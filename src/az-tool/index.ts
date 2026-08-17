#!/usr/bin/env bun
import { Command, Flag } from "effect/unstable/cli";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer, Option } from "effect";

import {
  makeSchemaCommand,
  formatAny,
  formatOption,
  logText,
  renderCauseToStderr,
  VERSION,
} from "#shared";
import { AuditServiceLayer, withAudit } from "#shared/audit";
import { AzService, AzServiceLayer } from "./service";
import { ConfigServiceLayer } from "#config";

const profileFlag = Flag.optional(Flag.string("profile")).pipe(
  Flag.withDescription("Azure platform profile name (from agent-tools config)"),
);

const commonFlags = {
  format: formatOption,
  profile: profileFlag,
};

/** Run a fixed read-only command through the same security gate as `cmd`. */
const runFixed = (cmd: string, profile: Option.Option<string>, format: "toon" | "json") =>
  Effect.gen(function* () {
    const az = yield* AzService;
    const result = yield* az.runCommand(cmd, Option.getOrUndefined(profile));
    yield* logText(formatAny(result.data, format));
  });

// ---------------------------------------------------------------------------
// Typed subcommands
// ---------------------------------------------------------------------------

const subscriptionCommand = Command.make("subscription", commonFlags, ({ format, profile }) =>
  runFixed("account show", profile, format),
).pipe(Command.withDescription("Show the subscription every command in this profile is pinned to"));

const groupsCommand = Command.make("groups", commonFlags, ({ format, profile }) =>
  runFixed("group list", profile, format),
).pipe(Command.withDescription("List resource groups in the pinned subscription"));

const resourcesCommand = Command.make(
  "resources",
  {
    ...commonFlags,
    group: Flag.optional(Flag.string("group")).pipe(
      Flag.withDescription("Limit the listing to one resource group"),
    ),
  },
  ({ format, group, profile }) =>
    Effect.gen(function* () {
      const groupName = Option.getOrUndefined(group);
      const cmd = groupName ? `resource list --resource-group ${groupName}` : "resource list";
      yield* runFixed(cmd, profile, format);
    }),
).pipe(Command.withDescription("List resources, optionally scoped to one resource group"));

// ---------------------------------------------------------------------------
// Raw command passthrough
// ---------------------------------------------------------------------------

const cmdCommand = Command.make(
  "cmd",
  {
    ...commonFlags,
    cmd: Flag.string("cmd").pipe(Flag.withDescription("az command (without the 'az' prefix)")),
    dryRun: Flag.boolean("dry-run").pipe(
      Flag.withDescription("Show the command that would run, after security checks"),
      Flag.withDefault(false),
    ),
  },
  ({ cmd, dryRun, format, profile }) =>
    Effect.gen(function* () {
      const az = yield* AzService;
      const profileName = Option.getOrUndefined(profile);

      if (dryRun) {
        const rendered = yield* az.renderCommand(cmd, profileName);
        yield* logText(`[DRY-RUN] Would execute: ${rendered}`);
        return;
      }

      const result = yield* az.runCommand(cmd, profileName);
      yield* logText(formatAny(result.data, format));
    }),
).pipe(
  Command.withDescription(
    `Execute a read-only Azure platform command.

The subscription is pinned by the selected profile — passing --subscription is rejected.
Mutating verbs, unknown verbs, credential reads, and shell syntax are all blocked.

EXAMPLES:
  az-tool cmd --cmd "vm list"
  az-tool cmd --cmd "webapp show --name my-app --resource-group my-rg"
  az-tool cmd --cmd "aks list --query \\"[].{name:name,version:kubernetesVersion}\\""
  az-tool cmd --cmd "storage account list" --profile prod --dry-run`,
  ),
);

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

const commandsCommand = makeSchemaCommand(() => mainCommand);

const mainCommand = Command.make("az-tool", {}).pipe(
  Command.withDescription(
    `Azure Platform Tool for Coding Agents (READ-ONLY)

Inspects Azure PaaS resources — vm, webapp, storage, aks, acr, monitor, and the rest.
For Azure DevOps pipelines, builds, and repos use azdo-tool instead.

Typed subcommands:
  az-tool subscription
  az-tool groups
  az-tool resources --group my-rg

Raw az wrapper:
  az-tool cmd --cmd "webapp list"`,
  ),
  Command.withSubcommands([
    subscriptionCommand,
    groupsCommand,
    resourcesCommand,
    cmdCommand,
    commandsCommand,
  ]),
);

const cli = Command.run(mainCommand, {
  version: VERSION,
});

const MainLayer = AzServiceLayer.pipe(
  Layer.provideMerge(ConfigServiceLayer),
  Layer.provideMerge(BunServices.layer),
  Layer.provideMerge(AuditServiceLayer),
);

const program = withAudit("az", cli).pipe(
  Effect.provide(MainLayer),
  Effect.tapCause(renderCauseToStderr),
);

BunRuntime.runMain(program, {
  disableErrorReporting: true,
});
