#!/usr/bin/env bun
import { Command, Options } from "@effect/cli";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import { Console, Effect, Layer, Option } from "effect";

import { formatAny, formatOption, formatOutput, renderCauseToStderr, VERSION } from "../shared";
import {
  findFailedJobs,
  getBuildJobSummary,
  getBuildLogContent,
  getBuildLogs,
  getBuildTimeline,
} from "./build";
import { AzCommandError } from "./errors";
import { extractOptionValue } from "./extract-option-value";
import { AzService, AzServiceLayer } from "./service";
import { ConfigService, ConfigServiceLayer } from "../config";

const mainCommand = Command.make(
  "az-tool",
  {
    profile: Options.optional(Options.text("profile")).pipe(
      Options.withDescription("Azure DevOps profile name (from agent-tools config)"),
    ),
    project: Options.optional(Options.text("project")).pipe(
      Options.withDescription("Azure DevOps project name (overrides config default)"),
    ),
    cmd: Options.text("cmd").pipe(Options.withDescription("az command (without 'az' prefix)")),
    dryRun: Options.boolean("dry-run").pipe(
      Options.withDescription("Show command without executing"),
      Options.withDefault(false),
    ),
    format: formatOption,
  },
  ({ profile: _profile, project, cmd, dryRun, format }) =>
    Effect.gen(function* () {
      const _config = yield* ConfigService;
      const projectName = project ? Option.getOrUndefined(project) : undefined;

      // Handle dry-run mode
      if (dryRun) {
        const fullCommand = `az ${cmd}`;
        yield* Console.log(`[DRY-RUN] Would execute: ${fullCommand}`);
        return;
      }

      const buildHelperResult = yield* runBuildHelperCommand(cmd);

      if (buildHelperResult !== undefined) {
        yield* Console.log(formatAny(buildHelperResult, format));
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
    `Azure CLI Tool for Coding Agents (READ-ONLY)

Supports raw az wrapper via --cmd and convenience build helpers:
  --cmd "build timeline --build-id 123"
  --cmd "build failed-jobs --build-id 123"
  --cmd "build logs --build-id 123"
  --cmd "build log-content --build-id 123 --log-id 45"
  --cmd "build summary --build-id 123"`,
  ),
);

const cli = Command.run(mainCommand, {
  name: "Azure CLI Tool",
  version: VERSION,
});

const MainLayer = AzServiceLayer.pipe(
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

function runBuildHelperCommand(cmd: string) {
  return Effect.gen(function* () {
    const words = cmd.trim().split(/\s+/);

    if (words[0] !== "build") {
      return undefined;
    }

    const action = words[1];
    if (!action) {
      return yield* invalidBuildCommand(
        cmd,
        "Missing build action. Use one of: timeline, failed-jobs, logs, log-content, summary",
      );
    }

    const buildId = yield* parseRequiredIntOption(words, "--build-id", cmd);

    if (action === "timeline") {
      const timeline = yield* getBuildTimeline(buildId);
      return timeline;
    }

    if (action === "failed-jobs") {
      const failedJobs = yield* findFailedJobs(buildId);
      return { buildId, failedJobs };
    }

    if (action === "logs") {
      const logs = yield* getBuildLogs(buildId);
      return logs;
    }

    if (action === "log-content") {
      const logId = yield* parseRequiredIntOption(words, "--log-id", cmd);
      const content = yield* getBuildLogContent(buildId, logId);
      return {
        buildId,
        logId,
        content,
      };
    }

    if (action === "summary") {
      const summary = yield* getBuildJobSummary(buildId);
      return { buildId, summary };
    }

    return yield* invalidBuildCommand(
      cmd,
      `Unknown build action '${action}'. Use one of: timeline, failed-jobs, logs, log-content, summary`,
    );
  });
}

function invalidBuildCommand(cmd: string, message: string) {
  return Effect.fail(
    new AzCommandError({
      message,
      command: cmd,
      exitCode: 2,
      stderr: message,
    }),
  );
}

function parseRequiredIntOption(args: readonly string[], optionName: string, cmd: string) {
  return Effect.gen(function* () {
    const rawValue = extractOptionValue(args, optionName);
    if (!rawValue) {
      return yield* invalidBuildCommand(cmd, `Missing required option ${optionName}`);
    }

    const parsedValue = Number.parseInt(rawValue, 10);
    if (Number.isNaN(parsedValue)) {
      return yield* invalidBuildCommand(
        cmd,
        `Option ${optionName} must be an integer, received '${rawValue}'`,
      );
    }

    return parsedValue;
  });
}
