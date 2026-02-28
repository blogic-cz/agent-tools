import { describe, expect, it } from "@effect/vitest";
import { Effect, Either, Layer, Match } from "effect";

import type { CommandResult, Environment } from "../src/k8s-tool/types";

import { K8sCommandError, K8sContextError, K8sTimeoutError } from "../src/k8s-tool/errors";
import { K8sService } from "../src/k8s-tool/service";

type K8sError = K8sCommandError | K8sContextError | K8sTimeoutError;

function createMockK8sServiceLayer(
  mockResponses: Record<string, CommandResult | string | K8sError>,
) {
  return Layer.succeed(K8sService, {
    runCommand: (cmd: string, _env: Environment) => {
      const response = mockResponses[`cmd:${cmd}`];

      if (
        response instanceof K8sCommandError ||
        response instanceof K8sContextError ||
        response instanceof K8sTimeoutError
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
        response instanceof K8sTimeoutError
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
        const result = yield* service.runKubectl("get pods", false).pipe(Effect.either);

        Either.match(result, {
          onLeft: (left) => {
            expect(left._tag).toBe("K8sContextError");
            expect(left.message).toContain("No kubectl context found");
          },
          onRight: () => {
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
        const result = yield* service.runKubectl("get pod invalid-pod", false).pipe(Effect.either);

        Either.match(result, {
          onLeft: (left) => {
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
          onRight: () => {
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
        const result = yield* service.runKubectl("logs -f pod-name", false).pipe(Effect.either);

        Either.match(result, {
          onLeft: (left) => {
            Match.value(left).pipe(
              Match.tag("K8sTimeoutError", (err) => {
                expect(err.timeoutMs).toBe(30000);
              }),
              Match.orElse(() => {
                throw new Error("Expected K8sTimeoutError");
              }),
            );
          },
          onRight: () => {
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
          .pipe(Effect.either);

        Either.match(result, {
          onLeft: (left) => {
            Match.value(left).pipe(
              Match.tag("K8sCommandError", (err) => {
                expect(err.command).toBe("kubectl get pods -n my-app-test");
              }),
              Match.orElse(() => {
                throw new Error("Expected K8sCommandError");
              }),
            );
          },
          onRight: () => {
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
        const result = yield* service.runCommand("invalid-kubectl-cmd", "test").pipe(Effect.either);

        Either.match(result, {
          onLeft: () => {},
          onRight: () => {
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
        const result = yield* service.runKubectl("get pods", false).pipe(Effect.either);

        Either.match(result, {
          onLeft: () => {},
          onRight: () => {
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
});
