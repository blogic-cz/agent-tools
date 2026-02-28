import { Schema } from "effect";

export class GitHubCommandError extends Schema.TaggedErrorClass<GitHubCommandError>()(
  "GitHubCommandError",
  {
    message: Schema.String,
    command: Schema.String,
    exitCode: Schema.Number,
    stderr: Schema.String,
  },
) {}

export class GitHubNotFoundError extends Schema.TaggedErrorClass<GitHubNotFoundError>()(
  "GitHubNotFoundError",
  {
    message: Schema.String,
    identifier: Schema.String,
    resource: Schema.String,
  },
) {}

export class GitHubAuthError extends Schema.TaggedErrorClass<GitHubAuthError>()("GitHubAuthError", {
  message: Schema.String,
}) {}

export class GitHubMergeError extends Schema.TaggedErrorClass<GitHubMergeError>()(
  "GitHubMergeError",
  {
    message: Schema.String,
    reason: Schema.Literals(["conflicts", "checks_failing", "branch_protected", "unknown"]),
  },
) {}

export class GitHubTimeoutError extends Schema.TaggedErrorClass<GitHubTimeoutError>()(
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
