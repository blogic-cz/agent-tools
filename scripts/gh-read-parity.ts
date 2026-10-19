import { createHash } from "node:crypto";
import { ghEnvironment } from "#gh/environment";

const argument = (name: string): string | undefined => {
  const index = Bun.argv.indexOf(name);
  return index === -1 ? undefined : Bun.argv[index + 1];
};
const repo = argument("--repo");
const run = argument("--run");
const job = argument("--job");
const pr = argument("--pr");
const issue = argument("--issue");
const release = argument("--release");
const gist = argument("--gist");
const only = argument("--only");
if (
  repo === undefined ||
  (run === undefined &&
    pr === undefined &&
    issue === undefined &&
    release === undefined &&
    gist === undefined)
)
  throw new Error(
    "Usage: bun scripts/gh-read-parity.ts --repo owner/name [--run ID --job NAME] [--pr N] [--issue N]",
  );
const cases = [
  ["repo", "info"],
  ["repo", "list", "--org", repo.split("/")[0] ?? "", "--limit", "1"],
  [
    "repo",
    "search-code",
    "--org",
    repo.split("/")[0] ?? "",
    "--query",
    `repo:${repo} example`,
    "--limit",
    "1",
  ],
  ["release", "list", "--limit", "1"],
  ["release", "status"],
  ...(release === undefined ? [] : [["release", "view", "--tag", release]]),
  ...(gist === undefined
    ? []
    : [
        ["gist", "list", "--limit", "1"],
        ["gist", "view", "--id", gist],
      ]),
  ...(run === undefined || job === undefined
    ? []
    : [
        ["workflow", "list", "--status", "completed", "--limit", "1"],
        ["workflow", "view", "--run", run],
        ["workflow", "jobs", "--run", run],
        ["workflow", "logs", "--run", run],
        ["workflow", "job-logs", "--run", run, "--job", job],
        ["workflow", "annotations", "--run", run],
        ["workflow", "watch", "--run", run, "--timeout", "1"],
      ]),
  ...(pr === undefined
    ? []
    : [
        ["pr", "view", "--pr", pr],
        ["pr", "list", "--search", `is:pr ${pr}`, "--state", "all"],
        ["pr", "checks", "--prs", pr],
        ["pr", "checks-failed", "--pr", pr],
        ...[
          "threads",
          "comments",
          "reviews",
          "last-human-reviewer",
          "feedback",
          "issue-comments",
          "issue-comments-latest",
          "discussion-summary",
          "review-triage",
        ].map((command) => ["pr", command, "--pr", pr]),
        ["pr", "review-triage-batch", "--prs", pr],
        ["pr", "stack", "view", "--pr", pr],
      ]),
  ...(issue === undefined
    ? []
    : [
        ["issue", "view", "--issue", issue],
        ["issue", "list", "--state", "all", "--limit", "1"],
        ["issue", "comments", "--issue", issue],
        ["issue", "triage", "--issue", issue, "--verbosity", "full"],
        ["issue", "snapshot-batch", "--issues", issue],
      ]),
];
const environment = {
  ...ghEnvironment(),
  ...(process.env["GH_TOOL_CACHE_DIR"] === undefined
    ? {}
    : { GH_TOOL_CACHE_DIR: process.env["GH_TOOL_CACHE_DIR"] }),
};
const execute = async (prefix: string[], argv: string[]) => {
  const child = Bun.spawn(
    [
      ...prefix,
      ...argv,
      ...(argv[0] === "gist" || (argv[0] === "repo" && argv[1] !== "info") ? [] : ["--repo", repo]),
      "--format",
      "json",
    ],
    {
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const firstResponseId = (stdout: string): unknown => {
  try {
    const value = JSON.parse(stdout);
    return Array.isArray(value) ? (value[0]?.databaseId ?? value[0]?.number ?? null) : null;
  } catch {
    return null;
  }
};
const compare = async (argv: string[]) => {
  const baseline = await execute(
    ["bunx", "--package", "@blogic-cz/agent-tools@1.7.5", "agent-tools-gh"],
    argv,
  );
  const current = await execute(["bun", "src/gh-tool/index.ts"], argv);
  const equal = baseline.exitCode === current.exitCode && baseline.stdout === current.stdout;
  console.log(
    JSON.stringify({
      command: argv.slice(0, 2).join(" "),
      equal,
      baselineExit: baseline.exitCode,
      currentExit: current.exitCode,
      baselineBytes: Buffer.byteLength(baseline.stdout),
      currentBytes: Buffer.byteLength(current.stdout),
      baselineHash: hash(baseline.stdout),
      currentHash: hash(current.stdout),
      baselineFirstId: firstResponseId(baseline.stdout),
      currentFirstId: firstResponseId(current.stdout),
      ...(equal
        ? {}
        : {
            baselineStdout: baseline.stdout,
            currentStdout: current.stdout,
            baselineStderr: baseline.stderr,
            currentStderr: current.stderr,
          }),
    }),
  );
  if (!equal || baseline.exitCode !== 0) process.exitCode = 1;
};
const selected =
  only === undefined
    ? cases
    : cases.filter((argv) => argv[0] === only || argv.slice(0, 2).join(" ") === only);
await selected.reduce((previous, argv) => previous.then(() => compare(argv)), Promise.resolve());
