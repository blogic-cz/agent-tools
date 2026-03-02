import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Effect, Layer, ServiceMap, Stream, Option } from "effect";

import type { InvokeParams } from "./types";
import type { AzureConfig } from "#config/types";

import { DIRECT_AZ_COMMANDS, STANDALONE_AZ_COMMANDS } from "./config";
import { AzSecurityError, AzCommandError, AzTimeoutError, AzParseError } from "./errors";
import { isCommandAllowed, isInvokeAllowed } from "./security";
import { ConfigService, getToolConfig } from "#config";

export class AzService extends ServiceMap.Service<
  AzService,
  {
    readonly runCommand: (
      cmd: string,
      project?: string,
    ) => Effect.Effect<string, AzSecurityError | AzCommandError | AzTimeoutError | AzParseError>;
    readonly runInvoke: (
      params: InvokeParams,
    ) => Effect.Effect<unknown, AzSecurityError | AzCommandError | AzTimeoutError | AzParseError>;
  }
>()("@agent-tools/AzService") {
  static readonly layer = Layer.effect(
    AzService,
    Effect.gen(function* () {
      const config = yield* ConfigService;
      const azConfig = getToolConfig<AzureConfig>(config, "azure");

      if (!azConfig) {
        const noConfigError = new AzCommandError({
          message: "No Azure configuration found. Add an 'azure' section to agent-tools.json5.",
          command: "unknown",
          exitCode: -1,
          hint: "Create or update agent-tools.json5 with an 'azure' section containing organization and defaultProject",
        });
        return {
          runCommand: (_cmd: string, _project?: string) => Effect.fail(noConfigError),
          runInvoke: (_params: InvokeParams) => Effect.fail(noConfigError),
        };
      }

      const executor = yield* ChildProcessSpawner.ChildProcessSpawner;

      const runShellCommand = (fullCommand: string, timeoutMs: number) =>
        Effect.scoped(
          Effect.gen(function* () {
            const command = ChildProcess.make("sh", ["-c", fullCommand], {
              stdout: "pipe",
              stderr: "pipe",
            });
            const process = yield* executor.spawn(command);

            const stdoutChunk = yield* process.stdout.pipe(Stream.decodeText(), Stream.runCollect);
            const stdout = stdoutChunk.join("");

            const stderrChunk = yield* process.stderr.pipe(Stream.decodeText(), Stream.runCollect);
            const stderr = stderrChunk.join("");

            const exitCode = yield* process.exitCode;

            return { stdout, stderr, exitCode };
          }),
        ).pipe(
          Effect.timeoutOption(timeoutMs),
          Effect.mapError(
            (platformError) =>
              new AzCommandError({
                message: `Command execution failed: ${platformError.message}`,
                command: fullCommand,
                exitCode: -1,
                hint: "Check that the az CLI is installed and authenticated",
                nextCommand: "az login",
                retryable: true,
              }),
          ),
        );

      const resolveProject = (project?: string) => project ?? azConfig.defaultProject;

      const runCommand = Effect.fn("AzService.runCommand")(function* (
        cmd: string,
        project?: string,
      ) {
        const projectName = resolveProject(project);

        const securityCheck = isCommandAllowed(cmd);
        if (!securityCheck.allowed) {
          return yield* new AzSecurityError({
            message: securityCheck.reason ?? "Command not allowed",
            command: cmd,
            hint: "Only read-only az devops commands are allowed. Use build helpers for common operations.",
          });
        }

        const invokeParams = parseInvokeFromCommand(cmd);
        if (invokeParams) {
          const invokeResult = yield* runInvoke({
            ...invokeParams,
            project: projectName,
          });
          return JSON.stringify(invokeResult);
        }

        const cmdWords = cmd.trim().split(/\s+/);
        const firstWord = cmdWords[0]?.toLowerCase() ?? "";
        const isDirectCommand = DIRECT_AZ_COMMANDS.includes(
          firstWord as (typeof DIRECT_AZ_COMMANDS)[number],
        );
        const isStandaloneCommand = STANDALONE_AZ_COMMANDS.includes(
          firstWord as (typeof STANDALONE_AZ_COMMANDS)[number],
        );

        let fullCommand: string;

        if (isStandaloneCommand) {
          fullCommand = `az ${cmd}`;
        } else if (isDirectCommand) {
          fullCommand = `az ${cmd} --organization "${azConfig.organization}" --project "${projectName}"`;
        } else {
          fullCommand = `az devops ${cmd} --organization "${azConfig.organization}" --project "${projectName}"`;
        }

        const resultOption = yield* runShellCommand(fullCommand, azConfig.timeoutMs ?? 60000);

        if (Option.isNone(resultOption)) {
          return yield* new AzTimeoutError({
            message: `Command timed out after ${azConfig.timeoutMs ?? 60000}ms`,
            command: fullCommand,
            timeoutMs: azConfig.timeoutMs ?? 60000,
            retryable: true,
            hint: "The command took too long. Retry or increase timeoutMs in azure config.",
          });
        }

        const result = resultOption.value;

        if (result.exitCode !== 0) {
          return yield* new AzCommandError({
            message: result.stderr || `Command failed with exit code ${result.exitCode}`,
            command: fullCommand,
            exitCode: result.exitCode,
            stderr: result.stderr || undefined,
          });
        }

        return result.stdout;
      });

      const runInvoke = Effect.fn("AzService.runInvoke")(function* (params: InvokeParams) {
        const securityCheck = isInvokeAllowed(params);
        if (!securityCheck.allowed) {
          return yield* new AzSecurityError({
            message: securityCheck.reason ?? "Invoke not allowed",
            command: `invoke --area ${params.area} --resource ${params.resource}`,
            hint: "Only allowed invoke areas/resources can be used. Check az-tool security config.",
          });
        }

        let fullCommand = `az devops invoke --area ${params.area} --resource ${params.resource}`;

        const projectName = resolveProject(params.project);

        const routeParameters = {
          project: projectName,
          ...params.routeParameters,
        };

        if (Object.keys(routeParameters).length > 0) {
          const routeParams = Object.entries(routeParameters)
            .map(([k, v]) => `${k}=${v}`)
            .join(" ");
          fullCommand += ` --route-parameters ${routeParams}`;
        }

        if (params.queryParameters) {
          const queryParams = Object.entries(params.queryParameters)
            .map(([k, v]) => `${k}=${v}`)
            .join(" ");
          fullCommand += ` --query-parameters ${queryParams}`;
        }

        fullCommand += ` --organization "${azConfig.organization}" --output json`;

        const resultOption = yield* runShellCommand(fullCommand, azConfig.timeoutMs ?? 60000);

        if (Option.isNone(resultOption)) {
          return yield* new AzTimeoutError({
            message: `Invoke timed out after ${azConfig.timeoutMs ?? 60000}ms`,
            command: fullCommand,
            timeoutMs: azConfig.timeoutMs ?? 60000,
            retryable: true,
            hint: "The invoke took too long. Retry or increase timeoutMs in azure config.",
          });
        }

        const result = resultOption.value;

        if (result.exitCode !== 0) {
          return yield* new AzCommandError({
            message: result.stderr || `Invoke failed with exit code ${result.exitCode}`,
            command: fullCommand,
            exitCode: result.exitCode,
            stderr: result.stderr || undefined,
          });
        }

        const jsonData = yield* Effect.try({
          try: () => JSON.parse(result.stdout) as unknown,
          catch: () =>
            new AzParseError({
              message: `Failed to parse JSON response from invoke`,
              rawOutput: result.stdout.slice(0, 500),
              hint: "The az CLI returned non-JSON output. Ensure --output json is used.",
            }),
        });
        return jsonData;
      });

      return { runCommand, runInvoke };
    }),
  );
}

export const AzServiceLayer = AzService.layer;

function parseInvokeFromCommand(cmd: string): InvokeParams | undefined {
  const words = cmd.trim().split(/\s+/);
  const loweredWords = words.map((word) => word.toLowerCase());

  if (!loweredWords.includes("invoke")) {
    return undefined;
  }

  const area = extractOptionValue(words, "--area");
  const resource = extractOptionValue(words, "--resource");

  if (!area || !resource) {
    return undefined;
  }

  const routeParameters = extractParametersOption(words, "--route-parameters");
  const queryParameters = extractParametersOption(words, "--query-parameters");
  const apiVersion = extractOptionValue(words, "--api-version");

  const mergedQueryParameters = apiVersion
    ? {
        ...queryParameters,
        "api-version": apiVersion,
      }
    : queryParameters;

  return {
    area,
    resource,
    ...(routeParameters ? { routeParameters } : {}),
    ...(mergedQueryParameters ? { queryParameters: mergedQueryParameters } : {}),
  };
}

function extractOptionValue(args: readonly string[], optionName: string): string | undefined {
  const optionIndex = args.findIndex((arg) => arg.toLowerCase() === optionName.toLowerCase());

  if (optionIndex === -1) {
    return undefined;
  }

  return args[optionIndex + 1];
}

function extractParametersOption(
  args: readonly string[],
  optionName: string,
): Record<string, string | number> | undefined {
  const optionIndex = args.findIndex((arg) => arg.toLowerCase() === optionName.toLowerCase());

  if (optionIndex === -1) {
    return undefined;
  }

  const result: Record<string, string | number> = {};

  for (let i = optionIndex + 1; i < args.length; i++) {
    const token = args[i];
    if (!token || token.startsWith("--")) {
      break;
    }

    const equalsIndex = token.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }

    const key = token.slice(0, equalsIndex);
    const rawValue = token.slice(equalsIndex + 1);
    const parsedNumber = Number(rawValue);
    result[key] = Number.isNaN(parsedNumber) ? rawValue : parsedNumber;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}
