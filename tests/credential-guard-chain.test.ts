import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialGuardConfig } from "#config/types";
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

let root: string;
let inbox: string;
let copyConfig: CredentialGuardConfig;

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "guard-chain-")));
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

describe("independent credential guard chain composition", () => {
  it.each([" && ", "; "])(
    "accepts dispatch and steer parts alone and joined with %s",
    (separator) => {
      for (const parts of [launch, steer]) {
        for (const part of parts) expect(() => check(part)).not.toThrow();
        expect(() => check(parts.join(separator), copyConfig)).not.toThrow();
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
    expect(() => check(command, copyConfig)).toThrow();
  });
  it.each([
    launch.join(" && "),
    'rtk proxy herdr agent start n --kind codex --pane w7:p9 && rtk proxy herdr agent prompt n "x"',
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
    'cp /tmp/payload /usr/local/bin/herdr && herdr agent prompt n "x"',
    'cp /tmp/steer.md /tmp/inbox/ && herdr agent start n --kind codex --pane w7:p9 && herdr agent prompt n "x"',
    'herdr pane run w7:p9 "cp /tmp/payload /tmp/script" && herdr agent prompt n "x"',
    'cp /tmp/steer.md /tmp/inbox/ && herdr agent prompt n "x" --file /tmp/inbox/steer.md',
    'cp /tmp/steer.md /tmp/inbox/ || herdr agent prompt n "x"',
    'cp /tmp/steer.md /tmp/inbox/ & herdr agent prompt n "x"',
  ])("refuses unsupported roles and operators: %s", (command) => {
    expect(() => check(command, copyConfig)).toThrow();
  });
  it("does not infer safety from independently accepted file arguments", () => {
    expect(() => check("cat config.json")).not.toThrow();
    expect(() => check("cp /tmp/steer.md /tmp/inbox/")).not.toThrow();
    expect(() => check("cat /tmp/inbox/steer.md")).not.toThrow();
    expect(() =>
      check(
        'cp /tmp/steer.md /tmp/inbox/ && cat /tmp/inbox/steer.md && herdr agent prompt n "x"',
        copyConfig,
      ),
    ).toThrow("chain part 2");
  });
  it("retains configured file and CLI policy for each part", () => {
    for (const config of [
      { additionalBlockedPaths: ["inbox"] },
      { additionalBlockedCliTools: [{ tool: "cp", suggestion: "use a bounded copy" }] },
    ]) {
      const guard = createCredentialGuard({ ...copyConfig, ...config });
      expect(() =>
        guard.handleToolExecuteBefore(
          { tool: "Bash" },
          { args: { command: steer.join(" && ").replaceAll("/tmp/inbox", inbox) } },
        ),
      ).toThrow();
    }
  });
  it.each([
    'herdr agent start n --kind codex --kind claude --pane w7:p9 && herdr agent prompt n "x"',
    'herdr agent start n --kind codex --kind=claude --pane w7:p9 && herdr agent prompt n "x"',
    'herdr pane wait-output w7:p9 --match x --timeout 10 --timeout 20 && herdr agent prompt n "x"',
    'herdr pane wait-output w7:p9 --match x --match y && herdr agent prompt n "x"',
    'herdr pane wait-output w7:p9 --regex x --regex y && herdr agent prompt n "x"',
  ])("refuses repeated proof options: %s", (command) => {
    expect(() => check(command)).toThrow("chain part 1");
  });
  it.each([
    'rtk cp /tmp/a.md /tmp/inbox/ && herdr agent prompt n "x"',
    'VAR=value && herdr agent prompt n "x"',
    'cp /tmp/steer.md /tmp/inbox/ 2>&1 && herdr agent prompt n "x"',
    'cp /tmp/*.md /tmp/inbox/ && herdr agent prompt n "x"',
  ])("names an unproved non-literal part: %s", (command) => {
    expect(() => check(command, copyConfig)).toThrow("chain part 1");
    expect(() => check(command, copyConfig)).toThrow(
      command.split(" && ")[0]?.split(" /tmp/inbox")[0] ?? "",
    );
  });
  it("uses no copy permission by default", () => {
    expect(() => check(steer.join(" && "))).toThrow("chain part 1");
    expect(() => check(steer.join(" && "), copyConfig)).not.toThrow();
  });
  it("requires opt-in for all three review startup-file probes", () => {
    const probes = [
      {
        command: `cp /tmp/evil.md ${root}/.codex/AGENTS.md && herdr agent prompt n "x"`,
        directory: join(root, ".codex"),
      },
      {
        command: `cp /tmp/evil.md ${root}/.claude/commands/run.md && herdr agent prompt n "x"`,
        directory: join(root, ".claude", "commands"),
      },
      {
        command: `${launch[0]} && cp /tmp/a.md ${root}/.codex/AGENTS.md && herdr agent prompt n "x"`,
        directory: join(root, ".codex"),
      },
    ];
    for (const { command, directory } of probes) {
      expect(() => check(command)).toThrow();
      expect(() => check(command, { chainCopyDestinations: [directory] })).not.toThrow();
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
  it("names the part whose composition cannot be proved", () => {
    expect(() =>
      check(
        'cp /tmp/steer.md /tmp/inbox/ && cat /tmp/inbox/steer.md && herdr agent prompt n "x"',
        copyConfig,
      ),
    ).toThrow("part 2");
    expect(() =>
      check(
        'cp /tmp/steer.md /tmp/inbox/ && cat /tmp/inbox/steer.md && herdr agent prompt n "x"',
        copyConfig,
      ),
    ).toThrow(`cat ${inbox}/steer.md`);
  });
});
