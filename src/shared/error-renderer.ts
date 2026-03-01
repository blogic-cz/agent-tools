import type { Effect } from "effect";

import { Cause, Console } from "effect";

const formatError = (error: unknown): string => {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof (error as Record<string, unknown>)._tag === "string"
  ) {
    const tag = (error as Record<string, unknown>)._tag as string;
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return `${tag}: ${message}`;
    const details = Object.entries(error as Record<string, unknown>)
      .filter(([key, val]) => typeof val === "string" && key !== "_tag")
      .map(([key, val]) => `${key}=${String(val)}`)
      .join(", ");
    return details ? `${tag}: ${details}` : tag;
  }
  if (error instanceof Error) return error.message;
  return String(error);
};

const formatCause = (cause: Cause.Cause<unknown>): string => {
  const failures = cause.reasons.filter(Cause.isFailReason);
  const firstFailure = failures[0];
  if (firstFailure !== undefined) return formatError(firstFailure.error);

  const defects = cause.reasons.filter(Cause.isDieReason);
  const firstDefect = defects[0];
  if (firstDefect !== undefined) {
    if (firstDefect.defect instanceof Error)
      return `Unexpected error: ${firstDefect.defect.message}`;
    return `Unexpected error: ${String(firstDefect.defect)}`;
  }

  if (Cause.hasInterruptsOnly(cause)) return "Interrupted";
  return "Unknown error";
};

export const renderCauseToStderr = (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
  Console.error(formatCause(cause));
