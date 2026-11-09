import { Console, Context, Effect, Schema } from "effect";
import type { JsonRead } from "./rest-porcelain";
import type { GhError } from "./transport";
import { parseRest, restGet, restPages, restPull, restReviewDecision } from "./rest-porcelain";
import { GitHubCommandError } from "#gh/errors";
import { ghSubprocessEvent, recordRequest } from "./telemetry";

export type Fallback = { source: "REST"; reason: string; unknown: string[] };
const fallbackResults = new WeakSet<object>();
export const markFallbackResult = <A extends object>(value: A): A => {
  fallbackResults.add(value);
  return value;
};
export const isFallbackResult = (value: unknown): boolean =>
  typeof value === "object" && value !== null && fallbackResults.has(value);

export const FallbackState = Context.Reference<{ notices: Fallback[] } | null>("gh/FallbackState", {
  defaultValue: () => null,
});
const fallbackMessage = (unknown: string[]) =>
  unknown.length === 0
    ? "GitHub GraphQL is blocked (rate limit); answered from REST. All fields were provided."
    : `GitHub GraphQL is blocked (rate limit); answered from REST. Not provided: ${unknown.join(", ")}. A null or UNKNOWN value there means "not provided", never false, unresolved or not approved. If your next step depends on it, retry in a few minutes; if it is still not provided, tell the user. Do not guess.`;
export const reportFallback = (unknown: string[]) =>
  Effect.gen(function* () {
    const notice: Fallback = { source: "REST", reason: "GitHub GraphQL rate limit", unknown };
    const state = yield* FallbackState;
    state?.notices.push(notice);
    if (state === null) yield* Console.warn(fallbackMessage(unknown));
    yield* recordRequest({
      ...ghSubprocessEvent(["api", "graphql"], 0),
      method: "FALLBACK",
      endpoint: "graphql-to-rest",
      outcome: "fallback",
    });
    return notice;
  });
export const withFallbackOutput = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const current = yield* Console.Console;
    const state = { notices: [] as Fallback[] };
    let warned = false;
    const flushWarning = () => {
      if (warned || state.notices.length === 0) return;
      warned = true;
      current.warn(
        fallbackMessage([...new Set(state.notices.flatMap((notice) => notice.unknown))]),
      );
    };
    const console = {
      ...current,
      log: (...args: readonly unknown[]) => {
        flushWarning();
        current.log(
          ...args.map((arg) => {
            if (state.notices.length === 0 || typeof arg !== "string") return arg;
            try {
              const value: unknown = JSON.parse(arg);
              if (value === null || typeof value !== "object") return arg;
              const fallback = {
                source: "REST",
                reason: "GitHub GraphQL rate limit",
                unknown: [...new Set(state.notices.flatMap((notice) => notice.unknown))],
              };
              return JSON.stringify(
                Array.isArray(value) ? { items: value, fallback } : { ...value, fallback },
                null,
                arg.includes("\n") ? 2 : undefined,
              );
            } catch {
              return arg;
            }
          }),
        );
      },
    };
    return yield* program.pipe(
      Effect.provideService(FallbackState, state),
      Effect.provideService(Console.Console, console),
      Effect.ensuring(Effect.sync(flushWarning)),
    );
  });
const Comment = Schema.Struct({
  id: Schema.Number,
  node_id: Schema.String,
  in_reply_to_id: Schema.optional(Schema.NullOr(Schema.Number)),
  path: Schema.String,
  line: Schema.NullOr(Schema.Number),
  body: Schema.String,
  user: Schema.Struct({ login: Schema.String }),
  commit_id: Schema.String,
});
const Reviewer = Schema.Struct({ login: Schema.String, type: Schema.optional(Schema.String) });
export const restGraphql = (
  query: string,
  variables: Record<string, string | number | null>,
  read: JsonRead,
): Effect.Effect<unknown, GhError> | null => {
  if (
    (query.includes("mutation") && !query.includes("submitPullRequestReview")) ||
    typeof variables.owner !== "string" ||
    typeof variables.name !== "string" ||
    typeof variables.pr !== "number"
  )
    return null;
  const repo = `${variables.owner}/${variables.name}`;
  const pr = variables.pr;
  const root = `repos/${repo}/pulls/${pr}`;
  if (
    query.includes("states: [PENDING]") ||
    query.includes("... on PullRequestReview {") ||
    query.includes("submitPullRequestReview")
  )
    return pendingRest(query, variables, read, root, repo, variables.pr);
  if (query.includes("reviewThreads"))
    return Effect.gen(function* () {
      const comments = (yield* parseRest(
        Schema.Array(Schema.Array(Comment)),
        yield* restPages(read, `${root}/comments`),
      )).flat();
      const groups = new Map<number, Array<typeof Comment.Type>>();
      for (const comment of comments) {
        const rootId = comment.in_reply_to_id ?? comment.id;
        const group = groups.get(rootId) ?? [];
        group.push(comment);
        groups.set(rootId, group);
      }
      const nodes = [...groups.entries()].map(([rootId, group]) => ({
        id: `rest-thread:${rootId}`,
        isResolved: null,
        comments: {
          nodes: group
            .toSorted((a, b) => Number(b.id === rootId) - Number(a.id === rootId))
            .map((item) => ({
              id: item.node_id,
              databaseId: item.id,
              path: item.path,
              line: item.line,
              body: item.body,
              author: { login: item.user.login },
              commit: { oid: item.commit_id },
              replyTo:
                item.in_reply_to_id === undefined || item.in_reply_to_id === null
                  ? null
                  : { id: String(item.in_reply_to_id) },
            })),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }));
      const pull = yield* restPull(read, repo, String(pr));
      const reviewDecision = query.includes("reviewDecision")
        ? yield* restReviewDecision(read, {
            repo,
            number: pr,
            baseRefName: pull.baseRefName,
            headSha: pull.headSha,
          })
        : pull.reviewDecision;
      const fallback = yield* reportFallback([
        "review thread resolution",
        ...(query.includes("reviewDecision") && reviewDecision === "UNKNOWN"
          ? ["reviewDecision"]
          : []),
      ]);
      return {
        fallback,
        repository: {
          pullRequest: {
            ...pull,
            reviewDecision,
            reviewRequests: {
              nodes: pull.reviewRequests.map((reviewer) => ({ requestedReviewer: reviewer })),
            },
            reviewThreads: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
          },
        },
      };
    });
  if (query.includes("reviews(last:") && query.includes("reviewRequests"))
    return Effect.gen(function* () {
      const reviews = (yield* parseRest(
        Schema.Array(
          Schema.Array(
            Schema.Struct({
              user: Schema.NullOr(Reviewer),
              state: Schema.String,
              submitted_at: Schema.NullOr(Schema.String),
            }),
          ),
        ),
        yield* restPages(read, `${root}/reviews`),
      )).flat();
      const requested = yield* parseRest(
        Schema.Struct({
          users: Schema.Array(Reviewer),
          teams: Schema.Array(Schema.Struct({ name: Schema.String })),
        }),
        yield* restGet(read, `${root}/requested_reviewers`),
      );
      const fallback = yield* reportFallback([]);
      return {
        fallback,
        repository: {
          pullRequest: {
            reviewRequests: {
              nodes: [
                ...requested.users.map((user) => ({
                  requestedReviewer: {
                    __typename: user.type === "Bot" ? "Bot" : "User",
                    login: user.login,
                  },
                })),
                ...requested.teams.map((team) => ({
                  requestedReviewer: { __typename: "Team", name: team.name },
                })),
              ],
            },
            reviews: {
              nodes: reviews.map((review) => ({
                author: review.user === null ? null : { login: review.user.login },
                state: review.state,
                submittedAt: review.submitted_at,
              })),
            },
          },
        },
      };
    });
  return null;
};
export const isGraphqlLimit = (error: unknown) =>
  error instanceof GitHubCommandError &&
  /rate.?limit|already exceeded|secondary limit|abuse detection|HTTP 429/i.test(error.stderr);
export const rateLimitResponse = (stdout: string): string | null => {
  try {
    const value = Schema.decodeUnknownSync(
      Schema.Struct({
        errors: Schema.optional(Schema.Array(Schema.Unknown)),
        type: Schema.optional(Schema.String),
        code: Schema.optional(Schema.String),
        message: Schema.optional(Schema.String),
      }),
    )(JSON.parse(stdout));
    const detail = JSON.stringify(value.errors ?? value);
    return /RATE_LIMIT|graphql_rate_limit|rate limit|secondary limit/i.test(detail) ? detail : null;
  } catch {
    return null;
  }
};
export const graphqlLimitError = () =>
  new GitHubCommandError({
    command: "gh api graphql",
    exitCode: 1,
    message: "GraphQL rate limit already exceeded",
    stderr: "GraphQL rate limit already exceeded",
  });

const PendingReview = Schema.Struct({
  id: Schema.Number,
  node_id: Schema.String,
  state: Schema.String,
  body: Schema.NullOr(Schema.String),
  user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  pull_request_url: Schema.String,
});
const pendingRest = (
  query: string,
  variables: Record<string, string | number | null>,
  read: JsonRead,
  root: string,
  repo: string,
  pr: number,
): Effect.Effect<unknown, GhError> =>
  Effect.gen(function* () {
    const reviews = (yield* parseRest(
      Schema.Array(Schema.Array(PendingReview)),
      yield* restPages(read, `${root}/reviews`),
    )).flat();
    const viewer = yield* parseRest(
      Schema.Struct({ login: Schema.String }),
      yield* restGet(read, "user"),
    );
    const pageInfo = { hasNextPage: false, endCursor: null };
    if (query.includes("states: [PENDING]")) {
      const fallback = yield* reportFallback([]);
      return {
        fallback,
        viewer,
        repository: {
          pullRequest: {
            reviews: {
              nodes: reviews
                .filter((review) => review.state === "PENDING")
                .map((review) => ({
                  id: review.node_id,
                  state: review.state,
                  author: review.user,
                })),
              pageInfo,
            },
          },
        },
      };
    }
    const review = reviews.find((item) => item.node_id === variables.reviewId);
    if (
      review === undefined ||
      review.state !== "PENDING" ||
      review.user?.login !== viewer.login ||
      review.pull_request_url !== `https://api.github.com/${root}`
    )
      return yield* new GitHubCommandError({
        command: "gh-tool pr submit-review",
        exitCode: 1,
        message: "REST could not verify an owned pending review on this PR",
        stderr: "REST could not verify an owned pending review on this PR",
      });
    if (query.includes("submitPullRequestReview")) {
      if (
        typeof variables.event !== "string" ||
        !["COMMENT", "APPROVE", "REQUEST_CHANGES"].includes(variables.event) ||
        typeof variables.body !== "string"
      )
        return yield* new GitHubCommandError({
          command: "gh-tool pr submit-review",
          exitCode: 1,
          message: "Invalid review event or body",
          stderr: "Invalid review event or body",
        });
      const result = yield* parseRest(
        Schema.Struct({ node_id: Schema.String, state: Schema.String }),
        yield* read([
          "api",
          "--method",
          "POST",
          `${root}/reviews/${review.id}/events`,
          "-f",
          `event=${variables.event}`,
          "-f",
          `body=${variables.body}`,
        ]),
      );
      const fallback = yield* reportFallback([]);
      return {
        fallback,
        submitPullRequestReview: { pullRequestReview: { id: result.node_id, state: result.state } },
      };
    }
    const comments = (yield* parseRest(
      Schema.Array(Schema.Array(Schema.Struct({ body: Schema.String }))),
      yield* restPages(read, `${root}/reviews/${review.id}/comments`),
    )).flat();
    const fallback = yield* reportFallback([]);
    return {
      fallback,
      viewer,
      node: {
        id: review.node_id,
        state: review.state,
        body: review.body,
        author: review.user,
        pullRequest: { number: pr, repository: { nameWithOwner: repo } },
        comments: { nodes: comments, pageInfo },
      },
    };
  });
