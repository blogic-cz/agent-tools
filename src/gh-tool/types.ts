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
  body: string;
  author: { login: string; is_bot: boolean };
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "";
  reviewRequests: ReviewRequest[];
};

export type ReviewThread = {
  threadId: string;
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
};

export type ReviewComment = {
  id: number;
  inReplyToId: number | null;
  author: string;
  body: string;
  path: string;
  line: number;
  createdAt: string;
};

export const IssueCommentId = Schema.Int.pipe(Schema.brand("IssueCommentId"));
export type IssueCommentId = typeof IssueCommentId.Type;

export const IsoTimestamp = Schema.String.pipe(Schema.brand("IsoTimestamp"));
export type IsoTimestamp = typeof IsoTimestamp.Type;

export const GitHubIssueCommentUrl = Schema.String.pipe(Schema.brand("GitHubIssueCommentUrl"));
export type GitHubIssueCommentUrl = typeof GitHubIssueCommentUrl.Type;

export type IssueComment = {
  id: IssueCommentId;
  author: string;
  body: string;
  createdAt: IsoTimestamp;
  url: GitHubIssueCommentUrl;
};

export type CheckResult = {
  name: string;
  state: string;
  bucket: string;
  link: string;
};

export type FailedCheckJob = {
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
  failedSteps: string[];
};

export type FailedCheckRunContext = {
  runId: number;
  url: string | null;
  workflowName: string | null;
  status: string;
  conclusion: string | null;
  failedJobs: FailedCheckJob[];
};

export type FailedCheckDetail = CheckResult & {
  runId: number | null;
  run: FailedCheckRunContext | null;
};

export type FailedChecksReport = {
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
  url: string;
  workflowName: string | null;
  status: string;
  conclusion: string | null;
  jobs: Array<{
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
