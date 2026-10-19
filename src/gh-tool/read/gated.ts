import { Effect, Schema } from "effect";
import { cachedRead, ReadCache } from "./cache";
import { OPS } from "./classes";
import type { ReadKey } from "./keys";
import { parsePreserving } from "./porcelain";

const Envelope = Schema.Struct({
  data: Schema.Unknown,
  originFetchedAt: Schema.Number,
  signal: Schema.String,
});
type Envelope<A> = { data: A; originFetchedAt: number; signal: string };

export const gatedRead = <A, E, R, E2, R2>(opts: {
  readonly key: ReadKey & { op: "prView" | "prChecks" | "reviewThreads" };
  readonly decode: (value: unknown) => A;
  readonly fetch: Effect.Effect<A, E, R>;
  readonly signal: Effect.Effect<string, E2, R2>;
  readonly maxAgeMs: (value: A) => number;
  readonly consistency?: "cached" | "origin";
}) =>
  Effect.gen(function* () {
    const session = yield* ReadCache;
    if (session === null || session.store === null || opts.consistency === "origin")
      return yield* opts.fetch;
    const value = yield* cachedRead({
      key: opts.key,
      policy: OPS[opts.key.op],
      decode: (raw): Envelope<A> => {
        const envelope = parsePreserving(Envelope)(raw);
        return { ...envelope, data: opts.decode(envelope.data) };
      },
      fetch: (previous: { value: Envelope<A>; valid: boolean } | null) =>
        Effect.gen(function* () {
          const signal = yield* opts.signal;
          const now = Date.now();
          if (
            previous !== null &&
            previous.valid &&
            previous.value.signal === signal &&
            now >= previous.value.originFetchedAt &&
            now - previous.value.originFetchedAt < opts.maxAgeMs(previous.value.data)
          )
            return { kind: "fresh" as const, value: previous.value };
          const data = yield* opts.fetch;
          return { kind: "fresh" as const, value: { data, originFetchedAt: now, signal } };
        }),
    });
    return value.data;
  });
