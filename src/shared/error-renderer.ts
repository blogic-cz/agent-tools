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
  const failures = Cause.failures(cause);
  const firstFailure = Array.from(failures)[0];
  if (firstFailure !== undefined) return formatError(firstFailure);

  const defects = Cause.defects(cause);
  const firstDefect = Array.from(defects)[0];
  if (firstDefect !== undefined) {
    if (firstDefect instanceof Error) return `Unexpected error: ${firstDefect.message}`;
    return `Unexpected error: ${String(firstDefect)}`;
  }

  if (Cause.isInterruptedOnly(cause)) return "Interrupted";
  return "Unknown error";
};

export const renderCauseToStderr = (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
  Console.error(formatCause(cause));
