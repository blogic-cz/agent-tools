import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
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
    expect(() => check(python.join(" && "))).toThrow("chain part 2");
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
  it.each([
    'cp /tmp/steer.md /tmp/inbox/ && herdr agent prompt n "x"',
    'rtk proxy cp /tmp/steer.md /tmp/inbox/message.md && rtk proxy herdr agent prompt n "x"',
  ])("runs the real Claude hook for accepted composition: %s", (command) => {
    const result = spawnSync("bun", ["src/credential-guard/claude-hook.ts"], {
      cwd: process.cwd(),
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
  it.each([
    'cp /tmp/steer.md /tmp/inbox/script.sh && herdr agent prompt n "x"',
    'cp /tmp/payload /usr/local/bin/herdr && herdr agent prompt n "x"',
    'cp /tmp/steer.md /tmp/inbox/ && herdr agent start n --kind codex --pane w7:p9 && herdr agent prompt n "x"',
    'herdr pane run w7:p9 "cp /tmp/payload /tmp/script" && herdr agent prompt n "x"',
    'cp /tmp/steer.md /tmp/inbox/ && herdr agent prompt n "x" --file /tmp/inbox/steer.md',
    'cp /tmp/steer.md /tmp/inbox/ || herdr agent prompt n "x"',
    'cp /tmp/steer.md /tmp/inbox/ & herdr agent prompt n "x"',
  ])("refuses unsupported roles and operators: %s", (command) => {
    expect(() => check(command)).toThrow();
  });
  it("does not infer safety from independently accepted file arguments", () => {
    expect(() => check("cat config.json")).not.toThrow();
    expect(() => check("cp /tmp/steer.md /tmp/inbox/")).not.toThrow();
    expect(() => check("cat /tmp/inbox/steer.md")).not.toThrow();
    expect(() =>
      check('cp /tmp/steer.md /tmp/inbox/ && cat /tmp/inbox/steer.md && herdr agent prompt n "x"'),
    ).toThrow("chain part 2");
  });
  it("retains configured file and CLI policy for each part", () => {
    for (const config of [
      { additionalBlockedPaths: ["inbox"] },
      { additionalBlockedCliTools: [{ tool: "cp", suggestion: "use a bounded copy" }] },
    ]) {
      const guard = createCredentialGuard(config);
      expect(() =>
        guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command: steer.join(" && ") } }),
      ).toThrow();
    }
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
