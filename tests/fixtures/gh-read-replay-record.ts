import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReplayGh, replayCases } from "./gh-read-replay";

const root = await mkdtemp(join(tmpdir(), "gh-read-record-"));
try {
  const node = spawnSync("which", ["node"], { encoding: "utf8" }).stdout.trim();
  const bin = await createReplayGh(root, node);
  const cases = replayCases.map((argv) => {
    const result = spawnSync(
      "bunx",
      [
        "--package",
        "@blogic-cz/agent-tools@1.7.5",
        "agent-tools-gh",
        ...argv,
        "--repo",
        "owner/repo",
        "--format",
        "json",
      ],
      {
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
      },
    );
    if (result.error || result.status !== 0)
      throw new Error(`${argv.join(" ")}: ${result.error ?? result.stderr}`);
    return { argv, stdout: result.stdout, status: result.status };
  });
  await writeFile(
    "tests/fixtures/gh-read-parity.json",
    JSON.stringify({ baseline: "@blogic-cz/agent-tools@1.7.5", cases }, null, 2) + "\n",
  );
  console.log(`Recorded ${cases.length} offline baseline outputs.`);
} finally {
  await rm(root, { recursive: true, force: true });
}
