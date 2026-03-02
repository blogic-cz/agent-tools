import { Command, Flag } from "effect/unstable/cli";
import { Console, Effect, Option } from "effect";

import { formatOption, logFormatted } from "../shared";
import { GitHubCommandError, GitHubNotFoundError } from "./errors";
import { GitHubService } from "./service";

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

const viewRun = Effect.fn("workflow.viewRun")(function* (runId: number) {
  const gh = yield* GitHubService;

  const run = yield* gh.runGhJson<WorkflowRunDetail>([
    "run",
    "view",
    String(runId),
    "--json",
    "databaseId,displayTitle,status,conclusion,headBranch,createdAt,event,url,workflowName,jobs",
  ]);

  return run;
});

const listJobs = Effect.fn("workflow.listJobs")(function* (runId: number) {
  const gh = yield* GitHubService;

  const run = yield* gh.runGhJson<{
    jobs: WorkflowJob[];
  }>(["run", "view", String(runId), "--json", "jobs"]);

  return run.jobs;
});

const fetchLogs = Effect.fn("workflow.fetchLogs")(function* (
  runId: number,
  failedOnly: boolean,
  jobId: number | null = null,
) {
  const gh = yield* GitHubService;
  const args = ["run", "view", String(runId)];

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

const cancelRun = Effect.fn("workflow.cancelRun")(function* (runId: number) {
  const gh = yield* GitHubService;

  yield* gh.runGh(["run", "cancel", String(runId)]);

  return {
    cancelled: true as const,
    runId,
    message: `Cancelled run ${runId}`,
  };
});

const watchRun = Effect.fn("workflow.watchRun")(function* (runId: number) {
  const gh = yield* GitHubService;

  const result = yield* gh.runGh(["run", "watch", String(runId), "--exit-status"]).pipe(
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
  );

  const finalState = yield* viewRun(runId);

  return {
    runId,
    status: finalState.status,
    conclusion: finalState.conclusion,
    jobs: finalState.jobs.map((job) => ({
      name: job.name,
      status: job.status,
      conclusion: job.conclusion,
    })),
    watchOutput: result.stdout,
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

const resolveJobId = Effect.fn("workflow.resolveJobId")(function* (runId: number, jobName: string) {
  const jobs = yield* listJobs(runId);

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
) {
  const jobs = yield* listJobs(runId);
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
}) {
  const gh = yield* GitHubService;
  const { owner, name: repo } = yield* gh.getRepoInfo();

  const jobId = yield* resolveJobId(opts.runId, opts.job);

  // Fetch raw logs via API (follows 302 redirect automatically)
  const raw = yield* gh.runGh(["api", `repos/${owner}/${repo}/actions/jobs/${jobId}/logs`]).pipe(
    Effect.map((r) => r.stdout),
    Effect.catchTag("GitHubCommandError", () => {
      // Fallback: use gh run view --log --job
      return fetchLogs(opts.runId, false, jobId).pipe(Effect.map((r) => r.log));
    }),
  );

  let entries = parseRawJobLogs(raw);

  if (opts.failedStepsOnly) {
    entries = yield* filterFailedStepEntries(opts.runId, jobId, entries);
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
    repo: Flag.string("repo").pipe(
      Flag.withDescription("Target repository (owner/name). Defaults to current repo"),
      Flag.optional,
    ),
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
      const runs = yield* listRuns({
        branch: Option.getOrNull(branch),
        limit,
        repo: Option.getOrNull(repo),
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
    run: Flag.integer("run").pipe(Flag.withDescription("Workflow run ID")),
  },
  ({ format, run }) =>
    Effect.gen(function* () {
      const detail = yield* viewRun(run);
      yield* logFormatted(detail, format);
    }),
).pipe(Command.withDescription("View workflow run details including jobs and steps"));

export const workflowJobsCommand = Command.make(
  "jobs",
  {
    format: formatOption,
    run: Flag.integer("run").pipe(Flag.withDescription("Workflow run ID")),
  },
  ({ format, run }) =>
    Effect.gen(function* () {
      const jobs = yield* listJobs(run);
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
    run: Flag.integer("run").pipe(Flag.withDescription("Workflow run ID")),
  },
  ({ failedOnly, format, run }) =>
    Effect.gen(function* () {
      const logs = yield* fetchLogs(run, failedOnly);

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
    repo: Flag.string("repo").pipe(
      Flag.withDescription("Target repository (owner/name). Defaults to current repo"),
      Flag.optional,
    ),
    run: Flag.integer("run").pipe(Flag.withDescription("Workflow run ID to rerun")),
  },
  ({ failedOnly, format, repo, run }) =>
    Effect.gen(function* () {
      const result = yield* rerunWorkflow(run, failedOnly, Option.getOrNull(repo));
      yield* logFormatted(result, format);
    }),
).pipe(Command.withDescription("Rerun a workflow run (failed jobs only by default)"));

export const workflowCancelCommand = Command.make(
  "cancel",
  {
    format: formatOption,
    run: Flag.integer("run").pipe(Flag.withDescription("Workflow run ID to cancel")),
  },
  ({ format, run }) =>
    Effect.gen(function* () {
      const result = yield* cancelRun(run);
      yield* logFormatted(result, format);
    }),
).pipe(Command.withDescription("Cancel an in-progress workflow run"));

export const workflowWatchCommand = Command.make(
  "watch",
  {
    format: formatOption,
    run: Flag.integer("run").pipe(Flag.withDescription("Workflow run ID to watch")),
  },
  ({ format, run }) =>
    Effect.gen(function* () {
      const result = yield* watchRun(run);
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
    run: Flag.integer("run").pipe(Flag.withDescription("Workflow run ID")),
  },
  ({ failedStepsOnly, format, job, run }) =>
    Effect.gen(function* () {
      const result = yield* fetchJobLogs({
        runId: run,
        job,
        failedStepsOnly,
        format,
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
