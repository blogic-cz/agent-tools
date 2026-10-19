import { expect, it } from "vitest";
import { Effect } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubService } from "#gh/read/transport";
import type { GitHubApiRequest } from "#gh/read/api";
import { ReadCache } from "#gh/read/cache";
import { FileStore } from "#gh/read/store";
import { createReview, fetchFeedback, postIssueComment, submitPendingReview } from "#gh/pr/review";
import { requestReview } from "#gh/pr/commands";
import { reads } from "#gh/read/reads";

it("refreshes PR list decisions after direct reviews, pending reviews and review requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "gh-review-list-"));
  try {
    const store = await FileStore.open("fixture", root);
    let decision = "REVIEW_REQUIRED";
    let listFetches = 0;
    const gh = GitHubService.of({
      runGh: () => Effect.die("Unexpected raw read"),
      runGhJson: <T>(args: string[]) =>
        Effect.sync(() => {
          if (args[0] === "pr") {
            listFetches += 1;
            return [
              {
                number: 1,
                url: "url",
                title: "title",
                headRefName: "feature",
                baseRefName: "main",
                state: "OPEN",
                isDraft: false,
                mergeable: "MERGEABLE",
                reviewDecision: decision,
              },
            ] as T;
          }
          if (args.some((arg) => arg.includes("requested_reviewers"))) {
            decision = "REVIEW_REQUIRED";
            return { requested_reviewers: [{ login: "reviewer" }] } as T;
          }
          if (args[1] === "repos/o/r/pulls/1") return { requested_reviewers: [] } as T;
          decision = "APPROVED";
          return { id: 1, state: "APPROVED", html_url: "url" } as T;
        }),
      runGraphQL: (query) =>
        Effect.sync(() => {
          if (query.includes("submitPullRequestReview")) {
            decision = "CHANGES_REQUESTED";
            return {
              submitPullRequestReview: {
                pullRequestReview: { id: "review-1", state: "CHANGES_REQUESTED" },
              },
            };
          }
          return {
            viewer: { login: "fixture" },
            node: {
              id: "review-1",
              state: "PENDING",
              body: "Pending",
              author: { login: "fixture" },
              pullRequest: { number: 1, repository: { nameWithOwner: "o/r" } },
              comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            },
          };
        }),
      apiRequest: <T>() => Effect.succeed({ status: 200, body: { users: [], teams: [] } as T }),
      getRepoInfo: () =>
        Effect.succeed({ owner: "o", name: "r", defaultBranch: "main", url: "url" }),
      getRepoRef: () =>
        Effect.succeed({ owner: "o", name: "r", defaultBranch: "main", url: "url" }),
      getRepoConfig: () => Effect.succeed(undefined),
      withRepoTarget: (_target, effect) => effect,
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const read = reads.prList(
          { owner: "o", name: "r" },
          { state: "open", limit: 10, author: null, base: null, head: null, search: null },
        );
        expect((yield* read)[0]?.reviewDecision).toBe("REVIEW_REQUIRED");
        yield* createReview({ pr: 1, event: "approve", body: "", confirm: true });
        expect((yield* read)[0]?.reviewDecision).toBe("APPROVED");
        yield* submitPendingReview(1, "review-1", "Please fix", "request-changes", true);
        expect((yield* read)[0]?.reviewDecision).toBe("CHANGES_REQUESTED");
        yield* requestReview(1, "reviewer");
        expect((yield* read)[0]?.reviewDecision).toBe("REVIEW_REQUIRED");
        expect(listFetches).toBe(4);
      }).pipe(
        Effect.provideService(GitHubService, gh),
        Effect.provideService(ReadCache, { store, warned: false }),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
      getRepoRef: () =>
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
