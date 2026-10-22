import { describe, expect, it } from "vitest";
import { createCredentialGuard } from "#guard";
import { isPassiveJqFilter } from "./passive-jq";

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

describe("credential guard file tools", () => {
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
      "prod-kubeconfig/admin.conf",
      "/tmp/team_kubeconfig/config",
      "mykubeconfig",
      "kubeconfig2",
      "config/MYKUBECONFIG2.backup",
      "prod-kubeconfig",
      "/tmp/team_kubeconfig/",
      "docs/kubeconfig-notes/readme.md",
      "docs/team-kubeconfig-prod/readme.md",
      "/tmp/team_kubeconfig/nested/check-kubeconfig-topology.md",
      "docs/cluster-kubeconfig-notes.md/readme.md",
      "config/kubeconfig2.MD",
      "docs/check-kubeconfig.md\n",
      "docs/check-kubeconfig.md\r\n",
    ])
      expect(guard.isPathBlocked(path)).toBe(true);
    for (const path of [
      "docs/check-kubeconfig-topology.md",
      "docs/team-kubeconfig-prod.md",
      "docs/TEAM-KUBECONFIG-PROD.MD",
      "docs/cluster-kubeconfig-notes.md",
    ])
      expect(guard.isPathBlocked(path)).toBe(false);
  });
  it.each([
    ["prod-kubeconfig/admin.conf", true],
    ["/tmp/team_kubeconfig/config", true],
    ["mykubeconfig", true],
    ["kubeconfig2", true],
    ["docs/kubeconfig-notes/readme.md", true],
    ["/tmp/team_kubeconfig/check-kubeconfig-topology.md", true],
    ["docs/cluster-kubeconfig-notes.md/readme.md", true],
    ["config/kubeconfig.md", true],
    ["docs/check-kubeconfig-topology.md", false],
    ["docs/cluster-kubeconfig-notes.md", false],
    ["docs/TEAM-KUBECONFIG-PROD.MD", false],
    ["docs/cluster-topology.md", false],
    ["docs/check-kubeconfig.md\n", true],
    ["docs/check-kubeconfig.md\r\n", true],
    ["prod-kubeconfig/.env.example", false],
  ])("preserves kubeconfig segment policy across file tools: %s", (path, blocked) => {
    for (const guard of [
      createCredentialGuard(),
      createCredentialGuard({ additionalBlockedPaths: ["ordinary-private\\.md$"] }),
    ]) {
      expect(guard.isPathBlocked(path)).toBe(blocked);
      for (const tool of ["Read", "Write", "Edit"]) {
        const invoke = () =>
          guard.handleToolExecuteBefore({ tool }, { args: { filePath: path, content: "Notes." } });
        if (blocked) expect(invoke).toThrow("Access blocked");
        else expect(invoke).not.toThrow();
      }
    }
  });
  it("retains configured protection for ordinary kubeconfig Markdown basenames", () => {
    const path = "docs/cluster-kubeconfig-notes.md";
    const guard = createCredentialGuard({
      additionalBlockedPaths: ["cluster-kubeconfig-notes\\.md$"],
    });
    expect(guard.isPathBlocked(path)).toBe(true);
    for (const tool of ["Read", "Write", "Edit"])
      expect(() =>
        guard.handleToolExecuteBefore({ tool }, { args: { file_path: path, content: "Notes." } }),
      ).toThrow("Access blocked");
  });
  it("preserves existing explicit allowed-path precedence for kubeconfig segments", () => {
    const path = "prod-kubeconfig/admin.conf";
    const guard = createCredentialGuard({
      additionalAllowedPaths: ["^prod-kubeconfig/admin\\.conf$"],
      additionalBlockedPaths: ["admin\\.conf$"],
    });
    expect(guard.isPathBlocked(path)).toBe(false);
    for (const tool of ["Read", "Write", "Edit"])
      expect(() =>
        guard.handleToolExecuteBefore({ tool }, { args: { file_path: path, content: "Notes." } }),
      ).not.toThrow();
    expect(guard.isDangerousBashCommand(`cat ${path}`)).toBe(false);
  });
});
