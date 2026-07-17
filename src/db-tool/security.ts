import type { DbMutationOperation, SchemaErrorInfo } from "./types";

const MUTATION_PATTERNS = [
  /^\s*UPDATE\s+/i,
  /^\s*INSERT\s+/i,
  /^\s*DELETE\s+/i,
  /^\s*TRUNCATE\s+/i,
  /^\s*DROP\s+/i,
  /^\s*ALTER\s+/i,
  /^\s*CREATE\s+/i,
];

const ALLOWABLE_MUTATION_PATTERNS: Array<[DbMutationOperation, RegExp]> = [
  ["insert", /^\s*INSERT\s+/i],
  ["update", /^\s*UPDATE\s+/i],
  ["delete", /^\s*DELETE\s+/i],
];

const TABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/;
const IDENTIFIER_PATTERN = String.raw`(?:"[^"]+"|[a-zA-Z_][a-zA-Z0-9_]*)`;
const QUALIFIED_IDENTIFIER_PATTERN = `${IDENTIFIER_PATTERN}(?:\\s*\\.\\s*${IDENTIFIER_PATTERN})?`;
const MUTATION_TARGET_PATTERNS: Array<[DbMutationOperation, RegExp]> = [
  ["insert", new RegExp(String.raw`^\s*INSERT\s+INTO\s+(${QUALIFIED_IDENTIFIER_PATTERN})`, "i")],
  ["update", new RegExp(String.raw`^\s*UPDATE\s+(${QUALIFIED_IDENTIFIER_PATTERN})`, "i")],
  ["delete", new RegExp(String.raw`^\s*DELETE\s+FROM\s+(${QUALIFIED_IDENTIFIER_PATTERN})`, "i")],
];

/**
 * Strip SQL comments (block and line) while preserving string literals.
 * This prevents bypass via inline comment masking before DELETE statements.
 */
export function stripSqlComments(sql: string): string {
  let result = "";
  let i = 0;
  const len = sql.length;

  while (i < len) {
    const ch = sql[i];
    const next = i + 1 < len ? sql[i + 1] : "";

    if (ch === "$") {
      const open = DOLLAR_TAG_OPEN.exec(sql.slice(i));
      if (open) {
        const tag = open[0];
        const closeAt = sql.indexOf(tag, i + tag.length);
        const stop = closeAt === -1 ? len : closeAt + tag.length;
        result += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }

    // Single-quoted string literal — skip through
    if (ch === "'") {
      result += ch;
      i++;
      while (i < len) {
        if (sql[i] === "'" && i + 1 < len && sql[i + 1] === "'") {
          result += "''";
          i += 2;
        } else if (sql[i] === "'") {
          result += "'";
          i++;
          break;
        } else {
          result += sql[i];
          i++;
        }
      }
      continue;
    }

    // Block comment /* ... */
    if (ch === "/" && next === "*") {
      i += 2;
      while (i + 1 < len && !(sql[i] === "*" && sql[i + 1] === "/")) {
        i++;
      }
      i += 2; // skip closing */
      result += " "; // replace comment with space
      continue;
    }

    // Line comment -- ...
    if (ch === "-" && next === "-") {
      i += 2;
      while (i < len && sql[i] !== "\n") {
        i++;
      }
      result += " ";
      continue;
    }

    result += ch;
    i++;
  }

  return result;
}

const DOLLAR_TAG_OPEN = /^\$([a-zA-Z_][a-zA-Z0-9_]*)?\$/;

export function splitSqlStatements(sql: string): string[] {
  const stripped = stripSqlComments(sql);
  const statements: string[] = [];
  const len = stripped.length;
  let current = "";
  let i = 0;
  while (i < len) {
    const ch = stripped[i];

    if (ch === "$") {
      const open = DOLLAR_TAG_OPEN.exec(stripped.slice(i));
      if (open) {
        const tag = open[0];
        const closeAt = stripped.indexOf(tag, i + tag.length);
        const stop = closeAt === -1 ? len : closeAt + tag.length;
        current += stripped.slice(i, stop);
        i = stop;
        continue;
      }
    }

    if (ch === "'") {
      const prev = i > 0 ? stripped[i - 1] : "";
      const beforePrev = i > 1 ? stripped[i - 2] : "";
      const isEscapeString = (prev === "E" || prev === "e") && !/[a-zA-Z0-9_]/.test(beforePrev);
      current += ch;
      i++;
      while (i < len) {
        const c = stripped[i];
        if (isEscapeString && c === "\\" && i + 1 < len) {
          current += c + stripped[i + 1];
          i += 2;
          continue;
        }
        if (c === "'" && stripped[i + 1] === "'") {
          current += "''";
          i += 2;
          continue;
        }
        current += c;
        i++;
        if (c === "'") break;
      }
      continue;
    }

    if (ch === ";") {
      if (current.trim() !== "") statements.push(current);
      current = "";
      i++;
      continue;
    }

    current += ch;
    i++;
  }
  if (current.trim() !== "") statements.push(current);
  return statements;
}

export function isMutationQuery(sql: string): boolean {
  return splitSqlStatements(sql).some((statement) =>
    MUTATION_PATTERNS.some((pattern) => pattern.test(statement)),
  );
}

export type MutationPolicy = {
  readonly allowMutations: boolean;
  readonly allowedMutations: readonly DbMutationOperation[];
  readonly allowedMutationTargets: Partial<Record<DbMutationOperation, readonly string[]>>;
};

export function findDisallowedMutation(
  sql: string,
  policy: MutationPolicy,
): { statement: string; operation?: DbMutationOperation; target?: string } | null {
  if (policy.allowMutations) return null;
  for (const statement of splitSqlStatements(sql)) {
    const mutates = MUTATION_PATTERNS.some((pattern) => pattern.test(statement));
    if (!mutates) continue;
    const operation = getAllowedMutationOperation(statement);
    if (operation !== undefined && policy.allowedMutations.includes(operation)) continue;
    const target = operation !== undefined ? getMutationTarget(statement) : undefined;
    if (
      operation !== undefined &&
      target !== undefined &&
      (policy.allowedMutationTargets[operation] ?? []).includes(target)
    ) {
      continue;
    }
    return { statement, operation, target };
  }
  return null;
}

export function getAllowedMutationOperation(sql: string): DbMutationOperation | undefined {
  const stripped = stripSqlComments(sql);
  return ALLOWABLE_MUTATION_PATTERNS.find(([, pattern]) => pattern.test(stripped))?.[0];
}

function normalizeSqlIdentifier(identifier: string): string {
  return identifier
    .split(".")
    .map((part) =>
      part
        .trim()
        .replace(/^"(.+)"$/, "$1")
        .replace(/""/g, '"'),
    )
    .join(".");
}

export function getMutationTarget(sql: string): string | undefined {
  const stripped = stripSqlComments(sql);
  const operation = getAllowedMutationOperation(stripped);
  const pattern = MUTATION_TARGET_PATTERNS.find(([candidate]) => candidate === operation)?.[1];
  const target = pattern?.exec(stripped)?.[1];

  return target === undefined ? undefined : normalizeSqlIdentifier(target);
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
