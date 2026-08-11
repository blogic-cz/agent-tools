import { mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import type { ChildProcess } from "effect/unstable/process";
import { ChildProcessSpawner } from "effect/unstable/process";
import { Effect, Layer, Result, Sink, Stream } from "effect";

import { ConfigService } from "#config/loader";
import type { AgentToolsConfig, LogsConfig } from "#config/types";
import { K8sCommandError } from "#k8s/errors";
import { K8sService } from "#k8s/service";
import type { CommandResult } from "#k8s/types";
import { LogsConfigError, LogsNotFoundError, LogsReadError } from "#logs/errors";
import { LogsService } from "#logs/service";
import type { Environment, ReadOptions } from "#logs/types";

type ShellResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

const defaultLogsConfig: LogsConfig = {
  localDir: "/app/logs",
  remotePath: "/var/log/app",
};

const defaultConfig: AgentToolsConfig = {
  logs: {
    default: defaultLogsConfig,
  },
};

type LocalLogFile = { name: string; contents: string; modifiedAt?: Date };

async function makeLocalLogDir(files: LocalLogFile[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-tools-logs-"));

  for (const file of files) {
    const path = join(dir, file.name);
    await writeFile(path, file.contents);
    if (file.modifiedAt) {
      await utimes(path, file.modifiedAt, file.modifiedAt);
    }
  }

  return dir;
}

function localConfig(localDir: string, overrides: Partial<LogsConfig> = {}): AgentToolsConfig {
  return { logs: { default: { ...defaultLogsConfig, localDir, ...overrides } } };
}

async function withLocalLogDir<A>(
  files: LocalLogFile[],
  use: (dir: string) => Promise<A>,
): Promise<A> {
  const dir = await makeLocalLogDir(files);
  try {
    return await use(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function commandToShellString(command: ChildProcess.Command): string {
  if (command._tag === "StandardCommand") {
    if (command.command === "sh" && command.args[0] === "-c") {
      return command.args[1] ?? "";
    }

    return [command.command, ...command.args].join(" ").trim();
  }

  return [commandToShellString(command.left), commandToShellString(command.right)].join(" | ");
}

function createMockProcess(result: ShellResult) {
  const encoder = new TextEncoder();

  const stdout = Stream.fromIterable([encoder.encode(result.stdout)]);
  const stderr = Stream.fromIterable([encoder.encode(result.stderr)]);

  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.succeed(undefined),
    stderr,
    stdin: Sink.drain,
    stdout,
    all: Stream.fromIterable([encoder.encode(result.stdout), encoder.encode(result.stderr)]),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
}

function createMockChildProcessSpawnerLayer(
  shellResponses: Record<string, ShellResult>,
  observedShellCommands?: Array<string>,
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const shellCommand = commandToShellString(command);
      observedShellCommands?.push(shellCommand);

      const directRealpathResponse =
        command._tag === "StandardCommand" && command.command === "realpath"
          ? {
              stdout: `${command.args.at(-2) ?? ""}\n${command.args.at(-1) ?? ""}\n`,
              stderr: "",
              exitCode: 0,
            }
          : undefined;
      const response = shellResponses[shellCommand] ??
        directRealpathResponse ?? {
          stdout: "",
          stderr: `No mock shell response for command: ${shellCommand}`,
          exitCode: 127,
        };

      return Effect.succeed(createMockProcess(response));
    }),
  );
}

function createMockK8sServiceLayer(
  k8sResponses: Record<string, CommandResult | K8sCommandError>,
  observedK8sCommands?: Array<string>,
) {
  return Layer.succeed(K8sService, {
    runCommand: (_cmd: string, _env: Environment) => Effect.succeed(""),
    runKubectl: (cmd: string, _dryRun: boolean, profile?: string) => {
      observedK8sCommands?.push(profile ? `${profile}:${cmd}` : cmd);
      const response = k8sResponses[cmd];

      if (response instanceof K8sCommandError) {
        return Effect.fail(response);
      }

      return Effect.succeed(
        response ?? {
          success: true,
          output: "",
          command: `kubectl ${cmd}`,
          executionTimeMs: 0,
        },
      );
    },
    runLogTail: (pod: string, _basePath: string, path: string, lines: number, profile?: string) => {
      const cmd = `exec ${JSON.stringify(pod)} -- tail -n ${lines} ${JSON.stringify(path)}`;
      observedK8sCommands?.push(profile ? `${profile}:${cmd}` : cmd);
      const response = k8sResponses[cmd];
      return response instanceof K8sCommandError
        ? Effect.fail(response)
        : Effect.succeed(
            response ?? {
              success: true,
              output: "",
              command: `kubectl ${cmd}`,
              executionTimeMs: 0,
            },
          );
    },
  });
}

function createLogsServiceLayer({
  shellResponses = {},
  k8sResponses = {},
  config = defaultConfig,
  observedShellCommands,
  observedK8sCommands,
}: {
  shellResponses?: Record<string, ShellResult>;
  k8sResponses?: Record<string, CommandResult | K8sCommandError>;
  config?: AgentToolsConfig | undefined;
  observedShellCommands?: Array<string>;
  observedK8sCommands?: Array<string>;
}) {
  return LogsService.layer.pipe(
    Layer.provide(createMockChildProcessSpawnerLayer(shellResponses, observedShellCommands)),
    Layer.provide(createMockK8sServiceLayer(k8sResponses, observedK8sCommands)),
    Layer.provide(Layer.succeed(ConfigService, config)),
  );
}

describe("LogsService", () => {
  describe("listLogs", () => {
    it("lists local .log files newest first and ignores other files", async () =>
      withLocalLogDir(
        [
          { name: "app.log", contents: "a", modifiedAt: new Date("2026-01-01T10:00:00Z") },
          { name: "worker.log", contents: "bb", modifiedAt: new Date("2026-01-01T10:01:00Z") },
          { name: "readme.txt", contents: "ccc" },
        ],
        async (dir) => {
          const result = await Effect.runPromise(
            Effect.gen(function* () {
              const service = yield* LogsService;
              return yield* service.listLogs("local");
            }).pipe(Effect.provide(createLogsServiceLayer({ config: localConfig(dir) }))),
          );

          expect(result.map((file) => file.name)).toEqual(["worker.log", "app.log"]);
          expect(result.map((file) => file.size)).toEqual(["2", "1"]);
          expect(result[1]?.date).toBe(new Date("2026-01-01T10:00:00Z").toISOString());
        },
      ));

    it("fails with LogsNotFoundError when the local directory holds no logs", async () =>
      withLocalLogDir([{ name: "readme.txt", contents: "nothing here" }], async (dir) => {
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const service = yield* LogsService;
            return yield* service.listLogs("local").pipe(Effect.result);
          }).pipe(Effect.provide(createLogsServiceLayer({ config: localConfig(dir) }))),
        );

        Result.match(result, {
          onFailure: (error) => {
            expect(error).toBeInstanceOf(LogsNotFoundError);
            expect(error._tag).toBe("LogsNotFoundError");
          },
          onSuccess: () => {
            expect.fail("Expected Failure but got Success");
          },
        });
      }));

    it.effect("fails with LogsReadError when the local directory cannot be read", () =>
      Effect.gen(function* () {
        const service = yield* LogsService;
        const result = yield* service.listLogs("local").pipe(Effect.result);

        Result.match(result, {
          onFailure: (error) => {
            expect(error).toBeInstanceOf(LogsReadError);
            expect(error._tag).toBe("LogsReadError");
          },
          onSuccess: () => {
            expect.fail("Expected Failure but got Success");
          },
        });
      }).pipe(
        Effect.provide(
          createLogsServiceLayer({
            config: localConfig(join(tmpdir(), "agent-tools-logs-does-not-exist")),
          }),
        ),
      ),
    );

    it.effect("lists remote logs through kubectl", () =>
      Effect.gen(function* () {
        const service = yield* LogsService;
        const result = yield* service.listLogs("test");

        expect(result).toEqual([{ name: "app.log", size: "220", date: "Jan 2 11:00" }]);
      }).pipe(
        Effect.provide(
          createLogsServiceLayer({
            k8sResponses: {
              "get pods --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}'":
                {
                  success: true,
                  output: "'app-pod-1'",
                  command: "kubectl get pods",
                  executionTimeMs: 5,
                },
              "exec app-pod-1 -- ls -la /var/log/app": {
                success: true,
                output: [
                  "total 4",
                  "-rw-r--r-- 1 root root 220 Jan 2 11:00 app.log",
                  "-rw-r--r-- 1 root root  11 Jan 2 11:01 notes.txt",
                ].join("\n"),
                command: "kubectl exec app-pod-1 -- ls -la /var/log/app",
                executionTimeMs: 7,
              },
            },
          }),
        ),
      ),
    );

    it.effect("maps remote command failures to LogsReadError", () =>
      Effect.gen(function* () {
        const service = yield* LogsService;
        const result = yield* service.listLogs("prod").pipe(Effect.result);

        Result.match(result, {
          onFailure: (error) => {
            expect(error).toBeInstanceOf(LogsReadError);
            expect(error._tag).toBe("LogsReadError");
          },
          onSuccess: () => {
            expect.fail("Expected Failure but got Success");
          },
        });
      }).pipe(
        Effect.provide(
          createLogsServiceLayer({
            k8sResponses: {
              "get pods --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}'":
                new K8sCommandError({
                  message: "kubectl failed",
                  command:
                    "get pods --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}'",
                  exitCode: 1,
                }),
            },
          }),
        ),
      ),
    );
  });

  it.effect("uses the logs profile Kubernetes profile for remote calls", () => {
    const observedK8sCommands: Array<string> = [];

    return Effect.gen(function* () {
      const service = yield* LogsService;
      const result = yield* service.listLogs("test", "appLogs");

      expect(result).toEqual([{ name: "app.log", size: "120", date: "Jan 1 10:00" }]);
      expect(observedK8sCommands).toEqual([
        "appCluster:get pods --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}'",
        "appCluster:exec app-pod -- ls -la /remote/logs",
      ]);
    }).pipe(
      Effect.provide(
        createLogsServiceLayer({
          config: {
            logs: {
              appLogs: {
                localDir: "/app/logs",
                remotePath: "/remote/logs",
                kubernetesProfile: "appCluster",
              },
            },
          },
          observedK8sCommands,
          k8sResponses: {
            "get pods --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}'":
              {
                success: true,
                output: "app-pod",
                command: "kubectl get pods",
                executionTimeMs: 1,
              },
            "exec app-pod -- ls -la /remote/logs": {
              success: true,
              output: ["total 4", "-rw-r--r-- 1 app app 120 Jan 1 10:00 app.log"].join("\n"),
              command: "kubectl exec",
              executionTimeMs: 1,
            },
          },
        }),
      ),
    );
  });

  describe("readLogs", () => {
    it("filters local logs literally, treating the pattern as text", async () => {
      const observedShellCommands: Array<string> = [];

      await withLocalLogDir(
        [{ name: "app.log", contents: "other line\nerror'; rm -rf /; `whoami` line\n" }],
        async (dir) => {
          const options: ReadOptions = {
            tail: 100,
            grep: "error'; rm -rf /; `whoami`",
            pretty: false,
          };

          const result = await Effect.runPromise(
            Effect.gen(function* () {
              const service = yield* LogsService;
              return yield* service.readLogs("local", options);
            }).pipe(
              Effect.provide(
                createLogsServiceLayer({ config: localConfig(dir), observedShellCommands }),
              ),
            ),
          );

          expect(result).toBe("error'; rm -rf /; `whoami` line");
          expect(observedShellCommands).toEqual([]);
        },
      );
    });

    it("transforms local JSON lines and keeps malformed lines", async () =>
      withLocalLogDir(
        [
          {
            name: "app.log",
            contents: ['{"level":"info","msg":"ok"}', "plain line", '{"n":1}'].join("\n"),
          },
        ],
        async (dir) => {
          const options: ReadOptions = { tail: 3, file: "app.log", pretty: true };

          const result = await Effect.runPromise(
            Effect.gen(function* () {
              const service = yield* LogsService;
              return yield* service.readLogs("local", options);
            }).pipe(Effect.provide(createLogsServiceLayer({ config: localConfig(dir) }))),
          );

          expect(result).toBe(
            ["--- info (3) ---", "[INFO] ok", "[INFO] plain line", '[INFO] {"n":1}'].join("\n"),
          );
        },
      ));

    it("returns no matching lines when local literal filter has no match", async () =>
      withLocalLogDir([{ name: "app.log", contents: "request completed\n" }], async (dir) => {
        const options: ReadOptions = {
          tail: 25,
          file: "app.log",
          grep: "timeout",
          pretty: false,
        };

        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const service = yield* LogsService;
            return yield* service.readLogs("local", options);
          }).pipe(Effect.provide(createLogsServiceLayer({ config: localConfig(dir) }))),
        );

        expect(result).toBe("(no matching lines)");
      }));

    it("uses the same case-insensitive literal filter locally and remotely", async () =>
      withLocalLogDir(
        [{ name: "app.log", contents: "ERROR4 regex-only\nERROR[42] local\n" }],
        async (dir) => {
          const options: ReadOptions = {
            tail: 10,
            file: "app.log",
            grep: "error[42]",
            pretty: false,
          };

          const layer = createLogsServiceLayer({
            config: localConfig(dir),
            k8sResponses: {
              "get pods --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}'":
                {
                  success: true,
                  output: "app-pod",
                  command: "kubectl get pods",
                  executionTimeMs: 1,
                },
              'exec "app-pod" -- tail -n 10 "/var/log/app/app.log"': {
                success: true,
                output: "error4 regex-only\nerror[42] remote\n",
                command: "kubectl exec",
                executionTimeMs: 1,
              },
            },
          });

          const results = await Effect.runPromise(
            Effect.gen(function* () {
              const service = yield* LogsService;
              return [
                yield* service.readLogs("local", options),
                yield* service.readLogs("test", options),
              ];
            }).pipe(Effect.provide(layer)),
          );

          expect(results).toEqual(["ERROR[42] local", "error[42] remote"]);
        },
      ));

    it.effect("rejects local and remote log path traversal before any command", () => {
      const observedShellCommands: string[] = [];
      const observedK8sCommands: string[] = [];

      return Effect.gen(function* () {
        const service = yield* LogsService;
        for (const env of ["local", "test"] as const) {
          const result = yield* service
            .readLogs(env, {
              tail: 20,
              file: "../../../etc/credentials.log",
              pretty: false,
            })
            .pipe(Effect.result);
          Result.match(result, {
            onFailure: (error) => expect(error).toBeInstanceOf(LogsReadError),
            onSuccess: () => expect.fail("Expected traversal rejection"),
          });
        }

        expect(observedShellCommands).toEqual([]);
        expect(observedK8sCommands).toEqual([]);
      }).pipe(
        Effect.provide(createLogsServiceLayer({ observedShellCommands, observedK8sCommands })),
      );
    });

    it("rejects a local log path that canonicalizes outside the configured directory", async () => {
      const outside = await makeLocalLogDir([{ name: "debug.log", contents: "secret" }]);

      await withLocalLogDir([], async (dir) => {
        // A directory junction is the one link type Windows creates without elevation, so the
        // escape is exercised on every platform rather than skipped on win32.
        await symlink(outside, join(dir, "linked"), "junction");

        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const service = yield* LogsService;
            return yield* service
              .readLogs("local", { tail: 20, file: "linked/debug.log", pretty: false })
              .pipe(Effect.result);
          }).pipe(Effect.provide(createLogsServiceLayer({ config: localConfig(dir) }))),
        );

        Result.match(result, {
          onFailure: (error) => expect(error).toBeInstanceOf(LogsReadError),
          onSuccess: () => expect.fail("Expected symlink escape rejection"),
        });
      });

      await rm(outside, { recursive: true, force: true });
    });

    it("fails local read when the requested log file is missing", async () =>
      withLocalLogDir([{ name: "other.log", contents: "x" }], async (dir) => {
        const options: ReadOptions = { tail: 25, file: "app.log", pretty: false };

        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const service = yield* LogsService;
            return yield* service.readLogs("local", options).pipe(Effect.result);
          }).pipe(Effect.provide(createLogsServiceLayer({ config: localConfig(dir) }))),
        );

        Result.match(result, {
          onFailure: (error) => {
            expect(error).toBeInstanceOf(LogsReadError);
            expect(error._tag).toBe("LogsReadError");
          },
          onSuccess: () => {
            expect.fail("Expected Failure but got Success");
          },
        });
      }));

    it.effect("sanitizes grep argument in remote kubectl exec command", () => {
      const observedK8sCommands: Array<string> = [];
      return Effect.gen(function* () {
        const service = yield* LogsService;
        const options: ReadOptions = {
          tail: 50,
          file: "api.log",
          grep: "fatal'; echo bad",
          pretty: false,
        };

        const result = yield* service.readLogs("test", options);

        expect(result).toBe("fatal'; echo bad line");
        expect(observedK8sCommands).toContain(
          'exec "app-pod" -- tail -n 50 "/var/log/app/api.log"',
        );
      }).pipe(
        Effect.provide(
          createLogsServiceLayer({
            observedK8sCommands,
            k8sResponses: {
              "get pods --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}'":
                {
                  success: true,
                  output: "app-pod",
                  command: "kubectl get pods",
                  executionTimeMs: 5,
                },
              'exec "app-pod" -- tail -n 50 "/var/log/app/api.log"': {
                success: true,
                output: "fatal'; echo bad line\n",
                command: "kubectl exec app-pod -- tail ...",
                executionTimeMs: 9,
              },
            },
          }),
        ),
      );
    });

    it.effect("transforms remote JSON lines", () =>
      Effect.gen(function* () {
        const service = yield* LogsService;
        const options: ReadOptions = {
          tail: 2,
          file: "app.log",
          pretty: true,
        };

        const result = yield* service.readLogs("prod", options);

        expect(result).toBe(["--- info (2) ---", '[INFO] {"x":1}', "[INFO] not json"].join("\n"));
      }).pipe(
        Effect.provide(
          createLogsServiceLayer({
            k8sResponses: {
              "get pods --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}'":
                {
                  success: true,
                  output: "prod-pod",
                  command: "kubectl get pods",
                  executionTimeMs: 3,
                },
              'exec "prod-pod" -- tail -n 2 "/var/log/app/app.log"': {
                success: true,
                output: '{"x":1}\nnot json',
                command: "kubectl exec prod-pod -- sh -c ...",
                executionTimeMs: 8,
              },
            },
          }),
        ),
      ),
    );

    it.effect("returns no matching lines when remote grep fails with exit code 1", () =>
      Effect.gen(function* () {
        const service = yield* LogsService;
        const options: ReadOptions = {
          tail: 10,
          file: "app.log",
          grep: "never-happens",
          pretty: false,
        };

        const result = yield* service.readLogs("prod", options);

        expect(result).toBe("(no matching lines)");
      }).pipe(
        Effect.provide(
          createLogsServiceLayer({
            k8sResponses: {
              "get pods --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}'":
                {
                  success: true,
                  output: "prod-pod",
                  command: "kubectl get pods",
                  executionTimeMs: 4,
                },
              'exec "prod-pod" -- tail -n 10 "/var/log/app/app.log"': {
                success: true,
                output: "ordinary line",
                command: "kubectl exec prod-pod -- tail ...",
                executionTimeMs: 8,
              },
            },
          }),
        ),
      ),
    );

    it.effect("maps remote read command failures to LogsReadError", () =>
      Effect.gen(function* () {
        const service = yield* LogsService;
        const options: ReadOptions = {
          tail: 10,
          file: "app.log",
          pretty: false,
        };

        const result = yield* service.readLogs("test", options).pipe(Effect.result);

        Result.match(result, {
          onFailure: (error) => {
            expect(error).toBeInstanceOf(LogsReadError);
            expect(error._tag).toBe("LogsReadError");
          },
          onSuccess: () => {
            expect.fail("Expected Failure but got Success");
          },
        });
      }).pipe(
        Effect.provide(
          createLogsServiceLayer({
            k8sResponses: {
              "get pods --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}'":
                {
                  success: true,
                  output: "test-pod",
                  command: "kubectl get pods",
                  executionTimeMs: 4,
                },
              'exec "test-pod" -- tail -n 10 "/var/log/app/app.log"': new K8sCommandError({
                message: "tail failed",
                command: "kubectl exec test-pod -- sh -c ...",
                exitCode: 2,
              }),
            },
          }),
        ),
      ),
    );
  });

  describe("missing config", () => {
    it.effect("fails listLogs when logs config is missing", () =>
      Effect.gen(function* () {
        const service = yield* LogsService;
        const result = yield* service.listLogs("local").pipe(Effect.result);

        Result.match(result, {
          onFailure: (error) => {
            expect(error).toBeInstanceOf(LogsReadError);
            expect(error._tag).toBe("LogsReadError");
            if (error._tag === "LogsReadError") {
              expect(error.source).toBe("config");
            }
          },
          onSuccess: () => {
            expect.fail("Expected Failure but got Success");
          },
        });
      }).pipe(
        Effect.provide(
          createLogsServiceLayer({
            config: {},
          }),
        ),
      ),
    );

    it.effect("fails readLogs when logs config is missing", () =>
      Effect.gen(function* () {
        const service = yield* LogsService;
        const result = yield* service
          .readLogs("local", { tail: 10, pretty: false })
          .pipe(Effect.result);

        Result.match(result, {
          onFailure: (error) => {
            expect(error).toBeInstanceOf(LogsReadError);
            expect(error._tag).toBe("LogsReadError");
            if (error._tag === "LogsReadError") {
              expect(error.source).toBe("config");
            }
          },
          onSuccess: () => {
            expect.fail("Expected Failure but got Success");
          },
        });
      }).pipe(
        Effect.provide(
          createLogsServiceLayer({
            config: {},
          }),
        ),
      ),
    );
  });
});

describe("env resolution with defaultEnvironment", () => {
  it("lists local logs successfully", async () =>
    withLocalLogDir([{ name: "app.log", contents: "hello" }], async (dir) => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* LogsService;
          return yield* service.listLogs("local");
        }).pipe(Effect.provide(createLogsServiceLayer({ config: localConfig(dir) }))),
      );

      expect(result).toBeDefined();
      expect(result.length).toBeGreaterThan(0);
    }));

  it.effect("lists remote logs through kubectl", () =>
    Effect.gen(function* () {
      const service = yield* LogsService;
      const result = yield* service.listLogs("test");

      expect(result).toBeDefined();
      expect(result.length).toBeGreaterThan(0);
    }).pipe(
      Effect.provide(
        createLogsServiceLayer({
          k8sResponses: {
            "get pods --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}'":
              {
                success: true,
                output: "'test-pod'",
                command: "kubectl get pods",
                executionTimeMs: 5,
              },
            "exec test-pod -- ls -la /var/log/app": {
              success: true,
              output: ["total 4", "-rw-r--r-- 1 root root 220 Jan 2 11:00 app.log"].join("\n"),
              command: "kubectl exec test-pod -- ls -la /var/log/app",
              executionTimeMs: 7,
            },
          },
        }),
      ),
    ),
  );

  it("LogsConfigError can carry missing-env hint", () => {
    const error = new LogsConfigError({
      message:
        "No environment specified. Use --env <name> or set defaultEnvironment in agent-tools.json5.",
      hint: 'Set defaultEnvironment in agent-tools.json5 (e.g. defaultEnvironment: "local") or pass --env explicitly.',
      nextCommand: "agent-tools-logs list --env local",
    });

    expect(error._tag).toBe("LogsConfigError");
    expect(error.message).toContain("No environment specified");
    expect(error.hint).toContain("defaultEnvironment");
    expect(error.nextCommand).toContain("--env local");
  });
});

describe("error recovery hints - unit tests", () => {
  it("LogsNotFoundError with hint and nextCommand", () => {
    const error = new LogsNotFoundError({
      message: "Log file not found",
      path: "/app/logs/missing.log",
      hint: "Check the log file path. Use 'agent-tools-logs list' to see available logs.",
      nextCommand: "agent-tools-logs list --env local",
    });

    expect(error._tag).toBe("LogsNotFoundError");
    expect(error.hint).toBe(
      "Check the log file path. Use 'agent-tools-logs list' to see available logs.",
    );
    expect(error.nextCommand).toBe("agent-tools-logs list --env local");
  });

  it("LogsReadError with hint", () => {
    const error = new LogsReadError({
      message: "Permission denied",
      source: "local",
      hint: "Check file permissions. You may need elevated privileges to read this log.",
    });

    expect(error._tag).toBe("LogsReadError");
    expect(error.hint).toBe(
      "Check file permissions. You may need elevated privileges to read this log.",
    );
    expect(error.nextCommand).toBeUndefined();
  });

  it("LogsConfigError with hint and nextCommand", () => {
    const error = new LogsConfigError({
      message: "No logs configuration found",
      hint: "Add logs configuration to agent-tools.json5",
      nextCommand: "agent-tools-logs list --env local",
    });

    expect(error._tag).toBe("LogsConfigError");
    expect(error.hint).toBe("Add logs configuration to agent-tools.json5");
    expect(error.nextCommand).toBe("agent-tools-logs list --env local");
  });

  it("hint fields are optional in logs errors", () => {
    const error = new LogsReadError({
      message: "Read error",
      source: "local",
    });

    expect(error._tag).toBe("LogsReadError");
    expect(error.message).toBe("Read error");
    expect(error.hint).toBeUndefined();
    expect(error.nextCommand).toBeUndefined();
  });
});
