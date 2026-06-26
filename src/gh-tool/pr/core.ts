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
  WorkflowRunDetail,
} from "#gh/types";

import { GitHubCommandError, GitHubMergeError } from "#gh/errors";
import { GitHubService } from "#gh/service";

import type { ButStatusJson, PRViewJsonResult } from "./helpers";
import { runLocalCommand } from "./helpers";

const CHECK_JSON_FIELDS = "name,state,bucket,link";
const GITHUB_ACTIONS_RUN_ID_RE = /github\.com\/[^/]+\/[^/]+\/actions\/runs\/(\d+)/;
// A single blocking `--watch` is capped here so an agent never loses a whole turn to a 30-min
// foreground wait. On hitting the cap we return the partial snapshot, not a failure (H1).
const MAX_WATCH_SECONDS = 120;

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

type WorkflowRunJobsForRerun = {
  databaseId: number;
  jobs: Array<{
    databaseId: number;
    name: string;
    status: string;
    conclusion: string | null;
  }>;
};

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

const resolveJobIdsForFailedChecks = (
  checks: CheckResult[],
  jobs: WorkflowRunJobsForRerun["jobs"],
): number[] | null => {
  const failedJobs = jobs.filter(isFailedWorkflowJob);
  const jobIds = new Set<number>();

  for (const check of checks) {
    const candidates = getCheckJobNameCandidates(check.name);
    const matches = failedJobs.filter((job) =>
      candidates.some((candidate) => job.name.toLowerCase() === candidate.toLowerCase()),
    );

    if (matches.length !== 1) {
      return null;
    }

    jobIds.add(matches[0].databaseId);
  }

  return [...jobIds];
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
      "databaseId,url,workflowName,status,conclusion,jobs",
    ])
    .pipe(Effect.catchTag("GitHubCommandError", () => Effect.succeed(null)));

  if (run === null) {
    return null;
  }

  const failedJobs = run.jobs
    .filter((job) => job.conclusion === "failure" || job.status === "failure")
    .map((job) => ({
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

  const enrichedFailedChecks: FailedCheckDetail[] = failedChecks.map((check) => {
    const runId = extractRunIdFromCheckLink(check.link);
    return {
      ...check,
      runId,
      run: runId === null ? null : (runContexts.get(runId) ?? null),
    };
  });

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
    "number,url,title,headRefName,baseRefName,state,isDraft,mergeable,body,author,reviewDecision,reviewRequests",
  );

  const info = yield* gh.runGhJson<PRViewInfo>(args);
  return info;
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
        yield* Effect.sleep(Duration.millis(MERGEABLE_POLL_INTERVAL_MS));
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

  // Stacked-PR safety: find open PRs that depend on this PR's head branch.
  // Deleting the head branch of an open PR that uses it as its base CLOSES that
  // PR (GitHub CLI behavior, see cli/cli#1168) instead of retargeting it. We
  // retarget such dependents onto this PR's base first, and only delete the
  // branch if EVERY retarget succeeds (fail-closed).
  const dependentOpenPrs =
    opts.deleteBranch && info.headRefName
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

    const dependentNote =
      dependentOpenPrs.length > 0
        ? `${dependentOpenPrs.length} dependent open PR(s) (${dependentOpenPrs
            .map((d) => `#${d.number}`)
            .join(", ")}) will be retargeted to \`${info.baseRefName}\` before deletion; ` +
          "branch deletion is skipped if any retarget fails. "
        : "";

    yield* Console.log(
      `DRY RUN: Would merge PR #${info.number} "${info.title}" via ${opts.strategy.toUpperCase()}. ` +
        `Branch \`${info.headRefName}\` → \`${info.baseRefName}\`. ` +
        (opts.deleteBranch ? `Branch \`${info.headRefName}\` will be deleted. ` : "") +
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

  // Retarget dependents BEFORE merging so the head branch can be deleted safely.
  // If any retarget fails, keep the branch (fail-closed) so no dependent PR is closed.
  let willDeleteBranch = opts.deleteBranch;
  let branchDeleteSkipped = false;
  const retargetedChildren: number[] = [];

  if (opts.deleteBranch && dependentOpenPrs.length > 0) {
    const repo = yield* gh.getRepoInfo();

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

  const mergeArgs = ["pr", "merge", String(opts.pr), `--${opts.strategy}`];

  if (willDeleteBranch) {
    mergeArgs.push("--delete-branch");
  }

  const mergeResult = yield* gh.runGh(mergeArgs).pipe(
    Effect.catchTag("GitHubCommandError", (error) => {
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
  );

  const shaMatch = mergeResult.stdout.match(/([0-9a-f]{7,40})/);

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

    // Cap the blocking wait; on timeout fall through to a snapshot instead of failing with no state.
    const cappedSeconds = Math.min(timeoutSeconds, MAX_WATCH_SECONDS);
    const watchOutcome = yield* gh.runGh(watchArgs).pipe(
      Effect.timeoutOrElse({
        duration: cappedSeconds * 1000,
        orElse: () => Effect.succeed(null),
      }),
    );

    const results = yield* fetchCheckResults(pr);
    if (watchOutcome === null && results.some((c) => c.bucket === "pending")) {
      const pending = results.filter((c) => c.bucket === "pending").length;
      yield* Console.warn(
        `ℹ️  Watch capped at ${cappedSeconds}s; ${pending} check(s) still pending (snapshot returned). ` +
          `Re-run to keep watching:\n   ${buildChecksCommand(pr, true)}`,
      );
    }
    return results;
  }

  const results = yield* fetchCheckResults(pr);
  if (results.some((c) => c.bucket === "pending")) {
    yield* Console.warn(
      `ℹ️  Some checks are still running. Re-run to refresh — each call returns the latest snapshot:\n` +
        `   ${buildChecksCommand(pr, false)}`,
    );
  }
  return results;
});

export const fetchFailedChecks = Effect.fn("pr.fetchFailedChecks")(function* (pr: number | null) {
  const checks = yield* fetchCheckResults(pr);
  return yield* buildFailedChecksReport(pr, checks);
});

export const fetchChecksForCommand = Effect.fn("pr.fetchChecksForCommand")(function* (
  pr: number | null,
  watch: boolean,
  failFast: boolean,
  timeoutSeconds: number,
) {
  if (!watch) {
    return yield* fetchChecks(pr, false, failFast, timeoutSeconds);
  }

  const watchedChecks = yield* fetchChecks(pr, true, failFast, timeoutSeconds).pipe(
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

export const rerunChecks = Effect.fn("pr.rerunChecks")(function* (
  pr: number | null,
  failedOnly: boolean,
) {
  const gh = yield* GitHubService;

  const checks = yield* fetchCheckResults(pr);

  const targetChecks = failedOnly ? checks.filter((check) => check.bucket === "fail") : checks;

  // Extract unique GitHub Actions run IDs from links
  const runIds = new Set<string>();
  const checksByRun = new Map<string, CheckResult[]>();
  for (const check of targetChecks) {
    const match = check.link.match(GITHUB_ACTIONS_RUN_ID_RE);
    if (match?.[1]) {
      runIds.add(match[1]);
      const existing = checksByRun.get(match[1]) ?? [];
      existing.push(check);
      checksByRun.set(match[1], existing);
    }
  }

  if (runIds.size === 0) {
    return {
      rerun: 0,
      message: failedOnly
        ? "No failed GitHub Actions runs found to rerun"
        : "No GitHub Actions runs found to rerun",
    };
  }

  const results: Array<{
    runId: string;
    success: boolean;
  }> = [];
  for (const runId of runIds) {
    const success = yield* Effect.gen(function* () {
      if (!failedOnly) {
        return yield* gh.runGh(["run", "rerun", runId]).pipe(
          Effect.map(() => true),
          Effect.catch(() => Effect.succeed(false)),
        );
      }

      const checksForRun = checksByRun.get(runId) ?? [];
      const run = yield* gh
        .runGhJson<WorkflowRunJobsForRerun>(["run", "view", runId, "--json", "databaseId,jobs"])
        .pipe(Effect.catchTag("GitHubCommandError", () => Effect.succeed(null)));

      const jobIds = run === null ? null : resolveJobIdsForFailedChecks(checksForRun, run.jobs);
      if (jobIds === null || jobIds.length === 0) {
        return yield* gh.runGh(["run", "rerun", runId, "--failed"]).pipe(
          Effect.map(() => true),
          Effect.catch(() => Effect.succeed(false)),
        );
      }

      const rerunResults = yield* Effect.forEach(
        jobIds,
        (jobId) =>
          gh.runGh(["run", "rerun", "--job", String(jobId)]).pipe(
            Effect.map(() => true),
            Effect.catch(() => Effect.succeed(false)),
          ),
        { concurrency: 1 },
      );

      return rerunResults.every(Boolean);
    });

    results.push({ runId, success });
  }

  return {
    rerun: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    runs: results,
    message: `Rerun ${results.filter((r) => r.success).length}/${results.length} GitHub Actions runs`,
  };
});
