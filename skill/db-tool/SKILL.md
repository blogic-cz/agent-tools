---
name: db-tool
description: "LOAD THIS SKILL when: running SQL queries, inspecting database schema, listing tables or columns, or working with database environments. Contains all db-tool commands."
---

# db-tool (Database)

Database query tool — SQL execution and schema introspection. Part of [@blogic-cz/agent-tools](https://github.com/blogic-cz/agent-tools).

## How to Run

Run via `bun agent-tools-db` or project script alias (check `package.json` for `db-tool`).
**NEVER run bare `psql`** — the credential guard will block it.
Auth: env var defined by `passwordEnvVar` in config (e.g. `AGENT_TOOLS_DB_PASSWORD`).

## Commands

```bash
bun agent-tools-db sql --env local --sql "SELECT * FROM users LIMIT 5"
bun agent-tools-db sql --env test --sql "SELECT count(*) FROM organizations"
bun agent-tools-db schema --env local --mode tables          # List tables
bun agent-tools-db schema --env local --mode columns --table users # Show table schema
```

Environment is any string (e.g. `local`, `test`, `prod`). Set `defaultEnvironment` in `agent-tools.json5` to skip `--env` on every call.

## Tips

- Use `--help` on any subcommand for full options.
- Error responses include `hint`, `nextCommand`, and `retryable` fields — always check them on failure.
- Prefer CLI tool over MCP tools — more efficient, doesn't load extra context.
