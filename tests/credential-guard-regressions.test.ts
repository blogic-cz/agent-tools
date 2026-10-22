import { readFile } from "node:fs/promises";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { createCredentialGuard } from "#guard";

const configSchema = Schema.Struct({
  allowedEnvironmentVariables: Schema.optionalKey(Schema.Array(Schema.String)),
  additionalBlockedPaths: Schema.optionalKey(Schema.Array(Schema.String)),
  additionalAllowedPaths: Schema.optionalKey(Schema.Array(Schema.String)),
  additionalDangerousBashPatterns: Schema.optionalKey(Schema.Array(Schema.String)),
  additionalBlockedCliTools: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        tool: Schema.String,
        suggestion: Schema.String,
      }),
    ),
  ),
});
const rowSchema = Schema.Struct({
  id: Schema.String,
  command: Schema.String,
  config: configSchema,
  refuse: Schema.Boolean,
  methods: Schema.Array(Schema.Literals(["hook", "dangerous"])),
});
const rows = (
  await readFile(new URL("./fixtures/credential-guard-regressions.jsonl", import.meta.url), "utf8")
)
  .trim()
  .split("\n")
  .map((line) => Schema.decodeUnknownSync(rowSchema)(JSON.parse(line)));

it.each(rows)("preserves reviewed old decision $id", (row) => {
  const guard = createCredentialGuard({
    allowedEnvironmentVariables: row.config.allowedEnvironmentVariables?.slice(),
    additionalBlockedPaths: row.config.additionalBlockedPaths?.slice(),
    additionalAllowedPaths: row.config.additionalAllowedPaths?.slice(),
    additionalDangerousBashPatterns: row.config.additionalDangerousBashPatterns?.slice(),
    additionalBlockedCliTools: row.config.additionalBlockedCliTools?.slice(),
  });
  for (const method of row.methods) {
    let refused = false;
    if (method === "dangerous") refused = guard.isDangerousBashCommand(row.command);
    else {
      try {
        guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command: row.command } });
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !/Command blocked|Sleep-polling detected/.test(error.message)
        )
          throw error;
        refused = true;
      }
    }
    expect(refused, `${method}: ${row.command.slice(0, 200)}`).toBe(row.refuse);
  }
});
