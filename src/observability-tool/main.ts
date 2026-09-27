#!/usr/bin/env bun

import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { Command } from "effect/unstable/cli";

import { ConfigServiceLayer } from "#config";
import { AuditServiceLayer, withAudit } from "#shared/audit";
import { withRedactedOutput } from "#shared/output-boundary";
import { makeSchemaCommand, renderCauseToStderr, VERSION } from "#shared";

import { metricsCommand } from "./metrics";
import { logsCommand } from "./logs";
import { traceCommand } from "./trace";

const commandsCommand = makeSchemaCommand(() => mainCommand);

const mainCommand = Command.make("observability-tool", {}).pipe(
  Command.withDescription(
    "LGTM observability queries — Tempo traces, Loki logs, Prometheus metrics",
  ),
  Command.withSubcommands([traceCommand, metricsCommand, logsCommand, commandsCommand]),
);

const cli = Command.run(mainCommand, { version: VERSION, renderErrors: false });

const MainLayer = Layer.mergeAll(BunServices.layer, ConfigServiceLayer, AuditServiceLayer);

const program = withRedactedOutput(withAudit("observability", cli)).pipe(
  Effect.provide(MainLayer),
  Effect.tapCause(renderCauseToStderr),
);

BunRuntime.runMain(program, { disableErrorReporting: true });
