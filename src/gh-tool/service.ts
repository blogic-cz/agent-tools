import { Command, CommandExecutor } from "@effect/platform";
import { Chunk, Context, Effect, Layer, Stream } from "effect";

import type { RepoInfo } from "./types";

import { GH_BINARY } from "./config";
import { GitHubAuthError, GitHubCommandError, GitHubNotFoundError } from "./errors";

type GhResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type GhError = GitHubCommandError | GitHubAuthError | GitHubNotFoundError;

export class GitHubService extends Context.Tag("@agent-tools/GitHubService")<
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
>() {
  static readonly layer = Layer.scoped(
    GitHubService,
    Effect.gen(function* () {
      const executor = yield* CommandExecutor.CommandExecutor;

      let cachedRepoInfo: RepoInfo | null = null;

      const executeGh = (args: string[]) =>
        Effect.scoped(
          Effect.gen(function* () {
            const command = Command.make(GH_BINARY, ...args).pipe(
              Command.stdout("pipe"),
              Command.stderr("pipe"),
            );

            const proc = yield* executor.start(command);

            const stdoutChunk = yield* proc.stdout.pipe(Stream.decodeText(), Stream.runCollect);
            const stdout = Chunk.join(stdoutChunk, "");

            const stderrChunk = yield* proc.stderr.pipe(Stream.decodeText(), Stream.runCollect);
            const stderr = Chunk.join(stderrChunk, "");

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
              }),
          ),
        );

      const runGh = Effect.fn("GitHubService.runGh")(function* (args: string[]) {
        const result = yield* executeGh(args);

        if (result.exitCode !== 0) {
          if (result.stderr.includes("not logged in") || result.stderr.includes("gh auth login")) {
            return yield* new GitHubAuthError({
              message: "GitHub CLI not authenticated. Run 'gh auth login'.",
            });
          }

          if (result.stderr.includes("not found") || result.stderr.includes("Could not resolve")) {
            return yield* new GitHubNotFoundError({
              message: result.stderr,
              resource: "unknown",
              identifier: "unknown",
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

          const parsed = yield* Effect.try(() => JSON.parse(result.stdout) as T).pipe(
            Effect.mapError(
              (error) =>
                new GitHubCommandError({
                  message: `Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}`,
                  command: `gh ${args.join(" ")}`,
                  exitCode: 0,
                  stderr: `Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}`,
                }),
            ),
          );

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

        const response = yield* Effect.try(() => JSON.parse(result.stdout)).pipe(
          Effect.mapError(
            (error) =>
              new GitHubCommandError({
                message: `Failed to parse GraphQL response: ${error instanceof Error ? error.message : String(error)}`,
                command: "gh api graphql",
                exitCode: 0,
                stderr: `Failed to parse GraphQL response: ${error instanceof Error ? error.message : String(error)}`,
              }),
          ),
        );

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
  );
}
