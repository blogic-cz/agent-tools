import { expect, it } from "vitest";
import { Effect } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubService } from "#gh/read/transport";
import type { GitHubApiRequest } from "#gh/read/api";
import { ReadCache } from "#gh/read/cache";
import { FileStore } from "#gh/read/store";
import { fetchFeedback, postIssueComment } from "#gh/pr/review";

it("shares feedback reads and invalidates only discussion comments after a comment", async () => {
  const root = await mkdtemp(join(tmpdir(), "gh-read-review-"));
  try {
    const store = await FileStore.open("fixture", root);
    const paths: string[] = [];
    let threadFetches = 0;
    let comments: unknown[] = [];
    const gh = GitHubService.of({
      apiRequest: <T>({ path }: GitHubApiRequest) =>
        Effect.sync(() => {
          paths.push(path);
          return {
            status: 200,
            body: (path.includes("/issues/") ? comments : []) as T,
            etag: '"page"',
          };
        }),
      runGraphQL: () =>
        Effect.sync(() => {
          threadFetches += 1;
          return {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          };
        }),
      runGh: () =>
        Effect.sync(() => {
          const comment = {
            id: 1,
            user: { login: "fixture" },
            body: "Hello",
            created_at: "2026-10-19T00:00:00Z",
            html_url: "url",
          };
          comments = [comment];
          return { stdout: JSON.stringify(comment), stderr: "", exitCode: 0 };
        }),
      runGhJson: () => Effect.die("Unexpected porcelain read"),
      getRepoInfo: () =>
        Effect.succeed({ owner: "o", name: "r", defaultBranch: "main", url: "url" }),
      getRepoConfig: () => Effect.succeed(undefined),
      withRepoTarget: (_target, effect) => effect,
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* fetchFeedback(1, "sha");
        expect(first.issueComments).toEqual([]);
        expect(paths.filter((path) => path.includes("/pulls/1/comments"))).toHaveLength(1);
        expect(paths).toHaveLength(3);
        expect(yield* fetchFeedback(1, "sha")).toEqual(first);
        expect(paths).toHaveLength(3);
        yield* postIssueComment(1, "Hello");
        const next = yield* fetchFeedback(1, "sha");
        expect(next.issueComments[0]?.body).toBe("Hello");
        expect(paths).toHaveLength(4);
        expect(threadFetches).toBe(1);
      }).pipe(
        Effect.provideService(GitHubService, gh),
        Effect.provideService(ReadCache, { store, warned: false }),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
