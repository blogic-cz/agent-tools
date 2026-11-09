import { Effect, Result, Schema } from "effect";
import { GitHubCommandError } from "#gh/errors";
import type { GhError } from "./transport";

export type JsonRead = (args: string[]) => Effect.Effect<unknown, GhError>;
export type ReviewDecision = "" | "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "UNKNOWN";
const User = Schema.Struct({ login: Schema.String, type: Schema.String });
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
  draft: Schema.Boolean,
  merged: Schema.optional(Schema.Boolean),
  merged_at: Schema.NullOr(Schema.String),
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
  state:
    pull.merged === true || (pull.merged_at !== null && pull.merged_at !== undefined)
      ? "MERGED"
      : pull.state.toUpperCase(),
  isDraft: pull.draft,
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
    pull.merged === true || (pull.merged_at !== null && pull.merged_at !== undefined)
      ? pull.merge_commit_sha === null || pull.merge_commit_sha === undefined
        ? null
        : { oid: pull.merge_commit_sha }
      : null,
  reviewRequests: [
    ...(pull.requested_reviewers ?? []).map((user) => ({ __typename: "User", login: user.login })),
    ...(pull.requested_teams ?? []).map((team) => ({
      __typename: "Team",
      name: team.name,
      slug: team.slug,
    })),
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

type ReviewRule = {
  approvals: number;
  codeOwner: boolean;
  dismissStale: boolean;
  lastPush: boolean;
};
const RestReviewRule = Schema.Struct({
  required_approving_review_count: Schema.optional(Schema.Number),
  require_code_owner_review: Schema.optional(Schema.Boolean),
  dismiss_stale_reviews_on_push: Schema.optional(Schema.Boolean),
  require_last_push_approval: Schema.optional(Schema.Boolean),
});
const reviewRule = (parameters: unknown) => {
  const decoded = Schema.decodeUnknownSync(RestReviewRule)(parameters);
  return {
    approvals: decoded.required_approving_review_count ?? 0,
    codeOwner: decoded.require_code_owner_review ?? false,
    dismissStale: decoded.dismiss_stale_reviews_on_push ?? false,
    lastPush: decoded.require_last_push_approval ?? false,
  };
};
const noRulesets = (error: unknown) =>
  error instanceof Error &&
  (/HTTP 404|Not Found/i.test(error.message) ||
    (/HTTP 403/i.test(error.message) &&
      /Upgrade to GitHub Pro|make this repository public/i.test(error.message)));
const restValue = <A>(read: JsonRead, path: string, schema: Schema.Codec<A>) =>
  restGet(read, path).pipe(
    Effect.flatMap((value) => parseRest(schema, value)),
    Effect.result,
  );
const Rulesets = Schema.Array(
  Schema.Struct({ type: Schema.String, parameters: Schema.optional(Schema.Unknown) }),
);

export const restReviewDecision = (
  read: JsonRead,
  input: { repo: string; number: number; baseRefName: string; headSha: string },
): Effect.Effect<ReviewDecision> =>
  Effect.gen(function* () {
    const base = encodeURIComponent(input.baseRefName);
    const rulesetResult = yield* restValue(
      read,
      `repos/${input.repo}/rules/branches/${base}`,
      Rulesets,
    );
    let rulesets: ReviewRule[] = [];
    if (Result.isFailure(rulesetResult)) {
      if (!noRulesets(rulesetResult.failure)) return "UNKNOWN";
    } else {
      try {
        rulesets = rulesetResult.success.flatMap((rule) =>
          rule.type === "pull_request" ? [reviewRule(rule.parameters)] : [],
        );
      } catch {
        return "UNKNOWN";
      }
    }

    const branchResult = yield* restValue(
      read,
      `repos/${input.repo}/branches/${base}`,
      Schema.Struct({ protected: Schema.Boolean }),
    );
    if (Result.isFailure(branchResult)) return "UNKNOWN";

    let classic: ReviewRule[] = [];
    if (branchResult.success.protected) {
      const protectionResult = yield* restValue(
        read,
        `repos/${input.repo}/branches/${base}/protection/required_pull_request_reviews`,
        RestReviewRule,
      );
      if (Result.isFailure(protectionResult)) {
        if (!/HTTP 404|Not Found/i.test(protectionResult.failure.message)) return "UNKNOWN";
      } else {
        classic = [reviewRule(protectionResult.success)];
      }
    }

    const rules = [...rulesets, ...classic];
    if (rules.length === 0) return "";
    const required: ReviewRule = {
      approvals: Math.max(...rules.map((rule) => rule.approvals)),
      codeOwner: rules.some((rule) => rule.codeOwner),
      dismissStale: rules.some((rule) => rule.dismissStale),
      lastPush: rules.some((rule) => rule.lastPush),
    };
    if (required.codeOwner || required.lastPush) return "UNKNOWN";

    const reviewsResult = yield* restValue(
      read,
      `repos/${input.repo}/pulls/${input.number}/reviews`,
      Schema.Array(
        Schema.Array(
          Schema.Struct({
            id: Schema.Number,
            user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
            state: Schema.String,
            submitted_at: Schema.NullOr(Schema.String),
            commit_id: Schema.String,
          }),
        ),
      ),
    );
    if (Result.isFailure(reviewsResult)) return "UNKNOWN";

    const latest = new Map<string, (typeof reviewsResult.success)[number][number]>();
    for (const review of reviewsResult.success.flat()) {
      const state = review.state.toUpperCase();
      if (review.user === null || !["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(state))
        continue;
      const login = review.user.login.toLowerCase();
      const current = latest.get(login);
      if (
        current === undefined ||
        (review.submitted_at ?? "") > (current.submitted_at ?? "") ||
        (review.submitted_at === current.submitted_at && review.id > current.id)
      )
        latest.set(login, review);
    }
    const currentReviews = [...latest.values()];
    if (currentReviews.some((review) => review.state.toUpperCase() === "CHANGES_REQUESTED"))
      return "CHANGES_REQUESTED";
    const approvals = currentReviews.filter(
      (review) =>
        review.state.toUpperCase() === "APPROVED" &&
        (!required.dismissStale || review.commit_id === input.headSha),
    ).length;
    return approvals >= required.approvals ? "APPROVED" : "REVIEW_REQUIRED";
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
          owner: Schema.Struct({ login: Schema.String }),
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
    !args.includes("--delete-branch")
  )
    return Effect.gen(function* () {
      const pull = yield* restPull(read, repo, selector);
      if (pull.state !== "OPEN") return pull;
      const comment = option(args, "--comment");
      if (comment !== undefined)
        yield* read([
          "api",
          "--method",
          "POST",
          `repos/${repo}/issues/${selector}/comments`,
          "-f",
          `body=${comment}`,
        ]);
      return yield* read([
        "api",
        "--method",
        "PATCH",
        `repos/${repo}/pulls/${selector}`,
        "-f",
        "state=closed",
      ]);
    });
  if (!args.includes("--json")) return null;
  const requestedFields = new Set((option(args, "--json") ?? "").split(","));
  const fields = new Set([...requestedFields, "reviewDecision"]);
  const projectPull = (pull: ReturnType<typeof pullFromRest>) =>
    Effect.gen(function* () {
      const value = requestedFields.has("reviewDecision")
        ? {
            ...pull,
            reviewDecision: yield* restReviewDecision(read, {
              repo,
              number: pull.number,
              baseRefName: pull.baseRefName,
              headSha: pull.headSha,
            }),
          }
        : pull;
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => fields.has(key))
          .toSorted(([a], [b]) => a.localeCompare(b)),
      );
    });
  if (args[1] === "view" && selector !== undefined && /^\d+$/.test(selector))
    return restPull(read, repo, selector).pipe(Effect.flatMap(projectPull));
  if (args[1] === "list" && option(args, "--search") !== undefined)
    return Effect.gen(function* () {
      const state = option(args, "--state") ?? "open";
      const query = [
        option(args, "--search"),
        `repo:${repo}`,
        "is:pr",
        ...(state === "all" ? [] : [`is:${state}`]),
        ...["author", "head", "base"].flatMap((flag) => {
          const value = option(args, `--${flag}`);
          return value === undefined ? [] : [`${flag}:${value}`];
        }),
      ].join(" ");
      const params = new URLSearchParams({
        q: query,
        per_page: "100",
        sort: "created",
        order: "desc",
      });
      const pages = yield* parseRest(
        Schema.Array(
          Schema.Struct({
            incomplete_results: Schema.Boolean,
            items: Schema.Array(Schema.Struct({ number: Schema.Number })),
          }),
        ),
        yield* restPages(read, `search/issues?${params}`),
      );
      if (pages.some((page) => page.incomplete_results))
        return yield* new GitHubCommandError({
          command: "pr list",
          exitCode: 1,
          message: "GitHub REST search returned incomplete results",
          stderr: "GitHub REST search returned incomplete results",
        });
      return yield* Effect.forEach(
        pages.flatMap((page) => page.items).slice(0, Number(option(args, "--limit") ?? 30)),
        (item) => restPull(read, repo, String(item.number)).pipe(Effect.map(projectPull)),
      );
    });
  if (args[1] === "list")
    return Effect.gen(function* () {
      const state = option(args, "--state") ?? "open";
      const params = new URLSearchParams({
        state: state === "merged" ? "closed" : state,
        per_page: "100",
      });
      const head = option(args, "--head");
      if (head?.includes(":")) params.set("head", head);
      const base = option(args, "--base");
      if (base !== undefined) params.set("base", base);
      const pages = yield* parseRest(
        Schema.Array(Schema.Array(RestPull)),
        yield* restPages(read, `repos/${repo}/pulls?${params}`),
      );
      let author = option(args, "--author");
      if (author === "@me")
        author = (yield* parseRest(
          Schema.Struct({ login: Schema.String }),
          yield* restGet(read, "user"),
        )).login;
      const pulls = pages
        .flat()
        .map(pullFromRest)
        .filter((pull) => state !== "merged" || pull.state === "MERGED")
        .filter((pull) => head === undefined || head.includes(":") || pull.headRefName === head)
        .filter(
          (pull) =>
            author === undefined || pull.author.login.toLowerCase() === author.toLowerCase(),
        )
        .slice(0, Number(option(args, "--limit") ?? 30));
      return yield* Effect.forEach(pulls, (pull) =>
        (fields.has("mergeable")
          ? restPull(read, repo, String(pull.number))
          : Effect.succeed(pull)
        ).pipe(Effect.flatMap(projectPull)),
      );
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
      const checkFields = (option(args, "--json") ?? "").split(",");
      return checks.map((check) =>
        Object.fromEntries(Object.entries(check).filter(([key]) => checkFields.includes(key))),
      );
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
    case "queued":
    case "in_progress":
    case "pending":
    case "waiting":
    case "requested":
      return "pending";
    default:
      return "unknown";
  }
};
