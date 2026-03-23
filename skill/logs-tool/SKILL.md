---
name: logs-tool
description: "LOAD THIS SKILL when: reading application logs, listing log files, or accessing remote pod logs. Contains all logs-tool commands."
---

# logs-tool (Application Logs)

Application logs — read local and remote (k8s pod) logs. Part of [@blogic-cz/agent-tools](https://github.com/blogic-cz/agent-tools).

## How to Run

Run via `bun logs-tool` (requires `@blogic-cz/agent-tools` as a dev dependency).
Auth: no auth needed for local files; uses k8s-tool for remote access.

## Commands

```bash
bun logs-tool list --env local          # List available log files
bun logs-tool read --env local --file app.log  # Read specific log
bun logs-tool read --env test --file app.log --tail 50
```

Environment is any string (e.g. `local`, `test`). Set `defaultEnvironment` in `agent-tools.json5` to skip `--env` on every call.

## Tips

- Use `--help` for full options.
- Error responses include `hint`, `nextCommand`, and `retryable` fields — always check them on failure.
