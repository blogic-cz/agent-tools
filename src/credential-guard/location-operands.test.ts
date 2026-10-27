/* eslint-disable eslint/no-template-curly-in-string -- Shell parameter syntax is literal test input. */
import { expect, it } from "vitest";
import { createCredentialGuard } from "./index";

const guard = createCredentialGuard();
const check = (command: string): void =>
  guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } });

it.each([
  "tmutil isexcluded ~/op",
  "tmutil addexclusion ~/op/worktrees",
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
  "unknown-cli op read x",
  "unknown-cli /usr/local/bin/op read op://a/b",
  "unknown-cli ~/bin/op --account a item get x",
  "unknown-cli -e ~/op read x",
  "unknown-cli op",
  "op item get x",
  "op read op://a/b",
  "launchctl asuser 501 /usr/bin/printenv",
  "launchctl asuser 501 /usr/bin/security dump-keychain",
  "tmutil unknown-subcommand ~/op",
  "tmutil unknown-subcommand public",
  "tmutil restore public ~/op",
  "tmutil startbackup",
  "tmutil",
  "tmutil isexcluded ~/.ssh/id_rsa",
  "tmutil addexclusion -p .env",
  "tmutil compare .env public",
  "mdfind -onlyin ~/.ssh op",
  'mdfind -onlyin "$UNKNOWN" x',
  "mdfind -onlyin",
  'tmutil isexcluded "$UNKNOWN"',
])("preserves source and unresolved-path refusals: %s", (command) => {
  expect(() => check(command)).toThrow();
});
