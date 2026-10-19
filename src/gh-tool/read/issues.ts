import { Effect, Schema } from "effect";
import { GitHubService } from "#gh/read/transport";
import { restSnapshot } from "./rest";
import { cachedRead } from "./cache";
import { OPS } from "./classes";
import { repoSlug } from "./keys";
import type { RepoRef } from "./keys";
import { parsePreserving } from "./porcelain";

const Label = Schema.Struct({ name: Schema.String });
const Login = Schema.Struct({ login: Schema.String });
const IssueListItem = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  state: Schema.String,
  url: Schema.String,
  labels: Schema.mutable(Schema.Array(Label)),
  createdAt: Schema.String,
});
const IssueView = Schema.Struct({
  ...IssueListItem.fields,
  assignees: Schema.mutable(Schema.Array(Login)),
  author: Login,
  body: Schema.String,
  closedAt: Schema.NullOr(Schema.String),
});
const IssueComment = Schema.Struct({
  id: Schema.Number,
  user: Login,
  body: Schema.String,
  created_at: Schema.String,
  html_url: Schema.String,
});
export type IssueView = typeof IssueView.Type;
export type IssueListFilter = { state: string; labels: string | null; limit: number };
export const ISSUE_LIST_FIELDS = "number,title,state,url,labels,createdAt";
export const ISSUE_VIEW_FIELDS =
  "number,title,state,url,labels,assignees,author,body,createdAt,closedAt";

export const issueView = Effect.fn("reads.issueView")(function* (
  repo: RepoRef,
  issue: number,
  consistency: "cached" | "origin" = "cached",
) {
  const gh = yield* GitHubService;
  return yield* cachedRead({
    key: { op: "issueView", repo, issue },
    policy: OPS.issueView,
    consistency,
    decode: parsePreserving(IssueView),
    fetch: () =>
      gh
        .runGhJson<IssueView>([
          "issue",
          "view",
          String(issue),
          "--repo",
          repoSlug(repo),
          "--json",
          ISSUE_VIEW_FIELDS,
        ])
        .pipe(Effect.map((value) => ({ kind: "fresh" as const, value }))),
  });
});

export const issueList = Effect.fn("reads.issueList")(function* (
  repo: RepoRef,
  filter: IssueListFilter,
) {
  const gh = yield* GitHubService;
  const args = [
    "issue",
    "list",
    "--state",
    filter.state,
    "--limit",
    String(filter.limit),
    "--json",
    ISSUE_LIST_FIELDS,
    "--repo",
    repoSlug(repo),
  ];
  if (filter.labels !== null) args.push("--label", filter.labels);
  return yield* cachedRead({
    key: { op: "issueList", repo, filter },
    policy: OPS.issueList,
    decode: parsePreserving(Schema.mutable(Schema.Array(IssueListItem))),
    fetch: () =>
      gh
        .runGhJson<Array<typeof IssueListItem.Type>>(args)
        .pipe(Effect.map((value) => ({ kind: "fresh" as const, value }))),
  });
});

export const issueComments = Effect.fn("reads.issueComments")(function* (
  repo: RepoRef,
  issue: number,
) {
  const snapshot = yield* restSnapshot({ op: "issueComments", repo, issue }, [
    {
      kind: "pages",
      path: `repos/${repoSlug(repo)}/issues/${issue}/comments`,
      items: Schema.decodeUnknownSync(Schema.Array(Schema.Unknown)),
    },
  ]);
  return snapshot.pages.flatMap((page) => page.body as Array<typeof IssueComment.Type>);
});
