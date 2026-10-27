import { expect, it } from "vitest";
import { parseBash } from "./bash";
import { judge } from "./policy";

const bash = (command: string) => judge(parseBash(command), { cwd: "/repo", home: "/users/test" });

it.each([
  "printf x > ./AGENT?.md",
  "printf x > ./AGENT[]S].md",
  "printf x >> ./AGENT[]S].md",
  "printf x > ./AGENT[S].md",
  "echo x | tee /tmp/output > ./AGENT[]S].md",
  "echo x | tee /tmp/output > ./AGENT?.md",
  "cp /tmp/evil/AGENTS.md ~/repo",
  "cp -R .claude ~/claude-backup",
  "cp -R /tmp/evil/.codex ~/somedir",
  "ln -s /tmp/evil/AGENTS.md /repo",
  "cp -r /tmp/evil/.claude ~/repo",
  "cp /tmp/evil/.mcp.json /repo",
  "rsync /tmp/x ~/.codex/AGENTS.md",
  "rsync -a /tmp/evil/ ~/.claude/",
  "ditto /tmp/x ~/.codex/AGENTS.md",
  "wget -O AGENTS.md https://example.com/x",
  "tar -xf /tmp/x.tar -C ~/.claude",
  "unzip /tmp/x.zip -d ~/.codex",
  "git checkout /tmp/x -- AGENTS.md",
  "patch AGENTS.md /tmp/x.patch",
  "truncate -s 0 AGENTS.md",
  "touch ~/.codex/AGENTS.md",
  "touch AGENT?.md",
  "touch ./AGENT[]S].md",
  "sed --in-pl=bak -e s/a/b/ AGENTS.md",
  "sed --in-pl AGENTS.md",
  "sed --in-pl s/a/b/ AGENTS.md",
  "sed --in s/a/b/ ~/.codex/AGENTS.md",
  "sort --out=AGENTS.md /tmp/x",
  "sort --outp=./AGENTS.md in.txt",
  "base64 --out=AGENTS.md /tmp/x",
  "tar --dir=~/.claude -xf /tmp/x.tar",
  "tar --direc=~/.claude -xf /tmp/x.tar",
  "patch --out=AGENTS.md public.txt /tmp/x.patch",
  "wget --output-d=AGENTS.md https://example.com/x",
  "wget --output-doc=AGENTS.md https://example.com/x",
  "tmutil restore /Volumes/TM/x/AGENTS.md AGENTS.md",
  "tmutil restore /Volumes/Backup/x ~/.claude/settings.json",
  "tar -cf AGENTS.md /tmp/evil",
  "tar --create --file=AGENTS.md /tmp/evil",
  "tar -cv -f AGENTS.md /tmp/evil",
  "tar --cre -f AGENTS.md /tmp/evil",
  "wget https://example.com/AGENTS.md",
  "git checkout HEAD AGENTS.md",
  "git checkout -p HEAD ./AGENTS.md",
])("refuses protected writes: %s", (command) => {
  expect(bash(command)).toMatchObject({
    findings: expect.arrayContaining([expect.objectContaining({ rule: "agent-config-write" })]),
  });
});

it.each([
  "cp AGENTS.md /tmp/x.md",
  "cp AGENTS.md ~/backup.md",
  "printf x > ./REPORT?.md",
  "cp -R .claude /tmp/claude-backup",
  "cp AGENTS.md /private/tmp/backup",
  "cp AGENTS.md /var/folders/test/backup",
  "cp AGENTS.md /private/var/folders/test/backup",
  'TMPDIR=/private/tmp/job; cp AGENTS.md "$TMPDIR/backup"',
  "rsync /tmp/x /tmp/y",
  "rsync -e ssh -a src/ host:/srv/",
  "rsync --rsh='ssh -p 2222' -a src/ host:/srv/",
  "ditto /tmp/x /tmp/y",
  "wget -O /tmp/x https://example.com/x",
  "tar -xf /tmp/x.tar -C /tmp/out",
  "tar -cf /tmp/out.tar public.txt",
  "tar -xf/repo/.codex/config.toml",
  "wget https://example.com/public.txt",
  "wget -O /tmp/x https://example.com/AGENTS.md",
  "unzip /tmp/x.zip -d /tmp/out",
  "git checkout main -- public.txt",
  "git checkout main public.txt",
  "patch public.txt /tmp/x.patch",
  "truncate -s 0 public.txt",
  "touch public.txt",
  "touch .env",
  "touch build/*.o",
  "tmutil restore public /tmp/x",
  "tmutil restore /Volumes/TM/a /tmp/x",
  "tmutil restore",
])("accepts ordinary operands: %s", (command) => {
  expect(bash(command)).toEqual({ kind: "pass" });
});

it.each(["jq --rawf /tmp/x.txt file.txt", "jq --slurpf=/tmp/x.txt file.txt"])(
  "keeps dangerous prefix fallback: %s",
  (command) => {
    expect(bash(command)).toMatchObject({
      findings: expect.arrayContaining([expect.objectContaining({ rule: "no-analyzer" })]),
    });
  },
);

it("keeps restore startup writes blocked", () => {
  expect(bash("tmutil restore /Volumes/Backup/x ~/.zshrc")).toMatchObject({
    findings: expect.arrayContaining([expect.objectContaining({ rule: "startup-mutation" })]),
  });
});

it.each([
  "rsync -e 'ssh -F ~/.ssh/config' src/ host:/srv/",
  "rsync -e 'cat ~/.ssh/id_rsa' src/ host:/srv/",
])("inspects remote shell arguments: %s", (command) => {
  expect(bash(command)).toMatchObject({
    findings: expect.arrayContaining([expect.objectContaining({ rule: "sensitive-path" })]),
  });
});

it.each(["tmutil restore ~/.ssh/id_rsa /tmp/x", "tmutil restore /tmp/x ~/.aws/credentials"])(
  "keeps sensitive restore refusal: %s",
  (command) => {
    expect(bash(command)).toMatchObject({
      findings: expect.arrayContaining([expect.objectContaining({ rule: "sensitive-path" })]),
    });
  },
);
