---
name: az-tool
description: "LOAD THIS SKILL when: working with Azure DevOps pipelines, builds, repos, or checking build logs and failures. Contains all az-tool commands."
---

# az-tool (Azure DevOps)

Azure DevOps tool — pipelines, builds, repos (read-only). Part of [@blogic-cz/agent-tools](https://github.com/blogic-cz/agent-tools).

## How to Run

Standard alias: `bun run az-tool`. Requires a `"az-tool": "agent-tools-az"` script in the project's `package.json`.
**NEVER run bare `az`** — the credential guard will block it.
Auth: `az login` session.

## Commands

```bash
bun run az-tool -- cmd --cmd "pipelines list"
bun run az-tool -- cmd --cmd "pipelines show --id 123"
bun run az-tool -- cmd --cmd "pipelines runs list --top 5"
bun run az-tool -- cmd --cmd "pipelines runs show --id 456"
bun run az-tool -- build summary --build-id 456      # Job status & duration
bun run az-tool -- build timeline --build-id 456     # Full event timeline
bun run az-tool -- build failed-jobs --build-id 456   # Just failures
bun run az-tool -- build logs --build-id 456          # List available logs
bun run az-tool -- build log-content --build-id 456 --log-id 78
```

Use `--profile <name>` to select a named profile when multiple Azure DevOps organizations are configured.

## Tips

- Use `--help` on any subcommand for full options.
- Error responses include `hint`, `nextCommand`, and `retryable` fields — always check them on failure.
- Prefer CLI tool over MCP tools — more efficient, doesn't load extra context.
