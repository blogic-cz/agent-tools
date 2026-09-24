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

/** Static shell words only. Never expand variables or execute a command. */
function parseStaticShellCommands(
  command: string,
): { pipelines: string[][][] } | "brace-expansion" | undefined {
  const pipelines: string[][][] = [];
  let commands: string[][] = [];
  let argv: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | undefined;

  const finishWord = () => {
    if (started) argv.push(word);
    word = "";
    started = false;
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
      return undefined;
    } else if (quote === '"') {
      if (char === quote) quote = undefined;
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === "{" && /^\{[^{}]*(?:,|\.\.)[^{}]*\}/.test(command.slice(i))) {
      return "brace-expansion";
    } else if (/[<>()]/.test(char) || (char === "#" && !started)) {
      return undefined;
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

  if (quote) return undefined;
  finishPipeline();
  return { pipelines };
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
  const program = argv.slice(1).join(" ");
  return /\b(?:system|getline)\s*\(|\||\b(?:print|printf)\b[^\n]*>/.test(program);
}

function isJqObjectConstruction(argv: string[]): boolean {
  return (
    argv[0]?.split("/").at(-1) === "jq" &&
    argv
      .slice(1)
      .some((arg) => /^\{[A-Za-z_][A-Za-z0-9_-]*(?:,\s*[A-Za-z_][A-Za-z0-9_-]*)*\}$/.test(arg)) &&
    !argv.slice(1).some((arg) => /\benv\b|\binput(?:s)?\b/.test(arg))
  );
}

function isEnvironmentListing(argv: string[]): boolean {
  const args = argv.slice(1);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) continue;
    if (arg === "--") return i + 1 === args.length;
    if (arg === "-u" || arg === "--unset" || arg === "-C" || arg === "--chdir") {
      i++;
      continue;
    }
    if (arg === "-i" || arg === "--ignore-environment" || arg.startsWith("--chdir=")) continue;
    if (arg.startsWith("-")) continue;
    return false;
  }
  return true;
}

function unwrapEnvironmentCommand(argv: string[]): string[] | null {
  if (argv[0]?.split("/").at(-1) !== "env") return null;
  const args = argv.slice(1);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) continue;
    if (arg === "--") return i + 1 === args.length ? null : args.slice(i + 1);
    if (arg === "-u" || arg === "--unset" || arg === "-C" || arg === "--chdir") {
      i++;
      continue;
    }
    if (arg === "-i" || arg === "--ignore-environment" || arg.startsWith("--chdir=")) continue;
    if (arg.startsWith("-")) continue;
    return args.slice(i);
  }
  return null;
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
  const argv = [...words];
  const executable = () => argv[0]?.split("/").at(-1);
  while (executable() === "rtk" || executable() === "command") {
    const wrapper = executable();
    argv.shift();
    if (wrapper === "rtk" && argv[0] === "proxy") argv.shift();
    if (wrapper === "command" && argv[0] === "--") argv.shift();
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

function isPassiveTextCommand(argv: string[]): boolean {
  const name = argv[0]?.split("/").at(-1) ?? "";
  const args = argv.slice(1);
  // These commands consume literal text. Execution options are not exceptions.
  if (["echo", "printf", "grep", "head"].includes(name)) {
    return true;
  }
  if (name === "rg") return !hasExecutionOption(args, ["pre", "hostname-bin"]);
  if (name === "awk") return !isAwkExecution(argv);
  if (name === "jq") return isJqObjectConstruction(argv);
  return (
    name === "git" &&
    args[0] === "grep" &&
    !hasExecutionOption(args, ["open-files-in-pager", "textconv"], "O")
  );
}

function hasStaticEnvironmentRead(argv: string[], allowedNames: Set<string>): boolean {
  const name = argv[0]?.split("/").at(-1);
  if (name === "printenv") return !isAllowedEnvironmentRead(argv, allowedNames);
  if (name === "env") {
    const wrapped = unwrapEnvironmentCommand(argv);
    return wrapped === null
      ? isEnvironmentListing(argv)
      : hasStaticEnvironmentRead(unwrapStaticCommand(wrapped), allowedNames);
  }
  if (isPassiveTextCommand(argv)) return false;
  // Any command may re-parse an argument as shell code (trap, find -exec, awk system()).
  return (
    hasArgumentBraceExpansion(argv.slice(1).join(" ")) || mentionsEnvironmentRead(argv.join(" "))
  );
}

function isStaticHerdrPrompt(command: string): boolean {
  if (/^herdr\s+agent\s+prompt\s+\S+\s+(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*')$/.test(command.trim())) {
    if (!/[$`]/.test(command)) return true;
    return !hasSensitiveFileRead(command) && !mentionsEnvironmentRead(command);
  }
  const parsed = parseStaticShellCommands(command);
  if (
    !parsed ||
    typeof parsed === "string" ||
    parsed.pipelines.length !== 1 ||
    parsed.pipelines[0]?.length !== 1
  ) {
    return false;
  }
  const argv = unwrapStaticCommand(parsed.pipelines[0]?.[0] ?? []);
  return argv[0] === "herdr" && argv[1] === "agent" && argv[2] === "prompt";
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

/** A single literal writer cannot execute its body or feed another command. */
function isLiteralTextWrite(command: string): boolean {
  const lines = command.trimEnd().split(/\r?\n/);
  const heredoc = /^(.*?)<<(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\3[ \t]*$/.exec(lines[0] ?? "");
  let header = command;
  let writers = ["echo", "printf"];
  if (heredoc) {
    const [, prefix, stripTabs, quote, delimiter] = heredoc;
    const end = lines.findIndex(
      (line, index) => index > 0 && (stripTabs ? line.replace(/^\t+/, "") : line) === delimiter,
    );
    // Only the first delimiter closes the body. No following commands are exceptions.
    if (end < 0 || end !== lines.length - 1) return false;
    const body = lines.slice(1, end).join("\n");
    if (!quote && /[$`\\]/.test(body)) return false;
    header = prefix ?? "";
    writers = ["cat", "tee"];
  } else if (!command.includes(">")) {
    return false;
  }

  // Output redirection does not execute text. Other unsupported syntax still fails parsing.
  const parsed = parseStaticShellCommands(header.replace(/2>&1/g, " ").replace(/>>?/g, " "));
  if (!parsed || parsed === "brace-expansion") {
    const balancedQuotes =
      (command.match(/'/g)?.length ?? 0) % 2 === 0 && (command.match(/"/g)?.length ?? 0) % 2 === 0;
    return (
      balancedQuotes &&
      /^(?:cd\s+\S+\s+&&\s+)?(?:echo|printf)\b[\s\S]*>>?\s+\S+\s*(?:&&\s+tail\b.*)?$/i.test(command)
    );
  }
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

function hasSensitiveFileRead(command: string): boolean {
  const sensitivePath =
    /(?:^|[/\s'"])(?:[.]env(?![.](?:example|template|sample)\b)|\S*[.](?:pem|key)\b|\S*[.](?:ssh|aws)[/]|(?:\S*secret(?:-|[/\s.]|$))|(?:(?:secrets?|credentials?)(?:[/\s.]|$)|[A-Za-z0-9_.-]*(?:secrets?|credentials?)(?:[/\s.]|$)|[A-Za-z0-9_.-]*-(?:secrets?|credentials?)(?:[/\s.-]|$)))/i;
  const sensitiveCamelCase =
    /(?:^|[/\s'"])[A-Za-z0-9_.-]*(?:(?:secret|credential)[A-Z]|(?:Secret|Credential)[A-Z])[^/\s'"]*/;
  const sensitiveName = /secret|credential/i;
  const isSensitivePath = (text: string) =>
    sensitivePath.test(text) || sensitiveCamelCase.test(text) || sensitiveName.test(text);
  if (/(?:^|[\s;&|])--env-file(?:=|\s)[^;&|]*\.env\b/i.test(command)) return true;
  if (/\bcat\b[^;&|]*<<-?\s*\S+[\s\S]*\b(?:secret|credential)\b/i.test(command)) return true;
  const parsed = parseStaticShellCommands(command);
  const readers = /\b(?:cat|cp|grep|rg|sed|awk|head|tail|less|more|source|ls)\b/i;
  if (parsed && parsed !== "brace-expansion") {
    return parsed.pipelines.flat().some((words) => {
      const argv = unwrapStaticCommand(words);
      const inspectedArgv =
        argv[0]?.split("/").at(-1) === "env" ? unwrapEnvironmentCommand(argv) : argv;
      if (inspectedArgv === null) return false;
      const inspected = unwrapStaticCommand(inspectedArgv);
      const name = inspected[0]?.split("/").at(-1) ?? "";
      return readers.test(name) && inspected.slice(1).some(isSensitivePath);
    });
  }
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

function hasEnvironmentVariableExpansionRead(command: string): boolean {
  if (!/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/.test(command)) return false;
  return /\b(?:echo|printf)\b[^;&|]*\$|\b(?:sh|bash|zsh)\b[^;&|]*\s-c\b/i.test(command);
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
    return (
      dangerousBashPatterns.some((pattern) => pattern.test(command)) ||
      hasSensitiveFileRead(command) ||
      hasEnvironmentVariableExpansionRead(command) ||
      hasEnvironmentSourceAccess(command) ||
      hasEnvironmentRead(command, allowedEnvironmentVariables)
    );
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

      if (isDangerousBashCommand(command)) {
        throw new Error(
          `\u{1F6AB} Command blocked: This command might expose secrets.\n\n` +
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
