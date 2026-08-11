import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve } from "node:path";

import { Context, Effect, Layer, Result } from "effect";

import type { Environment, LogFile, ReadOptions } from "./types";

import { K8sService, K8sServiceLayer } from "#k8s/service";
import { ConfigService, ConfigServiceLayer, getToolConfig } from "#config/loader";
import type { LogsConfig } from "#config/types";
import { LogsNotFoundError, LogsReadError, type LogsError } from "./errors";
import { transformLogOutput } from "./transformers";

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

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const takeLastLines = (contents: string, lines: number): string => {
  const all = contents.split("\n");
  const withoutTrailingBlank = all.at(-1) === "" ? all.slice(0, -1) : all;
  return withoutTrailingBlank.slice(-lines).join("\n");
};

/** Newest first, so callers can take the head as the latest log the way `ls -t` did. */
const readLocalLogDirectory = async (localDir: string): Promise<LogFile[]> => {
  const entries = await readdir(localDir, { withFileTypes: true });
  const logs = entries.filter((entry) => !entry.isDirectory() && entry.name.endsWith(".log"));

  const described = await Promise.all(
    logs.map(async (entry) => {
      const stats = await stat(join(localDir, entry.name));
      return {
        name: entry.name,
        size: String(stats.size),
        date: stats.mtime.toISOString(),
        modifiedAtMs: stats.mtimeMs,
      };
    }),
  );

  return described
    .toSorted((left, right) => right.modifiedAtMs - left.modifiedAtMs)
    .map(({ name, size, date }) => ({ name, size, date }));
};

const readCommandOutput = (output: unknown): string => (typeof output === "string" ? output : "");
const filterLogLines = (output: string, grep: string | undefined): string => {
  if (!grep) return output;
  const needle = grep.toLowerCase();
  return output
    .split("\n")
    .filter((line) => line.toLowerCase().includes(needle))
    .join("\n");
};
const resolveLocalLogPath = (base: string, file: string): string | undefined => {
  const resolvedBase = resolve(base);
  const resolvedPath = resolve(resolvedBase, file);
  const relativePath = relative(resolvedBase, resolvedPath);
  return relativePath === ".." ||
    relativePath.startsWith(`..${pathSeparator}`) ||
    isAbsolute(relativePath)
    ? undefined
    : resolvedPath;
};
const pathSeparator = process.platform === "win32" ? "\\" : "/";
const resolveRemoteLogPath = (base: string, file: string): string | undefined => {
  const resolvedBase = posix.resolve(base);
  const resolvedPath = posix.resolve(resolvedBase, file);
  const relativePath = posix.relative(resolvedBase, resolvedPath);
  return relativePath === ".." || relativePath.startsWith("../") || posix.isAbsolute(relativePath)
    ? undefined
    : resolvedPath;
};

export class LogsService extends Context.Service<
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
      const config = yield* ConfigService;

      const getLogsConfig = (profile?: string): LogsConfig | undefined =>
        getToolConfig<LogsConfig>(config, "logs", profile);

      const listLocalLogs = Effect.fn("LogsService.listLocalLogs")(function* (
        logsConfig: LogsConfig,
      ) {
        const localDir = logsConfig.localDir;
        const files = yield* Effect.tryPromise(() => readLocalLogDirectory(localDir)).pipe(
          Effect.mapError(
            (error) =>
              new LogsReadError({
                message: errorText(error) || "Failed to list local logs",
                source: localDir,
              }),
          ),
        );

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
        const kubernetesProfile = logsConfig.kubernetesProfile;

        const podResult = yield* k8s
          .runKubectl(
            `get pods --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}'`,
            false,
            kubernetesProfile,
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

        const pod = readCommandOutput(podResult.output).replace(/'/g, "");

        const listResult = yield* k8s
          .runKubectl(`exec ${pod} -- ls -la ${remotePath}`, false, kubernetesProfile)
          .pipe(
            Effect.mapError(
              (error) =>
                new LogsReadError({
                  message: error instanceof Error ? error.message : "Failed to list remote logs",
                  source: `${pod}:${remotePath}`,
                }),
            ),
          );

        const files = parseLogFiles(readCommandOutput(listResult.output));
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
          const files = yield* Effect.tryPromise(() => readLocalLogDirectory(localDir)).pipe(
            Effect.mapError(
              (error) =>
                new LogsReadError({
                  message: errorText(error) || "Failed to find latest log",
                  source: localDir,
                }),
            ),
          );

          const latest = files[0];
          if (!latest) {
            return yield* new LogsNotFoundError({
              message: "No log files found",
              path: localDir,
            });
          }

          logFile = latest.name;
        }

        const lexicalPath = resolveLocalLogPath(localDir, logFile);
        if (lexicalPath === undefined) {
          return yield* new LogsReadError({
            message: "Log file must stay within the configured local log directory.",
            source: localDir,
          });
        }
        const canonical = yield* Effect.tryPromise(async () => ({
          base: await realpath(localDir),
          path: await realpath(lexicalPath),
        })).pipe(
          Effect.mapError(
            (error) =>
              new LogsReadError({
                message: errorText(error) || "Failed to canonicalize the log path",
                source: lexicalPath,
              }),
          ),
        );

        const canonicalPath = canonical.path;
        if (
          resolveLocalLogPath(canonical.base, canonicalPath) !== canonicalPath ||
          !canonicalPath.endsWith(".log")
        ) {
          return yield* new LogsReadError({
            message: "Canonical log path escapes the configured local log directory.",
            source: localDir,
          });
        }

        const contents = yield* Effect.tryPromise(() => readFile(canonicalPath, "utf8")).pipe(
          Effect.mapError(
            (error) =>
              new LogsReadError({
                message: errorText(error) || "Failed to read the log file",
                source: canonicalPath,
              }),
          ),
        );

        const output = filterLogLines(takeLastLines(contents, options.tail), options.grep).trim();
        if (!output) {
          return "(no matching lines)";
        }

        return transformLogOutput(output);
      });

      const readRemoteLogs = Effect.fn("LogsService.readRemoteLogs")(function* (
        env: "test" | "prod",
        options: ReadOptions,
        logsConfig: LogsConfig,
      ) {
        const remotePath = logsConfig.remotePath;
        const kubernetesProfile = logsConfig.kubernetesProfile;
        const logFile = options.file ?? "app.log";
        const logPath = resolveRemoteLogPath(remotePath, logFile);
        if (logPath === undefined) {
          return yield* new LogsReadError({
            message: "Log file must stay within the configured remote log directory.",
            source: remotePath,
          });
        }

        const podResult = yield* k8s
          .runKubectl(
            `get pods --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}'`,
            false,
            kubernetesProfile,
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

        const pod = readCommandOutput(podResult.output).replace(/'/g, "");
        const execResult = yield* k8s
          .runLogTail(pod, remotePath, logPath, options.tail, kubernetesProfile)
          .pipe(Effect.result);

        return yield* Result.match(execResult, {
          onFailure: (error) =>
            Effect.fail(
              new LogsReadError({
                message: error instanceof Error ? error.message : "Failed to read remote logs",
                source: `${pod}:${logPath}`,
              }),
            ),
          onSuccess: (result) => {
            const output = readCommandOutput(result.output);
            const trimmed = filterLogLines(output, options.grep).trim();
            return Effect.succeed(trimmed ? transformLogOutput(trimmed) : "(no matching lines)");
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
