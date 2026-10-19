import { Effect } from "effect";
import { GitHubService } from "#gh/service";
import { invalidate } from "./cache";
import type { Tag } from "./keys";
import type { GhError } from "#gh/service";
import type { GitHubApiRequest } from "#gh/api";

const mutate = <A, R>(effect: Effect.Effect<A, GhError, R>, touched: readonly Tag[]) =>
  effect.pipe(
    Effect.tap(() => invalidate(touched)),
    Effect.tapError(() => invalidate(touched)),
  );

const run = Effect.fn("writes.run")(function* (argv: string[], touched: readonly Tag[]) {
  const gh = yield* GitHubService;
  return yield* mutate(gh.runGh(argv), touched);
});
const json = <A>(argv: string[], touched: readonly Tag[]) =>
  Effect.gen(function* () {
    const gh = yield* GitHubService;
    return yield* mutate(gh.runGhJson<A>(argv), touched);
  });
const graphql = (
  query: string,
  variables: Record<string, string | number | null>,
  touched: readonly Tag[],
) =>
  Effect.gen(function* () {
    const gh = yield* GitHubService;
    return yield* mutate(gh.runGraphQL(query, variables), touched);
  });
const api = <A>(request: GitHubApiRequest, touched: readonly Tag[]) =>
  Effect.gen(function* () {
    const gh = yield* GitHubService;
    return yield* mutate(gh.apiRequest<A>(request), touched);
  });
export const writes = { run, json, graphql, api };
