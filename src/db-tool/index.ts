#!/usr/bin/env bun
import { Command, Flag } from "effect/unstable/cli";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Layer, Option } from "effect";

import type { SchemaMode } from "./types";

import { formatOption, formatOutput, renderCauseToStderr, VERSION } from "../shared";
import { ConfigServiceLayer } from "../config";
import { makeDbConfigLayer } from "./config-service";
import { DbService } from "./service";

// Extract --profile from argv before @effect/cli parsing
// so we can build the correct config layer.
const profileIndex = process.argv.indexOf("--profile");
const profileArg = profileIndex !== -1 ? process.argv[profileIndex + 1] : undefined;

const sqlCommand = Command.make(
  "sql",
  {
    env: Flag.string("env").pipe(
      Flag.withDescription("Target database environment name (e.g. local, test, prod)"),
    ),
    sql: Flag.string("sql").pipe(Flag.withDescription("SQL query to execute")),
    format: formatOption,
    profile: Flag.optional(Flag.string("profile")).pipe(
      Flag.withDescription("Database profile name from agent-tools.json5 (if multiple configured)"),
    ),
  },
  ({ env, sql, format }) =>
    Effect.gen(function* () {
      const db = yield* DbService;
      const result = yield* db.executeQuery(env, sql);
      yield* Console.log(formatOutput(result, format));
    }),
).pipe(Command.withDescription("Execute a SQL query"));

const schemaCommand = Command.make(
  "schema",
  {
    env: Flag.string("env").pipe(
      Flag.withDescription("Target database environment name (e.g. local, test, prod)"),
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
      const db = yield* DbService;
      const result = yield* db.executeSchemaQuery(
        env,
        mode as SchemaMode,
        Option.getOrUndefined(table),
      );
      yield* Console.log(formatOutput(result, format));
    }),
).pipe(Command.withDescription("Introspect database schema (tables, columns, relationships)"));

const mainCommand = Command.make("db-tool", {}).pipe(
  Command.withDescription("Database Query Tool for Coding Agents"),
  Command.withSubcommands([sqlCommand, schemaCommand]),
);

const cli = Command.run(mainCommand, {
  version: VERSION,
});

const dbConfigLayer = makeDbConfigLayer(profileArg);

const MainLayer = DbService.layer.pipe(
  Layer.provide(dbConfigLayer),
  Layer.provideMerge(ConfigServiceLayer),
  Layer.provideMerge(BunServices.layer),
);

const program = cli.pipe(Effect.provide(MainLayer), Effect.tapCause(renderCauseToStderr));

BunRuntime.runMain(program, {
  disableErrorReporting: true,
});
