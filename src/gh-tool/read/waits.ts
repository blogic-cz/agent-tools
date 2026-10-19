import { Clock, Duration, Effect } from "effect";

export type WaitOutcome<A> =
  | { readonly kind: "done"; readonly value: A }
  | { readonly kind: "timedOut"; readonly last: A };
const until = <A, E, R>(
  read: Effect.Effect<A, E, R>,
  done: (value: A) => boolean,
  opts: {
    readonly intervalMs: number;
    readonly timeoutMs: number;
    readonly initial?: { readonly value: A };
    readonly readAtDeadline?: boolean;
    readonly onValue?: (value: A) => Effect.Effect<void, never, R>;
  },
): Effect.Effect<WaitOutcome<A>, E, R> =>
  Effect.gen(function* () {
    const deadline = Number(yield* Clock.currentTimeMillis) + opts.timeoutMs;
    const state = {
      value: opts.initial === undefined ? yield* read : opts.initial.value,
      timedOut: false,
    };
    if (opts.onValue !== undefined) yield* opts.onValue(state.value);
    yield* Effect.whileLoop({
      while: () => !done(state.value) && !state.timedOut,
      body: () =>
        Effect.gen(function* () {
          const remaining = deadline - Number(yield* Clock.currentTimeMillis);
          if (remaining <= 0) {
            state.timedOut = true;
            return;
          }
          yield* Effect.sleep(
            Duration.millis(Math.min(Math.max(5000, opts.intervalMs), remaining)),
          );
          if (
            Number(yield* Clock.currentTimeMillis) >= deadline &&
            (opts.readAtDeadline !== true || remaining < 5000)
          ) {
            state.timedOut = true;
            return;
          }
          state.value = yield* read;
          if (opts.onValue !== undefined) yield* opts.onValue(state.value);
        }),
      step: () => undefined,
    });
    return state.timedOut
      ? { kind: "timedOut", last: state.value }
      : { kind: "done", value: state.value };
  });
export const waits = { until };
