import type { FlagSpec } from "./config";
import type { AzSecurityCheckOptions, AzSecurityCheckResult } from "./types";

import {
  APP_FLAG,
  APP_INSIGHTS_DATA_PATHS,
  DEFAULT_LOGIN_TENANT_PATHS,
  AZURE_DEVOPS_GROUPS,
  BLOCKED_VERBS,
  CONTROLLED_FLAGS,
  CREDENTIAL_BLOCKED_SEGMENTS,
  CREDENTIAL_BLOCKED_VERBS,
  ENTRA_GROUP,
  ENTRA_OBJECT_ID_FLAG,
  EXTRA_WORKSPACES_FLAG,
  FILE_REFERENCE_PATTERN,
  KEYVAULT_GROUP,
  KEYVAULT_NAME_ONLY_SUBGROUPS,
  KEYVAULT_PUBLIC_SUBGROUPS,
  KQL_CROSS_RESOURCE_PATTERN,
  KQL_QUERY_GROUPS,
  LOG_ANALYTICS_GROUP,
  MANAGEMENT_GROUP_FLAG,
  ABOVE_SUBSCRIPTION_SUBGROUPS,
  FLAG_PREFIX_PATTERN,
  MANAGEMENT_GROUP_SHORT_FLAG,
  MANAGEMENT_GROUP_SHORT_FLAG_GROUPS,
  SCOPED_SUBGROUP_GROUPS,
  NO_SUBSCRIPTION_FLAG_PATHS,
  READ_ONLY_VERBS,
  READ_ONLY_VERB_PREFIXES,
  REJECTED_ADDRESSING_FLAGS,
  RESOURCE_GROUP_FLAG,
  RESOURCE_GROUP_IN_ID_PATTERN,
  SUBSCRIPTION_IN_ID_PATTERN,
  SUBSCRIPTION_SCOPE_PREFIX,
  TENANT_SCOPE_PATHS,
  UNROOTED_SCOPE_PATTERN,
  DOT_SEGMENT_PATTERN,
  WORKSPACE_FLAG,
} from "./config";

/**
 * Tokenize an az command line into argv. Returns undefined for anything
 * carrying shell syntax, so a command can never expand, chain, or redirect.
 * Quoted regions keep their contents verbatim, which leaves `--query
 * "[?name=='web']"` usable.
 */
export function parseAzCommand(cmd: string): string[] | undefined {
  const argv: string[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (const char of cmd) {
    if (escaped) {
      word += char;
      escaped = false;
      continue;
    }
    if (char === "\n" || char === "\r") return undefined;
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (/[$`;&|<>()]/.test(char)) {
      return undefined;
    } else if (/\s/.test(char)) {
      if (word) {
        argv.push(word);
        word = "";
      }
    } else {
      word += char;
    }
  }

  if (quote || escaped) return undefined;
  if (word) argv.push(word);
  return argv.length ? argv : undefined;
}

/**
 * The leading run of non-flag tokens: the command group path plus its verb.
 * Everything from the first flag onwards is argument territory, so a flag
 * value can never be mistaken for a verb.
 */
function commandHead(argv: readonly string[]): string[] {
  const head: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("-")) break;
    head.push(arg.toLowerCase());
  }
  return head;
}

export function isReadOnlyVerb(verb: string): boolean {
  if ((READ_ONLY_VERBS as readonly string[]).includes(verb)) return true;
  return READ_ONLY_VERB_PREFIXES.some((prefix) => verb.startsWith(prefix));
}

const isListVerb = (verb: string): boolean => verb === "list" || verb.startsWith("list-");

/** The flag part of an argument, so `--flag=value` and `--flag value` compare alike. */
const flagName = (arg: string): string => arg.split("=", 1)[0] ?? "";

/**
 * argparse, which az is built on, accepts any unambiguous prefix of a long
 * option, so `--resource-gr` reaches `--resource-group`. Every prefix is
 * treated as the full flag: that refuses a few unrelated flags such as
 * `--resource` instead of letting an abbreviation through.
 */
const namesLongFlag = (name: string, longFlag: string): boolean =>
  name.length > 2 && name.startsWith("--") && longFlag.startsWith(name);

const findLongFlag = (argv: readonly string[], flags: readonly string[]): string | undefined =>
  argv.find((arg) => flags.some((flag) => namesLongFlag(flagName(arg), flag)));

export const equalsIgnoreCase = (a: string, b: string): boolean =>
  a.toLowerCase() === b.toLowerCase();

/**
 * Every value given to a flag: `--flag v`, `--flag=v`, an abbreviated long
 * form, and the short form spaced, glued (`-gv`), or with `=`. All
 * occurrences are collected, empty `--flag=` ones included, because argparse
 * silently takes the LAST value of a repeated flag. `list` also collects the
 * further values of a space-delimited list flag.
 */
export function flagValues(
  argv: readonly string[],
  flag: FlagSpec,
  { list = false }: { list?: boolean } = {},
): string[] {
  const values: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    let inlineValue: string | undefined;

    if (arg.startsWith("--")) {
      if (!namesLongFlag(flagName(arg), flag.long)) continue;
      const equalsIndex = arg.indexOf("=");
      if (equalsIndex !== -1) inlineValue = arg.slice(equalsIndex + 1);
    } else if (flag.short !== undefined && arg.startsWith(flag.short)) {
      const rest = arg.slice(flag.short.length);
      if (rest) inlineValue = rest.startsWith("=") ? rest.slice(1) : rest;
    } else {
      continue;
    }

    if (inlineValue !== undefined) {
      values.push(inlineValue);
      continue;
    }

    for (let next = argv[i + 1]; next !== undefined && !next.startsWith("-"); next = argv[i + 1]) {
      values.push(next);
      i++;
      if (!list) break;
    }
  }

  return values;
}

const isResourceId = (value: string): boolean => value.toLowerCase().startsWith("/subscriptions/");

/**
 * Every resource group a command names via -g / --resource-group, plus the
 * resource group segment of every ARM resource ID it passes. Empty when the
 * command names none, which for subscription-wide reads like `vm list` is the
 * normal case. A flag value that is itself a resource ID is left to the ID
 * mining, so `--resource <id>` is judged by the group inside the ID.
 */
export function extractResourceGroups(argv: readonly string[]): string[] {
  const groups = flagValues(argv, RESOURCE_GROUP_FLAG).filter((value) => !isResourceId(value));

  for (const arg of argv) {
    for (const match of arg.matchAll(RESOURCE_GROUP_IN_ID_PATTERN)) {
      const group = match[1];
      if (group !== undefined) groups.push(group);
    }
  }

  return groups;
}

/**
 * Why a command's group path is treated as credential-bearing, or undefined if
 * it is not. Key Vault is handled separately from plain segment matching: its
 * `key` and `certificate` subgroups expose public material only, and its
 * `secret` subgroup only leaks on `show`, not on a listing.
 */
function credentialDenialReason(groupPath: readonly string[], verb: string): string | undefined {
  if (groupPath[0] === KEYVAULT_GROUP) {
    const subgroup = groupPath[1];

    if (
      subgroup !== undefined &&
      (KEYVAULT_PUBLIC_SUBGROUPS as readonly string[]).includes(subgroup)
    ) {
      return undefined;
    }

    if (
      subgroup !== undefined &&
      (KEYVAULT_NAME_ONLY_SUBGROUPS as readonly string[]).includes(subgroup) &&
      !isListVerb(verb)
    ) {
      return `'keyvault ${subgroup} ${verb}' returns secret values.`;
    }

    return undefined;
  }

  const segment = groupPath.find((part) =>
    (CREDENTIAL_BLOCKED_SEGMENTS as readonly string[]).includes(part),
  );

  return segment ? `'${segment}' addresses credential material and is blocked.` : undefined;
}

/**
 * An ARM ID carries its own scope, so it must sit inside the pinned
 * subscription. IDs naming another subscription and scopes above any
 * subscription, such as `/` or a management group, are outside it, as are
 * paths with `.`, `..`, or percent-encoded segments. With no pinned
 * subscription to compare against, every ID is.
 */
function isOutsidePinnedScope(arg: string, subscription: string | undefined): boolean {
  for (const match of arg.matchAll(SUBSCRIPTION_IN_ID_PATTERN)) {
    if (subscription === undefined || !equalsIgnoreCase(match[1] ?? "", subscription)) return true;
  }

  const value = arg.replace(FLAG_PREFIX_PATTERN, "").trim();
  // Dot segments collapse, and ARM reads `\\` as `/`, so `./providers/...` or `.\\providers/...` reach the tenant root.
  if (value.split(/[/\\]/).some((segment) => DOT_SEGMENT_PATTERN.test(segment))) return true;

  const rooted = UNROOTED_SCOPE_PATTERN.test(value) ? `/${value}` : value;
  if (!rooted.startsWith("/")) return false;

  const pinnedScope = SUBSCRIPTION_SCOPE_PREFIX.exec(rooted);
  return (
    !pinnedScope ||
    subscription === undefined ||
    !equalsIgnoreCase(pinnedScope[1] ?? "", subscription)
  );
}

type Denial = { reason: string; hint: string };

/** Whether the command's group path and verb start with one of `paths`, word by word. */
const startsWithPath = (head: readonly string[], paths: readonly string[]): boolean => {
  const path = head.join(" ");
  return paths.some((prefix) => path === prefix || path.startsWith(`${prefix} `));
};

/** Reads above the pinned subscription, by command path or by a management group flag. */
const readsAboveSubscription = (argv: readonly string[], head: readonly string[]): boolean => {
  const group = head[0] ?? "";
  const groupPath = head.slice(1, -1);

  return (
    startsWithPath(head, TENANT_SCOPE_PATHS) ||
    ((SCOPED_SUBGROUP_GROUPS as readonly string[]).includes(group) &&
      groupPath.some((part) =>
        (ABOVE_SUBSCRIPTION_SUBGROUPS as readonly string[]).includes(part),
      )) ||
    findLongFlag(argv, [MANAGEMENT_GROUP_FLAG.long]) !== undefined ||
    ((MANAGEMENT_GROUP_SHORT_FLAG_GROUPS as readonly string[]).includes(group) &&
      argv.some((arg) => !arg.startsWith("--") && arg.startsWith(MANAGEMENT_GROUP_SHORT_FLAG)))
  );
};

type ObservabilityCommand = {
  readonly isKqlQuery: boolean;
  readonly isLogAnalyticsQuery: boolean;
  readonly isAppInsightsData: boolean;
};

/**
 * KQL queries and App Insights data reads address their target by GUID, by a
 * resource ID, or from inside the query text, none of which the subscription
 * pin covers. These rules keep the target inside the pinned scope; the
 * workspace GUID itself is verified against the subscription at run time.
 */
function observabilityDenial(
  args: readonly string[],
  command: ObservabilityCommand,
  workspaces: readonly string[],
): Denial | undefined {
  if (command.isKqlQuery && args.some((arg) => KQL_CROSS_RESOURCE_PATTERN.test(arg))) {
    return {
      reason:
        "The query reaches data outside the addressed resource through a cross-resource function or externaldata.",
      hint: "Query one workspace or app at a time, without workspace(), app(), resource(), adx(), arg(), cluster(), database(), or externaldata.",
    };
  }

  if (command.isLogAnalyticsQuery) {
    // Exact match: every shorter prefix of --workspaces is ambiguous with --workspace, which az refuses.
    if (args.some((arg) => flagName(arg) === EXTRA_WORKSPACES_FLAG)) {
      return {
        reason: `'${EXTRA_WORKSPACES_FLAG}' adds workspaces that the profile cannot verify.`,
        hint: "Query one workspace per command with --workspace.",
      };
    }
    if (workspaces.length === 0) {
      return {
        reason: "A Log Analytics query must name its workspace with --workspace.",
        hint: 'List workspace customer IDs with: monitor log-analytics workspace list --query "[].{name:name,id:customerId}"',
      };
    }
  }

  if (command.isAppInsightsData) {
    // An empty or ID-valued -g leaves the extension using --app as given, which may be any app's GUID.
    const groups = flagValues(args, RESOURCE_GROUP_FLAG);
    if (groups.length === 0 || groups.some((value) => value === "" || isResourceId(value))) {
      return {
        reason: "App Insights data commands must name the app's resource group with -g.",
        hint: "Without -g, --app is used as given, so a GUID can reach an app outside the pinned subscription. Pass --app <name> -g <resource-group>.",
      };
    }
    if (flagValues(args, APP_FLAG, { list: true }).some((value) => value.includes("/"))) {
      return {
        reason: "A resource ID passed to --app carries its own subscription and resource group.",
        hint: "Pass the app name with --app and its resource group with -g.",
      };
    }
  }

  return undefined;
}

export function isAzCommandAllowed(
  cmd: string,
  options?: AzSecurityCheckOptions,
): AzSecurityCheckResult {
  const argv = parseAzCommand(cmd);

  if (!argv) {
    return {
      allowed: false,
      command: cmd,
      reason: "Empty, malformed, or shell syntax command.",
      hint: "Pass a single az command without pipes, redirects, substitution, or chaining.",
    };
  }

  const head = commandHead(argv);
  const verb = head.at(-1);

  if (!verb) {
    return {
      allowed: false,
      command: cmd,
      reason: "Command must start with an Azure CLI command group.",
      hint: 'Example: "vm list", "webapp show --name my-app --resource-group my-rg".',
    };
  }

  const groupPath = head.slice(0, -1);
  const group = head[0];

  const denied = (reason: string, hint?: string): AzSecurityCheckResult => ({
    allowed: false,
    command: cmd,
    verb,
    reason,
    ...(hint ? { hint } : {}),
  });

  if (group && (AZURE_DEVOPS_GROUPS as readonly string[]).includes(group)) {
    return denied(
      `'${group}' is an Azure DevOps command group, not an Azure platform one.`,
      `Use azdo-tool instead: bun azdo-tool cmd --cmd "${cmd}"`,
    );
  }

  const isEntra = group === ENTRA_GROUP;
  if (isEntra && !options?.allowEntra) {
    return denied(
      "Entra ID ('ad') commands are not enabled for this profile.",
      "Entra reads are tenant-wide. Ask the user to set allowEntra: true on the azurePlatform profile if they want them.",
    );
  }

  if (readsAboveSubscription(argv, head) && !options?.allowTenantScope) {
    return denied(
      "This command reads above the pinned subscription: the tenant, a management group, billing, or reservations.",
      "Ask the user to set allowTenantScope: true on the azurePlatform profile if they want tenant-wide reads.",
    );
  }

  if ((CREDENTIAL_BLOCKED_VERBS as readonly string[]).includes(verb)) {
    return denied(
      `'${verb}' returns credential material and is blocked.`,
      "Read secrets from the Azure portal or Key Vault directly, outside the agent session.",
    );
  }

  const credentialReason = credentialDenialReason(groupPath, verb);
  if (credentialReason) {
    return denied(
      credentialReason,
      "Read secrets from the Azure portal or Key Vault directly, outside the agent session.",
    );
  }

  if ((BLOCKED_VERBS as readonly string[]).includes(verb)) {
    return denied(
      `'${verb}' is a mutating operation blocked for AI agents. Only read-only operations are allowed: ${READ_ONLY_VERBS.join(", ")}, and the ${READ_ONLY_VERB_PREFIXES.join("/")} families.`,
    );
  }

  const isKqlQuery =
    verb === "query" && (KQL_QUERY_GROUPS as readonly string[]).includes(groupPath.join(" "));

  if (!isKqlQuery && !isReadOnlyVerb(verb)) {
    return denied(
      `Unknown Azure CLI verb '${verb}'. Only known read-only operations are allowed: ${READ_ONLY_VERBS.join(", ")}, and the ${READ_ONLY_VERB_PREFIXES.join("/")} families.`,
    );
  }

  const fileReference = argv.find((arg) => FILE_REFERENCE_PATTERN.test(arg));
  if (fileReference) {
    return denied(
      `'${fileReference}' makes az read the argument from a file, which the guards cannot inspect.`,
      "Pass the value inline instead. This includes JMESPath: write `[].name` rather than `@[].name`.",
    );
  }

  const controlledFlag = findLongFlag(argv, CONTROLLED_FLAGS);
  if (controlledFlag) {
    return denied(
      `Flag '${flagName(controlledFlag)}' is controlled by the selected profile.`,
      "Remove the override and select the intended azurePlatform profile with --profile instead.",
    );
  }

  const addressingFlag = argv.find(
    (arg) =>
      REJECTED_ADDRESSING_FLAGS.some((flag) => namesLongFlag(flagName(arg), flag)) &&
      !(isEntra && flagName(arg) === ENTRA_OBJECT_ID_FLAG),
  );
  if (addressingFlag) {
    return denied(
      `Flag '${flagName(addressingFlag)}' takes a full ARM resource ID, which carries its own subscription and resource group.`,
      "Address the resource within the pinned scope instead, using --resource-group and --name.",
    );
  }

  const outsideScope = argv.find((arg) => isOutsidePinnedScope(arg, options?.subscription));
  if (outsideScope !== undefined) {
    return denied(
      `'${outsideScope}' addresses a scope outside the pinned subscription.`,
      "Select the profile pinned to that subscription with --profile. A profile pinned by subscription name cannot take resource IDs; pin it by ID.",
    );
  }

  const command: ObservabilityCommand = {
    isKqlQuery,
    isLogAnalyticsQuery: isKqlQuery && groupPath.join(" ") === LOG_ANALYTICS_GROUP,
    isAppInsightsData: startsWithPath(head, APP_INSIGHTS_DATA_PATHS),
  };
  const workspaces = command.isLogAnalyticsQuery ? flagValues(argv, WORKSPACE_FLAG) : [];

  const observability = observabilityDenial(argv.slice(head.length), command, workspaces);
  if (observability) return denied(observability.reason, observability.hint);

  const scope = {
    ...(startsWithPath(head, NO_SUBSCRIPTION_FLAG_PATHS) ? { omitsSubscription: true } : {}),
    ...(startsWithPath(head, DEFAULT_LOGIN_TENANT_PATHS) ? { usesDefaultLoginTenant: true } : {}),
    ...(command.isLogAnalyticsQuery ? { workspaces } : {}),
  };

  // An empty or absent allowlist means the whole subscription is in scope.
  const allowedResourceGroups = options?.allowedResourceGroups;
  if (allowedResourceGroups && allowedResourceGroups.length > 0) {
    const namedGroups = extractResourceGroups(argv);
    const offendingGroup = namedGroups.find(
      (named) => !allowedResourceGroups.some((allowed) => equalsIgnoreCase(allowed, named)),
    );

    if (offendingGroup !== undefined) {
      const abbreviation = argv
        .map(flagName)
        .find(
          (name) =>
            name !== RESOURCE_GROUP_FLAG.long && namesLongFlag(name, RESOURCE_GROUP_FLAG.long),
        );
      return {
        allowed: false,
        command: cmd,
        verb,
        resourceGroup: offendingGroup,
        reason: `Resource group '${offendingGroup}' is not allowed by this profile.`,
        hint: `Allowed resource groups: ${allowedResourceGroups.join(", ")}.${abbreviation ? ` '${abbreviation}' counts as --resource-group; pass --resource as a full resource ID.` : ""}`,
      };
    }

    const [firstGroup] = namedGroups;
    return {
      allowed: true,
      command: cmd,
      argv,
      verb,
      ...(firstGroup ? { resourceGroup: firstGroup } : {}),
      ...scope,
    };
  }

  return { allowed: true, command: cmd, argv, verb, ...scope };
}
