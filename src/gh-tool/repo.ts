import { Command, Flag } from "effect/unstable/cli";
import { Effect, Option } from "effect";

import { formatOption, logFormatted } from "#shared";
import { GitHubCommandError } from "./errors";
import { GitHubService } from "./service";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type OrgRepo = {
  name: string;
  description: string | null;
  visibility: string;
  updatedAt: string;
  url: string;
  isArchived: boolean;
};

type CodeSearchResponse = {
  items: Array<{
    repository: {
      full_name: string;
    };
    path: string;
    html_url: string;
  }>;
};

// ---------------------------------------------------------------------------
// Internal handlers
// ---------------------------------------------------------------------------

const listOrgRepos = Effect.fn("repo.listOrgRepos")(function* (opts: {
  org: string;
  limit: number;
  visibility: string | null;
}) {
  const gh = yield* GitHubService;

  const args = [
    "repo",
    "list",
    opts.org,
    "--json",
    "name,description,visibility,updatedAt,url,isArchived",
    "--limit",
    String(opts.limit),
  ];

  if (opts.visibility !== null) {
    args.push("--visibility", opts.visibility);
  }

  return yield* gh.runGhJson<OrgRepo[]>(args);
});

const searchOrgCode = Effect.fn("repo.searchOrgCode")(function* (opts: {
  org: string;
  query: string;
  limit: number;
}) {
  const gh = yield* GitHubService;

  const trimmedQuery = opts.query.trim();
  if (trimmedQuery.length === 0) {
    return yield* new GitHubCommandError({
      message: "Search query cannot be empty",
      command: "repo search-code",
      exitCode: 1,
      stderr: "Search query cannot be empty",
    });
  }

  const searchQuery = encodeURIComponent(`${trimmedQuery} org:${opts.org}`);
  const args = ["api", `/search/code?q=${searchQuery}&per_page=${opts.limit}`];

  const response = yield* gh.runGhJson<CodeSearchResponse>(args);

  return response.items.map((item) => ({
    repo: item.repository.full_name,
    path: item.path,
    url: item.html_url,
  }));
});

// ---------------------------------------------------------------------------
// CLI Commands
// ---------------------------------------------------------------------------

export const repoInfoCommand = Command.make("info", { format: formatOption }, ({ format }) =>
  Effect.gen(function* () {
    const gh = yield* GitHubService;
    const info = yield* gh.getRepoInfo();
    yield* logFormatted(info, format);
  }),
).pipe(Command.withDescription("Show repository information (owner, name, default branch, URL)"));

export const repoListCommand = Command.make(
  "list",
  {
    format: formatOption,
    limit: Flag.integer("limit").pipe(
      Flag.withDescription("Maximum number of repositories to return"),
      Flag.withDefault(30),
    ),
    org: Flag.string("org").pipe(Flag.withDescription("GitHub organization slug")),
    visibility: Flag.choice("visibility", ["public", "private", "all"]).pipe(
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
    limit: Flag.integer("limit").pipe(
      Flag.withDescription("Maximum number of results to return"),
      Flag.withDefault(30),
    ),
    org: Flag.string("org").pipe(Flag.withDescription("GitHub organization slug")),
    query: Flag.string("query").pipe(Flag.withDescription("Code search query")),
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
