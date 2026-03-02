#!/usr/bin/env bun
import { Command, Flag } from "effect/unstable/cli";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Layer, Option } from "effect";

import { formatAny, formatOption, formatOutput, renderCauseToStderr, VERSION } from "../shared";
import {
  findFailedJobs,
  getBuildJobSummary,
  getBuildLogContent,
  getBuildLogs,
  getBuildTimeline,
} from "./build";
import { AzService, AzServiceLayer } from "./service";
import { ConfigServiceLayer } from "../config";

// ---------------------------------------------------------------------------
// Common flags shared across build subcommands
// ---------------------------------------------------------------------------

const commonBuildFlags = {
  format: formatOption,
  profile: Flag.optional(Flag.string("profile")).pipe(
    Flag.withDescription("Azure DevOps profile name (from agent-tools config)"),
  ),
};

// ---------------------------------------------------------------------------
// Build subcommands
// ---------------------------------------------------------------------------

const buildTimelineCommand = Command.make(
  "timeline",
  {
    ...commonBuildFlags,
    buildId: Flag.integer("build-id").pipe(Flag.withDescription("Build ID")),
  },
  ({ buildId, format, profile: _profile }) =>
    Effect.gen(function* () {
      const result = yield* getBuildTimeline(buildId);
      yield* Console.log(formatAny(result, format));
    }),
).pipe(Command.withDescription("Get build timeline with all records (jobs, stages, tasks)"));

const buildFailedJobsCommand = Command.make(
  "failed-jobs",
  {
    ...commonBuildFlags,
    buildId: Flag.integer("build-id").pipe(Flag.withDescription("Build ID")),
  },
  ({ buildId, format, profile: _profile }) =>
    Effect.gen(function* () {
      const failedJobs = yield* findFailedJobs(buildId);
      yield* Console.log(formatAny({ buildId, failedJobs }, format));
    }),
).pipe(Command.withDescription("Find failed or canceled jobs in a build"));

const buildLogsCommand = Command.make(
  "logs",
  {
    ...commonBuildFlags,
    buildId: Flag.integer("build-id").pipe(Flag.withDescription("Build ID")),
  },
  ({ buildId, format, profile: _profile }) =>
    Effect.gen(function* () {
      const result = yield* getBuildLogs(buildId);
      yield* Console.log(formatAny(result, format));
    }),
).pipe(Command.withDescription("Get list of build logs"));

const buildLogContentCommand = Command.make(
  "log-content",
  {
    ...commonBuildFlags,
    buildId: Flag.integer("build-id").pipe(Flag.withDescription("Build ID")),
    logId: Flag.integer("log-id").pipe(Flag.withDescription("Log ID")),
  },
  ({ buildId, format, logId, profile: _profile }) =>
    Effect.gen(function* () {
      const content = yield* getBuildLogContent(buildId, logId);
      yield* Console.log(formatAny({ buildId, logId, content }, format));
    }),
).pipe(Command.withDescription("Get specific log content by log ID"));

const buildSummaryCommand = Command.make(
  "summary",
  {
    ...commonBuildFlags,
    buildId: Flag.integer("build-id").pipe(Flag.withDescription("Build ID")),
  },
  ({ buildId, format, profile: _profile }) =>
    Effect.gen(function* () {
      const summary = yield* getBuildJobSummary(buildId);
      yield* Console.log(formatAny({ buildId, summary }, format));
    }),
).pipe(Command.withDescription("Get job summaries with duration and status information"));

// ---------------------------------------------------------------------------
// Build parent command
// ---------------------------------------------------------------------------

const buildCommand = Command.make("build", {}).pipe(
  Command.withDescription("Build helpers for Azure DevOps pipelines"),
  Command.withSubcommands([
    buildTimelineCommand,
    buildFailedJobsCommand,
    buildLogsCommand,
    buildLogContentCommand,
    buildSummaryCommand,
  ]),
);

// ---------------------------------------------------------------------------
// Raw command subcommand (preserves existing --cmd behavior)
// ---------------------------------------------------------------------------

const cmdCommand = Command.make(
  "cmd",
  {
    profile: Flag.optional(Flag.string("profile")).pipe(
      Flag.withDescription("Azure DevOps profile name (from agent-tools config)"),
    ),
    project: Flag.optional(Flag.string("project")).pipe(
      Flag.withDescription("Azure DevOps project name (overrides config default)"),
    ),
    cmd: Flag.string("cmd").pipe(Flag.withDescription("az command (without 'az' prefix)")),
    dryRun: Flag.boolean("dry-run").pipe(
      Flag.withDescription("Show command without executing"),
      Flag.withDefault(false),
    ),
    format: formatOption,
  },
  ({ profile: _profile, project, cmd, dryRun, format }) =>
    Effect.gen(function* () {
      const projectName = project ? Option.getOrUndefined(project) : undefined;

      if (dryRun) {
        const fullCommand = `az ${cmd}`;
        yield* Console.log(`[DRY-RUN] Would execute: ${fullCommand}`);
        return;
      }

      const az = yield* AzService;

      const startTime = Date.now();
      const output = yield* az.runCommand(cmd, projectName);
      const executionTimeMs = Date.now() - startTime;

      yield* Console.log(
        formatOutput(
          {
            success: true,
            data: output,
            executionTimeMs,
          },
          format,
        ),
      );
    }),
).pipe(
  Command.withDescription(
    `Execute raw az CLI commands directly.

EXAMPLES:
  agent-tools-az cmd --cmd "pipelines list"
  agent-tools-az cmd --cmd "repos list" --project my-project
  agent-tools-az cmd --cmd "pipelines runs list --output json"`,
  ),
);

// ---------------------------------------------------------------------------
// Main command with subcommands
// ---------------------------------------------------------------------------

const mainCommand = Command.make("az-tool", {}).pipe(
  Command.withDescription(
    `Azure CLI Tool for Coding Agents (READ-ONLY)

Typed build subcommands:
  az-tool build timeline --build-id 123
  az-tool build failed-jobs --build-id 123
  az-tool build logs --build-id 123
  az-tool build log-content --build-id 123 --log-id 45
  az-tool build summary --build-id 123

Raw az wrapper:
  az-tool cmd --cmd "pipelines list"`,
  ),
  Command.withSubcommands([buildCommand, cmdCommand]),
);

const cli = Command.run(mainCommand, {
  version: VERSION,
});

const MainLayer = AzServiceLayer.pipe(
  Layer.provideMerge(ConfigServiceLayer),
  Layer.provideMerge(BunServices.layer),
);

const program = cli.pipe(Effect.provide(MainLayer), Effect.tapCause(renderCauseToStderr));

BunRuntime.runMain(program, {
  disableErrorReporting: true,
});
