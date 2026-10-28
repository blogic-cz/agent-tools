import { afterEach, expect, it, vi } from "vitest";
import { Console, Effect, Schema } from "effect";
import { TestConsole } from "effect/testing";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileStore } from "#gh/read/store";
import { OPS } from "#gh/read/classes";
import { entryKey, tagsFor } from "#gh/read/keys";
import type { ReadKey } from "#gh/read/keys";
import { cachedRead, ReadCache, readFence, seedRead } from "#gh/read/cache";
import { GitHubCommandError } from "#gh/errors";

const directories: string[] = [];
const directory = async () => {
  const path = await mkdtemp(join(tmpdir(), "gh-read-store-"));
  directories.push(path);
  return path;
};
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const decode = Schema.decodeUnknownSync(Schema.String);
const key: ReadKey = { op: "runView", repo: { owner: "owner", name: "repo" }, runId: 123 };

it("rejects an expired owner after a replacement publishes newer data", async () => {
  const store = await FileStore.open("identity", await directory());
  const first = await store.prepare(key, OPS.runView, decode);
  if (first.kind !== "fetch") throw new Error("Expected first miss");
  await writeFile(
    join(store.directory, "leases", `${first.key}.json`),
    JSON.stringify({ owner: first.owner, expiresAt: 0 }),
  );
  expect(await store.put(first, "expired", false)).toBe(false);
  const replacement = await store.prepare(key, OPS.runView, decode);
  if (replacement.kind !== "fetch") throw new Error("Expected replacement miss");
  expect(await store.put(replacement, "newer", false)).toBe(true);
  expect(await store.put(first, "older", false)).toBe(false);
  await store.release(first.key, first.owner);
  await store.release(replacement.key, replacement.owner);
  expect(await store.put(first, "released", false)).toBe(false);
  expect(await store.prepare(key, OPS.runView, decode)).toEqual({ kind: "hit", value: "newer" });
});

it("rejects a fetch that started before a write and leaves another run cached", async () => {
  const store = await FileStore.open("identity", await directory());
  const other: ReadKey = { ...key, runId: 456 };
  const first = await store.prepare(key, OPS.runView, decode);
  const second = await store.prepare(other, OPS.runView, decode);
  if (first.kind !== "fetch" || second.kind !== "fetch") throw new Error("Expected misses");
  await store.put(second, "unaffected", false);
  await store.release(second.key, second.owner);
  await store.bump(["run:owner/repo/123"]);
  expect(await store.put(first, "stale", false)).toBe(false);
  await store.release(first.key, first.owner);
  const next = await store.prepare(key, OPS.runView, decode);
  expect(next.kind).toBe("fetch");
  if (next.kind === "fetch") await store.release(next.key, next.owner);
  expect(await store.prepare(other, OPS.runView, decode)).toEqual({
    kind: "hit",
    value: "unaffected",
  });
});

it("serves immutable content without another fetch after invalidation", async () => {
  const store = await FileStore.open("identity", await directory());
  const prepared = await store.prepare(key, { kind: "immutable" }, decode);
  if (prepared.kind !== "fetch") throw new Error("Expected initial fetch");
  await store.put(prepared, "completed log", true);
  await store.release(prepared.key, prepared.owner);
  await store.bump(tagsFor(key));
  expect(await store.prepare(key, { kind: "immutable" }, decode)).toEqual({
    kind: "hit",
    value: "completed log",
  });
  expect(await store.stats()).toMatchObject({ runView: { hit: 1 } });
});

it("resets volatile state after clock loss and keeps immutable entries across identities", async () => {
  const root = await directory();
  const store = await FileStore.open("identity", root);
  const other = await FileStore.open("other", root);
  const immutableKey: ReadKey = { op: "jobLog", repo: key.repo, jobId: 456 };
  await store.bump(tagsFor(key));
  const volatile = await store.prepare(key, OPS.runView, decode);
  const immutable = await other.prepare(immutableKey, { kind: "immutable" }, decode);
  if (volatile.kind !== "fetch" || immutable.kind !== "fetch") throw new Error("Expected misses");
  await store.put(volatile, "old state", false);
  await other.put(immutable, "completed log", true);
  await store.release(volatile.key, volatile.owner);
  await other.release(immutable.key, immutable.owner);
  const stale = await store.prepare(key, { kind: "ttl", ttlMs: 0 }, decode);
  if (stale.kind !== "fetch") throw new Error("Expected expired entry");
  await rm(join(store.directory, "clock"));
  await store.bump(tagsFor(key));
  expect(await store.canServeStale(stale)).toBe(false);
  expect(await store.put(stale, "late response", false)).toBe(false);
  const next = await store.prepare(key, OPS.runView, decode);
  expect(next.kind).toBe("fetch");
  if (next.kind === "fetch") await store.release(next.key, next.owner);
  expect(await other.prepare(immutableKey, { kind: "immutable" }, decode)).toEqual({
    kind: "hit",
    value: "completed log",
  });
});

it("separates identities and canonicalizes repository spelling", () => {
  expect(entryKey("one", key)).not.toBe(entryKey("two", key));
  expect(entryKey("one", key)).toBe(
    entryKey("one", { ...key, repo: { owner: "OWNER", name: "REPO" } }),
  );
});

it("refuses symlinks and directories with permissive modes", async () => {
  const root = await directory();
  await chmod(root, 0o755);
  await expect(FileStore.open("identity", root)).rejects.toThrow("0700");
  await chmod(root, 0o700);
  const link = join(await directory(), "link");
  await symlink(root, link);
  await expect(FileStore.open("identity", link)).rejects.toThrow("real");
});

it("coalesces two store clients behind a single lease", async () => {
  const root = await directory();
  const first = await FileStore.open("fixture", root);
  const second = await FileStore.open("fixture", root);
  const key: ReadKey = { op: "jobLog", repo: { owner: "owner", name: "repo" }, jobId: 456 };
  const lease = await first.prepare(key, { kind: "immutable" }, decode);
  if (lease.kind !== "fetch") throw new Error("Expected cache miss");
  const pending = second.prepare(key, { kind: "immutable" }, decode);
  await first.put(lease, "same log", true);
  await first.release(lease.key, lease.owner);
  expect(await pending).toEqual({ kind: "hit", value: "same log" });
});

it("keeps a live clock owner and recovers a dead owner's lock", async () => {
  const root = await directory();
  const store = await FileStore.open("fixture", root, { contentionTimeoutMs: 0 });
  const lock = join(store.directory, "clock.lock");
  await mkdir(lock, { mode: 0o700 });
  await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, owner: "owner" }));
  await utimes(lock, new Date(0), new Date(0));
  const alive = vi.spyOn(process, "kill").mockImplementation(() => true);
  try {
    await expect(store.readClock()).rejects.toThrow("Cache coordination timed out");
    expect(await readdir(lock)).toEqual(["owner.json"]);
    alive.mockImplementation(() => {
      throw Object.assign(new Error("dead"), { code: "ESRCH" });
    });
    const recovered = await FileStore.open("fixture", root);
    await recovered.bump(tagsFor(key));
    expect(await recovered.readClock()).toMatchObject({ generation: 1 });
  } finally {
    alive.mockRestore();
  }
});

it("recovers persisted clock acquisition and release states", async () => {
  const root = await directory();
  const store = await FileStore.open("fixture", root);
  const dead = vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("dead"), { code: "ESRCH" });
  });
  try {
    for (const boundary of ["acquire-before", "acquire-after", "release-before", "release-after"]) {
      const path = join(
        store.directory,
        boundary === "acquire-after" || boundary === "release-before"
          ? "clock.lock"
          : `clock.lock.${boundary}.tmp`,
      );
      await mkdir(path, { mode: 0o700 });
      await writeFile(
        join(path, "owner.json"),
        JSON.stringify({ pid: process.pid, owner: "owner" }),
      );
      await expect(store.readClock()).resolves.toMatchObject({ generation: 0 });
    }
    await mkdir(join(store.directory, "clock.lock"), { mode: 0o700 });
    await expect(store.readClock()).resolves.toMatchObject({ generation: 0 });
  } finally {
    dead.mockRestore();
  }
});

it("fetches immutable data once through the read layer and bypasses it for an origin read", async () => {
  const store = await FileStore.open("identity", await directory());
  const session = { store, warned: false };
  let upstream = 0;
  const read = (consistency: "cached" | "origin" = "cached") =>
    cachedRead({
      key,
      policy: { kind: "immutable" },
      decode,
      consistency,
      fetch: () =>
        Effect.sync(() => {
          upstream += 1;
          return { kind: "fresh" as const, value: "completed" };
        }),
    }).pipe(Effect.provideService(ReadCache, session));
  expect(await Effect.runPromise(read())).toBe("completed");
  expect(await Effect.runPromise(read())).toBe("completed");
  expect(upstream).toBe(1);
  expect(await Effect.runPromise(read("origin"))).toBe("completed");
  expect(upstream).toBe(2);
});

it("propagates an upstream error without turning it into a second fetch", async () => {
  const store = await FileStore.open("identity", await directory());
  let upstream = 0;
  const error = new GitHubCommandError({
    message: "unavailable",
    command: "fixture",
    exitCode: 502,
    stderr: "unavailable",
  });
  const read = cachedRead({
    key,
    policy: OPS.runView,
    decode,
    fetch: () =>
      Effect.suspend(() => {
        upstream += 1;
        return Effect.fail(error);
      }),
  }).pipe(Effect.provideService(ReadCache, { store, warned: false }), Effect.flip);
  expect(await Effect.runPromise(read)).toEqual(error);
  expect(upstream).toBe(1);
});

it.each(["none", "before", "during"] as const)(
  "serves rate-limited stale data only without a write, invalidation %s",
  async (invalidation) => {
    const store = await FileStore.open("identity", await directory());
    const session = { store, warned: false };
    const errors: unknown[][] = [];
    const console = await Effect.runPromise(TestConsole.make);
    const error = new GitHubCommandError({
      message: "API rate limit exceeded",
      command: "fixture",
      exitCode: 403,
      stderr: "API rate limit exceeded",
    });
    const seed = cachedRead({
      key,
      policy: { kind: "ttl", ttlMs: 0 },
      decode,
      fetch: () => Effect.succeed({ kind: "fresh" as const, value: "stored" }),
    });
    await Effect.runPromise(seed.pipe(Effect.provideService(ReadCache, session)));
    if (invalidation === "before") await store.bump(tagsFor(key));
    const read = cachedRead({
      key,
      policy: { kind: "ttl", ttlMs: 0 },
      decode,
      fetch: () =>
        Effect.gen(function* () {
          if (invalidation === "during") yield* Effect.promise(() => store.bump(tagsFor(key)));
          return yield* Effect.fail(error);
        }),
    }).pipe(
      Effect.provideService(ReadCache, session),
      Effect.provideService(Console.Console, {
        ...console,
        error: (...args) => errors.push([...args]),
      }),
      Effect.result,
    );
    const result = await Effect.runPromise(read);
    if (invalidation === "none") {
      expect(result).toMatchObject({ success: "stored" });
      expect(await Effect.runPromise(read)).toMatchObject({ success: "stored" });
      expect(errors).toEqual([["gh-tool: served cached runView (rate limited)"]]);
    } else {
      expect(result).toMatchObject({ failure: error });
      expect(errors).toEqual([]);
    }
  },
);

it("clears only the selected repository and identity", async () => {
  const root = await directory();
  const store = await FileStore.open("one", root);
  const other = await FileStore.open("two", root);
  const secondKey: ReadKey = { ...key, repo: { owner: "owner", name: "other" } };
  for (const [cache, target] of [
    [store, key],
    [store, secondKey],
    [other, key],
  ] as const) {
    const prepared = await cache.prepare(target, { kind: "immutable" }, decode);
    if (prepared.kind !== "fetch") throw new Error("Expected initial fetch");
    await cache.put(prepared, "saved", true);
    await cache.release(prepared.key, prepared.owner);
  }
  await store.clear(key.repo);
  const cleared = await store.prepare(key, OPS.runView, decode);
  expect(cleared.kind).toBe("fetch");
  if (cleared.kind === "fetch") await store.release(cleared.key, cleared.owner);
  expect(await store.prepare(secondKey, { kind: "immutable" }, decode)).toEqual({
    kind: "hit",
    value: "saved",
  });
  expect(await other.prepare(key, { kind: "immutable" }, decode)).toEqual({
    kind: "hit",
    value: "saved",
  });
});

it("evicts entries older than fourteen days without touching gh's cache files", async () => {
  const root = await directory();
  const store = await FileStore.open("identity", root);
  const prepared = await store.prepare(key, { kind: "immutable" }, decode);
  if (prepared.kind !== "fetch") throw new Error("Expected initial fetch");
  await store.put(prepared, "old log", true);
  await store.release(prepared.key, prepared.owner);
  const path = join(store.directory, "entries", `${prepared.key}.json`);
  const zip = join(store.ghCacheDirectory, "fixture.zip");
  await writeFile(zip, "gh owns this file");
  const old = new Date(Date.now() - 15 * 86_400_000);
  await utimes(path, old, old);
  await utimes(zip, old, old);
  await writeFile(join(store.directory, "gc"), "0");
  await FileStore.open("identity", root);
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(zip, "utf8")).toBe("gh owns this file");
});

it("fences stale reads, seeds and paused readers across namespace resets", async () => {
  const root = await directory();
  const store = await FileStore.open("identity", root);
  const other = await FileStore.open("identity", root);
  const session = { store, warned: false };
  const policy = { kind: "ttl" as const, ttlMs: 60_000 };
  const save = async (value: string) => {
    const prepared = await other.prepare(key, policy, decode);
    if (prepared.kind !== "fetch") throw new Error("Expected miss");
    await other.put(prepared, value, false);
    await other.release(prepared.key, prepared.owner);
  };
  await store.bump(tagsFor(key));
  await save("before reset");
  const fence = await Effect.runPromise(readFence.pipe(Effect.provideService(ReadCache, session)));
  const error = new GitHubCommandError({
    message: "rate limit",
    stderr: "rate limit",
    exitCode: 429,
    command: "fixture",
  });
  const read = cachedRead({
    key,
    policy: { kind: "ttl", ttlMs: 0 },
    decode,
    fetch: () =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await rm(join(store.directory, "clock"));
          await other.bump(tagsFor(key));
          await save("after reset");
        });
        return yield* Effect.fail(error);
      }),
  }).pipe(Effect.provideService(ReadCache, session), Effect.flip);
  expect(await Effect.runPromise(read)).toEqual(error);
  await rm(join(store.directory, "clock"));
  await other.bump(tagsFor(key));
  await Effect.runPromise(
    seedRead(key, "old seed", fence).pipe(Effect.provideService(ReadCache, session)),
  );
  const seeded = await store.prepare(key, policy, decode);
  expect(seeded.kind).toBe("fetch");
  if (seeded.kind !== "fetch") throw new Error("Expected rejected seed");
  await store.put(seeded, "before paused reset", false);
  await store.release(seeded.key, seeded.owner);

  const original = store["entry"].bind(store);
  let pause = () => {};
  const paused = new Promise<void>((resolve) => {
    pause = resolve;
  });
  let resume = () => {};
  const resumed = new Promise<void>((resolve) => {
    resume = resolve;
  });
  store["entry"] = async <A>(entryKey: string, decodeValue: (value: unknown) => A) => {
    const entry = await original(entryKey, decodeValue);
    pause();
    await resumed;
    return entry;
  };
  const reader = store.prepare(key, policy, decode);
  await paused;
  let resetDone = false;
  await rm(join(store.directory, "clock"));
  const reset = other.bump(tagsFor(key)).then(() => {
    resetDone = true;
    return undefined;
  });
  expect(resetDone).toBe(false);
  resume();
  expect(await reader).toEqual({ kind: "hit", value: "before paused reset" });
  await reset;
  store["entry"] = original;
  const after = await store.prepare(key, policy, decode);
  expect(after.kind).toBe("fetch");
  if (after.kind === "fetch") await store.release(after.key, after.owner);
});
