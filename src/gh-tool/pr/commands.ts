import { Command, Flag } from "effect/unstable/cli";
import { Console, Effect, Option } from "effect";

import type { CheckResult, PRStatusResult } from "#gh/types";

import { formatOption, logFormatted } from "#shared";
import { GitHubService } from "#gh/service";
import { GitHubCommandError } from "#gh/errors";

const emptyBatchError = (batch: string) =>
  new GitHubCommandError({
    message: `--prs received no valid PR numbers: ${JSON.stringify(batch)}`,
    command: "gh pr --prs",
    exitCode: 1,
    stderr: "",
    hint: "Pass comma-separated positive integers, e.g. --prs 1,2,3.",
  });
import {
  resolveDefaultTextInput,
  resolveOptionalTextInput,
  resolveRequiredTextInput,
} from "#gh/text-input";
import {
  CI_CHECK_WATCH_TIMEOUT_MS,
  DEFAULT_DELETE_BRANCH,
  DEFAULT_MERGE_STRATEGY,
  MERGE_STRATEGIES,
} from "#gh/config";

import {
  closePR,
  createPR,
  detectPRStatus,
  editPR,
  fetchChecks,
  fetchChecksForCommand,
  fetchFailedChecks,
  listPRs,
  mergePR,
  rerunChecks,
  viewPR,
  waitForMergeable,
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

const repoOption = Flag.string("repo").pipe(
  Flag.withDescription("Target repository profile name or owner/name"),
  Flag.optional,
);

const withRepo = <A, E, R>(repo: Option.Option<string>, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const gh = yield* GitHubService;
    return yield* gh.withRepoTarget(Option.getOrNull(repo), effect);
  });

type ReviewTriageSummary = {
  readonly visibleOpenReviewThreadsCount: number;
  readonly unrepliedReviewThreadsCount: number;
  readonly unresolvedReviewThreadsCount: number;
};

type ReviewTriageClassification = {
  readonly status: "clear" | "needs_investigation";
  readonly reasons: readonly string[];
};

export const classifyReviewTriage = (
  summary: ReviewTriageSummary,
  checks: readonly CheckResult[],
): ReviewTriageClassification => {
  const reasons = [
    ...(checks.some((check) => check.bucket === "fail") ? ["failed_checks"] : []),
    ...(summary.visibleOpenReviewThreadsCount > 0 ? ["visible_open_review_threads"] : []),
    ...(summary.unrepliedReviewThreadsCount > 0 ? ["unreplied_review_threads"] : []),
    ...(summary.unresolvedReviewThreadsCount > 0 ? ["unresolved_review_threads"] : []),
  ];
  return { status: reasons.length > 0 ? "needs_investigation" : "clear", reasons };
};

export const parsePrNumbers = (input: string): readonly number[] =>
  input
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((number) => Number.isInteger(number) && number > 0);

export const fetchReviewTriage = Effect.fn("pr.fetchReviewTriage")(function* (
  prNumber: number | null,
) {
  const [info, unresolvedThreads, visibleOpenThreads, summary, checks] = yield* Effect.all([
    viewPR(prNumber),
    fetchThreads(prNumber, true),
    fetchThreads(prNumber, false, true),
    fetchDiscussionSummary(prNumber),
    fetchChecks(prNumber, false, false, 0),
  ]);
  const classification = classifyReviewTriage(summary, checks);

  // Single merge-readiness verdict so agents stop re-stitching mergeable + checks + threads +
  // review state across separate calls (F2). `blocking` names exactly what's left to do.
  const blocking: string[] = [];
  if (info.mergeable !== "MERGEABLE") blocking.push(`mergeable=${info.mergeable || "UNKNOWN"}`);
  if (checks.some((check) => check.bucket === "fail")) blocking.push("failing_checks");
  if (checks.some((check) => check.bucket === "pending")) blocking.push("pending_checks");
  if (summary.unresolvedReviewThreadsCount > 0) blocking.push("unresolved_threads");
  if (info.reviewDecision !== "" && info.reviewDecision !== "APPROVED") {
    blocking.push(`review=${info.reviewDecision}`);
  }
  const ready = {
    ready: blocking.length === 0,
    mergeable: info.mergeable,
    reviewDecision: info.reviewDecision || null,
    blocking,
  };

  return { ready, classification, info, unresolvedThreads, visibleOpenThreads, summary, checks };
});

export const prViewCommand = Command.make(
  "view",
  {
    format: formatOption,
    pr: Flag.integer("pr").pipe(
      Flag.withDescription("PR number (default: current branch PR)"),
      Flag.optional,
    ),
    prs: Flag.string("prs").pipe(
      Flag.withDescription("Comma-separated PR numbers to view in one call (overrides --pr)"),
      Flag.optional,
    ),
    repo: repoOption,
  },
  ({ format, pr, prs, repo }) =>
    withRepo(
      repo,
      Effect.gen(function* () {
        const batch = Option.getOrNull(prs);
        if (batch !== null) {
          const numbers = parsePrNumbers(batch);
          if (numbers.length === 0) return yield* emptyBatchError(batch);
          const results = yield* Effect.all(
            numbers.map((n) => viewPR(n).pipe(Effect.map((info) => ({ pr: n, info })))),
            { concurrency: 5 },
          );
          yield* logFormatted({ count: results.length, prs: results }, format);
          return;
        }
        const info = yield* viewPR(Option.getOrNull(pr));
        yield* logFormatted(info, format);
      }),
    ),
).pipe(
  Command.withDescription("View PR information (use --prs 1,2,3 to view several in one call)"),
);

export const prStatusCommand = Command.make(
  "status",
  { format: formatOption, repo: repoOption },
  ({ format, repo }) =>
    withRepo(
      repo,
      Effect.gen(function* () {
        const result: PRStatusResult = yield* detectPRStatus();
        yield* logFormatted(result, format);
      }),
    ),
).pipe(
  Command.withDescription("Auto-detect PR for current branch or GitButler workspace branches"),
);

export const prListCommand = Command.make(
  "list",
  {
    format: formatOption,
    state: Flag.choice("state", ["open", "closed", "merged", "all"]).pipe(
      Flag.withDescription("Filter by state: open, closed, merged, all"),
      Flag.withDefault("open"),
    ),
    author: Flag.string("author").pipe(
      Flag.withDescription("Filter by author login (use @me for yourself)"),
      Flag.optional,
    ),
    base: Flag.string("base").pipe(Flag.withDescription("Filter by base branch"), Flag.optional),
    head: Flag.string("head").pipe(Flag.withDescription("Filter by head branch"), Flag.optional),
    search: Flag.string("search").pipe(
      Flag.withDescription("GitHub search query (e.g. 'review:required')"),
      Flag.optional,
    ),
    limit: Flag.integer("limit").pipe(
      Flag.withDescription("Maximum number of PRs to return"),
      Flag.withDefault(30),
    ),
    repo: repoOption,
  },
  ({ format, state, author, base, head, search, limit, repo }) =>
    withRepo(
      repo,
      Effect.gen(function* () {
        const prs = yield* listPRs({
          state,
          limit,
          author: Option.getOrNull(author),
          base: Option.getOrNull(base),
          head: Option.getOrNull(head),
          search: Option.getOrNull(search),
        });
        yield* logFormatted(prs, format);
      }),
    ),
).pipe(
  Command.withDescription(
    "List PRs (default: open; filter with --state/--author/--base/--head/--search)",
  ),
);

export const prWaitMergeableCommand = Command.make(
  "wait-mergeable",
  {
    format: formatOption,
    pr: Flag.integer("pr").pipe(
      Flag.withDescription("PR number (default: current branch PR)"),
      Flag.optional,
    ),
    timeout: Flag.integer("timeout").pipe(
      Flag.withDescription(
        "Max seconds to wait for a definitive mergeable verdict (capped at 180)",
      ),
      Flag.withDefault(60),
    ),
    repo: repoOption,
  },
  ({ format, pr, timeout, repo }) =>
    withRepo(
      repo,
      Effect.gen(function* () {
        const info = yield* waitForMergeable(Option.getOrNull(pr), timeout);
        yield* logFormatted(info, format);
      }),
    ),
).pipe(
  Command.withDescription(
    "Poll until GitHub reports a definitive mergeable verdict (MERGEABLE/CONFLICTING) or timeout",
  ),
);

export const prCreateCommand = Command.make(
  "create",
  {
    base: Flag.string("base").pipe(
      Flag.withDescription("Base branch for the PR (default: repository default branch)"),
      Flag.optional,
    ),
    body: Flag.string("body").pipe(Flag.withDescription("PR body/description"), Flag.optional),
    bodyFile: Flag.string("body-file").pipe(
      Flag.withDescription("Read PR body from a file path or '-' for stdin"),
      Flag.optional,
    ),
    bodyStdin: Flag.boolean("body-stdin").pipe(
      Flag.withDescription("Read PR body from stdin"),
      Flag.withDefault(false),
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
    repo: repoOption,
    title: Flag.string("title").pipe(Flag.withDescription("PR title")),
  },
  ({ base, body, bodyFile, bodyStdin, draft, format, head, repo, title }) =>
    withRepo(
      repo,
      Effect.gen(function* () {
        const resolvedBody = yield* resolveDefaultTextInput({
          command: "gh-tool pr create",
          value: Option.getOrNull(body),
          fileValue: Option.getOrNull(bodyFile),
          stdin: bodyStdin,
          valueFlag: "--body",
          fileFlag: "--body-file",
          stdinFlag: "--body-stdin",
          label: "body",
          defaultValue: "",
        });

        const info = yield* createPR({
          base: Option.getOrNull(base),
          body: resolvedBody,
          draft,
          head: Option.getOrNull(head),
          title,
        });
        yield* logFormatted(info, format);
      }),
    ),
).pipe(Command.withDescription("Create or update a PR for current branch"));

export const prEditCommand = Command.make(
  "edit",
  {
    base: Flag.string("base").pipe(Flag.withDescription("New base branch"), Flag.optional),
    body: Flag.string("body").pipe(Flag.withDescription("New PR body/description"), Flag.optional),
    bodyFile: Flag.string("body-file").pipe(
      Flag.withDescription("Read PR body from a file path or '-' for stdin"),
      Flag.optional,
    ),
    bodyStdin: Flag.boolean("body-stdin").pipe(
      Flag.withDescription("Read PR body from stdin"),
      Flag.withDefault(false),
    ),
    format: formatOption,
    pr: Flag.integer("pr").pipe(Flag.withDescription("PR number to edit")),
    repo: repoOption,
    title: Flag.string("title").pipe(Flag.withDescription("New PR title"), Flag.optional),
  },
  ({ base, body, bodyFile, bodyStdin, format, pr, repo, title }) =>
    withRepo(
      repo,
      Effect.gen(function* () {
        const resolvedBody = yield* resolveOptionalTextInput({
          command: "gh-tool pr edit",
          value: Option.getOrNull(body),
          fileValue: Option.getOrNull(bodyFile),
          stdin: bodyStdin,
          valueFlag: "--body",
          fileFlag: "--body-file",
          stdinFlag: "--body-stdin",
          label: "body",
        });

        const info = yield* editPR({
          pr,
          title: Option.getOrNull(title),
          body: resolvedBody,
          base: Option.getOrNull(base),
        });
        yield* logFormatted(info, format);
      }),
    ),
).pipe(Command.withDescription("Edit an existing PR's title, body, or other metadata"));

export const prCloseCommand = Command.make(
  "close",
  {
    comment: Flag.string("comment").pipe(
      Flag.withDescription("Comment to add when closing"),
      Flag.optional,
    ),
    commentFile: Flag.string("comment-file").pipe(
      Flag.withDescription("Read close comment from a file path or '-' for stdin"),
      Flag.optional,
    ),
    deleteBranch: Flag.boolean("delete-branch").pipe(
      Flag.withDescription("Delete the branch after closing"),
      Flag.withDefault(false),
    ),
    format: formatOption,
    pr: Flag.integer("pr").pipe(Flag.withDescription("PR number to close")),
    repo: repoOption,
  },
  ({ comment, commentFile, deleteBranch, format, pr, repo }) =>
    withRepo(
      repo,
      Effect.gen(function* () {
        const resolvedComment = yield* resolveOptionalTextInput({
          command: "gh-tool pr close",
          value: Option.getOrNull(comment),
          fileValue: Option.getOrNull(commentFile),
          valueFlag: "--comment",
          fileFlag: "--comment-file",
          label: "comment",
        });

        const result = yield* closePR({
          comment: resolvedComment,
          deleteBranch,
          pr,
        });
        yield* logFormatted(result, format);
      }),
    ),
).pipe(Command.withDescription("Close a PR with optional comment and branch deletion"));

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
    repo: repoOption,
    strategy: Flag.choice("strategy", MERGE_STRATEGIES).pipe(
      Flag.withDescription("Merge strategy: squash, merge, or rebase"),
      Flag.withDefault(DEFAULT_MERGE_STRATEGY),
    ),
  },
  ({ confirm, deleteBranch, format, pr, repo, strategy }) =>
    withRepo(
      repo,
      Effect.gen(function* () {
        const result = yield* mergePR({
          confirm,
          deleteBranch,
          pr,
          strategy,
        });
        yield* logFormatted(result, format);
      }),
    ),
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
    prs: Flag.string("prs").pipe(
      Flag.withDescription("Comma-separated PR numbers for a one-shot batch snapshot (no --watch)"),
      Flag.optional,
    ),
    repo: repoOption,
    timeout: Flag.integer("timeout").pipe(
      Flag.withDefault(CI_CHECK_WATCH_TIMEOUT_MS / 1000),
      Flag.withDescription("Timeout in seconds for watch mode (default: 600)"),
    ),
    watch: Flag.boolean("watch").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Watch until checks complete or timeout"),
    ),
  },
  ({ failFast, format, pr, prs, repo, timeout, watch }) =>
    withRepo(
      repo,
      Effect.gen(function* () {
        const batch = Option.getOrNull(prs);
        if (batch !== null) {
          if (watch) {
            yield* Console.warn(
              "ℹ️  --watch is ignored with --prs; batch mode returns a one-shot snapshot per PR.",
            );
          }
          const numbers = parsePrNumbers(batch);
          if (numbers.length === 0) return yield* emptyBatchError(batch);
          const results = yield* Effect.all(
            numbers.map((n) =>
              fetchChecks(n, false, failFast, timeout).pipe(
                Effect.map((checks) => ({ pr: n, checks })),
              ),
            ),
            { concurrency: 5 },
          );
          yield* logFormatted({ count: results.length, prs: results }, format);
          return;
        }
        const checks = yield* fetchChecksForCommand(Option.getOrNull(pr), watch, failFast, timeout);
        yield* logFormatted(checks, format);
      }),
    ),
).pipe(
  Command.withDescription(
    "Fetch CI check status for a PR (--watch to block; --prs 1,2,3 for a batch snapshot)",
  ),
);

export const prChecksFailedCommand = Command.make(
  "checks-failed",
  {
    format: formatOption,
    pr: Flag.integer("pr").pipe(
      Flag.withDescription("PR number (default: current branch PR)"),
      Flag.optional,
    ),
    repo: repoOption,
  },
  ({ format, pr, repo }) =>
    withRepo(
      repo,
      Effect.gen(function* () {
        const prNumber = Option.getOrNull(pr);
        const checks = yield* fetchFailedChecks(prNumber);
        yield* logFormatted(checks, format);
      }),
    ),
).pipe(Command.withDescription("Fetch only failed CI checks for a PR"));

export const prRerunChecksCommand = Command.make(
  "rerun-checks",
  {
    format: formatOption,
    pr: Flag.integer("pr").pipe(
      Flag.withDescription("PR number (default: current branch PR)"),
      Flag.optional,
    ),
    repo: repoOption,
    failedOnly: Flag.boolean("failed-only").pipe(
      Flag.withDefault(true),
      Flag.withDescription("Only rerun failed checks (default: true)"),
    ),
  },
  ({ failedOnly, format, pr, repo }) =>
    withRepo(
      repo,
      Effect.gen(function* () {
        const prNumber = Option.getOrNull(pr);
        const result = yield* rerunChecks(prNumber, failedOnly);
        yield* logFormatted(result, format);
      }),
    ),
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
    repo: repoOption,
    unresolvedOnly: Flag.boolean("unresolved-only").pipe(
      Flag.withDescription("Only show unresolved threads"),
      Flag.withDefault(true),
    ),
    visibleOpenOnly: Flag.boolean("visible-open-only").pipe(
      Flag.withDescription(
        "Show threads that still look open to humans: unresolved threads plus resolved threads with no reply",
      ),
      Flag.withDefault(false),
    ),
  },
  ({ format, pr, repo, unresolvedOnly, visibleOpenOnly }) =>
    withRepo(
      repo,
      Effect.gen(function* () {
        const prNumber = Option.getOrNull(pr);
        const threads = yield* fetchThreads(prNumber, unresolvedOnly, visibleOpenOnly);
        yield* logFormatted(threads, format);
      }),
    ),
).pipe(
  Command.withDescription(
    "Fetch review threads for a PR (unresolved by default, or use --visible-open-only for reply-aware human-visible open items)",
  ),
);

export const prCommentsCommand = Command.make(
  "comments",
  {
    format: formatOption,
    pr: Flag.integer("pr").pipe(
      Flag.withDescription("PR number (default: current branch PR)"),
      Flag.optional,
    ),
    repo: repoOption,
    since: Flag.string("since").pipe(
      Flag.withDescription("ISO timestamp to filter comments created after"),
      Flag.optional,
    ),
  },
  ({ format, pr, repo, since }) =>
    withRepo(
      repo,
      Effect.gen(function* () {
        const prNumber = Option.getOrNull(pr);
        const sinceValue = Option.getOrNull(since);
        const comments = yield* fetchComments(prNumber, sinceValue);
        yield* logFormatted(comments, format);
      }),
    ),
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
    repo: repoOption,
    since: Flag.string("since").pipe(
      Flag.withDescription("ISO timestamp to filter comments created after"),
      Flag.optional,
    ),
  },
  ({ author, bodyContains, format, pr, repo, since }) =>
    withRepo(
      repo,
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
    ),
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
    repo: repoOption,
  },
  ({ author, bodyContains, format, pr, repo }) =>
    withRepo(
      repo,
      Effect.gen(function* () {
        const prNumber = Option.getOrNull(pr);
        const authorValue = Option.getOrNull(author);
        const bodyContainsValue = Option.getOrNull(bodyContains);

        const comment = yield* fetchLatestIssueComment(prNumber, authorValue, bodyContainsValue);
        yield* logFormatted(comment, format);
      }),
    ),
).pipe(Command.withDescription("Fetch latest general PR discussion comment"));

export const prCommentCommand = Command.make(
  "comment",
  {
    body: Flag.string("body").pipe(
      Flag.withDescription("General PR comment body text"),
      Flag.optional,
    ),
    bodyFile: Flag.string("body-file").pipe(
      Flag.withDescription("Read general PR comment body from a file path or '-' for stdin"),
      Flag.optional,
    ),
    format: formatOption,
    pr: Flag.integer("pr").pipe(
      Flag.withDescription("PR number (default: current branch PR)"),
      Flag.optional,
    ),
    repo: repoOption,
  },
  ({ body, bodyFile, format, pr, repo }) =>
    withRepo(
      repo,
      Effect.gen(function* () {
        const prNumber = Option.getOrNull(pr);
        const resolvedBody = yield* resolveRequiredTextInput({
          command: "gh-tool pr comment",
          value: Option.getOrNull(body),
          fileValue: Option.getOrNull(bodyFile),
          valueFlag: "--body",
          fileFlag: "--body-file",
          label: "body",
        });
        const result = yield* postIssueComment(prNumber, resolvedBody);
        yield* logFormatted(result, format);
      }),
    ),
).pipe(Command.withDescription("Post a general PR discussion comment"));

export const prDiscussionSummaryCommand = Command.make(
  "discussion-summary",
  {
    format: formatOption,
    pr: Flag.integer("pr").pipe(
      Flag.withDescription("PR number (default: current branch PR)"),
      Flag.optional,
    ),
    repo: repoOption,
  },
  ({ format, pr, repo }) =>
    withRepo(
      repo,
      Effect.gen(function* () {
        const prNumber = Option.getOrNull(pr);
        const summary = yield* fetchDiscussionSummary(prNumber);
        yield* logFormatted(summary, format);
      }),
    ),
).pipe(
  Command.withDescription("Fetch counts and latest comment across PR discussions and reviews"),
);

export const prReplyCommand = Command.make(
  "reply",
  {
    body: Flag.string("body").pipe(Flag.withDescription("Reply body text"), Flag.optional),
    bodyFile: Flag.string("body-file").pipe(
      Flag.withDescription("Read reply body from a file path or '-' for stdin"),
      Flag.optional,
    ),
    commentId: Flag.integer("comment-id").pipe(
      Flag.withDescription("ID of the comment to reply to"),
    ),
    format: formatOption,
    pr: Flag.integer("pr").pipe(
      Flag.withDescription("PR number (default: current branch PR)"),
      Flag.optional,
    ),
    repo: repoOption,
  },
  ({ body, bodyFile, commentId, format, pr, repo }) =>
    withRepo(
      repo,
      Effect.gen(function* () {
        const prNumber = Option.getOrNull(pr);
        const resolvedBody = yield* resolveRequiredTextInput({
          command: "gh-tool pr reply",
          value: Option.getOrNull(body),
          fileValue: Option.getOrNull(bodyFile),
          valueFlag: "--body",
          fileFlag: "--body-file",
          label: "body",
        });
        const result = yield* replyToComment(prNumber, commentId, resolvedBody);
        yield* logFormatted(result, format);
      }),
    ),
).pipe(Command.withDescription("Reply to an inline review comment"));

export const prResolveCommand = Command.make(
  "resolve",
  {
    format: formatOption,
    threadId: Flag.string("thread-id").pipe(
      Flag.withDescription("GraphQL node ID of the thread to resolve"),
    ),
    repo: repoOption,
  },
  ({ format, repo, threadId }) =>
    withRepo(
      repo,
      Effect.gen(function* () {
        const result = yield* resolveThread(threadId);
        yield* logFormatted(result, format);
      }),
    ),
).pipe(Command.withDescription("Resolve a review thread via GraphQL"));

export const prSubmitReviewCommand = Command.make(
  "submit-review",
  {
    body: Flag.string("body").pipe(
      Flag.withDescription("Optional review body text when submitting"),
      Flag.optional,
    ),
    bodyFile: Flag.string("body-file").pipe(
      Flag.withDescription("Read review body from a file path or '-' for stdin"),
      Flag.optional,
    ),
    format: formatOption,
    pr: Flag.integer("pr").pipe(
      Flag.withDescription("PR number (default: current branch PR)"),
      Flag.optional,
    ),
    repo: repoOption,
    reviewId: Flag.string("review-id").pipe(
      Flag.withDescription(
        "Pending review GraphQL ID (defaults to current user's pending review on PR)",
      ),
      Flag.optional,
    ),
  },
  ({ body, bodyFile, format, pr, repo, reviewId }) =>
    withRepo(
      repo,
      Effect.gen(function* () {
        const prNumber = Option.getOrNull(pr);
        const reviewIdValue = Option.getOrNull(reviewId);
        const bodyValue = yield* resolveOptionalTextInput({
          command: "gh-tool pr submit-review",
          value: Option.getOrNull(body),
          fileValue: Option.getOrNull(bodyFile),
          valueFlag: "--body",
          fileFlag: "--body-file",
          label: "body",
        });
        const result = yield* submitPendingReview(prNumber, reviewIdValue, bodyValue);
        yield* logFormatted(result, format);
      }),
    ),
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
    repo: repoOption,
  },
  ({ format, pr, repo }) =>
    withRepo(
      repo,
      Effect.gen(function* () {
        const prNumber = Option.getOrNull(pr);
        const result = yield* fetchReviewTriage(prNumber);
        yield* logFormatted(result, format);
      }),
    ),
).pipe(
  Command.withDescription(
    "Composite: PR info + unresolved threads + visible-open threads + discussion summary + checks status in one call",
  ),
);

export const prReviewTriageBatchCommand = Command.make(
  "review-triage-batch",
  {
    format: formatOption,
    prs: Flag.string("prs").pipe(Flag.withDescription("Comma-separated PR numbers")),
    repo: repoOption,
  },
  ({ format, prs, repo }) =>
    withRepo(
      repo,
      Effect.gen(function* () {
        const results = yield* Effect.all(
          parsePrNumbers(prs).map((prNumber) => fetchReviewTriage(prNumber)),
          { concurrency: "unbounded" },
        );
        yield* logFormatted(results, format);
      }),
    ),
).pipe(
  Command.withDescription(
    "Composite: fetch review-triage output for multiple PRs in one gh-tool invocation",
  ),
);

export const prReplyAndResolveCommand = Command.make(
  "reply-and-resolve",
  {
    body: Flag.string("body").pipe(Flag.withDescription("Reply body text"), Flag.optional),
    bodyFile: Flag.string("body-file").pipe(
      Flag.withDescription("Read reply body from a file path or '-' for stdin"),
      Flag.optional,
    ),
    commentId: Flag.integer("comment-id").pipe(
      Flag.withDescription("ID of the comment to reply to"),
    ),
    format: formatOption,
    pr: Flag.integer("pr").pipe(
      Flag.withDescription("PR number (default: current branch PR)"),
      Flag.optional,
    ),
    repo: repoOption,
    threadId: Flag.string("thread-id").pipe(
      Flag.withDescription("GraphQL node ID of the thread to resolve"),
    ),
  },
  ({ body, bodyFile, commentId, format, pr, repo, threadId }) =>
    withRepo(
      repo,
      Effect.gen(function* () {
        const prNumber = Option.getOrNull(pr);
        const resolvedBody = yield* resolveRequiredTextInput({
          command: "gh-tool pr reply-and-resolve",
          value: Option.getOrNull(body),
          fileValue: Option.getOrNull(bodyFile),
          valueFlag: "--body",
          fileFlag: "--body-file",
          label: "body",
        });
        const replyResult = yield* replyToComment(prNumber, commentId, resolvedBody);
        const resolveResult = yield* resolveThread(threadId);
        yield* logFormatted({ reply: replyResult, resolve: resolveResult }, format);
      }),
    ),
).pipe(
  Command.withDescription(
    "Composite: reply to a review comment and resolve its thread in one call",
  ),
);
