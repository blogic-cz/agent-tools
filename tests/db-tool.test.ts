import { describe, expect, it } from "@effect/vitest";
import { Effect, Result, Layer, Sink, Stream } from "effect";
import type { ChildProcess } from "effect/unstable/process";
import { ChildProcessSpawner } from "effect/unstable/process";

import type { DbError } from "#db/errors";
import type { QueryResult } from "#db/types";
import type { AgentToolsConfig, DatabaseConfig } from "#config/types";

import { ConfigService } from "#config/loader";
import { DbConfigService } from "#db/config-service";
import { DbConnectionError, DbMutationBlockedError, DbParseError, DbQueryError } from "#db/errors";
import { getColumns, getRelationships, getTableNames, SYSTEM_SCHEMAS_SQL } from "#db/schema";
import {
  getAllowedMutationOperation,
  getMutationTarget,
  hasMultipleStatements,
  isValidTableName,
  stripSqlComments,
} from "#db/security";
import { buildApiProbeArgs, DbService, isFullyReadOnly, resolveDbAccessMode } from "#db/service";
import { DbSqlClient, type DbConnection } from "#db/sql-client";

/**
 * Mock DbService layer factory for testing
 * Allows parameterized responses for different test scenarios
 */
function createMockDbServiceLayer(responses: Record<string, QueryResult | DbError>) {
  return Layer.succeed(DbService, {
    executeQuery: (env: string, sql: string) => {
      const key = `query:${env}:${sql}`;
      const response = responses[key];

      if (response instanceof Error) {
        return Effect.fail(response);
      }

      return Effect.succeed(
        response ?? {
          success: false,
          error: "No mock response",
          executionTimeMs: 0,
        },
      );
    },
    executeSchemaQuery: (env: string, mode: string, table?: string) => {
      const key = `schema:${env}:${mode}${table ? `:${table}` : ""}`;
      const response = responses[key];

      if (response instanceof Error) {
        return Effect.fail(response);
      }

      return Effect.succeed(
        response ?? {
          success: false,
          error: "No mock response",
          executionTimeMs: 0,
        },
      );
    },
  });
}

type ShellResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type StandardCommand = ChildProcess.Command & {
  _tag: "StandardCommand";
  command: string;
  args: ReadonlyArray<string>;
};

type PipedCommand = ChildProcess.Command & {
  left: ChildProcess.Command;
  right: ChildProcess.Command;
};

function isStandardCommand(command: ChildProcess.Command): command is StandardCommand {
  return (command as { _tag?: string })._tag === "StandardCommand";
}

function commandToShellString(command: ChildProcess.Command): string {
  if (isStandardCommand(command)) {
    return [command.command, ...command.args].join(" ").trim();
  }

  const pipedCommand = command as PipedCommand;
  return [commandToShellString(pipedCommand.left), commandToShellString(pipedCommand.right)].join(
    " | ",
  );
}

function createMockProcess(result: ShellResult) {
  const encoder = new TextEncoder();

  const stdout = Stream.fromIterable([encoder.encode(result.stdout)]);
  const stderr = Stream.fromIterable([encoder.encode(result.stderr)]);
  const reref: ChildProcessSpawner.Reref = Effect.void;

  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.succeed(undefined),
    stderr,
    stdin: Sink.drain,
    stdout,
    all: Stream.fromIterable([encoder.encode(result.stdout), encoder.encode(result.stderr)]),
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(reref),
  });
}

function createMockChildProcessSpawnerLayer(
  shellResponses: Record<string, ShellResult>,
  observedShellCommands: Array<string>,
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const shellCommand = commandToShellString(command);
      observedShellCommands.push(shellCommand);

      const response = shellResponses[shellCommand] ?? {
        stdout: "",
        stderr: `No mock shell response for command: ${shellCommand}`,
        exitCode: 1,
      };

      return Effect.succeed(createMockProcess(response));
    }),
  );
}

type SqlResponse = {
  rows?: Record<string, unknown>[];
  rowCount?: number;
  command?: string;
  error?: string;
};

type ObservedSql = { sql: string; connection: DbConnection };

function createMockSqlClientLayer(
  sqlResponses: Record<string, SqlResponse>,
  observedSql: Array<ObservedSql>,
) {
  return Layer.succeed(DbSqlClient, {
    run: (connection: DbConnection, sql: string) => {
      observedSql.push({ sql, connection });

      const response = sqlResponses[sql];
      if (!response || response.error !== undefined) {
        const message = response?.error ?? `No mock SQL response for: ${sql}`;
        return Effect.fail(new DbQueryError({ message, sql, stderr: message }));
      }

      const rows = response.rows ?? [];
      return Effect.succeed({
        rows,
        rowCount: response.rowCount ?? rows.length,
        command: response.command ?? "SELECT",
      });
    },
  });
}

function createRealDbServiceLayer(
  config: AgentToolsConfig,
  databaseConfig: DatabaseConfig,
  sqlResponses: Record<string, SqlResponse>,
  observedSql: Array<ObservedSql>,
  shellResponses: Record<string, ShellResult> = {},
  observedShellCommands: Array<string> = [],
) {
  return DbService.layer.pipe(
    Layer.provide(createMockSqlClientLayer(sqlResponses, observedSql)),
    Layer.provide(createMockChildProcessSpawnerLayer(shellResponses, observedShellCommands)),
    Layer.provide(Layer.succeed(ConfigService, config)),
    Layer.provide(Layer.succeed(DbConfigService, databaseConfig)),
  );
}

describe("db schema introspection SQL", () => {
  it("lists user tables across all non-system schemas", () => {
    const sql = getTableNames();

    expect(sql).toContain("schemaname as schema");
    expect(sql).toContain("schemaname || '.' || tablename as qualified_name");
    expect(sql).toContain("schemaname NOT IN ('pg_catalog', 'information_schema')");
    expect(sql).not.toContain("schemaname = 'public'");
  });

  it("shows columns for schema-qualified tables", () => {
    const sql = getColumns("core_business_partners.business_partners");

    expect(sql).toContain("c.table_schema as schema");
    expect(sql).toContain("c.table_name as table");
    expect(sql).toContain("c.table_name = 'business_partners'");
    expect(sql).toContain("c.table_schema = 'core_business_partners'");
  });

  it("shows relationships across all non-system schemas", () => {
    const sql = getRelationships();

    expect(sql).toContain("tc.table_schema as from_schema");
    expect(sql).toContain("ccu.table_schema as to_schema");
    expect(sql).toContain("ccu.constraint_schema = tc.constraint_schema");
    expect(sql).toContain("tc.table_schema NOT IN ('pg_catalog', 'information_schema')");
    expect(sql).not.toContain("tc.table_schema = 'public'");
  });

  it("accepts optional schema-qualified table names only", () => {
    expect(isValidTableName("business_partners")).toBe(true);
    expect(isValidTableName("core_business_partners.business_partners")).toBe(true);
    expect(isValidTableName("core-business-partners.business_partners")).toBe(false);
    expect(isValidTableName("core.business.partners")).toBe(false);
  });

  it("detects explicitly allowable mutation operations", () => {
    expect(getAllowedMutationOperation("insert into users values (1)")).toBe("insert");
    expect(getAllowedMutationOperation("/* comment */ update users set name = 'x'")).toBe("update");
    expect(getAllowedMutationOperation("delete from users")).toBe("delete");
    expect(getAllowedMutationOperation("truncate users")).toBeUndefined();
  });

  it("detects statement batching that would hide a mutation behind a leading read", () => {
    expect(hasMultipleStatements("select 1; delete from foo")).toBe(true);
    expect(hasMultipleStatements("select 1 /* x */; drop table foo")).toBe(true);
    expect(hasMultipleStatements("select 1")).toBe(false);
    expect(hasMultipleStatements("select 1;")).toBe(false);
    expect(hasMultipleStatements("select 1;   \n  ")).toBe(false);
    expect(hasMultipleStatements("select ';' as semi")).toBe(false);
    expect(hasMultipleStatements('select "we;ird" from foo')).toBe(false);
    expect(hasMultipleStatements("select 1 -- ; not a statement")).toBe(false);
  });

  it("does not let a comment token inside a quoted region hide a batched statement", () => {
    expect(hasMultipleStatements('SELECT * FROM "weird--table"; DROP TABLE users')).toBe(true);
    expect(hasMultipleStatements('SELECT * FROM "weird/*x*/table"; DROP TABLE users')).toBe(true);
    expect(hasMultipleStatements("SELECT 'a--b'; DROP TABLE users")).toBe(true);
    expect(hasMultipleStatements("SELECT $$a--b$$; DROP TABLE users")).toBe(true);
    expect(hasMultipleStatements("SELECT $tag$a--b$tag$; DROP TABLE users")).toBe(true);
  });

  it("still strips real comments so masked mutations are classified correctly", () => {
    expect(stripSqlComments("select 1 -- drop table users").trim()).toBe("select 1");
    expect(stripSqlComments("/* a /* nested */ b */select 1").trim()).toBe("select 1");
    expect(stripSqlComments('select "keep--me" from t')).toContain('"keep--me"');
  });

  it("detects mutation targets including quoted schema-qualified identifiers", () => {
    expect(getMutationTarget('INSERT INTO ticker."TimeTickers" ("Id") VALUES (1)')).toBe(
      "ticker.TimeTickers",
    );
    expect(getMutationTarget("UPDATE public.users SET name = 'x'")).toBe("public.users");
    expect(getMutationTarget("DELETE FROM users WHERE id = 1")).toBe("users");
  });

  it("treats an env as fully read-only only with no allowed mutations or targets", () => {
    expect(
      isFullyReadOnly({ allowMutations: false, allowedMutations: [], allowedMutationTargets: {} }),
    ).toBe(true);
    expect(
      isFullyReadOnly({ allowMutations: true, allowedMutations: [], allowedMutationTargets: {} }),
    ).toBe(false);
    expect(
      isFullyReadOnly({
        allowMutations: false,
        allowedMutations: ["insert"],
        allowedMutationTargets: {},
      }),
    ).toBe(false);
    expect(
      isFullyReadOnly({
        allowMutations: false,
        allowedMutations: [],
        allowedMutationTargets: { insert: ["ticker.TimeTickers"] },
      }),
    ).toBe(false);
  });
});

describe("DbService", () => {
  describe("resolveDbAccessMode", () => {
    it("treats local environment as mutable without a tunnel", () => {
      const mode = resolveDbAccessMode("local", "127.0.0.1", true);

      expect(mode).toEqual({
        host: "127.0.0.1",
        needsTunnel: false,
        allowMutations: true,
        allowedMutations: ["insert", "update", "delete"],
      });
    });

    it("opens a tunnel for remote environments using forwarded localhost ports", () => {
      const mode = resolveDbAccessMode("test", "127.0.0.1", true);

      expect(mode).toEqual({
        host: "127.0.0.1",
        needsTunnel: true,
        allowMutations: false,
        allowedMutations: [],
      });
    });

    it("does not open a tunnel when kubectl config is missing", () => {
      const mode = resolveDbAccessMode("prod", "127.0.0.1", false);

      expect(mode).toEqual({
        host: "127.0.0.1",
        needsTunnel: false,
        allowMutations: false,
        allowedMutations: [],
      });
    });

    it("keeps direct remote hosts read only without localhost tunnel detection", () => {
      const mode = resolveDbAccessMode("prod", "db.internal", true);

      expect(mode).toEqual({
        host: "db.internal",
        needsTunnel: false,
        allowMutations: false,
        allowedMutations: [],
      });
    });

    it("keeps explicit mutation permissions for remote environments", () => {
      const mode = resolveDbAccessMode("staging", "127.0.0.1", true, ["insert"]);

      expect(mode).toEqual({
        host: "127.0.0.1",
        needsTunnel: true,
        allowMutations: false,
        allowedMutations: ["insert"],
      });
    });
  });

  describe("buildApiProbeArgs", () => {
    it("hits /version with a request-timeout for the given context", () => {
      expect(buildApiProbeArgs(undefined, "admin@cluster", 2000)).toEqual([
        "--context",
        "admin@cluster",
        "get",
        "--raw=/version",
        "--request-timeout=2000ms",
      ]);
    });

    it("prepends --kubeconfig when a kubeconfig path is resolved", () => {
      expect(buildApiProbeArgs("/home/u/kubeconfig", "admin@cluster", 1500)).toEqual([
        "--kubeconfig",
        "/home/u/kubeconfig",
        "--context",
        "admin@cluster",
        "get",
        "--raw=/version",
        "--request-timeout=1500ms",
      ]);
    });
  });

  describe("executeQuery", () => {
    it.effect("executes SELECT query successfully", () =>
      Effect.gen(function* () {
        const service = yield* DbService;
        const result = yield* service.executeQuery("local", "SELECT * FROM users");

        expect(result.success).toBe(true);
        expect(result.data).toEqual([{ id: 1, name: "test" }]);
        expect(result.rowCount).toBe(1);
        expect(result.executionTimeMs).toBe(42);
      }).pipe(
        Effect.provide(
          createMockDbServiceLayer({
            "query:local:SELECT * FROM users": {
              success: true,
              data: [{ id: 1, name: "test" }],
              rowCount: 1,
              executionTimeMs: 42,
            },
          }),
        ),
      ),
    );

    it.effect("returns empty result for SELECT with no rows", () =>
      Effect.gen(function* () {
        const service = yield* DbService;
        const result = yield* service.executeQuery("local", "SELECT * FROM users WHERE id = 999");

        expect(result.success).toBe(true);
        expect(result.data).toEqual([]);
        expect(result.rowCount).toBe(0);
      }).pipe(
        Effect.provide(
          createMockDbServiceLayer({
            "query:local:SELECT * FROM users WHERE id = 999": {
              success: true,
              data: [],
              rowCount: 0,
              executionTimeMs: 15,
            },
          }),
        ),
      ),
    );

    it.effect("blocks mutations on test environment", () =>
      Effect.gen(function* () {
        const service = yield* DbService;
        const result = yield* service
          .executeQuery("test", "UPDATE users SET name = 'test'")
          .pipe(Effect.result);

        Result.match(result, {
          onFailure: (error) => {
            expect(error._tag).toBe("DbMutationBlockedError");
          },
          onSuccess: () => {
            expect.fail("Expected Left but got Right");
          },
        });
      }).pipe(
        Effect.provide(
          createMockDbServiceLayer({
            "query:test:UPDATE users SET name = 'test'": new DbMutationBlockedError({
              message: "Mutation queries are not allowed on this environment",
              environment: "test",
            }),
          }),
        ),
      ),
    );

    it.effect("blocks mutations on prod environment", () =>
      Effect.gen(function* () {
        const service = yield* DbService;
        const result = yield* service.executeQuery("prod", "DELETE FROM users").pipe(Effect.result);

        Result.match(result, {
          onFailure: (error) => {
            expect(error._tag).toBe("DbMutationBlockedError");
          },
          onSuccess: () => {
            expect.fail("Expected Left but got Right");
          },
        });
      }).pipe(
        Effect.provide(
          createMockDbServiceLayer({
            "query:prod:DELETE FROM users": new DbMutationBlockedError({
              message: "Mutation queries are not allowed on this environment",
              environment: "prod",
            }),
          }),
        ),
      ),
    );

    it.effect("handles query execution errors", () =>
      Effect.gen(function* () {
        const service = yield* DbService;
        const result = yield* service
          .executeQuery("local", "SELECT * FROM nonexistent_table")
          .pipe(Effect.result);

        Result.match(result, {
          onFailure: (error) => {
            expect(error._tag).toBe("DbQueryError");
          },
          onSuccess: () => {
            expect.fail("Expected Left but got Right");
          },
        });
      }).pipe(
        Effect.provide(
          createMockDbServiceLayer({
            "query:local:SELECT * FROM nonexistent_table": new DbQueryError({
              message: 'relation "nonexistent_table" does not exist',
              sql: "SELECT * FROM nonexistent_table",
            }),
          }),
        ),
      ),
    );

    it.effect("includes schema hints on table not found", () =>
      Effect.gen(function* () {
        const service = yield* DbService;
        const result = yield* service.executeQuery("local", "SELECT * FROM users_table");

        expect(result.success).toBe(false);
        expect(result.availableTables).toContain("users");
        expect(result.hint).toContain("users_table");
        expect(result.schemaFile).toBe("packages/db/src/schema.ts");
      }).pipe(
        Effect.provide(
          createMockDbServiceLayer({
            "query:local:SELECT * FROM users_table": {
              success: false,
              error: 'relation "users_table" does not exist',
              availableTables: ["users", "organizations", "projects"],
              hint: 'Table "users_table" not found. Use one of the availableTables listed above.',
              schemaFile: "packages/db/src/schema.ts",
              executionTimeMs: 25,
            },
          }),
        ),
      ),
    );

    it.effect("includes column hints on column not found", () =>
      Effect.gen(function* () {
        const service = yield* DbService;
        const result = yield* service.executeQuery("local", "SELECT user_name FROM users");

        expect(result.success).toBe(false);
        expect(result.availableColumns).toContain("name");
        expect(result.hint).toContain("user_name");
      }).pipe(
        Effect.provide(
          createMockDbServiceLayer({
            "query:local:SELECT user_name FROM users": {
              success: false,
              error: 'column "user_name" does not exist',
              availableColumns: ["id", "name", "email", "created_at"],
              hint: 'Column "user_name" not found in table "users". Use one of the availableColumns listed above.',
              schemaFile: "packages/db/src/schema.ts",
              executionTimeMs: 20,
            },
          }),
        ),
      ),
    );

    it.effect("handles parse errors for invalid JSON", () =>
      Effect.gen(function* () {
        const service = yield* DbService;
        const result = yield* service
          .executeQuery("local", "SELECT invalid_json")
          .pipe(Effect.result);

        Result.match(result, {
          onFailure: (error) => {
            expect(error._tag).toBe("DbParseError");
          },
          onSuccess: () => {
            expect.fail("Expected Left but got Right");
          },
        });
      }).pipe(
        Effect.provide(
          createMockDbServiceLayer({
            "query:local:SELECT invalid_json": new DbParseError({
              message: "Failed to parse query result as JSON",
              rawOutput: "invalid json output",
            }),
          }),
        ),
      ),
    );

    it.effect("tracks execution time", () =>
      Effect.gen(function* () {
        const service = yield* DbService;
        const result = yield* service.executeQuery("local", "SELECT COUNT(*) FROM large_table");

        expect(result.executionTimeMs).toBe(156);
      }).pipe(
        Effect.provide(
          createMockDbServiceLayer({
            "query:local:SELECT COUNT(*) FROM large_table": {
              success: true,
              data: [{ count: 1000 }],
              rowCount: 1,
              executionTimeMs: 156,
            },
          }),
        ),
      ),
    );

    it.effect("uses direct access before environment-scoped VPN prerequisites", () => {
      const observedSql: ObservedSql[] = [];
      const observedShellCommands: string[] = [];
      const databaseConfig: DatabaseConfig = {
        vpn: "profileVpn",
        environments: {
          prod: {
            host: "db.internal",
            port: 5432,
            user: "readonly",
            database: "app",
            vpn: "prodVpn",
          },
        },
      };

      return Effect.gen(function* () {
        const service = yield* DbService;
        const result = yield* service.executeQuery("prod", "SELECT 1");

        expect(result.success).toBe(true);
        expect(result.data).toEqual([{ "?column?": 1 }]);
        expect(observedSql.map((entry) => entry.sql)).toEqual(["SELECT 1"]);
        expect(observedShellCommands).toEqual([]);
      }).pipe(
        Effect.provide(
          createRealDbServiceLayer(
            {
              vpns: {
                profileVpn: { name: "ProfileVPN" },
                prodVpn: { name: "ProdVPN" },
              },
            },
            databaseConfig,
            { "SELECT 1": { rows: [{ "?column?": 1 }] } },
            observedSql,
            {},
            observedShellCommands,
          ),
        ),
      );
    });

    it.effect("refuses batched statements before they reach the driver", () => {
      const observedSql: ObservedSql[] = [];
      const databaseConfig: DatabaseConfig = {
        environments: {
          prod: { host: "db.internal", port: 5432, user: "writer", database: "app" },
        },
        allowedMutationTargets: { prod: { insert: ["ticker.TimeTickers"] } },
      };

      return Effect.gen(function* () {
        const service = yield* DbService;
        const blocked = yield* service
          .executeQuery("prod", "select 1; delete from users")
          .pipe(Effect.result);

        Result.match(blocked, {
          onFailure: (error) => expect(error._tag).toBe("DbQueryError"),
          onSuccess: () => expect.fail("Expected batched statements to be refused"),
        });
        expect(observedSql).toEqual([]);
      }).pipe(Effect.provide(createRealDbServiceLayer({}, databaseConfig, {}, observedSql)));
    });

    it.effect("marks the connection read-only for a fully read-only environment", () => {
      const observedSql: ObservedSql[] = [];
      const databaseConfig: DatabaseConfig = {
        environments: {
          prod: { host: "db.internal", port: 5432, user: "readonly", database: "app" },
        },
      };

      return Effect.gen(function* () {
        const service = yield* DbService;
        yield* service.executeQuery("prod", "SELECT 1");

        expect(observedSql[0].connection.readOnly).toBe(true);
      }).pipe(
        Effect.provide(
          createRealDbServiceLayer(
            {},
            databaseConfig,
            { "SELECT 1": { rows: [{ "?column?": 1 }] } },
            observedSql,
          ),
        ),
      );
    });

    it.effect("leaves the connection writable when mutation targets are configured", () => {
      const observedSql: ObservedSql[] = [];
      const databaseConfig: DatabaseConfig = {
        environments: {
          prod: { host: "db.internal", port: 5432, user: "writer", database: "app" },
        },
        allowedMutationTargets: { prod: { insert: ["ticker.TimeTickers"] } },
      };

      return Effect.gen(function* () {
        const service = yield* DbService;
        yield* service.executeQuery("prod", "SELECT 1");

        expect(observedSql[0].connection.readOnly).toBe(false);
      }).pipe(
        Effect.provide(
          createRealDbServiceLayer(
            {},
            databaseConfig,
            { "SELECT 1": { rows: [{ "?column?": 1 }] } },
            observedSql,
          ),
        ),
      );
    });

    it.effect("allows only configured mutation targets on remote environments", () => {
      const observedSql: ObservedSql[] = [];
      const databaseConfig: DatabaseConfig = {
        environments: {
          prod: {
            host: "db.internal",
            port: 5432,
            user: "writer",
            database: "app",
          },
        },
        allowedMutationTargets: {
          prod: { insert: ["ticker.TimeTickers"] },
        },
      };
      const allowedSql = 'INSERT INTO ticker."TimeTickers" ("Id") VALUES (1)';
      const blockedSql = 'INSERT INTO public."OtherTable" ("Id") VALUES (1)';

      return Effect.gen(function* () {
        const service = yield* DbService;
        const blocked = yield* service.executeQuery("prod", blockedSql).pipe(Effect.result);

        Result.match(blocked, {
          onFailure: (error) => expect(error._tag).toBe("DbMutationBlockedError"),
          onSuccess: () => expect.fail("Expected blocked mutation"),
        });

        const result = yield* service.executeQuery("prod", allowedSql);

        expect(result.success).toBe(true);
        expect(result.rowCount).toBe(1);
        expect(result.message).toBe("INSERT 1");
        expect(observedSql.map((entry) => entry.sql)).toEqual([allowedSql]);
      }).pipe(
        Effect.provide(
          createRealDbServiceLayer(
            {},
            databaseConfig,
            { [allowedSql]: { rows: [], rowCount: 1, command: "INSERT" } },
            observedSql,
          ),
        ),
      );
    });

    it.effect("strips a trailing semicolon before sending select SQL", () => {
      const observedSql: ObservedSql[] = [];
      const databaseConfig: DatabaseConfig = {
        environments: {
          prod: {
            host: "db.internal",
            port: 5432,
            user: "readonly",
            database: "app",
          },
        },
      };

      return Effect.gen(function* () {
        const service = yield* DbService;
        const result = yield* service.executeQuery("prod", "SELECT 1;");

        expect(result.success).toBe(true);
        expect(observedSql.map((entry) => entry.sql)).toEqual(["SELECT 1"]);
      }).pipe(
        Effect.provide(
          createRealDbServiceLayer(
            {},
            databaseConfig,
            { "SELECT 1": { rows: [{ "?column?": 1 }] } },
            observedSql,
          ),
        ),
      );
    });

    it.effect("surfaces available tables when the driver reports a missing relation", () => {
      const observedSql: ObservedSql[] = [];
      const databaseConfig: DatabaseConfig = {
        environments: {
          prod: { host: "db.internal", port: 5432, user: "readonly", database: "app" },
        },
      };
      const missingSql = "SELECT * FROM nope";
      const tableListSql = `SELECT schemaname || '.' || tablename FROM pg_tables WHERE schemaname NOT IN (${SYSTEM_SCHEMAS_SQL}) ORDER BY schemaname, tablename;`;

      return Effect.gen(function* () {
        const service = yield* DbService;
        const result = yield* service.executeQuery("prod", missingSql);

        expect(result.success).toBe(false);
        expect(result.availableTables).toEqual(["public.users"]);
        expect(result.hint).toContain('Table "nope" not found');
      }).pipe(
        Effect.provide(
          createRealDbServiceLayer(
            {},
            databaseConfig,
            {
              [missingSql]: { error: 'relation "nope" does not exist' },
              [tableListSql]: { rows: [{ "?column?": "public.users" }] },
            },
            observedSql,
          ),
        ),
      );
    });
  });

  describe("executeSchemaQuery", () => {
    it.effect("lists all tables with tables mode", () =>
      Effect.gen(function* () {
        const service = yield* DbService;
        const result = yield* service.executeSchemaQuery("local", "tables");

        expect(result.success).toBe(true);
        expect(result.data).toHaveLength(3);
        expect(result.data?.[0]?.name).toBe("users");
        expect(result.message).toContain("tables");
      }).pipe(
        Effect.provide(
          createMockDbServiceLayer({
            "schema:local:tables": {
              success: true,
              data: [{ name: "users" }, { name: "organizations" }, { name: "projects" }],
              rowCount: 3,
              message: "Schema introspection: tables",
              executionTimeMs: 35,
            },
          }),
        ),
      ),
    );

    it.effect("shows columns for specific table with columns mode", () =>
      Effect.gen(function* () {
        const service = yield* DbService;
        const result = yield* service.executeSchemaQuery("local", "columns", "users");

        expect(result.success).toBe(true);
        expect(result.data).toHaveLength(3);
        expect(result.data?.[0]?.name).toBe("id");
        expect(result.message).toContain("columns");
        expect(result.message).toContain("users");
      }).pipe(
        Effect.provide(
          createMockDbServiceLayer({
            "schema:local:columns:users": {
              success: true,
              data: [
                {
                  name: "id",
                  type: "uuid",
                  nullable: false,
                },
                {
                  name: "email",
                  type: "text",
                  nullable: false,
                },
                {
                  name: "created_at",
                  type: "timestamp",
                  nullable: false,
                },
              ],
              rowCount: 3,
              message: "Schema introspection: columns for table 'users'",
              executionTimeMs: 28,
            },
          }),
        ),
      ),
    );

    it.effect("requires table parameter for columns mode", () =>
      Effect.gen(function* () {
        const service = yield* DbService;
        const result = yield* service.executeSchemaQuery("local", "columns");

        expect(result.success).toBe(false);
        expect(result.error).toContain("--table");
      }).pipe(
        Effect.provide(
          createMockDbServiceLayer({
            "schema:local:columns": {
              success: false,
              error: "--schema columns requires --table <name>",
              executionTimeMs: 5,
            },
          }),
        ),
      ),
    );

    it.effect("shows full schema with all tables and columns", () =>
      Effect.gen(function* () {
        const service = yield* DbService;
        const result = yield* service.executeSchemaQuery("local", "full");

        expect(result.success).toBe(true);
        expect(result.data).toHaveLength(2);
        expect(result.data?.[0]?.table).toBe("users");
        expect(result.message).toContain("Full schema");
      }).pipe(
        Effect.provide(
          createMockDbServiceLayer({
            "schema:local:full": {
              success: true,
              data: [
                {
                  table: "users",
                  columns: [
                    { name: "id", type: "uuid" },
                    { name: "email", type: "text" },
                  ],
                },
                {
                  table: "organizations",
                  columns: [
                    { name: "id", type: "uuid" },
                    { name: "name", type: "text" },
                  ],
                },
              ],
              rowCount: 2,
              message: "Full schema: 2 tables",
              executionTimeMs: 52,
            },
          }),
        ),
      ),
    );

    it.effect("shows foreign key relationships", () =>
      Effect.gen(function* () {
        const service = yield* DbService;
        const result = yield* service.executeSchemaQuery("local", "relationships");

        expect(result.success).toBe(true);
        expect(result.data).toHaveLength(2);
        expect(result.data?.[0]?.referenced_table).toBe("organizations");
        expect(result.message).toContain("relationships");
      }).pipe(
        Effect.provide(
          createMockDbServiceLayer({
            "schema:local:relationships": {
              success: true,
              data: [
                {
                  constraint_name: "members_organization_id_fk",
                  table_name: "members",
                  column_name: "organization_id",
                  referenced_table: "organizations",
                  referenced_column: "id",
                },
                {
                  constraint_name: "projects_organization_id_fk",
                  table_name: "projects",
                  column_name: "organization_id",
                  referenced_table: "organizations",
                  referenced_column: "id",
                },
              ],
              rowCount: 2,
              message: "Schema introspection: relationships",
              executionTimeMs: 40,
            },
          }),
        ),
      ),
    );

    it.effect("handles schema query errors", () =>
      Effect.gen(function* () {
        const service = yield* DbService;
        const result = yield* service
          .executeSchemaQuery("local", "columns", "nonexistent_table")
          .pipe(Effect.result);

        Result.match(result, {
          onFailure: (error) => {
            expect(error._tag).toBe("DbQueryError");
          },
          onSuccess: () => {
            expect.fail("Expected Left but got Right");
          },
        });
      }).pipe(
        Effect.provide(
          createMockDbServiceLayer({
            "schema:local:columns:nonexistent_table": new DbQueryError({
              message: 'relation "nonexistent_table" does not exist',
              sql: "SELECT ...",
            }),
          }),
        ),
      ),
    );

    it.effect("works with different environments", () =>
      Effect.gen(function* () {
        const service = yield* DbService;
        const resultTest = yield* service.executeSchemaQuery("test", "tables");
        const resultProd = yield* service.executeSchemaQuery("prod", "tables");

        expect(resultTest.success).toBe(true);
        expect(resultProd.success).toBe(true);
      }).pipe(
        Effect.provide(
          createMockDbServiceLayer({
            "schema:test:tables": {
              success: true,
              data: [{ name: "users" }],
              rowCount: 1,
              message: "Schema introspection: tables",
              executionTimeMs: 30,
            },
            "schema:prod:tables": {
              success: true,
              data: [{ name: "users" }],
              rowCount: 1,
              message: "Schema introspection: tables",
              executionTimeMs: 30,
            },
          }),
        ),
      ),
    );
  });

  describe("Error handling", () => {
    it.effect("handles connection errors", () =>
      Effect.gen(function* () {
        const service = yield* DbService;
        const result = yield* service.executeQuery("local", "SELECT 1").pipe(Effect.result);

        Result.match(result, {
          onFailure: (error) => {
            expect(error._tag).toBe("DbConnectionError");
          },
          onSuccess: () => {
            expect.fail("Expected Left but got Right");
          },
        });
      }).pipe(
        Effect.provide(
          createMockDbServiceLayer({
            "query:local:SELECT 1": new DbConnectionError({
              message: "Failed to connect to database",
              environment: "local",
            }),
          }),
        ),
      ),
    );

    it.effect("preserves error details in responses", () =>
      Effect.gen(function* () {
        const service = yield* DbService;
        const result = yield* service.executeQuery("local", "SELEC * FROM users");

        expect(result.success).toBe(false);
        expect(result.error).toContain("syntax error");
      }).pipe(
        Effect.provide(
          createMockDbServiceLayer({
            "query:local:SELEC * FROM users": {
              success: false,
              error: 'syntax error at or near "SELEC"',
              executionTimeMs: 10,
            },
          }),
        ),
      ),
    );
  });

  describe("Output formatting", () => {
    it.effect("includes execution time in all responses", () =>
      Effect.gen(function* () {
        const service = yield* DbService;
        const result = yield* service.executeQuery("local", "SELECT 1");

        expect(result.executionTimeMs).toBeDefined();
        expect(typeof result.executionTimeMs).toBe("number");
        expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
      }).pipe(
        Effect.provide(
          createMockDbServiceLayer({
            "query:local:SELECT 1": {
              success: true,
              data: [],
              rowCount: 0,
              executionTimeMs: 123,
            },
          }),
        ),
      ),
    );

    it.effect("includes row count in successful queries", () =>
      Effect.gen(function* () {
        const service = yield* DbService;
        const result = yield* service.executeQuery("local", "SELECT id FROM users LIMIT 3");

        expect(result.rowCount).toBe(3);
        expect(result.data).toHaveLength(3);
      }).pipe(
        Effect.provide(
          createMockDbServiceLayer({
            "query:local:SELECT id FROM users LIMIT 3": {
              success: true,
              data: [{ id: 1 }, { id: 2 }, { id: 3 }],
              rowCount: 3,
              executionTimeMs: 45,
            },
          }),
        ),
      ),
    );
  });

  describe("env resolution with defaultEnvironment", () => {
    it.effect("uses explicit --env when provided", () =>
      Effect.gen(function* () {
        const service = yield* DbService;
        const result = yield* service.executeQuery("prod", "SELECT 1");

        expect(result.success).toBe(true);
      }).pipe(
        Effect.provide(
          createMockDbServiceLayer({
            "query:prod:SELECT 1": {
              success: true,
              data: [{ result: 1 }],
              rowCount: 1,
              executionTimeMs: 10,
            },
          }),
        ),
      ),
    );

    it.effect("falls back to defaultEnvironment when --env is not provided", () =>
      Effect.gen(function* () {
        const service = yield* DbService;
        const result = yield* service.executeQuery("test", "SELECT 1");

        expect(result.success).toBe(true);
      }).pipe(
        Effect.provide(
          createMockDbServiceLayer({
            "query:test:SELECT 1": {
              success: true,
              data: [{ result: 1 }],
              rowCount: 1,
              executionTimeMs: 10,
            },
          }),
        ),
      ),
    );

    it.effect("handles missing environment with helpful error", () =>
      Effect.gen(function* () {
        const service = yield* DbService;
        const result = yield* service
          .executeQuery("(not specified)", "SELECT 1")
          .pipe(Effect.result);

        Result.match(result, {
          onFailure: (error) => {
            expect(error._tag).toBe("DbConnectionError");
          },
          onSuccess: () => {
            expect.fail("Expected Left but got Right");
          },
        });
      }).pipe(
        Effect.provide(
          createMockDbServiceLayer({
            "query:(not specified):SELECT 1": new DbConnectionError({
              message:
                "No environment specified. Use --env <name> or set defaultEnvironment in agent-tools.json5.",
              environment: "(not specified)",
              hint: 'Set defaultEnvironment in agent-tools.json5 (e.g. defaultEnvironment: "local") or pass --env explicitly.',
              nextCommand: 'agent-tools-db sql --env local --sql "SELECT 1"',
            }),
          }),
        ),
      ),
    );
  });

  describe("error recovery hints - unit tests", () => {
    it("DbConnectionError with hint and nextCommand", () => {
      const error = new DbConnectionError({
        message: "Connection timeout",
        environment: "prod",
        hint: "Check network connectivity and database availability",
        nextCommand: "agent-tools-db sql --env prod --sql 'SELECT 1'",
        retryable: true,
      });

      expect(error._tag).toBe("DbConnectionError");
      expect(error.hint).toBe("Check network connectivity and database availability");
      expect(error.nextCommand).toBe("agent-tools-db sql --env prod --sql 'SELECT 1'");
      expect(error.retryable).toBe(true);
    });

    it("DbQueryError with hint and retryable", () => {
      const error = new DbQueryError({
        message: 'relation "bad_table" does not exist',
        sql: "SELECT * FROM bad_table",
        hint: "Check table name spelling. Use schema introspection to list available tables.",
        retryable: false,
      });

      expect(error._tag).toBe("DbQueryError");
      expect(error.hint).toBe(
        "Check table name spelling. Use schema introspection to list available tables.",
      );
      expect(error.retryable).toBe(false);
    });

    it("DbMutationBlockedError with hint and nextCommand", () => {
      const error = new DbMutationBlockedError({
        message: "Mutation queries are not allowed on this environment",
        environment: "test",
        hint: "Use a local environment for mutations. Test environment is read-only.",
        nextCommand: "agent-tools-db sql --env local --sql \"UPDATE users SET name = 'test'\"",
      });

      expect(error._tag).toBe("DbMutationBlockedError");
      expect(error.hint).toBe(
        "Use a local environment for mutations. Test environment is read-only.",
      );
      expect(error.nextCommand).toContain("--env local");
    });

    it("hint fields are optional in error responses", () => {
      const error = new DbQueryError({
        message: 'relation "missing" does not exist',
        sql: "SELECT * FROM missing",
      });

      expect(error._tag).toBe("DbQueryError");
      expect(error.message).toBe('relation "missing" does not exist');
      expect(error.hint).toBeUndefined();
      expect(error.nextCommand).toBeUndefined();
    });
  });
});
