import { expect, it } from "vitest";
import { Effect } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubService } from "#gh/read/transport";
import { ReadCache } from "#gh/read/cache";
import { FileStore } from "#gh/read/store";
import { reads } from "#gh/read/reads";

it("refetches a growing active attempt and freezes only a verified completed attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "gh-attempt-"));
  try {
    const store = await FileStore.open("fixture", root);
    let completed = false;
    let jobs = [{ id: 1, name: "early" }];
    let fetches = 0;
    const gh = GitHubService.of({
      runGh: () => Effect.die("Unexpected raw read"),
      runGhJson: <T>(args: string[]) =>
        Effect.sync(() => {
          fetches += 1;
          return (
            args[1]?.includes("/jobs?")
              ? { jobs }
              : { status: completed ? "completed" : "in_progress" }
          ) as T;
        }),
      runGraphQL: () => Effect.die("Unexpected GraphQL read"),
      apiRequest: () => Effect.die("Unexpected HTTP read"),
      getRepoInfo: () => Effect.die("Unexpected repo read"),
      getRepoConfig: () => Effect.succeed(undefined),
      withRepoTarget: (_target, effect) => effect,
    });
    const read = reads
      .completedAttemptJobs({ owner: "o", name: "r" }, 1, 1)
      .pipe(
        Effect.provideService(GitHubService, gh),
        Effect.provideService(ReadCache, { store, warned: false }),
      );
    expect(await Effect.runPromise(read)).toEqual(jobs);
    jobs = [...jobs, { id: 2, name: "late" }];
    expect(await Effect.runPromise(read)).toEqual(jobs);
    completed = true;
    expect(await Effect.runPromise(read)).toEqual(jobs);
    expect(fetches).toBe(6);
    expect(await Effect.runPromise(read)).toEqual(jobs);
    expect(fetches).toBe(6);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
