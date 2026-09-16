import { Duration, Effect } from "effect";

import { GitHubAuthError, GitHubCommandError, GitHubNotFoundError } from "./errors";

// Direct HTTP, not `gh api`: the CLI collapses every failure into a non-zero exit and
// loses the status code, but merge-async answers 202 (accepted), 200 (already merged or
// queued) and 409 (a request already exists, UUID returned) as three different outcomes.
const GITHUB_API_ROOT = "https://api.github.com";
const GITHUB_ACCEPT = "application/vnd.github+json";
const GITHUB_API_VERSION = "2022-11-28";

export type GitHubApiResponse<T> = {
  status: number;
  body: T;
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
export const resolveGitHubToken = Effect.fn("gh.resolveGitHubToken")(function* () {
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

  return token;
});

export type GitHubApiRequest = {
  path: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  alsoAcceptStatus?: number[];
};

const MAX_API_RETRIES = 2;

const githubApiAttempt = Effect.fn("gh.githubApiAttempt")(function* <T>(opts: GitHubApiRequest) {
  const token = yield* resolveGitHubToken();
  const method = opts.method ?? "GET";
  const url = `${GITHUB_API_ROOT}/${opts.path.replace(/^\//, "")}`;

  const response = yield* Effect.tryPromise({
    try: () =>
      fetch(url, {
        method,
        headers: {
          Accept: GITHUB_ACCEPT,
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
          ...(opts.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
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

  const accepted = new Set([200, ...(opts.alsoAcceptStatus ?? [])]);
  if (accepted.has(response.status)) {
    return { status: response.status, body: parsed as T };
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

  return yield* new GitHubCommandError({
    message: apiErrorMessage(parsed, response.status),
    command: `${method} ${opts.path}`,
    exitCode: response.status,
    stderr: text,
    ...(response.status >= 500 ? { retryable: true } : {}),
  });
});

// Mirrors GitHubService.runGh: replay a transient failure, and only for an idempotent read.
export const githubApi = <T>(
  opts: GitHubApiRequest,
): Effect.Effect<
  GitHubApiResponse<T>,
  GitHubCommandError | GitHubAuthError | GitHubNotFoundError
> => {
  const canRetry = (opts.method ?? "GET") === "GET";
  const loop = (
    attempt: number,
  ): Effect.Effect<
    GitHubApiResponse<T>,
    GitHubCommandError | GitHubAuthError | GitHubNotFoundError
  > =>
    githubApiAttempt<T>(opts).pipe(
      Effect.catch((error) =>
        error._tag === "GitHubCommandError" &&
        error.retryable === true &&
        canRetry &&
        attempt < MAX_API_RETRIES
          ? Effect.sleep(Duration.millis(500 * 2 ** attempt)).pipe(
              Effect.flatMap(() => loop(attempt + 1)),
            )
          : Effect.fail(error),
      ),
    );
  return loop(0);
};

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
