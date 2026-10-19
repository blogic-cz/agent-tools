import { Effect } from "effect";
import { GitHubService } from "#gh/read/transport";
import { GitHubCommandError } from "#gh/errors";

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

export const listOrgRepos = Effect.fn("repo.listOrgRepos")(function* (opts: {
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

export const searchOrgCode = Effect.fn("repo.searchOrgCode")(function* (opts: {
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

export type ReleaseListItem = {
  tagName: string;
  name: string;
  isDraft: boolean;
  isPrerelease: boolean;
  createdAt: string;
  publishedAt: string | null;
};

export type ReleaseAuthor = {
  login: string;
};

export type ReleaseAsset = {
  name: string;
  size: number;
  downloadCount: number;
  contentType: string;
  createdAt: string;
  updatedAt: string;
  url: string;
};

export type ReleaseDetail = {
  tagName: string;
  name: string;
  isDraft: boolean;
  isPrerelease: boolean;
  createdAt: string;
  publishedAt: string | null;
  url: string;
  body: string;
  targetCommitish: string;
  author: ReleaseAuthor | null;
  assets: ReleaseAsset[];
};

export type ReleaseCreateResult = {
  created: true;
  tagName: string;
  name: string;
  url: string;
  isDraft: boolean;
  isPrerelease: boolean;
};

export type ReleaseEditResult = {
  edited: true;
  tagName: string;
  name: string;
  url: string;
  isDraft: boolean;
  isPrerelease: boolean;
};

export type ReleaseDeleteResult = {
  deleted: boolean;
  tagName: string;
  tagCleaned: boolean;
  dryRun?: true;
  message?: string;
};

export type LatestRelease = {
  tagName: string;
  name: string;
  createdAt: string;
  publishedAt: string | null;
  isLatest: boolean;
};

export type ReleaseStatusResult = {
  latestRelease: LatestRelease | null;
  repo: {
    owner: string;
    name: string;
    defaultBranch: string;
    url: string;
  };
};

export const listReleases = Effect.fn("release.listReleases")(function* (opts: {
  limit: number;
  repo: string | null;
}) {
  const gh = yield* GitHubService;

  const args = [
    "release",
    "list",
    "--json",
    "tagName,name,isDraft,isPrerelease,createdAt,publishedAt",
    "--limit",
    String(opts.limit),
  ];

  if (opts.repo !== null) {
    args.push("--repo", opts.repo);
  }

  return yield* gh.runGhJson<ReleaseListItem[]>(args);
});

export const viewRelease = Effect.fn("release.viewRelease")(function* (opts: {
  tag: string;
  repo: string | null;
}) {
  const gh = yield* GitHubService;

  const args = [
    "release",
    "view",
    opts.tag,
    "--json",
    "tagName,name,isDraft,isPrerelease,createdAt,publishedAt,url,body,targetCommitish,author,assets",
  ];

  if (opts.repo !== null) {
    args.push("--repo", opts.repo);
  }

  return yield* gh.runGhJson<ReleaseDetail>(args);
});

export const releaseStatus = Effect.fn("release.releaseStatus")(function* (repo: string | null) {
  const gh = yield* GitHubService;

  const args = [
    "release",
    "list",
    "--json",
    "tagName,name,createdAt,publishedAt,isLatest",
    "--limit",
    "1",
  ];
  if (repo !== null) {
    args.push("--repo", repo);
  }

  const [repoInfo, releases] = yield* Effect.all([
    gh.getRepoInfo(),
    gh.runGhJson<LatestRelease[]>(args),
  ]);

  const result: ReleaseStatusResult = {
    latestRelease: releases.length > 0 ? releases[0] : null,
    repo: {
      owner: repoInfo.owner,
      name: repoInfo.name,
      defaultBranch: repoInfo.defaultBranch,
      url: repoInfo.url,
    },
  };

  return result;
});
export type GistApiFile = {
  filename: string;
  language: string | null;
  type: string;
  size: number;
  truncated?: boolean;
  content?: string;
};

export type GistApi = {
  id: string;
  description: string | null;
  public: boolean;
  html_url: string;
  created_at: string;
  updated_at: string;
  owner: { login: string } | null;
  files: Record<string, GistApiFile>;
};

const gistList = Effect.fn("reads.gistList")(function* (limit: number) {
  const gh = yield* GitHubService;
  return yield* gh.runGhJson<GistApi[]>(["api", `gists?per_page=${limit}`]);
});
const gistView = Effect.fn("reads.gistView")(function* (id: string) {
  const gh = yield* GitHubService;
  return yield* gh.runGhJson<GistApi>(["api", `gists/${id}`]);
});
export type AsyncMergeResult = {
  status: "pending" | "merged" | "enqueued" | "failed";
  details?: {
    message?: string;
    uuid?: string;
    sha?: string;
    merge_method?: "squash" | "merge" | "rebase";
  };
};
const baseSha = Effect.fn("reads.baseSha")(function* (
  repo: { owner: string; name: string },
  pr: number,
) {
  const gh = yield* GitHubService;
  return yield* gh.runGh([
    "api",
    `repos/${repo.owner}/${repo.name}/pulls/${pr}`,
    "--jq",
    ".base.sha",
  ]);
});
const asyncMergeStatus = Effect.fn("reads.asyncMergeStatus")(function* (path: string) {
  const gh = yield* GitHubService;
  return yield* gh.runGhJson<AsyncMergeResult>(["api", path]);
});
const stackMergeStatus = Effect.fn("reads.stackMergeStatus")(function* (path: string) {
  const gh = yield* GitHubService;
  return yield* gh.apiRequest<AsyncMergeResult>({ path });
});
export const passthrough = {
  listOrgRepos,
  searchOrgCode,
  listReleases,
  viewRelease,
  releaseStatus,
  gistList,
  gistView,
  baseSha,
  asyncMergeStatus,
  stackMergeStatus,
};
