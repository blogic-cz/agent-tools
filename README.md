# agent-tools

CLI tools for AI coding agent workflows. Provides 6 purpose-built tools for interacting with GitHub, databases, Kubernetes, Azure DevOps, application logs, and OpenCode sessions — with project-specific configuration via JSON5.

## Installation

```bash
bun add @blogic/agent-tools
```

**Requirements:** [Bun](https://bun.sh/) >=1.0.0

## Quick Start

1. Create `agent-tools.json5` in your project root:

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

2. Run tools via npx or installed binaries:

```bash
npx agent-tools-gh pr list
npx agent-tools-k8s kubectl -n prod-ns get pods
npx agent-tools-logs list --env local
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

Add `$schema` to your config file for full IDE autocompletion:

```json5
{
  $schema: "https://raw.githubusercontent.com/blogic-cz/agent-tools/main/schemas/agent-tools.schema.json",
  // ... rest of config
}
```

### Named Profiles

Each tool section supports multiple named profiles. Select a profile with `--profile <name>`:

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

**Profile resolution order:**

1. `--profile <name>` flag (explicit)
2. Auto-select if only one profile exists
3. `"default"` key fallback
4. Error if multiple profiles exist with no default and no `--profile`

### Full Config Reference

```json5
{
  $schema: "...", // Optional: enables IDE autocompletion

  // Azure DevOps profiles
  azure: {
    default: {
      organization: "https://dev.azure.com/your-org", // Required
      defaultProject: "your-project", // Required
      timeoutMs: 60000, // Optional, default 60000
    },
  },

  // Kubernetes cluster profiles
  kubernetes: {
    default: {
      clusterId: "your-cluster-uuid-or-hostname", // Required: used to resolve kubectl context
      namespaces: {
        // Required: named namespace map
        test: "your-test-namespace",
        prod: "your-prod-namespace",
      },
      timeoutMs: 60000, // Optional, default 60000
    },
  },

  // Database profiles
  database: {
    default: {
      environments: {
        // Required: named DB environments
        local: {
          host: "127.0.0.1",
          port: 5432,
          user: "db-user",
          database: "mydb",
          passwordEnvVar: "AGENT_TOOLS_DB_LOCAL_PWD", // Optional: env var name for password
        },
        test: {
          host: "127.0.0.1",
          port: 5432,
          user: "readonly",
          database: "mydb-test",
          passwordEnvVar: "AGENT_TOOLS_DB_TEST_PWD",
        },
      },
      kubectl: {
        // Optional: kubectl tunnel config for remote DBs
        context: "my-kubectl-context",
        namespace: "db-namespace",
      },
      tunnelTimeoutMs: 5000, // Optional
      remotePort: 5432, // Optional
    },
  },

  // Logs profiles
  logs: {
    default: {
      localDir: "apps/web-app/logs", // Required: local log directory
      remotePath: "/app/logs", // Required: path inside pod
    },
  },

  // Global session config (not per-profile)
  session: {
    storagePath: "~/.local/share/opencode/storage", // Default if omitted
  },

  // Global credential guard config (merged with built-in defaults)
  credentialGuard: {
    additionalBlockedPaths: ["private/secrets/"],
    additionalAllowedPaths: ["apps/web-app/.env.test"],
    additionalBlockedCliTools: [{ tool: "kubectl", suggestion: "Use agent-tools-k8s instead" }],
    additionalDangerousBashPatterns: ["rm -rf /"],
  },
}
```

## Environment Variables

Secrets are **never** stored in the config file. Use environment variables instead:

| Variable           | Used By | Description                                               |
| ------------------ | ------- | --------------------------------------------------------- |
| `AGENT_TOOLS_DB_*` | db-tool | DB passwords (name defined by `passwordEnvVar` in config) |
| `GITHUB_TOKEN`     | gh-tool | GitHub API token (falls back to `gh` CLI auth)            |

## credential-guard

Import the credential guard library in your Claude Code hooks or plugins:

```typescript
import { handleToolExecuteBefore } from "@blogic/agent-tools/credential-guard";

// Use in Claude Code hook
export default { handleToolExecuteBefore };
```

The guard blocks:

- Reads of secret files (`.env`, private keys, credentials)
- Dangerous shell patterns (`rm -rf`, `chmod 777`, etc.)
- Execution of blocked CLI tools (configurable)

**Custom patterns** via `credentialGuard` config section — arrays are merged with built-in defaults (not replaced).

```typescript
import { createCredentialGuard } from "@blogic/agent-tools/credential-guard";

const guard = createCredentialGuard({
  additionalBlockedPaths: ["secrets/"],
  additionalAllowedPaths: ["apps/.env.test"],
});
```

## Example Config

See [`examples/agent-tools.json5`](./examples/agent-tools.json5) for a complete example.

## License

MIT
