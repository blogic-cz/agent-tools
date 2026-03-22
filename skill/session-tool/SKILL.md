---
name: session-tool
description: "LOAD THIS SKILL when: browsing OpenCode sessions, reading session history, or searching past conversations. Contains all session-tool commands."
---

# session-tool (OpenCode Sessions)

OpenCode session browser — list, read, and search session history. Part of [@blogic-cz/agent-tools](https://github.com/blogic-cz/agent-tools).

## How to Run

Run via `bun agent-tools-session` or project script alias (check `package.json` for `session-tool`).
Auth: no auth needed — reads local session storage.

## Commands

```bash
bun agent-tools-session list                   # List recent sessions
bun agent-tools-session read --session <session-id> # Read session messages
bun agent-tools-session search "query"         # Search across sessions
```

## Tips

- Use `--help` for full options.
- Error responses include `hint`, `nextCommand`, and `retryable` fields — always check them on failure.
