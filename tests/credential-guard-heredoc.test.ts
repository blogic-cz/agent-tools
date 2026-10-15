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

const text = "Wait with sleep 120, then check kubectl get pods. Never run printenv or env.";
const note = (header = "cat >> notes.md", open = "<<'EOF'\n") => `${header} ${open}${text}\nEOF`;

describe("credential guard heredoc bodies", () => {
  it.each([
    note(),
    note("cat >> notes.md", '<<"EOF"\n'),
    "cat >> notes.md <<-'EOF'\n\tsleep 120; kubectl get pods\n\tEOF",
    note("tee -a notes.md"),
    `${note()}\ngit status`,
    `cd docs && pwd; ${note()}`,
    "cat >> notes.md <<'EOF'\nDo not write $(cat secrets), `env`; gh pr merge 1.\nEOF",
  ])("allows quoted body text as data: %j", (command) => {
    expect(refusal(command)).toBeNull();
  });

  it("does not report sleep text in a quoted body as polling", () => {
    expect(detectSleepPolling(note())).toBeNull();
  });

  it.each([
    ["cat >> .env <<'EOF'\nnotes\nEOF", "file-access"],
    ["tee -a secrets/notes.md <<'EOF'\nnotes\nEOF", "file-access"],
    ["cat >> notes.md <<EOF\n$(cat secrets)\nEOF", "Command blocked"],
    ["cat >> notes.md <<EOF\nsleep 120; kubectl get pods\nEOF", "Sleep-polling"],
    ["bash <<'EOF'\nprintenv\nEOF", "Command blocked"],
    ["python3 - <<'EOF'\nimport os; print(os.environ)\nEOF", "Command blocked"],
    ["cat <<'EOF' | bash\nprintenv\nEOF", "bounded complete heredoc"],
    ["cat > run.sh <<'EOF'\nprintenv\nEOF\n./run.sh", "environment"],
    ["cat >> notes.md <<'EOF'\nprintenv\n", "bounded complete heredoc"],
    ["export PATH=/tmp/x\ncat <<'EOF'\nprintenv\nEOF", "Command blocked"],
    ["PATH=/tmp/x\ncat <<'EOF'\nprintenv\nEOF", "Command blocked"],
    ["alias cat=sh\ncat <<'EOF'\nprintenv\nEOF", "Command blocked"],
    ["shopt -s expand_aliases\ncat <<'EOF'\nprintenv\nEOF", "Command blocked"],
    ["enable -n cat\ncat <<'EOF'\nprintenv\nEOF", "Command blocked"],
    ["true; cat <<'EOF'\nprintenv\nEOF", "Command blocked"],
    [note("/tmp/x/cat >> notes.md"), "Sleep-polling"],
    [note("tee -p notes.md"), "Sleep-polling"],
    [note("tee -i notes.md"), "Sleep-polling"],
    [note("cat >> notes.md", "<<'EOF'\r\n"), "Sleep-polling"],
    ["while true; do bun agent-tools-gh pr checks --pr 7; sleep 120; done", "Sleep-polling"],
    ["cat >> notes.md <<'EOF'\nnotes\nEOF\nsleep 120; kubectl get pods", "Sleep-polling"],
  ])("still refuses %j", (command, reason) => {
    expect(refusal(command)).toContain(reason);
  });
});
