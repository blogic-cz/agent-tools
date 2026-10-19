import { expect, it } from "vitest";
import { Effect } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubService } from "#gh/read/transport";
import { ReadCache } from "#gh/read/cache";
import { FileStore } from "#gh/read/store";
import { fetchFailedChecks } from "#gh/pr/core";
import { fetchJobLogs } from "#gh/workflow";

it("shares completed logs across concurrent and repeated checks-failed diagnosis", async () => {
  const root = await mkdtemp(join(tmpdir(), "gh-diagnosis-"));
  try {
    const store = await FileStore.open("fixture", root);
    let logFetches = 0;
    const gh = GitHubService.of({
      runGh: (args) =>
        Effect.sync(() => {
          if (args[1]?.endsWith("/logs")) {
            logFetches += 1;
            return { stdout: "2026-10-19T00:00:00Z ##[error]test failed", stderr: "", exitCode: 0 };
          }
          return { stdout: "base", stderr: "", exitCode: 0 };
        }),
      runGhJson: <T>(args: string[]) =>
        Effect.sync(() => {
          if (args[0] === "run")
            return {
              databaseId: 100,
              displayTitle: "CI",
              status: "completed",
              conclusion: "failure",
              headBranch: "feature",
              headSha: "head",
              createdAt: "2026-10-19T00:00:00Z",
              event: "pull_request",
              url: "url",
              workflowName: "CI",
              attempt: 1,
              jobs: [
                {
                  databaseId: 1000,
                  name: "Build",
                  status: "completed",
                  conclusion: "failure",
                  startedAt: "2026-10-19T00:00:00Z",
                  completedAt: "2026-10-19T00:01:00Z",
                  url: "url",
                  steps: [{ name: "Test", status: "completed", conclusion: "failure", number: 1 }],
                },
              ],
            } as T;
          if (args[1] === "checks")
            return [
              {
                name: "Build",
                state: "FAILURE",
                bucket: "fail",
                link: "https://github.com/o/r/actions/runs/100/job/1000",
              },
            ] as T;
          return {
            number: 1,
            url: "url",
            title: "title",
            headRefName: "feature",
            baseRefName: "main",
            headRefOid: "head",
            state: "OPEN",
            isDraft: false,
            mergeable: "MERGEABLE",
            body: "",
            author: { login: "fixture", is_bot: false },
            reviewDecision: "",
            reviewRequests: [],
          } as T;
        }),
      runGraphQL: () => Effect.die("Unexpected GraphQL read"),
      apiRequest: <T>({ path }: { path: string }) =>
        Effect.succeed({
          status: 200,
          body: (path.includes("check-runs")
            ? { check_runs: [] }
            : path.includes("/status")
              ? { statuses: [] }
              : { head: { sha: "head" }, base: { sha: "base" } }) as T,
          etag: '"fixture"',
        }),
      getRepoInfo: () =>
        Effect.succeed({ owner: "o", name: "r", defaultBranch: "main", url: "url" }),
      getRepoRef: () =>
        Effect.succeed({ owner: "o", name: "r", defaultBranch: "main", url: "url" }),
      getRepoConfig: () => Effect.succeed(undefined),
      withRepoTarget: (_target, effect) => effect,
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const read = fetchFailedChecks(1, true);
        const results = yield* Effect.all([read, read], { concurrency: 2 });
        expect(results[0]?.failedChecks[0]?.failedStepLogs).toContain("test failed");
        expect(results[1]).toEqual(results[0]);
        expect(yield* read).toEqual(results[0]);
        expect(logFetches).toBe(1);
        const unknown = fetchJobLogs({
          runId: 100,
          job: "Build",
          jobId: 1001,
          failedStepsOnly: false,
          repo: "o/r",
          format: "json",
        });
        yield* unknown;
        yield* unknown;
        expect(logFetches).toBe(3);
      }).pipe(
        Effect.provideService(GitHubService, gh),
        Effect.provideService(ReadCache, { store, warned: false }),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
