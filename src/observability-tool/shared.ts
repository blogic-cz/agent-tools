import { Effect, Option } from "effect";
import { Flag } from "effect/unstable/cli";

import { ConfigService, getToolConfig } from "#config";
import type { ObservabilityConfig } from "#config";

import { ObservabilityToolError } from "./errors";
import type {
  DsQueryOpts,
  DsQueryResponse,
  GrafanaDatasource,
  ObservabilityEnvConfig,
} from "./types";

const DEFAULT_LOCAL_URL = "http://localhost:40300";
const DEFAULT_PROMETHEUS_UID = "prometheus";
const DEFAULT_LOKI_UID = "loki";
const DEFAULT_TEMPO_UID = "tempo";

export function formatObservabilityError(error: unknown): string {
  if (error instanceof ObservabilityToolError) {
    return formatObservabilityError(error.cause);
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export const envOption = Flag.string("env").pipe(
  Flag.withDescription("Target environment name from agent-tools config (default: local)"),
  Flag.withDefault("local"),
);

export const profileOption = Flag.optional(
  Flag.string("profile").pipe(
    Flag.withDescription(
      "Observability profile name from agent-tools config (default: 'default' key or single entry)",
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

async function discoverDatasources(url: string, token?: string): Promise<GrafanaDatasource[]> {
  const headers = buildHeaders(token);
  const response = await fetch(`${url}/api/datasources`, { headers });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Grafana API ${response.status}: /api/datasources — ${body}`);
  }

  return (await response.json()) as GrafanaDatasource[];
}

async function resolveFromProfile(
  profile: ObservabilityConfig | undefined,
  env: string,
): Promise<ObservabilityEnvConfig | undefined> {
  const environment = profile?.environments[env];
  if (!environment) {
    return undefined;
  }

  const token = resolveToken(environment.tokenEnvVar);
  const datasources = await discoverDatasources(environment.url, token);

  const tempoUid =
    datasources.find((datasource) => datasource.uid === DEFAULT_TEMPO_UID)?.uid ??
    datasources.find((datasource) => datasource.type === "tempo")?.uid;

  if (!tempoUid) {
    throw new Error(`No Tempo datasource found in observability.${env} config`);
  }

  return {
    url: environment.url,
    token,
    prometheusUid: environment.prometheusUid ?? DEFAULT_PROMETHEUS_UID,
    lokiUid: environment.lokiUid ?? DEFAULT_LOKI_UID,
    tempoUid,
  };
}

function resolveFromEnv(
  env: string,
): Pick<ObservabilityEnvConfig, "url" | "token" | "prometheusUid" | "lokiUid"> {
  if (env === "local") {
    return {
      url: process.env.OBSERVABILITY_URL_LOCAL ?? DEFAULT_LOCAL_URL,
      token: process.env.OBSERVABILITY_TOKEN_LOCAL,
      prometheusUid: DEFAULT_PROMETHEUS_UID,
      lokiUid: DEFAULT_LOKI_UID,
    };
  }

  const upper = env.toUpperCase();
  const url = process.env[`OBSERVABILITY_URL_${upper}`];
  const token = process.env[`OBSERVABILITY_TOKEN_${upper}`];

  if (!url) {
    throw new Error(
      `No observability.${env} config found and OBSERVABILITY_URL_${upper} is not set`,
    );
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
    const observabilityConfig = getToolConfig<ObservabilityConfig>(
      config,
      "observability",
      profileName,
    );

    return yield* Effect.tryPromise({
      try: async () => {
        const profileResolved = await resolveFromProfile(observabilityConfig, env);
        if (profileResolved) {
          return profileResolved;
        }

        const resolved = resolveFromEnv(env);

        const datasources = await discoverDatasources(resolved.url, resolved.token);
        const tempoUid =
          datasources.find((datasource) => datasource.uid === DEFAULT_TEMPO_UID)?.uid ??
          datasources.find((datasource) => datasource.type === "tempo")?.uid;

        if (!tempoUid) {
          throw new Error(`No Tempo datasource found for environment '${env}'`);
        }

        return {
          ...resolved,
          tempoUid,
        } satisfies ObservabilityEnvConfig;
      },
      catch: (cause) => new ObservabilityToolError({ cause }),
    });
  });

export function buildHeaders(token?: string): Headers {
  const headers = new Headers({
    Accept: "application/json",
    "Content-Type": "application/json",
  });

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  return headers;
}

export function observabilityFetch<T>(
  config: ObservabilityEnvConfig,
  path: string,
  init?: RequestInit,
): Effect.Effect<T, ObservabilityToolError> {
  return Effect.tryPromise({
    try: async () => {
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

      return (await response.json()) as T;
    },
    catch: (cause) => new ObservabilityToolError({ cause }),
  });
}

export function observabilityDsQuery(
  config: ObservabilityEnvConfig,
  datasourceUid: string,
  datasourceType: "prometheus" | "loki",
  expr: string,
  options?: DsQueryOpts,
): Effect.Effect<DsQueryResponse, ObservabilityToolError> {
  const opts = options ?? {};
  const query: Record<string, unknown> = {
    refId: "A",
    datasource: { uid: datasourceUid, type: datasourceType },
    expr,
    intervalMs: opts.intervalMs ?? 1000,
    maxDataPoints: opts.maxDataPoints ?? 1000,
  };

  if (datasourceType === "prometheus") {
    const instant = opts.instant ?? true;
    query.instant = instant;
    query.range = !instant;
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

  return observabilityFetch<DsQueryResponse>(config, "/api/ds/query", {
    method: "POST",
    body: JSON.stringify({
      queries: [query],
      from: opts.from ?? "now-5m",
      to: opts.to ?? "now",
    }),
  });
}
