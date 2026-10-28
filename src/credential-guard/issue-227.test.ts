import { expect, it } from "vitest";
import { createCredentialGuard } from "./index";
import { parseBash } from "./bash";
import { judge } from "./policy";

const bash = (command: string) => judge(parseBash(command), { cwd: "/repo", home: "/users/test" });

it.each([
  `sed -i '' 's/"x": "\\^1\\.14\\.[0-9]*"/"x": "^1.14.4"/' package.json`,
  "sed -i '' 's/a*/b/' package.json",
  "sed -i 's/[0-9]/x/' notes.txt",
  "sed -n '/[0-9]*/p' notes.txt",
])("keeps sed scripts out of write targets: %s", (command) => {
  expect(bash(command)).toEqual({ kind: "pass" });
  expect(() =>
    createCredentialGuard().handleToolExecuteBefore({ tool: "Bash" }, { args: { command } }),
  ).not.toThrow();
});

it.each([
  "sed -i 's/x/y/' AGENT?.md",
  "sed -i 's/x/y/' AGENT[]S].md",
  "sed -i 's/x/y/' AGENT[S].md",
  "sed -i 's/x/y/' .cl?ude/agents/task.md",
  "sed -i 's/x/y/' .claude/a*/task.md",
  "sed -i 's/x/y/' .claude/c*/task.md",
  "sed -i 's/x/y/' .cod?x/prompts/task.md",
  "sed -i 's/x/y/' .agents/s*/task.md",
  "tar -vW create -f AGENTS.md src",
  "tar -vW append -f AGENTS.md src",
  "tar -kW create -f AGENTS.md src",
  "tar -vWappend -f AGENTS.md src",
  "tar -A -f AGENTS.md x.tar",
  "tar --catenate -f AGENTS.md x.tar",
  "tar --delete -f AGENTS.md member",
])("refuses protected write targets: %s", (command) => {
  expect(bash(command)).toMatchObject({
    findings: expect.arrayContaining([expect.objectContaining({ rule: "agent-config-write" })]),
  });
});

it.each([
  "wget -r https://example.com/x",
  "wget -qr https://example.com/x",
  "wget --recursive https://example.com/x",
  "wget --content-disposition https://example.com/x",
])("refuses server-chosen wget names in the current directory: %s", (command) => {
  expect(bash(command)).toMatchObject({
    findings: expect.arrayContaining([expect.objectContaining({ rule: "no-analyzer" })]),
  });
});

it.each([
  "wget -r -P /tmp/job https://example.com/x",
  "wget -r --directory-prefix downloads https://example.com/x",
  "wget --content-disposition -P downloads https://example.com/x",
  "tar --delete -f /tmp/x.tar member",
  "tar -xf x.tar AGENTS.md",
])("keeps bounded destinations and documented archive limits: %s", (command) => {
  expect(bash(command)).toEqual({ kind: "pass" });
});

it.each([
  "wget -r -P ~/.claude https://example.com/x",
  "wget --content-disposition -P ~/.codex https://example.com/x",
])("checks explicit wget prefixes: %s", (command) => {
  expect(bash(command)).toMatchObject({
    findings: expect.arrayContaining([expect.objectContaining({ rule: "agent-config-write" })]),
  });
});
