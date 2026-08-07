import { Context, Effect, Layer } from "effect";

import { DbQueryError } from "./errors";

export type DbConnection = {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly database: string;
  readonly password: string;
  readonly readOnly: boolean;
};

export type DbQueryOutcome = {
  readonly rows: Record<string, unknown>[];
  readonly rowCount: number;
  readonly command: string;
};

type BunQueryResult = unknown[] & { count?: number; command?: string };

export const toErrorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const runWithBunSql = (connection: DbConnection, sql: string) =>
  Effect.tryPromise({
    try: async (): Promise<DbQueryOutcome> => {
      const client = new Bun.SQL({
        hostname: connection.host,
        port: connection.port,
        username: connection.user,
        password: connection.password,
        database: connection.database,
        max: 1,
        // Startup-packet GUC: covers every pooled connection, unlike a post-connect SET.
        ...(connection.readOnly ? { connection: { default_transaction_read_only: "on" } } : {}),
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

        const result = (await client.unsafe(sql)) as BunQueryResult;
        const rows = Array.isArray(result) ? (result as Record<string, unknown>[]) : [];

        return {
          rows,
          rowCount: result.count ?? rows.length,
          command: result.command ?? "",
        };
      } finally {
        await client.close();
      }
    },
    catch: (cause) => {
      const message = toErrorMessage(cause);
      return new DbQueryError({ message, sql, stderr: message });
    },
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
