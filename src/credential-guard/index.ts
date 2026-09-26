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

import type { CliToolOverride, CredentialGuardConfig } from "#config/types";

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
  detectSleepPolling: (command: string) => string | null;
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
    pattern: /(?:^|[;&|]\s*)az\s+(?:devops|pipelines|repos|boards|artifacts)\b/,
    name: "az (Azure DevOps)",
    wrapper: "agent-tools-azdo",
  },
  {
    pattern: /(?:^|[;&|]\s*)az\s/,
    name: "az",
    wrapper: "agent-tools-az",
  },
  {
    pattern: /(?:^|[;&|]\s*)curl\s.*dev\.azure\.com/,
    name: "curl (Azure DevOps)",
    wrapper: "agent-tools-azdo",
  },
];

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

/**
 * Read-only gh subcommands safe on external repos with -R flag.
 */
const GH_ALLOWED_READONLY_SUBCOMMANDS = new Set([
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
]);

function isAllowedGhArgv(argv: string[]): boolean {
  const subcommand = argv.slice(1, 3).join(" ");
  return (
    argv.some((arg, index) => (arg === "-R" || arg === "--repo") && Boolean(argv[index + 1])) &&
    GH_ALLOWED_READONLY_SUBCOMMANDS.has(subcommand)
  );
}

function getLeadingLiteralAssignments(
  command: string,
): Map<string, { value: string; end: number }> {
  const assignments = new Map<string, { value: string; end: number }>();
  let offset = 0;
  while (offset === 0 || command[offset - 1] === ";" || command[offset - 1] === "\n") {
    while (/\s/.test(command[offset] ?? "")) offset++;
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z0-9_./-]+)/.exec(command.slice(offset));
    if (!assignment) break;
    const end = offset + assignment[0].length;
    const next = command.slice(end).match(/^\s*/)?.[0].length ?? 0;
    const separator = command[end + next];
    if (separator !== ";" && separator !== "\n") break;
    assignments.set(assignment[1] ?? "", { value: assignment[2] ?? "", end });
    offset = end + next + 1;
  }
  return assignments;
}

function hasSafeLocalAssignmentCommands(
  command: string,
  assignments: Map<string, { value: string; end: number }>,
): boolean {
  if (!assignments.size) return true;
  const parsed = parseStaticShellCommands(command);
  if (!parsed || typeof parsed === "string") return false;
  return parsed.pipelines.flat().every((words) => {
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z0-9_./-]+)$/.exec(words[0] ?? "");
    if (assignment) {
      return words.length === 1 && assignments.get(assignment[1] ?? "")?.value === assignment[2];
    }
    const argv = unwrapStaticCommand(words);
    const name = argv[0]?.split("/").at(-1) ?? "";
    if (name === "cd") return isNavigationOperand(argv, "LOCALVALUE");
    if (name === "git") {
      let index = 1;
      while (argv[index] === "-C" && argv[index + 1]) index += 2;
      return (
        ["branch", "diff", "log", "rev-parse", "rev-list", "show", "status"].includes(
          argv[index] ?? "",
        ) && !hasExecutionOption(argv.slice(index + 1), ["exec", "ext-diff", "textconv"])
      );
    }
    if (name === "find") {
      return !argv.slice(1).some((arg) => /^-(?:exec|ok|delete|fprint|fprintf)/.test(arg));
    }
    if (name === "bun") return argv[1] === "run" && ["db-tool", "gh-tool"].includes(argv[2] ?? "");
    return (
      isPassiveTextCommand(argv) ||
      ["ls", "cat", "tail", "wc", "uniq", "cut", "mv"].includes(name) ||
      (name === "sort" && !hasExecutionOption(argv.slice(1), ["compress-program"])) ||
      (name === "sed" &&
        argv
          .slice(1)
          .every(
            (arg) =>
              /^-[En]+$/.test(arg) ||
              /^s([/|]).*\1[^/|]*\1[gp]*$/.test(arg) ||
              /^[A-Za-z0-9_./-]+$/.test(arg),
          ) &&
        !argv.includes("-f"))
    );
  });
}

function hasSensitivePathRedirect(
  command: string,
  isPathBlocked: (path: string) => boolean,
): boolean {
  let heredoc = boundedHeredoc(command);
  while (heredoc) {
    if (!heredoc.closed) return true;
    command = [heredoc.header, heredoc.following].join("\n");
    heredoc = boundedHeredoc(command);
  }
  const parsed = parseStaticShellCommands(command, true);
  if (!parsed || typeof parsed === "string") return false;
  const assignments = getLeadingLiteralAssignments(command);
  return parsed.redirects.some(({ target, dynamic }) => {
    if (!dynamic) return isPathBlocked(target);
    const materialized = target.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (match, braced: string, plain: string) => assignments.get(braced ?? plain)?.value ?? match,
    );
    return /[$`]/.test(materialized) || isPathBlocked(materialized);
  });
}

// ============================================================================
// HELPERS
// ============================================================================

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Static shell words only. Never expand variables or execute a command.
 * literalOperandsOnly retains recognizable paths/commands on unsupported expansions;
 * callers may use it to deny, never to establish a safe exception.
 */
function parseStaticShellCommands(
  command: string,
  literalOperandsOnly = false,
):
  | { pipelines: string[][][]; redirects: { target: string; dynamic: boolean; pipeline: number }[] }
  | "brace-expansion"
  | undefined {
  const pipelines: string[][][] = [];
  const redirects: { target: string; dynamic: boolean; pipeline: number }[] = [];
  let redirect = false;
  let dynamic = false;
  let commands: string[][] = [];
  let argv: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | undefined;

  const finishWord = () => {
    if (started) {
      if (redirect) redirects.push({ target: word, dynamic, pipeline: pipelines.length });
      else argv.push(word);
      redirect = false;
    }
    word = "";
    started = false;
    dynamic = false;
  };
  const finishCommand = () => {
    finishWord();
    if (argv.length) commands.push(argv);
    argv = [];
  };
  const finishPipeline = () => {
    finishCommand();
    if (commands.length) pipelines.push(commands);
    commands = [];
  };

  for (let i = 0; i < command.length; i++) {
    const char = command.charAt(i);
    if (quote === "'") {
      if (char === quote) quote = undefined;
      else word += char;
    } else if (char === "\\") {
      const next = command[++i];
      if (next === undefined || next === "\n" || next === "\r") return undefined;
      if (quote === '"' && !/[\\$`"]/.test(next)) word += "\\";
      word += next;
      started = true;
    } else if (char === "$" || char === "`") {
      if (!literalOperandsOnly) return undefined;
      dynamic = true;
      word += char;
      started = true;
    } else if (quote === '"') {
      if (char === quote) quote = undefined;
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (
      !literalOperandsOnly &&
      char === "{" &&
      /^\{[^{}]*(?:,|\.\.)[^{}]*\}/.test(command.slice(i))
    ) {
      return "brace-expansion";
    } else if (char === ">" || char === "<") {
      if (char === "<" && command[i + 1] === "<") {
        if (literalOperandsOnly) break;
        return undefined;
      }
      if (/^\d+$/.test(word)) {
        word = "";
        started = false;
      } else {
        finishWord();
      }
      if (redirect) return undefined;
      if (command[i + 1] === char) i++;
      if (command[i + 1] === "&" && /[0-9-]/.test(command[i + 2] ?? "")) {
        i += 2;
        while (/\d/.test(command[i + 1] ?? "")) i++;
      } else {
        redirect = true;
      }
    } else if (char === "#" && !started) {
      while (i + 1 < command.length && command[i + 1] !== "\n") i++;
    } else if (/[()]/.test(char)) {
      if (!literalOperandsOnly) return undefined;
      finishWord();
    } else if (char === "|" && command[i - 1] !== "|" && command[i + 1] !== "|") {
      finishCommand();
      if (command[i + 1] === "&") i++;
    } else if (/[;&|\r\n]/.test(char)) {
      finishPipeline();
    } else if (/\s/.test(char)) {
      finishWord();
    } else {
      word += char;
      started = true;
    }
  }

  if (quote && !literalOperandsOnly) return undefined;
  finishPipeline();
  if (redirect) return undefined;
  return { pipelines, redirects };
}

function mentionsEnvironmentRead(text: string): boolean {
  // `--env dev` is a flag of another command, not the env command.
  return /(?<![\w.-])printenv\b(?!-)|(?<![\w.-])-\w*Oprintenv\b|(?<![\w.-])\benv\b(?!-)/i.test(
    text.replace(/['"\\]/g, ""),
  );
}

function hasBraceExpansion(text: string): boolean {
  return /\{[^{}]*(?:,|\.\.)[^{}]*\}/.test(text);
}

function hasNonExecutingAwkProgram(text: string): boolean {
  const match = /\bawk\s+(['"])([\s\S]*?)\1/.exec(text);
  if (!match) return false;
  const program = match[2] ?? "";
  return !/\b(?:system|getline)\s*\(|\||\b(?:print|printf)\b[^\n]*>/.test(program);
}

function hasShellBraceExpansion(text: string): boolean {
  if (!hasBraceExpansion(text)) return false;
  if (!hasNonExecutingAwkProgram(text)) return true;
  return hasBraceExpansion(text.replace(/(\bawk\s+(['"]))[\s\S]*?\2/, "awk "));
}

/**
 * The command without quoted regex quantifiers such as `{0,80}`. Many commands re-parse quoted
 * text as shell code, so every other quoted brace stays. When both sides are digits, the expansion
 * cannot spell a command name. An empty side is not safe: `e{,}nv` and `e{0,}nv` expand to `env`.
 * An unclosed quote keeps the raw command.
 */
function withoutQuotedQuantifiers(command: string): string {
  let text = "";
  let quote: "'" | '"' | "$'" | undefined;
  for (let i = 0; i < command.length; i++) {
    const char = command.charAt(i);
    const quantifier = quote ? /^\{\d+,\d+\}/.exec(command.slice(i))?.[0] : undefined;
    if (quantifier) {
      i += quantifier.length - 1;
      continue;
    }
    text += char;
    if (quote === "'") {
      if (char === "'") quote = undefined;
    } else if (char === "\\") {
      text += command[++i] ?? "";
    } else if (quote) {
      if (char === quote.at(-1)) quote = undefined;
    } else if (char === "$" && command[i + 1] === "'") {
      quote = "$'";
      text += command[++i];
    } else if (char === "'" || char === '"') {
      quote = char;
    }
  }
  return quote ? command : text;
}

/** Braces in static words, except `{m,n}` with digits on both sides (see above). */
function hasArgumentBraceExpansion(text: string): boolean {
  return hasShellBraceExpansion(text.replace(/\{\d+,\d+\}/g, ""));
}

function hasCommandArgumentBraceExpansion(argv: string[]): boolean {
  // LogQL is data for this wrapper; its quoted label selectors are never shell-evaluated.
  if (
    argv[0]?.split("/").at(-1) === "bun" &&
    argv[1] === "run" &&
    argv[2] === "observability-tool" &&
    argv[3] === "logs" &&
    argv[4] === "query"
  )
    return false;
  return (argv[0]?.split("/").at(-1) === "awk" && !isAwkExecution(argv)) ||
    isJqObjectConstruction(argv)
    ? false
    : hasArgumentBraceExpansion(argv.join(" "));
}

/** echo and printf print their arguments; grep -o, rg and git grep print matched pattern text. */
function isLiteralTextProducer(argv: string[]): boolean {
  return isPassiveTextCommand(argv) && argv[0]?.split("/").at(-1) !== "head";
}

function isAwkExecution(argv: string[]): boolean {
  if (argv[0]?.split("/").at(-1) !== "awk") return false;
  // Only a literal inline program establishes passive behavior. File/unknown options do not.
  const program = argv[1];
  return (
    !program ||
    program.startsWith("-") ||
    /\b(?:system|getline|ENVIRON)\b|\||\b(?:print|printf)\b[^\n]*>|@(?:include|load)/.test(
      program,
    ) ||
    argv.slice(2).some((arg) => arg.startsWith("-"))
  );
}

function isJqObjectConstruction(argv: string[]): boolean {
  if (argv[0]?.split("/").at(-1) !== "jq") return false;
  let index = 1;
  // Options with values, program files, and unknown options cannot prove an inline filter.
  while (/^-[rRcMsScn]+$/.test(argv[index] ?? "")) index++;
  if (argv[index] === "--") index++;
  const filter = argv[index] ?? "";
  if (argv.slice(index + 1).some((arg) => arg.startsWith("-"))) return false;
  return (
    /^\{\s*[A-Za-z_][A-Za-z0-9_-]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_-]*)*\s*\}$/.test(filter) ||
    /^\{\s*[A-Za-z_][A-Za-z0-9_-]*\s*:\s*\.[A-Za-z_][A-Za-z0-9_.-]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_-]*\s*:\s*\.[A-Za-z_][A-Za-z0-9_.-]*)*\s*\}$/.test(
      filter,
    )
  );
}

function jqFileArguments(argv: string[]): string[] {
  const files: string[] = [];
  let index = 1;
  for (; index < argv.length; index++) {
    const arg = argv[index] ?? "";
    if (arg === "--") {
      index++;
      break;
    }
    if (/^-[rRcMsScn]+$/.test(arg)) continue;
    if (arg === "--arg" || arg === "--argjson") {
      index += 2;
      continue;
    }
    if (arg === "--rawfile" || arg === "--slurpfile") {
      files.push(argv[index + 2] ?? "");
      index += 2;
      continue;
    }
    if (arg.startsWith("-")) return argv.slice(1);
    break;
  }
  return [...files, ...argv.slice(index + 1)];
}

/** Index in `args` where the command wrapped by `env` starts, or null when `env` only lists. */
function environmentCommandStart(args: string[]): number | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) continue;
    if (arg === "--") return i + 1 === args.length ? null : i + 1;
    if (arg === "-u" || arg === "--unset" || arg === "-C" || arg === "--chdir") {
      i++;
      continue;
    }
    if (arg === "-i" || arg === "--ignore-environment" || arg.startsWith("--chdir=")) continue;
    if (arg.startsWith("--unset=")) continue;
    if (arg.startsWith("-")) return null;
    return i;
  }
  return null;
}

function isEnvironmentListing(argv: string[]): boolean {
  return environmentCommandStart(argv.slice(1)) === null;
}

function unwrapEnvironmentCommand(argv: string[]): string[] | null {
  if (argv[0]?.split("/").at(-1) !== "env") return null;
  const args = argv.slice(1);
  const start = environmentCommandStart(args);
  return start === null ? null : args.slice(start);
}

function isSafeLiteralInspection(argv: string[]): boolean {
  const name = argv[0]?.split("/").at(-1) ?? "";
  return (
    ["head", "tail"].includes(name) &&
    !argv.slice(1).some((arg) => /\.env(?:\.|$)|\.(?:pem|key)\b|secret|credential/i.test(arg))
  );
}

function isSafeLiteralConsumer(argv: string[]): boolean {
  return (
    isSafeLiteralInspection(argv) ||
    (argv[0]?.split("/").at(-1) === "bun" &&
      argv[1] === "run" &&
      argv[2] === "gh-tool" &&
      argv.includes("--body-file"))
  );
}

function unwrapStaticCommand(words: string[]): string[] {
  let argv = [...words];
  while (argv.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0] ?? "")) {
      argv.shift();
      continue;
    }
    const executable = argv[0]?.split("/").at(-1);
    if (executable === "env") {
      const wrapped = unwrapEnvironmentCommand(argv);
      if (!wrapped) break;
      argv = wrapped;
    } else if (executable === "rtk" || executable === "command") {
      argv.shift();
      if (executable === "rtk") {
        if (argv[0] === "proxy") argv.shift();
        else if (argv[0] === "read") argv[0] = "cat";
      }
      if (executable === "command" && argv[0] === "--") argv.shift();
    } else break;
  }
  return argv;
}

function isAllowedEnvironmentRead(argv: string[], allowedNames: Set<string>): boolean {
  if (argv[0]?.split("/").at(-1) !== "printenv") return false;
  const args = argv.slice(1);
  if (args[0] === "--") args.shift();
  return args.length > 0 && args.every((name) => allowedNames.has(name));
}

function hasExecutionOption(args: string[], longOptions: string[], shortOption?: string): boolean {
  return args.some((arg) => {
    const flag = arg.split("=", 1)[0] ?? "";
    if (flag.startsWith("--") && flag.length > 2) {
      // Git supports long-option abbreviations. Refuse ambiguous prefixes too.
      return longOptions.some((option) => option.startsWith(flag.slice(2)));
    }
    return shortOption !== undefined && /^-[^-]/.test(flag) && flag.includes(shortOption);
  });
}

function passivePrintfFormatIndex(argv: string[]): number | undefined {
  const index = argv[1] === "--" ? 2 : 1;
  const format = argv[index];
  if (format === undefined || (index === 1 && format.startsWith("-"))) return undefined;
  // Ignore escaped percent signs; %n writes a shell variable named by a data argument.
  return /%[-+ #0]*(?:\d+|\*)?(?:\.(?:\d+|\*))?[hljztL]*n/.test(format.replaceAll("%%", ""))
    ? undefined
    : index;
}

/** Unknown values are permitted only in operands that navigate without displaying the value. */
function isNavigationOperand(argv: string[], marker: string): boolean {
  const name = argv[0]?.split("/").at(-1);
  if (name === "cd") {
    const index = argv[1] === "--" ? 2 : 1;
    return argv.length === index + 1 && !argv[0]?.includes(marker);
  }
  if (name !== "git") return false;
  let index = 1;
  while (argv[index] === "-C" && argv[index + 1]) index += 2;
  return (
    ["status", "rev-parse", "rev-list"].includes(argv[index] ?? "") &&
    !argv.slice(index).some((arg) => arg.includes(marker)) &&
    !argv[0]?.includes(marker)
  );
}

function isPassiveTextCommand(argv: string[]): boolean {
  const name = argv[0]?.split("/").at(-1) ?? "";
  const args = argv.slice(1);
  // These commands consume literal text. Execution options are not exceptions.
  if (name === "printf") return passivePrintfFormatIndex(argv) !== undefined;
  if (["echo", "grep", "head"].includes(name)) {
    return true;
  }
  if (name === "rg") return !hasExecutionOption(args, ["pre", "hostname-bin"]);
  if (name === "awk") return !isAwkExecution(argv);
  if (name === "jq") return isJqObjectConstruction(argv);
  return (
    (name === "git" && args[0] === "status") ||
    (name === "git" &&
      args[0] === "grep" &&
      !hasExecutionOption(args, ["open-files-in-pager", "textconv"], "O"))
  );
}

function hasStaticEnvironmentRead(argv: string[], allowedNames: Set<string>): boolean {
  const name = argv[0]?.split("/").at(-1);
  if (
    ["sh", "bash", "zsh"].includes(name ?? "") &&
    hasExecutionOption(argv.slice(1), ["command"], "c") &&
    argv.slice(1).some((arg) => /\$\{?[A-Za-z_]/.test(arg))
  ) {
    return true;
  }
  if (name === "awk" && argv.slice(1).some((arg) => /\bENVIRON\b/.test(arg))) return true;
  if (name === "printenv") return !isAllowedEnvironmentRead(argv, allowedNames);
  if (name === "env") {
    const wrapped = unwrapEnvironmentCommand(argv);
    return wrapped === null
      ? isEnvironmentListing(argv)
      : hasStaticEnvironmentRead(unwrapStaticCommand(wrapped), allowedNames);
  }
  if (isPassiveTextCommand(argv)) return false;
  // Any command may re-parse an argument as shell code (trap, find -exec, awk system()).
  return hasCommandArgumentBraceExpansion(argv) || mentionsEnvironmentRead(argv.join(" "));
}

function isStaticHerdrPrompt(command: string): boolean {
  const parsed = parseStaticShellCommands(command);
  if (!parsed || typeof parsed === "string") return false;
  const commands = parsed.pipelines.flat().map(unwrapStaticCommand);
  const prompts = commands.filter(
    (argv) => argv[0] === "herdr" && argv[1] === "agent" && argv[2] === "prompt",
  );
  return (
    prompts.length > 0 &&
    commands.every((argv) =>
      argv[0] === "herdr" && argv[1] === "agent" && argv[2] === "prompt"
        ? argv.length >= 5
        : isPassiveTextCommand(argv),
    )
  );
}

function isHerdrPrompt(command: string): boolean {
  return /^herdr\s+agent\s+prompt\b/.test(command.trim());
}

function hasEnvironmentRead(command: string, allowedNames: Set<string>): boolean {
  if (isStaticHerdrPrompt(command)) return false;
  if (isHerdrPrompt(command)) return true;
  if (isLiteralTextWrite(command)) return false;
  // ponytail: complex shell syntax stays conservative; use a shell AST if more exceptions are needed.
  const parsed = parseStaticShellCommands(command);
  if (parsed === "brace-expansion") return true;
  if (!parsed) {
    const unquoted = command.replace(/'(?:\\.|[^'])*'/g, " ").replace(/"(?:\\.|[^"$`])*"/g, " ");
    const hasExecutor =
      /\|\s*(?:sh|bash|zsh|xargs)|\b(?:sh|bash|zsh)\b|\$\(|`|\b(?:eval|source)\b|\bfind\b.*\b-exec\b/i.test(
        command,
      );
    return (
      mentionsEnvironmentRead(unquoted) ||
      (mentionsEnvironmentRead(command) && hasExecutor) ||
      hasShellBraceExpansion(withoutQuotedQuantifiers(command))
    );
  }
  const pipelines = parsed.pipelines.map((commands) => commands.map(unwrapStaticCommand));
  const unwrapped = pipelines.flat();
  if (
    command.includes(">") &&
    unwrapped.some((argv) => isAllowedEnvironmentRead(argv, allowedNames))
  ) {
    return true;
  }
  if (
    command.includes(">") &&
    pipelines.some((pipeline) =>
      pipeline.some(
        (argv) => isLiteralTextProducer(argv) && mentionsEnvironmentRead(argv.join(" ")),
      ),
    ) &&
    unwrapped.some((argv) => ["sh", "bash", "zsh", "xargs", "eval"].includes(argv[0] ?? ""))
  ) {
    return true;
  }
  if (unwrapped.some((argv) => hasStaticEnvironmentRead(argv, allowedNames))) {
    return true;
  }

  // A literal producer can feed executable text to a shell, xargs, or an unknown consumer.
  const result = pipelines.some(
    (pipeline) =>
      pipeline.length > 1 &&
      pipeline.some(
        (argv) =>
          isAllowedEnvironmentRead(argv, allowedNames) ||
          (isLiteralTextProducer(argv) &&
            (mentionsEnvironmentRead(argv.join(" ")) || hasCommandArgumentBraceExpansion(argv))),
      ) &&
      pipeline.some(
        (argv) => !isPassiveTextCommand(argv) && !isAllowedEnvironmentRead(argv, allowedNames),
      ),
  );
  return result;
}

/** Find an actual heredoc operator outside shell quotes/comments, then parse one bounded body. */
function boundedHeredoc(command: string) {
  let quote: "'" | '"' | undefined;
  let wordStarted = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote === "'") {
      if (char === quote) quote = undefined;
    } else if (char === "\\") {
      i++;
      wordStarted = true;
    } else if (quote === '"') {
      if (char === quote) quote = undefined;
    } else if (char === "'" || char === '"') {
      quote = char;
      wordStarted = true;
    } else if (char === "#" && !wordStarted) {
      while (i + 1 < command.length && command[i + 1] !== "\n") i++;
    } else if (command.startsWith("<<", i)) {
      const match =
        /^<<(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2[ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)/.exec(
          command.slice(i),
        );
      const lines = match
        ? command
            .slice(i + match[0].length)
            .trimEnd()
            .split(/\r?\n/)
        : [];
      const end = lines.findIndex(
        (line) => (match?.[1] ? line.replace(/^\t+/, "") : line) === match?.[3],
      );
      return {
        header: command.slice(0, i),
        quoted: Boolean(match?.[2]),
        closed: Boolean(match) && end >= 0,
        body: lines.slice(0, end >= 0 ? end : undefined).join("\n"),
        following: end >= 0 ? lines.slice(end + 1).join("\n") : "",
      };
    } else {
      wordStarted = !/[\s;&|()<>]/.test(char ?? "");
    }
  }
  return undefined;
}

/** A single literal writer cannot execute its body or feed another command. */
function isLiteralTextWrite(command: string): boolean {
  const heredoc = boundedHeredoc(command);
  let header = command;
  let writers = ["echo", "printf"];
  if (heredoc) {
    // Only a complete body with no following commands is a literal-write exception.
    if (!heredoc.closed || heredoc.following) return false;
    if (!heredoc.quoted && /[$`\\]/.test(heredoc.body)) return false;
    header = heredoc.header;
    writers = ["cat", "tee"];
  } else if (!command.includes(">")) {
    return false;
  }

  // Output redirection does not execute text. Other unsupported syntax still fails parsing.
  const parsed = parseStaticShellCommands(header.replace(/2>&1/g, " ").replace(/>>?/g, " "));
  if (!parsed || parsed === "brace-expansion") return false;
  const commands = parsed.pipelines.flat().map(unwrapStaticCommand);
  const writerIndexes = commands
    .map((argv, index) => (writers.includes(argv[0]?.split("/").at(-1) ?? "") ? index : -1))
    .filter((index) => index >= 0);
  return (
    writerIndexes.length === 1 &&
    commands.every((argv, index) => {
      if (index === writerIndexes[0]) return true;
      const name = argv[0]?.split("/").at(-1) ?? "";
      return name === "cd" || isSafeLiteralConsumer(argv);
    })
  );
}

function hasSensitiveFileRead(command: string, isPathBlocked: (path: string) => boolean): boolean {
  const sensitivePath =
    /(?:^|[/\s'"])(?:[.]env(?![.](?:example|template|sample)\b)|\S*[.](?:pem|key)\b|\S*[.](?:ssh|aws)[/]|(?:\S*secret(?:-|[/\s.]|$))|(?:(?:secrets?|credentials?)(?:[/\s.]|$)|[A-Za-z0-9_.-]*(?:secrets?|credentials?)(?:[/\s.]|$)|[A-Za-z0-9_.-]*-(?:secrets?|credentials?)(?:[/\s.-]|$)))/i;
  const sensitiveCamelCase =
    /(?:^|[/\s'"])[A-Za-z0-9_.-]*(?:(?:secret|credential)[A-Z]|(?:Secret|Credential)[A-Z])[^/\s'"]*/;
  const sensitiveName = /secret|credential/i;
  const isSensitivePath = (text: string) =>
    sensitivePath.test(text) ||
    sensitiveCamelCase.test(text) ||
    (sensitiveName.test(text) && !/(?:^|\/)credential-guard(?:-[^/]+)?\.(?:ts|md)$/.test(text));
  if (/(?:^|[\s;&|])--env-file(?:=|\s)[^;&|]*\.env\b/i.test(command)) return true;
  if (/\bcat\b[^;&|]*<<-?\s*\S+[\s\S]*\b(?:secret|credential)\b/i.test(command)) return true;
  const parsed = parseStaticShellCommands(command);
  const readers =
    /\b(?:cat|cp|grep|rg|sed|awk|jq|head|tail|less|more|source|ls|sort|uniq|cut|wc|mv|find)\b/i;
  if (parsed && parsed !== "brace-expansion") {
    return parsed.pipelines.flat().some((words) => {
      const argv = unwrapStaticCommand(words);
      const inspectedArgv =
        argv[0]?.split("/").at(-1) === "env" ? unwrapEnvironmentCommand(argv) : argv;
      if (inspectedArgv === null) return false;
      const inspected = unwrapStaticCommand(inspectedArgv);
      const name = inspected[0]?.split("/").at(-1) ?? "";
      if (name === "bun" && inspected[1] === "run" && inspected[2] === "gh-tool") {
        return inspected.some((arg, index) => {
          const path =
            arg === "--body-file"
              ? inspected[index + 1]
              : arg.startsWith("--body-file=")
                ? arg.slice("--body-file=".length)
                : undefined;
          return path !== undefined && (isPathBlocked(path) || isSensitivePath(path));
        });
      }
      if (!readers.test(name)) return false;
      if (name === "rg" || name === "grep") {
        const args = inspected.slice(1);
        const paths: string[] = [];
        let hasPattern = false;
        let options = true;
        let filesOnly = false;
        for (let i = 0; i < args.length; i++) {
          const arg = args[i] ?? "";
          if (options && arg === "--") {
            options = false;
            continue;
          }
          if (
            options &&
            (arg === "--pre" ||
              arg.startsWith("--pre=") ||
              arg === "--hostname-bin" ||
              arg.startsWith("--hostname-bin="))
          )
            return true;
          if (options && (arg.startsWith("--file=") || /^-f.+/.test(arg))) {
            paths.push(arg.startsWith("--file=") ? arg.slice(7) : arg.slice(2));
            hasPattern = true;
            continue;
          }
          if (options && (arg.startsWith("--regexp=") || /^-e.+/.test(arg))) {
            hasPattern = true;
            continue;
          }
          if (
            options &&
            (arg.startsWith("--glob=") ||
              arg.startsWith("--iglob=") ||
              arg.startsWith("--include=") ||
              /^-g.+/.test(arg))
          ) {
            const glob = arg.startsWith("--iglob=")
              ? arg.slice(8)
              : arg.startsWith("--include=")
                ? arg.slice(10)
                : arg.startsWith("--glob=")
                  ? arg.slice(7)
                  : arg.slice(2);
            if (isSensitivePath(glob)) paths.push(glob);
            continue;
          }
          if (
            options &&
            ["-e", "--regexp", "-f", "--file", "-g", "--glob", "--iglob", "--include"].includes(arg)
          ) {
            const value = args[++i];
            if (arg === "-f" || arg === "--file") paths.push(value ?? "");
            if (
              (arg === "-g" || arg === "--glob" || arg === "--iglob" || arg === "--include") &&
              value &&
              isSensitivePath(value)
            )
              paths.push(value);
            if (arg === "-e" || arg === "--regexp" || arg === "-f" || arg === "--file")
              hasPattern = true;
            continue;
          }
          if (options && (arg === "--files" || (arg === "-l" && name === "grep"))) {
            filesOnly = arg === "--files";
            if (filesOnly) continue;
          }
          if (options && arg.startsWith("-")) {
            if (/^-[A-Za-z]+[fg]$/.test(arg)) {
              const value = args[++i];
              if (value && isSensitivePath(value)) paths.push(value);
              if (arg.endsWith("f")) hasPattern = true;
              continue;
            }
            const combinedPatternFile = arg.match(/^-[A-Za-z]*f(.+)$/)?.[1];
            if (combinedPatternFile) {
              if (isSensitivePath(combinedPatternFile)) paths.push(combinedPatternFile);
              hasPattern = true;
            }
            const optionValue = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : null;
            if (optionValue && isSensitivePath(optionValue)) paths.push(optionValue);
            continue;
          }
          if (!hasPattern && !filesOnly) {
            hasPattern = true;
            continue;
          }
          paths.push(arg);
        }
        return paths.some((path) => isPathBlocked(path) || isSensitivePath(path));
      }
      const paths = name === "jq" ? jqFileArguments(inspected) : inspected.slice(1);
      return paths.some((path) => isPathBlocked(path) || isSensitivePath(path));
    });
  }
  const operands = parseStaticShellCommands(command, true);
  if (
    operands &&
    typeof operands !== "string" &&
    operands.pipelines.flat().some((words) => {
      const argv = unwrapStaticCommand(words);
      return readers.test(argv[0] ?? "") && argv.slice(1).some(isPathBlocked);
    })
  )
    return true;
  if (readers.test(command) && command.split(/[\s'"`()<>;&|]+/).some(isPathBlocked)) return true;
  const unquoted = command.replace(/'(?:\\.|[^'])*'/g, " ").replace(/"(?:\\.|[^"$`])*"/g, " ");
  if (/\b(?:bun|node|python3?|ruby)\b/i.test(command) && isSensitivePath(command)) {
    return true;
  }
  return (
    new RegExp(readers.source + "[^;&|]*" + sensitivePath.source, "i").test(unquoted) ||
    new RegExp(readers.source + "[^;&|]*" + sensitiveCamelCase.source).test(unquoted) ||
    new RegExp(readers.source + "[^;&|]*" + sensitiveName.source, "i").test(unquoted)
  );
}

function hasEnvironmentVariableExpansionRead(
  command: string,
  allowedNames: Set<string>,
  isPathBlocked: (path: string) => boolean,
): boolean {
  let heredoc = boundedHeredoc(command);
  while (heredoc) {
    // In an unquoted heredoc, # and quote characters are data, not shell syntax.
    if (!heredoc.closed || (!heredoc.quoted && /[$`\\]/.test(heredoc.body))) return true;
    command = [heredoc.header, heredoc.following].join("\n");
    heredoc = boundedHeredoc(command);
  }
  if (!command.includes("$")) return false;
  let invalidExpansion = false;
  const assignments = getLeadingLiteralAssignments(command);
  const localValues = new Map<string, string>();
  let localIndex = 0;
  let expansions = 0;
  let normalized = "";
  let quote: "'" | '"' | undefined;
  let wordStarted = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i] ?? "";
    if (!quote && char === "#" && !wordStarted) {
      while (i + 1 < command.length && command[i + 1] !== "\n") i++;
      continue;
    }
    if (!quote && /[\s;&|()<>]/.test(char)) wordStarted = false;
    else wordStarted = true;
    if (char === "\\" && quote !== "'") {
      normalized += char + (command[++i] ?? "");
      continue;
    }
    if (quote === "'") {
      normalized += char;
      if (char === "'") quote = undefined;
      continue;
    }
    if (char === "'" && quote !== '"') {
      normalized += char;
      quote = "'";
      continue;
    }
    if (char === '"') {
      normalized += char;
      quote = quote === '"' ? undefined : '"';
      continue;
    }
    if (char !== "$") {
      normalized += char;
      continue;
    }
    const variable = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}|^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(
      command.slice(i),
    );
    if (!variable) {
      if (command[i + 1] === "{" || /[$][0-9@*#?!]/.test(command.slice(i, i + 2))) {
        invalidExpansion = true;
      }
      normalized += char;
      continue;
    }
    expansions++;
    const name = variable[1] ?? variable[2] ?? "";
    const assignment = assignments.get(name);
    if (assignment && assignment.end >= i) invalidExpansion = true;
    if (assignment && assignment.end < i) {
      const marker = `LOCALVALUE${localIndex++}`;
      localValues.set(marker, assignment.value);
      normalized += marker;
    } else if (allowedNames.has(name)) {
      normalized += quote ? "ENVVALUE" : "ENVVALUEUNQUOTED";
    } else {
      normalized += quote ? "UNKNOWNVALUE" : "UNKNOWNVALUEUNQUOTED";
    }
    i += variable[0].length - 1;
  }
  if (!expansions) return invalidExpansion;
  if (invalidExpansion) return true;

  const localMaterialized = [...localValues].reduce(
    (text, [marker, value]) => text.replaceAll(marker, value),
    normalized,
  );
  // Options must be checked after local literals become actual argv, never as placeholders.
  if (!hasSafeLocalAssignmentCommands(localMaterialized, assignments)) return true;
  const parsed = parseStaticShellCommands(localMaterialized);
  if (!parsed || typeof parsed === "string") return true;
  for (const words of parsed.pipelines.flat()) {
    if (!words.some((arg) => arg.includes("UNKNOWNVALUE"))) continue;
    if (words.some((arg) => arg.includes("UNKNOWNVALUEUNQUOTED"))) return true;
    const argv = unwrapStaticCommand(words);
    if (
      words.slice(0, words.length - argv.length).some((arg) => arg.includes("UNKNOWNVALUE")) ||
      !isNavigationOperand(argv, "UNKNOWNVALUE")
    )
      return true;
  }
  if (!localMaterialized.includes("ENVVALUE")) {
    return (
      hasSensitiveFileRead(localMaterialized, isPathBlocked) ||
      hasSensitivePathRedirect(localMaterialized, isPathBlocked) ||
      hasEnvironmentRead(localMaterialized, allowedNames)
    );
  }

  for (const [index, pipeline] of parsed.pipelines.entries()) {
    const hasEnvironmentValue = pipeline.some((argv) =>
      argv.some((arg) => arg.includes("ENVVALUE")),
    );
    if (!hasEnvironmentValue) continue;
    if (parsed.redirects.some((redirect) => redirect.pipeline === index)) return true;
    if (
      pipeline.some((argv) => {
        const unwrapped = unwrapStaticCommand(argv);
        const name = unwrapped[0]?.split("/").at(-1) ?? "";
        if (argv.some((arg) => arg.includes("ENVVALUE"))) {
          if (argv.slice(0, argv.length - unwrapped.length).some((arg) => arg.includes("ENVVALUE")))
            return true;
          if (isNavigationOperand(unwrapped, "ENVVALUE")) {
            return unwrapped.some((arg) => arg.includes("ENVVALUEUNQUOTED"));
          }
          const formatIndex = name === "printf" ? passivePrintfFormatIndex(unwrapped) : undefined;
          return (
            !["echo", "printf"].includes(name) ||
            !isPassiveTextCommand(unwrapped) ||
            unwrapped[0]?.includes("ENVVALUE") === true ||
            (name === "printf" &&
              (formatIndex === undefined ||
                unwrapped.slice(0, formatIndex + 1).some((arg) => arg.includes("ENVVALUE"))))
          );
        }
        return !isPassiveTextCommand(unwrapped);
      })
    ) {
      return true;
    }
  }
  const materialized = [...localValues].reduce(
    (text, [marker, value]) => text.replaceAll(marker, value),
    normalized.replaceAll("ENVVALUE", "SAFEENVVALUE"),
  );
  return hasSensitiveFileRead(materialized, isPathBlocked);
}

function hasEnvironmentSourceAccess(command: string): boolean {
  return (
    /\b(?:os\.environ|process\.env|Environment\.GetEnvironmentVariable)\b/.test(command) &&
    /\b(?:python3?|node|bun)\b/.test(command)
  );
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
  const names = config?.allowedEnvironmentVariables;
  if (
    names !== undefined &&
    (!Array.isArray(names) || names.some((name) => typeof name !== "string"))
  ) {
    throw new Error("allowedEnvironmentVariables must be an array of strings");
  }
  const allowedEnvironmentVariables = new Set(names ?? []);
  for (const name of allowedEnvironmentVariables) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Invalid allowed environment variable name: ${JSON.stringify(name)}`);
    }
  }
  const blockedPathPatterns = [
    ...DEFAULT_BLOCKED_PATH_PATTERNS,
    ...(config?.additionalBlockedPaths ?? []).map((p) => new RegExp(p)),
  ];

  const allowedPathPatterns = [
    ...DEFAULT_ALLOWED_PATH_PATTERNS,
    ...(config?.additionalAllowedPaths ?? []).map((p) => new RegExp(p)),
  ];

  const dangerousBashPatterns = [
    ...(config?.additionalDangerousBashPatterns?.map((p) => new RegExp(p)) ?? []),
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
    return getDangerousBashReason(command) !== null;
  }

  function getDangerousBashReason(command: string): string | null {
    if (
      hasSensitiveFileRead(command, isPathBlocked) ||
      hasSensitivePathRedirect(command, isPathBlocked)
    ) {
      return "accesses a sensitive file path";
    }
    if (
      !isLiteralTextWrite(command) &&
      hasEnvironmentVariableExpansionRead(command, allowedEnvironmentVariables, isPathBlocked)
    ) {
      return "expands an unapproved or executable environment variable value";
    }
    if (hasEnvironmentSourceAccess(command)) return "reads process environment from a script";
    if (hasEnvironmentRead(command, allowedEnvironmentVariables)) {
      return "reads environment variables or passes them to an executor";
    }
    if (dangerousBashPatterns.some((pattern) => pattern.test(command))) {
      return "matches a configured dangerous-command pattern";
    }
    return null;
  }

  function isGhCommandAllowed(command: string): boolean {
    const parsed = parseStaticShellCommands(command);
    if (!parsed || typeof parsed === "string") return false;
    const ghCommands = parsed.pipelines
      .flat()
      .map(unwrapStaticCommand)
      .filter((argv) => argv[0]?.split("/").at(-1) === "gh");
    return ghCommands.length > 0 && ghCommands.every(isAllowedGhArgv);
  }

  function allGhCommandsAllowed(command: string): boolean {
    return isGhCommandAllowed(command);
  }

  function detectSleepPolling(command: string): string | null {
    if (!/\bsleep\s+\d+/.test(command)) return null;

    for (const { pattern, suggestion } of DEFAULT_POLLING_DETECTION_RULES) {
      if (pattern.test(command)) {
        return suggestion;
      }
    }
    return null;
  }

  function getBlockedCliTool(command: string): { name: string; wrapper: string } | null {
    const staticCommands = parseStaticShellCommands(command);
    const parsed = staticCommands ?? parseStaticShellCommands(command, true);
    if (parsed && typeof parsed !== "string") {
      const commands = parsed.pipelines.flat().map(unwrapStaticCommand);
      for (const argv of commands) {
        const executable = argv[0]?.split("/").at(-1) ?? "";
        const match = blockedCliTools.find(({ name }) =>
          name === "curl (Azure DevOps)"
            ? executable === "curl" && argv.slice(1).join(" ").includes("dev.azure.com")
            : name === "az" || name === "az (Azure DevOps)"
              ? executable === "az" &&
                (name !== "az (Azure DevOps)" ||
                  /^(?:devops|pipelines|repos|boards|artifacts)$/.test(argv[1] ?? ""))
              : executable === name,
        );
        if (!match) continue;
        if (match.name === "gh" && allGhCommandsAllowed(command)) continue;
        return { name: match.name, wrapper: match.wrapper };
      }
      if (staticCommands) return null;
    }
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
    // Normalize tool name across platforms:
    // - AI coding agents pass capitalized: "Bash", "Read", "Write", "Edit"
    // - OpenCode MCP tools pass prefixed: "mcp_bash", "mcp_read", "mcp_write", "mcp_edit"
    const tool = input.tool.toLowerCase().replace(/^mcp_/, "");
    const args = output.args;

    const filePath = extractFilePath(args);

    if ((tool === "read" || tool === "write" || tool === "edit") && filePath) {
      if (isPathBlocked(filePath)) {
        throw new Error(
          `\u{1F6AB} Access blocked: "${filePath}" is a sensitive file.\n\n` +
            `This file may contain credentials or secrets.\n` +
            `If you need this file's content, ask the user to provide relevant parts.\n\n` +
            `Think this should be allowed? Review the project repository, extend the guard, and submit a PR.`,
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
                `Think this is a false positive? Review the project repository, fix the pattern, and submit a PR.`,
            );
          }
        }
      }
    }

    if (tool === "bash") {
      const command = extractCommand(args);

      const dangerousReason = getDangerousBashReason(command);
      if (dangerousReason) {
        throw new Error(
          `\u{1F6AB} Command blocked: ${dangerousReason}; this command might expose secrets.\n\n` +
            `Command: ${command}\n\n` +
            `If you need environment info, ask the user directly.\n\n` +
            `Think this is wrong? Review the project repository, adjust the patterns, and submit a PR.`,
        );
      }

      const sleepSuggestion = detectSleepPolling(command);
      if (sleepSuggestion) {
        throw new Error(
          `\u{26A0}\u{FE0F} Sleep-polling detected.\n\n` +
            `Instead of polling with sleep, use the built-in watch command:\n\n` +
            `Use instead: ${sleepSuggestion}\n\n` +
            `Watch commands block until completion — no polling needed.`,
        );
      }

      const blockedTool = getBlockedCliTool(command);
      if (blockedTool) {
        const skillName = blockedTool.wrapper.replace("agent-tools-", "") + "-tool";
        throw new Error(
          `\u{1F6AB} Direct ${blockedTool.name} usage blocked.\n\n` +
            `AI agents must use wrapper tools for security and audit.\n\n` +
            `Use instead: bun ${skillName}\n\n` +
            `Example: bun ${skillName} --help\n\n` +
            `Think this tool should be allowed? Review the project repository, extend the whitelist, and submit a PR.\n` +
            `→ Skill "${skillName}"`,
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
    detectSleepPolling,
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

/** Detect sleep-polling with agent-tools wrapper commands (default guard). */
export const detectSleepPolling = defaultGuard.detectSleepPolling;
