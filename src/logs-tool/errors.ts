import { Schema } from "effect";

export class LogsNotFoundError extends Schema.TaggedErrorClass<LogsNotFoundError>()(
  "LogsNotFoundError",
  {
    message: Schema.String,
    path: Schema.String,
    hint: Schema.optionalKey(Schema.String),
    nextCommand: Schema.optionalKey(Schema.String),
    retryable: Schema.optionalKey(Schema.Boolean),
  },
) {}

export class LogsReadError extends Schema.TaggedErrorClass<LogsReadError>()("LogsReadError", {
  message: Schema.String,
  source: Schema.String,
  hint: Schema.optionalKey(Schema.String),
  nextCommand: Schema.optionalKey(Schema.String),
  retryable: Schema.optionalKey(Schema.Boolean),
}) {}

export class LogsConfigError extends Schema.TaggedErrorClass<LogsConfigError>()("LogsConfigError", {
  message: Schema.String,
  hint: Schema.optionalKey(Schema.String),
  nextCommand: Schema.optionalKey(Schema.String),
  retryable: Schema.optionalKey(Schema.Boolean),
}) {}

export class LogsTimeoutError extends Schema.TaggedErrorClass<LogsTimeoutError>()(
  "LogsTimeoutError",
  {
    message: Schema.String,
    source: Schema.String,
    timeoutMs: Schema.Number,
    hint: Schema.optionalKey(Schema.String),
    nextCommand: Schema.optionalKey(Schema.String),
    retryable: Schema.optionalKey(Schema.Boolean),
  },
) {}

export type LogsError = LogsNotFoundError | LogsReadError | LogsConfigError | LogsTimeoutError;
