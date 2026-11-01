import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { Command } from "effect/cli";
import { ConfigService } from "#config";
import { mainCommand } from "#gh/main";
import { GitHubService } from "#gh/read/transport";
import { withReadCache } from "#gh/read/index";
import { withRedactedOutput } from "#shared/output-boundary";
import { createReplayGh, replayCases, replayFlags } from "./fixtures/gh-read-replay";
import { captureOutput } from "./helpers/capture-output";
import { processResultLayer } from "./helpers/process-result";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const invoke = async (argv: readonly string[], replay = createReplayGh()) => {
  vi.stubEnv("GH_TOKEN", "offline-replay");
  vi.stubEnv("GH_TOOL_CACHE", "off");
  const platform = Layer.mergeAll(
    BunServices.layer,
    processResultLayer(replay),
    Layer.succeed(ConfigService, undefined),
  );
  const services = GitHubService.layer.pipe(Layer.provideMerge(platform));
  return captureOutput(async () => {
    await Effect.runPromise(
      withRedactedOutput(
        Command.runWith(mainCommand, { version: "test", renderErrors: false })(argv),
      ).pipe(Effect.provide(services)),
    );
  });
};

it("uses one cold issue-list call and zero warm calls with an explicit repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "gh-read-calls-"));
  roots.push(root);
  vi.stubEnv("GH_TOKEN", "offline-replay");
  vi.stubEnv("GH_TOOL_CACHE_DIR", root);
  vi.stubEnv("GH_TOOL_CACHE", "on");
  const observed: string[][] = [];
  const replay = createReplayGh();
  const platform = Layer.mergeAll(
    BunServices.layer,
    processResultLayer((args) => {
      observed.push([...args]);
      return replay(args);
    }),
    Layer.succeed(ConfigService, undefined),
  );
  const services = GitHubService.layer.pipe(Layer.provideMerge(platform));
  const run = () =>
    captureOutput(async () => {
      await Effect.runPromise(
        withReadCache(
          withRedactedOutput(
            Command.runWith(mainCommand, { version: "test" })(replayFlags(["issue", "list"])),
          ),
        ).pipe(Effect.provide(services)),
      );
    });
  const cold = await run();
  expect(cold.stderr).toBe("");
  expect(observed.map((args) => args.slice(0, 2))).toEqual([["issue", "list"]]);
  const warm = await run();
  expect(warm.stdout).toBe(cold.stdout);
  expect(warm.stderr).toBe("");
  expect(observed).toHaveLength(1);
});

it("replays published 1.7.5 outputs with original review location fields without GitHub access", async () => {
  const fixture = JSON.parse(
    await readFile(new URL("./fixtures/gh-read-parity.json", import.meta.url), "utf8"),
  ) as { cases: { argv: string[]; stdout: string; status: number }[] };
  expect(fixture.cases.map((entry) => entry.argv)).toEqual(replayCases);
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname.endsWith("/stacks")) return Response.json([]);
    throw new Error("Unexpected offline request: " + url.pathname);
  });
  for (const entry of fixture.cases) {
    let expected = entry.stdout;
    if (entry.argv[0] === "pr") {
      expected = expected.replace(
        /^( +)"line": (null|\d+),$/gm,
        '$&\n$1"originalLine": null,\n$1"originalCommitSha": null,\n$1"diffHunk": null,',
      );
      if (["review-triage", "review-triage-batch"].includes(entry.argv[1] ?? ""))
        expected = expected.replace(/^( +)"reviews": \[$/gm, '$1"checksStatus": "reported",\n$&');
    }
    const result = await invoke(replayFlags(entry.argv));
    expect(result.stdout).toBe(expected);
    expect(result.stderr).toBe("");
  }
});

it("review-triage-batch summary returns hook fields with a smaller GitHub fetch", async () => {
  const calls: string[][] = [];
  const replay = createReplayGh();
  const result = await invoke(
    replayFlags(["pr", "review-triage-batch", "--prs", "42,43,44", "--summary"]),
    (args) => {
      calls.push([...args]);
      return replay(args);
    },
  );

  const entries = JSON.parse(result.stdout) as {
    info: Record<string, unknown>;
    summary: Record<string, unknown>;
    checks: ReadonlyArray<Record<string, unknown>>;
  }[];
  expect(result.stderr).toBe("");
  expect(entries).toHaveLength(3);
  expect(entries[0]).toEqual({
    pr: 42,
    info: {
      number: 42,
      title: "Example PR",
      state: "OPEN",
      isDraft: false,
      baseRefName: "main",
      reviewDecision: "APPROVED",
      mergeable: "MERGEABLE",
      reviewRequests: [{ login: "reviewer" }],
    },
    summary: { unresolvedReviewThreadsCount: 1, unrepliedReviewThreadsCount: 1 },
    checks: [{ name: "Build", bucket: "pending" }],
  });
  expect(entries[2]).toMatchObject({ pr: 44, checks: [] });
  expect(JSON.stringify(entries)).not.toMatch(/body|threads|diffHunk|inlineComments|reviews/);
  expect(calls).toHaveLength(6);
  expect(calls.filter((args) => args[1] === "graphql")).toHaveLength(3);
  expect(calls.filter((args) => args[1] === "checks")).toHaveLength(3);
  const query = calls.find((args) => args[1] === "graphql")?.join(" ") ?? "";
  expect(query).toContain("reviewThreads(first: 100");
  expect(query).toContain("comments(first: 2)");
  expect(query).toContain("replyTo { id }");
  expect(query).not.toContain("body");
  expect(query).not.toContain("diffHunk");
  expect(
    calls.filter((args) => args[1] === "checks").every((args) => args.at(-1) === "name,bucket"),
  ).toBe(true);
});

it("L706 preserves public GitHub login through assignee and comment output", async () => {
  vi.stubEnv("GITHUB_AUTH_USER", "fixture-operator");
  for (const argv of [
    ["issue", "edit", "--issue", "7", "--add-assignee", "fixture-operator"],
    ["pr", "comment", "--pr", "42", "--body", "Thanks @fixture-operator for reviewing."],
  ]) {
    const result = await invoke(replayFlags(argv));
    expect(result.stdout).toContain("fixture-operator");
    expect(result.stdout).not.toContain("[REDACTED]");
    expect(result.stderr).toBe("");
  }
});
