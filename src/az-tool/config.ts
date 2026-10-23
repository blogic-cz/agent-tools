/** Command groups owned by azdo-tool. Routed there with a hint instead of being run here. */
export const AZURE_DEVOPS_GROUPS = ["devops", "pipelines", "repos", "boards", "artifacts"] as const;

/** Verbs that only read state, matched exactly against the command verb. */
export const READ_ONLY_VERBS = [
  "list",
  "show",
  "describe",
  "exists",
  "search",
  "history",
  "version",
  "validate",
  "wait",
] as const;

/** Verb families that only read state, matched as a prefix of the command verb. */
export const READ_ONLY_VERB_PREFIXES = ["list-", "show-", "check-", "get-"] as const;

/**
 * Mutating verbs. Unknown verbs are rejected anyway; this list exists so the
 * common cases get "'delete' is a mutating operation" instead of "unknown verb".
 */
export const BLOCKED_VERBS = [
  "add",
  "apply",
  "approve",
  "assign",
  "attach",
  "browse",
  "cancel",
  "clear",
  "connect",
  "create",
  "delete",
  "deploy",
  "destroy",
  "detach",
  "disable",
  "down",
  "download",
  "enable",
  "execute",
  "failover",
  "generate",
  "grant",
  "import",
  "init",
  "install",
  "invoke",
  "login",
  "logout",
  "move",
  "patch",
  "publish",
  "prune",
  "purge",
  "regenerate",
  "reject",
  "remove",
  "renew",
  "repair",
  "replace",
  "reset",
  "restart",
  "restore",
  "revoke",
  "rotate",
  "run",
  "scale",
  "set",
  "ssh",
  "start",
  "stop",
  "swap",
  "sync",
  "tunnel",
  "unassign",
  "uninstall",
  "untag",
  "up",
  "update",
  "upgrade",
  "upload",
] as const;

/**
 * Credential-bearing verbs and group segments live in `#shared` because
 * azdo-tool's `acr`/`account` passthrough must refuse exactly the same
 * commands. Re-exported here so this file stays the single place az-tool's
 * security config is read from.
 *
 * Segment matching keeps neighbouring groups reachable: `keyvault list` works
 * because the blocked segment is `secret`, not `keyvault`. Key Vault gets a
 * further carve-out below.
 */
export { CREDENTIAL_BLOCKED_SEGMENTS, CREDENTIAL_BLOCKED_VERBS } from "#shared/azure-credentials";

/** The Key Vault command group, which needs finer treatment than segment matching. */
export const KEYVAULT_GROUP = "keyvault";

/**
 * Key Vault subgroups that expose public material only — a key's public JWK, a
 * certificate's public half. The private halves live under `secret`, which
 * stays gated. Without this, segment matching on `key` would block the whole
 * `az keyvault key` surface for no gain.
 */
export const KEYVAULT_PUBLIC_SUBGROUPS = ["key", "certificate"] as const;

/**
 * Key Vault subgroups where listing is metadata-only but `show` returns the
 * value. `az keyvault secret list` yields ids, attributes, and tags — no
 * secret material — so the list family is allowed and `show` is not.
 */
export const KEYVAULT_NAME_ONLY_SUBGROUPS = ["secret", "secrets"] as const;

/**
 * Flags controlled by the selected profile. A user override would defeat the
 * configured subscription pin, so they are rejected rather than forwarded.
 */
export const CONTROLLED_FLAGS = ["--subscription"] as const;

/**
 * Alternate addressing modes rejected outright. `--ids` takes a full ARM
 * resource ID that carries its own subscription and resource group, so it
 * side-steps both the subscription pin and the resource group allowlist.
 * `-g` plus `--name` expresses the same target inside the guarded scope.
 */
export const REJECTED_ADDRESSING_FLAGS = ["--ids"] as const;

/** A flag's long and optional short spelling, as argparse accepts them. */
export type FlagSpec = { readonly long: string; readonly short?: string };

/** The flag naming the resource group a command addresses. */
export const RESOURCE_GROUP_FLAG: FlagSpec = { long: "--resource-group", short: "-g" };

/** The subscription segment of an ARM resource ID, which must match the pinned one. */
export const SUBSCRIPTION_IN_ID_PATTERN = /\/subscriptions\/([^/\s]+)/gi;

/** A value that is an ARM ID at or below one subscription. Any other `/`-rooted value is a wider scope. */
export const SUBSCRIPTION_SCOPE_PREFIX = /^\/subscriptions\/([^/\s]+)(?:\/|$)/i;

/** A path segment that is `.` or `..`, or carries a percent-encoded `.`, `/`, or `\`. */
export const DOT_SEGMENT_PATTERN = /^\.{1,2}$|%2e|%2f|%5c/i;

/** ARM ID roots az accepts without the leading `/`, which it adds itself. */
export const UNROOTED_SCOPE_PATTERN = /^(?:subscriptions|providers)\//i;

/**
 * An argument az replaces with a file's content. az splits every argument on
 * its first `=` and loads the rest when it starts with `@`, so `@q.kql`,
 * `--flag=@q.kql`, and a KQL value `let x=@q.kql` all load a file the guards
 * never see.
 */
export const FILE_REFERENCE_PATTERN = /^(?:@|[^=]*=@)/;

/**
 * The Entra ID (Microsoft Graph) command group. It is tenant-wide, rejects
 * --subscription, and reads the directory of the default az login, so a
 * profile has to opt in with allowEntra.
 */
export const ENTRA_GROUP = "ad";

/** Entra addresses directory objects with --id, an object GUID rather than an ARM resource ID. */
export const ENTRA_OBJECT_ID_FLAG = "--id";

/**
 * Command paths that read above the pinned subscription: the tenant, its
 * management groups, billing, and reservations. A profile opts in with
 * allowTenantScope.
 */
export const TENANT_SCOPE_PATHS = [
  "account list",
  "account tenant",
  "account subscription",
  "account alias",
  "account management-group",
  "private-link association",
  "billing",
  "consumption reservation",
  "reservations",
  "managementpartner",
  "monitor sli",
  "data-boundary",
] as const;

/** Selects a management group scope on otherwise subscription-scoped commands. Its prefixes include --management-group. */
export const MANAGEMENT_GROUP_FLAG: FlagSpec = { long: "--management-group-id" };

/**
 * Groups where -m is short for the management group. Elsewhere -m means
 * something else (`consumption usage list -m` includes meter details), so it
 * is only read as a scope inside these.
 */
export const MANAGEMENT_GROUP_SHORT_FLAG_GROUPS = [
  "policy",
  "deployment",
  "stack",
  "stack-whatif",
  "private-link",
] as const;
export const MANAGEMENT_GROUP_SHORT_FLAG = "-m";

/**
 * Groups that nest a scope subgroup at any depth (`deployment tenant`,
 * `deployment operation mg`), and the subgroup names that leave the
 * subscription.
 */
export const SCOPED_SUBGROUP_GROUPS = ["deployment", "stack", "stack-whatif"] as const;
export const ABOVE_SUBSCRIPTION_SUBGROUPS = ["tenant", "mg"] as const;

/** A flag glued to its value: `--flag=`, `-f=`, or `-f`. What follows is the value. */
export const FLAG_PREFIX_PATTERN = /^(?:--[^=]+=|-[A-Za-z]=?)/;

/** Command paths that reject --subscription, which az-tool then leaves off. */
export const NO_SUBSCRIPTION_FLAG_PATHS = [
  "ad",
  "account list",
  "account management-group",
] as const;

/** Groups whose `query` verb runs KQL. The query APIs only read. */
export const KQL_QUERY_GROUPS = ["monitor app-insights", "monitor log-analytics"] as const;

/** The group whose `query` verb takes a workspace GUID that no subscription scopes. */
export const LOG_ANALYTICS_GROUP = "monitor log-analytics";

/**
 * App Insights data-plane commands. The extension takes their token from the
 * default az login, not the pinned subscription, and resolves `--app` inside
 * the pinned subscription only when it is a name paired with -g.
 */
export const APP_INSIGHTS_DATA_PATHS = [
  "monitor app-insights query",
  "monitor app-insights events",
  "monitor app-insights metrics",
] as const;

/**
 * Command paths that authenticate against the default az login whatever
 * --subscription says, so they run only when its tenant is the pinned one's.
 */
export const DEFAULT_LOGIN_TENANT_PATHS = [
  "ad",
  "account management-group",
  ...APP_INSIGHTS_DATA_PATHS,
] as const;

/** The Log Analytics workspace customer ID a query runs against. */
export const WORKSPACE_FLAG: FlagSpec = { long: "--workspace", short: "-w" };

/** Lists further targets for one query, outside the profile's scope checks. */
export const EXTRA_WORKSPACES_FLAG = "--workspaces";

/** The App Insights app. `query` spells it --apps; `--app` elsewhere is an abbreviation of it. */
export const APP_FLAG: FlagSpec = { long: "--apps", short: "-a" };

/** KQL that reaches data outside the addressed workspace or app. */
export const KQL_CROSS_RESOURCE_PATTERN =
  /\b(?:workspace|app|resource|adx|arg|cluster|database)['"\]\s]*\(|\bexternaldata\b/i;

/**
 * The resource group segment of an ARM resource ID. Flags such as `--scope`
 * and `--resource` take a full ID, naming a resource group without ever using
 * -g, so IDs are mined for group names too.
 */
export const RESOURCE_GROUP_IN_ID_PATTERN = /\/resourceGroups\/([^/\s]+)/gi;

export type ReadOnlyVerb = (typeof READ_ONLY_VERBS)[number];
export type BlockedVerb = (typeof BLOCKED_VERBS)[number];
export type AzureDevOpsGroup = (typeof AZURE_DEVOPS_GROUPS)[number];
