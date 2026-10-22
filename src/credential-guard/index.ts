import type { CredentialGuardConfig } from "#config/types";
import { redactSensitiveText } from "#shared/content-security";
import { SECRET_PATTERNS } from "#shared/credential-patterns";
import { posix } from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import { parseBash } from "./bash";
import { parsePowerShell } from "./powershell";
import { judge } from "./policy";
import type { Decision, PolicyContext } from "./policy";
import { buildRegistry, executableName } from "./registry";
import { DEFAULT_ALLOWED_PATH_PATTERNS, isSensitivePath, normalizePath } from "./paths";

export { findSecretMatches } from "#shared/credential-patterns";
export { redactSensitiveText } from "#shared/content-security";

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

/** Object returned by createCredentialGuard */
export type CredentialGuard = {
  handleToolExecuteBefore: (input: HookInput, output: HookOutput) => void;
  detectSecrets: (content: string) => { name: string; match: string } | null;
  isPathAllowed: (filePath: string) => boolean;
  isPathBlocked: (filePath: string) => boolean;
  isDangerousBashCommand: (command: string) => boolean;
  getBlockedCliTool: (command: string) => { name: string; wrapper: string } | null;
  isGhCommandAllowed: (command: string) => boolean;
  detectSleepPolling: (command: string) => string | null;
};

type PollingDetectionRule = {
  pattern: RegExp;
  suggestion: string;
};

const DEFAULT_POLLING_DETECTION_RULES: PollingDetectionRule[] = [
  {
    pattern: /workflow\s+(?:list|view|jobs|logs|job-logs)\b/,
    suggestion: "bun agent-tools-gh workflow watch --run <ID>",
  },
  {
    pattern: /pr\s+checks(?![\w-])(?!.*--watch)/,
    suggestion: "bun agent-tools-gh pr checks --pr <N> --watch",
  },
  {
    pattern: /pr\s+rerun-checks\b/,
    suggestion: "bun agent-tools-gh pr checks --pr <N> --watch (after rerun completes)",
  },
  {
    pattern: /kubectl\b/,
    suggestion: 'bun agent-tools-k8s kubectl --env <env> --cmd "wait --for=condition=..."',
  },
  {
    pattern: /\bpipelines?\s+runs?\b/,
    suggestion: "bun agent-tools-azdo build summary --build-id <ID>",
  },
];

/** Extract file path from hook arguments. */
export function extractFilePath(args: Record<string, unknown>): string {
  return (
    (args.filePath as string) ||
    (args.file_path as string) ||
    (args.notebook_path as string) ||
    (args.path as string) ||
    ""
  );
}

/** Extract content from hook arguments. */
export function extractContent(args: Record<string, unknown>): string {
  return (
    (args.content as string) ||
    (args.newString as string) ||
    (args.new_string as string) ||
    (args.new_source as string) ||
    ""
  );
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

const recovery: Readonly<Record<string, string>> = {
  unparseable: "Use complete literal shell syntax within the supported subset.",
  "ambient-expansion":
    "Use a local binding or an exact name in credentialGuard.allowedEnvironmentVariables.",
  "secret-source":
    "Use a bounded wrapper operation with filtered output. Do not dump credentials or the environment.",
  "sensitive-path": "Use a nonsensitive example or template, or a bounded wrapper operation.",
  "opaque-path": "Use literal nonsensitive file paths.",
  "opaque-executable": "Use a literal executable name.",
  "opaque-code": "Use a supported literal shell body or a repository-owned bounded operation.",
  "opaque-env-name": "Use an exact approved environment variable name.",
  "no-analyzer":
    "Use a repository-owned bounded operation. The guard cannot inspect this code form.",
  "wrapper-required": "Use the configured wrapper. Check its help and the project README.",
  "configured-pattern": "Use the bounded operation allowed by the project configuration.",
  "startup-mutation":
    "Run the operation without changing executable lookup or startup configuration.",
  "unsupported-option": "Use supported options with complete literal values.",
  "analysis-limit": "Split the operation into smaller bounded commands.",
  "copy-destination":
    "Use a literal destination below a configured chainCopyDestinations directory, without symlinks.",
};

function proveCopyDestination(
  target: string,
  source: string,
  directories: readonly string[],
): boolean {
  try {
    const literalPath = (path: string) =>
      /^(?:\/|[A-Za-z]:\/)[A-Za-z0-9_./ -]+$/.test(path) &&
      !path.split("/").some((part) => part === "." || part === "..");
    if (
      !literalPath(target) ||
      !/^(?:~\/)?[A-Za-z0-9_./-]+$/.test(source) ||
      source.startsWith("-")
    )
      return false;
    const targetPath = target.replace(/\/+$/, "");
    const targetStat = lstatSync(targetPath, { throwIfNoEntry: false });
    if (target.endsWith("/") && !targetStat?.isDirectory()) return false;
    const destination = targetStat?.isDirectory()
      ? posix.join(targetPath, posix.basename(source))
      : targetPath;
    for (const directory of directories) {
      if (!literalPath(directory)) continue;
      const root = directory.replace(/\/+$/, "");
      if (destination !== root && !destination.startsWith(root + "/")) continue;
      if (!lstatSync(root).isDirectory() || realpathSync(root).replace(/\\/g, "/") !== root)
        return false;
      const parts = destination.slice(root.length).split("/").filter(Boolean);
      let current = root;
      for (const [index, part] of parts.entries()) {
        current = posix.join(current, part);
        const stat = lstatSync(current, { throwIfNoEntry: false });
        if (!stat) return index === parts.length - 1;
        if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory()))
          return false;
        if (realpathSync(current).replace(/\\/g, "/") !== current) return false;
      }
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function createCredentialGuard(config?: CredentialGuardConfig): CredentialGuard {
  const names = config?.allowedEnvironmentVariables;
  if (
    names !== undefined &&
    (!Array.isArray(names) || names.some((name) => typeof name !== "string"))
  )
    throw new Error("allowedEnvironmentVariables must be an array of strings");
  const approvedNames = new Set(names ?? []);
  for (const name of approvedNames)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      throw new Error(`Invalid allowed environment variable name: ${JSON.stringify(name)}`);
  const context: PolicyContext = {
    home: process.env.HOME ?? process.env.USERPROFILE ?? "~",
    get cwd() {
      return process.cwd();
    },
    approvedNames,
    registry: buildRegistry(config?.additionalBlockedCliTools),
    additionalBlockedPaths: config?.additionalBlockedPaths?.map((p) => new RegExp(p)),
    additionalAllowedPaths: config?.additionalAllowedPaths?.map((p) => new RegExp(p)),
    dangerousPatterns: config?.additionalDangerousBashPatterns?.map((p) => new RegExp(p)),
    chainCopyDestinations: config?.chainCopyDestinations,
    proveCopyDestination: (path, source) =>
      proveCopyDestination(path, source, config?.chainCopyDestinations ?? []),
  };
  const decision = (command: string, powershell = false): Decision =>
    judge(powershell ? parsePowerShell(command) : parseBash(command), context);
  const isPathBlocked = (path: string): boolean => isSensitivePath(path, context);
  const isPathAllowed = (path: string): boolean =>
    !isPathBlocked(path) &&
    [...DEFAULT_ALLOWED_PATH_PATTERNS, ...(context.additionalAllowedPaths ?? [])].some((p) =>
      new RegExp(p.source, p.flags.replace(/[gy]/g, "")).test(
        normalizePath(path, context.home, context.cwd),
      ),
    );
  function detectSecrets(content: string): { name: string; match: string } | null {
    for (const { name, pattern } of SECRET_PATTERNS) {
      const match = content.match(pattern);
      if (match)
        return {
          name,
          match: match[0].substring(0, 8) + "..." + match[0].substring(match[0].length - 4),
        };
    }
    return null;
  }
  function getDangerousBashReason(command: string): string | null {
    const result = decision(command);
    return result.kind === "pass"
      ? null
      : result.findings
          .slice(0, 8)
          .map((f) => `${f.rule}: ${f.detail.slice(0, 250)}`)
          .join("; ");
  }
  const isDangerousBashCommand = (command: string): boolean =>
    getDangerousBashReason(command) !== null;
  function getBlockedCliTool(command: string): { name: string; wrapper: string } | null {
    const result = decision(command);
    if (result.kind === "pass") return null;
    const finding = result.findings.find((f) => f.rule === "wrapper-required");
    if (!finding) return null;
    const split = finding.detail.indexOf(": ");
    return { name: finding.detail.slice(0, split), wrapper: finding.detail.slice(split + 2) };
  }
  function isGhCommandAllowed(command: string): boolean {
    let found = false;
    const result = judge(parseBash(command), {
      ...context,
      onInvocation: (name) => {
        found ||= executableName(name) === "gh";
      },
    });
    return found && result.kind === "pass";
  }
  function detectSleepPolling(command: string): string | null {
    const invocations: string[] = [];
    let sleep = false;
    judge(parseBash(command), {
      ...context,
      onInvocation: (name, argv) => {
        const executable = executableName(name);
        if (executable === "sleep" && /^\d/.test(argv[1] ?? "")) sleep = true;
        invocations.push([executable, ...argv.slice(1)].join(" "));
      },
    });
    if (!sleep) return null;
    return (
      DEFAULT_POLLING_DETECTION_RULES.find(({ pattern }) =>
        invocations.some((invocation) => pattern.test(invocation)),
      )?.suggestion ?? null
    );
  }
  function handleToolExecuteBefore(input: HookInput, output: HookOutput): void {
    try {
      const tool = input.tool.toLowerCase().replace(/^mcp_/, "");
      const path = extractFilePath(output.args);
      if (
        ["read", "write", "edit", "multiedit", "notebookedit", "grep", "glob"].includes(tool) &&
        path &&
        isSensitivePath(path, {
          ...context,
          contentRead:
            tool !== "glob" &&
            (tool !== "grep" ||
              (!["files_with_matches", "count"].includes(String(output.args.output_mode)) &&
                /\.[^/]+$/.test(path))),
        })
      )
        throw new Error(`Access blocked: "${path}" is a sensitive file.`);
      if (tool === "grep") {
        for (const [field, option] of Object.entries({ glob: "-g", type: "-t" })) {
          const value = output.args[field];
          if (value === undefined) continue;
          if (typeof value !== "string") throw new Error("Invalid Grep filter");
          const quoted = "'" + value.replaceAll("'", "'\\''") + "'";
          const checked = decision("rg " + option + " " + quoted + " -- example");
          if (checked.kind !== "pass")
            throw new Error("Access blocked: Grep filter can select a sensitive file.");
        }
      }
      if (tool === "multiedit") {
        if (!Array.isArray(output.args.edits)) throw new Error("Invalid MultiEdit edits");
        for (const edit of output.args.edits) {
          if (
            !edit ||
            typeof edit !== "object" ||
            !("new_string" in edit) ||
            typeof edit.new_string !== "string"
          )
            throw new Error("Invalid MultiEdit replacement");
          handleToolExecuteBefore(
            { tool: "Edit" },
            { args: { file_path: path, new_string: edit.new_string } },
          );
        }
      }
      if (["write", "edit", "notebookedit"].includes(tool) && !isPathAllowed(path)) {
        const secret = detectSecrets(extractContent(output.args));
        if (secret)
          throw new Error(
            `Secret detected: Potential ${secret.name} found in content. Matched: [REDACTED]. Never commit secrets to code.`,
          );
      }
      if (tool === "bash" || tool === "monitor" || tool === "powershell" || tool === "pwsh") {
        const command = extractCommand(output.args);
        const result = decision(command, tool === "powershell" || tool === "pwsh");
        if (result.kind !== "pass") {
          const excerpt =
            command.length > 2000 ? command.slice(0, 2000) + " [command elided]" : command;
          const families = [...new Set(result.findings.slice(0, 8).map((f) => f.rule))];
          throw new Error(
            `Command blocked: ${result.findings
              .slice(0, 8)
              .map((f) => `${f.rule}: ${f.detail.slice(0, 250)}`)
              .join("; ")}.\n\n` +
              `Command: ${excerpt}\n\n` +
              families.map((rule) => recovery[rule]).join("\n") +
              "\nTool inventory and usage: https://github.com/blogic-cz/agent-tools#tools",
          );
        }
        const suggestion = detectSleepPolling(command);
        if (suggestion) throw new Error(`Sleep-polling detected. Use instead: ${suggestion}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const sanitized = redactSensitiveText(message);
      if (error instanceof Error) {
        if (sanitized !== message) {
          error.message = sanitized;
          if (error.stack) error.stack = error.stack.replace(message, () => sanitized);
        }
        throw error;
      }
      // eslint-disable-next-line eslint/preserve-caught-error
      throw new Error(sanitized);
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
    detectSleepPolling,
  };
}

let defaultGuard: CredentialGuard | undefined;
const getDefaultGuard = (): CredentialGuard => (defaultGuard ??= createCredentialGuard());

/** Handle tool execution with default guard (no extra config). */
export const handleToolExecuteBefore: CredentialGuard["handleToolExecuteBefore"] = (...args) =>
  getDefaultGuard().handleToolExecuteBefore(...args);

/** Detect secrets in content with default guard. */
export const detectSecrets: CredentialGuard["detectSecrets"] = (...args) =>
  getDefaultGuard().detectSecrets(...args);

/** Check if a path is in the allowed exceptions list (default guard). */
export const isPathAllowed: CredentialGuard["isPathAllowed"] = (...args) =>
  getDefaultGuard().isPathAllowed(...args);

/** Check if a path should be blocked (default guard). */
export const isPathBlocked: CredentialGuard["isPathBlocked"] = (...args) =>
  getDefaultGuard().isPathBlocked(...args);

/** Check if a bash command might expose secrets (default guard). */
export const isDangerousBashCommand: CredentialGuard["isDangerousBashCommand"] = (...args) =>
  getDefaultGuard().isDangerousBashCommand(...args);

/** Get blocked CLI tool info (default guard). */
export const getBlockedCliTool: CredentialGuard["getBlockedCliTool"] = (...args) =>
  getDefaultGuard().getBlockedCliTool(...args);

/** Check if a gh command is allowed (default guard). */
export const isGhCommandAllowed: CredentialGuard["isGhCommandAllowed"] = (...args) =>
  getDefaultGuard().isGhCommandAllowed(...args);

/** Detect sleep-polling with agent-tools wrapper commands (default guard). */
export const detectSleepPolling: CredentialGuard["detectSleepPolling"] = (...args) =>
  getDefaultGuard().detectSleepPolling(...args);
