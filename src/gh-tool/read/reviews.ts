import { Effect, Schema } from "effect";
import { GitHubService } from "#gh/service";
import { cachedRead } from "./cache";
import { gatedRead } from "./gated";
import { restSnapshot, snapshotDigest } from "./rest";
import { OPS } from "./classes";
import { repoSlug } from "./keys";
import type { RepoRef } from "./keys";
import {
  REVIEW_THREADS_QUERY,
  REVIEW_THREAD_COMMENTS_QUERY,
  LAST_HUMAN_REVIEWER_QUERY,
} from "./review-model";
import type {
  ThreadNode,
  ThreadsQueryResult,
  ThreadCommentsQueryResult,
  LastHumanReviewerQueryResult,
  RawReviewComment,
  RawPullRequestReview,
} from "./review-model";

const originThreads = Effect.fn("pr.fetchAllThreadNodes")(function* (
  repoInfo: RepoRef,
  pr: number,
) {
  const service = yield* GitHubService;

  const nodes: ThreadNode[] = [];
  let after: string | null = null;

  while (true) {
    const response = (yield* service.runGraphQL(REVIEW_THREADS_QUERY, {
      owner: repoInfo.owner,
      name: repoInfo.name,
      pr,
      after,
    })) as ThreadsQueryResult;

    const page = response.repository.pullRequest.reviewThreads;
    for (const node of page.nodes) {
      let commentsAfter = node.comments.pageInfo?.endCursor ?? null;
      while (node.comments.pageInfo?.hasNextPage && commentsAfter !== null) {
        const commentsResponse = (yield* service.runGraphQL(REVIEW_THREAD_COMMENTS_QUERY, {
          threadId: node.id,
          after: commentsAfter,
        })) as ThreadCommentsQueryResult;
        if (commentsResponse.node === null) break;
        node.comments.nodes.push(...commentsResponse.node.comments.nodes);
        node.comments.pageInfo = commentsResponse.node.comments.pageInfo;
        commentsAfter = commentsResponse.node.comments.pageInfo?.endCursor ?? null;
      }
      nodes.push(node);
    }

    if (!page.pageInfo.hasNextPage || page.pageInfo.endCursor === null) {
      return nodes;
    }

    after = page.pageInfo.endCursor;
  }
});

const reviewPages = (repo: RepoRef, pr: number, op: "prComments" | "prReviews") =>
  restSnapshot({ op, repo, pr }, [
    {
      kind: "pages",
      path: `repos/${repoSlug(repo)}/pulls/${pr}/${op === "prComments" ? "comments" : "reviews"}`,
      items: Schema.decodeUnknownSync(Schema.Array(Schema.Unknown)),
    },
  ]);

export const prComments = Effect.fn("reads.prComments")(function* (repo: RepoRef, pr: number) {
  const snapshot = yield* reviewPages(repo, pr, "prComments");
  return snapshot.pages.flatMap((page) => page.body as RawReviewComment[]);
});
export const prReviews = Effect.fn("reads.prReviews")(function* (repo: RepoRef, pr: number) {
  const snapshot = yield* reviewPages(repo, pr, "prReviews");
  return snapshot.pages.flatMap((page) => page.body as RawPullRequestReview[]);
});
export const reviewThreads = Effect.fn("reads.reviewThreads")(function* (
  repo: RepoRef,
  pr: number,
  consistency: "cached" | "origin" = "cached",
) {
  return yield* gatedRead({
    key: { op: "reviewThreads", repo, pr },
    consistency,
    decode: (raw) => Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(raw) as ThreadNode[],
    fetch: originThreads(repo, pr),
    signal: reviewPages(repo, pr, "prComments").pipe(Effect.map(snapshotDigest)),
    maxAgeMs: () => OPS.reviewThreads.maxAgeMs,
  });
});
export const lastHumanReviewer = Effect.fn("reads.lastHumanReviewer")(function* (
  repo: RepoRef,
  pr: number,
) {
  const service = yield* GitHubService;
  return yield* cachedRead({
    key: { op: "lastHumanReviewer", repo, pr },
    policy: OPS.lastHumanReviewer,
    decode: (raw) => raw as LastHumanReviewerQueryResult,
    fetch: () =>
      service
        .runGraphQL(LAST_HUMAN_REVIEWER_QUERY, { owner: repo.owner, name: repo.name, pr })
        .pipe(
          Effect.map((value) => ({
            kind: "fresh" as const,
            value: value as LastHumanReviewerQueryResult,
          })),
        ),
  });
});
