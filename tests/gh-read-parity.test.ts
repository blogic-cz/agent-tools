import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { createReplayGh, replayCases, replayFlags } from "./fixtures/gh-read-replay";

import { createRerunGh } from "./fixtures/gh-rerun-replay";

import { runReplayCases } from "./fixtures/gh-read-process";

it(
  "uses one cold issue-list call and zero warm calls with an explicit repository",
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "gh-read-call-trace-"));
    try {
      const trace = join(root, "calls.jsonl");
      const bun = spawnSync("bun", ["-e", "process.stdout.write(process.execPath)"], {
        encoding: "utf8",
      }).stdout;
      const { bin, preload } = await createReplayGh(root, bun, trace);
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
  },
);

it(
  "replays published 1.7.5 outputs with original review location fields without GitHub access",
  { timeout: 60000 },
  async ({ signal, onTestFinished }) => {
    const root = await mkdtemp(join(tmpdir(), "gh-read-parity-"));
    let running: Promise<void> | undefined;
    onTestFinished(async () => {
      if (running !== undefined) await Promise.allSettled([running]);
      await rm(root, { recursive: true, force: true });
    });
    const bun = spawnSync("bun", ["-e", "process.stdout.write(process.execPath)"], {
      encoding: "utf8",
    }).stdout;
    const { bin, preload } = await createReplayGh(root, bun);
    const fixture = JSON.parse(
      await readFile(new URL("./fixtures/gh-read-parity.json", import.meta.url), "utf8"),
    ) as {
      cases: { argv: string[]; stdout: string; status: number }[];
    };
    expect(fixture.cases.map((entry) => entry.argv)).toEqual(replayCases);
    running = runReplayCases({
      executable: bun,
      cases: fixture.cases.map((entry) => {
        let stdout = entry.stdout;
        if (entry.argv[0] === "pr") {
          stdout = stdout.replace(
            /^( +)"line": (null|\d+),$/gm,
            '$&\n$1"originalLine": null,\n$1"originalCommitSha": null,\n$1"diffHunk": null,',
          );
          if (["review-triage", "review-triage-batch"].includes(entry.argv[1] ?? "")) {
            stdout = stdout.replace(/^( +)"reviews": \[$/gm, '$1"checksStatus": "reported",\n$&');
          }
        }
        return {
          stdout,
          status: entry.status,
          argv: ["--preload", preload, "src/gh-tool/index.ts", ...replayFlags(entry.argv)],
        };
      }),
      options: {
        cwd: resolve(import.meta.dirname, ".."),
        encoding: "utf8",
        timeout: 15000,
        signal,
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          HOME: root,
          XDG_CONFIG_HOME: root,
          XDG_CACHE_HOME: root,
          GH_TOKEN: "offline-replay",
          GH_TOOL_CACHE: "off",
        },
      },
    });
    await running;
  },
);

it(
  "L706 preserves public GitHub login through CLI assignee and comment paths",
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "gh-public-login-"));
    try {
      const bun = spawnSync("bun", ["-e", "process.stdout.write(process.execPath)"], {
        encoding: "utf8",
      }).stdout;
      const { bin, preload } = await createReplayGh(root, bun);
      for (const argv of [
        ["issue", "edit", "--issue", "7", "--add-assignee", "fixture-operator"],
        ["pr", "comment", "--pr", "42", "--body", "Thanks @fixture-operator for reviewing."],
      ]) {
        const result = spawnSync(
          bun,
          ["--preload", preload, "src/gh-tool/index.ts", ...replayFlags(argv)],
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
              GITHUB_AUTH_USER: "fixture-operator",
            },
          },
        );
        expect({ status: result.status, stderr: result.stderr, error: result.error }).toEqual({
          status: 0,
          stderr: "",
          error: undefined,
        });
        expect(result.stdout).toContain("fixture-operator");
        expect(result.stdout).not.toContain("[REDACTED]");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

for (const [outcome, status] of [
  ["success", 0],
  ["failure", 1],
  ["pending", 124],
] as const) {
  it(`R8-18 CLI exits ${status} for watched ${outcome}`, { timeout: 15000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "gh-rerun-exit-"));
    try {
      const bun = spawnSync("bun", ["-e", "process.stdout.write(process.execPath)"], {
        encoding: "utf8",
      }).stdout;
      const bin = await createRerunGh(root, bun, outcome);
      const result = spawnSync(
        bun,
        [
          "src/gh-tool/index.ts",
          "pr",
          "rerun-checks",
          "--pr",
          "42",
          "--failed-only",
          "false",
          "--watch",
          "--timeout",
          "1",
          "--format",
          "json",
        ],
        {
          cwd: resolve(import.meta.dirname, ".."),
          encoding: "utf8",
          timeout: 10000,
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
      expect(result.status).toBe(status);
      const report = JSON.parse(result.stdout);
      expect(report.runs[0].latestAttempt).toMatchObject({
        attempt: 2,
        status: outcome === "pending" ? "in_progress" : "completed",
        conclusion: outcome === "pending" ? null : outcome,
      });
      if (outcome === "pending") expect(result.stderr).toContain("timed out");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
