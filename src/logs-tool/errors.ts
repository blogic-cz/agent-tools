import { Schema } from "effect";

export class LogsNotFoundError extends Schema.TaggedError<LogsNotFoundError>()(
  "LogsNotFoundError",
  {
    message: Schema.String,
    path: Schema.String,
    hint: Schema.optionalKey(Schema.String),
    nextCommand: Schema.optionalKey(Schema.String),
    retryable: Schema.optionalKey(Schema.Boolean),
  },
) {}

export class LogsReadError extends Schema.TaggedError<LogsReadError>()("LogsReadError", {
  message: Schema.String,
  source: Schema.String,
  hint: Schema.optionalKey(Schema.String),
  nextCommand: Schema.optionalKey(Schema.String),
  retryable: Schema.optionalKey(Schema.Boolean),
}) {}

export class LogsConfigError extends Schema.TaggedError<LogsConfigError>()("LogsConfigError", {
  message: Schema.String,
  hint: Schema.optionalKey(Schema.String),
  nextCommand: Schema.optionalKey(Schema.String),
  retryable: Schema.optionalKey(Schema.Boolean),
}) {}

export class LogsTimeoutError extends Schema.TaggedError<LogsTimeoutError>()("LogsTimeoutError", {
  message: Schema.String,
  source: Schema.String,
  timeoutMs: Schema.Number,
  hint: Schema.optionalKey(Schema.String),
  nextCommand: Schema.optionalKey(Schema.String),
  retryable: Schema.optionalKey(Schema.Boolean),
}) {}

export type LogsError = LogsNotFoundError | LogsReadError | LogsConfigError | LogsTimeoutError;
