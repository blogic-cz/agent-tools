import { Effect, Schema } from "effect";
import { GitHubService } from "#gh/read/transport";
import { GitHubCommandError } from "#gh/errors";
import type { CheckResult } from "#gh/types";
import { cachedRead, readFence, ReadCache, seedRead } from "./cache";
import { resolveTarget } from "#gh/pr/snapshot";
import { gatedRead } from "./gated";
import { restSnapshot, snapshotDigest } from "./rest";
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

export const prHead = Effect.fn("reads.prHead")(function* (
  repo: RepoRef,
  pr: number,
  consistency: "cached" | "origin" = "cached",
) {
  const snapshot = yield* restSnapshot(
    { op: "prHead", repo, pr },
    [{ kind: "single", path: `repos/${repoSlug(repo)}/pulls/${pr}` }],
    consistency,
  );
  const head = yield* Effect.try({
    try: () =>
      Schema.decodeUnknownSync(
        Schema.Struct({
          head: Schema.Struct({ sha: Schema.String }),
          base: Schema.Struct({ sha: Schema.String }),
        }),
      )(snapshot.pages[0]?.body),
    catch: (error) =>
      new GitHubCommandError({
        command: "pr head",
        exitCode: 0,
        message: String(error),
        stderr: String(error),
      }),
  });
  return { headSha: head.head.sha, baseSha: head.base.sha, signature: snapshotDigest(snapshot) };
});

export const checkSignal = Effect.fn("reads.checkSignal")(function* (repo: RepoRef, sha: string) {
  const snapshot = yield* restSnapshot({ op: "checkSignal", repo, sha }, [
    {
      kind: "pages",
      path: `repos/${repoSlug(repo)}/commits/${sha}/check-runs`,
      items: (body) =>
        Schema.decodeUnknownSync(Schema.Struct({ check_runs: Schema.Array(Schema.Unknown) }))(body)
          .check_runs,
    },
    {
      kind: "pages",
      path: `repos/${repoSlug(repo)}/commits/${sha}/status`,
      items: (body) =>
        Schema.decodeUnknownSync(Schema.Struct({ statuses: Schema.Array(Schema.Unknown) }))(body)
          .statuses,
    },
  ]);
  return snapshotDigest(snapshot);
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
  if (selector.by === "currentBranch" || repo === null) {
    const fence = yield* readFence;
    const data = (yield* fetch()).value;
    if (repo !== null && consistency !== "origin" && fence !== null) {
      const head = yield* prHead(repo, data.number).pipe(Effect.orElseSucceed(() => null));
      if (head !== null && head.headSha === data.headRefOid)
        yield* seedRead(
          { op: "prView", repo, pr: data.number },
          { data, originFetchedAt: Date.now(), signal: head.signature },
          fence,
        );
    }
    return data;
  }
  return yield* gatedRead({
    key: { op: "prView", repo, pr: selector.number },
    consistency,
    decode: parsePreserving(PullView),
    fetch: Effect.suspend(() => gh.runGhJson<PrView>(args)),
    signal: prHead(repo, selector.number).pipe(Effect.map((head) => head.signature)),
    maxAgeMs: () => OPS.prView.maxAgeMs,
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
  const session = yield* ReadCache;
  if (session === null || session.store === null) return (yield* fetch()).value;
  const number = yield* resolveTarget(pr, prView(repo, { by: "currentBranch" }));
  const head =
    headSha === null
      ? yield* prHead(repo, number, "origin").pipe(Effect.orElseSucceed(() => null))
      : { headSha };
  if (head === null) return (yield* fetch()).value;
  const sha = head.headSha;
  let verified = true;
  const stableFetch = Effect.gen(function* () {
    const before = yield* prHead(repo, number, "origin").pipe(Effect.orElseSucceed(() => null));
    if (before !== null && before.headSha !== sha) return yield* movedHead(number);
    const value = yield* gh.runGhJson<CheckResult[]>([
      "pr",
      "checks",
      String(number),
      "--repo",
      repoSlug(repo),
      "--json",
      "name,state,bucket,link",
    ]);
    const after = yield* prHead(repo, number, "origin").pipe(Effect.orElseSucceed(() => null));
    if (after !== null && after.headSha !== sha) return yield* movedHead(number);
    verified = before !== null && after !== null;
    return value;
  });
  return yield* gatedRead({
    key: { op: "prChecks", repo, pr: number, headSha: sha },
    decode: parsePreserving(Schema.mutable(Schema.Array(Check))),
    fetch: stableFetch,
    cacheableWhen: () => verified,
    signal: checkSignal(repo, sha),
    maxAgeMs: (value) =>
      value.length === 0 || value.some((check) => check.bucket === "pending")
        ? 15000
        : OPS.prChecks.maxAgeMs,
  });
});

const movedHead = (pr: number) =>
  new GitHubCommandError({
    command: `gh-tool pr checks --pr ${pr}`,
    exitCode: 1,
    message: "PR head changed while collecting checks",
    stderr: "PR head changed while collecting checks",
    retryable: true,
  });
