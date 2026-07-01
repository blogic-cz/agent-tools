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

const commandsCommand = makeSchemaCommand(() => mainCommand);

const mainCommand = Command.make("db-tool", {}).pipe(
  Command.withDescription("Database Query Tool for Coding Agents"),
  Command.withSubcommands([sqlCommand, schemaCommand, envsCommand, commandsCommand]),
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
