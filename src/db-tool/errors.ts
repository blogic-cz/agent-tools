import { Schema } from "effect";

export class DbConnectionError extends Schema.TaggedError<DbConnectionError>()(
  "DbConnectionError",
  {
    message: Schema.String,
    environment: Schema.String,
  },
) {}

export class DbQueryError extends Schema.TaggedError<DbQueryError>()("DbQueryError", {
  message: Schema.String,
  sql: Schema.String,
  stderr: Schema.optional(Schema.String),
}) {}

export class DbTunnelError extends Schema.TaggedError<DbTunnelError>()("DbTunnelError", {
  message: Schema.String,
  port: Schema.Number,
}) {}

export class DbParseError extends Schema.TaggedError<DbParseError>()("DbParseError", {
  message: Schema.String,
  rawOutput: Schema.String,
}) {}

export class DbMutationBlockedError extends Schema.TaggedError<DbMutationBlockedError>()(
  "DbMutationBlockedError",
  {
    message: Schema.String,
    environment: Schema.String,
  },
) {}

export type DbError =
  | DbConnectionError
  | DbMutationBlockedError
  | DbParseError
  | DbQueryError
  | DbTunnelError;
