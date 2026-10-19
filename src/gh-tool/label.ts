import { Command, Flag } from "effect/cli";
import { Effect, Option } from "effect";

import { formatOption, logFormatted } from "#shared";
import { GitHubService } from "#gh/read/transport";
import { resolveRepo } from "#gh/read/reads";
import { repoSlug } from "#gh/read/keys";
import { writes } from "#gh/read/writes";

export const createLabel = Effect.fn("label.createLabel")(function* (opts: {
  name: string;
  color: string;
  description: string;
  force: boolean;
}) {
  const repo = yield* resolveRepo(null);
  const args = [
    "label",
    "create",
    opts.name,
    "--color",
    opts.color,
    "--description",
    opts.description,
  ];
  if (opts.force) args.push("--force");
  yield* writes.run(args, [`repo:${repoSlug(repo)}`]);
  return { name: opts.name };
});

export const labelCreateCommand = Command.make(
  "create",
  {
    name: Flag.String("name").pipe(Flag.withDescription("Label name")),
    color: Flag.String("color").pipe(Flag.withDescription("Six-character hexadecimal color")),
    description: Flag.String("description").pipe(Flag.withDefault("")),
    force: Flag.Boolean("force").pipe(
      Flag.withDescription("Update the label if it already exists"),
      Flag.withDefault(false),
    ),
    repo: Flag.String("repo").pipe(
      Flag.withDescription("Target repository profile name or owner/name"),
      Flag.optional,
    ),
    format: formatOption,
  },
  ({ format, repo, ...opts }) =>
    Effect.gen(function* () {
      const gh = yield* GitHubService;
      yield* gh.withRepoTarget(
        Option.getOrNull(repo),
        Effect.gen(function* () {
          yield* logFormatted(yield* createLabel(opts), format);
        }),
      );
    }),
).pipe(Command.withDescription("Create a repository label"));
