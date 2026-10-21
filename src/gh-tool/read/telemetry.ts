import { Context, Effect } from "effect";
import { redactSensitiveText } from "#shared/content-security";

export type RequestEvent = {
  ts: string;
  method: string;
  endpoint: string;
  status: number | null;
  outcome: "cache" | "304" | "200" | "bypass" | "error" | "subprocess";
  resource: string | null;
  used: number | null;
  remaining: number | null;
  reset: number | null;
};
export type RequestRow = RequestEvent & { id: number; invocation: string; command: string };
export type TelemetryStore = {
  record: (event: RequestEvent) => void;
  read: (since: string) => readonly RequestRow[];
  close: () => void;
};

export const Telemetry = Context.Reference<TelemetryStore | null>("gh/Telemetry", {
  defaultValue: () => null,
});
export const CacheRequest = Context.Reference<boolean>("gh/CacheRequest", {
  defaultValue: () => false,
});

export const templateEndpoint = (path: string): string => {
  const pathname = path.replace(/^https?:\/\/[^/]+/, "").split(/[?#]/, 1)[0] ?? "";
  return redactSensitiveText(
    `/${pathname.replace(/^\//, "")}`
      .replace(/\b[0-9a-f]{7,64}\b/gi, (part) => (/^\d+$/.test(part) ? ":id" : ":sha"))
      .replace(/\/\d+(?=\/|$)/g, "/:id"),
  );
};

export const recordRequest = (event: RequestEvent): Effect.Effect<void> =>
  Effect.gen(function* () {
    const store = yield* Telemetry;
    try {
      store?.record({
        ...event,
        endpoint:
          event.outcome === "subprocess" ? event.endpoint : templateEndpoint(event.endpoint),
      });
    } catch {
      /* Best effort. */
    }
  });

export const cacheEvent = (operation: string): RequestEvent => ({
  ts: new Date().toISOString(),
  method: "CACHE",
  endpoint: `cache/${operation}`,
  status: null,
  outcome: "cache",
  resource: null,
  used: null,
  remaining: null,
  reset: null,
});

const API_VALUE_FLAGS = new Set([
  "-X",
  "--method",
  "-H",
  "--header",
  "-f",
  "-F",
  "--field",
  "--raw-field",
  "--jq",
  "-q",
  "--template",
  "-t",
  "--input",
  "--cache",
  "-p",
  "--preview",
  "--hostname",
]);

export const ghSubprocessEvent = (args: readonly string[], exitCode: number): RequestEvent => {
  const api = args[0] === "api";
  let endpoint: string | undefined;
  let method: string | undefined;
  let hasFields = false;
  if (api) {
    for (let index = 1; index < args.length; index++) {
      const arg = args[index];
      if (arg === undefined) continue;
      if (arg === "--") {
        endpoint ??= args[index + 1];
        break;
      }
      if (!arg.startsWith("-")) {
        endpoint ??= arg;
        continue;
      }
      const equals = arg.indexOf("=");
      const flag = equals < 0 ? arg : arg.slice(0, equals);
      if (!API_VALUE_FLAGS.has(flag)) continue;
      const value = equals < 0 ? args[++index] : arg.slice(equals + 1);
      if (flag === "-X" || flag === "--method") method = value;
      if (flag === "-f" || flag === "-F" || flag === "--field" || flag === "--raw-field")
        hasFields = true;
    }
  }
  return {
    ...cacheEvent(""),
    method: api ? (method ?? (hasFields ? "POST" : "GET")) : "GH",
    endpoint: api ? templateEndpoint(endpoint ?? "") : args.slice(0, 2).join(" "),
    status: exitCode >= 100 && exitCode <= 599 ? exitCode : null,
    outcome: "subprocess",
  };
};

const counts = (values: readonly string[]) => {
  const groups = new Map<string, number>();
  for (const value of values) groups.set(value, (groups.get(value) ?? 0) + 1);
  return [...groups]
    .map(([name, requests]) => ({ name, requests }))
    .toSorted((a, b) => b.requests - a.requests || a.name.localeCompare(b.name));
};

const subprocessSpendsResource = (row: RequestRow, resource: string): boolean => {
  if (row.outcome !== "subprocess") return false;
  if (row.method === "GH") return true;
  if (row.method === "GET" && row.endpoint === "/rate_limit") return false;
  return row.endpoint === "/graphql" ? resource === "graphql" : resource !== "graphql";
};

export const summarizeRequests = (rows: readonly RequestRow[]) => {
  const requests = rows.filter((row) => row.outcome !== "cache" && row.outcome !== "subprocess");
  const subprocesses = rows.filter((row) => row.outcome === "subprocess");
  const previous = new Map<string, { used: number; index: number }>();
  let externalUsageEstimate = 0;
  let intervals = 0;
  for (const [index, row] of rows.entries()) {
    if (row.outcome === "cache" || row.outcome === "subprocess") continue;
    if (row.resource === null || row.used === null || row.reset === null) continue;
    const resource = row.resource;
    const key = `${resource}:${row.reset}`;
    const before = previous.get(key);
    if (before !== undefined && row.used >= before.used) {
      const interval = rows.slice(before.index + 1, index + 1);
      const own = interval.filter(
        (candidate) =>
          candidate.resource === resource &&
          (candidate.reset === null || candidate.reset === row.reset) &&
          candidate.status !== 304 &&
          candidate.endpoint !== "/rate_limit",
      ).length;
      const subprocessCalls = interval.filter((candidate) =>
        subprocessSpendsResource(candidate, resource),
      ).length;
      externalUsageEstimate += Math.max(0, row.used - before.used - own - subprocessCalls);
      intervals++;
    }
    if (before === undefined || row.used >= before.used)
      previous.set(key, { used: row.used, index });
  }
  const notModified = requests.filter((row) => row.status === 304).length;
  return {
    directHttpRequests: requests.length,
    ghSubprocessCalls: subprocesses.length,
    cacheHits: rows.filter((row) => row.outcome === "cache").length,
    subprocessTopCommands: counts(subprocesses.map((row) => redactSensitiveText(row.command)))
      .slice(0, 20)
      .map(({ name, requests: calls }) => ({ name, calls })),
    subprocessTopEndpoints: counts(subprocesses.map((row) => `${row.method} ${row.endpoint}`))
      .slice(0, 20)
      .map(({ name, requests: calls }) => ({ name, calls })),
    directHttpByResource: counts(requests.map((row) => row.resource ?? "unknown")),
    directHttpTopCommands: counts(requests.map((row) => redactSensitiveText(row.command))).slice(
      0,
      20,
    ),
    directHttpTopEndpoints: counts(requests.map((row) => `${row.method} ${row.endpoint}`)).slice(
      0,
      20,
    ),
    notModified,
    ratio304: requests.length === 0 ? null : notModified / requests.length,
    externalUsageEstimate: intervals === 0 ? null : externalUsageEstimate,
    observedIntervals: intervals,
    caveat:
      "Estimate within observed reset windows only. Missing headers, concurrent requests, different tokens and dropped telemetry reduce accuracy. Direct HTTP counts are exact. Each gh subprocess call may make zero or more HTTP requests; its HTTP status and quota headers are unavailable. For this estimate, subprocess calls count as one request each. Cache hits count ReadCache only.",
  };
};
