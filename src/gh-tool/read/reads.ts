import { Effect, Schema } from "effect";
import { GitHubService } from "#gh/service";
import { GitHubCommandError } from "#gh/errors";
import type { CheckRunAnnotation } from "#gh/types";
import { cachedRead } from "./cache";
import { OPS } from "./classes";
import { repoSlug } from "./keys";
import { issueView, issueList, issueComments } from "./issues";
import { prView, prList, prChecks } from "./pulls";
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
  const info = yield* gh.getRepoInfo();
  return { owner: info.owner, name: info.name };
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

const runView = Effect.fn("reads.runView")(function* (repo: RepoRef, runId: number) {
  const gh = yield* GitHubService;
  return yield* cachedRead({
    key: { op: "runView", repo, runId },
    policy: OPS.runView,
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

export const reads = {
  prView,
  prList,
  prChecks,
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
