import { Duration, Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { CacheClass } from "./classes";
import { digest, entryKey, repoSlug, tagsFor } from "./keys";
import type { ReadKey, RepoRef, Tag } from "./keys";

const EntrySchema = Schema.Struct({
  schema: Schema.Literal(1),
  value: Schema.Unknown,
  fetchedAt: Schema.Number,
  startedAtClock: Schema.Number,
  immutable: Schema.Boolean,
  identity: Schema.String,
  repo: Schema.String,
  etag: Schema.optional(Schema.String),
});
const LeaseSchema = Schema.Struct({ owner: Schema.String, expiresAt: Schema.Number });
const CounterSchema = Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Number));
type Entry = typeof EntrySchema.Type;
export type StoreStats = Record<string, Record<string, number>>;
export type Prepared<A> =
  | { readonly kind: "hit"; readonly value: A }
  | {
      readonly kind: "fetch";
      readonly key: string;
      readonly readKey: ReadKey;
      readonly owner: string;
      readonly startedAtClock: number;
      readonly previous: (Entry & { value: A }) | null;
    };

const repeatUntil = <A>(
  attempt: () => Promise<A | null>,
  intervalMs: number,
  timeoutMs: number,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const state: { value: A | null } = { value: null };
      const deadline = Date.now() + timeoutMs;
      yield* Effect.whileLoop({
        while: () => state.value === null,
        body: () =>
          Effect.gen(function* () {
            state.value = yield* Effect.promise(attempt);
            if (state.value !== null) return;
            if (Date.now() >= deadline)
              return yield* Effect.die(new Error("Cache coordination timed out"));
            yield* Effect.sleep(Duration.millis(intervalMs));
          }),
        step: () => undefined,
      });
      if (state.value === null)
        return yield* Effect.die(new Error("Cache coordination returned no value"));
      return state.value;
    }),
  );
const missing = (cause: unknown) =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";
const exists = (cause: unknown) =>
  cause instanceof Error && "code" in cause && cause.code === "EEXIST";
const atomicWrite = async (path: string, text: string): Promise<void> => {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
};

export const defaultCacheDirectory = (): string =>
  `/tmp/agent-tools-${process.getuid?.() ?? "unknown"}`;
export class FileStore {
  private readonly counters: StoreStats = {};
  private readonly statsId = `${process.pid}-${randomUUID()}.json`;
  private statsWrite = Promise.resolve();
  private constructor(
    readonly directory: string,
    readonly identity: string,
  ) {}

  static async open(
    identity: string,
    directory = process.env["GH_TOOL_CACHE_DIR"] ?? defaultCacheDirectory(),
  ): Promise<FileStore> {
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("Cache ownership cannot be verified");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const checkDirectory = async (path: string) => {
      const stat = await lstat(path);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.uid !== uid ||
        (stat.mode & 0o777) !== 0o700
      )
        throw new Error("Cache directory must be real, owned by the current user, and mode 0700");
    };
    await checkDirectory(directory);
    await mkdir(join(directory, "gh-read-v1"), { mode: 0o700, recursive: true });
    await checkDirectory(join(directory, "gh-read-v1"));
    await Promise.all(
      ["entries", "leases", "tags", "stats", "gh-xdg-cache"].map(async (child) => {
        const path = join(directory, "gh-read-v1", child);
        await mkdir(path, { recursive: true, mode: 0o700 });
        await checkDirectory(path);
      }),
    );
    const store = new FileStore(join(directory, "gh-read-v1"), identity);
    await store.prune();
    return store;
  }

  private async readClock(): Promise<number> {
    try {
      const value = Number(await readFile(join(this.directory, "clock"), "utf8"));
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid cache clock");
      return value;
    } catch (error) {
      if (missing(error)) return 0;
      throw error;
    }
  }

  get ghCacheDirectory(): string {
    return join(this.directory, "gh-xdg-cache");
  }

  private async prune(): Promise<void> {
    const marker = join(this.directory, "gc");
    const now = Date.now();
    let last = 0;
    try {
      last = Number(await readFile(marker, "utf8"));
    } catch (error) {
      if (!missing(error)) throw error;
    }
    if (Number.isFinite(last) && now - last < 86_400_000) return;
    await atomicWrite(marker, String(now));
    await Promise.all(
      ["entries", "stats"].map(async (child) => {
        const directory = join(this.directory, child);
        await Promise.all(
          (await readdir(directory))
            .filter((name) => name.endsWith(".json"))
            .map(async (name) => {
              const path = join(directory, name);
              try {
                if ((await lstat(path)).mtimeMs < now - 14 * 86_400_000)
                  await rm(path, { force: true });
              } catch (error) {
                if (!missing(error)) throw error;
              }
            }),
        );
      }),
    );
  }

  private async locked<A>(body: () => Promise<A>): Promise<A> {
    const path = join(this.directory, "clock.lock");
    const handle = await repeatUntil(
      async () => {
        try {
          return await open(path, "wx", 0o600);
        } catch (error) {
          if (!exists(error)) throw error;
          return null;
        }
      },
      25,
      2000,
    );
    try {
      return await body();
    } finally {
      await handle.close();
      await rm(path, { force: true });
    }
  }

  private async maxGeneration(tags: readonly Tag[]): Promise<number> {
    const generations = await Promise.all(
      tags.map(async (tag) => {
        try {
          const generation = Number(
            await readFile(join(this.directory, "tags", digest(tag)), "utf8"),
          );
          if (!Number.isSafeInteger(generation) || generation < 0)
            throw new Error("Invalid tag generation");
          return generation;
        } catch (error) {
          if (missing(error)) return 0;
          throw error;
        }
      }),
    );
    return Math.max(0, ...generations);
  }

  async bump(tags: readonly Tag[]): Promise<void> {
    await this.locked(async () => {
      const generation = (await this.readClock()) + 1;
      await Promise.all(
        [...new Set(tags)].map((tag) =>
          atomicWrite(join(this.directory, "tags", digest(tag)), String(generation)),
        ),
      );
      await atomicWrite(join(this.directory, "clock"), String(generation));
    });
  }

  async record(
    op: string,
    outcome: "hit" | "fetch" | "wait" | "notModified" | "failopen",
  ): Promise<void> {
    const counters = this.counters[op] ?? (this.counters[op] = {});
    counters[outcome] = (counters[outcome] ?? 0) + 1;
    const text = JSON.stringify(this.counters);
    const write = this.statsWrite.then(() =>
      atomicWrite(join(this.directory, "stats", this.statsId), text),
    );
    this.statsWrite = write.catch(() => undefined);
    await write;
  }

  async stats(): Promise<StoreStats> {
    const total: StoreStats = {};
    const snapshots = await Promise.all(
      (await readdir(join(this.directory, "stats")))
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => {
          const counters = Schema.decodeUnknownSync(CounterSchema)(
            JSON.parse(await readFile(join(this.directory, "stats", name), "utf8")),
          );
          return counters;
        }),
    );
    for (const counters of snapshots) {
      for (const [op, counts] of Object.entries(counters)) {
        const target = total[op] ?? (total[op] = {});
        for (const [outcome, count] of Object.entries(counts))
          target[outcome] = (target[outcome] ?? 0) + count;
      }
    }
    return total;
  }

  private async entry<A>(
    key: string,
    decode: (value: unknown) => A,
  ): Promise<(Entry & { value: A }) | null> {
    try {
      const entry = Schema.decodeUnknownSync(EntrySchema)(
        JSON.parse(await readFile(join(this.directory, "entries", `${key}.json`), "utf8")),
      );
      return { ...entry, value: decode(entry.value) };
    } catch (error) {
      if (missing(error) || error instanceof SyntaxError || Schema.isSchemaError(error))
        return null;
      throw error;
    }
  }

  prepare<A>(
    readKey: ReadKey,
    policy: CacheClass,
    decode: (value: unknown) => A,
    policyForValue: (value: A) => CacheClass = () => policy,
  ): Promise<Prepared<A>> {
    const key = entryKey(this.identity, readKey);
    const owner = randomUUID();
    let waited = false;
    return repeatUntil<Prepared<A>>(
      async () => {
        const previous = await this.entry(key, decode);
        const now = Date.now();
        const effectivePolicy = previous === null ? policy : policyForValue(previous.value);
        const fresh =
          previous !== null &&
          (previous.immutable ||
            (effectivePolicy.kind !== "passthrough" &&
              effectivePolicy.kind !== "immutable" &&
              now >= previous.fetchedAt &&
              now - previous.fetchedAt < effectivePolicy.ttlMs &&
              previous.startedAtClock >= (await this.maxGeneration(tagsFor(readKey)))));
        if (fresh && previous !== null) {
          await this.record(readKey.op, "hit");
          return { kind: "hit", value: previous.value };
        }
        const acquired = await this.locked(async () => {
          const path = join(this.directory, "leases", `${key}.json`);
          try {
            const lease = Schema.decodeUnknownSync(LeaseSchema)(
              JSON.parse(await readFile(path, "utf8")),
            );
            if (lease.expiresAt > Date.now()) return false;
          } catch (error) {
            if (!missing(error)) throw error;
          }
          await atomicWrite(path, JSON.stringify({ owner, expiresAt: Date.now() + 60_000 }));
          return true;
        });
        if (acquired) {
          // A prior owner can publish between the first read and this lease acquisition.
          const current = await this.entry(key, decode);
          if (
            current !== null &&
            (current.immutable ||
              (current.fetchedAt !== previous?.fetchedAt &&
                current.startedAtClock >= (await this.maxGeneration(tagsFor(readKey)))))
          ) {
            await this.release(key, owner);
            await this.record(readKey.op, "hit");
            return { kind: "hit", value: current.value };
          }
          return {
            kind: "fetch",
            key,
            readKey,
            owner,
            startedAtClock: await this.readClock(),
            previous,
          };
        }
        if (!waited) {
          await this.record(readKey.op, "wait");
          waited = true;
        }
        return null;
      },
      150,
      20_000,
    );
  }

  put<A>(
    prepared: Extract<Prepared<A>, { kind: "fetch" }>,
    value: A,
    immutable: boolean,
    etag?: string,
  ): Promise<boolean> {
    return this.locked(async () => {
      if (
        !immutable &&
        (await this.maxGeneration(tagsFor(prepared.readKey))) > prepared.startedAtClock
      )
        return false;
      await atomicWrite(
        join(this.directory, "entries", `${prepared.key}.json`),
        JSON.stringify({
          schema: 1,
          value,
          fetchedAt: Date.now(),
          startedAtClock: prepared.startedAtClock,
          immutable,
          identity: this.identity,
          repo: repoSlug(prepared.readKey.repo),
          ...(etag === undefined ? {} : { etag }),
        } satisfies Entry),
      );
      return true;
    });
  }

  async release(key: string, owner: string): Promise<void> {
    await this.locked(async () => {
      const path = join(this.directory, "leases", `${key}.json`);
      try {
        const lease = Schema.decodeUnknownSync(LeaseSchema)(
          JSON.parse(await readFile(path, "utf8")),
        );
        if (lease.owner === owner) await rm(path);
      } catch (error) {
        if (!missing(error)) throw error;
      }
    });
  }

  async clear(repo: RepoRef | null): Promise<void> {
    const paths = await readdir(join(this.directory, "entries"));
    await Promise.all(
      paths
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => {
          const path = join(this.directory, "entries", name);
          const entry = Schema.decodeUnknownSync(EntrySchema)(
            JSON.parse(await readFile(path, "utf8")),
          );
          if (entry.identity === this.identity && (repo === null || entry.repo === repoSlug(repo)))
            await rm(path, { force: true });
        }),
    );
  }
}
