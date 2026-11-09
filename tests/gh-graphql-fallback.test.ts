import { describe, expect, it } from "@effect/vitest";
import { Console, Effect, Layer, Result, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { ConfigService } from "#config";
import { GitHubService } from "#gh/read/transport";
import { reviewThreads } from "#gh/read/reviews";
import { withFallbackOutput } from "#gh/read/graphql-fallback";
import { classifyReviewTriage } from "#gh/pr/commands";
import { Telemetry, type RequestEvent } from "#gh/read/telemetry";

const pull = {
  number: 12,
  html_url: "https://github.com/owner/repo/pull/12",
  title: "Example",
  state: "open",
  draft: false,
  merged: false,
  merged_at: null,
  mergeable: null,
  body: "",
  user: { login: "author", type: "User" },
  head: { ref: "feature", sha: "abc", user: { login: "owner", type: "User" } },
  base: { ref: "main", sha: "def", user: { login: "owner", type: "User" } },
  created_at: "2026-01-01T00:00:00Z",
};
type Reply = { stdout: string; stderr: string; exitCode: number };
const setup = (calls: string[][], reply?: (args: string[]) => Reply | undefined) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      if (command._tag !== "StandardCommand") return Effect.die("unexpected pipeline");
      const args = [...command.args];
      calls.push(args);
      const blocked =
        args.includes("graphql") || (args[0] === "pr" && args.includes("number,reviewDecision"));
      const data = args.some((arg) => arg.endsWith("/comments"))
        ? [
            [
              {
                id: 7,
                node_id: "comment-7",
                path: "file.ts",
                line: 1,
                body: "Please check this",
                user: { login: "reviewer" },
                commit_id: "abc",
              },
            ],
          ]
        : pull;
      const response = reply?.(args) ?? {
        stdout: blocked ? "" : JSON.stringify(data),
        stderr: blocked ? "GraphQL: API rate limit already exceeded (RATE_LIMIT)" : "",
        exitCode: blocked ? 1 : 0,
      };
      const { stdout, stderr } = response;
      const stream = (text: string) => Stream.fromIterable([new TextEncoder().encode(text)]);
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(response.exitCode)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: stream(stdout),
          stderr: stream(stderr),
          all: stream(stdout + stderr),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        }),
      );
    }),
  );
const provide = <A, E>(
  effect: Effect.Effect<A, E, GitHubService>,
  calls: string[][],
  reply?: (args: string[]) => Reply | undefined,
) =>
  effect.pipe(
    Effect.provide(GitHubService.layer),
    Effect.provide(setup(calls, reply)),
    Effect.provide(
      Layer.succeed(ConfigService, { github: { default: { owner: "owner", repo: "repo" } } }),
    ),
  );

describe("GraphQL REST fallback", () => {
  it.effect("keeps REST thread resolution unknown and audits the fallback", () => {
    const calls: string[][] = [];
    const events: RequestEvent[] = [];
    return provide(
      Effect.gen(function* () {
        const nodes = yield* reviewThreads({ owner: "owner", name: "repo" }, 12);
        expect(nodes).toHaveLength(1);
        expect(nodes[0]?.isResolved).toBeNull();
        expect(nodes[0]?.comments.nodes[0]?.databaseId).toBe(7);
        expect(JSON.stringify(nodes)).toContain('"isResolved":null');
        expect(
          classifyReviewTriage(
            {
              unresolvedReviewThreadsCount: null,
              visibleOpenReviewThreadsCount: 0,
              unrepliedReviewThreadsCount: 0,
            },
            [],
          ),
        ).toMatchObject({
          status: "needs_investigation",
          reasons: ["unknown_review_thread_resolution"],
        });
        expect(events.filter((event) => event.outcome === "fallback")).toHaveLength(1);
      }),
      calls,
      (args) =>
        args.includes("graphql")
          ? {
              stdout: JSON.stringify({
                errors: [{ type: "RATE_LIMIT", message: "API rate limit already exceeded" }],
              }),
              stderr: "",
              exitCode: 0,
            }
          : undefined,
    ).pipe(
      Effect.provideService(Telemetry, {
        record: (event) => {
          events.push(event);
        },
        read: () => [],
        close: () => {},
      }),
    );
  });
  it.effect("does not fallback on an authentication failure", () => {
    const calls: string[][] = [];
    return provide(
      Effect.gen(function* () {
        const gh = yield* GitHubService;
        const result = yield* gh
          .runGhJson(["pr", "view", "12", "--json", "number,reviewDecision"])
          .pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        expect(calls).toHaveLength(1);
      }),
      calls,
      () => ({ stdout: "", stderr: "HTTP 401 Bad credentials", exitCode: 1 }),
    );
  });
  it.effect("preserves the head condition in REST merge fallback", () => {
    const calls: string[][] = [];
    return provide(
      Effect.gen(function* () {
        const gh = yield* GitHubService;
        yield* gh.runGh(["pr", "merge", "12", "--squash", "--match-head-commit", "a".repeat(40)]);
        expect(calls.find((args) => args.includes("PUT"))).toEqual([
          "api",
          "--method",
          "PUT",
          "repos/owner/repo/pulls/12/merge",
          "-f",
          "merge_method=squash",
          "-f",
          `sha=${"a".repeat(40)}`,
        ]);
      }),
      calls,
      (args) =>
        args[0] === "pr"
          ? { stdout: "", stderr: "GraphQL secondary rate limit", exitCode: 1 }
          : {
              stdout: JSON.stringify({ merged: true, message: "Merged" }),
              stderr: "",
              exitCode: 0,
            },
    );
  });
  it.effect("adds JSON metadata without splitting JSONL records", () =>
    Effect.gen(function* () {
      const current = yield* Console.Console;
      const output: unknown[] = [];
      yield* withFallbackOutput(
        provide(
          Effect.gen(function* () {
            const gh = yield* GitHubService;
            yield* gh.runGhJson(["pr", "view", "12", "--json", "number,reviewDecision"]);
            yield* Console.log(JSON.stringify({ type: "snapshot", number: 12 }));
          }),
          [],
        ),
      ).pipe(
        Effect.provideService(Console.Console, {
          ...current,
          log: (...args) => {
            output.push(...args);
          },
          warn: () => {},
        }),
      );
      expect(output).toHaveLength(1);
      expect(String(output[0])).not.toContain("\n");
      expect(JSON.parse(String(output[0]))).toMatchObject({
        type: "snapshot",
        fallback: { source: "REST", unknown: ["reviewDecision"] },
      });
    }),
  );
  it.effect("reads PR facts without GraphQL", () => {
    const calls: string[][] = [];
    return provide(
      Effect.gen(function* () {
        const gh = yield* GitHubService;
        const value = yield* gh.runGhJson<{ number: number; headRefOid: string }>([
          "pr",
          "view",
          "12",
          "--json",
          "number,headRefOid",
        ]);
        expect(value).toMatchObject({ number: 12, headRefOid: "abc" });
        expect(calls.every((args) => args[0] === "api" && !args.includes("graphql"))).toBe(true);
      }),
      calls,
    );
  });
  it.effect("falls back once and keeps unknown values in JSON and stderr", () => {
    const calls: string[][] = [];
    const warnings: unknown[][] = [];
    return Effect.gen(function* () {
      const current = yield* Console.Console;
      return yield* provide(
        Effect.gen(function* () {
          const gh = yield* GitHubService;
          for (let i = 0; i < 2; i++) {
            const value = yield* gh.runGhJson<{
              reviewDecision: string;
              fallback: { unknown: string[] };
            }>(["pr", "view", "12", "--json", "number,reviewDecision"]);
            expect(value.reviewDecision).toBe("UNKNOWN");
            expect(value.fallback.unknown).toContain("reviewDecision");
            expect(JSON.stringify(value)).toContain("UNKNOWN");
          }
          expect(calls.filter((args) => args[0] === "pr")).toHaveLength(1);
          expect(warnings.flat().join(" ")).toContain("answered from REST");
          expect(warnings.flat().join(" ")).toContain("Unknown: reviewDecision");
        }),
        calls,
      ).pipe(
        Effect.provideService(Console.Console, {
          ...current,
          warn: (...args) => {
            warnings.push([...args]);
          },
        }),
      );
    });
  });
});
