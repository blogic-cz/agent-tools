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
  "cd ~/.claude && printf x > comm?nds/x.md",
  "cd ~/.claude && printf x | tee comm?nds/x.md",
  "cd ~/.claude && printf x > sk?lls/x/SKILL.md",
  "cd ~/.claude && cp /tmp/x sk?lls/foo/SKILL.md",
  "cd ~/.claude && cp /tmp/x hoo?s/x.sh",
  "cd ~/.claude && tee ag?nts/x.md < /tmp/x",
  "cd ~/.claude && touch comm?nds/x.md",
  "cd ~/.claude && truncate -s 0 comm?nds/x.md",
  "cd ~/.claude && cat /tmp/x >> comm*/x.md",
  "cd ~/.agents && printf x > sk?lls/x/SKILL.md",
  "cd ~/.agents && cp /tmp/x sk*/x/SKILL.md",
  "cd /repo/.claude && printf x > comm*/x.md",
  "cd ~/.claude/ && printf x > ./comm?nds/x.md",
  "cd ~/.claude/commands && printf x > ../sk?lls/x.md",
  "cd .claude && cp f c*/x.md",
  "cd .claude && echo x > c*/x.md",
  "cd /repo/.claude && cp f ./c*/x.md",
  "cd /repo/.claude && cp f s*/x/SKILL.md",
  "cd /repo/.agents && cp f s*/x/SKILL.md",
  "sed -i 's/x/y/' AGENT?.md",
  "sed -i 's/x/y/' AGENT[]S].md",
  "sed -i 's/x/y/' AGENT[S].md",
  "sed -i 's/x/y/' .cl?ude/agents/task.md",
  "sed -i 's/x/y/' .claude/a*/task.md",
  "sed -i 's/x/y/' .claude//a*/task.md",
  "sed -i 's/x/y/' .claude/./a*/task.md",
  "sed -i 's/x/y/' .claude/notes/../a*/task.md",
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

it.each(["tar --delete -f /tmp/x.tar member", "tar -xf x.tar AGENTS.md"])(
  "keeps documented archive limits: %s",
  (command) => {
    expect(bash(command)).toEqual({ kind: "pass" });
  },
);
