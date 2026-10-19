import { expect, it } from "vitest";
import { Effect } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubService } from "#gh/read/transport";
import type { GitHubApiRequest } from "#gh/read/api";
import { GitHubNotFoundError } from "#gh/errors";
import { ReadCache } from "#gh/read/cache";
import { FileStore } from "#gh/read/store";
import { reads } from "#gh/read/reads";
import { watchPRs } from "#gh/pr/core";

it("modern and legacy job links retain identity without run views and cache external 404s", async () => {
  const root = await mkdtemp(join(tmpdir(), "gh-read-identity-"));
  try {
    const store = await FileStore.open("fixture", root);
    let jobReads = 0;
    const gh = GitHubService.of({
      apiRequest: <T>({ path }: GitHubApiRequest) => {
        if (path.includes("/actions/jobs/")) {
          jobReads += 1;
          if (path.endsWith("/3"))
            return Effect.fail(
              new GitHubNotFoundError({
                message: "external",
                resource: "job",
                identifier: "3",
              }),
            );
          const id = path.endsWith("/1") ? 1 : 2;
          return Effect.succeed({
            status: 200,
            body: { run_id: id * 100, run_attempt: id + 1 } as T,
          });
        }
        return Effect.succeed({
          status: 200,
          body: (path.includes("/pulls/")
            ? { head: { sha: "head" }, base: { sha: "base" } }
            : { check_runs: [], statuses: [] }) as T,
        });
      },
      runGhJson: <T>(args: string[]) => {
        if (args[0] !== "pr") return Effect.die("A job link must never request run metadata");
        return Effect.succeed(
          (args[1] === "view"
            ? { number: 1, state: "OPEN", headRefOid: "head" }
            : [
                {
                  name: "Modern",
                  state: "completed",
                  bucket: "pass",
                  link: "https://github.com/o/r/actions/runs/100/job/1",
                },
                {
                  name: "Legacy",
                  state: "completed",
                  bucket: "pass",
                  link: "https://github.com/o/r/runs/2",
                },
              ]) as T,
        );
      },
      runGh: () => Effect.die("Unexpected raw read"),
      runGraphQL: () => Effect.die("Unexpected GraphQL read"),
      getRepoInfo: () =>
        Effect.succeed({ owner: "o", name: "r", defaultBranch: "main", url: "url" }),
      getRepoRef: () =>
        Effect.succeed({ owner: "o", name: "r", defaultBranch: "main", url: "url" }),
      getRepoConfig: () => Effect.succeed(undefined),
      withRepoTarget: (_target, effect) => effect,
    });
    const events: Array<Record<string, unknown>> = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const watch = watchPRs([1], { intervalSeconds: 5, timeoutSeconds: 10 }, (event) =>
          Effect.sync(() => events.push(event)),
        );
        yield* watch;
        yield* watch;
        expect(jobReads).toBe(2);
        expect(events.filter((event) => event.type === "check").slice(0, 2)).toMatchObject([
          { runId: 100, attempt: 2, jobId: 1 },
          { runId: 200, attempt: 3, jobId: 2 },
        ]);
        expect(yield* reads.jobIdentity({ owner: "o", name: "r" }, 3)).toBeNull();
        expect(yield* reads.jobIdentity({ owner: "o", name: "r" }, 3)).toBeNull();
        expect(jobReads).toBe(3);
      }).pipe(
        Effect.provideService(GitHubService, gh),
        Effect.provideService(ReadCache, { store, warned: false }),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
