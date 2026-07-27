#!/usr/bin/env bun
import { Command, Flag } from "effect/unstable/cli";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Layer, Option } from "effect";

import type { CommandResult } from "./types";

import {
  makeSchemaCommand,
  formatOption,
  formatOutput,
  renderCauseToStderr,
  VERSION,
} from "#shared";
import { AuditServiceLayer, withAudit } from "#shared/audit";
import { K8sService, K8sServiceLayer } from "./service";
import { ConfigService, ConfigServiceLayer, getDefaultEnvironment, getToolConfig } from "#config";
import type { K8sConfig } from "#config";
import { K8sContextError } from "./errors";
import {
  transformDescribe,
  transformGenericKubectl,
  transformLogs,
  transformPods,
  transformTop,
} from "./transformers";

/**
 * Resolve environment from explicit --env flag, config defaultEnvironment, or fail with hint.
 * Rejects implicit prod: if defaultEnvironment is "prod" and --env was not passed, fail explicitly.
 */
const resolveEnv = (
  envOption: Option.Option<string>,
  config: Parameters<typeof getDefaultEnvironment>[0],
) =>
  Effect.gen(function* () {
    const explicit = Option.getOrUndefined(envOption);
    if (explicit) return explicit;

    const defaultEnv = getDefaultEnvironment(config);

    if (defaultEnv === "prod") {
      return yield* new K8sContextError({
        message:
          "Implicit prod access blocked. Config defaultEnvironment is 'prod' but --env was not passed explicitly.",
        clusterId: "(prod-safety)",
        hint: "Pass --env prod explicitly to confirm production access, or change defaultEnvironment to a non-prod value.",
        nextCommand: 'agent-tools-k8s kubectl --env prod --cmd "get pods -n <namespace>"',
      });
    }

    if (defaultEnv) return defaultEnv;

    return yield* new K8sContextError({
      message:
        "No environment specified. Use --env <name> or set defaultEnvironment in agent-tools.json5.",
      clusterId: "(not specified)",
      hint: 'Set defaultEnvironment in agent-tools.json5 (e.g. defaultEnvironment: "test") or pass --env explicitly.',
      nextCommand: 'agent-tools-k8s kubectl --env test --cmd "get pods -n <namespace>"',
    });
  });

type CommonK8sCommandOptions = {
  readonly env: Option.Option<string>;
  readonly dryRun: boolean;
  readonly format: "toon" | "json";
  readonly profile: Option.Option<string>;
};

const executeK8sCommand = (command: string, options: CommonK8sCommandOptions) =>
  Effect.gen(function* () {
    const config = yield* ConfigService;
    const profileName = Option.getOrUndefined(options.profile);
    const k8sConfig = getToolConfig<K8sConfig>(config, "kubernetes", profileName);

    if (!k8sConfig) {
      const result: CommandResult = {
        success: false,
        error: "No Kubernetes configuration found",
        hint: "Add a 'kubernetes' section to agent-tools.json5 with clusterId and namespaces.",
        nextCommand:
          "echo '{ kubernetes: { default: { clusterId: \"my-cluster\" } } }' > agent-tools.json5",
        executionTimeMs: 0,
      };
      return result;
    }

    const resolvedEnv = yield* resolveEnv(options.env, config);

    const k8sService = yield* K8sService;
    const result = yield* k8sService.runKubectl(command, options.dryRun, profileName).pipe(
      Effect.catchTags({
        K8sContextError: (error) => {
          const errorResult: CommandResult = {
            success: false,
            error: error.message,
            hint: `Verify cluster ID "${k8sConfig.clusterId}" matches a context in kubectl config. Run: kubectl config get-contexts`,
            nextCommand: "kubectl config get-contexts",
            executionTimeMs: 0,
          };
          return Effect.succeed(errorResult);
        },
        K8sCommandError: (error) => {
          const errorResult: CommandResult = {
            success: false,
            error: error.message,
            command: error.command,
            hint:
              error.hint ?? "Check command syntax and ensure the target namespace/resource exists.",
            executionTimeMs: 0,
          };
          return Effect.succeed(errorResult);
        },
        K8sTimeoutError: (error) => {
          const errorResult: CommandResult = {
            success: false,
            error: error.message,
            command: error.command,
            hint:
              error.hint ??
              `Command timed out after ${error.timeoutMs}ms. Consider increasing timeoutMs in config or narrowing the query.`,
            executionTimeMs: error.timeoutMs,
          };
          return Effect.succeed(errorResult);
        },
        K8sDangerousCommandError: (error) => {
          const errorResult: CommandResult = {
            success: false,
            error: error.message,
            command: error.command,
            hint:
              error.hint ??
              "AI agents can only run read-only kubectl commands. For mutating operations, use kubectl directly or ask a human operator.",
            executionTimeMs: 0,
          };
          return Effect.succeed(errorResult);
        },
      }),
    );

    return { ...result, environment: resolvedEnv };
  });

const runK8sCommand = (command: string, options: CommonK8sCommandOptions) =>
  Effect.gen(function* () {
    const result = yield* executeK8sCommand(command, options);
    yield* Console.log(formatOutput(result, options.format));
  });

const logTransformedResult = (
  result: CommandResult,
  format: CommonK8sCommandOptions["format"],
  transform: (output: string) => string | Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const transformedResult =
      typeof result.output === "string" ? { ...result, output: transform(result.output) } : result;
    yield* Console.log(formatOutput(transformedResult, format));
  });

const commonFlags = {
  env: Flag.optional(Flag.string("env")).pipe(
    Flag.withDescription(
      "Target environment (e.g. test, prod). Falls back to defaultEnvironment in config.",
    ),
  ),
  dryRun: Flag.boolean("dry-run").pipe(
    Flag.withAlias("d"),
    Flag.withDescription("Show command without executing"),
    Flag.withDefault(false),
  ),
  format: formatOption,
  profile: Flag.optional(Flag.string("profile")).pipe(
    Flag.withDescription("Kubernetes profile name (if multiple configured)"),
  ),
};

const buildKubectlCommand = (base: string, args: ReadonlyArray<string>) => {
  const extras = args.filter((part) => part.length > 0);
  return extras.length === 0 ? base : `${base} ${extras.join(" ")}`;
};

const resolveStructuredNamespace = (
  namespaceOption: Option.Option<string>,
  envOption: Option.Option<string>,
  profileOption: Option.Option<string>,
) =>
  Effect.gen(function* () {
    const explicitNamespace = Option.getOrUndefined(namespaceOption);
    if (explicitNamespace) return explicitNamespace;

    const config = yield* ConfigService;
    const resolvedEnv = yield* resolveEnv(envOption, config);
    const profileName = Option.getOrUndefined(profileOption);
    const k8sConfig = getToolConfig<K8sConfig>(config, "kubernetes", profileName);

    if (!k8sConfig) return undefined;

    return k8sConfig.namespaces[resolvedEnv];
  });

const kubectlCommand = Command.make(
  "kubectl",
  {
    ...commonFlags,
    cmd: Flag.string("cmd").pipe(
      Flag.withDescription('kubectl command (without "kubectl" prefix)'),
    ),
  },
  ({ cmd, dryRun, env, format, profile }) =>
    Effect.gen(function* () {
      const result = yield* executeK8sCommand(cmd, { dryRun, env, format, profile });
      return yield* logTransformedResult(result, format, (output) =>
        transformGenericKubectl(output, cmd),
      );
    }),
).pipe(
  Command.withDescription(
    `Kubernetes CLI Tool for Coding Agents

Executes kubectl commands against the correct cluster context.
Parses commands into arguments and rejects shell syntax.

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
  2. Do not use pipes, chaining, substitution, or shell interpreters
  3. Use logs-tool for remote log filtering
  4. Use -n <namespace> for target namespace

EXAMPLES:
  # List pods in test namespace
  bun run src/k8s-tool kubectl --env test --cmd "get pods -n my-app-test"

  # Get pod logs (use logs-tool when filtering is required)
  bun run src/k8s-tool kubectl --env test --cmd "logs -l app=web-app -n my-app-test --tail=100"

  # Check resource usage
  bun run src/k8s-tool kubectl --env test --cmd "top pod -n my-app-test"

  # Describe a pod
  bun run src/k8s-tool kubectl --env test --cmd "describe pod web-app-xxx -n my-app-test"

  # Execute an allowlisted diagnostic in a pod
  bun run src/k8s-tool kubectl --env test --cmd "exec web-app-xxx -n my-app-test -- redis-cli INFO commandstats"

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

const podsCommand = Command.make(
  "pods",
  {
    ...commonFlags,
    namespace: Flag.string("namespace").pipe(
      Flag.withDescription("Namespace to query"),
      Flag.optional,
    ),
    label: Flag.string("label").pipe(
      Flag.withDescription("Label selector (key=value)"),
      Flag.optional,
    ),
    wide: Flag.boolean("wide").pipe(
      Flag.withDescription("Show additional pod information"),
      Flag.withDefault(false),
    ),
  },
  ({ dryRun, env, format, label, namespace, profile }) =>
    Effect.gen(function* () {
      const resolvedNamespace = yield* resolveStructuredNamespace(namespace, env, profile);
      const command = buildKubectlCommand("get pods -o json", [
        Option.match(label, {
          onNone: () => "",
          onSome: (value) => `-l ${value}`,
        }),
        resolvedNamespace ? `-n ${resolvedNamespace}` : "",
      ]);
      const result = yield* executeK8sCommand(command, { dryRun, env, format, profile });
      return yield* logTransformedResult(result, format, transformPods);
    }),
).pipe(Command.withDescription("List pods (get pods) with optional namespace/label/wide output"));

const logsCommand = Command.make(
  "logs",
  {
    ...commonFlags,
    pod: Flag.string("pod").pipe(Flag.withDescription("Pod name")),
    namespace: Flag.string("namespace").pipe(
      Flag.withDescription("Namespace containing the pod"),
      Flag.optional,
    ),
    container: Flag.string("container").pipe(
      Flag.withDescription("Container name (for multi-container pods)"),
      Flag.optional,
    ),
    tail: Flag.integer("tail").pipe(Flag.withDescription("Show last N log lines"), Flag.optional),
    follow: Flag.boolean("follow").pipe(
      Flag.withAlias("f"),
      Flag.withDescription("Stream logs in real time"),
      Flag.withDefault(false),
    ),
  },
  ({ container, dryRun, env, follow, format, namespace, pod, profile, tail }) =>
    Effect.gen(function* () {
      const resolvedNamespace = yield* resolveStructuredNamespace(namespace, env, profile);
      const command = buildKubectlCommand(`logs ${pod}`, [
        resolvedNamespace ? `-n ${resolvedNamespace}` : "",
        Option.match(container, {
          onNone: () => "",
          onSome: (value) => `-c ${value}`,
        }),
        Option.match(tail, {
          onNone: () => "",
          onSome: (value) => `--tail=${value}`,
        }),
        follow ? "-f" : "",
      ]);
      const result = yield* executeK8sCommand(command, { dryRun, env, format, profile });
      return yield* logTransformedResult(result, format, transformLogs);
    }),
).pipe(Command.withDescription("Fetch pod logs with tail/follow/container selectors"));

const describeCommand = Command.make(
  "describe",
  {
    ...commonFlags,
    resource: Flag.string("resource").pipe(
      Flag.withDescription("Resource type (pod, deploy, svc, etc.)"),
    ),
    name: Flag.string("name").pipe(Flag.withDescription("Resource name")),
    namespace: Flag.string("namespace").pipe(
      Flag.withDescription("Namespace containing the resource"),
      Flag.optional,
    ),
  },
  ({ dryRun, env, format, name, namespace, profile, resource }) =>
    Effect.gen(function* () {
      const resolvedNamespace = yield* resolveStructuredNamespace(namespace, env, profile);
      const command = buildKubectlCommand(`describe ${resource} ${name}`, [
        resolvedNamespace ? `-n ${resolvedNamespace}` : "",
      ]);
      const result = yield* executeK8sCommand(command, { dryRun, env, format, profile });
      return yield* logTransformedResult(result, format, transformDescribe);
    }),
).pipe(Command.withDescription("Describe a Kubernetes resource by type and name"));

const execCommand = Command.make(
  "exec",
  {
    ...commonFlags,
    pod: Flag.string("pod").pipe(Flag.withDescription("Pod name")),
    execCmd: Flag.string("exec-cmd").pipe(
      Flag.withDescription("Allowlisted diagnostic: redis-cli PING/INFO or ls"),
    ),
    namespace: Flag.string("namespace").pipe(
      Flag.withDescription("Namespace containing the pod"),
      Flag.optional,
    ),
    container: Flag.string("container").pipe(
      Flag.withDescription("Container name (for multi-container pods)"),
      Flag.optional,
    ),
  },
  ({ container, dryRun, env, execCmd, format, namespace, pod, profile }) =>
    Effect.gen(function* () {
      const resolvedNamespace = yield* resolveStructuredNamespace(namespace, env, profile);
      const command = buildKubectlCommand(`exec ${pod}`, [
        resolvedNamespace ? `-n ${resolvedNamespace}` : "",
        Option.match(container, {
          onNone: () => "",
          onSome: (value) => `-c ${value}`,
        }),
        `-- ${execCmd}`,
      ]);
      return yield* runK8sCommand(command, { dryRun, env, format, profile });
    }),
).pipe(Command.withDescription("Run an allowlisted diagnostic in a pod"));

const topCommand = Command.make(
  "top",
  {
    ...commonFlags,
    namespace: Flag.string("namespace").pipe(
      Flag.withDescription("Namespace to inspect"),
      Flag.optional,
    ),
    sortBy: Flag.choice("sort-by", ["cpu", "memory"] as const).pipe(
      Flag.withDescription("Sort metrics output when supported by kubectl"),
      Flag.optional,
    ),
  },
  ({ dryRun, env, format, namespace, profile, sortBy }) =>
    Effect.gen(function* () {
      const resolvedNamespace = yield* resolveStructuredNamespace(namespace, env, profile);
      const command = buildKubectlCommand("top pod", [
        resolvedNamespace ? `-n ${resolvedNamespace}` : "",
        Option.match(sortBy, {
          onNone: () => "",
          onSome: (value) => `--sort-by=${value}`,
        }),
      ]);
      const result = yield* executeK8sCommand(command, { dryRun, env, format, profile });
      return yield* logTransformedResult(result, format, transformTop);
    }),
).pipe(Command.withDescription("Show pod CPU/memory usage (kubectl top pod)"));

const commandsCommand = makeSchemaCommand(() => mainCommand);

const mainCommand = Command.make("k8s-tool", {}).pipe(
  Command.withDescription("Kubernetes CLI Tool for Coding Agents"),
  Command.withSubcommands([
    kubectlCommand,
    podsCommand,
    logsCommand,
    describeCommand,
    execCommand,
    topCommand,
    commandsCommand,
  ]),
);

const cli = Command.run(mainCommand, {
  version: VERSION,
});

const MainLayer = K8sServiceLayer.pipe(
  Layer.provideMerge(ConfigServiceLayer),
  Layer.provideMerge(BunServices.layer),
  Layer.provideMerge(AuditServiceLayer),
);

const program = withAudit("k8s", cli).pipe(
  Effect.provide(MainLayer),
  Effect.tapCause(renderCauseToStderr),
);

BunRuntime.runMain(program, {
  disableErrorReporting: true,
});
