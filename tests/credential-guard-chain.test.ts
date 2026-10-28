import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as nativeJoin } from "node:path";
const join = (...parts: string[]) => nativeJoin(...parts).replace(/\\/g, "/");
import type { CredentialGuardConfig } from "#config/types";
import { createCredentialGuard } from "#guard";

const launch = [
  'herdr pane run w1:p1 "exec bash ~/.codex/codex-clean.sh bash --norc -i"',
  "herdr pane wait-output w1:p1 --regex '[$] *$' --timeout 10000",
  "herdr agent start n --kind codex --pane w1:p1 -- --model gpt-6.1-sol",
  'herdr agent prompt n "Read /tmp/steer.md"',
];
const steer = ["cp /tmp/steer.md /tmp/inbox/", 'herdr agent prompt n "Read the steer"'];
const python = [
  "printf '%s' 'hello' > /tmp/prompt.md",
  `python3 -c "import subprocess; subprocess.run(['herdr','agent','prompt','n','hello'])"`,
];

let root: string;
let inbox: string;
let copyConfig: CredentialGuardConfig;

beforeAll(async () => {
  root = (await realpath(await mkdtemp(join(tmpdir(), "guard-chain-")))).replace(/\\/g, "/");
  inbox = join(root, "inbox");
  await mkdir(inbox);
  await mkdir(join(root, "outside"));
  await mkdir(join(root, ".codex"));
  await mkdir(join(root, ".claude", "commands"), { recursive: true });
  await writeFile(join(inbox, "existing.md"), "existing prose");
  await writeFile(join(root, "outside", "file.md"), "outside prose");
  await symlink(join(root, "outside"), join(inbox, "link"));
  await symlink(join(root, "outside", "file.md"), join(inbox, "file-link.md"));
  await symlink(inbox, join(root, "root-link"));
  copyConfig = { chainCopyDestinations: [inbox] };
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function check(command: string, config?: CredentialGuardConfig): void {
  command = command.replaceAll("/tmp/inbox", inbox);
  createCredentialGuard(config).handleToolExecuteBefore({ tool: "Bash" }, { args: { command } });
}

describe("credential guard composition and copy permission", () => {
  it.each([
    "cp /tmp/evil.md ~/.claude/CLAUDE.md",
    "cp /tmp/evil.md ~/.codex/AGENTS.md",
    "cp /tmp/evil.md ~/.codex/AGENTS.md && cat /tmp/x.md",
    "cp /tmp/evil.md ~/.codex/AGENTS.md && herdr agent start n --kind codex --pane w1:p2",
  ])("names the agent write rule for %s", (command) => {
    expect(() => check(command)).toThrow("agent-config-write");
  });
  it("names the native launch rule", () => {
    expect(() =>
      check(
        "herdr agent start n --kind codex --pane w1:p2 -- -c shell_environment_policy.inherit=all",
      ),
    ).toThrow("agent-launch-override");
  });
  it.each([
    ["herdr pane run w1:p2 printenv", "no-analyzer"],
    ["herdr pane send-keys w1:p2 printenv", "no-analyzer"],
    ["herdr agent start --kind codex n --command printenv", "secret-source"],
  ])("keeps the refusal rule for %s", (command, rule) => {
    expect(() => check(command)).toThrow(rule);
  });
  it("requires proof for standalone agent copies and refuses other writers despite a grant", () => {
    const destination = join(root, ".codex", "AGENTS.md");
    const config = { chainCopyDestinations: [join(root, ".codex")] };
    expect(() => check(`cp /tmp/evil.md ${destination}`, config)).not.toThrow();
    for (const command of [
      `tee ${destination}`,
      `mv /tmp/evil.md ${destination}`,
      `install /tmp/evil.md ${destination}`,
      `ln -s /tmp/evil.md ${destination}`,
      `echo x > ${destination}`,
      `sed -i 's/x/y/' ${destination}`,
    ])
      expect(() => check(command, config)).toThrow("agent-config-write");
  });
  it.each([" && ", "; "])("accepts independently safe parts joined with %s", (separator) => {
    for (const parts of [launch.slice(1), steer]) {
      for (const part of parts) expect(() => check(part)).not.toThrow();
      expect(() => check(parts.join(separator), copyConfig)).not.toThrow();
    }
  });
  it("refuses execution in an unknown terminal", () => {
    expect(() => check(launch[0] ?? "")).toThrow("Herdr execution in unknown terminal");
    expect(() => check(launch.join(" && "))).toThrow("Herdr execution in unknown terminal");
  });
  it("refuses inline runtime code in a chain", () => {
    expect(() => check(python[0] ?? "")).not.toThrow();
    expect(() => check(python[1] ?? "")).toThrow("no-analyzer");
    expect(() => check(python.join(" && "))).toThrow("no-analyzer");
  });
  it.each([
    'export GH_TOKEN=placeholder && herdr agent prompt n "x"',
    'VAR=value && herdr agent prompt n "x"',
    'tee /tmp/steer.md && herdr agent prompt n "x"',
    'mv /tmp/steer.md /tmp/inbox/ && herdr agent prompt n "x"',
    'cp /tmp/steer.md /tmp/inbox/ && cat /tmp/inbox/steer.md && herdr agent prompt n "x"',
    'cp /tmp/steer.md /tmp/inbox/ && herdr agent start n --kind codex --pane w1:p1 && herdr agent prompt n "x"',
    'cp /tmp/steer.md /tmp/inbox/ && herdr agent prompt n "x" --file /tmp/inbox/steer.md',
    'cp /tmp/steer.md /tmp/inbox/ || herdr agent prompt n "x"',
    'cp /tmp/steer.md /tmp/inbox/ & herdr agent prompt n "x"',
    'rtk proxy cp /tmp/a.md /tmp/inbox/ && herdr agent prompt n "x"',
    'cp /tmp/steer.md /tmp/inbox/ 2>&1 && herdr agent prompt n "x"',
    'herdr agent start n --kind codex --kind claude --pane w1:p1 && herdr agent prompt n "x"',
    'herdr agent start n --kind codex --kind=claude --pane w1:p1 && herdr agent prompt n "x"',
    'herdr pane wait-output w1:p1 --match x --timeout 10 --timeout 20 && herdr agent prompt n "x"',
    'herdr pane wait-output w1:p1 --match x --match y && herdr agent prompt n "x"',
    'herdr pane wait-output w1:p1 --regex x --regex y && herdr agent prompt n "x"',
  ])("accepts Gate 2/3 data composition: %s", (command) => {
    expect(() => check(command, copyConfig)).not.toThrow();
  });
  it.each([
    "cd /tmp/secrets && cat config.json",
    "printf 'cat ~/.ssh/id_rsa' > x.sh && bash x.sh",
    "cp ~/.ssh/id_rsa ./a && cat ./a",
    'source ./env && herdr agent prompt n "x"',
    'pushd /tmp && herdr agent prompt n "x"',
    'unset PATH && herdr agent prompt n "x"',
    '. ./env && herdr agent prompt n "x"',
    'alias herdr=cat && herdr agent prompt n "x"',
    'set -- x && herdr agent prompt n "x"',
    'eval "true" && herdr agent prompt n "x"',
    'cp /tmp/steer.md /tmp/inbox/ && herdr pane run w1:p1 "bash /tmp/inbox/steer.md" && herdr agent prompt n "x"',
    'cp /tmp/payload /usr/local/bin/herdr && herdr agent prompt n "x"',
    'herdr pane run w1:p1 "cp /tmp/payload /tmp/script" && herdr agent prompt n "x"',
    'cp /tmp/*.md /tmp/inbox/ && herdr agent prompt n "x"',
  ])("retains source, code and destination refusals: %s", (command) => {
    expect(() => check(command, copyConfig)).toThrow();
  });
  it.each([
    launch.slice(1).join(" && "),
    'rtk proxy herdr agent start n --kind codex --pane w1:p1 && rtk proxy herdr agent prompt n "x"',
  ])("accepts the launch chain %s", (command) => {
    expect(() => check(command)).not.toThrow();
  });
  it("retains configured file and CLI policy for each part", () => {
    for (const config of [
      { additionalBlockedPaths: ["inbox"] },
      { additionalBlockedCliTools: [{ tool: "cp", suggestion: "use a bounded copy" }] },
    ])
      expect(() => check(steer.join(" && "), { ...copyConfig, ...config })).toThrow();
  });
  it("requires explicit permission for a copy-to-Herdr chain", () => {
    expect(() => check(steer.join(" && "))).toThrow("copy-destination");
    expect(() => check(steer.join(" && "), copyConfig)).not.toThrow();
    expect(() => check(steer.join(" && "), { chainCopyDestinations: [] })).toThrow(
      "copy-destination",
    );
  });
  it("requires permission for agent startup file copies", () => {
    for (const [target, directory] of [
      [join(root, ".codex", "AGENTS.md"), join(root, ".codex")],
      [join(root, ".claude", "commands", "run.md"), join(root, ".claude", "commands")],
    ]) {
      const command = `cp /tmp/evil.md ${target} && herdr agent prompt n ready`;
      expect(() => check(command)).toThrow("copy-destination");
      expect(() => check(command, { chainCopyDestinations: [directory ?? ""] })).not.toThrow();
    }
  });
  it.each([
    "/tmp/inbox/link/new.md",
    "/tmp/inbox/file-link.md",
    "/tmp/inbox/../outside/new.md",
    "/tmp/inbox/new-directory/new.md",
    "/tmp/inbox-sibling/new.md",
    "~/inbox/new.md",
    '"$HOME/inbox/new.md"',
    "/tmp/inbox/*.md",
  ])("refuses unresolved or non-literal destinations: %s", (target) => {
    expect(() =>
      check(`cp /tmp/steer.md ${target} && herdr agent prompt n "x"`, copyConfig),
    ).toThrow();
  });
  it("refuses missing or symlinked configured directories", () => {
    for (const directory of [join(root, "missing"), join(root, "root-link")]) {
      expect(() =>
        check(`cp /tmp/steer.md ${directory}/new.md && herdr agent prompt n "x"`, {
          chainCopyDestinations: [directory],
        }),
      ).toThrow();
    }
  });
  it("uses destination permission rather than a prose suffix", () => {
    expect(() =>
      check('cp /tmp/payload /tmp/inbox/script.sh && herdr agent prompt n "x"', copyConfig),
    ).not.toThrow();
  });
  it("allows an existing nonsymlink file inside an approved directory", () => {
    expect(() =>
      check('cp /tmp/steer.md /tmp/inbox/existing.md && herdr agent prompt n "x"', copyConfig),
    ).not.toThrow();
  });
  it("checks each part against configured policy", () => {
    const guard = createCredentialGuard({ additionalDangerousBashPatterns: ["pane run"] });
    expect(() =>
      guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command: launch.join(" && ") } }),
    ).toThrow("pane run");
  });
});
