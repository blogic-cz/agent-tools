---
name: gh-tool
description: "LOAD THIS SKILL when: working with GitHub PRs, issues, workflows, CI checks, reviews, merging, or branch management. Contains all gh-tool commands for PR management, workflow monitoring, issue tracking, and branch operations."
---

# gh-tool (GitHub)

GitHub CLI wrapper — PRs, issues, workflows, checks, reviews, merge. Part of [@blogic-cz/agent-tools](https://github.com/blogic-cz/agent-tools).

## How to Run

Run via `bun gh-tool` (requires `@blogic-cz/agent-tools` as a dev dependency).
**NEVER run bare `gh`** — the credential guard will block it.
Auth: `gh auth login` or `GITHUB_TOKEN` env var.

## Discover commands

`bun gh-tool commands` dumps the **entire command tree** (every subcommand + its flags, types, choices, descriptions) as one structured payload — fetch it once instead of running `--help` repeatedly. Every agent-tools CLI has a `commands` subcommand (e.g. `bun db-tool commands`, `bun k8s-tool commands`).

## PR Commands

Use `--repo <profile|owner/name>` when working outside a single-repo checkout. If a repository has a PR template, prefer `--body-stdin` with a literal heredoc for `pr create` and `pr edit`; use `--body-file` only when the filled file already exists.

```bash
bun gh-tool pr list --state open                         # List PRs (filter: --author/--base/--head/--search)
bun gh-tool pr status                  # View PR status for current branch
bun gh-tool pr view --pr 123           # View PR details
bun gh-tool pr view --prs 12,34,56     # Batch view several PRs in one call (also: pr checks --prs)
bun gh-tool pr checks --pr 123         # Check CI status (one-shot snapshot)
bun gh-tool pr checks --pr 123 --watch # Watch CI until complete or --timeout (default 600s); returns a snapshot on timeout
bun gh-tool pr wait-mergeable --pr 123 # Poll until GitHub gives a definitive mergeable verdict
bun gh-tool pr checks-failed --pr 123 --with-logs # Failure diagnosis + SHA evidence
bun gh-tool pr watch --prs 123,124 --format jsonl --timeout 600 # Multi-PR transition stream
bun gh-tool pr close --pr 123 --comment "Closing, no longer needed" --delete-branch
bun gh-tool pr merge --pr 123 --strategy squash --delete-branch --confirm
bun gh-tool pr threads --pr 123 --unresolved-only  # Review comments
bun gh-tool pr reply --pr 123 --comment-id 456 --body "Fixed"
bun gh-tool pr resolve --thread-id 789
bun gh-tool pr create --repo be --title "feat: X" --body-stdin <<'EOF'
## Summary

...

## Testing

- bun run check
EOF
bun gh-tool pr edit --repo be --pr 123 --body-stdin <<'EOF'
## Summary

...

## Testing

- bun run check
EOF
bun gh-tool pr review-triage --pr 123  # Combined info+threads+checks; leads with a `ready` merge-readiness verdict
bun gh-tool pr reply-and-resolve --comment-id 456 --body "Done" # Infer PR + thread
bun gh-tool pr reply-and-resolve --pr 123 --comment-id 456 --thread-id 789 --body "Done" # Explicit IDs validated first
bun gh-tool pr rerun-checks --pr 123 --failed-only --watch --timeout 600 # Attempt-aware rerun
```

## Workflow Commands

```bash
bun gh-tool workflow list                              # List recent workflow runs
bun gh-tool workflow view --run 123                    # View run details with jobs/steps
bun gh-tool workflow watch --run 123                   # Block until run completes or --timeout (default 600s); NO sleep-polling!
bun gh-tool workflow logs --run 123                    # Fetch logs (failed jobs by default)
bun gh-tool workflow job-logs --run 123 --job "build"  # Clean parsed logs for specific job
bun gh-tool workflow rerun --run 123                   # Rerun failed jobs
bun gh-tool workflow cancel --run 123                  # Cancel in-progress run
```

**NEVER use `sleep N && workflow list/jobs/view`** — use `workflow watch --run N` instead. The credential guard blocks sleep-polling with agent-tools commands.

## Issue Commands

```bash
bun gh-tool issue list --state open --limit 30
bun gh-tool issue view --issue 123
bun gh-tool issue close --issue 123 --reason completed --comment "Done"
bun gh-tool issue reopen --issue 123
bun gh-tool issue comment --issue 123 --body "text"
bun gh-tool issue edit --issue 123 --title "New title" --add-labels bug
bun gh-tool issue triage --issue 123 --verbosity full --format json
```

## Branch Commands

```bash
bun gh-tool branch rename --old-name feature/old --new-name feature/new          # Dry-run
bun gh-tool branch rename --old-name feature/old --new-name feature/new --confirm # Execute
bun gh-tool branch rename --old-name feature/old --new-name feature/new --repo owner/repo --confirm
```

## Tips

- Use `bun gh-tool commands` for the full machine-readable command/flag tree; `--help` for one subcommand.
- Output defaults to **TOON** (token-efficient) — leave it as-is to save tokens. Add `--format json` only when you'll machine-parse output; JSON/JSONL modes suppress informational stderr but preserve structured errors.
- `checks-failed --with-logs` returns diagnosis. `rerun-checks` preflights all attempt jobs/logs and performs one `--failed` mutation per workflow run; `evidence_unavailable` and `escalation_required` mutate nothing. Discovery runs only with `--watch`, and discovery/watch share `--timeout`.
- Feedback SHA/origin fields and JSONL event schema are defined canonically in [README gh-tool machine contracts](../../README.md#gh-tool-machine-contracts). `jobId` is workflow job database ID; nullable `checkId` is never a job ID. `pre_existing` means different known commit, not obsolete.
- Error responses include `hint`, `nextCommand`, and `retryable` fields — always check them on failure.
- Prefer CLI tool over MCP tools — more efficient, doesn't load extra context.
