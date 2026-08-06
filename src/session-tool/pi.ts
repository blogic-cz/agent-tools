import { Effect } from "effect";
// node:fs/promises, not Bun.file/Bun.Glob: vitest runs under Node, where the Bun globals do not
// exist, and every function below is reached by the suite. See AGENTS.md.
import { open, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type { MessageSummary, SessionSummary } from "./types";

import { SessionReadError, SessionStorageNotFoundError, type SessionError } from "./errors";

export const PI_HEADER_MAX_BYTES = 64 * 1024;
export const PI_SUMMARY_HEAD_MAX_BYTES = 256 * 1024;
export const PI_SUMMARY_TAIL_MAX_BYTES = 256 * 1024;
const PI_READ_CONCURRENCY = 16;

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

export type PiSessionMetadata = SessionSummary & {
  cwd: string | null;
  bytesRead: number;
  parsedLines: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parseJsonRecord = (line: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const timestampValue = (value: unknown): number | null => {
  if (typeof value !== "string") return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
};

export const parsePiLine = (line: string): PiRecord | null => {
  const parsed = parseJsonRecord(line);
  if (parsed === null || typeof parsed.type !== "string") {
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
  const directories = await readdir(basePath, { withFileTypes: true });
  const files = await Promise.all(
    directories
      .filter((entry) => entry.isDirectory())
      .map(async (directory) => {
        const directoryPath = join(basePath, directory.name);
        return (await readdir(directoryPath, { withFileTypes: true }))
          .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
          .map((entry) => join(directoryPath, entry.name));
      }),
  );
  return files.flat();
};

const readSlice = async (filePath: string, start: number, end: number): Promise<string> => {
  const length = Math.max(0, end - start);
  if (length === 0) return "";
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
};

const completeLines = (text: string, startsAtBeginning: boolean, endsAtEnd: boolean): string[] => {
  const lines = text.split(/\r?\n/u);
  if (!startsAtBeginning) lines.shift();
  if (!endsAtEnd && !text.endsWith("\n")) lines.pop();
  return lines.map((line) => line.trim()).filter((line) => line.length > 0);
};

const readPiSessionHeader = async (sessionFile: string) => {
  const { size } = await stat(sessionFile);
  const end = Math.min(size, PI_HEADER_MAX_BYTES);
  const text = await readSlice(sessionFile, 0, end);
  const line = completeLines(text, true, end === size)[0] ?? "";
  const record = parsePiLine(line);
  return record?.type === "session" ? record : null;
};

export const readPiSessionMetadata = async (sessionFile: string): Promise<PiSessionMetadata> => {
  const file = await stat(sessionFile);
  const { size } = file;
  const fullReadLimit = PI_SUMMARY_HEAD_MAX_BYTES + PI_SUMMARY_TAIL_MAX_BYTES;
  const readWhole = size <= fullReadLimit;
  const headEnd = readWhole ? size : PI_SUMMARY_HEAD_MAX_BYTES;
  const tailStart = readWhole ? 0 : Math.max(headEnd, size - PI_SUMMARY_TAIL_MAX_BYTES);
  const tailReadStart = readWhole ? 0 : Math.max(0, tailStart - 1);
  const head = await readSlice(sessionFile, 0, headEnd);
  const tail = readWhole ? head : await readSlice(sessionFile, tailReadStart, size);
  const headLines = completeLines(head, true, headEnd === size);
  const tailLines = readWhole ? [] : completeLines(tail, tailReadStart === 0, true);
  const allLines = [...headLines, ...tailLines];
  const header = parsePiLine(headLines[0] ?? "");
  const records = headLines
    .map(parsePiLine)
    .filter((record): record is PiRecord => record !== null);
  const activityTimestamps = allLines
    .map(parseJsonRecord)
    .filter((record): record is Record<string, unknown> => record !== null)
    .filter((record) => record.type !== "session")
    .map((record) => timestampValue(record.timestamp))
    .filter((timestamp): timestamp is number => timestamp !== null);
  const headerTimestamp = header?.type === "session" ? timestampValue(header.timestamp) : null;
  const createdAt = headerTimestamp ?? activityTimestamps[0] ?? file.mtimeMs;
  const updatedAt = activityTimestamps.length > 0 ? Math.max(...activityTimestamps) : file.mtimeMs;

  return {
    sessionID: getPiSessionId(sessionFile),
    title: extractPiTitle(records),
    createdAt,
    updatedAt,
    source: "pi",
    cwd: header?.type === "session" ? (header.cwd ?? null) : null,
    bytesRead: headEnd + (readWhole ? 0 : size - tailReadStart),
    parsedLines: allLines.length,
  };
};

const mapConcurrent = async <T, R>(
  values: ReadonlyArray<T>,
  transform: (value: T) => Promise<R | null>,
): Promise<R[]> => {
  const results: Array<R | null> = Array.from({ length: values.length }, () => null);
  let next = 0;
  const workers = Array.from({ length: Math.min(PI_READ_CONCURRENCY, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      // eslint-disable-next-line no-await-in-loop -- worker loop intentionally caps file-read concurrency
      results[index] = await transform(values[index]);
    }
  });
  await Promise.all(workers);
  return results.filter((value): value is R => value !== null);
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

      const matching = await mapConcurrent(allFiles, async (file) => {
        try {
          const header = await readPiSessionHeader(file);
          return header?.cwd === projectDir ? file : null;
        } catch {
          return null;
        }
      });
      return matching;
    },
    catch: (error) =>
      new SessionStorageNotFoundError({
        message: error instanceof Error ? error.message : "pi storage directory not found",
        path: basePath,
      }),
  });

export const readPiSessionSummaries = (
  sessionFiles: string[],
): Effect.Effect<SessionSummary[], SessionError> =>
  Effect.tryPromise({
    try: () =>
      mapConcurrent(sessionFiles, async (sessionFile) => {
        try {
          const {
            cwd: _cwd,
            bytesRead: _bytesRead,
            parsedLines: _parsedLines,
            ...summary
          } = await readPiSessionMetadata(sessionFile);
          return summary;
        } catch {
          return null;
        }
      }),
    catch: (error) =>
      new SessionReadError({
        message: error instanceof Error ? error.message : "Failed to read pi session summaries",
        source: "pi",
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
          fileContent = await readFile(sessionFile, "utf8");
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

      return summaries.toSorted((left, right) => right.created - left.created);
    },
    catch: (error) =>
      new SessionReadError({
        message: error instanceof Error ? error.message : "Failed to read pi sessions",
        source: "pi",
      }),
  });
