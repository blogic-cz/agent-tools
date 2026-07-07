#!/usr/bin/env bun
import { Command } from "effect/unstable/cli";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";

import { makeSchemaCommand, renderCauseToStderr, VERSION } from "#shared";
import { AuditServiceLayer, withAudit } from "#shared/audit";
import { ConfigServiceLayer } from "#config";
import {
  issueCloseCommand,
  issueCommentCommand,
  issueCommentsCommand,
  issueEditCommand,
  issueListCommand,
  issueReopenCommand,
  issueSnapshotBatchCommand,
  issueTriageCommand,
  issueViewCommand,
} from "./issue";
import {
  prViewCommand,
  prStatusCommand,
  prListCommand,
  prCreateCommand,
  prCloseCommand,
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
  prReviewTriageBatchCommand,
  prReviewTriageCommand,
  prWaitMergeableCommand,
} from "./pr/index";
import { branchRenameCommand } from "./branch";
import {
  releaseCreateCommand,
  releaseDeleteCommand,
  releaseEditCommand,
  releaseListCommand,
  releaseStatusCommand,
  releaseViewCommand,
} from "./release";
import { repoInfoCommand, repoListCommand, repoSearchCodeCommand } from "./repo";
import { GitHubService } from "./service";
import {
  workflowAnnotationsCommand,
  workflowCancelCommand,
  workflowJobLogsCommand,
  workflowJobsCommand,
  workflowListCommand,
  workflowLogsCommand,
  workflowRerunCommand,
  workflowRunCommand,
  workflowViewCommand,
  workflowWatchCommand,
} from "./workflow";

const prCommand = Command.make("pr", {}).pipe(
  Command.withDescription("Pull request operations (view, create, merge, reviews, checks)"),
  Command.withSubcommands([
    prViewCommand,
    prStatusCommand,
    prListCommand,
    prCreateCommand,
    prCloseCommand,
    prEditCommand,
    prMergeCommand,
    prWaitMergeableCommand,
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
    prReviewTriageBatchCommand,
  ]),
);

const issueCommand = Command.make("issue", {}).pipe(
  Command.withDescription(
    "Issue operations (list, view, comments, triage, snapshot-batch, close, reopen, comment, edit)",
  ),
  Command.withSubcommands([
    issueListCommand,
    issueViewCommand,
    issueCommentsCommand,
    issueTriageCommand,
    issueSnapshotBatchCommand,
    issueCloseCommand,
    issueReopenCommand,
    issueCommentCommand,
    issueEditCommand,
  ]),
);

const branchCommand = Command.make("branch", {}).pipe(
  Command.withDescription("Branch operations (rename)"),
  Command.withSubcommands([branchRenameCommand]),
);

const repoCommand = Command.make("repo", {}).pipe(
  Command.withDescription("Repository operations"),
  Command.withSubcommands([repoInfoCommand, repoListCommand, repoSearchCodeCommand]),
);

const workflowCommand = Command.make("workflow", {}).pipe(
  Command.withDescription(
    "GitHub Actions workflow operations (run, list, view, jobs, logs, job-logs, annotations, rerun, cancel, watch)",
  ),
  Command.withSubcommands([
    workflowRunCommand,
    workflowListCommand,
    workflowViewCommand,
    workflowJobsCommand,
    workflowLogsCommand,
    workflowJobLogsCommand,
    workflowAnnotationsCommand,
    workflowRerunCommand,
    workflowCancelCommand,
    workflowWatchCommand,
  ]),
);

const releaseCommand = Command.make("release", {}).pipe(
  Command.withDescription("Release operations (create, list, view, edit, delete, status)"),
  Command.withSubcommands([
    releaseCreateCommand,
    releaseListCommand,
    releaseViewCommand,
    releaseEditCommand,
    releaseDeleteCommand,
    releaseStatusCommand,
  ]),
);

const commandsCommand = makeSchemaCommand(() => mainCommand);

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
  8. Use 'issue triage --issue N --verbosity full' to inspect one issue in one call
  9. Use 'issue comments --issue N' to read issue discussion comments separately
  10. Use 'issue close --issue N --comment "reason"' to close issues
  11. Use 'issue comment --issue N --body "text"' to comment on issues
  12. Use 'repo info' to get repository metadata
  13. Use 'workflow run' to dispatch workflow_dispatch workflows
  14. Use 'workflow list' to list recent workflow runs
  15. Use 'workflow view --run N' to inspect a specific run with jobs/steps
  16. Use 'workflow logs --run N' to get logs (failed jobs by default)
  17. Use 'workflow job-logs --run N --job "build-web-app"' to get clean parsed logs for a specific job
  18. Use 'workflow annotations --run N' to list CI annotations (errors, warnings, notices)
  19. Use 'workflow watch --run N' to watch until completion
  20. Use 'release status' to inspect latest release + repository context
  21. Use 'release create --tag vX.Y.Z --generate-notes' to publish a release
  22. Use 'release edit/view/list/delete' to maintain existing releases
  23. Use 'branch rename --old-name X --new-name Y --confirm' to rename a branch`,
  ),
  Command.withSubcommands([
    prCommand,
    issueCommand,
    repoCommand,
    branchCommand,
    workflowCommand,
    releaseCommand,
    commandsCommand,
  ]),
);

const cli = Command.run(mainCommand, {
  version: VERSION,
});

const MainLayer = GitHubService.layer.pipe(
  Layer.provideMerge(BunServices.layer),
  Layer.provideMerge(AuditServiceLayer),
  Layer.provideMerge(ConfigServiceLayer),
);

const program = withAudit("gh", cli).pipe(
  Effect.provide(MainLayer),
  Effect.tapCause(renderCauseToStderr),
);

BunRuntime.runMain(program, {
  disableErrorReporting: true,
});
