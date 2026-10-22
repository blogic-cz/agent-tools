import { createHash } from "node:crypto";
import { Schema } from "effect";
import { createCredentialGuard } from "#guard";
import { baseFixtureSchema, corpusConfig, parseCorpus, verdict } from "./guard-corpus-support";

const path = process.env.AGENT_TOOLS_PRIVATE_GUARD_CORPUS;
if (!path) {
  console.log("AGENT_TOOLS_PRIVATE_GUARD_CORPUS is unset; private corpus check skipped.");
} else {
  const rows = parseCorpus(await Bun.file(path).text());
  const basePath = path.replace(/\.jsonl$/, ".base.json");
  const base = Schema.decodeUnknownSync(baseFixtureSchema)(await Bun.file(basePath).json());
  const exceptionsPath = path.replace(/\.jsonl$/, ".exceptions.json");
  const exceptions = Schema.decodeUnknownSync(
    Schema.Array(Schema.Struct({ id: Schema.String, reason: Schema.String })),
  )(await Bun.file(exceptionsPath).json());
  const approved = new Set(
    exceptions.filter((entry) => entry.reason.length > 20).map((entry) => entry.id),
  );
  const guard = createCredentialGuard(corpusConfig);
  const mustRefusePassing: string[] = [];
  const benignRefused: string[] = [];
  const basePassNowRefused: string[] = [];
  for (const row of rows) {
    const prior = base.rows[row.id];
    const commandHash = createHash("sha256")
      .update(row.tool + "\0" + row.command)
      .digest("hex");
    if (!prior || prior.commandHash !== commandHash)
      throw new Error(`Missing or stale base verdict for ${row.id}`);
    const refused = verdict(guard, row);
    if (row.label === "must-refuse" && !refused) mustRefusePassing.push(row.id);
    if (row.label === "benign" && refused) {
      benignRefused.push(row.id);
      if (!prior.refused) basePassNowRefused.push(row.id);
    }
  }
  console.log(
    JSON.stringify(
      {
        rows: rows.length,
        errors: 0,
        mustRefusePassing,
        benignRefused,
        basePassNowRefused,
        unapprovedRegressions: basePassNowRefused.filter((id) => !approved.has(id)),
        staleExceptions: [...approved].filter((id) => !basePassNowRefused.includes(id)),
        counts: {
          mustRefusePassing: mustRefusePassing.length,
          benignRefused: benignRefused.length,
          basePassNowRefused: basePassNowRefused.length,
        },
      },
      null,
      2,
    ),
  );
  if (
    mustRefusePassing.length ||
    basePassNowRefused.some((id) => !approved.has(id)) ||
    [...approved].some((id) => !basePassNowRefused.includes(id))
  )
    process.exitCode = 1;
}
