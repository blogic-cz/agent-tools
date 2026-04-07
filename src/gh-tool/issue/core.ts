import { Effect } from "effect";

import type { GitHubIssueCommentUrl, IssueComment, IssueCommentId, IsoTimestamp } from "#gh/types";

import { GitHubCommandError } from "#gh/errors";
import { GitHubService } from "#gh/service";

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

const REST_PAGE_SIZE = 100;

const parseJson = <T>(
  stdout: string,
  command: string,
  parseFailurePrefix: string,
): Effect.Effect<T, GitHubCommandError> =>
  Effect.try({
    try: () => JSON.parse(stdout) as T,
    catch: (error) =>
      new GitHubCommandError({
        command,
        exitCode: 0,
        stderr: `${parseFailurePrefix}: ${error instanceof Error ? error.message : String(error)}`,
        message: `${parseFailurePrefix}: ${error instanceof Error ? error.message : String(error)}`,
      }),
  });

const fetchAllRestPages = Effect.fn("issue.fetchAllRestPages")(function* <T>(
  endpoint: string,
  command: string,
  parseFailurePrefix: string,
) {
  const service = yield* GitHubService;

  const results: T[] = [];
  let page = 1;

  while (true) {
    const separator = endpoint.includes("?") ? "&" : "?";
    const result = yield* service.runGh([
      "api",
      `${endpoint}${separator}per_page=${REST_PAGE_SIZE}&page=${page}`,
    ]);

    const rawPage = yield* parseJson<T[]>(result.stdout, command, parseFailurePrefix);
    results.push(...rawPage);

    if (rawPage.length < REST_PAGE_SIZE) {
      return results;
    }

    page += 1;
  }
});

const mapRawIssueComment = (comment: RawIssueComment): IssueComment => ({
  id: comment.id as IssueCommentId,
  author: comment.user.login,
  body: comment.body,
  createdAt: comment.created_at as IsoTimestamp,
  url: comment.html_url as GitHubIssueCommentUrl,
});

export const listIssues = Effect.fn("issue.listIssues")(function* (opts: {
  state: string;
  labels: string | null;
  limit: number;
}) {
  const gh = yield* GitHubService;

  const args = [
    "issue",
    "list",
    "--state",
    opts.state,
    "--limit",
    String(opts.limit),
    "--json",
    "number,title,state,url,labels,createdAt",
  ];

  if (opts.labels !== null) {
    args.push("--label", opts.labels);
  }

  return yield* gh.runGhJson<IssueListItem[]>(args);
});

export const viewIssue = Effect.fn("issue.viewIssue")(function* (issueNumber: number) {
  const gh = yield* GitHubService;

  return yield* gh.runGhJson<IssueInfo>([
    "issue",
    "view",
    String(issueNumber),
    "--json",
    "number,title,state,url,labels,assignees,author,createdAt,closedAt",
  ]);
});

export const fetchIssueComments = Effect.fn("issue.fetchIssueComments")(function* (
  issueNumber: number,
  since: string | null,
  author: string | null,
  bodyContains: string | null,
) {
  const gh = yield* GitHubService;
  const repoInfo = yield* gh.getRepoInfo();

  const raw = yield* fetchAllRestPages<RawIssueComment>(
    `repos/${repoInfo.owner}/${repoInfo.name}/issues/${issueNumber}/comments`,
    "gh-tool issue comments",
    "Failed to parse response",
  );

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
  const gh = yield* GitHubService;

  const args = ["issue", "close", String(opts.issue), "--reason", opts.reason];

  if (opts.comment !== null) {
    args.push("--comment", opts.comment);
  }

  yield* gh.runGh(args);

  return yield* gh.runGhJson<IssueInfo>([
    "issue",
    "view",
    String(opts.issue),
    "--json",
    "number,title,state,url,labels,assignees,author,createdAt,closedAt",
  ]);
});

export const reopenIssue = Effect.fn("issue.reopenIssue")(function* (opts: {
  issue: number;
  comment: string | null;
}) {
  const gh = yield* GitHubService;

  const args = ["issue", "reopen", String(opts.issue)];

  if (opts.comment !== null) {
    args.push("--comment", opts.comment);
  }

  yield* gh.runGh(args);

  return yield* gh.runGhJson<IssueInfo>([
    "issue",
    "view",
    String(opts.issue),
    "--json",
    "number,title,state,url,labels,assignees,author,createdAt,closedAt",
  ]);
});

export const commentOnIssue = Effect.fn("issue.commentOnIssue")(function* (opts: {
  issue: number;
  body: string;
}) {
  const gh = yield* GitHubService;
  const repoInfo = yield* gh.getRepoInfo();

  const trimmedBody = opts.body.trim();
  if (trimmedBody.length === 0) {
    return yield* Effect.fail(
      new GitHubCommandError({
        command: "gh-tool issue comment",
        exitCode: 0,
        stderr: "Comment body cannot be empty",
        message: "Comment body cannot be empty",
      }),
    );
  }

  const result = yield* gh.runGh([
    "api",
    "-X",
    "POST",
    `repos/${repoInfo.owner}/${repoInfo.name}/issues/${opts.issue}/comments`,
    "-f",
    `body=${trimmedBody}`,
  ]);

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

export const editIssue = Effect.fn("issue.editIssue")(function* (opts: {
  issue: number;
  title: string | null;
  body: string | null;
  addLabels: string | null;
  removeLabels: string | null;
  addAssignee: string | null;
  removeAssignee: string | null;
}) {
  const gh = yield* GitHubService;

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

  yield* gh.runGh(args);

  return yield* gh.runGhJson<IssueInfo>([
    "issue",
    "view",
    String(opts.issue),
    "--json",
    "number,title,state,url,labels,assignees,author,createdAt,closedAt",
  ]);
});
