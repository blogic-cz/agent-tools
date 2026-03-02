#!/usr/bin/env bun
import { Command } from "effect/unstable/cli";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";

import { renderCauseToStderr, VERSION } from "#shared";
import {
  issueListCommand,
  issueViewCommand,
  issueCloseCommand,
  issueReopenCommand,
  issueCommentCommand,
  issueEditCommand,
} from "./issue";
import {
  prViewCommand,
  prStatusCommand,
  prCreateCommand,
  prEditCommand,
  prMergeCommand,
  prThreadsCommand,
  prCommentsCommand,
  prIssueCommentsCommand,
  prIssueCommentsLatestCommand,
  prCommentCommand,
  prDiscussionSummaryCommand,
  prReplyCommand,
  prResolveCommand,
  prSubmitReviewCommand,
  prChecksCommand,
  prChecksFailedCommand,
  prRerunChecksCommand,
  prReplyAndResolveCommand,
  prReviewTriageCommand,
} from "./pr/index";
import { repoInfoCommand, repoListCommand, repoSearchCodeCommand } from "./repo";
import { GitHubService } from "./service";
import {
  workflowCancelCommand,
  workflowJobLogsCommand,
  workflowJobsCommand,
  workflowListCommand,
  workflowLogsCommand,
  workflowRerunCommand,
  workflowViewCommand,
  workflowWatchCommand,
} from "./workflow";

const prCommand = Command.make("pr", {}).pipe(
  Command.withDescription("Pull request operations (view, create, merge, reviews, checks)"),
  Command.withSubcommands([
    prViewCommand,
    prStatusCommand,
    prCreateCommand,
    prEditCommand,
    prMergeCommand,
    prThreadsCommand,
    prCommentsCommand,
    prIssueCommentsCommand,
    prIssueCommentsLatestCommand,
    prCommentCommand,
    prDiscussionSummaryCommand,
    prReplyCommand,
    prResolveCommand,
    prSubmitReviewCommand,
    prChecksCommand,
    prChecksFailedCommand,
    prRerunChecksCommand,
    prReplyAndResolveCommand,
    prReviewTriageCommand,
  ]),
);

const issueCommand = Command.make("issue", {}).pipe(
  Command.withDescription("Issue operations (list, view, close, reopen, comment, edit)"),
  Command.withSubcommands([
    issueListCommand,
    issueViewCommand,
    issueCloseCommand,
    issueReopenCommand,
    issueCommentCommand,
    issueEditCommand,
  ]),
);

const repoCommand = Command.make("repo", {}).pipe(
  Command.withDescription("Repository operations"),
  Command.withSubcommands([repoInfoCommand, repoListCommand, repoSearchCodeCommand]),
);

const workflowCommand = Command.make("workflow", {}).pipe(
  Command.withDescription(
    "GitHub Actions workflow operations (list runs, view, jobs, logs, job-logs, rerun, cancel, watch)",
  ),
  Command.withSubcommands([
    workflowListCommand,
    workflowViewCommand,
    workflowJobsCommand,
    workflowLogsCommand,
    workflowJobLogsCommand,
    workflowRerunCommand,
    workflowCancelCommand,
    workflowWatchCommand,
  ]),
);

const mainCommand = Command.make("gh-tool", {}).pipe(
  Command.withDescription(
    `GitHub CLI Tool for Coding Agents

Wraps the GitHub CLI (gh) with structured output for AI agents.
Supports PR management, issue management, reviews, CI checks, and repo info.

WORKFLOW FOR AI AGENTS:
  1. Use 'pr view' to inspect current PR
  2. Use 'pr discussion-summary' for overview (counts + latest discussion comment)
  3. Use 'pr threads' and 'pr issue-comments-latest --author <username> --body-contains "Review"' for review context
  4. Use 'pr submit-review', 'pr reply', 'pr comment' and 'pr resolve' to handle feedback
  5. Use 'pr checks' to monitor CI status
  6. Use 'pr merge' to merge (dry-run by default)
  7. Use 'issue list' to list open/closed issues
  8. Use 'issue close --issue N --comment "reason"' to close issues
   9. Use 'issue comment --issue N --body "text"' to comment on issues
  10. Use 'repo info' to get repository metadata
  11. Use 'workflow list' to list recent workflow runs
  12. Use 'workflow view --run N' to inspect a specific run with jobs/steps
  13. Use 'workflow logs --run N' to get logs (failed jobs by default)
  14. Use 'workflow job-logs --run N --job "build-web-app"' to get clean parsed logs for a specific job
  15. Use 'workflow watch --run N' to watch until completion`,
  ),
  Command.withSubcommands([prCommand, issueCommand, repoCommand, workflowCommand]),
);

const cli = Command.run(mainCommand, {
  version: VERSION,
});

const MainLayer = GitHubService.layer.pipe(Layer.provideMerge(BunServices.layer));

const program = cli.pipe(Effect.provide(MainLayer), Effect.tapCause(renderCauseToStderr));

BunRuntime.runMain(program, {
  disableErrorReporting: true,
});
