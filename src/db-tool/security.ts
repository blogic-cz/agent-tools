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

const DOLLAR_QUOTE_TAG = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;

/**
 * Strip SQL comments (block and line) and empty out every string literal, keeping only
 * double-quoted identifiers verbatim because the mutation-target parser needs them.
 * Single quotes, double-quoted identifiers and dollar-quoted bodies must all be tracked:
 * a quote or comment token surviving inside a region another check reads differently is a
 * guard bypass. `SELECT * FROM "weird--table"; DROP TABLE users` would lose its statement
 * separator to a phantom comment, and `SELECT $$O\'Brien$$ AS n; DROP TABLE users` would
 * leave an unpaired apostrophe that swallows the separator instead.
 */
export function stripSqlComments(sql: string): string {
  let result = "";
  let i = 0;
  const len = sql.length;

  while (i < len) {
    const ch = sql[i];
    const next = i + 1 < len ? sql[i + 1] : "";

    if (ch === "'" || ch === '"') {
      const keepBody = ch === '"';
      result += ch;
      i++;
      while (i < len) {
        if (sql[i] === ch && sql[i + 1] === ch) {
          if (keepBody) result += ch + ch;
          i += 2;
        } else if (sql[i] === ch) {
          result += ch;
          i++;
          break;
        } else {
          if (keepBody) result += sql[i];
          i++;
        }
      }
      continue;
    }

    if (ch === "$") {
      const tag = DOLLAR_QUOTE_TAG.exec(sql.slice(i))?.[0];
      if (tag) {
        const closing = sql.indexOf(tag, i + tag.length);
        const stop = closing === -1 ? len : closing + tag.length;
        result += closing === -1 ? tag : tag + tag;
        i = stop;
        continue;
      }
    }

    // Postgres block comments nest, so track depth rather than stopping at the first */.
    if (ch === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i + 1 < len && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      if (depth > 0) {
        i = len;
      }
      result += " ";
      continue;
    }

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

/**
 * Postgres runs every statement in a simple-query batch, but MUTATION_PATTERNS only match the
 * first one, so `select 1; delete from x` would otherwise pass the guard as a plain read.
 * Dollar-quoted bodies containing `;` are rejected as well: this fails closed by design.
 */
export function hasMultipleStatements(sql: string): boolean {
  const stripped = stripSqlComments(sql);
  let index = 0;

  while (index < stripped.length) {
    const char = stripped[index];

    if (char === "'" || char === '"') {
      index++;
      while (index < stripped.length) {
        if (stripped[index] === char && stripped[index + 1] === char) {
          index += 2;
          continue;
        }
        if (stripped[index] === char) {
          index++;
          break;
        }
        index++;
      }
      continue;
    }

    if (char === ";" && stripped.slice(index + 1).trim().length > 0) {
      return true;
    }

    index++;
  }

  return false;
}

export function isMutationQuery(sql: string): boolean {
  const stripped = stripSqlComments(sql);
  return MUTATION_PATTERNS.some((pattern) => pattern.test(stripped));
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
