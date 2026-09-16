import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { Console, Effect, Fiber, Layer } from "effect";
import { TestClock, TestConsole } from "effect/testing";

import type { GitHubRepoConfig } from "#config/types";
import { GitHubService } from "#gh/service";
import type { GhError, GhResult } from "#gh/service";
import { GitHubCommandError } from "#gh/errors";
import { githubApi } from "#gh/api";
import { mergeStack, unstackStack } from "#gh/pr/stack";
import { fetchChecks, mergePR } from "#gh/pr/core";
import { readStack } from "#gh/pr/stack-read";

const mockRepoInfo = {
  owner: "test-owner",
  name: "test-repo",
  defaultBranch: "main",
  url: "https://github.com/test-owner/test-repo",
};

type GhCall = { args: string[] };

const ghServiceLayer = (runGhJson: (args: string[]) => Effect.Effect<unknown, never>) =>
  Layer.succeed(
    GitHubService,
    GitHubService.of({
      runGh: () => Effect.succeed({ stdout: "", stderr: "", exitCode: 0 }),
      runGhJson: runGhJson as <T>(args: string[]) => Effect.Effect<T, never>,
      runGraphQL: () => Effect.succeed({}),
      apiRequest: githubApi,
      getRepoConfig: () => Effect.succeed(undefined as GitHubRepoConfig | undefined),
      getRepoInfo: () => Effect.succeed(mockRepoInfo),
      withRepoTarget: (_target, effect) => effect,
    }),
  );

const ghLayer = ghServiceLayer;

const ghLayerWith = (overrides: {
  runGh: (args: string[]) => Effect.Effect<GhResult, GhError>;
  runGhJson: (args: string[]) => Effect.Effect<unknown, GhError>;
}) =>
  Layer.succeed(
    GitHubService,
    GitHubService.of({
      runGh: overrides.runGh,
      runGhJson: overrides.runGhJson as <T>(args: string[]) => Effect.Effect<T, GhError>,
      runGraphQL: () => Effect.succeed({}),
      apiRequest: githubApi,
      getRepoConfig: () => Effect.succeed(undefined),
      getRepoInfo: () => Effect.succeed(mockRepoInfo),
      withRepoTarget: (_target, effect) => effect,
    }),
  );

const stackMember = (
  number: number,
  overrides: Partial<{
    merged_at: string | null;
    draft: boolean;
    head: string;
    base: string;
    state: "open" | "closed";
  }> = {},
) => ({
  number,
  title: `PR ${number}`,
  state: overrides.state ?? "open",
  merged_at: overrides.merged_at ?? null,
  draft: overrides.draft ?? false,
  html_url: `https://github.com/test-owner/test-repo/pull/${number}`,
  head: { ref: overrides.head ?? `feat/${number}` },
  base: { ref: overrides.base ?? "main" },
});

type FetchRoute = { status: number; body: unknown };

let fetchCalls: Array<{ url: string; method: string; body: unknown }> = [];
let routes: Array<{ match: RegExp; method?: string; respond: () => FetchRoute }> = [];
const realFetch = globalThis.fetch;

const installFetch = () => {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    fetchCalls.push({ url, method, body });

    const route = routes.find(
      (candidate) =>
        candidate.match.test(url) &&
        (candidate.method === undefined || candidate.method === method),
    );
    const result = route?.respond() ?? { status: 404, body: { message: "no route" } };

    // 204 forbids a body, so the stub must send none rather than the string "null".
    const hasBody = result.status !== 204 && result.status !== 304;
    return Promise.resolve(
      new Response(hasBody ? JSON.stringify(result.body) : null, {
        status: result.status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof globalThis.fetch;
};

beforeEach(() => {
  fetchCalls = [];
  routes = [];
  process.env["GITHUB_TOKEN"] = "test-token";
  installFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env["GITHUB_TOKEN"];
});

describe("pr stack view", () => {
  it.effect("reports an unstacked PR instead of inventing a stack", () =>
    Effect.gen(function* () {
      routes.push({
        match: /\/stacks\?pull_request=42$/,
        respond: () => ({ status: 200, body: [] }),
      });

      const view = yield* readStack({ pr: 42 }).pipe(
        Effect.provide(ghLayer(() => Effect.succeed({}))),
      );

      expect(view.isStacked).toBe(false);
      expect(view.stackNumber).toBeNull();
      expect(view.members).toEqual([]);
    }),
  );

  it.effect("derives merged state from merged_at and numbers positions bottom-up", () =>
    Effect.gen(function* () {
      routes.push({
        match: /\/stacks\?pull_request=693$/,
        respond: () => ({ status: 200, body: [{ number: 717 }] }),
      });
      routes.push({
        match: /\/stacks\/717$/,
        respond: () => ({
          status: 200,
          body: {
            number: 717,
            base: { ref: "main" },
            open: true,
            pull_requests: [
              stackMember(690, { merged_at: "2026-09-01T00:00:00Z", state: "closed" }),
              stackMember(693),
              stackMember(694, { base: "feat/693" }),
            ],
          },
        }),
      });

      const view = yield* readStack({ pr: 693 }).pipe(
        Effect.provide(ghLayer(() => Effect.succeed({}))),
      );

      expect(view.stackNumber).toBe(717);
      expect(
        view.members.map((m: { position: number; number: number; state: string }) => [
          m.position,
          m.number,
          m.state,
        ]),
      ).toEqual([
        [1, 690, "merged"],
        [2, 693, "open"],
        [3, 694, "open"],
      ]);
    }),
  );
});

describe("pr stack merge", () => {
  const twoOpenAboveOneMerged = () => {
    routes.push({
      match: /\/stacks\?pull_request=\d+$/,
      respond: () => ({ status: 200, body: [{ number: 717 }] }),
    });
    routes.push({
      match: /\/stacks\/717$/,
      respond: () => ({
        status: 200,
        body: {
          number: 717,
          base: { ref: "main" },
          open: true,
          pull_requests: [
            stackMember(690, { merged_at: "2026-09-01T00:00:00Z", state: "closed" }),
            stackMember(693),
            stackMember(694, { base: "feat/693" }),
          ],
        },
      }),
    });
  };

  const healthyGh = (calls: GhCall[]) => (args: string[]) => {
    calls.push({ args });
    if (args[1] === "view") {
      return Effect.succeed({ number: 1, mergeable: "MERGEABLE", isDraft: false });
    }
    return Effect.succeed([{ name: "build", state: "SUCCESS", bucket: "pass", link: "" }]);
  };

  it.effect("refuses a PR GitHub does not consider stacked", () =>
    Effect.gen(function* () {
      routes.push({
        match: /\/stacks\?pull_request=42$/,
        respond: () => ({ status: 200, body: [] }),
      });

      const error = yield* mergeStack({ pr: 42, strategy: "squash", confirm: true }).pipe(
        Effect.provide(ghLayer(() => Effect.succeed({}))),
        Effect.flip,
      );

      expect(error._tag).toBe("GitHubMergeError");
      expect(error.message).toContain("is not part of a GitHub stack");
      expect(fetchCalls.some((call) => call.method === "PUT")).toBe(false);
    }),
  );

  it.effect("targets the top OPEN member and never merges without --confirm", () =>
    Effect.gen(function* () {
      twoOpenAboveOneMerged();
      const calls: GhCall[] = [];

      const result = yield* mergeStack({ pr: 693, strategy: "squash", confirm: false }).pipe(
        Effect.provide(ghLayer(healthyGh(calls))),
      );

      expect(result.dryRun).toBe(true);
      expect(result.merged).toBe(false);
      expect(result.target).toBe(694);
      expect(result.plan.map((entry) => entry.number)).toEqual([693, 694]);
      expect(fetchCalls.some((call) => call.method === "PUT")).toBe(false);
    }),
  );

  it.effect("reports blockers in the dry-run plan instead of refusing it", () =>
    Effect.gen(function* () {
      twoOpenAboveOneMerged();

      const result = yield* mergeStack({ pr: 693, strategy: "squash", confirm: false }).pipe(
        Effect.provide(
          ghLayer((args) =>
            args[1] === "view"
              ? Effect.succeed({
                  number: Number(args[2]),
                  mergeable: args[2] === "694" ? "CONFLICTING" : "MERGEABLE",
                  isDraft: false,
                })
              : Effect.succeed([{ name: "build", state: "SUCCESS", bucket: "pass", link: "" }]),
          ),
        ),
      );

      expect(result.dryRun).toBe(true);
      expect(result.blockers).toEqual([
        { number: 694, reason: "not_mergeable", detail: "PR has merge conflicts" },
      ]);
      expect(fetchCalls.some((call) => call.method === "PUT")).toBe(false);
    }),
  );

  it.effect("refuses the whole stack when any open member is not ready", () =>
    Effect.gen(function* () {
      twoOpenAboveOneMerged();

      const error = yield* mergeStack({ pr: 693, strategy: "squash", confirm: true }).pipe(
        Effect.provide(
          ghLayer((args) => {
            if (args[1] === "view") {
              const conflicting = args[2] === "694";
              return Effect.succeed({
                number: Number(args[2]),
                mergeable: conflicting ? "CONFLICTING" : "MERGEABLE",
                isDraft: false,
              });
            }
            return Effect.succeed([{ name: "build", state: "SUCCESS", bucket: "pass", link: "" }]);
          }),
        ),
        Effect.flip,
      );

      expect(error.message).toContain("#694");
      expect(error.message).toContain("merge conflicts");
      expect(fetchCalls.some((call) => call.method === "PUT")).toBe(false);
    }),
  );

  it.effect("merges the stack in one request and asks for a direct merge", () =>
    Effect.gen(function* () {
      twoOpenAboveOneMerged();
      routes.push({
        match: /\/pulls\/694\/merge-async$/,
        method: "PUT",
        respond: () => ({
          status: 202,
          body: { status: "merged", details: { message: "merged", sha: "abc1234" } },
        }),
      });

      const result = yield* mergeStack({ pr: 693, strategy: "squash", confirm: true }).pipe(
        Effect.provide(ghLayer(healthyGh([]))),
      );

      expect(result.merged).toBe(true);
      expect(result.sha).toBe("abc1234");
      expect(result.adoptedExistingRequest).toBe(false);

      const put = fetchCalls.find((call) => call.method === "PUT");
      expect(put?.url).toContain("/pulls/694/merge-async");
      expect(put?.body).toEqual({ merge_method: "squash", merge_action: "direct_merge" });
      expect(fetchCalls.filter((call) => call.method === "PUT")).toHaveLength(1);
    }),
  );

  it.effect("adopts an existing async merge request instead of requesting a second one", () =>
    Effect.gen(function* () {
      twoOpenAboveOneMerged();
      routes.push({
        match: /\/pulls\/694\/merge-async$/,
        method: "PUT",
        respond: () => ({
          status: 409,
          body: { status: "merged", details: { message: "already requested", sha: "def5678" } },
        }),
      });

      const result = yield* mergeStack({ pr: 693, strategy: "squash", confirm: true }).pipe(
        Effect.provide(ghLayer(healthyGh([]))),
      );

      expect(result.adoptedExistingRequest).toBe(true);
      expect(result.merged).toBe(true);
      expect(fetchCalls.filter((call) => call.method === "PUT")).toHaveLength(1);
    }),
  );

  it.effect("reports a merge queue as unfinished rather than as a merge", () =>
    Effect.gen(function* () {
      twoOpenAboveOneMerged();
      routes.push({
        match: /\/pulls\/694\/merge-async$/,
        method: "PUT",
        respond: () => ({
          status: 202,
          body: { status: "enqueued", details: { message: "queued behind 3 PRs" } },
        }),
      });

      const error = yield* mergeStack({ pr: 693, strategy: "squash", confirm: true }).pipe(
        Effect.provide(ghLayer(healthyGh([]))),
        Effect.flip,
      );

      expect(error.message).toContain("queued behind 3 PRs");
      expect(error.hint).toContain("not merged yet");
    }),
  );
  it.effect("treats unsettled mergeability as a blocker instead of merging", () =>
    Effect.gen(function* () {
      twoOpenAboveOneMerged();

      const error = yield* mergeStack({ pr: 693, strategy: "squash", confirm: true }).pipe(
        Effect.provide(
          ghLayer((args) =>
            args[1] === "view"
              ? Effect.succeed({
                  number: Number(args[2]),
                  mergeable: args[2] === "694" ? "UNKNOWN" : "MERGEABLE",
                  isDraft: false,
                })
              : Effect.succeed([{ name: "build", state: "SUCCESS", bucket: "pass", link: "" }]),
          ),
        ),
        Effect.flip,
      );

      expect(error.message).toContain("#694");
      expect(error.message).toContain("has not settled mergeability");
      expect(fetchCalls.some((call) => call.method === "PUT")).toBe(false);
    }),
  );

  it.effect("tags a queued stack merge with the merge_queue reason", () =>
    Effect.gen(function* () {
      twoOpenAboveOneMerged();
      routes.push({
        match: /\/pulls\/694\/merge-async$/,
        method: "PUT",
        respond: () => ({
          status: 202,
          body: { status: "enqueued", details: { message: "queued" } },
        }),
      });

      const error = yield* mergeStack({ pr: 693, strategy: "squash", confirm: true }).pipe(
        Effect.provide(ghLayer(healthyGh([]))),
        Effect.flip,
      );

      expect(error).toMatchObject({
        _tag: "GitHubMergeError",
        reason: "merge_queue",
        nextCommand: "agent-tools-gh pr stack view --pr 694",
      });
    }),
  );

  it.effect("reports the strategy GitHub adopted, not the one requested", () =>
    Effect.gen(function* () {
      twoOpenAboveOneMerged();
      routes.push({
        match: /\/pulls\/694\/merge-async$/,
        method: "PUT",
        respond: () => ({
          status: 409,
          body: {
            status: "merged",
            details: { message: "already requested", sha: "def5678", merge_method: "merge" },
          },
        }),
      });

      const result = yield* mergeStack({ pr: 693, strategy: "squash", confirm: true }).pipe(
        Effect.provide(ghLayer(healthyGh([]))),
      );

      expect(result.adoptedExistingRequest).toBe(true);
      expect(result.strategy).toBe("merge");
    }),
  );

  it.effect("refuses a pending merge that carries no request id", () =>
    Effect.gen(function* () {
      twoOpenAboveOneMerged();
      routes.push({
        match: /\/pulls\/694\/merge-async$/,
        method: "PUT",
        respond: () => ({
          status: 202,
          body: { status: "pending", details: { message: "no id" } },
        }),
      });

      const error = yield* mergeStack({ pr: 693, strategy: "squash", confirm: true }).pipe(
        Effect.provide(ghLayer(healthyGh([]))),
        Effect.flip,
      );

      expect(error.message).toContain("without a request id");
      expect(error.message).not.toContain("300s");
    }),
  );
});

describe("pr merge stack guard", () => {
  const mergeGhLayer = (runGhJson: (args: string[]) => Effect.Effect<unknown, never>) =>
    ghLayer((args) => {
      if (args[1] === "view") {
        return Effect.succeed({
          number: 694,
          url: "u",
          title: "t",
          headRefName: "feat/694",
          baseRefName: "feat/693",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
        });
      }
      return runGhJson(args);
    });

  it.live("refuses the merge when stack membership cannot be read", () =>
    Effect.gen(function* () {
      routes.push({
        match: /\/stacks\?pull_request=694$/,
        respond: () => ({ status: 502, body: { message: "bad gateway" } }),
      });

      const error = yield* mergePR({
        pr: 694,
        strategy: "squash",
        deleteBranch: false,
        confirm: true,
      }).pipe(Effect.provide(mergeGhLayer(() => Effect.succeed([]))), Effect.flip);

      expect(error.message).toContain("Could not determine whether PR #694 belongs to a stack");
      expect(fetchCalls.filter((call) => call.url.includes("/stacks?"))).toHaveLength(3);
      expect(fetchCalls.some((call) => call.method === "PUT")).toBe(false);
    }),
  );

  it.effect("refuses when the PR is missing from the stack read for it", () =>
    Effect.gen(function* () {
      routes.push({
        match: /\/stacks\?pull_request=694$/,
        respond: () => ({ status: 200, body: [{ number: 717 }] }),
      });
      routes.push({
        match: /\/stacks\/717$/,
        respond: () => ({
          status: 200,
          body: {
            number: 717,
            base: { ref: "main" },
            open: true,
            pull_requests: [stackMember(693)],
          },
        }),
      });

      const error = yield* mergePR({
        pr: 694,
        strategy: "squash",
        deleteBranch: false,
        confirm: true,
      }).pipe(Effect.provide(mergeGhLayer(() => Effect.succeed([]))), Effect.flip);

      expect(error.message).toContain("is missing from stack #717");
      expect(fetchCalls.some((call) => call.method === "PUT")).toBe(false);
    }),
  );

  it.effect("proceeds when the repository exposes no stacks surface", () =>
    Effect.gen(function* () {
      routes.push({
        match: /\/stacks\?pull_request=694$/,
        respond: () => ({ status: 404, body: { message: "Not Found" } }),
      });

      const result = yield* mergePR({
        pr: 694,
        strategy: "squash",
        deleteBranch: false,
        confirm: false,
      }).pipe(Effect.provide(mergeGhLayer(() => Effect.succeed([]))));

      expect(result.merged).toBe(false);
    }),
  );
});

describe("pr stack unstack", () => {
  it.effect("reports what it would remove without --confirm", () =>
    Effect.gen(function* () {
      routes.push({
        match: /\/stacks\?pull_request=693$/,
        respond: () => ({ status: 200, body: [{ number: 717 }] }),
      });
      routes.push({
        match: /\/stacks\/717$/,
        respond: () => ({
          status: 200,
          body: {
            number: 717,
            base: { ref: "main" },
            open: true,
            pull_requests: [
              stackMember(690, { merged_at: "2026-09-01T00:00:00Z", state: "closed" }),
              stackMember(693),
              stackMember(694, { base: "feat/693" }),
            ],
          },
        }),
      });

      const result = yield* unstackStack({ pr: 693, confirm: false }).pipe(
        Effect.provide(ghLayer(() => Effect.succeed({}))),
      );

      expect(result.dryRun).toBe(true);
      expect(result.unstacked).toBe(false);
      expect(result.removes).toEqual([693, 694]);
      expect(fetchCalls.some((call) => call.method === "POST")).toBe(false);
    }),
  );

  it.effect("reads a 204 as the stack being dissolved", () =>
    Effect.gen(function* () {
      routes.push({
        match: /\/stacks\?pull_request=693$/,
        respond: () => ({ status: 200, body: [{ number: 717 }] }),
      });
      routes.push({
        match: /\/stacks\/717$/,
        respond: () => ({
          status: 200,
          body: {
            number: 717,
            base: { ref: "main" },
            open: true,
            pull_requests: [stackMember(693), stackMember(694, { base: "feat/693" })],
          },
        }),
      });
      routes.push({
        match: /\/stacks\/717\/unstack$/,
        method: "POST",
        respond: () => ({ status: 204, body: null }),
      });

      const result = yield* unstackStack({ pr: 693, confirm: true }).pipe(
        Effect.provide(ghLayer(() => Effect.succeed({}))),
      );

      expect(result.dissolved).toBe(true);
      expect(result.unstacked).toBe(true);
    }),
  );

  it.effect("refuses a PR that belongs to no stack", () =>
    Effect.gen(function* () {
      routes.push({
        match: /\/stacks\?pull_request=42$/,
        respond: () => ({ status: 200, body: [] }),
      });

      const error = yield* unstackStack({ pr: 42, confirm: true }).pipe(
        Effect.provide(ghLayer(() => Effect.succeed({}))),
        Effect.flip,
      );

      expect(error.message).toContain("is not part of a GitHub stack");
    }),
  );
});

describe("pr checks --watch registration window", () => {
  const noChecksYet = () =>
    Effect.fail(
      new GitHubCommandError({
        command: "gh pr checks --watch",
        exitCode: 1,
        stderr: "no checks reported on the 'feat/x' branch",
        message: "no checks reported on the 'feat/x' branch",
      }),
    );

  it.effect("keeps waiting while gh reports no checks yet, then returns the snapshot", () =>
    Effect.gen(function* () {
      let watchAttempts = 0;

      const fiber = yield* Effect.forkChild(
        fetchChecks(123, true, false, 300, true).pipe(
          Effect.provide(
            ghLayerWith({
              runGh: (args) => {
                if (!args.includes("--watch")) {
                  return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
                }
                watchAttempts += 1;
                return watchAttempts === 1
                  ? noChecksYet()
                  : Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
              },
              runGhJson: () =>
                Effect.succeed([{ name: "build", state: "SUCCESS", bucket: "pass", link: "" }]),
            }),
          ),
        ),
      );

      yield* TestClock.adjust("6 seconds");
      const results = yield* Fiber.join(fiber);

      expect(watchAttempts).toBe(2);
      expect(results.map((check) => check.bucket)).toEqual(["pass"]);
    }),
  );

  it.effect("stops at the grace window instead of holding the caller's whole timeout", () =>
    Effect.gen(function* () {
      let watchAttempts = 0;
      const warnings: unknown[][] = [];
      const testConsole = yield* TestConsole.make;
      const consoleLayer = Layer.succeed(Console.Console, {
        ...testConsole,
        warn: (...args: unknown[]) => warnings.push(args),
      });

      const fiber = yield* Effect.forkChild(
        fetchChecks(123, true, false, 300, false).pipe(
          Effect.provide(consoleLayer),
          Effect.provide(
            ghLayerWith({
              runGh: (args) => {
                if (!args.includes("--watch")) {
                  return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
                }
                watchAttempts += 1;
                return noChecksYet();
              },
              runGhJson: () => Effect.succeed([]),
            }),
          ),
        ),
      );

      // Past the 60s grace window but far short of the 300s the caller asked for.
      yield* TestClock.adjust("70 seconds");
      const results = yield* Fiber.join(fiber);

      expect(results).toEqual([]);
      expect(watchAttempts).toBeGreaterThan(1);
      expect(watchAttempts).toBeLessThan(20);

      const text = warnings.flat().join("\n");
      expect(text).toContain("No checks registered within 60s");
      expect(text).toContain("pr trigger-checks --pr 123");
      expect(text).not.toContain("timed out after 300s");
    }),
  );

  it.effect("still fails a watch on an error that is not the registration window", () =>
    Effect.gen(function* () {
      const error = yield* fetchChecks(123, true, false, 300, true).pipe(
        Effect.provide(
          ghLayerWith({
            runGh: (args) =>
              args.includes("--watch")
                ? Effect.fail(
                    new GitHubCommandError({
                      command: "gh pr checks --watch",
                      exitCode: 1,
                      stderr: "could not resolve to a PullRequest",
                      message: "could not resolve to a PullRequest",
                    }),
                  )
                : Effect.succeed({ stdout: "", stderr: "", exitCode: 0 }),
            runGhJson: () => Effect.succeed([]),
          }),
        ),
        Effect.flip,
      );

      expect(error.message).toContain("could not resolve");
    }),
  );
});
