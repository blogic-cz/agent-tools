import { Context, Effect, Layer } from "effect";

import { DbQueryError } from "./errors";
import { redactSensitiveText } from "#shared/content-security";

export type DbConnection = {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly database: string;
  readonly password: string;
  readonly readOnly: boolean;
  /** Server-side statement_timeout in milliseconds. 0 turns the limit off. */
  readonly queryTimeoutMs: number;
};

/** Default server-side limit for one statement. Low on purpose: a runaway agent query must not load the database. */
export const DEFAULT_QUERY_TIMEOUT_MS = 5000;
/** lock_timeout never exceeds this, so a statement that waits on a lock does not queue other sessions behind it. */
export const MAX_LOCK_TIMEOUT_MS = 2000;

const STATEMENT_TIMEOUT_HINT =
  "The server cancelled the query at the configured time limit. Run it again with --explain to see the plan, then narrow it with a WHERE on an indexed column or a LIMIT. To allow longer queries, raise database.<profile>.queryTimeoutMs in agent-tools.json5.";

export type DbQueryOutcome = {
  readonly rows: Record<string, unknown>[];
  readonly rowCount: number;
  readonly command: string;
};

type BunQueryResult = unknown[] & { count?: number; command?: string };

export const toErrorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const toDbQueryError = (cause: unknown, sql: string): DbQueryError => {
  const message = redactSensitiveText(toErrorMessage(cause));
  return /statement timeout/i.test(message)
    ? new DbQueryError({ message, sql, stderr: message, hint: STATEMENT_TIMEOUT_HINT })
    : new DbQueryError({ message, sql, stderr: message });
};

const startupSettings = (connection: DbConnection): Record<string, string> => ({
  ...(connection.readOnly ? { default_transaction_read_only: "on" } : {}),
  ...(connection.queryTimeoutMs > 0
    ? {
        statement_timeout: String(connection.queryTimeoutMs),
        lock_timeout: String(Math.min(connection.queryTimeoutMs, MAX_LOCK_TIMEOUT_MS)),
      }
    : {}),
});

const runWithBunSql = (connection: DbConnection, sql: string) =>
  Effect.tryPromise({
    try: async (): Promise<DbQueryOutcome> => {
      if (!Number.isSafeInteger(connection.queryTimeoutMs) || connection.queryTimeoutMs < 0) {
        throw new Error(
          `Refusing to query: queryTimeoutMs must be a non-negative integer, got ${connection.queryTimeoutMs}.`,
        );
      }
      const settings = startupSettings(connection);
      const client = new Bun.SQL({
        hostname: connection.host,
        port: connection.port,
        username: connection.user,
        password: connection.password,
        database: connection.database,
        max: 1,
        // Startup-packet GUCs: cover every pooled connection, unlike a post-connect SET.
        ...(Object.keys(settings).length > 0 ? { connection: settings } : {}),
      });

      try {
        if (connection.readOnly) {
          const [state] = (await client.unsafe("SHOW transaction_read_only")) as {
            transaction_read_only?: string;
          }[];
          if (state?.transaction_read_only !== "on") {
            throw new Error(
              "Refusing to query: the read-only session setting was not accepted by the server, so writes would not be blocked.",
            );
          }
        }

        if (connection.queryTimeoutMs > 0) {
          const [state] = (await client.unsafe(
            "SELECT setting FROM pg_settings WHERE name = 'statement_timeout'",
          )) as { setting?: string }[];
          if (state?.setting !== settings.statement_timeout) {
            throw new Error(
              "Refusing to query: the statement_timeout session setting was not accepted by the server, so a slow query would not be stopped.",
            );
          }
        }

        const result = (await client.unsafe(sql)) as BunQueryResult;
        const rows = Array.isArray(result) ? (result as Record<string, unknown>[]) : [];

        return {
          rows,
          rowCount: result.count ?? rows.length,
          command: result.command ?? "",
        };
      } finally {
        // A rejecting close() would replace the real query error via try/finally semantics.
        await client.close().catch(() => undefined);
      }
    },
    catch: (cause) => toDbQueryError(cause, sql),
  });

export class DbSqlClient extends Context.Service<
  DbSqlClient,
  {
    readonly run: (
      connection: DbConnection,
      sql: string,
    ) => Effect.Effect<DbQueryOutcome, DbQueryError>;
  }
>()("@agent-tools/DbSqlClient") {
  static readonly layer = Layer.succeed(DbSqlClient, { run: runWithBunSql });
}
