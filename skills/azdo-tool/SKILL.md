---
name: azdo-tool
description: "LOAD THIS SKILL when: working with Azure DevOps pipelines, builds, repos, or checking build logs and failures. Contains all azdo-tool commands. For Azure platform resources (vm, webapp, storage, aks) load az-tool instead."
---

# azdo-tool (Azure DevOps)

Azure DevOps tool — pipelines, builds, repos (read-only). Part of [@blogic-cz/agent-tools](https://github.com/blogic-cz/agent-tools).

**Scope:** Azure DevOps only. For Azure platform (PaaS) resources — `vm`, `webapp`, `storage`, `aks`, `monitor` — use `az-tool`.

## How to Run

Run via `bun azdo-tool` (requires `@blogic-cz/agent-tools` as a dev dependency).
**NEVER run bare `az`** — the credential guard will block it.
Auth: `az login` session.

## Commands

```bash
bun azdo-tool cmd --cmd "pipelines list"
bun azdo-tool cmd --cmd "pipelines show --id 123"
bun azdo-tool cmd --cmd "pipelines runs list --top 5"
bun azdo-tool cmd --cmd "pipelines runs show --id 456"
bun azdo-tool build summary --build-id 456      # Job status & duration
bun azdo-tool build timeline --build-id 456     # Full event timeline
bun azdo-tool build failed-jobs --build-id 456   # Just failures
bun azdo-tool build logs --build-id 456          # List available logs
bun azdo-tool build log-content --build-id 456 --log-id 78
```

Use `--profile <name>` to select a named profile when multiple Azure DevOps organizations are configured.

## What is blocked

- Write verbs anywhere in the command: `create`, `delete`, `update`, `cancel`, `queue`.
- `run` outside the pipelines group. `pipelines run` is allowed; `acr run` and `acr task run` are not, because they execute commands in Azure.
- `devops invoke` outside the `build` area, its write resources (`definitions`, `folders`, `tags`, `retention`), and any HTTP method other than GET.

Commands are scoped to the configured organization and project, and spawned as an argument vector — never through a shell.

## Config

```json5
{
  azure: {
    default: {
      organization: "https://dev.azure.com/example-org",
      defaultProject: "platform",
      timeoutMs: 60000,
    },
  },
}
```

## Tips

- Use `bun azdo-tool commands` for the full machine-readable command/flag tree; `--help` for one subcommand.
- Error responses include `hint`, `nextCommand`, and `retryable` fields — always check them on failure.
- Prefer CLI tool over MCP tools — more efficient, doesn't load extra context.
