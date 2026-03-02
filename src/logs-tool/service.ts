import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Effect, Layer, Result, ServiceMap, Stream } from "effect";

import type { Environment, LogFile, ReadOptions } from "./types";

import { K8sCommandError } from "#src/k8s-tool/errors";
import { K8sService, K8sServiceLayer } from "#src/k8s-tool/service";
import { ConfigService, ConfigServiceLayer, getToolConfig } from "#src/config/loader";
import type { LogsConfig } from "#src/config/types";
import { LogsNotFoundError, LogsReadError, type LogsError } from "./errors";

export const parseLogFiles = (output: string): LogFile[] => {
  const lines = output.trim().split("\n").slice(1);
  return lines
    .filter((line) => line.includes(".log"))
    .map((line) => {
      const parts = line.split(/\s+/);
      return {
        name: parts[parts.length - 1] ?? "",
        size: parts[4] ?? "",
        date: `${parts[5] ?? ""} ${parts[6] ?? ""} ${parts[7] ?? ""}`.trim(),
      };
    })
    .filter((file) => file.name.length > 0);
};

export const formatPrettyOutput = (output: string): string => {
  const lines = output.split("\n");
  return lines
    .map((line) => {
      try {
        const json = JSON.parse(line);
        return JSON.stringify(json, null, 2);
      } catch {
        return line;
      }
    })
    .join("\n---\n");
};

/**
 * Sanitize a string for safe use in shell commands by escaping single quotes
 * and wrapping in single quotes. This prevents shell injection.
 */
export const sanitizeShellArg = (input: string): string => `'${input.replace(/'/g, "'\\''")}'`;

export class LogsService extends ServiceMap.Service<
  LogsService,
  {
    readonly listLogs: (env: Environment, profile?: string) => Effect.Effect<LogFile[], LogsError>;
    readonly readLogs: (
      env: Environment,
      options: ReadOptions,
      profile?: string,
    ) => Effect.Effect<string, LogsError>;
  }
>()("@agent-tools/LogsService") {
  static readonly layer = Layer.effect(
    LogsService,
    Effect.gen(function* () {
      const k8s = yield* K8sService;
      const executor = yield* ChildProcessSpawner.ChildProcessSpawner;
      const config = yield* ConfigService;

      const runShellCommand = (commandStr: string) =>
        Effect.scoped(
          Effect.gen(function* () {
            const command = ChildProcess.make("sh", ["-c", commandStr], {
              stdout: "pipe",
              stderr: "pipe",
            });
            const process = yield* executor.spawn(command);

            const stdoutChunk = yield* process.stdout.pipe(Stream.decodeText(), Stream.runCollect);
            const stderrChunk = yield* process.stderr.pipe(Stream.decodeText(), Stream.runCollect);

            const stdout = stdoutChunk.join("");
            const stderr = stderrChunk.join("");
            const exitCode = yield* process.exitCode;

            return { stdout, stderr, exitCode };
          }),
        ).pipe(
          Effect.catch((platformError) =>
            Effect.succeed({
              stdout: "",
              stderr: String(platformError),
              exitCode: -1,
            }),
          ),
        );

      const getLogsConfig = (profile?: string): LogsConfig | undefined =>
        getToolConfig<LogsConfig>(config, "logs", profile);

      const listLocalLogs = Effect.fn("LogsService.listLocalLogs")(function* (
        logsConfig: LogsConfig,
      ) {
        const localDir = logsConfig.localDir;
        const result = yield* runShellCommand(`ls -la ${localDir}`);

        if (result.exitCode !== 0) {
          return yield* new LogsReadError({
            message: result.stderr.trim() || "Failed to list local logs",
            source: localDir,
          });
        }

        const files = parseLogFiles(result.stdout);
        if (files.length === 0) {
          return yield* new LogsNotFoundError({
            message: "No log files found",
            path: localDir,
          });
        }

        return files;
      });

      const listRemoteLogs = Effect.fn("LogsService.listRemoteLogs")(function* (
        env: "test" | "prod",
        logsConfig: LogsConfig,
      ) {
        const remotePath = logsConfig.remotePath;

        const podResult = yield* k8s
          .runKubectl(
            `-n $(kubectl config view --minify -o jsonpath='{.contexts[0].context.namespace}' 2>/dev/null || echo default) get pods -o jsonpath='{.items[0].metadata.name}'`,
            false,
          )
          .pipe(
            Effect.mapError(
              (error) =>
                new LogsReadError({
                  message: error instanceof Error ? error.message : "Failed to get pod name",
                  source: `${env}:unknown`,
                }),
            ),
          );

        const pod = (podResult.output ?? "").replace(/'/g, "");

        const listResult = yield* k8s.runKubectl(`exec ${pod} -- ls -la ${remotePath}`, false).pipe(
          Effect.mapError(
            (error) =>
              new LogsReadError({
                message: error instanceof Error ? error.message : "Failed to list remote logs",
                source: `${pod}:${remotePath}`,
              }),
          ),
        );

        const files = parseLogFiles(listResult.output ?? "");
        if (files.length === 0) {
          return yield* new LogsNotFoundError({
            message: "No log files found",
            path: `${pod}:${remotePath}`,
          });
        }

        return files;
      });

      const readLocalLogs = Effect.fn("LogsService.readLocalLogs")(function* (
        options: ReadOptions,
        logsConfig: LogsConfig,
      ) {
        const localDir = logsConfig.localDir;
        let logFile = options.file;

        if (!logFile) {
          const latest = yield* runShellCommand(`ls -t ${localDir}/*.log 2>/dev/null | head -1`);

          if (latest.exitCode !== 0) {
            return yield* new LogsReadError({
              message: latest.stderr.trim() || "Failed to find latest log",
              source: localDir,
            });
          }

          const latestPath = latest.stdout.trim();
          if (!latestPath) {
            return yield* new LogsNotFoundError({
              message: "No log files found",
              path: localDir,
            });
          }

          logFile = latestPath.split("/").pop() ?? latestPath;
        }

        const fullPath = `${localDir}/${logFile}`;
        let command = `tail -${options.tail} ${sanitizeShellArg(fullPath)}`;

        if (options.grep) {
          command += ` | grep -i ${sanitizeShellArg(options.grep)}`;
        }

        const result = yield* runShellCommand(command);

        if (result.exitCode !== 0 && result.exitCode !== 1) {
          return yield* new LogsReadError({
            message: result.stderr.trim() || `Command failed with exit code ${result.exitCode}`,
            source: fullPath,
          });
        }

        if (result.exitCode === 1 && options.grep) {
          return "(no matching lines)";
        }

        const output = result.stdout.trim();
        if (options.pretty && output) {
          return formatPrettyOutput(output);
        }

        return output || "(no matching lines)";
      });

      const readRemoteLogs = Effect.fn("LogsService.readRemoteLogs")(function* (
        env: "test" | "prod",
        options: ReadOptions,
        logsConfig: LogsConfig,
      ) {
        const remotePath = logsConfig.remotePath;

        const podResult = yield* k8s
          .runKubectl(`get pods -o jsonpath='{.items[0].metadata.name}'`, false)
          .pipe(
            Effect.mapError(
              (error) =>
                new LogsReadError({
                  message: error instanceof Error ? error.message : "Failed to get pod name",
                  source: `${env}:unknown`,
                }),
            ),
          );

        const pod = (podResult.output ?? "").replace(/'/g, "");
        const logFile = options.file ?? "app.log";
        const logPath = `${remotePath}/${logFile}`;
        let command = `tail -${options.tail} ${sanitizeShellArg(logPath)}`;

        if (options.grep) {
          command += ` | grep -i ${sanitizeShellArg(options.grep)}`;
        }

        const execResult = yield* k8s
          .runKubectl(`exec ${pod} -- sh -c "${command}"`, false)
          .pipe(Effect.result);

        return yield* Result.match(execResult, {
          onFailure: (error) => {
            if (error instanceof K8sCommandError && error.exitCode === 1 && options.grep) {
              return Effect.succeed("(no matching lines)");
            }

            return Effect.fail(
              new LogsReadError({
                message: error instanceof Error ? error.message : "Failed to read remote logs",
                source: `${pod}:${logPath}`,
              }),
            );
          },
          onSuccess: (result) => {
            const trimmed = (result.output ?? "").trim();
            if (options.pretty && trimmed) {
              return Effect.succeed(formatPrettyOutput(trimmed));
            }

            return Effect.succeed(trimmed || "(no matching lines)");
          },
        });
      });

      const listLogs = Effect.fn("LogsService.listLogs")(function* (
        env: Environment,
        profile?: string,
      ) {
        const logsConfig = getLogsConfig(profile);
        if (!logsConfig) {
          return yield* new LogsReadError({
            message: "No logs configuration found. Add a 'logs' section to agent-tools.json5.",
            source: "config",
          });
        }

        if (env === "local") {
          return yield* listLocalLogs(logsConfig);
        }

        return yield* listRemoteLogs(env, logsConfig);
      });

      const readLogs = Effect.fn("LogsService.readLogs")(function* (
        env: Environment,
        options: ReadOptions,
        profile?: string,
      ) {
        const logsConfig = getLogsConfig(profile);
        if (!logsConfig) {
          return yield* new LogsReadError({
            message: "No logs configuration found. Add a 'logs' section to agent-tools.json5.",
            source: "config",
          });
        }

        if (env === "local") {
          return yield* readLocalLogs(options, logsConfig);
        }

        return yield* readRemoteLogs(env, options, logsConfig);
      });

      return { listLogs, readLogs };
    }),
  );
}

export const LogsServiceLayer = LogsService.layer.pipe(
  Layer.provide(K8sServiceLayer),
  Layer.provide(ConfigServiceLayer),
);
