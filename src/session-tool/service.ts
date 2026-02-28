import { Context, Effect, Layer } from "effect";
import { readdir } from "node:fs/promises";

import type { MessageSummary, SessionInfo } from "./types";

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
          files = await readdir(subPath);
        } catch {
          continue;
        }

        const reads = files
          .filter((f) => f.endsWith(".json"))
          .map(async (f) => {
            const filePath = `${subPath}/${f}`;
            try {
              const content = await Bun.file(filePath).text();
              results.push({ filePath, content });
            } catch {}
          });
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
          } catch {}
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

export class SessionService extends Context.Tag("@agent-tools/SessionService")<
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
>() {
  static readonly layer = Layer.effect(
    SessionService,
    Effect.gen(function* () {
      const paths = yield* ResolvedPaths;

      return {
        getSessionsForProject: Effect.fn("SessionService.getSessionsForProject")(function* (
          projectDir: string | null,
        ) {
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
        }),

        getMessageSummaries: Effect.fn("SessionService.getMessageSummaries")(function* (
          filterSessions: Set<string> | null,
        ) {
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
              });
            }
          }

          return summaries.sort((left, right) => right.created - left.created);
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
