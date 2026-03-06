import { Effect } from "effect";

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
