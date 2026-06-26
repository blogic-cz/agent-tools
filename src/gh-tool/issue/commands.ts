import { Command, Flag } from "effect/unstable/cli";
import { Effect, Option } from "effect";

import { formatOption, logFormatted } from "#shared";
import { resolveOptionalTextInput, resolveRequiredTextInput } from "#gh/text-input";

import {
  closeIssue,
  commentOnIssue,
  editIssue,
  fetchIssueComments,
  listIssues,
  reopenIssue,
  viewIssue,
} from "./core";
import { GitHubService } from "#gh/service";

const repoOption = Flag.string("repo").pipe(
  Flag.withDescription("Target repository profile name or owner/name"),
  Flag.optional,
);

const withRepo = <A, E, R>(repo: Option.Option<string>, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const gh = yield* GitHubService;
    return yield* gh.withRepoTarget(Option.getOrNull(repo), effect);
  });

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
    repo: repoOption,
    state: Flag.choice("state", ["open", "closed", "all"]).pipe(
      Flag.withDescription("Filter by state: open, closed, all"),
      Flag.withDefault("open"),
    ),
  },
  ({ format, labels, limit, repo, state }) =>
    withRepo(
      repo,
      Effect.gen(function* () {
        const issues = yield* listIssues({
          labels: Option.getOrNull(labels),
          limit,
          state,
        });
        yield* logFormatted(issues, format);
      }),
    ),
).pipe(Command.withDescription("List issues (default: open, use --state to filter)"));

export const issueViewCommand = Command.make(
  "view",
  {
    format: formatOption,
    issue: Flag.integer("issue").pipe(Flag.withDescription("Issue number")),
    repo: repoOption,
  },
  ({ format, issue, repo }) =>
    withRepo(
      repo,
      Effect.gen(function* () {
        const info = yield* viewIssue(issue);
        yield* logFormatted(info, format);
      }),
    ),
).pipe(
  Command.withDescription(
    "View one issue's details. For multiple issues use `gh issue snapshot-batch --issues 1,2,3` (one call, not N).",
  ),
);

export const issueCommentsCommand = Command.make(
  "comments",
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
    issue: Flag.integer("issue").pipe(Flag.withDescription("Issue number")),
    repo: repoOption,
    since: Flag.string("since").pipe(
      Flag.withDescription("ISO timestamp to filter comments created after"),
      Flag.optional,
    ),
  },
  ({ author, bodyContains, format, issue, repo, since }) =>
    withRepo(
      repo,
      Effect.gen(function* () {
        const comments = yield* fetchIssueComments(
          issue,
          Option.getOrNull(since),
          Option.getOrNull(author),
          Option.getOrNull(bodyContains),
        );
        yield* logFormatted(comments, format);
      }),
    ),
).pipe(Command.withDescription("Fetch issue discussion comments"));

export const issueCloseCommand = Command.make(
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
    format: formatOption,
    issue: Flag.integer("issue").pipe(Flag.withDescription("Issue number to close")),
    repo: repoOption,
    reason: Flag.choice("reason", ["completed", "not planned"]).pipe(
      Flag.withDescription("Close reason: completed, not planned"),
      Flag.withDefault("completed"),
    ),
  },
  ({ comment, commentFile, format, issue, reason, repo }) =>
    withRepo(
      repo,
      Effect.gen(function* () {
        const resolvedComment = yield* resolveOptionalTextInput({
          command: "gh-tool issue close",
          value: Option.getOrNull(comment),
          fileValue: Option.getOrNull(commentFile),
          valueFlag: "--comment",
          fileFlag: "--comment-file",
          label: "comment",
        });

        const result = yield* closeIssue({
          comment: resolvedComment,
          issue,
          reason,
        });
        yield* logFormatted(result, format);
      }),
    ),
).pipe(Command.withDescription("Close an issue with optional comment and reason"));

export const issueReopenCommand = Command.make(
  "reopen",
  {
    comment: Flag.string("comment").pipe(
      Flag.withDescription("Comment to add when reopening"),
      Flag.optional,
    ),
    commentFile: Flag.string("comment-file").pipe(
      Flag.withDescription("Read reopen comment from a file path or '-' for stdin"),
      Flag.optional,
    ),
    format: formatOption,
    issue: Flag.integer("issue").pipe(Flag.withDescription("Issue number to reopen")),
    repo: repoOption,
  },
  ({ comment, commentFile, format, issue, repo }) =>
    withRepo(
      repo,
      Effect.gen(function* () {
        const resolvedComment = yield* resolveOptionalTextInput({
          command: "gh-tool issue reopen",
          value: Option.getOrNull(comment),
          fileValue: Option.getOrNull(commentFile),
          valueFlag: "--comment",
          fileFlag: "--comment-file",
          label: "comment",
        });

        const result = yield* reopenIssue({
          comment: resolvedComment,
          issue,
        });
        yield* logFormatted(result, format);
      }),
    ),
).pipe(Command.withDescription("Reopen a closed issue"));

export const issueCommentCommand = Command.make(
  "comment",
  {
    body: Flag.string("body").pipe(Flag.withDescription("Comment body text"), Flag.optional),
    bodyFile: Flag.string("body-file").pipe(
      Flag.withDescription("Read comment body from a file path or '-' for stdin"),
      Flag.optional,
    ),
    format: formatOption,
    issue: Flag.integer("issue").pipe(Flag.withDescription("Issue number to comment on")),
    repo: repoOption,
  },
  ({ body, bodyFile, format, issue, repo }) =>
    withRepo(
      repo,
      Effect.gen(function* () {
        const resolvedBody = yield* resolveRequiredTextInput({
          command: "gh-tool issue comment",
          value: Option.getOrNull(body),
          fileValue: Option.getOrNull(bodyFile),
          valueFlag: "--body",
          fileFlag: "--body-file",
          label: "body",
        });

        const result = yield* commentOnIssue({ body: resolvedBody, issue });
        yield* logFormatted(result, format);
      }),
    ),
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
    bodyFile: Flag.string("body-file").pipe(
      Flag.withDescription("Read issue body from a file path or '-' for stdin"),
      Flag.optional,
    ),
    format: formatOption,
    issue: Flag.integer("issue").pipe(Flag.withDescription("Issue number to edit")),
    repo: repoOption,
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
  ({
    addAssignee,
    addLabels,
    body,
    bodyFile,
    format,
    issue,
    removeAssignee,
    removeLabels,
    repo,
    title,
  }) =>
    withRepo(
      repo,
      Effect.gen(function* () {
        const resolvedBody = yield* resolveOptionalTextInput({
          command: "gh-tool issue edit",
          value: Option.getOrNull(body),
          fileValue: Option.getOrNull(bodyFile),
          valueFlag: "--body",
          fileFlag: "--body-file",
          label: "body",
        });

        const result = yield* editIssue({
          addAssignee: Option.getOrNull(addAssignee),
          addLabels: Option.getOrNull(addLabels),
          body: resolvedBody,
          issue,
          removeAssignee: Option.getOrNull(removeAssignee),
          removeLabels: Option.getOrNull(removeLabels),
          title: Option.getOrNull(title),
        });
        yield* logFormatted(result, format);
      }),
    ),
).pipe(Command.withDescription("Edit issue title, body, labels, or assignees"));
