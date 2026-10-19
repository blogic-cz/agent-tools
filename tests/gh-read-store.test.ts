import { afterEach, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { FileStore } from "#gh/read/store";
import { OPS } from "#gh/read/classes";
import { entryKey, tagsFor } from "#gh/read/keys";
import type { ReadKey } from "#gh/read/keys";
import { cachedRead, ReadCache } from "#gh/read/cache";
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

it("coalesces two real processes behind a single lease", async () => {
  const root = await directory();
  const script = join(root, "worker.ts");
  const storePath = resolve("src/gh-tool/read/store.ts");
  await writeFile(
    script,
    `
import { FileStore } from ${JSON.stringify(storePath)};
import { appendFile } from "node:fs/promises";
const root = process.argv[2];
const store = await FileStore.open("fixture", root);
const key = { op: "jobLog", repo: { owner: "owner", name: "repo" }, jobId: 123 };
const value = await store.prepare(key, { kind: "immutable" }, (value) => { if (typeof value !== "string") throw new Error("Invalid value"); return value; });
if (value.kind === "fetch") {
  await appendFile(root + "/fetches", "fetch\\n");
  await new Promise((resolve) => { setTimeout(resolve, 200); });
  await store.put(value, "same log", true);
  await store.release(value.key, value.owner);
  console.log("same log");
} else console.log(value.value);
`,
  );
  const exec = promisify(execFile);
  const results = await Promise.all([exec("bun", [script, root]), exec("bun", [script, root])]);
  expect(results.map((result) => result.stdout.trim())).toEqual(["same log", "same log"]);
  expect(await readFile(join(root, "fetches"), "utf8")).toBe("fetch\n");
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
