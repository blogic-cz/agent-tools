#!/usr/bin/env bun

import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { Command } from "effect/cli";

import { ConfigServiceLayer } from "#config";
import { AuditServiceLayer, withAudit } from "#shared/audit";
import { withRedactedOutput } from "#shared/output-boundary";
import { SecretEnvResolver } from "#shared/secret-env";
import { makeSchemaCommand, renderCauseToStderr, VERSION } from "#shared";

import { metricsCommand } from "./metrics";
import { logsCommand } from "./logs";
import { traceCommand } from "./trace";

const commandsCommand = makeSchemaCommand(() => mainCommand);

export const mainCommand = Command.make("observability-tool", {}).pipe(
  Command.withDescription(
    "LGTM observability queries — Tempo traces, Loki logs, Prometheus metrics",
  ),
  Command.withSubcommands([traceCommand, metricsCommand, logsCommand, commandsCommand]),
);

const cli = Command.run(mainCommand, { version: VERSION, renderErrors: false });

const MainLayer = Layer.mergeAll(
  BunServices.layer,
  ConfigServiceLayer,
  AuditServiceLayer,
  SecretEnvResolver.liveLayer,
);

const program = withRedactedOutput(withAudit("observability", cli)).pipe(
  Effect.provide(MainLayer),
  Effect.tapCause(renderCauseToStderr),
);

export const runMain = () => BunRuntime.runMain(program, { disableErrorReporting: true });

export const runProgram = (args: readonly string[]) =>
  withRedactedOutput(
    withAudit(
      "observability",
      Command.runWith(mainCommand, { version: VERSION, renderErrors: false })(args),
    ),
  ).pipe(Effect.provide(MainLayer), Effect.tapCause(renderCauseToStderr));
