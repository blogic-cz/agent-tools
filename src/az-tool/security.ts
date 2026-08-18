import type { AzSecurityCheckOptions, AzSecurityCheckResult } from "./types";

import {
  AZURE_DEVOPS_GROUPS,
  BLOCKED_VERBS,
  CONTROLLED_FLAGS,
  CREDENTIAL_BLOCKED_SEGMENTS,
  CREDENTIAL_BLOCKED_VERBS,
  KEYVAULT_GROUP,
  KEYVAULT_NAME_ONLY_SUBGROUPS,
  KEYVAULT_PUBLIC_SUBGROUPS,
  READ_ONLY_VERBS,
  READ_ONLY_VERB_PREFIXES,
  REJECTED_ADDRESSING_FLAGS,
  RESOURCE_GROUP_FLAGS,
  RESOURCE_GROUP_IN_ID_PATTERN,
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
 * Every resource group a command names via -g / --resource-group, in either the
 * spaced or the `=` form. Empty when the command names none, which for
 * subscription-wide reads like `vm list` is the normal case.
 *
 * All occurrences are collected, not just the first: the Azure CLI is argparse
 * based, so a repeated flag silently takes the LAST value. Validating only the
 * first would let `-g allowed -g denied` through while az ran against `denied`.
 */
export function extractResourceGroups(argv: readonly string[]): string[] {
  const groups: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    const equalsIndex = arg.indexOf("=");
    const flag = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
    if (!(RESOURCE_GROUP_FLAGS as readonly string[]).includes(flag)) continue;

    if (equalsIndex !== -1) {
      const inlineValue = arg.slice(equalsIndex + 1);
      if (inlineValue.length > 0) groups.push(inlineValue);
      continue;
    }

    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("-")) {
      groups.push(next);
      i++;
    }
  }

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

  if (!isReadOnlyVerb(verb)) {
    return denied(
      `Unknown Azure CLI verb '${verb}'. Only known read-only operations are allowed: ${READ_ONLY_VERBS.join(", ")}, and the ${READ_ONLY_VERB_PREFIXES.join("/")} families.`,
    );
  }

  const controlledFlag = argv.find((arg) =>
    (CONTROLLED_FLAGS as readonly string[]).includes(flagName(arg)),
  );
  if (controlledFlag) {
    return denied(
      `Flag '${flagName(controlledFlag)}' is controlled by the selected profile.`,
      "Remove the override and select the intended azurePlatform profile with --profile instead.",
    );
  }

  const addressingFlag = argv.find((arg) =>
    (REJECTED_ADDRESSING_FLAGS as readonly string[]).includes(flagName(arg)),
  );
  if (addressingFlag) {
    return denied(
      `Flag '${flagName(addressingFlag)}' takes a full ARM resource ID, which carries its own subscription and resource group.`,
      "Address the resource within the pinned scope instead, using --resource-group and --name.",
    );
  }

  // An empty or absent allowlist means the whole subscription is in scope.
  const allowedResourceGroups = options?.allowedResourceGroups;
  if (allowedResourceGroups && allowedResourceGroups.length > 0) {
    const namedGroups = extractResourceGroups(argv);
    const offendingGroup = namedGroups.find(
      (named) =>
        !allowedResourceGroups.some((allowed) => allowed.toLowerCase() === named.toLowerCase()),
    );

    if (offendingGroup !== undefined) {
      return {
        allowed: false,
        command: cmd,
        verb,
        resourceGroup: offendingGroup,
        reason: `Resource group '${offendingGroup}' is not allowed by this profile.`,
        hint: `Allowed resource groups: ${allowedResourceGroups.join(", ")}.`,
      };
    }

    const [firstGroup] = namedGroups;
    return {
      allowed: true,
      command: cmd,
      argv,
      verb,
      ...(firstGroup ? { resourceGroup: firstGroup } : {}),
    };
  }

  return { allowed: true, command: cmd, argv, verb };
}
