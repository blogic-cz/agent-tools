import { Schema } from "effect";

export class K8sContextError extends Schema.TaggedError<K8sContextError>()("K8sContextError", {
  message: Schema.String,
  clusterId: Schema.String,
}) {}

export class K8sCommandError extends Schema.TaggedError<K8sCommandError>()("K8sCommandError", {
  message: Schema.String,
  command: Schema.String,
  exitCode: Schema.optional(Schema.Number),
  stderr: Schema.optional(Schema.String),
}) {}

export class K8sTimeoutError extends Schema.TaggedError<K8sTimeoutError>()("K8sTimeoutError", {
  message: Schema.String,
  command: Schema.String,
  timeoutMs: Schema.Number,
}) {}

export type K8sError = K8sContextError | K8sCommandError | K8sTimeoutError;
