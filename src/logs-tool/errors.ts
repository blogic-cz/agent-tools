import { Schema } from "effect";

export class LogsNotFoundError extends Schema.TaggedError<LogsNotFoundError>()(
  "LogsNotFoundError",
  {
    message: Schema.String,
    path: Schema.String,
  },
) {}

export class LogsReadError extends Schema.TaggedError<LogsReadError>()("LogsReadError", {
  message: Schema.String,
  source: Schema.String,
}) {}

export type LogsError = LogsNotFoundError | LogsReadError;
