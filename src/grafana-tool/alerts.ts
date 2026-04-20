import { Console, Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { formatOption, formatOutput } from "#shared";

import {
  envOption,
  formatGrafanaError,
  grafanaFetch,
  GrafanaToolError,
  profileOption,
  resolveConfig,
} from "./shared";

type AlertRulesResponse = Record<
  string,
  Array<{
    name: string;
    rules: Array<{
      name: string;
      state: string;
      health: string;
      lastEvaluation?: string;
      evaluationTime?: number;
    }>;
  }>
>;

type AlertInstance = {
  labels: Record<string, string>;
  annotations: Record<string, string>;
  state: string;
  activeAt?: string;
  value?: string;
};

const listCommand = Command.make(
  "list",
  { format: formatOption, env: envOption, profile: profileOption },
  ({ format, env, profile }) =>
    Effect.gen(function* () {
      const start = Date.now();
      const config = yield* resolveConfig(env, profile);
      const data = yield* Effect.tryPromise({
        try: () => grafanaFetch<AlertRulesResponse>(config, "/api/ruler/grafana/api/v1/rules"),
        catch: (error) => new GrafanaToolError({ cause: error }),
      });

      const rules = Object.entries(data).flatMap(([namespace, groups]) =>
        groups.flatMap((group) =>
          group.rules.map((rule) => ({
            name: rule.name,
            state: rule.state,
            health: rule.health,
            namespace,
            group: group.name,
            lastEvaluation: rule.lastEvaluation,
            evaluationTime: rule.evaluationTime,
          })),
        ),
      );

      const result = {
        success: true,
        message: `Found ${rules.length} alert rule(s)`,
        data: { rules, count: rules.length },
        executionTimeMs: Date.now() - start,
      };

      yield* Console.log(formatOutput(result, format));
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const result = {
            success: false,
            message: "Failed to list alert rules",
            error: formatGrafanaError(error),
            hint: "Check Grafana is running and accessible",
            executionTimeMs: 0,
          };

          yield* Console.log(formatOutput(result, format));
        }),
      ),
    ),
).pipe(Command.withDescription("List all alert rules"));

const statusCommand = Command.make(
  "status",
  {
    format: formatOption,
    env: envOption,
    profile: profileOption,
    all: Flag.boolean("all").pipe(
      Flag.withDescription("Show all alerts including normal state"),
      Flag.withDefault(false),
    ),
  },
  ({ format, env, profile, all }) =>
    Effect.gen(function* () {
      const start = Date.now();
      const config = yield* resolveConfig(env, profile);
      const alerts = yield* Effect.tryPromise({
        try: () => grafanaFetch<AlertInstance[]>(config, "/api/alertmanager/grafana/api/v2/alerts"),
        catch: (error) => new GrafanaToolError({ cause: error }),
      });

      const filtered = all
        ? alerts
        : alerts.filter((alert) => alert.state === "firing" || alert.state === "pending");
      const firingCount = filtered.filter((alert) => alert.state === "firing").length;
      const pendingCount = filtered.filter((alert) => alert.state === "pending").length;

      const result = {
        success: true,
        message:
          firingCount === 0 && pendingCount === 0
            ? "No active alerts"
            : `${firingCount} firing, ${pendingCount} pending alert(s)`,
        data: {
          alerts: filtered.map((alert) => ({
            state: alert.state,
            labels: alert.labels,
            annotations: alert.annotations,
            activeAt: alert.activeAt,
            value: alert.value,
          })),
          firingCount,
          pendingCount,
          totalCount: filtered.length,
        },
        executionTimeMs: Date.now() - start,
      };

      yield* Console.log(formatOutput(result, format));
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const result = {
            success: false,
            message: "Failed to get alert status",
            error: formatGrafanaError(error),
            hint: "Check Grafana is running and accessible",
            executionTimeMs: 0,
          };

          yield* Console.log(formatOutput(result, format));
        }),
      ),
    ),
).pipe(Command.withDescription("Show firing and pending alerts"));

export const alertsCommand = Command.make("alerts", {}).pipe(
  Command.withDescription("Alert operations"),
  Command.withSubcommands([listCommand, statusCommand]),
);
