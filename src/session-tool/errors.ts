import { Schema } from "effect";

export class SessionStorageNotFoundError extends Schema.TaggedError<SessionStorageNotFoundError>()(
  "SessionStorageNotFoundError",
  {
    message: Schema.String,
    path: Schema.String,
  },
) {}

export class SessionReadError extends Schema.TaggedError<SessionReadError>()("SessionReadError", {
  message: Schema.String,
  source: Schema.String,
}) {}

export class SessionConfigError extends Schema.TaggedError<SessionConfigError>()(
  "SessionConfigError",
  {
    message: Schema.String,
  },
) {}

export class SessionParseError extends Schema.TaggedError<SessionParseError>()(
  "SessionParseError",
  {
    message: Schema.String,
    source: Schema.String,
  },
) {}

export type SessionError =
  | SessionReadError
  | SessionStorageNotFoundError
  | SessionConfigError
  | SessionParseError;
