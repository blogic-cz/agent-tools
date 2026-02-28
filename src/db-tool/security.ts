import type { SchemaErrorInfo } from "./types";

const MUTATION_PATTERNS = [
  /^\s*UPDATE\s+/i,
  /^\s*INSERT\s+/i,
  /^\s*DELETE\s+/i,
  /^\s*TRUNCATE\s+/i,
  /^\s*DROP\s+/i,
  /^\s*ALTER\s+/i,
  /^\s*CREATE\s+/i,
];

const TABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function isMutationQuery(sql: string): boolean {
  return MUTATION_PATTERNS.some((pattern) => pattern.test(sql));
}

export function isValidTableName(tableName: string): boolean {
  return TABLE_NAME_PATTERN.test(tableName);
}

export function detectSchemaError(stderr: string, sql: string): SchemaErrorInfo {
  const trimmedError = stderr.trim();

  if (!trimmedError.includes("does not exist")) {
    return {
      type: null,
      missingName: null,
      tableName: null,
    };
  }

  const relationMatch = trimmedError.match(/relation "([^"]+)" does not exist/);
  if (relationMatch) {
    return {
      type: "table_not_found",
      missingName: relationMatch[1],
      tableName: null,
    };
  }

  const columnMatch = trimmedError.match(/column "([^"]+)" does not exist/);
  if (columnMatch) {
    const tableFromSql = sql.match(/FROM\s+["']?(\w+)["']?/i);
    return {
      type: "column_not_found",
      missingName: columnMatch[1],
      tableName: tableFromSql?.[1] ?? null,
    };
  }

  return { type: null, missingName: null, tableName: null };
}
