import { Schema } from "effect";

export class AzSecurityError extends Schema.TaggedErrorClass<AzSecurityError>()("AzSecurityError", {
  message: Schema.String,
  command: Schema.String,
}) {}

export class AzCommandError extends Schema.TaggedErrorClass<AzCommandError>()("AzCommandError", {
  message: Schema.String,
  command: Schema.String,
  exitCode: Schema.optionalKey(Schema.Number),
  stderr: Schema.optionalKey(Schema.String),
}) {}

export class AzTimeoutError extends Schema.TaggedErrorClass<AzTimeoutError>()("AzTimeoutError", {
  message: Schema.String,
  command: Schema.String,
  timeoutMs: Schema.Number,
}) {}

export class AzParseError extends Schema.TaggedErrorClass<AzParseError>()("AzParseError", {
  message: Schema.String,
  rawOutput: Schema.String,
}) {}

export type AzError = AzSecurityError | AzCommandError | AzTimeoutError | AzParseError;
