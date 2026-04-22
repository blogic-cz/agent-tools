import { Console, Effect, type Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { formatOption, formatOutput } from "#shared";
import type { OutputFormat } from "#shared";

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
  ObservabilityEnvConfig,
  OtlpAnyValue,
  OtlpAttribute,
  ParsedId,
  SearchWindow,
  SpanResolution,
  TempoSearchResponse,
  TempoTraceResponse,
  TraceSummary,
} from "./types";

const SPAN_SEARCH_WINDOWS: SearchWindow[] = [
  { start: "now-1h", end: "now" },
  { start: "now-24h", end: "now" },
];

function parseId(value: string): ParsedId | undefined {
  const trimmed = value.trim().toLowerCase();
  if (/^[\da-f]{32}$/.test(trimmed)) {
    return { rawId: value, normalizedId: trimmed, kind: "trace_id" };
  }
  if (/^[\da-f]{16}$/.test(trimmed)) {
    return { rawId: value, normalizedId: trimmed, kind: "span_id" };
  }
  return undefined;
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

function relativeToEpoch(value: string, nowEpoch: number): number {
  const match = /^now-(\d+)([smhd])$/.exec(value.trim());
  if (!match) return nowEpoch;

  const amount = Number(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return nowEpoch - amount * (multipliers[unit] ?? 1);
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

type ResolvedTrace = {
  readonly resolution: SpanResolution;
  readonly spans: FlattenedSpan[];
};

function searchTempoBySpanId(
  config: ObservabilityEnvConfig,
  spanId: string,
  window: SearchWindow,
): Effect.Effect<TempoSearchResponse, ObservabilityToolError> {
  const now = Math.floor(Date.now() / 1000);
  const startEpoch = relativeToEpoch(window.start, now);
  const endEpoch = relativeToEpoch(window.end, now);
  const traceql = encodeURIComponent(`{ span:id = "${spanId}" }`);
  const searchUrl =
    `/api/datasources/proxy/uid/${config.tempoUid}/api/search` +
    `?q=${traceql}&start=${startEpoch}&end=${endEpoch}&limit=5`;

  return observabilityFetch<TempoSearchResponse>(config, searchUrl);
}

function fetchFullTrace(
  config: ObservabilityEnvConfig,
  traceId: string,
): Effect.Effect<FlattenedSpan[], ObservabilityToolError> {
  return Effect.gen(function* () {
    const raw = yield* observabilityFetch<TempoTraceResponse>(
      config,
      `/api/datasources/proxy/uid/${config.tempoUid}/api/traces/${traceId}`,
    );
    return flattenTrace(raw);
  });
}

function resolveTraceFromId(
  config: ObservabilityEnvConfig,
  parsed: ParsedId,
  explicitWindows?: { start: string; end: string },
): Effect.Effect<ResolvedTrace, ObservabilityToolError> {
  return Effect.gen(function* () {
    if (parsed.kind === "trace_id") {
      const spans = yield* fetchFullTrace(config, parsed.normalizedId);
      if (spans.length === 0) {
        return yield* new ObservabilityToolError({
          cause: new Error(`Trace ${parsed.normalizedId} returned zero spans`),
        });
      }
      return {
        resolution: {
          via: "direct_trace_id" as const,
          resolvedTraceId: parsed.normalizedId,
        },
        spans,
      };
    }

    const windows = explicitWindows
      ? [{ start: explicitWindows.start, end: explicitWindows.end }]
      : SPAN_SEARCH_WINDOWS;

    const attemptedWindows: SearchWindow[] = [];
    let usedWindow: SearchWindow | undefined;
    let uniqueTraceIds: string[] = [];

    for (const window of windows) {
      attemptedWindows.push(window);
      const searchResult = yield* searchTempoBySpanId(config, parsed.normalizedId, window);
      const traces = searchResult.traces ?? [];

      if (traces.length === 0) continue;

      const candidateTraceIds = traces
        .map((trace) => trace.traceID?.toLowerCase())
        .filter((id): id is string => id !== undefined);

      uniqueTraceIds = [...new Set(candidateTraceIds)];

      if (uniqueTraceIds.length > 1) {
        return yield* new ObservabilityToolError({
          cause: {
            message: `Ambiguous span ID ${parsed.normalizedId} — found in ${uniqueTraceIds.length} traces`,
            code: "AMBIGUOUS_SPAN_ID",
            retryable: true,
            details: { candidateTraceIds: uniqueTraceIds },
          },
        });
      }

      usedWindow = window;
      break;
    }

    if (uniqueTraceIds.length === 0 || !usedWindow) {
      const windowDesc = attemptedWindows
        .map((window) => `${window.start} → ${window.end}`)
        .join(", ");
      return yield* new ObservabilityToolError({
        cause: new Error(
          `No trace found containing span ${parsed.normalizedId} (searched windows: ${windowDesc})`,
        ),
      });
    }

    const traceId = uniqueTraceIds[0];
    const spans = yield* fetchFullTrace(config, traceId);

    if (spans.length === 0) {
      return yield* new ObservabilityToolError({
        cause: new Error(`Trace ${traceId} returned zero spans`),
      });
    }

    const focusSpan = spans.find((span) => span.spanId === parsed.normalizedId);

    return {
      resolution: {
        via: "span_search" as const,
        resolvedTraceId: traceId,
        searchedSpanId: parsed.normalizedId,
        focusSpan,
        attemptedWindows,
        usedWindow,
      },
      spans,
    };
  });
}

function handleTraceGet(
  id: string,
  format: OutputFormat,
  env: string,
  profile: Option.Option<string>,
) {
  const startedAt = Date.now();

  return Effect.gen(function* () {
    const parsed = parseId(id);
    if (!parsed) {
      return yield* new ObservabilityToolError({
        cause: {
          message: `Invalid ID format: expected 32-char trace ID or 16-char span ID, got ${id.length} characters`,
          code: "INVALID_ID_FORMAT",
          retryable: false,
        },
      });
    }

    const config = yield* resolveConfig(env, profile);
    const { resolution, spans } = yield* resolveTraceFromId(config, parsed);

    const result = {
      success: true,
      message:
        parsed.kind === "span_id"
          ? `Found trace ${resolution.resolvedTraceId} via span ${parsed.normalizedId} with ${spans.length} span(s)`
          : `Resolved trace ${resolution.resolvedTraceId} with ${spans.length} span(s)`,
      data: {
        environment: env,
        grafanaUrl: config.url,
        tempoDatasourceUid: config.tempoUid,
        input: parsed,
        resolution,
        summary: summarizeTrace(resolution.resolvedTraceId, spans),
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
          hint: "Accepts 32-char trace ID or 16-char span ID. Check format and Grafana/Tempo connectivity",
          executionTimeMs: Date.now() - startedAt,
        };
        yield* Console.log(formatOutput(result, format));
      }),
    ),
  );
}

const getCommand = Command.make(
  "get",
  {
    id: Argument.string("id"),
    format: formatOption,
    env: envOption,
    profile: profileOption,
  },
  ({ id, format, env, profile }) => handleTraceGet(id, format, env, profile),
).pipe(Command.withDescription("Resolve a trace by trace ID or span ID via Grafana/Tempo"));

const logsCommand = Command.make(
  "logs",
  {
    id: Argument.string("id"),
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
  ({ id, format, env, profile, limit, start, end }) => {
    const startedAt = Date.now();

    return Effect.gen(function* () {
      const parsed = parseId(id);
      if (!parsed) {
        return yield* new ObservabilityToolError({
          cause: {
            message: `Invalid ID format: expected 32-char trace ID or 16-char span ID, got ${id.length} characters`,
            code: "INVALID_ID_FORMAT",
            retryable: false,
          },
        });
      }

      const config = yield* resolveConfig(env, profile);
      const { resolution } = yield* resolveTraceFromId(config, parsed, { start, end });
      const resolvedTraceId = resolution.resolvedTraceId;

      const logql = `{job=~".+"} |= "${resolvedTraceId}"`;
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
        message:
          parsed.kind === "span_id"
            ? `Found ${logs.length} log line(s) for trace ${resolvedTraceId} (resolved from span ${parsed.normalizedId})`
            : `Found ${logs.length} log line(s) mentioning trace ${resolvedTraceId}`,
        data: {
          environment: env,
          grafanaUrl: config.url,
          lokiDatasourceUid: config.lokiUid,
          input: parsed,
          resolution,
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
            hint: "Accepts 32-char trace ID or 16-char span ID. Check format and Grafana/Loki connectivity",
            executionTimeMs: Date.now() - startedAt,
          };
          yield* Console.log(formatOutput(result, format));
        }),
      ),
    );
  },
).pipe(Command.withDescription("Find Loki logs mentioning a trace (accepts trace ID or span ID)"));

const findCommand = Command.make(
  "find",
  {
    id: Argument.string("id"),
    format: formatOption,
    env: envOption,
    profile: profileOption,
  },
  ({ id, format, env, profile }) => handleTraceGet(id, format, env, profile),
).pipe(Command.withDescription("Alias for 'trace get' — resolve a trace by trace ID or span ID"));

export const traceCommand = Command.make("trace", {}).pipe(
  Command.withDescription("Tempo trace operations"),
  Command.withSubcommands([getCommand, logsCommand, findCommand]),
);
