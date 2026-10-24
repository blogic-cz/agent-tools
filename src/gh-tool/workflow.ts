import { Command, Flag, Param } from "effect/cli";
import { Effect, Option } from "effect";

import { formatOption, logFormatted, logText } from "#shared";
import { CI_CHECK_WATCH_TIMEOUT_MS } from "#gh/config";
import { GitHubCommandError, GitHubNotFoundError, GitHubTimeoutError } from "./errors";
import { GitHubService } from "./read/transport";
import { reads, resolveRepo, waits, writes } from "./read";
import { rawJobLog } from "./read/reads";
import type { JobRef } from "./read/reads";
import { repoSlug } from "./read/keys";
import type { CheckRunAnnotation, JobAnnotations, LogDiagnosis } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogEntry = {
  step: string;
  message: string;
};

const repoOption = Flag.String("repo").pipe(
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
  if (/^[^/\s]+\/[^/\s]+$/.test(target)) return target;

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
  const repo = yield* resolveRepo(opts.repo);
  const runs = yield* reads.runList(repo, {
    workflow: opts.workflow,
    branch: opts.branch,
    status: opts.status,
    event: null,
    limit: opts.limit,
  });
  return runs.map(({ headSha: _headSha, workflowDatabaseId, ...run }) => {
    if (run.conclusion !== "cancelled") return run;
    const newer = runs
      .filter(
        (candidate) =>
          workflowDatabaseId !== undefined &&
          workflowDatabaseId !== null &&
          workflowDatabaseId > 0 &&
          candidate.workflowDatabaseId === workflowDatabaseId &&
          run.headBranch.length > 0 &&
          candidate.headBranch === run.headBranch &&
          candidate.event === run.event &&
          candidate.databaseId !== run.databaseId &&
          Date.parse(candidate.createdAt) > Date.parse(run.createdAt),
      )
      .toSorted(
        (left, right) =>
          Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
          right.databaseId - left.databaseId,
      )[0];
    return Object.assign(
      run,
      { cancellationReason: "unknown" },
      newer === undefined
        ? {}
        : {
            newerRun: {
              databaseId: newer.databaseId,
              status: newer.status,
              conclusion: newer.conclusion,
              url: newer.url,
              context:
                "Newer run in this list with the same workflow, branch and event. The cancellation reason is unknown.",
            },
          },
    );
  });
});

const viewRun = Effect.fn("workflow.viewRun")(function* (runId: number, repo: string | null) {
  const target = yield* resolveRepo(repo);
  const detail = yield* reads.runView(target, runId);
  const {
    attempt: _attempt,
    headSha: _headSha,
    workflowDatabaseId: _workflowDatabaseId,
    ...snapshot
  } = detail;
  return snapshot;
});

const listJobs = Effect.fn("workflow.listJobs")(function* (runId: number, repo: string | null) {
  return yield* reads.runJobs(yield* resolveRepo(repo), runId);
});

const fetchLogs = Effect.fn("workflow.fetchLogs")(function* (
  runId: number,
  failedOnly: boolean,
  jobId: number | null = null,
  repo: string | null = null,
) {
  const log = yield* reads.runLog(yield* resolveRepo(repo), runId, failedOnly, jobId);
  return {
    runId,
    failedOnly,
    log,
  };
});

export const rerunWorkflow = Effect.fn("workflow.rerunWorkflow")(function* (
  runId: number,
  failedOnly: boolean,
  repo: string | null,
) {
  const args = ["run", "rerun", String(runId)];
  if (failedOnly) {
    args.push("--failed");
  }
  if (repo !== null) {
    args.push("--repo", repo);
  }

  const target = yield* resolveRepo(repo);
  yield* writes.run(args, [`repo:${repoSlug(target)}`]);

  return {
    rerun: true as const,
    runId,
    failedOnly,
    message: failedOnly
      ? `Rerunning failed jobs for run ${runId}`
      : `Rerunning all jobs for run ${runId}`,
  };
});

export const cancelRun = Effect.fn("workflow.cancelRun")(function* (
  runId: number,
  repo: string | null,
) {
  const args = ["run", "cancel", String(runId)];
  if (repo !== null) {
    args.push("--repo", repo);
  }

  const target = yield* resolveRepo(repo);
  yield* writes.run(args, [`repo:${repoSlug(target)}`]);

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
  const args = ["workflow", "run", opts.workflow, "--ref", opts.ref];

  if (opts.repo !== null) {
    args.push("--repo", opts.repo);
  }

  for (const field of opts.fields) {
    args.push("-f", field);
  }

  const target = yield* resolveRepo(opts.repo);
  yield* writes.run(args, [`repo:${repoSlug(target)}`]);

  return {
    dispatched: true as const,
    workflow: opts.workflow,
    ref: opts.ref,
    repo: opts.repo,
    fields: opts.fields,
  };
});

export type DispatchedRun = {
  databaseId: number;
  headSha: string;
  status: string;
  conclusion: string | null;
  url: string;
};

const DISPATCH_DISCOVERY_BUDGET_MS = 16_000;
const DISPATCH_DISCOVERY_INTERVAL_MS = 5000;

export const listDispatchedRuns = Effect.fn("workflow.listDispatchedRuns")(function* (opts: {
  workflow: string;
  ref: string;
  repo: string | null;
}) {
  const repo = yield* resolveRepo(opts.repo);
  return yield* reads
    .runList(
      repo,
      {
        workflow: opts.workflow,
        branch: opts.ref,
        status: null,
        event: "workflow_dispatch",
        limit: 20,
      },
      "origin",
    )
    .pipe(
      Effect.map((runs) =>
        runs.map((run) => ({
          conclusion: run.conclusion,
          databaseId: run.databaseId,
          headSha: run.headSha,
          status: run.status,
          url: run.url,
        })),
      ),
    )
    .pipe(Effect.catchTag("GitHubCommandError", () => Effect.succeed<DispatchedRun[]>([])));
});

// `gh workflow run` and the REST dispatch endpoint both return an empty body — there is no
// dispatch-to-run mapping. Polling the run list for an id absent before the dispatch is the only
// way to name the run we just created, and an unnamed run cannot be watched or verified.
export const discoverDispatchedRun = Effect.fn("workflow.discoverDispatchedRun")(function* (opts: {
  workflow: string;
  ref: string;
  repo: string | null;
  knownRunIds: ReadonlySet<number>;
}) {
  const outcome = yield* waits.until(
    listDispatchedRuns(opts),
    (runs) => runs.some((run) => !opts.knownRunIds.has(run.databaseId)),
    { intervalMs: DISPATCH_DISCOVERY_INTERVAL_MS, timeoutMs: DISPATCH_DISCOVERY_BUDGET_MS },
  );
  const runs = outcome.kind === "done" ? outcome.value : outcome.last;
  return runs.find((run) => !opts.knownRunIds.has(run.databaseId)) ?? null;
});

// `gh run watch` has no native timeout (observed hanging 36 min). Block for the caller's --timeout,
// then fall back to a one-shot snapshot so a timeout never returns nothing.
const DEFAULT_WATCH_RUN_TIMEOUT_SECONDS = CI_CHECK_WATCH_TIMEOUT_MS / 1000;

export const buildWatchResult = (
  runId: number,
  finalState: {
    status: string;
    conclusion: string | null;
    jobs: ReadonlyArray<{ name: string; status: string; conclusion: string | null }>;
  },
  watchStdout: string | null,
  frames: boolean,
  timeoutSeconds: number,
) => ({
  runId,
  status: finalState.status,
  conclusion: finalState.conclusion,
  jobs: finalState.jobs.map((job) => ({
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
  })),
  ...(watchStdout === null
    ? {
        watchOutput: `(watch timed out after ${timeoutSeconds}s; status taken from snapshot — re-run to keep watching)`,
      }
    : frames
      ? { watchOutput: watchStdout }
      : {}),
});

const watchRun = Effect.fn("workflow.watchRun")(function* (
  runId: number,
  repo: string | null,
  timeoutSeconds: number,
  frames: boolean,
) {
  const target = yield* resolveRepo(repo);
  const progress: string[] = [];
  let previous = "";
  const outcome = yield* waits.until(
    reads.runView(target, runId),
    (run) => run.status === "completed",
    {
      intervalMs: 5000,
      timeoutMs: timeoutSeconds * 1000,
      onValue: (run) =>
        Effect.sync(() => {
          const frame = `${run.status} ${run.conclusion ?? ""}\n${run.jobs.map((job) => `${job.name}: ${job.status} ${job.conclusion ?? ""}`).join("\n")}`;
          if (frames && frame !== previous) progress.push(frame);
          previous = frame;
        }),
    },
  );
  const finalState = outcome.kind === "done" ? outcome.value : outcome.last;

  return {
    kind: outcome.kind,
    result: buildWatchResult(
      runId,
      finalState,
      outcome.kind === "timedOut" ? null : progress.join("\n"),
      frames,
      timeoutSeconds,
    ),
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
        message: `Invalid --repo format: "${opts.repo}". Expected "owner/name" (e.g. "example-org/example-repo").`,
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
    const selected = yield* resolveJob(opts.runId, opts.job, opts.repo);
    targetJobs = jobs.filter((j) => j.databaseId === selected.databaseId);
  }

  const results: JobAnnotations[] = [];
  for (const job of targetJobs) {
    const annotations = yield* reads
      .annotations({ owner, name: repoName }, { id: job.databaseId, status: job.status })
      .pipe(
        Effect.catchTag("GitHubCommandError", () => Effect.succeed([] as CheckRunAnnotation[])),
      );

    if (annotations.length > 0) {
      results.push({
        jobId: job.databaseId,
        jobName: job.name,
        annotations: [...annotations],
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

type StepTiming = {
  name: string;
  conclusion: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
};

type StepWindow = { name: string; failed: boolean; start: number; end: number };

const LINE_SECOND_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/;

// Older gh versions reject --allow-escape-sequences; they print escapes without it.
export const readJobLogApi = rawJobLog;

// Step times have one-second precision and several steps can share a second, so a
// boundary line goes to the failed step: a few extra lines beat a lost final error.
// Returns undefined for a line without a timestamp and null for a time outside every step.
function stepAtTime(line: string, windows: ReadonlyArray<StepWindow>) {
  const second = LINE_SECOND_RE.exec(line)?.[1];
  if (second === undefined) return undefined;
  const time = Date.parse(`${second}Z`);
  const inside = windows.filter((w) => w.start <= time && time <= w.end);
  return (inside.find((w) => w.failed) ?? inside.at(-1))?.name ?? null;
}

export function parseRawJobLogs(raw: string, steps: ReadonlyArray<StepTiming> = []): LogEntry[] {
  return parseAttributedJobLogs(raw, steps).map(({ step, message }) => ({ step, message }));
}

// `established` is true only when gh labelled the line or its own time falls inside a step window.
function parseAttributedJobLogs(raw: string, steps: ReadonlyArray<StepTiming>) {
  const entries: Array<LogEntry & { established: boolean }> = [];
  let currentStep = "(unknown)";
  let timedStep: string | undefined;
  const timed = steps
    .flatMap((step) => (step.startedAt ? [{ ...step, start: Date.parse(step.startedAt) }] : []))
    .toSorted((a, b) => a.start - b.start);
  const windows = timed.map((step, index) => ({
    name: step.name,
    failed: step.conclusion === "failure",
    start: step.start,
    end: step.completedAt ? Date.parse(step.completedAt) : (timed[index + 1]?.start ?? step.start),
  }));

  for (const rawLine of raw.split("\n")) {
    const cliLine = rawLine.match(/^[^\t]+\t([^\t]+)\t(\uFEFF?\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?.*)$/);
    const line = (cliLine?.[2] ?? rawLine).replace(/^\uFEFF/, "").replace(/\r$/, "");
    const byTime = stepAtTime(line, windows);
    if (byTime !== undefined) timedStep = byTime ?? undefined;

    // Step group markers
    const groupMatch = line.match(/##\[group\](.+)/);
    if (groupMatch) {
      if (!cliLine) currentStep = groupMatch[1].trim();
      if (byTime === undefined) timedStep = undefined;
      continue;
    }
    if (line.includes("##[endgroup]")) continue;

    const cleaned = cleanLogLine(line);
    if (cleaned.length === 0) continue;

    entries.push({
      step: cliLine?.[1] ?? timedStep ?? currentStep,
      message: cleaned,
      established: cliLine !== null || typeof byTime === "string",
    });
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

const normalizeFingerprint = (message: string) =>
  message
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/(?:0x)?[0-9a-f]{8,}/gi, "<id>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);

export const diagnoseLogEntries = (entries: readonly LogEntry[]): LogDiagnosis => {
  const fetchProgress =
    /^(?:\s*(?:\*\s+\[new branch\]|\[new branch\]|From\s+\S+|\*\s+\[new tag\]|\s*->\s+origin\/)|\s*\+?git fetch\b|.*refs\/(?:heads|remotes)\/)/i;
  const lines = entries
    .filter(
      ({ message }) =>
        /fatal:|error:|failed|exception|could not resolve|connection|timed out/i.test(message) ||
        !fetchProgress.test(message),
    )
    .map((entry) => entry.message);
  const text = lines.join("\n");
  const find = (pattern: RegExp) => lines.find((line) => pattern.test(line)) ?? null;
  const testsStarted =
    /\b(vitest|jest|pytest|tunit|go test|cargo test|test suites?|tests? (?:run|failed)|running tests?)\b/i.test(
      text,
    )
      ? true
      : /\b(install|checkout|restore|setup)\b/i.test(text)
        ? false
        : null;
  const matched = [
    [
      "infrastructure",
      /no space left on device|disk full|corrupt.*nuget|nuget.*corrupt|address already in use|socket.*bind/i,
    ],
    [
      "network",
      /econnreset|enotfound|network.*(?:error|timeout)|connection (?:reset|refused)|could not resolve host/i,
    ],
    ["test_failure", /\[Test Failure\]|Assertion(?:Error|Exception)/i],
    ["timeout", /timed? ?out|deadline exceeded/i],
    ["lint_failure", /\b(?:eslint|oxlint|lint)\b.*(?:error|failed)|lint failed/i],
    ["build_failure", /\b(?:build|compile|typescript)\b.*(?:error|failed)|compilation failed/i],
    ["test_failure", /\b(?:test|tests|vitest|jest|pytest)\b.*(?:fail|error)|\d+ failing/i],
  ] as const;
  for (const [category, pattern] of matched) {
    const error = find(pattern);
    if (error !== null) {
      return {
        category,
        fingerprint: `${category}:${normalizeFingerprint(error)}`,
        testsStarted,
        firstRelevantError: error,
      };
    }
  }
  const firstRelevantError = find(/\b(error|failed|fatal|exception)\b/i);
  return {
    category: "unknown",
    fingerprint: `unknown:${normalizeFingerprint(firstRelevantError ?? lines[0] ?? "no-log-output")}`,
    testsStarted,
    firstRelevantError,
  };
};

const resolveJob = Effect.fn("workflow.resolveJob")(function* (
  runId: number,
  jobName: string,
  repo: string | null,
) {
  const jobs = yield* listJobs(runId, repo);

  // Exact match first
  const exact = jobs.find((j) => j.name === jobName);
  if (exact) return exact;

  // Case-insensitive partial match
  const lower = jobName.toLowerCase();
  const partial = jobs.filter((j) => j.name.toLowerCase().includes(lower));

  if (partial.length === 1) return partial[0];

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

export const fetchJobLogs = Effect.fn("workflow.fetchJobLogs")(function* (
  opts: {
    runId: number;
    job: string;
    failedStepNames?: readonly string[] | null;
    steps?: ReadonlyArray<StepTiming>;
    failedStepsOnly: boolean;
    diagnose?: boolean;
    format: string;
    repo: string | null;
  } & ({ jobRef: JobRef; jobId?: never } | { jobId?: number | null; jobRef?: never }),
) {
  const gh = yield* GitHubService;

  let owner: string;
  let repoName: string;
  if (opts.repo !== null) {
    const parts = opts.repo.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return yield* new GitHubCommandError({
        message: `Invalid --repo format: "${opts.repo}". Expected "owner/name" (e.g. "example-org/example-repo").`,
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

  const job =
    opts.jobRef === undefined && (opts.jobId === null || opts.jobId === undefined)
      ? yield* resolveJob(opts.runId, opts.job, opts.repo)
      : null;
  const jobId = opts.jobRef?.id ?? opts.jobId ?? job?.databaseId;
  if (jobId === undefined)
    return yield* new GitHubCommandError({
      message: "Job identity unavailable",
      command: "workflow job-logs",
      exitCode: 1,
      stderr: "",
    });

  // `gh run view --log` can omit lines, so the job log endpoint is the primary source.
  const apiLogs = reads.jobLog(
    { owner, name: repoName },
    opts.jobRef ?? { id: jobId, status: job?.status ?? "unknown" },
  );
  const cliLogs = fetchLogs(opts.runId, opts.failedStepsOnly, jobId, opts.repo).pipe(
    Effect.map((r) => r.log),
  );
  const raw = yield* apiLogs.pipe(Effect.catchTag("GitHubCommandError", () => cliLogs));

  const steps = !opts.failedStepsOnly
    ? []
    : (opts.steps ??
      (yield* listJobs(opts.runId, opts.repo)).find((j) => j.databaseId === jobId)?.steps ??
      []);
  const attributed = parseAttributedJobLogs(raw, steps);
  let entries: LogEntry[] = attributed.map(({ step, message }) => ({ step, message }));

  if (opts.failedStepsOnly) {
    const wanted = new Set(
      opts.failedStepNames?.length
        ? opts.failedStepNames
        : steps.filter((s) => s.conclusion === "failure").map((s) => s.name),
    );
    const untimed = steps.some((s) => wanted.has(s.name) && !s.startedAt);
    const kept = attributed.filter((e) => wanted.has(e.step) || !e.established);
    if (!untimed && kept.some((e) => wanted.has(e.step))) {
      entries = kept.map(({ step, message }) => ({ step, message }));
    }
  }

  if (opts.diagnose) {
    return { runId: opts.runId, job: opts.job, jobId, diagnosis: diagnoseLogEntries(entries) };
  }

  if (opts.format === "json") {
    return { runId: opts.runId, job: opts.job, jobId, entries };
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
    branch: Flag.String("branch").pipe(
      Flag.withDescription("Filter by branch name"),
      Flag.optional,
    ),
    format: formatOption,
    limit: Flag.Int("limit").pipe(
      Flag.withDescription("Maximum number of runs to return"),
      Flag.withDefault(10),
    ),
    repo: repoOption,
    status: Flag.Literals("status", [
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
    workflow: Flag.String("workflow").pipe(
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
    run: Flag.Int("run").pipe(Flag.withDescription("Workflow run ID")),
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
    run: Flag.Int("run").pipe(Flag.withDescription("Workflow run ID")),
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
    failedOnly: Flag.Boolean("failed-only").pipe(
      Flag.withDescription("Only show logs from failed jobs (default: true)"),
      Flag.withDefault(true),
    ),
    format: formatOption,
    repo: repoOption,
    run: Flag.Int("run").pipe(Flag.withDescription("Workflow run ID")),
  },
  ({ failedOnly, format, repo, run }) =>
    Effect.gen(function* () {
      const resolvedRepo = yield* resolveRepoArg(repo);
      const logs = yield* fetchLogs(run, failedOnly, null, resolvedRepo);

      if (format === "toon" || format === "json") {
        yield* logFormatted(logs, format);
      } else {
        yield* logText(logs.log);
      }
    }),
).pipe(Command.withDescription("Fetch logs for a workflow run (--failed-only by default)"));

export const workflowRerunCommand = Command.make(
  "rerun",
  {
    failedOnly: Flag.Boolean("failed-only").pipe(
      Flag.withDescription("Only rerun failed jobs (default: true)"),
      Flag.withDefault(true),
    ),
    format: formatOption,
    repo: repoOption,
    run: Flag.Int("run").pipe(Flag.withDescription("Workflow run ID to rerun")),
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
    run: Flag.Int("run").pipe(Flag.withDescription("Workflow run ID to cancel")),
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
      Param.String(Param.flagKind, "field").pipe(
        Param.withAlias("f"),
        Param.withDescription("Workflow input as key=value; may be repeated"),
      ),
    ),
    format: formatOption,
    ref: Flag.String("ref").pipe(
      Flag.withDescription("Git ref to run the workflow on (branch, tag, or SHA)"),
    ),
    repo: repoOption,
    workflow: Flag.String("workflow").pipe(
      Flag.withDescription("Workflow file name (e.g., build.yml) or workflow ID"),
    ),
  },
  ({ field, format, ref, repo, workflow }) =>
    Effect.gen(function* () {
      const resolvedRepo = yield* resolveRepoArg(repo);
      const before = yield* listDispatchedRuns({ workflow, ref, repo: resolvedRepo });
      const result = yield* dispatchWorkflow({
        workflow,
        ref,
        fields: field,
        repo: resolvedRepo,
      });
      const created = yield* discoverDispatchedRun({
        workflow,
        ref,
        repo: resolvedRepo,
        knownRunIds: new Set(before.map((run) => run.databaseId)),
      });
      yield* logFormatted(
        {
          ...result,
          runId: created?.databaseId ?? null,
          headSha: created?.headSha ?? null,
          url: created?.url ?? null,
          nextCommand:
            created === null
              ? `agent-tools-gh workflow list --workflow ${workflow} --branch ${ref}`
              : `agent-tools-gh workflow watch --run ${created.databaseId}`,
        },
        format,
      );
    }),
).pipe(Command.withDescription("Dispatch a workflow_dispatch workflow run"));

export const workflowWatchCommand = Command.make(
  "watch",
  {
    format: formatOption,
    frames: Flag.Boolean("frames").pipe(
      Flag.withDescription(
        "Include the raw watch progress frames (large); omitted by default — final status/conclusion/jobs are always returned",
      ),
      Flag.withDefault(false),
    ),
    repo: repoOption,
    run: Flag.Int("run").pipe(Flag.withDescription("Workflow run ID to watch")),
    timeout: Flag.Int("timeout").pipe(
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
      const { kind, result } = yield* watchRun(run, resolvedRepo, timeout, frames);
      yield* logFormatted(result, format);
      if (kind === "timedOut") {
        return yield* new GitHubTimeoutError({
          message: `Workflow run ${run} timed out after ${timeout}s with status ${result.status}`,
          timeoutMs: timeout * 1000,
          hint: "The snapshot shows an unfinished run. Run workflow watch again to keep watching.",
          nextCommand: `agent-tools-gh workflow watch --run ${run}${resolvedRepo === null ? "" : ` --repo ${resolvedRepo}`}`,
        });
      }
    }),
).pipe(Command.withDescription("Watch a workflow run until it completes, then show final status"));

export const workflowJobLogsCommand = Command.make(
  "job-logs",
  {
    diagnose: Flag.Boolean("diagnose").pipe(
      Flag.withDescription("Return concise failure diagnosis metadata without log entries"),
      Flag.withDefault(false),
    ),
    failedStepsOnly: Flag.Boolean("failed-steps-only").pipe(
      Flag.withDescription("Only show logs from failed steps (default: false)"),
      Flag.withDefault(false),
    ),
    format: formatOption,
    job: Flag.String("job").pipe(
      Flag.withDescription("Job name to fetch logs for (exact or partial match)"),
    ),
    repo: repoOption,
    run: Flag.Int("run").pipe(Flag.withDescription("Workflow run ID")),
  },
  ({ diagnose, failedStepsOnly, format, job, repo, run }) =>
    Effect.gen(function* () {
      const resolvedRepo = yield* resolveRepoArg(repo);
      const result = yield* fetchJobLogs({
        runId: run,
        job,
        failedStepsOnly,
        diagnose,
        format,
        repo: resolvedRepo,
      });

      if ("formatted" in result) {
        yield* logText(result.formatted ?? "");
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
    job: Flag.String("job").pipe(
      Flag.withDescription("Filter to a specific job name (exact or partial match)"),
      Flag.optional,
    ),
    repo: repoOption,
    run: Flag.Int("run").pipe(Flag.withDescription("Workflow run ID")),
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
