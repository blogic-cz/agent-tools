import { Flag } from "effect/unstable/cli";
import { encode as encodeToon } from "@toon-format/toon";
import { Effect } from "effect";

import type { BaseResult, OutputFormat } from "./types";

export const formatOption = Flag.choice("format", ["toon", "json"]).pipe(
  Flag.withDescription("Output format: toon (default, token-efficient) or json"),
  Flag.withDefault("toon"),
);

export function formatOutput<T extends BaseResult>(result: T, format: OutputFormat): string {
  if (format === "toon") {
    return encodeToon(result);
  }
  return JSON.stringify(result, null, 2);
}

export function formatAny<T>(data: T, format: OutputFormat): string {
  if (format === "toon") {
    return encodeToon(data);
  }
  return JSON.stringify(data, null, 2);
}

// `Console.log` drops bytes on a non-blocking pipe: a payload over the pipe buffer arrives
// truncated at a page boundary, reaching the caller as invalid JSON. Awaiting the write callback
// makes the stream retry the short write. Never replace this with `Console.log`.
// EPIPE is the expected end of `<tool> | head`, so only other write failures become defects
// instead of a silent exit 0 with partial output.
export const logText = (text: string) =>
  Effect.callback<undefined>((resume) => {
    process.stdout.write(`${text}\n`, (error) =>
      resume(
        error && (error as NodeJS.ErrnoException).code !== "EPIPE"
          ? Effect.die(error)
          : Effect.succeed(undefined),
      ),
    );
  });

export const logFormatted = <T>(data: T, format: OutputFormat) => logText(formatAny(data, format));
