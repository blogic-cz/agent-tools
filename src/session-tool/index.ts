#!/usr/bin/env bun

/**
 * OpenCode Session Tool for Coding Agents
 *
 * Lists, searches, and reads OpenCode session history.
 * Uses current project scope by default, or all projects with --all.
 */

import { Args, Command, Options } from "@effect/cli";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import { Console, Effect, Either, Layer } from "effect";

import type { MessageSummary, SessionResult } from "./types";

import { formatOption, formatOutput, VERSION } from "../shared";
import { ResolvedPaths, ResolvedPathsLayer } from "./config";
import { SessionStorageNotFoundError } from "./errors";
import { formatDate, SessionService, SessionServiceLayer, truncate } from "./service";

const AppLayer = SessionServiceLayer.pipe(Layer.provideMerge(ResolvedPathsLayer));

const buildScopeLabel = (searchAll: boolean, currentDir: string) => {
  if (searchAll) {
    return "all projects";
  }

  const projectName = currentDir.split("/").pop() ?? currentDir;
  return `current project (${projectName})`;
};

const mapSummary = (summary: MessageSummary) => {
  return Effect.gen(function* () {
    const paths = yield* ResolvedPaths;
    return {
      sessionID: summary.sessionID,
      messageID: summary.id,
      title: summary.title,
      body: truncate(summary.body, 500),
      created: formatDate(summary.created),
      messagePath: `${paths.messagesPath}/${summary.sessionID}/${summary.id}.json`,
      role: summary.role,
      sessionPath: `${paths.messagesPath}/${summary.sessionID}`,
    };
  });
};

const listCommand = Command.make(
  "list",
  {
    all: Options.boolean("all").pipe(
      Options.withDescription("Search all projects"),
      Options.withDefault(false),
    ),
    format: formatOption,
    limit: Options.integer("limit").pipe(
      Options.withDescription("Limit result count"),
      Options.withDefault(10),
    ),
  },
  ({ all, format, limit }) =>
    Effect.gen(function* () {
      const sessionService = yield* SessionService;
      const startTime = Date.now();
      const currentDir = process.cwd();
      const scope = buildScopeLabel(all, currentDir);

      const result = yield* Effect.gen(function* () {
        const sessionFilter = all ? null : yield* sessionService.getSessionsForProject(currentDir);

        if (sessionFilter !== null && sessionFilter.size === 0) {
          return {
            success: false,
            error: "No sessions found for current project",
            data: {
              project: currentDir,
              scope,
            },
            scope,
            count: 0,
            executionTimeMs: Date.now() - startTime,
          } satisfies SessionResult;
        }

        const summaries = yield* sessionService.getMessageSummaries(sessionFilter);
        const results = summaries.slice(0, limit).map((summary) => ({
          created: formatDate(summary.created),
          sessionID: summary.sessionID,
          title: summary.title,
        }));

        return {
          success: true,
          data: {
            results,
            scope,
          },
          scope,
          count: results.length,
          executionTimeMs: Date.now() - startTime,
        } satisfies SessionResult;
      }).pipe(Effect.either);

      const output = Either.match(result, {
        onLeft: (error) =>
          ({
            success: false,
            error: error.message,
            data: error instanceof SessionStorageNotFoundError ? { path: error.path } : undefined,
            scope,
            count: 0,
            executionTimeMs: Date.now() - startTime,
          }) satisfies SessionResult,
        onRight: (okResult) => okResult,
      });

      yield* Console.log(formatOutput(output, format));
    }),
).pipe(Command.withDescription("List OpenCode session summaries"));

const searchCommand = Command.make(
  "search",
  {
    query: Args.text({ name: "query" }).pipe(Args.withDescription("Search query")),
    all: Options.boolean("all").pipe(
      Options.withDescription("Search all projects"),
      Options.withDefault(false),
    ),
    format: formatOption,
    limit: Options.integer("limit").pipe(
      Options.withDescription("Limit result count"),
      Options.withDefault(10),
    ),
  },
  ({ all, format, limit, query }) =>
    Effect.gen(function* () {
      const sessionService = yield* SessionService;
      const startTime = Date.now();
      const currentDir = process.cwd();
      const scope = buildScopeLabel(all, currentDir);

      const result = yield* Effect.gen(function* () {
        const sessionFilter = all ? null : yield* sessionService.getSessionsForProject(currentDir);

        if (sessionFilter !== null && sessionFilter.size === 0) {
          return {
            success: false,
            query,
            error: "No sessions found for current project",
            data: {
              project: currentDir,
              results: [],
            },
            scope,
            count: 0,
            executionTimeMs: Date.now() - startTime,
          } satisfies SessionResult;
        }

        const summaries = yield* sessionService.getMessageSummaries(sessionFilter);
        const matched = sessionService.searchSummaries(summaries, query);
        const mappedResults = yield* Effect.all(matched.slice(0, limit).map(mapSummary));

        return {
          success: true,
          query,
          data: {
            count: mappedResults.length,
            query,
            results: mappedResults,
            scope,
          },
          scope,
          count: mappedResults.length,
          executionTimeMs: Date.now() - startTime,
        } satisfies SessionResult;
      }).pipe(Effect.either);

      const output = Either.match(result, {
        onLeft: (error) =>
          ({
            success: false,
            query,
            error: error.message,
            data:
              error instanceof SessionStorageNotFoundError
                ? { path: error.path, results: [] }
                : { results: [] },
            scope,
            count: 0,
            executionTimeMs: Date.now() - startTime,
          }) satisfies SessionResult,
        onRight: (okResult) => okResult,
      });

      yield* Console.log(formatOutput(output, format));
    }),
).pipe(Command.withDescription("Search OpenCode message history"));

const readCommand = Command.make(
  "read",
  {
    session: Options.text("session").pipe(Options.withDescription("Session ID to read")),
    format: formatOption,
  },
  ({ format, session }) =>
    Effect.gen(function* () {
      const sessionService = yield* SessionService;
      const startTime = Date.now();

      const result = yield* sessionService
        .getMessageSummaries(new Set([session]))
        .pipe(Effect.either);

      const output: SessionResult = yield* Either.match(result, {
        onLeft: (error) =>
          Effect.succeed({
            success: false,
            error: error.message,
            data:
              error instanceof SessionStorageNotFoundError
                ? { path: error.path, session }
                : { session },
            count: 0,
            executionTimeMs: Date.now() - startTime,
          } satisfies SessionResult),
        onRight: (summaries) => {
          const sessionResults = summaries.filter((summary) => summary.sessionID === session);
          return Effect.all(sessionResults.map(mapSummary)).pipe(
            Effect.map(
              (mapped) =>
                ({
                  success: true,
                  data: {
                    files: mapped.map((message) => message.messagePath),
                    messages: mapped,
                    session,
                  },
                  count: mapped.length,
                  executionTimeMs: Date.now() - startTime,
                }) satisfies SessionResult,
            ),
          );
        },
      });

      yield* Console.log(formatOutput(output, format));
    }),
).pipe(Command.withDescription("Read all messages from a session"));

const mainCommand = Command.make("session-tool", {}).pipe(
  Command.withDescription("OpenCode session history tool"),
  Command.withSubcommands([listCommand, readCommand, searchCommand]),
);

const cli = Command.run(mainCommand, {
  name: "Session Tool",
  version: VERSION,
});

export const run = (argv: ReadonlyArray<string>) => cli(argv);

const MainLayer = AppLayer.pipe(Layer.provideMerge(BunContext.layer));

const program = cli(process.argv).pipe(Effect.provide(MainLayer));

BunRuntime.runMain(program, {
  disableErrorReporting: true,
});
