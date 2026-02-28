import { Command, Flag } from "effect/unstable/cli";
import { Effect, Option } from "effect";

import { formatOption, logFormatted } from "../shared";
import { GitHubCommandError } from "./errors";
import { GitHubService } from "./service";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type IssueInfo = {
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

type IssueListItem = {
  number: number;
  title: string;
  state: string;
  url: string;
  labels: Array<{ name: string }>;
  createdAt: string;
};

type RawIssueComment = {
  id: number;
  user: { login: string };
  body: string;
  created_at: string;
  html_url: string;
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const listIssues = Effect.fn("issue.listIssues")(function* (opts: {
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

const viewIssue = Effect.fn("issue.viewIssue")(function* (issueNumber: number) {
  const gh = yield* GitHubService;

  return yield* gh.runGhJson<IssueInfo>([
    "issue",
    "view",
    String(issueNumber),
    "--json",
    "number,title,state,url,labels,assignees,author,createdAt,closedAt",
  ]);
});

const closeIssue = Effect.fn("issue.closeIssue")(function* (opts: {
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

const reopenIssue = Effect.fn("issue.reopenIssue")(function* (opts: {
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

const commentOnIssue = Effect.fn("issue.commentOnIssue")(function* (opts: {
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

const editIssue = Effect.fn("issue.editIssue")(function* (opts: {
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

// ---------------------------------------------------------------------------
// CLI Commands
// ---------------------------------------------------------------------------

export const issueListCommand = Command.make(
  "list",
  {
    format: formatOption,
    labels: Flag.string("labels").pipe(
      Flag.withDescription("Filter by label (comma-separated)"),
      Flag.optional,
    ),
    limit: Flag.integer("limit").pipe(
      Flag.withDescription("Maximum number of issues to return"),
      Flag.withDefault(30),
    ),
    state: Flag.choice("state", ["open", "closed", "all"]).pipe(
      Flag.withDescription("Filter by state: open, closed, all"),
      Flag.withDefault("open"),
    ),
  },
  ({ format, labels, limit, state }) =>
    Effect.gen(function* () {
      const issues = yield* listIssues({
        labels: Option.getOrNull(labels),
        limit,
        state,
      });
      yield* logFormatted(issues, format);
    }),
).pipe(Command.withDescription("List issues (default: open, use --state to filter)"));

export const issueViewCommand = Command.make(
  "view",
  {
    format: formatOption,
    issue: Flag.integer("issue").pipe(Flag.withDescription("Issue number")),
  },
  ({ format, issue }) =>
    Effect.gen(function* () {
      const info = yield* viewIssue(issue);
      yield* logFormatted(info, format);
    }),
).pipe(Command.withDescription("View issue details"));

export const issueCloseCommand = Command.make(
  "close",
  {
    comment: Flag.string("comment").pipe(
      Flag.withDescription("Comment to add when closing"),
      Flag.optional,
    ),
    format: formatOption,
    issue: Flag.integer("issue").pipe(Flag.withDescription("Issue number to close")),
    reason: Flag.choice("reason", ["completed", "not planned"]).pipe(
      Flag.withDescription("Close reason: completed, not planned"),
      Flag.withDefault("completed"),
    ),
  },
  ({ comment, format, issue, reason }) =>
    Effect.gen(function* () {
      const result = yield* closeIssue({
        comment: Option.getOrNull(comment),
        issue,
        reason,
      });
      yield* logFormatted(result, format);
    }),
).pipe(Command.withDescription("Close an issue with optional comment and reason"));

export const issueReopenCommand = Command.make(
  "reopen",
  {
    comment: Flag.string("comment").pipe(
      Flag.withDescription("Comment to add when reopening"),
      Flag.optional,
    ),
    format: formatOption,
    issue: Flag.integer("issue").pipe(Flag.withDescription("Issue number to reopen")),
  },
  ({ comment, format, issue }) =>
    Effect.gen(function* () {
      const result = yield* reopenIssue({
        comment: Option.getOrNull(comment),
        issue,
      });
      yield* logFormatted(result, format);
    }),
).pipe(Command.withDescription("Reopen a closed issue"));

export const issueCommentCommand = Command.make(
  "comment",
  {
    body: Flag.string("body").pipe(Flag.withDescription("Comment body text")),
    format: formatOption,
    issue: Flag.integer("issue").pipe(Flag.withDescription("Issue number to comment on")),
  },
  ({ body, format, issue }) =>
    Effect.gen(function* () {
      const result = yield* commentOnIssue({ body, issue });
      yield* logFormatted(result, format);
    }),
).pipe(Command.withDescription("Post a comment on an issue"));

export const issueEditCommand = Command.make(
  "edit",
  {
    addAssignee: Flag.string("add-assignee").pipe(
      Flag.withDescription("Add assignee login (comma-separated for multiple)"),
      Flag.optional,
    ),
    addLabels: Flag.string("add-labels").pipe(
      Flag.withDescription("Add labels (comma-separated)"),
      Flag.optional,
    ),
    body: Flag.string("body").pipe(Flag.withDescription("New issue body"), Flag.optional),
    format: formatOption,
    issue: Flag.integer("issue").pipe(Flag.withDescription("Issue number to edit")),
    removeAssignee: Flag.string("remove-assignee").pipe(
      Flag.withDescription("Remove assignee login (comma-separated for multiple)"),
      Flag.optional,
    ),
    removeLabels: Flag.string("remove-labels").pipe(
      Flag.withDescription("Remove labels (comma-separated)"),
      Flag.optional,
    ),
    title: Flag.string("title").pipe(Flag.withDescription("New issue title"), Flag.optional),
  },
  ({ addAssignee, addLabels, body, format, issue, removeAssignee, removeLabels, title }) =>
    Effect.gen(function* () {
      const result = yield* editIssue({
        addAssignee: Option.getOrNull(addAssignee),
        addLabels: Option.getOrNull(addLabels),
        body: Option.getOrNull(body),
        issue,
        removeAssignee: Option.getOrNull(removeAssignee),
        removeLabels: Option.getOrNull(removeLabels),
        title: Option.getOrNull(title),
      });
      yield* logFormatted(result, format);
    }),
).pipe(Command.withDescription("Edit issue title, body, labels, or assignees"));
