import { Flag } from "effect/unstable/cli";
import { encode as encodeToon } from "@toon-format/toon";
import { Console } from "effect";

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

export const logFormatted = <T>(data: T, format: OutputFormat) =>
  Console.log(formatAny(data, format));
