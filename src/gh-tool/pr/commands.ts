import { Command, Flag } from "effect/unstable/cli";
import { Effect, Option } from "effect";

import type { PRStatusResult } from "#src/gh-tool/types";

import { formatOption, logFormatted } from "#src/shared";
import {
  CI_CHECK_WATCH_TIMEOUT_MS,
  DEFAULT_DELETE_BRANCH,
  DEFAULT_MERGE_STRATEGY,
  MERGE_STRATEGIES,
} from "#src/gh-tool/config";

import {
  createPR,
  detectPRStatus,
  editPR,
  fetchChecks,
  fetchFailedChecks,
  mergePR,
  rerunChecks,
  viewPR,
} from "./core";
import {
  fetchComments,
  fetchDiscussionSummary,
  fetchIssueComments,
  fetchLatestIssueComment,
  fetchThreads,
  postIssueComment,
  replyToComment,
  resolveThread,
  submitPendingReview,
} from "./review";

// ---------------------------------------------------------------------------
// CLI Commands
// ---------------------------------------------------------------------------

export const prViewCommand = Command.make(
  "view",
  {
    format: formatOption,
    pr: Flag.integer("pr").pipe(
      Flag.withDescription("PR number (default: current branch PR)"),
      Flag.optional,
    ),
  },
  ({ format, pr }) =>
    Effect.gen(function* () {
      const prNumber = Option.getOrNull(pr);
      const info = yield* viewPR(prNumber);
      yield* logFormatted(info, format);
    }),
).pipe(Command.withDescription("View PR information"));

export const prStatusCommand = Command.make("status", { format: formatOption }, ({ format }) =>
  Effect.gen(function* () {
    const result: PRStatusResult = yield* detectPRStatus();
    yield* logFormatted(result, format);
  }),
).pipe(
  Command.withDescription("Auto-detect PR for current branch or GitButler workspace branches"),
);

export const prCreateCommand = Command.make(
  "create",
  {
    base: Flag.string("base").pipe(
      Flag.withDescription("Base branch for the PR"),
      Flag.withDefault("test"),
    ),
    body: Flag.string("body").pipe(
      Flag.withDescription("PR body/description"),
      Flag.withDefault(""),
    ),
    draft: Flag.boolean("draft").pipe(
      Flag.withDescription("Create as draft PR"),
      Flag.withDefault(false),
    ),
    format: formatOption,
    head: Flag.string("head").pipe(
      Flag.withDescription("Source branch name (required in GitButler workspace mode)"),
      Flag.optional,
    ),
    title: Flag.string("title").pipe(Flag.withDescription("PR title")),
  },
  ({ base, body, draft, format, head, title }) =>
    Effect.gen(function* () {
      const info = yield* createPR({
        base,
        body,
        draft,
        head: Option.getOrNull(head),
        title,
      });
      yield* logFormatted(info, format);
    }),
).pipe(Command.withDescription("Create or update a PR for current branch"));

export const prEditCommand = Command.make(
  "edit",
  {
    body: Flag.string("body").pipe(Flag.withDescription("New PR body/description"), Flag.optional),
    format: formatOption,
    pr: Flag.integer("pr").pipe(Flag.withDescription("PR number to edit")),
    title: Flag.string("title").pipe(Flag.withDescription("New PR title"), Flag.optional),
  },
  ({ body, format, pr, title }) =>
    Effect.gen(function* () {
      const info = yield* editPR({
        pr,
        title: Option.getOrNull(title),
        body: Option.getOrNull(body),
      });
      yield* logFormatted(info, format);
    }),
).pipe(Command.withDescription("Edit an existing PR's title, body, or other metadata"));

export const prMergeCommand = Command.make(
  "merge",
  {
    confirm: Flag.boolean("confirm").pipe(
      Flag.withDescription("Actually merge (without this flag, only shows dry-run)"),
      Flag.withDefault(false),
    ),
    deleteBranch: Flag.boolean("delete-branch").pipe(
      Flag.withDescription("Delete branch after merge"),
      Flag.withDefault(DEFAULT_DELETE_BRANCH),
    ),
    format: formatOption,
    pr: Flag.integer("pr").pipe(Flag.withDescription("PR number to merge")),
    strategy: Flag.choice("strategy", MERGE_STRATEGIES).pipe(
      Flag.withDescription("Merge strategy: squash, merge, or rebase"),
      Flag.withDefault(DEFAULT_MERGE_STRATEGY),
    ),
  },
  ({ confirm, deleteBranch, format, pr, strategy }) =>
    Effect.gen(function* () {
      const result = yield* mergePR({
        confirm,
        deleteBranch,
        pr,
        strategy,
      });
      yield* logFormatted(result, format);
    }),
).pipe(Command.withDescription("Merge a PR (dry-run by default, use --confirm to execute)"));

export const prChecksCommand = Command.make(
  "checks",
  {
    failFast: Flag.boolean("fail-fast").pipe(
      Flag.withDefault(true),
      Flag.withDescription("Stop watching on first failure (with --watch)"),
    ),
    format: formatOption,
    pr: Flag.integer("pr").pipe(
      Flag.withDescription("PR number (default: current branch PR)"),
      Flag.optional,
    ),
    timeout: Flag.integer("timeout").pipe(
      Flag.withDefault(CI_CHECK_WATCH_TIMEOUT_MS / 1000),
      Flag.withDescription("Timeout in seconds for watch mode (default: 600)"),
    ),
    watch: Flag.boolean("watch").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Watch until checks complete or timeout"),
    ),
  },
  ({ failFast, format, pr, timeout, watch }) =>
    Effect.gen(function* () {
      const prNumber = Option.getOrNull(pr);
      const checks = yield* fetchChecks(prNumber, watch, failFast, timeout);
      yield* logFormatted(checks, format);
    }),
).pipe(Command.withDescription("Fetch CI check status for a PR (optionally watch with timeout)"));

export const prChecksFailedCommand = Command.make(
  "checks-failed",
  {
    format: formatOption,
    pr: Flag.integer("pr").pipe(
      Flag.withDescription("PR number (default: current branch PR)"),
      Flag.optional,
    ),
  },
  ({ format, pr }) =>
    Effect.gen(function* () {
      const prNumber = Option.getOrNull(pr);
      const checks = yield* fetchFailedChecks(prNumber);
      yield* logFormatted(checks, format);
    }),
).pipe(Command.withDescription("Fetch only failed CI checks for a PR"));

export const prRerunChecksCommand = Command.make(
  "rerun-checks",
  {
    format: formatOption,
    pr: Flag.integer("pr").pipe(
      Flag.withDescription("PR number (default: current branch PR)"),
      Flag.optional,
    ),
    failedOnly: Flag.boolean("failed-only").pipe(
      Flag.withDefault(true),
      Flag.withDescription("Only rerun failed checks (default: true)"),
    ),
  },
  ({ failedOnly, format, pr }) =>
    Effect.gen(function* () {
      const prNumber = Option.getOrNull(pr);
      const result = yield* rerunChecks(prNumber, failedOnly);
      yield* logFormatted(result, format);
    }),
).pipe(
  Command.withDescription("Rerun CI checks for a PR (GitHub Actions only, failed by default)"),
);

export const prThreadsCommand = Command.make(
  "threads",
  {
    format: formatOption,
    pr: Flag.integer("pr").pipe(
      Flag.withDescription("PR number (default: current branch PR)"),
      Flag.optional,
    ),
    unresolvedOnly: Flag.boolean("unresolved-only").pipe(
      Flag.withDescription("Only show unresolved threads"),
      Flag.withDefault(true),
    ),
  },
  ({ format, pr, unresolvedOnly }) =>
    Effect.gen(function* () {
      const prNumber = Option.getOrNull(pr);
      const threads = yield* fetchThreads(prNumber, unresolvedOnly);
      yield* logFormatted(threads, format);
    }),
).pipe(Command.withDescription("Fetch review threads for a PR (unresolved by default)"));

export const prCommentsCommand = Command.make(
  "comments",
  {
    format: formatOption,
    pr: Flag.integer("pr").pipe(
      Flag.withDescription("PR number (default: current branch PR)"),
      Flag.optional,
    ),
    since: Flag.string("since").pipe(
      Flag.withDescription("ISO timestamp to filter comments created after"),
      Flag.optional,
    ),
  },
  ({ format, pr, since }) =>
    Effect.gen(function* () {
      const prNumber = Option.getOrNull(pr);
      const sinceValue = Option.getOrNull(since);
      const comments = yield* fetchComments(prNumber, sinceValue);
      yield* logFormatted(comments, format);
    }),
).pipe(Command.withDescription("Fetch review comments for a PR (optionally filter by --since)"));

export const prIssueCommentsCommand = Command.make(
  "issue-comments",
  {
    author: Flag.string("author").pipe(
      Flag.withDescription("Filter by author login substring"),
      Flag.optional,
    ),
    bodyContains: Flag.string("body-contains").pipe(
      Flag.withDescription("Filter comments by body substring"),
      Flag.optional,
    ),
    format: formatOption,
    pr: Flag.integer("pr").pipe(
      Flag.withDescription("PR number (default: current branch PR)"),
      Flag.optional,
    ),
    since: Flag.string("since").pipe(
      Flag.withDescription("ISO timestamp to filter comments created after"),
      Flag.optional,
    ),
  },
  ({ author, bodyContains, format, pr, since }) =>
    Effect.gen(function* () {
      const prNumber = Option.getOrNull(pr);
      const sinceValue = Option.getOrNull(since);
      const authorValue = Option.getOrNull(author);
      const bodyContainsValue = Option.getOrNull(bodyContains);

      const comments = yield* fetchIssueComments(
        prNumber,
        sinceValue,
        authorValue,
        bodyContainsValue,
      );
      yield* logFormatted(comments, format);
    }),
).pipe(Command.withDescription("Fetch general PR discussion comments (issue comments)"));

export const prIssueCommentsLatestCommand = Command.make(
  "issue-comments-latest",
  {
    author: Flag.string("author").pipe(
      Flag.withDescription("Filter by author login substring"),
      Flag.optional,
    ),
    bodyContains: Flag.string("body-contains").pipe(
      Flag.withDescription("Filter comments by body substring"),
      Flag.optional,
    ),
    format: formatOption,
    pr: Flag.integer("pr").pipe(
      Flag.withDescription("PR number (default: current branch PR)"),
      Flag.optional,
    ),
  },
  ({ author, bodyContains, format, pr }) =>
    Effect.gen(function* () {
      const prNumber = Option.getOrNull(pr);
      const authorValue = Option.getOrNull(author);
      const bodyContainsValue = Option.getOrNull(bodyContains);

      const comment = yield* fetchLatestIssueComment(prNumber, authorValue, bodyContainsValue);
      yield* logFormatted(comment, format);
    }),
).pipe(Command.withDescription("Fetch latest general PR discussion comment"));

export const prCommentCommand = Command.make(
  "comment",
  {
    body: Flag.string("body").pipe(Flag.withDescription("General PR comment body text")),
    format: formatOption,
    pr: Flag.integer("pr").pipe(
      Flag.withDescription("PR number (default: current branch PR)"),
      Flag.optional,
    ),
  },
  ({ body, format, pr }) =>
    Effect.gen(function* () {
      const prNumber = Option.getOrNull(pr);
      const result = yield* postIssueComment(prNumber, body);
      yield* logFormatted(result, format);
    }),
).pipe(Command.withDescription("Post a general PR discussion comment"));

export const prDiscussionSummaryCommand = Command.make(
  "discussion-summary",
  {
    format: formatOption,
    pr: Flag.integer("pr").pipe(
      Flag.withDescription("PR number (default: current branch PR)"),
      Flag.optional,
    ),
  },
  ({ format, pr }) =>
    Effect.gen(function* () {
      const prNumber = Option.getOrNull(pr);
      const summary = yield* fetchDiscussionSummary(prNumber);
      yield* logFormatted(summary, format);
    }),
).pipe(
  Command.withDescription("Fetch counts and latest comment across PR discussions and reviews"),
);

export const prReplyCommand = Command.make(
  "reply",
  {
    body: Flag.string("body").pipe(Flag.withDescription("Reply body text")),
    commentId: Flag.integer("comment-id").pipe(
      Flag.withDescription("ID of the comment to reply to"),
    ),
    format: formatOption,
    pr: Flag.integer("pr").pipe(
      Flag.withDescription("PR number (default: current branch PR)"),
      Flag.optional,
    ),
  },
  ({ body, commentId, format, pr }) =>
    Effect.gen(function* () {
      const prNumber = Option.getOrNull(pr);
      const result = yield* replyToComment(prNumber, commentId, body);
      yield* logFormatted(result, format);
    }),
).pipe(Command.withDescription("Reply to an inline review comment"));

export const prResolveCommand = Command.make(
  "resolve",
  {
    format: formatOption,
    threadId: Flag.string("thread-id").pipe(
      Flag.withDescription("GraphQL node ID of the thread to resolve"),
    ),
  },
  ({ format, threadId }) =>
    Effect.gen(function* () {
      const result = yield* resolveThread(threadId);
      yield* logFormatted(result, format);
    }),
).pipe(Command.withDescription("Resolve a review thread via GraphQL"));

export const prSubmitReviewCommand = Command.make(
  "submit-review",
  {
    body: Flag.string("body").pipe(
      Flag.withDescription("Optional review body text when submitting"),
      Flag.optional,
    ),
    format: formatOption,
    pr: Flag.integer("pr").pipe(
      Flag.withDescription("PR number (default: current branch PR)"),
      Flag.optional,
    ),
    reviewId: Flag.string("review-id").pipe(
      Flag.withDescription(
        "Pending review GraphQL ID (defaults to current user's pending review on PR)",
      ),
      Flag.optional,
    ),
  },
  ({ body, format, pr, reviewId }) =>
    Effect.gen(function* () {
      const prNumber = Option.getOrNull(pr);
      const reviewIdValue = Option.getOrNull(reviewId);
      const bodyValue = Option.getOrNull(body);
      const result = yield* submitPendingReview(prNumber, reviewIdValue, bodyValue);
      yield* logFormatted(result, format);
    }),
).pipe(
  Command.withDescription(
    "Submit a pending review as COMMENT (auto-detects your pending review if --review-id is omitted)",
  ),
);

export const prReviewTriageCommand = Command.make(
  "review-triage",
  {
    format: formatOption,
    pr: Flag.integer("pr").pipe(
      Flag.withDescription("PR number (default: current branch PR)"),
      Flag.optional,
    ),
  },
  ({ format, pr }) =>
    Effect.gen(function* () {
      const prNumber = Option.getOrNull(pr);
      const [info, threads, summary, checks] = yield* Effect.all([
        viewPR(prNumber),
        fetchThreads(prNumber, true),
        fetchDiscussionSummary(prNumber),
        fetchChecks(prNumber, false, false, 0),
      ]);
      yield* logFormatted({ info, unresolvedThreads: threads, summary, checks }, format);
    }),
).pipe(
  Command.withDescription(
    "Composite: PR info + unresolved threads + discussion summary + checks status in one call",
  ),
);

export const prReplyAndResolveCommand = Command.make(
  "reply-and-resolve",
  {
    body: Flag.string("body").pipe(Flag.withDescription("Reply body text")),
    commentId: Flag.integer("comment-id").pipe(
      Flag.withDescription("ID of the comment to reply to"),
    ),
    format: formatOption,
    pr: Flag.integer("pr").pipe(
      Flag.withDescription("PR number (default: current branch PR)"),
      Flag.optional,
    ),
    threadId: Flag.string("thread-id").pipe(
      Flag.withDescription("GraphQL node ID of the thread to resolve"),
    ),
  },
  ({ body, commentId, format, pr, threadId }) =>
    Effect.gen(function* () {
      const prNumber = Option.getOrNull(pr);
      const replyResult = yield* replyToComment(prNumber, commentId, body);
      const resolveResult = yield* resolveThread(threadId);
      yield* logFormatted({ reply: replyResult, resolve: resolveResult }, format);
    }),
).pipe(
  Command.withDescription(
    "Composite: reply to a review comment and resolve its thread in one call",
  ),
);
