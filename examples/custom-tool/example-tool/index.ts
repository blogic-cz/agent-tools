#!/usr/bin/env bun

/**
 * Example Agent Tool
 *
 * Demonstrates how to build a CLI tool for coding agents using Effect CLI
 * and the shared @blogic-cz/agent-tools infrastructure.
 *
 * Usage:
 *   bun run agent-tools/example-tool/index.ts ping
 *   bun run agent-tools/example-tool/index.ts ping --format json
 */

import type { BaseResult, OutputFormat } from "@blogic-cz/agent-tools";

import { BunRuntime, BunServices } from "@effect/platform-bun";
import { encode as encodeToon } from "@toon-format/toon";
import { type Cause, Console, Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";

// ---------------------------------------------------------------------------
// Shared helpers (inline — real tools use #shared from the package internals)
// ---------------------------------------------------------------------------

const formatOption = Flag.choice("format", ["toon", "json"]).pipe(
  Flag.withDescription("Output format: toon (default, token-efficient) or json"),
  Flag.withDefault("toon"),
);

function formatOutput<T extends BaseResult>(result: T, format: OutputFormat): string {
  return format === "toon" ? encodeToon(result) : JSON.stringify(result, null, 2);
}

const renderCauseToStderr = (cause: Cause.Cause<unknown>) => Console.error(cause.toString());

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

const pingCommand = Command.make("ping", { format: formatOption }, ({ format }) =>
  Effect.gen(function* () {
    const result = {
      success: true,
      message: "pong",
      executionTimeMs: 0,
    };
    yield* Console.log(formatOutput(result, format));
  }),
).pipe(Command.withDescription("Simple health check — prints 'pong'"));

// ---------------------------------------------------------------------------
// Main command + CLI runner
// ---------------------------------------------------------------------------

const mainCommand = Command.make("example-tool", {}).pipe(
  Command.withDescription("Example Agent Tool — template for building new tools"),
  Command.withSubcommands([pingCommand]),
);

const cli = Command.run(mainCommand, {
  version: "0.0.1",
});

const program = cli.pipe(Effect.provide(BunServices.layer), Effect.tapCause(renderCauseToStderr));

BunRuntime.runMain(program, {
  disableErrorReporting: true,
});
