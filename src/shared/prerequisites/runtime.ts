import { fileURLToPath } from "node:url";

import { Duration, Effect, Option, Result } from "effect";

import type { AgentToolsConfig, ProfilePrerequisites, VpnConfig } from "#config/types";
import type {
  PrerequisiteCommandRunner,
  ResolvedVpnDriver,
  VpnCleanupPolicy,
} from "#shared/prerequisites/types";

import {
  makeParentVpnCommand,
  parseVpnStatus,
  sanitizeVpnDriver,
} from "#shared/prerequisites/driver-commands";
import type { GuardianInitMessage, GuardianOutboundMessage } from "#shared/prerequisites/guardian";
import { normalizeProfilePrerequisites } from "#shared/prerequisites/config";
import { PrerequisiteRunError } from "#shared/prerequisites/errors";
import type { SanitizedVpnDriver, VpnStore as VpnStoreType } from "#shared/prerequisites/store";
import { missingVpnToolHint, resolveVpnDriverConfig } from "#shared/prerequisites/vpn";

export const DEFAULT_VPN_IDLE_DISCONNECT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_DISCONNECT_TIMEOUT_MS = 10_000;
const COORDINATION_POLL_MS = 25;
const GUARDIAN_HANDOFF_TIMEOUT_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

type TimeoutScheduler = (callback: () => void, delayMs: number) => () => void;

export const scheduleLongTimeout = (
  callback: () => void,
  timeoutMs: number,
  now: () => number = Date.now,
  schedule: TimeoutScheduler = (scheduled, delayMs) => {
    const handle = setTimeout(scheduled, delayMs);
    return () => clearTimeout(handle);
  },
) => {
  const deadline = now() + timeoutMs;
  let cancelled = false;
  let cancelActive: (() => void) | undefined;
  const scheduleNext = () => {
    if (cancelled) return;
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      cancelled = true;
      callback();
      return;
    }
    cancelActive = schedule(scheduleNext, Math.min(remainingMs, MAX_TIMER_DELAY_MS));
  };
  scheduleNext();
  return () => {
    cancelled = true;
    cancelActive?.();
  };
};

const noop = () => undefined;
const readEnv = (name: string) => process.env[name];
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const vpnStartFailureMessage = (key: string, stderr: string, redactStderr: boolean) => {
  const generic = `Failed to start VPN prerequisite "${key}".`;
  return redactStderr ? generic : stderr.trim() || generic;
};

export const missingVpnSecretError = (key: string) =>
  new PrerequisiteRunError({
    message: `VPN prerequisite "${key}" requires configured credentials.`,
    hint: "Set the configured VPN secret before retrying, or remove secretEnvVar from the VPN config.",
  });

const coordinationError = (key: string, error: unknown) =>
  new PrerequisiteRunError({
    message: `Failed to coordinate VPN prerequisite "${key}": ${errorMessage(error)}`,
    hint:
      error instanceof Error && "hint" in error && typeof error.hint === "string"
        ? error.hint
        : "Retry after all agent-tools processes using this VPN have quiesced.",
  });

const isPidLive = (pid: number) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

const runStatus = <E>(driver: ResolvedVpnDriver, runCommand: PrerequisiteCommandRunner<E>) => {
  const command = makeParentVpnCommand(driver, "status");
  return runCommand(command.command, command.label).pipe(
    Effect.result,
    Effect.map((result) =>
      Result.isSuccess(result)
        ? parseVpnStatus(sanitizeVpnDriver(driver), result.success)
        : undefined,
    ),
  );
};

const runStatusBefore = <E>(
  driver: ResolvedVpnDriver,
  deadline: number,
  runCommand: PrerequisiteCommandRunner<E>,
) =>
  Effect.suspend(() => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return Effect.succeed(undefined);
    return runStatus(driver, runCommand).pipe(
      Effect.timeoutOption(Duration.millis(remainingMs)),
      Effect.map(Option.getOrUndefined),
    );
  });

const waitForConnected = <E>(
  driver: ResolvedVpnDriver,
  deadline: number,
  runCommand: PrerequisiteCommandRunner<E>,
) =>
  Effect.gen(function* () {
    let last: boolean | undefined;
    while (true) {
      last = yield* runStatusBefore(driver, deadline, runCommand);
      if (last === true) return true as const;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return last;
      yield* Effect.sleep(Duration.millis(Math.min(250, remainingMs)));
    }
  });

type GuardianHandle = {
  readonly leaseId: string;
  readonly stableGuardianId: () => Promise<string>;
  readonly release: () => Promise<void>;
};

type GuardianSpawner = typeof Bun.spawn;

const safeGuardianEnvironment = (excludedName?: string) =>
  Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "WINDIR"].flatMap((name) => {
      const value = process.env[name];
      return value === undefined || name === excludedName ? [] : [[name, value]];
    }),
  );

const guardianInit = (
  driver: SanitizedVpnDriver,
  runtimeRoot: string,
  config: VpnConfig,
  cleanup: VpnCleanupPolicy,
  leaseId: string,
  guardianId: string,
): GuardianInitMessage => {
  return {
    type: "INIT",
    driver,
    runtimeRoot,
    leaseId,
    guardianId,
    ownerPid: process.pid,
    cleanup,
    idleDisconnectMs: config.idleDisconnectMs ?? DEFAULT_VPN_IDLE_DISCONNECT_MS,
    disconnectTimeoutMs: config.disconnectTimeoutMs ?? DEFAULT_DISCONNECT_TIMEOUT_MS,
  };
};

const spawnDetachedGuardian = async (
  driver: ResolvedVpnDriver,
  config: VpnConfig,
  cleanup: VpnCleanupPolicy,
  spawn: GuardianSpawner = Bun.spawn,
): Promise<GuardianHandle> => {
  type Generation = {
    readonly guardianId: string;
    readonly child: ReturnType<typeof Bun.spawn>;
  };
  type Phase = "starting" | "ready" | "replacing" | "releasing" | "released" | "failed";

  const { getVpnStoreLocation, VpnStore } = await import("#shared/prerequisites/store");
  const sanitizedDriver = sanitizeVpnDriver(driver);
  const runtimeRoot = getVpnStoreLocation(sanitizedDriver).root;
  const leaseId = crypto.randomUUID();
  let phase: Phase = "starting";
  let active: Generation | undefined;
  let candidate: Generation | undefined;
  let replacements = 0;
  let replacementFailure: Error | undefined;
  let replacementInFlight: Promise<void> | undefined;
  let failedCleanup: Promise<void> | undefined;
  let releaseResolve: (() => void) | undefined;
  let releaseReject: ((error: Error) => void) | undefined;
  let releaseInFlight: Promise<void> | undefined;

  const cleanupLease = () => {
    let store: VpnStoreType | undefined;
    try {
      store = VpnStore.open(sanitizedDriver, { root: runtimeRoot });
      store.abandonLease(leaseId, Date.now());
    } catch {
      noop();
    } finally {
      try {
        store?.close();
      } catch {
        noop();
      }
    }
  };
  const cleanupFailedLease = () => (failedCleanup ??= Promise.resolve().then(cleanupLease));
  const failReplacement = (error: unknown) => {
    replacementFailure = error instanceof Error ? error : new Error(errorMessage(error));
    phase = "failed";
    releaseReject?.(replacementFailure);
  };

  const spawnGeneration = async (): Promise<Generation> => {
    const guardianId = crypto.randomUUID();
    let readyResolve!: () => void;
    let readyReject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const entry = fileURLToPath(new URL("./guardian-entry.ts", import.meta.url));
    const child = spawn([process.execPath, entry], {
      detached: true,
      env: safeGuardianEnvironment(
        driver.type === "macos-scutil" ? driver.secretEnvVar : undefined,
      ),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      ipc(message: GuardianOutboundMessage) {
        if (
          message.type === "READY" &&
          message.leaseId === leaseId &&
          message.guardianId === guardianId
        ) {
          readyResolve();
        } else if (message.type === "RELEASED" && message.leaseId === leaseId) {
          releaseResolve?.();
        } else if (message.type === "ERROR") {
          const error = new Error(message.message);
          readyReject(error);
          releaseReject?.(error);
        }
      },
    });
    const generation = { guardianId, child };
    candidate = generation;
    child.send(guardianInit(sanitizedDriver, runtimeRoot, config, cleanup, leaseId, guardianId));
    const timeout = setTimeout(
      () => readyReject(new Error("Timed out waiting for VPN lease guardian readiness.")),
      GUARDIAN_HANDOFF_TIMEOUT_MS,
    );
    try {
      await Promise.race([
        ready,
        child.exited.then((code) => {
          throw new Error(`VPN lease guardian exited before readiness (${code}).`);
        }),
      ]);
    } catch (error) {
      if (candidate === generation) candidate = undefined;
      child.kill();
      await child.exited.catch(noop);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    child.unref();
    active = generation;
    candidate = undefined;
    return generation;
  };

  const observe = (generation: Generation) => {
    void generation.child.exited.then(
      (code) => {
        if (active !== generation) return;
        active = undefined;
        if (phase !== "ready") return;
        if (replacements >= 1) {
          failReplacement(new Error(`VPN lease guardian exited (${code}).`));
          return;
        }
        replacements += 1;
        phase = "replacing";
        replacementInFlight = spawnGeneration()
          .then((replacement) => {
            if (phase === "releasing") {
              replacement.child.send({ type: "RELEASE", leaseId });
            } else if (phase === "replacing") {
              phase = "ready";
              observe(replacement);
            }
            return undefined;
          })
          .catch((error) => {
            failReplacement(error);
            throw replacementFailure;
          });
        void replacementInFlight.catch(noop);
        return undefined;
      },
      (error) => {
        if (active === generation) active = undefined;
        failReplacement(error);
        return undefined;
      },
    );
  };

  let generation: Generation;
  try {
    generation = await spawnGeneration();
  } catch (error) {
    await cleanupLease();
    replacements += 1;
    try {
      generation = await spawnGeneration();
    } catch (replacementError) {
      await cleanupLease();
      throw replacementError instanceof Error
        ? replacementError
        : new Error(errorMessage(replacementError), { cause: error });
    }
  }
  phase = "ready";
  observe(generation);

  const stableGuardianId = async () => {
    if (phase === "replacing") await replacementInFlight;
    if (phase === "failed") {
      await cleanupFailedLease();
      throw replacementFailure ?? new Error("VPN lease guardian replacement failed.");
    }
    const current = active;
    if (phase !== "ready" || !current) {
      throw replacementFailure ?? new Error("VPN lease guardian is unavailable.");
    }
    if (current.child.exitCode !== null) {
      await Promise.resolve();
      return stableGuardianId();
    }
    return current.guardianId;
  };

  const release = (): Promise<void> => {
    if (phase === "released") return Promise.resolve();
    if (releaseInFlight) return releaseInFlight;
    if (phase === "failed") {
      return cleanupFailedLease().then(() => {
        throw replacementFailure ?? new Error("VPN lease guardian replacement failed.");
      });
    }
    if (phase === "replacing" && !candidate) {
      return (replacementInFlight ?? Promise.resolve()).then(release, async (error: unknown) => {
        await cleanupFailedLease();
        throw error;
      });
    }
    phase = "releasing";
    const target = candidate ?? active;
    if (!target) return Promise.reject(new Error("VPN lease guardian is unavailable."));
    const releaseTimeoutMs =
      config.idleDisconnectMs === 0
        ? (config.disconnectTimeoutMs ?? DEFAULT_DISCONNECT_TIMEOUT_MS) +
          GUARDIAN_HANDOFF_TIMEOUT_MS
        : GUARDIAN_HANDOFF_TIMEOUT_MS;
    releaseInFlight = new Promise<void>((resolve, reject) => {
      let settled = false;
      let cancelTimeout: () => void = noop;
      const settleResolve = () => {
        if (settled) return;
        settled = true;
        cancelTimeout();
        releaseResolve = undefined;
        releaseReject = undefined;
        resolve();
      };
      const settleReject = (error: Error) => {
        if (settled) return;
        settled = true;
        cancelTimeout();
        releaseResolve = undefined;
        releaseReject = undefined;
        reject(error);
      };
      cancelTimeout = scheduleLongTimeout(
        () => settleReject(new Error("Timed out waiting for VPN lease guardian release.")),
        releaseTimeoutMs,
      );
      releaseResolve = settleResolve;
      releaseReject = settleReject;
      try {
        target.child.send({ type: "RELEASE", leaseId });
        void target.child.exited.then(
          (code) => {
            if (phase === "releasing") {
              settleReject(new Error(`VPN lease guardian exited during release (${code}).`));
            }
            return undefined;
          },
          (error) => {
            settleReject(error instanceof Error ? error : new Error(errorMessage(error)));
          },
        );
      } catch (error) {
        settleReject(error instanceof Error ? error : new Error(errorMessage(error)));
      }
    }).then(() => {
      phase = "released";
      target.child.disconnect();
      return undefined;
    });
    return releaseInFlight;
  };

  return { leaseId, stableGuardianId, release };
};

const makeInlineGuardian = async <E>(
  driver: ResolvedVpnDriver,
  config: VpnConfig,
  cleanup: VpnCleanupPolicy,
  runCommand: PrerequisiteCommandRunner<E>,
): Promise<GuardianHandle> => {
  const [{ runGuardian }, { getVpnStoreLocation }] = await Promise.all([
    import("#shared/prerequisites/guardian"),
    import("#shared/prerequisites/store"),
  ]);
  const leaseId = crypto.randomUUID();
  const guardianId = crypto.randomUUID();
  const sanitizedDriver = sanitizeVpnDriver(driver);
  const init = guardianInit(
    sanitizedDriver,
    getVpnStoreLocation(sanitizedDriver).root,
    config,
    cleanup,
    leaseId,
    guardianId,
  );
  const guardian = await runGuardian(
    init,
    () => undefined,
    (action) => {
      const command = makeParentVpnCommand(driver, action);
      return Effect.runPromise(runCommand(command.command, command.label));
    },
  );
  return {
    leaseId,
    stableGuardianId: () => Promise.resolve(guardianId),
    release: guardian.release,
  };
};

const startGuardian = <E>(
  driver: ResolvedVpnDriver,
  config: VpnConfig,
  cleanup: VpnCleanupPolicy,
  runCommand: PrerequisiteCommandRunner<E>,
  runGuardianInProcess: boolean,
  spawn?: GuardianSpawner,
) =>
  runGuardianInProcess
    ? makeInlineGuardian(driver, config, cleanup, runCommand)
    : spawnDetachedGuardian(driver, config, cleanup, spawn);

type ReleasableGuardian = { readonly release: () => Promise<void> };
type HeldVpnLease = { readonly guardian: GuardianHandle };

const safelyReleaseGuardian = (guardian: ReleasableGuardian) =>
  Effect.promise(() =>
    Promise.resolve()
      .then(() => guardian.release())
      .catch(noop),
  );

export const releaseHeldLeases = (leases: readonly { readonly guardian: ReleasableGuardian }[]) =>
  leases
    .toReversed()
    .reduce(
      (released, held) => released.pipe(Effect.andThen(safelyReleaseGuardian(held.guardian))),
      Effect.void,
    );

export const closeVpnStoreAfter = <A, E>(
  key: string,
  guardian: ReleasableGuardian,
  close: () => void,
  body: Effect.Effect<A, E, never>,
): Effect.Effect<A, E | PrerequisiteRunError, never> =>
  Effect.matchCauseEffect(body, {
    onFailure: (cause) =>
      Effect.exit(Effect.sync(close)).pipe(Effect.andThen(Effect.failCause(cause))),
    onSuccess: (value) =>
      Effect.try({
        try: close,
        catch: (error) => coordinationError(key, error),
      }).pipe(
        Effect.catch((error) =>
          safelyReleaseGuardian(guardian).pipe(Effect.andThen(Effect.fail(error))),
        ),
        Effect.map(() => value),
      ),
  });

const acquireVpn = <E>(
  key: string,
  driver: ResolvedVpnDriver,
  config: VpnConfig,
  cleanup: VpnCleanupPolicy,
  runCommand: PrerequisiteCommandRunner<E>,
  runGuardianInProcess: boolean,
  spawn?: GuardianSpawner,
) =>
  Effect.gen(function* () {
    const guardian = yield* Effect.tryPromise({
      try: () => startGuardian(driver, config, cleanup, runCommand, runGuardianInProcess, spawn),
      catch: (error) => coordinationError(key, error),
    });
    const releaseGuardian = safelyReleaseGuardian(guardian);
    const fail = (error: PrerequisiteRunError) =>
      releaseGuardian.pipe(Effect.andThen(Effect.fail(error)));
    const store = yield* Effect.tryPromise({
      try: async () => {
        const { VpnStore } = await import("#shared/prerequisites/store");
        return VpnStore.open(sanitizeVpnDriver(driver));
      },
      catch: (error) => coordinationError(key, error),
    }).pipe(Effect.catch(fail));
    const connectTimeoutMs = config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const idleDisconnectMs = config.idleDisconnectMs ?? DEFAULT_VPN_IDLE_DISCONNECT_MS;
    const connectDeadline = Date.now() + connectTimeoutMs;
    const stoppingCoordinationDeadline =
      connectDeadline + (config.disconnectTimeoutMs ?? DEFAULT_DISCONNECT_TIMEOUT_MS);
    const activateGuardianLease = Effect.tryPromise({
      try: async () => {
        const guardianId = await guardian.stableGuardianId();
        return store.activateLease(guardian.leaseId, guardianId, Date.now());
      },
      catch: (error) => coordinationError(key, error),
    }).pipe(Effect.catch(fail));

    const acquisition = Effect.gen(function* () {
      try {
        store.deleteDeadLeases(isPidLive, idleDisconnectMs, Date.now());
        while (true) {
          const snapshot = store.snapshot();
          if (snapshot.lifecycle === "UNKNOWN") {
            if (snapshot.activeLeases === 0) {
              const observed = yield* runStatusBefore(driver, connectDeadline, runCommand);
              if (
                observed !== undefined &&
                (store.reconcileUnknown(snapshot, observed, Date.now()) ||
                  store.snapshot().lifecycle !== "UNKNOWN")
              ) {
                continue;
              }
            }
            return yield* fail(
              new PrerequisiteRunError({
                message: `VPN prerequisite "${key}" has unknown ownership: ${snapshot.evidence ?? "no evidence"}`,
                hint: missingVpnToolHint(driver),
              }),
            );
          }
          if (snapshot.lifecycle === "ACTIVE" || snapshot.lifecycle === "IDLE") {
            if (yield* activateGuardianLease) return guardian;
            const remainingMs = connectDeadline - Date.now();
            if (remainingMs <= 0) {
              return yield* fail(coordinationError(key, "Guardian lease reservation was lost."));
            }
            yield* Effect.sleep(Duration.millis(Math.min(COORDINATION_POLL_MS, remainingMs)));
            continue;
          }
          if (snapshot.lifecycle === "EXTERNAL") {
            const guard = store.claimExternalCheck(
              crypto.randomUUID(),
              crypto.randomUUID(),
              process.pid,
              Date.now(),
            );
            if (!guard) continue;
            const claimed = store.snapshot();
            const connected = yield* runStatusBefore(driver, connectDeadline, runCommand);
            if (connected === undefined) {
              store.reconcileOperation(claimed, undefined, Date.now());
              return yield* fail(
                new PrerequisiteRunError({
                  message: `Could not confirm external VPN prerequisite "${key}" status.`,
                  hint: missingVpnToolHint(driver),
                }),
              );
            }
            if (!store.commitCheck(guard, connected, Date.now())) continue;
            if (!connected) continue;
            if (yield* activateGuardianLease) return guardian;
            continue;
          }
          if (
            snapshot.lifecycle === "CHECKING" ||
            snapshot.lifecycle === "STARTING" ||
            snapshot.lifecycle === "STOPPING"
          ) {
            const operationDeadline =
              snapshot.lifecycle === "STOPPING" ? stoppingCoordinationDeadline : connectDeadline;
            const remainingMs = operationDeadline - Date.now();
            if (remainingMs <= 0) {
              store.reconcileOperation(snapshot, undefined, Date.now());
              return yield* fail(
                coordinationError(key, `Timed out waiting for ${snapshot.lifecycle}.`),
              );
            }
            if (snapshot.operationPid !== null && !isPidLive(snapshot.operationPid)) {
              if (snapshot.lifecycle !== "CHECKING") {
                store.reconcileOperation(snapshot, undefined, Date.now());
                continue;
              }
              const connected = yield* runStatusBefore(driver, connectDeadline, runCommand);
              store.reconcileOperation(snapshot, connected, Date.now());
              continue;
            }
            const sleepRemainingMs = operationDeadline - Date.now();
            if (sleepRemainingMs <= 0) continue;
            yield* Effect.sleep(Duration.millis(Math.min(COORDINATION_POLL_MS, sleepRemainingMs)));
            continue;
          }

          const checkGuard = store.claimCheck(
            crypto.randomUUID(),
            crypto.randomUUID(),
            process.pid,
            Date.now(),
          );
          if (!checkGuard) continue;
          const claimedCheck = store.snapshot();
          const connected = yield* runStatusBefore(driver, connectDeadline, runCommand);
          if (connected === undefined) {
            store.reconcileOperation(claimedCheck, undefined, Date.now());
            return yield* fail(
              new PrerequisiteRunError({
                message: `Could not determine VPN prerequisite "${key}" status.`,
                hint: missingVpnToolHint(driver),
              }),
            );
          }
          if (!store.commitCheck(checkGuard, connected, Date.now())) continue;
          if (connected) {
            if (yield* activateGuardianLease) return guardian;
            continue;
          }

          if (
            driver.type === "macos-scutil" &&
            driver.secretEnvVar &&
            !readEnv(driver.secretEnvVar)
          ) {
            return yield* fail(missingVpnSecretError(key));
          }
          const startGuard = store.claimStart(
            crypto.randomUUID(),
            crypto.randomUUID(),
            process.pid,
            Date.now(),
          );
          if (!startGuard) continue;
          const startSecret =
            driver.type === "macos-scutil" && driver.secretEnvVar
              ? readEnv(driver.secretEnvVar)
              : undefined;
          const startCommand = makeParentVpnCommand(driver, "start", startSecret);
          const startRemainingMs = connectDeadline - Date.now();
          const startResult =
            startRemainingMs <= 0
              ? Option.none()
              : yield* runCommand(startCommand.command, startCommand.label).pipe(
                  Effect.result,
                  Effect.timeoutOption(Duration.millis(startRemainingMs)),
                );
          if (Option.isNone(startResult) || Result.isFailure(startResult.value)) {
            const message = `VPN prerequisite "${key}" start timed out or failed after dispatch.`;
            store.commitStart(startGuard, "unknown", crypto.randomUUID(), message, Date.now());
            return yield* fail(
              new PrerequisiteRunError({
                message,
                hint: missingVpnToolHint(driver),
              }),
            );
          }
          if (startResult.value.success.exitCode !== 0) {
            const message = vpnStartFailureMessage(
              key,
              startResult.value.success.stderr,
              startSecret !== undefined,
            );
            store.commitStart(startGuard, "down", crypto.randomUUID(), message, Date.now());
            return yield* fail(
              new PrerequisiteRunError({
                message,
                hint: missingVpnToolHint(driver),
              }),
            );
          }
          const ready = yield* waitForConnected(driver, connectDeadline, runCommand);
          if (ready !== true) {
            store.commitStart(
              startGuard,
              "unknown",
              crypto.randomUUID(),
              ready === false
                ? "VPN start completed but was not confirmed connected before the deadline."
                : "VPN start confirmation failed, timed out, or was unparseable.",
              Date.now(),
            );
            return yield* fail(
              new PrerequisiteRunError({
                message: `VPN prerequisite "${key}" did not connect within timeout.`,
                hint: missingVpnToolHint(driver),
              }),
            );
          }
          store.commitStart(
            startGuard,
            "managed",
            crypto.randomUUID(),
            "VPN start confirmed connected.",
            Date.now(),
          );
        }
      } catch (error) {
        return yield* fail(
          error instanceof PrerequisiteRunError ? error : coordinationError(key, error),
        );
      }
    });
    return yield* closeVpnStoreAfter(key, guardian, () => store.close(), acquisition);
  });

export const runWithProfilePrerequisites = <A, E, CommandError>(
  config: AgentToolsConfig,
  profile: ProfilePrerequisites,
  runCommand: PrerequisiteCommandRunner<CommandError>,
  effect: Effect.Effect<A, E, never>,
  options?: {
    /** Caller proved the target is already reachable: skip the VPN entirely (no status, no lease). */
    alreadySatisfied?: boolean;
    tryWithoutPrerequisites?: boolean;
    runGuardianInProcess?: boolean;
    guardianSpawn?: GuardianSpawner;
  },
): Effect.Effect<A, E | PrerequisiteRunError, never> => {
  const vpnPrerequisites = normalizeProfilePrerequisites(profile).filter(
    (prerequisite) => prerequisite.type === "vpn",
  );
  if (vpnPrerequisites.length === 0 || options?.alreadySatisfied === true) return effect;

  return Effect.gen(function* () {
    const tryDirect = () => effect.pipe(Effect.result);
    if (options?.tryWithoutPrerequisites) {
      const direct = yield* tryDirect();
      if (Result.isSuccess(direct)) return direct.success;
    }

    const prerequisiteResult = yield* Effect.gen(function* () {
      const held: HeldVpnLease[] = [];
      const acquired = yield* Effect.gen(function* () {
        for (const prerequisite of vpnPrerequisites) {
          const vpnConfig = config.vpns?.[prerequisite.key];
          if (!vpnConfig) {
            return yield* new PrerequisiteRunError({
              message: `VPN prerequisite "${prerequisite.key}" is not defined.`,
              hint: `Add vpns.${prerequisite.key} to agent-tools.json5 or remove the prerequisite.`,
            });
          }
          const resolution = resolveVpnDriverConfig(vpnConfig);
          if (!resolution.success) {
            return yield* new PrerequisiteRunError({
              message: resolution.error,
              hint: resolution.hint,
            });
          }
          const cleanup = prerequisite.cleanup ?? vpnConfig.defaultCleanup ?? "stop-if-started";
          const guardian = yield* acquireVpn(
            prerequisite.key,
            resolution.driver,
            vpnConfig,
            cleanup,
            runCommand,
            options?.runGuardianInProcess === true,
            options?.guardianSpawn,
          );
          held.push({ guardian });
        }
      }).pipe(Effect.result);

      if (Result.isFailure(acquired)) {
        yield* releaseHeldLeases(held);
        return yield* Effect.fail(acquired.failure);
      }
      return yield* effect.pipe(Effect.ensuring(releaseHeldLeases(held)));
    }).pipe(Effect.result);

    if (Result.isSuccess(prerequisiteResult)) return prerequisiteResult.success;
    if (
      options?.tryWithoutPrerequisites &&
      prerequisiteResult.failure instanceof PrerequisiteRunError
    ) {
      const retry = yield* tryDirect();
      if (Result.isSuccess(retry)) return retry.success;
      if (!(retry.failure instanceof PrerequisiteRunError))
        return yield* Effect.fail(retry.failure);
    }
    return yield* Effect.fail(prerequisiteResult.failure);
  });
};
