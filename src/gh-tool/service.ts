import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Effect, Layer, ServiceMap, Stream } from "effect";

import type { RepoInfo } from "./types";

import { GH_BINARY } from "./config";
import { GitHubAuthError, GitHubCommandError, GitHubNotFoundError } from "./errors";

type GhResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type GhError = GitHubCommandError | GitHubAuthError | GitHubNotFoundError;

export class GitHubService extends ServiceMap.Service<
  GitHubService,
  {
    readonly runGh: (args: string[]) => Effect.Effect<GhResult, GhError>;
    readonly runGhJson: <T>(args: string[]) => Effect.Effect<T, GhError>;
    readonly runGraphQL: (
      query: string,
      variables: Record<string, string | number>,
    ) => Effect.Effect<unknown, GhError>;
    readonly getRepoInfo: () => Effect.Effect<RepoInfo, GhError>;
  }
>()("@agent-tools/GitHubService") {
  static readonly layer = Layer.effect(
    GitHubService,
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* ChildProcessSpawner.ChildProcessSpawner;

        let cachedRepoInfo: RepoInfo | null = null;

        const executeGh = (args: string[]) =>
          Effect.scoped(
            Effect.gen(function* () {
              const command = ChildProcess.make(GH_BINARY, args, {
                stdout: "pipe",
                stderr: "pipe",
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

        const runGh = Effect.fn("GitHubService.runGh")(function* (args: string[]) {
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

            if (
              result.stderr.includes("not found") ||
              result.stderr.includes("Could not resolve")
            ) {
              return yield* new GitHubNotFoundError({
                message: result.stderr,
                resource: "unknown",
                identifier: "unknown",
                hint: "Verify the resource exists and you have access. Check repository owner/name spelling.",
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
          variables: Record<string, string | number>,
        ) {
          const args = ["api", "graphql", "-f", `query=${query}`];

          for (const [key, value] of Object.entries(variables)) {
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
          if (cachedRepoInfo !== null) {
            return cachedRepoInfo;
          }

          const result = yield* runGhJson<{
            owner: { login: string };
            name: string;
            defaultBranchRef: { name: string };
            url: string;
          }>(["repo", "view", "--json", "owner,name,defaultBranchRef,url"]);

          const repoInfo: RepoInfo = {
            owner: result.owner.login,
            name: result.name,
            defaultBranch: result.defaultBranchRef.name,
            url: result.url,
          };

          cachedRepoInfo = repoInfo;
          return repoInfo;
        });

        return { runGh, runGhJson, runGraphQL, getRepoInfo };
      }),
    ),
  );
}
