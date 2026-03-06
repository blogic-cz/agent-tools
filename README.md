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

> **Recommended:** Copy the repo URL and tell your AI agent to install it. The agent will set up everything — dev dependency, config file, credential guard, skill — in the right places for your project.
>
> ```
> Install @blogic-cz/agent-tools from https://github.com/blogic-cz/agent-tools as a dev dependency, install the agent-tools skill, set up the credential guard, and configure the tools I need for this project.
> ```

### Manual installation

```bash
bun add -d @blogic-cz/agent-tools
```

**Requirements:** [Bun](https://bun.sh/) >=1.0.0

### For agents reading this

Follow these steps to set up agent-tools in the consumer project.

**Step 1 — Install**

- **JavaScript/TypeScript project** (has `package.json`): Install as a **dev dependency**:
  ```bash
  bun add -d @blogic-cz/agent-tools
  ```
- **Non-JavaScript project** (no `package.json`): Skip installation — run tools directly with `bunx`:
  ```bash
  bunx agent-tools-gh pr status
  bunx agent-tools-k8s pods --env test
  ```

**Step 2 — Configure**

Ask the user which tools they need (gh, db, k8s, az, logs, session). Create `agent-tools.json5` in the project root with **only the selected tools configured**. See [`examples/agent-tools.json5`](./examples/agent-tools.json5) for the full config reference with all options documented.

Minimal starting config:

```json5
{
  $schema: "https://raw.githubusercontent.com/blogic-cz/agent-tools/main/schemas/agent-tools.schema.json",
}
```

**Step 3 — Credential Guard**

Set up the credential guard for the agent's platform:

- **Claude Code**: Add the `PreToolUse` hook to `.claude/settings.json` — see [Setup for Claude Code](#setup-for-claude-code)
- **OpenCode**: Create the plugin at `.opencode/plugins/credential-guard.ts` — see [Setup for OpenCode](#setup-for-opencode)

**Step 4 — Test & Demo**

For each tool the user selected in Step 2:

1. Run `bunx agent-tools-<tool> --help` to verify it works
2. Summarize the key commands available
3. Show the user what data they have access to based on their `agent-tools.json5` — e.g. which environments, clusters, namespaces, databases, or profiles are configured and reachable

**Step 5 — Skill & Agent Docs**

Tell the user to run the following command themselves — it's interactive and lets them choose which agents to install the skill for:

```bash
npx skills add blogic-cz/agent-tools
```

**Do not run this command for the user** — it requires interactive selection.

Then update the project's `AGENTS.md` and/or `CLAUDE.md`:

1. Add an `agent-tools` row to the skills table (if one exists):
   ```markdown
   | Agent wrapper tools (`db-tool`, `k8s-tool`, `logs-tool`, `az-tool`, `gh` patterns) | `agent-tools` |
   ```
2. Add or update the **Tooling** section:

   ```markdown
   ## Tooling

   For tool wrappers and operational patterns, load `agent-tools`.
   ```

**Step 6 — Custom Tool Scaffold**

Create an `agent-tools/` directory in the project root with an example tool so the user has a working template for building project-specific tools. Copy the scaffold from [`examples/custom-tool/`](./examples/custom-tool/):

```
agent-tools/
  package.json          # private package depending on @blogic-cz/agent-tools
  tsconfig.json         # extends root tsconfig
  noop.ts               # placeholder export for typecheck
  example-tool/
    index.ts             # ping-pong example using Effect CLI
```

After creating the files, run `bun install` in the `agent-tools/` directory (or from the workspace root if it's a monorepo). Then verify:

```bash
bun run agent-tools/example-tool/index.ts ping
```

## Quick Start

1. Install the package in your project
2. Create `agent-tools.json5` in your project root:

```json5
{
  $schema: "https://raw.githubusercontent.com/blogic-cz/agent-tools/main/schemas/agent-tools.schema.json",
  defaultEnvironment: "test", // optional: any string (e.g. "local", "test", "prod")
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
bunx agent-tools-gh pr status
bunx agent-tools-k8s kubectl --env test --cmd "get pods"
bunx agent-tools-logs list --env local
```

```bash
bunx agent-tools-gh pr review-triage   # interactive summary of PR feedback
bunx agent-tools-k8s pods --env test   # list pods (structured command)
```

Optionally, add script aliases to your `package.json` for shorter invocation:

```json
{
  "scripts": {
    "gh-tool": "agent-tools-gh",
    "k8s-tool": "agent-tools-k8s",
    "db-tool": "agent-tools-db",
    "logs-tool": "agent-tools-logs",
    "session-tool": "agent-tools-session"
  }
}
```

Then run via `bun run k8s-tool -- pods --env test` instead of `bunx agent-tools-k8s pods --env test`.

4. Hook up the credential guard in your agent config (Claude Code, OpenCode, etc.):

```typescript
import { handleToolExecuteBefore } from "@blogic-cz/agent-tools/credential-guard";

export default { handleToolExecuteBefore };
```

## Tools

| Binary                | Description                                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `agent-tools-gh`      | GitHub CLI wrapper — PR management, issues, workflows, composite commands (`review-triage`, `reply-and-resolve`) |
| `agent-tools-db`      | Database query tool — SQL execution, schema introspection                                                        |
| `agent-tools-k8s`     | Kubernetes tool — kubectl wrapper + structured commands (`pods`, `logs`, `describe`, `exec`, `top`)              |
| `agent-tools-az`      | Azure DevOps tool — pipelines, builds, repos                                                                     |
| `agent-tools-logs`    | Application logs — read local and remote (k8s pod) logs                                                          |
| `agent-tools-session` | OpenCode session browser — list, read, search sessions                                                           |

All tools support `--help` for full usage documentation.

## Configuration

Config is loaded from `agent-tools.json5` (or `agent-tools.json`) by walking up from the current working directory. Missing config = zero-config mode (works for `gh-tool`; others require config).

### Global Settings

Use `defaultEnvironment` to set the default target for tools that support environments (k8s-tool, logs-tool, db-tool). Passing `--env` explicitly always takes precedence. Note that tools will block implicit production access if `defaultEnvironment` is set to `"prod"`.

```json5
{
  defaultEnvironment: "test",
}
```

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
bunx agent-tools-az cmd --cmd "pipelines list"                    # uses "default" profile
bunx agent-tools-az cmd --cmd "pipelines list" --profile legacy   # uses "legacy" profile
```

**Profile resolution:** `--profile` flag > auto-select (single profile) > `"default"` key > error.

### Full Config Reference

See [`examples/agent-tools.json5`](./examples/agent-tools.json5) for a complete example with all options documented.

## Authentication

Each tool uses its own auth method — no unified token store:

| Tool        | Auth Method                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------- |
| `gh-tool`   | `gh` CLI session (`gh auth login`) or `GITHUB_TOKEN` env var                                 |
| `k8s-tool`  | Existing kubectl context (kubeconfig). Cluster ID from config resolves context automatically |
| `az-tool`   | `az` CLI session (`az login`)                                                                |
| `db-tool`   | Password from env var defined by `passwordEnvVar` in config (e.g. `AGENT_TOOLS_DB_PASSWORD`) |
| `logs-tool` | No auth — reads local files or uses k8s-tool for remote access                               |

Secrets are **never** stored in the config file. The `db-tool` config references env var **names** only:

```json5
{
  databases: {
    default: {
      passwordEnvVar: "AGENT_TOOLS_DB_PASSWORD", // tool reads process.env[passwordEnvVar] at runtime
    },
  },
}
```

Set the values in your shell:

```bash
export AGENT_TOOLS_DB_PASSWORD="your-password"
export GITHUB_TOKEN="ghp_xxxxxxxxxxxx"
```

The credential guard ensures these values never leak into agent output.

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

## Development & Evaluation

### Run Evaluation Harness

The evaluation harness runs a set of test cases against the tools to ensure quality and reliability:

```bash
bun run tests/eval/run.ts
```

## License

MIT
