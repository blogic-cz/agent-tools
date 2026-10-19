import { describe, expect, it } from "vitest";
import { createCredentialGuard } from "#guard";

const launch = [
  'herdr pane run w7:p9 "exec bash ~/.codex/codex-clean.sh bash --norc -i"',
  "herdr pane wait-output w7:p9 --regex '[$] *$' --timeout 10000",
  "herdr agent start n --kind codex --pane w7:p9 -- --model gpt-6.1-sol",
  'herdr agent prompt n "Read /tmp/steer.md"',
];
const steer = ["cp /tmp/steer.md /tmp/inbox/", 'herdr agent prompt n "Read the steer"'];
const python = [
  "printf '%s' 'hello' > /tmp/prompt.md",
  `python3 -c "import subprocess; subprocess.run(['herdr','agent','prompt','n','hello'])"`,
];

function check(command: string): void {
  createCredentialGuard().handleToolExecuteBefore({ tool: "Bash" }, { args: { command } });
}

describe("independent credential guard chain composition", () => {
  it.each([" && ", "; "])(
    "accepts dispatch and steer parts alone and joined with %s",
    (separator) => {
      for (const parts of [launch, steer]) {
        for (const part of parts) expect(() => check(part)).not.toThrow();
        expect(() => check(parts.join(separator))).not.toThrow();
      }
    },
  );
  it("keeps unproved Python subprocess execution blocked alone and in a chain", () => {
    expect(() => check(python[0] ?? "")).not.toThrow();
    expect(() => check(python[1] ?? "")).toThrow();
    expect(() => check(python.join(" && "))).toThrow();
  });
  it.each([
    "cd /tmp/secrets && cat config.json",
    "printf 'cat ~/.ssh/id_rsa' > x.sh && bash x.sh",
    'export GH_TOKEN=placeholder && herdr agent prompt n "x"',
    "cp ~/.ssh/id_rsa ./a && cat ./a",
    'source ./env && herdr agent prompt n "x"',
    'pushd /tmp && herdr agent prompt n "x"',
    'unset PATH && herdr agent prompt n "x"',
    'VAR=value && herdr agent prompt n "x"',
    '. ./env && herdr agent prompt n "x"',
    'alias herdr=cat && herdr agent prompt n "x"',
    'set -- x && herdr agent prompt n "x"',
    'eval "true" && herdr agent prompt n "x"',
    'cp /tmp/steer.md /tmp/inbox/ && cat /tmp/inbox/steer.md && herdr agent prompt n "x"',
    'cp /tmp/steer.md /tmp/inbox/ && herdr pane run w7:p9 "bash /tmp/inbox/steer.md" && herdr agent prompt n "x"',
    'tee /tmp/steer.md && herdr agent prompt n "x"',
    'mv /tmp/steer.md /tmp/inbox/ && herdr agent prompt n "x"',
  ])("keeps unproved state or file interactions blocked: %s", (command) => {
    expect(() => check(command)).toThrow();
  });
  it("checks each part against configured policy", () => {
    const guard = createCredentialGuard({ additionalDangerousBashPatterns: ["pane run"] });
    expect(() =>
      guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command: launch.join(" && ") } }),
    ).toThrow("pane run");
  });
  it("names the part whose composition cannot be proved", () => {
    expect(() =>
      check('cp /tmp/steer.md /tmp/inbox/ && cat /tmp/inbox/steer.md && herdr agent prompt n "x"'),
    ).toThrow("part 2");
    expect(() =>
      check('cp /tmp/steer.md /tmp/inbox/ && cat /tmp/inbox/steer.md && herdr agent prompt n "x"'),
    ).toThrow("cat /tmp/inbox/steer.md");
  });
});
