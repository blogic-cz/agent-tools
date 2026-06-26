---
name: session-tool
description: "LOAD THIS SKILL when: browsing OpenCode or Claude Code sessions, reading session history, or searching past conversations. Contains all session-tool commands."
---

# session-tool (OpenCode + Claude Code Sessions)

Session browser for OpenCode + Claude Code — list, read, and search session history. Part of [@blogic-cz/agent-tools](https://github.com/blogic-cz/agent-tools).

## How to Run

Run via `bun session-tool` (requires `@blogic-cz/agent-tools` as a dev dependency).
Auth: no auth needed — reads local session storage.

## Commands

```bash
bun session-tool list                   # List recent sessions
bun session-tool read --session <session-id> # Read session messages
bun session-tool search "query"         # Search across sessions
```

Session ID routing:

- UUID format (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`) -> Claude Code sessions
- `ses_*` format -> OpenCode sessions
- Other IDs -> searched across both sources

## Tips

- Use `bun session-tool commands` for the full machine-readable command/flag tree; `--help` for one subcommand.
- Output defaults to **TOON** (token-efficient) — leave it as-is to save tokens. Add `--format json` only when you'll machine-parse the result.
- Error responses include `hint`, `nextCommand`, and `retryable` fields — always check them on failure.
