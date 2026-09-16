import { Duration, Effect } from "effect";

const BASE_DELAY_MS = 500;

export const retryTransient = <A, E, R>(opts: {
  attempt: () => Effect.Effect<A, E, R>;
  isTransient: (error: E) => boolean;
  maxRetries: number;
}): Effect.Effect<A, E, R> => {
  const loop = (attempt: number): Effect.Effect<A, E, R> =>
    opts
      .attempt()
      .pipe(
        Effect.catch((error: E) =>
          opts.isTransient(error) && attempt < opts.maxRetries
            ? Effect.sleep(Duration.millis(BASE_DELAY_MS * 2 ** attempt)).pipe(
                Effect.flatMap(() => loop(attempt + 1)),
              )
            : Effect.fail(error),
        ),
      );

  return loop(0);
};
