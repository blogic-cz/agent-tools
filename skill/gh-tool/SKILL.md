---
name: gh-tool
description: "LOAD THIS SKILL when: working with GitHub PRs, issues, workflows, CI checks, reviews, or merging. Contains all gh-tool commands for PR management, workflow monitoring, and issue tracking."
---

# gh-tool (GitHub)

GitHub CLI wrapper — PRs, issues, workflows, checks, reviews, merge. Part of [@blogic-cz/agent-tools](https://github.com/blogic-cz/agent-tools).

## How to Run

Standard alias: `bun run gh-tool`. Requires a `"gh-tool": "agent-tools-gh"` script in the project's `package.json`.
**NEVER run bare `gh`** — the credential guard will block it.
Auth: `gh auth login` or `GITHUB_TOKEN` env var.

## PR Commands

```bash
bun run gh-tool -- pr status                  # View PR status for current branch
bun run gh-tool -- pr view --pr 123           # View PR details
bun run gh-tool -- pr checks --pr 123         # Check CI status
bun run gh-tool -- pr checks --pr 123 --watch # Watch CI until complete
bun run gh-tool -- pr checks-failed --pr 123  # Get failed check details
bun run gh-tool -- pr merge --pr 123 --strategy squash --delete-branch --confirm
bun run gh-tool -- pr threads --pr 123 --unresolved-only  # Review comments
bun run gh-tool -- pr reply --pr 123 --comment-id 456 --body "Fixed"
bun run gh-tool -- pr resolve --thread-id 789
bun run gh-tool -- pr create --base test --title "feat: X" --body "Description"
bun run gh-tool -- pr review-triage --pr 123  # Combined info, threads, checks
bun run gh-tool -- pr reply-and-resolve --pr 123 --comment-id 456 --thread-id 789 --body "Done"
```

## Workflow Commands

```bash
bun run gh-tool -- workflow list                              # List recent workflow runs
bun run gh-tool -- workflow view --run 123                    # View run details with jobs/steps
bun run gh-tool -- workflow watch --run 123                   # Block until run completes (NO sleep-polling!)
bun run gh-tool -- workflow logs --run 123                    # Fetch logs (failed jobs by default)
bun run gh-tool -- workflow job-logs --run 123 --job "build"  # Clean parsed logs for specific job
bun run gh-tool -- workflow rerun --run 123                   # Rerun failed jobs
bun run gh-tool -- workflow cancel --run 123                  # Cancel in-progress run
```

**NEVER use `sleep N && workflow list/jobs/view`** — use `workflow watch --run N` instead. The credential guard blocks sleep-polling with agent-tools commands.

## Issue Commands

```bash
bun run gh-tool -- issue list --state open --limit 30
bun run gh-tool -- issue view --issue 123
bun run gh-tool -- issue close --issue 123 --reason completed --comment "Done"
bun run gh-tool -- issue reopen --issue 123
bun run gh-tool -- issue comment --issue 123 --body "text"
bun run gh-tool -- issue edit --issue 123 --title "New title" --add-labels bug
bun run gh-tool -- issue triage-summary --format json --limit 100
```

## Tips

- Use `--help` on any subcommand for full options.
- Error responses include `hint`, `nextCommand`, and `retryable` fields — always check them on failure.
- Prefer CLI tool over MCP tools — more efficient, doesn't load extra context.
