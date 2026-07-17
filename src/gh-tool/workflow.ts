import { Command, Flag, Param } from "effect/unstable/cli";
import { Console, Effect, Option } from "effect";

import { formatOption, logFormatted } from "#shared";
import { CI_CHECK_WATCH_TIMEOUT_MS } from "#gh/config";
import { GitHubCommandError, GitHubNotFoundError } from "./errors";
import { GitHubService } from "./service";
import type { CheckRunAnnotation, JobAnnotations } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type WorkflowRun = {
  databaseId: number;
  displayTitle: string;
  status: string;
  conclusion: string | null;
  headBranch: string;
  createdAt: string;
  event: string;
  url: string;
  workflowName: string;
};

type WorkflowJob = {
  databaseId: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string;
  completedAt: string | null;
  url: string;
  steps: Array<{
    name: string;
    status: string;
    conclusion: string | null;
    number: number;
    startedAt: string | null;
    completedAt: string | null;
  }>;
};

type WorkflowRunDetail = WorkflowRun & {
  jobs: WorkflowJob[];
};

type LogEntry = {
  step: string;
  message: string;
};

const repoOption = Flag.string("repo").pipe(
  Flag.withDescription("Target repository profile name or owner/name. Defaults to current repo"),
  Flag.optional,
);

const resolveRepoArg = Effect.fn("workflow.resolveRepoArg")(function* (
  repo: Option.Option<string>,
) {
  const target = Option.getOrNull(repo);
  if (target === null) {
    return null;
  }

  const gh = yield* GitHubService;
  const info = yield* gh.withRepoTarget(target, gh.getRepoInfo());
  return `${info.owner}/${info.name}`;
});
// ---------------------------------------------------------------------------
// Internal handlers
// ---------------------------------------------------------------------------

const listRuns = Effect.fn("workflow.listRuns")(function* (opts: {
  workflow: string | null;
  branch: string | null;
  status: string | null;
  limit: number;
  repo: string | null;
}) {
  const gh = yield* GitHubService;

  const args = [
    "run",
    "list",
    "--json",
    "databaseId,displayTitle,status,conclusion,headBranch,createdAt,event,url,workflowName",
    "--limit",
    String(opts.limit),
  ];

  if (opts.repo !== null) {
    args.push("--repo", opts.repo);
  }

  if (opts.workflow !== null) {
    args.push("--workflow", opts.workflow);
  }

  if (opts.branch !== null) {
    args.push("--branch", opts.branch);
  }

  if (opts.status !== null) {
    args.push("--status", opts.status);
  }

  return yield* gh.runGhJson<WorkflowRun[]>(args);
});

const viewRun = Effect.fn("workflow.viewRun")(function* (runId: number, repo: string | null) {
  const gh = yield* GitHubService;

  const args = [
    "run",
    "view",
    String(runId),
    "--json",
    "databaseId,displayTitle,status,conclusion,headBranch,createdAt,event,url,workflowName,jobs",
  ];
  if (repo !== null) {
    args.push("--repo", repo);
  }

  return yield* gh.runGhJson<WorkflowRunDetail>(args);
});

const listJobs = Effect.fn("workflow.listJobs")(function* (runId: number, repo: string | null) {
  const gh = yield* GitHubService;

  const args = ["run", "view", String(runId), "--json", "jobs"];
  if (repo !== null) {
    args.push("--repo", repo);
  }

  const run = yield* gh.runGhJson<{
    jobs: WorkflowJob[];
  }>(args);

  return run.jobs;
});

const fetchLogs = Effect.fn("workflow.fetchLogs")(function* (
  runId: number,
  failedOnly: boolean,
  jobId: number | null = null,
  repo: string | null = null,
) {
  const gh = yield* GitHubService;
  const args = ["run", "view", String(runId)];

  if (repo !== null) {
    args.push("--repo", repo);
  }

  if (jobId !== null) {
    args.push("--log", "--job", String(jobId));
  } else if (failedOnly) {
    args.push("--log-failed");
  } else {
    args.push("--log");
  }

  const result = yield* gh.runGh(args);
  return {
    runId,
    failedOnly,
    log: result.stdout,
  };
});

const rerunWorkflow = Effect.fn("workflow.rerunWorkflow")(function* (
  runId: number,
  failedOnly: boolean,
  repo: string | null,
) {
  const gh = yield* GitHubService;

  const args = ["run", "rerun", String(runId)];
  if (failedOnly) {
    args.push("--failed");
  }
  if (repo !== null) {
    args.push("--repo", repo);
  }

  yield* gh.runGh(args);

  return {
    rerun: true as const,
    runId,
    failedOnly,
    message: failedOnly
      ? `Rerunning failed jobs for run ${runId}`
      : `Rerunning all jobs for run ${runId}`,
  };
});

const cancelRun = Effect.fn("workflow.cancelRun")(function* (runId: number, repo: string | null) {
  const gh = yield* GitHubService;

  const args = ["run", "cancel", String(runId)];
  if (repo !== null) {
    args.push("--repo", repo);
  }

  yield* gh.runGh(args);

  return {
    cancelled: true as const,
    runId,
    message: `Cancelled run ${runId}`,
  };
});

export const dispatchWorkflow = Effect.fn("workflow.dispatchWorkflow")(function* (opts: {
  workflow: string;
  ref: string;
  fields: ReadonlyArray<string>;
  repo: string | null;
}) {
  const gh = yield* GitHubService;
  const args = ["workflow", "run", opts.workflow, "--ref", opts.ref];

  if (opts.repo !== null) {
    args.push("--repo", opts.repo);
  }

  for (const field of opts.fields) {
    args.push("-f", field);
  }

  yield* gh.runGh(args);

  return {
    dispatched: true as const,
    workflow: opts.workflow,
    ref: opts.ref,
    repo: opts.repo,
    fields: opts.fields,
  };
});

// `gh run watch` has no native timeout (observed hanging 36 min). Block for the caller's --timeout,
// then fall back to a one-shot snapshot so a timeout never returns nothing.
const DEFAULT_WATCH_RUN_TIMEOUT_SECONDS = CI_CHECK_WATCH_TIMEOUT_MS / 1000;

const watchRun = Effect.fn("workflow.watchRun")(function* (
  runId: number,
  repo: string | null,
  timeoutSeconds: number,
  frames: boolean,
) {
  const gh = yield* GitHubService;

  const watchArgs = ["run", "watch", String(runId), "--exit-status"];
  if (repo !== null) {
    watchArgs.push("--repo", repo);
  }

  const result = yield* gh.runGh(watchArgs).pipe(
    Effect.catchTag("GitHubCommandError", (error) => {
      // exit-status returns non-zero if run failed, but we still want the output
      if (error.exitCode > 0 && error.stderr === "") {
        return Effect.succeed({
          stdout: "",
          stderr: "",
          exitCode: error.exitCode,
        });
      }
      return Effect.fail(error);
    }),
    Effect.timeoutOrElse({
      duration: timeoutSeconds * 1000,
      orElse: () => Effect.succeed(null),
    }),
  );

  const finalState = yield* viewRun(runId, repo);

  const timedOutNote = `(watch timed out after ${timeoutSeconds}s; status taken from snapshot — re-run to keep watching)`;

  return {
    runId,
    status: finalState.status,
    conclusion: finalState.conclusion,
    jobs: finalState.jobs.map((job) => ({
      name: job.name,
      status: job.status,
      conclusion: job.conclusion,
    })),
    ...(result === null
      ? { watchOutput: timedOutNote }
      : frames
        ? { watchOutput: result.stdout }
        : {}),
  };
});

const fetchAnnotations = Effect.fn("workflow.fetchAnnotations")(function* (opts: {
  runId: number;
  job: string | null;
  repo: string | null;
}) {
  const gh = yield* GitHubService;

  let owner: string;
  let repoName: string;
  if (opts.repo !== null) {
    const parts = opts.repo.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return yield* new GitHubCommandError({
        message: `Invalid --repo format: "${opts.repo}". Expected "owner/name" (e.g. "blogic-cz/agent-tools").`,
        command: "workflow annotations",
        exitCode: 1,
        stderr: "",
      });
    }
    owner = parts[0];
    repoName = parts[1];
  } else {
    const info = yield* gh.getRepoInfo();
    owner = info.owner;
    repoName = info.name;
  }

  const jobs = yield* listJobs(opts.runId, opts.repo);

  let targetJobs = jobs;
  if (opts.job !== null) {
    const jobId = yield* resolveJobId(opts.runId, opts.job, opts.repo);
    targetJobs = jobs.filter((j) => j.databaseId === jobId);
  }

  const results: JobAnnotations[] = [];
  for (const job of targetJobs) {
    const annotations = yield* gh
      .runGhJson<CheckRunAnnotation[]>([
        "api",
        `repos/${owner}/${repoName}/check-runs/${job.databaseId}/annotations`,
        "--paginate",
      ])
      .pipe(
        Effect.catchTag("GitHubCommandError", () => Effect.succeed([] as CheckRunAnnotation[])),
      );

    if (annotations.length > 0) {
      results.push({
        jobId: job.databaseId,
        jobName: job.name,
        annotations,
      });
    }
  }

  return {
    runId: opts.runId,
    totalAnnotations: results.reduce((sum, r) => sum + r.annotations.length, 0),
    jobs: results,
  };
});

// ---------------------------------------------------------------------------
// Log parsing utilities (pure functions)
// ---------------------------------------------------------------------------

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function cleanLogLine(line: string): string {
  return line
    .replace(ANSI_RE, "")
    .replace(TIMESTAMP_RE, "")
    .replace(/\r$/, "")
    .replace(/^##\[(command|debug|notice)\]/, "")
    .trim();
}

export function parseRawJobLogs(raw: string): LogEntry[] {
  const entries: LogEntry[] = [];
  let currentStep = "(unknown)";

  for (const rawLine of raw.split("\n")) {
    const line = rawLine.replace(/\r$/, "");

    // Step group markers
    const groupMatch = line.match(/##\[group\](.+)/);
    if (groupMatch) {
      currentStep = groupMatch[1].trim();
      continue;
    }
    if (line.includes("##[endgroup]")) continue;

    const cleaned = cleanLogLine(line);
    if (cleaned.length === 0) continue;

    entries.push({ step: currentStep, message: cleaned });
  }

  return entries;
}

export function formatLogEntries(entries: LogEntry[]): string {
  const sections: string[] = [];
  let lastStep = "";

  for (const entry of entries) {
    if (entry.step !== lastStep) {
      sections.push(`\n=== ${entry.step} ===`);
      lastStep = entry.step;
    }
    sections.push(entry.message);
  }

  return sections.join("\n").trim();
}

// ---------------------------------------------------------------------------
// Job-level log handlers
// ---------------------------------------------------------------------------

const resolveJobId = Effect.fn("workflow.resolveJobId")(function* (
  runId: number,
  jobName: string,
  repo: string | null,
) {
  const jobs = yield* listJobs(runId, repo);

  // Exact match first
  const exact = jobs.find((j) => j.name === jobName);
  if (exact) return exact.databaseId;

  // Case-insensitive partial match
  const lower = jobName.toLowerCase();
  const partial = jobs.filter((j) => j.name.toLowerCase().includes(lower));

  if (partial.length === 1) return partial[0].databaseId;

  if (partial.length > 1) {
    return yield* new GitHubCommandError({
      message: `Ambiguous job name "${jobName}". Matches: ${partial.map((j) => j.name).join(", ")}`,
      command: "workflow job-logs",
      exitCode: 1,
      stderr: "",
      hint: `Multiple jobs match "${jobName}". Use the exact job name from the list above.`,
      nextCommand: `agent-tools-gh workflow jobs --run ${runId}`,
    });
  }

  return yield* new GitHubNotFoundError({
    message: `Job "${jobName}" not found in run ${runId}. Available jobs: ${jobs.map((j) => j.name).join(", ")}`,
    identifier: jobName,
    resource: "job",
    hint: "Use one of the available job names listed above. Run the jobs command to see all jobs.",
    nextCommand: `agent-tools-gh workflow jobs --run ${runId}`,
  });
});

const filterFailedStepEntries = Effect.fn("workflow.filterFailedStepEntries")(function* (
  runId: number,
  jobId: number,
  entries: LogEntry[],
  repo: string | null,
) {
  const jobs = yield* listJobs(runId, repo);
  const job = jobs.find((j) => j.databaseId === jobId);
  if (!job) return entries;

  const failedStepNames = new Set(
    job.steps.filter((s) => s.conclusion === "failure").map((s) => s.name),
  );

  if (failedStepNames.size === 0) return entries;

  return entries.filter((e) => failedStepNames.has(e.step));
});

const fetchJobLogs = Effect.fn("workflow.fetchJobLogs")(function* (opts: {
  runId: number;
  job: string;
  failedStepsOnly: boolean;
  format: string;
  repo: string | null;
}) {
  const gh = yield* GitHubService;

  let owner: string;
  let repoName: string;
  if (opts.repo !== null) {
    const parts = opts.repo.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return yield* new GitHubCommandError({
        message: `Invalid --repo format: "${opts.repo}". Expected "owner/name" (e.g. "blogic-cz/agent-tools").`,
        command: "workflow job-logs",
        exitCode: 1,
        stderr: "",
      });
    }
    owner = parts[0];
    repoName = parts[1];
  } else {
    const info = yield* gh.getRepoInfo();
    owner = info.owner;
    repoName = info.name;
  }

  const jobId = yield* resolveJobId(opts.runId, opts.job, opts.repo);

  // Fetch raw logs via API (follows 302 redirect automatically)
  const raw = yield* gh
    .runGh(["api", `repos/${owner}/${repoName}/actions/jobs/${jobId}/logs`])
    .pipe(
      Effect.map((r) => r.stdout),
      Effect.catchTag("GitHubCommandError", () => {
        // Fallback: use gh run view --log --job
        return fetchLogs(opts.runId, false, jobId, opts.repo).pipe(Effect.map((r) => r.log));
      }),
    );

  let entries = parseRawJobLogs(raw);

  if (opts.failedStepsOnly) {
    entries = yield* filterFailedStepEntries(opts.runId, jobId, entries, opts.repo);
  }

  if (opts.format === "json") {
    return {
      runId: opts.runId,
      job: opts.job,
      jobId,
      entries,
    };
  }

  return {
    runId: opts.runId,
    job: opts.job,
    jobId,
    formatted: formatLogEntries(entries),
  };
});

// ---------------------------------------------------------------------------
// CLI Commands
// ---------------------------------------------------------------------------

export const workflowListCommand = Command.make(
  "list",
  {
    branch: Flag.string("branch").pipe(
      Flag.withDescription("Filter by branch name"),
      Flag.optional,
    ),
    format: formatOption,
    limit: Flag.integer("limit").pipe(
      Flag.withDescription("Maximum number of runs to return"),
      Flag.withDefault(10),
    ),
    repo: repoOption,
    status: Flag.choice("status", [
      "queued",
      "in_progress",
      "completed",
      "action_required",
      "cancelled",
      "failure",
      "neutral",
      "skipped",
      "stale",
      "success",
      "timed_out",
      "waiting",
    ]).pipe(Flag.withDescription("Filter by run status"), Flag.optional),
    workflow: Flag.string("workflow").pipe(
      Flag.withDescription("Filter by workflow file name (e.g., build-and-deploy.yml)"),
      Flag.optional,
    ),
  },
  ({ branch, format, limit, repo, status, workflow }) =>
    Effect.gen(function* () {
      const resolvedRepo = yield* resolveRepoArg(repo);
      const runs = yield* listRuns({
        branch: Option.getOrNull(branch),
        limit,
        repo: resolvedRepo,
        status: Option.getOrNull(status),
        workflow: Option.getOrNull(workflow),
      });
      yield* logFormatted(runs, format);
    }),
).pipe(
  Command.withDescription("List workflow runs (filter by --workflow, --branch, --status, --repo)"),
);

export const workflowViewCommand = Command.make(
  "view",
  {
    format: formatOption,
    repo: repoOption,
    run: Flag.integer("run").pipe(Flag.withDescription("Workflow run ID")),
  },
  ({ format, repo, run }) =>
    Effect.gen(function* () {
      const resolvedRepo = yield* resolveRepoArg(repo);
      const detail = yield* viewRun(run, resolvedRepo);
      yield* logFormatted(detail, format);
    }),
).pipe(Command.withDescription("View workflow run details including jobs and steps"));

export const workflowJobsCommand = Command.make(
  "jobs",
  {
    format: formatOption,
    repo: repoOption,
    run: Flag.integer("run").pipe(Flag.withDescription("Workflow run ID")),
  },
  ({ format, repo, run }) =>
    Effect.gen(function* () {
      const resolvedRepo = yield* resolveRepoArg(repo);
      const jobs = yield* listJobs(run, resolvedRepo);
      yield* logFormatted(jobs, format);
    }),
).pipe(Command.withDescription("List jobs and their steps for a workflow run"));

export const workflowLogsCommand = Command.make(
  "logs",
  {
    failedOnly: Flag.boolean("failed-only").pipe(
      Flag.withDescription("Only show logs from failed jobs (default: true)"),
      Flag.withDefault(true),
    ),
    format: formatOption,
    repo: repoOption,
    run: Flag.integer("run").pipe(Flag.withDescription("Workflow run ID")),
  },
  ({ failedOnly, format, repo, run }) =>
    Effect.gen(function* () {
      const resolvedRepo = yield* resolveRepoArg(repo);
      const logs = yield* fetchLogs(run, failedOnly, null, resolvedRepo);

      if (format === "toon" || format === "json") {
        yield* logFormatted(logs, format);
      } else {
        yield* Console.log(logs.log);
      }
    }),
).pipe(Command.withDescription("Fetch logs for a workflow run (--failed-only by default)"));

export const workflowRerunCommand = Command.make(
  "rerun",
  {
    failedOnly: Flag.boolean("failed-only").pipe(
      Flag.withDescription("Only rerun failed jobs (default: true)"),
      Flag.withDefault(true),
    ),
    format: formatOption,
    repo: repoOption,
    run: Flag.integer("run").pipe(Flag.withDescription("Workflow run ID to rerun")),
  },
  ({ failedOnly, format, repo, run }) =>
    Effect.gen(function* () {
      const resolvedRepo = yield* resolveRepoArg(repo);
      const result = yield* rerunWorkflow(run, failedOnly, resolvedRepo);
      yield* logFormatted(result, format);
    }),
).pipe(Command.withDescription("Rerun a workflow run (failed jobs only by default)"));

export const workflowCancelCommand = Command.make(
  "cancel",
  {
    format: formatOption,
    repo: repoOption,
    run: Flag.integer("run").pipe(Flag.withDescription("Workflow run ID to cancel")),
  },
  ({ format, repo, run }) =>
    Effect.gen(function* () {
      const resolvedRepo = yield* resolveRepoArg(repo);
      const result = yield* cancelRun(run, resolvedRepo);
      yield* logFormatted(result, format);
    }),
).pipe(Command.withDescription("Cancel an in-progress workflow run"));

export const workflowRunCommand = Command.make(
  "run",
  {
    field: Param.variadic(
      Param.string(Param.flagKind, "field").pipe(
        Param.withAlias("f"),
        Param.withDescription("Workflow input as key=value; may be repeated"),
      ),
    ),
    format: formatOption,
    ref: Flag.string("ref").pipe(
      Flag.withDescription("Git ref to run the workflow on (branch, tag, or SHA)"),
    ),
    repo: repoOption,
    workflow: Flag.string("workflow").pipe(
      Flag.withDescription("Workflow file name (e.g., build.yml) or workflow ID"),
    ),
  },
  ({ field, format, ref, repo, workflow }) =>
    Effect.gen(function* () {
      const resolvedRepo = yield* resolveRepoArg(repo);
      const result = yield* dispatchWorkflow({
        workflow,
        ref,
        fields: field,
        repo: resolvedRepo,
      });
      yield* logFormatted(result, format);
    }),
).pipe(Command.withDescription("Dispatch a workflow_dispatch workflow run"));

export const workflowWatchCommand = Command.make(
  "watch",
  {
    format: formatOption,
    frames: Flag.boolean("frames").pipe(
      Flag.withDescription(
        "Include the raw watch progress frames (large); omitted by default — final status/conclusion/jobs are always returned",
      ),
    ),
    repo: repoOption,
    run: Flag.integer("run").pipe(Flag.withDescription("Workflow run ID to watch")),
    timeout: Flag.integer("timeout").pipe(
      Flag.withDescription(
        `Max seconds to block before returning a snapshot (default: ${DEFAULT_WATCH_RUN_TIMEOUT_SECONDS}, minimum 1)`,
      ),
      Flag.withDefault(DEFAULT_WATCH_RUN_TIMEOUT_SECONDS),
      Flag.filter(
        (n) => n >= 1,
        () => "--timeout must be at least 1 second",
      ),
    ),
  },
  ({ format, frames, repo, run, timeout }) =>
    Effect.gen(function* () {
      const resolvedRepo = yield* resolveRepoArg(repo);
      const result = yield* watchRun(run, resolvedRepo, timeout, frames);
      yield* logFormatted(result, format);
    }),
).pipe(Command.withDescription("Watch a workflow run until it completes, then show final status"));

export const workflowJobLogsCommand = Command.make(
  "job-logs",
  {
    failedStepsOnly: Flag.boolean("failed-steps-only").pipe(
      Flag.withDescription("Only show logs from failed steps (default: false)"),
      Flag.withDefault(false),
    ),
    format: formatOption,
    job: Flag.string("job").pipe(
      Flag.withDescription("Job name to fetch logs for (exact or partial match)"),
    ),
    repo: repoOption,
    run: Flag.integer("run").pipe(Flag.withDescription("Workflow run ID")),
  },
  ({ failedStepsOnly, format, job, repo, run }) =>
    Effect.gen(function* () {
      const resolvedRepo = yield* resolveRepoArg(repo);
      const result = yield* fetchJobLogs({
        runId: run,
        job,
        failedStepsOnly,
        format,
        repo: resolvedRepo,
      });

      if ("formatted" in result) {
        yield* Console.log(result.formatted);
      } else {
        yield* logFormatted(result, format);
      }
    }),
).pipe(
  Command.withDescription(
    "Fetch parsed, clean logs for a specific job in a workflow run. Resolves job name to ID, strips timestamps/ANSI, groups by step.",
  ),
);

export const workflowAnnotationsCommand = Command.make(
  "annotations",
  {
    format: formatOption,
    job: Flag.string("job").pipe(
      Flag.withDescription("Filter to a specific job name (exact or partial match)"),
      Flag.optional,
    ),
    repo: repoOption,
    run: Flag.integer("run").pipe(Flag.withDescription("Workflow run ID")),
  },
  ({ format, job, repo, run }) =>
    Effect.gen(function* () {
      const resolvedRepo = yield* resolveRepoArg(repo);
      const result = yield* fetchAnnotations({
        runId: run,
        job: Option.getOrNull(job),
        repo: resolvedRepo,
      });
      yield* logFormatted(result, format);
    }),
).pipe(
  Command.withDescription(
    "List annotations (errors, warnings, notices) from check runs in a workflow run. Shows problem matcher output, test failures, and other CI annotations.",
  ),
);
