import { Schema } from "effect";

export const ErrorCode = Schema.Literals([
  "CONFIG_INVALID",
  "CREDENTIAL_UNAVAILABLE",
  "UNAUTHORIZED",
  "POLICY_DENIED",
  "BUDGET_EXHAUSTED",
  "DESTINATION_DENIED",
  "UPSTREAM_FAILED",
  "LIMIT_EXCEEDED",
  "DEADLINE_EXCEEDED",
  "DISCLOSURE_DENIED",
  "GRANT_ALREADY_USED",
  "GRANT_STORE_UNAVAILABLE",
]);
export class ApiError extends Schema.TaggedError<ApiError>()("ApiError", {
  code: ErrorCode,
  message: Schema.String,
  hint: Schema.String,
}) {}
export type ErrorCode = typeof ErrorCode.Type;
const hints: Record<ErrorCode, string> = {
  CONFIG_INVALID: "Ask the operator to validate configuration and protected file permissions.",
  CREDENTIAL_UNAVAILABLE: "Ask the operator to provision the profile credential.",
  UNAUTHORIZED: "Obtain a valid unexpired caller grant from the operator.",
  POLICY_DENIED: "Use an operator-approved profile, method and relative path.",
  BUDGET_EXHAUSTED: "Ask the operator for a new grant with an appropriate budget.",
  DESTINATION_DENIED: "Ask the operator to approve the exact HTTPS destination and addresses.",
  UPSTREAM_FAILED: "Check the approved service with the operator. No upstream details are exposed.",
  LIMIT_EXCEEDED: "Reduce request or response size within the configured limits.",
  DEADLINE_EXCEEDED: "The bounded request deadline expired.",
  DISCLOSURE_DENIED: "The response cannot be disclosed under this profile.",
  GRANT_STORE_UNAVAILABLE:
    "Restore protected durable grant storage. Retain existing markers and issue fresh grants after a failed startup.",
  GRANT_ALREADY_USED: "Generate fresh caller grants before restarting. Retain grant-use markers.",
};
export const apiError = (code: ErrorCode): ApiError =>
  new ApiError({ code, message: code, hint: hints[code] });
export const safeError = (error: unknown): ApiError =>
  error instanceof ApiError ? apiError(error.code) : apiError("UPSTREAM_FAILED");
