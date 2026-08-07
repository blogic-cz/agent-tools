import { Schema } from "effect";

export class DbConnectionError extends Schema.TaggedError<DbConnectionError>()(
  "DbConnectionError",
  {
    message: Schema.String,
    environment: Schema.String,
    hint: Schema.optionalKey(Schema.String),
    nextCommand: Schema.optionalKey(Schema.String),
    retryable: Schema.optionalKey(Schema.Boolean),
  },
) {}

export class DbQueryError extends Schema.TaggedError<DbQueryError>()("DbQueryError", {
  message: Schema.String,
  sql: Schema.String,
  stderr: Schema.optionalKey(Schema.String),
  hint: Schema.optionalKey(Schema.String),
  nextCommand: Schema.optionalKey(Schema.String),
  retryable: Schema.optionalKey(Schema.Boolean),
}) {}

export class DbTunnelError extends Schema.TaggedError<DbTunnelError>()("DbTunnelError", {
  message: Schema.String,
  port: Schema.Number,
  hint: Schema.optionalKey(Schema.String),
  nextCommand: Schema.optionalKey(Schema.String),
  retryable: Schema.optionalKey(Schema.Boolean),
}) {}

export class DbMutationBlockedError extends Schema.TaggedError<DbMutationBlockedError>()(
  "DbMutationBlockedError",
  {
    message: Schema.String,
    environment: Schema.String,
    hint: Schema.optionalKey(Schema.String),
    nextCommand: Schema.optionalKey(Schema.String),
    retryable: Schema.optionalKey(Schema.Boolean),
  },
) {}

export type DbError = DbConnectionError | DbMutationBlockedError | DbQueryError | DbTunnelError;
