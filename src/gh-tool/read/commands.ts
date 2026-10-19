import { Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";
import { formatOption, logFormatted } from "#shared";
import { cacheStats, clearCache } from "./cache";
import { resolveRepo } from "./reads";

const stats = Command.make("stats", { format: formatOption }, ({ format }) =>
  Effect.gen(function* () {
    yield* logFormatted(yield* cacheStats, format);
  }),
);
const clear = Command.make(
  "clear",
  { repo: Flag.String("repo").pipe(Flag.optional), format: formatOption },
  ({ repo, format }) =>
    Effect.gen(function* () {
      const target = Option.isSome(repo) ? yield* resolveRepo(repo.value) : null;
      const cleared = yield* clearCache(target);
      yield* logFormatted({ cleared, repo: Option.getOrNull(repo) }, format);
    }),
);
export const cacheCommand = Command.make("cache", {}).pipe(
  Command.withDescription("Inspect or clear the shared GitHub read cache"),
  Command.withSubcommands([stats, clear]),
);
