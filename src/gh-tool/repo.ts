import { Command, Flag } from "effect/cli";
import { Effect, Option } from "effect";

import { formatOption, logFormatted } from "#shared";
import { passthrough } from "./read/catalog";
import { GitHubService } from "./read/transport";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const listOrgRepos = passthrough.listOrgRepos;
const searchOrgCode = passthrough.searchOrgCode;

// ---------------------------------------------------------------------------
// CLI Commands
// ---------------------------------------------------------------------------

const repoOption = Flag.String("repo").pipe(
  Flag.withDescription("Target repository profile name or owner/name"),
  Flag.optional,
);

export const repoInfoCommand = Command.make(
  "info",
  { format: formatOption, repo: repoOption },
  ({ format, repo }) =>
    Effect.gen(function* () {
      const gh = yield* GitHubService;
      yield* gh.withRepoTarget(
        Option.getOrNull(repo),
        Effect.gen(function* () {
          const info = yield* passthrough.repoInfo();
          yield* logFormatted(info, format);
        }),
      );
    }),
).pipe(Command.withDescription("Show repository information (owner, name, default branch, URL)"));

export const repoListCommand = Command.make(
  "list",
  {
    format: formatOption,
    limit: Flag.Int("limit").pipe(
      Flag.withDescription("Maximum number of repositories to return"),
      Flag.withDefault(30),
    ),
    org: Flag.String("org").pipe(Flag.withDescription("GitHub organization slug")),
    visibility: Flag.Literals("visibility", ["public", "private", "all"]).pipe(
      Flag.withDescription("Filter by repository visibility"),
      Flag.optional,
    ),
  },
  ({ format, limit, org, visibility }) =>
    Effect.gen(function* () {
      const repos = yield* listOrgRepos({
        limit,
        org,
        visibility: Option.getOrNull(visibility),
      });
      yield* logFormatted(repos, format);
    }),
).pipe(
  Command.withDescription("List repositories in a GitHub organization (filter by --visibility)"),
);

export const repoSearchCodeCommand = Command.make(
  "search-code",
  {
    format: formatOption,
    limit: Flag.Int("limit").pipe(
      Flag.withDescription("Maximum number of results to return"),
      Flag.withDefault(30),
    ),
    org: Flag.String("org").pipe(Flag.withDescription("GitHub organization slug")),
    query: Flag.String("query").pipe(Flag.withDescription("Code search query")),
  },
  ({ format, limit, org, query }) =>
    Effect.gen(function* () {
      const results = yield* searchOrgCode({
        limit,
        org,
        query,
      });
      yield* logFormatted(results, format);
    }),
).pipe(Command.withDescription("Search code across organization repositories"));
