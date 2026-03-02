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

      const response = shellResponses[shellCommand] ?? {
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
    runKubectl: (cmd: string, _dryRun: boolean) => {
      observedK8sCommands?.push(cmd);
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
    it.effect("parses local ls -la output into LogFile entries", () =>
      Effect.gen(function* () {
        const service = yield* LogsService;
        const result = yield* service.listLogs("local");

        expect(result).toEqual([
          { name: "app.log", size: "120", date: "Jan 1 10:00" },
          { name: "worker.log", size: "88", date: "Jan 1 10:01" },
        ]);
      }).pipe(
        Effect.provide(
          createLogsServiceLayer({
            shellResponses: {
              "ls -la /app/logs": {
                stdout: [
                  "total 12",
                  "drwxr-xr-x 2 app app  64 Jan 1 09:59 .",
                  "-rw-r--r-- 1 app app 120 Jan 1 10:00 app.log",
                  "-rw-r--r-- 1 app app  88 Jan 1 10:01 worker.log",
                  "-rw-r--r-- 1 app app  42 Jan 1 10:02 readme.txt",
                ].join("\n"),
                stderr: "",
                exitCode: 0,
              },
            },
          }),
        ),
      ),
    );

    it.effect("fails with LogsNotFoundError for empty local output", () =>
      Effect.gen(function* () {
        const service = yield* LogsService;
        const result = yield* service.listLogs("local").pipe(Effect.result);

        Result.match(result, {
          onFailure: (error) => {
            expect(error).toBeInstanceOf(LogsNotFoundError);
            expect(error._tag).toBe("LogsNotFoundError");
          },
          onSuccess: () => {
            expect.fail("Expected Failure but got Success");
          },
        });
      }).pipe(
        Effect.provide(
          createLogsServiceLayer({
            shellResponses: {
              "ls -la /app/logs": {
                stdout: "",
                stderr: "",
                exitCode: 0,
              },
            },
          }),
        ),
      ),
    );

    it.effect("fails with LogsReadError when local list command fails", () =>
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
            shellResponses: {
              "ls -la /app/logs": {
                stdout: "",
                stderr: "permission denied",
                exitCode: 2,
              },
            },
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
              "-n $(kubectl config view --minify -o jsonpath='{.contexts[0].context.namespace}' 2>/dev/null || echo default) get pods -o jsonpath='{.items[0].metadata.name}'":
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
              "-n $(kubectl config view --minify -o jsonpath='{.contexts[0].context.namespace}' 2>/dev/null || echo default) get pods -o jsonpath='{.items[0].metadata.name}'":
                new K8sCommandError({
                  message: "kubectl failed",
                  command:
                    "-n $(kubectl config view --minify -o jsonpath='{.contexts[0].context.namespace}' 2>/dev/null || echo default) get pods -o jsonpath='{.items[0].metadata.name}'",
                  exitCode: 1,
                }),
            },
          }),
        ),
      ),
    );
  });

  describe("readLogs", () => {
    it.effect("sanitizes local grep shell argument to prevent injection", () => {
      const observedShellCommands: Array<string> = [];
      return Effect.gen(function* () {
        const service = yield* LogsService;
        const options: ReadOptions = {
          tail: 100,
          grep: "error'; rm -rf /; `whoami`",
          pretty: false,
        };

        const result = yield* service.readLogs("local", options);

        expect(result).toBe("matched line");
        expect(observedShellCommands).toContain(
          "tail -100 '/app/logs/app.log' | grep -i 'error'\\''; rm -rf /; `whoami`'",
        );
      }).pipe(
        Effect.provide(
          createLogsServiceLayer({
            observedShellCommands,
            shellResponses: {
              "ls -t /app/logs/*.log 2>/dev/null | head -1": {
                stdout: "/app/logs/app.log\n",
                stderr: "",
                exitCode: 0,
              },
              "tail -100 '/app/logs/app.log' | grep -i 'error'\\''; rm -rf /; `whoami`'": {
                stdout: "matched line\n",
                stderr: "",
                exitCode: 0,
              },
            },
          }),
        ),
      );
    });

    it.effect("pretty prints local JSON lines and keeps malformed lines", () =>
      Effect.gen(function* () {
        const service = yield* LogsService;
        const options: ReadOptions = {
          tail: 3,
          file: "app.log",
          pretty: true,
        };

        const result = yield* service.readLogs("local", options);

        expect(result).toBe(
          ['{\n  "level": "info",\n  "msg": "ok"\n}', "plain line", '{\n  "n": 1\n}'].join(
            "\n---\n",
          ),
        );
      }).pipe(
        Effect.provide(
          createLogsServiceLayer({
            shellResponses: {
              "tail -3 '/app/logs/app.log'": {
                stdout: ['{"level":"info","msg":"ok"}', "plain line", '{"n":1}'].join("\n"),
                stderr: "",
                exitCode: 0,
              },
            },
          }),
        ),
      ),
    );

    it.effect("returns no matching lines when local grep exits with code 1", () =>
      Effect.gen(function* () {
        const service = yield* LogsService;
        const options: ReadOptions = {
          tail: 25,
          file: "app.log",
          grep: "timeout",
          pretty: false,
        };

        const result = yield* service.readLogs("local", options);

        expect(result).toBe("(no matching lines)");
      }).pipe(
        Effect.provide(
          createLogsServiceLayer({
            shellResponses: {
              "tail -25 '/app/logs/app.log' | grep -i 'timeout'": {
                stdout: "",
                stderr: "",
                exitCode: 1,
              },
            },
          }),
        ),
      ),
    );

    it.effect("fails local read when command exits non-zero and not grep-empty", () =>
      Effect.gen(function* () {
        const service = yield* LogsService;
        const options: ReadOptions = {
          tail: 25,
          file: "app.log",
          pretty: false,
        };

        const result = yield* service.readLogs("local", options).pipe(Effect.result);

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
            shellResponses: {
              "tail -25 '/app/logs/app.log'": {
                stdout: "",
                stderr: "tail failed",
                exitCode: 2,
              },
            },
          }),
        ),
      ),
    );

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

        expect(result).toBe("fatal line");
        expect(observedK8sCommands).toContain(
          "exec app-pod -- sh -c \"tail -50 '/var/log/app/api.log' | grep -i 'fatal'\\''; echo bad'\"",
        );
      }).pipe(
        Effect.provide(
          createLogsServiceLayer({
            observedK8sCommands,
            k8sResponses: {
              "get pods -o jsonpath='{.items[0].metadata.name}'": {
                success: true,
                output: "app-pod",
                command: "kubectl get pods",
                executionTimeMs: 5,
              },
              "exec app-pod -- sh -c \"tail -50 '/var/log/app/api.log' | grep -i 'fatal'\\''; echo bad'\"":
                {
                  success: true,
                  output: "fatal line\n",
                  command: "kubectl exec app-pod -- sh -c ...",
                  executionTimeMs: 9,
                },
            },
          }),
        ),
      );
    });

    it.effect("pretty prints remote JSON lines", () =>
      Effect.gen(function* () {
        const service = yield* LogsService;
        const options: ReadOptions = {
          tail: 2,
          file: "app.log",
          pretty: true,
        };

        const result = yield* service.readLogs("prod", options);

        expect(result).toBe('{\n  "x": 1\n}\n---\nnot json');
      }).pipe(
        Effect.provide(
          createLogsServiceLayer({
            k8sResponses: {
              "get pods -o jsonpath='{.items[0].metadata.name}'": {
                success: true,
                output: "prod-pod",
                command: "kubectl get pods",
                executionTimeMs: 3,
              },
              "exec prod-pod -- sh -c \"tail -2 '/var/log/app/app.log'\"": {
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
              "get pods -o jsonpath='{.items[0].metadata.name}'": {
                success: true,
                output: "prod-pod",
                command: "kubectl get pods",
                executionTimeMs: 4,
              },
              "exec prod-pod -- sh -c \"tail -10 '/var/log/app/app.log' | grep -i 'never-happens'\"":
                new K8sCommandError({
                  message: "grep found no results",
                  command: "kubectl exec prod-pod -- sh -c ...",
                  exitCode: 1,
                }),
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
              "get pods -o jsonpath='{.items[0].metadata.name}'": {
                success: true,
                output: "test-pod",
                command: "kubectl get pods",
                executionTimeMs: 4,
              },
              "exec test-pod -- sh -c \"tail -10 '/var/log/app/app.log'\"": new K8sCommandError({
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
  it.effect("lists local logs successfully", () =>
    Effect.gen(function* () {
      const service = yield* LogsService;
      const result = yield* service.listLogs("local");

      expect(result).toBeDefined();
      expect(result.length).toBeGreaterThan(0);
    }).pipe(
      Effect.provide(
        createLogsServiceLayer({
          shellResponses: {
            "ls -la /app/logs": {
              stdout: [
                "total 12",
                "drwxr-xr-x 2 app app  64 Jan 1 09:59 .",
                "-rw-r--r-- 1 app app 120 Jan 1 10:00 app.log",
              ].join("\n"),
              stderr: "",
              exitCode: 0,
            },
          },
        }),
      ),
    ),
  );

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
            "-n $(kubectl config view --minify -o jsonpath='{.contexts[0].context.namespace}' 2>/dev/null || echo default) get pods -o jsonpath='{.items[0].metadata.name}'":
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
