# @blogic-cz/agent-tools

Safe CLI wrappers for AI coding agents. 9 tools for GitHub, observability, databases, Kubernetes, Azure platform, Azure DevOps, logs, OpenCode sessions, and audit history — with JSON5 config and a credential guard that blocks agents from touching secrets.

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

`effect` is a peer dependency pinned to an exact version, and package managers install
it for you. If your project depends on `effect` too, pin it to the same exact version.
Two copies of `effect` are structurally incompatible types, so the values this package
exports stop typechecking in your project when the versions drift.

### Skill installation

Install per-tool skills for only the tools your project uses:

```bash
npx skills add blogic-cz/agent-tools --path skills/gh-tool
npx skills add blogic-cz/agent-tools --path skills/observability-tool
npx skills add blogic-cz/agent-tools --path skills/db-tool
npx skills add blogic-cz/agent-tools --path skills/k8s-tool
npx skills add blogic-cz/agent-tools --path skills/az-tool
npx skills add blogic-cz/agent-tools --path skills/azdo-tool
npx skills add blogic-cz/agent-tools --path skills/logs-tool
npx skills add blogic-cz/agent-tools --path skills/session-tool
```

Or install the all-in-one skill that covers every tool:

```bash
npx skills add blogic-cz/agent-tools --path skills/agent-tools
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
  bunx gh-tool pr status
  bunx observability-tool trace get <trace-id>
  bunx k8s-tool pods --env test
  ```

**Step 2 — Configure**

Ask the user which tools they need (gh, observability, db, k8s, az, logs, session, audit). Create `agent-tools.json5` in the project root with **only the selected tools configured**. See [`examples/agent-tools.json5`](./examples/agent-tools.json5) for the full config reference with all options documented.

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

1. Run `bun <tool-name> --help` to verify it works (e.g. `bun gh-tool --help`)
2. Summarize the key commands available
3. Show the user what data they have access to based on their `agent-tools.json5` — e.g. which environments, clusters, namespaces, databases, or profiles are configured and reachable

**Step 5 — Skill & Agent Docs**

Install **only the per-tool skills the project needs** (recommended), or the all-in-one skill:

```bash
# Per-tool skills (recommended) — install only what the project uses
npx skills add blogic-cz/agent-tools --path skills/gh-tool
npx skills add blogic-cz/agent-tools --path skills/observability-tool
npx skills add blogic-cz/agent-tools --path skills/db-tool
npx skills add blogic-cz/agent-tools --path skills/k8s-tool
npx skills add blogic-cz/agent-tools --path skills/az-tool
npx skills add blogic-cz/agent-tools --path skills/azdo-tool
npx skills add blogic-cz/agent-tools --path skills/logs-tool
npx skills add blogic-cz/agent-tools --path skills/session-tool

# All-in-one skill (alternative) — all tools in a single skill
npx skills add blogic-cz/agent-tools --path skills/agent-tools
```

**Do not run these commands for the user** — they require interactive selection.

Available per-tool skills:

| Skill                | Install when project uses                   |
| -------------------- | ------------------------------------------- |
| `gh-tool`            | GitHub PRs, issues, workflows, CI checks    |
| `observability-tool` | Tempo traces, Loki logs, Prometheus metrics |
| `db-tool`            | SQL queries, schema introspection           |
| `k8s-tool`           | Kubernetes pods, logs, deployments          |
| `az-tool`            | Azure VMs, web apps, storage, AKS, ACR      |
| `azdo-tool`          | Azure DevOps pipelines, builds              |
| `logs-tool`          | Application log reading (local and remote)  |
| `session-tool`       | OpenCode session history browsing           |
| `agent-tools`        | All of the above in a single skill          |

Then update the project's `AGENTS.md` and/or `CLAUDE.md`:

1. Add rows to the skills table for each installed skill (if one exists):
   ```markdown
   | GitHub PRs, issues, workflows | `gh-tool` |
   | Database queries, schema | `db-tool` |
   ```
2. Add or update the **Tooling** section:

   ```markdown
   ## Tooling

   For tool wrappers and operational patterns, load the relevant tool skill (`gh-tool`, `db-tool`, etc.).
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
  audit: {
    retentionDays: 90,
    dbPath: "~/.agent-tools/audit.sqlite",
  },
  vpns: {
    exampleVpn: {
      // auto defaults to true:
      // darwin -> macos-scutil, linux -> linux-nmcli, win32 -> windows-rasdial
      name: "ExampleVPN",
      // Reuse package-managed connections for 30 seconds after the last command. Set 0 for immediate cleanup.
      idleDisconnectMs: 30000,
      // Total window for stop plus disconnected-status confirmation.
      disconnectTimeoutMs: 10000,
      // Optional: pass IPSec shared secret to macOS scutil from env without storing the value in config.
      secretEnvVar: "EXAMPLE_VPN_IPSEC_SHARED_SECRET",
    },
  },
  kubernetes: {
    default: {
      clusterId: "your-cluster-id",
      namespaces: { test: "your-ns-test", prod: "your-ns-prod" },
      prerequisites: [{ type: "vpn", key: "exampleVpn" }],
      // agent-tools starts disconnected VPNs, shares package-local leases, and disconnects only connections it owns.
    },
  },
  logs: {
    default: {
      localDir: "apps/web-app/logs",
      remotePath: "/app/logs",
    },
  },
  observability: {
    // Profile name (selected via --profile, or used automatically when it's the only one)
    default: {
      // Environment name (selected via --env)
      environments: {
        local: {
          url: "http://localhost:40300",
          prometheusUid: "prometheus",
          lokiUid: "loki",
        },
      },
    },
  },
}
```

3. Run tools:

```bash
bun gh-tool pr status
bun observability-tool trace get 0b7bdf0dde1c55458364ba5588a8075e --env local
bun k8s-tool kubectl --env test --cmd "get pods"
bun logs-tool list --env local
bun audit-tool list --limit 20
```

```bash
bun gh-tool pr review-triage   # interactive summary of PR feedback
bun gh-tool pr watch --prs 12,34 --format jsonl # transition-only multi-PR CI stream
bun k8s-tool pods --env test   # list pods (structured command)
```

4. Hook up the credential guard in your agent config (Claude Code, OpenCode, etc.):

```typescript
import { handleToolExecuteBefore } from "@blogic-cz/agent-tools/credential-guard";

export default { handleToolExecuteBefore };
```

## Tools

| Binary               | Description                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `gh-tool`            | GitHub CLI wrapper — PR management, issues, workflows, composite commands (`review-triage`, `reply-and-resolve`) |
| `observability-tool` | LGTM wrapper — Tempo traces, Loki log correlation, and Prometheus metrics via Grafana                            |
| `audit-tool`         | Audit trail browser — inspect recent tool invocations and purge old entries                                      |
| `db-tool`            | Database query tool — SQL execution, schema introspection                                                        |
| `k8s-tool`           | Kubernetes tool — kubectl wrapper + structured commands (`pods`, `logs`, `describe`, `exec`, `top`)              |
| `az-tool`            | Azure platform tool — read-only inspection of VMs, web apps, storage, AKS, ACR                                   |
| `azdo-tool`          | Azure DevOps tool — pipelines, builds, repos                                                                     |
| `logs-tool`          | Application logs — read local and remote (k8s pod) logs                                                          |
| `session-tool`       | OpenCode session browser — list, read, search sessions                                                           |

All tools support `--help` for full usage documentation. Legacy `agent-tools-*` binary names (e.g. `agent-tools-gh`) still work for backwards compatibility.

### Kubernetes command safety

`k8s-tool` parses generic kubectl commands into arguments and invokes `kubectl` directly. Shell pipelines, chaining, substitution, user overrides of the configured cluster or credentials, mutating `config`/`auth` subcommands, and `cluster-info dump` are rejected. Direct Secret reads, raw kubeconfig output, filename/kustomize reads, and `kubectl diff` are also blocked.

Pod `exec` is limited to direct `redis-cli PING/INFO` and `ls` diagnostics. Generic exec cannot read file contents; use `logs-tool`, which confines files to the configured log directory, tails them through an internal structured operation, and applies the same case-insensitive literal substring filter locally and remotely. Configured log directories are a trusted boundary and must not permit adversarial symlink replacement during reads.

### Azure command safety

Azure is split across two binaries. `azdo-tool` covers Azure DevOps (`pipelines`, `repos`, `devops invoke`); `az-tool` covers the Azure platform (`vm`, `webapp`, `storage`, `aks`, `acr`, `monitor`, …). Sending a DevOps group to `az-tool` fails with a pointer to `azdo-tool` rather than running.

`az-tool` resolves the verb **positionally** — the last word before the first flag — so a flag value can never be read as a command. Only read-only verbs are allowed (`list`, `show`, `describe`, `exists`, `search`, `history`, `version`, `validate`, `wait`, plus the `list-`, `show-`, `check-`, and `get-` families); mutating verbs and unknown verbs are both rejected. Credential reads are blocked regardless of verb: the `get-access-token`/`get-credentials`/`list-keys`/`list-connection-strings`/`list-publishing-profiles` family, and any command whose group path contains `secret`, `secrets`, `key`, `keys`, `credential`, `credentials`, `appsettings`, `admin-key`, `query-key`, `sas`, `password`, or `connection-string` — for those the listing itself returns values (`storage account keys list`, `webapp config appsettings list`). Key Vault is narrower: `keyvault secret list`/`list-versions` return names and attributes and are allowed, `keyvault secret show` is not, and the `key`/`certificate` subgroups are allowed because they expose only public material. Shell syntax is rejected and commands are spawned as an argument vector, never through a shell.

The subscription comes from the `azurePlatform` config profile and is appended to every command; a user-supplied `--subscription` is rejected, and with no `azurePlatform` section the tool refuses to run rather than falling back to whatever `az login` last selected. The set of configured profiles is therefore the allowlist of reachable subscriptions.

Two optional scope guards sit on top. A profile keyed `prod`/`production`, or carrying `production: true`, cannot be reached through auto-selection or the `default` key — `--profile` must name it explicitly, mirroring `k8s-tool`'s refusal of implicit prod. And `allowedResourceGroups` rejects any command naming a group outside the list; an empty or absent list allows every group in the subscription. A group is recognised both from `-g`/`--resource-group` — every occurrence, since the Azure CLI is argparse-based and a repeated flag takes the last value — and from the `/resourceGroups/<name>` segment of a full ARM resource ID passed to a flag such as `--scope` or `--resource`. `--ids` is rejected outright because it carries its own subscription as well as its own resource group, side-stepping both guards. The resource-group check only fires when a command names a group, so subscription-wide reads such as `vm list` remain unrestricted — it guards against touching the wrong group, it does not partition the subscription.

`azdo-tool` keeps its allowlist of read-only operations (`list`, `run`, `show`, `show-tags`) and rejects `create`/`delete`/`update`/`cancel`/`queue` anywhere in the command. `run` is accepted only in the `pipelines` group — `acr run` and `acr task run` execute arbitrary commands in Azure and are blocked. The `acr` and `account` groups remain reachable from `azdo-tool` for backwards compatibility; new work should use `az-tool` for them. Because those two groups address the Azure platform rather than Azure DevOps, the platform credential rules apply to them here as well — `acr credential show` is refused by both tools. The verb and segment lists behind that live in `src/shared/azure-credentials.ts` so the two tools cannot drift apart.

### gh-tool machine contracts

`pr view` adds `headSha` and `baseSha`; failed-check evidence adds the same SHA pair. Review summaries, inline comments, and threads add `commitSha` plus `feedbackOrigin`: `current_head` only for an exact `commitSha === headSha`, `pre_existing` for a different known SHA (not an obsolescence verdict), and `unknown` when either SHA is absent. Issue comments always use `commitSha: null` and `feedbackOrigin: unknown`. `review-triage` preserves existing fields and adds `inlineComments` plus per-kind `feedbackOriginCounts`; batch triage returns the same object per PR. `pr request-review --reviewers alice,bob` emits sorted `submittedReviewers` (normalized input), `newlyRequested` and `alreadyPending` (the submitted logins split by whether a pending request already existed, so a fresh re-request is distinguishable from a no-op), and `requestedReviewers` (GitHub-confirmed result). `pr last-human-reviewer` derives `currentRequestedReviewers` from live `reviewRequests` only; timeline events are not replayed because GitHub clears a pending request on review submit without emitting `ReviewRequestRemovedEvent`.

`pr watch --prs 12,34 --until terminal --format jsonl` accepts at most 50 unique, digits-only PR numbers and emits only JSONL state transitions. Identity uses `repo/pr/headSha/runId/attempt/jobId`; `runId`, `attempt`, and `jobId` are omitted from an event rather than emitted as `null`, and `checkId` is no longer emitted. State/bucket revisions emit even when identity stays stable; `supersedes` appears only when identity changes. Open PRs with no checks become terminal only after three stable empty snapshots, allowing bounded GitHub eventual consistency, and carry `checksObserved: false` — a terminal snapshot with no observed check is never green evidence. `pr checks`, batch checks, triage, and batch triage keep stderr silent with `--format json`; JSONL watch is also informationally silent. Failures still return structured nonzero errors on stderr.

Useful flows:

```bash
bun gh-tool pr checks-failed --pr 123 --with-logs --format json # includes diagnosis
bun gh-tool pr rerun-checks --pr 123 --failed-only --watch --timeout 600
bun gh-tool pr trigger-checks --pr 123 --workflow dotnet-pull-request.yml # only when zero checks reported
bun gh-tool pr watch --prs 123,124 --format jsonl --timeout 600
bun gh-tool pr reply-and-resolve --comment-id 456 --body "Done" # infers PR and thread
bun gh-tool pr request-review --repo be --pr 123 --reviewers alice,bob
# Optional --pr/--thread-id retain legacy flow and are validated before either mutation.
```

Reruns preflight every target before mutation and fail closed with `evidence_unavailable` when attempt jobs or logs cannot be read. Failed jobs use one `gh run rerun RUN --failed` mutation per workflow run. Without `--watch`, output returns current attempt metadata immediately; with `--watch`, discovery and watching share one absolute `--timeout` deadline and report `discovery_timeout` or `watch_timeout` with latest attempt state. Repeated matching pre-test infrastructure failures return `escalation_required` without mutation. See [`skills/gh-tool/SKILL.md`](skills/gh-tool/SKILL.md) for operating guidance; this section is canonical for added output fields.

Zero reported checks is a state, not an error: `gh pr checks` exits nonzero on an empty result, and every command that reads checks maps that to `[]`. `pr trigger-checks` covers the case where GitHub dropped the `pull_request` event and no run exists at all — it dispatches the named `workflow_dispatch` workflow **on the PR head branch**, then compares the created run's `headSha` back to the PR head and reports `matchesPrHead`. A run dispatched on the wrong ref goes green for another branch and must never be read as PR evidence, so `workflow run` also returns the discovered `runId`/`headSha` instead of a bare `dispatched: true`.

`pr feedback` returns the whole inventory by default. Narrow it with `--only visible-open|needs-human-reply|current-head` (narrowed filters drop issue comments), drop bots with `--exclude-authors github-actions,dependabot`, and read `omitted` for what each filter removed. Base64 report payloads in bodies are replaced with `[base64 payload omitted]`; pass `--raw-bodies` to keep them. `review-triage --omit reviews,inlineComments` trims a repeated snapshot to the verdict and check state, and lists what it left out in `omittedSections`.

An empty thread list can mean the reviewer is still drafting: comments inside a pending review are invisible to the API until the reviewer submits, and they keep their draft time in `createdAt`. `pr threads` and `pr comments` therefore also report `reviewId` and `updatedAt`. Equal `reviewId` values mark one submitted batch; join that id to the matching `reviews[].submittedAt` from `pr feedback` for the exact time the batch became visible. `updatedAt` is a cheap proxy for the same moment, but it also moves when someone edits the comment. Never conclude from an older `createdAt` that an earlier scan missed anything.

Call the wrappers through `bun run --silent <tool>` in repos that expose them as package scripts; without `--silent` every invocation echoes the resolved command line into the agent's context.

`audit-tool` reads the same SQLite file the wrappers write to. By default that file lives at `~/.agent-tools/audit.sqlite`, and you can override both path and retention per repo with the global `audit` config section.

## Audit Logging

Every tool invocation is automatically recorded to a local SQLite database — zero configuration required. The audit trail captures which tool ran, what arguments it received, how long it took, whether it succeeded, and which project directory it was called from.

### How it works

Each CLI wrapper (`gh`, `observability`, `k8s`, `db`, `az`, `logs`, `session`, `audit`) writes a row to `~/.agent-tools/audit.sqlite` on every execution. Logging is fire-and-forget — if the database is unavailable or write fails, the tool continues normally. Audit never blocks or slows down your workflow.

Entries older than `retentionDays` (default: 90) are automatically purged on each write.

### Browsing the audit trail

```bash
# Recent 20 entries (default)
bun audit-tool list

# Last 50 entries, JSON format
bun audit-tool list --limit 50 --format json

# Filter by tool
bun audit-tool list --tool gh

# Filter by project directory
bun audit-tool list --project /Users/me/my-repo

# Purge entries older than 30 days
bun audit-tool purge --days 30
```

### Audit Configuration

Both the database path and retention period are configurable in `agent-tools.json5`:

```json5
{
  audit: {
    retentionDays: 90, // days before auto-purge (default: 90)
    dbPath: "~/.agent-tools/audit.sqlite", // database file location
  },
}
```

All settings are optional — audit works out of the box with sensible defaults.

### What gets recorded

| Column      | Description                                                             |
| ----------- | ----------------------------------------------------------------------- |
| `ts`        | ISO 8601 timestamp                                                      |
| `tool`      | Tool name (`gh`, `observability`, `k8s`, `db`, `az`, `logs`, `session`) |
| `project`   | Working directory (`process.cwd()`)                                     |
| `args`      | Command-line arguments (JSON array)                                     |
| `duration`  | Execution time in milliseconds                                          |
| `success`   | `1` (success) or `0` (failure)                                          |
| `error`     | Error message if failed, `null` otherwise                               |
| `exit_code` | Process exit code                                                       |

## Configuration

Config is loaded by walking up from the current working directory to the nearest regular config file:

1. `agent-tools.json`
2. `agent-tools.json5`

That nearest regular config is the base. Local override files are then merged from that directory down to the current working directory:

1. `agent-tools.local.json`
2. `agent-tools.local.json5`

Later files override earlier files. Objects are merged deeply; arrays and primitive values are replaced. Missing config = zero-config mode (works for `gh-tool`; others require config).

Use `agent-tools.local.json5` for machine-specific ports, paths, and worktree overrides. Keep local files gitignored.

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
bun azdo-tool cmd --cmd "pipelines list"                    # uses "default" profile
bun azdo-tool cmd --cmd "pipelines list" --profile legacy   # uses "legacy" profile
```

**Profile resolution:** `--profile` flag > auto-select (single profile) > `"default"` key > error.

### Full Config Reference

See [`examples/agent-tools.json5`](./examples/agent-tools.json5) for a complete example with all options documented.

## Authentication

Each tool uses its own auth method — no unified token store:

| Tool                 | Auth Method                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `gh-tool`            | `gh` CLI session (`gh auth login`) or `GITHUB_TOKEN` env var                                 |
| `observability-tool` | Grafana URL from config plus optional token from `tokenEnvVar`                               |
| `k8s-tool`           | Existing kubectl context (kubeconfig). Cluster ID from config resolves context automatically |
| `az-tool`            | `az` CLI session (`az login`). Subscription pinned by the `azurePlatform` config profile     |
| `azdo-tool`          | `az` CLI session (`az login`)                                                                |
| `db-tool`            | Password from env var defined by `passwordEnvVar` in config (e.g. `AGENT_TOOLS_DB_PASSWORD`) |
| `logs-tool`          | No auth — reads local files or uses k8s-tool for remote access                               |

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

#### Endpoint overrides: `hostEnvVar` and `portEnvVar`

A database environment can also take its `host` and `port` from environment variables:

| Field        | Effect                                                                     |
| ------------ | -------------------------------------------------------------------------- |
| `hostEnvVar` | Name of an environment variable that overrides the literal `host` when set |
| `portEnvVar` | Name of an environment variable that overrides the literal `port` when set |

These are **overrides with fallback**, not requirements — the opposite of `passwordEnvVar`, which fails when its variable is unset:

- variable set to a value → that value wins over the literal in the config;
- variable unset or empty → the literal `host` / `port` in the config is used, and no error is raised;
- `portEnvVar` set to something that is not an integer between 1 and 65535 → the command **fails**. It never falls back to the literal, because that would query a different database while you believe the override applied.

The variable is read from the process environment first (Bun loads `.env` files into it), then from `~/.zshrc` exports.

The typical use is a repository where every git worktree runs its own database container on its own host port, published by that worktree's `.env`:

```json5
{
  database: {
    default: {
      environments: {
        local: {
          host: "127.0.0.1",
          port: 40543, // the main checkout's database
          user: "app",
          database: "app",
          portEnvVar: "APP_POSTGRES_PORT", // a worktree's .env sets this to e.g. 40643
          hostEnvVar: "APP_POSTGRES_HOST", // optional, same fallback rule
          prerequisites: [],
        },
      },
    },
  },
}
```

Run from the main checkout, where `APP_POSTGRES_PORT` is unset, `db-tool` connects to `127.0.0.1:40543`. Run from a worktree whose `.env` sets `APP_POSTGRES_PORT=40643`, the same config connects to `127.0.0.1:40643` — so `db-tool` and `job-tool` inspect that worktree's own database instead of the main checkout's.

Database VPN prerequisites can be set at the database profile or environment level. If an environment declares `vpn` or `prerequisites`, that environment config replaces the profile prerequisites; `prerequisites: []` explicitly disables inherited VPN setup. DB commands try the query directly first and only connect VPN prerequisites if direct access fails. Package-managed VPNs remain reusable for `idleDisconnectMs` (default 30000) after the last lease; `0` restores immediate cleanup. Preconnected or `leave-running` connections are treated as external and never stopped automatically. If runtime state is corrupt, unknown, or contains legacy artifacts, first stop all agent-tools processes using the VPN, then remove that VPN state directory under `~/.agent-tools/runtime/vpn-prerequisites`.

```json5
{
  vpns: {
    officeVpn: { name: "OfficeVPN" },
    prodVpn: { name: "ProdVPN" },
  },
  database: {
    default: {
      vpn: "officeVpn",
      environments: {
        local: {
          host: "127.0.0.1",
          port: 5432,
          user: "app",
          database: "app",
          prerequisites: [], // no VPN for local/direct access
        },
        prod: {
          host: "db.prod.internal",
          port: 5432,
          user: "readonly",
          database: "app",
          passwordEnvVar: "AGENT_TOOLS_DB_PROD_PASSWORD",
          vpn: "prodVpn", // overrides database.default.vpn
        },
      },
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
