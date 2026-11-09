import { Effect, Schema } from "effect";
import { GitHubCommandError } from "#gh/errors";
import type { GhError } from "./transport";

export type JsonRead = (args: string[]) => Effect.Effect<unknown, GhError>;
const User = Schema.Struct({ login: Schema.String, type: Schema.optional(Schema.String) });
const Ref = Schema.Struct({
  ref: Schema.String,
  sha: Schema.String,
  label: Schema.optional(Schema.String),
  user: Schema.NullOr(User),
});
export const RestPull = Schema.Struct({
  number: Schema.Number,
  html_url: Schema.String,
  title: Schema.String,
  state: Schema.String,
  draft: Schema.optional(Schema.Boolean),
  merged: Schema.optional(Schema.Boolean),
  merged_at: Schema.optional(Schema.NullOr(Schema.String)),
  mergeable: Schema.optional(Schema.NullOr(Schema.Boolean)),
  merge_commit_sha: Schema.optional(Schema.NullOr(Schema.String)),
  body: Schema.NullOr(Schema.String),
  user: User,
  head: Ref,
  base: Ref,
  created_at: Schema.String,
  requested_reviewers: Schema.optional(Schema.Array(User)),
  requested_teams: Schema.optional(
    Schema.Array(Schema.Struct({ name: Schema.String, slug: Schema.String })),
  ),
});
export const pullFromRest = (pull: typeof RestPull.Type) => ({
  number: pull.number,
  url: pull.html_url,
  title: pull.title,
  state: pull.merged === true || pull.merged_at != null ? "MERGED" : pull.state.toUpperCase(),
  isDraft: pull.draft ?? false,
  headRefName: pull.head.ref,
  baseRefName: pull.base.ref,
  headRefOid: pull.head.sha,
  headSha: pull.head.sha,
  baseSha: pull.base.sha,
  mergeable:
    pull.mergeable === true ? "MERGEABLE" : pull.mergeable === false ? "CONFLICTING" : "UNKNOWN",
  body: pull.body ?? "",
  author: { login: pull.user.login, is_bot: pull.user.type === "Bot" },
  createdAt: pull.created_at,
  headRepositoryOwner: pull.head.user === null ? null : { login: pull.head.user.login },
  mergeCommit:
    pull.merged === true || pull.merged_at != null
      ? pull.merge_commit_sha == null
        ? null
        : { oid: pull.merge_commit_sha }
      : null,
  reviewRequests: [
    ...(pull.requested_reviewers ?? []).map((user) => ({ __typename: "User", login: user.login })),
    ...(pull.requested_teams ?? []).map((team) => ({ __typename: "Team", ...team })),
  ],
  reviewDecision: "UNKNOWN",
  mergeStateStatus: "UNKNOWN",
});

export const parseRest = <A>(schema: Schema.Codec<A>, value: unknown) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(value),
    catch: (error) =>
      new GitHubCommandError({
        command: "GitHub REST",
        exitCode: 1,
        message: `Invalid REST response: ${String(error)}`,
        stderr: `Invalid REST response: ${String(error)}`,
      }),
  });
export const restGet = (read: JsonRead, path: string) => read(["api", "--method", "GET", path]);
export const restPages = (read: JsonRead, path: string) =>
  read(["api", "--method", "GET", path, "--paginate", "--slurp"]);
export const restPull = (read: JsonRead, repo: string, number: string) =>
  Effect.gen(function* () {
    return pullFromRest(
      yield* parseRest(RestPull, yield* restGet(read, `repos/${repo}/pulls/${number}`)),
    );
  });
const option = (args: readonly string[], flag: string) => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};
export const graphFieldsRequested = (args: readonly string[]) =>
  (option(args, "--json") ?? "")
    .split(",")
    .some((field) => field === "reviewDecision" || field === "mergeStateStatus");

export const restPorcelain = (
  args: string[],
  read: JsonRead,
  target: string | undefined,
): Effect.Effect<unknown, GhError> | null => {
  const repo = option(args, "--repo") ?? target ?? "{owner}/{repo}";
  const selector = args[2]?.startsWith("-") === false ? args[2] : undefined;
  if (args[0] === "repo" && args[1] === "view")
    return Effect.gen(function* () {
      const raw = yield* parseRest(
        Schema.Struct({
          owner: User,
          name: Schema.String,
          default_branch: Schema.String,
          html_url: Schema.String,
        }),
        yield* restGet(read, `repos/${selector ?? repo}`),
      );
      return {
        owner: { login: raw.owner.login },
        name: raw.name,
        defaultBranchRef: { name: raw.default_branch },
        url: raw.html_url,
      };
    });
  if (args[0] !== "pr") return null;
  if (
    args[1] === "merge" &&
    selector !== undefined &&
    /^\d+$/.test(selector) &&
    !args.includes("--auto") &&
    !args.includes("--admin")
  )
    return Effect.gen(function* () {
      const strategy = args.includes("--squash")
        ? "squash"
        : args.includes("--rebase")
          ? "rebase"
          : "merge";
      const sha = option(args, "--match-head-commit");
      const raw = yield* read([
        "api",
        "--method",
        "PUT",
        `repos/${repo}/pulls/${selector}/merge`,
        "-f",
        `merge_method=${strategy}`,
        ...(sha === undefined ? [] : ["-f", `sha=${sha}`]),
      ]);
      const result = yield* parseRest(
        Schema.Struct({ merged: Schema.Boolean, message: Schema.String }),
        raw,
      );
      if (!result.merged)
        return yield* new GitHubCommandError({
          command: "pr merge",
          exitCode: 1,
          message: result.message,
          stderr: result.message,
        });
      return result;
    });
  if (
    args[1] === "close" &&
    selector !== undefined &&
    /^\d+$/.test(selector) &&
    !args.includes("--comment") &&
    !args.includes("--delete-branch")
  )
    return read([
      "api",
      "--method",
      "PATCH",
      `repos/${repo}/pulls/${selector}`,
      "-f",
      "state=closed",
    ]);
  if (args[1] === "view" && selector !== undefined && /^\d+$/.test(selector))
    return restPull(read, repo, selector);
  if (
    args[1] === "list" &&
    option(args, "--search") === undefined &&
    option(args, "--author") === undefined
  )
    return Effect.gen(function* () {
      const state = option(args, "--state") ?? "open";
      const params = new URLSearchParams({
        state: state === "merged" ? "closed" : state,
        per_page: "100",
      });
      const head = option(args, "--head");
      if (head !== undefined)
        params.set("head", head.includes(":") ? head : `${repo.split("/")[0]}:${head}`);
      const base = option(args, "--base");
      if (base !== undefined) params.set("base", base);
      const pages = yield* parseRest(
        Schema.Array(Schema.Array(RestPull)),
        yield* restPages(read, `repos/${repo}/pulls?${params}`),
      );
      return pages
        .flat()
        .map(pullFromRest)
        .filter((pull) => state !== "merged" || pull.state === "MERGED")
        .slice(0, Number(option(args, "--limit") ?? 30));
    });
  if (args[1] === "checks" && selector !== undefined && /^\d+$/.test(selector))
    return Effect.gen(function* () {
      const pull = yield* restPull(read, repo, selector);
      const root = `repos/${repo}/commits/${pull.headSha}`;
      const runs = yield* parseRest(
        Schema.Array(
          Schema.Struct({
            check_runs: Schema.Array(
              Schema.Struct({
                name: Schema.String,
                status: Schema.String,
                conclusion: Schema.NullOr(Schema.String),
                html_url: Schema.NullOr(Schema.String),
              }),
            ),
          }),
        ),
        yield* restPages(read, `${root}/check-runs?per_page=100`),
      );
      const statuses = yield* parseRest(
        Schema.Array(
          Schema.Struct({
            statuses: Schema.Array(
              Schema.Struct({
                context: Schema.String,
                state: Schema.String,
                target_url: Schema.NullOr(Schema.String),
              }),
            ),
          }),
        ),
        yield* restPages(read, `${root}/status?per_page=100`),
      );
      const checks = runs.flatMap((page) =>
        page.check_runs.map((run) => ({
          name: run.name,
          state: (run.conclusion ?? run.status).toUpperCase(),
          bucket: bucket(run.conclusion ?? run.status),
          link: run.html_url ?? "",
        })),
      );
      const seen = new Set<string>();
      for (const status of statuses.flatMap((page) => page.statuses)) {
        if (seen.has(status.context)) continue;
        seen.add(status.context);
        checks.push({
          name: status.context,
          state: status.state.toUpperCase(),
          bucket: bucket(status.state),
          link: status.target_url ?? "",
        });
      }
      return checks;
    });
  return null;
};
const bucket = (state: string) => {
  switch (state) {
    case "success":
      return "pass";
    case "neutral":
    case "skipped":
      return "skipping";
    case "cancelled":
      return "cancel";
    case "failure":
    case "error":
    case "timed_out":
    case "action_required":
    case "stale":
    case "startup_failure":
      return "fail";
    default:
      return "pending";
  }
};
