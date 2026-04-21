import { Console, Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { formatOption, formatOutput } from "#shared";

import { ObservabilityToolError } from "./errors";
import {
  envOption,
  formatObservabilityError,
  observabilityDsQuery,
  profileOption,
  resolveConfig,
} from "./shared";

const queryCommand = Command.make(
  "query",
  {
    promql: Argument.string("promql"),
    format: formatOption,
    env: envOption,
    profile: profileOption,
    start: Flag.string("start").pipe(
      Flag.withDescription("Start time (default: now-1h)"),
      Flag.withDefault("now-1h"),
    ),
    end: Flag.string("end").pipe(
      Flag.withDescription("End time (default: now)"),
      Flag.withDefault("now"),
    ),
    step: Flag.integer("step").pipe(
      Flag.withDescription("Step in seconds (default: 60)"),
      Flag.withDefault(60),
    ),
  },
  ({ promql, format, env, profile, start, end, step }) => {
    const startedAt = Date.now();

    return Effect.gen(function* () {
      const config = yield* resolveConfig(env, profile);
      const response = yield* observabilityDsQuery(
        config,
        config.prometheusUid,
        "prometheus",
        promql,
        {
          instant: false,
          from: start,
          to: end,
          step,
        },
      );

      if (response.results.A.error) {
        return yield* new ObservabilityToolError({
          cause: new Error(response.results.A.error),
        });
      }

      const series = (response.results.A.frames ?? []).flatMap((frame) => {
        const fields = frame.schema.fields;
        const timeFieldIndex = fields.findIndex((field) => field.type === "time");

        if (timeFieldIndex === -1) {
          return [];
        }

        const timestamps = (frame.data.values[timeFieldIndex] ?? []) as Array<number | string>;

        return fields.flatMap((field, fieldIndex) => {
          if (fieldIndex === timeFieldIndex || field.type !== "number") {
            return [];
          }

          const values = (frame.data.values[fieldIndex] ?? []) as Array<number | string | null>;

          return {
            labels: field.labels ?? {},
            points: timestamps
              .map((timestamp, index) => ({
                timestamp: Number(timestamp),
                value:
                  values[index] === null || values[index] === undefined
                    ? ""
                    : String(values[index]),
              }))
              .filter((point) => point.value.length > 0),
          };
        });
      });

      const result = {
        success: true,
        message: `Resolved ${series.length} metric series for PromQL query`,
        data: {
          environment: env,
          grafanaUrl: config.url,
          prometheusDatasourceUid: config.prometheusUid,
          query: promql,
          start,
          end,
          step,
          seriesCount: series.length,
          series,
        },
        executionTimeMs: Date.now() - startedAt,
      };

      yield* Console.log(formatOutput(result, format));
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const result = {
            success: false,
            message: "Failed to execute PromQL query",
            error: formatObservabilityError(error),
            hint: "Check PromQL syntax and Grafana/Prometheus connectivity",
            executionTimeMs: Date.now() - startedAt,
          };
          yield* Console.log(formatOutput(result, format));
        }),
      ),
    );
  },
).pipe(Command.withDescription("Execute PromQL range query via Grafana"));

export const metricsCommand = Command.make("metrics", {}).pipe(
  Command.withDescription("Prometheus metric operations via Grafana"),
  Command.withSubcommands([queryCommand]),
);
