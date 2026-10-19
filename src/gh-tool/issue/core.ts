import { Effect } from "effect";

import type { GitHubIssueCommentUrl, IssueComment, IssueCommentId, IsoTimestamp } from "#gh/types";

import { GitHubCommandError } from "#gh/errors";
import { GitHubService } from "#gh/read/transport";
import { reads, resolveRepo } from "#gh/read/reads";
import { writes } from "#gh/read/writes";
import { project } from "#gh/read/porcelain";
import { repoSlug } from "#gh/read/keys";

export type IssueInfo = {
  number: number;
  title: string;
  state: string;
  url: string;
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  author: { login: string };
  createdAt: string;
  closedAt: string | null;
};

export type IssueListItem = {
  number: number;
  title: string;
  state: string;
  url: string;
  labels: Array<{ name: string }>;
  createdAt: string;
};

export type RawIssueComment = {
  id: number;
  user: { login: string };
  body: string;
  created_at: string;
  html_url: string;
};

const mapRawIssueComment = (comment: RawIssueComment): IssueComment => ({
  id: comment.id as IssueCommentId,
  commitSha: null,
  feedbackOrigin: "unknown",
  author: comment.user.login,
  body: comment.body,
  createdAt: comment.created_at as IsoTimestamp,
  url: comment.html_url as GitHubIssueCommentUrl,
});

export const listIssues = Effect.fn("issue.listIssues")(function* (opts: {
  state: string;
  labels: string | null;
  limit: number;
  includeBody?: boolean;
  fresh?: boolean;
}) {
  const { fresh, ...filter } = opts;
  return yield* reads.issueList(yield* resolveRepo(null), filter, fresh ? "origin" : "cached");
});

export const viewIssue = Effect.fn("issue.viewIssue")(function* (issueNumber: number) {
  const value = yield* reads.issueView(yield* resolveRepo(null), issueNumber);
  return project(value, [
    "number",
    "title",
    "state",
    "url",
    "labels",
    "assignees",
    "author",
    "createdAt",
    "closedAt",
  ]);
});

export const fetchIssueComments = Effect.fn("issue.fetchIssueComments")(function* (
  issueNumber: number,
  since: string | null,
  author: string | null,
  bodyContains: string | null,
) {
  const raw = yield* reads.issueComments(yield* resolveRepo(null), issueNumber);

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

export const closeIssue = Effect.fn("issue.closeIssue")(function* (opts: {
  issue: number;
  comment: string | null;
  reason: string;
}) {
  const args = ["issue", "close", String(opts.issue), "--reason", opts.reason];

  if (opts.comment !== null) {
    args.push("--comment", opts.comment);
  }

  const repo = yield* resolveRepo(null);
  yield* writes.run(args, [
    `issue:${repoSlug(repo)}#${opts.issue}`,
    `issues:${repoSlug(repo)}`,
    `issue-comments:${repoSlug(repo)}#${opts.issue}`,
  ]);

  return yield* viewIssue(opts.issue);
});

export const reopenIssue = Effect.fn("issue.reopenIssue")(function* (opts: {
  issue: number;
  comment: string | null;
}) {
  const args = ["issue", "reopen", String(opts.issue)];

  if (opts.comment !== null) {
    args.push("--comment", opts.comment);
  }

  const repo = yield* resolveRepo(null);
  yield* writes.run(args, [
    `issue:${repoSlug(repo)}#${opts.issue}`,
    `issues:${repoSlug(repo)}`,
    `issue-comments:${repoSlug(repo)}#${opts.issue}`,
  ]);

  return yield* viewIssue(opts.issue);
});

export const commentOnIssue = Effect.fn("issue.commentOnIssue")(function* (opts: {
  issue: number;
  body: string;
}) {
  const gh = yield* GitHubService;
  const repoInfo = yield* gh.getRepoInfo();

  if (opts.body.trim().length === 0) {
    return yield* Effect.fail(
      new GitHubCommandError({
        command: "gh-tool issue comment",
        exitCode: 0,
        stderr: "Comment body cannot be empty",
        message: "Comment body cannot be empty",
      }),
    );
  }

  const result = yield* writes.run(
    [
      "api",
      "-X",
      "POST",
      `repos/${repoInfo.owner}/${repoInfo.name}/issues/${opts.issue}/comments`,
      "-f",
      `body=${opts.body}`,
    ],
    [
      `issue-comments:${repoInfo.owner.toLowerCase()}/${repoInfo.name.toLowerCase()}#${opts.issue}`,
      `issue:${repoInfo.owner.toLowerCase()}/${repoInfo.name.toLowerCase()}#${opts.issue}`,
    ],
  );

  const rawComment = yield* Effect.try({
    try: () => JSON.parse(result.stdout) as RawIssueComment,
    catch: (error) =>
      new GitHubCommandError({
        command: "gh-tool issue comment",
        exitCode: 0,
        stderr: `Failed to parse response: ${error instanceof Error ? error.message : String(error)}`,
        message: `Failed to parse response: ${error instanceof Error ? error.message : String(error)}`,
      }),
  }).pipe(Effect.mapError((error) => error as GitHubCommandError));

  return {
    id: rawComment.id,
    author: rawComment.user.login,
    body: rawComment.body,
    createdAt: rawComment.created_at,
    url: rawComment.html_url,
  };
});

export const createIssue = Effect.fn("issue.createIssue")(function* (opts: {
  title: string;
  body: string;
  assignee: string | null;
  labels: string | null;
}) {
  const args = ["issue", "create", "--title", opts.title, "--body", opts.body];

  if (opts.assignee !== null) {
    args.push("--assignee", opts.assignee);
  }
  if (opts.labels !== null) {
    args.push("--label", opts.labels);
  }

  const repo = yield* resolveRepo(null);
  const result = yield* writes.run(args, [`repo:${repoSlug(repo)}`]);

  const urlMatch = result.stdout.match(/\/issues\/(\d+)/);
  if (!urlMatch?.[1]) {
    return yield* Effect.fail(
      new GitHubCommandError({
        command: "gh issue create",
        exitCode: 0,
        stderr: "Issue was created but its number could not be parsed from the output.",
        message: "Issue was created but its number could not be parsed from the output.",
      }),
    );
  }

  return yield* viewIssue(Number(urlMatch[1]));
});

export const editIssue = Effect.fn("issue.editIssue")(function* (opts: {
  issue: number;
  title: string | null;
  body: string | null;
  addLabels: string | null;
  removeLabels: string | null;
  addAssignee: string | null;
  removeAssignee: string | null;
}) {
  const args = ["issue", "edit", String(opts.issue)];

  if (opts.title !== null) {
    args.push("--title", opts.title);
  }
  if (opts.body !== null) {
    args.push("--body", opts.body);
  }
  if (opts.addLabels !== null) {
    args.push("--add-label", opts.addLabels);
  }
  if (opts.removeLabels !== null) {
    args.push("--remove-label", opts.removeLabels);
  }
  if (opts.addAssignee !== null) {
    args.push("--add-assignee", opts.addAssignee);
  }
  if (opts.removeAssignee !== null) {
    args.push("--remove-assignee", opts.removeAssignee);
  }

  const repo = yield* resolveRepo(null);
  yield* writes.run(args, [
    `issue:${repoSlug(repo)}#${opts.issue}`,
    `issues:${repoSlug(repo)}`,
    `issue-comments:${repoSlug(repo)}#${opts.issue}`,
  ]);

  return yield* viewIssue(opts.issue);
});
