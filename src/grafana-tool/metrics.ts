import { Console, Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { formatOption, formatOutput } from "#shared";

import { GrafanaToolError } from "./errors";
import {
  envOption,
  formatGrafanaError,
  grafanaDsQuery,
  profileOption,
  resolveConfig,
} from "./shared";
import type { DsQueryResponse } from "./types";

function parsePrometheusFrames(frames: DsQueryResponse["results"]["A"]["frames"]) {
  if (!frames || frames.length === 0) {
    return [] as Array<{ metric: Record<string, string>; value: number; timestamp: number }>;
  }

  const results: Array<{ metric: Record<string, string>; value: number; timestamp: number }> = [];

  for (const frame of frames) {
    const fields = frame.schema.fields;
    const values = frame.data.values;
    const timeIndex = fields.findIndex((field) => field.type === "time");
    const valueIndex = fields.findIndex((field) => field.type === "number");

    if (timeIndex < 0 || valueIndex < 0) {
      continue;
    }

    const labelFields = fields.filter((field) => field.type === "string");
    const timestamps = values[timeIndex] as number[];
    const seriesValues = values[valueIndex] as number[];

    for (const [index, timestamp] of timestamps.entries()) {
      const metric: Record<string, string> = {};
      for (const labelField of labelFields) {
        const labelIndex = fields.indexOf(labelField);
        const labels = values[labelIndex] as string[];
        if (labels[index]) {
          metric[labelField.name] = labels[index];
        }
      }

      results.push({
        metric,
        value: seriesValues[index] ?? 0,
        timestamp,
      });
    }
  }

  return results;
}

function extractLabelsFromFrame(
  frame: NonNullable<DsQueryResponse["results"]["A"]["frames"]>[number],
) {
  const labels: Record<string, string> = {};
  for (const [index, field] of frame.schema.fields.entries()) {
    if (field.type !== "string") {
      continue;
    }

    const values = frame.data.values[index] as string[];
    if (values[0]) {
      labels[field.name] = values[0];
    }
  }
  return labels;
}

const queryCommand = Command.make(
  "query",
  {
    promql: Argument.string("promql"),
    format: formatOption,
    env: envOption,
    profile: profileOption,
  },
  ({ promql, format, env, profile }) =>
    Effect.gen(function* () {
      const startedAt = Date.now();
      const config = yield* resolveConfig(env, profile);
      const response = yield* Effect.tryPromise({
        try: () =>
          grafanaDsQuery(config, config.prometheusUid, "prometheus", promql, {
            instant: true,
            maxDataPoints: 1,
          }),
        catch: (error) => new GrafanaToolError({ cause: error }),
      });

      if (response.results.A.error) {
        const result = {
          success: false,
          message: "PromQL query failed",
          error: response.results.A.error,
          hint: "Check PromQL syntax and Grafana/Prometheus connectivity",
          executionTimeMs: Date.now() - startedAt,
        };
        yield* Console.log(formatOutput(result, format));
        return;
      }

      const parsed = parsePrometheusFrames(response.results.A.frames);
      const result = {
        success: true,
        message: `PromQL query returned ${parsed.length} result(s)`,
        data: {
          results: parsed,
          query: promql,
          resultCount: parsed.length,
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
            error: formatGrafanaError(error),
            hint: "Check PromQL syntax and Grafana/Prometheus connectivity",
            executionTimeMs: 0,
          };
          yield* Console.log(formatOutput(result, format));
        }),
      ),
    ),
).pipe(Command.withDescription("Execute instant PromQL query via Grafana"));

const rangeCommand = Command.make(
  "range",
  {
    promql: Argument.string("promql"),
    format: formatOption,
    env: envOption,
    profile: profileOption,
    start: Flag.string("start").pipe(
      Flag.withDescription("Start time (ISO 8601 or relative, e.g. now-1h)"),
    ),
    end: Flag.string("end").pipe(
      Flag.withDescription("End time (ISO 8601 or relative, e.g. now)"),
      Flag.withDefault("now"),
    ),
    step: Flag.integer("step").pipe(
      Flag.withDescription("Step in seconds (default: 60)"),
      Flag.withDefault(60),
    ),
  },
  ({ promql, format, env, profile, start, end, step }) =>
    Effect.gen(function* () {
      const startedAt = Date.now();
      const config = yield* resolveConfig(env, profile);
      const response = yield* Effect.tryPromise({
        try: () =>
          grafanaDsQuery(config, config.prometheusUid, "prometheus", promql, {
            instant: false,
            from: start,
            to: end,
            step,
          }),
        catch: (error) => new GrafanaToolError({ cause: error }),
      });

      if (response.results.A.error) {
        const result = {
          success: false,
          message: "PromQL range query failed",
          error: response.results.A.error,
          hint: "Check PromQL syntax and time range",
          executionTimeMs: Date.now() - startedAt,
        };
        yield* Console.log(formatOutput(result, format));
        return;
      }

      const series = (response.results.A.frames ?? []).map((frame) => {
        const timeIndex = frame.schema.fields.findIndex((field) => field.type === "time");
        const valueIndex = frame.schema.fields.findIndex((field) => field.type === "number");
        const timestamps = (timeIndex >= 0 ? frame.data.values[timeIndex] : []) as number[];
        const values = (valueIndex >= 0 ? frame.data.values[valueIndex] : []) as number[];

        return {
          labels: extractLabelsFromFrame(frame),
          values: timestamps.map((timestamp, index) => ({
            timestamp,
            value: values[index] ?? 0,
          })),
        };
      });

      const result = {
        success: true,
        message: `PromQL range query returned ${series.length} series`,
        data: {
          series,
          query: promql,
          start,
          end,
          step,
          seriesCount: series.length,
        },
        executionTimeMs: Date.now() - startedAt,
      };

      yield* Console.log(formatOutput(result, format));
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const result = {
            success: false,
            message: "Failed to execute PromQL range query",
            error: formatGrafanaError(error),
            hint: "Check PromQL syntax and Grafana/Prometheus connectivity",
            executionTimeMs: 0,
          };
          yield* Console.log(formatOutput(result, format));
        }),
      ),
    ),
).pipe(Command.withDescription("Execute range PromQL query via Grafana"));

export const metricsCommand = Command.make("metrics", {}).pipe(
  Command.withDescription("Prometheus metric operations via Grafana"),
  Command.withSubcommands([queryCommand, rangeCommand]),
);
