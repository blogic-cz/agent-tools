import { Effect } from "effect";

import { GitHubCommandError } from "#gh/errors";
import { repoSlug } from "#gh/read/keys";
import { reads, resolveRepo } from "#gh/read/reads";
import { writes } from "#gh/read/writes";
import { validateOutboundText } from "#gh/text-input";

type CheckboxState = "checked" | "unchecked";

type CheckboxLine = {
  readonly before: string;
  readonly offset: number;
  readonly boxIndex: number;
  readonly checked: boolean;
};

const checkboxPattern = /^([ \t]*[-*+][ \t]+\[)([ xX])\][^\r\n]*\r?$/;
const headingPattern = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*\r?$/;

const bodyLines = (body: string) => {
  const lines: Array<{ text: string; offset: number }> = [];
  let offset = 0;
  for (const part of body.match(/[^\n]*(?:\n|$)/g) ?? []) {
    if (part.length === 0) continue;
    const text = part.endsWith("\n") ? part.slice(0, -1) : part;
    lines.push({ text, offset });
    offset += part.length;
  }
  return lines;
};

const findCheckboxLines = (body: string, match: string, section: string | null) => {
  const matches: CheckboxLine[] = [];
  let sectionLevel: number | null = null;
  let inSection = section === null;

  for (const { text, offset } of bodyLines(body)) {
    const heading = headingPattern.exec(text);
    if (heading !== null) {
      const level = heading[1]?.length ?? 0;
      const headingText = heading[2]?.trim() ?? "";
      if (sectionLevel !== null && level <= sectionLevel) {
        inSection = false;
        sectionLevel = null;
      }
      if (section !== null && headingText === section) {
        inSection = true;
        sectionLevel = level;
      }
      continue;
    }

    if (!inSection || !text.includes(match)) continue;
    const checkbox = checkboxPattern.exec(text);
    if (checkbox === null) continue;
    const prefix = checkbox[1] ?? "";
    const box = checkbox[2] ?? "";
    matches.push({
      before: text.endsWith("\r") ? text.slice(0, -1) : text,
      offset: offset + prefix.length,
      boxIndex: prefix.length,
      checked: box !== " ",
    });
  }
  return matches;
};

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

export const togglePRCheckbox = Effect.fn("pr.togglePRCheckbox")(function* (opts: {
  pr: number;
  match: string;
  section: string | null;
  state: CheckboxState;
}) {
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
  const matches = findCheckboxLines(first.body, opts.match, opts.section);
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

  const second = yield* readPRBody(opts.pr);
  if (second.body !== first.body) {
    return yield* new GitHubCommandError({
      command: "gh-tool pr checkbox",
      exitCode: 1,
      stderr: `PR #${opts.pr} body changed before the checkbox update`,
      message: `Refusing to update PR #${opts.pr}: its body changed after the first read`,
      hint: "Re-read the pull request and retry with the current task text.",
    });
  }

  const box = opts.state === "checked" ? "x" : " ";
  const updatedBody = `${first.body.slice(0, selected.offset)}${box}${first.body.slice(selected.offset + 1)}`;
  const after = `${selected.before.slice(0, selected.boxIndex)}${box}${selected.before.slice(selected.boxIndex + 1)}`;
  yield* writes.run(
    [
      "api",
      "--method",
      "PATCH",
      `repos/${first.repo.owner}/${first.repo.name}/pulls/${opts.pr}`,
      "-f",
      `body=${updatedBody}`,
    ],
    [`pr:${repoSlug(first.repo)}#${opts.pr}`, `pulls:${repoSlug(first.repo)}`],
    {
      body: updatedBody,
      selectionText: [opts.match, ...(opts.section === null ? [] : [opts.section])],
    },
  );

  return {
    pr: opts.pr,
    state: "updated" as const,
    before: selected.before,
    after,
  };
});
