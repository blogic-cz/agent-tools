import { Clock, Console, Effect, Option, Result } from "effect";

import type {
  BranchPRDetail,
  CheckResult,
  FailedCheckDetail,
  FailedCheckRunContext,
  MergeResult,
  MergeStrategy,
  PRInfo,
  RerunCheckAttempt,
  RerunChecksReport,
  RerunChecksRun,
  RerunRetryEvidence,
} from "#gh/types";

import type { GitHubAuthError, GitHubNotFoundError } from "#gh/errors";
import { GitHubCommandError, GitHubMergeError, GitHubTimeoutError } from "#gh/errors";
import { GitHubService } from "#gh/read/transport";
import { logFormatted, logText } from "#shared";
import { redactSensitiveText } from "#shared/content-security";

import type { ButStatusJson } from "./helpers";
import { runLocalCommand } from "./helpers";
import { readStack } from "./stack-read";
import {
  diagnoseLogEntries,
  discoverDispatchedRun,
  dispatchWorkflow,
  fetchJobLogs,
  formatLogEntries,
  listDispatchedRuns,
  parseRawJobLogs,
  readJobLogApi,
} from "#gh/workflow";
import { reads, resolveRepo } from "#gh/read/reads";
import { waits } from "#gh/read/waits";
import { project } from "#gh/read/porcelain";
import { writes } from "#gh/read/writes";
import { passthrough } from "#gh/read/catalog";
import type { AsyncMergeResult } from "#gh/read/catalog";
import { repoSlug } from "#gh/read/keys";
import { stableHead as collectWithStableState } from "./snapshot";
export { stableHead as collectWithStableState } from "./snapshot";

const LONG_LIVED_BRANCHES = new Set(["main", "master", "develop", "staging", "production"]);
const GITHUB_ACTIONS_RUN_ID_RE = /github\.com\/[^/]+\/[^/]+\/actions\/runs\/(\d+)/;
const MERGE_SHA_POLL_INTERVAL_MS = 5000;
const MERGE_SHA_WAIT_SECONDS = 5;
const isFullCommitSha = (value: unknown): value is string =>
  typeof value === "string" && value.length === 40 && /^[0-9a-f]+$/i.test(value);

const validatePRTitle = Effect.fn("pr.validatePRTitle")(function* (title: string) {
  const gh = yield* GitHubService;
  const repoConfig = yield* gh.getRepoConfig();
  const policy = repoConfig?.prTitle;

  if (!policy) {
    return;
  }

  const pattern = yield* Effect.try({
    try: () => new RegExp(policy.pattern),
    catch: (error) =>
      new GitHubCommandError({
        command: "pr title validation",
        exitCode: 1,
        stderr: `Invalid PR title policy regex: ${error instanceof Error ? error.message : String(error)}`,
        message: "Invalid PR title policy regex",
      }),
  });

  if (pattern.test(title)) {
    return;
  }

  const lines = [
    "PR title does not match the required format.",
    `Got: ${title}`,
    `Expected: ${policy.expected}`,
    ...(policy.example ? [`Example: ${policy.example}`] : []),
  ];

  return yield* new GitHubCommandError({
    command: "pr title validation",
    exitCode: 1,
    stderr: lines.join("\n"),
    message: lines[0] ?? "PR title does not match the required format.",
  });
});

const resolveMergeSha = Effect.fn("pr.resolveMergeSha")(function* (
  pr: number,
  knownSha: string | null,
) {
  if (knownSha !== null) {
    return knownSha;
  }

  const readMergeSha = () =>
    reads
      .prView(null, { by: "number", number: pr }, "origin")
      .pipe(Effect.map((result) => result.mergeCommit?.oid ?? null));
  const result = yield* readMergeSha().pipe(
    Effect.andThen((initial) =>
      waits
        .until(readMergeSha(), (sha) => sha !== null, {
          initial: { value: initial },
          intervalMs: MERGE_SHA_POLL_INTERVAL_MS,
          timeoutMs: MERGE_SHA_WAIT_SECONDS * 1000,
          readAtDeadline: true,
        })
        .pipe(Effect.map((outcome) => (outcome.kind === "done" ? outcome.value : outcome.last))),
    ),
    Effect.map((sha) => ({ sha, failed: false as const })),
    Effect.catch((error) =>
      Console.error(
        redactSensitiveText(
          `Warning: PR #${pr} was merged, but its merge commit SHA could not be read: ${error.message}`,
        ),
      ).pipe(Effect.as({ sha: null, failed: true as const })),
    ),
  );

  if (result.sha === null && !result.failed) {
    yield* Console.error(
      redactSensitiveText(
        `Warning: PR #${pr} was merged, but its merge commit SHA is still unknown after ${MERGE_SHA_WAIT_SECONDS}s.`,
      ),
    );
  }

  return result.sha;
});

const buildChecksCommand = (pr: number | null, includeWatch: boolean): string =>
  `bun agent-tools-gh pr checks${pr !== null ? ` --pr ${pr}` : ""}${includeWatch ? " --watch" : ""}`;

const buildChecksFailedCommand = (pr: number | null): string =>
  `bun agent-tools-gh pr checks-failed${pr !== null ? ` --pr ${pr}` : ""}`;

const extractRunIdFromCheckLink = (link: string): number | null => {
  const match = link.match(GITHUB_ACTIONS_RUN_ID_RE);
  if (!match?.[1]) {
    return null;
  }

  const runId = Number(match[1]);
  return Number.isFinite(runId) ? runId : null;
};

const isFailedWorkflowJob = (job: { status: string; conclusion: string | null }) =>
  job.conclusion === "failure" || job.status === "failure";

const getCheckJobNameCandidates = (checkName: string): string[] => {
  const exact = checkName.trim();
  const suffixParts = exact.split("/").map((part) => part.trim());
  let suffix: string | undefined;
  for (let index = suffixParts.length - 1; index >= 0; index -= 1) {
    const part = suffixParts[index];
    if (part !== undefined && part.length > 0) {
      suffix = part;
      break;
    }
  }

  return [...new Set([exact, suffix].filter((value): value is string => value !== undefined))];
};

const failedJobsMatchingCheck = <Job extends { name: string }>(
  checkName: string,
  failedJobs: readonly Job[],
): Job[] => {
  const candidates = getCheckJobNameCandidates(checkName);
  return failedJobs.filter((job) =>
    candidates.some((candidate) => job.name.toLowerCase() === candidate.toLowerCase()),
  );
};

const resolveJobIdsForFailedChecks = (
  checks: CheckResult[],
  jobs: RerunCheckAttempt["jobs"],
): number[] | null => {
  const failedJobs = jobs.filter(isFailedWorkflowJob);
  const jobIds = new Set<number>();

  for (const check of checks) {
    const matches = failedJobsMatchingCheck(check.name, failedJobs);

    if (matches.length !== 1) {
      return null;
    }

    jobIds.add(matches[0].databaseId);
  }

  return [...jobIds];
};

const matchFailedJobForCheck = <Job extends { name: string }>(
  checkName: string,
  failedJobs: readonly Job[],
): Job | null => {
  const matches = failedJobsMatchingCheck(checkName, failedJobs);
  return matches.length === 1 ? matches[0] : null;
};

const fetchWorkflowRunFailureContext = Effect.fn("pr.fetchWorkflowRunFailureContext")(function* (
  runId: number,
) {
  const run = yield* reads
    .runView(yield* resolveRepo(null), runId)
    .pipe(Effect.catchTag("GitHubCommandError", () => Effect.succeed(null)));

  if (run === null) {
    return null;
  }

  const failedJobs = run.jobs
    .filter((job) => job.conclusion === "failure" || job.status === "failure")
    .map((job) => ({
      databaseId: job.databaseId,
      jobId: job.databaseId,
      checkId: null,
      name: job.name,
      status: job.status,
      conclusion: job.conclusion,
      url: job.url,
      failedSteps: job.steps
        .filter((step) => step.conclusion === "failure" || step.status === "failure")
        .map((step) => step.name),
    }));

  const context: FailedCheckRunContext = {
    runId: run.databaseId,
    attempt: run.attempt ?? null,
    headSha: run.headSha ?? null,
    url: run.url,
    workflowName: run.workflowName,
    status: run.status,
    conclusion: run.conclusion,
    failedJobs,
  };
  const stepsByJob = new Map(run.jobs.map((job) => [job.databaseId, job.steps] as const));

  return { context, stepsByJob };
});

// `gh pr checks` exits 1 on an *empty* result ("no checks reported on the 'x' branch"). Zero checks
// is an ordinary state, so it is not an error, but it is also not an empty list: a PR with green
// checks (sabservis/nexus-be#1396) once came back empty.
export const NO_CHECKS_REPORTED_RE = /no checks reported/i;
// `gh` reports "no checks reported" both for the seconds after a push, before its checks
// register, and forever for a PR that has none — the message cannot tell them apart. So the
// wait for registration gets its own short budget: long enough to cover the race (measured
// at roughly 40s on blogic-cz/agent-tools#134), short enough that a check-less PR is not held
// for the caller's whole --timeout.
const CHECK_REGISTRATION_POLL_SECONDS = 5;
const CHECK_REGISTRATION_GRACE_SECONDS = 60;
const NO_CHECKS_REPORTED_REASON =
  "gh reported no checks for this head. Checks may not be registered yet, the PR may have no CI, or GitHub returned an empty rollup. This is not a CI verdict.";

export type CheckReport =
  | { checksStatus: "reported"; checks: CheckResult[] }
  | { checksStatus: "none_reported"; reason: string; checks: null };

const summarizeFailedStepEntries = (entries: Array<{ step: string; message: string }>) => {
  const selected = entries
    .map((entry, index) => ({
      entry,
      index,
      rank: /assert|expected|received|actual|failed|failure|error|exception|fatal/i.test(
        entry.message,
      )
        ? 0
        : 1,
    }))
    .toSorted((a, b) => a.rank - b.rank || b.index - a.index)
    .slice(0, 20)
    .toSorted((a, b) => a.index - b.index);
  const kept: Array<{ step: string; message: string }> = [];
  for (const { entry } of selected.toReversed()) {
    const clipped = { step: entry.step.slice(0, 80), message: entry.message.slice(0, 150) };
    if (formatLogEntries([clipped, ...kept]).length <= 3_900) kept.unshift(clipped);
  }
  let output = formatLogEntries(kept);
  if (kept.length < entries.length)
    output += `\n… ${entries.length - kept.length} log lines omitted`;
  return output;
};

export const fetchCheckResults = Effect.fn("pr.fetchCheckResults")(function* (
  pr: number | null,
  cache?: { headSha: string; watchPending?: boolean },
) {
  const report = yield* fetchCheckReport(pr, cache);
  return report.checks ?? [];
});

export const fetchCheckReport = Effect.fn("pr.fetchCheckReport")(function* (
  pr: number | null,
  cache?: { headSha: string; watchPending?: boolean },
) {
  const checks = yield* reads
    .prChecks(yield* resolveRepo(null), pr, cache?.headSha ?? null)
    .pipe(
      Effect.catchTag("GitHubCommandError", (error) =>
        NO_CHECKS_REPORTED_RE.test(error.stderr) || NO_CHECKS_REPORTED_RE.test(error.message)
          ? Effect.succeed(null)
          : Effect.fail(error),
      ),
    );
  if (checks === null || checks.length === 0) {
    return {
      checksStatus: "none_reported",
      reason: NO_CHECKS_REPORTED_REASON,
      checks: null,
    } satisfies CheckReport;
  }
  return { checksStatus: "reported", checks } satisfies CheckReport;
});

const buildFailedChecksReport = Effect.fn("pr.buildFailedChecksReport")(function* (
  pr: number | null,
  checks: CheckResult[],
  options: {
    withLogs: boolean;
    fullLogs?: boolean;
    evidence?: { headSha: string | null; baseSha: string | null } | null;
  } = { withLogs: false },
) {
  const failedChecks = checks.filter((check) => check.bucket === "fail");
  const pendingChecks = checks.filter((check) => check.bucket === "pending");
  const passedChecks = checks.filter((check) => check.bucket === "pass");

  const runIds = [
    ...new Set(
      failedChecks
        .map((check) => extractRunIdFromCheckLink(check.link))
        .filter((id) => id !== null),
    ),
  ];

  const evidence =
    options.evidence ??
    (yield* viewPR(pr).pipe(
      Effect.map((info) => ({ headSha: info.headSha ?? null, baseSha: info.baseSha ?? null })),
      Effect.catchTag("GitHubCommandError", () => Effect.succeed(null)),
    ));

  const runContexts = new Map(
    yield* Effect.forEach(
      runIds,
      (runId) =>
        fetchWorkflowRunFailureContext(runId).pipe(Effect.map((found) => [runId, found] as const)),
      { concurrency: 2 },
    ),
  );

  const enrichedFailedChecks: FailedCheckDetail[] = yield* Effect.forEach(
    failedChecks,
    (check) =>
      Effect.gen(function* () {
        const runId = extractRunIdFromCheckLink(check.link);
        const found = runId === null ? null : (runContexts.get(runId) ?? null);
        const run = found?.context ?? null;
        const detail: FailedCheckDetail = { ...check, runId, run };

        if (!options.withLogs || runId === null) {
          return detail;
        }

        const matchedJob = run ? matchFailedJobForCheck(check.name, run.failedJobs) : null;
        if (!matchedJob) {
          return detail;
        }

        const failedStepLogs = yield* fetchJobLogs({
          runId,
          job: matchedJob.name,
          jobRef: { id: matchedJob.databaseId, status: matchedJob.status },
          failedStepNames: matchedJob.failedSteps,
          steps: found?.stepsByJob.get(matchedJob.databaseId) ?? [],
          failedStepsOnly: true,
          format: "json",
          repo: null,
        }).pipe(Effect.catch(() => Effect.succeed(null)));

        if (failedStepLogs === null || !("entries" in failedStepLogs) || !failedStepLogs.entries) {
          return detail;
        }
        const formatted = options.fullLogs
          ? formatLogEntries(failedStepLogs.entries)
          : summarizeFailedStepEntries(failedStepLogs.entries);
        return formatted.length > 0
          ? {
              ...detail,
              failedStepLogs: formatted,
              ...(run?.headSha !== null &&
              run?.headSha !== undefined &&
              evidence?.headSha !== null &&
              evidence?.headSha !== undefined &&
              run.headSha !== evidence.headSha
                ? {}
                : { diagnosis: diagnoseLogEntries(failedStepLogs.entries) }),
            }
          : detail;
      }),
    { concurrency: 5 },
  );

  const nextCommands = [
    buildChecksFailedCommand(pr),
    ...new Set(
      enrichedFailedChecks.flatMap((check) => {
        if (check.runId === null) {
          return [];
        }

        const commands = [`bun agent-tools-gh workflow view --run ${check.runId}`];
        const matchedJob = check.run
          ? matchFailedJobForCheck(check.name, check.run.failedJobs)
          : null;
        if (matchedJob) {
          commands.push(
            `bun agent-tools-gh workflow job-logs --run ${check.runId} --job ${JSON.stringify(matchedJob.name)} --failed-steps-only`,
          );
        }

        return commands;
      }),
    ),
    ...(pendingChecks.length > 0 ? [buildChecksCommand(pr, true)] : []),
  ];

  const message =
    failedChecks.length === 0
      ? pendingChecks.length > 0
        ? `No failed checks yet; ${pendingChecks.length} check(s) are still running.`
        : "No failed checks detected."
      : pendingChecks.length > 0
        ? `Detected ${failedChecks.length} failed check(s) while ${pendingChecks.length} check(s) are still running.`
        : `Detected ${failedChecks.length} failed check(s).`;

  let remainingLogCharacters = 16_000;
  const reportFailedChecks = options.fullLogs
    ? enrichedFailedChecks
    : enrichedFailedChecks.map((check) => {
        if (check.failedStepLogs === undefined) return check;
        const limit = Math.max(0, remainingLogCharacters);
        remainingLogCharacters -= check.failedStepLogs.length;
        return check.failedStepLogs.length <= limit
          ? check
          : Object.assign({}, check, {
              failedStepLogs: `${check.failedStepLogs.slice(0, Math.max(0, limit - 40))}\n… report log summary omitted`,
            });
      });

  const hint =
    failedChecks.length === 0
      ? pendingChecks.length > 0
        ? "Some checks are still running. Re-run this command to refresh the snapshot."
        : "All current checks are green."
      : pendingChecks.length > 0
        ? "Inspect the failed workflow run first. Other checks are still running and may change overall merge readiness."
        : "Inspect the failed workflow run and failed job logs to get the first concrete error, then rerun only if the failure is understood.";

  return {
    evidence,
    status: failedChecks.length > 0 ? "failed" : "no_failures",
    message,
    summary: {
      total: checks.length,
      failed: failedChecks.length,
      pending: pendingChecks.length,
      passed: passedChecks.length,
    },
    failedChecks: reportFailedChecks,
    pendingChecks,
    hint,
    nextCommands,
  };
});

export const fetchPRView = Effect.fn("pr.fetchPRView")(function* (
  prNumber: number | null,
  consistency: "cached" | "origin" = "cached",
) {
  const raw = yield* reads.prView(
    yield* resolveRepo(null),
    prNumber === null ? { by: "currentBranch" } : { by: "number", number: prNumber },
    consistency,
  );
  const info = project(raw, [
    "number",
    "url",
    "title",
    "headRefName",
    "baseRefName",
    "headRefOid",
    "state",
    "isDraft",
    "mergeable",
    "body",
    "author",
    "reviewDecision",
    "reviewRequests",
    "headSha",
    "baseSha",
  ]);
  return {
    ...info,
    body: info.body ?? "",
    headSha: info.headRefOid ?? info.headSha ?? null,
    baseSha: info.baseSha ?? null,
  };
});

export const viewPR = Effect.fn("pr.viewPR")(function* (
  prNumber: number | null,
  consistency: "cached" | "origin" = "cached",
) {
  const gh = yield* GitHubService;

  const info = yield* fetchPRView(prNumber, consistency);
  const repo = yield* gh.getRepoInfo();
  const baseSha = yield* passthrough.baseSha(repo, info.number);
  return {
    ...info,
    baseSha: baseSha.stdout.trim() || null,
  };
});

export const detectPRStatus = Effect.fn("pr.detectPRStatus")(function* () {
  const directPr = yield* viewPR(null).pipe(Effect.option);
  if (Option.isSome(directPr)) {
    return {
      mode: "single" as const,
      pr: directPr.value,
    };
  }

  const currentBranchResult = yield* runLocalCommand("git", [
    "symbolic-ref",
    "--short",
    "HEAD",
  ]).pipe(Effect.option);

  if (Option.isNone(currentBranchResult)) {
    return {
      mode: "none" as const,
      branches: [] as BranchPRDetail[],
    };
  }

  const currentBranch = currentBranchResult.value.stdout;
  const isGitButlerWorkspace = currentBranch === "gitbutler/workspace";

  if (!isGitButlerWorkspace) {
    return {
      mode: "none" as const,
      branches: [] as BranchPRDetail[],
    };
  }

  const butStatusResult = yield* runLocalCommand("but", ["status", "--json"]);

  const butStatus = yield* Effect.try({
    try: () => JSON.parse(butStatusResult.stdout) as ButStatusJson,
    catch: (error) =>
      new GitHubCommandError({
        command: "but status --json",
        exitCode: 0,
        stderr: `Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}`,
        message: `Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}`,
      }),
  }).pipe(Effect.mapError((error) => error as GitHubCommandError));

  const branchNames = [
    ...new Set(
      butStatus.stacks.flatMap((stack) =>
        stack.branches.map((branch) => branch.name).filter((name) => name.length > 0),
      ),
    ),
  ];

  const repo = yield* resolveRepo(null);

  type BranchResult = {
    branch: string;
    openPr: PRInfo | null;
    closedPr: {
      number: number;
      url: string;
      state: "MERGED" | "CLOSED";
    } | null;
    remoteExists: boolean;
  };

  const branchResults = yield* Effect.all(
    branchNames.map((branchName) =>
      Effect.all(
        {
          openPr: reads
            .prList(repo, {
              state: "open",
              limit: 1,
              author: null,
              base: null,
              head: branchName,
              search: null,
            })
            .pipe(
              Effect.map((prs) =>
                prs[0] === undefined
                  ? null
                  : project(prs[0], [
                      "number",
                      "url",
                      "title",
                      "headRefName",
                      "baseRefName",
                      "state",
                      "isDraft",
                      "mergeable",
                    ]),
              ),
              Effect.catchTag("GitHubCommandError", () => Effect.succeed(null)),
            ),
          closedPr: reads
            .prList(repo, {
              state: "closed",
              limit: 1,
              author: null,
              base: null,
              head: branchName,
              search: null,
            })
            .pipe(
              Effect.map((prs) => {
                const pr = prs[0];
                if (!pr) return null;
                return {
                  number: pr.number,
                  url: pr.url,
                  state: pr.state as "MERGED" | "CLOSED",
                };
              }),
              Effect.catchTag("GitHubCommandError", () => Effect.succeed(null)),
            ),
          remoteExists: runLocalCommand("git", ["ls-remote", "--heads", "origin", branchName]).pipe(
            Effect.map((result) => result.stdout.trim().length > 0),
            Effect.catch(() => Effect.succeed(false)),
          ),
        },
        { concurrency: 2 },
      ).pipe(
        Effect.map((r): BranchResult => ({
          branch: branchName,
          ...r,
        })),
      ),
    ),
    { concurrency: 2 },
  );

  const foundPrs = branchResults.flatMap((r) => (r.openPr === null ? [] : [r.openPr]));

  if (foundPrs.length === 0) {
    const branchDetails: BranchPRDetail[] = branchResults.map((r) => ({
      branch: r.branch,
      remoteExists: r.remoteExists,
      closedPr: r.closedPr,
    }));
    return {
      mode: "none" as const,
      branches: branchDetails,
    };
  }

  if (foundPrs.length === 1) {
    return {
      mode: "single" as const,
      pr: foundPrs[0] as PRInfo,
    };
  }

  return {
    mode: "multiple" as const,
    prs: foundPrs,
  };
});

export const listPRs = Effect.fn("pr.listPRs")(function* (opts: {
  state: string;
  limit: number;
  author: string | null;
  base: string | null;
  head: string | null;
  search: string | null;
}) {
  const values = yield* reads.prList(yield* resolveRepo(null), opts);
  return values.map((value) =>
    project(value, [
      "number",
      "url",
      "title",
      "headRefName",
      "baseRefName",
      "state",
      "isDraft",
      "author",
      "createdAt",
      "reviewDecision",
    ]),
  );
});

// GitHub recomputes mergeability asynchronously after CI; poll until it settles out of "UNKNOWN".
const MAX_MERGEABLE_WAIT_SECONDS = 180;
const MERGEABLE_POLL_INTERVAL_MS = 5000;

export const waitForMergeable = Effect.fn("pr.waitForMergeable")(function* (
  pr: number | null,
  timeoutSeconds: number,
) {
  const cappedSeconds = Math.min(timeoutSeconds, MAX_MERGEABLE_WAIT_SECONDS);
  const initial = yield* viewPR(pr, "origin");
  const outcome = yield* waits.until(
    fetchPRView(pr, "origin").pipe(Effect.map((info) => ({ ...info, baseSha: initial.baseSha }))),
    (info) => info.mergeable !== "UNKNOWN",
    {
      initial: { value: initial },
      intervalMs: MERGEABLE_POLL_INTERVAL_MS,
      timeoutMs: cappedSeconds * 1000,
      readAtDeadline: true,
    },
  );
  return outcome.kind === "done" ? outcome.value : outcome.last;
});

export const createPR = Effect.fn("pr.createPR")(function* (opts: {
  base: string | null;
  title: string;
  body: string;
  draft: boolean;
  head: string | null;
  updateIfExists?: boolean;
}) {
  const gh = yield* GitHubService;
  yield* validatePRTitle(opts.title);

  // Default to the repo's real default branch instead of a hardcoded "test" — an omitted --base
  // must never silently open a PR against the wrong trunk (L1).
  const repo = yield* gh.getRepoInfo();
  const baseBranch = opts.base ?? repo.defaultBranch;
  const head =
    opts.head ?? (yield* runLocalCommand("git", ["symbolic-ref", "--short", "HEAD"])).stdout;
  const headSeparator = head.indexOf(":");
  const headOwner = (
    headSeparator === -1 ? repo.owner : head.slice(0, headSeparator)
  ).toLowerCase();
  const headBranch = headSeparator === -1 ? head : head.slice(headSeparator + 1);
  const lookup = reads.prList(
    repo,
    { state: "open", head: headBranch, base: baseBranch, limit: 2, author: null, search: null },
    "origin",
  );
  const candidates = yield* lookup;
  // The limited query may include another fork's branch. Refuse a saturated result
  // rather than assuming an owner-filtered match beyond the limit does not exist.
  if (candidates.length > 1) {
    return yield* new GitHubCommandError({
      command: "pr create",
      exitCode: 1,
      stderr: "Multiple open pull requests match the head and base branches.",
      message: "Multiple open pull requests match the head and base branches.",
      hint: "Select the intended PR with 'pr edit --pr <number>'.",
    });
  }
  const branchCandidate = candidates.find(
    (pr) => pr.state === "OPEN" && pr.headRefName === headBranch && pr.baseRefName === baseBranch,
  );
  if (branchCandidate !== undefined && !branchCandidate.headRepositoryOwner?.login) {
    return yield* new GitHubCommandError({
      command: "pr create",
      exitCode: 1,
      stderr: "Cannot establish the existing PR's head repository owner.",
      message: "Cannot establish the existing PR's head repository owner.",
    });
  }
  if (
    opts.updateIfExists === true &&
    headSeparator === -1 &&
    branchCandidate !== undefined &&
    branchCandidate.headRepositoryOwner?.login.toLowerCase() !== headOwner
  ) {
    return yield* new GitHubCommandError({
      command: "pr create",
      exitCode: 1,
      stderr: `PR #${branchCandidate.number} belongs to a different head repository owner.`,
      message: `PR #${branchCandidate.number} belongs to a different head repository owner.`,
      hint: "Use --head owner:branch to explicitly select a fork's PR, or 'pr edit --pr <number>'.",
    });
  }
  const existing = candidates.find(
    (pr) =>
      pr.state === "OPEN" &&
      pr.headRefName === headBranch &&
      pr.baseRefName === baseBranch &&
      pr.headRepositoryOwner?.login.toLowerCase() === headOwner,
  );
  if (existing !== undefined) {
    if (opts.updateIfExists !== true) {
      return yield* new GitHubCommandError({
        command: "pr create",
        exitCode: 1,
        stderr: `Open PR #${existing.number} already exists for ${headBranch} -> ${baseBranch}.`,
        message: `Open PR #${existing.number} already exists for ${headBranch} -> ${baseBranch}.`,
        hint: "Use --update-if-exists to update it, or 'pr edit --pr <number>'.",
      });
    }
    const current = yield* fetchPRView(existing.number, "origin");
    if (
      current.state !== "OPEN" ||
      current.headRefName !== headBranch ||
      current.baseRefName !== baseBranch
    ) {
      return yield* new GitHubCommandError({
        command: "pr create",
        exitCode: 1,
        stderr: `PR #${existing.number} no longer matches an open PR for the requested branches.`,
        message: `PR #${existing.number} no longer matches an open PR for the requested branches.`,
        hint: "Refresh the PR state before retrying.",
      });
    }
    const info = yield* editPR({
      pr: existing.number,
      title: opts.title,
      body: opts.body,
      base: null,
    });
    return { ...info, updated: true };
  }

  const createArgs = [
    "pr",
    "create",
    "--base",
    baseBranch,
    "--title",
    opts.title,
    "--body",
    opts.body,
  ];

  if (opts.head !== null) {
    createArgs.push("--head", opts.head);
  }

  if (opts.draft) {
    createArgs.push("--draft");
  }

  const createResult = yield* writes.run(createArgs, [`repo:${repoSlug(repo)}`]);

  const urlMatch = createResult.stdout.match(/\/pull\/(\d+)/);
  if (urlMatch?.[1]) {
    return { ...(yield* viewPR(Number(urlMatch[1]))), updated: false };
  }

  const prs = yield* lookup;
  if (
    prs.length === 1 &&
    prs[0]?.state === "OPEN" &&
    prs[0].headRefName === headBranch &&
    prs[0].baseRefName === baseBranch &&
    prs[0].headRepositoryOwner?.login.toLowerCase() === headOwner
  ) {
    return { ...(yield* viewPR(prs[0].number)), updated: false };
  }

  return yield* Effect.fail(
    new GitHubCommandError({
      command: `gh pr create --head ${headBranch}`,
      exitCode: 0,
      stderr: "Pull request was created but could not be resolved by head branch.",
      message: "Pull request was created but could not be resolved by head branch.",
    }),
  );
});

// GitHub rejects GraphQL `mergePullRequest` for a PR that belongs to a native stack and points at
// the asynchronous REST merge instead. `gh pr merge` only speaks GraphQL.
const ASYNC_MERGE_REQUIRED_RE = /asynchronous merge/i;
const ASYNC_MERGE_POLL_INTERVAL_MS = 5000;
const MAX_ASYNC_MERGE_WAIT_SECONDS = 120;

const asyncMergeFailure = (
  pr: number,
  message: string,
  hint: string,
  reason: "merge_queue" | "unknown" = "unknown",
) =>
  new GitHubMergeError({
    message: `Failed to merge PR #${pr} asynchronously: ${message}`,
    reason,
    hint,
    nextCommand: `agent-tools-gh pr view --pr ${pr}`,
  });

const mergeViaAsyncApi = Effect.fn("pr.mergeViaAsyncApi")(function* (opts: {
  pr: number;
  strategy: MergeStrategy;
}) {
  const gh = yield* GitHubService;
  const repo = yield* gh.getRepoInfo();
  const asyncPath = `repos/${repo.owner}/${repo.name}/pulls/${opts.pr}/merge-async`;

  let latest = yield* writes.json<AsyncMergeResult>(
    ["api", "--method", "PUT", asyncPath, "-f", `merge_method=${opts.strategy}`],
    [`pr:${repoSlug(repo)}#${opts.pr}`, `pulls:${repoSlug(repo)}`],
  );

  const uuid = latest.details?.uuid;
  if (uuid !== undefined) {
    const outcome = yield* waits.until(
      passthrough.asyncMergeStatus(`${asyncPath}/${uuid}`),
      (value) => value.status !== "pending",
      {
        initial: { value: latest },
        intervalMs: ASYNC_MERGE_POLL_INTERVAL_MS,
        timeoutMs: MAX_ASYNC_MERGE_WAIT_SECONDS * 1000,
        readAtDeadline: true,
      },
    );
    latest = outcome.kind === "done" ? outcome.value : outcome.last;
  }

  if (latest.status === "merged") {
    return latest.details?.sha ?? null;
  }

  if (latest.status === "enqueued") {
    return yield* asyncMergeFailure(
      opts.pr,
      latest.details?.message ?? "the pull request entered a merge queue",
      "The merge queue owns the merge from here; it is not merged yet. Watch the PR until the queue drains.",
      "merge_queue",
    );
  }

  if (latest.status === "pending") {
    return yield* asyncMergeFailure(
      opts.pr,
      `still pending after ${MAX_ASYNC_MERGE_WAIT_SECONDS}s`,
      "The asynchronous merge is still running. Re-check the PR state before retrying so the merge is not requested twice.",
    );
  }

  return yield* asyncMergeFailure(
    opts.pr,
    latest.details?.message ?? "the merge request failed",
    "Inspect the PR state and branch protections, then retry.",
  );
});

export const mergePR = Effect.fn("pr.mergePR")(function* (opts: {
  pr: number;
  strategy: MergeStrategy;
  deleteBranch: boolean;
  confirm: boolean;
  matchHeadCommit?: string;
}) {
  const gh = yield* GitHubService;
  const matchHeadCommit = opts.matchHeadCommit;

  if (matchHeadCommit !== undefined && !isFullCommitSha(matchHeadCommit)) {
    return yield* new GitHubMergeError({
      message: "--match-head-commit must be a full 40-character hexadecimal commit SHA",
      reason: "unknown",
      hint: "Provide the complete reviewed head commit SHA before retrying.",
      nextCommand: `agent-tools-gh pr view --pr ${opts.pr}`,
    });
  }

  const info = yield* reads.prView(null, { by: "number", number: opts.pr }, "origin").pipe(
    Effect.mapError((error) =>
      matchHeadCommit === undefined
        ? error
        : new GitHubMergeError({
            message: `Could not verify the head commit of PR #${opts.pr}: ${error.message}`,
            reason: "unknown",
            hint: "The merge is refused while the head is unknown. Re-read the PR and verify its reviewed head before retrying.",
            nextCommand: `agent-tools-gh pr view --pr ${opts.pr}`,
          }),
    ),
  );

  if (
    matchHeadCommit !== undefined &&
    (!isFullCommitSha(info?.headRefOid) ||
      info.headRefOid.toLowerCase() !== matchHeadCommit.toLowerCase())
  ) {
    return yield* new GitHubMergeError({
      message: `PR #${opts.pr} head does not match the reviewed commit ${matchHeadCommit}`,
      reason: "unknown",
      hint: "The head is missing, invalid, or changed. Re-read the PR and review its current head before retrying with that SHA.",
      nextCommand: `agent-tools-gh pr view --pr ${opts.pr}`,
    });
  }

  const repo = opts.deleteBranch ? yield* gh.getRepoInfo() : null;

  // merge-async lands the requested PR AND every unmerged PR below it in its stack, and
  // `gh pr merge` falls back to that endpoint for a stacked PR. Merging one member can
  // therefore land members this command never named. Refuse instead of merging silently.
  // Fail closed: readStack already reports a repository without a stacks surface as
  // unstacked, so a failure here leaves membership genuinely unknown, and proceeding
  // would land whatever sits below this PR without naming it.
  const stackView = yield* readStack({ pr: opts.pr }).pipe(
    Effect.catch((error) =>
      Effect.fail(
        new GitHubMergeError({
          message: `Could not determine whether PR #${opts.pr} belongs to a stack: ${error.message}`,
          reason: "unknown",
          hint: "Merging a stack member lands every open PR below it, so the merge is refused while membership is unknown. Retry, or read the stack with 'pr stack view'.",
          nextCommand: `agent-tools-gh pr stack view --pr ${opts.pr}`,
        }),
      ),
    ),
  );
  const ownPosition = stackView.members.find((entry) => entry.number === opts.pr)?.position;

  // The stack was fetched by querying this PR, so it must be among its own members. If it
  // is not, the PR left the stack between the list call and the detail call and membership
  // is unknown again — the same reason the lookup failure above refuses.
  if (stackView.isStacked && ownPosition === undefined) {
    return yield* new GitHubMergeError({
      message: `PR #${opts.pr} is missing from stack #${stackView.stackNumber}, which was read for that PR`,
      reason: "unknown",
      hint: "The stack changed while it was being read. Re-read it with 'pr stack view' before merging.",
      nextCommand: `agent-tools-gh pr stack view --pr ${opts.pr}`,
    });
  }

  const openBelow =
    !stackView.isStacked || ownPosition === undefined
      ? []
      : stackView.members.filter(
          (member) => member.state === "open" && member.position < ownPosition,
        );

  if (openBelow.length > 0) {
    return yield* new GitHubMergeError({
      message:
        `PR #${opts.pr} sits above ${openBelow.length} open PR(s) in stack #${stackView.stackNumber}: ` +
        openBelow.map((member) => `#${member.number}`).join(", ") +
        ". Merging it would land them too.",
      reason: "unknown",
      hint: "Use 'pr stack merge' to merge a stack: it checks every member first and reports the whole plan.",
      nextCommand: `agent-tools-gh pr stack merge --pr ${opts.pr}`,
    });
  }

  // A long-lived branch (default/env branch) as PR head means a promotion PR
  // (e.g. main -> staging). PRs based on it are unrelated work, not a stack —
  // retargeting them would mass-rewrite their base — and the branch itself
  // must never be deleted.
  const headIsLongLived =
    LONG_LIVED_BRANCHES.has(info.headRefName) || info.headRefName === repo?.defaultBranch;

  // Stacked-PR safety: find open PRs that depend on this PR's head branch.
  // Deleting the head branch of an open PR that uses it as its base CLOSES that
  // PR (GitHub CLI behavior, see cli/cli#1168) instead of retargeting it. We
  // retarget such dependents onto this PR's base first, and only delete the
  // branch if EVERY retarget succeeds (fail-closed).
  const dependentOpenPrs =
    opts.deleteBranch && !headIsLongLived && info.headRefName
      ? yield* reads.prList(
          yield* resolveRepo(null),
          {
            state: "open",
            limit: 100,
            base: info.headRefName,
            head: null,
            author: null,
            search: null,
          },
          "origin",
        )
      : [];

  if (!opts.confirm) {
    const mergeableNote =
      info.mergeable === "MERGEABLE"
        ? "PR is mergeable."
        : `PR mergeable status: ${info.mergeable}`;

    const dependentNote = headIsLongLived
      ? opts.deleteBranch
        ? `Head \`${info.headRefName}\` is a long-lived branch; deletion and dependent retargeting are skipped. `
        : ""
      : dependentOpenPrs.length > 0
        ? `${dependentOpenPrs.length} dependent open PR(s) (${dependentOpenPrs
            .map((d) => `#${d.number}`)
            .join(", ")}) will be retargeted to \`${info.baseRefName}\` before deletion ` +
          "(rolled back if the merge fails); branch deletion is skipped if any retarget fails. "
        : "";

    yield* logText(
      `DRY RUN: Would merge PR #${info.number} "${info.title}" via ${opts.strategy.toUpperCase()}. ` +
        `Branch \`${info.headRefName}\` → \`${info.baseRefName}\`. ` +
        (opts.deleteBranch && !headIsLongLived
          ? `Remote branch \`${info.headRefName}\` will be deleted. `
          : "") +
        dependentNote +
        mergeableNote,
    );

    const result: MergeResult = {
      merged: false,
      strategy: opts.strategy,
      branchDeleted: false,
      sha: null,
    };
    return result;
  }

  let willDeleteBranch = opts.deleteBranch && !headIsLongLived;
  let branchDeleteSkipped = opts.deleteBranch && headIsLongLived;
  const retargetedChildren: number[] = [];

  // Retarget dependents BEFORE merging: repos with "Automatically delete head
  // branches" delete the head as part of the merge itself, which closes any PR
  // still based on it (cli/cli#1168). A failed merge rolls the retargets back.
  // If any retarget fails, keep the branch (fail-closed) so no dependent PR is
  // closed.
  if (willDeleteBranch && dependentOpenPrs.length > 0 && repo) {
    for (const child of dependentOpenPrs) {
      const retargeted = yield* writes
        .run(
          [
            "api",
            "--method",
            "PATCH",
            `repos/${repo.owner}/${repo.name}/pulls/${child.number}`,
            "-f",
            `base=${info.baseRefName}`,
          ],
          [`pr:${repoSlug(repo)}#${child.number}`, `pulls:${repoSlug(repo)}`],
        )
        .pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );

      if (retargeted) {
        retargetedChildren.push(child.number);
      } else {
        willDeleteBranch = false;
        branchDeleteSkipped = true;
        break;
      }
    }
  }

  const rollbackRetargets = Effect.gen(function* () {
    const failed: number[] = [];
    if (retargetedChildren.length === 0 || !repo) {
      return failed;
    }
    for (const child of retargetedChildren) {
      const rolledBack = yield* writes
        .run(
          [
            "api",
            "--method",
            "PATCH",
            `repos/${repo.owner}/${repo.name}/pulls/${child}`,
            "-f",
            `base=${info.headRefName}`,
          ],
          [`pr:${repoSlug(repo)}#${child}`, `pulls:${repoSlug(repo)}`],
        )
        .pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
      if (!rolledBack) {
        failed.push(child);
      }
    }
    return failed;
  });

  const mergeRepo = yield* resolveRepo(null);
  const mergeArgs = ["pr", "merge", String(opts.pr), `--${opts.strategy}`];
  if (matchHeadCommit !== undefined) {
    mergeArgs.push("--match-head-commit", matchHeadCommit);
  }

  const shaFromAsyncMerge = yield* writes
    .run(mergeArgs, [`pr:${repoSlug(mergeRepo)}#${opts.pr}`, `pulls:${repoSlug(mergeRepo)}`])
    .pipe(
      Effect.map(() => null),
      Effect.catchTag("GitHubCommandError", (error) =>
        ASYNC_MERGE_REQUIRED_RE.test(error.stderr)
          ? matchHeadCommit !== undefined
            ? Effect.fail(
                new GitHubMergeError({
                  message: `PR #${opts.pr} requires an asynchronous merge that cannot enforce --match-head-commit`,
                  reason: "unknown",
                  hint: "The asynchronous fallback was refused because its exact-head condition is unsupported. Keep the reviewed SHA requirement and use a merge path that enforces it after reviewing the current head.",
                  nextCommand: `agent-tools-gh pr view --pr ${opts.pr}`,
                }),
              )
            : mergeViaAsyncApi({ pr: opts.pr, strategy: opts.strategy })
          : Effect.fail(error),
      ),
    )
    .pipe(
      Effect.catch((error) =>
        // A queued merge still lands, and its head branch disappears with it. Rolling the
        // dependents back onto that branch would close them (cli/cli#1168), so keep the retargets.
        error._tag === "GitHubMergeError" && error.reason === "merge_queue"
          ? Effect.fail(error)
          : rollbackRetargets.pipe(
              Effect.andThen(
                (
                  rollbackFailed,
                ): Effect.Effect<
                  never,
                  GitHubNotFoundError | GitHubAuthError | GitHubMergeError
                > => {
                  const rollbackNote =
                    rollbackFailed.length > 0
                      ? ` ROLLBACK INCOMPLETE: dependent PR(s) ${rollbackFailed
                          .map((child) => `#${child}`)
                          .join(", ")} are still retargeted to \`${info.baseRefName}\`; ` +
                        `manually restore their base to \`${info.headRefName}\`.`
                      : "";

                  if (error._tag !== "GitHubCommandError") {
                    return rollbackNote === ""
                      ? Effect.fail(error)
                      : Console.error(redactSensitiveText(rollbackNote.trim())).pipe(
                          Effect.andThen(Effect.fail(error)),
                        );
                  }

                  const stderr = error.stderr.toLowerCase();

                  if (stderr.includes("merge conflict") || stderr.includes("conflicts")) {
                    return Effect.fail(
                      new GitHubMergeError({
                        message: `PR #${opts.pr} has merge conflicts`,
                        reason: "conflicts",
                        hint: `Resolve merge conflicts locally, push the fix, then retry the merge.${rollbackNote}`,
                        nextCommand: `gh pr diff ${opts.pr}`,
                      }),
                    );
                  }

                  if (stderr.includes("required status check") || stderr.includes("checks")) {
                    return Effect.fail(
                      new GitHubMergeError({
                        message: `PR #${opts.pr} has failing required checks`,
                        reason: "checks_failing",
                        hint: `Wait for CI checks to pass or investigate failures before merging.${rollbackNote}`,
                        nextCommand: `agent-tools-gh pr checks --pr ${opts.pr}`,
                        retryable: true,
                      }),
                    );
                  }

                  if (stderr.includes("protected branch")) {
                    return Effect.fail(
                      new GitHubMergeError({
                        message: `PR #${opts.pr} targets a protected branch`,
                        reason: "branch_protected",
                        hint: `This branch has protection rules. Ensure required reviews and checks are satisfied, or ask a repo admin.${rollbackNote}`,
                      }),
                    );
                  }

                  return Effect.fail(
                    new GitHubMergeError({
                      message: `Failed to merge PR #${opts.pr}: ${error.stderr}`,
                      reason: "unknown",
                      hint: `Check the PR state and branch protections. The PR may already be merged or closed.${rollbackNote}`,
                      nextCommand: `agent-tools-gh pr view --pr ${opts.pr}`,
                    }),
                  );
                },
              ),
            ),
      ),
    );

  const mergedSha = yield* resolveMergeSha(opts.pr, shaFromAsyncMerge);

  // `gh pr merge --delete-branch` aborts its remote delete when the head branch is checked out in a
  // worktree; deleting the remote ref explicitly is worktree-independent. Local cleanup is separate.
  if (willDeleteBranch && repo && info.headRefName) {
    const remoteDeleted = yield* writes
      .run(
        [
          "api",
          "--method",
          "DELETE",
          `repos/${repo.owner}/${repo.name}/git/refs/heads/${info.headRefName}`,
        ],
        [`pr:${repoSlug(repo)}#${opts.pr}`, `pulls:${repoSlug(repo)}`],
      )
      .pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );

    if (!remoteDeleted) {
      willDeleteBranch = false;
      branchDeleteSkipped = true;
    }
  }

  const result: MergeResult = {
    merged: true,
    strategy: opts.strategy,
    branchDeleted: willDeleteBranch,
    sha: mergedSha,
    retargetedChildren: retargetedChildren.length > 0 ? retargetedChildren : undefined,
    branchDeleteSkipped: branchDeleteSkipped ? true : undefined,
  };
  return result;
});

export const closePR = Effect.fn("pr.closePR")(function* (opts: {
  pr: number;
  comment: string | null;
  deleteBranch: boolean;
}) {
  const args = ["pr", "close", String(opts.pr)];

  if (opts.comment !== null) {
    args.push("--comment", opts.comment);
  }

  if (opts.deleteBranch) {
    args.push("--delete-branch");
  }

  const repo = yield* resolveRepo(null);
  yield* writes.run(args, [
    `pr:${repoSlug(repo)}#${opts.pr}`,
    `pulls:${repoSlug(repo)}`,
    `issue-comments:${repoSlug(repo)}#${opts.pr}`,
  ]);

  return yield* viewPR(opts.pr);
});

export const readyPR = Effect.fn("pr.readyPR")(function* (opts: { pr: number | null }) {
  const info = yield* viewPR(opts.pr, "origin");

  // Idempotent: a PR that's already ready needs no mutation, and `gh pr ready` on a
  // non-draft PR is a no-op that would just add a pointless call.
  if (!info.isDraft) {
    return { ...info, wasAlreadyReady: true };
  }

  const repo = yield* resolveRepo(null);
  yield* writes.run(
    ["pr", "ready", String(info.number)],
    [`pr:${repoSlug(repo)}#${info.number}`, `pulls:${repoSlug(repo)}`],
  );

  const updated = yield* viewPR(info.number);
  return { ...updated, wasAlreadyReady: false };
});

export const draftPR = Effect.fn("pr.draftPR")(function* (opts: { pr: number | null }) {
  const info = yield* viewPR(opts.pr, "origin");

  if (info.isDraft) {
    return { ...info, wasAlreadyDraft: true };
  }

  const repo = yield* resolveRepo(null);
  yield* writes.run(
    ["pr", "ready", String(info.number), "--undo"],
    [`pr:${repoSlug(repo)}#${info.number}`, `pulls:${repoSlug(repo)}`],
  );

  const updated = yield* viewPR(info.number);
  return { ...updated, wasAlreadyDraft: false };
});

export const editPR = Effect.fn("pr.editPR")(function* (opts: {
  pr: number;
  title: string | null;
  body: string | null;
  base: string | null;
}) {
  if (opts.title === null && opts.body === null && opts.base === null) {
    return yield* Effect.fail(
      new GitHubCommandError({
        command: "pr edit",
        exitCode: 1,
        stderr: "At least one of --title, --body, or --base must be provided",
        message: "At least one of --title, --body, or --base must be provided",
      }),
    );
  }

  const gh = yield* GitHubService;
  if (opts.title !== null) {
    yield* validatePRTitle(opts.title);
  }

  const repo = yield* gh.getRepoInfo();

  // GitHub rejects a base change on a stacked PR with a bare 422. Say what the state is and
  // which operation changes it, rather than letting the validation error through.
  if (opts.base !== null) {
    const stackView = yield* readStack({ pr: opts.pr });
    if (stackView.isStacked === true) {
      return yield* new GitHubCommandError({
        command: "pr edit --base",
        exitCode: 1,
        stderr: `PR #${opts.pr} belongs to GitHub stack #${stackView.stackNumber}`,
        message: `Cannot retarget PR #${opts.pr}: it belongs to GitHub stack #${stackView.stackNumber}, whose members' bases GitHub owns`,
        hint: "Dissolve the stack first with 'pr stack unstack', which removes every unmerged member, then retarget. Merging the stack instead needs no retarget at all.",
        nextCommand: `agent-tools-gh pr stack view --pr ${opts.pr}`,
      });
    }
  }

  const editArgs = [
    "api",
    "--method",
    "PATCH",
    `repos/${repo.owner}/${repo.name}/pulls/${opts.pr}`,
  ];

  if (opts.title !== null) {
    editArgs.push("-f", `title=${opts.title}`);
  }
  if (opts.body !== null) {
    editArgs.push("-f", `body=${opts.body}`);
  }
  if (opts.base !== null) {
    editArgs.push("-f", `base=${opts.base}`);
  }

  yield* writes.run(editArgs, [`pr:${repoSlug(repo)}#${opts.pr}`, `pulls:${repoSlug(repo)}`]);

  return yield* viewPR(opts.pr);
});

export const fetchChecks = Effect.fn("pr.fetchChecks")(function* (
  pr: number | null,
  watch: boolean,
  failFast: boolean,
  timeoutSeconds: number,
  quiet = false,
) {
  if (watch) {
    const started = Number(yield* Clock.currentTimeMillis);
    const graceDeadlineMs =
      started + Math.min(CHECK_REGISTRATION_GRACE_SECONDS, timeoutSeconds) * 1000;
    const poll = Effect.gen(function* () {
      const checks = yield* fetchCheckResults(pr);
      return { checks, at: Number(yield* Clock.currentTimeMillis) };
    });
    const watchOutcome = yield* waits
      .until(
        poll,
        ({ checks, at }) =>
          checks.length === 0
            ? at >= graceDeadlineMs
            : (failFast && checks.some((check) => check.bucket === "fail")) ||
              checks.every((check) => check.bucket !== "pending"),
        { intervalMs: CHECK_REGISTRATION_POLL_SECONDS * 1000, timeoutMs: timeoutSeconds * 1000 },
      )
      .pipe(
        Effect.timeoutOrElse({
          duration: timeoutSeconds * 1000,
          orElse: () => Effect.succeed(null),
        }),
      );
    const last =
      watchOutcome === null
        ? null
        : watchOutcome.kind === "done"
          ? watchOutcome.value
          : watchOutcome.last;
    const graceExpired = last !== null && last.checks.length === 0 && last.at >= graceDeadlineMs;
    if (watchOutcome?.kind === "done" && last?.checks.some((check) => check.bucket === "fail"))
      return yield* new GitHubCommandError({
        command: buildChecksCommand(pr, true),
        exitCode: 1,
        message: "",
        stderr: "",
      });
    const results = yield* fetchCheckResults(pr);
    if (!quiet && graceExpired) {
      const prRef = pr === null ? "<number>" : String(pr);
      yield* Console.warn(
        `ℹ️  No checks registered within ${CHECK_REGISTRATION_GRACE_SECONDS}s of watching; ` +
          `returning the current snapshot. If this PR should have checks, the push event was ` +
          `likely dropped, and re-watching will find nothing again — dispatch them on the PR ` +
          `head instead:\n   agent-tools-gh pr trigger-checks --pr ${prRef} --workflow <file.yml>`,
      );
    }
    if (
      (watchOutcome === null || watchOutcome.kind === "timedOut") &&
      results.some((check) => check.bucket === "pending")
    ) {
      const pending = results.filter((check) => check.bucket === "pending").length;
      yield* logFormatted(results, quiet ? "json" : "toon");
      return yield* new GitHubTimeoutError({
        message: `Watch timed out, ${pending} pending after ${timeoutSeconds}s. This is not a CI verdict.`,
        timeoutMs: timeoutSeconds * 1000,
      });
    }
    return results;
  }

  const results = yield* fetchCheckResults(pr);
  if (!quiet && results.some((c) => c.bucket === "pending")) {
    yield* Console.warn(
      `ℹ️  Some checks are still running. Re-run to refresh — each call returns the latest snapshot:\n` +
        `   ${buildChecksCommand(pr, false)}`,
    );
  }
  return results;
});

// Dispatching on the wrong ref produces a green run for another branch that reads as PR evidence.
// The ref is therefore taken from the PR head, and the created run's headSha is compared back to it.
export const triggerChecks = Effect.fn("pr.triggerChecks")(function* (
  pr: number | null,
  workflow: string,
  fields: ReadonlyArray<string>,
) {
  const gh = yield* GitHubService;
  const info = yield* viewPR(pr);
  const repoInfo = yield* gh.getRepoInfo();
  const repo = `${repoInfo.owner}/${repoInfo.name}`;

  const existing = yield* fetchCheckResults(info.number);
  if (existing.length > 0) {
    return {
      triggered: false as const,
      pr: info.number,
      prHeadSha: info.headSha,
      message: `${existing.length} check(s) already reported for ${info.headSha ?? "head"}; nothing to trigger.`,
      nextCommand: `agent-tools-gh pr watch --prs ${info.number} --until terminal --format jsonl`,
    };
  }

  const before = yield* listDispatchedRuns({ workflow, ref: info.headRefName, repo });
  yield* dispatchWorkflow({ workflow, ref: info.headRefName, fields, repo });
  const created = yield* discoverDispatchedRun({
    workflow,
    ref: info.headRefName,
    repo,
    knownRunIds: new Set(before.map((run) => run.databaseId)),
  });

  const matchesPrHead = created !== null && created.headSha === info.headSha;
  if (created !== null && !matchesPrHead) {
    yield* Console.warn(
      `⚠️  Dispatched run ${created.databaseId} is on ${created.headSha}, not PR head ${info.headSha ?? "unknown"}. ` +
        `Its result is NOT evidence for PR #${info.number}.`,
    );
  }

  return {
    triggered: true as const,
    pr: info.number,
    workflow,
    ref: info.headRefName,
    runId: created?.databaseId ?? null,
    runHeadSha: created?.headSha ?? null,
    prHeadSha: info.headSha,
    matchesPrHead,
    url: created?.url ?? null,
    message:
      created === null
        ? "Dispatched, but no matching run appeared yet. List runs to find it before treating anything as evidence."
        : matchesPrHead
          ? `Run ${created.databaseId} is running against PR head ${info.headSha ?? "unknown"}.`
          : `Run ${created.databaseId} is on ${created.headSha}, not PR head ${info.headSha ?? "unknown"}; not evidence for this PR.`,
    nextCommand:
      created === null
        ? `agent-tools-gh workflow list --workflow ${workflow} --branch ${info.headRefName}`
        : `agent-tools-gh workflow watch --run ${created.databaseId}`,
  };
});

export const fetchFailedChecks = Effect.fn("pr.fetchFailedChecks")(function* (
  pr: number | null,
  withLogs = false,
  fullLogs = false,
) {
  const initial = yield* viewPR(pr);
  const snapshot = yield* collectWithStableState(
    initial,
    (info) => fetchCheckReport(info.number),
    (info) =>
      fetchPRView(info.number, "origin").pipe(
        Effect.map((refreshed) => ({ ...refreshed, baseSha: initial.baseSha })),
      ),
    (before, after) => after.headSha === before.headSha,
  );
  if (snapshot !== null) {
    if (snapshot.value.checksStatus === "none_reported") {
      return {
        evidence: { headSha: snapshot.state.headSha, baseSha: snapshot.state.baseSha },
        status: "none_reported",
        reason: snapshot.value.reason,
        message: "No checks were reported for this PR head.",
        summary: { total: 0, failed: 0, pending: 0, passed: 0 },
        failedChecks: [],
        pendingChecks: [],
        hint: "This is not a CI verdict. Check whether CI exists or has registered for this head.",
        nextCommands: [`bun agent-tools-gh pr checks --pr ${snapshot.state.number}`],
      };
    }
    return yield* buildFailedChecksReport(snapshot.state.number, snapshot.value.checks, {
      withLogs: withLogs || fullLogs,
      fullLogs,
      evidence: { headSha: snapshot.state.headSha, baseSha: snapshot.state.baseSha },
    });
  }
  return yield* Effect.fail(
    new GitHubCommandError({
      command: "gh-tool pr checks-failed",
      exitCode: 1,
      stderr: "",
      message: "PR head changed repeatedly while collecting checks",
      retryable: true,
    }),
  );
});

export const fetchChecksForCommand = Effect.fn("pr.fetchChecksForCommand")(function* (
  pr: number | null,
  watch: boolean,
  failFast: boolean,
  timeoutSeconds: number,
  quiet = false,
) {
  if (!watch) {
    return yield* fetchChecks(pr, false, failFast, timeoutSeconds, quiet);
  }

  const watchedChecks = yield* fetchChecks(pr, true, failFast, timeoutSeconds, quiet).pipe(
    Effect.result,
    Effect.flatMap((result) => {
      if (Result.isFailure(result) && result.failure._tag !== "GitHubCommandError") {
        return Effect.fail(result.failure);
      }

      return Effect.succeed(result);
    }),
  );

  if (Result.isSuccess(watchedChecks)) {
    return watchedChecks.success;
  }

  const finalChecks = yield* fetchCheckResults(pr);
  if (finalChecks.some((check) => check.bucket === "fail")) {
    return yield* buildFailedChecksReport(pr, finalChecks);
  }

  return yield* Effect.fail(watchedChecks.failure);
});

type WatchRun = {
  databaseId: number;
  attempt?: number | null;
  headSha?: string | null;
  jobs?: ReadonlyArray<{ databaseId: number; name: string }>;
};

const checkJobId = (link: string): number | null => {
  const modern = link.match(/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+\/job\/(\d+)/);
  const legacy = link.match(/github\.com\/[^/]+\/[^/]+\/runs\/(\d+)/);
  const id = Number(modern?.[1] ?? legacy?.[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

const watchPRState = Effect.fn("pr.watchPRState")(function* (pr: number) {
  return project(
    yield* reads.prView(yield* resolveRepo(null), { by: "number", number: pr }, "origin"),
    ["number", "state", "headRefOid"],
  );
});

export const fetchChecksBatch = Effect.fn("pr.fetchChecksBatch")(function* (
  prs: readonly number[],
) {
  return yield* Effect.forEach(
    prs,
    (pr) =>
      Effect.gen(function* () {
        const snapshot = yield* collectWithStableState(
          yield* watchPRState(pr),
          () => fetchCheckReport(pr),
          () => watchPRState(pr),
          (before, after) => before.headRefOid === after.headRefOid && before.state === after.state,
        );
        if (snapshot === null) {
          return yield* new GitHubCommandError({
            command: "gh-tool pr checks --prs",
            exitCode: 1,
            stderr: "",
            message: `PR #${pr} head changed repeatedly while collecting checks`,
            retryable: true,
          });
        }
        return {
          pr,
          state: snapshot.state.state,
          headSha: snapshot.state.headRefOid ?? null,
          ...snapshot.value,
        };
      }),
    { concurrency: 5 },
  );
});

export const watchPRs = Effect.fn("pr.watchPRs")(function* (
  prs: readonly number[],
  options: { intervalSeconds: number; timeoutSeconds: number; until?: "terminal" },
  emit: (event: Record<string, unknown>) => Effect.Effect<void>,
) {
  if ((options.until ?? "terminal") !== "terminal") {
    return yield* Effect.fail(
      new GitHubCommandError({
        command: "gh-tool pr watch",
        exitCode: 1,
        stderr: "",
        message: `Unsupported --until value: ${String(options.until)}`,
      }),
    );
  }
  const gh = yield* GitHubService;
  const repo = yield* gh.getRepoInfo();
  const currentIdentity = new Map<string, string>();
  const lastRevision = new Map<string, string>();
  const emptySnapshots = new Map<string, number>();
  const checksObserved = new Set<string>();
  const headByPR = new Map<number, string>();
  const terminal = new Set<number>();
  const started = Number(yield* Clock.currentTimeMillis);
  const deadline = started + options.timeoutSeconds * 1000;
  const beforeDeadline = Effect.gen(function* () {
    return Number(yield* Clock.currentTimeMillis) < deadline;
  });

  const snapshot = (pr: number) =>
    Effect.gen(function* () {
      const requireDeadline = Effect.gen(function* () {
        if (!(yield* beforeDeadline)) return yield* Effect.fail("timeout" as const);
      });
      yield* requireDeadline;
      const initial = yield* watchPRState(pr);
      const stableResult = yield* collectWithStableState(
        initial,
        (state) =>
          requireDeadline.pipe(
            Effect.andThen(
              state.headRefOid
                ? fetchCheckResults(pr, { headSha: state.headRefOid, watchPending: true })
                : fetchCheckResults(pr),
            ),
          ),
        () => requireDeadline.pipe(Effect.andThen(watchPRState(pr))),
        (before, after) => before.headRefOid === after.headRefOid && before.state === after.state,
      ).pipe(Effect.result);
      if (Result.isFailure(stableResult)) {
        if (stableResult.failure === "timeout") return "timeout" as const;
        return yield* Effect.fail(stableResult.failure);
      }
      if (stableResult.success === null) return null;
      const { state: after, value: checks } = stableResult.success;
      const head = after.headRefOid ?? null;
      const runs = new Map<number, WatchRun | null>();
      const identities = new Map<number, { runId: number; attempt: number } | null>();
      yield* Effect.forEach(
        [...new Set(checks.map((check) => checkJobId(check.link)))].filter(
          (id): id is number => id !== null,
        ),
        (id) =>
          Effect.gen(function* () {
            if (!(yield* beforeDeadline)) return;
            identities.set(
              id,
              yield* reads
                .jobIdentity(repo, id)
                .pipe(Effect.catchTag("GitHubCommandError", () => Effect.succeed(null))),
            );
          }),
        { concurrency: 2 },
      );
      yield* Effect.forEach(
        [
          ...new Set(
            checks
              .filter((check) => checkJobId(check.link) === null)
              .map((check) => extractRunIdFromCheckLink(check.link)),
          ),
        ].filter((runId): runId is number => runId !== null),
        (runId) =>
          Effect.gen(function* () {
            if (!(yield* beforeDeadline)) return;
            const run = yield* reads
              .runView(repo, runId)
              .pipe(Effect.catchTag("GitHubCommandError", () => Effect.succeed(null)));
            runs.set(runId, run);
          }),
        { concurrency: 2 },
      );
      if (!(yield* beforeDeadline)) return "timeout" as const;
      return {
        pr: after,
        head,
        checks: checks
          .map((check) => {
            const jobId = checkJobId(check.link);
            const identity = jobId === null ? null : identities.get(jobId);
            const runId = extractRunIdFromCheckLink(check.link);
            const resolvedRunId = runId ?? identity?.runId ?? null;
            const run: WatchRun | null =
              jobId === null
                ? runId === null
                  ? null
                  : (runs.get(runId) ?? null)
                : resolvedRunId === null
                  ? null
                  : {
                      databaseId: resolvedRunId,
                      attempt: identity?.attempt ?? null,
                      headSha: head,
                      jobs: [{ databaseId: jobId, name: check.name }],
                    };
            return { check, run };
          })
          .filter(({ run }) => run === null || run.headSha === null || run.headSha === head),
      };
    });

  let timedOut = false;
  yield* waits.until(
    Effect.gen(function* () {
      for (const number of prs) {
        if (terminal.has(number)) continue;
        if (!(yield* beforeDeadline)) {
          timedOut = true;
          break;
        }
        const remainingMs = Math.max(1, deadline - Number(yield* Clock.currentTimeMillis));
        const state = yield* snapshot(number).pipe(
          Effect.timeoutOrElse({
            duration: remainingMs,
            orElse: () => Effect.succeed("timeout" as const),
          }),
        );
        if (state === "timeout") {
          timedOut = true;
          break;
        }
        if (state === null) continue;
        const headKey = `${number}/${state.head ?? ""}`;
        const oldHeadKey = headByPR.get(number);
        if (oldHeadKey !== undefined && oldHeadKey !== headKey) {
          checksObserved.delete(oldHeadKey);
          emptySnapshots.delete(oldHeadKey);
        }
        headByPR.set(number, headKey);
        if (state.checks.length > 0) {
          checksObserved.add(headKey);
          emptySnapshots.set(headKey, 0);
        } else {
          emptySnapshots.set(headKey, (emptySnapshots.get(headKey) ?? 0) + 1);
        }
        for (const { check, run } of state.checks) {
          const matches = failedJobsMatchingCheck(check.name, run?.jobs ?? []);
          const jobId = matches.length === 1 ? (matches[0]?.databaseId ?? null) : null;
          const fallback = jobId === null ? `${check.name}|${check.link}` : String(jobId);
          const identity = [
            repo.owner + "/" + repo.name,
            number,
            state.head ?? "",
            run?.databaseId ?? "external",
            run?.attempt ?? "",
            fallback,
          ].join("/");
          const logical = `${number}/${check.name}`;
          const previousIdentity = currentIdentity.get(logical);
          const revision = `${check.state}/${check.bucket}`;
          if (lastRevision.get(identity) !== revision) {
            const event: Record<string, unknown> = {
              type: "check",
              repo: `${repo.owner}/${repo.name}`,
              pr: number,
              headSha: state.head,
              ...(run?.databaseId === undefined || run.databaseId === null
                ? {}
                : { runId: run.databaseId }),
              ...(run?.attempt === undefined || run.attempt === null
                ? {}
                : { attempt: run.attempt }),
              ...(jobId === null ? {} : { jobId }),
              name: check.name,
              state: check.state,
              bucket: check.bucket,
              link: check.link,
              identity,
            };
            if (previousIdentity !== undefined && previousIdentity !== identity) {
              event.supersedes = previousIdentity;
            }
            if (!(yield* beforeDeadline)) {
              timedOut = true;
              break;
            }
            yield* emit(event);
            lastRevision.set(identity, revision);
          }
          currentIdentity.set(logical, identity);
        }
        if (timedOut) break;
        // Empty snapshots need three consecutive observations, including after checks were seen.
        const hasTerminalCoverage =
          state.checks.length > 0 || (emptySnapshots.get(headKey) ?? 0) >= 3;
        const checksTerminal =
          state.checks.length === 0 ||
          state.checks.every(({ check }) => check.bucket !== "pending");
        if (state.pr.state !== "OPEN" || (hasTerminalCoverage && checksTerminal)) {
          if (!(yield* beforeDeadline)) {
            timedOut = true;
            break;
          }
          const identity = `${repo.owner}/${repo.name}/${number}/${state.head ?? ""}/terminal/${state.pr.state}`;
          yield* emit({
            type: "pr_terminal",
            repo: `${repo.owner}/${repo.name}`,
            pr: number,
            headSha: state.head,
            state: state.pr.state,
            checksObserved: checksObserved.has(headKey),
            identity,
          });
          terminal.add(number);
        }
      }
      const now = Number(yield* Clock.currentTimeMillis);
      timedOut = timedOut || (terminal.size < prs.length && now >= deadline);
    }),
    () => terminal.size >= prs.length || timedOut,
    {
      intervalMs: options.intervalSeconds * 1000,
      timeoutMs: options.timeoutSeconds * 1000,
    },
  );
  const watcherTimedOut = terminal.size < prs.length;
  yield* emit({
    type: "watcher_terminal",
    repo: `${repo.owner}/${repo.name}`,
    status: watcherTimedOut ? "timeout" : "terminal",
    terminal: [...terminal].toSorted((a, b) => a - b),
    ...(watcherTimedOut
      ? {
          verdict: null,
          message: `Watch timed out, ${prs.length - terminal.size} pending. This is not a CI verdict.`,
          timeoutSeconds: options.timeoutSeconds,
          pending: prs.filter((number) => !terminal.has(number)).toSorted((a, b) => a - b),
        }
      : {}),
  });
  if (watcherTimedOut) {
    return yield* new GitHubTimeoutError({
      message: `Watch timed out, ${prs.length - terminal.size} pending. This is not a CI verdict.`,
      timeoutMs: options.timeoutSeconds * 1000,
    });
  }
});

const fetchAttemptJobs = (runId: string, attempt: number, repo: string) =>
  Effect.gen(function* () {
    return yield* reads
      .completedAttemptJobs(yield* resolveRepo(repo), Number(runId), attempt)
      .pipe(Effect.catchTag("GitHubCommandError", () => Effect.succeed(null)));
  });

const readRerunState = (runId: string, withStatus: boolean) =>
  Effect.gen(function* () {
    const run = yield* reads.runView(yield* resolveRepo(null), Number(runId), "origin");
    const fields = withStatus
      ? (["databaseId", "attempt", "status", "jobs"] as const)
      : (["databaseId", "attempt", "jobs"] as const);
    return project(run, fields);
  });

const readJobDiagnosis = Effect.fn("pr.readJobDiagnosis")(function* (
  runId: string,
  jobName: string,
  attempt: number,
  repo: string,
) {
  const jobs = yield* fetchAttemptJobs(runId, attempt, repo);
  if (jobs === null) return null;
  const matches = jobs.filter((job) => job.name === jobName);
  if (matches.length !== 1) return null;
  const logs = yield* readJobLogApi(`repos/${repo}/actions/jobs/${matches[0]?.id}/logs`).pipe(
    Effect.catchTag("GitHubCommandError", () => Effect.succeed(null)),
  );
  return logs === null ? null : diagnoseLogEntries(parseRawJobLogs(logs.stdout));
});

const discoverRerun = Effect.fn("pr.discoverRerun")(function* (
  runId: string,
  currentAttempt: number | null,
  currentJobIds: readonly number[],
  deadline: number,
) {
  const read = readRerunState(runId, true).pipe(
    Effect.catchTag("GitHubCommandError", () => Effect.succeed(null)),
  );
  const outcome = yield* waits.until(
    read,
    (latest) =>
      latest !== null &&
      ((latest.attempt ?? 0) > (currentAttempt ?? 0) ||
        latest.jobs.some((job) => !currentJobIds.includes(job.databaseId))),
    {
      intervalMs: 5000,
      timeoutMs: Math.max(0, deadline - Number(yield* Clock.currentTimeMillis)),
      readAtDeadline: true,
    },
  );
  return outcome.kind === "done" ? outcome.value : null;
});

export const rerunChecks = Effect.fn("pr.rerunChecks")(function* (
  pr: number | null,
  failedOnly: boolean,
  options: { watch?: boolean; timeoutSeconds?: number } = {},
) {
  const gh = yield* GitHubService;
  const checks = yield* fetchCheckResults(pr);
  const targetChecks = failedOnly ? checks.filter((check) => check.bucket === "fail") : checks;
  const checksByRun = new Map<string, CheckResult[]>();
  for (const check of targetChecks) {
    const runId = check.link.match(GITHUB_ACTIONS_RUN_ID_RE)?.[1];
    if (runId !== undefined) checksByRun.set(runId, [...(checksByRun.get(runId) ?? []), check]);
  }
  if (checksByRun.size === 0) {
    const report: RerunChecksReport = {
      rerun: 0,
      message: failedOnly
        ? "No failed GitHub Actions runs found to rerun"
        : "No GitHub Actions runs found to rerun",
    };
    return report;
  }

  const repoInfo = yield* gh.getRepoInfo();
  const repo = `${repoInfo.owner}/${repoInfo.name}`;
  const candidates: Array<{
    runId: string;
    run: RerunCheckAttempt | null;
    evidence: RerunRetryEvidence;
  }> = [];
  for (const [runId, runChecks] of checksByRun) {
    const run = yield* readRerunState(runId, false).pipe(
      Effect.catchTag("GitHubCommandError", () => Effect.succeed(null)),
    );
    let evidence: RerunRetryEvidence = { state: "eligible", diagnosis: diagnoseLogEntries([]) };
    if (failedOnly) {
      const jobIds = run === null ? null : resolveJobIdsForFailedChecks(runChecks, run.jobs);
      if (
        run === null ||
        run.attempt === null ||
        run.attempt === undefined ||
        jobIds === null ||
        jobIds.length === 0
      ) {
        evidence = { state: "unavailable", reason: "failed jobs or current attempt unavailable" };
      } else {
        const targetJobs = run.jobs.filter((job) => jobIds.includes(job.databaseId));
        for (const job of targetJobs) {
          const current = yield* readJobDiagnosis(runId, job.name, run.attempt, repo);
          if (current === null) {
            evidence = {
              state: "unavailable",
              reason: `retry evidence unavailable for ${job.name}`,
            };
            break;
          }
          evidence = { state: "eligible", diagnosis: current };
          const retryablePreTest =
            current.testsStarted === false &&
            ["infrastructure", "network", "timeout"].includes(current.category);
          if (!retryablePreTest) continue;
          for (let attempt = 1; attempt < run.attempt; attempt += 1) {
            const prior = yield* readJobDiagnosis(runId, job.name, attempt, repo);
            if (prior === null) {
              evidence = {
                state: "unavailable",
                reason: `retry evidence unavailable for ${job.name} attempt ${attempt}`,
              };
              break;
            }
            if (prior.fingerprint === current.fingerprint) {
              evidence = {
                state: "ineligible",
                diagnosis: current,
                reason: "matching pre-test failure already retried",
              };
              break;
            }
          }
          if (evidence.state !== "eligible") break;
        }
      }
    }
    candidates.push({ runId, run, evidence });
  }

  if (candidates.some((candidate) => candidate.evidence.state !== "eligible")) {
    const unavailable = candidates.some((candidate) => candidate.evidence.state === "unavailable");
    const status = unavailable ? "evidence_unavailable" : "escalation_required";
    const runs: RerunChecksRun[] = candidates.map((candidate) => ({
      runId: candidate.runId,
      success: false,
      currentAttempt: candidate.run?.attempt ?? null,
      currentJobIds: candidate.run?.jobs?.map((job) => job.databaseId) ?? null,
      status: candidate.evidence.state === "eligible" ? "blocked" : status,
      evidence: candidate.evidence,
    }));
    const report: RerunChecksReport = {
      status,
      rerun: 0,
      failed: runs.length,
      runs,
      message: unavailable
        ? "Required retry evidence unavailable; no runs rerun"
        : "Escalation required; no runs rerun",
    };
    return report;
  }

  const watch = options.watch === true;
  const deadline = Number(yield* Clock.currentTimeMillis) + (options.timeoutSeconds ?? 60) * 1000;
  const results: RerunChecksRun[] = [];
  for (const candidate of candidates) {
    const success = yield* writes
      .run(["run", "rerun", candidate.runId, ...(failedOnly ? ["--failed"] : [])], [`repo:${repo}`])
      .pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      );
    results.push({
      runId: candidate.runId,
      success,
      status: success ? "rerun_started" : "failed",
      currentAttempt: candidate.run?.attempt ?? null,
      currentJobIds: candidate.run?.jobs?.map((job) => job.databaseId) ?? null,
      evidence: candidate.evidence,
    });
  }

  if (watch) {
    const discoveries = yield* Effect.forEach(
      candidates,
      (candidate, index) =>
        results[index]?.success
          ? discoverRerun(
              candidate.runId,
              candidate.run?.attempt ?? null,
              candidate.run?.jobs?.map((job) => job.databaseId) ?? [],
              deadline,
            )
          : Effect.succeed(null),
      { concurrency: 2 },
    );
    yield* Effect.forEach(
      candidates,
      (candidate, index) =>
        Effect.gen(function* () {
          const result = results[index];
          if (result === undefined || !result.success) return;
          const next = discoveries[index] ?? null;
          result.newAttempt = next?.attempt ?? null;
          result.newJobIds = next?.jobs.map((job) => job.databaseId) ?? null;
          if (next === null) {
            result.status = "discovery_timeout";
            result.latestAttempt = candidate.run;
            return;
          }
          let latest = next;
          const outcome = yield* waits.until(
            Effect.suspend(() =>
              readRerunState(candidate.runId, true).pipe(
                Effect.catchTag("GitHubCommandError", () => Effect.succeed(latest)),
                Effect.tap((refreshed) =>
                  Effect.sync(() => {
                    latest = refreshed;
                  }),
                ),
              ),
            ),
            (value) => value.status === "completed",
            {
              initial: { value: latest },
              intervalMs: 5000,
              timeoutMs: Math.max(0, deadline - Number(yield* Clock.currentTimeMillis)),
            },
          );
          latest = outcome.kind === "done" ? outcome.value : outcome.last;
          result.latestAttempt = latest;
          result.status = latest.status === "completed" ? "completed" : "watch_timeout";
        }),
      { concurrency: 2 },
    );
  }
  const report: RerunChecksReport = {
    status: results.some((result) => !result.success) ? "failed" : "rerun_started",
    rerun: results.filter((result) => result.success).length,
    failed: results.filter((result) => !result.success).length,
    runs: results,
    message: `Rerun ${results.filter((result) => result.success).length}/${results.length} GitHub Actions runs`,
  };
  return report;
});
