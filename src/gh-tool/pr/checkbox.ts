import { Effect } from "effect";

import { GitHubCommandError } from "#gh/errors";
import {
  bunMarkdownOutline,
  findCheckboxLines,
  validateCheckboxEdit,
  type CheckboxOutlineParser,
} from "#gh/pr/checkbox-markdown";
import { repoSlug } from "#gh/read/keys";
import { reads, resolveRepo } from "#gh/read/reads";
import { writes } from "#gh/read/writes";
import { validateOutboundText } from "#gh/text-input";

type CheckboxState = "checked" | "unchecked";

const readPRBody = Effect.fn("pr.checkbox.readPRBody")(function* (pr: number) {
  const repo = yield* resolveRepo(null);
  const body = yield* reads.prBody(repo, pr);
  return { repo, body };
});

const checkboxMatchError = (pr: number, count: number) =>
  new GitHubCommandError({
    command: "gh-tool pr checkbox",
    exitCode: 1,
    stderr: `Found ${count} matching task items in PR #${pr}`,
    message: `Expected one matching task item in PR #${pr}, found ${count}`,
    hint: "Use --section to narrow the search or pass a longer --match.",
  });

export const togglePRCheckbox = Effect.fn("pr.togglePRCheckbox")(function* (
  opts: {
    pr: number;
    match: string;
    section: string | null;
    state: CheckboxState;
  },
  parseOutline: CheckboxOutlineParser = bunMarkdownOutline,
) {
  yield* validateOutboundText(opts.match, "gh-tool pr checkbox");
  if (opts.section !== null) {
    yield* validateOutboundText(opts.section, "gh-tool pr checkbox");
  }

  if (opts.pr <= 0 || opts.match.length === 0 || opts.section === "") {
    return yield* new GitHubCommandError({
      command: "gh-tool pr checkbox",
      exitCode: 1,
      stderr: "--pr must be positive, --match must be non-empty, and --section must be non-empty",
      message: "Invalid PR checkbox selection",
    });
  }

  const first = yield* readPRBody(opts.pr);
  const matches = yield* Effect.try({
    try: () => findCheckboxLines(first.body, opts.match, opts.section, parseOutline),
    catch: (cause) =>
      new GitHubCommandError({
        command: "gh-tool pr checkbox",
        exitCode: 1,
        stderr: String(cause),
        message: "Cannot locate PR checkbox safely",
        hint: "PR body structure is ambiguous; tick this item in the GitHub UI.",
      }),
  });
  if (matches.length !== 1) return yield* checkboxMatchError(opts.pr, matches.length);

  const selected = matches[0];
  if (selected === undefined) return yield* checkboxMatchError(opts.pr, 0);

  const alreadyRequested = opts.state === "checked" ? selected.checked : !selected.checked;
  if (alreadyRequested) {
    return {
      pr: opts.pr,
      state: "unchanged" as const,
      before: selected.before,
      after: selected.before,
    };
  }

  const box = opts.state === "checked" ? "x" : " ";
  yield* Effect.try({
    try: () => validateCheckboxEdit(first.body, selected.offset, box, parseOutline),
    catch: (cause) =>
      new GitHubCommandError({
        command: "gh-tool pr checkbox",
        exitCode: 1,
        stderr: String(cause),
        message: "Cannot locate PR checkbox safely",
        hint: "PR body structure is ambiguous; tick this item in the GitHub UI.",
      }),
  });
  const after = `${selected.before.slice(0, selected.boxIndex)}${box}${selected.before.slice(selected.boxIndex + 1)}`;
  yield* writes.prCheckbox(
    {
      repo: first.repo,
      pr: opts.pr,
      expectedBody: first.body,
      boxOffset: selected.offset,
      replacement: box,
      selectionText: [opts.match, ...(opts.section === null ? [] : [opts.section])],
    },
    [`pr:${repoSlug(first.repo)}#${opts.pr}`, `pulls:${repoSlug(first.repo)}`],
  );

  return {
    pr: opts.pr,
    state: "updated" as const,
    before: selected.before,
    after,
  };
});
