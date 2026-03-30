type DeduplicateOptions = {
  normalizeTimestamps?: boolean;
  normalizeUUIDs?: boolean;
  normalizeHex?: boolean;
  normalizeNumbers?: boolean;
  normalizePaths?: boolean;
  maxUniqueLines?: number;
};

const TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d]*Z?/g;
const SYSLOG_TIMESTAMP_PATTERN = /^[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}/gm;
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HEX_PATTERN = /0x[0-9a-f]{6,}/gi;
const LONG_HEX_PATTERN = /\b[0-9a-f]{12,}\b/gi;
const LARGE_NUMBER_PATTERN = /\b\d{5,}\b/g;
const PATH_PATTERN = /\/[\w\-./]+/g;

function normalizeLine(
  line: string,
  options: Required<Omit<DeduplicateOptions, "maxUniqueLines">>,
): string {
  let normalized = line;

  if (options.normalizeTimestamps) {
    normalized = normalized.replace(TIMESTAMP_PATTERN, "<TIMESTAMP>");
    normalized = normalized.replace(SYSLOG_TIMESTAMP_PATTERN, "<TIMESTAMP>");
  }

  if (options.normalizeUUIDs) {
    normalized = normalized.replace(UUID_PATTERN, "<UUID>");
  }

  if (options.normalizeHex) {
    normalized = normalized.replace(HEX_PATTERN, "<HEX>");
    normalized = normalized.replace(LONG_HEX_PATTERN, "<HEX>");
  }

  if (options.normalizeNumbers) {
    normalized = normalized.replace(LARGE_NUMBER_PATTERN, "<NUM>");
  }

  if (options.normalizePaths) {
    normalized = normalized.replace(PATH_PATTERN, "<PATH>");
  }

  return normalized;
}

/**
 * Deduplicate consecutive identical lines after normalization.
 * Normalizes timestamps, UUIDs, hex strings, large numbers before comparison.
 * Returns lines with [×N] suffix for collapsed runs.
 */
export function deduplicateLines(text: string, options: DeduplicateOptions = {}): string {
  if (text.length === 0) {
    return "";
  }

  const normalizedOptions: Required<Omit<DeduplicateOptions, "maxUniqueLines">> = {
    normalizeTimestamps: options.normalizeTimestamps ?? true,
    normalizeUUIDs: options.normalizeUUIDs ?? true,
    normalizeHex: options.normalizeHex ?? true,
    normalizeNumbers: options.normalizeNumbers ?? false,
    normalizePaths: options.normalizePaths ?? false,
  };

  const lines = text.split(/\r?\n/);
  const output: string[] = [];

  let previousNormalized: string | undefined;
  let runLine = "";
  let runCount = 0;

  const flushRun = () => {
    if (runCount === 0) {
      return;
    }

    output.push(runCount > 1 ? `${runLine} [×${runCount}]` : runLine);
  };

  for (const line of lines) {
    const normalized = normalizeLine(line, normalizedOptions);

    if (previousNormalized !== undefined && normalized === previousNormalized) {
      runCount += 1;
      continue;
    }

    flushRun();

    if (typeof options.maxUniqueLines === "number" && output.length >= options.maxUniqueLines) {
      return output.join("\n");
    }

    previousNormalized = normalized;
    runLine = line;
    runCount = 1;
  }

  flushRun();

  if (typeof options.maxUniqueLines === "number") {
    return output.slice(0, options.maxUniqueLines).join("\n");
  }

  return output.join("\n");
}

function getColumnStarts(headerLine: string): number[] {
  const starts: number[] = [];
  const len = headerLine.length;
  let i = 0;

  while (i < len) {
    while (i < len && headerLine[i] === " ") {
      i += 1;
    }

    if (i >= len) {
      break;
    }

    starts.push(i);

    while (i < len) {
      if (headerLine[i] === " " && headerLine[i + 1] === " ") {
        break;
      }
      i += 1;
    }

    while (i < len && headerLine[i] === " ") {
      i += 1;
    }
  }

  return starts;
}

function parseHeaderAtColumns(headerLine: string, columnStarts: number[]): string[] {
  const headers: string[] = [];

  for (let i = 0; i < columnStarts.length; i += 1) {
    const start = columnStarts[i];
    const end = i + 1 < columnStarts.length ? columnStarts[i + 1] : headerLine.length;
    const raw = headerLine.slice(start, end).trim();
    headers.push(raw.replace(/\s+/g, "_"));
  }

  return headers;
}

/**
 * Parse kubectl-style whitespace-aligned text tables.
 * Handles multi-word headers (e.g., "NOMINATED NODE" → "NOMINATED_NODE").
 * Returns structured array of row objects keyed by header name.
 */
export function parseTextTable(text: string): {
  headers: string[];
  rows: Record<string, string>[];
} {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    return { headers: [], rows: [] };
  }

  const headerLine = lines[0];
  const columnStarts = getColumnStarts(headerLine);
  const headers = parseHeaderAtColumns(headerLine, columnStarts);

  const rows = lines.slice(1).map((line) => {
    const row: Record<string, string> = {};
    const values = line.trim().split(/\s{2,}/);

    for (let i = 0; i < headers.length; i += 1) {
      row[headers[i]] = values[i] ?? "";
    }

    return row;
  });

  return { headers, rows };
}

/**
 * Count occurrences of values for a given field across items.
 * Returns a map of value → count, sorted by count descending.
 */
export function aggregateByField<T extends Record<string, unknown>>(
  items: T[],
  field: keyof T & string,
): Record<string, number> {
  const counts = new Map<string, number>();

  for (const item of items) {
    const value = item[field];
    if (value === null || value === undefined) {
      continue;
    }

    const key = String(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const sortedEntries: Array<[string, number]> = [];

  for (const entry of counts.entries()) {
    const insertAt = sortedEntries.findIndex(([key, count]) => {
      if (entry[1] !== count) {
        return entry[1] > count;
      }
      return entry[0].localeCompare(key) < 0;
    });

    if (insertAt === -1) {
      sortedEntries.push(entry);
    } else {
      sortedEntries.splice(insertAt, 0, entry);
    }
  }

  return Object.fromEntries(sortedEntries);
}

/**
 * Format aggregated counts into a human-readable summary string.
 * Example: formatCountSummary({Running: 30, Error: 3}, 33, "pods") → "33 pods: 30 Running, 3 Error"
 */
export function formatCountSummary(
  counts: Record<string, number>,
  total: number,
  label: string,
): string {
  const parts = Object.entries(counts).map(([key, count]) => `${count} ${key}`);

  if (parts.length === 0) {
    return `${total} ${label}`;
  }

  return `${total} ${label}: ${parts.join(", ")}`;
}

/**
 * Truncate an array of rows to a maximum length, returning metadata about truncation.
 */
export function truncateRows<T>(
  data: T[],
  limit: number,
): { rows: T[]; truncated: boolean; total: number; showing: number } {
  const safeLimit = Math.max(0, limit);
  const rows = data.slice(0, safeLimit);

  return {
    rows,
    truncated: data.length > safeLimit,
    total: data.length,
    showing: rows.length,
  };
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true;
  }

  if (typeof value === "string") {
    return value.trim().length === 0;
  }

  return false;
}

/**
 * Remove columns/keys from records where ALL values are empty/null/undefined.
 * Optionally remove columns where >threshold% of values are empty.
 */
export function stripEmptyColumns<T extends Record<string, unknown>>(
  records: T[],
  threshold = 1.0,
): T[] {
  if (records.length === 0) {
    return records;
  }

  const boundedThreshold = Math.min(Math.max(threshold, 0), 1);
  const keys = new Set<string>();

  for (const record of records) {
    for (const key of Object.keys(record)) {
      keys.add(key);
    }
  }

  const keysToRemove = new Set<string>();

  for (const key of keys) {
    let emptyCount = 0;

    for (const record of records) {
      if (isEmptyValue(record[key])) {
        emptyCount += 1;
      }
    }

    const emptyRatio = emptyCount / records.length;
    if (emptyRatio >= boundedThreshold) {
      keysToRemove.add(key);
    }
  }

  return records.map((record) => {
    const nextEntries = Object.entries(record).filter(([key]) => !keysToRemove.has(key));
    return Object.fromEntries(nextEntries) as T;
  });
}
