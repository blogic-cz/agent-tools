import { Data, Effect, Option } from "effect";
import { Flag } from "effect/unstable/cli";

import { ConfigService, getToolConfig, type GrafanaConfig } from "#config";

const DEFAULT_LOCAL_URL = "http://localhost:40300";
const DEFAULT_PROMETHEUS_UID = "prometheus";
const DEFAULT_LOKI_UID = "loki";

export type GrafanaEnvConfig = {
  url: string;
  token?: string;
  prometheusUid: string;
  lokiUid: string;
};

export class GrafanaToolError extends Data.TaggedError("GrafanaToolError")<{
  readonly cause: unknown;
}> {}

export function formatGrafanaError(error: unknown): string {
  if (error instanceof GrafanaToolError) {
    return formatGrafanaError(error.cause);
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export const envOption = Flag.choice("env", ["local", "test", "prod"]).pipe(
  Flag.withDescription("Target environment: local (default), test, or prod"),
  Flag.withDefault("local"),
);

export const profileOption = Flag.optional(
  Flag.string("profile").pipe(
    Flag.withDescription(
      "Grafana profile name from agent-tools config (default: 'default' key or single entry)",
    ),
  ),
);

function resolveToken(tokenEnvVar?: string): string | undefined {
  if (!tokenEnvVar) {
    return undefined;
  }

  const token = process.env[tokenEnvVar];
  if (!token) {
    throw new Error(`${tokenEnvVar} environment variable is not set`);
  }

  return token;
}

function resolveFromProfile(
  profile: GrafanaConfig | undefined,
  env: string,
): GrafanaEnvConfig | undefined {
  const environment = profile?.environments[env];
  if (!environment) {
    return undefined;
  }

  return {
    url: environment.url,
    token: resolveToken(environment.tokenEnvVar),
    prometheusUid: environment.prometheusUid ?? DEFAULT_PROMETHEUS_UID,
    lokiUid: environment.lokiUid ?? DEFAULT_LOKI_UID,
  };
}

function resolveFromEnv(env: string): GrafanaEnvConfig {
  if (env === "local") {
    return {
      url: process.env.GRAFANA_URL_LOCAL ?? DEFAULT_LOCAL_URL,
      token: process.env.GRAFANA_TOKEN_LOCAL,
      prometheusUid: DEFAULT_PROMETHEUS_UID,
      lokiUid: DEFAULT_LOKI_UID,
    };
  }

  const upper = env.toUpperCase();
  const url = process.env[`GRAFANA_URL_${upper}`];
  const token = process.env[`GRAFANA_TOKEN_${upper}`];

  if (!url) {
    throw new Error(`No grafana.${env} config found and GRAFANA_URL_${upper} is not set`);
  }

  if (!token) {
    throw new Error(`No grafana.${env} config found and GRAFANA_TOKEN_${upper} is not set`);
  }

  return {
    url,
    token,
    prometheusUid: DEFAULT_PROMETHEUS_UID,
    lokiUid: DEFAULT_LOKI_UID,
  };
}

export const resolveConfig = (env: string, profile: Option.Option<string>) =>
  Effect.gen(function* () {
    const config = yield* ConfigService;
    const profileName = Option.getOrUndefined(profile);
    const grafanaConfig = getToolConfig<GrafanaConfig>(config, "grafana", profileName);
    return resolveFromProfile(grafanaConfig, env) ?? resolveFromEnv(env);
  });

export function buildHeaders(token?: string): Headers {
  const headers = new Headers({
    Accept: "application/json",
    "Content-Type": "application/json",
  });

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  } else {
    headers.set("Authorization", `Basic ${btoa("admin:admin")}`);
  }

  return headers;
}

export async function grafanaFetch<T>(
  config: GrafanaEnvConfig,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const headers = buildHeaders(config.token);
  if (init?.headers) {
    const extraHeaders = new Headers(init.headers);
    extraHeaders.forEach((value, key) => {
      headers.set(key, value);
    });
  }

  const response = await fetch(`${config.url}${path}`, {
    ...init,
    headers,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Grafana API ${response.status}: ${path} — ${body}`);
  }

  return response.json() as Promise<T>;
}

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

export function grafanaDsQuery(
  config: GrafanaEnvConfig,
  datasourceUid: string,
  datasourceType: string,
  expr: string,
  options?: DsQueryOpts,
): Promise<DsQueryResponse> {
  const opts = options ?? {};
  const query: Record<string, unknown> = {
    refId: "A",
    datasource: { uid: datasourceUid, type: datasourceType },
    expr,
    intervalMs: opts.intervalMs ?? 1000,
    maxDataPoints: opts.maxDataPoints ?? 1000,
  };

  if (datasourceType === "prometheus") {
    query.instant = opts.instant ?? true;
    query.range = !opts.instant;
    if (opts.step) {
      query.intervalMs = opts.step * 1000;
    }
  }

  if (datasourceType === "loki") {
    query.queryType = "range";
    if (opts.maxLines) {
      query.maxLines = opts.maxLines;
    }
  }

  return grafanaFetch<DsQueryResponse>(config, "/api/ds/query", {
    method: "POST",
    body: JSON.stringify({
      queries: [query],
      from: opts.from ?? "now-5m",
      to: opts.to ?? "now",
    }),
  });
}
