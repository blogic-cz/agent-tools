import { Effect, Schema } from "effect";
import { GitHubService } from "#gh/service";
import type { CheckResult } from "#gh/types";
import { cachedRead } from "./cache";
import { OPS } from "./classes";
import { repoSlug } from "./keys";
import type { RepoRef } from "./keys";
import { parsePreserving } from "./porcelain";

export const PR_VIEW_FIELDS =
  "number,url,title,headRefName,baseRefName,headRefOid,state,isDraft,mergeable,body,author,reviewDecision,reviewRequests,createdAt,headRepositoryOwner,mergeCommit";
export const PR_LIST_FIELDS =
  "number,url,title,headRefName,baseRefName,state,isDraft,mergeable,author,createdAt,reviewDecision,headRepositoryOwner";
export type PrListFilter = {
  state: string;
  limit: number;
  author: string | null;
  base: string | null;
  head: string | null;
  search: string | null;
};
export type PrSelector = { by: "number"; number: number } | { by: "currentBranch" };
const Pull = Schema.Struct({
  number: Schema.Number,
  url: Schema.String,
  title: Schema.String,
  headRefName: Schema.String,
  baseRefName: Schema.String,
  state: Schema.String,
  isDraft: Schema.Boolean,
  mergeable: Schema.Literals(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
  author: Schema.optional(
    Schema.Struct({ login: Schema.String, is_bot: Schema.optional(Schema.Boolean) }),
  ),
  createdAt: Schema.optional(Schema.String),
  reviewDecision: Schema.optional(Schema.String),
  headRepositoryOwner: Schema.optional(Schema.Struct({ login: Schema.String })),
});

const PullView = Schema.Struct({
  ...Pull.fields,
  headRefOid: Schema.optional(Schema.String),
  headSha: Schema.optional(Schema.NullOr(Schema.String)),
  baseSha: Schema.optional(Schema.NullOr(Schema.String)),
  body: Schema.String,
  author: Schema.Struct({ login: Schema.String, is_bot: Schema.Boolean }),
  reviewDecision: Schema.Literals(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED", ""]),
  reviewRequests: Schema.mutable(
    Schema.Array(
      Schema.Union([
        Schema.Struct({ __typename: Schema.Literal("User"), login: Schema.String }),
        Schema.Struct({
          __typename: Schema.Literal("Team"),
          name: Schema.String,
          slug: Schema.String,
        }),
      ]),
    ),
  ),
  mergeCommit: Schema.optional(Schema.NullOr(Schema.Struct({ oid: Schema.String }))),
});
export type PrView = typeof PullView.Type;
export type PrListItem = typeof Pull.Type;
const Check = Schema.Struct({
  name: Schema.String,
  state: Schema.String,
  bucket: Schema.String,
  link: Schema.String,
});

export const prView = Effect.fn("reads.prView")(function* (
  repo: RepoRef | null,
  selector: PrSelector,
  consistency: "cached" | "origin" = "cached",
) {
  const gh = yield* GitHubService;
  const args = [
    "pr",
    "view",
    ...(selector.by === "number" ? [String(selector.number)] : []),
    ...(repo === null ? [] : ["--repo", repoSlug(repo)]),
    "--json",
    PR_VIEW_FIELDS,
  ];
  const fetch = () =>
    gh.runGhJson<PrView>(args).pipe(Effect.map((value) => ({ kind: "fresh" as const, value })));
  if (selector.by === "currentBranch" || repo === null) return (yield* fetch()).value;
  return yield* cachedRead({
    key: { op: "prView", repo, pr: selector.number },
    policy: OPS.prView,
    consistency,
    decode: parsePreserving(PullView),
    fetch,
  });
});

export const prList = Effect.fn("reads.prList")(function* (
  repo: RepoRef,
  filter: PrListFilter,
  consistency: "cached" | "origin" = "cached",
) {
  const gh = yield* GitHubService;
  const args = [
    "pr",
    "list",
    "--state",
    filter.state,
    "--limit",
    String(filter.limit),
    "--repo",
    repoSlug(repo),
    "--json",
    PR_LIST_FIELDS,
  ];
  for (const [flag, value] of [
    ["--author", filter.author],
    ["--base", filter.base],
    ["--head", filter.head],
    ["--search", filter.search],
  ] as const)
    if (value !== null) args.push(flag, value);
  return yield* cachedRead({
    key: { op: "prList", repo, filter },
    policy: OPS.prList,
    consistency,
    decode: parsePreserving(Schema.mutable(Schema.Array(Pull))),
    fetch: () =>
      gh
        .runGhJson<PrListItem[]>(args)
        .pipe(Effect.map((value) => ({ kind: "fresh" as const, value }))),
  });
});

export const prChecks = Effect.fn("reads.prChecks")(function* (
  repo: RepoRef,
  pr: number | null,
  headSha: string | null,
) {
  const gh = yield* GitHubService;
  const fetch = () =>
    gh
      .runGhJson<CheckResult[]>([
        "pr",
        "checks",
        ...(pr === null ? [] : [String(pr)]),
        "--repo",
        repoSlug(repo),
        "--json",
        "name,state,bucket,link",
      ])
      .pipe(Effect.map((value) => ({ kind: "fresh" as const, value })));
  if (pr === null || headSha === null) return (yield* fetch()).value;
  return yield* cachedRead({
    key: { op: "prChecks", repo, pr, headSha },
    policy: OPS.prChecks,
    decode: parsePreserving(Schema.mutable(Schema.Array(Check))),
    fetch,
  });
});
