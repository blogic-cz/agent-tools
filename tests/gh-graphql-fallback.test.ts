import { describe, expect, it } from "@effect/vitest";
import { Console, Effect, Layer, Result, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { ConfigService } from "#config";
import { GitHubService } from "#gh/read/transport";
import { PR_VIEW_FIELDS, PR_LIST_FIELDS, prReviewTriageSummary } from "#gh/read/pulls";
import { reviewThreads } from "#gh/read/reviews";
import { reportFallback, withFallbackOutput } from "#gh/read/graphql-fallback";
import { classifyReviewTriage } from "#gh/pr/commands";
import { Telemetry, type RequestEvent } from "#gh/read/telemetry";
import { submitPendingReview } from "#gh/pr/review";

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
  for (const exitCode of [0, 1])
    it.effect(
      `handles structured RATE_LIMIT responses with exit code ${exitCode} and no stderr`,
      () =>
        provide(
          Effect.gen(function* () {
            const nodes = yield* reviewThreads({ owner: "owner", name: "repo" }, 12);
            expect(nodes[0]?.isResolved).toBeNull();
          }),
          [],
          (args) =>
            args.includes("graphql")
              ? {
                  stdout: JSON.stringify({
                    type: "RATE_LIMIT",
                    code: "graphql_rate_limit",
                    message: "API rate limit already exceeded",
                  }),
                  stderr: "",
                  exitCode,
                }
              : undefined,
        ),
    );
  it.effect("reads lists and checks through REST, including legacy statuses", () => {
    const calls: string[][] = [];
    return provide(
      Effect.gen(function* () {
        const gh = yield* GitHubService;
        const list = yield* gh.runGhJson<Array<{ number: number }>>([
          "pr",
          "list",
          "--head",
          "feature",
          "--state",
          "open",
          "--json",
          "number",
        ]);
        expect(list.map((item) => item.number)).toEqual([12]);
        const checks = yield* gh.runGhJson<Array<{ name: string; bucket: string }>>([
          "pr",
          "checks",
          "12",
          "--json",
          "name,state,bucket,link",
        ]);
        expect(checks).toMatchObject([
          { name: "Build", bucket: "pass" },
          { name: "Deploy", bucket: "fail" },
        ]);
        expect(calls.every((args) => args[0] === "api" && !args.includes("graphql"))).toBe(true);
      }),
      calls,
      (args) => {
        const path = args[3] ?? "";
        const data = path.includes("/pulls?")
          ? [[pull]]
          : path.includes("/check-runs?")
            ? [
                {
                  check_runs: [
                    {
                      name: "Build",
                      status: "completed",
                      conclusion: "success",
                      html_url: "external",
                    },
                  ],
                },
              ]
            : path.includes("/status?")
              ? [
                  {
                    statuses: [
                      { context: "Deploy", state: "failure", target_url: "external" },
                      { context: "Deploy", state: "success", target_url: "old" },
                    ],
                  },
                ]
              : undefined;
        return data === undefined
          ? undefined
          : { stdout: JSON.stringify(data), stderr: "", exitCode: 0 };
      },
    );
  });
  it.effect("does not carry the GraphQL block into a new service instance", () => {
    const calls: string[][] = [];
    const attempt = () =>
      provide(
        Effect.gen(function* () {
          const gh = yield* GitHubService;
          yield* gh.runGhJson(["pr", "view", "12", "--json", "number,reviewDecision"]);
        }),
        calls,
      );
    return Effect.gen(function* () {
      yield* attempt();
      yield* attempt();
      expect(calls.filter((args) => args[0] === "pr")).toHaveLength(2);
    });
  });
  it.effect("reports one warning and metadata for an empty JSON array", () =>
    Effect.gen(function* () {
      const current = yield* Console.Console;
      const warnings: unknown[] = [];
      const output: unknown[] = [];
      yield* withFallbackOutput(
        Effect.gen(function* () {
          yield* reportFallback(["review thread resolution"]);
          yield* reportFallback(["reviewDecision"]);
          yield* Console.log("[]");
        }),
      ).pipe(
        Effect.provideService(Console.Console, {
          ...current,
          log: (...args) => {
            output.push(...args);
          },
          warn: (...args) => {
            warnings.push(...args);
          },
        }),
      );
      expect(warnings).toHaveLength(1);
      expect(String(warnings[0])).toContain("review thread resolution, reviewDecision");
      expect(JSON.parse(String(output[0]))).toMatchObject({
        items: [],
        fallback: { source: "REST", unknown: ["review thread resolution", "reviewDecision"] },
      });
    }),
  );
  it.effect("submits an owned pending review through REST without more GraphQL attempts", () => {
    const calls: string[][] = [];
    return provide(
      Effect.gen(function* () {
        const result = yield* submitPendingReview(12, null, "Review complete");
        expect(result).toMatchObject({
          submitted: true,
          reviewId: "review-node",
          state: "COMMENTED",
        });
        expect(calls.filter((args) => args.includes("graphql"))).toHaveLength(1);
        expect(calls.filter((args) => args.includes("POST"))).toHaveLength(1);
      }),
      calls,
      (args) => {
        const path = args[3];
        const review = {
          id: 9,
          node_id: "review-node",
          state: "PENDING",
          body: "Draft review",
          user: { login: "author" },
          pull_request_url: "https://api.github.com/repos/owner/repo/pulls/12",
        };
        const data =
          path === "repos/owner/repo"
            ? {
                owner: { login: "owner" },
                name: "repo",
                default_branch: "main",
                html_url: "https://github.com/owner/repo",
              }
            : path === "user"
              ? { login: "author" }
              : path?.endsWith("/events")
                ? { node_id: "review-node", state: "COMMENTED" }
                : path?.endsWith("/reviews")
                  ? [[review]]
                  : path?.endsWith("/comments")
                    ? [[{ body: "Comment" }]]
                    : undefined;
        return data === undefined
          ? undefined
          : { stdout: JSON.stringify(data), stderr: "", exitCode: 0 };
      },
    );
  });
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
        expect(calls.some((args) => args[3]?.includes("/rules/branches/"))).toBe(false);
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
  const decision = (scenario: {
    rulesets?: unknown;
    rulesetsError?: string;
    branch?: unknown;
    protection?: unknown;
    protectionError?: string;
    reviews?: unknown[];
    reviewPages?: unknown[][];
  }) => {
    const calls: string[][] = [];
    return provide(
      Effect.gen(function* () {
        const gh = yield* GitHubService;
        const value = yield* gh.runGhJson<{
          reviewDecision: string;
          fallback: { unknown: string[] };
        }>(["pr", "view", "12", "--json", "number,reviewDecision"]);
        return value;
      }),
      calls,
      (args) => {
        if (args[0] === "pr") return undefined;
        const path = args[3];
        if (path === "repos/owner/repo/rules/branches/main")
          return scenario.rulesetsError === undefined
            ? ok(scenario.rulesets ?? [])
            : failure(scenario.rulesetsError);
        if (path === "repos/owner/repo/branches/main")
          return ok(scenario.branch ?? { protected: false });
        if (path === "repos/owner/repo/branches/main/protection/required_pull_request_reviews")
          return scenario.protectionError === undefined
            ? ok(scenario.protection ?? {})
            : failure(scenario.protectionError);
        if (path === "repos/owner/repo/pulls/12/reviews") {
          expect(args).toContain("--paginate");
          expect(args).toContain("--slurp");
          return ok(args.includes("--paginate") && args.includes("--slurp")
            ? scenario.reviewPages ?? [scenario.reviews ?? []]
            : scenario.reviews ?? []);
        }
        return undefined;
      },
    );
  };

  it.effect("refuses a permission-masked classic protection 404", () =>
    decision({ branch: { protected: true }, protectionError: "HTTP 404 Not Found" }).pipe(
      Effect.tap((value) => Effect.sync(() => {
        expect(value.reviewDecision).toBe("UNKNOWN");
        expect(value.fallback.unknown).toContain("reviewDecision");
      })),
    ),
  );
  it.effect("reads classic code-owner review requirements", () =>
    decision({ branch: { protected: true }, protection: {
      required_approving_review_count: 1, require_code_owner_reviews: true,
      dismiss_stale_reviews: false, require_last_push_approval: false,
    } }).pipe(Effect.tap((value) => Effect.sync(() => expect(value.reviewDecision).toBe("UNKNOWN")))),
  );
  it.effect("excludes classic stale approvals", () =>
    decision({ branch: { protected: true }, protection: {
      required_approving_review_count: 1, require_code_owner_reviews: false,
      dismiss_stale_reviews: true, require_last_push_approval: false,
    }, reviews: [{ id: 1, user: { login: "reviewer" }, state: "APPROVED",
      submitted_at: "2026-01-01T00:00:00Z", commit_id: "old" }] }).pipe(
      Effect.tap((value) => Effect.sync(() => expect(value.reviewDecision).toBe("REVIEW_REQUIRED"))),
    ),
  );
  it.effect("uses the latest review from a second page", () =>
    decision({ rulesets: [{ type: "pull_request", parameters: { required_approving_review_count: 1 } }],
      reviewPages: [[{ id: 1, user: { login: "reviewer" }, state: "APPROVED", submitted_at: "2026-01-01T00:00:00Z", commit_id: "abc" }],
        [{ id: 2, user: { login: "reviewer" }, state: "CHANGES_REQUESTED", submitted_at: "2026-01-02T00:00:00Z", commit_id: "abc" }]],
    }).pipe(Effect.tap((value) => Effect.sync(() => expect(value.reviewDecision).toBe("CHANGES_REQUESTED")))),
  );
  it.effect("projects search-list PR objects", () => provide(Effect.gen(function* () {
    const gh = yield* GitHubService;
    const value = yield* gh.runGhJson<unknown>(["pr", "list", "--search", "is:open", "--json", "number,title"]);
    expect(value).toEqual([{ number: 12, title: "Example", reviewDecision: "UNKNOWN" }]);
  }), [], (args) => args[3]?.startsWith("search/issues?") ? ok([{ incomplete_results: false, items: [{ number: 12 }] }]) : undefined));
  for (const command of ["view", "list"]) {
    it.effect(`restores healthy ${command} decisions and shares base rules`, () => {
      const calls: string[][] = [];
      return provide(Effect.gen(function* () {
        const gh = yield* GitHubService;
        const fields = command === "view" ? PR_VIEW_FIELDS : PR_LIST_FIELDS;
        const value = yield* gh.runGhJson<unknown>(["pr", command, ...(command === "view" ? ["12"] : []), "--json", fields]);
        const values = Array.isArray(value) ? value : [value];
        expect(values).toHaveLength(command === "view" ? 1 : 2);
        for (const item of values) expect(item).toMatchObject({ reviewDecision: "" });
        expect(calls.filter((args) => args[3]?.endsWith("/rules/branches/main"))).toHaveLength(1);
        expect(calls.filter((args) => args[3]?.endsWith("/branches/main"))).toHaveLength(1);
        expect(calls.some((args) => args[0] === "pr" || args.includes("graphql"))).toBe(false);
      }), calls, (args) => {
        const path = args[3] ?? "";
        if (path.includes("/rules/branches/")) return ok([]);
        if (path.endsWith("/branches/main")) return ok({ protected: false });
        if (path.includes("/pulls?")) return ok([[pull, { ...pull, number: 13 }]]);
        return undefined;
      });
    });
  }
  it.effect("uses GraphQL only for REST-unknown decisions on healthy lists", () => {
    const calls: string[][] = [];
    return provide(Effect.gen(function* () {
      const gh = yield* GitHubService;
      const values = yield* gh.runGhJson<Array<{ reviewDecision: string }>>(["pr", "list", "--json", PR_LIST_FIELDS]);
      expect(values.map((item) => item.reviewDecision)).toEqual(["", "APPROVED"]);
      expect(calls.filter((args) => args[0] === "pr")).toEqual([["pr", "view", "13", "--repo", "owner/repo", "--json", "reviewDecision"]]);
    }), calls, (args) => {
      if (args[0] === "pr") return ok({ reviewDecision: args[2] === "13" ? "APPROVED" : null });
      const path = args[3] ?? "";
      if (path.includes("/pulls?")) return ok([[pull, { ...pull, number: 13, base: { ...pull.base, ref: "restricted" } }]]);
      if (path.endsWith("/rules/branches/main")) return ok([]);
      if (path.endsWith("/rules/branches/restricted")) return failure("HTTP 403 Resource not accessible");
      if (path.endsWith("/branches/main")) return ok({ protected: false });
      return undefined;
    });
  });

  it.effect("computes no review requirement when rulesets are unavailable on a free plan", () =>
    decision({
      rulesetsError:
        "HTTP 403 Upgrade to GitHub Pro or make this repository public to use rulesets",
    }).pipe(
      Effect.tap((value) =>
        Effect.sync(() => {
          expect(value.reviewDecision).toBe("");
          expect(value.fallback.unknown).not.toContain("reviewDecision");
        }),
      ),
    ),
  );

  it.effect("ignores rulesets that only require status checks", () =>
    decision({
      rulesets: [
        {
          type: "required_status_checks",
          parameters: { strict_required_status_checks_policy: true },
        },
      ],
    }).pipe(Effect.tap((value) => Effect.sync(() => expect(value.reviewDecision).toBe("")))),
  );

  it.effect("computes review decisions from latest reviewer states", () => {
    const cases: Array<{
      name: string;
      reviews: unknown[];
      stale?: boolean;
      expected: string;
    }> = [
      {
        name: "one approval on the current head",
        reviews: [
          {
            id: 1,
            user: { login: "alice" },
            state: "APPROVED",
            submitted_at: "2026-01-01T00:00:00Z",
            commit_id: "abc",
          },
        ],
        expected: "APPROVED",
      },
      {
        name: "a later change request from another reviewer",
        reviews: [
          {
            id: 1,
            user: { login: "alice" },
            state: "APPROVED",
            submitted_at: "2026-01-01T00:00:00Z",
            commit_id: "abc",
          },
          {
            id: 2,
            user: { login: "bob" },
            state: "CHANGES_REQUESTED",
            submitted_at: "2026-01-02T00:00:00Z",
            commit_id: "abc",
          },
        ],
        expected: "CHANGES_REQUESTED",
      },
      {
        name: "comment-only review",
        reviews: [
          {
            id: 1,
            user: { login: "alice" },
            state: "COMMENTED",
            submitted_at: "2026-01-01T00:00:00Z",
            commit_id: "abc",
          },
        ],
        expected: "REVIEW_REQUIRED",
      },
      {
        name: "approval after the same user's change request",
        reviews: [
          {
            id: 1,
            user: { login: "alice" },
            state: "CHANGES_REQUESTED",
            submitted_at: "2026-01-01T00:00:00Z",
            commit_id: "abc",
          },
          {
            id: 2,
            user: { login: "alice" },
            state: "APPROVED",
            submitted_at: "2026-01-02T00:00:00Z",
            commit_id: "abc",
          },
        ],
        expected: "APPROVED",
      },
      {
        name: "stale approval after a push",
        reviews: [
          {
            id: 1,
            user: { login: "alice" },
            state: "APPROVED",
            submitted_at: "2026-01-01T00:00:00Z",
            commit_id: "old",
          },
        ],
        stale: true,
        expected: "REVIEW_REQUIRED",
      },
    ];
    return Effect.forEach(cases, ({ reviews, stale, expected }) =>
      decision({
        rulesets: [
          {
            type: "pull_request",
            parameters: {
              required_approving_review_count: 1,
              ...(stale === true ? { dismiss_stale_reviews_on_push: true } : {}),
            },
          },
        ],
        reviews: [...reviews],
      }).pipe(
        Effect.tap((value) => Effect.sync(() => expect(value.reviewDecision).toBe(expected))),
      ),
    );
  });

  it.effect(
    "returns UNKNOWN when a rule needs code-owner proof or classic protection is unreadable",
    () =>
      Effect.all([
        decision({
          rulesets: [
            {
              type: "pull_request",
              parameters: { required_approving_review_count: 1, require_code_owner_review: true },
            },
          ],
        }),
        decision({
          branch: { protected: true },
          protectionError: "HTTP 403 Resource not accessible by integration",
        }),
      ]).pipe(
        Effect.tap(([codeOwner, classic]) =>
          Effect.sync(() => {
            expect(codeOwner.reviewDecision).toBe("UNKNOWN");
            expect(classic.reviewDecision).toBe("UNKNOWN");
          }),
        ),
      ),
  );

  it.effect("does not read REST review rules when GraphQL supplies the decision", () => {
    const calls: string[][] = [];
    return provide(
      Effect.gen(function* () {
        const gh = yield* GitHubService;
        const result = yield* gh.runGhJson<{ reviewDecision: string }>([
          "pr",
          "view",
          "12",
          "--json",
          "number,reviewDecision",
        ]);
        expect(result.reviewDecision).toBe("APPROVED");
        expect(calls.some((args) => args[3]?.includes("/rules/branches/"))).toBe(false);
      }),
      calls,
      (args) => (args[0] === "pr" ? ok({ reviewDecision: "APPROVED" }) : undefined),
    );
  });
});

const ok = (data: unknown): Reply => ({ stdout: JSON.stringify(data), stderr: "", exitCode: 0 });
const failure = (stderr: string): Reply => ({ stdout: "", stderr, exitCode: 1 });
it.effect("falls back on a bare GraphQL HTTP 429", () =>
  provide(
    Effect.gen(function* () {
      const nodes = yield* reviewThreads({ owner: "owner", name: "repo" }, 12, "origin");
      expect(nodes).toHaveLength(1);
      expect(nodes[0]?.isResolved).toBeNull();
    }),
    [],
    (args) => (args.includes("graphql") ? failure("gh: Too Many Requests (HTTP 429)") : undefined),
  ),
);
for (const kind of ["summary", "threads"] as const)
  it.effect(`replaces earlier GraphQL pages on REST fallback for ${kind}`, () => {
    let pages = 0;
    const comments = Array.from({ length: 101 }, (_, i) => ({
      id: i + 1,
      node_id: `comment-${i + 1}`,
      path: "file.ts",
      line: 1,
      body: "Check",
      user: { login: "reviewer" },
      commit_id: "abc",
    }));
    return provide(
      Effect.gen(function* () {
        if (kind === "summary") {
          const result = yield* prReviewTriageSummary({ owner: "owner", name: "repo" }, 12);
          expect(result.summary.unrepliedReviewThreadsCount).toBe(101);
          expect(result.summary.unresolvedReviewThreadsCount).toBeNull();
        } else {
          const result = yield* reviewThreads({ owner: "owner", name: "repo" }, 12, "origin");
          expect(result).toHaveLength(101);
          expect(new Set(result.map((node) => node.id)).size).toBe(101);
        }
      }),
      [],
      (args) => {
        if (args.includes("graphql")) {
          if (pages++ > 0) return failure("GraphQL RATE_LIMIT");
          return ok({
            data: {
              repository: {
                pullRequest: {
                  number: 12,
                  title: "Example",
                  state: "OPEN",
                  isDraft: false,
                  baseRefName: "main",
                  reviewDecision: "APPROVED",
                  mergeable: "MERGEABLE",
                  reviewRequests: { nodes: [] },
                  reviewThreads: {
                    nodes: comments.slice(0, 100).map((comment) => ({
                      id: comment.node_id,
                      isResolved: false,
                      comments: {
                        nodes: [
                          {
                            id: comment.node_id,
                            databaseId: comment.id,
                            path: comment.path,
                            line: 1,
                            body: comment.body,
                            author: comment.user,
                            commit: { oid: "abc" },
                            replyTo: null,
                          },
                        ],
                        pageInfo: { hasNextPage: false, endCursor: null },
                      },
                    })),
                    pageInfo: { hasNextPage: true, endCursor: "page-1" },
                  },
                },
              },
            },
          });
        }
        if (args[3]?.endsWith("/comments")) return ok([comments]);
        if (args[3]?.includes("/check-runs?")) return ok([{ check_runs: [] }]);
        if (args[3]?.includes("/status?")) return ok([{ statuses: [] }]);
        return undefined;
      },
    );
  });
for (const state of ["closed", "merged"])
  it.effect(`finds a ${state} PR from the current branch`, () =>
    provide(
      Effect.gen(function* () {
        const gh = yield* GitHubService;
        const result = yield* gh.runGhJson<{ number: number; state: string }>([
          "pr",
          "view",
          "--json",
          "number,state",
        ]);
        expect(result).toEqual({
          number: 12,
          state: state.toUpperCase(),
          reviewDecision: "UNKNOWN",
        });
      }),
      [],
      (args) => {
        if (args[0] === "branch") return { stdout: "feature\n", stderr: "", exitCode: 0 };
        if (args[0] === "config") return failure("unset");
        if (args[3]?.includes("/pulls?"))
          return ok(
            args[3].includes("state=all")
              ? [[{ ...pull, state: "closed", merged: state === "merged" }]]
              : [[]],
          );
        return ok({ ...pull, state: "closed", merged: state === "merged" });
      },
    ),
  );
it.effect("uses the tracking head and fork owner for current branch lookup", () => {
  const calls: string[][] = [];
  return provide(
    Effect.gen(function* () {
      const gh = yield* GitHubService;
      const result = yield* gh.runGhJson<{ number: number }>(["pr", "view", "--json", "number"]);
      expect(result.number).toBe(12);
      expect(calls.some((args) => args[3]?.includes("head=alice%3Afeature"))).toBe(true);
    }),
    calls,
    (args) => {
      if (args[0] === "branch") return { stdout: "work\n", stderr: "", exitCode: 0 };
      if (args[0] === "config")
        return {
          stdout: args[2]?.endsWith(".merge") ? "refs/heads/feature\n" : "alice\n",
          stderr: "",
          exitCode: 0,
        };
      if (args[0] === "remote")
        return { stdout: "git@github.com:alice/fork.git\n", stderr: "", exitCode: 0 };
      if (args[3]?.includes("/pulls?")) return ok([[pull]]);
      return undefined;
    },
  );
});
it.effect("resolves a tracked PR ref by number in the selected repository", () => {
  const calls: string[][] = [];
  return provide(
    Effect.gen(function* () {
      const gh = yield* GitHubService;
      const result = yield* gh.runGhJson<{ number: number }>([
        "pr",
        "view",
        "--repo",
        "owner/repo",
        "--json",
        "number",
      ]);
      expect(result.number).toBe(12);
      expect(calls.some((args) => args.includes("repos/owner/repo/pulls/12"))).toBe(true);
      expect(
        calls.some((args) => args.some((arg) => arg.includes("refs%2Fpull%2F12%2Fhead"))),
      ).toBe(false);
    }),
    calls,
    (args) => {
      if (args[0] === "branch") return { stdout: "review-12\n", stderr: "", exitCode: 0 };
      if (args[0] === "config")
        return {
          stdout: args[2]?.endsWith(".merge") ? "refs/pull/12/head\n" : "origin\n",
          stderr: "",
          exitCode: 0,
        };
      if (args[0] === "remote")
        return { stdout: "git@github.com:owner/repo.git\n", stderr: "", exitCode: 0 };
      if (args[3] === "repos/owner/repo/pulls/12") return ok(pull);
      if (args[3]?.includes("/pulls?")) return ok([[]]);
      return undefined;
    },
  );
});
it.effect("verifies the PR before writing a close comment", () => {
  const calls: string[][] = [];
  return provide(
    Effect.gen(function* () {
      const gh = yield* GitHubService;
      const result = yield* gh
        .runGh(["pr", "close", "12", "--comment", "Closing"])
        .pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(calls.some((args) => args.includes("POST"))).toBe(false);
      expect(calls.some((args) => args.includes("PATCH"))).toBe(false);
    }),
    calls,
    (args) => (args.includes("GET") ? failure("HTTP 404 Not Found") : ok({})),
  );
});
it.effect("hydrates mergeability absent from REST list summaries", () =>
  provide(
    Effect.gen(function* () {
      const gh = yield* GitHubService;
      const result = yield* gh.runGhJson<Array<{ mergeable: string }>>([
        "pr",
        "list",
        "--json",
        "number,mergeable",
      ]);
      expect(result[0]?.mergeable).toBe("MERGEABLE");
    }),
    [],
    (args) => {
      if (args[3]?.includes("/pulls?")) {
        const { mergeable: _, ...summary } = pull;
        return ok([[summary]]);
      }
      return ok({ ...pull, mergeable: true });
    },
  ),
);
