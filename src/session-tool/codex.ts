import { Effect } from "effect";
import { readdir } from "node:fs/promises";

import type { MessageSummary } from "./types";

import { SessionReadError, SessionStorageNotFoundError, type SessionError } from "./errors";

export type CodexContentBlock =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | { type: string; text?: string };

export type CodexRecord =
  | {
      type: "session_meta";
      timestamp: string;
      payload: { id: string; cwd?: string; timestamp?: string };
    }
  | {
      type: "event_msg";
      timestamp: string;
      payload: { type: "thread_name_updated"; thread_name: string };
    }
  | {
      type: "response_item";
      timestamp: string;
      payload: {
        type: "message";
        role: "user" | "assistant" | "developer" | string;
        content: ReadonlyArray<CodexContentBlock>;
      };
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const parseCodexLine = (line: string): CodexRecord | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (
    !isRecord(parsed) ||
    typeof parsed.type !== "string" ||
    typeof parsed.timestamp !== "string"
  ) {
    return null;
  }

  const payload = parsed.payload;
  if (!isRecord(payload)) {
    return null;
  }

  if (parsed.type === "session_meta" && typeof payload.id === "string") {
    return {
      type: "session_meta",
      timestamp: parsed.timestamp,
      payload: {
        id: payload.id,
        cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
        timestamp: typeof payload.timestamp === "string" ? payload.timestamp : undefined,
      },
    };
  }

  if (
    parsed.type === "event_msg" &&
    payload.type === "thread_name_updated" &&
    typeof payload.thread_name === "string"
  ) {
    return {
      type: "event_msg",
      timestamp: parsed.timestamp,
      payload: { type: "thread_name_updated", thread_name: payload.thread_name },
    };
  }

  if (
    parsed.type === "response_item" &&
    payload.type === "message" &&
    typeof payload.role === "string" &&
    Array.isArray(payload.content)
  ) {
    return {
      type: "response_item",
      timestamp: parsed.timestamp,
      payload: {
        type: "message",
        role: payload.role,
        content: payload.content as ReadonlyArray<CodexContentBlock>,
      },
    };
  }

  return null;
};

export const extractCodexText = (content: ReadonlyArray<CodexContentBlock>): string =>
  content
    .filter(
      (block): block is CodexContentBlock & { text: string } =>
        (block.type === "input_text" || block.type === "output_text") &&
        typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n");

export const extractCodexTitle = (records: ReadonlyArray<CodexRecord>): string => {
  const named = records.find((record) => record.type === "event_msg");
  if (named !== undefined && named.type === "event_msg") {
    return named.payload.thread_name;
  }

  const firstUser = records.find(
    (record) => record.type === "response_item" && record.payload.role === "user",
  );
  if (firstUser !== undefined && firstUser.type === "response_item") {
    return extractCodexText(firstUser.payload.content).slice(0, 100);
  }

  return "Untitled session";
};

const getSessionIdFromFile = (filePath: string): string => {
  const fileName = filePath.split("/").pop() ?? "";
  const match =
    /rollout-.*?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/u.exec(
      fileName,
    );
  return match?.[1] ?? fileName.replace(/\.jsonl$/u, "");
};

export const getCodexSessionId = getSessionIdFromFile;

const walkSessionFiles = async (basePath: string): Promise<string[]> => {
  const results: string[] = [];

  const years = await readdir(basePath);
  for (const year of years) {
    if (!/^\d{4}$/u.test(year)) continue;
    const yearPath = `${basePath}/${year}`;
    let months: string[];
    try {
      // eslint-disable-next-line eslint/no-await-in-loop -- sequential directory walk
      months = await readdir(yearPath);
    } catch {
      continue;
    }

    for (const month of months) {
      const monthPath = `${yearPath}/${month}`;
      let days: string[];
      try {
        // eslint-disable-next-line eslint/no-await-in-loop -- sequential directory walk
        days = await readdir(monthPath);
      } catch {
        continue;
      }

      for (const day of days) {
        const dayPath = `${monthPath}/${day}`;
        let files: string[];
        try {
          // eslint-disable-next-line eslint/no-await-in-loop -- sequential directory walk
          files = await readdir(dayPath);
        } catch {
          continue;
        }

        for (const fileName of files) {
          if (fileName.endsWith(".jsonl") && fileName.startsWith("rollout-")) {
            results.push(`${dayPath}/${fileName}`);
          }
        }
      }
    }
  }

  return results;
};

const readSessionMeta = async (
  sessionFile: string,
): Promise<{ id: string; cwd?: string } | null> => {
  try {
    const file = Bun.file(sessionFile);
    const stream = file.stream();
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx !== -1) {
        const firstLine = buffer.slice(0, newlineIdx);
        const record = parseCodexLine(firstLine);
        if (record !== null && record.type === "session_meta") {
          return { id: record.payload.id, cwd: record.payload.cwd };
        }
        return null;
      }
    }
    const record = parseCodexLine(buffer);
    if (record !== null && record.type === "session_meta") {
      return { id: record.payload.id, cwd: record.payload.cwd };
    }
    return null;
  } catch {
    return null;
  }
};

export const getCodexSessions = (
  basePath: string,
  projectDir: string | null,
): Effect.Effect<string[], SessionError> =>
  Effect.tryPromise({
    try: async () => {
      const allFiles = await walkSessionFiles(basePath);
      if (projectDir === null) {
        return allFiles;
      }

      const filtered: string[] = [];
      const checks = allFiles.map(async (file) => {
        const meta = await readSessionMeta(file);
        if (meta !== null && meta.cwd === projectDir) {
          filtered.push(file);
        }
      });
      await Promise.all(checks);
      return filtered;
    },
    catch: (error) =>
      new SessionStorageNotFoundError({
        message: error instanceof Error ? error.message : "Codex storage directory not found",
        path: basePath,
      }),
  });

export const readCodexMessages = (
  sessionFiles: string[],
): Effect.Effect<MessageSummary[], SessionError> =>
  Effect.tryPromise({
    try: async () => {
      const summaries: MessageSummary[] = [];

      for (const sessionFile of sessionFiles) {
        let fileContent: string;
        try {
          // eslint-disable-next-line eslint/no-await-in-loop -- sequential file read keeps memory bounded
          fileContent = await Bun.file(sessionFile).text();
        } catch {
          continue;
        }

        const records = fileContent
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .map(parseCodexLine)
          .filter((record): record is CodexRecord => record !== null);

        const title = extractCodexTitle(records);
        const sessionID = getSessionIdFromFile(sessionFile);

        for (const record of records) {
          if (record.type !== "response_item") continue;
          if (record.payload.role !== "user" && record.payload.role !== "assistant") continue;

          const body = extractCodexText(record.payload.content);
          if (body.length === 0) continue;

          const createdTimestamp = new Date(record.timestamp).getTime();
          summaries.push({
            sessionID,
            id: `${sessionID}:${record.timestamp}`,
            title,
            body,
            created: Number.isFinite(createdTimestamp) ? createdTimestamp : 0,
            role: record.payload.role,
            source: "codex",
          });
        }
      }

      return (
        summaries as MessageSummary[] & {
          toSorted(
            compareFn: (left: MessageSummary, right: MessageSummary) => number,
          ): MessageSummary[];
        }
      ).toSorted((left, right) => right.created - left.created);
    },
    catch: (error) =>
      new SessionReadError({
        message: error instanceof Error ? error.message : "Failed to read Codex sessions",
        source: "codex",
      }),
  });
