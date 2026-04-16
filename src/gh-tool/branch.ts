import { Command, Flag } from "effect/unstable/cli";
import { Effect, Option } from "effect";

import { formatOption, logFormatted } from "#shared";
import type { BranchRenameResult } from "./types";
import { GitHubService } from "./service";

// ---------------------------------------------------------------------------
// Internal handlers
// ---------------------------------------------------------------------------

export const renameBranch = Effect.fn("branch.renameBranch")(function* (opts: {
  oldName: string;
  newName: string;
  confirm: boolean;
  repo: string | null;
}) {
  const gh = yield* GitHubService;

  if (!opts.confirm) {
    const scope = opts.repo !== null ? ` in ${opts.repo}` : "";

    const dryRun: BranchRenameResult = {
      renamed: false,
      oldName: opts.oldName,
      newName: opts.newName,
      dryRun: true,
      message: `Dry run: would rename branch '${opts.oldName}' to '${opts.newName}'${scope}. Re-run with --confirm to execute.`,
    };

    return dryRun;
  }

  const repoInfo =
    opts.repo !== null
      ? opts.repo
      : yield* gh.getRepoInfo().pipe(Effect.map((r) => `${r.owner}/${r.name}`));

  const args = [
    "api",
    `repos/${repoInfo}/branches/${encodeURIComponent(opts.oldName)}/rename`,
    "-X",
    "POST",
    "-f",
    `new_name=${opts.newName}`,
  ];

  yield* gh.runGh(args);

  const result: BranchRenameResult = {
    renamed: true,
    oldName: opts.oldName,
    newName: opts.newName,
  };

  return result;
});

// ---------------------------------------------------------------------------
// CLI Commands
// ---------------------------------------------------------------------------

export const branchRenameCommand = Command.make(
  "rename",
  {
    confirm: Flag.boolean("confirm").pipe(
      Flag.withDescription("Actually rename (without this flag, only shows dry-run)"),
      Flag.withDefault(false),
    ),
    format: formatOption,
    newName: Flag.string("new-name").pipe(Flag.withDescription("New branch name")),
    oldName: Flag.string("old-name").pipe(Flag.withDescription("Current branch name to rename")),
    repo: Flag.string("repo").pipe(
      Flag.withDescription("Target repository (owner/name). Defaults to current repo"),
      Flag.optional,
    ),
  },
  ({ confirm, format, newName, oldName, repo }) =>
    Effect.gen(function* () {
      const result = yield* renameBranch({
        oldName,
        newName,
        confirm,
        repo: Option.getOrNull(repo),
      });

      yield* logFormatted(result, format);
    }),
).pipe(
  Command.withDescription("Rename a GitHub branch (dry-run by default, use --confirm to execute)"),
);
