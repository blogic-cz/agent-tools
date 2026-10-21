import { CacheRequest, recordRequest } from "./telemetry";

import { Clock, Context, Effect } from "effect";

import { registerResolvedSecret } from "#shared/content-security";
import { retryTransient } from "#shared/retry-transient";

import { GitHubAuthError, GitHubCommandError, GitHubNotFoundError } from "#gh/errors";
import type { GitHubApiError } from "#gh/errors";
import { ghEnvironment } from "#gh/environment";
import { validateOutboundText } from "#gh/text-input";

// Direct HTTP, not `gh api`: the CLI collapses every failure into a non-zero exit and
// loses the status code, but merge-async answers 202 (accepted), 200 (already merged or
// queued) and 409 (a request already exists, UUID returned) as three different outcomes.
const GITHUB_API_ROOT = "https://api.github.com";
const GITHUB_ACCEPT = "application/vnd.github+json";
const GITHUB_API_VERSION = "2022-11-28";

export type GitHubApiResponse<T> = {
  status: number;
  body: T;
  etag?: string;
  link?: string;
  rateLimitResource?: string;
  rateLimitUsed?: string;
};

export type GitHubRateLimitHeaders = {
  readonly resource?: string;
  readonly limit?: number;
  readonly used?: number;
  readonly remaining?: number;
  readonly reset?: number;
};

const headerInteger = (headers: Headers, name: string) => {
  const value = headers.get(name);
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

export const parseRateLimitHeaders = (headers: Headers): GitHubRateLimitHeaders => {
  const resource = headers.get("x-ratelimit-resource");
  const limit = headerInteger(headers, "x-ratelimit-limit");
  const used = headerInteger(headers, "x-ratelimit-used");
  const remaining = headerInteger(headers, "x-ratelimit-remaining");
  const reset = headerInteger(headers, "x-ratelimit-reset");
  return {
    ...(resource === null ? {} : { resource }),
    ...(limit === undefined ? {} : { limit }),
    ...(used === undefined ? {} : { used }),
    ...(remaining === undefined ? {} : { remaining }),
    ...(reset === undefined ? {} : { reset }),
  };
};

const authFailure = (message: string) =>
  new GitHubAuthError({
    message,
    hint: "Set GITHUB_TOKEN or GH_TOKEN, or authenticate the GitHub CLI with 'gh auth login'.",
    nextCommand: "gh auth login",
  });

// Environment first, GH_TOKEN before GITHUB_TOKEN to match the gh CLI: the active gh
// account is directory-scoped global state and the shell exports the matching token.
// `gh auth token` only covers shells that export none.
export const SessionCredential = Context.Reference<string | null>(
  "@agent-tools/SessionCredential",
  {
    defaultValue: () => null,
  },
);

export const resolveGitHubToken = Effect.fn("gh.resolveGitHubToken")(function* () {
  const pinned = yield* SessionCredential;
  if (pinned !== null) return pinned;
  const fromEnv = [process.env["GH_TOKEN"], process.env["GITHUB_TOKEN"]].find(
    (candidate) => candidate !== undefined && candidate.length > 0,
  );
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }

  // Bun.spawn rather than the ChildProcessSpawner service on purpose: routing it through
  // the service would put that requirement in the error channel of every command that
  // reads the API, and token resolution is not what those commands are testing.
  const token = yield* Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(["gh", "auth", "token", "--hostname", "github.com"], {
        stdout: "pipe",
        stderr: "ignore",
        env: ghEnvironment(),
      });
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      return exitCode === 0 ? stdout.trim() : "";
    },
    catch: () => authFailure("No GitHub token available."),
  }).pipe(Effect.orElseSucceed(() => ""));
  if (token.length === 0) {
    return yield* authFailure("No GitHub token available.");
  }

  registerResolvedSecret(token);
  return token;
});

export type GitHubApiRequest = {
  path: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  alsoAcceptStatus?: number[];
  ifNoneMatch?: string;
};

const MAX_API_RETRIES = 2;
const MAX_RATE_LIMIT_WAIT_MS = 60_000;
const rateLimitRetryDelays = new WeakMap<GitHubCommandError, number>();

// Traverse only parsed JSON, never the caller's getters or toJSON hooks.
const decodedBodyText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(decodedBodyText).join("\n");
  if (value !== null && typeof value === "object")
    return Object.entries(value)
      .map(([key, item]) => `${key}\n${decodedBodyText(item)}`)
      .join("\n");
  return "";
};

const githubApiAttempt = Effect.fn("gh.githubApiAttempt")(function* <T>(
  opts: GitHubApiRequest,
  serializedBody: string | undefined,
) {
  const method = opts.method ?? "GET";
  const token = yield* resolveGitHubToken();
  const url = `${GITHUB_API_ROOT}/${opts.path.replace(/^\//, "")}`;

  const cached = yield* CacheRequest;
  const started = new Date().toISOString();
  const response = yield* Effect.tryPromise({
    try: () =>
      fetch(url, {
        method,
        headers: {
          Accept: GITHUB_ACCEPT,
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
          ...(opts.ifNoneMatch === undefined ? {} : { "If-None-Match": opts.ifNoneMatch }),
          ...(serializedBody === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(serializedBody === undefined ? {} : { body: serializedBody }),
      }),
    catch: (cause) =>
      new GitHubCommandError({
        message: `GitHub API request failed: ${String(cause)}`,
        command: `${method} ${opts.path}`,
        exitCode: -1,
        stderr: String(cause),
        retryable: true,
        hint: "Check network connectivity and VPN state, then retry.",
      }),
  }).pipe(
    Effect.tapError(() =>
      recordRequest({
        ts: started,
        method,
        endpoint: opts.path,
        status: null,
        outcome: "error",
        resource: null,
        used: null,
        remaining: null,
        reset: null,
      }),
    ),
  );

  const quota = parseRateLimitHeaders(response.headers);
  yield* recordRequest({
    ts: started,
    method,
    endpoint: opts.path,
    status: response.status,
    outcome:
      response.status === 304
        ? "304"
        : response.status >= 400
          ? "error"
          : cached
            ? "200"
            : "bypass",
    resource: quota.resource ?? null,
    used: quota.used ?? null,
    remaining: quota.remaining ?? null,
    reset: quota.reset ?? null,
  });
  const text = yield* Effect.tryPromise({
    try: () => response.text(),
    catch: (cause) =>
      new GitHubCommandError({
        message: `GitHub API response could not be read: ${String(cause)}`,
        command: `${method} ${opts.path}`,
        exitCode: -1,
        stderr: String(cause),
        hint: "The connection dropped mid-response. Re-read the resource before retrying a mutation.",
      }),
  });
  const parsed: unknown = text.length === 0 ? null : safeJsonParse(text);

  const accepted = new Set([
    200,
    ...(opts.alsoAcceptStatus ?? []),
    ...(method === "GET" && opts.ifNoneMatch !== undefined ? [304] : []),
  ]);
  if (accepted.has(response.status)) {
    const metadata = {
      etag: response.headers.get("etag"),
      link: response.headers.get("link"),
      rateLimitResource: response.headers.get("x-ratelimit-resource"),
      rateLimitUsed: response.headers.get("x-ratelimit-used"),
    };
    return {
      status: response.status,
      body: parsed as T,
      ...Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== null)),
    };
  }

  if (response.status === 401) {
    return yield* authFailure("GitHub credentials rejected (HTTP 401).");
  }

  if (response.status === 404) {
    return yield* new GitHubNotFoundError({
      message: `GitHub API returned 404 for ${opts.path}`,
      identifier: opts.path,
      resource: "github-api",
      hint: "Verify the resource exists, that you have access, and that the feature is enabled for this repository.",
    });
  }

  const now = yield* Clock.currentTimeMillis;
  const rateLimitHeaders = parseRateLimitHeaders(response.headers);
  const resetSeconds = rateLimitHeaders.reset ?? Number.NaN;
  const resetDelay =
    Number.isFinite(resetSeconds) && resetSeconds > 0
      ? Math.max(0, resetSeconds * 1000 - now + 1000)
      : undefined;
  const retryAfter = response.headers.get("retry-after");
  const retryAfterMs =
    retryAfter === null
      ? undefined
      : /^\d+(?:\.\d+)?$/.test(retryAfter)
        ? Number(retryAfter) * 1000
        : Date.parse(retryAfter) - now;
  const waitMs =
    retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
      ? retryAfterMs
      : resetDelay;
  const canWait = waitMs !== undefined && waitMs <= MAX_RATE_LIMIT_WAIT_MS;
  const rateLimit =
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.get("x-ratelimit-remaining") === "0" ||
        /rate limit|secondary rate limit|abuse detection/i.test(
          apiErrorMessage(parsed, response.status),
        )));
  const error = new GitHubCommandError({
    message: rateLimit
      ? `${apiErrorMessage(parsed, response.status)}; resource: ${rateLimitHeaders.resource ?? "unavailable"}; reset time: ${rateLimitHeaders.reset === undefined ? "unavailable" : new Date(resetSeconds * 1000).toISOString()}; remaining quota: ${rateLimitHeaders.remaining ?? "unavailable"}`
      : apiErrorMessage(parsed, response.status),
    command: `${method} ${opts.path}`,
    exitCode: response.status,
    stderr: text,
    ...(rateLimit
      ? {
          hint: "Wait for the reset before retrying. Check the named resource with the shown command; the lookup does not consume quota.",
          nextCommand: "gh-tool rate-limit",
        }
      : {}),
    ...(response.status >= 500 || (rateLimit && canWait) ? { retryable: true } : {}),
  });
  if (rateLimit && canWait && waitMs !== undefined) rateLimitRetryDelays.set(error, waitMs);
  return yield* error;
});

// Mirrors GitHubService.runGh: replay a transient failure, and only for an idempotent read.
export const githubApi = <T>(
  opts: GitHubApiRequest,
): Effect.Effect<GitHubApiResponse<T>, GitHubApiError> =>
  Effect.gen(function* () {
    const snapshot = yield* Effect.try({
      try: () => {
        const path = opts.path;
        const method = opts.method ?? "GET";
        const alsoAcceptStatus = opts.alsoAcceptStatus;
        const ifNoneMatch = opts.ifNoneMatch;
        const request = {
          path,
          method,
          ...(alsoAcceptStatus === undefined ? {} : { alsoAcceptStatus: [...alsoAcceptStatus] }),
          ...(ifNoneMatch === undefined ? {} : { ifNoneMatch }),
        };
        const body = opts.body;
        if (body === undefined) return { request, serialized: undefined, decoded: "" };
        const serialized = JSON.stringify(body);
        if (serialized === undefined) throw new Error("Body is not JSON serializable");
        return { request, serialized, decoded: decodedBodyText(JSON.parse(serialized)) };
      },
      catch: () =>
        new GitHubCommandError({
          command: "gh-tool API",
          exitCode: 1,
          stderr: "Refusing to publish an invalid request body",
          message: "Refusing to publish an invalid request body",
        }),
    });
    const { request } = snapshot;
    yield* validateOutboundText(
      `${request.path}\n${snapshot.serialized ?? ""}\n${snapshot.decoded}`,
      `gh-tool ${request.method} ${request.path}`,
    );
    return yield* retryTransient({
      attempt: () => githubApiAttempt<T>(request, snapshot.serialized),
      isTransient: (error) =>
        error._tag === "GitHubCommandError" && error.retryable === true && request.method === "GET",
      maxRetries: MAX_API_RETRIES,
      retryDelayMs: (error, _attempt, fallbackMs) =>
        error instanceof GitHubCommandError
          ? Math.max(fallbackMs, rateLimitRetryDelays.get(error) ?? 0)
          : fallbackMs,
    });
  });

const safeJsonParse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const apiErrorMessage = (body: unknown, status: number): string => {
  if (typeof body === "object" && body !== null && "message" in body) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === "string") {
      return `GitHub API error (HTTP ${status}): ${message}`;
    }
  }
  return `GitHub API error (HTTP ${status})`;
};
