import { Command, Flag } from "effect/unstable/cli";
import { Effect, Option } from "effect";

import { formatOption, logFormatted } from "#shared";
import { GitHubService } from "./service";

type ReleaseListItem = {
  tagName: string;
  name: string;
  isDraft: boolean;
  isPrerelease: boolean;
  createdAt: string;
  publishedAt: string | null;
};

type ReleaseAuthor = {
  login: string;
};

type ReleaseAsset = {
  name: string;
  size: number;
  downloadCount: number;
  contentType: string;
  createdAt: string;
  updatedAt: string;
  url: string;
};

type ReleaseDetail = {
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

type ReleaseCreateResult = {
  created: true;
  tagName: string;
  name: string;
  url: string;
  isDraft: boolean;
  isPrerelease: boolean;
};

type ReleaseEditResult = {
  edited: true;
  tagName: string;
  name: string;
  url: string;
  isDraft: boolean;
  isPrerelease: boolean;
};

type ReleaseDeleteResult = {
  deleted: boolean;
  tagName: string;
  tagCleaned: boolean;
  dryRun?: true;
  message?: string;
};

type LatestRelease = {
  tagName: string;
  name: string;
  createdAt: string;
  url: string;
};

type ReleaseStatusResult = {
  latestRelease: LatestRelease | null;
  repo: {
    owner: string;
    name: string;
    defaultBranch: string;
    url: string;
  };
};

const listReleases = Effect.fn("release.listReleases")(function* (opts: {
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

const viewRelease = Effect.fn("release.viewRelease")(function* (opts: {
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

const createRelease = Effect.fn("release.createRelease")(function* (opts: {
  tag: string;
  title: string | null;
  body: string | null;
  notesFile: string | null;
  draft: boolean;
  prerelease: boolean;
  generateNotes: boolean;
  notesStartTag: string | null;
  target: string | null;
  verifyTag: boolean;
  latest: boolean | null;
  repo: string | null;
}) {
  const gh = yield* GitHubService;

  const args = ["release", "create", opts.tag];

  if (opts.title !== null) {
    args.push("--title", opts.title);
  }

  if (opts.body !== null) {
    args.push("--notes", opts.body);
  }

  if (opts.notesFile !== null) {
    args.push("--notes-file", opts.notesFile);
  }

  if (opts.draft) {
    args.push("--draft");
  }

  if (opts.prerelease) {
    args.push("--prerelease");
  }

  if (opts.generateNotes) {
    args.push("--generate-notes");
  }

  if (opts.notesStartTag !== null) {
    args.push("--notes-start-tag", opts.notesStartTag);
  }

  if (opts.target !== null) {
    args.push("--target", opts.target);
  }

  if (opts.verifyTag) {
    args.push("--verify-tag");
  }

  if (opts.latest !== null) {
    args.push(`--latest=${opts.latest ? "true" : "false"}`);
  }

  if (opts.repo !== null) {
    args.push("--repo", opts.repo);
  }

  const result = yield* gh.runGh(args);
  const lines = result.stdout
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const url = lines.length > 0 ? lines[lines.length - 1] : "";

  const created: ReleaseCreateResult = {
    created: true,
    tagName: opts.tag,
    name: opts.title ?? opts.tag,
    url,
    isDraft: opts.draft,
    isPrerelease: opts.prerelease,
  };

  return created;
});

const editRelease = Effect.fn("release.editRelease")(function* (opts: {
  tag: string;
  title: string | null;
  body: string | null;
  draft: boolean | null;
  prerelease: boolean | null;
  latest: boolean | null;
  repo: string | null;
}) {
  const gh = yield* GitHubService;

  const args = ["release", "edit", opts.tag];

  if (opts.title !== null) {
    args.push("--title", opts.title);
  }

  if (opts.body !== null) {
    args.push("--notes", opts.body);
  }

  if (opts.draft !== null) {
    args.push(`--draft=${opts.draft ? "true" : "false"}`);
  }

  if (opts.prerelease !== null) {
    args.push(`--prerelease=${opts.prerelease ? "true" : "false"}`);
  }

  if (opts.latest !== null) {
    args.push(`--latest=${opts.latest ? "true" : "false"}`);
  }

  if (opts.repo !== null) {
    args.push("--repo", opts.repo);
  }

  yield* gh.runGh(args);

  const updated = yield* viewRelease({
    tag: opts.tag,
    repo: opts.repo,
  });

  const edited: ReleaseEditResult = {
    edited: true,
    tagName: updated.tagName,
    name: updated.name,
    url: updated.url,
    isDraft: updated.isDraft,
    isPrerelease: updated.isPrerelease,
  };

  return edited;
});

const deleteRelease = Effect.fn("release.deleteRelease")(function* (opts: {
  tag: string;
  cleanupTag: boolean;
  confirm: boolean;
  repo: string | null;
}) {
  const gh = yield* GitHubService;

  if (!opts.confirm) {
    const scope = opts.repo !== null ? ` in ${opts.repo}` : "";
    const cleanup = opts.cleanupTag ? " and its git tag" : "";

    const dryRun: ReleaseDeleteResult = {
      deleted: false,
      tagName: opts.tag,
      tagCleaned: opts.cleanupTag,
      dryRun: true,
      message: `Dry run: would delete release ${opts.tag}${cleanup}${scope}. Re-run with --confirm to execute.`,
    };

    return dryRun;
  }

  const args = ["release", "delete", opts.tag, "--yes"];

  if (opts.cleanupTag) {
    args.push("--cleanup-tag");
  }

  if (opts.repo !== null) {
    args.push("--repo", opts.repo);
  }

  yield* gh.runGh(args);

  const deleted: ReleaseDeleteResult = {
    deleted: true,
    tagName: opts.tag,
    tagCleaned: opts.cleanupTag,
  };

  return deleted;
});

const releaseStatus = Effect.fn("release.releaseStatus")(function* (repo: string | null) {
  const gh = yield* GitHubService;

  const args = ["release", "list", "--json", "tagName,name,createdAt,url", "--limit", "1"];
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

export const releaseCreateCommand = Command.make(
  "create",
  {
    body: Flag.string("body").pipe(
      Flag.withDescription("Release notes body (markdown)"),
      Flag.optional,
    ),
    draft: Flag.boolean("draft").pipe(
      Flag.withDescription("Create as draft release"),
      Flag.withDefault(false),
    ),
    format: formatOption,
    generateNotes: Flag.boolean("generate-notes").pipe(
      Flag.withDescription("Automatically generate release notes"),
      Flag.withDefault(false),
    ),
    latest: Flag.boolean("latest").pipe(
      Flag.withDescription("Mark this release as latest (true/false). Omit to leave unchanged"),
      Flag.optional,
    ),
    notesFile: Flag.string("notes-file").pipe(
      Flag.withDescription("Path to release notes file (passed to gh --notes-file)"),
      Flag.optional,
    ),
    notesStartTag: Flag.string("notes-start-tag").pipe(
      Flag.withDescription("Tag to start generating notes from"),
      Flag.optional,
    ),
    prerelease: Flag.boolean("prerelease").pipe(
      Flag.withDescription("Mark as pre-release"),
      Flag.withDefault(false),
    ),
    repo: Flag.string("repo").pipe(
      Flag.withDescription("Target repository (owner/name). Defaults to current repo"),
      Flag.optional,
    ),
    tag: Flag.string("tag").pipe(Flag.withDescription("Tag name for release (e.g., v1.2.3)")),
    target: Flag.string("target").pipe(
      Flag.withDescription("Target branch or commit SHA for tag"),
      Flag.optional,
    ),
    title: Flag.string("title").pipe(
      Flag.withDescription("Release title (defaults to tag)"),
      Flag.optional,
    ),
    verifyTag: Flag.boolean("verify-tag").pipe(
      Flag.withDescription("Abort if tag does not already exist in remote"),
      Flag.withDefault(false),
    ),
  },
  ({
    body,
    draft,
    format,
    generateNotes,
    latest,
    notesFile,
    notesStartTag,
    prerelease,
    repo,
    tag,
    target,
    title,
    verifyTag,
  }) =>
    Effect.gen(function* () {
      const result = yield* createRelease({
        tag,
        title: Option.getOrNull(title),
        body: Option.getOrNull(body),
        notesFile: Option.getOrNull(notesFile),
        draft,
        prerelease,
        generateNotes,
        notesStartTag: Option.getOrNull(notesStartTag),
        target: Option.getOrNull(target),
        verifyTag,
        latest: Option.getOrNull(latest),
        repo: Option.getOrNull(repo),
      });

      yield* logFormatted(result, format);
    }),
).pipe(
  Command.withDescription(
    "Create a release (supports --notes-file, --generate-notes, --target, --verify-tag, --latest)",
  ),
);

export const releaseListCommand = Command.make(
  "list",
  {
    format: formatOption,
    limit: Flag.integer("limit").pipe(
      Flag.withDescription("Maximum number of releases to return"),
      Flag.withDefault(10),
    ),
    repo: Flag.string("repo").pipe(
      Flag.withDescription("Target repository (owner/name). Defaults to current repo"),
      Flag.optional,
    ),
  },
  ({ format, limit, repo }) =>
    Effect.gen(function* () {
      const releases = yield* listReleases({
        limit,
        repo: Option.getOrNull(repo),
      });

      yield* logFormatted(releases, format);
    }),
).pipe(Command.withDescription("List releases"));

export const releaseViewCommand = Command.make(
  "view",
  {
    format: formatOption,
    repo: Flag.string("repo").pipe(
      Flag.withDescription("Target repository (owner/name). Defaults to current repo"),
      Flag.optional,
    ),
    tag: Flag.string("tag").pipe(Flag.withDescription("Release tag to view (e.g., v1.2.3)")),
  },
  ({ format, repo, tag }) =>
    Effect.gen(function* () {
      const release = yield* viewRelease({
        tag,
        repo: Option.getOrNull(repo),
      });

      yield* logFormatted(release, format);
    }),
).pipe(Command.withDescription("View release details by tag"));

export const releaseEditCommand = Command.make(
  "edit",
  {
    body: Flag.string("body").pipe(
      Flag.withDescription("New release notes body (markdown)"),
      Flag.optional,
    ),
    draft: Flag.boolean("draft").pipe(
      Flag.withDescription("Set draft status (true/false). Omit to keep current value"),
      Flag.optional,
    ),
    format: formatOption,
    latest: Flag.boolean("latest").pipe(
      Flag.withDescription("Set latest status (true/false). Omit to keep current value"),
      Flag.optional,
    ),
    prerelease: Flag.boolean("prerelease").pipe(
      Flag.withDescription("Set prerelease status (true/false). Omit to keep current value"),
      Flag.optional,
    ),
    repo: Flag.string("repo").pipe(
      Flag.withDescription("Target repository (owner/name). Defaults to current repo"),
      Flag.optional,
    ),
    tag: Flag.string("tag").pipe(Flag.withDescription("Release tag to edit (e.g., v1.2.3)")),
    title: Flag.string("title").pipe(Flag.withDescription("New release title"), Flag.optional),
  },
  ({ body, draft, format, latest, prerelease, repo, tag, title }) =>
    Effect.gen(function* () {
      const edited = yield* editRelease({
        tag,
        title: Option.getOrNull(title),
        body: Option.getOrNull(body),
        draft: Option.getOrNull(draft),
        prerelease: Option.getOrNull(prerelease),
        latest: Option.getOrNull(latest),
        repo: Option.getOrNull(repo),
      });

      yield* logFormatted(edited, format);
    }),
).pipe(Command.withDescription("Edit an existing release"));

export const releaseDeleteCommand = Command.make(
  "delete",
  {
    cleanupTag: Flag.boolean("cleanup-tag").pipe(
      Flag.withDescription("Also delete the git tag from remote"),
      Flag.withDefault(false),
    ),
    confirm: Flag.boolean("confirm").pipe(
      Flag.withDescription("Actually delete release (without this flag, only shows dry-run)"),
      Flag.withDefault(false),
    ),
    format: formatOption,
    repo: Flag.string("repo").pipe(
      Flag.withDescription("Target repository (owner/name). Defaults to current repo"),
      Flag.optional,
    ),
    tag: Flag.string("tag").pipe(Flag.withDescription("Release tag to delete (e.g., v1.2.3)")),
  },
  ({ cleanupTag, confirm, format, repo, tag }) =>
    Effect.gen(function* () {
      const result = yield* deleteRelease({
        tag,
        cleanupTag,
        confirm,
        repo: Option.getOrNull(repo),
      });

      yield* logFormatted(result, format);
    }),
).pipe(Command.withDescription("Delete a release (dry-run by default, use --confirm to execute)"));

export const releaseStatusCommand = Command.make(
  "status",
  {
    format: formatOption,
    repo: Flag.string("repo").pipe(
      Flag.withDescription("Target repository (owner/name). Defaults to current repo"),
      Flag.optional,
    ),
  },
  ({ format, repo }) =>
    Effect.gen(function* () {
      const status = yield* releaseStatus(Option.getOrNull(repo));
      yield* logFormatted(status, format);
    }),
).pipe(Command.withDescription("Show release readiness status (latest release + repository info)"));
