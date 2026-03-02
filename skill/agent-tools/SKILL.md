---
name: agent-tools
description: "LOAD THIS SKILL when: using CLI wrapper tools (gh-tool, db-tool, k8s-tool, az-tool, logs-tool, session-tool), working with databases, GitHub PRs, Kubernetes, Azure DevOps, or application logs. Contains tool overview, usage patterns, and project-specific aliases."
---

# Agent Tools

Safe CLI wrappers for AI coding agents — GitHub, databases, Kubernetes, Azure DevOps, logs, and OpenCode sessions.

**Full documentation**: Read the [README](https://github.com/blogic-cz/agent-tools) for complete API reference, configuration, and credential setup.

## Tools Overview

| Tool             | Description                                                        | Help                         |
| ---------------- | ------------------------------------------------------------------ | ---------------------------- |
| **gh-tool**      | GitHub CLI wrapper — PR management, issues, checks, reviews, merge | `agent-tools-gh --help`      |
| **db-tool**      | Database query tool — SQL execution, schema introspection          | `agent-tools-db --help`      |
| **k8s-tool**     | Kubernetes tool — kubectl with config-driven context resolution    | `agent-tools-k8s --help`     |
| **az-tool**      | Azure DevOps tool — pipelines, builds, repos (read-only)           | `agent-tools-az --help`      |
| **logs-tool**    | Application logs — read local and remote (k8s pod) logs            | `agent-tools-logs --help`    |
| **session-tool** | OpenCode session browser — list, read, search session history      | `agent-tools-session --help` |

## Tool Priority

1. **CLI Tools (Preferred)** — More efficient, don't load context, provide full functionality
2. **MCP Tools (Fallback)** — Use when CLI alternatives don't exist

Always prefer `agent-tools-gh` over raw `gh`, `agent-tools-db` over raw `psql`, `agent-tools-k8s` over raw `kubectl`. The wrappers add security guardrails, audit trails, and project-specific config.

**Consistency**: Tools provide `hint`, `nextCommand`, and `retryable` fields in error responses to help you recover from failures. Always check these fields when a command fails.

## Quick Reference

### gh-tool (GitHub)

```bash
agent-tools-gh pr status                  # View PR status for current branch
agent-tools-gh pr view --pr 123           # View PR details
agent-tools-gh pr checks --pr 123         # Check CI status
agent-tools-gh pr checks --pr 123 --watch # Watch CI until complete
agent-tools-gh pr checks-failed --pr 123  # Get failed check details
agent-tools-gh pr merge --pr 123 --strategy squash --delete-branch --confirm
agent-tools-gh pr threads --pr 123 --unresolved-only  # Review comments
agent-tools-gh pr reply --pr 123 --comment-id 456 --body "Fixed"
agent-tools-gh pr resolve --thread-id 789
agent-tools-gh pr create --base test --title "feat: X" --body "Description"
agent-tools-gh pr review-triage --pr 123  # Combined info, threads, checks
agent-tools-gh pr reply-and-resolve --pr 123 --comment-id 456 --thread-id 789 --body "Done"
```

### db-tool (Database)

```bash
agent-tools-db sql --env local --sql "SELECT * FROM users LIMIT 5"
agent-tools-db sql --env test --sql "SELECT count(*) FROM organizations"
agent-tools-db schema --env local --mode tables          # List tables
agent-tools-db schema --env local --mode columns --table users # Show table schema
```

Environment is any string (e.g. `local`, `test`, `prod`). Set `defaultEnvironment` in config to skip `--env` on every call.

### k8s-tool (Kubernetes)

```bash
agent-tools-k8s kubectl --env test --cmd "get pods -n test-ns"
agent-tools-k8s kubectl --env prod --cmd "logs <pod> --tail=100"
agent-tools-k8s kubectl --env test --cmd "describe pod <pod>"
agent-tools-k8s pods --env test                     # List pods
agent-tools-k8s logs --pod <pod> --env test --tail 50 # Fetch logs
agent-tools-k8s describe --resource pod --name <pod> --env test
agent-tools-k8s exec --pod <pod> --exec-cmd "ls -la" --env test
agent-tools-k8s top --env test                      # Show resource usage
```

### az-tool (Azure DevOps)

```bash
agent-tools-az cmd --cmd "pipelines list"
agent-tools-az cmd --cmd "pipelines show --id 123"
agent-tools-az cmd --cmd "pipelines runs list --top 5"
agent-tools-az cmd --cmd "pipelines runs show --id 456"
agent-tools-az build summary --build-id 456      # Job status & duration
agent-tools-az build timeline --build-id 456     # Full event timeline
agent-tools-az build failed-jobs --build-id 456   # Just failures
agent-tools-az build logs --build-id 456          # List available logs
agent-tools-az build log-content --build-id 456 --log-id 78
```

### logs-tool (Application Logs)

```bash
agent-tools-logs list --env local          # List available log files
agent-tools-logs read --env local --file app.log  # Read specific log
agent-tools-logs read --env test --file app.log --tail 50
```

### session-tool (OpenCode Sessions)

```bash
agent-tools-session list                   # List recent sessions
agent-tools-session read --session <session-id> # Read session messages
agent-tools-session search "query"         # Search across sessions
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
