import { Effect, Ref, Schema } from "effect";

const WINDOW_MS = 60000;

export class ThrottleError extends Schema.TaggedErrorClass<ThrottleError>()("ThrottleError", {
  message: Schema.String,
  label: Schema.String,
  limit: Schema.Number,
  windowMs: Schema.Number,
}) {}

export const createThrottle = (opts: { maxPerMinute: number; label: string }) => {
  const timestampsRef = Effect.runSync(Ref.make<number[]>([]));

  const check = (): Effect.Effect<void, ThrottleError> =>
    Effect.gen(function* () {
      const now = Date.now();
      const windowStart = now - WINDOW_MS;
      const timestamps = yield* Ref.get(timestampsRef);
      const recentTimestamps = timestamps.filter((timestamp) => timestamp >= windowStart);

      if (recentTimestamps.length >= opts.maxPerMinute) {
        return yield* new ThrottleError({
          message: `Rate limit exceeded for ${opts.label}`,
          label: opts.label,
          limit: opts.maxPerMinute,
          windowMs: WINDOW_MS,
        });
      }

      yield* Ref.set(timestampsRef, [...recentTimestamps, now]);
    });

  return { check };
};
