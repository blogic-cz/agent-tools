import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

for (const command of ["watch", "checks"]) {
  it(
    `pr ${command} exits 124 with a pending count at the deadline`,
    { timeout: 20000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "gh-watch-cli-"));
      try {
        const bin = join(root, "bin");
        await mkdir(bin);
        const gh = join(bin, "gh");
        await writeFile(
          gh,
          `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "repo" && args[1] === "view") {
  console.log(JSON.stringify({ owner: { login: "test-owner" }, name: "test-repo", defaultBranchRef: { name: "main" }, url: "https://github.com/test-owner/test-repo" }));
} else if (args[0] === "pr" && args[1] === "view") {
  console.log(JSON.stringify({ number: 123, state: "OPEN", headRefOid: "fixture-head" }));
} else if (args[0] === "pr" && args[1] === "checks") {
  if (args.includes("--watch")) setTimeout(() => {}, 5000);
  else console.log(JSON.stringify([{ name: "CI", state: "IN_PROGRESS", bucket: "pending", link: "external" }]));
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
        const args =
          command === "watch"
            ? ["--prs", "123", "--interval", "120"]
            : ["--pr", "123", "--watch", "--format", "json"];
        const result = spawnSync(
          bun,
          [
            "src/gh-tool/index.ts",
            "pr",
            command,
            ...args,
            "--timeout",
            "1",
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
              GH_TOOL_CACHE: "off",
            },
          },
        );
        const output = result.stdout + result.stderr;
        expect(result.error).toBeUndefined();
        expect({ status: result.status, output }).toMatchObject({ status: 124 });
        expect(output).toMatch(/timed out[^\n]*1 pending/i);
        if (command === "checks") {
          expect(JSON.parse(result.stdout)).toEqual([
            { name: "CI", state: "IN_PROGRESS", bucket: "pending", link: "external" },
          ]);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}
