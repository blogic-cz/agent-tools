import { Schema } from "effect";

export class AzdoSecurityError extends Schema.TaggedError<AzdoSecurityError>()(
  "AzdoSecurityError",
  {
    message: Schema.String,
    command: Schema.String,
    hint: Schema.optionalKey(Schema.String),
    nextCommand: Schema.optionalKey(Schema.String),
    retryable: Schema.optionalKey(Schema.Boolean),
  },
) {}

export class AzdoCommandError extends Schema.TaggedError<AzdoCommandError>()("AzdoCommandError", {
  message: Schema.String,
  command: Schema.String,
  exitCode: Schema.optionalKey(Schema.Number),
  stderr: Schema.optionalKey(Schema.String),
  hint: Schema.optionalKey(Schema.String),
  nextCommand: Schema.optionalKey(Schema.String),
  retryable: Schema.optionalKey(Schema.Boolean),
}) {}

export class AzdoTimeoutError extends Schema.TaggedError<AzdoTimeoutError>()("AzdoTimeoutError", {
  message: Schema.String,
  command: Schema.String,
  timeoutMs: Schema.Number,
  hint: Schema.optionalKey(Schema.String),
  nextCommand: Schema.optionalKey(Schema.String),
  retryable: Schema.optionalKey(Schema.Boolean),
}) {}

export class AzdoParseError extends Schema.TaggedError<AzdoParseError>()("AzdoParseError", {
  message: Schema.String,
  rawOutput: Schema.String,
  hint: Schema.optionalKey(Schema.String),
  nextCommand: Schema.optionalKey(Schema.String),
  retryable: Schema.optionalKey(Schema.Boolean),
}) {}

export type AzdoError = AzdoSecurityError | AzdoCommandError | AzdoTimeoutError | AzdoParseError;
