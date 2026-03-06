---
name: agent-tools
description: "LOAD THIS SKILL when: using CLI wrapper tools (gh-tool, db-tool, k8s-tool, az-tool, logs-tool, session-tool), working with databases, GitHub PRs, Kubernetes, Azure DevOps, or application logs. Contains tool overview, usage patterns, and project-specific aliases."
---

# Agent Tools

Safe CLI wrappers for AI coding agents — GitHub, databases, Kubernetes, Azure DevOps, logs, and OpenCode sessions.

**Full documentation**: Read the [README](https://github.com/blogic-cz/agent-tools) for complete API reference, configuration, and credential setup.

## How to Run (CRITICAL)

These are **npm binary commands** — they CANNOT be run bare. You MUST use one of:

```bash
# Option 1: bunx (always works when @blogic-cz/agent-tools is installed)
bun agent-tools-k8s pods --env test

# Option 2: project script aliases (if defined in package.json "scripts")
bun run k8s-tool -- pods --env test
```

**NEVER run bare `agent-tools-*` commands** — they will fail with `command not found`.
**NEVER run raw `kubectl`, `gh`, `psql`, `az`** — the credential guard will block them.

Check the project's `package.json` for available script aliases (e.g. `k8s-tool`, `gh-tool`, `db-tool`).

All examples below use `bunx` prefix for clarity.

## Tools Overview

| Tool             | Description                                                        | Help                             |
| ---------------- | ------------------------------------------------------------------ | -------------------------------- |
| **gh-tool**      | GitHub CLI wrapper — PR management, issues, checks, reviews, merge | `bun agent-tools-gh --help`      |
| **db-tool**      | Database query tool — SQL execution, schema introspection          | `bun agent-tools-db --help`      |
| **k8s-tool**     | Kubernetes tool — kubectl with config-driven context resolution    | `bun agent-tools-k8s --help`     |
| **az-tool**      | Azure DevOps tool — pipelines, builds, repos (read-only)           | `bun agent-tools-az --help`      |
| **logs-tool**    | Application logs — read local and remote (k8s pod) logs            | `bun agent-tools-logs --help`    |
| **session-tool** | OpenCode session browser — list, read, search session history      | `bun agent-tools-session --help` |

## Tool Priority

1. **CLI Tools (Preferred)** — More efficient, don't load context, provide full functionality
2. **MCP Tools (Fallback)** — Use when CLI alternatives don't exist

Always prefer `bun agent-tools-gh` over raw `gh`, `bun agent-tools-db` over raw `psql`, `bun agent-tools-k8s` over raw `kubectl`. The wrappers add security guardrails, audit trails, and project-specific config.

**Consistency**: Tools provide `hint`, `nextCommand`, and `retryable` fields in error responses to help you recover from failures. Always check these fields when a command fails.

## Quick Reference

### gh-tool (GitHub)

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

```bash
bun agent-tools-gh issue list --state open --limit 30
bun agent-tools-gh issue view --issue 123
bun agent-tools-gh issue close --issue 123 --reason completed --comment "Done"
bun agent-tools-gh issue reopen --issue 123
bun agent-tools-gh issue comment --issue 123 --body "text"
bun agent-tools-gh issue edit --issue 123 --title "New title" --add-labels bug
bun agent-tools-gh issue triage-summary --format json --limit 100
```

### db-tool (Database)

```bash
bun agent-tools-db sql --env local --sql "SELECT * FROM users LIMIT 5"
bun agent-tools-db sql --env test --sql "SELECT count(*) FROM organizations"
bun agent-tools-db schema --env local --mode tables          # List tables
bun agent-tools-db schema --env local --mode columns --table users # Show table schema
```

Environment is any string (e.g. `local`, `test`, `prod`). Set `defaultEnvironment` in config to skip `--env` on every call.

### k8s-tool (Kubernetes)

```bash
bun agent-tools-k8s kubectl --env test --cmd "get pods -n test-ns"
bun agent-tools-k8s kubectl --env prod --cmd "logs <pod> --tail=100"
bun agent-tools-k8s kubectl --env test --cmd "describe pod <pod>"
bun agent-tools-k8s pods --env test                     # List pods
bun agent-tools-k8s logs --pod <pod> --env test --tail 50 # Fetch logs
bun agent-tools-k8s describe --resource pod --name <pod> --env test
bun agent-tools-k8s exec --pod <pod> --exec-cmd "ls -la" --env test
bun agent-tools-k8s top --env test                      # Show resource usage
```

### az-tool (Azure DevOps)

```bash
bun agent-tools-az cmd --cmd "pipelines list"
bun agent-tools-az cmd --cmd "pipelines show --id 123"
bun agent-tools-az cmd --cmd "pipelines runs list --top 5"
bun agent-tools-az cmd --cmd "pipelines runs show --id 456"
bun agent-tools-az build summary --build-id 456      # Job status & duration
bun agent-tools-az build timeline --build-id 456     # Full event timeline
bun agent-tools-az build failed-jobs --build-id 456   # Just failures
bun agent-tools-az build logs --build-id 456          # List available logs
bun agent-tools-az build log-content --build-id 456 --log-id 78
```

### logs-tool (Application Logs)

```bash
bun agent-tools-logs list --env local          # List available log files
bun agent-tools-logs read --env local --file app.log  # Read specific log
bun agent-tools-logs read --env test --file app.log --tail 50
```

### session-tool (OpenCode Sessions)

```bash
bun agent-tools-session list                   # List recent sessions
bun agent-tools-session read --session <session-id> # Read session messages
bun agent-tools-session search "query"         # Search across sessions
```

## Configuration

Config is loaded from `agent-tools.json5` (or `agent-tools.json`) by walking up from the current working directory.

See full config reference: https://github.com/blogic-cz/agent-tools#configuration

#### defaultEnvironment

Set `defaultEnvironment: "test"` in the root of your config to skip `--env test` in every command. Tools will fail explicitly if they detect an implicit `prod` access for safety.

## Credential Guard

The guard blocks agents from accessing sensitive files and leaking secrets. It's configured via the `credentialGuard` section in `agent-tools.json5`.

**What it blocks:**

- Reads of secret files (`.env`, `.pem`, `.key`, `.ssh/`, etc.)
- Writes containing detected secrets (API keys, tokens, passwords)
- Dangerous shell patterns (`printenv`, `cat .env`, etc.)
- Direct CLI usage (`gh`, `kubectl`, `psql`, `az`) — must use wrapper tools

## Authentication

Each tool uses its own auth — no unified token store:

| Tool        | Auth                                                    |
| ----------- | ------------------------------------------------------- |
| `gh-tool`   | `gh auth login` or `GITHUB_TOKEN` env var               |
| `k8s-tool`  | Existing kubectl context (kubeconfig)                   |
| `az-tool`   | `az login` session                                      |
| `db-tool`   | Env var defined by `passwordEnvVar` in config           |
| `logs-tool` | No auth — local files or via k8s-tool for remote access |
