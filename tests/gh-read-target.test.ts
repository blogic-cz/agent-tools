import { expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubService } from "#gh/service";
import type { GitHubApiRequest, GitHubApiResponse } from "#gh/api";
import { ReadCache } from "#gh/read/cache";
import { FileStore } from "#gh/read/store";
import { prView, prChecks } from "#gh/read/pulls";
import { OPS } from "#gh/read/classes";
import { GitHubCommandError } from "#gh/errors";

const repo = { owner: "o", name: "r" };
const pull = {
  number: 1,
  url: "url",
  title: "Test",
  headRefName: "feature",
  baseRefName: "main",
  headRefOid: "first",
  state: "OPEN",
  isDraft: false,
  mergeable: "MERGEABLE",
  body: "",
  author: { login: "fixture", is_bot: false },
  reviewDecision: "",
  reviewRequests: [],
};

it("seeds a branch-selected number and resolves checks without a supplied head", async () => {
  const root = await mkdtemp(join(tmpdir(), "gh-read-target-"));
  try {
    const store = await FileStore.open("fixture", root);
    let views = 0;
    let checks = 0;
    const gh = GitHubService.of({
      runGhJson: <T>(args: string[]) =>
        Effect.sync(() => {
          if (args[1] === "view") {
            views += 1;
            return pull as T;
          }
          checks += 1;
          expect(args.slice(0, 3)).toEqual(["pr", "checks", "1"]);
          return [{ name: "CI", state: "SUCCESS", bucket: "pass", link: "external" }] as T;
        }),
      apiRequest: <T>({ path }: GitHubApiRequest) =>
        Effect.succeed({
          status: 200,
          body: (path.includes("/pulls/")
            ? { head: { sha: "first" }, base: { sha: "base" } }
            : { check_runs: [], statuses: [] }) as T,
        } satisfies GitHubApiResponse<T>),
      runGh: () => Effect.die("Unexpected raw request"),
      runGraphQL: () => Effect.die("Unexpected GraphQL request"),
      getRepoInfo: () => Effect.die("Unexpected repo request"),
      getRepoConfig: () => Effect.succeed(undefined),
      withRepoTarget: (_target, effect) => effect,
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* prView(repo, { by: "currentBranch" });
        expect((yield* prView(repo, { by: "number", number: 1 })).number).toBe(1);
        expect(views).toBe(1);
        yield* prChecks(repo, 1, null);
        yield* prChecks(repo, 1, null);
        expect(checks).toBe(1);
      }).pipe(
        Effect.provideService(GitHubService, gh),
        Effect.provideService(ReadCache, { store, warned: false }),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("does not publish checks under a head that moved during porcelain", async () => {
  const root = await mkdtemp(join(tmpdir(), "gh-read-head-fence-"));
  try {
    const store = await FileStore.open("fixture", root);
    let head = "first";
    const gh = GitHubService.of({
      runGhJson: <T>() =>
        Effect.sync(() => {
          head = "second";
          return [] as T;
        }),
      apiRequest: <T>({ path }: GitHubApiRequest) =>
        Effect.succeed({
          status: 200,
          body: (path.includes("/pulls/")
            ? { head: { sha: head }, base: { sha: "base" } }
            : { check_runs: [], statuses: [] }) as T,
        }),
      runGh: () => Effect.die("Unexpected raw request"),
      runGraphQL: () => Effect.die("Unexpected GraphQL request"),
      getRepoInfo: () => Effect.die("Unexpected repo request"),
      getRepoConfig: () => Effect.succeed(undefined),
      withRepoTarget: (_target, effect) => effect,
    });
    const error = await Effect.runPromise(
      prChecks(repo, 1, "first").pipe(
        Effect.provideService(GitHubService, gh),
        Effect.provideService(ReadCache, { store, warned: false }),
        Effect.flip,
      ),
    );
    expect(error).toBeInstanceOf(GitHubCommandError);
    const next = await store.prepare(
      { op: "prChecks", repo, pr: 1, headSha: "first" },
      OPS.prChecks,
      Schema.decodeUnknownSync(Schema.Unknown),
    );
    expect(next.kind).toBe("fetch");
    if (next.kind === "fetch") await store.release(next.key, next.owner);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
