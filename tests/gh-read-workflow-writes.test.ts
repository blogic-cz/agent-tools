import { expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubService } from "#gh/service";
import { ReadCache } from "#gh/read/cache";
import { FileStore } from "#gh/read/store";
import { OPS } from "#gh/read/classes";
import { cancelRun, dispatchWorkflow, rerunWorkflow } from "#gh/workflow";

it.each([
  ["rerun", rerunWorkflow(1, false, "o/r").pipe(Effect.asVoid)],
  ["cancel", cancelRun(1, "o/r").pipe(Effect.asVoid)],
  [
    "dispatch",
    dispatchWorkflow({ workflow: "ci.yml", ref: "main", fields: [], repo: "o/r" }).pipe(
      Effect.asVoid,
    ),
  ],
] as const)("%s invalidates shared checks when its head is unknown", async (_name, write) => {
  const root = await mkdtemp(join(tmpdir(), "gh-read-write-"));
  try {
    const store = await FileStore.open("fixture", root);
    const key = { op: "prChecks", repo: { owner: "o", name: "r" }, pr: 1, headSha: "sha" } as const;
    const decode = Schema.decodeUnknownSync(Schema.String);
    const prior = await store.prepare(key, OPS.prChecks, decode);
    if (prior.kind !== "fetch") throw new Error("Expected miss");
    await store.put(prior, "settled", false);
    await store.release(prior.key, prior.owner);
    const gh = GitHubService.of({
      runGh: () => Effect.succeed({ stdout: "", stderr: "", exitCode: 0 }),
      runGhJson: () => Effect.die("Unexpected read"),
      runGraphQL: () => Effect.die("Unexpected read"),
      apiRequest: () => Effect.die("Unexpected read"),
      getRepoInfo: () => Effect.die("Unexpected read"),
      getRepoConfig: () => Effect.succeed(undefined),
      withRepoTarget: (_target, effect) => effect,
    });
    await Effect.runPromise(
      write.pipe(
        Effect.provideService(GitHubService, gh),
        Effect.provideService(ReadCache, { store, warned: false }),
      ),
    );
    const next = await store.prepare(key, OPS.prChecks, decode);
    expect(next.kind).toBe("fetch");
    if (next.kind === "fetch") await store.release(next.key, next.owner);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
