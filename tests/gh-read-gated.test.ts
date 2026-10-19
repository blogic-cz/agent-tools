import { expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatedRead } from "#gh/read/gated";
import { ReadCache, invalidate } from "#gh/read/cache";
import { FileStore } from "#gh/read/store";

it("falls back to porcelain when a signal fails and preserves porcelain errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "gh-read-gated-"));
  try {
    const store = await FileStore.open("fixture", root);
    let fetches = 0;
    const session = { store, warned: false };
    const read = gatedRead({
      key: { op: "prView", repo: { owner: "o", name: "r" }, pr: 1 },
      decode: Schema.decodeUnknownSync(Schema.String),
      signal: Effect.fail("signal unavailable"),
      fetch: Effect.sync(() => `porcelain ${++fetches}`),
      maxAgeMs: () => 15000,
    }).pipe(Effect.provideService(ReadCache, session));
    expect(await Effect.runPromise(read)).toBe("porcelain 1");
    await Effect.runPromise(
      invalidate(["pr:o/r#1"]).pipe(Effect.provideService(ReadCache, session)),
    );
    expect(await Effect.runPromise(read)).toBe("porcelain 2");
    const failed = gatedRead({
      key: { op: "prChecks", repo: { owner: "o", name: "r" }, pr: 1, headSha: "sha" },
      decode: Schema.decodeUnknownSync(Schema.String),
      signal: Effect.fail("signal unavailable"),
      fetch: Effect.fail("porcelain failed"),
      maxAgeMs: () => 15000,
    }).pipe(Effect.provideService(ReadCache, session), Effect.flip);
    expect(await Effect.runPromise(failed)).toBe("porcelain failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
