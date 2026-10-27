/* eslint-disable eslint/no-template-curly-in-string -- Shell parameter syntax is literal test input. */
import { expect, it } from "vitest";
import { createCredentialGuard } from "./index";

const guard = createCredentialGuard();
const check = (command: string): void =>
  guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } });

it.each([
  "tmutil isexcluded ~/op",
  "tmutil addexclusion ~/op/worktrees",
  "tmutil",
  "tmutil version",
  "tmutil help",
  "tmutil listbackups",
  "tmutil latestbackup",
  "tmutil destinationinfo",
  "tmutil status",
  "tmutil currentphase",
  "tmutil startbackup",
  "tmutil unknown-subcommand public",
  "sudo tmutil listbackups",
  "tmutil listbackups | head",
  'mdfind -onlyin "$HOME/o""p" -count x',
  'for p in ~/projects ~/op; do tmutil isexcluded "$p"; done',
])("accepts declared location operands: %s", (command) => {
  expect(() => check(command)).not.toThrow();
});

it("keeps secret-source basenames as locations in declared path roles", () => {
  for (const name of ["op", "bw", "pass", "security", "printenv"]) {
    for (const command of [
      `tmutil isexcluded ~/projects/${name}`,
      `tmutil addexclusion -p ~/projects/${name}`,
      `tmutil removeexclusion -v ~/projects/${name}`,
      `tmutil compare -D 2 -I op ~/projects/${name} ~/other/${name}`,
      `tmutil uniquesize ~/projects/${name}`,
      `tmutil calculatedrift ~/projects/${name}`,
      `mdfind -onlyin ~/projects/${name} -count x`,
    ]) {
      expect(() => check(command)).not.toThrow();
    }
  }
});

it.each([
  "mdfind -onlyin ~/op -count x",
  "mdfind op",
  "mdfind -name .env -attr password -0 -live -literal -interpret op",
])("keeps Spotlight query and attribute text as data: %s", (command) => {
  expect(() => check(command)).not.toThrow();
});

it.each([
  ["unknown-cli op read x", "secret-source"],
  ["unknown-cli /usr/local/bin/op read op://a/b", "secret-source"],
  ["unknown-cli ~/bin/op --account a item get x", "secret-source"],
  ["unknown-cli -e ~/op read x", "secret-source"],
  ["unknown-cli op", "secret-source"],
  ["op item get x", "secret-source"],
  ["op read op://a/b", "secret-source"],
  ["launchctl asuser 501 /usr/bin/printenv", "secret-source"],
  ["launchctl asuser 501 /usr/bin/security dump-keychain", "secret-source"],
  ["tmutil unknown-subcommand ~/op", "secret-source"],
  ["tmutil restore ~/.ssh/id_rsa /tmp/x", "sensitive-path"],
  ["tmutil isexcluded ~/.ssh/id_rsa", "sensitive-path"],
  ["tmutil addexclusion -p .env", "sensitive-path"],
  ["tmutil compare .env public", "sensitive-path"],
  ["tmutil isexcluded $(op read op://a/b)", "secret-source"],
  ['tmutil isexcluded "$UNKNOWN"', "opaque-path"],
  ["mdfind -onlyin ~/.ssh op", "sensitive-path"],
  ['mdfind -onlyin "$UNKNOWN" x', "opaque-path"],
  ["mdfind -onlyin", "opaque-path"],
  ["mdfind -onlyin ~/.ssh x", "sensitive-path"],
  ['mdfind "$(cat ~/.ssh/id_rsa)"', "sensitive-path"],
] as const)("refuses with the expected rule for %s", (command, rule) => {
  expect(() => check(command)).toThrow(rule);
});
