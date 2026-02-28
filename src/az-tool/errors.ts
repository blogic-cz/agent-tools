import { Schema } from "effect";

export class AzSecurityError extends Schema.TaggedError<AzSecurityError>()("AzSecurityError", {
  message: Schema.String,
  command: Schema.String,
}) {}

export class AzCommandError extends Schema.TaggedError<AzCommandError>()("AzCommandError", {
  message: Schema.String,
  command: Schema.String,
  exitCode: Schema.optional(Schema.Number),
  stderr: Schema.optional(Schema.String),
}) {}

export class AzTimeoutError extends Schema.TaggedError<AzTimeoutError>()("AzTimeoutError", {
  message: Schema.String,
  command: Schema.String,
  timeoutMs: Schema.Number,
}) {}

export class AzParseError extends Schema.TaggedError<AzParseError>()("AzParseError", {
  message: Schema.String,
  rawOutput: Schema.String,
}) {}

export type AzError = AzSecurityError | AzCommandError | AzTimeoutError | AzParseError;
