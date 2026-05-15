#!/usr/bin/env bun

import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Layer } from "effect";
import type { Cause } from "effect";
import { Command } from "effect/unstable/cli";

import { ConfigServiceLayer } from "#config";
import { AuditServiceLayer, withAudit } from "#shared/audit";
import { VERSION } from "#shared";

import { metricsCommand } from "./metrics";
import { logsCommand } from "./logs";
import { traceCommand } from "./trace";

const renderCauseToStderr = (cause: Cause.Cause<unknown>) => Console.error(cause.toString());

const mainCommand = Command.make("observability-tool", {}).pipe(
  Command.withDescription(
    "LGTM observability queries — Tempo traces, Loki logs, Prometheus metrics",
  ),
  Command.withSubcommands([traceCommand, metricsCommand, logsCommand]),
);

const cli = Command.run(mainCommand, { version: VERSION });

const MainLayer = Layer.mergeAll(BunServices.layer, ConfigServiceLayer, AuditServiceLayer);

const program = withAudit("observability", cli).pipe(
  Effect.provide(MainLayer),
  Effect.tapCause(renderCauseToStderr),
);

BunRuntime.runMain(program, { disableErrorReporting: true });
