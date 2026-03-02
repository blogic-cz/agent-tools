import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Effect, Layer, Option, Ref, ServiceMap, Stream } from "effect";

import type { CommandResult, Environment } from "./types";

import { K8sCommandError, K8sContextError, K8sTimeoutError } from "./errors";
import { ConfigService, getToolConfig } from "#config";
import type { K8sConfig } from "#config";

export class K8sService extends ServiceMap.Service<
  K8sService,
  {
    readonly runCommand: (
      cmd: string,
      env: Environment,
    ) => Effect.Effect<string, K8sContextError | K8sCommandError | K8sTimeoutError>;
    readonly runKubectl: (
      cmd: string,
      dryRun: boolean,
    ) => Effect.Effect<CommandResult, K8sContextError | K8sCommandError | K8sTimeoutError>;
  }
>()("@agent-tools/K8sService") {
  static readonly layer = Layer.effect(
    K8sService,
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* ChildProcessSpawner.ChildProcessSpawner;

        const config = yield* ConfigService;
        const k8sConfig = getToolConfig<K8sConfig>(config, "kubernetes");

        if (!k8sConfig) {
          const noConfigError = new K8sContextError({
            message:
              "No Kubernetes configuration found. Add a 'kubernetes' section to agent-tools.json5.",
            clusterId: "unknown",
          });
          return {
            runCommand: (_cmd: string, _env: Environment) => Effect.fail(noConfigError),
            runKubectl: (_cmd: string, _dryRun: boolean) => Effect.fail(noConfigError),
          };
        }

        const KUBECTL_TIMEOUT_MS = k8sConfig.timeoutMs ?? 60000;

        // Create Ref for context caching (replaces module-level let)
        const contextRef = yield* Ref.make<string | null>(null);

        // Helper that uses executor.spawn() to avoid ChildProcessSpawner requirement in return type
        const runShellCommand = (commandStr: string, timeoutMs: number) =>
          Effect.scoped(
            Effect.gen(function* () {
              const command = ChildProcess.make("sh", ["-c", commandStr], {
                stdout: "pipe",
                stderr: "pipe",
              });
              const process = yield* executor.spawn(command);

              const stdoutChunk = yield* process.stdout.pipe(
                Stream.decodeText(),
                Stream.runCollect,
              );
              const stdout = stdoutChunk.join("");

              const stderrChunk = yield* process.stderr.pipe(
                Stream.decodeText(),
                Stream.runCollect,
              );
              const stderr = stderrChunk.join("");

              const exitCode = yield* process.exitCode;

              return { stdout, stderr, exitCode };
            }),
          ).pipe(
            Effect.timeoutOption(timeoutMs),
            Effect.mapError(
              (platformError) =>
                new K8sCommandError({
                  message: `Command execution failed: ${String(platformError)}`,
                  command: commandStr,
                  exitCode: -1,
                  stderr: undefined,
                }),
            ),
          );

        const resolveContext = Effect.fn("K8sService.resolveContext")(function* () {
          // Check cache first
          const cached = yield* Ref.get(contextRef);
          if (cached !== null) {
            return cached;
          }

          const jqCommand = `kubectl config view -o json | jq -r '.contexts[] | select(.context.cluster == "${k8sConfig.clusterId}") | .name' | head -1`;

          const contextResultOption = yield* runShellCommand(jqCommand, KUBECTL_TIMEOUT_MS);

          if (Option.isNone(contextResultOption)) {
            return yield* new K8sTimeoutError({
              message: `Context resolution timed out after ${KUBECTL_TIMEOUT_MS}ms`,
              command: jqCommand,
              timeoutMs: KUBECTL_TIMEOUT_MS,
            });
          }

          const contextResult = contextResultOption.value;

          if (contextResult.exitCode === 0 && contextResult.stdout.trim()) {
            const resolvedContextValue = contextResult.stdout.trim();
            yield* Ref.set(contextRef, resolvedContextValue);
            return resolvedContextValue;
          }

          const fallbackCommand = `kubectl config view -o json | jq -r '.contexts[] as $ctx | .clusters[] | select(.name == $ctx.context.cluster and (.cluster.server | contains("${k8sConfig.clusterId}"))) | $ctx.name' | head -1`;

          const fallbackResultOption = yield* runShellCommand(fallbackCommand, KUBECTL_TIMEOUT_MS);

          if (Option.isNone(fallbackResultOption)) {
            return yield* new K8sTimeoutError({
              message: `Context resolution timed out after ${KUBECTL_TIMEOUT_MS}ms`,
              command: fallbackCommand,
              timeoutMs: KUBECTL_TIMEOUT_MS,
            });
          }

          const fallbackResult = fallbackResultOption.value;

          if (fallbackResult.exitCode === 0 && fallbackResult.stdout.trim()) {
            const resolvedContextValue = fallbackResult.stdout.trim();
            yield* Ref.set(contextRef, resolvedContextValue);
            return resolvedContextValue;
          }

          return yield* new K8sContextError({
            message: `No kubectl context found for cluster ID: ${k8sConfig.clusterId}. Make sure you have the cluster configured in kubectl.`,
            clusterId: k8sConfig.clusterId,
          });
        });

        const executeCommand = Effect.fn("K8sService.executeCommand")(function* (cmd: string) {
          const context = yield* resolveContext();
          const fullCommand = `kubectl --context ${context} ${cmd}`;

          const resultOption = yield* runShellCommand(fullCommand, KUBECTL_TIMEOUT_MS);

          if (Option.isNone(resultOption)) {
            return yield* new K8sTimeoutError({
              message: `Command timed out after ${KUBECTL_TIMEOUT_MS}ms`,
              command: fullCommand,
              timeoutMs: KUBECTL_TIMEOUT_MS,
            });
          }

          const result = resultOption.value;

          return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            command: fullCommand,
          };
        });

        const runCommand = Effect.fn("K8sService.runCommand")(function* (
          cmd: string,
          _env: Environment,
        ) {
          const result = yield* executeCommand(cmd);

          if (result.exitCode !== 0) {
            return yield* new K8sCommandError({
              message: result.stderr ?? `kubectl exited with code ${result.exitCode}`,
              command: result.command,
              exitCode: result.exitCode,
              stderr: result.stderr ?? undefined,
            });
          }

          return result.stdout.trim();
        });

        const runKubectl = Effect.fn("K8sService.runKubectl")(function* (
          cmd: string,
          dryRun: boolean,
        ) {
          const startTime = Date.now();

          if (dryRun) {
            const context = yield* resolveContext();
            const fullCommand = `kubectl --context ${context} ${cmd}`;
            return {
              success: true,
              command: fullCommand,
              output: "(dry run - command not executed)",
              executionTimeMs: Date.now() - startTime,
            };
          }

          const result = yield* executeCommand(cmd);

          if (result.exitCode !== 0) {
            return yield* new K8sCommandError({
              message: result.stderr ?? `kubectl exited with code ${result.exitCode}`,
              command: result.command,
              exitCode: result.exitCode,
              stderr: result.stderr ?? undefined,
            });
          }

          return {
            success: true,
            output: result.stdout.trim(),
            command: result.command,
            executionTimeMs: Date.now() - startTime,
          };
        });

        return { runCommand, runKubectl };
      }),
    ),
  );
}

export const K8sServiceLayer = K8sService.layer;

export { K8sCommandError } from "./errors";
