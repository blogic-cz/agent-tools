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
    const hint = (error as Record<string, unknown>).hint;
    const nextCommand = (error as Record<string, unknown>).nextCommand;
    let result = "";
    if (typeof message === "string") {
      result = `${tag}: ${message}`;
    } else {
      const details = Object.entries(error as Record<string, unknown>)
        .filter(
          ([key, val]) =>
            typeof val === "string" && key !== "_tag" && key !== "hint" && key !== "nextCommand",
        )
        .map(([key, val]) => `${key}=${String(val)}`)
        .join(", ");
      result = details ? `${tag}: ${details}` : tag;
    }
    if (typeof hint === "string") {
      result += `\n  Hint: ${hint}`;
    }
    // Surface the exact corrective invocation that tagged errors already carry — without this
    // the affordance is computed everywhere and shown nowhere.
    if (typeof nextCommand === "string" && nextCommand.length > 0) {
      result += `\n  Try: ${nextCommand}`;
    }
    return result;
  }
  if (error instanceof Error) return error.message;
  return String(error);
};

const formatCause = (cause: Cause.Cause<unknown>): string => {
  const firstFailure = cause.reasons.find(Cause.isFailReason);
  if (firstFailure !== undefined) return formatError(firstFailure.error);

  const firstDefect = cause.reasons.find(Cause.isDieReason);
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
