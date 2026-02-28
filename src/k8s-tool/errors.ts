import { Schema } from "effect";

export class K8sContextError extends Schema.TaggedErrorClass<K8sContextError>()("K8sContextError", {
  message: Schema.String,
  clusterId: Schema.String,
}) {}

export class K8sCommandError extends Schema.TaggedErrorClass<K8sCommandError>()("K8sCommandError", {
  message: Schema.String,
  command: Schema.String,
  exitCode: Schema.optionalKey(Schema.Number),
  stderr: Schema.optionalKey(Schema.String),
}) {}

export class K8sTimeoutError extends Schema.TaggedErrorClass<K8sTimeoutError>()("K8sTimeoutError", {
  message: Schema.String,
  command: Schema.String,
  timeoutMs: Schema.Number,
}) {}

export type K8sError = K8sContextError | K8sCommandError | K8sTimeoutError;
