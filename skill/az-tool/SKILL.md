---
name: az-tool
description: "LOAD THIS SKILL when: working with Azure DevOps pipelines, builds, repos, or checking build logs and failures. Contains all az-tool commands."
---

# az-tool (Azure DevOps)

Azure DevOps tool — pipelines, builds, repos (read-only). Part of [@blogic-cz/agent-tools](https://github.com/blogic-cz/agent-tools).

## How to Run

Run via `bun agent-tools-az` or project script alias (check `package.json` for `az-tool`).
**NEVER run bare `az`** — the credential guard will block it.
Auth: `az login` session.

## Commands

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

Use `--profile <name>` to select a named profile when multiple Azure DevOps organizations are configured.

## Tips

- Use `--help` on any subcommand for full options.
- Error responses include `hint`, `nextCommand`, and `retryable` fields — always check them on failure.
- Prefer CLI tool over MCP tools — more efficient, doesn't load extra context.
