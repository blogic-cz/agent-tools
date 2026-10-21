import { describe, expect, it } from "@effect/vitest";
import { Clock, Effect, Layer, Result } from "effect";

import { GitHubCommandError, GitHubNotFoundError } from "#gh/errors";
import { getPRStatusRateLimit, getRateLimit } from "#gh/read/reads";
import { GitHubService, type GhError } from "#gh/read/transport";

const response = (reset: number) => ({
  resources: {
    core: { limit: 5000, used: 120, remaining: 4880, reset },
    graphql: { limit: 5000, used: 80, remaining: 4920, reset },
    search: { limit: 30, used: 2, remaining: 28, reset },
  },
});

const githubLayer = (runGhJson: (args: string[]) => Effect.Effect<unknown, GhError>) =>
  Layer.succeed(
    GitHubService,
    GitHubService.of({
      runGh: () => Effect.die("unused"),
      runGhJson: (args) => runGhJson(args) as never,
      runGraphQL: () => Effect.die("unused"),
      apiRequest: () => Effect.die("unused"),
      getRepoConfig: () => Effect.succeed(undefined),
      getRepoInfo: () => Effect.die("unused"),
      getRepoRef: () => Effect.die("unused"),
      withRepoTarget: (_target, effect) => effect,
    }),
  );

describe("gh-tool rate-limit", () => {
  it.effect("returns each resource with its quota and reset countdown", () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const reset = Math.floor(now / 1000) + 60;
      const args: string[][] = [];
      const result = yield* getRateLimit().pipe(
        Effect.provide(
          githubLayer((request) => {
            args.push(request);
            return Effect.succeed(response(reset));
          }),
        ),
      );

      expect(args).toEqual([["api", "rate_limit"]]);
      expect(result).toEqual({
        core: {
          limit: 5000,
          used: 120,
          remaining: 4880,
          reset: new Date(reset * 1000).toISOString(),
          secondsUntilReset: Math.max(0, Math.ceil(reset - now / 1000)),
        },
        graphql: {
          limit: 5000,
          used: 80,
          remaining: 4920,
          reset: new Date(reset * 1000).toISOString(),
          secondsUntilReset: Math.max(0, Math.ceil(reset - now / 1000)),
        },
        search: {
          limit: 30,
          used: 2,
          remaining: 28,
          reset: new Date(reset * 1000).toISOString(),
          secondsUntilReset: Math.max(0, Math.ceil(reset - now / 1000)),
        },
      });
    }),
  );

  it.effect("returns only the selected resource", () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const result = yield* getRateLimit("graphql").pipe(
        Effect.provide(githubLayer(() => Effect.succeed(response(Math.floor(now / 1000) + 60)))),
      );

      expect(Object.keys(result)).toEqual(["graphql"]);
      expect(result.graphql).toMatchObject({ limit: 5000, used: 80, remaining: 4920 });
    }),
  );

  it.effect("rejects a resource that GitHub did not return", () =>
    Effect.gen(function* () {
      const result = yield* getRateLimit("unknown").pipe(
        Effect.provide(githubLayer(() => Effect.succeed(response(1)))),
        Effect.result,
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(GitHubCommandError);
        expect(result.failure.message).toContain("core, graphql");
      }
    }),
  );

  it.effect("reports API failures without returning a quota", () =>
    Effect.gen(function* () {
      const failure = new GitHubNotFoundError({
        message: "rate-limit endpoint unavailable",
        identifier: "rate_limit",
        resource: "github-api",
      });
      const result = yield* getRateLimit().pipe(
        Effect.provide(githubLayer(() => Effect.fail(failure))),
        Effect.result,
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure).toBe(failure);
    }),
  );

  it.effect("keeps the PR status quota summary usable when the lookup fails", () =>
    Effect.gen(function* () {
      const failure = new GitHubNotFoundError({
        message: "rate-limit endpoint unavailable",
        identifier: "rate_limit",
        resource: "github-api",
      });
      const result = yield* getPRStatusRateLimit().pipe(
        Effect.provide(githubLayer(() => Effect.fail(failure))),
      );

      expect(result).toEqual({ error: "rate-limit endpoint unavailable" });
    }),
  );

  it.effect("limits the PR status quota summary to core and graphql", () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const result = yield* getPRStatusRateLimit().pipe(
        Effect.provide(githubLayer(() => Effect.succeed(response(Math.floor(now / 1000) + 60)))),
      );

      expect(Object.keys(result)).toEqual(["core", "graphql"]);
    }),
  );
});
