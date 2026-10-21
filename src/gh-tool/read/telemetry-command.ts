import { Effect } from "effect";
import { Command, Flag } from "effect/cli";
import { formatOption, logFormatted } from "#shared";
import { GitHubCommandError } from "#gh/errors";
import { getRateLimit } from "./reads";
import { summarizeRequests, Telemetry } from "./telemetry";

export const telemetryCommand = Command.make(
  "telemetry",
  {
    hours: Flag.Int("hours").pipe(
      Flag.withDefault(1),
      Flag.withDescription("Report window in hours, up to 168"),
    ),
    format: formatOption,
  },
  ({ hours, format }) =>
    Effect.gen(function* () {
      const store = yield* Telemetry;
      const report = yield* Effect.try({
        try: () => {
          if (!Number.isFinite(hours) || hours <= 0 || hours > 168)
            throw new Error("hours must be greater than 0 and at most 168");
          if (store === null) throw new Error("Telemetry database unavailable");
          const since = new Date(Date.now() - hours * 3600000).toISOString();
          return { since, ...summarizeRequests(store.read(since)) };
        },
        catch: (error) =>
          new GitHubCommandError({
            message: String(error),
            command: "gh-tool telemetry",
            exitCode: 1,
            stderr: String(error),
          }),
      });
      const current = yield* getRateLimit().pipe(
        Effect.catch((error) => Effect.succeed({ error: error.message })),
      );
      yield* logFormatted({ ...report, current }, format);
    }),
).pipe(
  Command.withDescription(
    "Report direct HTTP requests, gh subprocess calls, ReadCache hits and estimated external quota use",
  ),
);
