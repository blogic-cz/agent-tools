import { describe, expect, it } from "@effect/vitest";
import { Effect, Result, Layer } from "effect";

import type { DbError } from "../src/db-tool/errors";
import type { QueryResult } from "../src/db-tool/types";

import {
  DbConnectionError,
  DbMutationBlockedError,
  DbParseError,
  DbQueryError,
} from "../src/db-tool/errors";
import { DbService } from "../src/db-tool/service";

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

describe("DbService", () => {
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
