#!/usr/bin/env bun

/**
 * Application Logs Tool for Coding Agents
 *
 * Reads application logs from local development or test/prod environments.
 * For test/prod, uses k8s-tool internally to access logs from PVC.
 *
 * Run with --help for full usage documentation.
 *
 * IMPORTANT FOR AI AGENTS:
 * Use this tool to investigate application behavior and errors.
 * Always start with --list to see available log files.
 * Use --format toon for LLM-optimized output (fewer tokens).
 */

import { Command, Flag } from "effect/unstable/cli";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Layer, Option, Result } from "effect";

import type { Environment, LogResult, ReadOptions } from "./types";

import { formatOption, formatOutput, renderCauseToStderr, VERSION } from "../shared";
import { LogsNotFoundError } from "./errors";
import { LogsService, LogsServiceLayer } from "./service";

const profileOption = Flag.optional(
  Flag.string("profile").pipe(
    Flag.withDescription(
      "Named profile from agent-tools.json5 logs section (default: 'default' key or single entry)",
    ),
  ),
);

const buildSource = (
  mode: "list" | "read",
  env: Environment,
  logsConfig: { localDir: string; remotePath: string } | undefined,
  options: ReadOptions | null,
): string | undefined => {
  if (!logsConfig) return undefined;

  if (mode === "list") {
    return env === "local" ? logsConfig.localDir : `${env}:${logsConfig.remotePath}`;
  }

  if (env === "local") {
    const fileName = options?.file ?? "latest";
    return `${logsConfig.localDir}/${fileName}`;
  }

  const fileName = options?.file ?? "app.log";
  return `${env}:${logsConfig.remotePath}/${fileName}`;
};

const listCommand = Command.make(
  "list",
  {
    env: Flag.choice("env", ["local", "test", "prod"]).pipe(
      Flag.withDescription("Target environment"),
    ),
    format: formatOption,
    profile: profileOption,
  },
  ({ env, format, profile }) =>
    Effect.gen(function* () {
      const logsService = yield* LogsService;
      const startTime = Date.now();
      const profileName = Option.getOrUndefined(profile);

      const result = yield* logsService
        .listLogs(env as Environment, profileName)
        .pipe(Effect.result);
      const executionTimeMs = Date.now() - startTime;

      const logResult: LogResult = Result.match(result, {
        onFailure: (error) => ({
          success: false,
          error: error.message,
          source: error instanceof LogsNotFoundError ? error.path : undefined,
          executionTimeMs,
        }),
        onSuccess: (data) => ({
          success: true,
          data,
          source: buildSource("list", env as Environment, undefined, null),
          executionTimeMs,
        }),
      });

      yield* Console.log(formatOutput(logResult, format));
    }),
).pipe(Command.withDescription("List available log files"));

const readCommand = Command.make(
  "read",
  {
    env: Flag.choice("env", ["local", "test", "prod"]).pipe(
      Flag.withDescription("Target environment"),
    ),
    file: Flag.string("file").pipe(
      Flag.withDescription("Specific log file to read"),
      Flag.optional,
    ),
    format: formatOption,
    grep: Flag.string("grep").pipe(
      Flag.withDescription("Filter lines containing pattern"),
      Flag.optional,
    ),
    pretty: Flag.boolean("pretty").pipe(
      Flag.withDescription("Pretty-print JSON log entries"),
      Flag.withDefault(false),
    ),
    profile: profileOption,
    tail: Flag.integer("tail").pipe(
      Flag.withDescription("Show last N lines"),
      Flag.withDefault(100),
    ),
  },
  ({ env, file, format, grep, pretty, profile, tail }) =>
    Effect.gen(function* () {
      const logsService = yield* LogsService;
      const startTime = Date.now();
      const profileName = Option.getOrUndefined(profile);

      const readOptions: ReadOptions = {
        tail,
        grep: Option.getOrUndefined(grep),
        file: Option.getOrUndefined(file),
        pretty,
      };

      const result = yield* logsService
        .readLogs(env as Environment, readOptions, profileName)
        .pipe(Effect.result);
      const executionTimeMs = Date.now() - startTime;

      const logResult: LogResult = Result.match(result, {
        onFailure: (error) => ({
          success: false,
          error: error.message,
          source: error instanceof LogsNotFoundError ? error.path : undefined,
          executionTimeMs,
        }),
        onSuccess: (data) => ({
          success: true,
          data,
          source: buildSource("read", env as Environment, undefined, readOptions),
          executionTimeMs,
        }),
      });

      yield* Console.log(formatOutput(logResult, format));
    }),
).pipe(Command.withDescription("Read application logs"));

const mainCommand = Command.make("logs-tool", {}).pipe(
  Command.withDescription("Application Logs Tool for Coding Agents"),
  Command.withSubcommands([listCommand, readCommand]),
);

const cli = Command.run(mainCommand, {
  version: VERSION,
});

export const run = Command.runWith(mainCommand, {
  version: VERSION,
});

const MainLayer = LogsServiceLayer.pipe(Layer.provideMerge(BunServices.layer));

const program = cli.pipe(Effect.provide(MainLayer), Effect.tapCause(renderCauseToStderr));

BunRuntime.runMain(program, {
  disableErrorReporting: true,
});
