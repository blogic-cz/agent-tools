import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Result } from "effect";
import { TestClock } from "effect/testing";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GitHubService } from "#gh/read/transport";
import type { GhError, GhResult } from "#gh/read/transport";
import { GitHubCommandError } from "#gh/errors";
import { createIssue, listIssues } from "#gh/issue/core";
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
const opts = {
  idempotencyKey: "Body",
  title: "Title",
  body: "Body",
  labels: "debt",
  assignee: "owner",
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
  it.effect.each(["body", "labels", "failed", "duplicate"])(
    "refuses recovery when origin is %s",
    (mode) =>
      Effect.gen(function* () {
        let attempts = 0;
        const layer = mock({
          runGh: () => {
            attempts++;
            return Effect.fail(failure("HTTP 429"));
          },
          runGhJson: (args) => {
            if (args[1] === "list")
              return Effect.succeed(
                mode === "duplicate" ? [issue, { ...issue, number: 43 }] : [issue],
              );
            if (mode === "failed") return Effect.fail(failure("detail unavailable"));
            return Effect.succeed(
              mode === "body"
                ? { ...issue, body: "Edited without marker" }
                : { ...issue, labels: [] },
            );
          },
        });
        const fiber = yield* createIssue(opts).pipe(
          Effect.provide(layer),
          Effect.result,
          Effect.forkChild,
        );
        yield* TestClock.adjust("60 seconds");
        expect((yield* Fiber.join(fiber))._tag).toBe("Failure");
        expect(attempts).toBe(1);
      }),
  );
  it.effect("does not recover an old matching issue without an explicit idempotency key", () =>
    Effect.gen(function* () {
      let reads = 0;
      const error = failure("secondary rate limit");
      const result = yield* createIssue({
        title: "Title",
        body: "Body",
        labels: "debt",
        assignee: "bob",
      }).pipe(
        Effect.provide(
          mock({
            runGh: () => Effect.fail(error),
            runGhJson: () => {
              reads++;
              return Effect.succeed([{ ...issue, assignees: [{ login: "alice" }] }]);
            },
          }),
        ),
        Effect.result,
      );
      expect(result).toEqual(Result.fail(error));
      expect(reads).toBe(0);
    }),
  );

  it.effect.each(["", "absent"])("rejects an invalid idempotency key %s before creating", (key) =>
    Effect.gen(function* () {
      let writes = 0;
      const result = yield* createIssue({ ...opts, idempotencyKey: key }).pipe(
        Effect.provide(
          mock({
            runGh: () => {
              writes++;
              return Effect.succeed(success);
            },
          }),
        ),
        Effect.result,
      );
      expect(result._tag).toBe("Failure");
      expect(writes).toBe(0);
    }),
  );

  it.effect.each(["assignee", "content"])(
    "refuses recovery and retry when the key has different %s",
    (mode) =>
      Effect.gen(function* () {
        let attempts = 0;
        const other =
          mode === "assignee"
            ? { ...issue, assignees: [{ login: "alice" }] }
            : { ...issue, body: "Body changed" };
        const layer = mock({
          runGh: () => {
            attempts++;
            return Effect.fail(failure("rate limit"));
          },
          runGhJson: (args) => Effect.succeed(args[1] === "list" ? [other] : other),
        });
        const fiber = yield* createIssue(opts).pipe(
          Effect.provide(layer),
          Effect.result,
          Effect.forkChild,
        );
        yield* TestClock.adjust("60 seconds");
        expect((yield* Fiber.join(fiber))._tag).toBe("Failure");
        expect(attempts).toBe(1);
      }),
  );

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

  it.effect("reconciles a closed matching issue before replaying a rate-limited create", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const layer = mock({
        runGh: () => {
          attempts++;
          return Effect.fail(failure("HTTP 403: secondary rate limit"));
        },
        runGhJson: (args) => Effect.succeed(args[1] === "list" ? [issue] : issue),
      });
      const fiber = yield* createIssue(opts).pipe(Effect.provide(layer), Effect.forkChild);
      yield* TestClock.adjust("59 seconds");
      expect(attempts).toBe(1);
      yield* TestClock.adjust("1 second");
      expect((yield* Fiber.join(fiber)).number).toBe(42);
      expect(attempts).toBe(1);
    }),
  );

  it.effect("retries after 60 seconds when title matches but body differs", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const layer = mock({
        runGh: () =>
          ++attempts === 1 ? Effect.fail(failure("HTTP 429")) : Effect.succeed(success),
        runGhJson: (args) =>
          Effect.succeed(args[1] === "list" ? [{ ...issue, body: "Other" }] : issue),
      });
      const fiber = yield* createIssue(opts).pipe(Effect.provide(layer), Effect.forkChild);
      yield* TestClock.adjust("59 seconds");
      expect(attempts).toBe(1);
      yield* TestClock.adjust("1 second");
      expect((yield* Fiber.join(fiber)).number).toBe(42);
      expect(attempts).toBe(2);
    }),
  );

  it.effect("stops after five rate-limited attempts", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const error = failure("secondary rate limit");
      const layer = mock({
        runGh: () => {
          attempts++;
          return Effect.fail(error);
        },
        runGhJson: () => Effect.succeed([]),
      });
      const fiber = yield* createIssue(opts).pipe(
        Effect.provide(layer),
        Effect.result,
        Effect.forkChild,
      );
      for (const seconds of [60, 120, 180, 240]) yield* TestClock.adjust(`${seconds} seconds`);
      expect(yield* Fiber.join(fiber)).toEqual(Result.fail(error));
      expect(attempts).toBe(5);
    }),
  );

  it.effect.each(["HTTP 403: Resource not accessible", "connection reset", "HTTP 502"])(
    "does not replay %s",
    (message) =>
      Effect.gen(function* () {
        let attempts = 0;
        const error = failure(message);
        const result = yield* createIssue(opts).pipe(
          Effect.provide(
            mock({
              runGh: () => {
                attempts++;
                return Effect.fail(error);
              },
            }),
          ),
          Effect.result,
        );
        expect(result).toEqual(Result.fail(error));
        expect(attempts).toBe(1);
      }),
  );

  it.effect.each(["capped", "failed"] as const)(
    "refuses a retry when reconciliation is %s",
    (mode) =>
      Effect.gen(function* () {
        let attempts = 0;
        const layer = mock({
          runGh: () => {
            attempts++;
            return Effect.fail(failure("rate limit"));
          },
          runGhJson: () =>
            mode === "capped"
              ? Effect.succeed(Array.from({ length: 1000 }, () => issue))
              : Effect.fail(failure("list failed")),
        });
        const fiber = yield* createIssue(opts).pipe(
          Effect.provide(layer),
          Effect.result,
          Effect.forkChild,
        );
        yield* TestClock.adjust("60 seconds");
        expect((yield* Fiber.join(fiber))._tag).toBe("Failure");
        expect(attempts).toBe(1);
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
