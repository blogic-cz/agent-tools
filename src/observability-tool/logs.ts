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

import type { LogLine, StructuredLogLine } from "./types";

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

function parseLabel(value: string | Record<string, string>): Record<string, string> {
  if (isStringRecord(value)) {
    return value;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return isStringRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseStructuredLogLine(line: string): StructuredLogLine {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }

    const record = parsed as Record<string, unknown>;
    return {
      body: typeof record.body === "string" ? record.body : undefined,
      severity: typeof record.severity === "string" ? record.severity : undefined,
      attributes:
        typeof record.attributes === "object" && record.attributes !== null
          ? (record.attributes as Record<string, unknown>)
          : undefined,
    };
  } catch {
    return {};
  }
}

export function extractLogsFromDsQuery(response: {
  results: {
    A: {
      frames?: Array<{
        schema: { fields: Array<{ name: string; type?: string }> };
        data: { values: unknown[][] };
      }>;
    };
  };
}): LogLine[] {
  const logs: LogLine[] = [];

  for (const frame of response.results.A.frames ?? []) {
    const fields = frame.schema.fields;
    const values = frame.data.values;
    const timeIndex = fields.findIndex(
      (field) => field.name === "timestamp" || field.name === "Time" || field.type === "time",
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
      const structured = parseStructuredLogLine(line);
      logs.push({
        timestamp: String(timestamps[index] ?? ""),
        line,
        ...structured,
        labels: labelValues[index] ? parseLabel(labelValues[index]) : {},
      });
    }
  }

  return logs;
}

const queryCommand = Command.make(
  "query",
  {
    logql: Argument.string("logql"),
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
    limit: Flag.integer("limit").pipe(
      Flag.withDescription("Max log lines (default: 100)"),
      Flag.withDefault(100),
    ),
  },
  ({ logql, format, env, profile, start, end, limit }) => {
    const startedAt = Date.now();

    return Effect.gen(function* () {
      const config = yield* resolveConfig(env, profile);
      const response = yield* observabilityDsQuery(config, config.lokiUid, "loki", logql, {
        from: start,
        to: end,
        maxLines: limit,
      });

      if (response.results.A.error) {
        return yield* new ObservabilityToolError({ cause: new Error(response.results.A.error) });
      }

      const logs = extractLogsFromDsQuery(response).toSorted((left, right) =>
        right.timestamp.localeCompare(left.timestamp),
      );

      const result = {
        success: true,
        message: `Found ${logs.length} Loki log line(s)`,
        data: {
          environment: env,
          grafanaUrl: config.url,
          lokiDatasourceUid: config.lokiUid,
          query: logql,
          start,
          end,
          limit,
          logCount: logs.length,
          logs,
        },
        executionTimeMs: Date.now() - startedAt,
      };

      yield* Console.log(formatOutput(result, format));
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const result = {
            success: false,
            message: "Failed to execute LogQL query",
            error: formatObservabilityError(error),
            hint: "Check LogQL syntax and Grafana/Loki connectivity",
            executionTimeMs: Date.now() - startedAt,
          };
          yield* Console.log(formatOutput(result, format));
        }),
      ),
    );
  },
).pipe(Command.withDescription("Execute LogQL range query via Grafana/Loki"));

export const logsCommand = Command.make("logs", {}).pipe(
  Command.withDescription("Loki log operations via Grafana"),
  Command.withSubcommands([queryCommand]),
);
