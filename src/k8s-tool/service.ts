import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Context, Effect, Layer, Option, Ref, Stream } from "effect";

import type { CommandResult, Environment } from "./types";

import {
  K8sCommandError,
  K8sContextError,
  K8sDangerousCommandError,
  K8sTimeoutError,
} from "./errors";
import { ConfigService, getToolConfig } from "#config";
import type { K8sConfig } from "#config";
import { collectProcessOutput } from "#shared/exec";
import { isPrerequisiteRunError } from "#shared/prerequisites/errors";
import { runWithProfilePrerequisites } from "#shared/prerequisites/runtime";
import { isKubectlCommandAllowed } from "./security";

export class K8sService extends Context.Service<
  K8sService,
  {
    readonly runCommand: (
      cmd: string,
      env: Environment,
      profile?: string,
    ) => Effect.Effect<
      string,
      K8sContextError | K8sCommandError | K8sTimeoutError | K8sDangerousCommandError
    >;
    readonly runKubectl: (
      cmd: string,
      dryRun: boolean,
      profile?: string,
    ) => Effect.Effect<
      CommandResult,
      K8sContextError | K8sCommandError | K8sTimeoutError | K8sDangerousCommandError
    >;
  }
>()("@agent-tools/K8sService") {
  static readonly layer = Layer.effect(
    K8sService,
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* ChildProcessSpawner.ChildProcessSpawner;

        const config = yield* ConfigService;

        const getK8sConfig = (profile?: string) =>
          getToolConfig<K8sConfig>(config, "kubernetes", profile);

        const requireK8sConfig = (profile?: string) =>
          Effect.gen(function* () {
            const k8sConfig = getK8sConfig(profile);
            if (!k8sConfig) {
              return yield* new K8sContextError({
                message: profile
                  ? `No Kubernetes configuration found for profile: ${profile}.`
                  : "No Kubernetes configuration found. Add a 'kubernetes' section to agent-tools.json5.",
                clusterId: profile ?? "unknown",
              });
            }

            return k8sConfig;
          });

        // Cache context by selected profile/cluster instead of a single default profile.
        const contextRef = yield* Ref.make<Record<string, string>>({});

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

        const runPrerequisiteCommand = (command: ChildProcess.Command, label: string) =>
          Effect.scoped(
            Effect.gen(function* () {
              const process = yield* executor.spawn(command);
              return yield* collectProcessOutput(process);
            }),
          ).pipe(
            Effect.mapError(
              (platformError) =>
                new K8sCommandError({
                  message: `Prerequisite command failed (${label}): ${String(platformError)}`,
                  command: label,
                  exitCode: -1,
                  stderr: String(platformError),
                }),
            ),
          );

        const resolveContext = Effect.fn("K8sService.resolveContext")(function* (
          profile: string | undefined,
          k8sConfig: K8sConfig,
        ) {
          const timeoutMs = k8sConfig.timeoutMs ?? 60000;
          const cacheKey = profile ?? `cluster:${k8sConfig.clusterId}`;
          const cached = yield* Ref.get(contextRef);
          const cachedContext = cached[cacheKey];
          if (cachedContext !== undefined) {
            return cachedContext;
          }

          const jqCommand = `kubectl config view -o json | jq -r '.contexts[] | select(.context.cluster == "${k8sConfig.clusterId}") | .name' | head -1`;

          const contextResultOption = yield* runShellCommand(jqCommand, timeoutMs);

          if (Option.isNone(contextResultOption)) {
            return yield* new K8sTimeoutError({
              message: `Context resolution timed out after ${timeoutMs}ms`,
              command: jqCommand,
              timeoutMs,
            });
          }

          const contextResult = contextResultOption.value;

          if (contextResult.exitCode === 0 && contextResult.stdout.trim()) {
            const resolvedContextValue = contextResult.stdout.trim();
            yield* Ref.update(contextRef, (contexts) => ({
              ...contexts,
              [cacheKey]: resolvedContextValue,
            }));
            return resolvedContextValue;
          }

          const fallbackCommand = `kubectl config view -o json | jq -r '.contexts[] as $ctx | .clusters[] | select(.name == $ctx.context.cluster and (.cluster.server | contains("${k8sConfig.clusterId}"))) | $ctx.name' | head -1`;

          const fallbackResultOption = yield* runShellCommand(fallbackCommand, timeoutMs);

          if (Option.isNone(fallbackResultOption)) {
            return yield* new K8sTimeoutError({
              message: `Context resolution timed out after ${timeoutMs}ms`,
              command: fallbackCommand,
              timeoutMs,
            });
          }

          const fallbackResult = fallbackResultOption.value;

          if (fallbackResult.exitCode === 0 && fallbackResult.stdout.trim()) {
            const resolvedContextValue = fallbackResult.stdout.trim();
            yield* Ref.update(contextRef, (contexts) => ({
              ...contexts,
              [cacheKey]: resolvedContextValue,
            }));
            return resolvedContextValue;
          }

          return yield* new K8sContextError({
            message: `No kubectl context found for cluster ID: ${k8sConfig.clusterId}. Make sure you have the cluster configured in kubectl.`,
            clusterId: k8sConfig.clusterId,
          });
        });

        const executeCommand = Effect.fn("K8sService.executeCommand")(function* (
          cmd: string,
          profile?: string,
        ) {
          const k8sConfig = yield* requireK8sConfig(profile);
          const timeoutMs = k8sConfig.timeoutMs ?? 60000;
          return yield* runWithProfilePrerequisites(
            config ?? {},
            k8sConfig,
            runPrerequisiteCommand,
            Effect.gen(function* () {
              const context = yield* resolveContext(profile, k8sConfig);
              const fullCommand = `kubectl --context ${context} ${cmd}`;

              const resultOption = yield* runShellCommand(fullCommand, timeoutMs);

              if (Option.isNone(resultOption)) {
                return yield* new K8sTimeoutError({
                  message: `Command timed out after ${timeoutMs}ms`,
                  command: fullCommand,
                  timeoutMs,
                });
              }

              const result = resultOption.value;

              return {
                stdout: result.stdout,
                stderr: result.stderr,
                exitCode: result.exitCode,
                command: fullCommand,
              };
            }),
            { tryWithoutPrerequisites: true },
          ).pipe(
            Effect.mapError((error) =>
              isPrerequisiteRunError(error)
                ? new K8sContextError({
                    message: error.message,
                    clusterId: k8sConfig.clusterId,
                    hint: error.hint,
                  })
                : error,
            ),
          );
        });

        const runCommand = Effect.fn("K8sService.runCommand")(function* (
          cmd: string,
          _env: Environment,
          profile?: string,
        ) {
          // Security: block dangerous commands before execution
          const securityCheck = isKubectlCommandAllowed(cmd);
          if (!securityCheck.allowed) {
            return yield* new K8sDangerousCommandError({
              message: securityCheck.reason ?? "Command not allowed",
              command: cmd,
              verb: securityCheck.verb,
              hint: "AI agents can only run read-only kubectl commands. For mutating operations, use kubectl directly or ask a human operator.",
            });
          }

          const result = yield* executeCommand(cmd, profile);
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
          profile?: string,
        ) {
          // Security: block dangerous commands before execution (even dry-run)
          const securityCheck = isKubectlCommandAllowed(cmd);
          if (!securityCheck.allowed) {
            return yield* new K8sDangerousCommandError({
              message: securityCheck.reason ?? "Command not allowed",
              command: cmd,
              verb: securityCheck.verb,
              hint: "AI agents can only run read-only kubectl commands. For mutating operations, use kubectl directly or ask a human operator.",
            });
          }

          const startTime = Date.now();
          if (dryRun) {
            const k8sConfig = yield* requireK8sConfig(profile);
            const context = yield* resolveContext(profile, k8sConfig);
            const fullCommand = `kubectl --context ${context} ${cmd}`;
            return {
              success: true,
              command: fullCommand,
              output: "(dry run - command not executed)",
              executionTimeMs: Date.now() - startTime,
            };
          }

          const result = yield* executeCommand(cmd, profile);

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
