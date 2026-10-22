import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";

const hook =
  process.env.AGENT_TOOLS_TEST_HOOK_PATH ??
  fileURLToPath(new URL("../src/credential-guard/claude-hook.ts", import.meta.url));
let directory = "";
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "guard-hook-"));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
function run(tool: string, args: Record<string, unknown>, timeout = 1000) {
  return spawnSync("bun", [hook], {
    cwd: directory,
    input: JSON.stringify({ tool_name: tool, tool_input: args }),
    encoding: "utf8",
    timeout,
  });
}
it.each([0x0b, 0x0c, 0xa0, 0x2028, 0x2029, 0x3000, 0xfeff, 0x85, 0x200b])(
  "refuses unsupported PowerShell character %i within one second",
  (code) => {
    for (const tool of ["PowerShell", "pwsh"]) {
      const started = performance.now();
      const result = run(tool, { command: "Get-Content" + String.fromCharCode(code) + ".env" });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect(performance.now() - started).toBeLessThan(1000);
    }
  },
);
const token = "ghp_" + "x".repeat(36);
it.each([
  { tool: "Edit", args: { file_path: "/tmp/example.ts", new_string: token } },
  {
    tool: "MultiEdit",
    args: { file_path: "/tmp/example.ts", edits: [{ old_string: "example", new_string: token }] },
  },
  { tool: "MultiEdit", args: { file_path: "/tmp/.env", edits: [] } },
  { tool: "NotebookEdit", args: { notebook_path: "/tmp/.env", new_source: "example" } },
  { tool: "NotebookEdit", args: { notebook_path: "/tmp/example.ipynb", new_source: token } },
  { tool: "Grep", args: { path: "/tmp/.env", pattern: "example" } },
  { tool: "Glob", args: { path: "/tmp/.env", pattern: "*" } },
  { tool: "Monitor", args: { command: "cat .env" } },
])("refuses the real $tool fields", ({ tool, args }) => {
  const result = run(tool, args);
  expect(result.status).toBe(2);
  expect(result.stderr).not.toContain(token);
});
it.each(["Edit", "MultiEdit", "NotebookEdit", "Grep", "Glob", "Monitor", "ExampleTool"])(
  "accepts benign $tool input",
  (tool) => {
    const result = run(tool, {
      file_path: "/tmp/example.ts",
      notebook_path: "/tmp/example.ipynb",
      path: "/tmp/example",
      new_string: "example",
      new_source: "example",
      edits: [{ old_string: "old", new_string: "example" }],
      command: "echo example",
    });
    expect(result.status).toBe(0);
  },
);
// Windows refuses to remove a process's working directory, so this state cannot occur there.
it.skipIf(process.platform === "win32")(
  "exits 2 when its working directory disappears before import",
  async () => {
    const gone = await mkdtemp(join(tmpdir(), "guard-gone-"));
    const script = `import { rmdirSync } from "node:fs"; rmdirSync(process.cwd()); await import(${JSON.stringify(hook)});`;
    const result = spawnSync("bun", ["--eval", script], {
      cwd: gone,
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "printenv" } }),
      encoding: "utf8",
      timeout: 1000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
  },
);
it("flushes a bounded refusal with its recovery hint through a pipe", () => {
  const result = run("Bash", { command: "cat example | ".repeat(50000) + "cat .env" });
  expect(result.status).toBe(2);
  expect(result.stderr.length).toBeLessThanOrEqual(8000);
  expect(result.stderr).toContain("[command elided]");
  expect(result.stderr).toContain("Tool inventory and usage:");
});

it("answers adversarial shell inputs within one second", () => {
  let nested = "cat .env";
  for (let depth = 0; depth < 9; depth++)
    nested = "sh -c '" + nested.replaceAll("'", "'\"'\"'") + "'";
  const cases = [
    ["long quote chain", "echo " + "'x'".repeat(64000) + "; cat .env"],
    ["nested shell quotes", nested],
    ["deep nesting", "( ".repeat(1000) + "cat .env" + " )".repeat(1000)],
    ["many brace words", "echo " + "{a,b} ".repeat(8000) + "; cat .env"],
    ["brace quote chain", "echo {a,b}" + "'x'".repeat(64000) + "; cat .env"],
    ["brace double quote chain", "echo {a,b}" + '"x"'.repeat(64000)],
    ["short brace quote chain", "echo {a,b}" + "'x'".repeat(8000) + "; cat .env"],
    ["many plain words", "echo " + "x ".repeat(120000) + "; cat .env"],
    ["medium plain words", "echo " + "x ".repeat(60000) + "; cat .env"],
    ["short plain words", "echo " + "x ".repeat(16000) + "; cat .env"],
    ["printf many words", "printf '%s\\n' " + "a ".repeat(20000) + "| xargs ls; cat .env"],
    ["nested brace quotes", "sh -c 'echo {a,b}" + '"x"'.repeat(20000) + "'; cat .env"],
    ["long for list", "for i in " + "a ".repeat(20000) + "; do echo $i; done; cat .env"],
    ["long pipeline", "echo public | ".repeat(3000) + "cat .env"],
  ];
  for (const [label, command] of cases) {
    const started = performance.now();
    const result = run("Bash", { command });
    expect({ label, error: result.error, status: result.status }).toEqual({
      label,
      error: undefined,
      status: 2,
    });
    expect(performance.now() - started).toBeLessThan(1000);
  }
});

it("refuses above the parser work budget through the real hook", () => {
  const below = run("Bash", { command: "echo " + "x ".repeat(2047) });
  expect(below.status).toBe(0);
  const above = run("Bash", { command: "echo " + "x ".repeat(2048) });
  expect(above.status).toBe(2);
  expect(above.stderr).toContain("analysis-limit");
});
