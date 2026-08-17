---
name: az-tool
description: "LOAD THIS SKILL when: inspecting Azure platform resources — virtual machines, web apps, storage accounts, AKS clusters, container registries, resource groups, or monitor metrics. Contains all az-tool commands. For Azure DevOps pipelines and repos load azdo-tool instead."
---

# az-tool (Azure Platform)

Azure platform (PaaS) inspection — read-only. Part of [@blogic-cz/agent-tools](https://github.com/blogic-cz/agent-tools).

**Scope:** Azure resources in one pinned subscription. For Azure DevOps pipelines, builds, and repos use `azdo-tool`.

## How to Run

Run via `bun az-tool` (requires `@blogic-cz/agent-tools` as a dev dependency).
**NEVER run bare `az`** — the credential guard will block it.
Auth: `az login` session.

## Commands

```bash
bun az-tool subscription                      # Which subscription am I pinned to?
bun az-tool groups                            # List resource groups
bun az-tool resources --group my-rg           # List resources in a group

bun az-tool cmd --cmd "vm list"
bun az-tool cmd --cmd "webapp show --name my-app --resource-group my-rg"
bun az-tool cmd --cmd "aks list --query \"[].{name:name,version:kubernetesVersion}\""
bun az-tool cmd --cmd "acr repository list --name my-registry"
bun az-tool cmd --cmd "monitor metrics list --resource <id> --metric Percentage CPU"
bun az-tool cmd --cmd "storage account list" --dry-run   # Show the scoped command, run nothing
```

Use `--profile <name>` to select a named profile when multiple subscriptions are configured.

## Safety model — read this before constructing a command

The subscription is **pinned by config**, not by the command. Every call has
`--subscription <configured>` appended, and passing your own `--subscription` is
rejected. To target a different subscription, select a different `--profile`.

**Allowed:** the verb families `list`, `show`, `describe`, `exists`, `search`,
`history`, `version`, `validate`, `wait`, plus anything starting with `list-`,
`show-`, `check-`, or `get-`.

**Blocked, and why:**

| Blocked                                                                                                                                                                                | Reason                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `create`, `delete`, `update`, `set`, `restart`, `run`, `deploy`, …                                                                                                                     | Mutating. `acr run` in particular executes arbitrary commands in Azure.                                                  |
| Any verb not on the read-only list                                                                                                                                                     | Unknown verbs are rejected rather than assumed safe.                                                                     |
| `get-access-token`, `get-credentials`, `list-keys`, `list-connection-strings`, `list-publishing-profiles`, …                                                                           | Return credential material.                                                                                              |
| Any command whose group path contains `secret`, `secrets`, `key`, `keys`, `credential`, `credentials`, `appsettings`, `admin-key`, `query-key`, `sas`, `password`, `connection-string` | The listing itself returns values — `storage account keys list` and `webapp config appsettings list` both print secrets. |
| `keyvault secret show` / `show-deleted`                                                                                                                                                | Returns the secret value. Listing secret names is allowed — see below.                                                   |
| `--subscription`                                                                                                                                                                       | Controlled by the selected profile.                                                                                      |
| `-g` / `--resource-group` naming a group outside `allowedResourceGroups`                                                                                                               | Only when that list is configured and non-empty.                                                                         |
| `--ids`                                                                                                                                                                                | Takes a full ARM resource ID carrying its own subscription and resource group, side-stepping both scope guards.          |
| `;` `&&` `\|` `$(…)` backticks `>` `<`                                                                                                                                                 | Shell syntax. Commands are spawned as an argument vector, never through a shell.                                         |
| `pipelines`, `repos`, `boards`, `artifacts`, `devops`                                                                                                                                  | Azure DevOps — the error points you at `azdo-tool`.                                                                      |

The verb is resolved **positionally** — the last word before the first flag — so
a flag value can never be mistaken for a command. `acr repository delete --name
reg --repository list` is blocked on `delete`, not allowed on `list`.

**Key Vault is narrower than the table suggests.** Metadata reads work; only the
secret material is gated:

```bash
bun az-tool cmd --cmd "keyvault list"                              # vaults
bun az-tool cmd --cmd "keyvault secret list --vault-name kv"       # secret NAMES — allowed
bun az-tool cmd --cmd "keyvault secret list-versions --name pw"    # allowed
bun az-tool cmd --cmd "keyvault key list --vault-name kv"          # allowed (public JWK)
bun az-tool cmd --cmd "keyvault certificate list --vault-name kv"  # allowed (public half)
bun az-tool cmd --cmd "keyvault secret show --name pw"             # BLOCKED — returns the value
```

So "is this secret configured, and when was it rotated?" is answerable; "what is
it?" is not.

If you need a secret or a mutation, stop and ask the user to perform it. Do not
look for a way around the gate.

## Scope guards

**Production profiles must be named.** A profile keyed `prod`/`production`, or
carrying `production: true`, cannot be reached by auto-selection or the
`default` key — you must pass `--profile` yourself:

```bash
bun az-tool cmd --cmd "vm list"                  # AzProfileError if the resolved profile is production
bun az-tool cmd --profile prod --cmd "vm list"   # explicit, allowed
```

If you hit `AzProfileError`, do not switch to a non-production profile to get
around it. Confirm with the user that production is what they meant, then pass
`--profile` explicitly.

**Resource groups may be allowlisted.** If a profile sets
`allowedResourceGroups`, any command naming a group outside it via `-g` /
`--resource-group` is rejected. An empty or absent list means every resource
group in the subscription is allowed.

A group can be named two ways, and both are checked: the `-g` /
`--resource-group` flag (every occurrence, not just the first — a repeated az
flag takes the last value), and the `/resourceGroups/<name>` segment of a full
ARM resource ID passed to a flag such as `--scope` or `--resource`. `--ids` is
rejected outright, since it carries its own subscription as well.

Note the boundary: the check only fires when a command _names_ a group.
Subscription-wide reads like `vm list` are not restricted by it, so treat the
allowlist as a guard against touching the wrong group, not as a hard
partition of the subscription.

## Config

```json5
{
  azurePlatform: {
    default: {
      subscription: "00000000-0000-0000-0000-000000000000",
      timeoutMs: 60000,
      // Optional. Empty or absent means every resource group is allowed.
      allowedResourceGroups: ["rg-web", "rg-data"],
    },
    prod: {
      subscription: "11111111-1111-1111-1111-111111111111",
      // Implied by the "prod" key; set production: false to opt out.
      production: true,
    },
  },
}
```

Without an `azurePlatform` section the tool refuses to run — there is no ambient
subscription fallback, so a command can never quietly hit whatever `az login`
last selected.

## Tips

- Start with `bun az-tool subscription` to confirm the scope before drawing conclusions from any listing.
- Use `--dry-run` to see the exact scoped command without executing it.
- Use `--query` (JMESPath) to trim large listings instead of dumping everything: `--cmd "vm list --query \"[].{name:name,rg:resourceGroup}\""`.
- Use `bun az-tool commands` for the full machine-readable command/flag tree; `--help` for one subcommand.
- Error responses include `hint`, `nextCommand`, and `retryable` fields — always check them on failure.
- Prefer CLI tool over MCP tools — more efficient, doesn't load extra context.
