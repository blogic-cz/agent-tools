#!/usr/bin/env bun

import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Layer } from "effect";
import type { Cause } from "effect";
import { Command } from "effect/unstable/cli";

import { ConfigServiceLayer } from "#config";
import { AuditServiceLayer, withAudit } from "#shared/audit";
import { VERSION } from "#shared";

import { alertsCommand } from "./alerts";
import { dashboardsCommand } from "./dashboards";
import { datasourcesCommand } from "./datasources";
import { healthCommand } from "./health";
import { logsCommand } from "./logs";
import { metricsCommand } from "./metrics";

const renderCauseToStderr = (cause: Cause.Cause<unknown>) => Console.error(cause.toString());

const mainCommand = Command.make("grafana-tool", {}).pipe(
  Command.withDescription("Grafana queries — dashboards, alerts, Prometheus metrics, Loki logs"),
  Command.withSubcommands([
    healthCommand,
    dashboardsCommand,
    alertsCommand,
    datasourcesCommand,
    metricsCommand,
    logsCommand,
  ]),
);

const cli = Command.run(mainCommand, { version: VERSION });

const MainLayer = Layer.mergeAll(BunServices.layer, ConfigServiceLayer, AuditServiceLayer);

const program = withAudit("grafana", cli).pipe(
  Effect.provide(MainLayer),
  Effect.tapCause(renderCauseToStderr),
);

BunRuntime.runMain(program, { disableErrorReporting: true });
