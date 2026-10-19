import { createHash } from "node:crypto";

export type RepoRef = { readonly owner: string; readonly name: string };
export type RunFilter = {
  readonly workflow: string | null;
  readonly branch: string | null;
  readonly status: string | null;
  readonly event: string | null;
  readonly limit: number;
};
export type ReadKey = { readonly repo: RepoRef } & (
  | {
      readonly op:
        | "prView"
        | "prChecks"
        | "prHead"
        | "prComments"
        | "prReviews"
        | "reviewThreads"
        | "lastHumanReviewer";
      readonly pr: number;
    }
  | { readonly op: "checkSignal"; readonly sha: string }
  | {
      readonly op: "prList" | "issueList";
      readonly filter: Readonly<Record<string, string | number | boolean | null>>;
    }
  | { readonly op: "issueView" | "issueComments"; readonly issue: number }
  | { readonly op: "runList"; readonly filter: RunFilter }
  | { readonly op: "runView"; readonly runId: number }
  | { readonly op: "runJobs"; readonly runId: number; readonly attempt: number }
  | {
      readonly op: "runLog";
      readonly runId: number;
      readonly attempt: number;
      readonly failedOnly: boolean;
      readonly jobId: number | null;
    }
  | { readonly op: "jobLog" | "annotations" | "jobIdentity"; readonly jobId: number }
);
export type Op = ReadKey["op"];
export type Tag =
  `${"pr" | "reviews" | "review-comments" | "threads" | "issue" | "issue-comments" | "run" | "checks" | "pulls" | "issues" | "runs" | "repo"}:${string}`;

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
};
export const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
export const repoSlug = (repo: RepoRef): string => `${repo.owner}/${repo.name}`.toLowerCase();
export const entryKey = (identity: string, key: ReadKey): string =>
  digest(JSON.stringify(canonical({ schema: 1, identity, ...key, repo: repoSlug(key.repo) })));
export const tagsFor = (key: ReadKey): readonly Tag[] => {
  const repo = repoSlug(key.repo);
  const fallback: Tag = `repo:${repo}`;
  switch (key.op) {
    case "prView":
    case "prHead":
    case "lastHumanReviewer":
      return [fallback, `pr:${repo}#${key.pr}`];
    case "prChecks":
      return [fallback, `pr:${repo}#${key.pr}`, `checks:${repo}#${key.pr}`];
    case "checkSignal":
      return [fallback, `checks:${repo}@${key.sha}`];
    case "prComments":
      return [fallback, `review-comments:${repo}#${key.pr}`];
    case "prReviews":
      return [fallback, `reviews:${repo}#${key.pr}`];
    case "reviewThreads":
      return [fallback, `threads:${repo}#${key.pr}`];
    case "prList":
      return [fallback, `pulls:${repo}`];
    case "issueList":
      return [fallback, `issues:${repo}`];
    case "issueView":
      return [fallback, `issue:${repo}#${key.issue}`];
    case "issueComments":
      return [fallback, `issue-comments:${repo}#${key.issue}`];
    case "runView":
    case "runJobs":
    case "runLog":
      return [fallback, `run:${repo}/${key.runId}`];
    case "runList":
      return [fallback, `runs:${repo}`];
    case "jobLog":
    case "annotations":
    case "jobIdentity":
      return [fallback];
    default: {
      const exhaustive: never = key;
      return exhaustive;
    }
  }
};
