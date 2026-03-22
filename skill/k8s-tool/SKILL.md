---
name: k8s-tool
description: "LOAD THIS SKILL when: working with Kubernetes pods, logs, deployments, resource usage, or running kubectl commands. Contains all k8s-tool commands."
---

# k8s-tool (Kubernetes)

Kubernetes tool — kubectl wrapper with config-driven context resolution and structured commands. Part of [@blogic-cz/agent-tools](https://github.com/blogic-cz/agent-tools).

## How to Run

Run via `bun agent-tools-k8s` or project script alias (check `package.json` for `k8s-tool`).
**NEVER run bare `kubectl`** — the credential guard will block it.
Auth: existing kubectl context (kubeconfig). Cluster ID from config resolves context automatically.

## Commands

```bash
bun agent-tools-k8s kubectl --env test --cmd "get pods -n test-ns"
bun agent-tools-k8s kubectl --env prod --cmd "logs <pod> --tail=100"
bun agent-tools-k8s kubectl --env test --cmd "describe pod <pod>"
bun agent-tools-k8s pods --env test                     # List pods (structured)
bun agent-tools-k8s logs --pod <pod> --env test --tail 50 # Fetch logs
bun agent-tools-k8s describe --resource pod --name <pod> --env test
bun agent-tools-k8s exec --pod <pod> --exec-cmd "ls -la" --env test
bun agent-tools-k8s top --env test                      # Show resource usage
```

Environment is any string (e.g. `test`, `prod`). Set `defaultEnvironment` in `agent-tools.json5` to skip `--env` on every call. Implicit production access is blocked for safety.

## Tips

- Use `--help` on any subcommand for full options.
- Error responses include `hint`, `nextCommand`, and `retryable` fields — always check them on failure.
- Prefer CLI tool over MCP tools — more efficient, doesn't load extra context.
