import { Schema } from "effect";

export class AzSecurityError extends Schema.TaggedErrorClass<AzSecurityError>()("AzSecurityError", {
  message: Schema.String,
  command: Schema.String,
  hint: Schema.optionalKey(Schema.String),
  nextCommand: Schema.optionalKey(Schema.String),
  retryable: Schema.optionalKey(Schema.Boolean),
}) {}

export class AzCommandError extends Schema.TaggedErrorClass<AzCommandError>()("AzCommandError", {
  message: Schema.String,
  command: Schema.String,
  exitCode: Schema.optional(Schema.Number),
  stderr: Schema.optional(Schema.String),
  hint: Schema.optionalKey(Schema.String),
  nextCommand: Schema.optionalKey(Schema.String),
  retryable: Schema.optionalKey(Schema.Boolean),
}) {}

export class AzTimeoutError extends Schema.TaggedErrorClass<AzTimeoutError>()("AzTimeoutError", {
  message: Schema.String,
  command: Schema.String,
  timeoutMs: Schema.Number,
  hint: Schema.optionalKey(Schema.String),
  nextCommand: Schema.optionalKey(Schema.String),
  retryable: Schema.optionalKey(Schema.Boolean),
}) {}

export class AzParseError extends Schema.TaggedErrorClass<AzParseError>()("AzParseError", {
  message: Schema.String,
  rawOutput: Schema.String,
  hint: Schema.optionalKey(Schema.String),
  nextCommand: Schema.optionalKey(Schema.String),
  retryable: Schema.optionalKey(Schema.Boolean),
}) {}

export type AzError = AzSecurityError | AzCommandError | AzTimeoutError | AzParseError;
