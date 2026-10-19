import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Result } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GitHubService } from "#gh/read/transport";
import type { GhError, GhResult } from "#gh/read/transport";
import { GitHubCommandError } from "#gh/errors";
import { listIssues } from "#gh/issue/core";
import { createLabel } from "#gh/label";
import { commitAuthor } from "#gh/read/commits";
import { ReadCache } from "#gh/read/cache";
import { FileStore } from "#gh/read/store";

const repo = { owner: "owner", name: "repo" };
const issue = {
  number: 42,
  title: "Title",
  body: "Body",
  state: "CLOSED",
  url: "https://github.com/owner/repo/issues/42",
  labels: [{ name: "debt" }],
  assignees: [{ login: "owner" }],
  createdAt: "2026-10-19T00:00:00Z",
};
const success = { stdout: issue.url, stderr: "", exitCode: 0 };
const failure = (stderr: string) =>
  new GitHubCommandError({ command: "gh issue create", exitCode: 1, message: stderr, stderr });

const mock = (overrides: {
  runGh?: (args: string[]) => Effect.Effect<GhResult, GhError>;
  runGhJson?: (args: string[]) => Effect.Effect<unknown, GhError>;
}) =>
  Layer.succeed(
    GitHubService,
    GitHubService.of({
      runGh: overrides.runGh ?? (() => Effect.succeed(success)),
      runGhJson: <T>(args: string[]) =>
        (overrides.runGhJson ?? (() => Effect.succeed(issue)))(args) as Effect.Effect<T, GhError>,
      runGraphQL: () => Effect.die("Unexpected GraphQL"),
      apiRequest: () => Effect.die("Unexpected API request"),
      getRepoInfo: () => Effect.die("Unexpected repo info"),
      getRepoRef: () => Effect.succeed(repo),
      getRepoConfig: () => Effect.succeed(undefined),
      withRepoTarget: (_repo, effect) => effect,
    }),
  );

describe("issue census operations", () => {
  it.effect("propagates commit author lookup failure instead of returning null", () =>
    Effect.gen(function* () {
      const error = failure("HTTP 403");
      const result = yield* commitAuthor(repo, "abc123").pipe(
        Effect.provide(mock({ runGhJson: () => Effect.fail(error) })),
        Effect.result,
      );
      expect(result).toEqual(Result.fail(error));
    }),
  );
  it.effect("forwards all states and a 1000 issue limit and includes bodies only on request", () =>
    Effect.gen(function* () {
      const calls: string[][] = [];
      const layer = mock({
        runGhJson: (args) => {
          calls.push(args);
          return Effect.succeed(
            Array.from({ length: 131 }, (_, i) => ({ ...issue, number: i + 1 })),
          );
        },
      });
      const items = yield* listIssues({
        state: "all",
        labels: "debt",
        limit: 1000,
        includeBody: true,
      }).pipe(Effect.provide(layer));
      expect(items).toHaveLength(131);
      expect(items[130]?.body).toBe("Body");
      expect(calls[0]).toEqual([
        "issue",
        "list",
        "--state",
        "all",
        "--limit",
        "1000",
        "--json",
        "number,title,state,url,labels,createdAt,body",
        "--repo",
        "owner/repo",
        "--label",
        "debt",
      ]);
      yield* listIssues({ state: "open", labels: null, limit: 30 }).pipe(Effect.provide(layer));
      expect(calls[1]).toContain("number,title,state,url,labels,createdAt");
    }),
  );

  it.effect("forwards label creation and optional force", () =>
    Effect.gen(function* () {
      const calls: string[][] = [];
      const result = yield* createLabel({
        name: "debt",
        color: "0E8A16",
        description: "Debt",
        force: true,
      }).pipe(
        Effect.provide(
          mock({
            runGh: (args) => {
              calls.push(args);
              return Effect.succeed(success);
            },
          }),
        ),
      );
      expect(result).toEqual({ name: "debt" });
      expect(calls).toEqual([
        ["label", "create", "debt", "--color", "0E8A16", "--description", "Debt", "--force"],
      ]);
    }),
  );

  it.effect.each([{ login: "owner" }, null])("returns a linked or null commit author", (author) =>
    Effect.gen(function* () {
      const calls: string[][] = [];
      const result = yield* commitAuthor(repo, "abc123").pipe(
        Effect.provide(
          mock({
            runGhJson: (args) => {
              calls.push(args);
              return Effect.succeed({ sha: "abc123", author });
            },
          }),
        ),
      );
      expect(result).toEqual({ sha: "abc123", author });
      expect(calls).toEqual([["api", "repos/owner/repo/commits/abc123"]]);
    }),
  );

  it.effect("shares commit author reads and separates issue list bodies and fresh reads", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "gh-census-")));
      try {
        const store = yield* Effect.promise(() => FileStore.open("fixture", root));
        const calls: string[][] = [];
        const layer = mock({
          runGhJson: (args) => {
            calls.push(args);
            return Effect.succeed(
              args[0] === "api" ? { sha: "abc123", author: { login: "owner" } } : [issue],
            );
          },
        });
        yield* Effect.gen(function* () {
          yield* commitAuthor(repo, "abc123");
          yield* commitAuthor(repo, "abc123");
          expect(calls).toHaveLength(1);
          const filter = { state: "all", labels: "debt", limit: 1000 };
          yield* listIssues(filter);
          yield* listIssues({ ...filter, includeBody: true });
          yield* listIssues({ ...filter, includeBody: true });
          expect(calls).toHaveLength(3);
          yield* listIssues({ ...filter, includeBody: true, fresh: true });
          expect(calls).toHaveLength(4);
        }).pipe(Effect.provide(layer), Effect.provideService(ReadCache, { store, warned: false }));
      } finally {
        yield* Effect.promise(() => rm(root, { recursive: true, force: true }));
      }
    }),
  );
});
