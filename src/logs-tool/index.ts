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

import { Command, Options } from "@effect/cli";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import { Console, Effect, Either, Layer, Option } from "effect";

import type { Environment, LogResult, ReadOptions } from "./types";

import { formatOption, formatOutput, renderCauseToStderr, VERSION } from "../shared";
import { LogsNotFoundError } from "./errors";
import { LogsService, LogsServiceLayer } from "./service";

const profileOption = Options.optional(
  Options.text("profile").pipe(
    Options.withDescription(
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
    env: Options.choice("env", ["local", "test", "prod"]).pipe(
      Options.withDescription("Target environment"),
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
        .pipe(Effect.either);
      const executionTimeMs = Date.now() - startTime;

      const logResult: LogResult = Either.match(result, {
        onLeft: (error) => ({
          success: false,
          error: error.message,
          source: error instanceof LogsNotFoundError ? error.path : error.source,
          executionTimeMs,
        }),
        onRight: (data) => ({
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
    env: Options.choice("env", ["local", "test", "prod"]).pipe(
      Options.withDescription("Target environment"),
    ),
    file: Options.text("file").pipe(
      Options.withDescription("Specific log file to read"),
      Options.optional,
    ),
    format: formatOption,
    grep: Options.text("grep").pipe(
      Options.withDescription("Filter lines containing pattern"),
      Options.optional,
    ),
    pretty: Options.boolean("pretty").pipe(
      Options.withDescription("Pretty-print JSON log entries"),
      Options.withDefault(false),
    ),
    profile: profileOption,
    tail: Options.integer("tail").pipe(
      Options.withDescription("Show last N lines"),
      Options.withDefault(100),
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
        .pipe(Effect.either);
      const executionTimeMs = Date.now() - startTime;

      const logResult: LogResult = Either.match(result, {
        onLeft: (error) => ({
          success: false,
          error: error.message,
          source: error instanceof LogsNotFoundError ? error.path : error.source,
          executionTimeMs,
        }),
        onRight: (data) => ({
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
  name: "Logs Tool",
  version: VERSION,
});

export const run = (argv: ReadonlyArray<string>) => cli(argv);

const MainLayer = LogsServiceLayer.pipe(Layer.provideMerge(BunContext.layer));

const program = cli(process.argv).pipe(
  Effect.provide(MainLayer),
  Effect.tapErrorCause(renderCauseToStderr),
);

BunRuntime.runMain(program, {
  disableErrorReporting: true,
});
