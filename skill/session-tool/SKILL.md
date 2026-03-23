---
name: session-tool
description: "LOAD THIS SKILL when: browsing OpenCode sessions, reading session history, or searching past conversations. Contains all session-tool commands."
---

# session-tool (OpenCode Sessions)

OpenCode session browser — list, read, and search session history. Part of [@blogic-cz/agent-tools](https://github.com/blogic-cz/agent-tools).

## How to Run

Standard alias: `bun run session-tool`. Requires a `"session-tool": "agent-tools-session"` script in the project's `package.json`.
Auth: no auth needed — reads local session storage.

## Commands

```bash
bun run session-tool -- list                   # List recent sessions
bun run session-tool -- read --session <session-id> # Read session messages
bun run session-tool -- search "query"         # Search across sessions
```

## Tips

- Use `--help` for full options.
- Error responses include `hint`, `nextCommand`, and `retryable` fields — always check them on failure.
