import { Command, Flag } from "effect/unstable/cli";
import { Effect, Option } from "effect";

import { formatOption, logFormatted } from "#shared";

import { closeIssue, commentOnIssue, editIssue, listIssues, reopenIssue, viewIssue } from "./core";

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
