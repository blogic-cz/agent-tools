import { Command, Flag } from "effect/unstable/cli";
import { Effect, Option } from "effect";
import { join } from "node:path";

import { formatOption, logFormatted } from "#shared";
import { isSensitivePath, resolveOptionalTextInput } from "#gh/text-input";
import { GitHubCommandError } from "./errors";
import { GitHubService } from "./service";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// `gh gist list/view` have no --json, so reads go through `gh api gists` (REST shape).
type GistApiFile = {
  filename: string;
  language: string | null;
  type: string;
  size: number;
  truncated?: boolean;
  content?: string;
};

type GistApi = {
  id: string;
  description: string | null;
  public: boolean;
  html_url: string;
  created_at: string;
  updated_at: string;
  owner: { login: string } | null;
  files: Record<string, GistApiFile>;
};

type GistListItem = {
  id: string;
  description: string | null;
  public: boolean;
  url: string;
  createdAt: string;
  updatedAt: string;
  files: string[];
};

type GistFile = {
  filename: string;
  language: string | null;
  size: number;
  truncated: boolean;
  content?: string;
};

type GistDetail = {
  id: string;
  description: string | null;
  public: boolean;
  url: string;
  createdAt: string;
  updatedAt: string;
  owner: string | null;
  files: GistFile[];
};

type GistCreateResult = {
  created: true;
  id: string;
  url: string;
  public: boolean;
  files: string[];
};

type GistEditResult = {
  edited: true;
  id: string;
  changes: string[];
};

type GistDeleteResult = {
  deleted: boolean;
  id: string;
  dryRun?: true;
  message?: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const inputError = (message: string, command: string) =>
  new GitHubCommandError({
    message,
    command,
    exitCode: 1,
    stderr: message,
  });

const parsePaths = (value: string, command: string) => {
  const paths = value.split(",").map((path) => path.trim());

  if (paths.length === 0 || paths.some((path) => path.length === 0)) {
    return Effect.fail(
      inputError(`--files must be comma-separated paths without empty segments: ${value}`, command),
    );
  }

  const sensitivePath = paths.find((path) => validateFilePath(path, command) !== null);
  if (sensitivePath !== undefined) {
    const validation = validateFilePath(sensitivePath, command);
    if (validation !== null) return Effect.fail(validation);
  }

  return Effect.succeed(paths);
};

const validateFilePath = (path: string, command: string) =>
  isSensitivePath(path) ? inputError(`Refusing to read sensitive file: ${path}`, command) : null;

// `gh gist create/edit` read content from files only; inline --body is staged in a temp file
// whose basename becomes the gist filename.
const stageBody = Effect.fn("gist.stageBody")(function* (opts: {
  body: string;
  filename: string;
  command: string;
}) {
  const directory = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const proc = Bun.spawn(
          ["mktemp", "-d", join(process.env.TMPDIR ?? "/tmp", "gh-tool-gist-XXXXXX")],
          { stdout: "pipe", stderr: "pipe" },
        );
        const [exitCode, stdout, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);

        if (exitCode !== 0) {
          throw new Error(stderr.trim() || `mktemp exited with code ${exitCode}`);
        }

        return stdout.trim();
      },
      catch: (error) =>
        inputError(
          `Failed to stage gist content: ${error instanceof Error ? error.message : String(error)}`,
          opts.command,
        ),
    }),
    (tempDirectory) =>
      Effect.tryPromise({
        try: async () => {
          const proc = Bun.spawn(["rm", "-rf", tempDirectory], {
            stdout: "ignore",
            stderr: "ignore",
          });
          await proc.exited;
        },
        catch: () => undefined,
      }).pipe(Effect.ignore),
  );
  const path = join(directory, opts.filename);

  yield* Effect.tryPromise({
    try: () => Bun.write(path, opts.body),
    catch: (error) =>
      inputError(
        `Failed to stage gist content: ${error instanceof Error ? error.message : String(error)}`,
        opts.command,
      ),
  });

  return path;
});

const toListItem = (gist: GistApi): GistListItem => ({
  id: gist.id,
  description: gist.description,
  public: gist.public,
  url: gist.html_url,
  createdAt: gist.created_at,
  updatedAt: gist.updated_at,
  files: Object.keys(gist.files ?? {}),
});

export const toGistDetail = (
  gist: GistApi,
  opts: { filename: string | null; withContent: boolean },
): GistDetail => {
  const files = Object.values(gist.files ?? {})
    .filter((file) => opts.filename === null || file.filename === opts.filename)
    .map((file) => {
      const result: GistFile = {
        filename: file.filename,
        language: file.language,
        size: file.size,
        truncated: file.truncated ?? false,
      };

      if (opts.withContent) {
        result.content = file.content ?? "";
      }

      return result;
    });

  return {
    id: gist.id,
    description: gist.description,
    public: gist.public,
    url: gist.html_url,
    createdAt: gist.created_at,
    updatedAt: gist.updated_at,
    owner: gist.owner?.login ?? null,
    files,
  };
};

export const validateBodyFilename = (
  body: string | null,
  filename: string | null,
  command: string,
): GitHubCommandError | null => {
  if (body === null) return null;
  if (filename === null) {
    return inputError("--filename is required with --body/--body-file", command);
  }
  if (filename === "." || filename === ".." || /[\\/]/.test(filename)) {
    return inputError("--filename must be a file name without path separators", command);
  }
  return null;
};

export const validateEditInput = (opts: {
  body: string | null;
  filename: string | null;
  description: string | null;
  add: string | null;
  remove: string | null;
}): GitHubCommandError | null => {
  const command = "gh-tool gist edit";

  if (
    opts.body === null &&
    opts.description === null &&
    opts.add === null &&
    opts.remove === null
  ) {
    return inputError(
      "Provide at least one of --body/--body-file (with --filename), --desc, --add, or --remove",
      command,
    );
  }

  return validateBodyFilename(opts.body, opts.filename, command);
};

// ---------------------------------------------------------------------------
// Internal handlers
// ---------------------------------------------------------------------------

const listGists = Effect.fn("gist.listGists")(function* (opts: {
  limit: number;
  visibility: string | null;
}) {
  const gh = yield* GitHubService;

  const gists = yield* gh.runGhJson<GistApi[]>(["api", `gists?per_page=${opts.limit}`]);

  return gists
    .filter(
      (gist) =>
        opts.visibility === null || (opts.visibility === "public" ? gist.public : !gist.public),
    )
    .map(toListItem);
});

const viewGist = Effect.fn("gist.viewGist")(function* (opts: {
  id: string;
  filename: string | null;
  withContent: boolean;
}) {
  const gh = yield* GitHubService;

  const gist = yield* gh.runGhJson<GistApi>(["api", `gists/${opts.id}`]);

  return toGistDetail(gist, { filename: opts.filename, withContent: opts.withContent });
});

const createGist = Effect.fn("gist.createGist")(function* (opts: {
  paths: string[];
  description: string | null;
  public: boolean;
}) {
  const gh = yield* GitHubService;

  const args = ["gist", "create", ...opts.paths];

  if (opts.description !== null) {
    args.push("--desc", opts.description);
  }

  if (opts.public) {
    args.push("--public");
  }

  const result = yield* gh.runGh(args);
  const url =
    result.stdout
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .findLast((line) => line.startsWith("https://")) ?? "";

  const created: GistCreateResult = {
    created: true,
    id: url.split("/").at(-1) ?? "",
    url,
    public: opts.public,
    files: opts.paths.map((path) => path.split("/").at(-1) ?? path),
  };

  return created;
});

const editGist = Effect.fn("gist.editGist")(function* (opts: {
  id: string;
  description: string | null;
  add: string | null;
  remove: string | null;
  filename: string | null;
  sourcePath: string | null;
}) {
  const gh = yield* GitHubService;

  const args = ["gist", "edit", opts.id];
  const changes: string[] = [];

  if (opts.sourcePath !== null) {
    args.push(opts.sourcePath);
    changes.push(`content:${opts.filename ?? opts.sourcePath.split("/").at(-1)}`);
  }

  if (opts.description !== null) {
    args.push("--desc", opts.description);
    changes.push("description");
  }

  if (opts.add !== null) {
    args.push("--add", opts.add);
    changes.push(`add:${opts.add.split("/").at(-1)}`);
  }

  if (opts.remove !== null) {
    args.push("--remove", opts.remove);
    changes.push(`remove:${opts.remove}`);
  }

  if (opts.filename !== null) {
    args.push("--filename", opts.filename);
  }

  yield* gh.runGh(args);

  const edited: GistEditResult = { edited: true, id: opts.id, changes };

  return edited;
});

const deleteGist = Effect.fn("gist.deleteGist")(function* (opts: { id: string; confirm: boolean }) {
  const gh = yield* GitHubService;

  if (!opts.confirm) {
    const dryRun: GistDeleteResult = {
      deleted: false,
      id: opts.id,
      dryRun: true,
      message: `Would delete gist ${opts.id}. Re-run with --confirm to execute.`,
    };

    return dryRun;
  }

  yield* gh.runGh(["gist", "delete", opts.id, "--yes"]);

  const deleted: GistDeleteResult = { deleted: true, id: opts.id };

  return deleted;
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export const gistListCommand = Command.make(
  "list",
  {
    format: formatOption,
    limit: Flag.integer("limit").pipe(
      Flag.withDescription("Maximum number of gists to return"),
      Flag.withDefault(10),
    ),
    visibility: Flag.choice("visibility", ["public", "secret"]).pipe(
      Flag.withDescription("Filter by visibility: public or secret"),
      Flag.optional,
    ),
  },
  ({ format, limit, visibility }) =>
    Effect.gen(function* () {
      const requested = Option.getOrNull(visibility);

      const gists = yield* listGists({ limit, visibility: requested });

      yield* logFormatted(gists, format);
    }),
).pipe(Command.withDescription("List your gists (id, description, visibility, file names)"));

export const gistViewCommand = Command.make(
  "view",
  {
    filename: Flag.string("filename").pipe(
      Flag.withDescription("Return only this file from the gist"),
      Flag.optional,
    ),
    format: formatOption,
    id: Flag.string("id").pipe(Flag.withDescription("Gist id or URL")),
    metadataOnly: Flag.boolean("metadata-only").pipe(
      Flag.withDescription("Omit file contents"),
      Flag.withDefault(false),
    ),
  },
  ({ filename, format, id, metadataOnly }) =>
    Effect.gen(function* () {
      const gist = yield* viewGist({
        id: id.split("/").at(-1) ?? id,
        filename: Option.getOrNull(filename),
        withContent: !metadataOnly,
      });

      yield* logFormatted(gist, format);
    }),
).pipe(Command.withDescription("View a gist with file contents"));

export const gistCreateCommand = Command.make(
  "create",
  {
    body: Flag.string("body").pipe(
      Flag.withDescription("Inline gist content (requires --filename)"),
      Flag.optional,
    ),
    bodyFile: Flag.string("body-file").pipe(
      Flag.withDescription(
        "Read gist content from a file path or '-' for stdin (requires --filename)",
      ),
      Flag.optional,
    ),
    desc: Flag.string("desc").pipe(Flag.withDescription("Gist description"), Flag.optional),
    filename: Flag.string("filename").pipe(
      Flag.withDescription("File name used for --body/--body-file content"),
      Flag.optional,
    ),
    files: Flag.string("files").pipe(
      Flag.withDescription("Comma-separated paths of existing files to upload"),
      Flag.optional,
    ),
    format: formatOption,
    public: Flag.boolean("public").pipe(
      Flag.withDescription("Publish as a public gist (gists are secret by default)"),
      Flag.withDefault(false),
    ),
  },
  ({ body, bodyFile, desc, filename, files, format, public: isPublic }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const command = "gh-tool gist create";
        const filesValue = Option.getOrNull(files);
        const resolvedBody = yield* resolveOptionalTextInput({
          command,
          value: Option.getOrNull(body),
          fileValue: Option.getOrNull(bodyFile),
          valueFlag: "--body",
          fileFlag: "--body-file",
          label: "body",
        });

        if (filesValue === null && resolvedBody === null) {
          return yield* Effect.fail(
            inputError("Provide --files, or --body/--body-file with --filename", command),
          );
        }

        const paths: string[] = [];

        if (filesValue !== null) {
          paths.push(...(yield* parsePaths(filesValue, command)));
        }

        if (resolvedBody !== null) {
          const name = Option.getOrNull(filename);

          if (name === null) {
            return yield* Effect.fail(
              validateBodyFilename(resolvedBody, name, command) ??
                inputError("--filename is required with --body/--body-file", command),
            );
          }

          paths.push(yield* stageBody({ body: resolvedBody, filename: name, command }));
        }

        const created = yield* createGist({
          paths,
          description: Option.getOrNull(desc),
          public: isPublic,
        });

        yield* logFormatted(created, format);
      }),
    ),
).pipe(Command.withDescription("Create a gist from files or inline content (secret by default)"));

export const gistEditCommand = Command.make(
  "edit",
  {
    add: Flag.string("add").pipe(
      Flag.withDescription("Path of a new file to add to the gist"),
      Flag.optional,
    ),
    body: Flag.string("body").pipe(
      Flag.withDescription("Replacement content for --filename"),
      Flag.optional,
    ),
    bodyFile: Flag.string("body-file").pipe(
      Flag.withDescription("Read replacement content from a file path or '-' for stdin"),
      Flag.optional,
    ),
    desc: Flag.string("desc").pipe(Flag.withDescription("New gist description"), Flag.optional),
    filename: Flag.string("filename").pipe(
      Flag.withDescription("Gist file to replace with --body/--body-file"),
      Flag.optional,
    ),
    format: formatOption,
    id: Flag.string("id").pipe(Flag.withDescription("Gist id or URL")),
    remove: Flag.string("remove").pipe(
      Flag.withDescription("File name to remove from the gist"),
      Flag.optional,
    ),
  },
  ({ add, body, bodyFile, desc, filename, format, id, remove }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const command = "gh-tool gist edit";
        const resolvedBody = yield* resolveOptionalTextInput({
          command,
          value: Option.getOrNull(body),
          fileValue: Option.getOrNull(bodyFile),
          valueFlag: "--body",
          fileFlag: "--body-file",
          label: "body",
        });

        const description = Option.getOrNull(desc);
        const addPath = Option.getOrNull(add);
        const removeName = Option.getOrNull(remove);
        const name = Option.getOrNull(filename);

        const validation = validateEditInput({
          body: resolvedBody,
          filename: name,
          description,
          add: addPath,
          remove: removeName,
        });

        if (validation !== null) {
          return yield* Effect.fail(validation);
        }

        if (addPath !== null) {
          const pathValidation = validateFilePath(addPath, command);
          if (pathValidation !== null) {
            return yield* Effect.fail(pathValidation);
          }
        }

        const sourcePath =
          resolvedBody === null || name === null
            ? null
            : yield* stageBody({ body: resolvedBody, filename: name, command });

        const edited = yield* editGist({
          id: id.split("/").at(-1) ?? id,
          description,
          add: addPath,
          remove: removeName,
          filename: name,
          sourcePath,
        });

        yield* logFormatted(edited, format);
      }),
    ),
).pipe(Command.withDescription("Edit a gist (never opens an editor — content flags required)"));

export const gistDeleteCommand = Command.make(
  "delete",
  {
    confirm: Flag.boolean("confirm").pipe(
      Flag.withDescription("Actually delete the gist (without this flag, only shows dry-run)"),
      Flag.withDefault(false),
    ),
    format: formatOption,
    id: Flag.string("id").pipe(Flag.withDescription("Gist id or URL")),
  },
  ({ confirm, format, id }) =>
    Effect.gen(function* () {
      const result = yield* deleteGist({ id: id.split("/").at(-1) ?? id, confirm });

      yield* logFormatted(result, format);
    }),
).pipe(Command.withDescription("Delete a gist (dry-run by default, use --confirm to execute)"));
