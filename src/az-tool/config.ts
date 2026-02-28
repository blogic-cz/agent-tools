export const ALLOWED_SUBCOMMANDS = ["list", "run", "show", "show-tags"] as const;

export const BLOCKED_SUBCOMMANDS = ["create", "delete", "update", "cancel", "queue"] as const;

export const DIRECT_AZ_COMMANDS = ["pipelines", "repos"] as const;

export const STANDALONE_AZ_COMMANDS = ["acr", "account"] as const;

export const ALLOWED_INVOKE_AREAS = ["build"] as const;

export const ALLOWED_INVOKE_RESOURCES: Record<string, readonly string[]> = {
  build: ["timeline", "logs", "builds"],
} as const;

export const BLOCKED_INVOKE_AREAS = [
  "git",
  "policy",
  "security",
  "wiki",
  "work",
  "graph",
  "audit",
  "permissions",
] as const;

export const BLOCKED_INVOKE_RESOURCES: Record<string, readonly string[]> = {
  build: ["definitions", "folders", "tags", "retention"],
} as const;

export type AllowedSubcommand = (typeof ALLOWED_SUBCOMMANDS)[number];
export type BlockedSubcommand = (typeof BLOCKED_SUBCOMMANDS)[number];
export type AllowedInvokeArea = (typeof ALLOWED_INVOKE_AREAS)[number];
export type BlockedInvokeArea = (typeof BLOCKED_INVOKE_AREAS)[number];
