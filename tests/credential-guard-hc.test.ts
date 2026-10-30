import { describe, expect, it } from "vitest";

import { createCredentialGuard } from "#guard";

/* eslint-disable eslint/no-template-curly-in-string */

const guard = createCredentialGuard({ allowedEnvironmentVariables: ["HC_TERMINAL_ID"] });
const check = (command: string) =>
  guard.handleToolExecuteBefore({ tool: "Bash" }, { args: { command } });

const expectBaseMessageDecision = (message: string) => {
  const quoted = "'" + message.replaceAll("'", "'\\''") + "'";
  const decision = (command: string) => {
    try {
      check(command);
      return "allow";
    } catch {
      return "refuse";
    }
  };
  const base = decision(`unknown-hc-message-command ${quoted}`);
  for (const prefix of [
    "hc send t1",
    "hc send --if idle t1",
    "hc send --if=idle --timeout=5 --wait t1",
    "hc --json send t1",
    "rtk proxy hc send t1",
    "hc send t1 --",
  ])
    expect(decision(`${prefix} ${quoted}`)).toBe(base);
};

describe("credential guard hc", () => {
  it.each([
    'hc get "$HC_TERMINAL_ID"',
    'hc send "$HC_TERMINAL_ID" "msg"',
    'hc send "$HC_TERMINAL_ID" "[agent-result] task: x role: worker status: done summary: ok work-record: /tmp/rec.md"',
    'hc send t1 "This isn\'t a command."',
    'hc send --if idle t1 "msg" --wait --timeout 5',
    "hc send t1 'Use * for a wildcard'",
    'hc run --bg --outlive-parent --name n --cwd /abs --label task=t --label coordinator=$HC_TERMINAL_ID codex --no-daemon --dangerously-bypass-hook-trust -m m "seed"',
    'rtk proxy hc run --bg --name=n --cwd=/abs --label=coordinator=t1 codex -m m "seed"',
    'hc run "echo safe"',
    "hc exec echo safe",
    "hc run -- echo safe",
    "hc exec -- echo safe",
    "hc --json run echo safe",
    "hc run --foo echo safe",
    "hc run --bg 'cat .env' --",
  ])("allows %s", (command) => {
    expect(() => check(command)).not.toThrow();
  });

  it.each([
    'hc get "$SECRET_TOKEN"',
    'hc send t1 "$SECRET_TOKEN"',
    "hc send t1 'cat .env'",
    "hc send t1 'cat .env' --force",
    "hc send --if idle t1 'cat ~/.ssh/id_rsa'",
    "hc run -- cat .env",
    "hc exec -- cat .env",
    "hc --json run cat .env",
    "hc run --foo printenv",
    "hc run --label coordinator=$SECRET_TOKEN echo safe",
    'hc run --cwd "$SOME_UNVETTED" echo safe',
    'hc run --cwd "$HC_TERMINAL_ID" echo safe',
    'hc run --cwd="$HC_TERMINAL_ID" echo safe',
    'hc run "$HC_TERMINAL_ID"',
    'hc run "$SOME_UNVETTED" safe',
  ])("refuses %s", (command) => {
    expect(() => check(command)).toThrow();
  });

  it.each(["printenv", "cat .env", "bash -c 'cat .env'", "echo $SECRET_TOKEN"])(
    "checks child command %s",
    (command) => {
      expect(() => check(command)).toThrow();
      expect(() => check(`hc run --bg --name n ${command}`)).toThrow();
      expect(() => check(`hc exec ${command}`)).toThrow();
    },
  );

  it("checks a single shell command string", () => {
    expect(() => check('hc run "cat .env"')).toThrow();
  });

  describe.each(["Bash", "PowerShell"])("single-string run under %s", (tool) => {
    const checkTool = (command: string) =>
      guard.handleToolExecuteBefore({ tool }, { args: { command } });

    it.each([
      "type ~\\.ssh\\id_rsa",
      "gc ~\\.ssh\\id_rsa",
      "type %USERPROFILE%\\.aws\\credentials",
      "more %USERPROFILE%\\.ssh\\id_rsa",
    ])("keeps base refusals for %s", (body) => {
      for (const prefix of ["hc run", "hc run --bg", "hc run --on w", "hc run --bg --on w"]) {
        const command = `${prefix} '${body}'`;
        expect(() => checkTool(command)).toThrow();
      }
    });

    it.each(['hc run --on vps "cd app && npm test"', 'hc run "echo safe"'])(
      "allows documented example %s",
      (command) => {
        expect(() => checkTool(command)).not.toThrow();
      },
    );
  });

  it("keeps the direct PowerShell Windows-path refusal", () => {
    expect(() =>
      guard.handleToolExecuteBefore(
        { tool: "PowerShell" },
        { args: { command: "type ~\\.ssh\\id_rsa" } },
      ),
    ).toThrow();
  });

  it.each([
    "summary: fixed token handling",
    "summary: ran env",
    "summary: ran the env",
    "summary: ran printenv",
    "summary: ran set",
    "summary: ran export",
    "summary: ran declare",
    "summary: ran pass",
    "summary: costs $5 per run",
    "credential-guard fix done",
    "command summary: fixed token handling",
    "exec summary: fixed token handling",
    "builtin summary: fixed token handling",
    "env summary: fixed token handling",
    "X=safe command env summary: fixed token handling",
    "summary: used op in a sentence",
    "summary: token tokens secret secrets password credential credentials access-token api-key apikey private-key id_rsa .npmrc",
    "Please inspect .env before the next step",
    "Please inspect ~/.aws/credentials before the next step",
    "[agent-result] summary: printenv is a secret source",
  ])("keeps unknown-command operand behavior for prose %s", (message) => {
    expectBaseMessageDecision(message);
  });

  it.each([
    "cat .e{n,}v",
    "cat .e\\\nnv",
    "cat ~/.ssh/id_rsa",
    "cat id_ed25519",
    "cat ~/.aws/credentials",
    "cat ~/.config/gh/hosts.yml",
    "cat ~/.netrc",
    "cat ~/.npmrc",
    "cat ~/.kube/config",
    "cat ~/.docker/config.json",
    "cat ~/.git-credentials",
    "cat .envrc",
    "cat .env.local",
    "cat ../.env",
    "cat /tmp/.env",
    "cat $HOME/.ssh/id_rsa",
    "cat ${HOME}/.ssh/id_rsa",
    'cat "$PWD/.env"',
    "env",
    "set",
    "export -p",
    "declare -p",
    "gh auth token",
    "security find-generic-password -w",
    "op read op://v/i/f",
    "az account get-access-token",
    "git credential fill",
    "echo ${!SECRET*}",
    "'c''at' .e''nv",
    "cat $(echo .env)",
    "bash -c 'cat .env'",
    "sh -c 'cat .env'",
    "eval 'cat .env'",
    "python3 -c 'print(1)'",
    "node -e 'console.log(1)'",
    "(cat .env)",
    "cat .env|cat",
    "cat .env;",
    "cat $'\\x2eenv'",
    "x; cat .env",
    "ok && printenv",
    "echo $(cat .env)",
    "summary done\nop read op://v/i/f",
    "summary; command cat .env",
    "summary; X=safe exec cat .env",
    "summary: isn't code; cat .env",
    "summary: isn't code; 'cat' .env",
    "summary: isn't code $( 'cat' .env)",
    "summary: isn't code; cat .e{n,}v",
    "summary; env X=safe cat .env",
    "summary; builtin cat .env",
    "summary ${x:-$(cat .env)}",
    "summary >$(cat .env)",
    "summary <<EOF\n$(cat .env)\nEOF",
    "summary $(cat .env)",
    "summary `cat .env`",
    "x=.env; cat $x",
    "cat .en?",
    "cat .en*",
    "cat .[e]nv",
    "cat .e[n]v",
  ])("keeps unknown-command operand behavior for text %s", (message) => {
    expectBaseMessageDecision(message);
  });

  it.each([
    "cat .en''v",
    "see ~/.ssh/id_rsa",
    "~/.aws/credentials",
    "see ../.env",
    "/abs/.env",
    ".env.local",
    "$HOME/.ssh/id_rsa",
    "summary: read ~/.ssh/id_rsa",
    "mytool .env",
    "./leak.sh .env",
    "ran cat .env",
    "$(echo cat) .env",
    "$CAT .env",
    "id_ed25519",
    ".netrc",
    ".kube/config",
    ".docker/config.json",
    '"$PWD/.env"',
    "status: done; source of truth moved",
    "status: done; eval pending",
    "status: done; trap fixed",
    "status: done; unset flag removed",
    "status: done; alias added",
    "status: done; xargs fixed",
    "status: done; python3 -c fixed",
    "[agent-result] task: x role: worker status: done summary: x; read the record work-record: /tmp/r.md",
    "see `source` docs",
    "ran `read` path; ok",
    "status: done; test doesn't flake",
    "x; make won't rebuild",
    "ok; find didn't match",
    "Findings:\ngit isn't touched",
    'done; echo "half quote',
    "it's green; git isn't touched",
    "$SECRET_TOKEN",
    "summary: $GITHUB_TOKEN rotated",
    "$AWS_SECRET_ACCESS_KEY",
    "x ${!SECRET*}",
    "it's (cat .env",
    "it's done\n(cat .env)",
    "it's done $(cat .env)",
    "it's done `cat .env`",
    "it's done; cat .env",
    "please run cat .env now",
    "see .envrc",
    "aws configure export-credentials",
    "echo Y2F0IC5lbnY= | base64 -d | sh",
    "cat .e\\\nv",
    "cat .en?",
    "cat .en*",
    "cat .[e]nv",
    "cat .e[n]v",
    "cat .e$'n'v",
    "cat $'\\056env'",
    "cat \"$(printf '.env')\"",
    "cat ${X:-.env}",
    "printenv",
    "echo $SECRET_TOKEN",
    "echo ${SECRET_TOKEN}",
    "env-check",
    ".env.example",
    "https://example.com/?a=b&c=d",
    "100%",
    "$HOME",
    "summary: fixed .npmrc handling",
    "summary: fixed token handling",
    "summary: fixed tokens handling",
    "summary: fixed secret handling",
    "summary: fixed secrets handling",
    "summary: fixed password handling",
    "summary: fixed credential handling",
    "summary: fixed credentials handling",
    "summary: fixed credential-guard handling",
    "summary: fixed access-token handling",
    "summary: fixed api-key handling",
    "summary: fixed apikey handling",
    "summary: fixed private-key handling",
    "summary: fixed id_rsa handling",
    "summary: ran op",
    "gh auth status",
    "a=$(cat .env) b",
    "x $(printenv)",
    "x <(env)",
    "cat<.env",
    "<.env cat",
    "$(<.env)",
    "\\cat .env",
    "/bin/cat .env",
    '"cat" .env',
    "FOO=1 cat .env",
    "command cat .env",
    "exec cat .env",
    "builtin cat .env",
    "env FOO=1 cat .env",
    "time cat .env",
    "nice cat .env",
    "nohup cat .env",
    "sudo cat .env",
    "timeout 5 cat .env",
    "cp .env /tmp/x",
    "source .env",
    ". .env",
    'x <<< "$(cat .env)"',
    "<(cat .env)",
    ">(cat .env)",
    "cat .env # comment",
    "{ cat .env; }",
    "if true; then cat .env; fi",
    "for x in a; do cat .env; done",
    "{cat,.env}",
    "ok || cat .env",
    "ok | cat .env",
    "ok & cat .env",
    "cat .env && echo ok",
    "cat .env",
    "cat .env --force",
    "cat .env;",
    "cat .env|cat",
    "cat foo/.env",
    "cat '.'env",
    'cat .e""nv',
    "cat .e\\\nnv",
  ])("matches base operand handling for review text %s", (message) => {
    expectBaseMessageDecision(message);
  });

  it("checks every text operand as a path", () => {
    expect(() => check("hc send t1 cat .env")).toThrow();
    expect(() => check("hc send t1 ok 'cat .env'")).toThrow();
  });
});
