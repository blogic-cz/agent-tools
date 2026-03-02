/**
 * Credential Guard
 *
 * Security patterns and functions for detecting sensitive files and secrets.
 * Used by AI coding agent hooks/plugins.
 *
 * Security layers:
 * 1. Path-based blocking (files that should never be read)
 * 2. Content scanning (detect secrets in write operations)
 * 3. Dangerous bash command detection
 * 4. CLI tool blocking (must use wrapper tools)
 *
 * Note: This is a convenience layer. Real security should be enforced
 * at infrastructure level (K8s RBAC, file permissions, etc.)
 */

import type { CliToolOverride, CredentialGuardConfig } from "#config/types.ts";

// ============================================================================
// TYPES
// ============================================================================

/** Input format received by hooks/plugins. */
export type HookInput = {
  tool: string;
};

/** Output format received by hooks/plugins. */
export type HookOutput = {
  args: Record<string, unknown>;
};

type BlockedCliTool = {
  pattern: RegExp;
  name: string;
  wrapper: string;
};

/** Object returned by createCredentialGuard */
export type CredentialGuard = {
  handleToolExecuteBefore: (input: HookInput, output: HookOutput) => void;
  detectSecrets: (content: string) => { name: string; match: string } | null;
  isPathAllowed: (filePath: string) => boolean;
  isPathBlocked: (filePath: string) => boolean;
  isDangerousBashCommand: (command: string) => boolean;
  getBlockedCliTool: (command: string) => { name: string; wrapper: string } | null;
  isGhCommandAllowed: (command: string) => boolean;
};

// ============================================================================
// DEFAULT PATTERNS
// ============================================================================

/**
 * Paths that should NEVER be accessed by AI agents.
 * These patterns match files containing credentials, keys, and secrets.
 */
const DEFAULT_BLOCKED_PATH_PATTERNS: RegExp[] = [
  /\.env$/,
  /\.env\.[^.]+$/, // .env.local, .env.production, etc.
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.pfx$/,
  /\/secrets?\//i,
  /^secrets?\//i,
  /\/credentials?\//i,
  /^credentials?\//i,
  /\.aws\//,
  /\.ssh\//,
  /\.kube\//,
  /kubeconfig/i,
  /\.sentryclirc$/,
];

/**
 * Exceptions - files that match blocked patterns but are safe to access.
 * Only truly generic defaults (no project-specific paths).
 */
const DEFAULT_ALLOWED_PATH_PATTERNS: RegExp[] = [
  /\.env\.example$/,
  /\.env\.template$/,
  /\.env\.sample$/,
];

/** Patterns to detect secrets in content. */
const SECRET_PATTERNS = [
  {
    name: "AWS Access Key",
    pattern: /(?:AKIA|ABIA|ACCA|ASIA)[A-Z0-9]{16}/,
  },
  {
    name: "GitHub Token",
    pattern: /gh[ps]_[A-Za-z0-9]{36}/,
  },
  {
    name: "GitHub PAT",
    pattern: /github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}/,
  },
  { name: "OpenAI Key", pattern: /sk-[A-Za-z0-9]{48}/ },
  {
    name: "Generic API Key",
    pattern: /(?:api[_-]?key|apikey)["\s:=]+["']?([A-Za-z0-9_-]{20,})["']?/i,
  },
  {
    name: "Generic Secret",
    pattern:
      /(?:secret|token|password|passwd|pwd)["  \t:=]+["']?(?!\$\{|process\.env|z\.|generate|create|read|get|fetch|import|export|const|function|return|Schema)[^\s"']{32,}["']?/i,
  },
  {
    // eslint-disable-next-line eslint/no-useless-concat -- intentionally split to avoid credential guard self-detection
    name: "Priv" + "ate Key",
    pattern: new RegExp("-----BEGIN.*PRIVATE KEY-----"),
  },
  {
    name: "JWT Token",
    pattern: /(?:["'=:\s]|^)eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
  {
    name: "Azure SAS Token",
    pattern: /[?&]sig=[A-Za-z0-9%+/=]{20,}/,
  },
  {
    name: "GCP Service Account Key",
    pattern: /"type"\s*:\s*"service_account"/,
  },
  {
    name: "Slack Webhook URL",
    pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/,
  },
  {
    name: "Discord Webhook URL",
    pattern: /https:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/,
  },
  {
    name: "Database URL",
    pattern: /(?:postgres(?:ql)?|mysql|mongodb):\/\/(?!\$\{)[^:]+:(?!\$\{)[^@]+@/,
  },
];

/**
 * Dangerous bash patterns that might expose secrets.
 */
const DEFAULT_DANGEROUS_BASH_PATTERNS: RegExp[] = [
  /printenv/i,
  /(?:^|&&|\||;)\s*env(?:\s|$)/i,
  /\bcat\s+\S*\.env/i,
  /\bcat\s+\S*\.pem/i,
  /\bcat\s+\S*\.key/i,
  /\bcat\s+\S*secret/i,
  /\bcat\s+\S*credential/i,
  /\bcat\s+\S*\/\.ssh\//i,
  /\bcat\s+\S*\/\.aws\//i,
];

/**
 * CLI tools that must use wrapper tools for security and audit.
 */
const DEFAULT_BLOCKED_CLI_TOOLS: BlockedCliTool[] = [
  {
    pattern: /(?:^|[;&|]\s*)gh\s/,
    name: "gh",
    wrapper: "agent-tools-gh",
  },
  {
    pattern: /(?:^|[;&|]\s*)kubectl\s/,
    name: "kubectl",
    wrapper: "agent-tools-k8s",
  },
  {
    pattern: /(?:^|[;&|]\s*)psql\s/,
    name: "psql",
    wrapper: "agent-tools-db",
  },
  {
    pattern: /(?:^|[;&|]\s*)az\s/,
    name: "az",
    wrapper: "agent-tools-az",
  },
  {
    pattern: /(?:^|[;&|]\s*)curl\s.*dev\.azure\.com/,
    name: "curl (Azure DevOps)",
    wrapper: "agent-tools-az",
  },
];

/**
 * Read-only gh subcommands safe on external repos with -R flag.
 */
const GH_ALLOWED_READONLY_SUBCOMMANDS = [
  "issue list",
  "issue view",
  "issue search",
  "pr list",
  "pr view",
  "pr diff",
  "pr checks",
  "release list",
  "release view",
  "repo view",
  "search issues",
  "search prs",
  "search repos",
];

// ============================================================================
// HELPERS
// ============================================================================

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Extract file path from hook arguments. */
export function extractFilePath(args: Record<string, unknown>): string {
  return (args.filePath as string) || (args.file_path as string) || (args.path as string) || "";
}

/** Extract content from hook arguments. */
export function extractContent(args: Record<string, unknown>): string {
  return (args.content as string) || (args.newString as string) || "";
}

/** Extract command from hook arguments. */
export function extractCommand(args: Record<string, unknown>): string {
  return (args.command as string) || "";
}

// ============================================================================
// FACTORY
// ============================================================================

/**
 * Create a credential guard with optional extra patterns merged into defaults.
 *
 * @param config - Optional overrides. Arrays are concatenated with defaults (not replaced).
 * @returns Object with all guard functions bound to the merged pattern sets.
 */
export function createCredentialGuard(config?: CredentialGuardConfig): CredentialGuard {
  const blockedPathPatterns = [
    ...DEFAULT_BLOCKED_PATH_PATTERNS,
    ...(config?.additionalBlockedPaths ?? []).map((p) => new RegExp(p)),
  ];

  const allowedPathPatterns = [
    ...DEFAULT_ALLOWED_PATH_PATTERNS,
    ...(config?.additionalAllowedPaths ?? []).map((p) => new RegExp(p)),
  ];

  const dangerousBashPatterns = [
    ...DEFAULT_DANGEROUS_BASH_PATTERNS,
    ...(config?.additionalDangerousBashPatterns ?? []).map((p) => new RegExp(p)),
  ];

  const blockedCliTools: BlockedCliTool[] = [
    ...DEFAULT_BLOCKED_CLI_TOOLS,
    ...(config?.additionalBlockedCliTools ?? []).map(
      (override: CliToolOverride): BlockedCliTool => ({
        pattern: new RegExp(`(?:^|[;&|]\\s*)${escapeRegex(override.tool)}\\s`),
        name: override.tool,
        wrapper: override.suggestion,
      }),
    ),
  ];

  function isPathAllowed(filePath: string): boolean {
    const normalizedPath = filePath.replace(/\\/g, "/");
    return allowedPathPatterns.some((pattern) => pattern.test(normalizedPath));
  }

  function isPathBlocked(filePath: string): boolean {
    const normalizedPath = filePath.replace(/\\/g, "/");

    for (const pattern of allowedPathPatterns) {
      if (pattern.test(normalizedPath)) {
        return false;
      }
    }

    for (const pattern of blockedPathPatterns) {
      if (pattern.test(normalizedPath)) {
        return true;
      }
    }

    return false;
  }

  function detectSecrets(content: string): { name: string; match: string } | null {
    for (const { name, pattern } of SECRET_PATTERNS) {
      const match = content.match(pattern);
      if (match) {
        const redacted = match[0].substring(0, 8) + "..." + match[0].substring(match[0].length - 4);
        return { name, match: redacted };
      }
    }
    return null;
  }

  function isDangerousBashCommand(command: string): boolean {
    return dangerousBashPatterns.some((pattern) => pattern.test(command));
  }

  function isGhCommandAllowed(command: string): boolean {
    if (!/ -R\s+\S+/.test(command) && !/ --repo\s+\S+/.test(command)) {
      return false;
    }

    const ghMatch = command.match(/(?:^|[;&|]\s*)gh\s+(\S+(?:\s+\S+)?)/);
    if (!ghMatch) {
      return false;
    }

    const subcommand = ghMatch[1];

    return GH_ALLOWED_READONLY_SUBCOMMANDS.some(
      (allowed) => subcommand === allowed || subcommand.startsWith(`${allowed} `),
    );
  }

  function allGhCommandsAllowed(command: string): boolean {
    const segments = command.split(/[;&|\n]+/);
    const ghSegments = segments.filter((s) => /\bgh\s/.test(s));
    if (ghSegments.length === 0) return false;
    return ghSegments.every((segment) => isGhCommandAllowed(segment.trim()));
  }

  function getBlockedCliTool(command: string): { name: string; wrapper: string } | null {
    for (const { pattern, name, wrapper } of blockedCliTools) {
      if (pattern.test(command)) {
        if (name === "gh" && allGhCommandsAllowed(command)) {
          return null;
        }
        return { name, wrapper };
      }
    }
    return null;
  }

  function handleToolExecuteBefore(input: HookInput, output: HookOutput): void {
    const tool = input.tool;
    const args = output.args;

    const filePath = extractFilePath(args);

    if ((tool === "read" || tool === "write" || tool === "edit") && filePath) {
      if (isPathBlocked(filePath)) {
        throw new Error(
          `\u{1F6AB} Access blocked: "${filePath}" is a sensitive file.\n\n` +
            `This file may contain credentials or secrets.\n` +
            `If you need this file's content, ask the user to provide relevant parts.\n\n` +
            `Think this should be allowed? See https://github.com/blogic-cz/agent-tools — fork, extend the guard, and submit a PR.`,
        );
      }
    }

    if (tool === "write" || tool === "edit") {
      if (!isPathAllowed(filePath)) {
        const content = extractContent(args);

        if (content) {
          const detected = detectSecrets(content);
          if (detected) {
            throw new Error(
              `\u{1F6AB} Secret detected: Potential ${detected.name} found in content.\n\n` +
                `Matched: ${detected.match}\n\n` +
                `Never commit secrets to code. Use environment variables or secret managers.\n\n` +
                `Think this is a false positive? See https://github.com/blogic-cz/agent-tools — fork, fix the pattern, and submit a PR.`,
            );
          }
        }
      }
    }

    if (tool === "bash") {
      const command = extractCommand(args);

      if (isDangerousBashCommand(command)) {
        throw new Error(
          `\u{1F6AB} Command blocked: This command might expose secrets.\n\n` +
            `Command: ${command}\n\n` +
            `If you need environment info, ask the user directly.\n\n` +
            `Think this is wrong? See https://github.com/blogic-cz/agent-tools — fork, adjust the patterns, and submit a PR.`,
        );
      }

      const blockedTool = getBlockedCliTool(command);
      if (blockedTool) {
        throw new Error(
          `\u{1F6AB} Direct ${blockedTool.name} usage blocked.\n\n` +
            `AI agents must use wrapper tools for security and audit.\n\n` +
            `Use instead: ${blockedTool.wrapper}\n\n` +
            `Run with --help for documentation.\n\n` +
            `Think this tool should be allowed? See https://github.com/blogic-cz/agent-tools — fork, extend the whitelist, and submit a PR.`,
        );
      }
    }
  }

  return {
    handleToolExecuteBefore,
    detectSecrets,
    isPathAllowed,
    isPathBlocked,
    isDangerousBashCommand,
    getBlockedCliTool,
    isGhCommandAllowed,
  };
}

// ============================================================================
// TOP-LEVEL EXPORTS (default guard, no config)
// ============================================================================

const defaultGuard = createCredentialGuard();

/** Handle tool execution with default guard (no extra config). */
export const handleToolExecuteBefore = defaultGuard.handleToolExecuteBefore;

/** Detect secrets in content with default guard. */
export const detectSecrets = defaultGuard.detectSecrets;

/** Check if a path is in the allowed exceptions list (default guard). */
export const isPathAllowed = defaultGuard.isPathAllowed;

/** Check if a path should be blocked (default guard). */
export const isPathBlocked = defaultGuard.isPathBlocked;

/** Check if a bash command might expose secrets (default guard). */
export const isDangerousBashCommand = defaultGuard.isDangerousBashCommand;

/** Get blocked CLI tool info (default guard). */
export const getBlockedCliTool = defaultGuard.getBlockedCliTool;

/** Check if a gh command is allowed (default guard). */
export const isGhCommandAllowed = defaultGuard.isGhCommandAllowed;
