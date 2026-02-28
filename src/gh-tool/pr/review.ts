import { Effect } from "effect";

import type {
  GitHubIssueCommentUrl,
  IssueComment,
  IssueCommentId,
  IsoTimestamp,
  ReviewComment,
  ReviewThread,
} from "../types";

import { GitHubCommandError } from "../errors";
import { GitHubService } from "../service";

import { viewPR } from "./core";

// ---------------------------------------------------------------------------
// GraphQL queries & mutations
// ---------------------------------------------------------------------------

const REVIEW_THREADS_QUERY = `
  query($owner: String!, $name: String!, $pr: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $pr) {
        reviewThreads(first: 100) {
          nodes {
            id
            isResolved
            comments(first: 1) {
              nodes {
                id
                databaseId
                path
                line
                body
                author { login }
              }
            }
          }
        }
      }
    }
  }
`;

const RESOLVE_THREAD_MUTATION = `
  mutation($threadId: ID!) {
    resolveReviewThread(input: {threadId: $threadId}) {
      thread { id isResolved }
    }
  }
`;

const PENDING_REVIEWS_QUERY = `
  query($owner: String!, $name: String!, $pr: Int!) {
    viewer { login }
    repository(owner: $owner, name: $name) {
      pullRequest(number: $pr) {
        reviews(last: 100, states: [PENDING]) {
          nodes {
            id
            state
            author { login }
          }
        }
      }
    }
  }
`;

const SUBMIT_REVIEW_MUTATION = `
  mutation($reviewId: ID!, $event: PullRequestReviewEvent!, $body: String) {
    submitPullRequestReview(input: { pullRequestReviewId: $reviewId, event: $event, body: $body }) {
      pullRequestReview { id state }
    }
  }
`;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type ThreadNode = {
  id: string;
  isResolved: boolean;
  comments: {
    nodes: Array<{
      id: string;
      databaseId: number;
      path: string;
      line: number;
      body: string;
      author: { login: string };
    }>;
  };
};

type ThreadsQueryResult = {
  repository: {
    pullRequest: {
      reviewThreads: {
        nodes: ThreadNode[];
      };
    };
  };
};

type ResolveThreadResult = {
  resolveReviewThread: {
    thread: { id: string; isResolved: boolean };
  };
};

type PendingReviewsQueryResult = {
  viewer: { login: string };
  repository: {
    pullRequest: {
      reviews: {
        nodes: Array<{
          id: string;
          state: string;
          author: { login: string };
        }>;
      };
    };
  };
};

type SubmitReviewResult = {
  submitPullRequestReview: {
    pullRequestReview: { id: string; state: string };
  };
};

type RawReviewComment = {
  id: number;
  in_reply_to_id: number | null;
  user: { login: string };
  body: string;
  path: string;
  line: number;
  created_at: string;
};

type RawIssueComment = {
  id: number;
  user: { login: string };
  body: string;
  created_at: string;
  html_url: string;
};

type ReviewCommentById = {
  id: number;
  in_reply_to_id: number | null;
  pull_request_url: string;
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const mapRawIssueComment = (comment: RawIssueComment): IssueComment => ({
  id: comment.id as IssueCommentId,
  author: comment.user.login,
  body: comment.body,
  createdAt: comment.created_at as IsoTimestamp,
  url: comment.html_url as GitHubIssueCommentUrl,
});

/**
 * Fetch review threads for a PR via GraphQL.
 * Filters to unresolved threads when unresolvedOnly is true.
 */
export const fetchThreads = Effect.fn("pr.fetchThreads")(function* (
  pr: number | null,
  unresolvedOnly: boolean,
) {
  const service = yield* GitHubService;
  const repoInfo = yield* service.getRepoInfo();

  const resolvedPr = pr ?? (yield* viewPR(null)).number;

  const response = (yield* service.runGraphQL(REVIEW_THREADS_QUERY, {
    owner: repoInfo.owner,
    name: repoInfo.name,
    pr: resolvedPr,
  })) as ThreadsQueryResult;

  const threads = response.repository.pullRequest.reviewThreads.nodes;

  const mapped: ReviewThread[] = threads
    .filter((node) => node.comments.nodes.length > 0)
    .map((node) => {
      const comment = node.comments.nodes[0]!;
      return {
        threadId: node.id,
        commentId: comment.databaseId,
        path: comment.path,
        line: comment.line,
        body: comment.body,
        isResolved: node.isResolved,
      };
    });

  return unresolvedOnly ? mapped.filter((t) => !t.isResolved) : mapped;
});

/**
 * Fetch review comments for a PR via REST API.
 * Optionally filters to comments created at or after `since` timestamp.
 */
export const fetchComments = Effect.fn("pr.fetchComments")(function* (
  pr: number | null,
  since: string | null,
) {
  const service = yield* GitHubService;
  const repoInfo = yield* service.getRepoInfo();

  const resolvedPr = pr ?? (yield* viewPR(null)).number;

  const result = yield* service.runGh([
    "api",
    `repos/${repoInfo.owner}/${repoInfo.name}/pulls/${resolvedPr}/comments`,
  ]);

  const raw = yield* Effect.try({
    try: () => JSON.parse(result.stdout) as RawReviewComment[],
    catch: (error) =>
      new GitHubCommandError({
        command: "gh-tool pr comments",
        exitCode: 0,
        stderr: `Failed to parse response: ${error instanceof Error ? error.message : String(error)}`,
        message: `Failed to parse response: ${error instanceof Error ? error.message : String(error)}`,
      }),
  });

  const comments: ReviewComment[] = raw.map((c) => ({
    id: c.id,
    inReplyToId: c.in_reply_to_id,
    author: c.user.login,
    body: c.body,
    path: c.path,
    line: c.line,
    createdAt: c.created_at,
  }));

  if (since !== null) {
    const sinceMs = new Date(since).getTime();
    return comments.filter((c) => new Date(c.createdAt).getTime() >= sinceMs);
  }

  return comments;
});

/**
 * Fetch general PR discussion comments (issue comments) via REST API.
 * Supports optional filtering by timestamp, author, and body substring.
 */
export const fetchIssueComments = Effect.fn("pr.fetchIssueComments")(function* (
  pr: number | null,
  since: string | null,
  author: string | null,
  bodyContains: string | null,
) {
  const service = yield* GitHubService;
  const repoInfo = yield* service.getRepoInfo();

  const resolvedPr = pr ?? (yield* viewPR(null)).number;

  const result = yield* service.runGh([
    "api",
    `repos/${repoInfo.owner}/${repoInfo.name}/issues/${resolvedPr}/comments`,
  ]);

  const raw = yield* Effect.try({
    try: () => JSON.parse(result.stdout) as RawIssueComment[],
    catch: (error) =>
      new GitHubCommandError({
        command: "gh-tool pr issue-comments",
        exitCode: 0,
        stderr: `Failed to parse response: ${error instanceof Error ? error.message : String(error)}`,
        message: `Failed to parse response: ${error instanceof Error ? error.message : String(error)}`,
      }),
  });

  let comments = raw.map(mapRawIssueComment);

  if (since !== null) {
    const sinceMs = new Date(since).getTime();
    comments = comments.filter((comment) => new Date(comment.createdAt).getTime() >= sinceMs);
  }

  if (author !== null) {
    const authorFilter = author.toLowerCase();
    comments = comments.filter((comment) => comment.author.toLowerCase().includes(authorFilter));
  }

  if (bodyContains !== null) {
    const bodyFilter = bodyContains.toLowerCase();
    comments = comments.filter((comment) => comment.body.toLowerCase().includes(bodyFilter));
  }

  return comments;
});

export const fetchLatestIssueComment = Effect.fn("pr.fetchLatestIssueComment")(function* (
  pr: number | null,
  author: string | null,
  bodyContains: string | null,
) {
  const comments = yield* fetchIssueComments(pr, null, author, bodyContains);

  if (comments.length === 0) {
    return null;
  }

  const latest = comments.reduce((current, next) =>
    new Date(next.createdAt).getTime() > new Date(current.createdAt).getTime() ? next : current,
  );

  return latest;
});

export const postIssueComment = Effect.fn("pr.postIssueComment")(function* (
  pr: number | null,
  body: string,
) {
  const service = yield* GitHubService;
  const repoInfo = yield* service.getRepoInfo();

  const resolvedPr = pr ?? (yield* viewPR(null)).number;

  const trimmedBody = body.trim();
  if (trimmedBody.length === 0) {
    return yield* Effect.fail(
      new GitHubCommandError({
        command: "gh-tool pr comment",
        exitCode: 0,
        stderr: "Comment body cannot be empty",
        message: "Comment body cannot be empty",
      }),
    );
  }

  const result = yield* service.runGh([
    "api",
    "-X",
    "POST",
    `repos/${repoInfo.owner}/${repoInfo.name}/issues/${resolvedPr}/comments`,
    "-f",
    `body=${trimmedBody}`,
  ]);

  const rawComment = yield* Effect.try({
    try: () => JSON.parse(result.stdout) as RawIssueComment,
    catch: (error) =>
      new GitHubCommandError({
        command: "gh-tool pr comment",
        exitCode: 0,
        stderr: `Failed to parse response: ${error instanceof Error ? error.message : String(error)}`,
        message: `Failed to parse response: ${error instanceof Error ? error.message : String(error)}`,
      }),
  });

  return mapRawIssueComment(rawComment);
});

export const fetchDiscussionSummary = Effect.fn("pr.fetchDiscussionSummary")(function* (
  pr: number | null,
) {
  const [issueComments, reviewComments, threads] = yield* Effect.all([
    fetchIssueComments(pr, null, null, null),
    fetchComments(pr, null),
    fetchThreads(pr, false),
  ]);

  const latestIssueComment =
    issueComments.length === 0
      ? null
      : issueComments.reduce((current, next) =>
          new Date(next.createdAt).getTime() > new Date(current.createdAt).getTime()
            ? next
            : current,
        );

  return {
    issueCommentsCount: issueComments.length,
    latestIssueComment,
    reviewCommentsCount: reviewComments.length,
    reviewThreadsCount: threads.length,
    unresolvedReviewThreadsCount: threads.filter((thread) => !thread.isResolved).length,
  };
});

const fetchReviewCommentById = Effect.fn("pr.fetchReviewCommentById")(function* (
  commentId: number,
) {
  const service = yield* GitHubService;

  const comment = yield* service.runGhJson<ReviewCommentById>([
    "api",
    `repos/{owner}/{repo}/pulls/comments/${commentId}`,
  ]);

  return comment;
});

/**
 * Reply to an inline review comment via REST API.
 */
export const replyToComment = Effect.fn("pr.replyToComment")(function* (
  pr: number | null,
  commentId: number,
  body: string,
) {
  const service = yield* GitHubService;
  const repoInfo = yield* service.getRepoInfo();

  const resolvedPr = pr ?? (yield* viewPR(null)).number;

  const trimmedBody = body.trim();
  if (trimmedBody.length === 0) {
    return yield* Effect.fail(
      new GitHubCommandError({
        command: "gh-tool pr reply",
        exitCode: 0,
        stderr: "Reply body cannot be empty",
        message: "Reply body cannot be empty",
      }),
    );
  }

  const targetComment = yield* fetchReviewCommentById(commentId);
  const rootCommentId = targetComment.in_reply_to_id ?? targetComment.id;

  if (!targetComment.pull_request_url.endsWith(`/pulls/${resolvedPr}`)) {
    return yield* Effect.fail(
      new GitHubCommandError({
        command: "gh-tool pr reply",
        exitCode: 0,
        stderr: `Comment ${commentId} does not belong to PR #${resolvedPr}`,
        message: `Comment ${commentId} does not belong to PR #${resolvedPr}`,
      }),
    );
  }

  const result = yield* service
    .runGh([
      "api",
      "-X",
      "POST",
      `repos/${repoInfo.owner}/${repoInfo.name}/pulls/${resolvedPr}/comments/${rootCommentId}/replies`,
      "-f",
      `body=${trimmedBody}`,
    ])
    .pipe(
      Effect.catchTag("GitHubCommandError", (error) => {
        if (error.stderr.includes("can only have one pending review per pull request")) {
          return Effect.fail(
            new GitHubCommandError({
              command: error.command,
              exitCode: error.exitCode,
              stderr:
                "Cannot reply while you have a pending review on this PR. Submit or dismiss your pending review in GitHub, then run the command again.",
              message:
                "Cannot reply while you have a pending review on this PR. Submit or dismiss your pending review in GitHub, then run the command again.",
            }),
          );
        }

        if (error.stderr.includes("Validation Failed")) {
          return Effect.fail(
            new GitHubCommandError({
              command: error.command,
              exitCode: error.exitCode,
              stderr:
                "Reply failed with GitHub validation error. Common causes: (1) you have a pending review on this PR, (2) comment ID is from a different PR, or (3) comment is not a top-level thread comment. Submit/dismiss pending reviews and retry.",
              message:
                "Reply failed with GitHub validation error. Common causes: (1) you have a pending review on this PR, (2) comment ID is from a different PR, or (3) comment is not a top-level thread comment. Submit/dismiss pending reviews and retry.",
            }),
          );
        }

        return Effect.fail(error);
      }),
    );

  const parsed = yield* Effect.try({
    try: () =>
      JSON.parse(result.stdout) as {
        id: number;
      },
    catch: (error) =>
      new GitHubCommandError({
        command: "gh-tool pr reply",
        exitCode: 0,
        stderr: `Failed to parse response: ${error instanceof Error ? error.message : String(error)}`,
        message: `Failed to parse response: ${error instanceof Error ? error.message : String(error)}`,
      }),
  });

  return { success: true as const, commentId: parsed.id };
});

/**
 * Resolve a review thread via GraphQL mutation.
 */
export const resolveThread = Effect.fn("pr.resolveThread")(function* (threadId: string) {
  const service = yield* GitHubService;

  const response = (yield* service.runGraphQL(RESOLVE_THREAD_MUTATION, {
    threadId,
  })) as ResolveThreadResult;

  return {
    resolved: response.resolveReviewThread.thread.isResolved,
    threadId: response.resolveReviewThread.thread.id,
  };
});

export const submitPendingReview = Effect.fn("pr.submitPendingReview")(function* (
  pr: number | null,
  reviewId: string | null,
  body: string | null,
) {
  const service = yield* GitHubService;
  const repoInfo = yield* service.getRepoInfo();

  const resolvedPr = pr ?? (yield* viewPR(null)).number;

  let targetReviewId = reviewId;

  if (targetReviewId === null) {
    const pending = (yield* service.runGraphQL(PENDING_REVIEWS_QUERY, {
      owner: repoInfo.owner,
      name: repoInfo.name,
      pr: resolvedPr,
    })) as PendingReviewsQueryResult;

    const viewerLogin = pending.viewer.login;
    const pendingReviews = pending.repository.pullRequest.reviews.nodes;

    const ownPendingReview = pendingReviews.find((review) => review.author.login === viewerLogin);

    if (!ownPendingReview) {
      return yield* Effect.fail(
        new GitHubCommandError({
          command: "gh-tool pr submit-review",
          exitCode: 0,
          stderr: "No pending review found for current user on this PR",
          message: "No pending review found for current user on this PR",
        }),
      );
    }

    targetReviewId = ownPendingReview.id;
  }

  const result = (yield* service.runGraphQL(SUBMIT_REVIEW_MUTATION, {
    reviewId: targetReviewId,
    event: "COMMENT",
    body: body ?? "",
  })) as SubmitReviewResult;

  return {
    submitted: true as const,
    reviewId: result.submitPullRequestReview.pullRequestReview.id,
    state: result.submitPullRequestReview.pullRequestReview.state,
  };
});
