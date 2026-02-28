import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Console, Effect, Option, Stream } from "effect";

import type {
  BranchPRDetail,
  CheckResult,
  GitHubIssueCommentUrl,
  IssueComment,
  IssueCommentId,
  IsoTimestamp,
  MergeResult,
  MergeStrategy,
  PRInfo,
  PRStatusResult,
  ReviewComment,
  ReviewThread,
} from "./types";

import { formatOption, logFormatted } from "../shared";
import {
  CI_CHECK_WATCH_TIMEOUT_MS,
  DEFAULT_DELETE_BRANCH,
  DEFAULT_MERGE_STRATEGY,
  MERGE_STRATEGIES,
} from "./config";
import { GitHubCommandError, GitHubMergeError, GitHubTimeoutError } from "./errors";
import { GitHubService } from "./service";

type PRViewJsonResult = PRInfo & { mergeable: string };

type LocalCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type ButStatusJson = {
  stacks: Array<{
    branches: Array<{ name: string }>;
  }>;
};

const runLocalCommand = Effect.fn("pr.runLocalCommand")(function* (binary: string, args: string[]) {
  const executor = yield* ChildProcessSpawner.ChildProcessSpawner;

  const command = ChildProcess.make(binary, args, {
    stdout: "pipe",
    stderr: "pipe",
  });

  const result = yield* Effect.scoped(
    Effect.gen(function* () {
      const proc = yield* executor.spawn(command);

      const stdoutChunk = yield* proc.stdout.pipe(Stream.decodeText(), Stream.runCollect);
      const stdout = stdoutChunk.join("");

      const stderrChunk = yield* proc.stderr.pipe(Stream.decodeText(), Stream.runCollect);
      const stderr = stderrChunk.join("");

      const exitCode = yield* proc.exitCode;

      const commandText = [binary, ...args].join(" ");
      if (exitCode !== 0) {
        return yield* Effect.fail(
          new GitHubCommandError({
            message: stderr.trim(),
            command: commandText,
            exitCode: exitCode as number,
            stderr: stderr.trim(),
          }),
        );
      }

      const commandResult: LocalCommandResult = {
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: exitCode as number,
      };
      return commandResult;
    }),
  ).pipe(
    Effect.mapError(
      (error) =>
        new GitHubCommandError({
          command: [binary, ...args].join(" "),
          exitCode: -1,
          stderr: String(error),
          message: String(error),
        }),
    ),
  );

  return result;
});

const viewPR = Effect.fn("pr.viewPR")(function* (prNumber: number | null) {
  const gh = yield* GitHubService;

  const args = ["pr", "view"];
  if (prNumber !== null) {
    args.push(String(prNumber));
  }
  args.push("--json", "number,url,title,headRefName,baseRefName,state,isDraft");

  const info = yield* gh.runGhJson<PRInfo>(args);
  return info;
});

const detectPRStatus = Effect.fn("pr.detectPRStatus")(function* () {
  const directPr = yield* viewPR(null).pipe(Effect.option);
  if (Option.isSome(directPr)) {
    return {
      mode: "single" as const,
      pr: directPr.value,
    };
  }

  const currentBranchResult = yield* runLocalCommand("git", [
    "symbolic-ref",
    "--short",
    "HEAD",
  ]).pipe(Effect.option);

  if (Option.isNone(currentBranchResult)) {
    return {
      mode: "none" as const,
      branches: [] as BranchPRDetail[],
    };
  }

  const currentBranch = currentBranchResult.value.stdout;
  const isGitButlerWorkspace = currentBranch === "gitbutler/workspace";

  if (!isGitButlerWorkspace) {
    return {
      mode: "none" as const,
      branches: [] as BranchPRDetail[],
    };
  }

  const butStatusResult = yield* runLocalCommand("but", ["status", "--json"]);

  const butStatus = yield* Effect.try({
    try: () => JSON.parse(butStatusResult.stdout) as ButStatusJson,
    catch: (error) =>
      new GitHubCommandError({
        command: "but status --json",
        exitCode: 0,
        stderr: `Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}`,
        message: `Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}`,
      }),
  }).pipe(Effect.mapError((error) => error as GitHubCommandError));

  const branchNames = [
    ...new Set(
      butStatus.stacks.flatMap((stack) =>
        stack.branches.map((branch) => branch.name).filter((name) => name.length > 0),
      ),
    ),
  ];

  const gh = yield* GitHubService;

  type BranchResult = {
    branch: string;
    openPr: PRInfo | null;
    closedPr: {
      number: number;
      url: string;
      state: "MERGED" | "CLOSED";
    } | null;
    remoteExists: boolean;
  };

  const branchResults = yield* Effect.all(
    branchNames.map((branchName) =>
      Effect.all(
        {
          openPr: gh
            .runGhJson<PRInfo[]>([
              "pr",
              "list",
              "--head",
              branchName,
              "--json",
              "number,url,title,headRefName,baseRefName,state,isDraft",
              "--limit",
              "1",
            ])
            .pipe(
              Effect.map((prs) => prs[0] ?? null),
              Effect.catchTag("GitHubCommandError", () => Effect.succeed(null)),
            ),
          closedPr: gh
            .runGhJson<
              Array<{
                number: number;
                url: string;
                state: string;
              }>
            >([
              "pr",
              "list",
              "--head",
              branchName,
              "--state",
              "closed",
              "--json",
              "number,url,state",
              "--limit",
              "1",
            ])
            .pipe(
              Effect.map((prs) => {
                const pr = prs[0];
                if (!pr) return null;
                return {
                  number: pr.number,
                  url: pr.url,
                  state: pr.state as "MERGED" | "CLOSED",
                };
              }),
              Effect.catchTag("GitHubCommandError", () => Effect.succeed(null)),
            ),
          remoteExists: runLocalCommand("git", ["ls-remote", "--heads", "origin", branchName]).pipe(
            Effect.map((result) => result.stdout.trim().length > 0),
            Effect.catch(() => Effect.succeed(false)),
          ),
        },
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map(
          (r): BranchResult => ({
            branch: branchName,
            ...r,
          }),
        ),
      ),
    ),
    { concurrency: "unbounded" },
  );

  const foundPrs = branchResults.filter((r) => r.openPr !== null).map((r) => r.openPr!);

  if (foundPrs.length === 0) {
    const branchDetails: BranchPRDetail[] = branchResults.map((r) => ({
      branch: r.branch,
      remoteExists: r.remoteExists,
      closedPr: r.closedPr,
    }));
    return {
      mode: "none" as const,
      branches: branchDetails,
    };
  }

  if (foundPrs.length === 1) {
    return {
      mode: "single" as const,
      pr: foundPrs[0]!,
    };
  }

  return {
    mode: "multiple" as const,
    prs: foundPrs,
  };
});

const createPR = Effect.fn("pr.createPR")(function* (opts: {
  base: string;
  title: string;
  body: string;
  draft: boolean;
  head: string | null;
}) {
  const gh = yield* GitHubService;

  // When --head is provided (e.g. GitButler workspace), use `gh pr list --head`
  // to find existing PR since `gh pr view` relies on the current git branch.
  const existing = yield* opts.head !== null
    ? gh
        .runGhJson<PRInfo[]>([
          "pr",
          "list",
          "--head",
          opts.head,
          "--json",
          "number,url,title,headRefName,baseRefName,state,isDraft",
          "--limit",
          "1",
        ])
        .pipe(Effect.map((prs) => (prs.length > 0 ? Option.some(prs[0]!) : Option.none())))
    : gh
        .runGhJson<{ number: number; url: string }>(["pr", "view", "--json", "number,url"])
        .pipe(Effect.option);

  if (Option.isSome(existing)) {
    const pr = existing.value;
    yield* gh.runGh(["pr", "edit", String(pr.number), "--title", opts.title, "--body", opts.body]);

    return yield* viewPR(pr.number);
  }

  const createArgs = [
    "pr",
    "create",
    "--base",
    opts.base,
    "--title",
    opts.title,
    "--body",
    opts.body,
  ];

  if (opts.head !== null) {
    createArgs.push("--head", opts.head);
  }

  if (opts.draft) {
    createArgs.push("--draft");
  }

  const createResult = yield* gh.runGh(createArgs);

  if (opts.head === null) {
    return yield* viewPR(null);
  }

  const urlMatch = createResult.stdout.match(/\/pull\/(\d+)/);
  if (urlMatch?.[1]) {
    return yield* viewPR(Number(urlMatch[1]));
  }

  const prs = yield* gh.runGhJson<PRInfo[]>([
    "pr",
    "list",
    "--head",
    opts.head,
    "--json",
    "number,url,title,headRefName,baseRefName,state,isDraft",
    "--limit",
    "1",
  ]);
  if (prs.length > 0) {
    return prs[0]!;
  }

  return yield* Effect.fail(
    new GitHubCommandError({
      command: `gh pr create --head ${opts.head}`,
      exitCode: 0,
      stderr: "Pull request was created but could not be resolved by head branch.",
      message: "Pull request was created but could not be resolved by head branch.",
    }),
  );
});

const mergePR = Effect.fn("pr.mergePR")(function* (opts: {
  pr: number;
  strategy: MergeStrategy;
  deleteBranch: boolean;
  confirm: boolean;
}) {
  const gh = yield* GitHubService;

  const info = yield* gh.runGhJson<PRViewJsonResult>([
    "pr",
    "view",
    String(opts.pr),
    "--json",
    "number,url,title,headRefName,baseRefName,state,isDraft,mergeable",
  ]);

  if (!opts.confirm) {
    const mergeableNote =
      info.mergeable === "MERGEABLE"
        ? "PR is mergeable."
        : `PR mergeable status: ${info.mergeable}`;

    yield* Console.log(
      `DRY RUN: Would merge PR #${info.number} "${info.title}" via ${opts.strategy.toUpperCase()}. ` +
        `Branch \`${info.headRefName}\` → \`${info.baseRefName}\`. ` +
        (opts.deleteBranch ? `Branch \`${info.headRefName}\` will be deleted. ` : "") +
        mergeableNote,
    );

    const result: MergeResult = {
      merged: false,
      strategy: opts.strategy,
      branchDeleted: false,
      sha: null,
    };
    return result;
  }

  const mergeArgs = ["pr", "merge", String(opts.pr), `--${opts.strategy}`];

  if (opts.deleteBranch) {
    mergeArgs.push("--delete-branch");
  }

  const mergeResult = yield* gh.runGh(mergeArgs).pipe(
    Effect.catchTag("GitHubCommandError", (error) => {
      const stderr = error.stderr.toLowerCase();

      if (stderr.includes("merge conflict") || stderr.includes("conflicts")) {
        return Effect.fail(
          new GitHubMergeError({
            message: `PR #${opts.pr} has merge conflicts`,
            reason: "conflicts",
          }),
        );
      }

      if (stderr.includes("required status check") || stderr.includes("checks")) {
        return Effect.fail(
          new GitHubMergeError({
            message: `PR #${opts.pr} has failing required checks`,
            reason: "checks_failing",
          }),
        );
      }

      if (stderr.includes("protected branch")) {
        return Effect.fail(
          new GitHubMergeError({
            message: `PR #${opts.pr} targets a protected branch`,
            reason: "branch_protected",
          }),
        );
      }

      return Effect.fail(
        new GitHubMergeError({
          message: `Failed to merge PR #${opts.pr}: ${error.stderr}`,
          reason: "unknown",
        }),
      );
    }),
  );

  const shaMatch = mergeResult.stdout.match(/([0-9a-f]{7,40})/);

  const result: MergeResult = {
    merged: true,
    strategy: opts.strategy,
    branchDeleted: opts.deleteBranch,
    sha: shaMatch?.[1] ?? null,
  };
  return result;
});

const fetchChecks = Effect.fn("pr.fetchChecks")(function* (
  pr: number | null,
  watch: boolean,
  failFast: boolean,
  timeoutSeconds: number,
) {
  const gh = yield* GitHubService;

  const args = ["pr", "checks"];
  if (pr !== null) {
    args.push(String(pr));
  }

  if (watch) {
    const watchArgs = [...args, "--watch"];
    if (failFast) {
      watchArgs.push("--fail-fast");
    }

    const timeoutMs = timeoutSeconds * 1000;
    yield* gh.runGh(watchArgs).pipe(
      Effect.timeoutOrElse({
        duration: timeoutMs,
        onTimeout: () =>
          Effect.fail(
            new GitHubTimeoutError({
              message: `CI check monitoring timed out after ${timeoutSeconds}s`,
              timeoutMs,
            }),
          ),
      }),
    );

    return yield* gh.runGhJson<CheckResult[]>([...args, "--json", "name,state,bucket,link"]);
  }

  return yield* gh.runGhJson<CheckResult[]>([...args, "--json", "name,state,bucket,link"]);
});

const fetchFailedChecks = Effect.fn("pr.fetchFailedChecks")(function* (pr: number | null) {
  const checks = yield* fetchChecks(pr, false, false, 0);
  return checks.filter((check) => check.bucket === "fail");
});

// ---------------------------------------------------------------------------
// Review: GraphQL queries & internal types
// ---------------------------------------------------------------------------

// GraphQL query for review threads
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

// GraphQL mutation for resolving threads
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

// ---------------------------------------------------------------------------
// Review: handlers
// ---------------------------------------------------------------------------

/**
 * Fetch review threads for a PR via GraphQL.
 * Filters to unresolved threads when unresolvedOnly is true.
 */
const fetchThreads = Effect.fn("pr.fetchThreads")(function* (
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
const fetchComments = Effect.fn("pr.fetchComments")(function* (
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

const mapRawIssueComment = (comment: RawIssueComment): IssueComment => ({
  id: comment.id as IssueCommentId,
  author: comment.user.login,
  body: comment.body,
  createdAt: comment.created_at as IsoTimestamp,
  url: comment.html_url as GitHubIssueCommentUrl,
});

/**
 * Fetch general PR discussion comments (issue comments) via REST API.
 * Supports optional filtering by timestamp, author, and body substring.
 */
const fetchIssueComments = Effect.fn("pr.fetchIssueComments")(function* (
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

const fetchLatestIssueComment = Effect.fn("pr.fetchLatestIssueComment")(function* (
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

const postIssueComment = Effect.fn("pr.postIssueComment")(function* (
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

const fetchDiscussionSummary = Effect.fn("pr.fetchDiscussionSummary")(function* (
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

type ReviewCommentById = {
  id: number;
  in_reply_to_id: number | null;
  pull_request_url: string;
};

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
const replyToComment = Effect.fn("pr.replyToComment")(function* (
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
const resolveThread = Effect.fn("pr.resolveThread")(function* (threadId: string) {
  const service = yield* GitHubService;

  const response = (yield* service.runGraphQL(RESOLVE_THREAD_MUTATION, {
    threadId,
  })) as ResolveThreadResult;

  return {
    resolved: response.resolveReviewThread.thread.isResolved,
    threadId: response.resolveReviewThread.thread.id,
  };
});

const submitPendingReview = Effect.fn("pr.submitPendingReview")(function* (
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

const editPR = Effect.fn("pr.editPR")(function* (opts: {
  pr: number;
  title: string | null;
  body: string | null;
}) {
  if (!opts.title && !opts.body) {
    return yield* Effect.fail(
      new GitHubCommandError({
        command: "pr edit",
        exitCode: 1,
        stderr: "At least one of --title or --body must be provided",
        message: "At least one of --title or --body must be provided",
      }),
    );
  }

  const gh = yield* GitHubService;

  const editArgs = ["pr", "edit", String(opts.pr)];

  if (opts.title) {
    editArgs.push("--title", opts.title);
  }
  if (opts.body) {
    editArgs.push("--body", opts.body);
  }

  yield* gh.runGh(editArgs);

  return yield* viewPR(opts.pr);
});

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

// ---------------------------------------------------------------------------
// Rerun checks
// ---------------------------------------------------------------------------

const rerunChecks = Effect.fn("pr.rerunChecks")(function* (pr: number | null, failedOnly: boolean) {
  const gh = yield* GitHubService;

  const checks = yield* gh.runGhJson<
    Array<{
      name: string;
      link: string;
      bucket: string;
      state: string;
    }>
  >(["pr", "checks", ...(pr !== null ? [String(pr)] : []), "--json", "name,link,bucket,state"]);

  // Extract unique GitHub Actions run IDs from links
  const runIds = new Set<string>();
  for (const check of failedOnly ? checks.filter((c) => c.bucket === "fail") : checks) {
    const match = check.link.match(/github\.com\/[^/]+\/[^/]+\/actions\/runs\/(\d+)/);
    if (match?.[1]) {
      runIds.add(match[1]);
    }
  }

  if (runIds.size === 0) {
    return {
      rerun: 0,
      message: failedOnly
        ? "No failed GitHub Actions runs found to rerun"
        : "No GitHub Actions runs found to rerun",
    };
  }

  const results: Array<{
    runId: string;
    success: boolean;
  }> = [];
  for (const runId of runIds) {
    const rerunArgs = failedOnly ? ["run", "rerun", runId, "--failed"] : ["run", "rerun", runId];
    const success = yield* gh.runGh(rerunArgs).pipe(
      Effect.map(() => true),
      Effect.catch(() => Effect.succeed(false)),
    );
    results.push({ runId, success });
  }

  return {
    rerun: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    runs: results,
    message: `Rerun ${results.filter((r) => r.success).length}/${results.length} GitHub Actions runs`,
  };
});

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
