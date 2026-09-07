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
bun session-tool search "query" --body-chars 0 # Search with full message bodies
```

Session ID routing:

- UUID format (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`) -> Claude Code sessions
- `ses_*` format -> OpenCode sessions
- Other IDs -> searched across both sources

## Tips

- Use `bun session-tool commands` for the full machine-readable command/flag tree; `--help` for one subcommand.
- Output defaults to **TOON** (token-efficient) — leave it as-is to save tokens. Add `--format json` only when you'll machine-parse the result.
- `search` caps each message body at 500 characters; a cut result carries `truncated: true` and `bodyLength`. Absence of a term in a cut body proves nothing — re-run with `--body-chars 0`, or `read --session <id>` (never truncates), before concluding a session lacks something.
- Error responses include `hint`, `nextCommand`, and `retryable` fields — always check them on failure.
