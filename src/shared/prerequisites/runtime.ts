// Synchronous node:fs calls keep the cross-process lock/lease critical section atomic;
// Bun does not provide equivalent synchronous directory primitives for this use case.
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";

import { Clock, Duration, Effect, Result } from "effect";
import { ChildProcess } from "effect/unstable/process";

import type { AgentToolsConfig, ProfilePrerequisites } from "#config/types";
import type {
  PrerequisiteCommandRunner,
  ResolvedVpnDriver,
  VpnCleanupPolicy,
  VpnLease,
  VpnLeaseHandle,
  VpnLockOwner,
  VpnStartState,
} from "#shared/prerequisites/types";

import { joinPath } from "#shared/path";
import { normalizeProfilePrerequisites } from "#shared/prerequisites/config";
import { PrerequisiteRunError } from "#shared/prerequisites/errors";
import { missingVpnToolHint, resolveVpnDriverConfig } from "#shared/prerequisites/vpn";

const readEnv = (name: string) => Bun.env[name];

const DEFAULT_LEASE_TTL_MS = 10 * 60 * 1000;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_BUFFER_MS = 5_000;

const getRuntimeRoot = () =>
  readEnv("AGENT_TOOLS_RUNTIME_DIR") ??
  joinPath(readEnv("TMPDIR") ?? readEnv("TEMP") ?? readEnv("TMP") ?? "/tmp", "agent-tools");

const getDriverIdentity = (driver: ResolvedVpnDriver) => {
  if (driver.type === "macos-scutil") {
    return { type: driver.type, platform: driver.platform, serviceName: driver.serviceName };
  }

  if (driver.type === "linux-nmcli") {
    return { type: driver.type, platform: driver.platform, connectionName: driver.connectionName };
  }

  return { type: driver.type, platform: driver.platform, entryName: driver.entryName };
};

const getDriverLeaseKey = (driver: ResolvedVpnDriver) =>
  Bun.hash(JSON.stringify(getDriverIdentity(driver))).toString(16);

const makeLeaseHandle = (
  driver: ResolvedVpnDriver,
  ttlMs: number,
  lockTimeoutMs: number,
): VpnLeaseHandle => {
  const key = getDriverLeaseKey(driver);
  const directory = joinPath(getRuntimeRoot(), "vpn-prerequisites", key);
  return {
    directory,
    leasePath: joinPath(directory, `lease-${process.pid}.json`),
    statePath: joinPath(directory, "started.json"),
    lockPath: joinPath(directory, "lock"),
    ttlMs,
    lockTimeoutMs,
  };
};

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const hasErrorCode = (error: unknown, code: string) =>
  typeof error === "object" && error !== null && "code" in error && error.code === code;

const fsError = (message: string, error: unknown) =>
  new PrerequisiteRunError({
    message: `${message}: ${getErrorMessage(error)}`,
    hint: "Retry the command. If this repeats, remove stale files under the agent-tools runtime directory.",
  });

const syncFs = <A>(message: string, operation: () => A) =>
  Effect.try({
    try: operation,
    catch: (error) => fsError(message, error),
  });

const readJsonFile = (path: string): unknown | undefined => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed;
  } catch (error) {
    void error;
    return undefined;
  }
};

type JsonObject = { readonly [key: string]: unknown };

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isVpnLease = (value: unknown): value is VpnLease =>
  isJsonObject(value) &&
  isFiniteNumber(value.pid) &&
  isFiniteNumber(value.createdAt) &&
  isFiniteNumber(value.updatedAt);

const isVpnStartState = (value: unknown): value is VpnStartState =>
  isJsonObject(value) && isFiniteNumber(value.pid) && isFiniteNumber(value.startedAt);

const isVpnLockOwner = (value: unknown): value is VpnLockOwner =>
  isJsonObject(value) && isFiniteNumber(value.pid) && isFiniteNumber(value.createdAt);

const readVpnLease = (path: string) => {
  const parsed = readJsonFile(path);
  return isVpnLease(parsed) ? parsed : undefined;
};

const readVpnStartState = (path: string) => {
  const parsed = readJsonFile(path);
  return isVpnStartState(parsed) ? parsed : undefined;
};

const readVpnLockOwner = (path: string) => {
  const parsed = readJsonFile(path);
  return isVpnLockOwner(parsed) ? parsed : undefined;
};

const isPidLive = (pid: number) => {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

const isLeaseLive = (lease: VpnLease | undefined, now: number, ttlMs: number) => {
  if (!lease) {
    return false;
  }

  if (isPidLive(lease.pid)) {
    return true;
  }

  return now - lease.updatedAt <= ttlMs;
};

const pruneStaleLeases = (handle: VpnLeaseHandle, now: number) =>
  syncFs("Failed to prune VPN prerequisite lease files", () => {
    for (const entry of readdirSync(handle.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith("lease-") || !entry.name.endsWith(".json")) {
        continue;
      }

      const leasePath = joinPath(handle.directory, entry.name);
      const lease = readVpnLease(leasePath);
      if (!isLeaseLive(lease, now, handle.ttlMs)) {
        rmSync(leasePath, { force: true });
      }
    }
  });

const hasOtherLiveLeases = (handle: VpnLeaseHandle, now: number) =>
  Effect.gen(function* () {
    yield* pruneStaleLeases(handle, now);

    return yield* syncFs("Failed to inspect VPN prerequisite lease files", () => {
      for (const entry of readdirSync(handle.directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.startsWith("lease-") || !entry.name.endsWith(".json")) {
          continue;
        }

        const leasePath = joinPath(handle.directory, entry.name);
        if (leasePath === handle.leasePath) {
          continue;
        }

        const lease = readVpnLease(leasePath);
        if (isLeaseLive(lease, now, handle.ttlMs)) {
          return true;
        }
      }

      return false;
    });
  });

const writeLease = (handle: VpnLeaseHandle, now: number) =>
  syncFs("Failed to write VPN prerequisite lease", () => {
    mkdirSync(handle.directory, { recursive: true });
    const existingLease = readVpnLease(handle.leasePath);
    const lease: VpnLease = {
      pid: process.pid,
      createdAt: existingLease?.createdAt ?? now,
      updatedAt: now,
    };
    writeFileSync(handle.leasePath, JSON.stringify(lease));
  });

const writeStartState = (handle: VpnLeaseHandle, now: number) =>
  syncFs("Failed to write VPN prerequisite start state", () => {
    const state: VpnStartState = { pid: process.pid, startedAt: now };
    writeFileSync(handle.statePath, JSON.stringify(state));
  });

const readStartState = (handle: VpnLeaseHandle) =>
  syncFs("Failed to read VPN prerequisite start state", () => readVpnStartState(handle.statePath));

const removeOwnLease = (handle: VpnLeaseHandle) =>
  syncFs("Failed to remove VPN prerequisite lease", () => {
    rmSync(handle.leasePath, { force: true });
  });

const removeStartState = (handle: VpnLeaseHandle) =>
  syncFs("Failed to remove VPN prerequisite start state", () => {
    rmSync(handle.statePath, { force: true });
  });

const getLockDirectoryAgeMs = (handle: VpnLeaseHandle, now: number) =>
  syncFs("Failed to inspect VPN prerequisite lease lock", () => {
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(handle.lockPath);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        return undefined;
      }

      throw error;
    }

    return now - stats.mtimeMs;
  });

const isLockOwnerStale = (
  owner: VpnLockOwner | undefined,
  lockAgeMs: number,
  timeoutMs: number,
) => {
  const staleThresholdMs = Math.max(LOCK_STALE_MS, timeoutMs);
  if (!owner) {
    return lockAgeMs > staleThresholdMs;
  }

  return !isPidLive(owner.pid) && lockAgeMs > staleThresholdMs;
};

const acquireFileLock = (handle: VpnLeaseHandle) =>
  Effect.gen(function* () {
    yield* syncFs("Failed to create VPN prerequisite lease directory", () => {
      mkdirSync(handle.directory, { recursive: true });
    });
    const start = yield* Clock.currentTimeMillis;

    while (true) {
      const now = yield* Clock.currentTimeMillis;
      let lockError: unknown;
      try {
        mkdirSync(handle.lockPath);
        writeFileSync(
          joinPath(handle.lockPath, "owner.json"),
          `{"pid":${process.pid},"createdAt":${Number(now)}}`,
        );
        return;
      } catch (error) {
        lockError = error;
      }

      if (!hasErrorCode(lockError, "EEXIST")) {
        return yield* fsError("Failed to acquire VPN prerequisite lease lock", lockError);
      }

      const lockOwner = readVpnLockOwner(joinPath(handle.lockPath, "owner.json"));
      const lockAgeMs = yield* getLockDirectoryAgeMs(handle, Number(now));
      if (lockAgeMs === undefined) {
        continue;
      }

      if (isLockOwnerStale(lockOwner, lockAgeMs, handle.lockTimeoutMs)) {
        yield* syncFs("Failed to remove stale VPN prerequisite lease lock", () => {
          rmSync(handle.lockPath, { recursive: true, force: true });
        });
        continue;
      }

      if (Number(now) - Number(start) > handle.lockTimeoutMs) {
        return yield* new PrerequisiteRunError({
          message: "Timed out while waiting for VPN prerequisite lease lock.",
          hint: "Retry the command. If this repeats, remove stale files under the agent-tools runtime directory.",
        });
      }

      yield* Effect.sleep(Duration.millis(LOCK_RETRY_MS));
    }
  });

const releaseFileLock = (handle: VpnLeaseHandle) =>
  syncFs("Failed to release VPN prerequisite lease lock", () => {
    rmSync(handle.lockPath, { recursive: true, force: true });
  }).pipe(Effect.ignore);

const withVpnLeaseLock = <A, E>(
  handle: VpnLeaseHandle,
  effect: Effect.Effect<A, E, never>,
): Effect.Effect<A, E | PrerequisiteRunError, never> =>
  Effect.acquireRelease(acquireFileLock(handle), () => releaseFileLock(handle)).pipe(
    Effect.flatMap(() => effect),
    Effect.scoped,
  );

type HeldVpnLease = {
  readonly handle: VpnLeaseHandle;
  readonly driver: ResolvedVpnDriver;
  readonly cleanup: VpnCleanupPolicy;
  readonly cooldownMs: number;
};

const cleanupHeldLeases = <CommandError>(
  heldLeases: readonly HeldVpnLease[],
  runCommand: PrerequisiteCommandRunner<CommandError>,
) =>
  Effect.gen(function* () {
    for (const held of heldLeases.toReversed()) {
      if (held.cooldownMs > 0) {
        yield* Effect.sleep(Duration.millis(held.cooldownMs));
      }

      yield* withVpnLeaseLock(
        held.handle,
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          yield* removeOwnLease(held.handle);
          if (held.cleanup === "leave-running") {
            // Treat the agent-started VPN as intentionally adopted so later default runs do not stop it.
            yield* removeStartState(held.handle);
            return;
          }

          const state = yield* readStartState(held.handle);
          const hasOtherLeases = yield* hasOtherLiveLeases(held.handle, Number(now));
          const shouldStop = state !== undefined && !hasOtherLeases;

          if (!shouldStop) {
            return;
          }

          const stopCommand = makeVpnCommand(held.driver, "stop");
          yield* runCommand(stopCommand.command, stopCommand.label).pipe(Effect.ignore);
          yield* removeStartState(held.handle);
        }),
      ).pipe(Effect.ignore);
    }
  });

const makeVpnCommand = (driver: ResolvedVpnDriver, action: "status" | "start" | "stop") => {
  if (driver.type === "macos-scutil") {
    const secret = driver.secretEnvVar ? readEnv(driver.secretEnvVar) : undefined;
    const secretArgs = action === "start" && secret ? ["--secret", secret] : [];
    const redactedSecretArgs = secretArgs.length > 0 ? ["--secret", "<redacted>"] : [];
    const args =
      action === "status"
        ? ["--nc", "status", driver.serviceName]
        : action === "start"
          ? ["--nc", "start", driver.serviceName, ...secretArgs]
          : ["--nc", "stop", driver.serviceName];
    const labelArgs =
      action === "start" ? ["--nc", "start", driver.serviceName, ...redactedSecretArgs] : args;

    return {
      command: ChildProcess.make("scutil", args, { stdout: "pipe", stderr: "pipe" }),
      label: ["scutil", ...labelArgs].join(" "),
    };
  }

  if (driver.type === "linux-nmcli") {
    const args =
      action === "status"
        ? ["-t", "-f", "NAME", "connection", "show", "--active"]
        : action === "start"
          ? ["connection", "up", driver.connectionName]
          : ["connection", "down", driver.connectionName];

    return {
      command: ChildProcess.make("nmcli", args, { stdout: "pipe", stderr: "pipe" }),
      label: ["nmcli", ...args].join(" "),
    };
  }

  const args =
    action === "stop"
      ? [driver.entryName, "/disconnect"]
      : action === "start"
        ? [driver.entryName]
        : [];
  return {
    command: ChildProcess.make("rasdial", args, { stdout: "pipe", stderr: "pipe" }),
    label: ["rasdial", ...args].join(" "),
  };
};

const isVpnConnectedOutput = (driver: ResolvedVpnDriver, stdout: string) => {
  if (driver.type === "macos-scutil") {
    return stdout.includes("Connected");
  }

  if (driver.type === "linux-nmcli") {
    return stdout
      .trim()
      .split("\n")
      .some((line) => line.trim() === driver.connectionName);
  }

  return stdout.includes(driver.entryName);
};

const isVpnConnected = <E>(driver: ResolvedVpnDriver, runCommand: PrerequisiteCommandRunner<E>) => {
  const statusCommand = makeVpnCommand(driver, "status");
  return runCommand(statusCommand.command, statusCommand.label).pipe(
    Effect.result,
    Effect.map((result) => {
      if (Result.isFailure(result)) {
        return false;
      }

      return result.success.exitCode === 0 && isVpnConnectedOutput(driver, result.success.stdout);
    }),
  );
};

const waitForVpn = <E>(
  driver: ResolvedVpnDriver,
  timeoutMs: number,
  runCommand: PrerequisiteCommandRunner<E>,
) =>
  Effect.gen(function* () {
    const startTime = yield* Clock.currentTimeMillis;
    const deadline = Number(startTime) + timeoutMs;
    let result: boolean | undefined;

    yield* Effect.whileLoop({
      while: () => result === undefined,
      body: () =>
        Effect.gen(function* () {
          if (yield* isVpnConnected(driver, runCommand)) {
            result = true;
            return;
          }

          const now = yield* Clock.currentTimeMillis;
          if (Number(now) >= deadline) {
            result = false;
            return;
          }

          yield* Effect.sleep(Duration.millis(500));
        }),
      step: () => undefined,
    });

    return result === true;
  });

export const runWithProfilePrerequisites = <A, E, CommandError>(
  config: AgentToolsConfig,
  profile: ProfilePrerequisites,
  runCommand: PrerequisiteCommandRunner<CommandError>,
  effect: Effect.Effect<A, E, never>,
  options?: { tryWithoutPrerequisites?: boolean },
): Effect.Effect<A, E | PrerequisiteRunError, never> => {
  const prerequisites = normalizeProfilePrerequisites(profile);
  const vpnPrerequisites = prerequisites.filter((prerequisite) => prerequisite.type === "vpn");

  if (vpnPrerequisites.length === 0) {
    return effect;
  }

  return Effect.gen(function* () {
    const shouldTryDirect = options?.tryWithoutPrerequisites === true;

    const tryDirect = () => effect.pipe(Effect.result);

    if (shouldTryDirect) {
      const directResult = yield* tryDirect();
      if (Result.isSuccess(directResult)) {
        return directResult.success;
      }
    }

    const prerequisiteResult = yield* Effect.gen(function* () {
      const heldLeases: HeldVpnLease[] = [];
      const acquirePrerequisites = Effect.gen(function* () {
        for (const prerequisite of vpnPrerequisites) {
          const vpnConfig = config.vpns?.[prerequisite.key];
          if (!vpnConfig) {
            return yield* new PrerequisiteRunError({
              message: `VPN prerequisite "${prerequisite.key}" is not defined.`,
              hint: `Add vpns.${prerequisite.key} to agent-tools.json5 or remove the prerequisite.`,
            });
          }

          const driverResolution = resolveVpnDriverConfig(vpnConfig);
          if (!driverResolution.success) {
            return yield* new PrerequisiteRunError({
              message: driverResolution.error,
              hint: driverResolution.hint,
            });
          }

          const driver = driverResolution.driver;
          const cleanup: VpnCleanupPolicy =
            prerequisite.cleanup ?? vpnConfig.defaultCleanup ?? "stop-if-started";
          const connectTimeoutMs = vpnConfig.connectTimeoutMs ?? 30000;
          const handle = makeLeaseHandle(
            driver,
            vpnConfig.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
            connectTimeoutMs + LOCK_TIMEOUT_BUFFER_MS,
          );

          const acquisitionResult = yield* withVpnLeaseLock(
            handle,
            Effect.gen(function* () {
              const result = yield* Effect.gen(function* () {
                const now = yield* Clock.currentTimeMillis;
                yield* writeLease(handle, Number(now));
                yield* pruneStaleLeases(handle, Number(now));

                const wasConnected = yield* isVpnConnected(driver, runCommand);
                if (wasConnected) {
                  return;
                }

                if (
                  driver.type === "macos-scutil" &&
                  driver.secretEnvVar &&
                  !readEnv(driver.secretEnvVar)
                ) {
                  return yield* new PrerequisiteRunError({
                    message: `VPN secret environment variable "${driver.secretEnvVar}" is not set.`,
                    hint: `Set ${driver.secretEnvVar} before running this tool or remove secretEnvVar from the VPN config.`,
                  });
                }

                const startCommand = makeVpnCommand(driver, "start");
                const startResult = yield* runCommand(
                  startCommand.command,
                  startCommand.label,
                ).pipe(
                  Effect.mapError(
                    () =>
                      new PrerequisiteRunError({
                        message: `Failed to start VPN prerequisite "${prerequisite.key}".`,
                        hint: missingVpnToolHint(driver),
                      }),
                  ),
                );

                if (startResult.exitCode !== 0) {
                  const stderr = startResult.stderr.trim();
                  return yield* new PrerequisiteRunError({
                    message:
                      stderr !== ""
                        ? stderr
                        : `Failed to start VPN prerequisite "${prerequisite.key}".`,
                    hint: missingVpnToolHint(driver),
                  });
                }

                const ready = yield* waitForVpn(driver, connectTimeoutMs, runCommand);
                if (!ready) {
                  return yield* new PrerequisiteRunError({
                    message: `VPN prerequisite "${prerequisite.key}" did not connect within timeout.`,
                    hint: missingVpnToolHint(driver),
                  });
                }

                if (cleanup === "stop-if-started") {
                  const connectedAt = yield* Clock.currentTimeMillis;
                  yield* writeStartState(handle, Number(connectedAt));
                }
              }).pipe(Effect.result);

              if (Result.isFailure(result)) {
                yield* removeOwnLease(handle).pipe(Effect.ignore);
              }

              return result;
            }),
          ).pipe(
            Effect.mapError((error) =>
              error instanceof PrerequisiteRunError
                ? error
                : new PrerequisiteRunError({
                    message: `Failed to coordinate VPN prerequisite "${prerequisite.key}".`,
                    hint: missingVpnToolHint(driver),
                  }),
            ),
          );

          if (Result.isFailure(acquisitionResult)) {
            return yield* Effect.fail(acquisitionResult.failure);
          }

          heldLeases.push({ handle, driver, cleanup, cooldownMs: vpnConfig.cooldownMs ?? 0 });
        }
      });

      const acquireResult = yield* acquirePrerequisites.pipe(Effect.result);
      const cleanup = cleanupHeldLeases(heldLeases, runCommand);

      if (Result.isFailure(acquireResult)) {
        yield* cleanup.pipe(Effect.ignore);
        return yield* Effect.fail(acquireResult.failure);
      }

      return yield* effect.pipe(Effect.ensuring(cleanup));
    }).pipe(Effect.result);

    if (Result.isSuccess(prerequisiteResult)) {
      return prerequisiteResult.success;
    }

    if (shouldTryDirect && prerequisiteResult.failure instanceof PrerequisiteRunError) {
      const directRetryResult = yield* tryDirect();
      if (Result.isSuccess(directRetryResult)) {
        return directRetryResult.success;
      }
      if (!(directRetryResult.failure instanceof PrerequisiteRunError)) {
        return yield* Effect.fail(directRetryResult.failure);
      }
    }

    return yield* Effect.fail(prerequisiteResult.failure);
  });
};
