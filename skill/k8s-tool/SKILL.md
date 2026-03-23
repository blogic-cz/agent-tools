---
name: k8s-tool
description: "LOAD THIS SKILL when: working with Kubernetes pods, logs, deployments, resource usage, or running kubectl commands. Contains all k8s-tool commands."
---

# k8s-tool (Kubernetes)

Kubernetes tool — kubectl wrapper with config-driven context resolution and structured commands. Part of [@blogic-cz/agent-tools](https://github.com/blogic-cz/agent-tools).

## How to Run

Standard alias: `bun run k8s-tool`. Requires a `"k8s-tool": "agent-tools-k8s"` script in the project's `package.json`.
**NEVER run bare `kubectl`** — the credential guard will block it.
Auth: existing kubectl context (kubeconfig). Cluster ID from config resolves context automatically.

## Commands

```bash
bun run k8s-tool -- kubectl --env test --cmd "get pods -n test-ns"
bun run k8s-tool -- kubectl --env prod --cmd "logs <pod> --tail=100"
bun run k8s-tool -- kubectl --env test --cmd "describe pod <pod>"
bun run k8s-tool -- pods --env test                     # List pods (structured)
bun run k8s-tool -- logs --pod <pod> --env test --tail 50 # Fetch logs
bun run k8s-tool -- describe --resource pod --name <pod> --env test
bun run k8s-tool -- exec --pod <pod> --exec-cmd "ls -la" --env test
bun run k8s-tool -- top --env test                      # Show resource usage
```

Environment is any string (e.g. `test`, `prod`). Set `defaultEnvironment` in `agent-tools.json5` to skip `--env` on every call. Implicit production access is blocked for safety.

## Tips

- Use `--help` on any subcommand for full options.
- Error responses include `hint`, `nextCommand`, and `retryable` fields — always check them on failure.
- Prefer CLI tool over MCP tools — more efficient, doesn't load extra context.
