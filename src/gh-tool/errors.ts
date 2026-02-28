import { Schema } from "effect";

export class GitHubCommandError extends Schema.TaggedError<GitHubCommandError>()(
  "GitHubCommandError",
  {
    message: Schema.String,
    command: Schema.String,
    exitCode: Schema.Number,
    stderr: Schema.String,
  },
) {}

export class GitHubNotFoundError extends Schema.TaggedError<GitHubNotFoundError>()(
  "GitHubNotFoundError",
  {
    message: Schema.String,
    identifier: Schema.String,
    resource: Schema.String,
  },
) {}

export class GitHubAuthError extends Schema.TaggedError<GitHubAuthError>()("GitHubAuthError", {
  message: Schema.String,
}) {}

export class GitHubMergeError extends Schema.TaggedError<GitHubMergeError>()("GitHubMergeError", {
  message: Schema.String,
  reason: Schema.Literal("conflicts", "checks_failing", "branch_protected", "unknown"),
}) {}

export class GitHubTimeoutError extends Schema.TaggedError<GitHubTimeoutError>()(
  "GitHubTimeoutError",
  {
    message: Schema.String,
    timeoutMs: Schema.Number,
  },
) {}

export type GitHubServiceError =
  | GitHubCommandError
  | GitHubNotFoundError
  | GitHubAuthError
  | GitHubMergeError
  | GitHubTimeoutError;
