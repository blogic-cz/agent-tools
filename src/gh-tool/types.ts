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
};

export type ReviewThread = {
  threadId: string;
  commentId: number;
  path: string;
  line: number;
  body: string;
  isResolved: boolean;
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

export type MergeResult = {
  merged: boolean;
  strategy: MergeStrategy;
  branchDeleted: boolean;
  sha: string | null;
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
