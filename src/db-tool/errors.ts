import { Schema } from "effect";

export class DbConnectionError extends Schema.TaggedErrorClass<DbConnectionError>()(
  "DbConnectionError",
  {
    message: Schema.String,
    environment: Schema.String,
  },
) {}

export class DbQueryError extends Schema.TaggedErrorClass<DbQueryError>()("DbQueryError", {
  message: Schema.String,
  sql: Schema.String,
  stderr: Schema.optionalKey(Schema.String),
}) {}

export class DbTunnelError extends Schema.TaggedErrorClass<DbTunnelError>()("DbTunnelError", {
  message: Schema.String,
  port: Schema.Number,
}) {}

export class DbParseError extends Schema.TaggedErrorClass<DbParseError>()("DbParseError", {
  message: Schema.String,
  rawOutput: Schema.String,
}) {}

export class DbMutationBlockedError extends Schema.TaggedErrorClass<DbMutationBlockedError>()(
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
