import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createReplayGh, replayCases, replayFlags } from "./gh-read-replay";

const packageMetadata = JSON.parse(
  await readFile(new URL("../../package.json", import.meta.url), "utf8"),
) as { name: string };
const baseline = process.argv[2];
if (baseline === undefined)
  throw new Error("Pass an installed published 1.7.5 src/gh-tool/index.ts path");
const metadata = JSON.parse(
  await readFile(join(dirname(dirname(dirname(resolve(baseline)))), "package.json"), "utf8"),
) as { name: string; version: string };
if (metadata.name !== packageMetadata.name || metadata.version !== "1.7.5")
  throw new Error("Baseline must be published agent-tools 1.7.5");

const root = await mkdtemp(join(tmpdir(), "gh-read-record-"));
try {
  const node = spawnSync("which", ["node"], { encoding: "utf8" }).stdout.trim();
  const { bin, preload } = await createReplayGh(root, node);
  const cases = replayCases.map((argv) => {
    const result = spawnSync("bun", ["--preload", preload, baseline, ...replayFlags(argv)], {
      encoding: "utf8",
      timeout: 20000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env["PATH"]}`,
        HOME: root,
        XDG_CONFIG_HOME: root,
        XDG_CACHE_HOME: root,
        GH_TOKEN: "offline-replay",
        GITHUB_TOKEN: "offline-replay",
        GH_TOOL_CACHE: "off",
      },
    });
    if (result.error || result.status !== 0)
      throw new Error(`${argv.join(" ")}: ${result.error ?? result.stderr}`);
    return { argv, stdout: result.stdout, status: result.status };
  });
  await writeFile(
    "tests/fixtures/gh-read-parity.json",
    JSON.stringify({ baseline: "agent-tools@1.7.5", cases }, null, 2) + "\n",
  );
  console.log(`Recorded ${cases.length} offline baseline outputs.`);
} finally {
  await rm(root, { recursive: true, force: true });
}
