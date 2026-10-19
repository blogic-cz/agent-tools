import { expect, it } from "vitest";
import { Effect } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubService } from "#gh/read/transport";
import type { GitHubApiRequest } from "#gh/read/api";
import { ReadCache } from "#gh/read/cache";
import { FileStore } from "#gh/read/store";
import { fetchFeedback, postIssueComment, submitPendingReview } from "#gh/pr/review";

it("shares feedback reads and invalidates only discussion comments after a comment", async () => {
  const root = await mkdtemp(join(tmpdir(), "gh-read-review-"));
  try {
    const store = await FileStore.open("fixture", root);
    const paths: string[] = [];
    let threadFetches = 0;
    let comments: unknown[] = [];
    let inlineComments: unknown[] = [];
    const gh = GitHubService.of({
      apiRequest: <T>({ path }: GitHubApiRequest) =>
        Effect.sync(() => {
          paths.push(path);
          return {
            status: 200,
            body: (path.includes("/issues/")
              ? comments
              : path.includes("/comments?")
                ? inlineComments
                : []) as T,
            etag: '"page"',
          };
        }),
      runGraphQL: (query) =>
        Effect.sync(() => {
          if (query.includes("node(id: $reviewId)"))
            return {
              viewer: { login: "fixture" },
              node: {
                id: "review-1",
                state: "PENDING",
                body: "Pending review",
                author: { login: "fixture" },
                pullRequest: { number: 1, repository: { nameWithOwner: "o/r" } },
                comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
              },
            };
          if (query.includes("submitPullRequestReview")) {
            inlineComments = [
              {
                id: 2,
                in_reply_to_id: null,
                user: { login: "fixture" },
                body: "Published inline comment",
                path: "file.ts",
                line: 1,
                created_at: "2026-10-19T00:00:00Z",
                updated_at: "2026-10-19T00:00:00Z",
                commit_id: "sha",
              },
            ];
            return {
              submitPullRequestReview: {
                pullRequestReview: { id: "review-1", state: "COMMENTED" },
              },
            };
          }
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
        yield* submitPendingReview(1, "review-1", null);
        const published = yield* fetchFeedback(1, "sha");
        expect(published.inlineComments[0]?.body).toBe("Published inline comment");
        expect(paths).toHaveLength(6);
        expect(threadFetches).toBe(2);
      }).pipe(
        Effect.provideService(GitHubService, gh),
        Effect.provideService(ReadCache, { store, warned: false }),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
