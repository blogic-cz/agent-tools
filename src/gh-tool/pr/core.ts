import { Clock, Console, Duration, Effect, Option, Result } from "effect";

import type {
  BranchPRDetail,
  CheckResult,
  FailedCheckDetail,
  FailedCheckRunContext,
  MergeResult,
  MergeStrategy,
  PRInfo,
  PRViewInfo,
  RerunCheckAttempt,
  RerunChecksReport,
  RerunChecksRun,
  RerunRetryEvidence,
  WorkflowRunDetail,
} from "#gh/types";

import { GitHubCommandError, GitHubMergeError } from "#gh/errors";
import { GitHubService } from "#gh/service";

import type { ButStatusJson, PRViewJsonResult } from "./helpers";
import { runLocalCommand } from "./helpers";
import { diagnoseLogEntries, fetchJobLogs, formatLogEntries, parseRawJobLogs } from "#gh/workflow";

const CHECK_JSON_FIELDS = "name,state,bucket,link";
const LONG_LIVED_BRANCHES = new Set(["main", "master", "develop", "staging", "production"]);
const STABLE_SNAPSHOT_ATTEMPTS = 3;
const GITHUB_ACTIONS_RUN_ID_RE = /github\.com\/[^/]+\/[^/]+\/actions\/runs\/(\d+)/;

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
  const gh = yield* GitHubService;

  const run = yield* gh
    .runGhJson<WorkflowRunDetail>([
      "run",
      "view",
      String(runId),
      "--json",
      "databaseId,attempt,url,workflowName,status,conclusion,jobs",
    ])
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
    url: run.url,
    workflowName: run.workflowName,
    status: run.status,
    conclusion: run.conclusion,
    failedJobs,
  };

  return context;
});

const fetchCheckResults = Effect.fn("pr.fetchCheckResults")(function* (pr: number | null) {
  const gh = yield* GitHubService;

  const args = ["pr", "checks"];
  if (pr !== null) {
    args.push(String(pr));
  }

  return yield* gh.runGhJson<CheckResult[]>([...args, "--json", CHECK_JSON_FIELDS]);
});

const buildFailedChecksReport = Effect.fn("pr.buildFailedChecksReport")(function* (
  pr: number | null,
  checks: CheckResult[],
  options: {
    withLogs: boolean;
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

  const runContexts = new Map<number, FailedCheckRunContext | null>();
  const contexts = yield* Effect.forEach(
    runIds,
    (runId) =>
      fetchWorkflowRunFailureContext(runId).pipe(
        Effect.map((context) => [runId, context] as const),
      ),
    { concurrency: "unbounded" },
  );

  for (const [runId, context] of contexts) {
    runContexts.set(runId, context);
  }

  const enrichedFailedChecks: FailedCheckDetail[] = yield* Effect.forEach(
    failedChecks,
    (check) =>
      Effect.gen(function* () {
        const runId = extractRunIdFromCheckLink(check.link);
        const run = runId === null ? null : (runContexts.get(runId) ?? null);
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
          jobId: matchedJob.databaseId,
          failedStepNames: matchedJob.failedSteps,
          failedStepsOnly: true,
          format: "json",
          repo: null,
        }).pipe(Effect.catch(() => Effect.succeed(null)));

        if (failedStepLogs === null || !("entries" in failedStepLogs) || !failedStepLogs.entries) {
          return detail;
        }
        const formatted = formatLogEntries(failedStepLogs.entries);
        return formatted.length > 0
          ? {
              ...detail,
              failedStepLogs: formatted,
              diagnosis: diagnoseLogEntries(failedStepLogs.entries),
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
        const firstFailedJob = check.run?.failedJobs[0];
        if (firstFailedJob) {
          commands.push(
            `bun agent-tools-gh workflow job-logs --run ${check.runId} --job ${JSON.stringify(firstFailedJob.name)} --failed-steps-only`,
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
    failedChecks: enrichedFailedChecks,
    pendingChecks,
    hint,
    nextCommands,
  };
});

export const viewPR = Effect.fn("pr.viewPR")(function* (prNumber: number | null) {
  const gh = yield* GitHubService;

  const args = ["pr", "view"];
  if (prNumber !== null) {
    args.push(String(prNumber));
  }
  args.push(
    "--json",
    "number,url,title,headRefName,baseRefName,headRefOid,baseRefOid,state,isDraft,mergeable,body,author,reviewDecision,reviewRequests",
  );

  const info = yield* gh.runGhJson<PRViewInfo & { headRefOid?: string; baseRefOid?: string }>(args);
  return {
    ...info,
    headSha: info.headRefOid ?? info.headSha ?? null,
    baseSha: info.baseRefOid ?? info.baseSha ?? null,
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

  const gh = yield* GitHubService;

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
          openPr: gh
            .runGhJson<PRInfo[]>([
              "pr",
              "list",
              "--head",
              branchName,
              "--json",
              "number,url,title,headRefName,baseRefName,state,isDraft,mergeable",
              "--limit",
              "1",
            ])
            .pipe(
              Effect.map((prs) => prs[0] ?? null),
              Effect.catchTag("GitHubCommandError", () => Effect.succeed(null)),
            ),
          closedPr: gh
            .runGhJson<
              Array<{
                number: number;
                url: string;
                state: string;
              }>
            >([
              "pr",
              "list",
              "--head",
              branchName,
              "--state",
              "closed",
              "--json",
              "number,url,state",
              "--limit",
              "1",
            ])
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
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map(
          (r): BranchResult => ({
            branch: branchName,
            ...r,
          }),
        ),
      ),
    ),
    { concurrency: "unbounded" },
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
  const gh = yield* GitHubService;
  const args = [
    "pr",
    "list",
    "--state",
    opts.state,
    "--limit",
    String(opts.limit),
    "--json",
    "number,url,title,headRefName,baseRefName,state,isDraft,author,createdAt,reviewDecision",
  ];
  if (opts.author !== null) args.push("--author", opts.author);
  if (opts.base !== null) args.push("--base", opts.base);
  if (opts.head !== null) args.push("--head", opts.head);
  if (opts.search !== null) args.push("--search", opts.search);
  return yield* gh.runGhJson<PRInfo[]>(args);
});

// GitHub recomputes mergeability asynchronously after CI; poll until it settles out of "UNKNOWN".
const MAX_MERGEABLE_WAIT_SECONDS = 180;
const MERGEABLE_POLL_INTERVAL_MS = 3000;

export const waitForMergeable = Effect.fn("pr.waitForMergeable")(function* (
  pr: number | null,
  timeoutSeconds: number,
) {
  const cappedSeconds = Math.min(timeoutSeconds, MAX_MERGEABLE_WAIT_SECONDS);
  const start = yield* Clock.currentTimeMillis;
  const deadlineMs = Number(start) + cappedSeconds * 1000;

  // Effect.whileLoop (not recursion) so TestClock.adjust can advance Effect.sleep without real waits.
  let latest = yield* viewPR(pr);
  let timedOut = false;
  yield* Effect.whileLoop({
    while: () => latest.mergeable === "UNKNOWN" && !timedOut,
    body: () =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (Number(now) >= deadlineMs) {
          timedOut = true;
          return;
        }
        // Cap the sleep to the remaining budget so the total wait doesn't overshoot the deadline.
        const remaining = deadlineMs - Number(now);
        yield* Effect.sleep(Duration.millis(Math.min(MERGEABLE_POLL_INTERVAL_MS, remaining)));
        latest = yield* viewPR(pr);
      }),
    step: () => undefined,
  });

  return latest;
});

export const createPR = Effect.fn("pr.createPR")(function* (opts: {
  base: string | null;
  title: string;
  body: string;
  draft: boolean;
  head: string | null;
}) {
  const gh = yield* GitHubService;
  yield* validatePRTitle(opts.title);

  // Default to the repo's real default branch instead of a hardcoded "test" — an omitted --base
  // must never silently open a PR against the wrong trunk (L1).
  const baseBranch = opts.base ?? (yield* gh.getRepoInfo()).defaultBranch;

  // When --head is provided (e.g. GitButler workspace), use `gh pr list --head`
  // to find existing PR since `gh pr view` relies on the current git branch.
  const existing = yield* opts.head !== null
    ? gh
        .runGhJson<PRInfo[]>([
          "pr",
          "list",
          "--head",
          opts.head,
          "--json",
          "number,url,title,headRefName,baseRefName,state,isDraft,mergeable",
          "--limit",
          "1",
        ])
        .pipe(
          Effect.map((prs) =>
            prs.length > 0 ? Option.some(prs[0] as PRInfo) : Option.none<PRInfo>(),
          ),
        )
    : gh
        .runGhJson<{ number: number; url: string }>(["pr", "view", "--json", "number,url"])
        .pipe(Effect.option);

  if (Option.isSome(existing)) {
    const pr = existing.value;
    return yield* editPR({
      pr: pr.number,
      title: opts.title,
      body: opts.body,
      base: null,
    });
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

  const createResult = yield* gh.runGh(createArgs);

  if (opts.head === null) {
    return yield* viewPR(null);
  }

  const urlMatch = createResult.stdout.match(/\/pull\/(\d+)/);
  if (urlMatch?.[1]) {
    return yield* viewPR(Number(urlMatch[1]));
  }

  const prs = yield* gh.runGhJson<PRInfo[]>([
    "pr",
    "list",
    "--head",
    opts.head,
    "--json",
    "number,url,title,headRefName,baseRefName,state,isDraft,mergeable",
    "--limit",
    "1",
  ]);
  if (prs.length > 0) {
    return prs[0] as PRInfo;
  }

  return yield* Effect.fail(
    new GitHubCommandError({
      command: `gh pr create --head ${opts.head}`,
      exitCode: 0,
      stderr: "Pull request was created but could not be resolved by head branch.",
      message: "Pull request was created but could not be resolved by head branch.",
    }),
  );
});

export const mergePR = Effect.fn("pr.mergePR")(function* (opts: {
  pr: number;
  strategy: MergeStrategy;
  deleteBranch: boolean;
  confirm: boolean;
}) {
  const gh = yield* GitHubService;

  const info = yield* gh.runGhJson<PRViewJsonResult>([
    "pr",
    "view",
    String(opts.pr),
    "--json",
    "number,url,title,headRefName,baseRefName,state,isDraft,mergeable",
  ]);

  const repo = opts.deleteBranch ? yield* gh.getRepoInfo() : null;

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
      ? yield* gh.runGhJson<Array<{ number: number; headRefName: string; baseRefName: string }>>([
          "pr",
          "list",
          "--base",
          info.headRefName,
          "--state",
          "open",
          "--limit",
          "100",
          "--json",
          "number,headRefName,baseRefName",
        ])
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

    yield* Console.log(
      `DRY RUN: Would merge PR #${info.number} "${info.title}" via ${opts.strategy.toUpperCase()}. ` +
        `Branch \`${info.headRefName}\` → \`${info.baseRefName}\`. ` +
        (opts.deleteBranch ? `Remote branch \`${info.headRefName}\` will be deleted. ` : "") +
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
      const retargeted = yield* gh
        .runGh([
          "api",
          "--method",
          "PATCH",
          `repos/${repo.owner}/${repo.name}/pulls/${child.number}`,
          "-f",
          `base=${info.baseRefName}`,
        ])
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
    if (retargetedChildren.length === 0 || !repo) {
      return;
    }
    yield* Effect.forEach(
      retargetedChildren,
      (child) =>
        gh
          .runGh([
            "api",
            "--method",
            "PATCH",
            `repos/${repo.owner}/${repo.name}/pulls/${child}`,
            "-f",
            `base=${info.headRefName}`,
          ])
          .pipe(Effect.ignore),
      { discard: true },
    );
  });

  const mergeArgs = ["pr", "merge", String(opts.pr), `--${opts.strategy}`];

  const mergeResult = yield* gh.runGh(mergeArgs).pipe(
    Effect.catchTag("GitHubCommandError", (error) =>
      rollbackRetargets.pipe(
        Effect.andThen(() => {
          const stderr = error.stderr.toLowerCase();

          if (stderr.includes("merge conflict") || stderr.includes("conflicts")) {
            return Effect.fail(
              new GitHubMergeError({
                message: `PR #${opts.pr} has merge conflicts`,
                reason: "conflicts",
                hint: "Resolve merge conflicts locally, push the fix, then retry the merge.",
                nextCommand: `gh pr diff ${opts.pr}`,
              }),
            );
          }

          if (stderr.includes("required status check") || stderr.includes("checks")) {
            return Effect.fail(
              new GitHubMergeError({
                message: `PR #${opts.pr} has failing required checks`,
                reason: "checks_failing",
                hint: "Wait for CI checks to pass or investigate failures before merging.",
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
                hint: "This branch has protection rules. Ensure required reviews and checks are satisfied, or ask a repo admin.",
              }),
            );
          }

          return Effect.fail(
            new GitHubMergeError({
              message: `Failed to merge PR #${opts.pr}: ${error.stderr}`,
              reason: "unknown",
              hint: "Check the PR state and branch protections. The PR may already be merged or closed.",
              nextCommand: `agent-tools-gh pr view --pr ${opts.pr}`,
            }),
          );
        }),
      ),
    ),
  );

  const shaMatch = mergeResult.stdout.match(/([0-9a-f]{7,40})/);

  // `gh pr merge --delete-branch` aborts its remote delete when the head branch is checked out in a
  // worktree; deleting the remote ref explicitly is worktree-independent. Local cleanup is separate.
  if (willDeleteBranch && repo && info.headRefName) {
    const remoteDeleted = yield* gh
      .runGh([
        "api",
        "--method",
        "DELETE",
        `repos/${repo.owner}/${repo.name}/git/refs/heads/${info.headRefName}`,
      ])
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
    sha: shaMatch?.[1] ?? null,
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
  const gh = yield* GitHubService;

  const args = ["pr", "close", String(opts.pr)];

  if (opts.comment !== null) {
    args.push("--comment", opts.comment);
  }

  if (opts.deleteBranch) {
    args.push("--delete-branch");
  }

  yield* gh.runGh(args);

  return yield* viewPR(opts.pr);
});

export const editPR = Effect.fn("pr.editPR")(function* (opts: {
  pr: number;
  title: string | null;
  body: string | null;
  base: string | null;
}) {
  if (!opts.title && !opts.body && !opts.base) {
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

  const editArgs = [
    "api",
    "--method",
    "PATCH",
    `repos/${repo.owner}/${repo.name}/pulls/${opts.pr}`,
  ];

  if (opts.title) {
    editArgs.push("-f", `title=${opts.title}`);
  }
  if (opts.body) {
    editArgs.push("-f", `body=${opts.body}`);
  }
  if (opts.base) {
    editArgs.push("-f", `base=${opts.base}`);
  }

  yield* gh.runGh(editArgs);

  return yield* viewPR(opts.pr);
});

export const fetchChecks = Effect.fn("pr.fetchChecks")(function* (
  pr: number | null,
  watch: boolean,
  failFast: boolean,
  timeoutSeconds: number,
  quiet = false,
) {
  const gh = yield* GitHubService;

  const args = ["pr", "checks"];
  if (pr !== null) {
    args.push(String(pr));
  }

  if (watch) {
    const watchArgs = [...args, "--watch"];
    if (failFast) {
      watchArgs.push("--fail-fast");
    }

    // Block for the caller's requested --timeout (no artificial cap — blocking isn't the problem;
    // --timeout is validated >= 1s at the CLI boundary). On timeout return a snapshot, never
    // nothing — that was the actual token-wasting bug.
    const watchOutcome = yield* gh.runGh(watchArgs).pipe(
      Effect.timeoutOrElse({
        duration: timeoutSeconds * 1000,
        orElse: () => Effect.succeed(null),
      }),
    );

    const results = yield* fetchCheckResults(pr);
    if (!quiet && watchOutcome === null && results.some((c) => c.bucket === "pending")) {
      const pending = results.filter((c) => c.bucket === "pending").length;
      yield* Console.warn(
        `ℹ️  Watch timed out after ${timeoutSeconds}s; ${pending} check(s) still pending (snapshot returned). ` +
          `Re-run to keep watching:\n   ${buildChecksCommand(pr, true)}`,
      );
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

export const collectWithStableState = <S, A, E1, R1, E2, R2>(
  initial: S,
  collect: (state: S) => Effect.Effect<A, E1, R1>,
  refresh: (state: S) => Effect.Effect<S, E2, R2>,
  unchanged: (before: S, after: S) => boolean,
): Effect.Effect<{ state: S; value: A } | null, E1 | E2, R1 | R2> =>
  Effect.gen(function* () {
    let before = initial;
    for (let attempt = 0; attempt < STABLE_SNAPSHOT_ATTEMPTS; attempt += 1) {
      const value = yield* collect(before);
      const after = yield* refresh(before);
      if (unchanged(before, after)) return { state: after, value };
      before = after;
    }
    return null;
  });

export const fetchFailedChecks = Effect.fn("pr.fetchFailedChecks")(function* (
  pr: number | null,
  withLogs = false,
) {
  const initial = yield* viewPR(pr);
  const snapshot = yield* collectWithStableState(
    initial,
    (info) => fetchCheckResults(info.number),
    (info) => viewPR(info.number),
    (before, after) => after.headSha === before.headSha,
  );
  if (snapshot !== null) {
    return yield* buildFailedChecksReport(snapshot.state.number, snapshot.value, {
      withLogs,
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

type WatchPR = { number: number; state: string; headRefOid?: string | null };
type WatchRun = {
  databaseId: number;
  attempt?: number | null;
  headSha?: string | null;
  jobs?: Array<{ databaseId: number; name: string }>;
};

const watchPRState = Effect.fn("pr.watchPRState")(function* (pr: number) {
  const gh = yield* GitHubService;
  return yield* gh.runGhJson<WatchPR>([
    "pr",
    "view",
    String(pr),
    "--json",
    "number,state,headRefOid",
  ]);
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
        () => requireDeadline.pipe(Effect.andThen(fetchCheckResults(pr))),
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
      yield* Effect.forEach(
        [...new Set(checks.map((check) => extractRunIdFromCheckLink(check.link)))].filter(
          (runId): runId is number => runId !== null,
        ),
        (runId) =>
          Effect.gen(function* () {
            if (!(yield* beforeDeadline)) return;
            const run = yield* gh
              .runGhJson<WatchRun>([
                "run",
                "view",
                String(runId),
                "--json",
                "databaseId,attempt,headSha,jobs",
              ])
              .pipe(Effect.catchTag("GitHubCommandError", () => Effect.succeed(null)));
            runs.set(runId, run);
          }),
        { concurrency: 5 },
      );
      if (!(yield* beforeDeadline)) return "timeout" as const;
      return {
        pr: after,
        head,
        checks: checks
          .map((check) => ({
            check,
            run:
              extractRunIdFromCheckLink(check.link) === null
                ? null
                : (runs.get(extractRunIdFromCheckLink(check.link) ?? -1) ?? null),
          }))
          .filter(({ run }) => run === null || run.headSha === null || run.headSha === head),
      };
    });

  let timedOut = false;
  yield* Effect.whileLoop({
    while: () => terminal.size < prs.length && !timedOut,
    body: () =>
      Effect.gen(function* () {
        for (const number of prs) {
          if (terminal.has(number)) continue;
          if (!(yield* beforeDeadline)) {
            timedOut = true;
            break;
          }
          const state = yield* snapshot(number);
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
                runId: run?.databaseId ?? null,
                attempt: run?.attempt ?? null,
                jobId,
                checkId: null,
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
        if (!timedOut && terminal.size < prs.length) {
          yield* Effect.sleep(
            Duration.millis(Math.min(options.intervalSeconds * 1000, deadline - now)),
          );
        }
      }),
    step: () => undefined,
  });
  yield* emit({
    type: "watcher_terminal",
    repo: `${repo.owner}/${repo.name}`,
    status: terminal.size === prs.length ? "terminal" : "timeout",
    terminal: [...terminal].toSorted((a, b) => a - b),
  });
});

type RerunDiscovery = RerunCheckAttempt & { status?: string };

const fetchAttemptJobs = Effect.fn("pr.fetchAttemptJobs")(function* (
  runId: string,
  attempt: number,
  repo: string,
) {
  const gh = yield* GitHubService;
  const jobs: Array<{ id: number; name: string }> = [];
  for (let page = 1; ; page += 1) {
    const response = yield* gh
      .runGhJson<{ jobs?: Array<{ id: number; name: string }> }>([
        "api",
        `repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
      ])
      .pipe(Effect.catchTag("GitHubCommandError", () => Effect.succeed(null)));
    if (response?.jobs === undefined) return null;
    jobs.push(...response.jobs);
    if (response.jobs.length < 100) return jobs;
  }
});

const readJobDiagnosis = Effect.fn("pr.readJobDiagnosis")(function* (
  runId: string,
  jobName: string,
  attempt: number,
  repo: string,
) {
  const gh = yield* GitHubService;
  const jobs = yield* fetchAttemptJobs(runId, attempt, repo);
  if (jobs === null) return null;
  const matches = jobs.filter((job) => job.name === jobName);
  if (matches.length !== 1) return null;
  const logs = yield* gh
    .runGh(["api", `repos/${repo}/actions/jobs/${matches[0]?.id}/logs`])
    .pipe(Effect.catchTag("GitHubCommandError", () => Effect.succeed(null)));
  return logs === null ? null : diagnoseLogEntries(parseRawJobLogs(logs.stdout));
});

const discoverRerun = Effect.fn("pr.discoverRerun")(function* (
  runId: string,
  currentAttempt: number | null,
  currentJobIds: readonly number[],
  deadline: number,
) {
  const gh = yield* GitHubService;
  let latest: RerunDiscovery | null = null;
  while (Number(yield* Clock.currentTimeMillis) <= deadline) {
    latest = yield* gh
      .runGhJson<RerunDiscovery>(["run", "view", runId, "--json", "databaseId,attempt,status,jobs"])
      .pipe(Effect.catchTag("GitHubCommandError", () => Effect.succeed(null)));
    if (
      latest !== null &&
      ((latest.attempt ?? 0) > (currentAttempt ?? 0) ||
        latest.jobs.some((job) => !currentJobIds.includes(job.databaseId)))
    ) {
      return latest;
    }
    const remaining = deadline - Number(yield* Clock.currentTimeMillis);
    if (remaining <= 0) return null;
    yield* Effect.sleep(Duration.millis(Math.min(1000, remaining)));
  }
  return null;
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
    const run = yield* gh
      .runGhJson<RerunCheckAttempt>(["run", "view", runId, "--json", "databaseId,attempt,jobs"])
      .pipe(Effect.catchTag("GitHubCommandError", () => Effect.succeed(null)));
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
    const success = yield* gh
      .runGh(["run", "rerun", candidate.runId, ...(failedOnly ? ["--failed"] : [])])
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
      { concurrency: "unbounded" },
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
          while (latest.status !== "completed") {
            const remaining = deadline - Number(yield* Clock.currentTimeMillis);
            if (remaining <= 0) break;
            yield* Effect.sleep(Duration.millis(Math.min(1000, remaining)));
            if (Number(yield* Clock.currentTimeMillis) >= deadline) break;
            latest = yield* gh
              .runGhJson<RerunDiscovery>([
                "run",
                "view",
                candidate.runId,
                "--json",
                "databaseId,attempt,status,jobs",
              ])
              .pipe(Effect.catchTag("GitHubCommandError", () => Effect.succeed(latest)));
          }
          result.latestAttempt = latest;
          result.status = latest.status === "completed" ? "completed" : "watch_timeout";
        }),
      { concurrency: "unbounded" },
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
