import { Schema } from "effect";

export type MergeStrategy = "squash" | "merge" | "rebase";

export type PRInfo = {
  number: number;
  url: string;
  title: string;
  headRefName: string;
  baseRefName: string;
  state: string;
  isDraft: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
};

export type ReviewRequest =
  | { __typename: "User"; login: string }
  | { __typename: "Team"; name: string; slug: string };

export type PRViewInfo = PRInfo & {
  headSha: string | null;
  baseSha: string | null;
  body: string;
  author: { login: string; is_bot: boolean };
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "";
  reviewRequests: ReviewRequest[];
};

export const FeedbackOrigin = Schema.Literals(["current_head", "pre_existing", "unknown"]);
export type FeedbackOrigin = typeof FeedbackOrigin.Type;

export type ReviewThread = {
  threadId: string;
  commitSha: string | null;
  feedbackOrigin: FeedbackOrigin;
  commentId: number;
  path: string;
  line: number;
  body: string;
  isResolved: boolean;
  hasReply: boolean;
  replyCount: number;
  needsHumanReply: boolean;
  isVisibleOpen: boolean;
  lastReplyAuthor: string | null;
  lastReplyAt: string | null;
  reviewId: number | null;
  updatedAt: string | null;
  /** Thread ids of exact duplicates collapsed into this representative (encounter order). */
  duplicateThreadIds: string[];
};

export type ReviewComment = {
  id: number;
  commitSha: string | null;
  feedbackOrigin: FeedbackOrigin;
  inReplyToId: number | null;
  author: string;
  body: string;
  path: string;
  line: number;
  createdAt: string;
  reviewId: number | null;
  /**
   * Last change to the comment. A comment drafted inside a pending review keeps its draft time in
   * `createdAt` and carries the submit time here until someone edits it, so this is a proxy for
   * when the comment became visible. Join `reviewId` to the review's `submittedAt` for the exact
   * time.
   */
  updatedAt: string;
};

export const IssueCommentId = Schema.Int.pipe(Schema.brand("IssueCommentId"));
export type IssueCommentId = typeof IssueCommentId.Type;

export const IsoTimestamp = Schema.String.pipe(Schema.brand("IsoTimestamp"));
export type IsoTimestamp = typeof IsoTimestamp.Type;

export const GitHubIssueCommentUrl = Schema.String.pipe(Schema.brand("GitHubIssueCommentUrl"));
export type GitHubIssueCommentUrl = typeof GitHubIssueCommentUrl.Type;

export type IssueComment = {
  id: IssueCommentId;
  commitSha: null;
  feedbackOrigin: "unknown";
  author: string;
  body: string;
  createdAt: IsoTimestamp;
  url: GitHubIssueCommentUrl;
};

export type PullRequestReview = {
  id: number;
  commitSha: string | null;
  feedbackOrigin: FeedbackOrigin;
  author: string;
  state: string;
  body: string;
  submittedAt: IsoTimestamp | null;
  url: string;
};

export type CheckResult = {
  name: string;
  state: string;
  bucket: string;
  link: string;
};

export type FailedCheckJob = {
  databaseId: number;
  jobId: number;
  checkId: number | null;
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
  failedSteps: string[];
};

export type FailedCheckRunContext = {
  runId: number;
  attempt: number | null;
  url: string | null;
  workflowName: string | null;
  status: string;
  conclusion: string | null;
  failedJobs: FailedCheckJob[];
};

export type FailedCheckDetail = CheckResult & {
  runId: number | null;
  run: FailedCheckRunContext | null;
  failedStepLogs?: string;
  diagnosis?: LogDiagnosis;
};

export const LogDiagnosisCategory = Schema.Literals([
  "infrastructure",
  "network",
  "timeout",
  "test_failure",
  "build_failure",
  "lint_failure",
  "unknown",
]);
export type LogDiagnosisCategory = typeof LogDiagnosisCategory.Type;

export type LogDiagnosis = {
  category: LogDiagnosisCategory;
  fingerprint: string;
  testsStarted: boolean | null;
  firstRelevantError: string | null;
};

export const RerunRetryEvidenceState = Schema.Literals(["eligible", "ineligible", "unavailable"]);
export type RerunRetryEvidenceState = typeof RerunRetryEvidenceState.Type;

export type RerunRetryEvidence =
  | { state: "eligible"; diagnosis: LogDiagnosis }
  | { state: "ineligible"; diagnosis: LogDiagnosis; reason: string }
  | { state: "unavailable"; reason: string };

export const RerunCheckStatus = Schema.Literals([
  "blocked",
  "evidence_unavailable",
  "escalation_required",
  "rerun_started",
  "failed",
  "discovery_timeout",
  "completed",
  "watch_timeout",
]);
export type RerunCheckStatus = typeof RerunCheckStatus.Type;

export type RerunCheckJob = {
  databaseId: number;
  name: string;
  status: string;
  conclusion: string | null;
};

export type RerunCheckAttempt = {
  databaseId: number;
  attempt?: number | null;
  jobs: RerunCheckJob[];
  status?: string;
};

export type RerunChecksRun = {
  runId: string;
  success: boolean;
  currentAttempt: number | null;
  currentJobIds: number[] | null;
  evidence: RerunRetryEvidence;
  status: RerunCheckStatus;
  newAttempt?: number | null;
  newJobIds?: number[] | null;
  latestAttempt?: RerunCheckAttempt | null;
};

export type RerunChecksReport = {
  rerun: number;
  failed?: number;
  message: string;
  status?: "evidence_unavailable" | "escalation_required" | "failed" | "rerun_started";
  runs?: RerunChecksRun[];
};

export type FailedChecksReport = {
  evidence: { headSha: string | null; baseSha: string | null } | null;
  status: "failed" | "no_failures";
  message: string;
  summary: {
    total: number;
    failed: number;
    pending: number;
    passed: number;
  };
  failedChecks: FailedCheckDetail[];
  pendingChecks: CheckResult[];
  hint: string;
  nextCommands: string[];
};

export type WorkflowRunDetail = {
  databaseId: number;
  attempt: number | null;
  url: string;
  workflowName: string | null;
  status: string;
  conclusion: string | null;
  jobs: Array<{
    databaseId: number;
    name: string;
    status: string;
    conclusion: string | null;
    url: string;
    steps: Array<{
      name: string;
      status: string;
      conclusion: string | null;
    }>;
  }>;
};

export type MergeResult = {
  merged: boolean;
  strategy: MergeStrategy;
  branchDeleted: boolean;
  sha: string | null;
  /** PR numbers whose base was retargeted off the deleted branch before deletion. */
  retargetedChildren?: number[];
  /** True when branch deletion was requested but skipped to protect dependent PRs. */
  branchDeleteSkipped?: boolean;
};

export type RepoInfo = {
  owner: string;
  name: string;
  defaultBranch: string;
  url: string;
};

export type PRStatusSingle = {
  mode: "single";
  pr: PRInfo;
};

export type PRStatusMultiple = {
  mode: "multiple";
  prs: PRInfo[];
};

export type BranchPRDetail = {
  branch: string;
  remoteExists: boolean;
  closedPr: {
    number: number;
    url: string;
    state: "MERGED" | "CLOSED";
  } | null;
};

export type PRStatusNone = {
  mode: "none";
  branches: BranchPRDetail[];
};

export type PRStatusResult = PRStatusSingle | PRStatusMultiple | PRStatusNone;

export type BranchRenameResult = {
  renamed: boolean;
  oldName: string;
  newName: string;
  dryRun?: true;
  message?: string;
};

export type CheckRunAnnotation = {
  path: string;
  start_line: number;
  end_line: number;
  start_column: number | null;
  end_column: number | null;
  annotation_level: "notice" | "warning" | "failure";
  title: string | null;
  message: string;
  raw_details: string | null;
};

export type JobAnnotations = {
  jobId: number;
  jobName: string;
  annotations: CheckRunAnnotation[];
};
