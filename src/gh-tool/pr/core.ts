import { Console, Effect, Option, Result } from "effect";

import type {
  BranchPRDetail,
  CheckResult,
  FailedCheckDetail,
  FailedCheckRunContext,
  MergeResult,
  MergeStrategy,
  PRInfo,
  WorkflowRunDetail,
} from "#gh/types";

import { GitHubCommandError, GitHubMergeError, GitHubTimeoutError } from "#gh/errors";
import { GitHubService } from "#gh/service";

import type { ButStatusJson, PRViewJsonResult } from "./helpers";
import { runLocalCommand } from "./helpers";

const CHECK_JSON_FIELDS = "name,state,bucket,link";
const GITHUB_ACTIONS_RUN_ID_RE = /github\.com\/[^/]+\/[^/]+\/actions\/runs\/(\d+)/;

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
        ? "Wait for the remaining checks to finish, or use --watch to block until CI settles."
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
  args.push("--json", "number,url,title,headRefName,baseRefName,state,isDraft,mergeable");

  const info = yield* gh.runGhJson<PRInfo>(args);
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

export const createPR = Effect.fn("pr.createPR")(function* (opts: {
  base: string;
  title: string;
  body: string;
  draft: boolean;
  head: string | null;
}) {
  const gh = yield* GitHubService;

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
    yield* gh.runGh(["pr", "edit", String(pr.number), "--title", opts.title, "--body", opts.body]);

    return yield* viewPR(pr.number);
  }

  const createArgs = [
    "pr",
    "create",
    "--base",
    opts.base,
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

  if (!opts.confirm) {
    const mergeableNote =
      info.mergeable === "MERGEABLE"
        ? "PR is mergeable."
        : `PR mergeable status: ${info.mergeable}`;

    yield* Console.log(
      `DRY RUN: Would merge PR #${info.number} "${info.title}" via ${opts.strategy.toUpperCase()}. ` +
        `Branch \`${info.headRefName}\` → \`${info.baseRefName}\`. ` +
        (opts.deleteBranch ? `Branch \`${info.headRefName}\` will be deleted. ` : "") +
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

  const mergeArgs = ["pr", "merge", String(opts.pr), `--${opts.strategy}`];

  if (opts.deleteBranch) {
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
    branchDeleted: opts.deleteBranch,
    sha: shaMatch?.[1] ?? null,
  };
  return result;
});

export const editPR = Effect.fn("pr.editPR")(function* (opts: {
  pr: number;
  title: string | null;
  body: string | null;
}) {
  if (!opts.title && !opts.body) {
    return yield* Effect.fail(
      new GitHubCommandError({
        command: "pr edit",
        exitCode: 1,
        stderr: "At least one of --title or --body must be provided",
        message: "At least one of --title or --body must be provided",
      }),
    );
  }

  const gh = yield* GitHubService;

  const editArgs = ["pr", "edit", String(opts.pr)];

  if (opts.title) {
    editArgs.push("--title", opts.title);
  }
  if (opts.body) {
    editArgs.push("--body", opts.body);
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

    const timeoutMs = timeoutSeconds * 1000;
    yield* gh.runGh(watchArgs).pipe(
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () =>
          Effect.fail(
            new GitHubTimeoutError({
              message: `CI check monitoring timed out after ${timeoutSeconds}s`,
              timeoutMs,
              hint: "CI checks are still running. Retry with a longer --timeout or check status manually.",
              nextCommand: `agent-tools-gh pr checks${pr !== null ? ` --pr ${pr}` : ""}`,
              retryable: true,
            }),
          ),
      }),
    );

    return yield* fetchCheckResults(pr);
  }

  const results = yield* fetchCheckResults(pr);
  if (results.some((c) => c.bucket === "pending")) {
    yield* Console.warn(
      `ℹ️  Some checks are still running. Prefer --watch to block until completion instead of polling:\n` +
        `   ${buildChecksCommand(pr, true)}`,
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

  const watchedChecks = yield* fetchChecks(pr, true, failFast, timeoutSeconds).pipe(Effect.result);

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

  const checks = yield* gh.runGhJson<
    Array<{
      name: string;
      link: string;
      bucket: string;
      state: string;
    }>
  >(["pr", "checks", ...(pr !== null ? [String(pr)] : []), "--json", "name,link,bucket,state"]);

  // Extract unique GitHub Actions run IDs from links
  const runIds = new Set<string>();
  for (const check of failedOnly ? checks.filter((c) => c.bucket === "fail") : checks) {
    const match = check.link.match(/github\.com\/[^/]+\/[^/]+\/actions\/runs\/(\d+)/);
    if (match?.[1]) {
      runIds.add(match[1]);
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
    const rerunArgs = failedOnly ? ["run", "rerun", runId, "--failed"] : ["run", "rerun", runId];
    const success = yield* gh.runGh(rerunArgs).pipe(
      Effect.map(() => true),
      Effect.catch(() => Effect.succeed(false)),
    );
    results.push({ runId, success });
  }

  return {
    rerun: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    runs: results,
    message: `Rerun ${results.filter((r) => r.success).length}/${results.length} GitHub Actions runs`,
  };
});
