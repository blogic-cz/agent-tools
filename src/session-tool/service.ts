import { Context, Effect, Layer } from "effect";
import { readdir } from "node:fs/promises";

import type { MessageSummary, SessionInfo } from "./types";

import { getClaudeCodeSessions, readClaudeCodeMessages } from "./claude-code";
import { ResolvedPaths } from "./config";
import { SessionReadError, SessionStorageNotFoundError, type SessionError } from "./errors";

const parseJson = <T>(content: string): T | null => {
  try {
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
};

export const formatDate = (timestamp: number): string => {
  if (!timestamp) {
    return "unknown";
  }

  return new Date(timestamp).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

export const truncate = (value: string, maxLen: number): string => {
  if (value.length <= maxLen) {
    return value;
  }

  return `${value.slice(0, maxLen - 3)}...`;
};

type FileEntry = { filePath: string; content: string };

type SourceFilter = "both" | "opencode" | "claude-code";

const UUID_SESSION_ID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

const getSessionIdFromClaudeFile = (filePath: string): string => {
  const fileName = filePath.split("/").pop() ?? "";
  return fileName.endsWith(".jsonl") ? fileName.slice(0, -".jsonl".length) : fileName;
};

const detectSourceFilter = (filterSessions: Set<string> | null): SourceFilter => {
  if (filterSessions === null || filterSessions.size !== 1) {
    return "both";
  }

  const sessionId = filterSessions.values().next().value;
  if (typeof sessionId !== "string") {
    return "both";
  }

  if (sessionId.startsWith("ses_")) {
    return "opencode";
  }

  if (UUID_SESSION_ID_REGEX.test(sessionId)) {
    return "claude-code";
  }

  return "both";
};

/**
 * Reads JSON files from a two-level directory (parent/sub/*.json) using Bun.file().
 * Required for ~100k OpenCode message files where shell-per-file would timeout.
 */
const readJsonFilesInTree = (parentDir: string): Effect.Effect<FileEntry[], SessionError> =>
  Effect.tryPromise({
    try: async () => {
      const subDirs = await readdir(parentDir);
      const results: FileEntry[] = [];

      for (const subDir of subDirs) {
        const subPath = `${parentDir}/${subDir}`;
        let files: string[];
        try {
          // eslint-disable-next-line eslint/no-await-in-loop -- sequential directory walk, each iteration may short-circuit
          files = await readdir(subPath);
        } catch {
          /* ignore unreadable files */
          continue;
        }

        const reads = files
          .filter((f) => f.endsWith(".json"))
          .map(async (f) => {
            const filePath = `${subPath}/${f}`;
            try {
              const content = await Bun.file(filePath).text();
              results.push({ filePath, content });
            } catch {
              /* ignore unreadable files */
            }
          });
        // eslint-disable-next-line eslint/no-await-in-loop -- sequential directory walk, each iteration may short-circuit
        await Promise.all(reads);
      }

      return results;
    },
    catch: (error) =>
      new SessionStorageNotFoundError({
        message: error instanceof Error ? error.message : "Directory not found",
        path: parentDir,
      }),
  });

const readJsonFilesFlat = (dir: string): Effect.Effect<FileEntry[], SessionError> =>
  Effect.tryPromise({
    try: async () => {
      const files = await readdir(dir);
      const results: FileEntry[] = [];

      const reads = files
        .filter((f) => f.endsWith(".json"))
        .map(async (f) => {
          const filePath = `${dir}/${f}`;
          try {
            const content = await Bun.file(filePath).text();
            results.push({ filePath, content });
          } catch {
            /* ignore unreadable files */
          }
        });
      await Promise.all(reads);

      return results;
    },
    catch: (error) =>
      new SessionReadError({
        message: error instanceof Error ? error.message : "Failed to read directory",
        source: dir,
      }),
  });

export class SessionService extends Context.Service<
  SessionService,
  {
    readonly getSessionsForProject: (
      projectDir: string | null,
    ) => Effect.Effect<Set<string>, SessionError>;
    readonly getMessageSummaries: (
      filterSessions: Set<string> | null,
    ) => Effect.Effect<MessageSummary[], SessionError>;
    readonly searchSummaries: (summaries: MessageSummary[], query: string) => MessageSummary[];
  }
>()("@agent-tools/SessionService") {
  static readonly layer = Layer.effect(
    SessionService,
    Effect.gen(function* () {
      const paths = yield* ResolvedPaths;

      return {
        getSessionsForProject: Effect.fn("SessionService.getSessionsForProject")(function* (
          projectDir: string | null,
        ) {
          const opencodeSessions = yield* Effect.gen(function* () {
            const files = yield* readJsonFilesInTree(paths.sessionsPath);
            const matchingSessions = new Set<string>();

            for (const { content } of files) {
              const parsed = parseJson<SessionInfo>(content);
              if (parsed === null) continue;

              if (projectDir === null || parsed.directory === projectDir) {
                matchingSessions.add(parsed.id);
              }
            }

            return matchingSessions;
          }).pipe(
            Effect.catchTag("SessionStorageNotFoundError", () => Effect.succeed(new Set<string>())),
          );

          const claudeSessions =
            paths.claudeCodePath === null
              ? new Set<string>()
              : yield* getClaudeCodeSessions(paths.claudeCodePath, projectDir).pipe(
                  Effect.map(
                    (files) =>
                      new Set<string>(
                        files.map((filePath) => getSessionIdFromClaudeFile(filePath)),
                      ),
                  ),
                  Effect.catchTag("SessionStorageNotFoundError", () =>
                    Effect.succeed(new Set<string>()),
                  ),
                );

          const matchingSessions = new Set<string>(opencodeSessions);
          for (const sessionId of claudeSessions) {
            matchingSessions.add(sessionId);
          }

          return matchingSessions;
        }),

        getMessageSummaries: Effect.fn("SessionService.getMessageSummaries")(function* (
          filterSessions: Set<string> | null,
        ) {
          const sourceFilter = detectSourceFilter(filterSessions);

          const opencodeSummaries =
            sourceFilter === "claude-code"
              ? []
              : yield* Effect.gen(function* () {
                  const sessionDirs = yield* Effect.tryPromise({
                    try: async () => {
                      const dirs = await readdir(paths.messagesPath);
                      return dirs
                        .filter((name) => name.startsWith("ses_"))
                        .filter((name) => filterSessions === null || filterSessions.has(name));
                    },
                    catch: () =>
                      new SessionStorageNotFoundError({
                        message: "Message storage directory not found",
                        path: paths.messagesPath,
                      }),
                  });

                  const summaries: MessageSummary[] = [];

                  for (const sessionId of sessionDirs) {
                    const sessionPath = `${paths.messagesPath}/${sessionId}`;
                    const files = yield* readJsonFilesFlat(sessionPath);

                    for (const { filePath, content } of files) {
                      const parsed = parseJson<{
                        id?: string;
                        role?: string;
                        sessionID?: string;
                        summary?: {
                          body?: string;
                          title?: string;
                        };
                        time?: {
                          created?: number;
                        };
                      }>(content);

                      if (parsed === null || parsed.summary?.title === undefined) {
                        continue;
                      }

                      summaries.push({
                        sessionID: parsed.sessionID ?? sessionId,
                        id: parsed.id ?? filePath.split("/").pop()?.replace(".json", "") ?? "",
                        title: parsed.summary.title,
                        body: parsed.summary.body ?? "",
                        created: parsed.time?.created ?? 0,
                        role: parsed.role ?? "unknown",
                        source: "opencode",
                      });
                    }
                  }

                  return summaries;
                }).pipe(Effect.catchTag("SessionStorageNotFoundError", () => Effect.succeed([])));

          const claudeSummaries =
            sourceFilter === "opencode" || paths.claudeCodePath === null
              ? []
              : yield* getClaudeCodeSessions(paths.claudeCodePath, null).pipe(
                  Effect.map((sessionFiles) =>
                    filterSessions === null
                      ? sessionFiles
                      : sessionFiles.filter((sessionFile) =>
                          filterSessions.has(getSessionIdFromClaudeFile(sessionFile)),
                        ),
                  ),
                  Effect.flatMap(readClaudeCodeMessages),
                  Effect.catchTag("SessionStorageNotFoundError", () => Effect.succeed([])),
                );

          const summaries = [...opencodeSummaries, ...claudeSummaries];

          return (
            summaries as MessageSummary[] & {
              toSorted(
                compareFn: (left: MessageSummary, right: MessageSummary) => number,
              ): MessageSummary[];
            }
          ).toSorted((left, right) => right.created - left.created);
        }),

        searchSummaries: (summaries: MessageSummary[], query: string): MessageSummary[] => {
          const lowerQuery = query.toLowerCase();
          return summaries.filter(
            (summary) =>
              summary.title.toLowerCase().includes(lowerQuery) ||
              summary.body.toLowerCase().includes(lowerQuery),
          );
        },
      };
    }),
  );
}

export const SessionServiceLayer = SessionService.layer;
