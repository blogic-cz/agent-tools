import { Schema } from "effect";

export class LogsNotFoundError extends Schema.TaggedErrorClass<LogsNotFoundError>()(
  "LogsNotFoundError",
  {
    message: Schema.String,
    path: Schema.String,
  },
) {}

export class LogsReadError extends Schema.TaggedErrorClass<LogsReadError>()("LogsReadError", {
  message: Schema.String,
  source: Schema.String,
}) {}

export class LogsConfigError extends Schema.TaggedErrorClass<LogsConfigError>()("LogsConfigError", {
  message: Schema.String,
}) {}

export class LogsTimeoutError extends Schema.TaggedErrorClass<LogsTimeoutError>()(
  "LogsTimeoutError",
  {
    message: Schema.String,
    source: Schema.String,
    timeoutMs: Schema.Number,
  },
) {}

export type LogsError = LogsNotFoundError | LogsReadError | LogsConfigError | LogsTimeoutError;
