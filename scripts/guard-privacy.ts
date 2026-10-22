import { createHash } from "node:crypto";
const metadata = { name: "@blogic-cz/agent-tools" };

const organization = metadata.name.split("/")[0]?.replace(/^@/, "") ?? "";
const privateHashes = new Set<string>([
  "80c6b522acef32eca2edf464fb838dbf9d5841cbdaceea05a21fd59df9f5691e",
  "80c6b522acef32eca2edf464fb838dbf9d5841cbdaceea05a21fd59df9f5691e",

  "ff06535ac1029cca2fc2b86ac7355a7b4e0b8d839fc76b51d30833f4e1347ddc",
  "0284461565535d24447a16cc5ab6a9793971e39c4b182800dc3620402529b800",

  "f35967545f07d474ecd53ede34546185bc81dbc1da62506da3a7235919a6c90d",
  "b8415f3947f6b04f94736f899be8ef4c33f8d921f185d30017b9c0cea42085ef",
  "77d14ab0d8212c4f9e214e7739a860cfc9ad4cb321419b751b565342bff145b0",
  "21a70f5b386b6bea809f845ac15e6b23a9f8f147872aede612199d1c2476c06b",
]);

export function findPrivacyLeak(filename: string, text: string): string | null {
  if (filename === "LICENSE" || filename === "skills-lock.json") return null;
  for (const match of text.matchAll(
    /(?:[A-Za-z]:[\\/]+Users[\\/]+|\/(?:Users|home)\/|\\+Users\\+|\\+[^\\\s]+\\+[A-Za-z]\$\\+Users\\+)([\p{L}\p{N}_.-]+)/giu,
  ))
    if (!["dev", "user", "test", "x"].includes((match[1] ?? "").toLowerCase()))
      return "personal home path";
  for (const match of text.matchAll(/-Users-([\p{L}\p{N}_.]+)-/giu))
    if (!["dev", "user", "test", "x"].includes((match[1] ?? "").toLowerCase()))
      return "personal home path";
  if (/(?:^|[\s/"'`])bp\//m.test(text)) return "personal directory layout";
  if (/\bw(?![12]:)[A-Za-z0-9]+:[pt][A-Za-z0-9]+\b/.test(text))
    return "personal terminal identifier";
  for (const token of text
    .match(/[A-Za-z0-9_.@+-]+/g)
    ?.flatMap((value) => [value].concat(value.split(/[.@+-]/))) ?? []) {
    if (privateHashes.has(createHash("sha256").update(token.toLowerCase()).digest("hex")))
      return "private identifier";
  }
  if (/\bses_[A-Za-z0-9_-]{20,}\b/.test(text)) return "private session identifier";
  const fixture = /(?:^|\/)(?:tests\/|[^/]+\.test\.|fixtures\/)/.test(filename);
  if (
    !fixture &&
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(
      text
        .replaceAll("00000000-0000-0000-0000-000000000000", "")
        .replaceAll("11111111-1111-1111-1111-111111111111", ""),
    )
  )
    return "private session UUID";
  const testData =
    /(?:^|\/)tests\//.test(filename) ||
    /\.test\.[cm]?[jt]sx?$/.test(filename) ||
    ["scripts/build-guard-corpus.ts", "scripts/build-guard-base-verdicts.ts"].includes(filename);
  if (!testData) return null;
  let masked = text;
  const fixturePath = filename.replace(/\\/g, "/").includes("fixtures/");
  const test = /(?:\.test|\.spec)\.[cm]?[jt]sx?$/.test(filename);
  const escaped = metadata.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (test && !fixturePath) {
    masked = masked.replace(
      new RegExp(
        "(from\\s+|import\\s*\\(|import\\s+)[\"']" + escaped + "(?:/[A-Za-z0-9_./-]+)?[\"']",
        "g",
      ),
      "package import",
    );
  }
  return organization &&
    [organization, organization.split("-")[0] ?? organization].some((name) =>
      masked.toLowerCase().includes(name.toLowerCase()),
    )
    ? "non-generic organization"
    : null;
}
