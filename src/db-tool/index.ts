#!/usr/bin/env bun
import { Command, Flag } from "effect/unstable/cli";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Layer, Option } from "effect";

import type { SchemaMode } from "./types";

import {
  makeSchemaCommand,
  formatOption,
  formatOutput,
  renderCauseToStderr,
  VERSION,
} from "#shared";
import { AuditServiceLayer, withAudit } from "#shared/audit";
import { ConfigService, ConfigServiceLayer, getDefaultEnvironment } from "#config";
import { DbConfigService, makeDbConfigLayer } from "./config-service";
import { DbConnectionError } from "./errors";
import { DbService } from "./service";

// Extract --profile from argv before @effect/cli parsing
// so we can build the correct config layer.
const profileIndex = process.argv.indexOf("--profile");
const profileArg = profileIndex !== -1 ? process.argv[profileIndex + 1] : undefined;

/**
 * Resolve environment from explicit --env flag, config defaultEnvironment, or fail with hint.
 */
const resolveEnv = (envOption: Option.Option<string>) =>
  Effect.gen(function* () {
    const explicit = Option.getOrUndefined(envOption);
    if (explicit) return explicit;

    const config = yield* ConfigService;
    const defaultEnv = getDefaultEnvironment(config);

    if (defaultEnv === "prod") {
      return yield* new DbConnectionError({
        message:
          "Implicit prod access blocked. Config defaultEnvironment is 'prod' but --env was not passed explicitly.",
        environment: "(prod-safety)",
        hint: "Pass --env prod explicitly to confirm production access, or change defaultEnvironment to a non-prod value.",
        nextCommand: 'agent-tools-db sql --env prod --sql "SELECT 1"',
      });
    }

    if (defaultEnv) return defaultEnv;

    return yield* new DbConnectionError({
      message:
        "No environment specified. Use --env <name> or set defaultEnvironment in agent-tools.json5.",
      environment: "(not specified)",
      hint: 'Set defaultEnvironment in agent-tools.json5 (e.g. defaultEnvironment: "local") or pass --env explicitly.',
      nextCommand: 'agent-tools-db sql --env local --sql "SELECT 1"',
    });
  });

const sqlCommand = Command.make(
  "sql",
  {
    env: Flag.optional(Flag.string("env")).pipe(
      Flag.withDescription(
        "Target database environment name (e.g. local, test, prod). Falls back to defaultEnvironment in config.",
      ),
    ),
    sql: Flag.string("sql").pipe(Flag.withDescription("SQL query to execute")),
    limit: Flag.optional(Flag.integer("limit")).pipe(
      Flag.withDescription(
        "Max rows to return (default 50). Use 0 for no cap. Prefer a SQL LIMIT for large tables.",
      ),
    ),
    format: formatOption,
    profile: Flag.optional(Flag.string("profile")).pipe(
      Flag.withDescription("Database profile name from agent-tools.json5 (if multiple configured)"),
    ),
  },
  ({ env, sql, limit, format }) =>
    Effect.gen(function* () {
      const resolvedEnv = yield* resolveEnv(env);
      const db = yield* DbService;
      const result = yield* db.executeQuery(resolvedEnv, sql, Option.getOrUndefined(limit));
      yield* Console.log(formatOutput(result, format));
    }),
).pipe(Command.withDescription("Execute a SQL query"));

const schemaCommand = Command.make(
  "schema",
  {
    env: Flag.optional(Flag.string("env")).pipe(
      Flag.withDescription(
        "Target database environment name (e.g. local, test, prod). Falls back to defaultEnvironment in config.",
      ),
    ),
    mode: Flag.choice("mode", ["tables", "columns", "full", "relationships"]).pipe(
      Flag.withDescription(
        "Schema introspection mode: tables (list all), columns (show columns for --table), full (all tables with columns), relationships (foreign keys)",
      ),
    ),
    table: Flag.string("table").pipe(
      Flag.withDescription("Table name (required for --mode columns)"),
      Flag.optional,
    ),
    format: formatOption,
    profile: Flag.optional(Flag.string("profile")).pipe(
      Flag.withDescription("Database profile name from agent-tools.json5 (if multiple configured)"),
    ),
  },
  ({ env, mode, table, format }) =>
    Effect.gen(function* () {
      const resolvedEnv = yield* resolveEnv(env);
      const db = yield* DbService;
      const result = yield* db.executeSchemaQuery(
        resolvedEnv,
        mode as SchemaMode,
        Option.getOrUndefined(table),
      );
      yield* Console.log(formatOutput(result, format));
    }),
).pipe(Command.withDescription("Introspect database schema (tables, columns, relationships)"));

const envsCommand = Command.make(
  "envs",
  {
    format: formatOption,
    profile: Flag.optional(Flag.string("profile")).pipe(
      Flag.withDescription("Database profile name from agent-tools.json5 (if multiple configured)"),
    ),
  },
  ({ format }) =>
    Effect.gen(function* () {
      const config = yield* ConfigService;
      const dbConfig = yield* DbConfigService;
      const environments = dbConfig ? Object.keys(dbConfig.environments) : [];
      const result = {
        success: true as const,
        environments,
        default: getDefaultEnvironment(config) ?? null,
        message: `${environments.length} environment(s) configured`,
        executionTimeMs: 0,
      };
      yield* Console.log(formatOutput(result, format));
    }),
).pipe(
  Command.withDescription("List configured database environments and the default (no network)"),
);

const ACTIVITY_SQL = `SELECT pid, usename AS "user", state,
  date_trunc('second', now() - xact_start) AS xact_age,
  date_trunc('second', now() - query_start) AS query_age,
  wait_event_type, wait_event, left(query, 200) AS query
FROM pg_stat_activity
WHERE pid <> pg_backend_pid() AND state IS NOT NULL
ORDER BY xact_start ASC NULLS LAST`;

const LOCKS_SQL = `SELECT blocking.pid AS blocking_pid, blocking.usename AS blocking_user,
  left(blocking.query, 150) AS blocking_query,
  blocked.pid AS blocked_pid, blocked.usename AS blocked_user,
  left(blocked.query, 150) AS blocked_query
FROM pg_stat_activity blocked
JOIN pg_stat_activity blocking ON blocking.pid = ANY(pg_blocking_pids(blocked.pid))
ORDER BY blocking.pid, blocked.pid`;

const GRANTS_SQL = `SELECT grantee, table_schema AS schema, table_name AS "table",
  string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privileges
FROM information_schema.role_table_grants
WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
GROUP BY grantee, table_schema, table_name
ORDER BY grantee, table_schema, table_name`;

const makeDiagnosticCommand = (name: string, description: string, sql: string) =>
  Command.make(
    name,
    {
      env: Flag.optional(Flag.string("env")).pipe(
        Flag.withDescription(
          "Target database environment name (e.g. local, test, prod). Falls back to defaultEnvironment in config.",
        ),
      ),
      limit: Flag.optional(Flag.integer("limit")).pipe(
        Flag.withDescription("Max rows to return (default 50). Use 0 for no cap."),
      ),
      format: formatOption,
      profile: Flag.optional(Flag.string("profile")).pipe(
        Flag.withDescription(
          "Database profile name from agent-tools.json5 (if multiple configured)",
        ),
      ),
    },
    ({ env, limit, format }) =>
      Effect.gen(function* () {
        const resolvedEnv = yield* resolveEnv(env);
        const db = yield* DbService;
        const result = yield* db.executeQuery(resolvedEnv, sql, Option.getOrUndefined(limit));
        yield* Console.log(formatOutput(result, format));
      }),
  ).pipe(Command.withDescription(description));

const activityCommand = makeDiagnosticCommand(
  "activity",
  "Show live sessions from pg_stat_activity (state, transaction/query age, wait event), longest-running first",
  ACTIVITY_SQL,
);

const locksCommand = makeDiagnosticCommand(
  "locks",
  "Show blocking chains (blocker -> blocked) from pg_blocking_pids + pg_stat_activity",
  LOCKS_SQL,
);

const grantsCommand = makeDiagnosticCommand(
  "grants",
  "Show per-role table/sequence privileges by schema (excludes system schemas)",
  GRANTS_SQL,
);

const commandsCommand = makeSchemaCommand(() => mainCommand);

const mainCommand = Command.make("db-tool", {}).pipe(
  Command.withDescription("Database Query Tool for Coding Agents"),
  Command.withSubcommands([
    sqlCommand,
    schemaCommand,
    activityCommand,
    locksCommand,
    grantsCommand,
    envsCommand,
    commandsCommand,
  ]),
);

const cli = Command.run(mainCommand, {
  version: VERSION,
});

const dbConfigLayer = makeDbConfigLayer(profileArg);

const MainLayer = DbService.layer.pipe(
  // provideMerge (not provide) so DbConfigService stays in the program context for the `envs` command,
  // which reads it directly rather than going through DbService.
  Layer.provideMerge(dbConfigLayer),
  Layer.provideMerge(ConfigServiceLayer),
  Layer.provideMerge(BunServices.layer),
  Layer.provideMerge(AuditServiceLayer),
);

const program = withAudit("db", cli).pipe(
  Effect.provide(MainLayer),
  Effect.tapCause(renderCauseToStderr),
);

BunRuntime.runMain(program, {
  disableErrorReporting: true,
});
