---
name: gh-tool
description: "LOAD THIS SKILL when: working with GitHub PRs, issues, workflows, CI checks, reviews, or merging. Contains all gh-tool commands for PR management, workflow monitoring, and issue tracking."
---

# gh-tool (GitHub)

GitHub CLI wrapper — PRs, issues, workflows, checks, reviews, merge. Part of [@blogic-cz/agent-tools](https://github.com/blogic-cz/agent-tools).

## How to Run

Run via `bun agent-tools-gh` or project script alias (check `package.json` for `gh-tool`).
**NEVER run bare `gh`** — the credential guard will block it.
Auth: `gh auth login` or `GITHUB_TOKEN` env var.

## PR Commands

```bash
bun agent-tools-gh pr status                  # View PR status for current branch
bun agent-tools-gh pr view --pr 123           # View PR details
bun agent-tools-gh pr checks --pr 123         # Check CI status
bun agent-tools-gh pr checks --pr 123 --watch # Watch CI until complete
bun agent-tools-gh pr checks-failed --pr 123  # Get failed check details
bun agent-tools-gh pr merge --pr 123 --strategy squash --delete-branch --confirm
bun agent-tools-gh pr threads --pr 123 --unresolved-only  # Review comments
bun agent-tools-gh pr reply --pr 123 --comment-id 456 --body "Fixed"
bun agent-tools-gh pr resolve --thread-id 789
bun agent-tools-gh pr create --base test --title "feat: X" --body "Description"
bun agent-tools-gh pr review-triage --pr 123  # Combined info, threads, checks
bun agent-tools-gh pr reply-and-resolve --pr 123 --comment-id 456 --thread-id 789 --body "Done"
```

## Workflow Commands

```bash
bun agent-tools-gh workflow list                              # List recent workflow runs
bun agent-tools-gh workflow view --run 123                    # View run details with jobs/steps
bun agent-tools-gh workflow watch --run 123                   # Block until run completes (NO sleep-polling!)
bun agent-tools-gh workflow logs --run 123                    # Fetch logs (failed jobs by default)
bun agent-tools-gh workflow job-logs --run 123 --job "build"  # Clean parsed logs for specific job
bun agent-tools-gh workflow rerun --run 123                   # Rerun failed jobs
bun agent-tools-gh workflow cancel --run 123                  # Cancel in-progress run
```

**NEVER use `sleep N && workflow list/jobs/view`** — use `workflow watch --run N` instead. The credential guard blocks sleep-polling with agent-tools commands.

## Issue Commands

```bash
bun agent-tools-gh issue list --state open --limit 30
bun agent-tools-gh issue view --issue 123
bun agent-tools-gh issue close --issue 123 --reason completed --comment "Done"
bun agent-tools-gh issue reopen --issue 123
bun agent-tools-gh issue comment --issue 123 --body "text"
bun agent-tools-gh issue edit --issue 123 --title "New title" --add-labels bug
bun agent-tools-gh issue triage-summary --format json --limit 100
```

## Tips

- Use `--help` on any subcommand for full options.
- Error responses include `hint`, `nextCommand`, and `retryable` fields — always check them on failure.
- Prefer CLI tool over MCP tools — more efficient, doesn't load extra context.
