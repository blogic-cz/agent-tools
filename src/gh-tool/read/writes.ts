import { Effect } from "effect";
import { GitHubCommandError } from "#gh/errors";
import { GitHubService } from "#gh/read/transport";
import { invalidate } from "./cache";
import type { Tag } from "./keys";
import type { GhError, PRCheckboxWrite } from "#gh/read/transport";
import type { GitHubApiRequest } from "#gh/read/api";

const mutate = <A, R>(effect: Effect.Effect<A, GhError, R>, touched: readonly Tag[]) =>
  effect.pipe(
    Effect.tap(() => invalidate(touched)),
    Effect.tapError(() => invalidate(touched)),
  );

const run = Effect.fn("writes.run")(function* (argv: string[], touched: readonly Tag[]) {
  const gh = yield* GitHubService;
  return yield* mutate(gh.runGh(argv), touched);
});
const prCheckbox = Effect.fn("writes.prCheckbox")(function* (
  opts: PRCheckboxWrite,
  touched: readonly Tag[],
) {
  const gh = yield* GitHubService;
  if (gh.writePRCheckbox === undefined) {
    return yield* new GitHubCommandError({
      command: "gh-tool pr checkbox",
      exitCode: 1,
      stderr: "PR checkbox writes are unavailable",
      message:
        "Refusing to update the PR checkbox because the GitHub service cannot verify the body",
    });
  }
  return yield* mutate(gh.writePRCheckbox(opts), touched);
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
export const writes = { run, prCheckbox, json, graphql, api };
