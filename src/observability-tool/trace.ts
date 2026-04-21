import { Console, Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { formatOption, formatOutput } from "#shared";

import { ObservabilityToolError } from "./errors";
import {
  envOption,
  formatObservabilityError,
  observabilityDsQuery,
  observabilityFetch,
  profileOption,
  resolveConfig,
} from "./shared";
import type {
  FlattenedSpan,
  OtlpAnyValue,
  OtlpAttribute,
  TempoTraceResponse,
  TraceSummary,
} from "./types";

function isHexTraceId(value: string): boolean {
  return /^[\da-f]{32}$/i.test(value);
}

function getStringAttribute(
  attributes: ReadonlyArray<OtlpAttribute> | null,
  key: string,
): string | undefined {
  const attribute = attributes?.find((item) => item.key === key);
  const value = attribute?.value;

  if (value?.stringValue !== undefined) return value.stringValue;
  if (value?.intValue !== undefined) return String(value.intValue);
  if (value?.doubleValue !== undefined) return String(value.doubleValue);
  if (value?.boolValue !== undefined) return String(value.boolValue);
  return undefined;
}

function anyValueToUnknown(value?: OtlpAnyValue): unknown {
  if (value === undefined) return undefined;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.intValue !== undefined) return value.intValue;
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.arrayValue?.values !== undefined) {
    return value.arrayValue.values.map((item) => anyValueToUnknown(item));
  }
  if (value.kvlistValue?.values !== undefined) {
    return Object.fromEntries(
      value.kvlistValue.values.map((entry) => [entry.key, anyValueToUnknown(entry.value)]),
    );
  }
  return undefined;
}

function attributesToRecord(
  attributes: ReadonlyArray<OtlpAttribute> | null,
): Record<string, unknown> {
  return Object.fromEntries(
    (attributes ?? [])
      .map((attribute) => [attribute.key, anyValueToUnknown(attribute.value)] as const)
      .filter((entry) => entry[1] !== undefined),
  );
}

function decodeIdToHex(value?: string, expectedBytes?: number): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;

  const expectedHexLength = expectedBytes === undefined ? undefined : expectedBytes * 2;
  if (
    expectedHexLength !== undefined &&
    new RegExp(`^[\\da-f]{${expectedHexLength}}$`, "i").test(trimmed)
  ) {
    return trimmed.toLowerCase();
  }

  try {
    const bytes = Buffer.from(trimmed, "base64");
    if (expectedBytes !== undefined && bytes.length !== expectedBytes) {
      return undefined;
    }
    return bytes.toString("hex");
  } catch {
    return undefined;
  }
}

function nanoToBigInt(value?: string): bigint | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}

function computeDurationMs(start?: string, end?: string): number | undefined {
  const startNano = nanoToBigInt(start);
  const endNano = nanoToBigInt(end);

  if (startNano === undefined || endNano === undefined || endNano < startNano) {
    return undefined;
  }

  return Number(endNano - startNano) / 1_000_000;
}

function isErrorStatus(code?: string | number): boolean {
  if (code === undefined) return false;
  if (typeof code === "number") return code === 2;
  return code.toUpperCase().includes("ERROR") || code === "2";
}

function flattenTrace(trace: TempoTraceResponse): FlattenedSpan[] {
  const spans: FlattenedSpan[] = [];

  for (const batch of trace.batches ?? []) {
    const resourceAttributes = attributesToRecord(batch.resource?.attributes ?? null);
    const serviceName =
      getStringAttribute(batch.resource?.attributes ?? null, "service.name") ?? "unknown-service";

    for (const scopeSpan of batch.scopeSpans ?? []) {
      for (const span of scopeSpan.spans ?? []) {
        spans.push({
          serviceName,
          scopeName: scopeSpan.scope?.name,
          name: span.name ?? "unknown-span",
          kind: span.kind,
          traceId: decodeIdToHex(span.traceId, 16),
          spanId: decodeIdToHex(span.spanId, 8),
          parentSpanId: decodeIdToHex(span.parentSpanId, 8),
          startTimeUnixNano: span.startTimeUnixNano,
          endTimeUnixNano: span.endTimeUnixNano,
          durationMs: computeDurationMs(span.startTimeUnixNano, span.endTimeUnixNano),
          statusCode: span.status?.code,
          statusMessage: span.status?.message,
          isError: isErrorStatus(span.status?.code),
          attributes: attributesToRecord(span.attributes ?? null),
          resourceAttributes,
        });
      }
    }
  }

  return spans.toSorted((left, right) => {
    const leftStart = nanoToBigInt(left.startTimeUnixNano) ?? 0n;
    const rightStart = nanoToBigInt(right.startTimeUnixNano) ?? 0n;
    return leftStart < rightStart ? -1 : leftStart > rightStart ? 1 : 0;
  });
}

function summarizeTrace(traceId: string, spans: readonly FlattenedSpan[]): TraceSummary {
  const services = [...new Set(spans.map((span) => span.serviceName))].toSorted();
  const spanIds = new Set(
    spans.map((span) => span.spanId).filter((value): value is string => value !== undefined),
  );
  const rootSpans = spans.filter(
    (span) => span.parentSpanId === undefined || !spanIds.has(span.parentSpanId),
  );

  const startedAt = spans.reduce<bigint | undefined>((current, span) => {
    const value = nanoToBigInt(span.startTimeUnixNano);
    if (value === undefined) return current;
    if (current === undefined || value < current) return value;
    return current;
  }, undefined);
  const endedAt = spans.reduce<bigint | undefined>((current, span) => {
    const value = nanoToBigInt(span.endTimeUnixNano);
    if (value === undefined) return current;
    if (current === undefined || value > current) return value;
    return current;
  }, undefined);

  return {
    traceId,
    spanCount: spans.length,
    serviceCount: services.length,
    services,
    errorSpanCount: spans.filter((span) => span.isError).length,
    rootSpans,
    totalDurationMs:
      startedAt !== undefined && endedAt !== undefined && endedAt >= startedAt
        ? Number(endedAt - startedAt) / 1_000_000
        : undefined,
    startedAtUnixNano: startedAt?.toString(),
    endedAtUnixNano: endedAt?.toString(),
  };
}

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

const getCommand = Command.make(
  "get",
  {
    traceId: Argument.string("traceId"),
    format: formatOption,
    env: envOption,
    profile: profileOption,
  },
  ({ traceId, format, env, profile }) => {
    const startedAt = Date.now();

    return Effect.gen(function* () {
      if (!isHexTraceId(traceId)) {
        return yield* new ObservabilityToolError({
          cause: new Error("trace get requires a 32-character hex trace ID"),
        });
      }

      const config = yield* resolveConfig(env, profile);
      const raw = yield* observabilityFetch<TempoTraceResponse>(
        config,
        `/api/datasources/proxy/uid/${config.tempoUid}/api/traces/${traceId.toLowerCase()}`,
      );
      const spans = flattenTrace(raw);

      if (spans.length === 0) {
        return yield* new ObservabilityToolError({
          cause: new Error(`Trace ${traceId} returned zero spans`),
        });
      }

      const result = {
        success: true,
        message: `Resolved trace ${traceId.toLowerCase()} with ${spans.length} span(s)`,
        data: {
          environment: env,
          grafanaUrl: config.url,
          tempoDatasourceUid: config.tempoUid,
          summary: summarizeTrace(traceId.toLowerCase(), spans),
          spans,
        },
        executionTimeMs: Date.now() - startedAt,
      };

      yield* Console.log(formatOutput(result, format));
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const result = {
            success: false,
            message: "Failed to resolve trace from Tempo",
            error: formatObservabilityError(error),
            hint: "Check trace ID format and Grafana/Tempo connectivity",
            executionTimeMs: Date.now() - startedAt,
          };
          yield* Console.log(formatOutput(result, format));
        }),
      ),
    );
  },
).pipe(Command.withDescription("Resolve a trace by ID via Grafana/Tempo"));

const logsCommand = Command.make(
  "logs",
  {
    traceId: Argument.string("traceId"),
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
  ({ traceId, format, env, profile, limit, start, end }) => {
    const startedAt = Date.now();

    return Effect.gen(function* () {
      if (!isHexTraceId(traceId)) {
        return yield* new ObservabilityToolError({
          cause: new Error("trace logs requires a 32-character hex trace ID"),
        });
      }

      const config = yield* resolveConfig(env, profile);
      const normalizedTraceId = traceId.toLowerCase();
      const logql = `{job=~".+"} |= "${normalizedTraceId}"`;
      const response = yield* observabilityDsQuery(config, config.lokiUid, "loki", logql, {
        from: start,
        to: end,
        maxLines: limit,
      });

      if (response.results.A.error) {
        return yield* new ObservabilityToolError({
          cause: new Error(response.results.A.error),
        });
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

      const result = {
        success: true,
        message: `Found ${logs.length} log line(s) mentioning trace ${normalizedTraceId}`,
        data: {
          environment: env,
          grafanaUrl: config.url,
          lokiDatasourceUid: config.lokiUid,
          query: logql,
          logCount: logs.length,
          logs: logs.toSorted((left, right) => right.timestamp.localeCompare(left.timestamp)),
        },
        executionTimeMs: Date.now() - startedAt,
      };

      yield* Console.log(formatOutput(result, format));
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const result = {
            success: false,
            message: "Failed to execute trace log lookup",
            error: formatObservabilityError(error),
            hint: "Check trace ID format and Grafana/Loki connectivity",
            executionTimeMs: Date.now() - startedAt,
          };
          yield* Console.log(formatOutput(result, format));
        }),
      ),
    );
  },
).pipe(Command.withDescription("Find Loki logs mentioning a trace ID"));

export const traceCommand = Command.make("trace", {}).pipe(
  Command.withDescription("Tempo trace operations"),
  Command.withSubcommands([getCommand, logsCommand]),
);
