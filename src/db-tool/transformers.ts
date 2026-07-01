import { stripEmptyColumns, truncateRows } from "#shared";

export const DEFAULT_ROW_LIMIT = 50;
export const MAX_VALUE_LENGTH = 200;

export type TransformResult = {
  data: Record<string, unknown>[];
  truncated: boolean;
  total: number;
  showing: number;
};

function truncateValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  if (value.length <= MAX_VALUE_LENGTH) {
    return value;
  }

  return `${value.slice(0, MAX_VALUE_LENGTH)}...`;
}

export function transformQueryResult(
  data: Record<string, unknown>[],
  // limit 0 (or negative) means "no row cap".
  limit: number = DEFAULT_ROW_LIMIT,
): TransformResult {
  const withoutEmptyColumns = stripEmptyColumns(data);
  const truncatedValues = withoutEmptyColumns.map((record) =>
    Object.fromEntries(Object.entries(record).map(([key, value]) => [key, truncateValue(value)])),
  );
  const effectiveLimit = limit > 0 ? limit : Number.POSITIVE_INFINITY;
  const { rows, truncated, total, showing } = truncateRows(truncatedValues, effectiveLimit);

  return {
    data: rows,
    truncated,
    total,
    showing,
  };
}
