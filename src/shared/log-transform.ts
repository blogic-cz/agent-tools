import { deduplicateLines } from "./transform";

type LogLevel = "ERROR" | "WARN" | "INFO" | "DEBUG";

type ParsedLogLine = {
  level: LogLevel;
  timestamp?: string;
  message: string;
  originalIndex: number;
};

const TIMESTAMP_FIELDS = ["timestamp", "ts", "time", "@timestamp", "datetime"] as const;
const LEVEL_FIELDS = ["level", "severity", "lvl", "log.level"] as const;
const MESSAGE_FIELDS = ["message", "msg", "log", "text"] as const;
const ERROR_FIELDS = ["error", "err", "stack", "exception", "error.message"] as const;

const LEVEL_ORDER: ReadonlyArray<LogLevel> = ["ERROR", "WARN", "INFO", "DEBUG"];

function getByPath(obj: unknown, path: string): unknown {
  if (typeof obj !== "object" || obj === null) {
    return undefined;
  }

  if (!path.includes(".")) {
    return (obj as Record<string, unknown>)[path];
  }

  const parts = path.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

function toText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (value && typeof value === "object") {
    if ("message" in value) {
      const nestedMessage = toText((value as Record<string, unknown>).message);
      if (nestedMessage) {
        return nestedMessage;
      }
    }

    try {
      return JSON.stringify(value);
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function formatTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && value > 1_000_000_000_000) {
    return new Date(value).toISOString();
  }
  if (typeof value === "number" && value > 1_000_000_000) {
    return new Date(value * 1000).toISOString();
  }
  return undefined;
}

function firstMappedField(
  obj: unknown,
  fields: ReadonlyArray<string>,
  isTimestamp = false,
): string | undefined {
  for (const field of fields) {
    const raw = getByPath(obj, field);
    if (isTimestamp) {
      const formatted = formatTimestamp(raw);
      if (formatted) return formatted;
    }
    const value = toText(raw);
    if (value) {
      return value;
    }
  }

  return undefined;
}

// Pino numeric levels: 10=trace, 20=debug, 30=info, 40=warn, 50=error, 60=fatal
function normalizeLevel(rawLevel: string | undefined): LogLevel {
  const normalized = rawLevel?.trim().toLowerCase();

  if (!normalized) {
    return "INFO";
  }

  const numericLevel = Number(normalized);
  if (Number.isFinite(numericLevel)) {
    if (numericLevel >= 50) return "ERROR";
    if (numericLevel >= 40) return "WARN";
    if (numericLevel >= 30) return "INFO";
    return "DEBUG";
  }

  if (normalized === "error" || normalized === "err" || normalized === "fatal") {
    return "ERROR";
  }

  if (normalized === "warn" || normalized === "warning") {
    return "WARN";
  }

  if (normalized === "info") {
    return "INFO";
  }

  if (normalized === "debug" || normalized === "trace") {
    return "DEBUG";
  }

  return "INFO";
}

function formatLine({ level, timestamp, message }: ParsedLogLine): string {
  if (timestamp) {
    return `[${timestamp}] [${level}] ${message}`;
  }

  return `[${level}] ${message}`;
}

function parseJsonLogLine(line: string, originalIndex: number): ParsedLogLine {
  try {
    const parsed = JSON.parse(line) as unknown;
    const timestamp = firstMappedField(parsed, TIMESTAMP_FIELDS, true);
    const level = normalizeLevel(firstMappedField(parsed, LEVEL_FIELDS));
    const message =
      firstMappedField(parsed, MESSAGE_FIELDS) ??
      firstMappedField(parsed, ERROR_FIELDS) ??
      line.trim();

    return {
      level,
      timestamp,
      message,
      originalIndex,
    };
  } catch {
    return {
      level: "INFO",
      message: line.trim(),
      originalIndex,
    };
  }
}

function isJsonMode(lines: ReadonlyArray<string>): boolean {
  const firstNonEmpty = lines.find((line) => line.trim().length > 0);
  if (!firstNonEmpty) {
    return false;
  }

  try {
    const parsed = JSON.parse(firstNonEmpty) as unknown;
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
}

function groupHeader(level: LogLevel, count: number): string {
  switch (level) {
    case "ERROR":
      return `--- errors (${count}) ---`;
    case "WARN":
      return `--- warnings (${count}) ---`;
    case "INFO":
      return `--- info (${count}) ---`;
    case "DEBUG":
      return `--- debug (${count}) ---`;
  }
}

function transformJsonLines(lines: ReadonlyArray<string>): string {
  const parsedLines = lines
    .map((line, originalIndex) => ({ line, originalIndex }))
    .filter(({ line }) => line.trim().length > 0)
    .map(({ line, originalIndex }) => parseJsonLogLine(line, originalIndex));

  if (parsedLines.length === 0) {
    return "";
  }

  const ordered = LEVEL_ORDER.flatMap((level) =>
    parsedLines
      .filter((entry) => entry.level === level)
      .sort((a, b) => a.originalIndex - b.originalIndex),
  );

  const output: Array<string> = [];

  for (const level of LEVEL_ORDER) {
    const group = ordered.filter((entry) => entry.level === level);
    if (group.length === 0) {
      continue;
    }

    output.push(groupHeader(level, group.length));
    output.push(...group.map(formatLine));
  }

  return deduplicateLines(output.join("\n"));
}

export function transformLogOutput(rawOutput: string): string {
  if (rawOutput.length === 0) {
    return "";
  }

  const lines = rawOutput.split(/\r?\n/);

  if (isJsonMode(lines)) {
    return transformJsonLines(lines);
  }

  return deduplicateLines(rawOutput, {
    normalizeTimestamps: true,
    normalizeUUIDs: true,
  });
}
