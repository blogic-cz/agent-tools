import { Effect } from "effect";
import { GitHubService } from "#gh/service";
import { invalidate } from "./cache";
import type { Tag } from "./keys";

const run = Effect.fn("writes.run")(function* (argv: string[], touched: readonly Tag[]) {
  const gh = yield* GitHubService;
  return yield* gh.runGh(argv).pipe(
    Effect.tap(() => invalidate(touched)),
    Effect.tapError(() => invalidate(touched)),
  );
});
export const writes = { run };
