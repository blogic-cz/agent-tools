import { Console, Context, Effect } from "effect";
import { resolveGitHubToken, SessionCredential } from "#gh/read/api";
import { GitHubCommandError } from "#gh/errors";
import { digest } from "./keys";
import type { ReadKey, RepoRef, Tag } from "./keys";
import type { CacheClass } from "./classes";
import { FileStore } from "./store";

type CacheSession = { store: FileStore | null; warned: boolean; staleWarned?: boolean };
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
    return yield* effect.pipe(
      Effect.provideService(ReadCache, session),
      Effect.provideService(SessionCredential, token),
    );
  });

export type Fetched<A> =
  | { readonly kind: "fresh"; readonly value: A; readonly etag?: string }
  | { readonly kind: "unchanged" };
export const cachedRead = <A, E, R>(opts: {
  readonly key: ReadKey;
  readonly policy: CacheClass;
  readonly decode: (value: unknown) => A;
  readonly fetch: (
    previous: { value: A; etag?: string; valid: boolean } | null,
  ) => Effect.Effect<Fetched<A>, E, R>;
  readonly immutableWhen?: (value: A) => boolean;
  readonly policyForValue?: (value: A) => CacheClass;
  readonly consistency?: "cached" | "origin";
  readonly validateOrigin?: boolean;
  readonly cacheableWhen?: (value: A) => boolean;
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
      (opts.consistency === "origin" && opts.validateOrigin !== true)
    )
      return yield* direct();
    const prepared = yield* safe(session, () =>
      store.prepare(
        opts.key,
        opts.policy,
        opts.decode,
        opts.policyForValue,
        opts.consistency === "origin",
      ),
    );
    if (prepared === null) return yield* direct();
    if (prepared.kind === "hit") return prepared.value;
    return yield* Effect.gen(function* () {
      yield* safe(session, () => store.record(opts.key.op, "fetch"));
      const previousValid =
        prepared.previous === null
          ? false
          : yield* safe(session, () => store.canServeStale(prepared));
      const fetched = yield* opts.fetch(
        prepared.previous === null ? null : { ...prepared.previous, valid: previousValid === true },
      );
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
      if (opts.cacheableWhen?.(fetched.value) !== false)
        yield* safe(session, () =>
          store.put(
            prepared,
            fetched.value,
            opts.immutableWhen?.(fetched.value) ?? opts.policy.kind === "immutable",
            fetched.etag,
          ),
        );
      return fetched.value;
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const rateLimited =
            error instanceof GitHubCommandError &&
            (error.exitCode === 429 ||
              /rate limit|abuse detection/i.test(`${error.message}\n${error.stderr}`));
          if (opts.consistency === "origin" || !rateLimited || prepared.previous === null)
            return yield* Effect.fail(error);
          const valid = yield* safe(session, () => store.canServeStale(prepared));
          if (valid !== true) return yield* Effect.fail(error);
          if (!session.staleWarned) {
            session.staleWarned = true;
            yield* Console.error(`gh-tool: served cached ${opts.key.op} (rate limited)`);
          }
          yield* safe(session, () => store.record(opts.key.op, "stale"));
          return prepared.previous.value;
        }),
      ),
      Effect.ensuring(safe(session, () => store.release(prepared.key, prepared.owner))),
    );
  });

export const readFence = Effect.gen(function* () {
  const session = yield* ReadCache;
  if (session === null || session.store === null) return null;
  const store = session.store;
  return yield* safe(session, () => store.readClock());
});

export const seedRead = <A>(key: ReadKey, value: A, clock: number | null) =>
  Effect.gen(function* () {
    const session = yield* ReadCache;
    if (session === null || session.store === null || clock === null) return;
    const store = session.store;
    yield* safe(session, async () => {
      const prepared = await store.prepare(
        key,
        { kind: "passthrough" },
        (raw) => raw,
        undefined,
        true,
      );
      if (prepared.kind !== "fetch") return;
      try {
        await store.put({ ...prepared, startedAtClock: clock }, value, false);
      } finally {
        await store.release(prepared.key, prepared.owner);
      }
    });
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
