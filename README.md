# @blogic-cz/agent-tools

Safe CLI wrappers for AI coding agents. 6 tools for GitHub, databases, Kubernetes, Azure DevOps, logs, and OpenCode sessions — with JSON5 config and a credential guard that blocks agents from touching secrets.

## Why

AI agents need CLI access. Giving them raw `gh`, `kubectl`, `psql` is dangerous — they can leak credentials, hit production, or run destructive commands.

These tools wrap each CLI with:

- **Security guardrails** — blocked paths, secret detection, dangerous command filtering
- **Audit trail** — every command goes through a wrapper, not raw shell
- **Project config** — agents use the right cluster, namespace, and database without guessing
- **Consistent output** — structured JSON or token-efficient TOON format for LLM consumption

## Installation

```bash
bun add @blogic-cz/agent-tools
```

**Requirements:** [Bun](https://bun.sh/) >=1.0.0

### For agents reading this

Clone the repo and look at the source. The tools are in `src/`, each tool is self-contained:

```bash
git clone https://github.com/blogic-cz/agent-tools.git
ls src/  # gh-tool/ db-tool/ k8s-tool/ az-tool/ logs-tool/ session-tool/ credential-guard/
```

## Quick Start

1. Install the package in your project
2. Create `agent-tools.json5` in your project root:

```json5
{
  $schema: "https://raw.githubusercontent.com/blogic-cz/agent-tools/main/schemas/agent-tools.schema.json",
  kubernetes: {
    default: {
      clusterId: "your-cluster-id",
      namespaces: { test: "your-ns-test", prod: "your-ns-prod" },
    },
  },
  logs: {
    default: {
      localDir: "apps/web-app/logs",
      remotePath: "/app/logs",
    },
  },
}
```

3. Run tools:

```bash
npx agent-tools-gh pr list
npx agent-tools-k8s kubectl -n prod-ns get pods
npx agent-tools-logs list --env local
```

4. Hook up the credential guard in your agent config (Claude Code, OpenCode, etc.):

```typescript
import { handleToolExecuteBefore } from "@blogic-cz/agent-tools/credential-guard";

export default { handleToolExecuteBefore };
```

## Tools

| Binary                | Description                                                     |
| --------------------- | --------------------------------------------------------------- |
| `agent-tools-gh`      | GitHub CLI wrapper — PR management, issues, workflows           |
| `agent-tools-db`      | Database query tool — SQL execution, schema introspection       |
| `agent-tools-k8s`     | Kubernetes tool — kubectl with config-driven context resolution |
| `agent-tools-az`      | Azure DevOps tool — pipelines, builds, repos                    |
| `agent-tools-logs`    | Application logs — read local and remote (k8s pod) logs         |
| `agent-tools-session` | OpenCode session browser — list, read, search sessions          |

All tools support `--help` for full usage documentation.

## Configuration

Config is loaded from `agent-tools.json5` (or `agent-tools.json`) by walking up from the current working directory. Missing config = zero-config mode (works for `gh-tool`; others require config).

### IDE Autocompletion

Add `$schema` to your config file:

```json5
{
  $schema: "https://raw.githubusercontent.com/blogic-cz/agent-tools/main/schemas/agent-tools.schema.json",
}
```

### Named Profiles

Each tool section supports multiple named profiles. Select with `--profile <name>`:

```json5
{
  azure: {
    default: { organization: "https://dev.azure.com/main-org", defaultProject: "platform" },
    legacy: { organization: "https://dev.azure.com/old-org", defaultProject: "app" },
  },
}
```

```bash
npx agent-tools-az pipeline list                    # uses "default" profile
npx agent-tools-az pipeline list --profile legacy   # uses "legacy" profile
```

**Profile resolution:** `--profile` flag > auto-select (single profile) > `"default"` key > error.

### Full Config Reference

See [`examples/agent-tools.json5`](./examples/agent-tools.json5) for a complete example with all options documented.

## Environment Variables

Secrets are **never** stored in the config file. Use environment variables:

| Variable           | Used By | Description                                               |
| ------------------ | ------- | --------------------------------------------------------- |
| `AGENT_TOOLS_DB_*` | db-tool | DB passwords (name defined by `passwordEnvVar` in config) |
| `GITHUB_TOKEN`     | gh-tool | GitHub API token (falls back to `gh` CLI auth)            |

### Setting up credentials

The config file only references env var **names** (via `passwordEnvVar`), never actual secrets. Set the values in your shell:

**macOS / Linux** — add to `~/.zshrc` or `~/.bashrc`:

```bash
export AGENT_TOOLS_DB_PASSWORD="your-password"
export GITHUB_TOKEN="ghp_xxxxxxxxxxxx"
```

**Windows** — PowerShell (persistent, user-level):

```powershell
[Environment]::SetEnvironmentVariable("AGENT_TOOLS_DB_PASSWORD", "your-password", "User")
[Environment]::SetEnvironmentVariable("GITHUB_TOKEN", "ghp_xxxxxxxxxxxx", "User")
```

Restart your terminal after adding env vars. The credential guard ensures these values never leak into agent output.

## Credential Guard

The guard blocks agents from accessing sensitive files, leaking secrets, and running dangerous commands. Every block message links to the source — if an agent thinks a block is wrong, it can fork the repo and submit a PR.

**What it blocks:**

- Reads of secret files (`.env`, `.pem`, `.key`, `.ssh/`, etc.)
- Writes containing detected secrets (API keys, tokens, passwords)
- Dangerous shell patterns (`printenv`, `cat .env`, etc.)
- Direct CLI usage (`gh`, `kubectl`, `psql`, `az`) — must use wrapper tools

### Setup for Claude Code

Claude Code uses shell command hooks. The package ships a ready-made wrapper script.

1. Add to `.claude/settings.json` (or `.claude/settings.local.json` for gitignored config):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "bun node_modules/@blogic-cz/agent-tools/src/credential-guard/claude-hook.ts"
          }
        ]
      }
    ]
  }
}
```

That's it. The hook reads tool input from stdin, runs the guard, and exits with code 2 (blocked + reason on stderr) or 0 (allowed).

### Setup for OpenCode

OpenCode loads plugins automatically from `.opencode/plugins/`. Create a plugin file:

**`.opencode/plugins/credential-guard.ts`**

```typescript
import { handleToolExecuteBefore } from "@blogic-cz/agent-tools/credential-guard";

export const CredentialGuard = async () => ({
  "tool.execute.before": handleToolExecuteBefore,
});
```

If the package isn't already in your project dependencies, add a `.opencode/package.json`:

```json
{
  "dependencies": {
    "@blogic-cz/agent-tools": "*"
  }
}
```

OpenCode installs plugin dependencies automatically at startup.

### Custom patterns

Use the `credentialGuard` config section to extend built-in defaults (arrays are merged, not replaced):

```json5
{
  credentialGuard: {
    additionalBlockedPaths: ["private/secrets/"],
    additionalAllowedPaths: ["apps/web-app/.env.test"],
    additionalBlockedCliTools: [{ tool: "helm", suggestion: "Use agent-tools-k8s instead" }],
    additionalDangerousBashPatterns: ["rm -rf /"],
  },
}
```

### Extending the guard

The guard source is at [`src/credential-guard/index.ts`](./src/credential-guard/index.ts). Fork the repo, adjust patterns, submit a PR: https://github.com/blogic-cz/agent-tools

## License

MIT
