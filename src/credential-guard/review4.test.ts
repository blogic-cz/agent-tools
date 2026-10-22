import { expect, it } from "vitest";
import { createCredentialGuard } from "./index";

it.each(["unknown-type"])("rejects unknown Grep type %s", (type) => {
  const guard = createCredentialGuard();
  expect(() =>
    guard.handleToolExecuteBefore(
      { tool: "Grep" },
      { args: { pattern: "FAKE", type, output_mode: "content" } },
    ),
  ).toThrow();
});
it.each(["ts", "js", "sh", "zsh", "json", "py", "md", "yaml"])(
  "accepts Grep type filter %s",
  (type) => {
    const guard = createCredentialGuard();
    expect(() =>
      guard.handleToolExecuteBefore(
        { tool: "Grep" },
        { args: { pattern: "FAKE", type, output_mode: "content" } },
      ),
    ).not.toThrow();
  },
);
it.each([
  "gh pr view --zz-undeclared -R example/repo",
  "rtk gain --zz-undeclared",
  "rtk read --zz-undeclared README.md",
  "find . --zz-undeclared",
])("accepts harmless undeclared special-command options: %s", (command) => {
  const guard = createCredentialGuard();
  expect(() =>
    guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }),
  ).not.toThrow();
});

it.each([
  "git grep text -- '*.ts' ':!*.json'",
  "git grep text -- '*.cs' ':(exclude,glob)*Tests*'",
  "git grep text -- '*.ts' ':^secrets'",
  "rg --files -t sh",
])("accepts exclusions and file listings: %s", (command) => {
  const guard = createCredentialGuard();
  expect(() =>
    guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }),
  ).not.toThrow();
});
it.each([
  "git fetch origin main --u=printenv",
  "git --zz=.env",
  "git diff --unified .env ordinary.ts",
])("refuses ambiguous or undeclared option forms: %s", (command) => {
  const guard = createCredentialGuard();
  expect(() => guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } })).toThrow();
});

it("checks a qualified environment provider in an attached path parameter", () => {
  const guard = createCredentialGuard();
  expect(() =>
    guard.handleToolExecuteBefore(
      { tool: "PowerShell" },
      { args: { command: "Get-ChildItem -Path:'Microsoft.PowerShell.Core\\Environment::'" } },
    ),
  ).toThrow();
});
it.each(["nodejs", "pypy", "pypy3", "luajit", "lua5.4", "ipython", "ipython3", "bpython"])(
  "refuses code stdin to %s",
  (name) => {
    const guard = createCredentialGuard();
    expect(() =>
      guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command: name + " <<< 'x'" } }),
    ).toThrow();
  },
);

it.each(["git grep -hoE pattern -- '*.cs'", "npm run check env"])(
  "accepts safe data and reader flags: %s",
  (command) => {
    expect(() =>
      createCredentialGuard({}).handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }),
    ).not.toThrow();
  },
);
