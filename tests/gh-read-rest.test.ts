import { afterEach, expect, it, vi } from "vitest";
import { Effect, Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubService } from "#gh/read/transport";
import type { GitHubApiRequest, GitHubApiResponse } from "#gh/read/api";
import { ReadCache } from "#gh/read/cache";
import { FileStore } from "#gh/read/store";
import { restSnapshot, snapshotDigest } from "#gh/read/rest";
import { GitHubCommandError } from "#gh/errors";

afterEach(() => vi.restoreAllMocks());

it("origin reads validate stored ETags inside the TTL and refuse stale data on failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "gh-read-origin-"));
  try {
    const store = await FileStore.open("fixture", root);
    const requests: GitHubApiRequest[] = [];
    let failure = false;
    const gh = GitHubService.of({
      apiRequest: <T>(request: GitHubApiRequest) => {
        requests.push(request);
        if (failure)
          return Effect.fail(
            new GitHubCommandError({
              command: "GET pulls/1",
              exitCode: 429,
              message: "rate limited",
              stderr: "rate limited",
            }),
          );
        return Effect.succeed({
          status: requests.length === 1 ? 200 : 304,
          body: { head: { sha: "sha" } } as T,
          etag: '"head"',
        });
      },
      runGh: () => Effect.die("Unexpected porcelain request"),
      runGhJson: () => Effect.die("Unexpected porcelain request"),
      runGraphQL: () => Effect.die("Unexpected GraphQL request"),
      getRepoInfo: () => Effect.die("Unexpected repo request"),
      getRepoConfig: () => Effect.succeed(undefined),
      withRepoTarget: (_target, effect) => effect,
    });
    const read = restSnapshot(
      { op: "prHead", repo: { owner: "o", name: "r" }, pr: 1 },
      [{ kind: "single", path: "repos/o/r/pulls/1" }],
      "origin",
    ).pipe(
      Effect.provideService(GitHubService, gh),
      Effect.provideService(ReadCache, { store, warned: false }),
    );
    const first = await Effect.runPromise(read);
    expect(await Effect.runPromise(read)).toEqual(first);
    expect(requests.map((request) => request.ifNoneMatch)).toEqual([undefined, '"head"']);
    failure = true;
    expect(await Effect.runPromise(read.pipe(Effect.flip))).toBeInstanceOf(GitHubCommandError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("revalidates every page and handles changed and removed trailing pages", async () => {
  const root = await mkdtemp(join(tmpdir(), "gh-read-rest-"));
  try {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const store = await FileStore.open("fixture", root);
    const requests: GitHubApiRequest[] = [];
    const queue: GitHubApiResponse<unknown>[] = [];
    const gh = GitHubService.of({
      apiRequest: <T>(request: GitHubApiRequest) =>
        Effect.sync(() => {
          requests.push(request);
          const result = queue.shift();
          if (result === undefined) throw new Error("Unexpected upstream request");
          return result as GitHubApiResponse<T>;
        }),
      runGh: () => Effect.die("Unexpected porcelain request"),
      runGhJson: () => Effect.die("Unexpected porcelain request"),
      runGraphQL: () => Effect.die("Unexpected GraphQL request"),
      getRepoInfo: () => Effect.die("Unexpected repo request"),
      getRepoConfig: () => Effect.succeed(undefined),
      withRepoTarget: (_target, effect) => effect,
    });
    const read = restSnapshot(
      { op: "prComments", repo: { owner: "owner", name: "repo" }, pr: 42 },
      [
        {
          path: "repos/owner/repo/pulls/42/comments",
          kind: "pages",
          items: Schema.decodeUnknownSync(Schema.Array(Schema.Number)),
        },
      ],
    ).pipe(
      Effect.provideService(GitHubService, gh),
      Effect.provideService(ReadCache, { store, warned: false }),
    );
    const page = Array.from({ length: 100 }, (_, index) => index);
    queue.push(
      { status: 200, body: page, etag: '"first"' },
      { status: 200, body: [100], etag: '"last"' },
    );
    const initial = await Effect.runPromise(read);
    expect(initial.pages).toHaveLength(2);
    now = 15000;
    queue.push({ status: 304, body: null }, { status: 304, body: null });
    const unchanged = await Effect.runPromise(read);
    expect(unchanged).toEqual(initial);
    expect(requests.slice(2).map((request) => request.ifNoneMatch)).toEqual(['"first"', '"last"']);
    now = 30000;
    queue.push({ status: 304, body: null }, { status: 200, body: [101], etag: '"changed"' });
    const changed = await Effect.runPromise(read);
    expect(snapshotDigest(changed)).not.toBe(snapshotDigest(initial));
    expect(changed.pages[1]?.body).toEqual([101]);
    now = 45000;
    queue.push({ status: 200, body: page.slice(0, 99), etag: '"short"' });
    const shorter = await Effect.runPromise(read);
    expect(shorter.pages).toHaveLength(1);
    expect(requests).toHaveLength(7);
    expect(queue).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
