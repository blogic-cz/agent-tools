import { describe, expect, it } from "vitest";

import { createCredentialGuard, detectSleepPolling } from "#guard";

function refusal(command: string): string | null {
  try {
    createCredentialGuard().handleToolExecuteBefore({ tool: "Bash" }, { args: { command } });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const quotedNote = (text: string, delimiter = "'EOF'") =>
  `cat >> notes.md <<${delimiter}\n${text}\nEOF`;

describe("credential guard heredoc bodies", () => {
  it.each([
    ["sleep text", quotedNote("Then sleep 120 and rerun bun agent-tools-gh pr checks --pr 7.")],
    ["env text", quotedNote("The env command and Directory.* options are prose here.")],
    ["printenv text", quotedNote("Never run printenv in a worker.")],
    ["substitution text", quotedNote("Do not write $(cat secrets) or `env` in a script.")],
    ["double-quoted delimiter", quotedNote("sleep 120 with kubectl get pods", '"EOF"')],
    ["tab-stripped delimiter", "cat >> notes.md <<-'EOF'\n\tsleep 120; kubectl get pods\n\tEOF"],
    ["tee append", "tee -a notes.md <<'EOF'\nprintenv; sleep 120; kubectl get pods\nEOF"],
    [
      "following passive command",
      `${quotedNote("printenv; sleep 120; kubectl get pods")}\ngit status`,
    ],
    ["cli name text", quotedNote("x; gh pr merge 1; kubectl delete pod y")],
  ])("allows a quoted heredoc with %s as data", (_label, command) => {
    expect(refusal(command)).toBeNull();
  });

  it("does not report sleep text in a quoted body as polling", () => {
    expect(detectSleepPolling(quotedNote("sleep 120; kubectl get pods"))).toBeNull();
  });

  it.each([
    ["sensitive redirect target", "cat >> .env <<'EOF'\nnotes\nEOF", "file-access"],
    ["sensitive tee target", "tee -a secrets/notes.md <<'EOF'\nnotes\nEOF", "file-access"],
    ["unquoted substitution", "cat >> notes.md <<EOF\n$(cat secrets)\nEOF", "Command blocked"],
    ["unquoted variable", "cat >> notes.md <<EOF\n$HOME\nEOF", "Command blocked"],
    ["unquoted backtick", "cat >> notes.md <<EOF\n`printenv`\nEOF", "Command blocked"],
    [
      "unquoted plain text",
      "cat >> notes.md <<EOF\nsleep 120 then bun agent-tools-gh pr checks --pr 7\nEOF",
      "Sleep-polling",
    ],
    ["shell consumer", "bash <<'EOF'\nprintenv\nEOF", "Command blocked"],
    ["same-line pipe to shell", "cat <<'EOF' | bash\nprintenv\nEOF", "bounded complete heredoc"],
    [
      "python stdin consumer",
      "python3 - <<'EOF'\nimport os; print(os.environ)\nEOF",
      "Command blocked",
    ],
    ["node stdin consumer", "node <<'EOF'\nconsole.log(process.env)\nEOF", "Command blocked"],
    ["written script then run", "cat > run.sh <<'EOF'\nprintenv\nEOF\n./run.sh", "environment"],
    ["written script then shell", "cat > run.sh <<'EOF'\nprintenv\nEOF\nbash run.sh", "shell"],
    ["unclosed body", "cat >> notes.md <<'EOF'\nprintenv\n", "bounded complete heredoc"],
    [
      "real sleep loop",
      "while true; do bun agent-tools-gh pr checks --pr 7; sleep 120; done",
      "Sleep-polling",
    ],
    [
      "real sleep after heredoc",
      `${quotedNote("notes")}\nsleep 120; bun agent-tools-gh pr checks --pr 7`,
      "Sleep-polling",
    ],
  ])("still refuses %s", (_label, command, reason) => {
    expect(refusal(command)).toContain(reason);
  });
});
