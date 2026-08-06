import { Effect } from "effect";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import type { MessageSummary } from "./types";

import { SessionReadError, SessionStorageNotFoundError, type SessionError } from "./errors";

export const encodeProjectPath = (dir: string): string => dir.replaceAll(/[/\\:]/g, "-");

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

export type ClaudeCodeRecord =
  | { type: "summary"; summary: string }
  | {
      type: "user";
      timestamp: string;
      uuid: string;
      message: { role: "user"; content: string | ReadonlyArray<ContentBlock> };
    }
  | {
      type: "assistant";
      timestamp: string;
      uuid: string;
      message: { role: "assistant"; content: ReadonlyArray<ContentBlock> };
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isContentBlock = (value: unknown): value is ContentBlock => {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "text":
      return typeof value.text === "string";
    case "thinking":
      return typeof value.thinking === "string";
    case "tool_use":
      return typeof value.id === "string" && typeof value.name === "string";
    case "tool_result":
      return typeof value.tool_use_id === "string" && typeof value.content === "string";
    default:
      return false;
  }
};

const isUserRecord = (
  value: Record<string, unknown>,
): value is Extract<ClaudeCodeRecord, { type: "user" }> => {
  if (
    value.type !== "user" ||
    typeof value.timestamp !== "string" ||
    typeof value.uuid !== "string"
  ) {
    return false;
  }

  if (!isRecord(value.message) || value.message.role !== "user") {
    return false;
  }

  if (typeof value.message.content === "string") {
    return true;
  }

  return Array.isArray(value.message.content) && value.message.content.every(isContentBlock);
};

const isAssistantRecord = (
  value: Record<string, unknown>,
): value is Extract<ClaudeCodeRecord, { type: "assistant" }> => {
  if (
    value.type !== "assistant" ||
    typeof value.timestamp !== "string" ||
    typeof value.uuid !== "string" ||
    !isRecord(value.message) ||
    value.message.role !== "assistant"
  ) {
    return false;
  }

  return Array.isArray(value.message.content) && value.message.content.every(isContentBlock);
};

export const parseJsonlLine = (line: string): ClaudeCodeRecord | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    return null;
  }

  if (parsed.type === "summary" && typeof parsed.summary === "string") {
    return {
      type: "summary",
      summary: parsed.summary,
    };
  }

  if (isUserRecord(parsed)) {
    return parsed;
  }

  if (isAssistantRecord(parsed)) {
    return parsed;
  }

  if (
    parsed.type === "system" ||
    parsed.type === "progress" ||
    parsed.type === "file-history-snapshot" ||
    parsed.type === "queue-operation"
  ) {
    return null;
  }

  return null;
};

export const extractTextFromContent = (content: string | ReadonlyArray<ContentBlock>): string => {
  if (typeof content === "string") {
    return content;
  }

  return content
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
};

export const extractSessionTitle = (records: ReadonlyArray<ClaudeCodeRecord>): string => {
  const summaryRecord = records.find((record) => record.type === "summary");
  if (summaryRecord !== undefined) {
    return summaryRecord.summary;
  }

  const firstUserRecord = records.find((record) => record.type === "user");
  if (firstUserRecord !== undefined) {
    return extractTextFromContent(firstUserRecord.message.content).slice(0, 100);
  }

  return "Untitled session";
};

export const getClaudeCodeSessions = (
  basePath: string,
  projectDir: string | null,
): Effect.Effect<string[], SessionError> =>
  Effect.tryPromise({
    try: async () => {
      const targetProjectDir = projectDir === null ? null : encodeProjectPath(projectDir);
      const projectEntries = await readdir(basePath, { withFileTypes: true });

      const sessionFiles: string[] = [];

      for (const entry of projectEntries) {
        if (!entry.isDirectory()) {
          continue;
        }

        if (targetProjectDir !== null && entry.name !== targetProjectDir) {
          continue;
        }

        const projectPath = join(basePath, entry.name);
        let files: string[];
        try {
          // eslint-disable-next-line eslint/no-await-in-loop -- directory scan must finish before filtering file list
          files = await readdir(projectPath);
        } catch {
          continue;
        }

        for (const fileName of files) {
          if (!fileName.endsWith(".jsonl") || fileName.startsWith("agent-")) {
            continue;
          }

          sessionFiles.push(join(projectPath, fileName));
        }
      }

      return sessionFiles;
    },
    catch: (error) =>
      new SessionStorageNotFoundError({
        message: error instanceof Error ? error.message : "Claude Code storage directory not found",
        path: basePath,
      }),
  });

const getFileNameWithoutExtension = (filePath: string): string => {
  const fileName = basename(filePath);
  if (fileName === "") {
    return "";
  }

  if (!fileName.endsWith(".jsonl")) {
    return fileName;
  }

  return fileName.slice(0, -".jsonl".length);
};

export const readClaudeCodeMessages = (
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
          .map(parseJsonlLine)
          .filter((record): record is ClaudeCodeRecord => record !== null);

        const title = extractSessionTitle(records);
        const sessionID = getFileNameWithoutExtension(sessionFile);

        for (const record of records) {
          if (record.type !== "user" && record.type !== "assistant") {
            continue;
          }

          const createdTimestamp = new Date(record.timestamp).getTime();
          summaries.push({
            sessionID,
            id: record.uuid,
            title,
            body: extractTextFromContent(record.message.content),
            created: Number.isFinite(createdTimestamp) ? createdTimestamp : 0,
            role: record.type,
            source: "claude-code",
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
        message: error instanceof Error ? error.message : "Failed to read Claude Code sessions",
        source: "claude-code",
      }),
  });
