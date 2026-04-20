import { Console, Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { formatOption, formatOutput } from "#shared";

import {
  envOption,
  formatGrafanaError,
  grafanaDsQuery,
  profileOption,
  resolveConfig,
} from "./shared";

function parseLabel(value: string | Record<string, string>): Record<string, string> {
  if (typeof value === "object" && value !== null) {
    return value;
  }

  try {
    return JSON.parse(value) as Record<string, string>;
  } catch {
    return {};
  }
}

const queryCommand = Command.make(
  "query",
  {
    logql: Argument.string("logql"),
    format: formatOption,
    env: envOption,
    profile: profileOption,
    limit: Flag.integer("limit").pipe(
      Flag.withDescription("Max log lines (default: 100)"),
      Flag.withDefault(100),
    ),
    start: Flag.string("start").pipe(
      Flag.withDescription("Start time (default: now-1h)"),
      Flag.withDefault("now-1h"),
    ),
    end: Flag.string("end").pipe(
      Flag.withDescription("End time (default: now)"),
      Flag.withDefault("now"),
    ),
  },
  ({ logql, format, env, profile, limit, start, end }) => {
    const startedAt = Date.now();

    return Effect.gen(function* () {
      const config = yield* resolveConfig(env, profile);
      const response = yield* grafanaDsQuery(config, config.lokiUid, "loki", logql, {
        from: start,
        to: end,
        maxLines: limit,
      });

      if (response.results.A.error) {
        const result = {
          success: false,
          message: "LogQL query failed",
          error: response.results.A.error,
          hint: "Check LogQL syntax and Grafana/Loki connectivity",
          executionTimeMs: Date.now() - startedAt,
        };
        yield* Console.log(formatOutput(result, format));
        return;
      }

      const logs: Array<{ timestamp: string; line: string; labels: Record<string, string> }> = [];
      for (const frame of response.results.A.frames ?? []) {
        const fields = frame.schema.fields;
        const values = frame.data.values;
        const timeIndex = fields.findIndex(
          (field) => field.name === "timestamp" || field.type === "time",
        );
        const lineIndex = fields.findIndex(
          (field) => field.name === "body" || field.name === "Line" || field.name === "line",
        );
        const labelsIndex = fields.findIndex(
          (field) => field.name === "labels" || field.name === "labelTypes",
        );

        const timestamps = (timeIndex >= 0 ? values[timeIndex] : []) as Array<string | number>;
        const lines = (lineIndex >= 0 ? values[lineIndex] : []) as string[];
        const labelValues = (labelsIndex >= 0 ? values[labelsIndex] : []) as Array<
          string | Record<string, string>
        >;

        for (const [index, line] of lines.entries()) {
          logs.push({
            timestamp: String(timestamps[index] ?? ""),
            line,
            labels: labelValues[index] ? parseLabel(labelValues[index]) : {},
          });
        }
      }

      logs.sort((left, right) => (left.timestamp > right.timestamp ? -1 : 1));

      const result = {
        success: true,
        message: `LogQL query returned ${logs.length} log line(s)`,
        data: { logs, query: logql, logCount: logs.length },
        executionTimeMs: Date.now() - startedAt,
      };

      yield* Console.log(formatOutput(result, format));
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const result = {
            success: false,
            message: "Failed to execute LogQL query",
            error: formatGrafanaError(error),
            hint: "Check LogQL syntax and Grafana/Loki connectivity",
            executionTimeMs: Date.now() - startedAt,
          };

          yield* Console.log(formatOutput(result, format));
        }),
      ),
    );
  },
).pipe(Command.withDescription("Query logs via Grafana/Loki"));

export const logsCommand = Command.make("logs", {}).pipe(
  Command.withDescription("Loki log operations"),
  Command.withSubcommands([queryCommand]),
);
