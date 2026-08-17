import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Context, Effect, Layer, Option, Stream } from "effect";

import type { AzurePlatformConfig } from "#config/types";

import type { AzParseError } from "./errors";

import { AzCommandError, AzProfileError, AzSecurityError, AzTimeoutError } from "./errors";
import { isProductionProfile, selectAzProfileName } from "./profile";
import { isAzCommandAllowed } from "./security";
import { ConfigService, getToolConfig } from "#config";
import { missingBinaryFromSpawnFailure } from "#shared/binary-preflight";
import { renderCommandLine } from "#shared/exec";

const DEFAULT_TIMEOUT_MS = 60000;

const hasOutputFlag = (argv: readonly string[]): boolean =>
  argv.some((arg) => arg === "-o" || arg === "--output" || arg.startsWith("--output="));

export type AzCommandResult = {
  readonly command: string;
  readonly subscription: string | undefined;
  readonly data: unknown;
};

export class AzService extends Context.Service<
  AzService,
  {
    readonly runCommand: (
      cmd: string,
      profile?: string,
    ) => Effect.Effect<
      AzCommandResult,
      AzSecurityError | AzCommandError | AzTimeoutError | AzParseError | AzProfileError
    >;
    readonly renderCommand: (
      cmd: string,
      profile?: string,
    ) => Effect.Effect<string, AzSecurityError | AzCommandError | AzProfileError>;
  }
>()("@agent-tools/AzService") {
  static readonly layer = Layer.effect(
    AzService,
    Effect.gen(function* () {
      const config = yield* ConfigService;
      const executor = yield* ChildProcessSpawner.ChildProcessSpawner;

      const resolveConfig = (profile?: string) =>
        Effect.gen(function* () {
          const azConfig = getToolConfig<AzurePlatformConfig>(config, "azurePlatform", profile);

          if (!azConfig) {
            return yield* new AzCommandError({
              message:
                "No Azure platform configuration found. Add an 'azurePlatform' section to agent-tools.json5.",
              command: "unknown",
              exitCode: -1,
              hint: "azurePlatform pins the subscription every command runs against, so it is required.",
              nextCommand:
                "echo '{ azurePlatform: { default: { subscription: \"<subscription-id>\" } } }' > agent-tools.json5",
            });
          }

          // A production subscription must be named, never inherited from
          // auto-selection or the "default" key.
          const profileName = selectAzProfileName(config?.azurePlatform, profile);
          if (!profile && isProductionProfile(profileName, azConfig)) {
            const label = profileName ?? "default";
            return yield* new AzProfileError({
              message: `Implicit production access blocked. Profile '${label}' is a production profile but --profile was not passed explicitly.`,
              profile: label,
              hint: `Pass --profile ${label} explicitly to confirm production access, or set production: false on that profile.`,
              nextCommand: `agent-tools-az cmd --profile ${label} --cmd "group list"`,
            });
          }

          return azConfig;
        });

      /** Security gate plus profile scoping. Shared by dry-run rendering and execution. */
      const buildArgv = (cmd: string, profile?: string) =>
        Effect.gen(function* () {
          const azConfig = yield* resolveConfig(profile);
          const securityCheck = isAzCommandAllowed(cmd, {
            allowedResourceGroups: azConfig.allowedResourceGroups,
          });

          if (!securityCheck.allowed || !securityCheck.argv) {
            return yield* new AzSecurityError({
              message: securityCheck.reason ?? "Command not allowed",
              command: cmd,
              hint:
                securityCheck.hint ??
                "Only read-only Azure platform commands are allowed. Use azdo-tool for Azure DevOps.",
            });
          }

          const argv = [...securityCheck.argv, "--only-show-errors"];

          if (!hasOutputFlag(securityCheck.argv)) {
            argv.push("--output", "json");
          }

          argv.push("--subscription", azConfig.subscription);

          return { argv, azConfig };
        });

      const spawnAz = (argv: readonly string[], timeoutMs: number, renderedCommand: string) =>
        Effect.scoped(
          Effect.gen(function* () {
            const command = ChildProcess.make("az", argv, {
              stdout: "pipe",
              stderr: "pipe",
            });
            const process = yield* executor.spawn(command);

            const stdoutChunk = yield* process.stdout.pipe(Stream.decodeText(), Stream.runCollect);
            const stderrChunk = yield* process.stderr.pipe(Stream.decodeText(), Stream.runCollect);
            const exitCode = yield* process.exitCode;

            return { stdout: stdoutChunk.join(""), stderr: stderrChunk.join(""), exitCode };
          }),
        ).pipe(
          Effect.timeoutOption(timeoutMs),
          Effect.mapError((platformError) => {
            const missing = missingBinaryFromSpawnFailure("az", String(platformError));
            return new AzCommandError({
              message: `Command execution failed: ${String(platformError)}`,
              command: renderedCommand,
              exitCode: -1,
              stderr: String(platformError),
              hint: missing?.hint ?? "Check that the az CLI is installed and authenticated",
              nextCommand: "az login",
              retryable: true,
            });
          }),
        );

      const renderCommand = Effect.fn("AzService.renderCommand")(function* (
        cmd: string,
        profile?: string,
      ) {
        const { argv } = yield* buildArgv(cmd, profile);
        return renderCommandLine(["az", ...argv]);
      });

      const runCommand = Effect.fn("AzService.runCommand")(function* (
        cmd: string,
        profile?: string,
      ) {
        const { argv, azConfig } = yield* buildArgv(cmd, profile);
        const timeoutMs = azConfig.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const fullCommand = renderCommandLine(["az", ...argv]);

        const resultOption = yield* spawnAz(argv, timeoutMs, fullCommand);

        if (Option.isNone(resultOption)) {
          return yield* new AzTimeoutError({
            message: `Command timed out after ${timeoutMs}ms`,
            command: fullCommand,
            timeoutMs,
            retryable: true,
            hint: "The command took too long. Retry or increase timeoutMs in azurePlatform config.",
          });
        }

        const result = resultOption.value;

        if (result.exitCode !== 0) {
          return yield* new AzCommandError({
            message: result.stderr || `Command failed with exit code ${result.exitCode}`,
            command: fullCommand,
            exitCode: result.exitCode,
            ...(result.stderr ? { stderr: result.stderr } : {}),
          });
        }

        const output = result.stdout.trim();

        if (output.length === 0) {
          return {
            command: fullCommand,
            subscription: azConfig.subscription,
            data: null,
          } satisfies AzCommandResult;
        }

        // --output json is injected unless the caller picked a format, so non-JSON
        // output here is a deliberate table/tsv request and is passed through as text.
        const parsed = ((): unknown => {
          try {
            return JSON.parse(output) as unknown;
          } catch {
            return output;
          }
        })();

        return {
          command: fullCommand,
          subscription: azConfig.subscription,
          data: parsed,
        } satisfies AzCommandResult;
      });

      return { runCommand, renderCommand };
    }),
  );
}

export const AzServiceLayer = AzService.layer;
