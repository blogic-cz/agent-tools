import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const MERGED_HEAD = "3e49e95c3dae6bba9236d2c43d2cb30c40478d30";
const OPEN_HEAD = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c";

it(
  "pr checks --prs marks a PR whose checks gh did not report instead of returning an empty list",
  { timeout: 20000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "gh-checks-batch-cli-"));
    try {
      const bin = join(root, "bin");
      await mkdir(bin);
      const gh = join(bin, "gh");
      await writeFile(
        gh,
        `#!${process.execPath}
const args = process.argv.slice(2);
const pr = args[2];
if (args[0] === "repo" && args[1] === "view") {
  console.log(JSON.stringify({ owner: { login: "test-owner" }, name: "test-repo", defaultBranchRef: { name: "main" }, url: "https://github.com/test-owner/test-repo" }));
} else if (args[0] === "pr" && args[1] === "view") {
  console.log(JSON.stringify(pr === "1396"
    ? { state: "MERGED", headRefOid: "${MERGED_HEAD}" }
    : { state: "OPEN", headRefOid: "${OPEN_HEAD}" }));
} else if (args[0] === "pr" && args[1] === "checks" && pr === "1396") {
  console.error("no checks reported on the 'feat/merged' branch");
  process.exitCode = 1;
} else if (args[0] === "pr" && args[1] === "checks") {
  console.log(JSON.stringify([{ name: "Build and Test", state: "SUCCESS", bucket: "pass", link: "external" }]));
} else {
  console.error("unsupported offline fixture command");
  process.exitCode = 1;
}
`,
      );
      await chmod(gh, 0o755);
      const bun = spawnSync("bun", ["-e", "process.stdout.write(process.execPath)"], {
        encoding: "utf8",
      }).stdout;
      const result = spawnSync(
        bun,
        [
          "src/gh-tool/index.ts",
          "pr",
          "checks",
          "--prs",
          "1396,949",
          "--format",
          "json",
          "--repo",
          "test-owner/test-repo",
        ],
        {
          cwd: resolve(import.meta.dirname, ".."),
          encoding: "utf8",
          timeout: 15000,
          env: {
            PATH: bin + ":/usr/bin:/bin",
            HOME: root,
            XDG_CONFIG_HOME: root,
            XDG_CACHE_HOME: root,
            GH_TOKEN: "synthetic-offline-token",
          },
        },
      );
      expect(result.error).toBeUndefined();
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toEqual({
        count: 2,
        prs: [
          {
            pr: 1396,
            state: "MERGED",
            headSha: MERGED_HEAD,
            checksStatus: "none_reported",
            reason:
              "gh reported no checks for this head. Checks may not be registered yet, the PR may have no CI, or GitHub returned an empty rollup. This is not a CI verdict.",
            checks: null,
          },
          {
            pr: 949,
            state: "OPEN",
            headSha: OPEN_HEAD,
            checksStatus: "reported",
            checks: [
              { name: "Build and Test", state: "SUCCESS", bucket: "pass", link: "external" },
            ],
          },
        ],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
