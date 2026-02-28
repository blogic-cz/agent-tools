#!/usr/bin/env bun
import { Command, Options } from "@effect/cli";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import { Console, Effect, Layer, Option } from "effect";

import type { CommandResult } from "./types";

import { formatOption, formatOutput, renderCauseToStderr, VERSION } from "../shared";
import { K8sService, K8sServiceLayer } from "./service";
import { ConfigService, ConfigServiceLayer, getToolConfig } from "../config";
import type { K8sConfig } from "../config";

const kubectlCommand = Command.make(
  "kubectl",
  {
    env: Options.choice("env", ["test", "prod"]).pipe(
      Options.withDescription("Target environment: test or prod"),
    ),
    cmd: Options.text("cmd").pipe(
      Options.withDescription('kubectl command (without "kubectl" prefix)'),
    ),
    dryRun: Options.boolean("dry-run").pipe(
      Options.withAlias("d"),
      Options.withDescription("Show command without executing"),
      Options.withDefault(false),
    ),
    format: formatOption,
    profile: Options.optional(Options.text("profile")).pipe(
      Options.withDescription("Kubernetes profile name (if multiple configured)"),
    ),
  },
  ({ cmd, dryRun, format, profile }) =>
    Effect.gen(function* () {
      const config = yield* ConfigService;
      const profileName = profile ? Option.getOrUndefined(profile) : undefined;
      const k8sConfig = getToolConfig<K8sConfig>(config, "kubernetes", profileName);

      if (!k8sConfig) {
        const result: CommandResult = {
          success: false,
          error: "No Kubernetes configuration found",
          executionTimeMs: 0,
        };
        yield* Console.log(formatOutput(result, format));
        return;
      }

      const k8sService = yield* K8sService;
      const result = yield* k8sService.runKubectl(cmd, dryRun).pipe(
        Effect.catchTags({
          K8sContextError: (error) => {
            const result: CommandResult = {
              success: false,
              error: error.message,
              executionTimeMs: 0,
            };
            return Effect.succeed(result);
          },
          K8sCommandError: (error) => {
            const result: CommandResult = {
              success: false,
              error: error.message,
              command: error.command,
              executionTimeMs: 0,
            };
            return Effect.succeed(result);
          },
          K8sTimeoutError: (error) => {
            const result: CommandResult = {
              success: false,
              error: error.message,
              command: error.command,
              executionTimeMs: error.timeoutMs,
            };
            return Effect.succeed(result);
          },
        }),
      );

      yield* Console.log(formatOutput(result, format));
    }),
).pipe(
  Command.withDescription(
    `Kubernetes CLI Tool for Coding Agents

Executes kubectl commands against the correct cluster context.
Supports shell pipes and complex commands.

IMPORTANT FOR AI AGENTS:
Always use this tool instead of kubectl directly to ensure
commands run against the correct cluster context.
Use --format toon for LLM-optimized output (fewer tokens).

CLUSTER CONFIGURATION:
  Cluster ID: (from agent-tools.json5 kubernetes profile)
  Namespaces: (from agent-tools.json5 kubernetes profile)
  (Context name is resolved dynamically from cluster ID)

WORKFLOW FOR AI AGENTS:
  1. Use this tool for ALL kubectl operations on test/prod
  2. Pipes are supported - use shell syntax
  3. Use -n <namespace> for target namespace

EXAMPLES:
  # List pods in test namespace
  bun run src/k8s-tool kubectl --env test --cmd "get pods -n my-app-test"

  # Get pod logs with grep
  bun run src/k8s-tool kubectl --env test --cmd "logs -l app=web-app -n my-app-test --tail=100 | grep error"

  # Check resource usage
  bun run src/k8s-tool kubectl --env test --cmd "top pod -n my-app-test"

  # Describe pod with filtered output
  bun run src/k8s-tool kubectl --env test --cmd "describe pod web-app-xxx -n my-app-test | grep -A20 Events"

  # Execute command in pod
  bun run src/k8s-tool kubectl --env test --cmd "exec web-app-xxx -n my-app-test -- cat /app/logs/app.log | tail -50"

  # Dry run - show command without executing
  bun run src/k8s-tool kubectl --env test --cmd "get pods -n my-app-test" --dry-run

OUTPUT:
  TOON: Token-efficient format for LLM agents - DEFAULT
  JSON: { success, output?, error?, command?, executionTimeMs }

RELATED TOOLS:
  - logs-tool: Higher-level tool for reading application logs
  - db-tool: Database queries and schema introspection`,
  ),
);

const mainCommand = Command.make("k8s-tool", {}).pipe(
  Command.withDescription("Kubernetes CLI Tool for Coding Agents"),
  Command.withSubcommands([kubectlCommand]),
);

const cli = Command.run(mainCommand, {
  name: "K8s Tool",
  version: VERSION,
});

const MainLayer = K8sServiceLayer.pipe(
  Layer.provideMerge(ConfigServiceLayer),
  Layer.provideMerge(BunContext.layer),
);

const program = cli(process.argv).pipe(
  Effect.provide(MainLayer),
  Effect.tapErrorCause(renderCauseToStderr),
);

BunRuntime.runMain(program, {
  disableErrorReporting: true,
});
