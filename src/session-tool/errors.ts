import { Schema } from "effect";

export class SessionStorageNotFoundError extends Schema.TaggedErrorClass<SessionStorageNotFoundError>()(
  "SessionStorageNotFoundError",
  {
    message: Schema.String,
    path: Schema.String,
  },
) {}

export class SessionReadError extends Schema.TaggedErrorClass<SessionReadError>()(
  "SessionReadError",
  {
    message: Schema.String,
    source: Schema.String,
  },
) {}

export class SessionConfigError extends Schema.TaggedErrorClass<SessionConfigError>()(
  "SessionConfigError",
  {
    message: Schema.String,
  },
) {}

export class SessionParseError extends Schema.TaggedErrorClass<SessionParseError>()(
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
