import { Clock, Duration, Effect } from "effect";

export const pollUntilResolved = <A, E, R>(opts: {
  initial: A;
  isPending: (value: A) => boolean;
  fetchLatest: () => Effect.Effect<A, E, R>;
  intervalMs: number;
  budgetSeconds: number;
}): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    let latest = opts.initial;

    if (!opts.isPending(latest)) {
      return latest;
    }

    const start = yield* Clock.currentTimeMillis;
    const deadlineMs = Number(start) + opts.budgetSeconds * 1000;
    let timedOut = false;

    // Effect.whileLoop (not recursion) so TestClock.adjust can advance Effect.sleep without real waits.
    yield* Effect.whileLoop({
      while: () => opts.isPending(latest) && !timedOut,
      body: () =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          if (Number(now) >= deadlineMs) {
            timedOut = true;
            return;
          }
          const remaining = deadlineMs - Number(now);
          yield* Effect.sleep(Duration.millis(Math.min(opts.intervalMs, remaining)));
          latest = yield* opts.fetchLatest();
        }),
      step: () => undefined,
    });

    return latest;
  });
