import { Effect } from "effect";

export const resolveTarget = <A extends { number: number }, E, R>(
  pr: number | null,
  current: Effect.Effect<A, E, R>,
) => (pr === null ? current.pipe(Effect.map((value) => value.number)) : Effect.succeed(pr));

export const stableHead = <S, A, E1, R1, E2, R2>(
  initial: S,
  collect: (state: S) => Effect.Effect<A, E1, R1>,
  refresh: (state: S) => Effect.Effect<S, E2, R2>,
  unchanged: (before: S, after: S) => boolean,
): Effect.Effect<{ state: S; value: A } | null, E1 | E2, R1 | R2> =>
  Effect.gen(function* () {
    let before = initial;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const value = yield* collect(before);
      const after = yield* refresh(before);
      if (unchanged(before, after)) return { state: after, value };
      before = after;
    }
    return null;
  });
