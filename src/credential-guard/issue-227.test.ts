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

it.each([
  "wget -r https://example.com/x",
  "wget -qr https://example.com/x",
  "wget --recursive https://example.com/x",
  "wget --content-disposition https://example.com/x",
  "wget -m https://example.com/",
  "wget --mirror https://example.com/",
  "wget -mnd https://example.com/",
  "wget -p -nd https://example.com/",
  "wget --page-requisites https://example.com/",
  "wget --trust-server-names https://example.com/",
])("refuses server-chosen wget names in the current directory: %s", (command) => {
  expect(bash(command)).toMatchObject({
    findings: expect.arrayContaining([expect.objectContaining({ rule: "no-analyzer" })]),
  });
});

it.each([
  "wget -r -nd -P ~ https://example.com/",
  "wget -r -nd -P /users/test https://example.com/",
  'wget -r -nd -P "$HOME" https://example.com/',
  "wget --content-disposition -P ~ https://example.com/x",
  "cd ~ && wget -r -nd -P . https://example.com/",
  "cd ~ && wget --content-disposition -P . https://example.com/x",
  "wget -r -nd -P . https://example.com/",
  "wget --content-disposition -P . https://example.com/x",
  "wget -r -nd -P ./ https://example.com/",
  "wget -r -nd -P '' https://example.com/",
  "wget -r -nd --directory-prefix= https://example.com/",
  'wget -r -nd -P "$PWD" https://example.com/',
  "wget -r -nd -P .. https://example.com/",
  "wget -qrP. https://example.com/",
  "wget -rP. https://example.com/",
])("refuses server-chosen names at home, cwd, or a parent: %s", (command) => {
  expect(bash(command)).toMatchObject({
    findings: expect.arrayContaining([expect.objectContaining({ rule: "no-analyzer" })]),
  });
});

it("refuses server-chosen names in the fish startup directory", () => {
  expect(bash("wget -r -nd -P ~/.config/fish https://example.com/")).toMatchObject({
    findings: expect.arrayContaining([expect.objectContaining({ rule: "startup-mutation" })]),
  });
});

it.each([
  "wget -r -nH -P ~/.config https://example.com/",
  "wget -r -nH -nd -P ~/.config https://example.com/",
  "wget -r -nH --cut-dirs=1 -P ~/.config https://example.com/x/",
  "cd /tmp && wget -r -nH -P ~/.. https://example.com/",
  "cd /tmp && wget -r -nH -P /Users https://example.com/",
  "wget -r -P /opt/downloads https://example.com/",
])("refuses unbounded server-chosen wget prefixes: %s", (command) => {
  expect(bash(command)).toMatchObject({
    findings: expect.arrayContaining([expect.objectContaining({ rule: "no-analyzer" })]),
  });
});

it.each([
  "cd ~ && wget -r -nH -P .config https://example.com/",
  "cd / && wget -r -nH -P Users https://example.com/",
  "cd /users && wget -r -nH -P test/.config https://example.com/",
  "cd ~ && wget -r -nH -P Library https://example.com/",
  "cd /opt && wget -r -nH -P out https://example.com/",
])("resolves server-chosen wget prefixes after cd: %s", (command) => {
  expect(bash(command)).toMatchObject({
    findings: expect.arrayContaining([expect.objectContaining({ rule: "no-analyzer" })]),
  });
});

it("allows a relative server-chosen wget prefix under a temporary working directory", () => {
  expect(bash("cd /tmp && wget -r -nH -P out https://example.com/")).toEqual({ kind: "pass" });
});

it("refuses a relative server-chosen wget prefix after an unresolved cd", () => {
  expect(bash('cd "$UNKNOWN" && wget -r -nH -P out https://example.com/')).toMatchObject({
    findings: expect.arrayContaining([expect.objectContaining({ rule: "opaque-path" })]),
  });
});

it.each([
  "-r",
  "--recursive",
  "-m",
  "--mirror",
  "-p",
  "--page-requisites",
  "--content-disposition",
  "--trust-server-names",
])("checks every server-chosen wget mode: %s", (mode) => {
  for (const directories of ["", "-nd", "--no-directories"]) {
    expect(bash(`wget ${mode} ${directories} -P . https://example.com/x`)).toMatchObject({
      findings: expect.arrayContaining([expect.objectContaining({ rule: "no-analyzer" })]),
    });
    for (const prefix of ["downloads", "/tmp/job"]) {
      expect(bash(`wget ${mode} ${directories} -P ${prefix} https://example.com/x`)).toEqual({
        kind: "pass",
      });
    }
  }
});

it.each([
  "-r",
  "--recursive",
  "-m",
  "--mirror",
  "-p",
  "--page-requisites",
  "--content-disposition",
  "--trust-server-names",
])("bounds prefixes for every server-chosen wget mode: %s", (mode) => {
  for (const directories of [
    "",
    "-nd",
    "--no-directories",
    "-nH",
    "--cut-dirs=1",
    "-nd -nH --cut-dirs=1",
  ]) {
    expect(bash(`wget ${mode} ${directories} -P . https://example.com/x`)).toMatchObject({
      findings: expect.arrayContaining([expect.objectContaining({ rule: "no-analyzer" })]),
    });
    for (const prefix of [
      "~/.config",
      '"$HOME/downloads"',
      "/opt/downloads",
      "downloads/../other",
      "/tmp/../other",
      "~+",
      "~-",
      "~user",
    ]) {
      expect(bash(`wget ${mode} ${directories} -P ${prefix} https://example.com/x`)).toMatchObject({
        findings: expect.arrayContaining([expect.objectContaining({ rule: "no-analyzer" })]),
      });
    }
    for (const prefix of [
      "downloads",
      "./downloads",
      "/tmp/job",
      "/private/tmp/job",
      "/var/folders/job",
    ]) {
      expect(bash(`wget ${mode} ${directories} -P ${prefix} https://example.com/x`)).toEqual({
        kind: "pass",
      });
    }
  }
});

it("allows server-chosen names under TMPDIR", () => {
  expect(
    bash('TMPDIR=/private/tmp/job; wget -r -nH -P "$TMPDIR/downloads" https://example.com/x'),
  ).toEqual({ kind: "pass" });
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
