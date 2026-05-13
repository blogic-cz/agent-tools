import { Clock, Duration, Effect, Result } from "effect";
import { ChildProcess } from "effect/unstable/process";

import type { AgentToolsConfig, ProfilePrerequisites } from "#config/types";
import type { PrerequisiteCommandRunner, ResolvedVpnDriver } from "#shared/prerequisites/types";

import { normalizeProfilePrerequisites } from "#shared/prerequisites/config";
import { PrerequisiteRunError } from "#shared/prerequisites/errors";
import { missingVpnToolHint, resolveVpnDriverConfig } from "#shared/prerequisites/vpn";

const makeVpnCommand = (driver: ResolvedVpnDriver, action: "status" | "start" | "stop") => {
  if (driver.type === "macos-scutil") {
    const args =
      action === "status"
        ? ["--nc", "status", driver.serviceName]
        : action === "start"
          ? ["--nc", "start", driver.serviceName]
          : ["--nc", "stop", driver.serviceName];

    return {
      command: ChildProcess.make("scutil", args, { stdout: "pipe", stderr: "pipe" }),
      label: ["scutil", ...args].join(" "),
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
      const startedDrivers: Array<{ driver: ResolvedVpnDriver; cooldownMs: number }> = [];

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
        const wasConnected = yield* isVpnConnected(driver, runCommand);
        if (wasConnected) {
          continue;
        }

        const startCommand = makeVpnCommand(driver, "start");
        const startResult = yield* runCommand(startCommand.command, startCommand.label).pipe(
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
              stderr !== "" ? stderr : `Failed to start VPN prerequisite "${prerequisite.key}".`,
            hint: missingVpnToolHint(driver),
          });
        }

        const ready = yield* waitForVpn(driver, vpnConfig.connectTimeoutMs ?? 30000, runCommand);
        if (!ready) {
          return yield* new PrerequisiteRunError({
            message: `VPN prerequisite "${prerequisite.key}" did not connect within timeout.`,
            hint: missingVpnToolHint(driver),
          });
        }

        const cleanup = prerequisite.cleanup ?? vpnConfig.defaultCleanup ?? "stop-if-started";
        if (cleanup === "stop-if-started") {
          startedDrivers.push({ driver, cooldownMs: vpnConfig.cooldownMs ?? 0 });
        }
      }

      const cleanup = Effect.gen(function* () {
        for (const started of startedDrivers.toReversed()) {
          if (started.cooldownMs > 0) {
            yield* Effect.sleep(Duration.millis(started.cooldownMs));
          }

          const stopCommand = makeVpnCommand(started.driver, "stop");
          yield* runCommand(stopCommand.command, stopCommand.label).pipe(Effect.ignore);
        }
      });

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
    }

    return yield* Effect.fail(prerequisiteResult.failure);
  });
};
