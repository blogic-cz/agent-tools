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
import { redactSensitiveText } from "#shared/content-security";
import { SECRET_PATTERNS } from "#shared/credential-patterns";
import { posix } from "node:path";

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

const PROCESS_ENVIRONMENT_PATH =
  /^(?:\/|(?:\.\.\/)*)proc\/(?:self|thread-self|[0-9]+|\$\$|\$\{\$\})(?:\/task\/(?:[0-9]+|\$\$|\$\{\$\}))?\/environ$/;

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
    while (/[ \t\n]/.test(command[offset] ?? "")) offset++;
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z0-9_./-]+)/.exec(command.slice(offset));
    if (!assignment) break;
    const end = offset + assignment[0].length;
    const next = command.slice(end).match(/^[ \t]*/)?.[0].length ?? 0;
    const separator = command[end + next];
    if (separator !== ";" && separator !== "\n") break;
    assignments.set(assignment[1] ?? "", { value: assignment[2] ?? "", end });
    offset = end + next + 1;
  }
  return assignments;
}

function isSafeHerdrTabCreate(argv: string[]): boolean {
  if (argv[0] !== "herdr" || argv[1] !== "tab" || argv[2] !== "create") return false;
  const seen = new Set<string>();
  for (let index = 3; index < argv.length; index++) {
    const arg = argv[index] ?? "";
    const [option, ...attached] = arg.split("=");
    if (option === "--focus" || option === "--no-focus") {
      if (attached.length || seen.has("focus")) return false;
      seen.add("focus");
      continue;
    }
    if (!["--workspace", "--cwd", "--label"].includes(option ?? "") || seen.has(option ?? ""))
      return false;
    const value = attached.length ? attached.join("=") : argv[++index];
    if (!value || (!attached.length && value.startsWith("--"))) return false;
    seen.add(option ?? "");
  }
  return true;
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
      return (
        words.length === 1 &&
        assignment[1] !== "IFS" &&
        assignments.get(assignment[1] ?? "")?.value === assignment[2]
      );
    }
    return isSafeLocalAssignmentCommand(words);
  });
}

function isSafeLocalAssignmentCommand(words: string[]): boolean {
  const argv = unwrapStaticCommand(words);
  if (isSafeHerdrTabCreate(argv)) return true;
  const name = argv[0]?.split("/").at(-1) ?? "";
  if (name === "wc" && hasExecutionOption(argv.slice(1), ["files0-from"])) return false;
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
  if (name === "sed") return isReadonlySedPrint(argv);
  return (
    isPassiveTextCommand(argv) ||
    ["ls", "cat", "tail", "wc", "uniq", "cut", "mv"].includes(name) ||
    (name === "sort" &&
      !hasExecutionOption(argv.slice(1), ["compress-program", "files0-from", "output"], "o"))
  );
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

/** A lexical binding proof, preserving shell quotes and rejecting every other expansion. */
function literalBindingText(
  command: string,
  name: string,
  value: string,
): { text: string; syntax: string } | undefined {
  let text = "";
  let syntax = "";
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i++) {
    const char = command[i] ?? "";
    if (!quote && /[^\S \t\n]/.test(char)) return undefined;
    if (char === "\\" && quote !== "'") {
      const next = command[++i];
      if (next === undefined || /[\r\n]/.test(next)) return undefined;
      text += char + next;
      syntax += "  ";
    } else if (quote === "'") {
      text += char;
      syntax += " ";
      if (char === quote) quote = undefined;
    } else if (char === "'" && !quote) {
      quote = char;
      text += char;
      syntax += " ";
    } else if (char === '"') {
      quote = quote ? undefined : char;
      text += char;
      syntax += " ";
    } else if (char === "$") {
      const match = /^\$\{([A-Za-z_]\w*)\}|^\$([A-Za-z_]\w*)/.exec(command.slice(i));
      if (!match || (match[1] ?? match[2]) !== name) return undefined;
      text += value;
      syntax += quote ? " ".repeat(value.length) : value;
      i += match[0].length - 1;
    } else {
      if (char === "`" || (!quote && /[(){}*?[\]#]/.test(char))) return undefined;
      text += char;
      syntax += quote ? " " : char;
    }
  }
  return quote ? undefined : { text, syntax };
}

/** These single-letter binders cannot name shell lookup, splitting or generated variables. */
function isLiteralBinder(name: string): boolean {
  return /^(?:[a-z]|T)$/.test(name);
}

function unwrapProofCommand(words: string[], marker: string): string[] | undefined {
  let index = 0;
  while (words[index] === "rtk" || words[index] === "command") {
    if (words[index++] === "rtk") {
      if (words[index++] !== "proxy") return undefined;
    } else if (words[index] === "--") index++;
  }
  if (words.slice(0, index + 1).some((word) => word.includes(marker))) return undefined;
  const argv = words.slice(index);
  if (!argv.length || /^[A-Za-z_]\w*=/.test(argv[0] ?? "")) return undefined;
  return argv;
}

function isLiteralLoopCommand(words: string[], marker: string, value: string): boolean {
  const marked = unwrapProofCommand(words, marker);
  if (!marked) return false;
  const argv = marked.map((word) => word.replaceAll(marker, () => value));
  const name = argv[0];
  const uses = marked.flatMap((word, index) => (word.includes(marker) ? [index] : []));
  if (name === "cat")
    return (
      argv.slice(1).every((word) => word === "--" || !word.startsWith("-")) &&
      uses.every((index) => index > 0 && !argv[index]?.startsWith("-"))
    );
  if (name === "echo") return uses.every((index) => index > 0 && !argv[index]?.startsWith("-"));
  if (name === "printf") {
    const format = passivePrintfFormatIndex(argv);
    return format !== undefined && uses.every((index) => index > format);
  }
  if (name === "herdr") return isLiteralHerdrRead(argv) && uses.every((index) => index === 3);
  if (name === "bun")
    return (
      argv.length === 9 &&
      argv.slice(0, 6).join(" ") === "bun run gh-tool pr review-triage --repo" &&
      /^[A-Za-z0-9_.-]+$/.test(argv[6] ?? "") &&
      argv[7] === "--pr" &&
      /^\d+$/.test(argv[8] ?? "") &&
      uses.every((index) => index === 8)
    );
  return (
    uses.length === 0 &&
    ((["grep", "head", "tail"].includes(name ?? "") && isPassiveTextCommand(argv)) ||
      isLiteralStdinJsonDisplay(argv))
  );
}

function isLiteralHerdrRead(argv: string[]): boolean {
  return (
    argv[0] === "herdr" &&
    !argv[3]?.startsWith("-") &&
    /^[A-Za-z0-9_.:-]+$/.test(argv[3] ?? "") &&
    ((argv.length === 4 && argv[1] === "agent" && argv[2] === "get") ||
      (argv.length === 8 &&
        ["pane", "agent"].includes(argv[1] ?? "") &&
        argv[2] === "read" &&
        argv[4] === "--source" &&
        argv[5] === "recent-unwrapped" &&
        argv[6] === "--lines" &&
        /^[1-9]\d*$/.test(argv[7] ?? "")))
  );
}

/** Conventional platform shell names and numeric versions; not arbitrary renamed executables. */
function isShellWord(word: string): boolean {
  return /^(?:sh|bash|rbash|zsh|dash|ash|ksh|rksh|csh|tcsh|fish)(?:[.-]?[0-9]+(?:[.][0-9]+)*)?$/.test(
    word.split("/").at(-1) ?? "",
  );
}

/** Shell-named operands are data only under an existing non-executing argument role. */
function hasProvedShellDataOperands(argv: string[]): boolean {
  const name = argv[0]?.split("/").at(-1) ?? "";
  if (isPassiveTextCommand(argv) || isLiteralHerdrRead(argv) || isStaticNavigationCommand(argv))
    return true;
  if (["cat", "ls", "uniq", "cut"].includes(name)) return true;
  if (["find", "wc", "sort"].includes(name)) return isProvedCwdSubprocessRole(argv);
  return name === "test" && argv.length === 3 && argv[1] === "-e" && !/[$`]/.test(argv[2] ?? "");
}

const SHELL_IDENTITIES = new Set([
  "sh",
  "bash",
  "zsh",
  "/bin/sh",
  "/usr/bin/sh",
  "/bin/bash",
  "/usr/bin/bash",
  "/bin/zsh",
  "/usr/bin/zsh",
]);

/** Literal argv only. Undefined means a shell was found without a complete invocation proof. */
function literalShellBodies(command: string): string[] | undefined {
  const parsed = parseStaticShellCommands(command);
  const operands = parsed ?? parseStaticShellCommands(command, true);
  if (!operands || typeof operands === "string") return [];
  const commands = operands.pipelines.flat();
  if (
    commands.some((words) =>
      ["exec", "nohup", "sudo"].includes(unwrapStaticCommand(words)[0]?.split("/").at(-1) ?? ""),
    )
  )
    return undefined;
  for (const words of commands) {
    const argv = unwrapStaticCommand(words);
    if (
      !isShellWord(argv[0] ?? "") &&
      argv.some(
        (word, index) =>
          index !== inlineProgramIndex(argv) &&
          (isShellWord(word) ||
            (/^--?[A-Za-z0-9-]+=/.test(word) && isShellWord(word.slice(word.indexOf("=") + 1)))),
      ) &&
      !hasProvedShellDataOperands(argv) &&
      !isStaticHerdrPrompt(command)
    )
      return undefined;
  }
  const shells = commands.filter((words) => isShellWord(unwrapStaticCommand(words)[0] ?? ""));
  if (!shells.length) return [];
  if (
    !parsed ||
    typeof parsed === "string" ||
    !literalBindingText(command, "", "") ||
    new TextEncoder().encode(command).byteLength > 65_536 ||
    commands.some((words) => unwrapStaticCommand(words)[0]?.split("/").at(-1) === "cd")
  )
    return undefined;
  const bodies: string[] = [];
  for (const words of shells) {
    const argv = unwrapProofCommand(words, "\0");
    if (!argv || !SHELL_IDENTITIES.has(argv[0] ?? "")) return undefined;
    const name = argv[0]?.split("/").at(-1);
    if (argv.length === 2 && ["--version", "--help"].includes(argv[1] ?? "")) continue;
    const index = name === "zsh" && argv[1] === "-f" ? 2 : 1;
    if ((name === "zsh" && index !== 2) || argv[index] !== "-c" || argv.length !== index + 2)
      return undefined;
    bodies.push(argv[index + 1] ?? "");
  }
  return bodies;
}

function isProvedLiteralShellBody(body: string): boolean {
  if (!body.trim()) return true;
  const materialized = materializeLiteralShell(body)?.command ?? body;
  const parsed = parseStaticShellCommands(materialized);
  if (!parsed || typeof parsed === "string" || !hasProvedNavigationSequence(materialized))
    return false;
  if (isStaticHerdrPrompt(materialized)) return true;
  return parsed.pipelines.flat().every((words) => {
    const argv = unwrapProofCommand(words, "\0");
    if (!argv) return false;
    if (argv[0]?.split("/").at(-1) === "env") return false;
    const name = unwrapStaticCommand(argv)[0]?.split("/").at(-1) ?? "";
    if (isShellWord(name))
      return (
        literalShellBodies(
          words.map((word) => "'" + word.replaceAll("'", "'\"'\"'") + "'").join(" "),
        ) !== undefined
      );
    return (
      isProvedCwdSubprocessRole(unwrapStaticCommand(argv)) ||
      (name === "bun" && isSafeLocalAssignmentCommand(argv) && !isUnsupportedInlineRuntime(argv)) ||
      isStaticNavigationCommand(argv) ||
      isLiteralHerdrRead(argv) ||
      (argv.length === 1 && ["true", "false", "pwd"].includes(name))
    );
  });
}

/** A complete stdin-only JSON projection, with no suffix, imports or executable input. */
function isLiteralStdinJsonDisplay(argv: string[]): boolean {
  if (argv.length !== 3 || !["python", "python3"].includes(argv[0] ?? "") || argv[1] !== "-c")
    return false;
  const program = argv[2] ?? "";
  if (program.length > 65_536) return false;
  const parts = programParts(program, true);
  if (!parts || parts.literals.join("\0") !== "result\0text\0\0result") return false;
  // ponytail: one JSON projection with a single-letter local; extend only with another complete grammar.
  const code = parts.code.replace(/[ \t]+/g, " ").trim();
  return /^import json\s*,\s*sys\s*(?:;|\r?\n)\s*([a-z])\s*=\s*json\s*\.\s*load\s*\(\s*sys\s*\.\s*stdin\s*\)\s*(?:;|\r?\n)\s*print\s*\(\s*\1\s*\[\s*STRING\s*\]\s*\.\s*get\s*\(\s*STRING\s*,\s*STRING\s*\)\s+if isinstance\s*\(\s*\1\s*\.\s*get\s*\(\s*STRING\s*\)\s*,\s*dict\s*\)\s+else \1\s*\)\s*;?$/.test(
    code,
  );
}

type LiteralShellProof = { command: string; paths: string[] };

/** Bounded observed shell forms only; failure leaves the original command under normal policy. */
function materializeLiteralShell(command: string): LiteralShellProof | undefined {
  if (new TextEncoder().encode(command).byteLength > 65_536) return undefined;
  const marker = "GUARDLITERALBINDING";
  if (command.includes(marker)) return undefined;
  let script = command.replace(/^[ \t\n]+|[ \t\n]+$/g, "");
  const wrapped = parseStaticShellCommands(script);
  if (
    wrapped &&
    typeof wrapped !== "string" &&
    wrapped.pipelines.length === 1 &&
    wrapped.pipelines[0]?.length === 1 &&
    wrapped.redirects.length === 0
  ) {
    const argv = unwrapProofCommand(wrapped.pipelines[0]?.[0] ?? [], marker);
    if (argv?.[0] === "sh" && argv[1] === "-c" && argv.length === 3) {
      if (!literalBindingText(script, "", "")) return undefined;
      script = argv[2] ?? "";
    }
  }
  const loop =
    /^for[ \t]+([A-Za-z_]\w*)[ \t]+in[ \t]+([^;\n]+);[ \t\r\n]*do[ \t\r\n]+([\s\S]*);[ \t\r\n]*done[ \t\r\n]*$/.exec(
      script,
    );
  if (loop) {
    const name = loop[1] ?? "";
    if (!isLiteralBinder(name)) return undefined;
    const items = loop[2] ?? "";
    const rawValues = items.trim().split(/[ \t]+/);
    if (
      rawValues.some(
        (item) =>
          !/^(?:[A-Za-z0-9_./:][A-Za-z0-9_./:-]*|'[A-Za-z0-9_./:][A-Za-z0-9_./:-]*'|"[A-Za-z0-9_./:][A-Za-z0-9_./:-]*")$/.test(
            item,
          ),
      )
    )
      return undefined;
    const values = rawValues.map((item) => item.replace(/^['"]|['"]$/g, ""));
    if (!values.length || values.length > 16) return undefined;
    const marked = literalBindingText(loop[3] ?? "", name, marker);
    if (!marked || /&&|\|\||[<>]|&/.test(marked.syntax.replace(/\b2>&1(?=[ \t\n;|]|$)/g, "")))
      return undefined;
    const parsed = parseStaticShellCommands(marked.text);
    if (
      !parsed ||
      typeof parsed === "string" ||
      parsed.redirects.length ||
      parsed.pipelines.flat().length > 16 ||
      !parsed.pipelines.flat().length
    )
      return undefined;
    if (
      !values.every((value) =>
        parsed.pipelines.flat().every((words) => isLiteralLoopCommand(words, marker, value)),
      )
    )
      return undefined;
    const size = values.reduce(
      (total, value) =>
        total +
        new TextEncoder().encode(marked.text).byteLength +
        (marked.text.split(marker).length - 1) * (value.length - marker.length) +
        2,
      0,
    );
    if (size > 65_536) return undefined;
    return {
      command: values.map((value) => marked.text.replaceAll(marker, () => value)).join(";\n"),
      paths: [],
    };
  }
  // Single ASCII-letter names avoid shell startup/special variables such as PATH and IFS.
  const assignment =
    /^(?:cd[ \t]+(~?\/?[A-Za-z0-9_./-]+)[ \t]*(;|\n|&&)[ \t]*)?([A-Za-z])=([A-Za-z0-9_./][A-Za-z0-9_./-]*)[ \t]*(;|\n|&&)[ \t]*/.exec(
      script,
    );
  if (assignment) {
    const rest = literalBindingText(
      script.slice(assignment[0].length),
      assignment[3] ?? "",
      marker,
    );
    if (!rest || !rest.text.includes(marker)) return undefined;
    // No branches, background jobs or pipeline-local state. FD duplication stays inert.
    const syntax = rest.syntax.replace(/[<>]&[0-9-]+/g, "");
    if (/\|\||(^|[^&])&(?!&)|[^\S \t\n]/.test(syntax)) return undefined;
    if (assignment[2] === "&&") {
      if (assignment[5] !== "&&") return undefined;
      const boundary = rest.syntax.search(/[;\r\n]/);
      if (boundary >= 0 && rest.text.slice(boundary).includes(marker)) return undefined;
    }
    const parsed = parseStaticShellCommands(rest.text);
    if (
      !parsed ||
      typeof parsed === "string" ||
      parsed.redirects.some(({ target }) => target.includes(marker)) ||
      !parsed.pipelines.flat().length ||
      parsed.pipelines.flat().length > 32
    )
      return undefined;
    const value = assignment[4] ?? "";
    const paths: string[] = [];
    for (const words of parsed.pipelines.flat()) {
      const marked = unwrapProofCommand(words, marker);
      if (!marked) return undefined;
      const argv = marked.map((word) => word.replaceAll(marker, () => value));
      const name = argv[0]?.split("/").at(-1) ?? "";
      const uses = marked.flatMap((word, index) => (word.includes(marker) ? [index] : []));
      const checksum =
        ["shasum", "sha1sum", "sha256sum", "sha512sum", "md5sum", "cksum"].includes(name) &&
        !hasExecutionOption(argv.slice(1), ["check"], "c");
      if (!uses.length) {
        if (
          !isSafeLocalAssignmentCommand(argv) &&
          inlineProgramIndex(argv) === undefined &&
          !(argv[0] === "git" && argv[1] === "commit") &&
          !checksum
        )
          return undefined;
        continue;
      }
      if (
        uses.some(
          (index) => index === 0 || !/^[A-Za-z0-9_./][A-Za-z0-9_./-]*$/.test(argv[index] ?? ""),
        )
      )
        return undefined;
      const gitAdd =
        argv.slice(0, 3).join(" ") === "git add --" && uses.every((index) => index >= 3);
      const reader =
        ["cat", "ls", "head", "tail", "wc", "uniq", "cut", "sort", "grep", "rg"].includes(name) &&
        isSafeLocalAssignmentCommand(argv);
      if (!gitAdd && !reader && !checksum) return undefined;
      paths.push(...uses.map((index) => argv[index] ?? ""));
    }
    const prefix = assignment[1] ? `cd ${assignment[1]}${assignment[2]} ` : "";
    const size =
      new TextEncoder().encode(prefix + rest.text).byteLength +
      (rest.text.split(marker).length - 1) * (value.length - marker.length);
    if (paths.length > 32 || size > 65_536) return undefined;
    return { command: prefix + rest.text.replaceAll(marker, () => value), paths };
  }
  // Expand only complete, unquoted path words. Keep all other source text intact.
  const paths: string[] = [];
  let expanded = "";
  let marked = "";
  let start = 0;
  let quote: "'" | '"' | undefined;
  let braces = false;
  const finishWord = (end: number): boolean => {
    const word = command.slice(start, end);
    if (!braces) {
      expanded += word;
      marked += word;
      return true;
    }
    // ponytail: one comma-list per path, no nesting; extend only with a bounded shell parser.
    const match =
      /^([A-Za-z0-9_./-]*\/[A-Za-z0-9_./-]*)\{([A-Za-z0-9_./-]+(?:,[A-Za-z0-9_./-]+)+)\}([A-Za-z0-9_./-]*)$/.exec(
        word,
      );
    if (!match) return false;
    const members = (match[2] ?? "").split(",");
    if (members.length > 16 || paths.length + members.length > 32) return false;
    const values = members.map((member) => (match[1] ?? "") + member + (match[3] ?? ""));
    const text = values.join(" ");
    if (expanded.length + text.length + command.length - end > 65_536) return false;
    paths.push(...values);
    expanded += text;
    marked += marker;
    return true;
  };
  for (let i = 0; i <= command.length; i++) {
    const char = command[i];
    if (quote === "'") {
      if (char === quote) quote = undefined;
    } else if (char === "\\") {
      if (command[i + 1] === undefined || /[\r\n]/.test(command[i + 1] ?? "")) return undefined;
      i++;
    } else if (quote === '"') {
      if (char === quote) quote = undefined;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "{" || char === "}") {
      braces = true;
    } else if (char === undefined || /[ \t\n]/.test(char)) {
      if (!finishWord(i)) return undefined;
      expanded += char ?? "";
      marked += char ?? "";
      start = i + 1;
      braces = false;
    } else if (/[\s;&|<>#]/.test(char)) {
      // Other JS whitespace is a literal shell word character, not a token boundary.
      return undefined;
    }
  }
  if (quote || !paths.length || new TextEncoder().encode(expanded).byteLength > 65_536)
    return undefined;
  const parsed = parseStaticShellCommands(marked);
  if (
    !parsed ||
    typeof parsed === "string" ||
    parsed.redirects.length ||
    parsed.pipelines.length !== 1 ||
    parsed.pipelines[0]?.length !== 1
  )
    return undefined;
  const argv = unwrapProofCommand(parsed.pipelines[0]?.[0] ?? [], marker);
  const expandedCommands = parseStaticShellCommands(expanded);
  const expandedArgv =
    expandedCommands && typeof expandedCommands !== "string"
      ? unwrapProofCommand(expandedCommands.pipelines[0]?.[0] ?? [], marker)
      : undefined;
  // Classify actual options too: a marked path can hide an executor such as git grep -O/path.
  if (
    !argv ||
    !expandedArgv ||
    (!isPassiveTextCommand(expandedArgv) && expandedArgv[0]?.split("/").at(-1) !== "cat")
  )
    return undefined;
  return { command: expanded, paths };
}

/** Complete package metadata loops: no prelude, loader shadowing, mutation or arbitrary suffix. */
function staticPackageInventory(program: string): string[] | undefined {
  if (program.length > 65_536) return undefined;
  const prefix =
    /^for\s*\(\s*const\s+([a-z])\s+of\s+(\[\s*(?:"[A-Za-z0-9_./@-]+"|'[A-Za-z0-9_./@-]+')(?:\s*,\s*(?:"[A-Za-z0-9_./@-]+"|'[A-Za-z0-9_./@-]+'))*\s*\])\s*\)\s*\{\s*(try\s*\{\s*)?const\s+([a-z])\s*=\s*require\s*\(\s*(["'])\.\/\5\s*\+\s*\1\s*\)\s*;\s*/.exec(
      program.trim(),
    );
  if (!prefix || prefix[1] === prefix[4]) return undefined;
  const paths = [...(prefix[2] ?? "").matchAll(/["']([^"']+)["']/g)].map(
    (match) => "./" + (match[1] ?? ""),
  );
  if (
    !paths.length ||
    paths.length > 16 ||
    // Four bytes per character bounds encoded text and shell quote escaping before allocation.
    (program.length + Math.max(...paths.map((path) => path.length)) + 64) * paths.length * 4 >
      65_536 ||
    paths.some((path) => !/(?:^|\/)package\.json$/.test(path))
  )
    return undefined;
  const name = prefix[1];
  const result = prefix[4];
  const end = prefix[3] ? String.raw`\s*\}\s*catch\s*\{\s*\}\s*\}` : String.raw`\s*\}`;
  const suffix = program.trim().slice(prefix[0].length);
  const bin = new RegExp(
    String.raw`^console\.log\(\s*${name}\s*,\s*${result}\.bin\s*\)\s*;?${end}\s*$`,
  );
  const scripts = new RegExp(
    String.raw`^console\.log\(\s*${name}\s*,\s*Object\.entries\(\s*${result}\.scripts\s*\|\|\s*\{\}\s*\)\.filter\(\(\[n\]\)=>n\.endsWith\("-tool"\)\|\|n\.endsWith\(":cli"\)\|\|n\.endsWith\(":auth"\)\|\|n==="ui:check"\)\s*\)\s*;?${end}\s*$`,
  );
  return bin.test(suffix) || scripts.test(suffix) ? paths : undefined;
}

/** Shared identity for refusal paths, including versioned/free-threaded Python and Windows names. */
function inlineRuntimeKind(executable: string | undefined): "python" | "node" | "bun" | undefined {
  const name =
    executable
      ?.split(/[/\\]/)
      .at(-1)
      ?.replace(/\.exe$/i, "") ?? "";
  if (/^python(?:\d+(?:\.\d+)*)?t?$/i.test(name)) return "python";
  if (/^node$/i.test(name)) return "node";
  if (/^bun$/i.test(name)) return "bun";
  return undefined;
}

function mentionsInlineRuntime(command: string): boolean {
  return command.split(/[\s'"`()<>;&|]+/).some((word) => inlineRuntimeKind(word) !== undefined);
}

/** Locate code only in an actual inline-program operand, after supported runtime flags. */
function inlineProgramIndex(argv: string[]): number | undefined {
  const executable = argv[0]?.split("/").at(-1) ?? "";
  const name = inlineRuntimeKind(argv[0]);
  // Other recognized runtime spellings retain conservative refusal; this exception is bounded.
  if (!name || !["python", "python3", "node", "bun"].includes(executable)) return undefined;
  const python = name === "python";
  const flags = python ? ["-u", "-B", "-I", "-S"] : name === "bun" ? ["--no-env-file"] : [];
  let index = 1;
  while (flags.includes(argv[index] ?? "")) index++;
  if (
    !(python ? argv[index] === "-c" : ["-e", "--eval"].includes(argv[index] ?? "")) ||
    argv[index + 1] === undefined
  )
    return undefined;
  // Python consumes the remaining words as sys.argv. Node can still parse startup options
  // after eval, until -- or an ordinary positional operand. Bun suffixes require explicit --.
  const suffix = argv[index + 2];
  if (name === "bun" && suffix !== undefined && suffix !== "--") return undefined;
  if (name === "node" && suffix?.startsWith("-") && suffix !== "--") return undefined;
  return index + 1;
}

function isUnsupportedInlineRuntime(argv: string[]): boolean {
  const runtime = inlineRuntimeKind(argv[0]);
  if (!runtime) return false;
  if (inlineProgramIndex(argv) !== undefined) return false;
  let index = 1;
  for (; index < argv.length; index++) {
    const arg = argv[index] ?? "";
    if (arg === "--" || !arg.startsWith("-")) break;
    if (
      /^(?:-[A-Za-z]*[cep]|-[rmp]|--(?:eval|print|require|import|loader|preload|experimental-loader))(?:$|=|[^-])/.test(
        arg,
      )
    )
      return true;
    if (
      (runtime === "python" && arg === "--check-hash-based-pycs") ||
      (runtime === "node" &&
        ["--conditions", "-C", "--icu-data-dir", "--dns-result-order"].includes(arg))
    ) {
      if (argv[index + 1] === undefined) return true;
      index++;
      continue;
    }
    // Unknown startup-option arity cannot establish where the script/tool begins.
    if (
      !(
        (runtime === "python" && /^-[uBISsEOqvV]+$/.test(arg)) ||
        (runtime === "node" &&
          /^(?:--(?:trace-warnings|no-warnings|version|help)|--(?:conditions|icu-data-dir|dns-result-order)=.+)$/.test(
            arg,
          )) ||
        (runtime === "bun" && ["--no-env-file", "--version", "--help"].includes(arg)) ||
        ["--version", "--help", "-h"].includes(arg)
      )
    )
      return true;
  }
  if (runtime === "bun" && ["exec", "repl"].includes(argv[index] ?? "")) return true;
  // Bun retains eval/loader controls around its tool operand; only a later -c is tool data.
  return (
    runtime === "bun" &&
    argv
      .slice(index)
      .some((arg) =>
        /^(?:-[A-Za-z]*[ep]|-[rmp]|--(?:eval|print|require|import|loader|preload|experimental-loader))(?:$|=|[^-])/.test(
          arg,
        ),
      )
  );
}

/** Move a complete, literal Python stdin program into the existing inline argv boundary. */
function normalizeProgramHeredocs(command: string): string {
  const heredoc = boundedHeredoc(command);
  if (!heredoc || !heredoc.closed || (!heredoc.quoted && /[$`\\]/.test(heredoc.body)))
    return command;
  const parsed = parseStaticShellCommands(heredoc.header);
  if (!parsed || typeof parsed === "string") return command;
  const last = parsed.pipelines.at(-1)?.at(-1);
  const argv = last ? unwrapStaticCommand(last) : [];
  if (
    inlineRuntimeKind(argv[0]) !== "python" ||
    inlineProgramIndex([argv[0] ?? "", "-c", ""]) === undefined ||
    argv.length !== 2 ||
    argv[1] !== "-"
  )
    return command;
  if (!/-\s*$/.test(heredoc.header)) return command;
  const quoted = "'" + heredoc.body.replaceAll("'", "'\"'\"'") + "'";
  return (
    heredoc.header.replace(/-\s*$/, () => "-c " + quoted) +
    "\n" +
    normalizeProgramHeredocs(heredoc.following)
  );
}

/** Strings are data in these languages; retain their values separately for path checks. */
function programParts(
  program: string,
  python: boolean,
):
  | { code: string; literals: string[]; pathLiterals: string[]; loadedModules: string[] }
  | undefined {
  const literals: string[] = [];
  const pathLiterals: string[] = [];
  const loadedModules: string[] = [];
  let code = "";
  for (let i = 0; i < program.length; i++) {
    const char = program[i] ?? "";
    if ((python && char === "#") || (!python && program.startsWith("//", i))) {
      const terminator = python ? /[\r\n]/ : /[\r\n\u2028\u2029]/;
      while (i < program.length && !terminator.test(program[i] ?? "")) i++;
      code += "\n";
      continue;
    }
    if (!python && program.startsWith("/*", i)) {
      const end = program.indexOf("*/", i + 2);
      if (end < 0) return undefined;
      i = end + 1;
      code += " ";
      continue;
    }
    if (!python && char === "/") {
      // Recognize regex only at an expression start; ambiguous slash syntax stays closed.
      if (!/[=(,:!&|?;[{]\s*$/.test(code) && !/\breturn\s+$/.test(code)) return undefined;
      let inClass = false;
      let closed = false;
      for (i++; i < program.length; i++) {
        const next = program[i];
        if (next === "\\") {
          i++;
          continue;
        }
        if (next === "\n") return undefined;
        if (next === "[") inClass = true;
        else if (next === "]") inClass = false;
        else if (next === "/" && !inClass) {
          closed = true;
          break;
        }
      }
      if (!closed) return undefined;
      code += " REGEX ";
      continue;
    }
    if (char !== "'" && char !== '"' && char !== "`") {
      code += char;
      continue;
    }
    // Bun.write(PATH, TEXT) differs from file-object write(TEXT).
    const literalTextArgument =
      (/\.(?:write_text|write)\s*\(\s*$/.test(code) && !/\bBun\s*\.\s*write\s*\(\s*$/.test(code)) ||
      /\bBun\s*\.\s*write\s*\(\s*STRING\s*,\s*$/.test(code);
    const interpolated = python && /[fF]/.test(/[rRuUbBfF]+$/.exec(program.slice(0, i))?.[0] ?? "");
    const delimiter = program.startsWith(char.repeat(3), i) ? char.repeat(3) : char;
    i += delimiter.length;
    let value = "";
    let expressionDepth = 0;
    while (i < program.length && !program.startsWith(delimiter, i)) {
      if (program[i] === "\\") {
        value += program[i] + (program[++i] ?? "");
        i++;
      } else {
        const current = program[i];
        if (expressionDepth > 0 && (current === "'" || current === '"')) {
          if (program.startsWith(current.repeat(3), i)) return undefined;
          let end = i + 1;
          while (end < program.length && program[end] !== current) {
            if (program[end] === "\\") end++;
            end++;
          }
          if (end >= program.length) return undefined;
          value += program.slice(i, end + 1);
          i = end + 1;
          continue;
        }
        if (
          interpolated &&
          expressionDepth === 0 &&
          (program.startsWith("{{", i) || program.startsWith("}}", i))
        ) {
          value += program.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (
          (interpolated && current === "{") ||
          (char === "`" && current === "{" && (expressionDepth > 0 || program[i - 1] === "$"))
        )
          expressionDepth++;
        if ((interpolated || char === "`") && current === "}" && expressionDepth > 0)
          expressionDepth--;
        value += program[i++];
      }
    }
    if (i >= program.length || expressionDepth !== 0) return undefined;
    // Path values need exact decoding. Other escapes (including continuations and
    // identity escapes) remain unproved; payload strings do not require this proof.
    if (
      /\b(?:open|Path|readFile|readFileSync|writeFile|writeFileSync|file|Bun\s*\.\s*write)\s*\(\s*$/.test(
        code,
      ) &&
      value.replace(/\\(?:x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4})/g, "").includes("\\")
    )
      return undefined;
    value = value.replace(
      /\\(?:x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|([0-7]{1,3}))/g,
      (_match, hex: string | undefined, unicode: string | undefined, octal: string | undefined) =>
        String.fromCharCode(Number.parseInt(hex ?? unicode ?? octal ?? "0", octal ? 8 : 16)),
    );
    if (
      !python &&
      /\b(?:require|import)\s*\(\s*$|\bimport\s*$|\b(?:import|export)\s+[^;()\n]*\bfrom\s*$/.test(
        code,
      )
    )
      loadedModules.push(value);
    literals.push(value);
    if (!literalTextArgument) pathLiterals.push(value);
    // Template expressions remain executable; do not use their quoted boundary as an exemption.
    if (interpolated || (char === "`" && value.includes("${"))) code += value;
    code += " STRING ";
    i += delimiter.length - 1;
  }
  return { code, literals, pathLiterals, loadedModules };
}

/** One immutable literal argv list passed once to subprocess.run, without a shell. */
function staticSubprocessCommand(program: string): string | undefined {
  // The binding and use must be adjacent top-level statements at the start of the program.
  // A literal-looking assignment in a string, branch, or imported scope proves nothing.
  const prefix =
    /^import subprocess[ \t]*\r?\n([A-Za-z_]\w*)[ \t]*=[ \t]*(\[\s*(?:"[^"\\]*"|'[^'\\]*')(?:\s*,\s*(?:"[^"\\]*"|'[^'\\]*'))*\s*,?\s*\])[ \t]*\r?\n(?:[A-Za-z_]\w*[ \t]*=[ \t]*)?subprocess\.run\(/.exec(
      program.trimStart(),
    );
  if (!prefix) return undefined;
  const variable = prefix[1] ?? "";
  const rest = program.trimStart().slice(prefix[0].length);
  const call = new RegExp(
    `^${variable}\\s*(?:,\\s*(?:cwd\\s*=\\s*(?:"[^"\\\\]*"|'[^'\\\\]*')|(?:capture_output|text|check)\\s*=\\s*(?:True|False)|timeout\\s*=\\s*\\d+))*\\s*\\)`,
  ).exec(rest);
  if (!call) return undefined;
  const parts = programParts(program, true);
  if (
    !parts ||
    (parts.code.match(new RegExp(`\\b${variable}\\b`, "g"))?.length ?? 0) !== 2 ||
    (parts.code.match(/\bsubprocess\b/g)?.length ?? 0) !== 2
  )
    return undefined;
  const values = [...(prefix[2] ?? "").matchAll(/"([^"\\]*)"|'([^'\\]*)'/g)].map(
    (match) => match[1] ?? match[2] ?? "",
  );
  if (!values.length) return undefined;
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const command = values.map(quote).join(" ");
  const directories = [...call[0].matchAll(/\bcwd\s*=\s*(?:"([^"\\]*)"|'([^'\\]*)')/g)];
  if (!directories.length) return command;
  const cwd = directories[0]?.[1] ?? directories[0]?.[2] ?? "";
  // Never replay a cwd-bearing call as if it ran in the original shell directory.
  if (directories.length !== 1 || !isStaticNavigationCommand(["cd", "--", cwd])) return undefined;
  const argv = unwrapCwdSubprocessCommand(values);
  if (!argv || !isProvedCwdSubprocessRole(argv)) return undefined;
  // Keep wrapper assignments/options in policy replay after proving the nested command role.
  const replay = `cd -- ${quote(cwd)} && ${command}`;
  return hasProvedNavigationSequence(replay) ? replay : undefined;
}

function unwrapCwdSubprocessCommand(words: string[]): string[] | undefined {
  let argv = words;
  // Each successful wrapper removes words; the original word count bounds recursion.
  for (let depth = 0; depth < words.length; depth++) {
    const unwrapped = unwrapProofCommand(argv, "\0");
    if (!unwrapped) return undefined;
    argv = unwrapped;
    if (argv[0]?.split("/").at(-1) !== "env") return argv;
    const nested = unwrapEnvironmentCommand(argv);
    if (!nested) return undefined;
    // Inspect only env's prefix, not options belonging to its child command.
    // env directory, split-string and unknown options do not preserve the proved context.
    if (
      argv
        .slice(1, argv.length - nested.length)
        .some(
          (arg) =>
            arg.startsWith("-") && arg !== "--" && arg !== "-i" && arg !== "--ignore-environment",
        )
    )
      return undefined;
    argv = nested;
  }
  return undefined;
}

function isProvedCwdSubprocessRole(argv: string[]): boolean {
  const name = argv[0]?.split("/").at(-1) ?? "";
  if (inlineProgramIndex(argv) !== undefined || isUnsupportedInlineRuntime(argv)) return false;
  if (isPassiveTextCommand(argv)) return true;
  if (name === "find") return isSafeLocalAssignmentCommand(argv);
  if (["ls", "cat", "uniq", "cut"].includes(name)) return true;
  if (name === "wc") return !hasExecutionOption(argv.slice(1), ["files0-from"]);
  if (name === "sort")
    return !hasExecutionOption(argv.slice(1), ["compress-program", "files0-from"]);
  if (name === "git") {
    let index = 1;
    while (argv[index] === "-C" && argv[index + 1]) index += 2;
    return ["ls-files", "ls-tree", "status", "rev-parse", "rev-list"].includes(argv[index] ?? "");
  }
  // A literal Bun script keeps the existing supported test-runner route.
  if (name === "bun") return /^[A-Za-z0-9_./-]+\.(?:[cm]?[jt]s)$/.test(argv[1] ?? "");
  // Retain extraction so the nested CLI policy returns its ordinary descriptor.
  return DEFAULT_BLOCKED_CLI_TOOLS.some((tool) => tool.name === name);
}

function inlineSubprocessCommands(command: string): string[] {
  const parsed = parseStaticShellCommands(command);
  if (!parsed || typeof parsed === "string") return [];
  return parsed.pipelines.flat().flatMap((words) => {
    const argv = unwrapStaticCommand(words);
    const index = inlineProgramIndex(argv);
    const nested = index === undefined ? undefined : staticSubprocessCommand(argv[index] ?? "");
    return nested ? [nested] : [];
  });
}

/** The complete invocation must preserve the package loader's startup and lookup identity. */
function hasProvedPackageInventoryInvocation(command: string): boolean {
  if (hasEnvironmentMutationPrefix(command)) return false;
  const parsed = parseStaticShellCommands(command);
  if (!parsed || typeof parsed === "string") return false;
  return parsed.pipelines.flat().every((words) => {
    const argv = unwrapStaticCommand(words);
    if (
      argv[0]?.split("/").at(-1) === "cat" ||
      isPassiveTextCommand(argv) ||
      isLiteralInlineWriter(argv)
    )
      return true;
    const index = inlineProgramIndex(argv);
    return (
      inlineRuntimeKind(argv[0]) === "node" &&
      index !== undefined &&
      staticPackageInventory(argv[index] ?? "") !== undefined
    );
  });
}

/** Replay each proved JSON loader operand through ordinary command policies as well. */
function inlinePackageCommands(command: string, allowInventory: boolean): string[] {
  if (!allowInventory) return [];
  const parsed = parseStaticShellCommands(command);
  if (!parsed || typeof parsed === "string") return [];
  return parsed.pipelines.flat().flatMap((words) => {
    const argv = unwrapStaticCommand(words);
    const index = inlineProgramIndex(argv);
    if (index === undefined || inlineRuntimeKind(argv[0]) !== "node") return [];
    const program = argv[index] ?? "";
    const paths = staticPackageInventory(program);
    return (paths ?? []).map((path) =>
      ["node", "-e", program]
        .map((word, position) => {
          const materialized =
            position === 2
              ? program.replace(
                  /\brequire\s*\(\s*(["'])\.\/\1\s*\+\s*[a-z]\s*\)/,
                  () => `require(${JSON.stringify(path)})`,
                )
              : word;
          return "'" + materialized.replaceAll("'", "'\"'\"'") + "'";
        })
        .join(" "),
    );
  });
}

function hasInlineProgramExecution(
  program: string,
  python: boolean,
  allowInventory = false,
): boolean {
  const parts = programParts(program, python);
  if (!parts) return true;
  if (parts.loadedModules.some((name) => /^(?:node:)?vm$/.test(name))) return true;
  // Dynamic loading and reflective access cannot establish a non-executing code operand.
  if (
    (/\b(?:require|import)\s*\((?!\s*STRING\s*\))/.test(parts.code) &&
      (!allowInventory || !staticPackageInventory(program))) ||
    /\[\s*STRING\s*\+/.test(parts.code) ||
    /\b(?:process|os)\s*\[/.test(parts.code)
  )
    return true;
  const code = staticSubprocessCommand(program)
    ? parts.code.replace(/\bsubprocess\b/g, "")
    : parts.code;
  return (
    /\b(?:subprocess|child_process|execSync|execFile|execFileSync|spawn|spawnSync|eval|exec|Function|Reflect|getattr|setattr|globals|locals|vars|compile|__import__)\b|\bos\s*\.\s*(?:system|popen)|\bBun\s*\.\s*(?:spawn|spawnSync)|\bDeno\s*\.\s*Command/.test(
      code,
    ) || parts.literals.some((value) => /^(?:node:)?child_process$/.test(value))
  );
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
  const sql = literalSqlArgumentIndex(argv);
  if (sql !== undefined)
    return argv.some((arg, index) => index !== sql && hasArgumentBraceExpansion(arg));
  return (argv[0]?.split("/").at(-1) === "awk" && !isAwkExecution(argv)) ||
    inlineProgramIndex(argv) !== undefined ||
    isJqObjectConstruction(argv)
    ? false
    : hasArgumentBraceExpansion(argv.join(" "));
}

function literalSqlArgumentIndex(argv: string[]): number | undefined {
  if (
    argv[0]?.split("/").at(-1) !== "bun" ||
    argv[1] !== "run" ||
    argv[2] !== "db-tool" ||
    !["sql", "query"].includes(argv[3] ?? "")
  )
    return undefined;
  let sql: number | undefined;
  const seen = new Set<string>();
  for (let index = 4; index < argv.length; index++) {
    const [option = "", ...attached] = (argv[index] ?? "").split("=");
    if (
      !["--sql", "--env", "--profile", "--limit", "--format"].includes(option) ||
      seen.has(option)
    )
      return undefined;
    seen.add(option);
    const value = attached.length ? attached.join("=") : argv[++index];
    if (!value || value.startsWith("--")) return undefined;
    if (option === "--sql") sql = index;
    else if (!/^[A-Za-z0-9_./-]+$/.test(value)) return undefined;
  }
  return sql;
}

/** echo and printf print their arguments; grep -o, rg and git grep print matched pattern text. */
function isLiteralTextProducer(argv: string[]): boolean {
  return isPassiveTextCommand(argv) && argv[0]?.split("/").at(-1) !== "head";
}

function awkProgramIndex(argv: string[]): number | undefined {
  if (argv[0]?.split("/").at(-1) !== "awk") return undefined;
  let index = 1;
  while (index < argv.length) {
    const arg = argv[index] ?? "";
    if (arg === "--") return index + 1 < argv.length ? index + 1 : undefined;
    if (arg === "-F") {
      if (argv[index + 1] === undefined) return undefined;
      index += 2;
      continue;
    }
    if (arg.startsWith("-F") && arg.length > 2) {
      index++;
      continue;
    }
    if (arg.startsWith("-")) return undefined;
    return index;
  }
  return undefined;
}

function isAwkExecution(argv: string[]): boolean {
  if (argv[0]?.split("/").at(-1) !== "awk") return false;
  // Only a literal inline program with known-safe options establishes passive behavior.
  const index = awkProgramIndex(argv);
  const program = index === undefined ? undefined : argv[index];
  return (
    !program ||
    /\b(?:system|getline|ENVIRON)\b|\||\b(?:print|printf)\b[^\n]*>|@(?:include|load)/.test(
      program,
    ) ||
    argv.slice((index ?? -1) + 1).some((arg) => arg.startsWith("-"))
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
  const expression = filter
    .replace(/\.[A-Za-z_][A-Za-z0-9_.-]*/g, "FIELD")
    .replace(/\b[A-Za-z_][A-Za-z0-9_-]*\s*:/g, ":");
  if (/^\{[\s\S]*\}$/.test(filter) && /^(?:FIELD|length|map|[\s{}():,|>0-9])+$/.test(expression))
    return true;
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
  if (isAllowedPythonEnvironmentRead(argv, allowedNames)) return true;
  if (argv[0]?.split("/").at(-1) !== "printenv") return false;
  const args = argv.slice(1);
  if (args[0] === "--") args.shift();
  return args.length > 0 && args.every((name) => allowedNames.has(name));
}

/** Prove the complete, print-only Python program before treating its reads as approved. */
function isAllowedPythonEnvironmentRead(argv: string[], allowedNames: Set<string>): boolean {
  const index = inlineProgramIndex(argv);
  if (inlineRuntimeKind(argv[0]) !== "python" || index === undefined || argv.length !== index + 1)
    return false;

  const program = argv[index] ?? "";
  if (program.length > 65_536) return false;
  let position = 0;
  let foundRead = false;
  let importedJson = false;
  const skipInlineWhitespace = () => {
    while (/[\t ]/.test(program[position] ?? "")) position++;
  };
  const take = (value: string): boolean => {
    if (!program.startsWith(value, position)) return false;
    position += value.length;
    return true;
  };
  const takeIdentifier = (value: string): boolean => {
    if (
      !program.startsWith(value, position) ||
      /[A-Za-z0-9_]/.test(program[position + value.length] ?? "")
    )
      return false;
    position += value.length;
    return true;
  };
  const takeString = (): string | undefined => {
    skipInlineWhitespace();
    const quote = program[position];
    if ((quote !== "'" && quote !== '"') || program.startsWith(quote.repeat(3), position))
      return undefined;
    position++;
    const start = position;
    while (position < program.length && program[position] !== quote) {
      if (/[\\\r\n]/.test(program[position] ?? "")) return undefined;
      position++;
    }
    if (program[position] !== quote) return undefined;
    const value = program.slice(start, position);
    position++;
    return value;
  };
  const takeEnvironmentRead = (variable?: string): boolean => {
    skipInlineWhitespace();
    const takeName = (): boolean => {
      skipInlineWhitespace();
      if (variable !== undefined) return takeIdentifier(variable);
      const name = takeString();
      return name !== undefined && allowedNames.has(name);
    };
    const start = position;
    if (!takeIdentifier("os")) return false;
    if (!take(".")) {
      position = start;
      return false;
    }
    if (takeIdentifier("getenv")) {
      if (!take("(")) return false;
      if (!takeName()) return false;
      skipInlineWhitespace();
      if (take(",")) {
        if (takeString() === undefined) return false;
        skipInlineWhitespace();
      }
      if (!take(")")) return false;
      foundRead = true;
      return true;
    }
    if (!takeIdentifier("environ")) return false;
    if (take(".")) {
      if (!takeIdentifier("get") || !take("(")) return false;
      if (!takeName()) return false;
      skipInlineWhitespace();
      if (take(",")) {
        if (takeString() === undefined) return false;
        skipInlineWhitespace();
      }
      if (!take(")")) return false;
      foundRead = true;
      return true;
    }
    if (!take("[")) return false;
    if (!takeName()) return false;
    skipInlineWhitespace();
    if (!take("]")) return false;
    foundRead = true;
    return true;
  };
  const takeApprovedNames = (): boolean => {
    if (!take("[")) return false;
    for (let count = 0; count < 16; count++) {
      const name = takeString();
      if (name === undefined || !allowedNames.has(name)) return false;
      skipInlineWhitespace();
      if (take("]")) return true;
      if (!take(",")) return false;
      skipInlineWhitespace();
      if (take("]")) return true;
    }
    return false;
  };
  const takeComprehension = (): boolean => {
    const dictionary = take("{");
    if (!dictionary && !take("[")) return false;
    skipInlineWhitespace();
    const variable = dictionary
      ? /^[A-Za-z_][A-Za-z0-9_]*/.exec(program.slice(position))?.[0]
      : /^os\.(?:getenv\(|environ(?:\.get\(|\[))[\t ]*([A-Za-z_][A-Za-z0-9_]*)/.exec(
          program.slice(position),
        )?.[1];
    if (!variable || ["os", "json", "print"].includes(variable)) return false;
    if (dictionary) {
      if (!takeIdentifier(variable)) return false;
      skipInlineWhitespace();
      if (!take(":")) return false;
    }
    if (!takeEnvironmentRead(variable)) return false;
    const loop = new RegExp(`[\\t ]+for[\\t ]+${variable}[\\t ]+in[\\t ]+`, "y");
    loop.lastIndex = position;
    const match = loop.exec(program);
    if (!match) return false;
    position = loop.lastIndex;
    if (!takeApprovedNames()) return false;
    skipInlineWhitespace();
    return take(dictionary ? "}" : "]");
  };
  const takeProjection = (): boolean => {
    const start = position;
    const previousRead = foundRead;
    if (takeComprehension()) return true;
    position = start;
    foundRead = previousRead;
    const dictionary = take("{");
    if (!dictionary && !take("[")) return false;
    const close = dictionary ? "}" : "]";
    for (let count = 0; count < 16; count++) {
      if (dictionary) {
        const key = takeString();
        if (key === undefined || !allowedNames.has(key)) return false;
        skipInlineWhitespace();
        if (!take(":")) return false;
      }
      if (!takeEnvironmentRead()) return false;
      skipInlineWhitespace();
      if (take(close)) return true;
      if (!take(",")) return false;
      skipInlineWhitespace();
      if (take(close)) return true;
    }
    return false;
  };
  const takeJsonDisplay = (): boolean => {
    if (!importedJson || !takeIdentifier("json") || !take(".dumps")) return false;
    skipInlineWhitespace();
    if (!take("(")) return false;
    skipInlineWhitespace();
    if (!takeProjection()) return false;
    skipInlineWhitespace();
    return take(")");
  };
  const takeExpression = (): boolean => {
    const takeTerm = (): boolean => {
      skipInlineWhitespace();
      return program.startsWith("json", position)
        ? takeJsonDisplay()
        : takeString() !== undefined || takeEnvironmentRead();
    };
    if (!takeTerm()) return false;
    skipInlineWhitespace();
    while (take("+")) {
      if (!takeTerm()) return false;
      skipInlineWhitespace();
    }
    return true;
  };
  const takePrint = (): boolean => {
    skipInlineWhitespace();
    if (!takeIdentifier("print")) return false;
    skipInlineWhitespace();
    if (!take("(")) return false;
    skipInlineWhitespace();
    if (take(")")) return true;
    while (true) {
      if (!takeExpression()) return false;
      skipInlineWhitespace();
      if (take(")")) return true;
      if (!take(",")) return false;
      skipInlineWhitespace();
      if (take(")")) return true;
    }
  };
  const skipSeparators = (): void => {
    while (true) {
      skipInlineWhitespace();
      if (take(";") || take("\n") || take("\r\n")) continue;
      break;
    }
  };

  skipInlineWhitespace();
  if (!takeIdentifier("import")) return false;
  skipInlineWhitespace();
  const jsonFirst = takeIdentifier("json");
  if (!jsonFirst && !takeIdentifier("os")) return false;
  importedJson = jsonFirst;
  skipInlineWhitespace();
  if (take(",")) {
    skipInlineWhitespace();
    if (!takeIdentifier(jsonFirst ? "os" : "json")) return false;
    importedJson = true;
  } else if (jsonFirst) return false;
  skipInlineWhitespace();
  if (!(take(";") || take("\n") || take("\r\n"))) return false;
  skipSeparators();
  if (!importedJson && takeIdentifier("import")) {
    skipInlineWhitespace();
    if (!takeIdentifier("json")) return false;
    importedJson = true;
    skipInlineWhitespace();
    if (!(take(";") || take("\n") || take("\r\n"))) return false;
    skipSeparators();
  }
  while (position < program.length) {
    if (!takePrint()) return false;
    skipInlineWhitespace();
    if (position === program.length) break;
    if (!(take(";") || take("\n") || take("\r\n"))) return false;
    skipSeparators();
  }
  return foundRead;
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

/** Literal directory operands only; navigation is never a pipeline consumer. */
function isStaticNavigationCommand(argv: string[]): boolean {
  const path = (value: string | undefined) => /^[A-Za-z0-9_./][A-Za-z0-9_./ -]*$/.test(value ?? "");
  if (argv[0] === "cd")
    return isNavigationOperand(argv, "\0") && path(argv[argv[1] === "--" ? 2 : 1]);
  if (argv[0] !== "git") return false;
  let index = 1;
  while (argv[index] === "-C") {
    if (!path(argv[index + 1])) return false;
    index += 2;
  }
  return (
    isNavigationOperand(argv, "\0") ||
    (index > 1 && isPassiveTextCommand(["git", ...argv.slice(index)]))
  );
}

/** Literal wrappers and exact directory-operation roles; unknown consumers keep refusal. */
function isProvedDirectoryCommand(words: string[]): boolean {
  const argv = unwrapStaticCommand(words);
  if (
    !words
      .slice(0, words.length - argv.length)
      .every((word) => ["rtk", "proxy", "command", "--"].includes(word))
  )
    return false;
  if (argv[0] === "cd") return isStaticNavigationCommand(argv);
  if (argv[0] !== "git") return false;
  let index = 1;
  while (argv[index] === "-C") {
    if (!isStaticNavigationCommand(["cd", argv[index + 1] ?? ""])) return false;
    index += 2;
  }
  const args = argv.slice(index);
  if (args[0] === "status")
    return args.length === 1 || (args.length === 2 && args[1] === "--short");
  if (args[0] === "fetch")
    return (
      args.length >= 2 &&
      args.length <= 3 &&
      args.slice(1).every((arg) => /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(arg))
    );
  return (
    (args.length === 2 && args[0] === "rev-parse" && args[1] === "HEAD") ||
    (args.length === 3 && args[0] === "rev-list" && args[1] === "--count" && args[2] === "HEAD")
  );
}

/** Prove a single cd whose uses are gated on success, without simulating shell state. */
function hasProvedNavigationSequence(command: string): boolean {
  const literal = literalBindingText(command, "", "");
  const parsed = parseStaticShellCommands(command);
  if (!literal || !parsed || typeof parsed === "string") return false;
  const commands = parsed.pipelines.flat().map((words) => unwrapProofCommand(words, "\0"));
  const changesDirectory = commands.filter((argv) => argv?.[0] === "cd");
  if (
    !commands.some((argv) => argv && (argv[0] === "cd" || (argv[0] === "git" && argv[1] === "-C")))
  )
    return true;
  if (
    /\|\||(^|[^&])&(?!&)/.test(literal.syntax.replace(/[<>]&[0-9-]+/g, "")) ||
    parsed.redirects.some(({ target }) => !target.startsWith("/")) ||
    changesDirectory.length > 1
  )
    return false;
  if (!changesDirectory.length) return true;
  // Only the final AND list can use this directory. A failing cd never reaches its readers.
  // Trim real trailing whitespace, not the spaces masking final quoted argv words.
  const syntax = literal.syntax.slice(0, command.replace(/[ \t\n]+$/g, "").length);
  const boundary = Math.max(syntax.lastIndexOf(";"), syntax.lastIndexOf("\n"));
  const tail = parseStaticShellCommands(command.slice(boundary + 1, syntax.length));
  if (!tail || typeof tail === "string" || tail.pipelines.length < 2) return false;
  const first = tail.pipelines[0];
  const argv = unwrapProofCommand(first?.[0] ?? [], "\0");
  return (
    first?.length === 1 &&
    argv?.[0] === "cd" &&
    isStaticNavigationCommand(argv) &&
    syntax.slice(boundary + 1).match(/&&|[;&|\n]/)?.[0] === "&&"
  );
}

function isPassiveTextCommand(argv: string[]): boolean {
  const name = argv[0]?.split("/").at(-1) ?? "";
  const args = argv.slice(1);
  // These commands consume literal text. Execution options are not exceptions.
  if (name === "printf") return passivePrintfFormatIndex(argv) !== undefined;
  // Native cut only selects input data; its file operands still receive shared path checks.
  if (["echo", "grep", "head", "tail", "cut"].includes(name)) {
    return true;
  }
  if (name === "rg") return !hasExecutionOption(args, ["pre", "hostname-bin"]);
  if (name === "awk") return !isAwkExecution(argv);
  if (name === "sed") return isReadonlySedPrint(argv);
  if (name === "jq") return isJqObjectConstruction(argv);
  return (
    (name === "git" && args[0] === "status") ||
    (name === "git" &&
      args[0] === "grep" &&
      !hasExecutionOption(args, ["open-files-in-pager", "textconv"], "O"))
  );
}

/** One print program with optional numeric or escaped-regex addresses; no callbacks. */
function isReadonlySedPrint(argv: string[]): boolean {
  if (argv[0]?.split("/").at(-1) !== "sed") return false;
  let index = 1;
  while (/^-[nE]+$/.test(argv[index] ?? "")) index++;
  if (argv[index] === "--") index++;
  const address = String.raw`(?:[0-9]+|\$|/(?:\\[^\r\n]|[^/\\\r\n])*/)`;
  return (
    new RegExp(`^(?:${address}(?:,${address})?)?p$`).test(argv[index] ?? "") &&
    argv.slice(index + 1).every((arg) => !arg.startsWith("-"))
  );
}

function hasStaticEnvironmentRead(
  argv: string[],
  allowedNames: Set<string>,
  allowInventory = false,
): boolean {
  const name = argv[0]?.split("/").at(-1);
  if (
    ["sh", "bash", "zsh"].includes(name ?? "") &&
    hasExecutionOption(argv.slice(1), ["command"], "c") &&
    argv.slice(1).some((arg) => /\$\{?[A-Za-z_]/.test(arg))
  ) {
    return true;
  }
  if (
    name === "docker" &&
    argv.some((arg) => ["sh", "bash", "zsh"].includes(arg)) &&
    argv.some((arg) => /[$`]/.test(arg))
  )
    return true;
  if (name === "awk" && argv.slice(1).some((arg) => /\bENVIRON\b/.test(arg))) return true;
  if (name === "printenv") return !isAllowedEnvironmentRead(argv, allowedNames);
  if (name === "env") {
    const wrapped = unwrapEnvironmentCommand(argv);
    return wrapped === null
      ? isEnvironmentListing(argv)
      : hasStaticEnvironmentRead(unwrapStaticCommand(wrapped), allowedNames, allowInventory);
  }
  if (isUnsupportedInlineRuntime(argv)) return true;
  const programIndex = inlineProgramIndex(argv);
  if (programIndex !== undefined)
    return hasInlineProgramExecution(
      argv[programIndex] ?? "",
      inlineRuntimeKind(argv[0]) === "python",
      allowInventory && inlineRuntimeKind(argv[0]) === "node",
    );
  if (isPassiveTextCommand(argv)) return false;
  // Any command may re-parse an argument as shell code (trap, find -exec, awk system()).
  return (
    hasCommandArgumentBraceExpansion(argv) ||
    ([
      "sh",
      "bash",
      "zsh",
      "eval",
      "source",
      "find",
      "xargs",
      "trap",
      "awk",
      "git",
      "sort",
      "jq",
      "docker",
    ].includes(name ?? "") &&
      mentionsEnvironmentRead(argv.join(" ")))
  );
}

function isStaticHerdrPrompt(command: string): boolean {
  // Preserve shell word boundaries and executable identity before proving composition.
  const literal = literalBindingText(command, "", "");
  if (!literal) return false;
  const parsed = parseStaticShellCommands(command);
  if (!parsed || typeof parsed === "string") return false;
  const commands = parsed.pipelines.flat().map((words) => unwrapProofCommand(words, "\0"));
  const prompts = commands.filter(
    (argv) => argv?.[0] === "herdr" && argv[1] === "agent" && argv[2] === "prompt",
  );
  if (!hasProvedNavigationSequence(command)) return false;
  return (
    prompts.length > 0 &&
    parsed.pipelines.every((pipeline) =>
      pipeline.every((words, index) => {
        const argv = unwrapProofCommand(words, "\0");
        if (!argv) return false;
        if (argv[0] === "herdr" && argv[1] === "agent" && argv[2] === "prompt")
          return index === 0 && argv.length >= 5;
        // cat is a reader at the start of an independent pipeline, never a consumer.
        if (argv[0] === "cat")
          return (
            index === 0 &&
            argv.length > 1 &&
            argv.slice(1).every((arg) => arg === "--" || !arg.startsWith("-"))
          );
        if (isPassiveTextCommand(argv)) return true;
        if (isLiteralHerdrRead(argv)) return index === 0;
        if (argv[0] === "sleep")
          return (
            index === 0 &&
            pipeline.length === 1 &&
            argv.length === 2 &&
            /^\d+(?:\.\d+)?$/.test(argv[1] ?? "")
          );
        if (isStaticNavigationCommand(argv))
          return index === 0 && (argv[0] !== "cd" || pipeline.length === 1);
        return false;
      }),
    )
  );
}

function isHerdrPrompt(command: string): boolean {
  if (/^herdr\s+agent\s+prompt\b/.test(command.trim())) return true;
  const parsed = parseStaticShellCommands(command, true);
  if (!parsed || typeof parsed === "string") return false;
  return parsed.pipelines.flat().some((words) => {
    const argv = unwrapStaticCommand(words);
    return argv[0] === "herdr" && argv[1] === "agent" && argv[2] === "prompt";
  });
}

function hasEnvironmentRead(
  command: string,
  allowedNames: Set<string>,
  allowInventory = hasProvedPackageInventoryInvocation(command),
  replayedShellBodies: string[] = [],
): boolean {
  if (isStaticHerdrPrompt(command)) return false;
  if (isHerdrPrompt(command)) return true;
  if (isLiteralTextWrite(command)) return false;
  // ponytail: complex shell syntax stays conservative; use a shell AST if more exceptions are needed.
  const parsed = parseStaticShellCommands(command);
  if (parsed === "brace-expansion") return true;
  if (!parsed) {
    const operands = parseStaticShellCommands(command, true);
    if (
      operands &&
      typeof operands !== "string" &&
      operands.pipelines.flat().some((words) => {
        const argv = unwrapStaticCommand(words);
        return (
          argv[0]?.split("/").at(-1) === "bun" &&
          argv[1] === "run" &&
          argv[2] === "db-tool" &&
          ["sql", "query"].includes(argv[3] ?? "") &&
          argv.some(
            (arg, index) =>
              (arg === "--sql" && /\$\(|`/.test(argv[index + 1] ?? "")) ||
              (arg.startsWith("--sql=") && /\$\(|`/.test(arg)),
          )
        );
      })
    )
      return true;
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
    pipelines.some((pipeline) =>
      pipeline.some(
        (argv, index) =>
          literalSqlArgumentIndex(argv) !== undefined &&
          pipeline.slice(index + 1).some((consumer) => !isPassiveTextCommand(consumer)),
      ),
    )
  )
    return true;
  if (
    parsed.redirects.length > 0 &&
    unwrapped.some((argv) => isAllowedEnvironmentRead(argv, allowedNames))
  ) {
    return true;
  }
  if (
    parsed.redirects.length > 0 &&
    pipelines.some((pipeline) =>
      pipeline.some(
        (argv) => isLiteralTextProducer(argv) && mentionsEnvironmentRead(argv.join(" ")),
      ),
    ) &&
    unwrapped.some((argv) => ["sh", "bash", "zsh", "xargs", "eval"].includes(argv[0] ?? ""))
  ) {
    return true;
  }
  if (
    unwrapped.some(
      (argv) =>
        !(SHELL_IDENTITIES.has(argv[0] ?? "") && replayedShellBodies.includes(argv.at(-1) ?? "")) &&
        hasStaticEnvironmentRead(argv, allowedNames, allowInventory),
    )
  ) {
    return true;
  }

  // A literal producer can feed executable text to a shell, xargs, or an unknown consumer.
  const result = pipelines.some((pipeline) =>
    pipeline.some(
      (argv, index) =>
        (isAllowedEnvironmentRead(argv, allowedNames) ||
          (isLiteralTextProducer(argv) &&
            (mentionsEnvironmentRead(argv.join(" ")) || hasCommandArgumentBraceExpansion(argv)))) &&
        pipeline
          .slice(index + 1)
          .some(
            (consumer) =>
              !isPassiveTextCommand(consumer) && !isAllowedEnvironmentRead(consumer, allowedNames),
          ),
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
    (sensitiveName.test(text) &&
      !/(?:^|\/)credential-guard(?:(?:-[^/]+)?\.(?:ts|md|js)|\*|\/(?:index\.(?:ts|js)))?$/.test(
        text,
      ));
  if (/(?:^|[\s;&|])--env-file(?:=|\s)[^;&|]*\.env\b/i.test(command)) return true;
  const heredoc = boundedHeredoc(command);
  if (
    heredoc &&
    (isLiteralTextWrite(command) ||
      (isLiteralTextWrite(command.slice(0, command.length - heredoc.following.length).trimEnd()) &&
        !mentionsInlineRuntime(heredoc.following) &&
        !/\b(?:sh|bash|zsh|eval|source|xargs)\b/.test(heredoc.following)))
  ) {
    return hasSensitiveFileRead(heredoc.header + "\n" + heredoc.following, isPathBlocked);
  }
  if (/\bcat\b[^;&|]*<<-?\s*\S+[\s\S]*\b(?:secret|credential)\b/i.test(command)) return true;
  const parsed = parseStaticShellCommands(command);
  const readers =
    /\b(?:cat|cp|grep|rg|sed|awk|jq|head|tail|less|more|source|ls|sort|uniq|cut|wc|mv|find|shasum|sha1sum|sha256sum|sha512sum|md5sum|cksum)\b/i;
  if (parsed && parsed !== "brace-expansion") {
    let directory = "";
    const trackDirectory = hasProvedNavigationSequence(command);
    const safeDirectorySequence = parsed.pipelines.flat().every(isProvedDirectoryCommand);
    return parsed.pipelines.flat().some((words) => {
      const argv = unwrapStaticCommand(words);
      const inspectedArgv =
        argv[0]?.split("/").at(-1) === "env" ? unwrapEnvironmentCommand(argv) : argv;
      if (inspectedArgv === null) return false;
      let inspected = unwrapStaticCommand(inspectedArgv);
      let name = inspected[0]?.split("/").at(-1) ?? "";
      let commandDirectory = directory;
      const inDirectory = (path: string) =>
        path.startsWith("/") ? posix.normalize(path) : posix.join(commandDirectory, path);
      const blockedOperand = (path: string) =>
        [path, inDirectory(path)].some((value) => isPathBlocked(value) || isSensitivePath(value));
      // Directory slots use path policies, not the broad credential-file name heuristic.
      const blockedDirectory = (path: string) =>
        [path, inDirectory(path)].some(
          (value) => isPathBlocked(value) || isPathBlocked(value + "/"),
        );
      if (name === "cd") {
        const path = inspected[inspected[1] === "--" ? 2 : 1];
        if (path === undefined) return false;
        if (blockedDirectory(path)) return true;
        // A successful cd alone proves neither its later readers nor pipeline consumers safe.
        if (
          (!trackDirectory || !safeDirectorySequence) &&
          (blockedOperand(path) || blockedOperand(path + "/"))
        )
          return true;
        if (trackDirectory && isStaticNavigationCommand(inspected)) directory = inDirectory(path);
        return false;
      }
      if (name === "git") {
        let index = 1;
        while (inspected[index] === "-C" && inspected[index + 1]) {
          const path = inspected[index + 1] ?? "";
          if (blockedDirectory(path)) return true;
          // Git -C affects this command only; following consumers keep the shell directory.
          if (
            !isProvedDirectoryCommand(words) &&
            (blockedOperand(path) || blockedOperand(path + "/"))
          )
            return true;
          commandDirectory = inDirectory(path);
          index += 2;
        }
        // Git grep has the same pattern-versus-file roles as grep below.
        if (inspected[index] === "grep") {
          inspected = ["grep", ...inspected.slice(index + 1)];
          name = "grep";
        }
      }
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
      const programIndex = inlineProgramIndex(inspected);
      if (programIndex !== undefined) {
        const parts = programParts(
          inspected[programIndex] ?? "",
          inlineRuntimeKind(inspected[0]) === "python",
        );
        if (!parts) return true;
        const inventory = staticPackageInventory(inspected[programIndex] ?? "");
        if (inventory?.some((path) => isPathBlocked(path) || isSensitivePath(path))) return true;
        if (parts.code.split(/[\s'"`()<>;&|]+/).some(isPathBlocked)) return true;
        const accessesFiles =
          /\b(?:open|Path|read_text|read_bytes|readFile|readFileSync|file|write_text|writeFile|writeFileSync)\b/.test(
            parts.code,
          ) || /\bBun\s*\.\s*write\s*\(/.test(parts.code);
        if (
          accessesFiles &&
          /\b(?:sys|process)\s*\.\s*argv\b/.test(parts.code) &&
          inspected
            .slice(programIndex + 1)
            .some((arg) => isPathBlocked(arg) || isSensitivePath(arg))
        )
          return true;
        // Interpolation expressions remain in code; inspect their nested literal operands too.
        const expressionParts = /['"]/.test(parts.code)
          ? programParts(parts.code, inlineRuntimeKind(inspected[0]) === "python")
          : { pathLiterals: [] };
        if (!expressionParts) return true;
        return [...parts.pathLiterals, ...expressionParts.pathLiterals].some(
          (value) =>
            (accessesFiles && isPathBlocked(value)) ||
            (!/\s/.test(value) && /[/.]/.test(value) && isSensitivePath(value)),
        );
      }
      if (!readers.test(name)) return false;
      if (name === "rg" || name === "grep") {
        const args = inspected.slice(1);
        const paths: string[] = [];
        let hasPattern = false;
        let options = true;
        const enumeratesFiles = name === "rg" && args.includes("--files");
        let filesOnly = enumeratesFiles;
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
            if (
              !enumeratesFiles &&
              (isSensitivePath(glob) || isPathBlocked(glob.replaceAll("*", "")))
            )
              paths.push(glob);
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
              !enumeratesFiles &&
              value &&
              (isSensitivePath(value) || isPathBlocked(value.replaceAll("*", "")))
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
        return paths.some(blockedOperand);
      }
      const paths = name === "jq" ? jqFileArguments(inspected) : inspected.slice(1);
      return paths.some(blockedOperand);
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
  if ((mentionsInlineRuntime(command) || /\bruby\b/i.test(command)) && isSensitivePath(command)) {
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
  if (!command.includes("$") && !command.includes("`")) return false;
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
    if (char === "`") return true;
    if (char !== "$") {
      normalized += char;
      continue;
    }
    if (command[i + 1] === "?") {
      expansions++;
      normalized += "NUMERICSTATUSVALUE";
      i++;
      continue;
    }
    const variable = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(:-)?\}|^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(
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
    const name = variable[1] ?? variable[3] ?? "";
    if (variable[2]) {
      if (quote !== '"' || !allowedNames.has(name)) invalidExpansion = true;
      normalized += "ENVVALUE";
      i += variable[0].length - 1;
      continue;
    }
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
    (text, [marker, value]) => text.replaceAll(marker, () => value),
    normalized,
  );
  // Options must be checked after local literals become actual argv, never as placeholders.
  if (!hasSafeLocalAssignmentCommands(localMaterialized, assignments)) return true;
  const parsed = parseStaticShellCommands(localMaterialized);
  if (!parsed || typeof parsed === "string") return true;
  for (const [index, pipeline] of parsed.pipelines.entries()) {
    if (!pipeline.some((words) => words.some((arg) => arg.includes("NUMERICSTATUSVALUE"))))
      continue;
    if (parsed.redirects.some((redirect) => redirect.pipeline === index)) return true;
    if (
      pipeline.some((words) => {
        const argv = unwrapStaticCommand(words);
        if (!words.some((arg) => arg.includes("NUMERICSTATUSVALUE")))
          return !isPassiveTextCommand(argv);
        const name = argv[0]?.split("/").at(-1);
        const format = name === "printf" ? passivePrintfFormatIndex(argv) : undefined;
        return (
          !["echo", "printf"].includes(name ?? "") ||
          !isPassiveTextCommand(argv) ||
          words
            .slice(0, words.length - argv.length)
            .some((arg) => arg.includes("NUMERICSTATUSVALUE")) ||
          argv[0]?.includes("NUMERICSTATUSVALUE") === true ||
          (name === "printf" &&
            (format === undefined ||
              argv.slice(0, format + 1).some((arg) => arg.includes("NUMERICSTATUSVALUE"))))
        );
      })
    )
      return true;
  }
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
          if (isApprovedEnvironmentPredicate(unwrapped)) return false;
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
    (text, [marker, value]) => text.replaceAll(marker, () => value),
    normalized.replaceAll("ENVVALUE", "SAFEENVVALUE"),
  );
  return hasSensitiveFileRead(materialized, isPathBlocked);
}

/** Quoted approved metadata can be compared or checked for blankness, never evaluated. */
function isApprovedEnvironmentPredicate(argv: string[]): boolean {
  let args = argv.slice(1);
  if (argv[0] === "[") {
    if (args.at(-1) !== "]") return false;
    args = args.slice(0, -1);
  } else if (argv[0] !== "test") return false;
  const value = (arg: string | undefined) => arg === "ENVVALUE";
  const literal = (arg: string | undefined) =>
    /^[A-Za-z0-9_.:-]*$/.test(arg ?? "") && arg !== undefined;
  return (
    (args.length === 2 && ["-n", "-z"].includes(args[0] ?? "") && value(args[1])) ||
    (args.length === 3 &&
      args[1] === "=" &&
      ((value(args[0]) && literal(args[2])) || (literal(args[0]) && value(args[2]))))
  );
}

function mentionsEnvironmentSource(command: string): boolean {
  return /\b(?:os\s*\.\s*(?:environ|getenv)|process\s*\.\s*env|Environment\s*\.\s*GetEnvironmentVariable)\b/.test(
    command,
  );
}

/** Closed raw-source grammar: literal display/write only, without projection or evaluation. */
function isLiteralInlineWriter(argv: string[]): boolean {
  const index = inlineProgramIndex(argv);
  if (index === undefined || argv.length !== index + 1) return false;
  const kind = inlineRuntimeKind(argv[0]);
  const python = kind === "python";
  const program = (argv[index] ?? "").trim();
  let position = 0;
  const take = (pattern: RegExp): boolean => {
    const match = pattern.exec(program.slice(position));
    if (!match) return false;
    position += match[0].length;
    return true;
  };
  const literal = (): string | undefined => {
    take(/^\s*/);
    const start = position;
    const quote = program[position];
    if (quote !== "'" && quote !== '"') return undefined;
    const delimiter =
      python && program.startsWith(quote.repeat(3), position) ? quote.repeat(3) : quote;
    position += delimiter.length;
    while (position < program.length) {
      if (program.startsWith(delimiter, position)) {
        position += delimiter.length;
        return program.slice(start, position);
      }
      if (program[position] === "\\") position += 2;
      else if (delimiter.length === 1 && /[\r\n\u2028\u2029]/.test(program[position] ?? ""))
        return undefined;
      else position++;
    }
    return undefined;
  };
  let prefix: RegExp;
  let middle: RegExp | undefined;
  let mode = false;
  if (python && /^print\s*\(/.test(program)) prefix = /^print\s*\(\s*/;
  else if (!python && /^console\s*\.\s*log\s*\(/.test(program))
    prefix = /^console\s*\.\s*log\s*\(\s*/;
  else if (python && /^open\s*\(/.test(program)) {
    prefix = /^open\s*\(\s*/;
    mode = true;
    middle = /^\s*\)\s*\.\s*write\s*\(\s*/;
  } else if (kind === "bun" && /^Bun\s*\.\s*write\s*\(/.test(program)) {
    prefix = /^Bun\s*\.\s*write\s*\(\s*/;
    middle = /^\s*,\s*/;
  } else if (python) {
    prefix = /^from[ \t]+pathlib[ \t]+import[ \t]+Path[ \t]*(?:;|\r?\n)\s*Path\s*\(\s*/;
    middle = /^\s*\)\s*\.\s*write_text\s*\(\s*/;
  } else return false;
  if (!take(prefix) || literal() === undefined) return false;
  if (mode) {
    if (!take(/^\s*,\s*/)) return false;
    const value = literal();
    if (value !== "'w'" && value !== '"w"') return false;
  }
  if (middle && (!take(middle) || literal() === undefined)) return false;
  return take(/^\s*\)\s*;?\s*$/) && position === program.length;
}

/** Literal inline output can accompany a proved environment display; file writers cannot. */
function isLiteralInlineDisplay(argv: string[]): boolean {
  const index = inlineProgramIndex(argv);
  if (index === undefined || !isLiteralInlineWriter(argv)) return false;
  const kind = inlineRuntimeKind(argv[0]);
  const program = argv[index] ?? "";
  return (
    (kind === "python" && /^\s*print\s*\(/.test(program)) ||
    (kind === "node" && /^\s*console\s*\.\s*log\s*\(/.test(program))
  );
}

/** Parse approved Python readers from the original shell shape, including quoted stdin heredocs. */
function hasApprovedPythonEnvironmentRead(command: string, allowedNames: Set<string>): boolean {
  const normalized = normalizeProgramHeredocs(command);
  const parsed = parseStaticShellCommands(normalized);
  if (!parsed || typeof parsed === "string") return false;
  return parsed.pipelines
    .flat()
    .some((words) => isAllowedPythonEnvironmentRead(unwrapStaticCommand(words), allowedNames));
}

/** Inert command identity is unproved after an explicit environment mutation. */
function hasEnvironmentMutationPrefix(command: string): boolean {
  const heredoc = boundedHeredoc(command);
  if (heredoc) {
    if (!heredoc.closed) return true;
    return hasEnvironmentMutationPrefix(heredoc.header + "\n" + heredoc.following);
  }
  const parsed = parseStaticShellCommands(command);
  if (!parsed || typeof parsed === "string") return true;
  return parsed.pipelines.flat().some((words) => {
    let index = 0;
    while (index < words.length) {
      const word = words[index] ?? "";
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) return true;
      const name = word.split("/").at(-1);
      if (name === "env") {
        index++;
        if (words[index] === "--") index++;
        if (words[index]?.startsWith("-")) return true;
      } else if (name === "rtk" || name === "command") {
        index++;
        if ((name === "rtk" && words[index] === "proxy") || words[index] === "--") index++;
      } else return false;
    }
    return false;
  });
}

function hasEnvironmentSourceAccess(
  command: string,
  rawTrigger: boolean,
  allowedNames: Set<string>,
): boolean {
  if (rawTrigger && hasEnvironmentMutationPrefix(command)) return true;
  const parsed = parseStaticShellCommands(command);
  if (parsed && typeof parsed !== "string") {
    const commands = parsed.pipelines.flat().map(unwrapStaticCommand);
    if (commands.some((argv) => isAllowedPythonEnvironmentRead(argv, allowedNames))) {
      if (hasEnvironmentMutationPrefix(command)) return true;
      return !commands.every(
        (argv) =>
          argv[0]?.split("/").at(-1) === "cat" ||
          isPassiveTextCommand(argv) ||
          isAllowedPythonEnvironmentRead(argv, allowedNames) ||
          isLiteralInlineDisplay(argv),
      );
    }
  }
  if (isLiteralTextWrite(command) || isStaticHerdrPrompt(command)) return false;
  if (!parsed || typeof parsed === "string") return rawTrigger;
  const commands = parsed.pipelines.flat().map(unwrapStaticCommand);
  if (rawTrigger) {
    // Original invocation-wide evidence survives split writers and inline quote projection.
    return !commands.every(
      (argv) =>
        argv[0]?.split("/").at(-1) === "cat" ||
        isPassiveTextCommand(argv) ||
        isLiteralInlineWriter(argv),
    );
  }
  return commands.some((argv) => {
    if (isAllowedPythonEnvironmentRead(argv, allowedNames)) return false;
    const index = inlineProgramIndex(argv);
    if (index === undefined) return false;
    const python = inlineRuntimeKind(argv[0]) === "python";
    const parts = programParts(argv[index] ?? "", python);
    if (!parts) return true;
    return (
      mentionsEnvironmentSource(parts.code) ||
      (python && /\b(?:environ|getenv)\b/.test(parts.code)) ||
      (/\b(?:os|process)\s*\[/.test(parts.code) &&
        parts.literals.some((value) => /^(?:env|environ|getenv)$/.test(value)))
    );
  });
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
    return (
      !PROCESS_ENVIRONMENT_PATH.test(posix.normalize(normalizedPath)) &&
      allowedPathPatterns.some((pattern) => pattern.test(normalizedPath))
    );
  }

  function isPathBlocked(filePath: string): boolean {
    const normalizedPath = filePath.replace(/\\/g, "/");

    if (PROCESS_ENVIRONMENT_PATH.test(posix.normalize(normalizedPath))) return true;

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

  function getDangerousBashReason(command: string, shellDepth = 0): string | null {
    const originalCommand = command;
    const allowPackageInventory = hasProvedPackageInventoryInvocation(originalCommand);
    const rawEnvironmentSource =
      mentionsEnvironmentSource(command) && mentionsInlineRuntime(command);
    if (
      hasApprovedPythonEnvironmentRead(originalCommand, allowedEnvironmentVariables) &&
      hasEnvironmentMutationPrefix(normalizeProgramHeredocs(originalCommand))
    ) {
      return "blocked by the environment/execution policy after an unproved environment mutation";
    }
    if (rawEnvironmentSource && hasEnvironmentMutationPrefix(originalCommand))
      return "blocked by the environment/execution policy after an unproved environment mutation";
    command = normalizeProgramHeredocs(command);
    const shellBodies = literalShellBodies(command);
    if (!shellBodies || (shellBodies.length && shellDepth >= 8))
      return "cannot prove a bounded literal shell invocation";
    for (const body of shellBodies) {
      const reason = getDangerousBashReason(body, shellDepth + 1);
      if (reason || getBlockedCliTool(body, true, shellDepth + 1))
        return reason ?? "invokes a blocked CLI from a shell body";
      if (!isProvedLiteralShellBody(body)) return "cannot prove a closed literal shell body";
    }
    const proof = materializeLiteralShell(command);
    if (!proof && /^\s*for\b/.test(command)) return "cannot prove a bounded literal shell loop";
    if (proof) {
      if (proof.paths.some((path) => hasSensitiveFileRead("cat " + path, isPathBlocked)))
        return "accesses a sensitive file path";
      command = proof.command;
      if (getBlockedCliTool(command, true, shellDepth))
        return "invokes a blocked CLI from a literal expansion";
    }
    for (const nested of [
      ...inlineSubprocessCommands(command),
      ...inlinePackageCommands(command, allowPackageInventory),
    ]) {
      const reason = getDangerousBashReason(nested, shellDepth);
      if (reason || getBlockedCliTool(nested, true, shellDepth))
        return reason ?? "invokes a blocked CLI from a script";
    }
    if (
      hasSensitiveFileRead(command, isPathBlocked) ||
      hasSensitivePathRedirect(command, isPathBlocked)
    )
      return "blocked by the file-access policy; a sensitive path matched or this command form could not be verified";
    if (
      !isLiteralTextWrite(command) &&
      hasEnvironmentVariableExpansionRead(command, allowedEnvironmentVariables, isPathBlocked)
    ) {
      return "expands an unapproved or executable environment variable value";
    }
    if (
      hasEnvironmentSourceAccess(command, rawEnvironmentSource, allowedEnvironmentVariables) ||
      hasEnvironmentRead(
        command,
        allowedEnvironmentVariables,
        allowPackageInventory,
        shellBodies.filter((body) => {
          const parsed = parseStaticShellCommands(body);
          return (
            parsed &&
            typeof parsed !== "string" &&
            parsed.pipelines
              .flat()
              .every((words) => isPassiveTextCommand(unwrapStaticCommand(words)))
          );
        }),
      )
    ) {
      return "blocked by the environment/execution policy; permitted access or non-execution could not be established for this command form";
    }
    if (
      dangerousBashPatterns.some(
        (pattern) => pattern.test(originalCommand) || pattern.test(command),
      )
    ) {
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

  function getBlockedCliTool(
    command: string,
    expand = true,
    shellDepth = 0,
  ): { name: string; wrapper: string } | null {
    command = normalizeProgramHeredocs(command);
    const shellBodies = literalShellBodies(command);
    if (shellBodies && shellDepth < 8) {
      for (const body of shellBodies) {
        const blocked = getBlockedCliTool(body, true, shellDepth + 1);
        if (blocked) return blocked;
      }
    }
    const proof = expand ? materializeLiteralShell(command) : undefined;
    if (proof) {
      const originalBlocked = getBlockedCliTool(command, false, shellDepth);
      if (originalBlocked) return originalBlocked;
      command = proof.command;
    }
    for (const nested of inlineSubprocessCommands(command)) {
      const blocked = getBlockedCliTool(nested, true, shellDepth);
      if (blocked) return blocked;
    }
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
    try {
      enforceToolExecuteBefore(input, output);
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
      // Do not preserve an unsanitized non-Error value as the new error's cause.
      // eslint-disable-next-line eslint/preserve-caught-error
      throw new Error(sanitized);
    }
  }

  function enforceToolExecuteBefore(input: HookInput, output: HookOutput): void {
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
                `Matched: [REDACTED]\n\n` +
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
            `Use a supported command form or the appropriate wrapper tool.\n\n` +
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
