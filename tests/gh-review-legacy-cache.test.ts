import { expect, it, vi } from "vitest";
import { Effect, Result } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { GitHubCommandError } from "#gh/errors";
import { FileStore } from "#gh/read/store";
import { ReadCache } from "#gh/read/cache";
import { digest } from "#gh/read/keys";
import { OPS } from "#gh/read/classes";
import { GitHubService } from "#gh/read/transport";
import { fetchThreads, replyAndResolveComment } from "#gh/pr/review";

const repo = { owner: "o", name: "r", defaultBranch: "main", url: "url" };
const node = (databaseId: number | null) => ({
  id: `node-${databaseId}`,
  databaseId,
  path: "file.ts",
  line: null,
  body: "Check value",
  author: { login: "reviewer" },
  commit: { oid: "sha" },
});

async function fixture(ids: Array<number | null>, rateLimited = false) {
  const root = await mkdtemp("/tmp/pr186-old-cache-");
  const store = await FileStore.open("fixture", root);
  const key = { op: "reviewThreads" as const, repo, pr: 1 };
  const rawComment = {
    id: 3_000_000_001,
    in_reply_to_id: null,
    user: { login: "reviewer" },
    body: "Check value",
    path: "file.ts",
    line: null,
    original_line: 8,
    original_commit_id: "original-sha",
    diff_hunk: "@@ -8 +8 @@",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
  const prepared = await store.prepare(key, OPS.reviewThreads, (raw) => raw);
  if (prepared.kind !== "fetch") throw new Error("Expected empty cache");
  await store.put(
    prepared,
    {
      data: [{ id: "thread-1", isResolved: false, comments: { nodes: ids.map(node) } }],
      originFetchedAt: Date.now(),
      signal: digest(JSON.stringify([[rawComment]])),
    },
    false,
  );
  await store.release(prepared.key, prepared.owner);
  const mutations: string[] = [];
  let graphqlReads = 0;
  let restReads = 0;
  const gh = GitHubService.of({
    apiRequest: <T>() =>
      Effect.sync(() => {
        restReads += 1;
        return { status: 200, body: [rawComment] as T };
      }),
    runGhJson: <T>() =>
      Effect.succeed({
        id: 101,
        in_reply_to_id: null,
        pull_request_url: "https://api.github.com/repos/o/r/pulls/1",
      } as T),
    runGh: () =>
      Effect.sync(() => {
        mutations.push("reply");
        return { stdout: JSON.stringify({ id: 999 }), stderr: "", exitCode: 0 };
      }),
    runGraphQL: (query) =>
      rateLimited
        ? Effect.fail(
            new GitHubCommandError({
              command: "gh api graphql",
              exitCode: 429,
              message: "rate limit",
              stderr: "rate limit",
            }),
          )
        : Effect.sync(() => {
            if (query.includes("mutation")) {
              mutations.push("resolve");
              return { resolveReviewThread: { thread: { id: "thread-1", isResolved: true } } };
            }
            graphqlReads += 1;
            return {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [
                      {
                        id: "thread-1",
                        isResolved: false,
                        comments: { nodes: [node(3_000_000_001)] },
                      },
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            };
          }),
    getRepoInfo: () => Effect.succeed(repo),
    getRepoRef: () => Effect.succeed(repo),
    getRepoConfig: () => Effect.succeed(undefined),
    withRepoTarget: (_target, effect) => effect,
  });
  return {
    root,
    store,
    gh,
    mutations,
    graphqlReads: () => graphqlReads,
    restReads: () => restReads,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

it("refreshes an old databaseId:null cache before joining original locations", async () => {
  const f = await fixture([null]);
  try {
    const result = await Effect.runPromise(
      fetchThreads(1, false, false, "sha").pipe(
        Effect.provideService(GitHubService, f.gh),
        Effect.provideService(ReadCache, { store: f.store, warned: false }),
      ),
    );
    expect({
      threads: result.map(({ commentId, originalLine }) => ({ commentId, originalLine })),
      graphqlReads: f.graphqlReads(),
    }).toEqual({
      threads: [{ commentId: 3_000_000_001, originalLine: 8 }],
      graphqlReads: 1,
    });
  } finally {
    await f.cleanup();
  }
});

it("uses the bulk read once and reuses safe cached IDs and locations", async () => {
  const f = await fixture([101]);
  try {
    await f.store.clear(repo);
    const read = fetchThreads(1, false, false, "sha").pipe(
      Effect.provideService(GitHubService, f.gh),
      Effect.provideService(ReadCache, { store: f.store, warned: false }),
    );
    const cold = await Effect.runPromise(read);
    const warm = await Effect.runPromise(read);
    expect(warm).toEqual(cold);
    expect(cold[0]).toMatchObject({ commentId: 3_000_000_001, originalLine: 8 });
    expect({ graphql: f.graphqlReads(), rest: f.restReads() }).toEqual({ graphql: 1, rest: 1 });
  } finally {
    await f.cleanup();
  }
});

it("refuses an old cache with a missing reply ID before mutations", async () => {
  const f = await fixture([101, null]);
  try {
    const result = await Effect.runPromise(
      replyAndResolveComment(1, 101, null, "done").pipe(
        Effect.provideService(GitHubService, f.gh),
        Effect.provideService(ReadCache, { store: f.store, warned: false }),
        Effect.result,
      ),
    );
    expect({ failed: Result.isFailure(result), mutations: f.mutations }).toEqual({
      failed: true,
      mutations: [],
    });
  } finally {
    await f.cleanup();
  }
});

it("never serves invalid cached IDs through the rate-limited stale fallback", async () => {
  const f = await fixture([101, null], true);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + OPS.reviewThreads.ttlMs + 1);
  try {
    const result = await Effect.runPromise(
      fetchThreads(1, false, false, "sha").pipe(
        Effect.provideService(GitHubService, f.gh),
        Effect.provideService(ReadCache, { store: f.store, warned: false }),
        Effect.result,
      ),
    );
    expect(Result.isFailure(result)).toBe(true);
    expect(f.mutations).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    await f.cleanup();
  }
});

it("refetches invalid cached IDs even when the REST signal is unchanged", async () => {
  const f = await fixture([null]);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + OPS.reviewThreads.ttlMs + 1);
  try {
    const result = await Effect.runPromise(
      fetchThreads(1, false, false, "sha").pipe(
        Effect.provideService(GitHubService, f.gh),
        Effect.provideService(ReadCache, { store: f.store, warned: false }),
      ),
    );
    expect(result[0]).toMatchObject({ commentId: 3_000_000_001, originalLine: 8 });
    expect(f.graphqlReads()).toBe(1);
  } finally {
    vi.restoreAllMocks();
    await f.cleanup();
  }
});

it("keeps valid numeric legacy entries compatible", async () => {
  const f = await fixture([101]);
  try {
    const result = await Effect.runPromise(
      fetchThreads(1, false, false, "sha").pipe(
        Effect.provideService(GitHubService, f.gh),
        Effect.provideService(ReadCache, { store: f.store, warned: false }),
      ),
    );
    expect(result[0]?.commentId).toBe(101);
    expect(f.graphqlReads()).toBe(0);
  } finally {
    await f.cleanup();
  }
});
