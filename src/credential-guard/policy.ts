import { formatLiteralPrintf } from "./literal-output";
import { splitXargsInput } from "./xargs";
import { parseBash } from "./bash";
import { parsePowerShell } from "./powershell";
import { MAX_PARSE_DEPTH, MAX_SCRIPT_BYTES, wordText } from "./ir";
import type { Command, List, ParseError, Pipeline, Redirect, Script, Span, Word } from "./ir";
import {
  CODE_OR_PROSE_EXTENSION,
  expandGlobAlternatives,
  isSensitivePath,
  normalizePath,
} from "./paths";
import type { PathContext } from "./paths";
import { analyzeCode, buildRegistry, classify, executableName, isStdinScript } from "./registry";
import type { Issue, Language, Registry } from "./registry";

const builtInNonSecretNames = ["HOME", "PWD", "OLDPWD", "PATH"] as const;

const ruleNames = [
  "unparseable",
  "ambient-expansion",
  "secret-source",
  "sensitive-path",
  "opaque-path",
  "opaque-executable",
  "opaque-code",
  "opaque-env-name",
  "no-analyzer",
  "wrapper-required",
  "configured-pattern",
  "startup-mutation",
  "unsupported-option",
  "analysis-limit",
  "copy-destination",
  "agent-config-write",
  "agent-launch-override",
] satisfies readonly string[];
export type RuleId = string & { readonly __brand: "RuleId" };
function isRuleId(value: string): value is RuleId {
  return ruleNames.includes(value);
}
function ruleId(value: string): RuleId {
  if (isRuleId(value)) return value;
  throw new Error(`unknown rule ${value}`);
}
export type Finding = { readonly rule: RuleId; readonly detail: string; readonly span: Span };
export type Decision =
  | { readonly kind: "pass" }
  | { readonly kind: "violation"; readonly findings: readonly [Finding, ...Finding[]] }
  | { readonly kind: "missing-knowledge"; readonly findings: readonly [Finding, ...Finding[]] };
export type PolicyContext = PathContext & {
  readonly approvedNames?: ReadonlySet<string>;
  readonly onInvocation?: (executable: string, argv: readonly (string | undefined)[]) => void;
  readonly registry?: Registry;
  readonly dangerousPatterns?: readonly RegExp[];
  readonly isPathBlocked?: (path: string) => boolean;
  readonly chainCopyDestinations?: readonly string[];
  readonly proveCopyDestination?: (path: string, source: string) => boolean;
};
export type Value =
  | { readonly kind: "literal"; readonly texts: readonly string[] }
  | {
      readonly kind: "opaque";
      readonly mentions: readonly string[];
      readonly prefix: string;
      readonly globPatterns?: readonly string[];
      readonly supplied?: boolean;
    }
  | { readonly kind: "stream"; readonly stdout: Value };
type Scope = {
  readonly bindings: ReadonlyMap<string, Value>;
  readonly cwd: Value;
  readonly positional: readonly Value[] | null;
  readonly written: ReadonlyMap<string, Value>;
  readonly exported: ReadonlySet<string>;
  readonly dirtyStartup: readonly string[];
  readonly dialect: Script["dialect"];
  readonly braceMode: "bash" | "zsh" | "literal" | "host" | "sh";
};
type LoopFrame = { allowed: boolean; breaks: Scope | null; continues: Scope | null };
type Flow = {
  readonly success: Scope | null;
  readonly failure: Scope | null;
  readonly stdout: Value;
};
export const MAX_VALUE_ALTERNATIVES = 64;
export const MAX_LOOP_PASSES = 8;
export const MAX_FOLD_STEPS = 20000;
const literal = (...texts: string[]): Value => ({ kind: "literal", texts });
const opaque = (...fragments: string[]): Extract<Value, { kind: "opaque" }> => ({
  kind: "opaque",
  prefix: "",
  mentions: [...new Set(fragments)].slice(0, MAX_VALUE_ALTERNATIVES),
});
const glob = (text: string): Value => ({ ...opaque(text), globPatterns: [text] });
function mentions(value: Value): readonly string[] {
  return value.kind === "literal" ? value.texts : value.kind === "opaque" ? value.mentions : [];
}
function agentConfigGlob(value: Value): boolean {
  return mentions(value).some((text) =>
    text
      .replace(/\\/g, "/")
      .split("/")
      .some((part) => {
        if (!/[*?[]/.test(part)) return false;
        if (part.replace(/\[[A-Za-z0-9._]\]/g, "").includes("[")) return true;
        const pattern = new RegExp(
          `^${part
            .replace(/[.+^${}()|\\]/g, "\\$&")
            .replace(/\[([A-Za-z0-9_]|\\\.)\]/g, "$1")
            .replace(/\*/g, ".*")
            .replace(/\?/g, ".")}$`,
          "i",
        );
        return [
          "AGENTS.md",
          "CLAUDE.md",
          ".mcp.json",
          ".claude",
          ".claude.json",
          ".codex",
          ".agents",
          "config.toml",
          "settings.json",
          "settings.local.json",
          "commands",
          "agents",
          "skills",
          "hooks",
        ].some((name) => pattern.test(name));
      }),
  );
}
function join(a: Value, b: Value): Value {
  const texts = [...new Set([...mentions(a), ...mentions(b)])];
  return a.kind === "literal" && b.kind === "literal" && texts.length <= MAX_VALUE_ALTERNATIVES
    ? { kind: "literal", texts }
    : opaque(...texts);
}
function concat(a: Value, b: Value): Value {
  if (a.kind === "literal" && a.texts.length === 1 && a.texts[0] === "") return b;
  if (b.kind === "literal" && b.texts.length === 1 && b.texts[0] === "") return a;
  const aPatterns =
    a.kind === "literal" ? a.texts : a.kind === "opaque" ? a.globPatterns : undefined;
  const bPatterns =
    b.kind === "literal" ? b.texts : b.kind === "opaque" ? b.globPatterns : undefined;
  if (
    aPatterns &&
    bPatterns &&
    (a.kind !== "literal" || b.kind !== "literal") &&
    aPatterns.length * bPatterns.length <= MAX_VALUE_ALTERNATIVES
  ) {
    const patterns = aPatterns.flatMap((left) => bPatterns.map((right) => left + right));
    if (patterns.every((pattern) => pattern.length <= MAX_SCRIPT_BYTES))
      return { ...opaque(...patterns), globPatterns: patterns };
  }
  if (
    a.kind !== "literal" ||
    b.kind !== "literal" ||
    a.texts.length * b.texts.length > MAX_VALUE_ALTERNATIVES ||
    a.texts.some((x) => b.texts.some((y) => x.length + y.length > MAX_SCRIPT_BYTES))
  )
    return {
      ...opaque(...mentions(a), ...mentions(b)),
      prefix:
        a.kind === "literal" && a.texts.length === 1
          ? (a.texts[0] ?? "") + (b.kind === "opaque" ? b.prefix : "")
          : a.kind === "opaque"
            ? a.prefix
            : "",
    };
  return { kind: "literal", texts: a.texts.flatMap((x) => b.texts.map((y) => x + y)) };
}
function merge(a: Scope | null, b: Scope | null): Scope | null {
  if (!a) return b;
  if (!b) return a;
  const bindings = new Map<string, Value>();
  for (const [key, value] of a.bindings) {
    const other = b.bindings.get(key);
    if (other) bindings.set(key, join(value, other));
  }
  const written = new Map(a.written);
  for (const [key, value] of b.written)
    written.set(key, written.has(key) ? join(written.get(key) ?? opaque(), value) : value);
  return {
    ...a,
    braceMode: a.braceMode === b.braceMode ? a.braceMode : "host",
    bindings,
    written,
    exported: new Set([...a.exported, ...b.exported]),
    cwd: join(a.cwd, b.cwd),
    dirtyStartup: [...new Set([...a.dirtyStartup, ...b.dirtyStartup])],
  };
}
function withStartup(scope: Scope, paths: readonly string[]): Scope {
  return {
    ...scope,
    dirtyStartup: [...new Set([...scope.dirtyStartup, ...paths])],
  };
}
function after(flow: Flow): Scope | null {
  return merge(flow.success, flow.failure);
}
function stateKey(scope: Scope): string {
  return JSON.stringify({
    bindings: [...scope.bindings].toSorted(([a], [b]) => a.localeCompare(b)),
    cwd: scope.cwd,
    dirty: scope.dirtyStartup,
    braceMode: scope.braceMode,
    exported: [...scope.exported].toSorted(),
    written: [...scope.written].toSorted(([a], [b]) => a.localeCompare(b)),
  });
}

function redirectsCannotFail(items: readonly Redirect[]): boolean {
  const open = new Set([0, 1, 2]);
  for (const item of items) {
    if (item.kind === "file" && wordText(item.target) === "/dev/null") {
      open.add(item.fd ?? (item.op === "<" ? 0 : 1));
    } else if (item.kind === "duplicate") {
      const fd = item.fd ?? (item.input ? 0 : 1);
      if (item.target === "-") open.delete(fd);
      else if (/^[0-9]+$/.test(item.target) && open.has(Number(item.target))) open.add(fd);
      else return false;
    } else return false;
  }
  return true;
}

function readTargets(command: Command): readonly string[] | null {
  if (command.kind !== "simple" || !command.argv[0] || wordText(command.argv[0]) !== "read")
    return null;
  const names = command.argv.slice(1).map(wordText);
  if (names[0] === "-r") names.shift();
  if (names[0] === "--") names.shift();
  return names.length &&
    names.every(
      (name): name is string => name !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name),
    )
    ? names
    : null;
}

export function judge(script: Script | ParseError, context: PolicyContext): Decision {
  const findings: Finding[] = [];
  let detected = false;
  let steps = 0;
  let herdrSeen = false;
  let loopFrames: LoopFrame[] = [];
  const childShell = (run: () => Flow): Flow => {
    const parent = loopFrames;
    loopFrames = [];
    try {
      return run();
    } finally {
      loopFrames = parent;
    }
  };
  const observedWrites = new Map<string, Value>();
  const observeWrite = (path: string, value: Value): void => {
    observedWrites.set(path, join(observedWrites.get(path) ?? literal(), value));
  };
  const writtenValue = (scope: Scope, path: string): Value | undefined => {
    const scoped = scope.written.get(path);
    const observed = observedWrites.get(path);
    return scoped
      ? observed
        ? join(scoped, observed)
        : scoped
      : observed
        ? opaque(...mentions(observed))
        : undefined;
  };
  const copyProofs: Array<() => void> = [];
  const registry = context.registry ?? buildRegistry();
  const home = normalizePath(context.home, context.home, context.cwd);
  const agentConfigDirectory = (path: string): boolean =>
    (/(?:^|\/)\.codex(?:\/|$)/.test(path) && !path.startsWith(`${home}/.codex/`)) ||
    path === `${home}/.codex/` ||
    path === `${home}/.codex/prompts` ||
    path.startsWith(`${home}/.codex/prompts/`) ||
    /(?:^|\/)\.claude\/(?:commands|agents|skills)(?:\/|$)/.test(path) ||
    path === `${home}/.claude/hooks` ||
    path.startsWith(`${home}/.claude/hooks/`) ||
    path === `${home}/.agents/skills` ||
    path.startsWith(`${home}/.agents/skills/`);
  const agentConfigPath = (path: string): boolean =>
    agentConfigDirectory(path) ||
    /(?:^|\/)(?:agents\.md|claude\.md|\.mcp\.json|\.claude)\/?$/.test(path) ||
    /(?:^|\/)\.claude\/settings[^/]*\.json$/.test(path) ||
    path === `${home}/.agents` ||
    path === `${home}/.codex/config.toml` ||
    path === `${home}/.claude.json`;
  const emit = (rule: string, detail: string, span: Span, uncertainty = false): void => {
    detected ||= !uncertainty;
    if (findings.length < 256) findings.push({ rule: ruleId(rule), detail, span });
  };
  const checkConfigured = (text: string, span: Span): void => {
    for (const pattern of context.dangerousPatterns ?? [])
      if (new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")).test(text))
        emit("configured-pattern", pattern.source, span);
  };
  const issue = (item: Issue, span: Span): void =>
    emit(item.rule, item.detail, span, item.kind === "missing-knowledge");
  const allowed = (name: string, dialect: Script["dialect"]): boolean =>
    [...builtInNonSecretNames, ...(context.approvedNames ?? [])].some((n) =>
      dialect === "powershell" ? n.toLowerCase() === name.toLowerCase() : n === name,
    );
  const bindingName = (name: string, scope: Scope): string =>
    scope.dialect === "powershell" ? name.toLowerCase() : name;
  const startup = (name: string): boolean =>
    registry.startupVariables.has(name.toUpperCase()) ||
    /^(?:LD_|DYLD_|_RLD_|LDR_|PYTHON[A-Z_]|GIT_CONFIG_(?:KEY|VALUE)_)/i.test(name);
  const safeStartup = (
    name: string,
    value: Value,
    argv: readonly (string | undefined)[],
  ): boolean => {
    if (value.kind !== "literal" || value.texts.length !== 1) return false;
    const target = executableName(argv[0] ?? "");
    if (name === "HOME")
      return [
        "jq",
        "cat",
        "sed",
        "awk",
        "ls",
        "rg",
        "grep",
        "head",
        "tail",
        "wc",
        "sort",
        "true",
        ":",
      ].includes(target);
    return (
      ["GIT_EDITOR", "GIT_SEQUENCE_EDITOR"].includes(name) &&
      target === "git" &&
      ["true", ":", "false"].includes(value.texts[0] ?? "")
    );
  };
  const charge = (span: Span, units = 1): boolean => {
    steps += units;
    if (steps <= MAX_FOLD_STEPS) return true;
    emit("analysis-limit", "fold step limit", span, true);
    return false;
  };
  const checkPath = (
    value: Value,
    scope: Scope,
    span: Span,
    contentRead = false,
    gitObject = false,
  ): readonly string[] => {
    const resolved: string[] = [];
    if (value.kind === "stream") return [];
    if (
      (value.kind === "opaque" &&
        !value.globPatterns?.every((pattern) => CODE_OR_PROSE_EXTENSION.test(pattern))) ||
      scope.cwd.kind !== "literal"
    )
      emit("opaque-path", "path is not a finite literal", span, true);
    for (const text of mentions(value)) {
      for (const cwd of mentions(scope.cwd)) {
        const named = text.replace(/^@/, "");
        const clean =
          gitObject && !/^[A-Za-z]:[\\/]/.test(named) ? named.replace(/^[^:]+:/, "") : named;
        const path = normalizePath(clean, context.home, cwd);
        resolved.push(path);
        if (
          isSensitivePath(clean, { ...context, cwd, contentRead }) ||
          context.isPathBlocked?.(path)
        )
          emit("sensitive-path", text, span);
      }
    }
    return resolved;
  };
  const evaluate = (word: Word, scope: Scope, depth: number): Value => {
    if (!charge(word.span, word.parts.length + 1)) return opaque();
    let value = literal("");
    for (const part of word.parts) {
      let next: Value;
      switch (part.kind) {
        case "literal":
          next = literal(part.text);
          break;
        case "brace":
          next = opaque("{" + part.alternatives.join(",") + "}");
          break;
        case "glob":
          next = glob(part.text);
          break;
        case "special": {
          if (/^[0-9]+$/.test(part.name) || part.name === "@" || part.name === "*") {
            if (scope.positional === null) {
              emit("ambient-expansion", `unbound positional ${part.name}`, word.span);
              next = opaque();
            } else if (/^[0-9]+$/.test(part.name))
              next = scope.positional[Number(part.name)] ?? literal("");
            else next = scope.positional.slice(1).reduce(join, literal());
          } else next = opaque();
          break;
        }
        case "parameter": {
          const name = scope.dialect === "powershell" ? part.name.toUpperCase() : part.name;
          const builtIn =
            name === "HOME" && (scope.dialect === "bash" || !part.ambient)
              ? literal(context.home)
              : name === "PWD" && (scope.dialect === "bash" || !part.ambient)
                ? scope.cwd
                : undefined;
          const bound =
            (part.ambient ? undefined : scope.bindings.get(bindingName(part.name, scope))) ??
            builtIn;
          const fallback = part.operand ? evaluate(part.operand, scope, depth) : null;
          if (bound) next = fallback && part.operator !== "plain" ? join(bound, fallback) : bound;
          else if (
            allowed(part.name, scope.dialect) ||
            [
              "PIPESTATUS",
              "pipestatus",
              "BASH_REMATCH",
              "RANDOM",
              "LINENO",
              "SECONDS",
              "PPID",
              "UID",
              "EUID",
              "OPTIND",
              "BASH_VERSION",
            ].includes(part.name)
          )
            next = opaque();
          else if (
            part.operator === "alternate" &&
            fallback?.kind === "literal" &&
            fallback.texts.every((t) => t === "")
          )
            next = literal("");
          else {
            emit("ambient-expansion", part.name, part.span);
            next = opaque();
          }
          if (part.operator === "length") next = opaque();
          break;
        }
        case "command-substitution": {
          const flow = childShell(() =>
            foldList(part.body.body, { ...scope, dialect: part.body.dialect }, opaque(), depth + 1),
          );
          next =
            flow.stdout.kind === "literal"
              ? { kind: "literal", texts: flow.stdout.texts.map((t) => t.replace(/\n+$/, "")) }
              : flow.stdout;
          break;
        }
        case "process-substitution": {
          const flow = childShell(() => foldList(part.body.body, scope, opaque(), depth + 1));
          next = { kind: "stream", stdout: flow.stdout };
          break;
        }
      }
      value = concat(value, next);
    }
    return value;
  };
  const analyze = (
    language: Language,
    value: Value,
    scope: Scope,
    input: Value,
    span: Span,
    depth: number,
    positional: readonly Value[] = [],
  ): Value => {
    if (depth > MAX_PARSE_DEPTH) {
      emit("analysis-limit", "nested execution depth", span, true);
      return opaque();
    }
    if (value.kind !== "literal") {
      emit("opaque-code", "code is not literal", span, true);
      return opaque();
    }
    let stdout: Value = literal();
    for (const text of value.texts) {
      if (language === "bash" || language === "powershell") {
        checkConfigured(text, span);
        const nested = language === "bash" ? parseBash(text) : parsePowerShell(text);
        if (nested.kind === "parse-error") {
          emit(
            nested.code === "work-limit" ? "analysis-limit" : "unparseable",
            nested.code,
            span,
            true,
          );
          continue;
        }
        const findingStart = findings.length;
        const flow = childShell(() =>
          foldList(
            nested.body,
            {
              ...scope,
              positional,
              dialect: nested.dialect,
            },
            input,
            depth + 1,
          ),
        );
        for (let index = findingStart; index < findings.length; index++) {
          const finding = findings[index];
          if (finding) findings[index] = { ...finding, span };
        }
        stdout = join(stdout, flow.stdout);
      } else {
        for (const finding of analyzeCode(language, text)) issue(finding, span);
        stdout = opaque();
      }
    }
    return stdout;
  };
  const redirects = (
    items: readonly Redirect[],
    scope: Scope,
    input: Value,
    depth: number,
    span: Span,
  ): {
    scope: Scope;
    input: Value;
    outputs: readonly { path: string; append: boolean; fd: number }[];
  } => {
    let current = scope;
    let stdin = input;
    const outputs: { path: string; append: boolean; fd: number }[] = [];
    for (const redirect of items) {
      if (redirect.kind === "duplicate") {
        if (redirect.input && (redirect.fd === null || redirect.fd === 0))
          stdin = { ...opaque(), supplied: true };
        continue;
      }
      if (redirect.kind === "heredoc" || redirect.kind === "herestring") {
        const body = evaluate(redirect.body, current, depth);
        const exact = redirect.body.parts.every((part) => part.kind === "literal");
        if (redirect.fd === null || redirect.fd === 0)
          stdin = !exact
            ? opaque(...mentions(body))
            : redirect.kind === "herestring"
              ? concat(body, literal("\n"))
              : body;
        continue;
      }
      const target = evaluate(redirect.target, current, depth);
      const paths = checkPath(target, current, span, redirect.op === "<" || redirect.op === "<>");
      if (
        (redirect.op === "<" || redirect.op === "<>") &&
        (redirect.fd === null || redirect.fd === 0)
      ) {
        stdin = target.kind === "stream" ? target.stdout : { ...opaque(...paths), supplied: true };
      }
      if (redirect.op !== "<") {
        if (current.dialect === "bash" && (paths.some(agentConfigPath) || agentConfigGlob(target)))
          emit("agent-config-write", "write to agent instructions or configuration", span, true);
        outputs.push(
          ...paths.map((path) => ({
            path,
            append: redirect.op === ">>" || redirect.op === "<>",
            fd: redirect.fd ?? 1,
          })),
        );
        current = withStartup(current, paths);
      }
    }
    return { scope: current, input: stdin, outputs };
  };
  const invoke = (
    values: readonly Value[],
    scope: Scope,
    input: Value,
    span: Span,
    depth: number,
    runtimeWrapper = false,
  ): Flow => {
    if (!charge(span, values.length + 1) || depth > MAX_PARSE_DEPTH) {
      if (depth > MAX_PARSE_DEPTH) emit("analysis-limit", "wrapper depth", span, true);
      return { success: scope, failure: scope, stdout: opaque() };
    }
    const first = values[0];
    if (!first || first.kind !== "literal" || first.texts.length !== 1) {
      emit("opaque-executable", "executable is not one literal", span, true);
      return { success: scope, failure: scope, stdout: opaque() };
    }
    const argv = values.map((v) =>
      v.kind === "literal" && v.texts.length === 1
        ? v.texts[0]
        : v.kind === "opaque" &&
            v.globPatterns?.length === 1 &&
            /^(?:--glob|--iglob|--include)=/.test(v.globPatterns[0] ?? "")
          ? v.globPatterns[0]
          : undefined,
    );
    for (const cwd of mentions(scope.cwd)) {
      const executable = first.texts[0] ?? "";
      const written = writtenValue(scope, normalizePath(executable, context.home, cwd));
      if (written)
        analyze(
          /\.(?:py|[cm]?[jt]sx?)$/i.test(executable) ? "runtime" : "bash",
          written,
          scope,
          input,
          span,
          depth + 1,
          values,
        );
    }
    if (argv.every((word) => word !== undefined)) {
      checkConfigured(argv.join(" "), span);
      checkConfigured(
        [argv[0], ...argv.slice(1).map((word) => JSON.stringify(word))].join(" "),
        span,
      );
    }
    herdrSeen ||= executableName(first.texts[0] ?? "") === "herdr";
    context.onInvocation?.(first.texts[0] ?? "", argv);
    for (const value of values.slice(1)) {
      for (const text of mentions(value))
        if (/^(?:env:|(?:microsoft\.powershell\.core[\\/])?environment::)/i.test(text))
          checkPath(value, scope, span);
    }
    const hasInput = input.kind !== "opaque" || input.supplied === true;
    const plan = classify(argv, registry, scope.dialect, runtimeWrapper);
    if (plan.refuseSuppliedStdin && hasInput)
      emit("opaque-code", "wrapped module receives code input", span, true);
    if (plan.pipelinePaths && hasInput) {
      if (input.kind !== "literal")
        emit("opaque-path", "PowerShell pipeline path is not a literal string", span, true);
      else checkPath(input, scope, span, true);
    }
    if (
      [...scope.dirtyStartup, ...observedWrites.keys()].some((path) =>
        plan.startupFiles.some((pattern) => pattern.test(path)),
      )
    )
      emit(
        "startup-mutation",
        "execution follows a write to its trusted startup configuration",
        span,
        true,
      );
    for (const finding of plan.issues) issue(finding, span);
    const bindings = new Map(plan.remote ? [] : scope.bindings);
    const exported = new Set(plan.remote ? [] : scope.exported);
    if (executableName(first.texts[0] ?? "") === "export")
      for (const value of values.slice(1)) {
        const text =
          value.kind === "literal" && value.texts.length === 1
            ? value.texts[0]
            : value.kind === "opaque"
              ? value.prefix
              : undefined;
        const name = /^([A-Za-z_][A-Za-z0-9_]*)(?:=|$)/.exec(text ?? "")?.[1];
        if (name) exported.add(bindingName(name, scope));
      }
    if (plan.delta === "assign") {
      for (const value of values.slice(1)) {
        if (value.kind === "literal") continue;
        const name =
          executableName(first.texts[0] ?? "") === "export" && value.kind === "opaque"
            ? /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(value.prefix)?.[1]
            : undefined;
        if (name) {
          if (startup(name)) emit("startup-mutation", name, span, true);
          bindings.set(bindingName(name, scope), opaque(...mentions(value)));
          continue;
        }
        emit("opaque-env-name", "declaration operand is not literal", span, true);
        for (const fragment of mentions(value)) {
          const mentionedName = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(fragment)?.[1];
          if (mentionedName && startup(mentionedName))
            emit("startup-mutation", mentionedName, span, true);
        }
      }
    }
    for (const assignment of plan.assignments) {
      if (
        startup(assignment.name) &&
        !safeStartup(
          assignment.name,
          literal(assignment.value),
          argv.slice(plan.children[0]?.start ?? argv.length),
        )
      )
        emit("startup-mutation", assignment.name, span, true);
      bindings.set(bindingName(assignment.name, scope), literal(assignment.value));
    }
    let invocationCwd = plan.remote ? literal("/") : scope.cwd;
    for (const operand of plan.cwdOperands) {
      const destination =
        operand.literal !== undefined
          ? literal(operand.literal)
          : (values[operand.index] ?? opaque());
      for (const path of mentions(destination))
        if (/^(?:env:|(?:microsoft\.powershell\.core[\\/])?environment::)/i.test(path))
          checkPath(destination, scope, span);
      const cwd = invocationCwd;
      invocationCwd =
        destination.kind === "literal" && cwd.kind === "literal"
          ? literal(
              ...destination.texts.flatMap((path) =>
                cwd.texts.map((base) => normalizePath(path, context.home, base)),
              ),
            )
          : opaque(...mentions(destination));
    }
    const invocationScope = { ...scope, cwd: invocationCwd };
    if (executableName(first.texts[0] ?? "") === "git") {
      checkPath(invocationScope.cwd, invocationScope, span);
      checkPath(concat(invocationScope.cwd, literal("/")), invocationScope, span);
    }
    if (executableName(first.texts[0] ?? "") === "bun" && plan.cwdOperands.length) {
      checkPath(invocationScope.cwd, invocationScope, span);
      checkPath(concat(invocationScope.cwd, literal("/")), invocationScope, span);
      for (const cwd of mentions(invocationScope.cwd)) {
        if (writtenValue(scope, cwd))
          emit("opaque-path", "Bun working directory was written in this command", span, true);
        const segments = cwd.split("/");
        while (segments.length) {
          const directory = segments.join("/") || "/";
          for (const filename of ["package.json", "bunfig.toml", ".bunfig.toml"]) {
            if (writtenValue(scope, normalizePath(filename, context.home, directory)))
              emit(
                "startup-mutation",
                "Bun project configuration was written in this command",
                span,
                true,
              );
          }
          segments.pop();
        }
      }
    }
    const childScope = {
      ...invocationScope,
      written: plan.remote ? new Map<string, Value>() : invocationScope.written,
      dirtyStartup: plan.remote ? [] : invocationScope.dirtyStartup,
      braceMode:
        executableName(first.texts[0] ?? "") === "bash"
          ? "bash"
          : executableName(first.texts[0] ?? "") === "sh"
            ? "sh"
            : executableName(first.texts[0] ?? "") === "dash"
              ? "literal"
              : invocationScope.braceMode,
      bindings,
      exported: new Set([
        ...exported,
        ...plan.assignments.map((assignment) => bindingName(assignment.name, scope)),
      ]),
    };
    let stdout: Value =
      plan.stdout === "stdin" && scope.dialect === "bash"
        ? input
        : opaque(...values.slice(1).flatMap(mentions));
    if (
      plan.stdout === "arguments" &&
      executableName(first.texts[0] ?? "") === "echo" &&
      scope.dialect === "bash" &&
      argv.every((word) => word !== undefined)
    )
      stdout = literal(argv.slice(1).join(" ") + "\n");
    if (
      executableName(first.texts[0] ?? "") === "printf" &&
      scope.dialect === "bash" &&
      argv.every((word) => word !== undefined)
    ) {
      const output = formatLiteralPrintf(argv.slice(1));
      if (output !== null) stdout = literal(output);
    }

    if (
      scope.dialect === "powershell" &&
      ["write-output", "echo"].includes(executableName(first.texts[0] ?? "")) &&
      argv.length === 2 &&
      argv[1] !== undefined
    )
      stdout = literal(argv[1]);
    let resultScope: Scope = plan.delta === "assign" ? { ...scope, bindings, exported } : scope;
    for (const operand of plan.roles) {
      const value =
        operand.literal !== undefined
          ? literal(operand.literal)
          : (values[operand.index] ?? opaque());
      const role = operand.role;
      if (role === "write-name") {
        if (
          (value.kind !== "literal" && !(value.kind === "opaque" && value.globPatterns)) ||
          invocationScope.cwd.kind !== "literal"
        )
          emit("opaque-path", "write target is not a known name or glob", span, true);
        if (
          scope.dialect === "bash" &&
          (agentConfigGlob(value) ||
            mentions(value).some((text) =>
              mentions(invocationScope.cwd).some((cwd) =>
                agentConfigPath(normalizePath(text, context.home, cwd)),
              ),
            ))
        )
          emit("agent-config-write", "write to agent instructions or configuration", span, true);
        continue;
      }
      if (typeof role !== "string") {
        const analyzedOutput = analyze(
          role.code,
          value,
          childScope,
          input,
          span,
          depth + 1,
          plan.codePositionals.length
            ? plan.codePositionals.map((i) => values[i] ?? opaque())
            : [values[0] ?? opaque()],
        );
        stdout = ["sh", "bash"].includes(executableName(first.texts[0] ?? ""))
          ? analyzedOutput
          : opaque();
        continue;
      }
      if (
        role === "names" &&
        mentions(value).some((text) =>
          /^(?:env:|(?:microsoft\.powershell\.core[\\/])?environment::)/i.test(text),
        )
      )
        checkPath(value, invocationScope, span);
      if (role === "member") {
        if (
          value.kind !== "literal" ||
          !value.texts.every((text) =>
            [
              "name",
              "fullname",
              "length",
              "basename",
              "extension",
              "lastwritetime",
              "count",
            ].includes(text.toLowerCase()),
          )
        )
          emit("no-analyzer", "PowerShell member is not an allowed property", span, true);
        continue;
      }
      if (role === "search-filter") {
        if (value.kind === "opaque" && !value.globPatterns)
          emit("opaque-path", "search filter is not literal", span, true);
        checkPath(literal(...mentions(value)), invocationScope, span, true);
        continue;
      }
      if (role === "path-pattern") {
        const patterns =
          value.kind === "literal"
            ? value.texts.filter(
                (text) => executableName(first.texts[0] ?? "") !== "rg" || !text.startsWith("!"),
              )
            : null;
        if (patterns?.length === 0) continue;
        const alternatives =
          patterns?.flatMap((pattern) => {
            const expanded = expandGlobAlternatives(pattern);
            if (expanded === null) emit("opaque-path", "unsupported glob alternation", span, true);
            return expanded ?? [];
          }) ?? null;
        const patternValue =
          alternatives === null
            ? value
            : alternatives.some((text) => /[*?[]/.test(text))
              ? { ...opaque(...alternatives), globPatterns: alternatives }
              : literal(...alternatives);
        checkPath(patternValue, invocationScope, span, true);
        continue;
      }
      if (
        role === "path" ||
        role === "content" ||
        role === "write" ||
        role === "script" ||
        role === "test-filter"
      ) {
        if (
          scope.dialect === "bash" &&
          (role === "write" ||
            plan.directoryWrites.some((write) => write.sources.includes(operand.index))) &&
          agentConfigGlob(value)
        )
          emit(
            "agent-config-write",
            "glob may write agent instructions or configuration",
            span,
            true,
          );
        const testGlob =
          role === "test-filter" && value.kind === "opaque" && value.globPatterns !== undefined;
        if (
          testGlob &&
          [...invocationScope.written.keys(), ...observedWrites.keys()].some((path) =>
            /\.[cm]?[jt]sx?$/i.test(path),
          )
        )
          emit(
            "opaque-code",
            "test filter may select a script written in this command",
            span,
            true,
          );
        const paths = checkPath(
          testGlob ? literal(...mentions(value)) : value,
          invocationScope,
          span,
          role === "content" || (role === "write" && plan.inPlaceBackupSuffix !== null),
          executableName(first.texts[0] ?? "") === "git",
        );
        if (role === "write") {
          const written = new Map(resultScope.written);
          const targets = [...paths];
          if (plan.inPlaceBackupSuffix !== null) {
            const suffix = plan.inPlaceBackupSuffix;
            if (value.kind !== "literal")
              emit("opaque-path", "in-place target is not literal", span, true);
            if (suffix) {
              const backups = mentions(value).flatMap((text) =>
                suffix.includes("*")
                  ? [text + suffix, suffix.replaceAll("*", text)]
                  : [text + suffix],
              );
              targets.push(...checkPath(literal(...backups), invocationScope, span, true));
            }
            const startupPatterns = [...registry.entries.values()].flatMap(
              (entry) => entry.startupFiles ?? [],
            );
            for (const target of targets)
              if (
                startupPatterns.some((pattern) => pattern.test(target)) ||
                /(?:^|\/)(?:\.?(?:bashrc|bash_profile|bash_login|bash_logout|profile|zshrc|zshenv|zprofile|zlogin|zlogout)|config\.fish)$/.test(
                  target,
                )
              )
                emit("startup-mutation", "in-place write to startup configuration", span, true);
          }
          const destination = plan.directoryWrites.find((write) => write.index === operand.index);
          const agentTargets = [...paths];
          if (
            scope.dialect === "bash" &&
            (executableName(first.texts[0] ?? "") === "install" ||
              destination?.sources.includes(operand.index)) &&
            paths.some((path) => agentConfigPath(`${home}/${path.split("/").at(-1) ?? ""}`))
          )
            emit(
              "agent-config-write",
              "writer candidate has an agent configuration basename",
              span,
              true,
            );
          if (destination)
            for (const sourceIndex of destination.sources)
              for (const name of mentions(values[sourceIndex] ?? opaque()))
                for (const path of paths) {
                  const target = normalizePath(
                    `${path}/${name.replace(/\\/g, "/").replace(/\/+$/, "").split("/").at(-1) ?? ""}`,
                    context.home,
                    context.cwd,
                  );
                  const directory =
                    destination.directory ||
                    (!/^\/(?:tmp|private\/tmp|(?:private\/)?var\/folders)(?:\/|$)/.test(path) &&
                      mentions(value).some((text) => !/\.[^./]+$/.test(text))) ||
                    path === normalizePath(context.home, context.home, context.cwd) ||
                    agentConfigDirectory(path) ||
                    mentions(value).some((text) => /(?:\/|^\.\.?|\/\.\.?)$/.test(text));
                  if (directory) agentTargets.push(target);
                  if (directory || plan.copyDestination) targets.push(target);
                }
          if (
            (plan.copyDestination ||
              (executableName(first.texts[0] ?? "") === "tmutil" && argv[1] === "restore")) &&
            targets.some((target) =>
              /(?:^|\/)(?:\.?(?:bashrc|bash_profile|profile|zshrc|zshenv|zprofile)|config\.fish)$/.test(
                target,
              ),
            )
          )
            emit("startup-mutation", "copy to startup configuration", span, true);
          for (const path of targets) {
            if (scope.dialect === "bash" && agentTargets.includes(path) && agentConfigPath(path)) {
              if (plan.copyDestination) {
                if (
                  values.length !== 3 ||
                  value.kind !== "literal" ||
                  values[1]?.kind !== "literal" ||
                  !context.chainCopyDestinations?.length ||
                  !value.texts.every(
                    (target) => context.proveCopyDestination?.(target, argv[1] ?? "") === true,
                  )
                )
                  emit(
                    "agent-config-write",
                    "copy to agent instructions or configuration requires the existing filesystem proof",
                    span,
                    true,
                  );
              } else
                emit(
                  "agent-config-write",
                  "write to agent instructions or configuration",
                  span,
                  true,
                );
            }
            written.set(path, opaque());
            observeWrite(path, opaque());
          }
          resultScope = withStartup({ ...resultScope, written }, targets);
        }
        if (role === "script" || role === "test-filter") {
          if (
            value.kind === "literal" &&
            value.texts.some((text) => isStdinScript(text) || /^\/dev\/fd\/[0-9]+$/.test(text))
          )
            stdout = analyze(
              plan.scriptLanguage,
              value.texts.every(isStdinScript) ? input : opaque(),
              childScope,
              input,
              span,
              depth + 1,
              values.slice(operand.index),
            );
          if (value.kind === "opaque" && !testGlob)
            emit("opaque-code", "script path is not literal", span, true);
          if (value.kind === "stream")
            stdout = analyze(
              plan.scriptLanguage,
              value.stdout,
              childScope,
              input,
              span,
              depth + 1,
              values.slice(operand.index),
            );
          for (const path of paths) {
            const written = writtenValue(scope, path);
            if (written)
              stdout = analyze(
                plan.scriptLanguage,
                written,
                childScope,
                input,
                span,
                depth + 1,
                values.slice(operand.index),
              );
          }
        }
      } else if (role === "env-name") {
        if (value.kind !== "literal")
          emit("opaque-env-name", "environment name is not literal", span, true);
        else
          for (const name of value.texts)
            if (!allowed(name, scope.dialect) && !bindings.has(bindingName(name, scope)))
              emit("secret-source", `environment ${name}`, span);
      }
    }
    for (const nested of plan.children) {
      const extra = nested.findRoots !== null ? opaque(...nested.findRoots) : input;
      if (plan.xargsInput) {
        const groups =
          input.kind === "literal" && input.texts.length === 1
            ? splitXargsInput(input.texts[0] ?? "", plan.xargsInput)
            : null;
        if (groups === null && input.kind === "literal" && plan.xargsInput.replacement !== null)
          emit("unsupported-option", "xargs replacement input is not portable", span, true);
        for (const words of groups ?? [[""]]) {
          const added = groups === null ? [opaque()] : words.map((word) => literal(word));
          const replaced = values.slice(nested.start, nested.end).map((value) => {
            if (
              !nested.placeholder ||
              value.kind !== "literal" ||
              !value.texts.some((text) => text.includes(nested.placeholder ?? ""))
            )
              return value;
            return groups === null
              ? opaque()
              : literal(
                  ...value.texts.map((text) =>
                    text.replaceAll(nested.placeholder ?? "", words[0] ?? ""),
                  ),
                );
          });
          invoke(
            nested.placeholder ? replaced : [...replaced, ...added],
            childScope,
            opaque(),
            span,
            depth + 1,
          );
        }
        stdout = opaque();
        continue;
      }
      const childValues = values
        .slice(nested.start, nested.end)
        .map((v) =>
          nested.placeholder &&
          v.kind === "literal" &&
          v.texts.some((t) => t.includes(nested.placeholder ?? ""))
            ? extra
            : v,
        );
      if (nested.appendInput) childValues.push(extra);
      const flow = invoke(childValues, childScope, input, span, depth + 1, nested.runtimeWrapper);
      const forwardedBy = executableName(first.texts[0] ?? "");
      const exactForward =
        (forwardedBy === "env" &&
          argv
            .slice(1, nested.start)
            .every((word) => word !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word))) ||
        (["command", "builtin"].includes(forwardedBy) && nested.start === 1) ||
        (forwardedBy === "rtk" && argv[1] === "proxy" && nested.start === 2);
      stdout = exactForward ? flow.stdout : opaque();
      if (["command", "builtin"].includes((first.texts[0] ?? "").toLowerCase()))
        resultScope = after(flow) ?? resultScope;
      else if (!plan.remote) {
        const persisted = merge(resultScope, after(flow)) ?? resultScope;
        resultScope = {
          ...resultScope,
          written: persisted.written,
          dirtyStartup: persisted.dirtyStartup,
        };
      }
    }
    if (plan.stdinCode) stdout = analyze(plan.stdinCode, input, childScope, input, span, depth + 1);
    if (plan.delta === "cd") {
      const directoryBindings = new Map(resultScope.bindings);
      if (scope.dialect === "bash") {
        directoryBindings.set("PWD", invocationScope.cwd);
        directoryBindings.set("OLDPWD", scope.cwd);
      }
      return {
        success: { ...resultScope, bindings: directoryBindings, cwd: invocationScope.cwd },
        failure: resultScope,
        stdout,
      };
    }
    if (plan.copyDestination)
      copyProofs.push(() => {
        const destination = values.at(-1) ?? opaque();
        const paths = checkPath(destination, scope, span);
        if (
          destination.kind !== "literal" ||
          values.length !== 3 ||
          values[1]?.kind !== "literal" ||
          !paths.length ||
          !context.chainCopyDestinations?.length ||
          paths.some(
            (path) =>
              !context.chainCopyDestinations?.some((root) => {
                const normalized = normalizePath(root, context.home, context.cwd);
                return path === normalized || path.startsWith(`${normalized}/`);
              }),
          ) ||
          (destination.kind === "literal" &&
            destination.texts.some(
              (path) => context.proveCopyDestination?.(path, argv[1] ?? "") !== true,
            ))
        )
          emit(
            "copy-destination",
            "copy destination requires the existing filesystem proof",
            span,
            true,
          );
      });
    return { success: resultScope, failure: resultScope, stdout };
  };
  const expandWords = (words: readonly Word[], scope: Scope): readonly Word[] => {
    const expanded: Word[] = [];
    const anyBraces = words.some((word) => word.parts.some((part) => part.kind === "brace"));
    if (!anyBraces) return words;
    for (const word of words) {
      let variants: Array<{ split: boolean; span: Span; parts: Word["parts"][number][] }> = [
        { ...word, parts: [] },
      ];
      for (const part of word.parts) {
        if (!charge(word.span, variants.length)) return [];
        if (part.kind !== "brace") {
          for (const variant of variants) variant.parts.push(part);
          continue;
        }
        if (scope.braceMode === "literal") {
          for (const variant of variants)
            variant.parts.push({
              kind: "literal",
              text: "{" + part.alternatives.join(",") + "}",
              quoted: false,
            });
          continue;
        }
        const choices = part.alternatives;
        if (variants.length * choices.length > MAX_VALUE_ALTERNATIVES) {
          emit("analysis-limit", "brace expansion word limit", word.span, true);
          return [];
        }
        variants = variants.flatMap((variant) =>
          choices.map((text) => ({
            split: variant.split,
            span: variant.span,
            parts: [
              ...variant.parts,
              { kind: "literal", text, quoted: false } satisfies Word["parts"][number],
            ],
          })),
        );
      }
      for (const variant of variants) {
        if (
          scope.braceMode === "bash" &&
          variant.parts.every((part) => part.kind === "literal" && !part.quoted && part.text === "")
        )
          continue;
        expanded.push(variant);
      }
      if (expanded.length > MAX_VALUE_ALTERNATIVES) {
        emit("analysis-limit", "brace expansion word limit", word.span, true);
        return [];
      }
    }
    return expanded;
  };
  const foldCommand = (command: Command, scope: Scope, input: Value, depth: number): Flow => {
    if (!charge(command.span)) return { success: scope, failure: scope, stdout: opaque() };
    const braceWords =
      command.kind === "simple" ? command.argv : command.kind === "for" ? command.items : [];
    if (
      (scope.braceMode === "host" || scope.braceMode === "sh") &&
      braceWords.some((word) => word.parts.some((part) => part.kind === "brace"))
    ) {
      const expanded = foldCommand(command, { ...scope, braceMode: "bash" }, input, depth + 1);
      const other = foldCommand(
        command,
        { ...scope, braceMode: scope.braceMode === "sh" ? "literal" : "zsh" },
        input,
        depth + 1,
      );
      const restore = (state: Scope | null): Scope | null =>
        state && { ...state, braceMode: scope.braceMode };
      return {
        success: restore(merge(expanded.success, other.success)),
        failure: restore(merge(expanded.failure, other.failure)),
        stdout: opaque(),
      };
    }

    if (command.kind === "test") {
      command.words.forEach((word) => evaluate(word, scope, depth));
      return { success: scope, failure: scope, stdout: literal("") };
    }
    if (
      scope.dialect === "bash" &&
      ["literal", "sh"].includes(scope.braceMode) &&
      command.kind !== "simple" &&
      command.redirects.some((item) => item.kind === "file" && ["&>", "&>>"].includes(item.op))
    ) {
      const child = childShell(() =>
        foldCommand(
          {
            ...command,
            redirects: command.redirects.filter(
              (item) => !(item.kind === "file" && ["&>", "&>>"].includes(item.op)),
            ),
          },
          scope,
          input,
          depth + 1,
        ),
      );
      redirects(command.redirects, scope, input, depth, command.span);
      return { ...child, success: scope, failure: scope };
    }
    const redirected = redirects(command.redirects, scope, input, depth, command.span);
    let flow: Flow;
    if (command.kind === "simple") {
      const names = scope.dialect === "bash" ? readTargets(command) : null;
      const assignments = command.assignments.map((a) => ({
        ...a,
        literalValue: wordText(a.value) !== undefined,
        value:
          a.operation === "opaque"
            ? opaque(...mentions(evaluate(a.value, scope, depth)))
            : evaluate(a.value, scope, depth),
      }));
      const executable = command.argv[0];
      const declaration = executable !== undefined && wordText(executable) === "export";
      const values = expandWords(command.argv, scope).flatMap((word, index) => {
        const value = evaluate(word, scope, depth);
        const first = word.parts[0];
        const declared =
          declaration &&
          index > 0 &&
          first?.kind === "literal" &&
          /^[A-Za-z_][A-Za-z0-9_]*=/.test(first.text);
        if (declared || !word.split || value.kind !== "literal") return [value];
        if (value.texts.length !== 1) return [opaque(...value.texts)];
        return (value.texts[0] ?? "")
          .split(/[ \t\n]+/)
          .filter(Boolean)
          .map((text) => (/[*?[]/.test(text) ? glob(text) : literal(text)));
      });
      if (
        values.length > MAX_VALUE_ALTERNATIVES &&
        command.argv.some((word) => word.parts.some((part) => part.kind === "brace"))
      )
        emit("analysis-limit", "brace expansion word limit", command.span, true);
      const bindings = new Map(redirected.scope.bindings);
      for (const assignment of assignments) {
        const readSeparator =
          names !== null && assignment.name === "IFS" && assignment.literalValue;
        if (
          startup(assignment.name) &&
          !readSeparator &&
          !safeStartup(assignment.name, assignment.value, command.argv.map(wordText))
        )
          emit("startup-mutation", assignment.name, command.span, true);
        bindings.set(bindingName(assignment.name, scope), assignment.value);
      }
      if (
        scope.dialect === "powershell" &&
        command.argv.length === 1 &&
        executable?.parts.every((part) => part.kind === "literal" && part.quoted)
      )
        return {
          success: redirected.scope,
          failure: null,
          stdout: evaluate(executable, redirected.scope, depth),
        };
      const transfer = executable ? wordText(executable) : undefined;
      if (
        scope.dialect !== "powershell" &&
        transfer === "exit" &&
        redirectsCannotFail(command.redirects) &&
        !(
          (scope.braceMode === "literal" || scope.braceMode === "sh") &&
          command.redirects.some((item) => item.kind === "file" && ["&>", "&>>"].includes(item.op))
        ) &&
        command.assignments.length === 0 &&
        command.argv.length <= 2 &&
        (command.argv.length === 1 ||
          /^-?\d+$/.test((command.argv[1] ? wordText(command.argv[1]) : undefined) ?? ""))
      ) {
        return { success: null, failure: null, stdout: literal("") };
      }
      if (
        scope.dialect !== "powershell" &&
        transfer === "return" &&
        command.assignments.length === 0 &&
        command.argv.length <= 2 &&
        (command.argv.length === 1 ||
          /^-?\d+$/.test((command.argv[1] ? wordText(command.argv[1]) : undefined) ?? ""))
      )
        return { success: null, failure: redirected.scope, stdout: literal("") };
      const frame = loopFrames.at(-1);
      if (
        scope.dialect !== "powershell" &&
        frame?.allowed &&
        (transfer === "break" || transfer === "continue") &&
        command.assignments.length === 0 &&
        command.redirects.length === 0 &&
        (command.argv.length === 1 ||
          (command.argv.length === 2 && command.argv[1] && wordText(command.argv[1]) === "1"))
      ) {
        if (transfer === "break") frame.breaks = merge(frame.breaks, redirected.scope);
        else frame.continues = merge(frame.continues, redirected.scope);
        return { success: null, failure: null, stdout: literal("") };
      }
      let readFlow: Flow | undefined;
      if (names) {
        const readBindings = new Map(bindings);
        for (const name of names) {
          if (
            startup(name) ||
            /^[A-Z_]/.test(name) ||
            scope.exported.has(name) ||
            /^(?:path|cdpath|fpath|manpath|module_path|mailpath|watch|psvar|argv|status|pipestatus|reply|commands|functions|options|parameters|history|dirstack|aliases|signals|zsh_eval_context|galiases|keymaps|jobdirs|patchars|functrace|funcsourcetrace|zsh_scheduled_events|terminfo|reswords|modules|histchars|fignore|usergroups|saliases|funcstack|widgets|userdirs|historywords|nameddirs|termcap|functions_source|jobtexts|funcfiletrace|builtins|prompt|rprompt|jobstates|http_proxy|https_proxy|all_proxy|no_proxy|dis_.*|.*_functions)$/.test(
              name,
            )
          )
            emit(
              "startup-mutation",
              "read into shell control or exported variable " + name,
              command.span,
              true,
            );
          readBindings.set(name, opaque());
        }
        const success = { ...redirected.scope, bindings: readBindings };
        const failure = merge({ ...redirected.scope, bindings }, success);
        readFlow = { success, failure, stdout: opaque() };
      }
      flow =
        readFlow ??
        (values.length
          ? invoke(
              values,
              {
                ...redirected.scope,
                bindings,
                exported: new Set([
                  ...scope.exported,
                  ...assignments.map((assignment) => bindingName(assignment.name, scope)),
                ]),
              },
              redirected.input,
              command.span,
              depth,
            )
          : {
              success: { ...redirected.scope, bindings },
              failure:
                command.redirects.length ||
                command.assignments.some((a) =>
                  a.value.parts.some((part) => part.kind === "command-substitution"),
                )
                  ? { ...redirected.scope, bindings }
                  : null,
              stdout: literal(""),
            });
      if (values.length && assignments.length) {
        const restore = (state: Scope | null): Scope | null => {
          if (!state) return null;
          const restored = new Map(state.bindings);
          for (const assignment of assignments) {
            const name = bindingName(assignment.name, scope);
            const old = scope.bindings.get(name);
            const persistent = [
              ":",
              "export",
              "readonly",
              "eval",
              "set",
              "shift",
              "times",
              "trap",
              ".",
              "exec",
              "return",
              "break",
              "continue",
              "unset",
            ].includes(transfer ?? "");
            if (old)
              restored.set(
                name,
                persistent ? join(old, state.bindings.get(name) ?? opaque()) : old,
              );
            else restored.delete(name);
          }
          return { ...state, bindings: restored, exported: scope.exported };
        };
        flow = { ...flow, success: restore(flow.success), failure: restore(flow.failure) };
      }
    } else if (command.kind === "group") {
      const run = (): Flow => foldList(command.body, redirected.scope, redirected.input, depth + 1);
      flow = command.subshell ? childShell(run) : run();
      if (command.subshell) flow = { ...flow, success: scope, failure: scope };
    } else if (command.kind === "for") {
      if (startup(command.name)) emit("startup-mutation", command.name, command.span, true);
      const items: Value[] = [];
      for (const word of expandWords(command.items, scope)) {
        const value = evaluate(word, scope, depth);
        if (value.kind === "literal" && value.texts.length === 1) {
          const text = value.texts[0] ?? "";
          if (!word.split) items.push(literal(text));
          else
            for (const part of text.split(/[ \t\n]+/).filter(Boolean))
              items.push(/[*?[]/.test(part) ? glob(part) : literal(part));
        } else items.push(opaque(...mentions(value)));
      }
      if (items.length > MAX_VALUE_ALTERNATIVES) {
        emit("analysis-limit", "loop item limit", command.span, true);
        flow = { success: scope, failure: scope, stdout: opaque() };
      } else {
        let current: Scope | null = redirected.scope;
        const frame: LoopFrame = {
          allowed: items.every((item) => item.kind === "literal"),
          breaks: null,
          continues: null,
        };
        loopFrames.push(frame);
        for (const item of items) {
          if (!current) break;
          const bindings = new Map(current.bindings);
          bindings.set(bindingName(command.name, scope), item);
          const step = foldList(
            command.body,
            { ...current, bindings },
            redirected.input,
            depth + 1,
          );
          current = merge(after(step), frame.continues);
          frame.continues = null;
        }
        loopFrames.pop();
        const exit = merge(current, frame.breaks);
        flow = { success: exit, failure: exit, stdout: opaque() };
      }
    } else if (command.kind === "while" || command.kind === "until") {
      let current = redirected.scope;
      let stable = false;
      let conditionExits: Scope | null = null;
      const frame: LoopFrame = { allowed: true, breaks: null, continues: null };
      loopFrames.push(frame);
      for (let pass = 0; pass < MAX_LOOP_PASSES; pass++) {
        const condition = foldList(command.condition, current, redirected.input, depth + 1);
        const entry = command.kind === "while" ? condition.success : condition.failure;
        conditionExits = merge(
          conditionExits,
          command.kind === "while" ? condition.failure : condition.success,
        );
        const body = entry ? foldList(command.body, entry, redirected.input, depth + 1) : null;
        const next =
          merge(redirected.scope, merge(body ? after(body) : null, frame.continues)) ?? current;
        frame.continues = null;
        if (stateKey(next) === stateKey(current)) {
          stable = true;
          break;
        }
        current = next;
      }
      loopFrames.pop();
      if (!stable) emit("analysis-limit", "loop state did not converge", command.span, true);
      const exit = merge(merge(current, frame.breaks), conditionExits);
      flow = { success: exit, failure: exit, stdout: opaque() };
    } else {
      const branches: Flow[] = [];
      if (command.kind === "if") {
        let entry = redirected.scope;
        for (const branch of command.branches) {
          const condition = foldList(branch.condition, entry, redirected.input, depth + 1);
          if (condition.success)
            branches.push(foldList(branch.body, condition.success, redirected.input, depth + 1));
          entry = condition.failure ?? entry;
        }
        branches.push(
          command.otherwise
            ? foldList(command.otherwise, entry, redirected.input, depth + 1)
            : { success: entry, failure: null, stdout: literal("") },
        );
      } else {
        evaluate(command.subject, scope, depth);
        for (const arm of command.arms) {
          arm.patterns.forEach((word) => evaluate(word, scope, depth));
          branches.push(foldList(arm.body, redirected.scope, redirected.input, depth + 1));
        }
        branches.push({ success: scope, failure: null, stdout: literal("") });
      }
      flow = branches.reduce<Flow>(
        (a, b) => ({
          success: merge(a.success, b.success),
          failure: merge(a.failure, b.failure),
          stdout: join(a.stdout, b.stdout),
        }),
        { success: null, failure: null, stdout: literal() },
      );
    }
    if (
      !["simple", "group", "test"].includes(command.kind) ||
      (command.kind === "simple" &&
        command.argv.some((word) => word.parts.some((part) => part.kind !== "literal")))
    )
      flow = { ...flow, stdout: opaque() };
    if (redirected.outputs.length) {
      if (!after(flow))
        for (const output of redirected.outputs) observeWrite(output.path, opaque());
      const remember = (state: Scope | null): Scope | null => {
        if (!state) return null;
        const written = new Map(state.written);
        for (const output of redirected.outputs) {
          const contents =
            output.append ||
            output.fd !== 1 ||
            redirected.outputs.length !== 1 ||
            command.redirects.some((redirect) => redirect.kind === "duplicate")
              ? opaque()
              : flow.stdout;
          written.set(output.path, contents);
          observeWrite(output.path, contents);
        }
        return { ...state, written };
      };
      flow = { ...flow, success: remember(flow.success), failure: remember(flow.failure) };
    }
    if (
      command.redirects.some(
        (redirect) =>
          redirect.kind === "duplicate" || (redirect.kind === "file" && redirect.op !== "<"),
      )
    )
      flow = { ...flow, stdout: opaque() };
    return flow;
  };
  const foldPipeline = (pipeline: Pipeline, scope: Scope, input: Value, depth: number): Flow => {
    let current: Flow = { success: scope, failure: null, stdout: input };
    for (const [index, command] of pipeline.commands.entries()) {
      const incoming = pipeline.stderr
        ? { ...opaque(), supplied: true }
        : index > 0 && current.stdout.kind === "opaque"
          ? { ...current.stdout, supplied: true }
          : current.stdout;
      current =
        pipeline.commands.length > 1
          ? childShell(() => foldCommand(command, scope, incoming, depth))
          : foldCommand(command, scope, incoming, depth);
    }
    if (pipeline.stderr) current = { ...current, stdout: opaque() };
    if (pipeline.commands.length > 1)
      current = {
        ...current,
        success: merge(scope, current.success),
        failure: merge(scope, current.failure),
      };
    return pipeline.negated
      ? { ...current, success: current.failure, failure: current.success }
      : current;
  };
  function foldList(list: List, scope: Scope, input: Value, depth: number): Flow {
    if (depth > MAX_PARSE_DEPTH) {
      emit("analysis-limit", "composition depth", { start: 0, end: 0 }, true);
      return { success: scope, failure: scope, stdout: opaque() };
    }
    let current: Flow = { success: scope, failure: null, stdout: literal() };
    let output: Value = literal();
    for (const item of list.items) {
      const entry = after(current);
      if (!entry) break;
      const last = (item.rest.at(-1)?.pipeline ?? item.first).commands.at(-1);
      const background =
        item.background ||
        (scope.dialect === "bash" &&
          ["literal", "sh"].includes(scope.braceMode) &&
          last?.kind !== "test" &&
          last?.redirects.some(
            (redirect) => redirect.kind === "file" && ["&>", "&>>"].includes(redirect.op),
          ));
      const run = (pipeline: Pipeline, state: Scope): Flow =>
        background
          ? childShell(() => foldPipeline(pipeline, state, input, depth))
          : foldPipeline(pipeline, state, input, depth);
      current = run(item.first, entry);
      for (const part of item.rest) {
        const selected = part.op === "&&" ? current.success : current.failure;
        if (!selected) continue;
        const next = run(part.pipeline, selected);
        current =
          part.op === "&&"
            ? {
                success: next.success,
                failure: merge(current.failure, next.failure),
                stdout: join(current.stdout, next.stdout),
              }
            : {
                success: merge(current.success, next.success),
                failure: next.failure,
                stdout: join(current.stdout, next.stdout),
              };
      }
      if (background) current = { ...current, success: entry, failure: entry };
      output = join(output, current.stdout);
    }
    const single =
      list.items.length === 1 && list.items[0]?.rest.length === 0 && !list.items[0]?.background;
    return { ...current, stdout: single ? output : opaque() };
  }
  if (script.kind === "parse-error")
    emit(
      script.code === "work-limit" ? "analysis-limit" : "unparseable",
      script.code,
      script.span,
      true,
    );
  else {
    const scope: Scope = {
      bindings: new Map(),
      cwd: literal(normalizePath(context.cwd, context.home, "/")),
      positional: null,
      written: new Map(),
      exported: new Set(),
      dirtyStartup: [],
      dialect: script.dialect,
      braceMode: "host",
    };
    foldList(script.body, scope, opaque(), 0);
    if (herdrSeen || context.chainCopyDestinations?.length) for (const prove of copyProofs) prove();
    checkConfigured(script.source, script.span);
  }
  const [first, ...rest] = findings;
  return first
    ? { kind: detected ? "violation" : "missing-knowledge", findings: [first, ...rest] }
    : { kind: "pass" };
}
