import { Clock, Duration, Effect } from "effect";

import { GitHubService } from "#gh/service";
import { GitHubMergeError } from "#gh/errors";

import type { MergeStrategy, StackMember, StackMergeBlocker, StackMergeResult } from "#gh/types";

import { fetchCheckResults, fetchPRView } from "./core";
import { readStack } from "./stack-read";

export { readStack };

type AsyncMergeDetails = {
  message?: string;
  uuid?: string;
  sha?: string;
  merge_method?: MergeStrategy;
};

type AsyncMergeResult = {
  status: "pending" | "merged" | "enqueued" | "failed";
  details?: AsyncMergeDetails;
};

const POLL_INTERVAL_MS = 2000;
const MAX_WAIT_SECONDS = 300;

const stackMergeFailure = (opts: {
  stackNumber: number;
  pr: number;
  message: string;
  hint: string;
  reason?: GitHubMergeError["reason"];
}) =>
  new GitHubMergeError({
    message: `Failed to merge stack #${opts.stackNumber}: ${opts.message}`,
    reason: opts.reason ?? "unknown",
    hint: opts.hint,
    nextCommand: `agent-tools-gh pr stack view --pr ${opts.pr}`,
  });

const collectBlockers = Effect.fn("pr.collectStackBlockers")(function* (members: StackMember[]) {
  const blockers: StackMergeBlocker[] = [];

  for (const member of members) {
    if (member.isDraft) {
      blockers.push({ number: member.number, reason: "draft", detail: "PR is a draft" });
      continue;
    }

    const info = yield* fetchPRView(member.number);
    if (info.mergeable === "CONFLICTING") {
      blockers.push({
        number: member.number,
        reason: "not_mergeable",
        detail: "PR has merge conflicts",
      });
      continue;
    }

    if (info.mergeable !== "MERGEABLE") {
      blockers.push({
        number: member.number,
        reason: "mergeability_unknown",
        detail: `GitHub has not settled mergeability yet (${info.mergeable})`,
      });
      continue;
    }

    const checks = yield* fetchCheckResults(member.number);
    const failing = checks.filter((check) => check.bucket === "fail");
    if (failing.length > 0) {
      blockers.push({
        number: member.number,
        reason: "checks_failing",
        detail: `${failing.length} failing check(s): ${failing.map((c) => c.name).join(", ")}`,
      });
      continue;
    }

    const pending = checks.filter((check) => check.bucket === "pending");
    if (pending.length > 0) {
      blockers.push({
        number: member.number,
        reason: "checks_pending",
        detail: `${pending.length} check(s) still running`,
      });
    }
  }

  return blockers;
});

export const mergeStack = Effect.fn("pr.mergeStack")(function* (opts: {
  pr: number;
  strategy: MergeStrategy;
  confirm: boolean;
}) {
  const gh = yield* GitHubService;
  const repo = yield* gh.getRepoInfo();
  const view = yield* readStack({ pr: opts.pr });

  if (!view.isStacked || view.stackNumber === null || view.baseRef === null) {
    return yield* new GitHubMergeError({
      message: `PR #${opts.pr} is not part of a GitHub stack`,
      reason: "unknown",
      hint: "Use 'pr merge' for an unstacked PR. A chain of PRs based on each other is only a stack when GitHub has registered it as one.",
      nextCommand: `agent-tools-gh pr merge --pr ${opts.pr}`,
    });
  }

  const unmerged = view.members.filter((member) => member.state === "open");
  if (unmerged.length === 0) {
    return yield* new GitHubMergeError({
      message: `Stack #${view.stackNumber} has no open pull requests left`,
      reason: "unknown",
      hint: "Every member is already merged or closed.",
    });
  }

  // merge-async merges every unmerged PR up to and including the requested one, so the
  // top open member is the request that lands the whole stack.
  const target = unmerged[unmerged.length - 1] as StackMember;

  const blockers = yield* collectBlockers(unmerged);

  const plan = unmerged.map((member) => ({
    position: member.position,
    number: member.number,
    headRefName: member.headRefName,
  }));

  const base = {
    stackNumber: view.stackNumber,
    baseRef: view.baseRef,
    target: target.number,
    plan,
    blockers,
  };

  if (blockers.length > 0) {
    return yield* new GitHubMergeError({
      message:
        `Stack #${view.stackNumber} is not ready: ` +
        blockers.map((b) => `#${b.number} ${b.detail}`).join("; "),
      reason: "unknown",
      hint: "A partial stack merge leaves a parent on the trunk and a broken child, so nothing was attempted.",
    });
  }

  if (!opts.confirm) {
    return {
      ...base,
      strategy: opts.strategy,
      merged: false,
      dryRun: true,
      sha: null,
      adoptedExistingRequest: false,
    } satisfies StackMergeResult;
  }

  const asyncPath = `repos/${repo.owner}/${repo.name}/pulls/${target.number}/merge-async`;

  const requested = yield* gh.apiRequest<AsyncMergeResult>({
    path: asyncPath,
    method: "PUT",
    body: { merge_method: opts.strategy, merge_action: "direct_merge" },
    alsoAcceptStatus: [202, 409],
  });

  // A 409 hands back an existing request whose options may differ from the ones asked
  // for, so the result reports the strategy GitHub is actually applying.
  const adoptedExistingRequest = requested.status === 409;
  let latest = requested.body;
  const effectiveStrategy = latest.details?.merge_method ?? opts.strategy;

  const uuid = latest.details?.uuid;
  if (latest.status === "pending" && (uuid === undefined || uuid.length === 0)) {
    return yield* stackMergeFailure({
      stackNumber: view.stackNumber,
      pr: target.number,
      message: "GitHub reported a pending merge without a request id",
      hint: "The merge may or may not be running. Re-read the stack before retrying so the merge is not requested twice.",
    });
  }

  if (latest.status === "pending" && uuid !== undefined) {
    const start = yield* Clock.currentTimeMillis;
    const deadlineMs = Number(start) + MAX_WAIT_SECONDS * 1000;
    let timedOut = false;

    yield* Effect.whileLoop({
      while: () => latest.status === "pending" && !timedOut,
      body: () =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          if (Number(now) >= deadlineMs) {
            timedOut = true;
            return;
          }
          const remaining = deadlineMs - Number(now);
          yield* Effect.sleep(Duration.millis(Math.min(POLL_INTERVAL_MS, remaining)));
          const polled = yield* gh.apiRequest<AsyncMergeResult>({ path: `${asyncPath}/${uuid}` });
          latest = polled.body;
        }),
      step: () => undefined,
    });
  }

  if (latest.status === "merged") {
    return {
      ...base,
      strategy: effectiveStrategy,
      merged: true,
      dryRun: false,
      sha: latest.details?.sha ?? null,
      adoptedExistingRequest,
    } satisfies StackMergeResult;
  }

  if (latest.status === "enqueued") {
    return yield* stackMergeFailure({
      stackNumber: view.stackNumber,
      pr: target.number,
      reason: "merge_queue",
      message: latest.details?.message ?? "the stack entered a merge queue",
      hint: "The merge queue owns the merge from here; it is not merged yet. Watch the PRs until the queue drains.",
    });
  }

  if (latest.status === "pending") {
    return yield* stackMergeFailure({
      stackNumber: view.stackNumber,
      pr: target.number,
      message: `still pending after ${MAX_WAIT_SECONDS}s`,
      hint: "The asynchronous merge is still running. Re-check the stack before retrying so the merge is not requested twice.",
    });
  }

  return yield* stackMergeFailure({
    stackNumber: view.stackNumber,
    pr: target.number,
    message: latest.details?.message ?? "the merge request failed",
    hint: "Inspect the stack state and branch protections, then retry.",
  });
});
