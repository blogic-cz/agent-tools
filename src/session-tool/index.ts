#!/usr/bin/env bun

/**
 * OpenCode Session Tool for Coding Agents
 *
 * Lists, searches, and reads OpenCode session history.
 * Uses current project scope by default, or all projects with --all.
 */

import { Argument, Command, Flag } from "effect/unstable/cli";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer, Result } from "effect";

import type { MessageSummary, SessionResult, SessionSource } from "./types";

import { ALL_SESSION_SOURCES } from "./types";

import { makeSchemaCommand, formatOption, formatOutput, logText, VERSION } from "#shared";
import { AuditServiceLayer, withAudit } from "#shared/audit";
import { ResolvedPaths, ResolvedPathsLayer } from "./config";
import { SessionStorageNotFoundError } from "./errors";
import { formatDate, SessionService, SessionServiceLayer, truncate } from "./service";
import {
  projectSessionFilter,
  sessionSummariesFromMessages,
  sortSessionSummaries,
} from "./summaries";

const AppLayer = SessionServiceLayer.pipe(Layer.provideMerge(ResolvedPathsLayer));

const sourceOption = Flag.string("source").pipe(
  Flag.withDescription("Filter by source: all, opencode, claude-code, codex, pi"),
  Flag.withDefault("all"),
);

const filterBySource = (summaries: MessageSummary[], source: string): MessageSummary[] => {
  if (source === "all") return summaries;
  return summaries.filter((s) => s.source === (source as SessionSource));
};

const sourceSet = (source: string): ReadonlySet<SessionSource> =>
  source === "all" ? ALL_SESSION_SOURCES : new Set([source as SessionSource]);

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
      ...(summary.source === "opencode"
        ? {
            messagePath: `${paths.messagesPath}/${summary.sessionID}/${summary.id}.json`,
            sessionPath: `${paths.messagesPath}/${summary.sessionID}`,
          }
        : {}),
      role: summary.role,
      source: summary.source,
    };
  });
};

const listCommand = Command.make(
  "list",
  {
    all: Flag.boolean("all").pipe(
      Flag.withDescription("Search all projects"),
      Flag.withDefault(false),
    ),
    format: formatOption,
    limit: Flag.integer("limit").pipe(
      Flag.withDescription("Limit result count"),
      Flag.withDefault(10),
    ),
    source: sourceOption,
  },
  ({ all, format, limit, source }) =>
    Effect.gen(function* () {
      const sessionService = yield* SessionService;
      const startTime = Date.now();
      const currentDir = process.cwd();
      const scope = buildScopeLabel(all, currentDir);

      const result = yield* Effect.gen(function* () {
        const sources = sourceSet(source);
        const projectSessions = new Map<SessionSource, Set<string>>();
        if (!all) {
          for (const sessionSource of sources) {
            const matching = yield* sessionService.getSessionsForProject(
              currentDir,
              new Set([sessionSource]),
            );
            projectSessions.set(sessionSource, matching);
          }
        }

        if (!all && [...projectSessions.values()].every((sessions) => sessions.size === 0)) {
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

        const nonPiSources = [...sources].filter((item) => item !== "pi");
        const [messagesBySource, piSummaries] = yield* Effect.all([
          Effect.all(
            nonPiSources.map((sessionSource) =>
              sessionService.getMessageSummaries(
                projectSessionFilter(projectSessions, sessionSource, all),
                new Set([sessionSource]),
              ),
            ),
          ),
          sources.has("pi")
            ? sessionService.getPiSessionSummaries(projectSessionFilter(projectSessions, "pi", all))
            : Effect.succeed([]),
        ]);
        const messages = messagesBySource.flat();
        const summaries = sortSessionSummaries([
          ...sessionSummariesFromMessages(messages),
          ...piSummaries,
        ]);
        const results = summaries.slice(0, limit).map((summary) => ({
          createdAt: formatDate(summary.createdAt),
          updatedAt: formatDate(summary.updatedAt),
          sessionID: summary.sessionID,
          title: summary.title,
          source: summary.source,
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
      }).pipe(Effect.result);

      const output = Result.match(result, {
        onFailure: (error) =>
          ({
            success: false,
            error: error.message,
            data: error instanceof SessionStorageNotFoundError ? { path: error.path } : undefined,
            scope,
            count: 0,
            executionTimeMs: Date.now() - startTime,
          }) satisfies SessionResult,
        onSuccess: (okResult) => okResult,
      });

      yield* logText(formatOutput(output, format));
    }),
).pipe(Command.withDescription("List OpenCode session summaries"));

const searchCommand = Command.make(
  "search",
  {
    query: Argument.string("query").pipe(Argument.withDescription("Search query")),
    all: Flag.boolean("all").pipe(
      Flag.withDescription("Search all projects"),
      Flag.withDefault(false),
    ),
    format: formatOption,
    limit: Flag.integer("limit").pipe(
      Flag.withDescription("Limit result count"),
      Flag.withDefault(10),
    ),
    source: sourceOption,
  },
  ({ all, format, limit, query, source }) =>
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

        const allSummaries = yield* sessionService.getMessageSummaries(sessionFilter);
        const summaries = filterBySource(allSummaries, source);
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
      }).pipe(Effect.result);

      const output = Result.match(result, {
        onFailure: (error) =>
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
        onSuccess: (okResult) => okResult,
      });

      yield* logText(formatOutput(output, format));
    }),
).pipe(Command.withDescription("Search message history"));

const readCommand = Command.make(
  "read",
  {
    session: Flag.string("session").pipe(Flag.withDescription("Session ID to read")),
    format: formatOption,
    source: sourceOption,
  },
  ({ format, session, source }) =>
    Effect.gen(function* () {
      const sessionService = yield* SessionService;
      const startTime = Date.now();

      const result = yield* sessionService
        .getMessageSummaries(new Set([session]))
        .pipe(Effect.result);

      const output: SessionResult = yield* Result.match(result, {
        onFailure: (error) =>
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
        onSuccess: (summaries) => {
          const filtered = filterBySource(summaries, source);
          const sessionResults = filtered.filter((summary) => summary.sessionID === session);
          return Effect.all(sessionResults.map(mapSummary)).pipe(
            Effect.map(
              (mapped) =>
                ({
                  success: true,
                  data: {
                    files: mapped
                      .map((message) =>
                        "messagePath" in message ? (message.messagePath as string) : null,
                      )
                      .filter((filePath): filePath is string => filePath !== null),
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

      yield* logText(formatOutput(output, format));
    }),
).pipe(Command.withDescription("Read all messages from a session"));

const commandsCommand = makeSchemaCommand(() => mainCommand);

const mainCommand = Command.make("session-tool", {}).pipe(
  Command.withDescription("OpenCode session history tool"),
  Command.withSubcommands([listCommand, readCommand, searchCommand, commandsCommand]),
);

const cli = Command.run(mainCommand, {
  version: VERSION,
});

export const run = Command.runWith(mainCommand, {
  version: VERSION,
});

const MainLayer = AppLayer.pipe(
  Layer.provideMerge(BunServices.layer),
  Layer.provideMerge(AuditServiceLayer),
);

const program = withAudit("session", cli).pipe(Effect.provide(MainLayer));

BunRuntime.runMain(program, {
  disableErrorReporting: true,
});
