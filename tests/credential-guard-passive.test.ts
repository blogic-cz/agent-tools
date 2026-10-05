import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createCredentialGuard } from "#guard";
// eslint-disable-next-line import/no-relative-parent-imports -- Tests the private grammar without extending the public guard API.
import { isPassiveJqFilter } from "../src/credential-guard/passive-jq";
import corpus from "./fixtures/credential-guard-passive.json";

/** These are tool inputs, never shell commands executed by this suite. */
describe("passive guard anonymous corpus", () => {
  for (const tool of ["Bash", "bash", "mcp_bash"]) {
    it.each(corpus)(`${tool}: $name`, (entry) => {
      const guard = createCredentialGuard("config" in entry ? entry.config : undefined);
      expect(guard.isDangerousBashCommand(entry.command)).toBe(entry.blocked);
      let reason = "";
      try {
        guard.handleToolExecuteBefore({ tool }, { args: { command: entry.command } });
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
      }
      expect(Boolean(reason)).toBe(entry.blocked);
      if ("reason" in entry) expect(reason).toContain(entry.reason);
    });
  }
  it.each(["tool_name", "tool"])("preserves shared hook %s envelope normalization", (key) => {
    for (const entry of corpus) {
      const data =
        key === "tool_name"
          ? { tool_name: "Bash", tool_input: { command: entry.command } }
          : { tool: "bash", input: { command: entry.command } };
      const guard = createCredentialGuard("config" in entry ? entry.config : undefined);
      const invoke = () =>
        guard.handleToolExecuteBefore(
          { tool: "tool_name" in data ? (data.tool_name ?? "") : (data.tool ?? "") },
          { args: "tool_input" in data ? (data.tool_input ?? {}) : (data.input ?? {}) },
        );
      if (entry.blocked) expect(invoke).toThrow();
      else expect(invoke).not.toThrow();
    }
  });
  it.each([
    ["jq '.rows // [] | length' sample.json", 0],
    ["jq 'unknown_filter' sample.json", 2],
    ["python3 -I -S -m py_compile src/main.py", 0],
    ["python3 -m py_compile src/main.py", 2],
    ["for i in 1 2; do jq '.' test-$i.json; done", 0],
    ["jq '.' .en[v]", 2],
  ])("runs the actual Claude adapter with data: %s", (command, status) => {
    const result = spawnSync("bun", ["src/credential-guard/claude-hook.ts"], {
      cwd: process.cwd(),
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
      encoding: "utf8",
    });
    expect(result.status).toBe(status);
    expect(result.stdout).toBe("");
    if (status) expect(result.stderr).toContain("Command blocked");
  });
});

describe("passive jq independent parser limits", () => {
  it("enforces the byte limit", () => {
    expect(isPassiveJqFilter("." + " ".repeat(65_535))).toBe(true);
    expect(isPassiveJqFilter("." + " ".repeat(65_536))).toBe(false);
    expect(isPassiveJqFilter('"' + "é".repeat(32_767) + '"')).toBe(true);
    expect(isPassiveJqFilter('"' + "é".repeat(32_768) + '"')).toBe(false);
  });
  it("enforces the token limit without shallow-chain recursion", () => {
    expect(isPassiveJqFilter(Array(2048).fill(".").join("|"))).toBe(true);
    expect(isPassiveJqFilter(Array(2048).fill(".").join("|") + "?")).toBe(true);
    expect(isPassiveJqFilter(Array(2049).fill(".").join("|"))).toBe(false);
  });
  it("enforces the depth limit", () => {
    expect(isPassiveJqFilter("(".repeat(64) + "." + ")".repeat(64))).toBe(true);
    expect(isPassiveJqFilter("(".repeat(65) + "." + ")".repeat(65))).toBe(false);
  });
  it.each([
    ". |",
    "{a:}",
    "{a",
    "map(.) trailing",
    '"unterminated',
    '"\\(env)"',
    "unknown_filter",
    ".[]? | env",
    ".[env]",
    "map(env)",
    'include "helper"; .',
  ])("refuses incomplete and unsupported syntax: %s", (filter) => {
    expect(isPassiveJqFilter(filter)).toBe(false);
    expect(createCredentialGuard().isDangerousBashCommand(`jq '${filter}' sample.json`)).toBe(true);
  });
});

describe("passive guard proof boundaries", () => {
  it("retains the finite-loop value bound for new numeric selector roles", () => {
    const guard = createCredentialGuard();
    const command = (count: number) =>
      `for p in ${Array.from({ length: count }, (_, index) => index + 1).join(" ")}; do bun run gh-tool pr checks --pr $p; done`;
    expect(guard.isDangerousBashCommand(command(16))).toBe(false);
    expect(guard.isDangerousBashCommand(command(17))).toBe(true);
  });
  it("explains malformed prompt quoting without inventing a file flag", () => {
    const guard = createCredentialGuard();
    expect(() =>
      guard.handleToolExecuteBefore(
        { tool: "Bash" },
        { args: { command: "herdr agent prompt example-agent 'Please don't invent records.'" } },
      ),
    ).toThrow("Check shell quote balance");
    try {
      guard.handleToolExecuteBefore(
        { tool: "Bash" },
        { args: { command: "herdr agent prompt example-agent 'Please don't invent records.'" } },
      );
    } catch (error) {
      expect(String(error)).not.toContain("might expose secrets");
      expect(String(error)).toContain("unterminated quoted argument");
    }
  });
  it("gives a usable cache-free recovery with extra file policy", () => {
    const guard = createCredentialGuard({
      additionalBlockedPaths: ["appsettings\\..*\\.local\\.json$"],
    });
    for (const command of [
      "python3 -I -S -m py_compile src/main.py",
      "python3 -m py_compile src/main.py",
    ]) {
      expect(() => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } })).toThrow(
        "python3 -I -S -B -c 'import ast;",
      );
    }
    expect(
      guard.isDangerousBashCommand(
        'python3 -I -S -B -c \'import ast; ast.parse(open("src/main.py", "rb").read(), filename="src/main.py")\'',
      ),
    ).toBe(false);
  });
  it("keeps custom tee destinations protected", () => {
    const guard = createCredentialGuard({ additionalBlockedPaths: ["protected\\.json$"] });
    for (const command of [
      "tee /private/tmp/protected.json <<'EOF'\nordinary prose\nEOF",
      "python3 - <<'PY'\nprint(\"ordinary\")\nPY\ntee /private/tmp/protected.json <<'EOF'\nCredential-guard prose\nEOF",
    ])
      expect(guard.isDangerousBashCommand(command)).toBe(true);
  });
  it.each([
    "tee --unknown .env <<'EOF'\nordinary prose\nEOF",
    "python3 - <<'PY'\nprint(\"ordinary\")\nPY\nopaque-writer /tmp/example <<'EOF'\nCredential-guard prose\nEOF",
    "python3 - <<'PY'\nprint(\"ordinary\")\nPY\ncat >> /tmp/example <<'EOF'\nCredential-guard prose\nEOF\nopaque-runner",
    "python3 - <<'PY'\nprint(\"ordinary\")\nPY\ncat >> /tmp/example <<EOF\n$UNAPPROVED\nEOF",
  ])("does not acquire the literal writer proof: %s", (command) => {
    expect(createCredentialGuard().isDangerousBashCommand(command)).toBe(true);
  });
  it("bounds composed heredoc counts", () => {
    const program = "python3 - <<'PY'\nprint(\"ordinary\")\nPY\n";
    const writer = "cat >> /private/tmp/example-record.md <<'EOF'\nordinary prose\nEOF\n";
    expect(createCredentialGuard().isDangerousBashCommand(program + writer.repeat(31))).toBe(false);
    expect(createCredentialGuard().isDangerousBashCommand(program + writer.repeat(32))).toBe(true);
  });
  it("bounds syntax compilation file counts", () => {
    const command = "python3 -I -S -m py_compile ";
    const files = Array.from({ length: 33 }, (_, index) => `src/file-${index}.py`);
    expect(
      createCredentialGuard().isDangerousBashCommand(command + files.slice(0, 32).join(" ")),
    ).toBe(false);
    expect(createCredentialGuard().isDangerousBashCommand(command + files.join(" "))).toBe(true);
  });
  it("keeps content scanning on Write and Edit", () => {
    const content = "ghp_" + "A".repeat(36);
    for (const tool of ["Write", "Edit"]) {
      expect(() =>
        createCredentialGuard().handleToolExecuteBefore(
          { tool },
          { args: { filePath: "docs/example.md", content } },
        ),
      ).toThrow("Secret detected");
    }
  });
  it("protects kubeconfig artifacts without matching unrelated path words", () => {
    const guard = createCredentialGuard();
    for (const path of [
      "config/kubeconfig",
      "config/kubeconfig-prod.yaml",
      "config/cluster.kubeconfig",
      "config/team-kubeconfig-prod.yaml",
      "config/prod-kubeconfig-test.json",
      "config/TEAM-KUBECONFIG-PROD.YAML",
      "config/team-kubeconfig.backup",
      "config/kubeconfig.md",
      "config/kubeconfig/cluster.json",
    ])
      expect(guard.isPathBlocked(path)).toBe(true);
    for (const path of [
      "docs/check-kubeconfig-topology.md",
      "docs/team-kubeconfig-prod.md",
      "docs/TEAM-KUBECONFIG-PROD.MD",
      "docs/kubeconfig-notes/readme.md",
    ])
      expect(guard.isPathBlocked(path)).toBe(false);
  });
});
