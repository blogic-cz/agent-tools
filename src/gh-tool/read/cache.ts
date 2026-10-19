import { Console, Context, Effect } from "effect";
import { resolveGitHubToken } from "#gh/api";
import { digest } from "./keys";
import type { ReadKey, RepoRef, Tag } from "./keys";
import type { CacheClass } from "./classes";
import { FileStore } from "./store";

type CacheSession = { store: FileStore | null; warned: boolean };
export const ReadCache = Context.Reference<CacheSession | null>("@agent-tools/ReadCache", {
  defaultValue: () => null,
});

const disable = (session: CacheSession, error: unknown) =>
  Effect.gen(function* () {
    session.store = null;
    if (session.warned) return;
    session.warned = true;
    yield* Console.error(
      `gh-tool: cache off (${error instanceof Error ? error.message : String(error)})`,
    );
  });
const safe = <A>(session: CacheSession, io: () => Promise<A>) =>
  Effect.tryPromise({ try: io, catch: (error) => error }).pipe(
    Effect.catch((error) => disable(session, error).pipe(Effect.as(null))),
  );

export const withReadCache = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    if (process.env["GH_TOOL_CACHE"] === "off") return yield* effect;
    const token = yield* resolveGitHubToken().pipe(Effect.orElseSucceed(() => null));
    if (token === null) return yield* effect;
    const session: CacheSession = { store: null, warned: false };
    session.store = yield* safe(session, () => FileStore.open(digest(token)));
    return yield* effect.pipe(Effect.provideService(ReadCache, session));
  });

export type Fetched<A> =
  | { readonly kind: "fresh"; readonly value: A; readonly etag?: string }
  | { readonly kind: "unchanged" };
export const cachedRead = <A, E, R>(opts: {
  readonly key: ReadKey;
  readonly policy: CacheClass;
  readonly decode: (value: unknown) => A;
  readonly fetch: (previous: { value: A; etag?: string } | null) => Effect.Effect<Fetched<A>, E, R>;
  readonly immutableWhen?: (value: A) => boolean;
  readonly policyForValue?: (value: A) => CacheClass;
  readonly consistency?: "cached" | "origin";
}): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const session = yield* ReadCache;
    const store = session?.store;
    const direct = () =>
      opts
        .fetch(null)
        .pipe(
          Effect.flatMap((fetched) =>
            fetched.kind === "fresh"
              ? Effect.succeed(fetched.value)
              : Effect.die(new Error("304 without a cached value")),
          ),
        );
    if (
      session === null ||
      store === null ||
      store === undefined ||
      opts.policy.kind === "passthrough" ||
      opts.consistency === "origin"
    )
      return yield* direct();
    const prepared = yield* safe(session, () =>
      store.prepare(opts.key, opts.policy, opts.decode, opts.policyForValue),
    );
    if (prepared === null) return yield* direct();
    if (prepared.kind === "hit") return prepared.value;
    return yield* Effect.gen(function* () {
      yield* safe(session, () => store.record(opts.key.op, "fetch"));
      const fetched = yield* opts.fetch(prepared.previous);
      if (fetched.kind === "unchanged") {
        if (prepared.previous === null)
          return yield* Effect.die(new Error("304 without a cached value"));
        const previous = prepared.previous;
        yield* safe(session, () => store.record(opts.key.op, "notModified"));
        yield* safe(session, () =>
          store.put(prepared, previous.value, previous.immutable, previous.etag),
        );
        return previous.value;
      }
      yield* safe(session, () =>
        store.put(
          prepared,
          fetched.value,
          opts.immutableWhen?.(fetched.value) ?? opts.policy.kind === "immutable",
          fetched.etag,
        ),
      );
      return fetched.value;
    }).pipe(Effect.ensuring(safe(session, () => store.release(prepared.key, prepared.owner))));
  });

export const invalidate = (tags: readonly Tag[]) =>
  Effect.gen(function* () {
    const session = yield* ReadCache;
    const store = session?.store;
    if (session !== null && store !== null && store !== undefined)
      yield* safe(session, () => store.bump(tags));
  });

export const cacheStats = Effect.gen(function* () {
  const session = yield* ReadCache;
  const store = session?.store;
  if (session === null || store === null || store === undefined) return {};
  return (yield* safe(session, () => store.stats())) ?? {};
});

export const clearCache = (repo: RepoRef | null) =>
  Effect.gen(function* () {
    const session = yield* ReadCache;
    const store = session?.store;
    if (session === null || store === null || store === undefined) return false;
    return (yield* safe(session, () => store.clear(repo))) !== null;
  });
