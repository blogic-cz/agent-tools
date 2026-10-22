import { createHash } from "node:crypto";
import baseVerdicts from "./fixtures/credential-guard-corpus-v2.base.json";
import exceptions from "./fixtures/credential-guard-corpus-v2.exceptions.json";
import { readFile } from "node:fs/promises";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { createCredentialGuard } from "#guard";
import { corpusConfig } from "../scripts/guard-corpus-support";
import baseline from "./fixtures/credential-guard-corpus-v2.baseline.json";

const rowSchema = Schema.Struct({
  id: Schema.String,
  command: Schema.String,
  tool: Schema.Literals(["bash", "powershell"]),
  label: Schema.Literals(["must-refuse", "benign"]),
  category: Schema.optionalKey(
    Schema.Literals([
      "env-read",
      "secret-file",
      "ambient-expansion",
      "hidden-code",
      "inline-runtime",
      "keychain",
      "process-env",
      "wrapper-bypass",
      "other",
    ]),
  ),
  origin: Schema.Literals(["blocked", "allowed", "synthetic"]),
  review: Schema.Struct({
    by: Schema.Array(Schema.String),
    note: Schema.optionalKey(Schema.String),
  }),
});
const rows = (
  await readFile(new URL("./fixtures/credential-guard-corpus-v2.jsonl", import.meta.url), "utf8")
)
  .trim()
  .split("\n")
  .map((line) => Schema.decodeUnknownSync(rowSchema)(JSON.parse(line)));

it("keeps both corpus verdict sets equal to the reviewed baseline", () => {
  const guard = createCredentialGuard(corpusConfig);
  const prior = Schema.decodeUnknownSync(
    Schema.Record(
      Schema.String,
      Schema.Struct({ commandHash: Schema.String, refused: Schema.Boolean }),
    ),
  )(baseVerdicts.rows);
  const baseRegressions: string[] = [];
  const mustRefusePassing: string[] = [];
  const benignRefused: string[] = [];
  for (const row of rows) {
    let refused = false;
    try {
      guard.handleToolExecuteBefore(
        { tool: row.tool === "powershell" ? "PowerShell" : "Bash" },
        { args: { command: row.command } },
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !/Command blocked|Direct .* usage blocked|Sleep-polling detected/.test(error.message)
      )
        throw error;
      refused = true;
    }
    if (row.label === "must-refuse" && !refused) mustRefusePassing.push(row.id);
    const base = prior[row.id];
    expect(base?.commandHash).toBe(
      createHash("sha256")
        .update(row.tool + "\0" + row.command)
        .digest("hex"),
    );
    if (row.label === "benign" && refused) {
      benignRefused.push(row.id);
      if (!base?.refused) baseRegressions.push(row.id);
    }
  }
  mustRefusePassing.sort();
  benignRefused.sort();
  console.log(
    JSON.stringify({
      rows: rows.length,
      mustRefusePassing: mustRefusePassing.length,
      benignRefused: benignRefused.length,
    }),
  );
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((row) => row.origin === "synthetic")).toBe(true);
  expect(baseVerdicts.revision).toBe("d93e77a");
  expect(Object.keys(prior).sort()).toEqual(rows.map((row) => row.id).sort());
  expect(baseRegressions.sort()).toEqual(exceptions.map((item) => item.id).sort());
  expect(exceptions.every((item) => item.reason.length > 20)).toBe(true);
  expect(mustRefusePassing).toEqual([]);
  expect(baseline.mustRefusePassing).toEqual([]);
  for (const command of [
    "for f in .env; do cat $f; done",
    'herdr agent prompt c "$(env)"',
    "jq -n '$ENV'",
    "jq -n env",
    "python3 -m py_compile .env",
    "timeout 5 env",
    "npx -c env",
    "xargs printenv",
  ]) {
    expect(rows.some((row) => row.command === command && row.label === "must-refuse")).toBe(true);
  }
  expect(
    rows
      .filter(
        (row) =>
          row.label === "must-refuse" ||
          (row.origin === "blocked" && /env|secret|token|password|key/i.test(row.command)),
      )
      .every((row) => row.review.by.includes("rules") && row.review.by.includes("guard-corpus")),
  ).toBe(true);
  expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
  expect({
    mustRefusePassing,
    benignRefused,
    counts: { mustRefusePassing: mustRefusePassing.length, benignRefused: benignRefused.length },
  }).toEqual(baseline);
}, 60_000);
