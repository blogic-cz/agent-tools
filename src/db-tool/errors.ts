import { Schema } from "effect";

export class DbConnectionError extends Schema.TaggedErrorClass<DbConnectionError>()(
  "DbConnectionError",
  {
    message: Schema.String,
    environment: Schema.String,
    hint: Schema.optionalKey(Schema.String),
    nextCommand: Schema.optionalKey(Schema.String),
    retryable: Schema.optionalKey(Schema.Boolean),
  },
) {}

export class DbQueryError extends Schema.TaggedErrorClass<DbQueryError>()("DbQueryError", {
  message: Schema.String,
  sql: Schema.String,
  stderr: Schema.optionalKey(Schema.String),
  hint: Schema.optionalKey(Schema.String),
  nextCommand: Schema.optionalKey(Schema.String),
  retryable: Schema.optionalKey(Schema.Boolean),
}) {}

export class DbTunnelError extends Schema.TaggedErrorClass<DbTunnelError>()("DbTunnelError", {
  message: Schema.String,
  port: Schema.Number,
  hint: Schema.optionalKey(Schema.String),
  nextCommand: Schema.optionalKey(Schema.String),
  retryable: Schema.optionalKey(Schema.Boolean),
}) {}

export class DbParseError extends Schema.TaggedErrorClass<DbParseError>()("DbParseError", {
  message: Schema.String,
  rawOutput: Schema.String,
  hint: Schema.optionalKey(Schema.String),
  nextCommand: Schema.optionalKey(Schema.String),
  retryable: Schema.optionalKey(Schema.Boolean),
}) {}

export class DbMutationBlockedError extends Schema.TaggedErrorClass<DbMutationBlockedError>()(
  "DbMutationBlockedError",
  {
    message: Schema.String,
    environment: Schema.String,
    hint: Schema.optionalKey(Schema.String),
    nextCommand: Schema.optionalKey(Schema.String),
    retryable: Schema.optionalKey(Schema.Boolean),
  },
) {}

export type DbError =
  | DbConnectionError
  | DbMutationBlockedError
  | DbParseError
  | DbQueryError
  | DbTunnelError;
