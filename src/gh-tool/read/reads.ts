import { Clock, Effect, Result, Schema } from "effect";
import { GitHubService } from "#gh/read/transport";
import { GitHubCommandError } from "#gh/errors";
import type { CheckRunAnnotation } from "#gh/types";
import { cachedRead, ReadCache } from "./cache";
import { OPS } from "./classes";
import { repoSlug } from "./keys";
import { issueView, issueList, issueComments } from "./issues";
import { prView, prList, prChecks, prHead, checkSignal } from "./pulls";
import { prComments, prReviews, reviewThreads, lastHumanReviewer } from "./reviews";
import { reviewGuards } from "./review-guards";
import type { RepoRef, RunFilter } from "./keys";
import {
  parsePreserving,
  RUN_LIST_FIELDS,
  RUN_VIEW_FIELDS,
  WorkflowRun,
  WorkflowRunDetail,
  WorkflowJob,
} from "./porcelain";

export type JobRef = { readonly id: number; readonly status: string };

const RateLimitResponse = Schema.Struct({
  resources: Schema.Record(
    Schema.String,
    Schema.Struct({
      limit: Schema.Int,
      used: Schema.Int,
      remaining: Schema.Int,
      reset: Schema.Int,
    }),
  ),
});

export type RateLimitResource = {
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
  readonly reset: string;
  readonly secondsUntilReset: number;
};

export type RateLimitSummary = Readonly<Record<string, RateLimitResource>>;
export type PRStatusRateLimit =
  | Readonly<{ core: RateLimitResource; graphql: RateLimitResource }>
  | Readonly<{ error: string }>;

export const getRateLimit = Effect.fn("reads.getRateLimit")(function* (resource?: string) {
  const gh = yield* GitHubService;
  const response = yield* gh.runGhJson<unknown>(["api", "rate_limit"]);
  const parsed = yield* Effect.try({
    try: () => parsePreserving(RateLimitResponse)(response),
    catch: (cause) =>
      new GitHubCommandError({
        message: `GitHub rate-limit response was invalid: ${String(cause)}`,
        command: "gh-tool rate-limit",
        exitCode: 1,
        stderr: String(cause),
      }),
  });
  const names = Object.keys(parsed.resources).toSorted();
  const now = (yield* Clock.currentTimeMillis) / 1000;
  const selected = resource === undefined ? names : [resource];
  const entries: Array<[string, RateLimitResource]> = [];
  for (const name of selected) {
    const bucket = parsed.resources[name];
    if (bucket === undefined) {
      return yield* new GitHubCommandError({
        message: `Unknown rate-limit resource '${name}'. Available resources: ${names.join(", ")}`,
        command: "gh-tool rate-limit",
        exitCode: 1,
        stderr: "",
        hint: "Select a resource returned by GitHub, or omit --resource to show all resources.",
      });
    }
    entries.push([
      name,
      {
        limit: bucket.limit,
        used: bucket.used,
        remaining: bucket.remaining,
        reset: new Date(bucket.reset * 1000).toISOString(),
        secondsUntilReset: Math.max(0, Math.ceil(bucket.reset - now)),
      },
    ]);
  }
  return Object.fromEntries(entries) satisfies RateLimitSummary;
});

export const getPRStatusRateLimit = Effect.fn("reads.getPRStatusRateLimit")(function* () {
  const result = yield* getRateLimit().pipe(Effect.result);
  if (Result.isFailure(result))
    return { error: result.failure.message } satisfies PRStatusRateLimit;

  const { core, graphql } = result.success;
  if (core === undefined || graphql === undefined) {
    return {
      error: "GitHub rate-limit response omitted the core or graphql resource.",
    } satisfies PRStatusRateLimit;
  }
  return { core, graphql } satisfies PRStatusRateLimit;
});

const completedAttemptJobs = Effect.fn("reads.completedAttemptJobs")(function* (
  repo: RepoRef,
  runId: number,
  attempt: number,
) {
  const gh = yield* GitHubService;
  const Job = Schema.Struct({ id: Schema.Number, name: Schema.String });
  const result = yield* cachedRead({
    key: { op: "completedAttemptJobs", repo, runId, attempt },
    policy: OPS.completedAttemptJobs,
    decode: parsePreserving(
      Schema.Struct({ jobs: Schema.mutable(Schema.Array(Job)), completed: Schema.Boolean }),
    ),
    cacheableWhen: (value) => value.completed,
    fetch: () =>
      Effect.gen(function* () {
        const run = yield* gh.runGhJson<{ status?: string }>([
          "api",
          `repos/${repoSlug(repo)}/actions/runs/${runId}/attempts/${attempt}`,
        ]);
        const jobs: Array<typeof Job.Type> = [];
        for (let page = 1; ; page += 1) {
          const response = yield* gh.runGhJson<{ jobs?: Array<typeof Job.Type> }>([
            "api",
            `repos/${repoSlug(repo)}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
          ]);
          if (response.jobs === undefined)
            return yield* new GitHubCommandError({
              command: "attempt jobs",
              exitCode: 0,
              message: "Attempt jobs unavailable",
              stderr: "Attempt jobs unavailable",
            });
          jobs.push(...response.jobs);
          if (response.jobs.length < 100)
            return {
              kind: "fresh" as const,
              value: { jobs, completed: run.status === "completed" },
            };
        }
      }),
  });
  return result.jobs;
});

export const resolveRepo = Effect.fn("reads.resolveRepo")(function* (repo: string | null) {
  if (repo !== null) {
    const [owner, name, extra] = repo.split("/");
    if (owner && name && extra === undefined) return { owner, name };
    return yield* new GitHubCommandError({
      message: `Invalid repository: ${repo}`,
      command: "gh-tool --repo",
      exitCode: 1,
      stderr: "Expected owner/name",
    });
  }
  const gh = yield* GitHubService;
  return yield* gh.getRepoRef();
});

const runList = Effect.fn("reads.runList")(function* (
  repo: RepoRef,
  filter: RunFilter,
  consistency: "cached" | "origin" = "cached",
) {
  const gh = yield* GitHubService;
  const args = [
    "run",
    "list",
    "--repo",
    repoSlug(repo),
    "--json",
    RUN_LIST_FIELDS,
    "--limit",
    String(filter.limit),
  ];
  for (const [flag, value] of [
    ["--workflow", filter.workflow],
    ["--branch", filter.branch],
    ["--status", filter.status],
    ["--event", filter.event],
  ] as const)
    if (value !== null && value !== undefined) args.push(flag, value);
  return yield* cachedRead({
    key: { op: "runList", repo, filter },
    policy: OPS.runList,
    consistency,
    decode: parsePreserving(Schema.Array(WorkflowRun)),
    fetch: () =>
      gh
        .runGhJson<ReadonlyArray<WorkflowRun>>(args)
        .pipe(Effect.map((value) => ({ kind: "fresh" as const, value }))),
  });
});

const runView = Effect.fn("reads.runView")(function* (
  repo: RepoRef,
  runId: number,
  consistency: "cached" | "origin" = "cached",
) {
  const gh = yield* GitHubService;
  const run = yield* cachedRead({
    key: { op: "runView", repo, runId },
    policy: OPS.runView,
    consistency,
    decode: parsePreserving(WorkflowRunDetail),
    policyForValue: (value) =>
      value.status === "completed" ? { kind: "ttl", ttlMs: 300000 } : OPS.runView,
    fetch: () =>
      gh
        .runGhJson<WorkflowRunDetail>([
          "run",
          "view",
          String(runId),
          "--repo",
          repoSlug(repo),
          "--json",
          RUN_VIEW_FIELDS,
        ])
        .pipe(Effect.map((value) => ({ kind: "fresh" as const, value }))),
  });
  if (run.status !== "completed" || consistency === "origin") return run;
  return yield* cachedRead({
    key: { op: "runView", repo, runId, attempt: run.attempt },
    policy: { kind: "immutable" },
    decode: parsePreserving(WorkflowRunDetail),
    fetch: () => Effect.succeed({ kind: "fresh" as const, value: run }),
  });
});

const runJobs = Effect.fn("reads.runJobs")(function* (repo: RepoRef, runId: number) {
  const run = yield* runView(repo, runId);
  return yield* cachedRead({
    key: { op: "runJobs", repo, runId, attempt: run.attempt },
    policy: run.status === "completed" ? { kind: "immutable" } : OPS.runJobs,
    decode: parsePreserving(Schema.Array(WorkflowJob)),
    fetch: () => Effect.succeed({ kind: "fresh" as const, value: run.jobs }),
  });
});

const runLog = Effect.fn("reads.runLog")(function* (
  repo: RepoRef,
  runId: number,
  failedOnly: boolean,
  jobId: number | null,
) {
  const gh = yield* GitHubService;
  const run = yield* runView(repo, runId);
  const args = [
    "run",
    "view",
    String(runId),
    "--repo",
    repoSlug(repo),
    failedOnly ? "--log-failed" : "--log",
    "--attempt",
    String(run.attempt),
  ];
  if (jobId !== null) args.push("--job", String(jobId));
  return yield* cachedRead({
    key: { op: "runLog", repo, runId, attempt: run.attempt, failedOnly, jobId },
    policy: run.status === "completed" ? { kind: "immutable" } : OPS.runLog,
    decode: parsePreserving(Schema.String),
    fetch: () =>
      gh
        .runGh(args)
        .pipe(Effect.map((result) => ({ kind: "fresh" as const, value: result.stdout }))),
  });
});

export const rawJobLog = Effect.fn("reads.rawJobLog")(function* (path: string) {
  const gh = yield* GitHubService;
  return yield* gh
    .runGh(["api", path, "--allow-escape-sequences"])
    .pipe(
      Effect.catchTag("GitHubCommandError", (error) =>
        `${error.stderr}${error.message}`.includes("unknown flag: --allow-escape-sequences")
          ? gh.runGh(["api", path])
          : Effect.fail(error),
      ),
    );
});
const jobLog = Effect.fn("reads.jobLog")(function* (repo: RepoRef, job: JobRef) {
  return yield* cachedRead({
    key: { op: "jobLog", repo, jobId: job.id },
    policy: job.status === "completed" ? { kind: "immutable" } : OPS.jobLog,
    decode: parsePreserving(Schema.String),
    fetch: () =>
      rawJobLog(`repos/${repoSlug(repo)}/actions/jobs/${job.id}/logs`).pipe(
        Effect.map((result) => ({ kind: "fresh" as const, value: result.stdout })),
      ),
  });
});

const Annotation = Schema.Struct({
  path: Schema.String,
  start_line: Schema.Number,
  end_line: Schema.Number,
  start_column: Schema.NullOr(Schema.Number),
  end_column: Schema.NullOr(Schema.Number),
  annotation_level: Schema.Literals(["notice", "warning", "failure"]),
  message: Schema.String,
  title: Schema.NullOr(Schema.String),
  raw_details: Schema.NullOr(Schema.String),
});
const annotations = Effect.fn("reads.annotations")(function* (repo: RepoRef, job: JobRef) {
  const gh = yield* GitHubService;
  return yield* cachedRead({
    key: { op: "annotations", repo, jobId: job.id },
    policy: job.status === "completed" ? { kind: "immutable" } : OPS.annotations,
    decode: parsePreserving(Schema.Array(Annotation)),
    fetch: () =>
      gh
        .runGhJson<ReadonlyArray<CheckRunAnnotation>>([
          "api",
          `repos/${repoSlug(repo)}/check-runs/${job.id}/annotations`,
          "--paginate",
        ])
        .pipe(Effect.map((value) => ({ kind: "fresh" as const, value }))),
  });
});

const JobIdentity = Schema.NullOr(Schema.Struct({ runId: Schema.Number, attempt: Schema.Number }));
const jobIdentity = Effect.fn("reads.jobIdentity")(function* (repo: RepoRef, jobId: number) {
  const gh = yield* GitHubService;
  const session = yield* ReadCache;
  const path = `repos/${repoSlug(repo)}/actions/jobs/${jobId}`;
  return yield* cachedRead({
    key: { op: "jobIdentity", repo, jobId },
    policy: OPS.jobIdentity,
    decode: parsePreserving(JobIdentity),
    fetch: () =>
      (session === null || session.store === null
        ? gh.runGhJson<{ run_id: number; run_attempt: number }>(["api", path])
        : gh
            .apiRequest<{ run_id: number; run_attempt: number }>({ path })
            .pipe(Effect.map((response) => response.body))
      ).pipe(
        Effect.flatMap((job) =>
          Effect.try({
            try: () =>
              Schema.decodeUnknownSync(JobIdentity)({
                runId: job.run_id,
                attempt: job.run_attempt,
              }),
            catch: (error) =>
              new GitHubCommandError({
                command: `GET ${path}`,
                exitCode: 0,
                message: String(error),
                stderr: String(error),
              }),
          }),
        ),
        Effect.catchTag("GitHubNotFoundError", () => Effect.succeed(null)),
        Effect.map((value) => ({ kind: "fresh" as const, value })),
      ),
  });
});

export const reads = {
  getRateLimit,
  getPRStatusRateLimit,
  completedAttemptJobs,
  jobIdentity,
  reviewGuards,
  prComments,
  prReviews,
  reviewThreads,
  lastHumanReviewer,
  prView,
  prList,
  prChecks,
  prHead,
  checkSignal,
  runList,
  runView,
  runJobs,
  runLog,
  jobLog,
  annotations,
  issueView,
  issueList,
  issueComments,
};
