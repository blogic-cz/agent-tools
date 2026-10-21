import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { ConfigService } from "#config";
import { GitHubService } from "#gh/read/transport";
import { afterEach, expect, it, vi } from "vitest";
import { githubApi, parseRateLimitHeaders, SessionCredential } from "#gh/read/api";
import { cachedRead, ReadCache } from "#gh/read/cache";
import { FileStore } from "#gh/read/store";
import {
  CacheRequest,
  cacheEvent,
  ghSubprocessEvent,
  summarizeRequests,
  Telemetry,
  templateEndpoint,
} from "#gh/read/telemetry";
import type { RequestEvent, RequestRow, TelemetryStore } from "#gh/read/telemetry";

const memory = () => {
  const events: RequestEvent[] = [];
  const store: TelemetryStore = {
    record: (event) => {
      events.push(event);
    },
    read: () => [],
    close: () => {},
  };
  return { events, store };
};
afterEach(() => vi.restoreAllMocks());

it("records each HTTP response with parsed quota and templates identifiers", async () => {
  const { events, store } = memory();
  const fetch = vi.spyOn(globalThis, "fetch");
  const headers = {
    "x-ratelimit-resource": "core",
    "x-ratelimit-used": "12",
    "x-ratelimit-remaining": "4988",
    "x-ratelimit-reset": "2000",
  };
  fetch.mockResolvedValueOnce(new Response("{}", { status: 200, headers }));
  fetch.mockResolvedValueOnce(new Response(null, { status: 304, headers }));
  const read = (etag?: string) =>
    githubApi({ path: "repos/example-org/example-repo/pulls/42", ifNoneMatch: etag }).pipe(
      Effect.provideService(SessionCredential, "fixture"),
      Effect.provideService(Telemetry, store),
      Effect.provideService(CacheRequest, true),
    );
  expect((await Effect.runPromise(read())).status).toBe(200);
  expect((await Effect.runPromise(read('"etag"'))).status).toBe(304);
  expect(events).toMatchObject([
    {
      status: 200,
      outcome: "200",
      resource: "core",
      used: 12,
      remaining: 4988,
      reset: 2000,
      endpoint: "/repos/example-org/example-repo/pulls/:id",
    },
    { status: 304, outcome: "304", resource: "core" },
  ]);
  expect(
    templateEndpoint("repos/example-org/example-repo/commits/abcdef0123456789?token=secret"),
  ).toBe("/repos/example-org/example-repo/commits/:sha");
  expect(
    parseRateLimitHeaders(
      new Headers({
        "x-ratelimit-used": "NaN",
        "x-ratelimit-reset": "-1",
        "x-ratelimit-remaining": "9007199254740992",
      }),
    ),
  ).toEqual({});
});

it("preserves HTTP success and failure when telemetry writes throw", async () => {
  const store: TelemetryStore = {
    record: () => {
      throw new Error("locked");
    },
    read: () => [],
    close: () => {},
  };
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response("{}"))
    .mockResolvedValueOnce(new Response("{}", { status: 404 }));
  const read = githubApi({ path: "repos/example-org/example-repo" }).pipe(
    Effect.provideService(SessionCredential, "fixture"),
    Effect.provideService(Telemetry, store),
  );
  expect((await Effect.runPromise(read)).status).toBe(200);
  const result = await Effect.runPromise(read.pipe(Effect.flip));
  expect(result._tag).toBe("GitHubNotFoundError");
});

it("records network failure without inventing an HTTP status", async () => {
  const { store, events } = memory();
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
  await Effect.runPromise(
    githubApi({ path: "graphql", method: "POST", body: {} }).pipe(
      Effect.provideService(SessionCredential, "fixture"),
      Effect.provideService(Telemetry, store),
      Effect.flip,
    ),
  );
  expect(events).toMatchObject([{ status: null, outcome: "error", resource: null }]);
});

it("records one subprocess invocation without claiming HTTP requests or quota", () => {
  expect(
    ghSubprocessEvent(["api", "repos/example-org/example-repo/pulls/42?token=secret"], 0),
  ).toMatchObject({
    method: "GET",
    endpoint: "/repos/example-org/example-repo/pulls/:id",
    outcome: "subprocess",
    status: null,
    resource: null,
    used: null,
    remaining: null,
    reset: null,
  });
  expect(ghSubprocessEvent(["api", "graphql", "-f", "query={viewer{login}}"], 1)).toMatchObject({
    method: "POST",
    status: null,
  });
  expect(
    ghSubprocessEvent(["api", "repos/example-org/example-repo", "--method", "PATCH"], 1),
  ).toMatchObject({ method: "PATCH" });
  const event = ghSubprocessEvent(["pr", "view", "42"], 0);
  expect(event).toMatchObject({ method: "GH", endpoint: "pr view" });
  expect(
    summarizeRequests([{ ...event, id: 1, invocation: "test", command: "pr view" }]),
  ).toMatchObject({
    directHttpRequests: 0,
    ghSubprocessCalls: 1,
    cacheHits: 0,
    ratio304: null,
    externalUsageEstimate: null,
  });
});

it.each([
  {
    name: "issue and PR comment",
    args: ["-X", "POST", "repos/example-org/example-repo/issues/42/comments", "-f", "body=fixture"],
    endpoint: "/repos/example-org/example-repo/issues/:id/comments",
    method: "POST",
  },
  {
    name: "comment edit",
    args: [
      "-X",
      "PATCH",
      "repos/example-org/example-repo/issues/comments/42",
      "-f",
      "body=fixture",
    ],
    endpoint: "/repos/example-org/example-repo/issues/comments/:id",
    method: "PATCH",
  },
  {
    name: "review reply",
    args: [
      "-X",
      "POST",
      "repos/example-org/example-repo/pulls/42/comments/43/replies",
      "-f",
      "body=fixture",
    ],
    endpoint: "/repos/example-org/example-repo/pulls/:id/comments/:id/replies",
    method: "POST",
  },
  {
    name: "review submission",
    args: [
      "--method",
      "POST",
      "repos/example-org/example-repo/pulls/42/reviews",
      "-f",
      "event=COMMENT",
    ],
    endpoint: "/repos/example-org/example-repo/pulls/:id/reviews",
    method: "POST",
  },
  {
    name: "async merge",
    args: [
      "--method",
      "PUT",
      "repos/example-org/example-repo/pulls/42/merge-async",
      "-f",
      "merge_method=squash",
    ],
    endpoint: "/repos/example-org/example-repo/pulls/:id/merge-async",
    method: "PUT",
  },
  {
    name: "PR edit and child retarget",
    args: ["--method", "PATCH", "repos/example-org/example-repo/pulls/42", "-f", "base=main"],
    endpoint: "/repos/example-org/example-repo/pulls/:id",
    method: "PATCH",
  },
  {
    name: "branch deletion",
    args: ["--method", "DELETE", "repos/example-org/example-repo/git/refs/heads/fixture"],
    endpoint: "/repos/example-org/example-repo/git/refs/heads/fixture",
    method: "DELETE",
  },
  {
    name: "reviewer request",
    args: [
      "--method",
      "POST",
      "repos/example-org/example-repo/pulls/42/requested_reviewers",
      "-f",
      "reviewers[]=fixture",
    ],
    endpoint: "/repos/example-org/example-repo/pulls/:id/requested_reviewers",
    method: "POST",
  },
  {
    name: "release notes",
    args: [
      "--hostname",
      "github.example.com",
      "--method",
      "POST",
      "repos/example-org/example-repo/releases/generate-notes",
      "-f",
      "tag_name=v1",
    ],
    endpoint: "/repos/example-org/example-repo/releases/generate-notes",
    method: "POST",
  },
  {
    name: "branch rename",
    args: [
      "repos/example-org/example-repo/branches/fixture/rename",
      "-X",
      "POST",
      "-f",
      "new_name=next",
    ],
    endpoint: "/repos/example-org/example-repo/branches/fixture/rename",
    method: "POST",
  },
  {
    name: "GraphQL",
    args: ["graphql", "-f", "query={viewer{login}}", "-F", "number=42"],
    endpoint: "/graphql",
    method: "POST",
  },
  {
    name: "annotations",
    args: ["repos/example-org/example-repo/check-runs/42/annotations", "--paginate"],
    endpoint: "/repos/example-org/example-repo/check-runs/:id/annotations",
    method: "GET",
  },
  {
    name: "base SHA",
    args: ["repos/example-org/example-repo/pulls/42", "--jq", ".base.sha"],
    endpoint: "/repos/example-org/example-repo/pulls/:id",
    method: "GET",
  },
])("finds the API endpoint for $name callers", ({ args, endpoint, method }) => {
  expect(ghSubprocessEvent(["api", ...args], 0)).toMatchObject({ endpoint, method });
});

it.each([
  "-X",
  "--method",
  "-H",
  "--header",
  "-f",
  "-F",
  "--field",
  "--raw-field",
  "--jq",
  "-q",
  "--template",
  "-t",
  "--input",
  "--cache",
  "-p",
  "--preview",
  "--hostname",
])("skips the value of API option %s before the endpoint", (flag) => {
  for (const option of [[flag, "fixture"], [`${flag}=fixture`]]) {
    expect(
      ghSubprocessEvent(
        ["api", ...option, "repos/example-org/example-repo/pulls/42?key=private"],
        0,
      ).endpoint,
    ).toBe("/repos/example-org/example-repo/pulls/:id");
  }
});

it.each(["--paginate", "--slurp", "--include", "-i", "--silent", "--verbose"])(
  "keeps the endpoint after valueless API option %s",
  (flag) => {
    expect(ghSubprocessEvent(["api", flag, "repos/example-org/example-repo"], 0)).toMatchObject({
      endpoint: "/repos/example-org/example-repo",
      method: "GET",
    });
  },
);

it("keeps trace-like diagnostics unchanged and never enables gh tracing", async () => {
  const stderr = "gh: fixture failure\n* Request at ordinary content\nBad credentials (HTTP 401)\n";
  const encoder = new TextEncoder();
  const events: RequestEvent[] = [];
  const spawner = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      if (command._tag !== "StandardCommand") return Effect.die("unexpected command");
      expect(command.options.env?.GH_DEBUG).toBeUndefined();
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stderr: Stream.make(encoder.encode(stderr)),
          stdout: Stream.empty,
          stdin: Sink.drain,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        }),
      );
    }),
  );
  const run = (store: TelemetryStore | null) =>
    Effect.gen(function* () {
      const service = yield* GitHubService;
      return yield* service.runGh(["api", "repos/example-org/example-repo"]).pipe(Effect.flip);
    }).pipe(
      Effect.provide(GitHubService.layer),
      Effect.provide(spawner),
      Effect.provide(Layer.succeed(ConfigService, {})),
      Effect.provideService(Telemetry, store),
    );
  const before = await Effect.runPromise(run(null));
  const after = await Effect.runPromise(
    run({
      record: (event) => {
        events.push(event);
      },
      read: () => [],
      close: () => {},
    }),
  );
  expect(after).toEqual(before);
  expect(after._tag).toBe("GitHubAuthError");
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ outcome: "subprocess", status: null, resource: null });
});

it("records cache-only hits separately from HTTP requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "gh-telemetry-cache-"));
  try {
    const cache = await FileStore.open("fixture", root);
    const { store, events } = memory();
    let calls = 0;
    const read = cachedRead({
      key: { op: "prHead", repo: { owner: "example-org", name: "example-repo" }, pr: 1 },
      policy: { kind: "ttl", ttlMs: 60000 },
      decode: (value) => value,
      fetch: () =>
        Effect.sync(() => {
          calls++;
          return { kind: "fresh" as const, value: "head" };
        }),
    }).pipe(
      Effect.provideService(ReadCache, { store: cache, warned: false }),
      Effect.provideService(Telemetry, store),
    );
    await Effect.runPromise(read);
    await Effect.runPromise(read);
    expect(calls).toBe(1);
    expect(events).toMatchObject([{ method: "CACHE", outcome: "cache", status: null }]);
    expect(
      summarizeRequests(
        events.map((event, id) =>
          Object.assign({}, event, { id, invocation: "test", command: "pr view" }),
        ),
      ),
    ).toMatchObject({ directHttpRequests: 0, ghSubprocessCalls: 0, cacheHits: 1, ratio304: null });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("estimates external usage within each resource and reset window and excludes 304 and quota reads", () => {
  const row = (id: number, used: number | null, patch: Partial<RequestRow> = {}): RequestRow => ({
    ...cacheEvent(""),
    id,
    invocation: "test",
    command: "pr view",
    method: "GET",
    endpoint: "/repos/example-org/example-repo",
    outcome: "bypass",
    status: 200,
    resource: "core",
    reset: 1000,
    used,
    ...patch,
  });
  const report = summarizeRequests([
    row(1, 10),
    row(2, null),
    row(3, 15),
    row(4, 15, { status: 304, outcome: "304" }),
    row(5, 17, { endpoint: "/rate_limit" }),
    row(6, 1, { reset: 2000 }),
    row(7, 100, { resource: "graphql" }),
    row(8, 3, { reset: 2000 }),
  ]);
  expect(report).toMatchObject({
    directHttpRequests: 8,
    notModified: 1,
    ratio304: 1 / 8,
    externalUsageEstimate: 6,
    observedIntervals: 4,
  });
  expect(summarizeRequests([row(1, 11), row(2, 10), row(3, 12)])).toMatchObject({
    directHttpRequests: 3,
    externalUsageEstimate: 0,
    observedIntervals: 1,
  });
  expect(summarizeRequests([row(1, 11), row(2, 10), row(3, 13)])).toMatchObject({
    externalUsageEstimate: 0,
  });
  expect(summarizeRequests([row(1, 11), row(2, 10), row(3, 14)])).toMatchObject({
    externalUsageEstimate: 1,
  });
  expect(summarizeRequests([row(1, 10)])).toMatchObject({
    externalUsageEstimate: null,
    observedIntervals: 0,
  });
});

it("does not count requests from another reset window as own usage", () => {
  const row = (id: number, used: number, reset: number): RequestRow => ({
    ...cacheEvent(""),
    id,
    invocation: "test",
    command: "pr view",
    method: "GET",
    endpoint: "/repos/example-org/example-repo",
    outcome: "bypass",
    status: 200,
    resource: "core",
    reset,
    used,
    remaining: null,
  });

  expect(summarizeRequests([row(1, 10, 1000), row(2, 1, 2000), row(3, 14, 1000)])).toMatchObject({
    externalUsageEstimate: 3,
    observedIntervals: 1,
  });
});

it("counts same-resource requests with an unknown reset as own usage", () => {
  const row = (id: number, used: number, reset: number | null): RequestRow => ({
    ...cacheEvent(""),
    id,
    invocation: "test",
    command: "pr view",
    method: "GET",
    endpoint: "/repos/example-org/example-repo",
    outcome: "bypass",
    status: 200,
    resource: "core",
    reset,
    used,
    remaining: null,
  });

  expect(summarizeRequests([row(1, 10, 1000), row(2, 1, null), row(3, 14, 1000)])).toMatchObject({
    externalUsageEstimate: 2,
    observedIntervals: 1,
  });
});

it("subtracts gh subprocess calls from observed external usage", () => {
  const row = (id: number, used: number): RequestRow => ({
    ...cacheEvent(""),
    id,
    invocation: "test",
    command: "rate limit",
    method: "GET",
    endpoint: "/rate_limit",
    outcome: "bypass",
    status: 200,
    resource: "core",
    reset: 1000,
    used,
    remaining: null,
  });
  const subprocess = (id: number): RequestRow => ({
    ...ghSubprocessEvent(["api", "repos/example-org/example-repo/issues"], 0),
    id,
    invocation: "test",
    command: "api repos/example-org/example-repo/issues",
  });

  expect(summarizeRequests([row(1, 10), subprocess(2), subprocess(3), row(4, 15)])).toMatchObject({
    externalUsageEstimate: 3,
    observedIntervals: 1,
  });
  expect(summarizeRequests([row(1, 10), subprocess(2), subprocess(3), row(4, 11)])).toMatchObject({
    externalUsageEstimate: 0,
    observedIntervals: 1,
  });
});

it("subtracts only subprocess calls that can spend the sampled resource", () => {
  const quotaSample = (id: number, resource: string, used: number): RequestRow => ({
    ...cacheEvent(""),
    id,
    invocation: "test",
    command: "rate limit",
    method: "GET",
    endpoint: "/rate_limit",
    outcome: "bypass",
    status: 200,
    resource,
    reset: 1000,
    used,
    remaining: null,
  });
  const subprocess = (args: string[], id: number): RequestRow => ({
    ...ghSubprocessEvent(args, 0),
    id,
    invocation: "test",
    command: args.join(" "),
  });

  expect(
    summarizeRequests([
      quotaSample(1, "core", 10),
      subprocess(["api", "graphql", "-X", "POST"], 2),
      subprocess(["api", "rate_limit"], 3),
      quotaSample(4, "core", 13),
    ]),
  ).toMatchObject({ externalUsageEstimate: 3, observedIntervals: 1 });
  expect(
    summarizeRequests([
      quotaSample(1, "graphql", 10),
      subprocess(["api", "repos/example-org/example-repo"], 2),
      quotaSample(3, "graphql", 13),
    ]),
  ).toMatchObject({ externalUsageEstimate: 3, observedIntervals: 1 });
  expect(
    summarizeRequests([
      quotaSample(1, "graphql", 10),
      subprocess(["api", "graphql", "-X", "POST"], 2),
      quotaSample(3, "graphql", 13),
    ]),
  ).toMatchObject({ externalUsageEstimate: 2, observedIntervals: 1 });
  expect(
    summarizeRequests([
      quotaSample(1, "core", 10),
      subprocess(["repo", "view", "example-org/example-repo"], 2),
      quotaSample(3, "core", 13),
    ]),
  ).toMatchObject({ externalUsageEstimate: 2, observedIntervals: 1 });
});

it("persists rows, prunes seven-day history and drops writes while SQLite is locked", async () => {
  const root = await mkdtemp(join(tmpdir(), "gh-telemetry-db-"));
  try {
    const result = spawnSync(
      "bun",
      [
        "-e",
        `
      import { Database } from "bun:sqlite";
      import { openRequestTelemetry } from "./src/gh-tool/read/telemetry-store.ts";
      import { cacheEvent } from "./src/gh-tool/read/telemetry.ts";
      import { registerResolvedSecret } from "./src/shared/content-security.ts";
      process.argv = ["bun", "gh-tool", "pr", "comment", "--body", "fixture-resolved-credential"];
      const path = process.env.DB_PATH;
      const store = openRequestTelemetry(path);
      registerResolvedSecret("fixture-resolved-credential");
      store.record({ ...cacheEvent("prHead"), method: "GET", status: 200, outcome: "200" });
      store.record({ ...cacheEvent("prHead"), method: "GET", status: 304, outcome: "304" });
      store.record({ ...cacheEvent("old"), ts: "2000-01-01T00:00:00.000Z" });
      store.close();
      const reopened = openRequestTelemetry(path);
      const before = reopened.read("2000");
      const lock = new Database(path);
      lock.run("BEGIN IMMEDIATE");
      reopened.record(cacheEvent("locked"));
      lock.run("ROLLBACK");
      const after = reopened.read("2000");
      const raw = lock.query("SELECT command FROM github_requests").all();
      lock.run("UPDATE github_requests SET command = ?", ["pr comment --body fixture-read-credential"]);
      registerResolvedSecret("fixture-read-credential");
      console.log(JSON.stringify({ before, after, raw, redactedRead: reopened.read("2000") }));
      reopened.close(); lock.close();
    `,
      ],
      {
        cwd: join(__dirname, ".."),
        encoding: "utf8",
        env: { ...process.env, DB_PATH: join(root, "audit.sqlite") },
        timeout: 10000,
      },
    );
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
    const data = JSON.parse(result.stdout);
    expect(data.before).toMatchObject([
      { method: "GET", status: 200, outcome: "200" },
      { method: "GET", status: 304, outcome: "304" },
    ]);
    expect(data.before).toHaveLength(2);
    expect(JSON.stringify(data)).not.toContain("fixture-resolved-credential");
    expect(JSON.stringify(data.redactedRead)).not.toContain("fixture-read-credential");
    expect(data.after).toEqual(data.before);
    expect(data.before[0].invocation).toBe(data.before[1].invocation);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("stores only the GitHub subcommand path and flag names in request telemetry", async () => {
  const root = await mkdtemp(join(tmpdir(), "gh-telemetry-command-"));
  try {
    const result = spawnSync(
      "bun",
      [
        "-e",
        `
      import { Database } from "bun:sqlite";
      import { openRequestTelemetry } from "./src/gh-tool/read/telemetry-store.ts";
      import { cacheEvent } from "./src/gh-tool/read/telemetry.ts";
      const commands = [
        ["pr", "comment", "--pr", "12", "--body", "private text"],
        ["pr", "create", "--field=value"],
        ["pr", "comment", "-f", "value"],
        ["pr", "view", "12"],
        ["workflow", "logs", "--run", "102"],
        ["telemetry", "--hours", "24"],
      ];
      for (const [index, args] of commands.entries()) {
        process.argv = ["bun", "gh-tool", ...args];
        const store = openRequestTelemetry(process.env.DB_PATH);
        store.record(cacheEvent(String(index)));
        store.close();
      }
      const db = new Database(process.env.DB_PATH);
      console.log(JSON.stringify(db.query("SELECT command FROM github_requests ORDER BY id").all()));
      db.close();
    `,
      ],
      {
        cwd: join(__dirname, ".."),
        encoding: "utf8",
        env: { ...process.env, DB_PATH: join(root, "audit.sqlite") },
        timeout: 10000,
      },
    );
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual([
      { command: "pr comment --body --pr" },
      { command: "pr create --field" },
      { command: "pr comment -f" },
      { command: "pr view" },
      { command: "workflow logs --run" },
      { command: "telemetry --hours" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
