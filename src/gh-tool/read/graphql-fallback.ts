import { Console, Context, Effect, Schema } from "effect";
import type { JsonRead } from "./rest-porcelain";
import { parseRest, restGet, restPages, restPull } from "./rest-porcelain";
import { GitHubCommandError } from "#gh/errors";
import { ghSubprocessEvent, recordRequest } from "./telemetry";

export type Fallback = { source: "REST"; reason: string; unknown: string[] };
export const FallbackState = Context.Reference<{ notices: Fallback[] } | null>("gh/FallbackState", {
  defaultValue: () => null,
});
export const reportFallback = (unknown: string[]) =>
  Effect.gen(function* () {
    const notice: Fallback = { source: "REST", reason: "GitHub GraphQL rate limit", unknown };
    const state = yield* FallbackState;
    state?.notices.push(notice);
    yield* Console.warn(
      `GitHub GraphQL is blocked (rate limit); answered from REST. Unknown: ${unknown.join(", ") || "none"}.`,
    );
    yield* recordRequest({
      ...ghSubprocessEvent(["api", "graphql"], 0),
      method: "FALLBACK",
      endpoint: "graphql-to-rest",
    });
    return notice;
  });
export const withFallbackOutput = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const current = yield* Console.Console;
    const state = { notices: [] as Fallback[] };
    const console = {
      ...current,
      log: (...args: readonly unknown[]) =>
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
                Array.isArray(value)
                  ? value.map((item) => ({ ...item, fallback }))
                  : { ...value, fallback },
                null,
                2,
              );
            } catch {
              return arg;
            }
          }),
        ),
    };
    return yield* program.pipe(
      Effect.provideService(FallbackState, state),
      Effect.provideService(Console.Console, console),
    );
  });
const Comment = Schema.Struct({
  id: Schema.Number,
  node_id: Schema.String,
  in_reply_to_id: Schema.optional(Schema.Number),
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
) => {
  if (
    query.includes("mutation") ||
    typeof variables.owner !== "string" ||
    typeof variables.name !== "string" ||
    typeof variables.pr !== "number"
  )
    return null;
  const repo = `${variables.owner}/${variables.name}`;
  const root = `repos/${repo}/pulls/${variables.pr}`;
  if (query.includes("reviewThreads"))
    return Effect.gen(function* () {
      const comments = (yield* parseRest(
        Schema.Array(Schema.Array(Comment)),
        yield* restPages(read, `${root}/comments`),
      )).flat();
      const roots = comments.filter((comment) => comment.in_reply_to_id === undefined);
      const nodes = roots.map((comment) => ({
        id: `rest-thread:${comment.id}`,
        isResolved: null,
        comments: {
          nodes: [comment, ...comments.filter((reply) => reply.in_reply_to_id === comment.id)].map(
            (item) => ({
              id: item.node_id,
              databaseId: item.id,
              path: item.path,
              line: item.line,
              body: item.body,
              author: { login: item.user.login },
              commit: { oid: item.commit_id },
              replyTo:
                item.in_reply_to_id === undefined ? null : { id: String(item.in_reply_to_id) },
            }),
          ),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      }));
      const pull = yield* restPull(read, repo, String(variables.pr));
      const fallback = yield* reportFallback([
        "review thread resolution",
        ...(query.includes("reviewDecision") ? ["reviewDecision"] : []),
      ]);
      return {
        fallback,
        repository: {
          pullRequest: {
            ...pull,
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
  /rate.?limit|already exceeded|secondary limit|abuse detection/i.test(error.stderr);
export const graphqlLimitError = () =>
  new GitHubCommandError({
    command: "gh api graphql",
    exitCode: 1,
    message: "GraphQL rate limit already exceeded",
    stderr: "GraphQL rate limit already exceeded",
  });
