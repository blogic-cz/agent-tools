import { Schema } from "effect";
import type { createCredentialGuard } from "#guard";

export const corpusConfig = {
  allowedEnvironmentVariables: [
    "HERDR_PANE_ID",
    "HERDR_ENV",
    "HERDR_WORKSPACE_ID",
    "HERDR_TAB_ID",
    "TMPDIR",
    "TMP",
    "TEMP",
    "CODEX_SESSION_ID",
  ],
  additionalBlockedPaths: ["appsettings\\..*\\.local\\.json$"],
  additionalAllowedPaths: ["apps/example/.env.prod", "apps/example/.env.test"],
  additionalBlockedCliTools: [
    { tool: "argocd", suggestion: "Use bun run argo-tool for read-only inspection." },
    { tool: "vault", suggestion: "Use bun run vault-tool for redacted, read-only inspection." },
  ],
};
const rowSchema = Schema.Struct({
  id: Schema.String,
  command: Schema.String,
  tool: Schema.Literals(["bash", "powershell"]),
  label: Schema.Literals(["must-refuse", "benign"]),
  origin: Schema.Literals(["blocked", "allowed", "synthetic"]),
});
export type CorpusRow = typeof rowSchema.Type;
export function parseCorpus(text: string): readonly CorpusRow[] {
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => Schema.decodeUnknownSync(rowSchema)(JSON.parse(line)));
}
export function verdict(guard: ReturnType<typeof createCredentialGuard>, row: CorpusRow): boolean {
  try {
    guard.handleToolExecuteBefore({ tool: row.tool }, { args: { command: row.command } });
    return false;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !/Command blocked|Direct .* usage blocked|Sleep-polling detected/.test(error.message)
    )
      throw error;
    return true;
  }
}
export const baseFixtureSchema = Schema.Struct({
  revision: Schema.Literal("d93e77a"),
  rows: Schema.Record(
    Schema.String,
    Schema.Struct({ commandHash: Schema.String, refused: Schema.Boolean }),
  ),
});
