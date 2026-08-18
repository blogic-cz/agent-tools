import { deduplicateLines, parseTextTable } from "#shared";

import type { BuildJob } from "./types";

type ParsedTable = {
  headers: string[];
  rows: Record<string, string>[];
};

const TIMESTAMP_PREFIX_PATTERN = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+/;

const TIMESTAMP_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+$/;

const ERROR_MARKER_PATTERN = /(##\[error\]|error:|Error:|ERROR|FAILED)/;

function stripTimestampPrefix(line: string): string {
  return line.replace(TIMESTAMP_PREFIX_PATTERN, "");
}

function isNoiseLine(line: string): boolean {
  const trimmed = stripTimestampPrefix(line).trimStart();

  if (trimmed.startsWith("##[section]")) {
    return true;
  }

  if (trimmed.startsWith("##[debug]")) {
    return true;
  }

  if (/^Downloading\b/i.test(trimmed)) {
    return true;
  }

  return TIMESTAMP_ONLY_PATTERN.test(line);
}

function looksLikeTextTable(text: string): boolean {
  const firstLine = text.split(/\r?\n/, 1)[0]?.trimEnd() ?? "";

  if (firstLine.length === 0) {
    return false;
  }

  return /^[A-Z][A-Z0-9_ -]*(\s{2,}[A-Z][A-Z0-9_ -]*)+$/.test(firstLine);
}

export function transformBuildLogContent(rawLog: string): string {
  if (rawLog.length === 0) {
    return "";
  }

  const hadTrailingNewline = rawLog.endsWith("\n");

  const deduplicated = deduplicateLines(rawLog, {
    normalizeTimestamps: true,
    normalizeUUIDs: true,
  });

  const keptLines = deduplicated
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .filter((line) => !isNoiseLine(line));

  const errorLines: string[] = [];
  const nonErrorLines: string[] = [];

  for (const line of keptLines) {
    if (ERROR_MARKER_PATTERN.test(line)) {
      errorLines.push(line);
    } else {
      nonErrorLines.push(line);
    }
  }

  const transformed = [...errorLines, ...nonErrorLines].join("\n");

  if (hadTrailingNewline && transformed.length > 0) {
    return `${transformed}\n`;
  }

  return transformed;
}

export function transformCmdOutput(
  rawOutput: string,
): string | Record<string, unknown> | unknown[] | ParsedTable {
  if (rawOutput.length === 0) {
    return "";
  }

  const trimmed = rawOutput.trim();

  const parsedJson = (() => {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return undefined;
    }
  })();

  if (typeof parsedJson === "object" && parsedJson !== null) {
    return parsedJson as Record<string, unknown> | unknown[];
  }

  if (looksLikeTextTable(trimmed)) {
    return parseTextTable(trimmed);
  }

  const lineCount = trimmed.split(/\r?\n/).length;
  if (lineCount > 50) {
    return deduplicateLines(trimmed);
  }

  return trimmed;
}

export function transformTimeline(records: BuildJob[]): BuildJob[] {
  return records.filter((record) => {
    if (record.type === "Stage" || record.type === "Job") {
      return true;
    }

    return (record.errorCount ?? 0) > 0 || (record.warningCount ?? 0) > 0;
  });
}
