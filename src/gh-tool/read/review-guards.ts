import { Effect } from "effect";
import { GitHubService } from "#gh/read/transport";
import type { RepoRef } from "./keys";
import { repoSlug } from "./keys";
import { PENDING_REVIEWS_QUERY, PENDING_REVIEW_CONTENT_QUERY } from "./review-model";
import type { EditableComment, ReviewCommentById } from "./review-model";

export const reviewGuards = {
  requestedReviewers: (repo: RepoRef, pr: number) =>
    Effect.gen(function* () {
      const gh = yield* GitHubService;
      return yield* gh.runGhJson<{ requested_reviewers?: unknown }>([
        "api",
        `repos/${repoSlug(repo)}/pulls/${pr}`,
      ]);
    }),
  commentById: (commentId: number) =>
    Effect.gen(function* () {
      const gh = yield* GitHubService;
      return yield* gh.runGhJson<ReviewCommentById>([
        "api",
        `repos/{owner}/{repo}/pulls/comments/${commentId}`,
      ]);
    }),
  editableComment: (repo: RepoRef, kind: "review" | "issue", commentId: number) =>
    Effect.gen(function* () {
      const gh = yield* GitHubService;
      return yield* gh.runGhJson<EditableComment>([
        "api",
        `repos/${repoSlug(repo)}/${kind === "review" ? "pulls" : "issues"}/comments/${commentId}`,
      ]);
    }),
  viewer: () =>
    Effect.gen(function* () {
      const gh = yield* GitHubService;
      return yield* gh.runGhJson<{ login: string }>(["api", "user"]);
    }),
  pullNumber: (repo: RepoRef, pr: number) =>
    Effect.gen(function* () {
      const gh = yield* GitHubService;
      return yield* gh.runGhJson<{ number: number }>([
        "api",
        `repos/${repoSlug(repo)}/pulls/${pr}`,
      ]);
    }),
  pendingReviews: (repo: RepoRef, pr: number, after: string | null) =>
    Effect.gen(function* () {
      const gh = yield* GitHubService;
      return yield* gh.runGraphQL(PENDING_REVIEWS_QUERY, {
        owner: repo.owner,
        name: repo.name,
        pr,
        after,
      });
    }),
  pendingReviewContent: (reviewId: string, after: string | null) =>
    Effect.gen(function* () {
      const gh = yield* GitHubService;
      return yield* gh.runGraphQL(PENDING_REVIEW_CONTENT_QUERY, { reviewId, after });
    }),
};
