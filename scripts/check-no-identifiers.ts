import { findPrivacyLeak } from "./guard-privacy";
import { identifierMatches } from "./guard-identifiers";

const DEFAULT_FILES = [
  "tests/fixtures/credential-guard-corpus-v2.jsonl",
  "tests/fixtures/credential-guard-regressions.jsonl",
  "tests/credential-guard.test.ts",
  "src/credential-guard/index.ts",
];

function isDocumentationIp(value: string): boolean {
  const [a, b, c] = value.split(".").map(Number);
  return (
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function findGenericLeak(text: string): string | null {
  if (/[A-Z0-9._%+-]{2,}@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)) return "email address";
  if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i.test(text))
    return "uuid";
  if (/\b(?:gh[ps]_|github_pat_)[A-Za-z0-9_]{20,}/.test(text)) return "github token shape";
  if (/^\s*[A-Z][A-Z0-9_]{2,}=[^\s]+\s*$/m.test(text)) return "environment dump";
  const ticket = text.match(/\b[A-Z]{2,}-\d+\b/g)?.find((value) => !value.startsWith("PROJ-"));
  if (ticket) return "ticket key";
  const ipv4 = text
    .match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)
    ?.find((value) => !isDocumentationIp(value));
  if (ipv4) return "non-documentation IPv4 address";

  const allowedHosts = new Set([
    "api.github.com",
    "dev.azure.com",
    "discord.com",
    "discordapp.com",
    "downloads.example.com",
    "example.com",
    "github.com",
    "hooks.slack.com",
    "localhost",
  ]);
  for (const match of text.matchAll(/https?:\/\/([^/\s"'`]+)/gi)) {
    const host =
      (match[1] ?? "")
        .replace(/[\\'`]+$/g, "")
        .split(":")[0]
        ?.toLowerCase() ?? "";
    if (
      host !== "" &&
      !allowedHosts.has(host) &&
      !host.endsWith(".example.com") &&
      !host.endsWith(".test") &&
      !host.endsWith(".invalid")
    ) {
      return "non-example domain";
    }
  }
  return null;
}

async function readInputs(): Promise<Array<{ name: string; text: string }>> {
  const args = Bun.argv.slice(2);
  if (args[0] === "--file" && args[1])
    return [{ name: args[1], text: await Bun.file(args[1]).text() }];
  if (args[0] === "--diff-range" && args[1]) {
    const proc = Bun.spawn(["git", "diff", "--no-ext-diff", args[1]], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const diff = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) throw new Error("git diff failed");
    const text = diff
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1))
      .join("\n");
    return [{ name: `git diff ${args[1]} additions`, text }];
  }
  const tracked = Bun.spawn(["git", "ls-files", "--stage", "-z"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const names = (await new Response(tracked.stdout).text()).split("\0").filter(Boolean);
  if ((await tracked.exited) !== 0) throw new Error("git ls-files failed");
  const files = new Map(
    names.map((entry) => [entry.split("\t")[1] ?? "", entry.startsWith("120000 ")]),
  );
  for (const name of [...DEFAULT_FILES, "scripts/guard-privacy.ts"]) files.set(name, false);
  return Promise.all(
    [...files].map(async ([name, symlink]) => {
      if (!symlink) return { name, text: await Bun.file(name).text() };
      const link = Bun.spawn(["git", "show", `:${name}`], { stdout: "pipe", stderr: "pipe" });
      const text = await new Response(link.stdout).text();
      if ((await link.exited) !== 0) throw new Error("git show symlink failed");
      return { name, text };
    }),
  );
}

const leaks: string[] = [];
for (const input of await readInputs()) {
  if (["LICENSE", "skills-lock.json"].includes(input.name)) continue;
  const generic =
    findPrivacyLeak(input.name, input.text) ??
    (DEFAULT_FILES.includes(input.name) || input.name.startsWith("tests/fixtures/credential-guard")
      ? findGenericLeak(input.text)
      : null);
  if (generic) leaks.push(`${input.name}: ${generic}`);
  const decoded: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === "string") decoded.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  if (input.name.endsWith(".jsonl"))
    input.text
      .trim()
      .split("\n")
      .filter(Boolean)
      .forEach((line) => collect(JSON.parse(line)));
  else if (input.name.startsWith("tests/fixtures/") && input.name.endsWith(".json"))
    collect(JSON.parse(input.text));
  if (decoded.some((text) => findPrivacyLeak(input.name, text)))
    leaks.push(`${input.name}: encoded private identifier`);
  const allowedHashes = new Set<string>();
  const testData = /(?:^|\/)tests\//.test(input.name) || /\.test\.[cm]?[jt]sx?$/.test(input.name);
  if (!testData)
    allowedHashes.add("4dda1082d2b2192c119ffce35838f45225a95f01e223c9e2d70c3779d2d81c6c");
  if (input.name === "src/az-tool/security.ts")
    allowedHashes.add("d0960501f8971be812f2e5494426e08cdbb2cbc3b3190ba60075f14b8da7178a");
  if ([input.text, ...decoded].some((text) => identifierMatches(text, allowedHashes).length > 0))
    leaks.push(`${input.name}: hashed identifier denylist`);
}

if (leaks.length > 0) {
  console.error(leaks.join("\n"));
  process.exit(1);
}

console.log("identifier scan: 0 findings");
