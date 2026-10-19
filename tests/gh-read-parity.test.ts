import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { createReplayGh, replayCases, replayFlags } from "./fixtures/gh-read-replay";

it("uses one cold issue-list call and zero warm calls with an explicit repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "gh-read-call-trace-"));
  try {
    const trace = join(root, "calls.jsonl");
    const { bin, preload } = await createReplayGh(root, process.execPath, trace);
    const bun = spawnSync("bun", ["-e", "process.stdout.write(process.execPath)"], {
      encoding: "utf8",
    }).stdout;
    const run = () =>
      spawnSync(
        bun,
        ["--preload", preload, "src/gh-tool/index.ts", ...replayFlags(["issue", "list"])],
        {
          cwd: resolve(import.meta.dirname, ".."),
          encoding: "utf8",
          timeout: 15000,
          env: {
            PATH: `${bin}:/usr/bin:/bin`,
            HOME: root,
            GH_TOKEN: "offline-replay",
            GH_TOOL_CACHE_DIR: root,
          },
        },
      );
    const cold = run();
    expect({ status: cold.status, stderr: cold.stderr, error: cold.error }).toEqual({
      status: 0,
      stderr: "",
      error: undefined,
    });
    const coldTrace = (await readFile(trace, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(coldTrace.map((args) => args.slice(0, 2))).toEqual([["issue", "list"]]);
    const warm = run();
    expect({
      status: warm.status,
      stderr: warm.stderr,
      stdout: warm.stdout,
      error: warm.error,
    }).toEqual({ status: 0, stderr: "", stdout: cold.stdout, error: undefined });
    expect((await readFile(trace, "utf8")).trim().split("\n")).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it(
  "replays published 1.7.5 command outputs without GitHub access",
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "gh-read-parity-"));
    try {
      const { bin, preload } = await createReplayGh(root, process.execPath);
      const bun = spawnSync("bun", ["-e", "process.stdout.write(process.execPath)"], {
        encoding: "utf8",
      }).stdout;
      const fixture = JSON.parse(
        await readFile(new URL("./fixtures/gh-read-parity.json", import.meta.url), "utf8"),
      ) as {
        cases: { argv: string[]; stdout: string; status: number }[];
      };
      expect(fixture.cases.map((entry) => entry.argv)).toEqual(replayCases);
      for (const entry of fixture.cases) {
        const result = spawnSync(
          bun,
          ["--preload", preload, "src/gh-tool/index.ts", ...replayFlags(entry.argv)],
          {
            cwd: resolve(import.meta.dirname, ".."),
            encoding: "utf8",
            timeout: 15000,
            env: {
              PATH: `${bin}:/usr/bin:/bin`,
              HOME: root,
              XDG_CONFIG_HOME: root,
              XDG_CACHE_HOME: root,
              GH_TOKEN: "offline-replay",
              GH_TOOL_CACHE: "off",
            },
          },
        );
        expect(result.error).toBeUndefined();
        expect({ status: result.status, stderr: result.stderr }).toEqual({
          status: entry.status,
          stderr: "",
        });
        expect({ argv: entry.argv, stdout: result.stdout }).toEqual({
          argv: entry.argv,
          stdout: entry.stdout,
        });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
