import { describe, expect, it } from "@effect/vitest";
import { Console, Effect, Layer, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { ConfigService } from "#config";
import { GitHubService } from "#gh/read/transport";

const pull = {
  number: 12,
  html_url: "https://github.com/owner/repo/pull/12",
  title: "Example",
  state: "open",
  draft: false,
  merged: false,
  mergeable: null,
  body: "",
  user: { login: "author", type: "User" },
  head: { ref: "feature", sha: "abc", user: { login: "owner" } },
  base: { ref: "main", sha: "def", user: { login: "owner" } },
  created_at: "2026-01-01T00:00:00Z",
};
const setup = (calls: string[][]) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      if (command._tag !== "StandardCommand") return Effect.die("unexpected pipeline");
      const args = [...command.args];
      calls.push(args);
      const blocked =
        args.includes("graphql") || (args[0] === "pr" && args.includes("number,reviewDecision"));
      const data = args.some((arg) => arg.endsWith("/comments")) ? [] : pull;
      const stdout = blocked ? "" : JSON.stringify(data);
      const stderr = blocked ? "GraphQL: API rate limit already exceeded (RATE_LIMIT)" : "";
      const stream = (text: string) => Stream.fromIterable([new TextEncoder().encode(text)]);
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(blocked ? 1 : 0)),
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
const provide = <A, E>(effect: Effect.Effect<A, E, GitHubService>, calls: string[][]) =>
  effect.pipe(
    Effect.provide(GitHubService.layer),
    Effect.provide(setup(calls)),
    Effect.provide(
      Layer.succeed(ConfigService, { github: { default: { owner: "owner", repo: "repo" } } }),
    ),
  );

describe("GraphQL REST fallback", () => {
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
