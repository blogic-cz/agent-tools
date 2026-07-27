---
name: k8s-tool
description: "LOAD THIS SKILL when: working with Kubernetes pods, logs, deployments, resource usage, or running kubectl commands. Contains all k8s-tool commands."
---

# k8s-tool (Kubernetes)

Kubernetes tool — kubectl wrapper with config-driven context resolution and structured commands. Part of [@blogic-cz/agent-tools](https://github.com/blogic-cz/agent-tools).

## How to Run

Run via `bun k8s-tool` (requires `@blogic-cz/agent-tools` as a dev dependency).
**NEVER run bare `kubectl`** — the credential guard will block it.
Auth: existing kubectl context (kubeconfig). Cluster ID from config resolves context automatically.

## Commands

```bash
bun k8s-tool kubectl --env test --cmd "get pods -n test-ns"
bun k8s-tool kubectl --env prod --cmd "logs <pod> --tail=100"
bun k8s-tool kubectl --env test --cmd "describe pod <pod>"
bun k8s-tool pods --env test                     # List pods (structured)
bun k8s-tool logs --pod <pod> --env test --tail 50 # Fetch logs
bun k8s-tool describe --resource pod --name <pod> --env test
bun k8s-tool exec --pod <pod> --exec-cmd "ls -la" --env test
bun k8s-tool top --env test                      # Show resource usage
```

Environment is any string (e.g. `test`, `prod`). Set `defaultEnvironment` in `agent-tools.json5` to skip `--env` on every call. Implicit production access is blocked for safety.

## Safety Boundary

- Generic kubectl commands are parsed into arguments and executed without a user-controlled shell. Do not use pipes, chaining, substitution, or shell interpreters.
- The configured context, kubeconfig, server, authentication, TLS, and impersonation settings cannot be overridden in `--cmd`.
- Only read-only `config` and `auth` subcommands are allowed; `cluster-info dump` is blocked.
- Secret reads, raw kubeconfig output, filename/kustomize reads, and `kubectl diff` are blocked.
- Pod exec accepts only direct `redis-cli PING/INFO` and `ls` diagnostics; generic exec cannot read file contents.
- Use `logs-tool` for confined remote log-file access and filtering.

## Tips

- Use `bun k8s-tool commands` for the full machine-readable command/flag tree; `--help` for one subcommand.
- Output defaults to **TOON** (token-efficient) — leave it as-is to save tokens. Add `--format json` only when you'll machine-parse the result.
- Error responses include `hint`, `nextCommand`, and `retryable` fields — always check them on failure.
- Prefer CLI tool over MCP tools — more efficient, doesn't load extra context.
