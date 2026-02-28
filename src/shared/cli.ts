import { parseArgs } from "node:util";

import type { OutputFormat } from "./types";

export const commonArgOptions = {
  help: {
    type: "boolean" as const,
    short: "h",
    default: false,
  },
  format: {
    type: "string" as const,
    short: "f",
    default: "toon",
  },
} as const;

export function parseCommonArgs(): {
  format: OutputFormat;
  args: string[];
} | null {
  const args = Bun.argv.slice(2);

  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    return null;
  }

  const { values } = parseArgs({
    args,
    options: commonArgOptions,
    strict: false,
    allowPositionals: true,
  });

  const format = values.format === "json" || values.format === "toon" ? values.format : "toon";

  return { format, args };
}
