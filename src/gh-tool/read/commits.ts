import { Effect, Schema } from "effect";

import { GitHubService } from "./transport";
import { cachedRead } from "./cache";
import { OPS } from "./classes";
import { repoSlug } from "./keys";
import type { RepoRef } from "./keys";
import { parsePreserving } from "./porcelain";

const CommitAuthor = Schema.Struct({
  sha: Schema.String,
  author: Schema.NullOr(Schema.Struct({ login: Schema.String })),
});

export const commitAuthor = Effect.fn("reads.commitAuthor")(function* (repo: RepoRef, sha: string) {
  const gh = yield* GitHubService;
  const decode = parsePreserving(CommitAuthor);
  const value = yield* cachedRead({
    key: { op: "commitAuthor", repo, sha },
    policy: OPS.commitAuthor,
    decode,
    fetch: () =>
      gh
        .runGhJson<unknown>(["api", `repos/${repoSlug(repo)}/commits/${encodeURIComponent(sha)}`])
        .pipe(Effect.map((raw) => ({ kind: "fresh" as const, value: decode(raw) }))),
  });
  return { sha: value.sha, author: value.author === null ? null : { login: value.author.login } };
});
