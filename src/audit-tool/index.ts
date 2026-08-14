#!/usr/bin/env bun
import { Command, Flag } from "effect/unstable/cli";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer, Option } from "effect";

import {
  makeSchemaCommand,
  formatOption,
  formatOutput,
  logText,
  renderCauseToStderr,
  VERSION,
} from "#shared";
import { AuditService, AuditServiceLayer, withAudit } from "#shared/audit";

type AuditToolResult<T> = {
  success: boolean;
  executionTimeMs: number;
  data?: T;
  error?: string;
};

const commonFlags = {
  format: formatOption,
};

const listCommand = Command.make(
  "list",
  {
    ...commonFlags,
    limit: Flag.integer("limit").pipe(
      Flag.withDescription("Maximum number of recent audit entries to return"),
      Flag.withDefault(20),
    ),
    project: Flag.optional(Flag.string("project")).pipe(
      Flag.withDescription("Filter entries by exact working directory path"),
    ),
    tool: Flag.optional(Flag.string("tool")).pipe(
      Flag.withDescription("Filter entries by tool name (gh, k8s, db, az, logs, session, audit)"),
    ),
  },
  ({ format, limit, project, tool }) =>
    Effect.gen(function* () {
      const startTime = Date.now();
      const audit = yield* AuditService;
      const entries = yield* audit.listRecent(limit);
      const toolFilteredEntries = Option.match(tool, {
        onNone: () => entries,
        onSome: (value) => entries.filter((entry) => entry.tool === value),
      });
      const filteredEntries = Option.match(project, {
        onNone: () => toolFilteredEntries,
        onSome: (value) => toolFilteredEntries.filter((entry) => entry.project === value),
      });

      const result: AuditToolResult<typeof filteredEntries> = {
        success: true,
        executionTimeMs: Date.now() - startTime,
        data: filteredEntries,
      };

      yield* logText(formatOutput(result, format));
    }),
).pipe(Command.withDescription("List recent audit log entries"));

const purgeCommand = Command.make(
  "purge",
  {
    ...commonFlags,
    days: Flag.integer("days").pipe(
      Flag.withDescription("Delete audit entries older than this many days"),
      Flag.withDefault(90),
    ),
  },
  ({ days, format }) =>
    Effect.gen(function* () {
      const startTime = Date.now();
      const audit = yield* AuditService;
      const deleted = yield* audit.purgeOlderThanDays(days);

      const result: AuditToolResult<{ deleted: number; days: number }> = {
        success: true,
        executionTimeMs: Date.now() - startTime,
        data: { deleted, days },
      };

      yield* logText(formatOutput(result, format));
    }),
).pipe(Command.withDescription("Delete old audit log entries"));

const commandsCommand = makeSchemaCommand(() => mainCommand);

const mainCommand = Command.make("audit-tool", {}).pipe(
  Command.withDescription("Audit log inspection and maintenance for agent-tools"),
  Command.withSubcommands([listCommand, purgeCommand, commandsCommand]),
);

const cli = Command.run(mainCommand, {
  version: VERSION,
});

const MainLayer = AuditServiceLayer.pipe(Layer.provideMerge(BunServices.layer));

const program = withAudit("audit", cli).pipe(
  Effect.provide(MainLayer),
  Effect.tapCause(renderCauseToStderr),
);

BunRuntime.runMain(program, {
  disableErrorReporting: true,
});
