export type GrafanaEnvConfig = {
  url: string;
  token?: string;
  prometheusUid: string;
  lokiUid: string;
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
        schema: { fields: Array<{ name: string; type: string }> };
        data: { values: unknown[][] };
      }>;
      error?: string;
    };
  };
};
