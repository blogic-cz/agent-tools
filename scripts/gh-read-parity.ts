import { createHash } from "node:crypto";
import { ghEnvironment } from "#gh/environment";

const argument = (name: string): string | undefined => {
  const index = Bun.argv.indexOf(name);
  return index === -1 ? undefined : Bun.argv[index + 1];
};
const repo = argument("--repo");
const run = argument("--run");
const job = argument("--job");
if (repo === undefined || run === undefined || job === undefined)
  throw new Error("Usage: bun scripts/gh-read-parity.ts --repo owner/name --run ID --job NAME");
const cases = [
  ["workflow", "list", "--status", "completed", "--limit", "1"],
  ["workflow", "view", "--run", run],
  ["workflow", "jobs", "--run", run],
  ["workflow", "logs", "--run", run],
  ["workflow", "job-logs", "--run", run, "--job", job],
  ["workflow", "annotations", "--run", run],
  ["workflow", "watch", "--run", run, "--timeout", "1"],
];
const environment = {
  ...ghEnvironment(),
  ...(process.env["GH_TOOL_CACHE_DIR"] === undefined
    ? {}
    : { GH_TOOL_CACHE_DIR: process.env["GH_TOOL_CACHE_DIR"] }),
};
const execute = async (prefix: string[], argv: string[]) => {
  const child = Bun.spawn([...prefix, ...argv, "--repo", repo, "--format", "json"], {
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
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
    }),
  );
  if (!equal || baseline.exitCode !== 0) process.exitCode = 1;
};
await cases.reduce((previous, argv) => previous.then(() => compare(argv)), Promise.resolve());
