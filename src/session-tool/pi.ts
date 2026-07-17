import { Effect } from "effect";

import type { MessageSummary } from "./types";

import { SessionReadError, SessionStorageNotFoundError, type SessionError } from "./errors";

export type PiContentBlock =
  | { type: "text"; text: string }
  | { type: string; [key: string]: unknown };

export type PiRecord =
  | { type: "session"; id: string; timestamp?: string; cwd?: string }
  | {
      type: "message";
      timestamp: string;
      message: { role: string; content: string | ReadonlyArray<PiContentBlock> };
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const parsePiLine = (line: string): PiRecord | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    return null;
  }

  if (parsed.type === "session" && typeof parsed.id === "string") {
    return {
      type: "session",
      id: parsed.id,
      timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : undefined,
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined,
    };
  }

  if (
    parsed.type === "message" &&
    typeof parsed.timestamp === "string" &&
    isRecord(parsed.message) &&
    typeof parsed.message.role === "string" &&
    (typeof parsed.message.content === "string" || Array.isArray(parsed.message.content))
  ) {
    return parsed as Extract<PiRecord, { type: "message" }>;
  }

  return null;
};

export const extractPiText = (content: string | ReadonlyArray<PiContentBlock>): string => {
  if (typeof content === "string") {
    return content;
  }

  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        block.type === "text" && typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n");
};

export const extractPiTitle = (records: ReadonlyArray<PiRecord>): string => {
  const firstUser = records.find(
    (record): record is Extract<PiRecord, { type: "message" }> =>
      record.type === "message" && record.message.role === "user",
  );
  if (firstUser !== undefined) {
    return extractPiText(firstUser.message.content).slice(0, 100);
  }

  return "Untitled session";
};

const SESSION_ID_REGEX =
  /_([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/u;

export const getPiSessionId = (filePath: string): string => {
  const fileName = filePath.split("/").pop() ?? "";
  const match = SESSION_ID_REGEX.exec(fileName);
  return match?.[1] ?? fileName.replace(/\.jsonl$/u, "");
};

const walkSessionFiles = async (basePath: string): Promise<string[]> => {
  const { Glob } = await import("bun");
  const glob = new Glob("*/*.jsonl");
  return Array.fromAsync(glob.scan({ cwd: basePath, absolute: true }));
};

const readSessionCwd = async (sessionFile: string): Promise<string | null> => {
  try {
    const text = await Bun.file(sessionFile).text();
    const firstLine = text.split("\n")[0] ?? "";
    const record = parsePiLine(firstLine);
    if (record !== null && record.type === "session") {
      return record.cwd ?? null;
    }
    return null;
  } catch {
    return null;
  }
};

export const getPiSessions = (
  basePath: string,
  projectDir: string | null,
): Effect.Effect<string[], SessionError> =>
  Effect.tryPromise({
    try: async () => {
      const allFiles = await walkSessionFiles(basePath);
      if (projectDir === null) {
        return allFiles;
      }

      const cwds = await Promise.all(allFiles.map((file) => readSessionCwd(file)));
      return allFiles.filter((_, i) => cwds[i] === projectDir);
    },
    catch: (error) =>
      new SessionStorageNotFoundError({
        message: error instanceof Error ? error.message : "pi storage directory not found",
        path: basePath,
      }),
  });

export const readPiMessages = (
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
          .map(parsePiLine)
          .filter((record): record is PiRecord => record !== null);

        const title = extractPiTitle(records);
        const sessionID = getPiSessionId(sessionFile);

        for (const record of records) {
          if (record.type !== "message") continue;
          if (record.message.role !== "user" && record.message.role !== "assistant") continue;

          const body = extractPiText(record.message.content);
          if (body.length === 0) continue;

          const createdTimestamp = new Date(record.timestamp).getTime();
          summaries.push({
            sessionID,
            id: `${sessionID}:${record.timestamp}`,
            title,
            body,
            created: Number.isFinite(createdTimestamp) ? createdTimestamp : 0,
            role: record.message.role,
            source: "pi",
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
        message: error instanceof Error ? error.message : "Failed to read pi sessions",
        source: "pi",
      }),
  });
