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
 * Read-shaped verbs that return credential material. Blocked in every group,
 * because the read-only verb families above would otherwise admit them.
 */
export const CREDENTIAL_BLOCKED_VERBS = [
  "get-access-token",
  "get-credentials",
  "get-secrets",
  "list-account-keys",
  "list-connection-strings",
  "list-keys",
  "list-publishing-credentials",
  "list-publishing-profiles",
  "list-secrets",
  "show-connection-string",
  "show-secret",
] as const;

/**
 * Group-path segments that carry credential material. A command whose group
 * path contains one is blocked regardless of verb, because for these the
 * listing itself returns values — `az storage account keys list` and
 * `az webapp config appsettings list` both print secrets.
 *
 * Segment matching keeps neighbouring groups reachable: `keyvault list` works
 * because the blocked segment is `secret`, not `keyvault`. Key Vault gets a
 * further carve-out below.
 */
export const CREDENTIAL_BLOCKED_SEGMENTS = [
  "admin-key",
  "appsettings",
  "connection-string",
  "credential",
  "credentials",
  "key",
  "keys",
  "password",
  "query-key",
  "sas",
  "secret",
  "secrets",
] as const;

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

/** Flags naming the resource group a command addresses. */
export const RESOURCE_GROUP_FLAGS = ["-g", "--resource-group"] as const;

/**
 * The resource group segment of an ARM resource ID. Flags such as `--scope`
 * and `--resource` take a full ID, naming a resource group without ever using
 * -g, so IDs are mined for group names too.
 */
export const RESOURCE_GROUP_IN_ID_PATTERN = /\/resourceGroups\/([^/\s]+)/gi;

export type ReadOnlyVerb = (typeof READ_ONLY_VERBS)[number];
export type BlockedVerb = (typeof BLOCKED_VERBS)[number];
export type AzureDevOpsGroup = (typeof AZURE_DEVOPS_GROUPS)[number];
