import { Schema } from "effect";

export class GitHubCommandError extends Schema.TaggedErrorClass<GitHubCommandError>()(
  "GitHubCommandError",
  {
    message: Schema.String,
    command: Schema.String,
    exitCode: Schema.Number,
    stderr: Schema.String,
    hint: Schema.optionalKey(Schema.String),
    nextCommand: Schema.optionalKey(Schema.String),
    retryable: Schema.optionalKey(Schema.Boolean),
  },
) {}

export class GitHubNotFoundError extends Schema.TaggedErrorClass<GitHubNotFoundError>()(
  "GitHubNotFoundError",
  {
    message: Schema.String,
    identifier: Schema.String,
    resource: Schema.String,
    hint: Schema.optionalKey(Schema.String),
    nextCommand: Schema.optionalKey(Schema.String),
    retryable: Schema.optionalKey(Schema.Boolean),
  },
) {}

export class GitHubAuthError extends Schema.TaggedErrorClass<GitHubAuthError>()("GitHubAuthError", {
  message: Schema.String,
  hint: Schema.optionalKey(Schema.String),
  nextCommand: Schema.optionalKey(Schema.String),
  retryable: Schema.optionalKey(Schema.Boolean),
}) {}

export class GitHubMergeError extends Schema.TaggedErrorClass<GitHubMergeError>()(
  "GitHubMergeError",
  {
    message: Schema.String,
    reason: Schema.Literals(["conflicts", "checks_failing", "branch_protected", "unknown"]),
    hint: Schema.optionalKey(Schema.String),
    nextCommand: Schema.optionalKey(Schema.String),
    retryable: Schema.optionalKey(Schema.Boolean),
  },
) {}

export class GitHubTimeoutError extends Schema.TaggedErrorClass<GitHubTimeoutError>()(
  "GitHubTimeoutError",
  {
    message: Schema.String,
    timeoutMs: Schema.Number,
    hint: Schema.optionalKey(Schema.String),
    nextCommand: Schema.optionalKey(Schema.String),
    retryable: Schema.optionalKey(Schema.Boolean),
  },
) {}

export type GitHubServiceError =
  | GitHubCommandError
  | GitHubNotFoundError
  | GitHubAuthError
  | GitHubMergeError
  | GitHubTimeoutError;
