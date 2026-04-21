export type ObservabilityEnvConfig = {
  url: string;
  token?: string;
  prometheusUid: string;
  lokiUid: string;
  tempoUid: string;
};

export type GrafanaDatasource = {
  uid: string;
  name: string;
  type: string;
  url?: string;
};

export type OtlpAnyValue = {
  readonly stringValue?: string;
  readonly boolValue?: boolean;
  readonly intValue?: number | string;
  readonly doubleValue?: number;
  readonly arrayValue?: { readonly values?: readonly OtlpAnyValue[] };
  readonly kvlistValue?: {
    readonly values?: ReadonlyArray<{
      readonly key: string;
      readonly value?: OtlpAnyValue;
    }>;
  };
};

export type OtlpAttribute = {
  readonly key: string;
  readonly value?: OtlpAnyValue;
};

export type TempoTraceResponse = {
  readonly batches?: ReadonlyArray<{
    readonly resource?: {
      readonly attributes?: ReadonlyArray<OtlpAttribute>;
    };
    readonly scopeSpans?: ReadonlyArray<{
      readonly scope?: {
        readonly name?: string;
      };
      readonly spans?: ReadonlyArray<{
        readonly attributes?: ReadonlyArray<OtlpAttribute>;
        readonly endTimeUnixNano?: string;
        readonly kind?: string | number;
        readonly name?: string;
        readonly parentSpanId?: string;
        readonly spanId?: string;
        readonly startTimeUnixNano?: string;
        readonly status?: {
          readonly code?: string | number;
          readonly message?: string;
        };
        readonly traceId?: string;
      }>;
    }>;
  }>;
};

export type FlattenedSpan = {
  readonly serviceName: string;
  readonly scopeName?: string;
  readonly name: string;
  readonly kind?: string | number;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly parentSpanId?: string;
  readonly startTimeUnixNano?: string;
  readonly endTimeUnixNano?: string;
  readonly durationMs?: number;
  readonly statusCode?: string | number;
  readonly statusMessage?: string;
  readonly isError: boolean;
  readonly attributes: Record<string, unknown>;
  readonly resourceAttributes: Record<string, unknown>;
};

export type TraceSummary = {
  readonly traceId: string;
  readonly spanCount: number;
  readonly serviceCount: number;
  readonly services: string[];
  readonly errorSpanCount: number;
  readonly rootSpans: FlattenedSpan[];
  readonly totalDurationMs?: number;
  readonly startedAtUnixNano?: string;
  readonly endedAtUnixNano?: string;
};

export type DsQueryOpts = {
  instant?: boolean;
  from?: string;
  to?: string;
  maxLines?: number;
  intervalMs?: number;
  maxDataPoints?: number;
  step?: number;
};

export type DsQueryResponse = {
  results: {
    A: {
      status?: number;
      frames?: Array<{
        schema: {
          fields: Array<{
            name: string;
            type?: string;
            labels?: Record<string, string>;
          }>;
        };
        data: { values: unknown[][] };
      }>;
      error?: string;
    };
  };
};
