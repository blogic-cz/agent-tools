import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";

import { Cause, Effect } from "effect";

import { decodeConfig } from "#config/loader";
import { parseVpnStatus, vpnCommandSpec } from "#shared/prerequisites/driver-commands";
import {
  stopWhenIdle,
  type GuardianInitMessage,
  type GuardianOutboundMessage,
} from "#shared/prerequisites/guardian";
import {
  closeVpnStoreAfter,
  missingVpnSecretError,
  releaseHeldLeases,
  runWithProfilePrerequisites,
  scheduleLongTimeout,
  vpnStartFailureMessage,
} from "#shared/prerequisites/runtime";
import {
  getVpnStoreLocation,
  type OperationGuard,
  sanitizeVpnDriver,
  VpnStore,
} from "#shared/prerequisites/store";

const driver =
  process.platform === "darwin"
    ? ({
        type: "macos-scutil",
        platform: "darwin",
        serviceName: "ExampleVPN",
      } as const)
    : process.platform === "linux"
      ? ({
          type: "linux-nmcli",
          platform: "linux",
          connectionName: "ExampleVPN",
        } as const)
      : ({
          type: "windows-rasdial",
          platform: "win32",
          entryName: "ExampleVPN",
        } as const);

const roots: string[] = [];
const root = () => {
  const value = mkdtempSync(`${tmpdir()}/agent-tools-vpn-store-`);
  roots.push(value);
  return value;
};

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
  delete process.env.AGENT_TOOLS_RUNTIME_DIR;
  delete process.env.PRIVATE_VPN_SECRET_NAME;
});

const noop = () => undefined;

const required = <A>(value: A | undefined): A => {
  if (value === undefined) throw new Error("Expected value to be defined.");
  return value;
};

const currentOperationGuard = (runtimeRoot: string): OperationGuard => {
  const store = VpnStore.open(driver, { root: runtimeRoot });
  const snapshot = store.snapshot();
  store.close();
  if (snapshot.operationId === null || snapshot.operationToken === null) {
    throw new Error("Expected an active operation guard.");
  }
  return {
    operationId: snapshot.operationId,
    token: snapshot.operationToken,
    revision: snapshot.revision,
  };
};

const reserve = (store: VpnStore, leaseId: string, guardianId: string, now = 0) =>
  store.reserveLease({
    leaseId,
    guardianId,
    ownerPid: process.pid,
    cleanup: "stop-if-started",
    now,
  });

const makeManaged = (
  store: VpnStore,
  leaseId: string = crypto.randomUUID(),
  guardianId: string = crypto.randomUUID(),
) => {
  reserve(store, leaseId, guardianId);
  const check = required(
    store.claimCheck(crypto.randomUUID(), crypto.randomUUID(), process.pid, 1),
  );
  expect(store.commitCheck(check, false, 2)).toBe(true);
  const start = required(
    store.claimStart(crypto.randomUUID(), crypto.randomUUID(), process.pid, 3),
  );
  expect(store.commitStart(start, "managed", crypto.randomUUID(), "started", 4)).toBe(true);
  expect(store.activateLease(leaseId, guardianId, 5)).toBe(true);
  return { leaseId, guardianId };
};

const init = (runtimeRoot: string, leaseId: string, guardianId: string): GuardianInitMessage => ({
  type: "INIT",
  driver,
  runtimeRoot,
  leaseId,
  guardianId,
  ownerPid: process.pid,
  cleanup: "stop-if-started",
  idleDisconnectMs: 0,
  disconnectTimeoutMs: 50,
});

const connectedOutput = () =>
  driver.type === "macos-scutil"
    ? "Connected\n"
    : driver.type === "linux-nmcli"
      ? "ExampleVPN\n"
      : "Connected to\nExampleVPN\nCommand completed successfully.\n";
const disconnectedOutput = () =>
  driver.type === "macos-scutil"
    ? "Disconnected\n"
    : driver.type === "linux-nmcli"
      ? ""
      : "No connections\nCommand completed successfully.\n";

const runtimeConfig = (idleDisconnectMs = 0, connectTimeoutMs = 50) => ({
  vpns: {
    work: {
      name: "ExampleVPN",
      idleDisconnectMs,
      connectTimeoutMs,
      disconnectTimeoutMs: 50,
    },
  },
});

const statusLabel = () => {
  const spec = vpnCommandSpec(driver, "status");
  return [spec.executable, ...spec.args].join(" ");
};

const isStartCommand = (label: string) =>
  label.includes("connection up") || label === "rasdial ExampleVPN" || label.includes("--nc start");

const isMutatingCommand = (label: string) =>
  isStartCommand(label) ||
  label.includes("--nc stop") ||
  label.includes("connection down") ||
  label.includes("/disconnect");

const POISONED_EVIDENCE =
  "VPN still reported connected after stop when the disconnect deadline expired.";

const poisonUnknown = async (runtimeRoot: string) => {
  const store = VpnStore.open(driver, { root: runtimeRoot, now: 0 });
  const held = makeManaged(store);
  store.releaseLease({ ...held, idleDisconnectMs: 0, now: 10 });
  let clock = 10;
  await stopWhenIdle(
    store,
    { ...init(runtimeRoot, held.leaseId, held.guardianId), disconnectTimeoutMs: 10 },
    (action) => {
      clock += 6;
      return Promise.resolve({
        stdout: action === "stop" ? "" : connectedOutput(),
        stderr: "",
        exitCode: 0,
      });
    },
    () => clock,
  );
  expect(store.snapshot()).toMatchObject({ lifecycle: "UNKNOWN", evidence: POISONED_EVIDENCE });
  store.close();
};

const replacementFailingSpawn = (
  runtimeRoot: string,
  failure: "before-reserve" | "after-reserve",
  control: { exitFirst: () => void },
) => {
  let generation = 0;
  return ((_command: string[], options?: unknown) => {
    generation += 1;
    if (generation === 2 && failure === "before-reserve") {
      throw new Error("replacement spawn failed before reserve");
    }
    const currentGeneration = generation;
    const ipc = (
      options as { readonly ipc?: (message: GuardianOutboundMessage) => void } | undefined
    )?.ipc;
    let exitCode: number | null = null;
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const exit = () => {
      if (exitCode !== null) return;
      exitCode = 1;
      resolveExit(1);
    };
    const child = {
      get exitCode() {
        return exitCode;
      },
      exited,
      send(message: GuardianInitMessage | { readonly type: "RELEASE"; readonly leaseId: string }) {
        if (message.type !== "INIT") return;
        const store = VpnStore.open(message.driver, { root: runtimeRoot });
        store.reserveLease({
          leaseId: message.leaseId,
          guardianId: message.guardianId,
          ownerPid: message.ownerPid,
          cleanup: message.cleanup,
          now: Date.now(),
        });
        store.close();
        if (currentGeneration === 1) {
          control.exitFirst = exit;
          ipc?.({
            type: "READY",
            leaseId: message.leaseId,
            guardianId: message.guardianId,
          });
        } else {
          exit();
        }
      },
      kill: exit,
      unref: noop,
      disconnect: noop,
    };
    return child as ReturnType<typeof Bun.spawn>;
  }) as typeof Bun.spawn;
};

const replacementReleaseSpawn = (
  runtimeRoot: string,
  control: {
    exitFirst: () => void;
    replacementReserved: Promise<void>;
    resolveReplacementReserved: () => void;
    initialGuardianId: string;
    replacementGuardianId: string;
    releaseGuardianIds: string[];
  },
) => {
  let generation = 0;
  return ((_command: string[], options?: unknown) => {
    generation += 1;
    const currentGeneration = generation;
    const ipc = (
      options as { readonly ipc?: (message: GuardianOutboundMessage) => void } | undefined
    )?.ipc;
    let initMessage: GuardianInitMessage | undefined;
    let exitCode: number | null = null;
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const exit = () => {
      if (exitCode !== null) return;
      exitCode = 0;
      resolveExit(0);
    };
    const child = {
      get exitCode() {
        return exitCode;
      },
      exited,
      send(message: GuardianInitMessage | { readonly type: "RELEASE"; readonly leaseId: string }) {
        if (message.type === "INIT") {
          initMessage = message;
          const store = VpnStore.open(message.driver, { root: runtimeRoot });
          store.reserveLease({
            leaseId: message.leaseId,
            guardianId: message.guardianId,
            ownerPid: message.ownerPid,
            cleanup: message.cleanup,
            now: Date.now(),
          });
          store.close();
          if (currentGeneration === 1) {
            control.initialGuardianId = message.guardianId;
            control.exitFirst = exit;
            ipc?.({
              type: "READY",
              leaseId: message.leaseId,
              guardianId: message.guardianId,
            });
          } else {
            control.replacementGuardianId = message.guardianId;
            control.resolveReplacementReserved();
          }
          return;
        }
        const initialized = required(initMessage);
        control.releaseGuardianIds.push(initialized.guardianId);
        const store = VpnStore.open(initialized.driver, { root: runtimeRoot });
        store.releaseLease({
          leaseId: initialized.leaseId,
          guardianId: initialized.guardianId,
          idleDisconnectMs: 0,
          now: Date.now(),
        });
        store.close();
        ipc?.({
          type: "READY",
          leaseId: initialized.leaseId,
          guardianId: initialized.guardianId,
        });
        ipc?.({ type: "RELEASED", leaseId: initialized.leaseId });
      },
      kill: exit,
      unref: noop,
      disconnect: exit,
    };
    return child as ReturnType<typeof Bun.spawn>;
  }) as typeof Bun.spawn;
};

const commandRunner =
  (state: { connected: boolean; commands: string[] }) => (_command: unknown, label: string) =>
    Effect.sync(() => {
      state.commands.push(label);
      if (label.includes("status") || label.includes("connection show") || label === "rasdial") {
        return {
          stdout: state.connected ? connectedOutput() : disconnectedOutput(),
          stderr: "",
          exitCode: 0,
        };
      }
      if (
        label.includes("start") ||
        label.includes("connection up") ||
        label === "rasdial ExampleVPN"
      ) {
        state.connected = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (
        label.includes("stop") ||
        label.includes("connection down") ||
        label.includes("/disconnect")
      ) {
        state.connected = false;
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      throw new Error(`unexpected command: ${label}`);
    });

test("long timeouts use safe cancellable chunks", () => {
  const maximum = 2_147_483_647;
  let clock = 100;
  const scheduled: Array<{
    callback: () => void;
    delayMs: number;
    cancelled: boolean;
  }> = [];
  const schedule = (callback: () => void, delayMs: number) => {
    const task = { callback, delayMs, cancelled: false };
    scheduled.push(task);
    return () => {
      task.cancelled = true;
    };
  };

  const cancel = scheduleLongTimeout(
    () => undefined,
    maximum + 5_000,
    () => clock,
    schedule,
  );
  expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([maximum]);
  clock += maximum;
  required(scheduled[0]).callback();
  expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([maximum, 5_000]);
  cancel();
  expect(required(scheduled[1]).cancelled).toBe(true);

  const cancelledBeforeReschedule: typeof scheduled = [];
  const cancelBeforeReschedule = scheduleLongTimeout(
    () => undefined,
    maximum + 5_000,
    () => 0,
    (callback, delayMs) => {
      const task = { callback, delayMs, cancelled: false };
      cancelledBeforeReschedule.push(task);
      return () => {
        task.cancelled = true;
      };
    },
  );
  cancelBeforeReschedule();
  required(cancelledBeforeReschedule[0]).callback();
  expect(cancelledBeforeReschedule).toHaveLength(1);
});

describe("VpnStore", () => {
  test("uses STRICT WAL FULL schema under private canonical root", () => {
    const runtimeRoot = root();
    const store = VpnStore.open(driver, { root: runtimeRoot, now: 0 });
    expect(store.settings()).toEqual({
      journalMode: "wal",
      synchronous: 2,
      userVersion: 2,
    });
    const db = new Database(store.databasePath, { strict: true });
    expect(
      db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name='leases'").get()?.sql,
    ).toContain("STRICT");
    const stateSchema = db
      .query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name='vpn_state'")
      .get()?.sql;
    expect(stateSchema).toContain("adopt_external_after_start");
    expect(stateSchema).toContain("lifecycle = 'STARTING'");
    reserve(store, "lease", "guardian");
    if (process.platform !== "win32") {
      expect(statSync(store.directory).mode & 0o777).toBe(0o700);
      for (const path of [
        store.databasePath,
        `${store.databasePath}-wal`,
        `${store.databasePath}-shm`,
      ]) {
        expect(statSync(path).mode & 0o777).toBe(0o600);
      }
    }
    db.close();
    store.close();
  });

  test("supports same-PID UUID leases and exact UUID release", () => {
    const store = VpnStore.open(driver, { root: root(), now: 0 });
    reserve(store, "lease-a", "guardian-a");
    reserve(store, "lease-b", "guardian-b");
    expect(store.snapshot().pendingLeases).toBe(2);
    expect(
      store.releaseLease({
        leaseId: "lease-a",
        guardianId: "wrong",
        idleDisconnectMs: 30,
        now: 1,
      }).released,
    ).toBe(false);
    expect(
      store.releaseLease({
        leaseId: "lease-a",
        guardianId: "guardian-a",
        idleDisconnectMs: 30,
        now: 1,
      }).released,
    ).toBe(true);
    expect(store.snapshot().pendingLeases).toBe(1);
    store.close();
  });

  test("rejects stale operation token and revision", () => {
    const store = VpnStore.open(driver, { root: root(), now: 0 });
    reserve(store, "lease", "guardian");
    const guard = required(store.claimCheck("operation", "token", process.pid, 1));
    expect(store.commitCheck({ ...guard, token: "stale" }, false, 2)).toBe(false);
    expect(store.commitCheck({ ...guard, revision: guard.revision - 1 }, false, 2)).toBe(false);
    expect(store.commitCheck(guard, false, 2)).toBe(true);
    store.close();
  });

  test("sets exact idle deadline and acquire cancels before deadline", () => {
    const store = VpnStore.open(driver, { root: root(), now: 0 });
    const held = makeManaged(store);
    expect(store.releaseLease({ ...held, idleDisconnectMs: 30, now: 100 }).deadline).toBe(130);
    reserve(store, "lease-2", "guardian-2", 120);
    expect(store.snapshot()).toMatchObject({
      lifecycle: "ACTIVE",
      idleDeadline: null,
    });
    expect(store.claimStop("stop", "token", process.pid, 130)).toBeUndefined();
    store.close();

    const deadStore = VpnStore.open(driver, { root: root(), now: 0 });
    makeManaged(deadStore, "dead-lease", "dead-guardian");
    expect(deadStore.deleteDeadLeases(() => false, 30, 100)).toBe(1);
    expect(deadStore.snapshot()).toMatchObject({
      lifecycle: "IDLE",
      idleDeadline: 130,
    });
    deadStore.close();
  });

  test("deadline winner fences later reservation and duplicate stop", async () => {
    const runtimeRoot = root();
    const store = VpnStore.open(driver, { root: runtimeRoot, now: 0 });
    const held = makeManaged(store);
    store.releaseLease({ ...held, idleDisconnectMs: 0, now: 100 });
    let stops = 0;
    let connected = true;
    const run = (action: "status" | "stop") => {
      if (action === "stop") {
        stops += 1;
        connected = false;
      }
      return Promise.resolve({
        stdout: connected ? connectedOutput() : disconnectedOutput(),
        stderr: "",
        exitCode: 0,
      });
    };
    await Promise.all([
      stopWhenIdle(store, init(runtimeRoot, held.leaseId, held.guardianId), run, () => 100),
      stopWhenIdle(store, init(runtimeRoot, held.leaseId, held.guardianId), run, () => 100),
    ]);
    expect(stops).toBe(1);
    expect(store.snapshot().lifecycle).toBe("DOWN");
    reserve(store, "late", "guardian-late", 101);
    expect(store.snapshot().lifecycle).toBe("DOWN");
    store.close();
  });

  test("never claims stop while any reservation exists", () => {
    const store = VpnStore.open(driver, { root: root(), now: 0 });
    const held = makeManaged(store);
    store.releaseLease({ ...held, idleDisconnectMs: 0, now: 10 });
    reserve(store, "pending", "guardian-pending", 10);
    expect(store.claimStop("stop", "token", process.pid, 10)).toBeUndefined();
    store.close();
  });

  test("zero disconnect budget starts no command, becomes UNKNOWN, and is not retried", async () => {
    const runtimeRoot = root();
    const store = VpnStore.open(driver, { root: runtimeRoot, now: 0 });
    const held = makeManaged(store);
    store.releaseLease({ ...held, idleDisconnectMs: 0, now: 10 });
    const commands: string[] = [];
    const run = (action: "status" | "stop") => {
      commands.push(action);
      return Promise.resolve({
        stdout: connectedOutput(),
        stderr: "",
        exitCode: 0,
      });
    };
    await stopWhenIdle(
      store,
      {
        ...init(runtimeRoot, held.leaseId, held.guardianId),
        disconnectTimeoutMs: 0,
      },
      run,
      () => 10,
    );
    await stopWhenIdle(store, init(runtimeRoot, held.leaseId, held.guardianId), run, () => 10);
    expect(commands).toEqual([]);
    expect(store.snapshot()).toMatchObject({ lifecycle: "UNKNOWN" });
    store.close();
  });

  test("uses one total stop and confirmation budget", async () => {
    const runtimeRoot = root();
    const store = VpnStore.open(driver, { root: runtimeRoot, now: 0 });
    const held = makeManaged(store);
    store.releaseLease({ ...held, idleDisconnectMs: 0, now: 100 });
    let clock = 100;
    const starts: Array<{
      action: "status" | "stop";
      at: number;
      budget: number;
    }> = [];
    const run = (action: "status" | "stop", budget: number) => {
      starts.push({ action, at: clock, budget });
      clock += action === "stop" ? 6 : 4;
      return Promise.resolve({
        stdout: connectedOutput(),
        stderr: "",
        exitCode: 0,
      });
    };
    await stopWhenIdle(
      store,
      {
        ...init(runtimeRoot, held.leaseId, held.guardianId),
        disconnectTimeoutMs: 10,
      },
      run,
      () => clock,
    );
    expect(starts).toEqual([
      { action: "stop", at: 100, budget: 10 },
      { action: "status", at: 106, budget: 4 },
    ]);
    expect(starts.every(({ at, budget }) => at < 110 && at - 100 + budget <= 10)).toBe(true);
    expect(store.snapshot().lifecycle).toBe("UNKNOWN");
    store.close();
  });

  test("records distinct evidence for failed and still-connected stop confirmation", async () => {
    const stopWith = async (status: { stdout: string; exitCode: number }) => {
      const runtimeRoot = root();
      const store = VpnStore.open(driver, { root: runtimeRoot, now: 0 });
      const held = makeManaged(store);
      store.releaseLease({ ...held, idleDisconnectMs: 0, now: 10 });
      let clock = 10;
      await stopWhenIdle(
        store,
        { ...init(runtimeRoot, held.leaseId, held.guardianId), disconnectTimeoutMs: 10 },
        (action) => {
          clock += 6;
          return Promise.resolve(
            action === "stop"
              ? { stdout: "", stderr: "", exitCode: 0 }
              : { stdout: status.stdout, stderr: "", exitCode: status.exitCode },
          );
        },
        () => clock,
      );
      const snapshot = store.snapshot();
      store.close();
      return snapshot;
    };

    expect(await stopWith({ stdout: "", exitCode: 1 })).toMatchObject({
      lifecycle: "UNKNOWN",
      evidence: "VPN status command after stop failed (exit 1); ownership is unknown.",
    });
    expect(await stopWith({ stdout: connectedOutput(), exitCode: 0 })).toMatchObject({
      lifecycle: "UNKNOWN",
      evidence: "VPN still reported connected after stop when the disconnect deadline expired.",
    });
  });

  test("starts no command when deadline expires before stop", async () => {
    const runtimeRoot = root();
    const store = VpnStore.open(driver, { root: runtimeRoot, now: 0 });
    const held = makeManaged(store);
    store.releaseLease({ ...held, idleDisconnectMs: 0, now: 10 });
    const times = [10, 10, 10, 21];
    const commands: string[] = [];
    await stopWhenIdle(
      store,
      {
        ...init(runtimeRoot, held.leaseId, held.guardianId),
        disconnectTimeoutMs: 10,
      },
      (action) => {
        commands.push(action);
        return Promise.resolve({
          stdout: connectedOutput(),
          stderr: "",
          exitCode: 0,
        });
      },
      () => times.shift() ?? 21,
    );
    expect(commands).toEqual([]);
    expect(store.snapshot().lifecycle).toBe("UNKNOWN");
    store.close();
  });

  test("leave-running permanently adopts managed connection as EXTERNAL", () => {
    const store = VpnStore.open(driver, { root: root(), now: 0 });
    const leaseId = "lease";
    const guardianId = "guardian";
    store.reserveLease({
      leaseId,
      guardianId,
      ownerPid: process.pid,
      cleanup: "leave-running",
      now: 0,
    });
    const check = required(store.claimCheck("check", "check-token", process.pid, 1));
    store.commitCheck(check, false, 2);
    const start = required(store.claimStart("start", "start-token", process.pid, 3));
    store.commitStart(start, "managed", "epoch", "started", 4);
    store.activateLease(leaseId, guardianId, 5);
    store.releaseLease({ leaseId, guardianId, idleDisconnectMs: 0, now: 6 });
    expect(store.snapshot()).toMatchObject({
      lifecycle: "EXTERNAL",
      managedEpochId: null,
    });
    store.close();

    const deadStore = VpnStore.open(driver, { root: root(), now: 0 });
    deadStore.reserveLease({
      leaseId: "dead-leave",
      guardianId: "dead-guardian",
      ownerPid: 999_999_999,
      cleanup: "leave-running",
      now: 0,
    });
    const deadCheck = required(deadStore.claimCheck("check", "token", process.pid, 1));
    deadStore.commitCheck(deadCheck, false, 2);
    const deadStart = required(deadStore.claimStart("start", "token", process.pid, 3));
    deadStore.commitStart(deadStart, "managed", "epoch", "started", 4);
    deadStore.activateLease("dead-leave", "dead-guardian", 5);
    expect(deadStore.deleteDeadLeases(() => false, 0, 6)).toBe(1);
    expect(deadStore.snapshot()).toMatchObject({
      lifecycle: "EXTERNAL",
      managedEpochId: null,
    });
    deadStore.close();
  });

  test("release during STARTING durably adopts after managed start", () => {
    const store = VpnStore.open(driver, { root: root(), now: 0 });
    reserve(store, "default", "default-guardian");
    store.reserveLease({
      leaseId: "leave",
      guardianId: "leave-guardian",
      ownerPid: process.pid,
      cleanup: "leave-running",
      now: 0,
    });
    const check = required(store.claimCheck("check", "check-token", process.pid, 1));
    expect(store.commitCheck(check, false, 2)).toBe(true);
    const start = required(store.claimStart("start", "start-token", process.pid, 3));

    expect(
      store.releaseLease({
        leaseId: "leave",
        guardianId: "leave-guardian",
        idleDisconnectMs: 0,
        now: 4,
      }).released,
    ).toBe(true);
    expect(store.snapshot()).toMatchObject({
      lifecycle: "STARTING",
      adoptExternalAfterStart: true,
      pendingLeases: 1,
    });
    expect(store.claimStop("stop", "stop-token", process.pid, 4)).toBeUndefined();
    expect(store.commitStart(start, "managed", "epoch", "started", 5)).toBe(true);
    expect(store.activateLease("default", "default-guardian", 6)).toBe(true);
    expect(store.snapshot()).toMatchObject({
      lifecycle: "EXTERNAL",
      managedEpochId: null,
      adoptExternalAfterStart: false,
    });
    store.releaseLease({
      leaseId: "default",
      guardianId: "default-guardian",
      idleDisconnectMs: 0,
      now: 7,
    });
    expect(store.snapshot()).toMatchObject({ lifecycle: "EXTERNAL", idleDeadline: null });
    expect(store.claimStop("stop", "stop-token", process.pid, 7)).toBeUndefined();
    store.close();
  });

  test("dead leave-running reconciliation during STARTING durably adopts", () => {
    const store = VpnStore.open(driver, { root: root(), now: 0 });
    reserve(store, "default", "default-guardian");
    store.reserveLease({
      leaseId: "dead-leave",
      guardianId: "dead-leave-guardian",
      ownerPid: 999_999_999,
      cleanup: "leave-running",
      now: 0,
    });
    const check = required(store.claimCheck("check", "check-token", process.pid, 1));
    expect(store.commitCheck(check, false, 2)).toBe(true);
    const start = required(store.claimStart("start", "start-token", process.pid, 3));

    expect(store.deleteDeadLeases((pid) => pid === process.pid, 0, 4)).toBe(1);
    expect(store.snapshot()).toMatchObject({
      lifecycle: "STARTING",
      adoptExternalAfterStart: true,
      pendingLeases: 1,
    });
    expect(store.claimStop("stop", "stop-token", process.pid, 4)).toBeUndefined();
    expect(store.commitStart(start, "managed", "epoch", "started", 5)).toBe(true);
    expect(store.activateLease("default", "default-guardian", 6)).toBe(true);
    store.releaseLease({
      leaseId: "default",
      guardianId: "default-guardian",
      idleDisconnectMs: 0,
      now: 7,
    });
    expect(store.snapshot()).toMatchObject({
      lifecycle: "EXTERNAL",
      managedEpochId: null,
      adoptExternalAfterStart: false,
      idleDeadline: null,
    });
    expect(store.claimStop("stop", "stop-token", process.pid, 7)).toBeUndefined();
    store.close();
  });

  test("known DOWN clears and ignores abandoned leave-running intent", () => {
    const store = VpnStore.open(driver, { root: root(), now: 0 });
    reserve(store, "default", "default-guardian");
    store.reserveLease({
      leaseId: "leave",
      guardianId: "leave-guardian",
      ownerPid: process.pid,
      cleanup: "leave-running",
      now: 0,
    });
    const check = required(store.claimCheck("check", "check-token", process.pid, 1));
    expect(store.commitCheck(check, false, 2)).toBe(true);
    const start = required(store.claimStart("start", "start-token", process.pid, 3));
    store.releaseLease({
      leaseId: "leave",
      guardianId: "leave-guardian",
      idleDisconnectMs: 0,
      now: 4,
    });
    expect(store.commitStart(start, "down", "unused", "failed", 5)).toBe(true);
    expect(store.snapshot()).toMatchObject({
      lifecycle: "DOWN",
      adoptExternalAfterStart: false,
    });
    store.close();

    const deadStore = VpnStore.open(driver, { root: root(), now: 0 });
    deadStore.reserveLease({
      leaseId: "dead-leave",
      guardianId: "dead-leave-guardian",
      ownerPid: 999_999_999,
      cleanup: "leave-running",
      now: 0,
    });
    expect(deadStore.deleteDeadLeases(() => false, 0, 1)).toBe(1);
    expect(deadStore.snapshot()).toMatchObject({
      lifecycle: "DOWN",
      adoptExternalAfterStart: false,
    });
    deadStore.close();
  });

  test("abandoned leases preserve targeted cleanup semantics without authorizing stop", () => {
    const starting = VpnStore.open(driver, { root: root(), now: 0 });
    reserve(starting, "default", "default-guardian");
    starting.reserveLease({
      leaseId: "leave",
      guardianId: "leave-guardian",
      ownerPid: process.pid,
      cleanup: "leave-running",
      now: 0,
    });
    const check = required(starting.claimCheck("check", "check-token", process.pid, 1));
    expect(starting.commitCheck(check, false, 2)).toBe(true);
    const start = required(starting.claimStart("start", "start-token", process.pid, 3));
    expect(starting.abandonLease("leave", 4)).toBe(true);
    expect(starting.snapshot()).toMatchObject({
      lifecycle: "STARTING",
      operationId: "start",
      adoptExternalAfterStart: true,
      pendingLeases: 1,
      activeLeases: 0,
    });
    expect(starting.commitStart(start, "managed", "epoch", "started", 5)).toBe(true);
    expect(starting.snapshot()).toMatchObject({
      lifecycle: "EXTERNAL",
      managedEpochId: null,
      adoptExternalAfterStart: false,
      idleDeadline: null,
    });
    expect(starting.claimStop("stop", "stop-token", process.pid, 6)).toBeUndefined();
    starting.close();

    for (const lifecycle of ["ACTIVE", "IDLE"] as const) {
      const leave = VpnStore.open(driver, { root: root(), now: 0 });
      const held = makeManaged(leave, `leave-${lifecycle}`, `guardian-${lifecycle}`);
      const db = new Database(leave.databasePath);
      db.query("UPDATE leases SET cleanup='leave-running' WHERE lease_id=?").run(held.leaseId);
      if (lifecycle === "IDLE") {
        db.query("UPDATE vpn_state SET lifecycle='IDLE', idle_deadline=10 WHERE singleton=1").run();
      }
      db.close();
      expect(leave.abandonLease(held.leaseId, 6)).toBe(true);
      expect(leave.snapshot()).toMatchObject({
        lifecycle: "EXTERNAL",
        managedEpochId: null,
        adoptExternalAfterStart: false,
        idleDeadline: null,
        pendingLeases: 0,
        activeLeases: 0,
      });
      expect(leave.claimStop("stop", "stop-token", process.pid, 6)).toBeUndefined();
      leave.close();
    }

    const stopped = VpnStore.open(driver, { root: root(), now: 0 });
    const stoppedLease = makeManaged(stopped, "stop", "stop-guardian");
    expect(stopped.abandonLease(stoppedLease.leaseId, 6)).toBe(true);
    expect(stopped.snapshot()).toMatchObject({
      lifecycle: "UNKNOWN",
      managedEpochId: null,
      idleDeadline: null,
      pendingLeases: 0,
      activeLeases: 0,
      evidence: "VPN guardian generation failed; ownership is ambiguous and no stop is authorized.",
    });
    expect(stopped.claimStop("stop", "stop-token", process.pid, 6)).toBeUndefined();
    stopped.close();

    const down = VpnStore.open(driver, { root: root(), now: 0 });
    down.reserveLease({
      leaseId: "down-leave",
      guardianId: "down-guardian",
      ownerPid: process.pid,
      cleanup: "leave-running",
      now: 0,
    });
    expect(down.abandonLease("down-leave", 1)).toBe(true);
    expect(down.snapshot()).toMatchObject({
      lifecycle: "DOWN",
      managedEpochId: null,
      adoptExternalAfterStart: false,
      pendingLeases: 0,
      activeLeases: 0,
    });
    expect(down.claimStop("stop", "stop-token", process.pid, 1)).toBeUndefined();
    down.close();
  });

  test("stale STARTING and STOPPING always become fenced UNKNOWN", () => {
    for (const kind of ["START", "STOP"] as const) {
      for (const connected of [true, false]) {
        const store = VpnStore.open(driver, { root: root(), now: 0 });
        let guard;
        if (kind === "START") {
          reserve(store, "lease", "guardian");
          guard = required(store.claimStart("start", "token", 999_999_999, 1));
        } else {
          const held = makeManaged(store);
          store.releaseLease({ ...held, idleDisconnectMs: 0, now: 10 });
          guard = required(store.claimStop("stop", "token", 999_999_999, 10));
        }
        expect(store.reconcileOperation(store.snapshot(), connected, 20)).toBe(true);
        const snapshot = store.snapshot();
        expect(snapshot.lifecycle).toBe("UNKNOWN");
        expect(snapshot.evidence).toContain("command completion and ownership are ambiguous");
        expect(snapshot.evidence).toContain("no retry is authorized");
        expect(
          kind === "START"
            ? store.commitStart(guard, "managed", "epoch", "stale", 21)
            : store.commitStop(guard, true, "stale", 21),
        ).toBe(false);
        expect(store.claimStart("retry", "token", process.pid, 22)).toBeUndefined();
        expect(store.claimStop("retry", "token", process.pid, 22)).toBeUndefined();
        expect(store.claimCheck("retry", "token", process.pid, 22)).toBeUndefined();
        store.close();
      }
    }
  });

  test("fails closed for legacy, corrupt, identity-mismatched, and busy state", () => {
    const legacyRoot = root();
    const legacy = getVpnStoreLocation(driver, legacyRoot);
    const oldHashDirectory = `${legacy.root}/vpn-prerequisites/deadbeef`;
    mkdirSync(oldHashDirectory, { recursive: true });
    writeFileSync(`${oldHashDirectory}/started.json`, "{}");
    writeFileSync(`${oldHashDirectory}/lease-123.json`, "{}");
    expect(() => VpnStore.open(driver, { root: legacyRoot })).toThrow(
      "Stop all agent-tools processes",
    );

    const corruptRoot = root();
    const corrupt = getVpnStoreLocation(driver, corruptRoot);
    mkdirSync(corrupt.directory, { recursive: true });
    writeFileSync(corrupt.databasePath, "not sqlite");
    expect(() => VpnStore.open(driver, { root: corruptRoot })).toThrow(
      "Stop all agent-tools processes",
    );

    const busyRoot = root();
    const store = VpnStore.open(driver, { root: busyRoot });
    const lock = new Database(store.databasePath);
    lock.exec("BEGIN IMMEDIATE");
    expect(() => reserve(store, "lease", "guardian")).toThrow("transaction failed");
    lock.exec("ROLLBACK");
    lock.close();
    store.close();
  });

  test("missing secret errors and coordination payloads contain no secret name or value", () => {
    const runtimeRoot = root();
    const secretName = "PRIVATE_VPN_SECRET_NAME";
    const secretValue = "super-secret-value";
    const sanitized = sanitizeVpnDriver({
      type: "macos-scutil",
      platform: "darwin",
      serviceName: "ExampleVPN",
      secretEnvVar: secretName,
    });
    const store = VpnStore.open(sanitized, { root: runtimeRoot });
    reserve(store, "lease", "guardian");
    const check = required(store.claimCheck("check", "token", process.pid, 1));
    expect(store.commitCheck(check, false, 2)).toBe(true);
    store.releaseLease({
      leaseId: "lease",
      guardianId: "guardian",
      idleDisconnectMs: 0,
      now: 3,
    });
    const error = missingVpnSecretError("work");
    const payload = {
      ...init(runtimeRoot, "lease", "guardian"),
      driver: sanitized,
    };
    const serialized = JSON.stringify({
      error,
      payload,
      snapshot: store.snapshot(),
    });
    expect(serialized).toContain("requires configured credentials");
    expect(serialized).toContain("Set the configured VPN secret");
    expect(serialized).not.toContain(secretName);
    expect(serialized).not.toContain(secretValue);

    const stateFiles = readdirSync(store.directory);
    for (const name of stateFiles) {
      const bytes = readFileSync(`${store.directory}/${name}`, "latin1");
      expect(bytes).not.toContain(secretName);
      expect(bytes).not.toContain(secretValue);
    }
    store.close();
  });

  test("fractional timer config cannot create SQLite state or a lease", () => {
    const runtimeRoot = root();
    process.env.AGENT_TOOLS_RUNTIME_DIR = runtimeRoot;
    expect(() =>
      decodeConfig({
        vpns: { work: { name: "ExampleVPN", idleDisconnectMs: 0.5 } },
      }),
    ).toThrow("idleDisconnectMs must be an integer");
    expect(existsSync(`${runtimeRoot}/vpn-prerequisites`)).toBe(false);
  });

  test("redacts failed-start stderr only when a secret was supplied", () => {
    const stderr = " failed argv --secret sentinel-secret via PRIVATE_VPN_SECRET_NAME ";
    const redacted = vpnStartFailureMessage("work", stderr, true);
    expect(redacted).toBe('Failed to start VPN prerequisite "work".');
    expect(redacted).not.toContain("sentinel-secret");
    expect(redacted).not.toContain("PRIVATE_VPN_SECRET_NAME");
    expect(vpnStartFailureMessage("work", stderr, false)).toBe(stderr.trim());
  });
});

describe("runWithProfilePrerequisites", () => {
  test("store close preserves primary outcomes and cleans sole-success failure", async () => {
    const normalValue = { held: true };
    let normalCloses = 0;
    let normalReleases = 0;
    const normalResult = await Effect.runPromise(
      closeVpnStoreAfter(
        "work",
        {
          release: () => {
            normalReleases += 1;
            return Promise.resolve();
          },
        },
        () => {
          normalCloses += 1;
        },
        Effect.succeed(normalValue),
      ),
    );
    expect(normalResult).toBe(normalValue);
    expect(normalCloses).toBe(1);
    expect(normalReleases).toBe(0);

    const makeLease = () => {
      const store = VpnStore.open(driver, { root: root(), now: 0 });
      const lease = makeManaged(store);
      let releases = 0;
      const guardian = {
        release: () => {
          releases += 1;
          store.releaseLease({ ...lease, idleDisconnectMs: 0, now: 6 });
          throw new Error("guardian close failed");
        },
      };
      return { store, guardian, lease, releases: () => releases };
    };

    const successful = makeLease();
    const closeFailure = new Error("parent close failed");
    const successResult = await Effect.runPromise(
      Effect.result(
        closeVpnStoreAfter(
          "work",
          successful.guardian,
          () => {
            throw closeFailure;
          },
          Effect.succeed("held"),
        ),
      ),
    );
    expect(successResult._tag).toBe("Failure");
    if (successResult._tag === "Failure") {
      expect(successResult.failure.message).toBe(
        'Failed to coordinate VPN prerequisite "work": parent close failed',
      );
    }
    expect(successful.releases()).toBe(1);
    expect(successful.store.snapshot()).toMatchObject({ activeLeases: 0, pendingLeases: 0 });
    successful.store.close();

    const typed = makeLease();
    const typedFailure = new Error("typed primary");
    const typedResult = await Effect.runPromise(
      Effect.result(
        closeVpnStoreAfter(
          "work",
          typed.guardian,
          () => {
            throw closeFailure;
          },
          Effect.sync(() =>
            typed.store.releaseLease({ ...typed.lease, idleDisconnectMs: 0, now: 6 }),
          ).pipe(Effect.andThen(Effect.fail(typedFailure))),
        ),
      ),
    );
    expect(typedResult._tag).toBe("Failure");
    if (typedResult._tag === "Failure") expect(typedResult.failure).toBe(typedFailure);
    expect(typed.releases()).toBe(0);
    expect(typed.store.snapshot()).toMatchObject({ activeLeases: 0, pendingLeases: 0 });
    typed.store.close();

    const defective = makeLease();
    const defect = new Error("defect primary");
    const defectExit = await Effect.runPromise(
      Effect.exit(
        closeVpnStoreAfter(
          "work",
          defective.guardian,
          () => {
            throw closeFailure;
          },
          Effect.sync(() =>
            defective.store.releaseLease({ ...defective.lease, idleDisconnectMs: 0, now: 6 }),
          ).pipe(Effect.andThen(Effect.die(defect))),
        ),
      ),
    );
    expect(defectExit._tag).toBe("Failure");
    if (defectExit._tag === "Failure") {
      const found = Cause.findDefect(defectExit.cause);
      expect(found._tag).toBe("Success");
      if (found._tag === "Success") expect(found.success).toBe(defect);
    }
    expect(defective.releases()).toBe(0);
    expect(defective.store.snapshot()).toMatchObject({ activeLeases: 0, pendingLeases: 0 });
    defective.store.close();
  });

  test("sole parent close failure releases exact lease before user work", async () => {
    const runtimeRoot = root();
    process.env.AGENT_TOOLS_RUNTIME_DIR = runtimeRoot;
    const originalOpen = VpnStore.open;
    const originalClose = VpnStore.prototype.close;
    let opens = 0;
    let parentStore: VpnStore | undefined;
    let workRan = false;

    try {
      VpnStore.open = (patchedDriver, options) => {
        const store = originalOpen(patchedDriver, options);
        opens += 1;
        if (opens === 2) {
          parentStore = store;
          store.close = () => {
            throw new Error("injected parent close failure");
          };
        }
        return store;
      };
      const result = await Effect.runPromise(
        Effect.result(
          runWithProfilePrerequisites(
            runtimeConfig(),
            { vpn: "work" },
            () => Effect.succeed({ stdout: connectedOutput(), stderr: "", exitCode: 0 }),
            Effect.sync(() => {
              workRan = true;
            }),
            { runGuardianInProcess: true },
          ),
        ),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.message).toBe(
          'Failed to coordinate VPN prerequisite "work": injected parent close failure',
        );
      }
      expect(workRan).toBe(false);
      expect(required(parentStore).snapshot()).toMatchObject({
        pendingLeases: 0,
        activeLeases: 0,
      });
    } finally {
      VpnStore.open = originalOpen;
      if (parentStore) originalClose.call(parentStore);
    }
  });

  test("failed detached replacement never activates stale generations or starts work", async () => {
    for (const failure of ["before-reserve", "after-reserve"] as const) {
      const runtimeRoot = root();
      process.env.AGENT_TOOLS_RUNTIME_DIR = runtimeRoot;
      const control = { exitFirst: noop };
      const labels: string[] = [];
      let workRan = false;

      // eslint-disable-next-line no-await-in-loop -- replacement cases share process state
      const result = await Effect.runPromise(
        Effect.result(
          runWithProfilePrerequisites(
            runtimeConfig(0),
            { vpn: "work" },
            (_command, label) => {
              labels.push(label);
              return Effect.promise(async () => {
                control.exitFirst();
                await new Promise((resolve) => {
                  setTimeout(resolve, 0);
                });
                return { stdout: connectedOutput(), stderr: "", exitCode: 0 };
              });
            },
            Effect.sync(() => {
              workRan = true;
            }),
            {
              guardianSpawn: replacementFailingSpawn(runtimeRoot, failure, control),
            },
          ),
        ),
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.message).toContain("Failed to coordinate VPN prerequisite");
        expect(result.failure.message).toContain(
          failure === "before-reserve"
            ? "replacement spawn failed before reserve"
            : "guardian exited before readiness",
        );
      }
      expect(workRan).toBe(false);
      expect(labels).toHaveLength(1);
      expect(labels.join("\n")).not.toContain("stop");
      expect(labels.join("\n")).not.toContain("connection down");
      expect(labels.join("\n")).not.toContain("/disconnect");

      const store = VpnStore.open(driver, { root: runtimeRoot });
      expect(store.snapshot()).toMatchObject({
        lifecycle: "EXTERNAL",
        pendingLeases: 0,
        activeLeases: 0,
      });
      expect(store.claimStop("stop", "token", process.pid, Date.now())).toBeUndefined();
      store.close();
    }
  });

  test("release during detached replacement targets only the reserved replacement", async () => {
    const runtimeRoot = root();
    process.env.AGENT_TOOLS_RUNTIME_DIR = runtimeRoot;
    let resolveReplacementReserved: () => void = noop;
    const control = {
      exitFirst: noop,
      replacementReserved: new Promise<void>((resolve) => {
        resolveReplacementReserved = resolve;
      }),
      resolveReplacementReserved: () => resolveReplacementReserved(),
      initialGuardianId: "",
      replacementGuardianId: "",
      releaseGuardianIds: [] as string[],
    };

    const value = await Effect.runPromise(
      runWithProfilePrerequisites(
        runtimeConfig(0),
        { vpn: "work" },
        () => Effect.succeed({ stdout: connectedOutput(), stderr: "", exitCode: 0 }),
        Effect.promise(async () => {
          control.exitFirst();
          await control.replacementReserved;
          return "done";
        }),
        { guardianSpawn: replacementReleaseSpawn(runtimeRoot, control) },
      ),
    );

    expect(value).toBe("done");
    expect(control.replacementGuardianId).not.toBe(control.initialGuardianId);
    expect(control.releaseGuardianIds.length).toBeGreaterThan(0);
    expect(control.releaseGuardianIds.every((id) => id === control.replacementGuardianId)).toBe(
      true,
    );
    const store = VpnStore.open(driver, { root: runtimeRoot });
    expect(store.snapshot()).toMatchObject({
      lifecycle: "EXTERNAL",
      pendingLeases: 0,
      activeLeases: 0,
    });
    store.close();
  });

  test("releases held guardians in reverse after rejection without replacing outcomes", async () => {
    const calls: string[] = [];
    const leases = () => [
      {
        guardian: {
          release: () => {
            calls.push("A");
            throw new Error("A release threw");
          },
        },
      },
      {
        guardian: {
          release: () => {
            calls.push("B");
            return Promise.reject(new Error("B release rejected"));
          },
        },
      },
    ];
    const originalSuccess = { value: "success" };
    const success = await Effect.runPromise(
      Effect.succeed(originalSuccess).pipe(Effect.ensuring(releaseHeldLeases(leases()))),
    );
    expect(success).toBe(originalSuccess);

    const originalFailure = new Error("original failure");
    const failure = await Effect.runPromise(
      Effect.fail(originalFailure).pipe(
        Effect.ensuring(releaseHeldLeases(leases())),
        Effect.result,
      ),
    );
    expect(failure._tag).toBe("Failure");
    if (failure._tag === "Failure") expect(failure.failure).toBe(originalFailure);

    const originalDefect = new Error("original defect");
    const defectExit = await Effect.runPromise(
      Effect.exit(Effect.die(originalDefect).pipe(Effect.ensuring(releaseHeldLeases(leases())))),
    );
    expect(defectExit._tag).toBe("Failure");
    if (defectExit._tag === "Failure") {
      const defect = Cause.findDefect(defectExit.cause);
      expect(defect._tag).toBe("Success");
      if (defect._tag === "Success") expect(defect.success).toBe(originalDefect);
    }
    expect(calls).toEqual(["B", "A", "B", "A", "B", "A"]);
  });

  test("releases inline guardian when parent store open fails", async () => {
    const runtimeRoot = root();
    process.env.AGENT_TOOLS_RUNTIME_DIR = runtimeRoot;
    const commands: string[] = [];
    const originalOpen = VpnStore.open;
    const openFailure = new Error("parent store open failed");
    let openCalls = 0;

    try {
      VpnStore.open = (patchedDriver, options) => {
        openCalls += 1;
        if (openCalls === 2) throw openFailure;
        return originalOpen(patchedDriver, options);
      };
      const result = await Effect.runPromise(
        Effect.result(
          runWithProfilePrerequisites(
            runtimeConfig(),
            { vpn: "work" },
            (_command, label) =>
              Effect.sync(() => {
                commands.push(label);
                return { stdout: "", stderr: "", exitCode: 0 };
              }),
            Effect.void,
            { runGuardianInProcess: true },
          ),
        ),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toBeInstanceOf(Error);
        expect(result.failure.message).toBe(
          'Failed to coordinate VPN prerequisite "work": parent store open failed',
        );
      }
    } finally {
      VpnStore.open = originalOpen;
    }

    expect(openCalls).toBe(2);
    expect(commands).toEqual([]);
    const store = VpnStore.open(driver, { root: runtimeRoot });
    expect(store.snapshot()).toMatchObject({
      pendingLeases: 0,
      activeLeases: 0,
    });
    store.close();
  });

  test("dead mutating operations fence UNKNOWN without running any command", async () => {
    for (const kind of ["START", "STOP"] as const) {
      const runtimeRoot = root();
      process.env.AGENT_TOOLS_RUNTIME_DIR = runtimeRoot;
      const store = VpnStore.open(driver, { root: runtimeRoot, now: 0 });
      const guard =
        kind === "START"
          ? (() => {
              reserve(store, "stale-lease", "stale-guardian");
              return required(store.claimStart("stale-start", "token", 999_999_999, 1));
            })()
          : (() => {
              const held = makeManaged(store);
              store.releaseLease({ ...held, idleDisconnectMs: 0, now: 10 });
              return required(store.claimStop("stale-stop", "token", 999_999_999, 10));
            })();
      store.close();

      // eslint-disable-next-line no-await-in-loop -- cases share process environment and must stay sequential
      const result = await Effect.runPromise(
        Effect.result(
          runWithProfilePrerequisites(
            runtimeConfig(),
            { vpn: "work" },
            () => Effect.never,
            Effect.void,
            { runGuardianInProcess: true },
          ),
        ),
      );
      expect(result._tag).toBe("Failure");
      const reconciled = VpnStore.open(driver, { root: runtimeRoot });
      expect(reconciled.snapshot().lifecycle).toBe("UNKNOWN");
      expect(
        kind === "START"
          ? reconciled.commitStart(guard, "managed", "late", "late", Date.now())
          : reconciled.commitStop(guard, true, "late", Date.now()),
      ).toBe(false);
      reconciled.close();

      const commands: string[] = [];
      // eslint-disable-next-line no-await-in-loop -- cases share process environment and must stay sequential
      await Effect.runPromise(
        Effect.result(
          runWithProfilePrerequisites(
            runtimeConfig(),
            { vpn: "work" },
            (_command, label) =>
              Effect.sync(() => {
                commands.push(label);
                return { stdout: "", stderr: "status failed", exitCode: 1 };
              }),
            Effect.void,
            { runGuardianInProcess: true },
          ),
        ),
      );
      expect(commands).toEqual([statusLabel()]);
    }
  });

  test("initial status timeout is bounded, fenced UNKNOWN, and starts nothing later", async () => {
    const runtimeRoot = root();
    process.env.AGENT_TOOLS_RUNTIME_DIR = runtimeRoot;
    const commands: string[] = [];
    let staleGuard: OperationGuard | undefined;
    const startedAt = performance.now();
    const result = await Effect.runPromise(
      Effect.result(
        runWithProfilePrerequisites(
          runtimeConfig(),
          { vpn: "work" },
          (_command, label) => {
            commands.push(label);
            staleGuard = currentOperationGuard(runtimeRoot);
            return Effect.never;
          },
          Effect.void,
          { runGuardianInProcess: true },
        ),
      ),
    );
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(result._tag).toBe("Failure");
    expect(commands).toHaveLength(1);

    const reconciled = VpnStore.open(driver, { root: runtimeRoot });
    expect(reconciled.snapshot().lifecycle).toBe("UNKNOWN");
    expect(reconciled.commitCheck(required(staleGuard), false, Date.now())).toBe(false);
    reconciled.close();
    await new Promise((resolve) => {
      setTimeout(resolve, 75);
    });
    expect(commands).toHaveLength(1);
  });

  test("external and stale status timeouts reconcile only their exact CHECKING operation", async () => {
    for (const lifecycle of ["EXTERNAL", "STALE"] as const) {
      const runtimeRoot = root();
      process.env.AGENT_TOOLS_RUNTIME_DIR = runtimeRoot;
      const store = VpnStore.open(driver, { root: runtimeRoot, now: 0 });
      reserve(store, "stale-lease", "stale-guardian");
      const preparedGuard = required(
        store.claimCheck(
          "prepared-check",
          "prepared-token",
          lifecycle === "STALE" ? 999_999_999 : process.pid,
          1,
        ),
      );
      if (lifecycle === "EXTERNAL") expect(store.commitCheck(preparedGuard, true, 2)).toBe(true);
      store.close();

      let claimedGuard: OperationGuard | undefined;
      const startedAt = performance.now();
      // eslint-disable-next-line no-await-in-loop -- cases share process environment and must stay sequential
      const result = await Effect.runPromise(
        Effect.result(
          runWithProfilePrerequisites(
            runtimeConfig(),
            { vpn: "work" },
            () => {
              claimedGuard = currentOperationGuard(runtimeRoot);
              return Effect.never;
            },
            Effect.void,
            { runGuardianInProcess: true },
          ),
        ),
      );
      expect(performance.now() - startedAt).toBeLessThan(1_000);
      expect(result._tag).toBe("Failure");
      const reconciled = VpnStore.open(driver, { root: runtimeRoot });
      expect(reconciled.snapshot().lifecycle).toBe("UNKNOWN");
      expect(reconciled.commitCheck(required(claimedGuard), false, Date.now())).toBe(false);
      if (lifecycle === "STALE") {
        expect(reconciled.commitCheck(preparedGuard, false, Date.now())).toBe(false);
      }
      reconciled.close();
    }
  });

  test("start timeout and Effect failure fence STARTING as UNKNOWN", async () => {
    for (const failure of ["timeout", "effect"] as const) {
      const runtimeRoot = root();
      process.env.AGENT_TOOLS_RUNTIME_DIR = runtimeRoot;
      const commands: string[] = [];
      let staleGuard: OperationGuard | undefined;
      const startedAt = performance.now();
      // eslint-disable-next-line no-await-in-loop -- cases share process environment and must stay sequential
      const result = await Effect.runPromise(
        Effect.result(
          runWithProfilePrerequisites(
            runtimeConfig(),
            { vpn: "work" },
            (_command, label) => {
              commands.push(label);
              if (commands.length === 1) {
                return Effect.succeed({
                  stdout: disconnectedOutput(),
                  stderr: "",
                  exitCode: 0,
                });
              }
              staleGuard = currentOperationGuard(runtimeRoot);
              return failure === "timeout" ? Effect.never : Effect.fail(new Error("start failed"));
            },
            Effect.void,
            { runGuardianInProcess: true },
          ),
        ),
      );
      expect(performance.now() - startedAt).toBeLessThan(1_000);
      expect(result._tag).toBe("Failure");
      expect(commands).toHaveLength(2);
      const reconciled = VpnStore.open(driver, { root: runtimeRoot });
      expect(reconciled.snapshot().lifecycle).toBe("UNKNOWN");
      expect(
        reconciled.commitStart(required(staleGuard), "managed", "late", "late", Date.now()),
      ).toBe(false);
      reconciled.close();
      // eslint-disable-next-line no-await-in-loop -- verifies timed-out command cannot dispatch later
      await new Promise((resolve) => {
        setTimeout(resolve, 75);
      });
      expect(commands).toHaveLength(2);
    }
  });

  test("zero connect budget runs no command and fails closed as UNKNOWN", async () => {
    const runtimeRoot = root();
    process.env.AGENT_TOOLS_RUNTIME_DIR = runtimeRoot;
    const commands: string[] = [];
    const result = await Effect.runPromise(
      Effect.result(
        runWithProfilePrerequisites(
          {
            vpns: {
              work: {
                name: "ExampleVPN",
                idleDisconnectMs: 0,
                connectTimeoutMs: 0,
                disconnectTimeoutMs: 50,
              },
            },
          },
          { vpn: "work" },
          (_command, label) => {
            commands.push(label);
            return Effect.never;
          },
          Effect.void,
          { runGuardianInProcess: true },
        ),
      ),
    );
    expect(result._tag).toBe("Failure");
    expect(commands).toEqual([]);
    const store = VpnStore.open(driver, { root: runtimeRoot });
    expect(store.snapshot().lifecycle).toBe("UNKNOWN");
    store.close();
  });

  test("successful start without confirmation before total deadline becomes UNKNOWN", async () => {
    const runtimeRoot = root();
    process.env.AGENT_TOOLS_RUNTIME_DIR = runtimeRoot;
    let calls = 0;
    const result = await Effect.runPromise(
      Effect.result(
        runWithProfilePrerequisites(
          runtimeConfig(),
          { vpn: "work" },
          () =>
            Effect.sync(() => {
              calls += 1;
              return calls === 2
                ? { stdout: "", stderr: "", exitCode: 0 }
                : { stdout: disconnectedOutput(), stderr: "", exitCode: 0 };
            }),
          Effect.void,
          { runGuardianInProcess: true },
        ),
      ),
    );
    expect(result._tag).toBe("Failure");
    expect(calls).toBeGreaterThanOrEqual(3);
    const store = VpnStore.open(driver, { root: runtimeRoot });
    expect(store.snapshot().lifecycle).toBe("UNKNOWN");
    store.close();
  });

  test("expired live operation reconciles exact snapshot and fences late commit", async () => {
    const runtimeRoot = root();
    process.env.AGENT_TOOLS_RUNTIME_DIR = runtimeRoot;
    const store = VpnStore.open(driver, { root: runtimeRoot, now: 0 });
    reserve(store, "live-lease", "live-guardian");
    const guard = required(store.claimStart("live-start", "token", process.pid, 1));
    store.close();

    const originalNow = Date.now;
    let now = originalNow();
    Date.now = () => (now += 100_000);
    try {
      await Effect.runPromise(
        Effect.result(
          runWithProfilePrerequisites(
            runtimeConfig(),
            { vpn: "work" },
            () => Effect.never,
            Effect.void,
            { runGuardianInProcess: true },
          ),
        ),
      );
    } finally {
      Date.now = originalNow;
    }

    const reconciled = VpnStore.open(driver, { root: runtimeRoot });
    expect(reconciled.snapshot().lifecycle).toBe("UNKNOWN");
    expect(reconciled.commitStart(guard, "managed", "late", "late", Date.now())).toBe(false);
    reconciled.close();

    const commands: string[] = [];
    await Effect.runPromise(
      Effect.result(
        runWithProfilePrerequisites(
          runtimeConfig(),
          { vpn: "work" },
          (_command, label) =>
            Effect.sync(() => {
              commands.push(label);
              return { stdout: "", stderr: "status failed", exitCode: 1 };
            }),
          Effect.void,
          { runGuardianInProcess: true },
        ),
      ),
    );
    expect(commands).toEqual([statusLabel()]);
  });

  test("redacts macOS secret start failures from errors, evidence, state files, and logs", async () => {
    if (process.platform !== "darwin") return;
    const runtimeRoot = root();
    process.env.AGENT_TOOLS_RUNTIME_DIR = runtimeRoot;
    process.env.PRIVATE_VPN_SECRET_NAME = "sentinel-secret";
    const stderr = "failed argv --secret sentinel-secret via PRIVATE_VPN_SECRET_NAME";
    const labels: string[] = [];
    const result = await Effect.runPromise(
      Effect.result(
        runWithProfilePrerequisites(
          {
            vpns: {
              work: {
                name: "ExampleVPN",
                secretEnvVar: "PRIVATE_VPN_SECRET_NAME",
                idleDisconnectMs: 0,
              },
            },
          },
          { vpn: "work" },
          (_command, label) =>
            Effect.sync(() => {
              labels.push(label);
              return label.includes("status")
                ? { stdout: disconnectedOutput(), stderr: "", exitCode: 0 }
                : { stdout: "", stderr, exitCode: 1 };
            }),
          Effect.void,
          { runGuardianInProcess: true },
        ),
      ),
    );
    expect(result._tag).toBe("Failure");
    const returned = JSON.stringify(result);
    expect(returned).toContain('Failed to start VPN prerequisite \\"work\\".');
    expect(returned).not.toContain("sentinel-secret");
    expect(returned).not.toContain("PRIVATE_VPN_SECRET_NAME");
    expect(labels.join("\n")).not.toContain("sentinel-secret");
    expect(labels.join("\n")).not.toContain("PRIVATE_VPN_SECRET_NAME");

    const sanitized = sanitizeVpnDriver({
      type: "macos-scutil",
      platform: "darwin",
      serviceName: "ExampleVPN",
      secretEnvVar: "PRIVATE_VPN_SECRET_NAME",
    });
    const store = VpnStore.open(sanitized, { root: runtimeRoot });
    expect(store.snapshot().evidence).toBe('Failed to start VPN prerequisite "work".');
    const stateFiles = readdirSync(store.directory);
    expect(stateFiles.toSorted()).toEqual(["state.sqlite", "state.sqlite-shm", "state.sqlite-wal"]);
    for (const name of stateFiles) {
      const bytes = readFileSync(`${store.directory}/${name}`, "latin1");
      expect(bytes).not.toContain("sentinel-secret");
      expect(bytes).not.toContain("PRIVATE_VPN_SECRET_NAME");
    }
    store.close();
  });

  test("starts and immediately confirms stop when idleDisconnectMs is zero", async () => {
    const runtimeRoot = root();
    process.env.AGENT_TOOLS_RUNTIME_DIR = runtimeRoot;
    const state = { connected: false, commands: [] as string[] };
    const value = await Effect.runPromise(
      runWithProfilePrerequisites(
        runtimeConfig(),
        { vpn: "work" },
        commandRunner(state),
        Effect.succeed("ok"),
        { runGuardianInProcess: true },
      ),
    );
    expect(value).toBe("ok");
    expect(state.connected).toBe(false);
    expect(
      state.commands.filter(
        (command) =>
          command.includes("stop") ||
          command.includes("connection down") ||
          command.includes("/disconnect"),
      ),
    ).toHaveLength(1);
  });

  test("rechecks EXTERNAL before activation and never stops unknown manual state", async () => {
    process.env.AGENT_TOOLS_RUNTIME_DIR = root();
    const state = { connected: true, commands: [] as string[] };
    const run = () =>
      Effect.runPromise(
        runWithProfilePrerequisites(
          runtimeConfig(),
          { vpn: "work" },
          commandRunner(state),
          Effect.void,
          { runGuardianInProcess: true },
        ),
      );
    await run();
    expect(state.connected).toBe(true);
    expect(
      state.commands.some(
        (command) =>
          command.includes("stop") ||
          command.includes("connection down") ||
          command.includes("/disconnect"),
      ),
    ).toBe(false);

    state.connected = false;
    await run();
    expect(state.connected).toBe(false);
    expect(
      state.commands.filter(
        (command) =>
          command.includes("start") ||
          command.includes("connection up") ||
          command === "rasdial ExampleVPN" ||
          command.includes("stop") ||
          command.includes("connection down") ||
          command.includes("/disconnect"),
      ),
    ).toHaveLength(2);

    state.connected = true;
    await run();
    let workRan = false;
    const commandsBefore = state.commands.length;
    const unknown = await Effect.runPromise(
      Effect.result(
        runWithProfilePrerequisites(
          runtimeConfig(),
          { vpn: "work" },
          (_command, label) =>
            Effect.sync(() => {
              state.commands.push(label);
              return { stdout: "", stderr: "status failed", exitCode: 1 };
            }),
          Effect.sync(() => {
            workRan = true;
          }),
          { runGuardianInProcess: true },
        ),
      ),
    );
    expect(unknown._tag).toBe("Failure");
    expect(workRan).toBe(false);
    expect(state.commands.slice(commandsBefore)).toHaveLength(1);
  });

  test("alreadySatisfied skips VPN work that a poisoned UNKNOWN state would still block", async () => {
    const runtimeRoot = root();
    process.env.AGENT_TOOLS_RUNTIME_DIR = runtimeRoot;
    const poisoned = VpnStore.open(driver, { root: runtimeRoot, now: 0 });
    const held = makeManaged(poisoned);
    poisoned.releaseLease({ ...held, idleDisconnectMs: 0, now: 10 });
    await stopWhenIdle(
      poisoned,
      { ...init(runtimeRoot, held.leaseId, held.guardianId), disconnectTimeoutMs: 0 },
      () => Promise.resolve({ stdout: connectedOutput(), stderr: "", exitCode: 0 }),
      () => 10,
    );
    expect(poisoned.snapshot().lifecycle).toBe("UNKNOWN");
    poisoned.close();

    const state = { connected: false, commands: [] as string[] };
    let runs = 0;
    const work = Effect.sync(() => {
      runs += 1;
      return "done";
    });

    const skipped = await Effect.runPromise(
      runWithProfilePrerequisites(runtimeConfig(), { vpn: "work" }, commandRunner(state), work, {
        alreadySatisfied: true,
        runGuardianInProcess: true,
      }),
    );
    expect(skipped).toBe("done");
    expect(runs).toBe(1);
    expect(state.commands).toEqual([]);

    const gated = await Effect.runPromise(
      Effect.result(
        runWithProfilePrerequisites(
          runtimeConfig(),
          { vpn: "work" },
          (_command, label) =>
            Effect.sync(() => {
              state.commands.push(label);
              return { stdout: "", stderr: "status failed", exitCode: 1 };
            }),
          work,
          { runGuardianInProcess: true },
        ),
      ),
    );
    expect(gated._tag).toBe("Failure");
    if (gated._tag === "Failure") {
      expect(gated.failure.message).toContain('VPN prerequisite "work" has unknown ownership');
    }
    expect(runs).toBe(1);
  });

  test("poisoned UNKNOWN self-heals to DOWN from an observed disconnected status", async () => {
    const runtimeRoot = root();
    process.env.AGENT_TOOLS_RUNTIME_DIR = runtimeRoot;
    await poisonUnknown(runtimeRoot);

    const state = { connected: false, commands: [] as string[] };
    const value = await Effect.runPromise(
      runWithProfilePrerequisites(
        runtimeConfig(0, 5_000),
        { vpn: "work" },
        commandRunner(state),
        Effect.succeed("ok"),
        { runGuardianInProcess: true },
      ),
    );

    expect(value).toBe("ok");
    expect(state.commands[0]).toBe(statusLabel());
    expect(state.commands.some(isStartCommand)).toBe(true);
    const store = VpnStore.open(driver, { root: runtimeRoot });
    expect(store.snapshot().lifecycle).not.toBe("UNKNOWN");
    store.close();
  });

  test("poisoned UNKNOWN self-heals to EXTERNAL when the VPN is connected elsewhere", async () => {
    const runtimeRoot = root();
    process.env.AGENT_TOOLS_RUNTIME_DIR = runtimeRoot;
    await poisonUnknown(runtimeRoot);

    const state = { connected: true, commands: [] as string[] };
    const value = await Effect.runPromise(
      runWithProfilePrerequisites(
        runtimeConfig(0, 5_000),
        { vpn: "work" },
        commandRunner(state),
        Effect.succeed("ok"),
        { runGuardianInProcess: true },
      ),
    );

    expect(value).toBe("ok");
    expect(state.connected).toBe(true);
    expect(state.commands.some(isMutatingCommand)).toBe(false);
    const store = VpnStore.open(driver, { root: runtimeRoot });
    expect(store.snapshot()).toMatchObject({ lifecycle: "EXTERNAL" });
    store.close();
  });

  test("unobservable status keeps UNKNOWN failed closed with its original evidence", async () => {
    const runtimeRoot = root();
    process.env.AGENT_TOOLS_RUNTIME_DIR = runtimeRoot;
    await poisonUnknown(runtimeRoot);

    const commands: string[] = [];
    let workRan = false;
    const result = await Effect.runPromise(
      Effect.result(
        runWithProfilePrerequisites(
          runtimeConfig(),
          { vpn: "work" },
          (_command, label) =>
            Effect.sync(() => {
              commands.push(label);
              return { stdout: "", stderr: "status failed", exitCode: 1 };
            }),
          Effect.sync(() => {
            workRan = true;
          }),
          { runGuardianInProcess: true },
        ),
      ),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.message).toBe(
        `VPN prerequisite "work" has unknown ownership: ${POISONED_EVIDENCE}`,
      );
    }
    expect(workRan).toBe(false);
    expect(commands).toEqual([statusLabel()]);
    const store = VpnStore.open(driver, { root: runtimeRoot });
    expect(store.snapshot()).toMatchObject({
      lifecycle: "UNKNOWN",
      evidence: POISONED_EVIDENCE,
    });
    store.close();
  });

  test("UNKNOWN never reconciles while another lease is active", async () => {
    const runtimeRoot = root();
    process.env.AGENT_TOOLS_RUNTIME_DIR = runtimeRoot;
    await poisonUnknown(runtimeRoot);
    const holder = VpnStore.open(driver, { root: runtimeRoot });
    reserve(holder, "held-lease", "held-guardian", 20);
    expect(holder.activateLease("held-lease", "held-guardian", 21)).toBe(true);
    holder.close();

    const state = { connected: false, commands: [] as string[] };
    const result = await Effect.runPromise(
      Effect.result(
        runWithProfilePrerequisites(
          runtimeConfig(),
          { vpn: "work" },
          commandRunner(state),
          Effect.void,
          { runGuardianInProcess: true },
        ),
      ),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.hint).toBe(
        "Another agent-tools process holds an active lease on this VPN. Retry once it has finished.",
      );
    }
    expect(state.commands).toEqual([]);
    const store = VpnStore.open(driver, { root: runtimeRoot });
    expect(store.snapshot()).toMatchObject({
      lifecycle: "UNKNOWN",
      evidence: POISONED_EVIDENCE,
      activeLeases: 1,
    });
    store.close();
  });

  test("preserves direct-first retry and missing-config errors", async () => {
    process.env.AGENT_TOOLS_RUNTIME_DIR = root();
    let attempts = 0;
    const operation = Effect.try({
      try: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("direct miss");
        return "ok";
      },
      catch: (error) => error as Error,
    });
    const state = { connected: false, commands: [] as string[] };
    const value = await Effect.runPromise(
      runWithProfilePrerequisites(
        runtimeConfig(),
        { vpn: "work" },
        commandRunner(state),
        operation,
        {
          tryWithoutPrerequisites: true,
          runGuardianInProcess: true,
        },
      ),
    );
    expect(value).toBe("ok");
    expect(attempts).toBe(2);

    const missing = await Effect.runPromise(
      Effect.result(
        runWithProfilePrerequisites({}, { vpn: "missing" }, commandRunner(state), Effect.void, {
          runGuardianInProcess: true,
        }),
      ),
    );
    expect(missing._tag).toBe("Failure");
  });
});

test("status command and parsers handle exact cross-platform names", () => {
  const linux = {
    type: "linux-nmcli",
    platform: "linux",
    connectionName: String.raw`Office\:VPN`,
  } as const;
  const windows = {
    type: "windows-rasdial",
    platform: "win32",
    entryName: "VPN",
  } as const;
  const macos = {
    type: "macos-scutil",
    platform: "darwin",
    serviceName: "Office VPN",
  } as const;

  expect(vpnCommandSpec(linux, "status").args).toEqual([
    "-t",
    "-e",
    "no",
    "-f",
    "NAME",
    "connection",
    "show",
    "--active",
  ]);
  expect(
    parseVpnStatus(linux, {
      stdout: `${linux.connectionName}\r\n`,
      exitCode: 0,
    }),
  ).toBe(true);
  expect(parseVpnStatus(linux, { stdout: "Office:VPN\r\n", exitCode: 0 })).toBe(false);

  const footer = "Command completed successfully.";
  expect(
    parseVpnStatus(windows, {
      stdout: `Connected to\r\nCorpVPN\r\n${footer}\r\n`,
      exitCode: 0,
    }),
  ).toBe(false);
  expect(
    parseVpnStatus(windows, {
      stdout: `Connected to\r\n  VPN  \r\n${footer}\r\n`,
      exitCode: 0,
    }),
  ).toBe(true);
  expect(parseVpnStatus(windows, { stdout: `No connections\r\n${footer}\r\n`, exitCode: 0 })).toBe(
    false,
  );
  expect(
    parseVpnStatus(windows, { stdout: "Connected to\r\nVPN\r\n", exitCode: 0 }),
  ).toBeUndefined();
  expect(parseVpnStatus(windows, { stdout: `VPN\r\n${footer}\r\n`, exitCode: 0 })).toBeUndefined();

  for (const collision of ["No connections", footer]) {
    const collisionDriver = { ...windows, entryName: collision };
    expect(
      parseVpnStatus(collisionDriver, {
        stdout: `No connections\r\n${footer}\r\n`,
        exitCode: 0,
      }),
    ).toBe(false);
    expect(
      parseVpnStatus(collisionDriver, {
        stdout: `Connected to\r\n${collision}\r\n${footer}\r\n`,
        exitCode: 0,
      }),
    ).toBe(true);
  }

  expect(parseVpnStatus(macos, { stdout: "Connected\r\n", exitCode: 0 })).toBe(true);
  expect(parseVpnStatus(macos, { stdout: "Disconnected\r\n", exitCode: 0 })).toBe(false);
  expect(parseVpnStatus(macos, { stdout: "Not Connected\r\n", exitCode: 0 })).toBeUndefined();
  expect(parseVpnStatus(macos, { stdout: " Connected \r\n", exitCode: 0 })).toBeUndefined();
});
