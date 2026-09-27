import { Flag } from "effect/unstable/cli";
import { decode as decodeToon, encode as encodeToon } from "@toon-format/toon";
import { Effect } from "effect";

import { redactSensitiveText, redactSensitiveValue } from "./content-security";
import type { BaseResult, OutputFormat } from "./types";

export const formatOption = Flag.Literals("format", ["toon", "json"]).pipe(
  Flag.withDescription("Output format: toon (default, token-efficient) or json"),
  Flag.withDefault("toon"),
);

export function formatOutput<T extends BaseResult>(result: T, format: OutputFormat): string {
  if (format === "toon") {
    return encodeToon(redactSensitiveValue(result));
  }
  return JSON.stringify(redactSensitiveValue(result), null, 2);
}

export function formatAny<T>(data: T, format: OutputFormat): string {
  if (format === "toon") {
    return encodeToon(redactSensitiveValue(data));
  }
  return JSON.stringify(redactSensitiveValue(data), null, 2);
}

const redactOutputText = (text: string) => {
  let json: unknown;
  let isJson = false;
  try {
    json = JSON.parse(text);
    isJson = true;
  } catch {
    // Try structured TOON below before treating this as plain text.
  }
  if (isJson) {
    return (
      JSON.stringify(redactSensitiveValue(json), null, text.includes("\n") ? 2 : undefined) ??
      "null"
    );
  }

  let toon: unknown;
  try {
    toon = decodeToon(text);
  } catch {
    // Raw logs and status strings are not structured output.
  }
  if (toon !== null && typeof toon === "object") return encodeToon(redactSensitiveValue(toon));
  return redactSensitiveText(text);
};

// `Console.log` drops bytes on a non-blocking pipe: a payload over the pipe buffer arrives
// truncated at a page boundary, reaching the caller as invalid JSON. Awaiting the write callback
// makes the stream retry the short write. Never replace this with `Console.log`.
// EPIPE is the expected end of `<tool> | head`, so only other write failures become defects
// instead of a silent exit 0 with partial output.
export const logText = (text: string) =>
  Effect.callback<undefined>((resume) => {
    process.stdout.write(`${redactOutputText(text)}\n`, (error) =>
      resume(
        error && (error as NodeJS.ErrnoException).code !== "EPIPE"
          ? Effect.die(error)
          : Effect.succeed(undefined),
      ),
    );
  });

export const logFormatted = <T>(data: T, format: OutputFormat) => logText(formatAny(data, format));
