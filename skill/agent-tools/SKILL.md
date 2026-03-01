---
name: agent-tools
description: "LOAD THIS SKILL when: using CLI wrapper tools (gh-tool, db-tool, k8s-tool, az-tool, logs-tool, session-tool), working with databases, GitHub PRs, Kubernetes, Azure DevOps, or application logs. Contains tool overview, usage patterns, and project-specific aliases."
---

# Agent Tools

Safe CLI wrappers for AI coding agents — GitHub, databases, Kubernetes, Azure DevOps, logs, and OpenCode sessions.

**Full documentation**: Read the [README](https://github.com/blogic-cz/agent-tools) for complete API reference, configuration, and credential setup.

## Tools Overview

| Tool             | Description                                                          | Help                          |
| ---------------- | -------------------------------------------------------------------- | ----------------------------- |
| **gh-tool**      | GitHub CLI wrapper — PR management, issues, checks, reviews, merge   | `bun run gh-tool --help`      |
| **db-tool**      | Database query tool — SQL execution, schema introspection, tunneling | `bun run db-tool --help`      |
| **k8s-tool**     | Kubernetes tool — kubectl with config-driven context resolution      | `bun run k8s-tool --help`     |
| **az-tool**      | Azure DevOps tool — pipelines, builds, repos (read-only)             | `bun run az-tool --help`      |
| **logs-tool**    | Application logs — read local and remote (k8s pod) logs              | `bun run logs-tool --help`    |
| **session-tool** | OpenCode session browser — list, read, search session history        | `bun run session-tool --help` |

## Tool Priority

1. **CLI Tools (Preferred)** — More efficient, don't load context, provide full functionality
2. **MCP Tools (Fallback)** — Use when CLI alternatives don't exist

Always prefer `bun run gh-tool` over raw `gh`, `bun run db-tool` over raw `psql`, `bun run k8s-tool` over raw `kubectl`. The wrappers add security guardrails, audit trails, and project-specific config.

## Quick Reference

### gh-tool (GitHub)

```bash
bun run gh-tool pr list                    # List open PRs
bun run gh-tool pr view --pr 123           # View PR details
bun run gh-tool pr checks --pr 123         # Check CI status
bun run gh-tool pr checks --pr 123 --watch # Watch CI until complete
bun run gh-tool pr checks-failed --pr 123  # Get failed check details
bun run gh-tool pr merge --pr 123 --strategy squash --delete-branch --confirm
bun run gh-tool pr threads --pr 123 --unresolved-only  # Review comments
bun run gh-tool pr reply --pr 123 --comment-id 456 --body "Fixed"
bun run gh-tool pr resolve --thread-id 789
bun run gh-tool pr create --base test --title "feat: X" --body "Description"
```

### db-tool (Database)

```bash
bun run db-tool query --env local "SELECT * FROM users LIMIT 5"
bun run db-tool query --env test "SELECT count(*) FROM organizations"
bun run db-tool schema --env local          # List tables
bun run db-tool schema --env local users    # Show table schema
```

Environments: `local`, `test`, `prod`. Config in `agent-tools.json5`.

### k8s-tool (Kubernetes)

```bash
bun run k8s-tool kubectl -n test get pods
bun run k8s-tool kubectl -n prod logs <pod> --tail=100
bun run k8s-tool kubectl -n test describe pod <pod>
```

### az-tool (Azure DevOps)

```bash
bun run az-tool pipeline list
bun run az-tool pipeline show --id 123
bun run az-tool build list --top 5
bun run az-tool build show --id 456
```

### logs-tool (Application Logs)

```bash
bun run logs-tool list --env local          # List available log files
bun run logs-tool read --env local app.log  # Read specific log
bun run logs-tool read --env test app.log --tail 50
```

### session-tool (OpenCode Sessions)

```bash
bun run session-tool list                   # List recent sessions
bun run session-tool read <session-id>      # Read session messages
bun run session-tool search "query"         # Search across sessions
```

## Configuration

Config is loaded from `agent-tools.json5` (or `agent-tools.json`) by walking up from the current working directory.

See full config reference: https://github.com/blogic-cz/agent-tools#configuration

## Credential Guard

The guard blocks agents from accessing sensitive files and leaking secrets. It's configured via the `credentialGuard` section in `agent-tools.json5`.

**What it blocks:**

- Reads of secret files (`.env`, `.pem`, `.key`, `.ssh/`, etc.)
- Writes containing detected secrets (API keys, tokens, passwords)
- Dangerous shell patterns (`printenv`, `cat .env`, etc.)
- Direct CLI usage (`gh`, `kubectl`, `psql`, `az`) — must use wrapper tools
