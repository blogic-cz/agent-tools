import { posix } from "node:path";

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
import { collectProcessOutput, quoteShellArg } from "#shared/exec";
import { describeMissingBinary, missingBinaryFromSpawnFailure } from "#shared/binary-preflight";
import { resolveEnvTemplate } from "#shared/env-template";
import { isPrerequisiteRunError } from "#shared/prerequisites/errors";
import { normalizeProfilePrerequisites } from "#shared/prerequisites/config";
import { runWithProfilePrerequisites } from "#shared/prerequisites/runtime";
import { buildApiProbeArgs } from "#shared/k8s-probe";
import { isKubectlCommandAllowed, isSafeLogPath } from "./security";

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
    readonly runLogTail: (
      pod: string,
      basePath: string,
      path: string,
      lines: number,
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

        const resolveKubeconfig = Effect.fn("K8sService.resolveKubeconfig")(function* (
          k8sConfig: K8sConfig,
        ) {
          const kubeconfig = k8sConfig.kubeconfig;
          if (!kubeconfig) {
            return undefined;
          }

          return yield* resolveEnvTemplate(kubeconfig).pipe(
            Effect.mapError(
              ({ envVar }) =>
                new K8sContextError({
                  message: `Environment variable ${envVar} (required for kubeconfig) is not set.`,
                  clusterId: k8sConfig.clusterId,
                }),
            ),
          );
        });

        const withKubeconfig = (command: string, kubeconfig: string | undefined) =>
          kubeconfig ? `KUBECONFIG=${quoteShellArg(kubeconfig)} ${command}` : command;
        const renderArg = (arg: string) =>
          /^[A-Za-z0-9_./:=,@+-]+$/.test(arg) ? arg : quoteShellArg(arg);
        const renderKubectlCommand = (context: string, argv: readonly string[]) =>
          ["kubectl", "--context", context, ...argv].map(renderArg).join(" ");

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
                  stderr: String(platformError),
                  ...(missingBinaryFromSpawnFailure("kubectl", String(platformError))
                    ? { hint: describeMissingBinary("kubectl").hint }
                    : {}),
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

        /**
         * Cheap pre-flight: is the cluster API reachable right now? Returns true when the probe
         * is disabled (apiProbeTimeoutMs <= 0) so behaviour is unchanged unless a probe can run.
         * A false result lets the command fail fast instead of hanging until the full timeoutMs.
         */
        const probeApiReachable = (
          context: string,
          kubeconfig: string | undefined,
          timeoutMs: number,
        ) =>
          Effect.gen(function* () {
            if (timeoutMs <= 0) {
              return true;
            }

            const probe = ChildProcess.make(
              "kubectl",
              buildApiProbeArgs(kubeconfig, context, timeoutMs),
              {
                stdout: "pipe",
                stderr: "pipe",
              },
            );

            const result = yield* Effect.scoped(
              Effect.gen(function* () {
                const process = yield* executor.spawn(probe);
                return yield* collectProcessOutput(process);
              }),
            ).pipe(Effect.catch(() => Effect.succeed({ stdout: "", stderr: "", exitCode: 1 })));

            return result.exitCode === 0;
          });

        const resolveContext = Effect.fn("K8sService.resolveContext")(function* (
          profile: string | undefined,
          k8sConfig: K8sConfig,
        ) {
          const timeoutMs = k8sConfig.timeoutMs ?? 60000;
          const kubeconfig = yield* resolveKubeconfig(k8sConfig);
          const cacheKey = profile ?? `cluster:${k8sConfig.clusterId}:${kubeconfig ?? "default"}`;
          const cached = yield* Ref.get(contextRef);
          const cachedContext = cached[cacheKey];
          if (cachedContext !== undefined) {
            return { context: cachedContext, kubeconfig };
          }

          const jqCommand = withKubeconfig(
            `kubectl config view -o json | jq -r '.contexts[] | select(.context.cluster == "${k8sConfig.clusterId}") | .name' | head -1`,
            kubeconfig,
          );

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
            return { context: resolvedContextValue, kubeconfig };
          }

          const fallbackCommand = withKubeconfig(
            `kubectl config view -o json | jq -r '.contexts[] as $ctx | .clusters[] | select(.name == $ctx.context.cluster and (.cluster.server | contains("${k8sConfig.clusterId}"))) | $ctx.name' | head -1`,
            kubeconfig,
          );

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
            return { context: resolvedContextValue, kubeconfig };
          }

          return yield* new K8sContextError({
            message: `No kubectl context found for cluster ID: ${k8sConfig.clusterId}. Make sure you have the cluster configured in kubectl.`,
            clusterId: k8sConfig.clusterId,
          });
        });

        const executeCommand = Effect.fn("K8sService.executeCommand")(function* (
          argv: readonly string[],
          profile?: string,
        ) {
          const k8sConfig = yield* requireK8sConfig(profile);
          const timeoutMs = k8sConfig.timeoutMs ?? 60000;
          const apiProbeTimeoutMs = k8sConfig.apiProbeTimeoutMs ?? 2000;

          const { context, kubeconfig } = yield* resolveContext(profile, k8sConfig);
          const reachableWithoutPrerequisites = yield* probeApiReachable(
            context,
            kubeconfig,
            apiProbeTimeoutMs,
          );
          const vpnGated = normalizeProfilePrerequisites(k8sConfig).some(
            (prerequisite) => prerequisite.type === "vpn",
          );
          return yield* runWithProfilePrerequisites(
            config ?? {},
            k8sConfig,
            runPrerequisiteCommand,
            Effect.gen(function* () {
              const reachable =
                reachableWithoutPrerequisites ||
                (vpnGated && (yield* probeApiReachable(context, kubeconfig, apiProbeTimeoutMs)));
              if (!reachable) {
                return yield* new K8sContextError({
                  message: `Kubernetes API server (${k8sConfig.clusterId}) not reachable within ${apiProbeTimeoutMs}ms. VPN likely not connected, or the cluster API is degraded.`,
                  clusterId: k8sConfig.clusterId,
                  hint: "Check the VPN connection and cluster health, then retry. Set kubernetes.apiProbeTimeoutMs to 0 in agent-tools.json5 to disable this pre-flight probe.",
                });
              }

              const fullCommand = renderKubectlCommand(context, argv);
              const command = ChildProcess.make("kubectl", ["--context", context, ...argv], {
                stdout: "pipe",
                stderr: "pipe",
                ...(kubeconfig ? { env: { KUBECONFIG: kubeconfig }, extendEnv: true } : {}),
              });
              const resultOption = yield* Effect.scoped(
                Effect.gen(function* () {
                  const process = yield* executor.spawn(command);
                  return yield* collectProcessOutput(process);
                }),
              ).pipe(
                Effect.timeoutOption(timeoutMs),
                Effect.mapError(
                  (platformError) =>
                    new K8sCommandError({
                      message: `Command execution failed: ${String(platformError)}`,
                      command: fullCommand,
                      exitCode: -1,
                      stderr: String(platformError),
                      ...(missingBinaryFromSpawnFailure("kubectl", String(platformError))
                        ? { hint: describeMissingBinary("kubectl").hint }
                        : {}),
                    }),
                ),
              );

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
            { alreadySatisfied: apiProbeTimeoutMs > 0 && reachableWithoutPrerequisites },
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
          if (!securityCheck.allowed || !securityCheck.argv) {
            return yield* new K8sDangerousCommandError({
              message: securityCheck.reason ?? "Command not allowed",
              command: cmd,
              ...(securityCheck.verb ? { verb: securityCheck.verb } : {}),
              hint:
                securityCheck.hint ??
                "AI agents can only run read-only kubectl commands. For mutating operations, use kubectl directly or ask a human operator.",
            });
          }

          const result = yield* executeCommand(securityCheck.argv, profile);
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
          if (!securityCheck.allowed || !securityCheck.argv) {
            return yield* new K8sDangerousCommandError({
              message: securityCheck.reason ?? "Command not allowed",
              command: cmd,
              ...(securityCheck.verb ? { verb: securityCheck.verb } : {}),
              hint:
                securityCheck.hint ??
                "AI agents can only run read-only kubectl commands. For mutating operations, use kubectl directly or ask a human operator.",
            });
          }

          const startTime = Date.now();
          if (dryRun) {
            const k8sConfig = yield* requireK8sConfig(profile);
            const { context } = yield* resolveContext(profile, k8sConfig);
            const fullCommand = renderKubectlCommand(context, securityCheck.argv);
            return {
              success: true,
              command: fullCommand,
              output: "(dry run - command not executed)",
              executionTimeMs: Date.now() - startTime,
            };
          }

          const result = yield* executeCommand(securityCheck.argv, profile);

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

        const runLogTail = Effect.fn("K8sService.runLogTail")(function* (
          pod: string,
          basePath: string,
          path: string,
          lines: number,
          profile?: string,
        ) {
          const normalizedBase = posix.resolve(basePath);
          const normalizedPath = posix.resolve(path);
          const lexicalRelative = posix.relative(normalizedBase, normalizedPath);
          if (
            !/^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/.test(pod) ||
            !Number.isInteger(lines) ||
            lines < 1 ||
            lexicalRelative === ".." ||
            lexicalRelative.startsWith("../") ||
            posix.isAbsolute(lexicalRelative) ||
            !isSafeLogPath(normalizedPath)
          ) {
            return yield* new K8sDangerousCommandError({
              message: "Invalid internal log-tail request.",
              command: "exec tail",
              verb: "exec",
              hint: "Use logs-tool with a log file inside its configured remote directory.",
            });
          }

          const realpathArgv = ["exec", pod, "--", "realpath", normalizedBase, normalizedPath];
          const realpathResult = yield* executeCommand(realpathArgv, profile);
          if (realpathResult.exitCode !== 0) {
            return yield* new K8sCommandError({
              message:
                realpathResult.stderr ||
                `Remote realpath exited with code ${realpathResult.exitCode}`,
              command: realpathResult.command,
              exitCode: realpathResult.exitCode,
              ...(realpathResult.stderr ? { stderr: realpathResult.stderr } : {}),
            });
          }
          const [canonicalBase, canonicalPath] = realpathResult.stdout.trim().split("\n");
          const canonicalRelative =
            canonicalBase === undefined || canonicalPath === undefined
              ? ".."
              : posix.relative(canonicalBase, canonicalPath);
          if (
            canonicalBase === undefined ||
            canonicalPath === undefined ||
            canonicalRelative === ".." ||
            canonicalRelative.startsWith("../") ||
            posix.isAbsolute(canonicalRelative) ||
            !isSafeLogPath(canonicalPath)
          ) {
            return yield* new K8sDangerousCommandError({
              message: "Canonical log path escapes the configured remote directory.",
              command: realpathResult.command,
              verb: "exec",
              hint: "Remove symlinks that point outside the configured remote log directory.",
            });
          }

          const argv = ["exec", pod, "--", "tail", "-n", String(lines), canonicalPath];
          const startTime = Date.now();
          const result = yield* executeCommand(argv, profile);
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

        return { runCommand, runKubectl, runLogTail };
      }),
    ),
  );
}

export const K8sServiceLayer = K8sService.layer;

export { K8sCommandError } from "./errors";
