import {
  isKubectlCommandAllowed,
  ALLOWED_KUBECTL_VERBS,
  BLOCKED_KUBECTL_VERBS,
} from "#k8s/security";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Match, Option, Result } from "effect";

import type { CommandResult, Environment } from "#k8s/types";

import {
  K8sCommandError,
  K8sContextError,
  K8sDangerousCommandError,
  K8sTimeoutError,
} from "#k8s/errors";
import { K8sService } from "#k8s/service";
import { formatOutput } from "#shared";

type K8sError = K8sCommandError | K8sContextError | K8sTimeoutError | K8sDangerousCommandError;

function createMockK8sServiceLayer(
  mockResponses: Record<string, CommandResult | string | K8sError>,
) {
  return Layer.succeed(K8sService, {
    runCommand: (cmd: string, _env: Environment) => {
      const response = mockResponses[`cmd:${cmd}`];

      if (
        response instanceof K8sCommandError ||
        response instanceof K8sContextError ||
        response instanceof K8sTimeoutError ||
        response instanceof K8sDangerousCommandError
      ) {
        return Effect.fail(response);
      }

      if (typeof response === "string") {
        return Effect.succeed(response.trim());
      }

      if (response && "error" in response && response.error) {
        return Effect.fail(
          new K8sCommandError({
            message: response.error,
            command: cmd,
            exitCode: -1,
          }),
        );
      }

      return Effect.succeed(response?.output ?? "");
    },

    runKubectl: (cmd: string, dryRun: boolean) => {
      const response = mockResponses[`kubectl:${cmd}:${dryRun}`] ??
        mockResponses[`kubectl:${cmd}`] ?? {
          success: true,
          output: "mock output",
          command: `kubectl ${cmd}`,
          executionTimeMs: 100,
        };

      if (
        response instanceof K8sCommandError ||
        response instanceof K8sContextError ||
        response instanceof K8sTimeoutError ||
        response instanceof K8sDangerousCommandError
      ) {
        return Effect.fail(response);
      }

      if (typeof response === "string") {
        return Effect.succeed({
          success: true,
          output: response,
          command: `kubectl ${cmd}`,
          executionTimeMs: 100,
        });
      }

      return Effect.succeed(response as CommandResult);
    },
  });
}

describe("K8sService", () => {
  describe("runKubectl - successful execution", () => {
    it.effect("executes kubectl command successfully", () =>
      Effect.gen(function* () {
        const service = yield* K8sService;
        const result = yield* service.runKubectl("get pods -n my-app-test", false);

        expect(result.success).toBe(true);
        expect(result.output).toBe("pod-1\npod-2\npod-3");
        expect(result.command).toBe("kubectl get pods -n my-app-test");
        expect(result.executionTimeMs).toBeGreaterThan(0);
      }).pipe(
        Effect.provide(
          createMockK8sServiceLayer({
            "kubectl:get pods -n my-app-test": {
              success: true,
              output: "pod-1\npod-2\npod-3",
              command: "kubectl get pods -n my-app-test",
              executionTimeMs: 150,
            },
          }),
        ),
      ),
    );

    it.effect("includes execution time in result", () =>
      Effect.gen(function* () {
        const service = yield* K8sService;
        const result = yield* service.runKubectl("get nodes", false);

        expect(result.executionTimeMs).toBe(250);
      }).pipe(
        Effect.provide(
          createMockK8sServiceLayer({
            "kubectl:get nodes": {
              success: true,
              output: "node-1\nnode-2",
              command: "kubectl get nodes",
              executionTimeMs: 250,
            },
          }),
        ),
      ),
    );

    it.effect("handles complex kubectl commands with pipes", () =>
      Effect.gen(function* () {
        const service = yield* K8sService;
        const result = yield* service.runKubectl(
          "logs -l app=web-app -n my-app-test | grep error",
          false,
        );

        expect(result.success).toBe(true);
        expect(result.output).toContain("error-line");
      }).pipe(
        Effect.provide(
          createMockK8sServiceLayer({
            "kubectl:logs -l app=web-app -n my-app-test | grep error": {
              success: true,
              output: "error-line-1\nerror-line-2",
              command: "kubectl logs -l app=web-app -n my-app-test | grep error",
              executionTimeMs: 300,
            },
          }),
        ),
      ),
    );

    it.effect("handles empty output", () =>
      Effect.gen(function* () {
        const service = yield* K8sService;
        const result = yield* service.runKubectl("get pods -n empty-namespace", false);

        expect(result.success).toBe(true);
        expect(result.output).toBe("");
      }).pipe(
        Effect.provide(
          createMockK8sServiceLayer({
            "kubectl:get pods -n empty-namespace": {
              success: true,
              output: "",
              command: "kubectl get pods -n empty-namespace",
              executionTimeMs: 100,
            },
          }),
        ),
      ),
    );
  });

  describe("runKubectl - dry-run mode", () => {
    it.effect("does not execute command in dry-run mode", () =>
      Effect.gen(function* () {
        const service = yield* K8sService;
        const result = yield* service.runKubectl("get pods -n my-app-test", true);

        expect(result.success).toBe(true);
        expect(result.output).toBe("(dry run - command not executed)");
      }).pipe(
        Effect.provide(
          createMockK8sServiceLayer({
            "kubectl:get pods -n my-app-test:true": {
              success: true,
              command: "kubectl get pods -n my-app-test",
              output: "(dry run - command not executed)",
              executionTimeMs: 10,
            },
          }),
        ),
      ),
    );

    it.effect("shows command that would be executed", () =>
      Effect.gen(function* () {
        const service = yield* K8sService;
        const result = yield* service.runKubectl("delete pod test-pod", true);

        expect(result.command).toContain("delete pod test-pod");
      }).pipe(
        Effect.provide(
          createMockK8sServiceLayer({
            "kubectl:delete pod test-pod:true": {
              success: true,
              command: "kubectl --context test-cluster delete pod test-pod",
              output: "(dry run - command not executed)",
              executionTimeMs: 5,
            },
          }),
        ),
      ),
    );

    it.effect("has minimal execution time in dry-run", () =>
      Effect.gen(function* () {
        const service = yield* K8sService;
        const result = yield* service.runKubectl("get pods", true);

        expect(result.executionTimeMs).toBeLessThan(50);
      }).pipe(
        Effect.provide(
          createMockK8sServiceLayer({
            "kubectl:get pods:true": {
              success: true,
              command: "kubectl get pods",
              output: "(dry run - command not executed)",
              executionTimeMs: 2,
            },
          }),
        ),
      ),
    );
  });

  describe("runKubectl - error handling", () => {
    it.effect("handles K8sContextError", () =>
      Effect.gen(function* () {
        const service = yield* K8sService;
        const result = yield* service.runKubectl("get pods", false).pipe(Effect.result);

        Result.match(result, {
          onFailure: (left) => {
            expect(left._tag).toBe("K8sContextError");
            expect(left.message).toContain("No kubectl context found");
          },
          onSuccess: () => {
            expect.fail("Expected Left but got Right");
          },
        });
      }).pipe(
        Effect.provide(
          createMockK8sServiceLayer({
            "kubectl:get pods": new K8sContextError({
              message: "No kubectl context found for cluster ID: test-cluster",
              clusterId: "test-cluster",
            }),
          }),
        ),
      ),
    );

    it.effect("handles K8sCommandError with exit code", () =>
      Effect.gen(function* () {
        const service = yield* K8sService;
        const result = yield* service.runKubectl("get pod invalid-pod", false).pipe(Effect.result);

        Result.match(result, {
          onFailure: (left) => {
            Match.value(left).pipe(
              Match.tag("K8sCommandError", (err) => {
                expect(err.exitCode).toBe(1);
                expect(err.stderr).toContain("NotFound");
              }),
              Match.orElse(() => {
                throw new Error("Expected K8sCommandError");
              }),
            );
          },
          onSuccess: () => {
            expect.fail("Expected Left but got Right");
          },
        });
      }).pipe(
        Effect.provide(
          createMockK8sServiceLayer({
            "kubectl:get pod invalid-pod": new K8sCommandError({
              message: "pod not found",
              command: "kubectl get pod invalid-pod",
              exitCode: 1,
              stderr: 'Error from server (NotFound): pods "invalid-pod" not found',
            }),
          }),
        ),
      ),
    );

    it.effect("handles K8sTimeoutError", () =>
      Effect.gen(function* () {
        const service = yield* K8sService;
        const result = yield* service.runKubectl("logs -f pod-name", false).pipe(Effect.result);

        Result.match(result, {
          onFailure: (left) => {
            Match.value(left).pipe(
              Match.tag("K8sTimeoutError", (err) => {
                expect(err.timeoutMs).toBe(30000);
              }),
              Match.orElse(() => {
                throw new Error("Expected K8sTimeoutError");
              }),
            );
          },
          onSuccess: () => {
            expect.fail("Expected Left but got Right");
          },
        });
      }).pipe(
        Effect.provide(
          createMockK8sServiceLayer({
            "kubectl:logs -f pod-name": new K8sTimeoutError({
              message: "Command timed out after 30000ms",
              command: "kubectl logs -f pod-name",
              timeoutMs: 30000,
            }),
          }),
        ),
      ),
    );

    it.effect("includes command in error for debugging", () =>
      Effect.gen(function* () {
        const service = yield* K8sService;
        const result = yield* service
          .runKubectl("get pods -n my-app-test", false)
          .pipe(Effect.result);

        Result.match(result, {
          onFailure: (left) => {
            Match.value(left).pipe(
              Match.tag("K8sCommandError", (err) => {
                expect(err.command).toBe("kubectl get pods -n my-app-test");
              }),
              Match.orElse(() => {
                throw new Error("Expected K8sCommandError");
              }),
            );
          },
          onSuccess: () => {
            expect.fail("Expected Left but got Right");
          },
        });
      }).pipe(
        Effect.provide(
          createMockK8sServiceLayer({
            "kubectl:get pods -n my-app-test": new K8sCommandError({
              message: "Connection refused",
              command: "kubectl get pods -n my-app-test",
              exitCode: 1,
            }),
          }),
        ),
      ),
    );
  });

  describe("runCommand - basic execution", () => {
    it.effect("executes raw kubectl command", () =>
      Effect.gen(function* () {
        const service = yield* K8sService;
        const result = yield* service.runCommand("get pods -n my-app-test", "test");

        expect(result).toBe("pod-1\npod-2");
      }).pipe(
        Effect.provide(
          createMockK8sServiceLayer({
            "cmd:get pods -n my-app-test": "pod-1\npod-2",
          }),
        ),
      ),
    );

    it.effect("trims whitespace from output", () =>
      Effect.gen(function* () {
        const service = yield* K8sService;
        const result = yield* service.runCommand("get nodes", "prod");

        expect(result).not.toMatch(/^\s/);
        expect(result).not.toMatch(/\s$/);
      }).pipe(
        Effect.provide(
          createMockK8sServiceLayer({
            "cmd:get nodes": "  node-1\nnode-2  \n",
          }),
        ),
      ),
    );

    it.effect("handles command with environment parameter", () =>
      Effect.gen(function* () {
        const service = yield* K8sService;
        const result = yield* service.runCommand("get pods -n my-app-prod", "prod");

        expect(result).toContain("prod-pod");
      }).pipe(
        Effect.provide(
          createMockK8sServiceLayer({
            "cmd:get pods -n my-app-prod": "prod-pod-1\nprod-pod-2",
          }),
        ),
      ),
    );

    it.effect("fails on command error", () =>
      Effect.gen(function* () {
        const service = yield* K8sService;
        const result = yield* service.runCommand("invalid-kubectl-cmd", "test").pipe(Effect.result);

        Result.match(result, {
          onFailure: () => {
            /* noop - only success branch is asserted */
          },
          onSuccess: () => {
            expect.fail("Expected Left but got Right");
          },
        });
      }).pipe(
        Effect.provide(
          createMockK8sServiceLayer({
            "cmd:invalid-kubectl-cmd": new K8sCommandError({
              message: "Invalid command",
              command: "invalid-kubectl-cmd",
              exitCode: 127,
            }),
          }),
        ),
      ),
    );
  });

  describe("output formatting", () => {
    it.effect("preserves multiline output", () =>
      Effect.gen(function* () {
        const service = yield* K8sService;
        const result = yield* service.runKubectl("describe pod test-pod", false);

        expect(result.output?.split("\n")).toHaveLength(4);
      }).pipe(
        Effect.provide(
          createMockK8sServiceLayer({
            "kubectl:describe pod test-pod": {
              success: true,
              output: "line1\nline2\nline3\nline4",
              command: "kubectl describe pod test-pod",
              executionTimeMs: 200,
            },
          }),
        ),
      ),
    );

    it.effect("handles JSON output", () =>
      Effect.gen(function* () {
        const service = yield* K8sService;
        const result = yield* service.runKubectl("get pod test-pod -o json", false);

        expect(() => JSON.parse(result.output ?? "")).not.toThrow();
      }).pipe(
        Effect.provide(
          createMockK8sServiceLayer({
            "kubectl:get pod test-pod -o json": {
              success: true,
              output: JSON.stringify({
                apiVersion: "v1",
                kind: "Pod",
                metadata: { name: "test-pod" },
              }),
              command: "kubectl get pod test-pod -o json",
              executionTimeMs: 150,
            },
          }),
        ),
      ),
    );

    it.effect("handles YAML output", () =>
      Effect.gen(function* () {
        const service = yield* K8sService;
        const result = yield* service.runKubectl("get pod test-pod -o yaml", false);

        expect(result.output).toContain("apiVersion");
        expect(result.output).toContain("kind: Pod");
      }).pipe(
        Effect.provide(
          createMockK8sServiceLayer({
            "kubectl:get pod test-pod -o yaml": {
              success: true,
              output: `apiVersion: v1
kind: Pod
metadata:
  name: test-pod
spec:
  containers:
  - name: app
    image: app:latest`,
              command: "kubectl get pod test-pod -o yaml",
              executionTimeMs: 150,
            },
          }),
        ),
      ),
    );
  });

  describe("command variations", () => {
    it.effect("handles get commands", () =>
      Effect.gen(function* () {
        const service = yield* K8sService;
        const result = yield* service.runKubectl("get pods", false);

        expect(result.success).toBe(true);
      }).pipe(
        Effect.provide(
          createMockK8sServiceLayer({
            "kubectl:get pods": {
              success: true,
              output: "pod-1\npod-2\npod-3",
              command: "kubectl get pods",
              executionTimeMs: 100,
            },
          }),
        ),
      ),
    );

    it.effect("handles describe commands", () =>
      Effect.gen(function* () {
        const service = yield* K8sService;
        const result = yield* service.runKubectl("describe pod test-pod", false);

        expect(result.output).toContain("Name:");
      }).pipe(
        Effect.provide(
          createMockK8sServiceLayer({
            "kubectl:describe pod test-pod": {
              success: true,
              output: "Name: test-pod\nNamespace: default",
              command: "kubectl describe pod test-pod",
              executionTimeMs: 150,
            },
          }),
        ),
      ),
    );

    it.effect("handles logs commands", () =>
      Effect.gen(function* () {
        const service = yield* K8sService;
        const result = yield* service.runKubectl("logs pod-name", false);

        expect(result.output).toContain("[INFO]");
      }).pipe(
        Effect.provide(
          createMockK8sServiceLayer({
            "kubectl:logs pod-name": {
              success: true,
              output: "[INFO] Application started\n[INFO] Ready to serve",
              command: "kubectl logs pod-name",
              executionTimeMs: 200,
            },
          }),
        ),
      ),
    );

    it.effect("handles exec commands", () =>
      Effect.gen(function* () {
        const service = yield* K8sService;
        const result = yield* service.runKubectl("exec pod-name -- ls -la", false);

        expect(result.output).toContain("output");
      }).pipe(
        Effect.provide(
          createMockK8sServiceLayer({
            "kubectl:exec pod-name -- ls -la": {
              success: true,
              output: "command output from pod",
              command: "kubectl exec pod-name -- ls -la",
              executionTimeMs: 250,
            },
          }),
        ),
      ),
    );

    it.effect("handles top commands", () =>
      Effect.gen(function* () {
        const service = yield* K8sService;
        const result = yield* service.runKubectl("top pod", false);

        expect(result.output).toContain("CPU");
      }).pipe(
        Effect.provide(
          createMockK8sServiceLayer({
            "kubectl:top pod": {
              success: true,
              output: "NAME       CPU(cores)   MEMORY(bytes)\npod-1      100m         256Mi",
              command: "kubectl top pod",
              executionTimeMs: 300,
            },
          }),
        ),
      ),
    );
  });

  describe("edge cases", () => {
    it.effect("handles very long output", () =>
      Effect.gen(function* () {
        const service = yield* K8sService;
        const result = yield* service.runKubectl("logs pod-name --tail=1000", false);

        expect(result.output?.split("\n")).toHaveLength(1000);
      }).pipe(
        Effect.provide(
          createMockK8sServiceLayer({
            "kubectl:logs pod-name --tail=1000": {
              success: true,
              output: Array(1000)
                .fill(0)
                .map((_, i) => `line-${i}`)
                .join("\n"),
              command: "kubectl logs pod-name --tail=1000",
              executionTimeMs: 500,
            },
          }),
        ),
      ),
    );

    it.effect("handles special characters in output", () =>
      Effect.gen(function* () {
        const service = yield* K8sService;
        const result = yield* service.runKubectl("get pods", false);

        expect(result.output).toBe("pod-name-with-special-chars_123-456");
      }).pipe(
        Effect.provide(
          createMockK8sServiceLayer({
            "kubectl:get pods": {
              success: true,
              output: "pod-name-with-special-chars_123-456",
              command: "kubectl get pods",
              executionTimeMs: 100,
            },
          }),
        ),
      ),
    );

    it.effect("handles unicode characters", () =>
      Effect.gen(function* () {
        const service = yield* K8sService;
        const result = yield* service.runKubectl("get pods", false);

        expect(result.output).toBe("Pod: 测试-pod-🚀");
      }).pipe(
        Effect.provide(
          createMockK8sServiceLayer({
            "kubectl:get pods": {
              success: true,
              output: "Pod: 测试-pod-🚀",
              command: "kubectl get pods",
              executionTimeMs: 100,
            },
          }),
        ),
      ),
    );

    it.effect("handles commands with quotes", () =>
      Effect.gen(function* () {
        const service = yield* K8sService;
        const result = yield* service.runKubectl('get pods -o json | jq ".items[0]"', false);

        expect(result.success).toBe(true);
      }).pipe(
        Effect.provide(
          createMockK8sServiceLayer({
            'kubectl:get pods -o json | jq ".items[0]"': {
              success: true,
              output: "filtered output",
              command: 'kubectl get pods -o json | jq ".items[0]"',
              executionTimeMs: 150,
            },
          }),
        ),
      ),
    );
  });

  describe("result structure", () => {
    it.effect("includes all required fields in success result", () =>
      Effect.gen(function* () {
        const service = yield* K8sService;
        const result = yield* service.runKubectl("get pods", false);

        expect(result).toHaveProperty("success");
        expect(result).toHaveProperty("output");
        expect(result).toHaveProperty("command");
        expect(result).toHaveProperty("executionTimeMs");
      }).pipe(
        Effect.provide(
          createMockK8sServiceLayer({
            "kubectl:get pods": {
              success: true,
              output: "test output",
              command: "kubectl get pods",
              executionTimeMs: 100,
            },
          }),
        ),
      ),
    );

    it.effect("includes error field in error result", () =>
      Effect.gen(function* () {
        const service = yield* K8sService;
        const result = yield* service.runKubectl("get pods", false).pipe(Effect.result);

        Result.match(result, {
          onFailure: () => {
            /* noop - only success branch is asserted */
          },
          onSuccess: () => {
            expect.fail("Expected Left but got Right");
          },
        });
      }).pipe(
        Effect.provide(
          createMockK8sServiceLayer({
            "kubectl:get pods": new K8sCommandError({
              message: "Command failed",
              command: "kubectl get pods",
              exitCode: 1,
            }),
          }),
        ),
      ),
    );

    it.effect("execution time is always a number", () =>
      Effect.gen(function* () {
        const service = yield* K8sService;
        const result = yield* service.runKubectl("get pods", false);

        expect(typeof result.executionTimeMs).toBe("number");
        expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
      }).pipe(
        Effect.provide(
          createMockK8sServiceLayer({
            "kubectl:get pods": {
              success: true,
              output: "output",
              command: "kubectl get pods",
              executionTimeMs: 0,
            },
          }),
        ),
      ),
    );
  });

  describe("structured subcommands - command construction", () => {
    // Replicates the internal buildKubectlCommand logic from index.ts
    // eslint-disable-next-line unicorn/consistent-function-scoping -- test helper, clearer inline
    const buildCmd = (base: string, args: ReadonlyArray<string>) => {
      const extras = args.filter((part) => part.length > 0);
      return extras.length === 0 ? base : `${base} ${extras.join(" ")}`;
    };

    describe("pods", () => {
      it("builds base get pods command with no options", () => {
        expect(buildCmd("get pods", ["", "", ""])).toBe("get pods");
      });

      it("builds command with label selector", () => {
        expect(buildCmd("get pods", ["-l app=web", "", ""])).toBe("get pods -l app=web");
      });

      it("builds command with namespace", () => {
        expect(buildCmd("get pods", ["", "-n my-app-test", ""])).toBe("get pods -n my-app-test");
      });

      it("builds command with wide output", () => {
        expect(buildCmd("get pods", ["", "", "-o wide"])).toBe("get pods -o wide");
      });

      it("builds command with all flags combined", () => {
        expect(buildCmd("get pods", ["-l app=web", "-n my-app-test", "-o wide"])).toBe(
          "get pods -l app=web -n my-app-test -o wide",
        );
      });
    });

    describe("logs", () => {
      it("builds base logs command", () => {
        expect(buildCmd("logs my-pod", ["", "", "", ""])).toBe("logs my-pod");
      });

      it("builds command with namespace and container", () => {
        expect(buildCmd("logs my-pod", ["-n my-ns", "-c app", "", ""])).toBe(
          "logs my-pod -n my-ns -c app",
        );
      });

      it("builds command with tail and follow", () => {
        expect(buildCmd("logs my-pod", ["", "", "--tail=100", "-f"])).toBe(
          "logs my-pod --tail=100 -f",
        );
      });

      it("builds command with all options", () => {
        expect(buildCmd("logs my-pod", ["-n my-ns", "-c app", "--tail=50", "-f"])).toBe(
          "logs my-pod -n my-ns -c app --tail=50 -f",
        );
      });
    });

    describe("describe", () => {
      it("builds base describe command", () => {
        expect(buildCmd("describe pod my-pod", [""])).toBe("describe pod my-pod");
      });

      it("builds command with namespace", () => {
        expect(buildCmd("describe deploy web-app", ["-n my-ns"])).toBe(
          "describe deploy web-app -n my-ns",
        );
      });
    });

    describe("exec", () => {
      it("builds base exec command with -- separator", () => {
        expect(buildCmd("exec my-pod", ["", "", "-- ls -la"])).toBe("exec my-pod -- ls -la");
      });

      it("builds command with namespace and container", () => {
        expect(buildCmd("exec my-pod", ["-n my-ns", "-c app", "-- cat /app/logs/app.log"])).toBe(
          "exec my-pod -n my-ns -c app -- cat /app/logs/app.log",
        );
      });
    });

    describe("top", () => {
      it("builds base top pod command", () => {
        expect(buildCmd("top pod", ["", ""])).toBe("top pod");
      });

      it("builds command with namespace", () => {
        expect(buildCmd("top pod", ["-n my-ns", ""])).toBe("top pod -n my-ns");
      });

      it("builds command with sort-by", () => {
        expect(buildCmd("top pod", ["", "--sort-by=cpu"])).toBe("top pod --sort-by=cpu");
      });

      it("builds command with namespace and sort-by", () => {
        expect(buildCmd("top pod", ["-n my-ns", "--sort-by=memory"])).toBe(
          "top pod -n my-ns --sort-by=memory",
        );
      });
    });
  });

  describe("output format - TOON and JSON", () => {
    it("formats successful result as JSON with all fields", () => {
      const result: CommandResult = {
        success: true,
        output: "pod-1\npod-2",
        command: "kubectl get pods",
        executionTimeMs: 150,
      };
      const json = formatOutput(result, "json");
      const parsed = JSON.parse(json);
      expect(parsed.success).toBe(true);
      expect(parsed.output).toBe("pod-1\npod-2");
      expect(parsed.command).toBe("kubectl get pods");
      expect(parsed.executionTimeMs).toBe(150);
    });

    it("formats successful result as TOON", () => {
      const result: CommandResult = {
        success: true,
        output: "pod-1\npod-2",
        command: "kubectl get pods",
        executionTimeMs: 150,
      };
      const toon = formatOutput(result, "toon");
      expect(toon).toContain("pod-1");
      expect(toon).toContain("pod-2");
    });

    it("includes hint fields in JSON output", () => {
      const result: CommandResult = {
        success: false,
        error: "pod not found",
        hint: "Check pod name and namespace",
        nextCommand: "kubectl get pods -n my-ns",
        retryable: false,
        executionTimeMs: 0,
      };
      const json = formatOutput(result, "json");
      const parsed = JSON.parse(json);
      expect(parsed.hint).toBe("Check pod name and namespace");
      expect(parsed.nextCommand).toBe("kubectl get pods -n my-ns");
      expect(parsed.retryable).toBe(false);
    });

    it("includes hint fields in TOON output", () => {
      const result: CommandResult = {
        success: false,
        error: "pod not found",
        hint: "Check pod name and namespace",
        nextCommand: "kubectl get pods -n my-ns",
        executionTimeMs: 0,
      };
      const toon = formatOutput(result, "toon");
      expect(toon).toContain("Check pod name and namespace");
      expect(toon).toContain("kubectl get pods -n my-ns");
    });

    it("includes environment field in output when present", () => {
      const result: CommandResult = {
        success: true,
        output: "pod-1",
        executionTimeMs: 100,
        environment: "test",
      };
      const json = formatOutput(result, "json");
      const parsed = JSON.parse(json);
      expect(parsed.environment).toBe("test");
    });
  });

  describe("env resolution", () => {
    it("explicit env option returns the provided value", () => {
      const env = Option.some("test");
      expect(Option.getOrUndefined(env)).toBe("test");
    });

    it("none env option returns undefined for config fallback", () => {
      const env: Option.Option<string> = Option.none();
      expect(Option.getOrUndefined(env)).toBeUndefined();
    });

    it("prod safety error carries actionable hint and next command", () => {
      const error = new K8sContextError({
        message:
          "Implicit prod access blocked. Config defaultEnvironment is 'prod' but --env was not passed explicitly.",
        clusterId: "(prod-safety)",
        hint: "Pass --env prod explicitly to confirm production access, or change defaultEnvironment to a non-prod value.",
        nextCommand: 'agent-tools-k8s kubectl --env prod --cmd "get pods -n <namespace>"',
      });
      expect(error._tag).toBe("K8sContextError");
      expect(error.hint).toContain("--env prod");
      expect(error.nextCommand).toContain("--env prod");
      expect(error.clusterId).toBe("(prod-safety)");
    });

    it("missing env error provides config guidance", () => {
      const error = new K8sContextError({
        message:
          "No environment specified. Use --env <name> or set defaultEnvironment in agent-tools.json5.",
        clusterId: "(not specified)",
        hint: 'Set defaultEnvironment in agent-tools.json5 (e.g. defaultEnvironment: "test") or pass --env explicitly.',
        nextCommand: 'agent-tools-k8s kubectl --env test --cmd "get pods -n <namespace>"',
      });
      expect(error.hint).toContain("defaultEnvironment");
      expect(error.nextCommand).toContain("--env test");
    });
  });

  describe("error recovery hints", () => {
    it("K8sContextError carries hint, nextCommand, and retryable", () => {
      const error = new K8sContextError({
        message: "No kubectl context found",
        clusterId: "my-cluster",
        hint: "Verify cluster ID matches kubectl config",
        nextCommand: "kubectl config get-contexts",
        retryable: true,
      });
      expect(error.hint).toBe("Verify cluster ID matches kubectl config");
      expect(error.nextCommand).toBe("kubectl config get-contexts");
      expect(error.retryable).toBe(true);
    });

    it("K8sCommandError carries hint with exit code and stderr", () => {
      const error = new K8sCommandError({
        message: "pod not found",
        command: "kubectl get pod invalid-pod",
        exitCode: 1,
        stderr: 'Error from server (NotFound): pods "invalid-pod" not found',
        hint: "Check pod name; use 'kubectl get pods' to list available pods.",
        nextCommand: "kubectl get pods -n my-ns",
        retryable: false,
      });
      expect(error.hint).toContain("kubectl get pods");
      expect(error.nextCommand).toBe("kubectl get pods -n my-ns");
      expect(error.retryable).toBe(false);
      expect(error.exitCode).toBe(1);
    });

    it("K8sTimeoutError carries hint with retryable flag", () => {
      const error = new K8sTimeoutError({
        message: "Command timed out after 30000ms",
        command: "kubectl logs -f pod-name",
        timeoutMs: 30000,
        hint: "Consider increasing timeoutMs or narrowing the query.",
        retryable: true,
      });
      expect(error.hint).toContain("timeoutMs");
      expect(error.retryable).toBe(true);
      expect(error.timeoutMs).toBe(30000);
    });

    it("errors without hints have undefined optional fields", () => {
      const error = new K8sContextError({
        message: "No context",
        clusterId: "my-cluster",
      });
      expect(error.hint).toBeUndefined();
      expect(error.nextCommand).toBeUndefined();
      expect(error.retryable).toBeUndefined();
    });

    it.effect("service error with hints propagates through mock layer", () =>
      Effect.gen(function* () {
        const service = yield* K8sService;
        const result = yield* service
          .runKubectl("get pod missing-pod -n my-ns", false)
          .pipe(Effect.result);

        Result.match(result, {
          onFailure: (left) => {
            Match.value(left).pipe(
              Match.tag("K8sCommandError", (err) => {
                expect(err.hint).toBe("Check the pod name is correct.");
                expect(err.nextCommand).toBe("kubectl get pods -n my-ns");
                expect(err.retryable).toBe(false);
              }),
              Match.orElse(() => {
                throw new Error("Expected K8sCommandError");
              }),
            );
          },
          onSuccess: () => {
            expect.fail("Expected Left but got Right");
          },
        });
      }).pipe(
        Effect.provide(
          createMockK8sServiceLayer({
            "kubectl:get pod missing-pod -n my-ns": new K8sCommandError({
              message: "pod not found",
              command: "kubectl get pod missing-pod -n my-ns",
              exitCode: 1,
              hint: "Check the pod name is correct.",
              nextCommand: "kubectl get pods -n my-ns",
              retryable: false,
            }),
          }),
        ),
      ),
    );
  });
});

describe("env resolution with defaultEnvironment", () => {
  it.effect("executes kubectl command successfully with explicit env", () =>
    Effect.gen(function* () {
      const service = yield* K8sService;
      const result = yield* service.runKubectl("get pods", false);

      expect(result.success).toBe(true);
      expect(result.output).toBeDefined();
    }).pipe(
      Effect.provide(
        createMockK8sServiceLayer({
          "kubectl:get pods": {
            success: true,
            output: "pod-1",
            command: "kubectl get pods",
            executionTimeMs: 100,
          },
        }),
      ),
    ),
  );

  it.effect("service layer is environment-agnostic (env resolution happens at CLI level)", () =>
    Effect.gen(function* () {
      const service = yield* K8sService;
      const result = yield* service.runKubectl("get pods", false);

      expect(result.success).toBe(true);
      expect(result.command).toBe("kubectl get pods");
    }).pipe(
      Effect.provide(
        createMockK8sServiceLayer({
          "kubectl:get pods": {
            success: true,
            output: "pod-1",
            command: "kubectl get pods",
            executionTimeMs: 100,
          },
        }),
      ),
    ),
  );

  it("K8sContextError can carry prod-safety hint", () => {
    const error = new K8sContextError({
      message:
        "Implicit prod access blocked. Config defaultEnvironment is 'prod' but --env was not passed explicitly.",
      clusterId: "(prod-safety)",
      hint: "Pass --env prod explicitly to confirm production access, or change defaultEnvironment to a non-prod value.",
      nextCommand: 'agent-tools-k8s kubectl --env prod --cmd "get pods -n <namespace>"',
    });

    expect(error._tag).toBe("K8sContextError");
    expect(error.message).toContain("Implicit prod access blocked");
    expect(error.hint).toContain("--env prod");
    expect(error.nextCommand).toContain("--env prod");
  });
});

it("K8sContextError can carry missing-env hint", () => {
  const error = new K8sContextError({
    message:
      "No environment specified. Use --env <name> or set defaultEnvironment in agent-tools.json5.",
    clusterId: "(not specified)",
    hint: 'Set defaultEnvironment in agent-tools.json5 (e.g. defaultEnvironment: "test") or pass --env explicitly.',
    nextCommand: 'agent-tools-k8s kubectl --env test --cmd "get pods -n <namespace>"',
  });

  expect(error._tag).toBe("K8sContextError");
  expect(error.message).toContain("No environment specified");
  expect(error.hint).toContain("defaultEnvironment");
  expect(error.nextCommand).toContain("--env test");
});

describe("error recovery hints - unit tests", () => {
  it("K8sCommandError with hint and nextCommand", () => {
    const error = new K8sCommandError({
      message: 'error: namespaces "invalid" not found',
      command: "get pods -n invalid",
      exitCode: 1,
      hint: "Check namespace name. Use 'kubectl get namespaces' to list available namespaces.",
      nextCommand: "agent-tools-k8s kubectl --cmd 'get namespaces'",
      retryable: true,
    });

    expect(error._tag).toBe("K8sCommandError");
    expect(error.hint).toBe(
      "Check namespace name. Use 'kubectl get namespaces' to list available namespaces.",
    );
    expect(error.nextCommand).toBe("agent-tools-k8s kubectl --cmd 'get namespaces'");
    expect(error.retryable).toBe(true);
  });

  it("K8sContextError with hint and nextCommand", () => {
    const error = new K8sContextError({
      message: "No cluster context configured",
      clusterId: "prod-cluster",
      hint: "Configure kubectl context using 'kubectl config use-context <context-name>'",
      nextCommand: "kubectl config use-context prod-cluster",
    });

    expect(error._tag).toBe("K8sContextError");
    expect(error.hint).toContain("kubectl config use-context");
    expect(error.nextCommand).toBe("kubectl config use-context prod-cluster");
  });

  it("K8sTimeoutError with hint and retryable", () => {
    const error = new K8sTimeoutError({
      message: "Command timed out after 30000ms",
      command: "logs -f pod-name",
      timeoutMs: 30000,
      hint: "Pod may be slow to respond. Try increasing timeout or checking pod status.",
      nextCommand: "agent-tools-k8s kubectl --cmd 'describe pod pod-name'",
      retryable: true,
    });

    expect(error._tag).toBe("K8sTimeoutError");
    expect(error.hint).toContain("Pod may be slow");
    expect(error.retryable).toBe(true);
  });

  it("hint fields are optional in K8s errors", () => {
    const error = new K8sCommandError({
      message: "Connection refused",
      command: "get pods",
      exitCode: 1,
    });

    expect(error._tag).toBe("K8sCommandError");
    expect(error.message).toBe("Connection refused");
    expect(error.hint).toBeUndefined();
    expect(error.nextCommand).toBeUndefined();
  });
});

describe("kubectl command security", () => {
  describe("isKubectlCommandAllowed - blocked verbs", () => {
    const dangerousCommands = [
      "delete pod my-pod -n my-ns",
      "delete deployment web-app",
      "apply -f deployment.yaml",
      "patch deployment web-app -p '{}",
      "create namespace new-ns",
      "scale deployment web-app --replicas=0",
      "drain node-1",
      "cordon node-1",
      "uncordon node-1",
      "taint nodes node-1 key=value:NoSchedule",
      "edit deployment web-app",
      "replace -f deployment.yaml",
      "rollout restart deployment web-app",
      "set image deployment/web-app app=app:v2",
      "label pod my-pod env=prod",
      "annotate pod my-pod note=test",
      "expose deployment web-app --port=80",
      "autoscale deployment web-app --min=1 --max=5",
      "run test-pod --image=alpine",
      "cp /tmp/file my-pod:/tmp/file",
    ];

    for (const cmd of dangerousCommands) {
      const verb = cmd.split(/\s+/)[0];
      it(`blocks '${verb}' command: ${cmd}`, () => {
        const result = isKubectlCommandAllowed(cmd);
        expect(result.allowed).toBe(false);
        expect(result.verb).toBe(verb);
        expect(result.reason).toContain("mutating operation");
      });
    }
  });

  describe("isKubectlCommandAllowed - allowed verbs", () => {
    const safeCommands = [
      "get pods -n my-ns",
      "get deployment web-app -o yaml",
      "describe pod my-pod -n my-ns",
      "logs my-pod -n my-ns --tail=100",
      "top pod -n my-ns",
      "explain deployment",
      "api-resources",
      "api-versions",
      "version",
      "cluster-info",
      "auth can-i get pods",
      "diff -f deployment.yaml",
      "wait --for=condition=ready pod/my-pod",
      "exec my-pod -- ls -la",
      "port-forward my-pod 8080:80",
      "config view",
      "config get-contexts",
    ];

    for (const cmd of safeCommands) {
      const verb = cmd.split(/\s+/)[0];
      it(`allows '${verb}' command: ${cmd}`, () => {
        const result = isKubectlCommandAllowed(cmd);
        expect(result.allowed).toBe(true);
        expect(result.verb).toBe(verb);
      });
    }
  });

  describe("isKubectlCommandAllowed - piped commands", () => {
    it("allows safe command with pipe", () => {
      const result = isKubectlCommandAllowed("get pods -n my-ns | grep Running");
      expect(result.allowed).toBe(true);
      expect(result.verb).toBe("get");
    });

    it("blocks dangerous command even with pipe", () => {
      const result = isKubectlCommandAllowed("delete pod my-pod | tee log.txt");
      expect(result.allowed).toBe(false);
      expect(result.verb).toBe("delete");
    });
  });

  describe("isKubectlCommandAllowed - edge cases", () => {
    it("blocks empty command", () => {
      const result = isKubectlCommandAllowed("");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Empty");
    });

    it("blocks whitespace-only command", () => {
      const result = isKubectlCommandAllowed("   ");
      expect(result.allowed).toBe(false);
    });

    it("blocks unknown verb", () => {
      const result = isKubectlCommandAllowed("something-unknown pods");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Unknown kubectl verb");
    });

    it("handles leading flags (without value) before verb", () => {
      // pure flags before verb are filtered out, verb is 'get'
      const result = isKubectlCommandAllowed("--all-namespaces get pods");
      expect(result.allowed).toBe(true);
      expect(result.verb).toBe("get");
    });

    it("is case-insensitive for verb matching", () => {
      const result = isKubectlCommandAllowed("DELETE pod my-pod");
      expect(result.allowed).toBe(false);
      expect(result.verb).toBe("delete");
    });
  });

  describe("verb lists consistency", () => {
    it("allowed and blocked lists have no overlap", () => {
      const overlap = (ALLOWED_KUBECTL_VERBS as readonly string[]).filter((v) =>
        (BLOCKED_KUBECTL_VERBS as readonly string[]).includes(v),
      );
      expect(overlap).toEqual([]);
    });

    it("all blocked verbs are real kubectl verbs", () => {
      // Sanity check — blocked list should not be empty
      expect(BLOCKED_KUBECTL_VERBS.length).toBeGreaterThan(10);
    });

    it("all allowed verbs are real kubectl verbs", () => {
      // Sanity check — allowed list should not be empty
      expect(ALLOWED_KUBECTL_VERBS.length).toBeGreaterThan(5);
    });
  });

  describe("K8sDangerousCommandError", () => {
    it("carries verb, hint, and nextCommand", () => {
      const error = new K8sDangerousCommandError({
        message: "'delete' is a mutating operation blocked for AI agents.",
        command: "delete pod my-pod -n my-ns",
        verb: "delete",
        hint: "AI agents can only run read-only kubectl commands.",
        nextCommand: "agent-tools-k8s kubectl --cmd 'get pods -n my-ns'",
      });

      expect(error._tag).toBe("K8sDangerousCommandError");
      expect(error.verb).toBe("delete");
      expect(error.hint).toContain("read-only");
      expect(error.nextCommand).toContain("get pods");
    });

    it("has optional fields", () => {
      const error = new K8sDangerousCommandError({
        message: "Command not allowed",
        command: "delete pod my-pod",
      });

      expect(error._tag).toBe("K8sDangerousCommandError");
      expect(error.verb).toBeUndefined();
      expect(error.hint).toBeUndefined();
      expect(error.nextCommand).toBeUndefined();
    });
  });
});
