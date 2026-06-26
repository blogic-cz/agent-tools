import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Context, Duration, Effect, Layer, Stream } from "effect";

import type { GitHubRepoConfig } from "#config";
import type { RepoInfo } from "./types";

import { GH_BINARY } from "./config";
import { GitHubAuthError, GitHubCommandError, GitHubNotFoundError } from "./errors";
import { ConfigService, getGitHubConfig, resolveGitHubRepoTarget } from "#config";

// Transient GitHub-side failures worth a silent retry (vs. a hard error the agent must act on).
const NETWORK_ERROR_RE =
  /i\/o timeout|dial tcp|operation timed out|connection reset|\bEOF\b|HTTP 50[0-9]|50[0-9] (?:Bad Gateway|Service Unavailable|Gateway Timeout)|timeout awaiting/i;
const AUTH_401_RE = /HTTP 401|Bad credentials/i;
const MAX_GH_RETRIES = 2;

// Only retry verbs that are unambiguously idempotent reads — never replay a mutation on a timeout.
const READ_VERBS = new Set(["view", "list", "checks", "status", "diff"]);
const MUTATION_TOKENS =
  /\b(create|edit|merge|comment|close|reopen|delete|review|ready|sync|rerun|cancel|mutation)\b|(?:-X|--method)\s+(?:POST|PATCH|PUT|DELETE)/i;
const isSafeRetryRead = (args: readonly string[]): boolean => {
  const joined = args.join(" ");
  if (MUTATION_TOKENS.test(joined)) return false;
  if (args[0] === "api") return true; // GET by default; mutating methods already excluded above
  return args.some((a) => READ_VERBS.has(a));
};

type GhResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type GhError = GitHubCommandError | GitHubAuthError | GitHubNotFoundError;

export class GitHubService extends Context.Service<
  GitHubService,
  {
    readonly runGh: (args: string[]) => Effect.Effect<GhResult, GhError>;
    readonly runGhJson: <T>(args: string[]) => Effect.Effect<T, GhError>;
    readonly runGraphQL: (
      query: string,
      variables: Record<string, string | number | null>,
    ) => Effect.Effect<unknown, GhError>;
    readonly getRepoConfig: () => Effect.Effect<GitHubRepoConfig | undefined, never>;
    readonly getRepoInfo: () => Effect.Effect<RepoInfo, GhError>;
    readonly withRepoTarget: <A, E, R>(
      target: string | null,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | GitHubCommandError, R>;
  }
>()("@agent-tools/GitHubService") {
  static readonly layer = Layer.effect(
    GitHubService,
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* ChildProcessSpawner.ChildProcessSpawner;
        const config = yield* ConfigService;
        const initialRepoTarget = (() => {
          try {
            return resolveGitHubRepoTarget(config);
          } catch {
            return undefined;
          }
        })();
        const RepoTarget = Context.Reference<string | undefined>(
          "@agent-tools/GitHubService/RepoTarget",
          {
            defaultValue: () => initialRepoTarget,
          },
        );

        const repoInfoCache = new Map<string | null, RepoInfo>();

        const resolveRepoTarget = Effect.fn("GitHubService.resolveRepoTarget")(function* (
          target: string | null,
        ) {
          const resolved = yield* Effect.try({
            try: () => resolveGitHubRepoTarget(config, target),
            catch: (error) =>
              new GitHubCommandError({
                message: error instanceof Error ? error.message : String(error),
                command: "gh-tool --repo",
                exitCode: 1,
                stderr: error instanceof Error ? error.message : String(error),
              }),
          });

          return resolved;
        });

        const withRepoTarget = <A, E, R>(target: string | null, effect: Effect.Effect<A, E, R>) =>
          Effect.gen(function* () {
            const resolved = yield* resolveRepoTarget(target);
            return yield* effect.pipe(Effect.provideService(RepoTarget, resolved));
          });

        const getRepoConfig = Effect.fn("GitHubService.getRepoConfig")(function* () {
          const ghRepo = yield* RepoTarget;
          const repos = config?.github;

          if (repos && ghRepo) {
            const repoConfig = Object.values(repos).find(
              (repo) => `${repo.owner}/${repo.repo}` === ghRepo,
            );
            if (repoConfig) {
              return repoConfig;
            }
          }

          return getGitHubConfig(config);
        });

        const executeGh = (args: string[]) =>
          Effect.scoped(
            Effect.gen(function* () {
              const ghRepo = yield* RepoTarget;
              const command = ChildProcess.make(GH_BINARY, args, {
                stdout: "pipe",
                stderr: "pipe",
                ...(ghRepo ? { env: { GH_REPO: ghRepo }, extendEnv: true } : {}),
              });

              const proc = yield* executor.spawn(command);

              const stdoutChunk = yield* proc.stdout.pipe(Stream.decodeText(), Stream.runCollect);
              const stdout = stdoutChunk.join("");

              const stderrChunk = yield* proc.stderr.pipe(Stream.decodeText(), Stream.runCollect);
              const stderr = stderrChunk.join("");

              const exitCode = yield* proc.exitCode;

              return {
                stdout,
                stderr,
                exitCode: exitCode as number,
              };
            }),
          ).pipe(
            Effect.mapError(
              (platformError) =>
                new GitHubCommandError({
                  message: `Command execution failed: ${String(platformError)}`,
                  command: `gh ${args.join(" ")}`,
                  exitCode: -1,
                  stderr: `Command execution failed: ${String(platformError)}`,
                  hint: "Ensure the 'gh' CLI is installed and available on PATH.",
                  nextCommand: "gh --version",
                }),
            ),
          );

        const runGhAttempt = Effect.fn("GitHubService.runGhAttempt")(function* (args: string[]) {
          const result = yield* executeGh(args);

          if (result.exitCode !== 0) {
            if (
              result.stderr.includes("not logged in") ||
              result.stderr.includes("gh auth login")
            ) {
              return yield* new GitHubAuthError({
                message: "GitHub CLI not authenticated. Run 'gh auth login'.",
                hint: "Authenticate with GitHub CLI or set GITHUB_TOKEN environment variable.",
                nextCommand: "gh auth login",
              });
            }

            // Expired/invalid token (401) is distinct from "never logged in" — the fix is refresh.
            if (AUTH_401_RE.test(result.stderr)) {
              return yield* new GitHubAuthError({
                message: "GitHub credentials rejected (HTTP 401). Token is missing or expired.",
                hint: "Refresh the GitHub CLI token, then retry.",
                nextCommand: "gh auth refresh -h github.com",
              });
            }

            // Transient network/5xx — flag retryable so the wrapper below can replay safe reads.
            if (NETWORK_ERROR_RE.test(result.stderr)) {
              return yield* new GitHubCommandError({
                message: `Transient GitHub network error: ${result.stderr.trim()}`,
                command: `gh ${args.join(" ")}`,
                exitCode: result.exitCode,
                stderr: result.stderr,
                retryable: true,
                hint: "Transient GitHub/network failure. Read commands auto-retry; if it persists, check VPN/connectivity.",
              });
            }

            if (
              result.stderr.includes("not found") ||
              result.stderr.includes("Could not resolve")
            ) {
              const ghRepo = yield* RepoTarget;
              return yield* new GitHubNotFoundError({
                message: ghRepo
                  ? `${result.stderr.trim()} (queried repo: ${ghRepo})`
                  : result.stderr,
                resource: ghRepo ?? "unknown",
                identifier: "unknown",
                hint: ghRepo
                  ? `Queried ${ghRepo}. If the resource lives in another repo, pass --repo (e.g. --repo fe).`
                  : "Verify the resource exists and you have access. Check repository owner/name spelling.",
              });
            }

            return yield* new GitHubCommandError({
              message: result.stderr,
              command: `gh ${args.join(" ")}`,
              exitCode: result.exitCode,
              stderr: result.stderr,
            });
          }

          return result;
        });

        // Auto-retry transient failures, but only for idempotent reads (never replay a mutation).
        const runGh = (args: string[]): Effect.Effect<GhResult, GhError> => {
          const canRetry = isSafeRetryRead(args);
          const loop = (attempt: number): Effect.Effect<GhResult, GhError> =>
            runGhAttempt(args).pipe(
              Effect.catch((err) => {
                const retryable =
                  err instanceof GitHubCommandError && err.retryable === true && canRetry;
                if (retryable && attempt < MAX_GH_RETRIES) {
                  return Effect.sleep(Duration.millis(500 * 2 ** attempt)).pipe(
                    Effect.flatMap(() => loop(attempt + 1)),
                  );
                }
                return Effect.fail(err);
              }),
            );
          return loop(0);
        };

        const runGhJson = <T>(args: string[]) =>
          Effect.gen(function* () {
            const result = yield* runGh(args);

            const parsed = yield* Effect.try({
              try: () => JSON.parse(result.stdout) as T,
              catch: (error) =>
                new GitHubCommandError({
                  message: `Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}`,
                  command: `gh ${args.join(" ")}`,
                  exitCode: 0,
                  stderr: `Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}`,
                }),
            }).pipe(Effect.mapError((error) => error as GhError));

            return parsed;
          }).pipe(Effect.withSpan("GitHubService.runGhJson"));

        const runGraphQL = Effect.fn("GitHubService.runGraphQL")(function* (
          query: string,
          variables: Record<string, string | number | null>,
        ) {
          const args = ["api", "graphql", "-f", `query=${query}`];

          for (const [key, value] of Object.entries(variables)) {
            if (value === null) {
              continue;
            }

            if (typeof value === "number") {
              args.push("-F", `${key}=${value}`);
            } else {
              args.push("-f", `${key}=${value}`);
            }
          }

          const result = yield* runGh(args);

          const response = yield* Effect.try({
            try: () => JSON.parse(result.stdout) as { errors?: unknown[]; data?: unknown },
            catch: (error) =>
              new GitHubCommandError({
                message: `Failed to parse GraphQL response: ${error instanceof Error ? error.message : String(error)}`,
                command: "gh api graphql",
                exitCode: 0,
                stderr: `Failed to parse GraphQL response: ${error instanceof Error ? error.message : String(error)}`,
              }),
          }).pipe(Effect.mapError((error) => error as GhError));

          if (response.errors && Array.isArray(response.errors) && response.errors.length > 0) {
            return yield* new GitHubCommandError({
              message: JSON.stringify(response.errors),
              command: "gh api graphql",
              exitCode: 0,
              stderr: JSON.stringify(response.errors),
            });
          }

          return response.data as unknown;
        });

        const getRepoInfo = Effect.fn("GitHubService.getRepoInfo")(function* () {
          const ghRepo = yield* RepoTarget;
          const cacheKey = ghRepo ?? null;
          const cachedRepoInfo = repoInfoCache.get(cacheKey);
          if (cachedRepoInfo) {
            return cachedRepoInfo;
          }

          const repoArgs = ghRepo ? [ghRepo] : [];
          const result = yield* runGhJson<{
            owner: { login: string };
            name: string;
            defaultBranchRef: { name: string };
            url: string;
          }>(["repo", "view", ...repoArgs, "--json", "owner,name,defaultBranchRef,url"]);

          const repoInfo: RepoInfo = {
            owner: result.owner.login,
            name: result.name,
            defaultBranch: result.defaultBranchRef.name,
            url: result.url,
          };

          repoInfoCache.set(cacheKey, repoInfo);
          return repoInfo;
        });

        return { runGh, runGhJson, runGraphQL, getRepoConfig, getRepoInfo, withRepoTarget };
      }),
    ),
  );
}
