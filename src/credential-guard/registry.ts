import rgTypes from "./rg-types.json";
import type { XargsInput } from "./xargs";
import { isPassiveAwkProgram } from "./passive-awk";
import { isPassiveSedProgram } from "./passive-sed";
import { isPassiveJqFilter } from "./passive-jq";

export type Language = "bash" | "powershell" | "jq" | "sed" | "awk" | "runtime";
export type OperandRole =
  | "data"
  | "path"
  | "content"
  | "path-pattern"
  | "search-filter"
  | "names"
  | "env-name"
  | "script"
  | "test-filter"
  | "member"
  | "rg-type"
  | "write"
  | "write-name"
  | { readonly code: Language };
export type Issue = {
  readonly kind: "violation" | "missing-knowledge";
  readonly rule:
    | "secret-source"
    | "wrapper-required"
    | "no-analyzer"
    | "opaque-code"
    | "opaque-executable"
    | "opaque-env-name"
    | "startup-mutation"
    | "agent-launch-override"
    | "unsupported-option";
  readonly detail: string;
};
export type Option = {
  readonly roles: readonly OperandRole[];
  readonly issue?: Issue;
  readonly attachedValue?: RegExp;
};
export type ExecutableEntry = {
  readonly name: string;
  readonly rejectsAbbreviations?: boolean;
  readonly readsContent?: boolean;
  readonly readsStdinCode?: boolean;
  readonly builtinOnly?: boolean;
  readonly pipelineData?: boolean;
  readonly aliases?: readonly string[];
  readonly numericOption?: boolean;
  readonly optionsBeforeOperands?: boolean;
  readonly optionGrammar?: "echo" | "printf";
  readonly informationFlags?: readonly string[];
  readonly namePattern?: RegExp;
  readonly operands: readonly OperandRole[];
  readonly options?: Readonly<Record<string, Option>>;
  readonly subcommands?: Readonly<Record<string, Omit<ExecutableEntry, "name">>>;
  readonly effect?: Issue | "none";
  readonly bare?: Issue;
  readonly startup?: readonly string[];
  readonly startupFiles?: readonly RegExp[];
  readonly semantics?:
    | "joined-shell"
    | "remote-shell"
    | "ordinary"
    | "shell"
    | "runtime"
    | "python"
    | "env"
    | "forward"
    | "timeout"
    | "xargs"
    | "find"
    | "gh"
    | "git"
    | "ps"
    | "sed"
    | "awk"
    | "jq"
    | "herdr"
    | "copy"
    | "cd"
    | "seq"
    | "listing"
    | "eval"
    | "env-provider"
    | "curl";
  readonly stdout?: "opaque" | "arguments" | "stdin";
};
export type Registry = {
  readonly entries: ReadonlyMap<string, ExecutableEntry>;
  readonly startupVariables: ReadonlySet<string>;
  readonly blocked: ReadonlyMap<string, string>;
};
export type InvocationPlan = {
  readonly remote: boolean;
  readonly xargsInput: XargsInput | null;
  readonly roles: readonly {
    readonly index: number;
    readonly role: OperandRole;
    readonly literal?: string;
  }[];
  readonly issues: readonly Issue[];
  readonly children: readonly {
    readonly start: number;
    readonly end: number;
    readonly appendInput: boolean;
    readonly placeholder: string | null;
    readonly findRoots: readonly string[] | null;
    readonly runtimeWrapper?: boolean;
  }[];
  readonly assignments: readonly {
    readonly name: string;
    readonly index: number;
    readonly value: string;
  }[];
  readonly stdout: "opaque" | "arguments" | "stdin";
  readonly delta: "none" | "cd" | "assign";
  readonly stdinCode: Language | null;
  readonly refuseSuppliedStdin: boolean;
  readonly pipelinePaths: boolean;
  readonly startupFiles: readonly RegExp[];
  readonly copyDestination: boolean;
  readonly directoryWrites: readonly {
    readonly index: number;
    readonly sources: readonly number[];
    readonly directory: boolean;
  }[];
  readonly inPlaceBackupSuffix: string | null;
  readonly scriptLanguage: Language;
  readonly codePositionals: readonly number[];
  readonly cwdOperands: readonly { readonly index: number; readonly literal?: string }[];
};
const data: OperandRole = "data";
const path: OperandRole = "path";
const flag: Option = { roles: [] };
const arg = (...roles: OperandRole[]): Option => ({ roles });
const code = (language: Language): OperandRole => ({ code: language });
const source = (detail: string): Issue => ({ kind: "violation", rule: "secret-source", detail });
const unknown = (detail: string): Issue => ({
  kind: "missing-knowledge",
  rule: "no-analyzer",
  detail,
});
const wrapper = (name: string, suggestion: string): Issue => ({
  kind: "violation",
  rule: "wrapper-required",
  detail: `${name}: ${suggestion}`,
});
const flags = (...names: string[]): Readonly<Record<string, Option>> =>
  Object.fromEntries(names.map((name) => [name, flag]));
const readerOptions = {
  ...flags("-q", "-v", "--quiet", "--verbose"),
  "-n": arg(data),
  "-c": arg(data),
};
const shellOptions = {
  ...flags("-e", "-u", "-x", "-s", "--noprofile", "--norc"),
  "-c": arg(code("bash")),
  "--rcfile": { roles: ["script"], issue: unknown("shell startup file") },
  "--init-file": { roles: ["script"], issue: unknown("shell startup file") },
  "-o": arg(data),
  "-l": { roles: [], issue: unknown("login shell startup") },
  "-i": { roles: [], issue: unknown("interactive shell startup") },
} satisfies Readonly<Record<string, Option>>;
const nodeOptions = {
  ...flags("--version", "-v", "--help"),
  "-e": arg(code("runtime")),
  "--eval": arg(code("runtime")),
  "-p": arg(code("runtime")),
  "--print": arg(code("runtime")),
  "-r": { roles: [path], issue: unknown("runtime preload") },
  "--require": { roles: [path], issue: unknown("runtime preload") },
  "--import": { roles: [path], issue: unknown("runtime import") },
  "--env-file": arg(path),
};
const pythonOptions = {
  ...flags("-I", "-S", "-B", "-E", "-u", "--version", "-V", "--help"),
  "-c": arg(code("runtime")),
  "-m": arg(data),
  "-W": arg(data),
  "--check-hash-based-pycs": arg(data),
  "-X": arg(data),
};

const gitDiffOptions = {
  ...Object.fromEntries(
    ["-U", "-C", "-M"].map((name) => [name, { roles: [], attachedValue: /^[0-9]+%?$/ }]),
  ),
  "--unified": flag,
  "--dirstat": flag,
  "--ignore-submodules": arg(data),
  ...flags(
    "--stat",
    "--shortstat",
    "--numstat",
    "--name-only",
    "--name-status",
    "--check",
    "--cached",
    "--staged",
    "--no-color",
    "--color",
    "--no-ext-diff",
    "--no-textconv",
    "--exit-code",
    "--quiet",
    "--patch",
    "--no-patch",
    "--raw",
    "--summary",
    "--compact-summary",
    "--ignore-space-change",
    "--ignore-all-space",
    "--ignore-space-at-eol",
    "--ignore-cr-at-eol",
    "--word-diff",
    "--relative",
    "--binary",
    "--full-index",
    "--cc",
    "-c",
    "--no-renames",
    "-p",
    "-s",
  ),
  "--diff-filter": arg(data),
  "--stat-width": arg(data),
  "--stat-name-width": arg(data),
  "--word-diff-regex": arg(data),
  "--output-indicator-new": arg(data),
  "--output-indicator-old": arg(data),
  "--output-indicator-context": arg(data),
};
const gitLogOptions = {
  ...gitDiffOptions,
  ...flags(
    "--oneline",
    "--decorate",
    "--graph",
    "--all",
    "--reverse",
    "--first-parent",
    "--no-merges",
    "--merges",
    "--follow",
    "--abbrev-commit",
    "--date-order",
    "--topo-order",
    "--no-decorate",
    "--branches",
    "--tags",
    "--remotes",
    "--not",
    "--reflog",
    "--timestamp",
    "-g",
  ),
  "--format": arg(data),
  "--pretty": arg(data),
  "--author": arg(data),
  "--committer": arg(data),
  "--since": arg(data),
  "--until": arg(data),
  "--before": arg(data),
  "--after": arg(data),
  "--date": arg(data),
  "--max-count": arg(data),
  "-n": arg(data),
  "--skip": arg(data),
  "--max-parents": arg(data),
  "--min-parents": arg(data),
};

export const EXECUTABLES: readonly ExecutableEntry[] = [
  {
    name: "git",
    informationFlags: ["--help", "--version"],
    startupFiles: [/(?:^|\/)\.git\/config$/],
    operands: [data],
    semantics: "git",
    startup: [
      "GIT_CONFIG",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_SYSTEM",
      "GIT_EDITOR",
      "GIT_SEQUENCE_EDITOR",
      "GIT_PAGER",
      "GIT_SSH_COMMAND",
      "GIT_SSH",
      "GIT_PROXY_COMMAND",
      "GIT_EXEC_PATH",
      "GIT_ASKPASS",
      "SSH_ASKPASS",
      "EDITOR",
      "VISUAL",
      "GIT_CONFIG_PARAMETERS",
      "GIT_EXTERNAL_DIFF",
      "PAGER",
      "EDITOR",
      "VISUAL",
    ],
    options: {
      "-C": arg("names"),
      "-c": arg(data),
      "--config-env": { roles: [data], issue: unknown("git config override") },
      ...flags(
        "--help",
        "--version",
        "--no-optional-locks",
        "--literal-pathspecs",
        "--no-replace-objects",
      ),
      "--git-dir": arg("names"),
      "--exec-path": { roles: [data], issue: unknown("git executable directory") },
      "--textconv": { roles: [], issue: unknown("git text converter") },
      "--ext-diff": { roles: [], issue: unknown("git external diff") },
      "--upload-pack": { roles: [data], issue: unknown("git upload program") },
      "--receive-pack": { roles: [data], issue: unknown("git receive program") },
      "--work-tree": arg("names"),
      ...flags("--no-pager", "--paginate", "-P", "--bare"),
    },
    subcommands: {
      switch: {
        operands: [data],
        options: { "-c": arg(data), "-C": arg(data), ...flags("-q", "--detach", "--force", "-f") },
      },
      bisect: { operands: [data], subcommands: { run: { operands: [data] } } },
      submodule: {
        operands: [data],
        subcommands: {
          foreach: { operands: [data], options: flags("--recursive", "--quiet", "-q") },
        },
        options: {
          ...flags(
            "--init",
            "--recursive",
            "--force",
            "--remote",
            "--checkout",
            "--merge",
            "--rebase",
            "--quiet",
            "-q",
          ),
          "--reference": arg("names"),
          "--depth": arg(data),
          "--jobs": arg(data),
        },
      },
      "ls-remote": {
        operands: [data],
        options: flags("--heads", "--tags", "--refs", "--exit-code", "-q"),
      },
      "merge-tree": {
        operands: [data],
        options: flags(
          "--write-tree",
          "--name-only",
          "--no-messages",
          "--allow-unrelated-histories",
        ),
      },
      apply: {
        operands: ["content"],
        options: flags(
          "--3way",
          "--check",
          "--stat",
          "--numstat",
          "--cached",
          "--index",
          "--reverse",
          "-R",
        ),
      },
      "update-index": {
        operands: ["names"],
        options: {
          "--cacheinfo": arg(data),
          ...flags("--add", "--remove", "--force-remove", "--refresh"),
        },
      },
      tag: {
        operands: [data],
        options: {
          ...flags("--list", "-l", "-d", "-f", "-a", "-s"),
          "-m": arg(data),
          "--format": arg(data),
          "--sort": arg(data),
          "-F": arg("content"),
        },
      },
      stash: {
        operands: ["names"],
        options: {
          ...flags(
            "-u",
            "--include-untracked",
            "--all",
            "-a",
            "-q",
            "--quiet",
            "--keep-index",
            "--staged",
          ),
          "-m": arg(data),
        },
      },
      clone: {
        operands: ["names"],
        options: {
          "--depth": arg(data),
          "--reference": arg("names"),
          "-b": arg(data),
          "--branch": arg(data),
          ...flags("--recursive", "--recurse-submodules", "--bare", "--mirror", "--quiet", "-q"),
        },
      },
      status: {
        operands: ["names"],
        options: {
          ...flags(
            "--short",
            "-s",
            "--branch",
            "-b",
            "--porcelain",
            "--ignored",
            "--untracked-files",
            "-u",
          ),
          "--ignore-submodules": arg(data),
        },
      },
      branch: {
        operands: [data],
        options: {
          ...flags(
            "--show-current",
            "-q",
            "--quiet",
            "--merged",
            "--no-merged",
            "-d",
            "-D",
            "-a",
            "-r",
            "-v",
            "-l",
            "-m",
            "-M",
            "--list",
            "--contains",
            "-f",
            "--force",
            "--no-track",
          ),
          "--sort": arg(data),
          "-c": flag,
          "-C": flag,
          "--format": arg(data),
          "--set-upstream-to": arg(data),
          "--track": flag,
        },
      },
      checkout: {
        operands: ["names"],
        options: {
          ...flags("-q", "-f", "--detach", "--ours", "--theirs"),
          "-b": arg(data),
          "-B": arg(data),
        },
      },
      difftool: {
        operands: [path],
        options: {
          "-x": arg(code("bash")),
          "--extcmd": arg(code("bash")),
          "-t": arg(data),
          "--tool": arg(data),
          ...flags("--tool-help", "-y", "--no-prompt"),
        },
      },
      rebase: {
        operands: [data],
        options: {
          ...flags(
            "--continue",
            "--abort",
            "--skip",
            "-i",
            "--interactive",
            "--autosquash",
            "--autostash",
            "--keep-base",
            "--rebase-merges",
            "-q",
            "--quiet",
            "--show-current-patch",
          ),
          "--onto": arg(data),
          "-x": arg(code("bash")),
          "--exec": arg(code("bash")),
        },
      },
      push: {
        operands: [data],
        options: flags(
          "-u",
          "--set-upstream",
          "--force-with-lease",
          "--force-if-includes",
          "-f",
          "--force",
          "--tags",
          "--follow-tags",
          "--delete",
          "--dry-run",
          "-q",
          "--quiet",
          "--porcelain",
          "--all",
        ),
      },
      fetch: {
        operands: [data],
        options: {
          ...flags("-u", "--update-head-ok"),
          ...flags(
            "-q",
            "--quiet",
            "--all",
            "--prune",
            "-p",
            "--tags",
            "--no-tags",
            "--force",
            "-f",
          ),
          "--depth": arg(data),
        },
      },
      pull: {
        operands: [data],
        options: flags("--ff-only", "--rebase", "--no-rebase", "--autostash", "-q", "--quiet"),
      },
      merge: {
        operands: [data],
        options: {
          ...flags(
            "--ff-only",
            "--no-ff",
            "--no-commit",
            "--abort",
            "--continue",
            "--squash",
            "--no-edit",
            "-q",
          ),
          "-m": arg(data),
        },
      },
      reset: {
        operands: ["names"],
        options: flags("--hard", "--soft", "--mixed", "--keep", "--merge", "-q"),
      },
      restore: {
        operands: ["names"],
        options: {
          ...flags("--staged", "--worktree", "--ours", "--theirs"),
          "--source": arg(data),
          "-s": arg(data),
        },
      },
      remote: {
        operands: [data],
        options: flags("-v", "--verbose", "-a", "--auto", "--all", "--push", "--add", "--delete"),
      },
      worktree: {
        operands: ["names"],
        options: {
          ...flags("--porcelain", "--force", "-f", "--detach", "-q", "--quiet"),
          "-b": arg(data),
          "-B": arg(data),
        },
      },
      "ls-files": {
        operands: ["names"],
        options: {
          ...flags(
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
            "--modified",
            "--deleted",
            "--stage",
            "-s",
            "--unmerged",
            "-u",
          ),
          "--exclude": arg(data),
        },
      },
      "ls-tree": {
        operands: [data],
        options: flags(
          "-r",
          "-t",
          "-d",
          "--name-only",
          "--name-status",
          "--full-tree",
          "--long",
          "-l",
          "-z",
        ),
      },
      "merge-base": {
        operands: [data],
        options: flags("--is-ancestor", "--fork-point", "--all", "--octopus"),
      },
      "rev-list": {
        operands: [data],
        numericOption: true,
        options: { ...gitLogOptions, ...flags("--count", "--left-right", "--boundary") },
      },
      show: {
        numericOption: true,
        readsContent: true,
        operands: [path],
        options: {
          ...gitLogOptions,
          "--textconv": { roles: [], issue: unknown("git text converter") },
          "--ext-diff": { roles: [], issue: unknown("git external diff") },
        },
      },
      "rev-parse": {
        operands: ["names"],
        options: {
          ...flags(
            "--git-dir",
            "--absolute-git-dir",
            "--git-common-dir",
            "--show-toplevel",
            "--show-prefix",
            "--is-inside-work-tree",
            "--is-bare-repository",
            "--short",
            "--verify",
            "--abbrev-ref",
            "--symbolic-full-name",
            "-q",
            "--quiet",
            "--branches",
            "--tags",
            "--remotes",
            "--all",
            "--not",
          ),
          "--git-path": arg("names"),
        },
      },
      diff: {
        operands: [path],
        readsContent: true,
        options: {
          ...gitDiffOptions,
          "-S": arg(data),
          "-G": arg(data),
          "-I": arg(data),
          "--grep": arg(data),
          "--dst-prefix": arg(data),
          "--src-prefix": arg(data),
          "-l": arg(data),
          "--line-prefix": arg(data),
          "--ws-error-highlight": arg(data),
          "--color-moved-ws": arg(data),
          "--color": flag,
          ...flags("-p", "-u", "-R", "-w", "-b"),
          "--no-index": flag,
          "--output": arg("write"),
          "-O": arg(path),
          "--ext-diff": { roles: [], issue: unknown("git external diff") },
          "--textconv": { roles: [], issue: unknown("git text converter") },
        },
      },
      log: {
        numericOption: true,
        operands: [path],
        options: {
          ...gitLogOptions,
          "-S": arg(data),
          "-G": arg(data),
          "-I": arg(data),
          "--grep": arg(data),
          "--dst-prefix": arg(data),
          "--src-prefix": arg(data),
          "-l": arg(data),
          "--line-prefix": arg(data),
          "--ws-error-highlight": arg(data),
          "--color-moved-ws": arg(data),
          "--color": flag,
          "--textconv": { roles: [], issue: unknown("git text converter") },
          "--ext-diff": { roles: [], issue: unknown("git external diff") },
        },
      },
      blame: {
        readsContent: true,
        operands: [path],
        options: {
          "-L": arg(data),
          "--contents": arg("content"),
          "--ignore-revs-file": arg("content"),
          "-S": arg("content"),
          ...flags("-p", "--porcelain", "--line-porcelain", "-l", "-n", "-w"),
        },
      },
      "for-each-ref": {
        operands: [data],
        options: {
          "--format": arg(data),
          "--sort": arg(data),
          "--count": arg(data),
          "--points-at": arg(data),
          "--contains": arg(data),
          "--no-contains": arg(data),
          "--merged": arg(data),
          "--no-merged": arg(data),
          ...flags(
            "--shell",
            "-s",
            "--perl",
            "-p",
            "--python",
            "--tcl",
            "--stdin",
            "--ignore-case",
          ),
        },
      },
      "commit-tree": {
        operands: [data],
        options: { "-p": arg(data), "-m": arg(data), "-F": arg("content") },
      },
      "check-ignore": {
        operands: ["names"],
        options: flags("-v", "--verbose", "-q", "--quiet", "--stdin", "-z", "--no-index"),
      },
      "symbolic-ref": {
        operands: [data],
        options: {
          "-m": arg(data),
          ...flags("--short", "-q", "--quiet", "--no-recurse", "-d", "--delete"),
        },
      },
      init: {
        operands: ["write"],
        options: {
          "-b": arg(data),
          "--initial-branch": arg(data),
          ...flags("-q", "--quiet", "--bare"),
        },
      },
      replay: {
        operands: [data],
        options: { "--onto": arg(data), "--advance": arg(data), "--contained": flag },
      },
      reflog: { operands: [data], options: gitLogOptions },
      cherry: { operands: [data], options: flags("-v") },
      "cherry-pick": {
        operands: [data],
        options: {
          "-m": arg(data),
          ...flags("--no-commit", "-n", "--no-edit", "--continue", "--abort", "--skip"),
        },
      },
      revert: {
        operands: [data],
        options: {
          "-m": arg(data),
          ...flags("--no-edit", "--no-commit", "-n", "--continue", "--abort", "--skip"),
        },
      },
      "diff-tree": {
        operands: [path],
        options: { ...gitDiffOptions, ...flags("--no-commit-id", "-r", "-t", "--root") },
      },
      "cat-file": {
        readsContent: true,
        operands: [path],
        options: {
          ...flags("-p", "-t", "-s", "-e"),
          ...Object.fromEntries(
            ["--batch", "--batch-check", "--batch-command", "--batch-all-objects"].map((option) => [
              option,
              { roles: [], issue: unknown("git batch object input") },
            ]),
          ),
        },
      },
      archive: {
        readsContent: true,
        operands: [data, path],
        options: {
          "-o": arg("write"),
          "--output": arg("write"),
          "--format": arg(data),
          "--prefix": arg(data),
          ...flags("-v", "--verbose", "--list"),
        },
      },
      grep: {
        readsContent: true,
        operands: [data, path],
        options: {
          ...flags("-c", "-r", "-P", "-v", "-o", "--only-matching"),
          "-A": arg(data),
          "-B": arg(data),
          "-C": arg(data),
          ...flags(
            "--no-index",
            "--untracked",
            "--no-exclude-standard",
            "-n",
            "-i",
            "-l",
            "-I",
            "-w",
            "-E",
            "-F",
            "-q",
            "-h",
          ),
          "-e": arg(data),
          "-f": arg(path),
          "-O": { roles: [], issue: unknown("git pager execution") },
          "--open-files-in-pager": { roles: [], issue: unknown("git pager execution") },
          "--textconv": { roles: [], issue: unknown("git text converter") },
        },
      },
      commit: {
        operands: ["names"],
        options: {
          "-m": arg(data),
          "--message": arg(data),
          "--fixup": arg(data),
          "-F": arg(path),
          "--file": arg(path),
          ...flags(
            "--amend",
            "--no-edit",
            "--no-verify",
            "--allow-empty",
            "-a",
            "-q",
            "-v",
            "-s",
            "--signoff",
          ),
        },
      },
      add: {
        operands: ["names"],
        options: flags(
          "-A",
          "--all",
          "-u",
          "-f",
          "-v",
          "--update",
          "--force",
          "--intent-to-add",
          "-N",
        ),
      },
      rm: { operands: ["names"], options: flags("-r", "-f", "-q", "--cached", "--ignore-unmatch") },
      mv: { operands: ["names"] },
      credential: { operands: [data], effect: source("git credential") },
      config: {
        operands: [data],
        options: flags("--get", "--get-all", "--local", "--global", "--show-origin"),
        effect: source("git config can contain credentials"),
      },
    },
  },
  {
    name: "grep",
    aliases: ["egrep", "fgrep", "ggrep", "rg"],
    operands: [data, path],
    options: {
      "-e": arg(data),
      "--regexp": arg(data),
      "-f": arg(path),
      "--file": arg(path),
      "-g": arg(path),
      "--glob": arg(path),
      "--iglob": arg(path),
      "--include": arg(path),
      "--exclude": arg(data),
      "--exclude-dir": arg(data),
      "-A": arg(data),
      "-B": arg(data),
      "-C": arg(data),
      "-m": arg(data),
      "--max-count": arg(data),
      "-t": arg("rg-type"),
      "--type": arg("rg-type"),
      "--type-add": arg(data),
      "--type-not": arg(data),
      "-T": arg(data),
      ...flags(
        "--files",
        "--hidden",
        "--no-ignore",
        "--no-ignore-vcs",
        "-u",
        "-U",
        "-c",
        "--count",
        "--count-matches",
        "--files-with-matches",
        "--files-without-match",
        "--line-number",
        "--no-heading",
        "--no-filename",
        "--fixed-strings",
        "-N",
        "-L",
        "--heading",
        "--smart-case",
        "-S",
        "-I",
        "--text",
        "-a",
        "--multiline",
        "--multiline-dotall",
        "--pcre2",
        "-P",
        "--null",
        "-0",
        "--null-data",
        "-z",
      ),
      "--max-columns": arg(data),
      "--max-columns-preview": flag,
      "--color": arg(data),
      "--threads": arg(data),
      "-j": arg(data),
      "--max-depth": arg(data),
      "--sort": arg(data),
      "--sortr": arg(data),
      "--max-filesize": arg(data),
      "--context": arg(data),
      "--after-context": arg(data),
      "--before-context": arg(data),
      "--replace": arg(data),
      "--pre": { roles: [data], issue: unknown("rg preprocessor") },
      "--hostname-bin": { roles: [data], issue: unknown("rg hostname program") },
      ...flags(
        "-n",
        "-i",
        "-v",
        "-r",
        "-R",
        "-l",
        "-h",
        "-H",
        "-o",
        "-E",
        "-F",
        "-s",
        "-q",
        "-w",
        "-x",
      ),
    },
  },
  {
    name: "cd",
    builtinOnly: true,
    aliases: ["Set-Location", "Push-Location", "sl"],
    operands: ["names"],
    semantics: "cd",
    startup: ["CDPATH"],
    options: flags("-L", "-P", "-e"),
  },
  {
    name: "head",
    numericOption: true,
    readsContent: true,
    operands: [path],
    options: readerOptions,
    stdout: "opaque",
  },
  {
    name: "tail",
    numericOption: true,
    readsContent: true,
    operands: [path],
    options: { ...readerOptions, ...flags("-f", "-F") },
    stdout: "opaque",
  },
  {
    name: "echo",
    optionGrammar: "echo",
    optionsBeforeOperands: true,
    operands: [data],
    stdout: "arguments",
    options: flags("-n", "-e", "-E"),
  },
  {
    name: "printf",
    optionGrammar: "printf",
    optionsBeforeOperands: true,
    operands: [data],
    stdout: "opaque",
    options: { "-v": { roles: [data], issue: unknown("printf variable write") } },
  },
  {
    name: "bun",
    informationFlags: ["--help", "--version"],
    operands: ["script", path],
    options: {
      ...flags("--no-env-file", "--bun", "--silent", "--check", "--version", "-v", "--help", "-h"),
      "--filter": arg(data),
      "--cwd": arg("names"),
      "-e": arg(code("runtime")),
      "--eval": arg(code("runtime")),
      "-p": arg(code("runtime")),
      "--print": arg(code("runtime")),
      "-r": { roles: ["script"], issue: unknown("runtime preload") },
      "--preload": { roles: ["script"], issue: unknown("runtime preload") },
      "-c": { roles: ["script"], issue: unknown("runtime configuration") },
      "--config": { roles: ["script"], issue: unknown("runtime configuration") },
      "--install": arg(data),
    },
    semantics: "runtime",
    startup: ["BUN_OPTIONS", "NODE_OPTIONS"],
  },
  {
    name: "node",
    aliases: ["nodejs"],
    informationFlags: ["--help", "--version", "-v"],
    operands: ["script", path],
    options: {
      ...nodeOptions,
      ...flags("--check", "--test", "--experimental-strip-types"),
      "-c": { roles: ["script"], issue: unknown("runtime syntax check") },
    },
    semantics: "runtime",
    startup: ["NODE_OPTIONS", "NODE_PATH"],
  },
  {
    name: "python3",
    informationFlags: ["--help", "--version", "-V"],
    namePattern: /^python(?:[0-9]+(?:\.[0-9]+)*t?)?$/,
    aliases: ["python", "pypy", "pypy3"],
    operands: ["script", path],
    options: pythonOptions,
    semantics: "python",
    startup: ["PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP"],
  },
  {
    name: "perl",
    informationFlags: ["--help", "--version", "-v"],
    operands: ["script", path],
    semantics: "runtime",
    options: {
      ...flags("--help", "--version", "-v", "-w", "-n", "-p"),
      "-e": arg(code("runtime")),
      "-E": arg(code("runtime")),
      "-I": arg(path),
      "-M": { roles: [data], issue: unknown("Perl preload") },
    },
    startup: ["PERL5OPT", "PERL5LIB", "PERLLIB"],
  },
  {
    name: "ruby",
    informationFlags: ["--help", "--version", "-v"],
    operands: ["script", path],
    semantics: "runtime",
    options: {
      ...flags("--help", "--version", "-v", "-w", "-n", "-p"),
      "-e": arg(code("runtime")),
      "-I": arg(path),
      "-r": { roles: [path], issue: unknown("Ruby preload") },
    },
    startup: ["RUBYOPT", "RUBYLIB", "GEM_HOME", "GEM_PATH"],
  },
  {
    name: "php",
    operands: ["script", path],
    semantics: "runtime",
    options: {
      ...flags("--help", "--version", "-v", "-n"),
      "-r": arg(code("runtime")),
      "-B": arg(code("runtime")),
      "-R": arg(code("runtime")),
      "-E": arg(code("runtime")),
      "-F": arg(code("runtime")),
      "-f": arg("script"),
    },
  },
  {
    name: "lua",
    aliases: ["luajit", "lua5.4", "lua5.3"],
    informationFlags: ["--help", "--version", "-v"],
    operands: ["script", path],
    semantics: "runtime",
    options: {
      ...flags("--help", "--version", "-v"),
      "-e": arg(code("runtime")),
      "-l": { roles: [data], issue: unknown("Lua preload") },
    },
  },
  {
    name: "osascript",
    operands: ["script", path],
    semantics: "runtime",
    options: { "-e": arg(code("runtime")), "-l": arg(data), "-s": arg(data) },
  },
  {
    name: "deno",
    operands: ["script", path],
    semantics: "runtime",
    options: flags("--help", "--version"),
    subcommands: {
      repl: { operands: [data], effect: unknown("runtime REPL code") },
      eval: { operands: [code("runtime"), data] },
      run: { operands: ["script", path] },
    },
  },
  {
    name: "sqlite3",
    operands: [path, data],
    readsStdinCode: true,
    options: flags(
      "-readonly",
      "-readwrite",
      "-batch",
      "-header",
      "-noheader",
      "-column",
      "-csv",
      "-json",
    ),
  },
  ...["expect", "wish", "swift", "ocaml", "erl", "clj"].map((name): ExecutableEntry => ({
    name,
    operands: ["script", path],
    semantics: "runtime",
  })),
  {
    name: "java",
    options: {
      ...flags("--version", "-version", "--help", "-help"),
      "-jar": arg("script"),
      "-cp": arg(path),
      "-classpath": arg(path),
    },
    operands: [path],
    startup: ["JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "CLASSPATH", "_JAVA_OPTIONS", "JAVA_HOME"],
  },
  {
    name: "herdr",
    options: {
      "--session": arg(data),
      "--machine": arg(data),
      "--remote": arg(data),
      "--remote-keybindings": arg(data),
      ...flags("--handoff"),
      "--format": arg(data),
      "--env": arg(data),
      ...flags("--focus"),
      "--label": arg(data),
      "--until": arg(data),
      "--kind": arg(data),
      "--pane": arg(data),
      "--source": arg(data),
      "--lines": arg(data),
      "--match": arg(data),
      "--regex": arg(data),
      "--timeout": arg(data),
      "--file": arg("content"),
      "--cwd": arg("names"),
      "--command": arg(code("bash")),
      "--name": arg(data),
      "--direction": arg(data),
      "--workspace": arg(data),
      "--tab": arg(data),
      ...flags("--help", "--all", "--json", "--no-focus", "--wait", "--current"),
    },
    informationFlags: ["--help"],
    operands: [data],
    semantics: "herdr",
    subcommands: {
      agent: { operands: [data] },
      workspace: { operands: [data] },
      tab: { operands: [data] },
      notification: { operands: [data] },
      session: { operands: [data] },
      pane: {
        operands: [data],
        subcommands: {
          layout: { operands: [data] },
          close: { operands: [data] },
          list: { operands: [data] },
          get: { operands: [data] },
          read: { operands: [data] },
          current: { operands: [data] },
          split: { operands: [data] },
          run: { operands: [data] },
          "send-keys": { operands: [data] },
          "send-text": { operands: [data] },
        },
      },
    },
  },
  {
    name: "cat",
    options: flags("-n", "-b", "-s", "-v", "-e", "-t", "-u", "-A", "-E", "-T"),
    readsContent: true,
    operands: [path],
    stdout: "stdin",
  },
  {
    name: "shasum",
    readsContent: true,
    aliases: ["sha1sum", "sha224sum", "sha256sum", "sha384sum", "sha512sum", "md5sum", "b2sum"],
    operands: [path],
    options: {
      ...flags("-b", "-t", "--binary", "--text", "--tag"),
      "-a": arg(data),
      "--algorithm": arg(data),
      "-c": { roles: [], issue: unknown("checksum indirect file list") },
      "--check": { roles: [], issue: unknown("checksum indirect file list") },
    },
  },
  {
    name: "tee",
    operands: ["write"],
    options: flags("-a", "--append", "-i", "--ignore-interrupts", "-p"),
  },
  {
    name: "base64",
    readsContent: true,
    operands: [path],
    options: {
      ...flags("-d", "-D", "--decode", "-i", "--ignore-garbage"),
      "-w": arg(data),
      "-b": arg(data),
      "--wrap": arg(data),
      "--input": arg("content"),
      "-o": arg("write"),
      "--output": arg("write"),
    },
  },
  {
    name: "diff",
    readsContent: true,
    operands: [path],
    options: {
      ...flags("-u", "-c", "-r", "-q", "-s", "-w", "-b", "-B", "-i", "-N", "--no-index"),
      "-U": arg(data),
      "-C": arg(data),
      "-I": arg(data),
      "--exclude": arg(data),
    },
  },
  {
    name: "cmp",
    readsContent: true,
    operands: [path],
    options: { ...flags("-s", "-l"), "-n": arg(data), "-i": arg(data) },
  },
  { name: "dd", operands: [data] },
  {
    name: "gzip",
    aliases: ["gunzip", "zcat"],
    readsContent: true,
    operands: [path],
    options: flags(
      "-c",
      "--stdout",
      "-d",
      "--decompress",
      "-f",
      "-k",
      "-n",
      "-q",
      "-r",
      "-t",
      "-v",
      "-1",
      "-9",
    ),
  },
  {
    name: "openssl",
    operands: [data],
    options: {
      "-in": arg("content"),
      "-out": arg("write"),
      ...flags("-a", "-A", "-d", "-e", "-base64"),
    },
  },
  {
    name: "iconv",
    readsContent: true,
    operands: [path],
    options: {
      "-f": arg(data),
      "-t": arg(data),
      "--from-code": arg(data),
      "--to-code": arg(data),
      "-o": arg("write"),
      ...flags("-c", "-s", "-l"),
    },
  },
  {
    name: "expand",
    readsContent: true,
    operands: [path],
    options: { "-t": arg(data), "--tabs": arg(data), ...flags("-i", "--initial") },
  },
  {
    name: "pr",
    readsContent: true,
    operands: [path],
    options: {
      "-h": arg(data),
      "-l": arg(data),
      "-w": arg(data),
      "-o": arg(data),
      "-s": arg(data),
      ...flags("-t", "-T", "-d", "-m", "-n"),
    },
  },
  {
    name: "fmt",
    readsContent: true,
    operands: [path],
    options: { "-w": arg(data), "--width": arg(data), ...flags("-s", "-u") },
  },
  {
    name: "column",
    readsContent: true,
    operands: [path],
    options: {
      "-s": arg(data),
      "-o": arg(data),
      "-c": arg(data),
      ...flags("-t", "-x", "-e", "-n"),
    },
  },
  { name: "uuencode", readsContent: true, operands: [path, data], options: flags("-m") },
  {
    name: "yq",
    readsContent: true,
    operands: [code("jq"), path],
    options: {
      ...flags("-r", "-c", "-y", "-Y", "-n", "-e"),
      "-f": { roles: [path], issue: unknown("yq program file") },
    },
  },
  {
    name: "plutil",
    readsContent: true,
    operands: [path],
    options: { ...flags("-p", "-lint", "-s"), "-convert": arg(data), "-o": arg("write") },
  },
  {
    name: "textutil",
    readsContent: true,
    operands: [path],
    options: {
      "-cat": arg(data),
      "-convert": arg(data),
      "-output": arg("write"),
      ...flags("-stdout", "-info"),
    },
  },
  {
    name: "install",
    readsContent: true,
    operands: [path],
    options: {
      "-m": arg(data),
      "-o": arg(data),
      "-g": arg(data),
      "-t": arg("write"),
      "--target-directory": arg("write"),
      ...flags("-T", "--no-target-directory"),
      ...flags("-d", "-v", "-C", "-p", "-s", "-c", "-D", "-b", "-U"),
      "-S": { roles: [], attachedValue: /^.+$/ },
    },
  },
  {
    name: "sed",
    readsContent: true,
    aliases: ["gsed"],
    operands: [code("sed"), path],
    semantics: "sed",
    options: {
      "-e": arg(code("sed")),
      "--expression": arg(code("sed")),
      "-f": { roles: [path], issue: unknown("sed program file") },
      "--file": { roles: [path], issue: unknown("sed program file") },
      ...flags("-n", "-E", "-r"),
      ...flags("-i", "--in-place"),
    },
  },
  {
    name: "awk",
    readsContent: true,
    aliases: ["gawk", "mawk"],
    operands: [code("awk"), path],
    semantics: "awk",
    startup: ["AWKPATH", "AWKLIBPATH"],
    options: {
      "-F": arg(data),
      "-v": arg(data),
      "-f": { roles: [path], issue: unknown("awk program file") },
      "--file": { roles: [path], issue: unknown("awk program file") },
      "-e": { roles: [code("awk")], issue: unknown("additional awk program") },
      "--source": { roles: [code("awk")], issue: unknown("additional awk program") },
      "-l": { roles: ["script"], issue: unknown("awk extension") },
      "--load": { roles: ["script"], issue: unknown("awk extension") },
    },
  },
  {
    name: "jq",
    rejectsAbbreviations: true,
    readsContent: true,
    startupFiles: [/(?:^|\/)\.jq$/],
    operands: [code("jq"), path],
    semantics: "jq",
    startup: ["JQ_LIBRARY_PATH"],
    options: {
      ...flags(
        "-n",
        "-r",
        "-c",
        "-s",
        "-e",
        "-R",
        "-S",
        "-M",
        "-C",
        "--null-input",
        "--raw-output",
        "--compact-output",
        "--slurp",
        "--exit-status",
      ),
      "--arg": arg(data, data),
      "--argjson": arg(data, data),
      "--rawfile": arg(data, path),
      "--slurpfile": arg(data, path),
      "-f": { roles: [path], issue: unknown("jq program file") },
      "--from-file": { roles: [path], issue: unknown("jq program file") },
      "-L": { roles: [path], issue: unknown("jq library override") },
    },
  },
  {
    name: "cut",
    readsContent: true,
    operands: [path],
    stdout: "opaque",
    options: { "-d": arg(data), "-f": arg(data), "-c": arg(data), "-b": arg(data), ...flags("-s") },
  },
  {
    name: "less",
    aliases: ["more", "most"],
    readsContent: true,
    operands: [path],
    options: flags("-R", "-S", "-F", "-X", "-N", "-n", "-r", "-s", "-f"),
  },
  {
    name: "bat",
    readsContent: true,
    operands: [path],
    startup: ["BAT_PAGER"],
    options: {
      ...flags("-n", "-p", "--plain", "--number"),
      "--paging": arg(data),
      "--style": arg(data),
      "--language": arg(data),
      "--pager": arg(code("runtime")),
    },
  },
  {
    name: "view",
    aliases: ["vim", "vi"],
    readsContent: true,
    operands: [path],
    options: {
      "-c": arg(code("runtime")),
      "--cmd": arg(code("runtime")),
      "-S": arg(code("runtime")),
      "-u": arg("script"),
      "-U": arg("script"),
      ...flags("-e", "-s", "-R", "-n", "-N", "-M", "-m", "-b", "-f", "-d"),
    },
  },
  {
    name: "nl",
    readsContent: true,
    operands: [path],
    options: {
      "-b": arg(data),
      "-n": arg(data),
      "-w": arg(data),
      "-s": arg(data),
      "-v": arg(data),
      "-i": arg(data),
    },
  },
  {
    name: "tac",
    readsContent: true,
    operands: [path],
    options: { ...flags("-b", "-r"), "-s": arg(data) },
  },
  { name: "rev", readsContent: true, operands: [path] },
  {
    name: "fold",
    readsContent: true,
    operands: [path],
    options: { ...flags("-b", "-s"), "-w": arg(data) },
  },
  {
    name: "paste",
    readsContent: true,
    operands: [path],
    options: { ...flags("-s"), "-d": arg(data) },
  },
  {
    name: "md5",
    readsContent: true,
    operands: [path],
    options: { ...flags("-q", "-r"), "-s": arg(data) },
  },
  {
    name: "xxd",
    readsContent: true,
    operands: [path],
    options: {
      ...flags("-p", "-r", "-i", "-b", "-a", "-u"),
      "-l": arg(data),
      "-s": arg(data),
      "-c": arg(data),
      "-g": arg(data),
    },
  },
  {
    name: "hexdump",
    readsContent: true,
    operands: [path],
    options: {
      ...flags("-C", "-b", "-c", "-d", "-o", "-x", "-v"),
      "-n": arg(data),
      "-s": arg(data),
      "-e": arg(data),
      "-f": arg("content"),
    },
  },
  {
    name: "od",
    readsContent: true,
    operands: [path],
    options: {
      ...flags("-c", "-x", "-b", "-v"),
      "-A": arg(data),
      "-t": arg(data),
      "-N": arg(data),
      "-j": arg(data),
    },
  },
  {
    name: "strings",
    readsContent: true,
    operands: [path],
    options: { ...flags("-a", "-f", "-o"), "-n": arg(data), "-t": arg(data), "-e": arg(data) },
  },
  {
    name: "nano",
    readsContent: true,
    operands: [path],
    options: flags("-v", "-w", "-l", "-m", "-i", "-B"),
  },
  {
    name: "emacs",
    readsContent: true,
    operands: [path],
    options: {
      "--eval": arg(code("runtime")),
      "-l": arg(code("runtime")),
      "--load": arg(code("runtime")),
      "--batch": { roles: [], issue: unknown("editor batch code") },
      ...flags("-nw", "-Q", "-q"),
    },
  },
  {
    name: "man",
    operands: [data],
    startup: ["MANPAGER"],
    options: {
      "-P": arg(code("runtime")),
      "--pager": arg(code("runtime")),
      "-H": arg(code("runtime")),
      "-l": arg("content"),
      "--local-file": arg("content"),
      "-M": arg("names"),
      "-S": arg(data),
      ...flags("-a", "-k", "-f", "-w", "--help", "--version"),
    },
  },
  {
    name: "info",
    operands: [data],
    options: {
      "-f": arg("content"),
      "--file": arg("content"),
      "-n": arg(data),
      "--node": arg(data),
      "-d": arg("names"),
      ...flags("--help", "--version", "-w"),
    },
  },
  {
    name: "tldr",
    operands: [data],
    options: {
      "--render": arg("content"),
      "-p": arg(data),
      "--platform": arg(data),
      ...flags("--help", "--version", "-l", "--list", "-u", "--update"),
    },
  },
  {
    name: "whatis",
    aliases: ["apropos"],
    operands: [data],
    options: {
      "-P": arg(code("runtime")),
      "--pager": arg(code("runtime")),
      ...flags("-a", "-e", "-r", "-w", "--help", "--version"),
    },
  },
  {
    name: "which",
    aliases: ["whereis"],
    operands: [data],
    options: flags("-a", "-s", "-b", "-m", "-u"),
  },
  {
    name: "type",
    builtinOnly: true,
    operands: [data],
    options: flags("-a", "-t", "-p", "-P", "-f"),
  },
  {
    name: "brew",
    operands: [data],
    options: {
      ...flags(
        "--formula",
        "--cask",
        "--installed",
        "--analytics",
        "--desc",
        "--versions",
        "-1",
        "-l",
        "--version",
        "--help",
      ),
      "--json": arg(data),
      "-e": arg(code("runtime")),
      "--eval": arg(code("runtime")),
      "-c": arg(code("runtime")),
      "--command": arg(code("runtime")),
    },
    subcommands: {
      ...Object.fromEntries(
        [
          "sh",
          "ruby",
          "irb",
          "exec",
          "command",
          "test",
          "livecheck",
          "style",
          "typecheck",
          "tests",
          "debugger",
        ].map((name) => [name, { operands: [data], effect: unknown("brew code execution") }]),
      ),
      bundle: {
        operands: [data],
        subcommands: { exec: { operands: [data], effect: unknown("brew bundle execution") } },
      },
    },
  },
  {
    name: "pip",
    options: flags("--version", "--help", "-q", "-v"),
    operands: [path],
    subcommands: { show: { operands: [data] } },
  },
  {
    name: "cargo",
    options: {
      "--bin": arg(data),
      "--example": arg(data),
      "--limit": arg(data),
      ...flags("--bins"),
      ...flags(
        "--version",
        "--help",
        "-q",
        "--quiet",
        "--release",
        "--all-targets",
        "--workspace",
        "--locked",
        "--offline",
        "--all-features",
        "--lib",
        "--all",
        "--no-default-features",
        "--no-deps",
      ),
      "-p": arg(data),
      "--package": arg(data),
      "--target": arg(data),
      "--features": arg(data),
      "--test": arg(data),
      "--manifest-path": arg("content"),
    },
    operands: [path],
    subcommands: { search: { operands: [data] }, test: { operands: [data] } },
  },
  {
    name: "make",
    startupFiles: [/(?:^|\/)(?:GNUmakefile|makefile|Makefile)$/i],
    operands: [data],
    options: {
      "-f": arg("script"),
      "--file": arg("script"),
      "--makefile": arg("script"),
      "-C": arg("names"),
      "--directory": arg("names"),
      "--eval": arg(code("runtime")),
      "-p": { roles: [], issue: source("make variable listing") },
      "--print-data-base": { roles: [], issue: source("make variable listing") },
      ...flags("-n", "--dry-run", "-s", "--silent", "-k", "-B", "-r", "-R", "--help", "--version"),
      "-j": arg(data),
      "--jobs": arg(data),
    },
  },
  {
    name: "just",
    startupFiles: [/(?:^|\/)(?:\.?justfile)$/i],
    operands: [data],
    options: {
      ...flags("--verbose", "-v", "--quiet", "-q"),
      "-f": arg("script"),
      "--justfile": arg("script"),
      "--command": arg(code("runtime")),
      "-c": arg(code("runtime")),
      "-d": arg("names"),
      "--working-directory": arg("names"),
      ...flags("--list", "-l", "--summary", "--dry-run", "-n", "--help", "--version"),
    },
  },
  {
    name: "task",
    startupFiles: [/(?:^|\/)Taskfile(?:\.dist)?\.ya?ml$/i],
    operands: [data],
    options: {
      "-t": arg("script"),
      "--taskfile": arg("script"),
      "-d": arg("names"),
      "--dir": arg("names"),
      ...flags("--list", "-l", "--list-all", "--dry", "-n", "--help", "--version"),
    },
  },
  {
    name: "ConvertFrom-Json",
    builtinOnly: true,
    aliases: [
      "ConvertTo-Json",
      "Select-Object",
      "Where-Object",
      "Sort-Object",
      "Measure-Object",
      "Group-Object",
      "Format-Table",
      "Format-List",
      "Out-String",
      "Out-Null",
    ],
    operands: [data],
    pipelineData: true,
    options: {
      ...flags(
        "-Line",
        "-Word",
        "-Character",
        "-Unique",
        "-Descending",
        "-Compress",
        "-AsHashtable",
      ),
      "-First": arg(data),
      "-Last": arg(data),
      "-Skip": arg(data),
      "-Property": arg(data),
      "-ExpandProperty": arg(data),
      "-Like": arg(data),
      "-NotLike": arg(data),
      "-Match": arg(data),
      "-EQ": arg(data),
      "-Depth": arg(data),
      "-Width": arg(data),
    },
  },
  {
    name: "ForEach-Object",
    builtinOnly: true,
    aliases: ["%", "foreach"],
    pipelineData: true,
    operands: ["member"],
    options: {
      "-MemberName": arg("member"),
      "-ArgumentList": { roles: [data], issue: unknown("PowerShell method arguments") },
    },
  },
  ...[
    "irb",
    "pry",
    "jshell",
    "julia",
    "ghci",
    "racket",
    "guile",
    "scheme",
    "clojure",
    "scala",
    "R",
    "Rscript",
    "ipython",
    "ipython3",
    "bpython",
  ].map((name): ExecutableEntry => ({
    name,
    operands: ["script", path],
    semantics: "runtime",
    options: {
      ...flags("--help", "--version"),
      "-e": arg(code("runtime")),
      "--eval": arg(code("runtime")),
    },
  })),
  {
    name: "pkill",
    aliases: ["pgrep"],
    operands: [data],
    options: {
      ...flags("-f", "-l", "-a", "-x", "-n", "-o", "-v", "-i", "-9", "-TERM", "-KILL"),
      "-u": arg(data),
      "-U": arg(data),
      "-P": arg(data),
      "-g": arg(data),
      "-s": arg(data),
    },
  },
  {
    name: "killall",
    aliases: ["kill"],
    operands: [data],
    options: {
      ...flags("-9", "-15", "-TERM", "-KILL", "-HUP", "-INT", "-0", "-q", "-v", "-l", "-w"),
      "-s": arg(data),
      "-u": arg(data),
    },
  },
  {
    name: "lsof",
    operands: [data],
    options: {
      "-F": arg(data),
      "-s": arg(data),
      ...flags("-n", "-P", "-t", "-a", "-l"),
      "-i": { roles: [], attachedValue: /^[A-Za-z0-9:]+$/ },
      "-c": arg(data),
      "-p": arg(data),
      "-u": arg(data),
      "-d": arg(data),
    },
  },
  ...["nvm", "fnm", "volta", "asdf", "pyenv"].map((name): ExecutableEntry => ({
    name,
    operands: [data],
    effect: unknown("unsupported version manager command"),
    options: flags("--help", "--version"),
    subcommands: Object.fromEntries(
      ["list", "ls", "current", "alias", "use", "versions", "global", "local"].map((command) => [
        command,
        { operands: [data], effect: "none" },
      ]),
    ),
  })),
  {
    name: "tree",
    options: { ...flags("-a", "-d", "-f", "-i", "-I", "--dirsfirst"), "-L": arg(data) },
    operands: ["names"],
    semantics: "listing",
  },
  { name: "basename", aliases: ["dirname"], operands: [data] },
  {
    name: "tmutil",
    operands: [path],
    subcommands: {
      ...Object.fromEntries(
        [
          "setdestination",
          "destinationinfo",
          "setquota",
          "removedestination",
          "enable",
          "disable",
          "startbackup",
          "stopbackup",
          "verifychecksums",
          "restore",
          "delete",
          "deleteinprogress",
          "latestbackup",
          "listbackups",
          "machinedirectory",
          "inheritbackup",
          "associatedisk",
          "localsnapshot",
          "listlocalsnapshots",
          "listlocalsnapshotdates",
          "deletelocalsnapshots",
          "thinlocalsnapshots",
          "help",
          "version",
          "status",
          "currentphase",
        ].map((name) => [
          name,
          {
            operands: [path],
            effect: "none",
          } satisfies Omit<ExecutableEntry, "name">,
        ]),
      ),
      isexcluded: { operands: [path], options: flags("-X"), effect: "none" },
      addexclusion: { operands: [path], options: flags("-p", "-v"), effect: "none" },
      removeexclusion: { operands: [path], options: flags("-p", "-v"), effect: "none" },
      compare: {
        operands: [path],
        options: {
          ...flags(
            "-@",
            "-a",
            "-c",
            "-d",
            "-e",
            "-f",
            "-g",
            "-h",
            "-l",
            "-m",
            "-n",
            "-s",
            "-t",
            "-u",
            "-E",
            "-U",
            "-X",
          ),
          "-D": arg(data),
          "-I": arg(data),
        },
        effect: "none",
      },
      uniquesize: { operands: [path], effect: "none" },
      calculatedrift: { operands: [path], effect: "none" },
    },
  },
  {
    name: "mdfind",
    operands: [data],
    options: {
      "-onlyin": arg(path),
      "-name": arg(data),
      "-attr": arg(data),
      ...flags("-count", "-0", "-live", "-literal", "-interpret"),
    },
  },
  {
    name: "ls",
    options: {
      "--time-style": arg(data),
      ...flags(
        "-l",
        "-O",
        "-T",
        "-a",
        "-A",
        "-h",
        "-t",
        "-r",
        "-S",
        "-d",
        "-R",
        "-F",
        "-1",
        "-n",
        "-i",
        "-s",
        "--color",
        "--all",
        "--directory",
        "--recursive",
      ),
    },
    operands: ["names"],
    semantics: "listing",
  },
  {
    name: "fd",
    operands: ["names"],
    semantics: "listing",
    options: {
      ...flags(
        "-H",
        "--hidden",
        "-I",
        "--no-ignore",
        "-u",
        "--unrestricted",
        "-s",
        "--case-sensitive",
        "-i",
        "--ignore-case",
        "-g",
        "--glob",
        "-F",
        "--fixed-strings",
        "-a",
        "--absolute-path",
        "-L",
        "--follow",
        "-l",
        "--list-details",
        "-0",
        "--print0",
        "-q",
        "--quiet",
        "--show-errors",
        "--one-file-system",
        "--no-ignore-vcs",
        "--no-ignore-parent",
        "--help",
        "--version",
      ),
      "-t": arg(data),
      "--type": arg(data),
      "-e": arg(data),
      "--extension": arg(data),
      "-E": arg(data),
      "--exclude": arg(data),
      "-d": arg(data),
      "--max-depth": arg(data),
      "--min-depth": arg(data),
      "--exact-depth": arg(data),
      "-j": arg(data),
      "--threads": arg(data),
      "--base-directory": arg("names"),
      "--search-path": arg("names"),
      "-p": flag,
      "--full-path": flag,
      "-S": arg(data),
      "--size": arg(data),
      "--changed-within": arg(data),
      "--changed-before": arg(data),
      "-c": arg(data),
      "--color": arg(data),
      "--path-separator": arg(data),
    },
  },
  {
    name: "wc",
    optionsBeforeOperands: false,
    readsContent: true,
    operands: [path],
    options: {
      ...flags("-l", "-w", "-c", "-m", "-L"),
      "--files0-from": { roles: [path], issue: unknown("indirect file list") },
    },
  },
  {
    name: "sort",
    readsContent: true,
    operands: [path],
    stdout: "opaque",
    options: {
      "-T": arg("names"),
      "--temporary-directory": arg("names"),
      "-o": arg("write"),
      "--output": arg("write"),
      "-k": arg(data),
      "-t": arg(data),
      ...flags("-n", "-r", "-u", "-f", "-h", "-V", "-b", "-s", "-g", "-M", "--unique"),
      "--compress-program": { roles: [data], issue: unknown("sort compression program") },
      "--files0-from": { roles: [path], issue: unknown("indirect file list") },
      "--random-source": arg(path),
    },
  },
  {
    name: "sh",
    namePattern: /^bash[0-9]+(?:\.[0-9]+)*$/,
    startupFiles: [/(?:^|\/)\.(?:bashrc|bash_profile|profile|zshrc)$/],
    aliases: ["bash", "dash"],
    operands: ["script", path],
    options: shellOptions,
    semantics: "shell",
    startup: ["BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "PROMPT_COMMAND", "IFS", "BASH_XTRACEFD"],
  },
  {
    name: "zsh",
    aliases: ["rbash", "rksh", "ksh", "ksh93", "zsh5"],
    operands: [data],
    effect: unknown("unsupported shell dialect"),
  },
  {
    name: "csh",
    aliases: [
      "tcsh",
      "fish",
      "tclsh",
      "ksh88",
      "mksh",
      "pdksh",
      "oksh",
      "elvish",
      "nu",
      "nushell",
      "xonsh",
      "ash",
      "yash",
      "oil",
      "osh",
    ],
    informationFlags: ["--help", "--version"],
    operands: ["script", path],
    options: { "-c": arg(code("runtime")), ...flags("--help", "--version") },
    semantics: "runtime",
  },
  {
    name: "turbo",
    operands: [data],
    options: {
      "--filter": arg(data),
      "--cwd": arg("names"),
      ...flags("--help", "--version", "--dry-run", "--no-cache", "--force"),
    },
  },
  {
    name: "direnv",
    operands: [data],
    effect: unknown("direnv state change"),
    subcommands: { exec: { operands: ["names", data] } },
  },
  { name: "parallel", operands: [data], effect: unknown("parallel executes operands and stdin") },
  {
    name: "New-PSDrive",
    builtinOnly: true,
    aliases: ["ndr"],
    operands: [data],
    effect: unknown("PowerShell drive aliases"),
  },
  {
    name: "dotnet",
    options: {
      "--report": arg(data),
      "--output-dir": arg("write"),
      ...flags("--locked-mode", "--force", "-nologo"),
      "-v": arg(data),
      "-f": arg(data),
      "--context": arg(data),
      "--startup-project": arg(path),
      "--file": arg("content"),
      ...flags("--nologo", "--no-launch-profile"),
      ...flags(
        "--no-build",
        "--no-restore",
        "--help",
        "--version",
        "--list-sdks",
        "--list-runtimes",
      ),
      "--project": arg(path),
      "--configuration": arg(data),
      "-c": arg(data),
      "--filter": arg(data),
      "--framework": arg(data),
      "--verbosity": arg(data),
      "--include": arg(path),
      "--severity": arg(data),
    },
    informationFlags: ["--help", "--version"],
    operands: [path],
    subcommands: {
      fsi: { operands: [data], effect: unknown("FSharp code has no analyzer") },
      restore: { operands: [path], options: flags("--force-evaluate") },
      csharpier: {
        operands: ["content"],
        options: flags("--write-stdout"),
        subcommands: { format: { operands: ["content"], options: flags("--write-stdout") } },
      },
    },
  },
  { name: "busybox", operands: [data], effect: unknown("applet execution has no analyzer") },
  { name: "eval", builtinOnly: true, operands: [code("bash")], semantics: "eval" },
  {
    name: "alias",
    builtinOnly: true,
    aliases: [
      "unalias",
      "unset",
      "pushd",
      "popd",
      "shopt",
      "enable",
      "trap",
      "read",
      "mapfile",
      "readarray",
    ],
    operands: [data],
    effect: unknown("shell state mutation has no analyzer"),
  },
  {
    name: "source",
    builtinOnly: true,
    aliases: ["."],
    operands: [path],
    effect: unknown("source file contents are not visible"),
  },
  {
    name: "env",
    operands: [data],
    semantics: "env",
    bare: source("environment listing"),
    options: {
      ...flags("-i", "--ignore-environment", "-0"),
      "-u": arg(data),
      "--unset": arg(data),
      "-C": arg("names"),
      "--chdir": arg("names"),
      "-S": arg(code("bash")),
      "--split-string": arg(code("bash")),
    },
  },
  {
    name: "rtk",
    operands: [data],
    semantics: "ordinary",
  },
  {
    name: "command",
    builtinOnly: true,
    aliases: ["builtin", "exec"],
    operands: [data],
    semantics: "forward",
    options: {
      ...flags("-p", "-c", "-l"),
      "-a": arg(data),
      "-n": arg(data),
      "-v": flag,
      "-V": flag,
    },
  },
  {
    name: "nohup",
    aliases: ["time", "nice"],
    operands: [data],
    semantics: "forward",
    options: {
      ...flags("-p", "-c", "-l"),
      "-a": arg(data),
      "-n": arg(data),
      "-v": flag,
      "-V": flag,
    },
  },
  {
    name: "sudo",
    aliases: ["doas"],
    operands: [data],
    semantics: "forward",
    options: {
      ...flags("-n", "-E", "-H", "-S"),
      "-u": arg(data),
      "-g": arg(data),
      "-h": arg(data),
    },
  },
  {
    name: "watch",
    operands: [data],
    semantics: "joined-shell",
    options: { "-n": arg(data), ...flags("-d", "-t") },
  },
  {
    name: "ssh",
    operands: [data],
    semantics: "remote-shell",
    options: {
      ...flags("-T"),
      "-i": arg(path),
      "-F": arg(path),
      "-p": arg(data),
      "-l": arg(data),
      "-o": { roles: [data], issue: unknown("SSH execution configuration") },
    },
  },
  {
    name: "timeout",
    operands: [data],
    semantics: "timeout",
    options: {
      "-s": arg(data),
      "-k": arg(data),
      "--signal": arg(data),
      "--kill-after": arg(data),
      ...flags("--foreground", "--preserve-status", "-v"),
    },
  },
  {
    name: "xargs",
    operands: [data],
    semantics: "xargs",
    options: {
      "-I": arg(data),
      "-n": arg(data),
      "-P": arg(data),
      "-L": arg(data),
      ...flags("-r", "-t", "-o", "--open-tty", "--no-run-if-empty"),
    },
  },
  {
    name: "stdbuf",
    operands: [data],
    semantics: "forward",
    options: {
      "-i": arg(data),
      "-o": arg(data),
      "-e": arg(data),
      "--input": arg(data),
      "--output": arg(data),
      "--error": arg(data),
    },
  },
  {
    name: "setsid",
    operands: [data],
    semantics: "forward",
    options: flags("-f", "-w", "-c", "--fork", "--wait", "--ctty"),
  },
  {
    name: "caffeinate",
    operands: [data],
    semantics: "forward",
    options: { ...flags("-d", "-i", "-m", "-s", "-u"), "-t": arg(data), "-w": arg(data) },
  },
  {
    name: "chronic",
    aliases: ["unbuffer"],
    operands: [data],
    semantics: "forward",
    options: flags("-v", "-e"),
  },
  {
    name: "ionice",
    operands: [data],
    semantics: "forward",
    options: { "-c": arg(data), "-n": arg(data), "-p": arg(data), ...flags("-t") },
  },
  {
    name: "flock",
    operands: ["names"],
    semantics: "timeout",
    options: {
      ...flags("-s", "-x", "-u", "-n", "-o", "-F"),
      "-w": arg(data),
      "-E": arg(data),
      "-c": arg(code("bash")),
      "--command": arg(code("bash")),
    },
  },
  {
    name: "script",
    operands: ["names"],
    semantics: "timeout",
    options: {
      ...flags("-q", "-a", "-e", "-f"),
      "-c": arg(code("bash")),
      "--command": arg(code("bash")),
    },
  },
  {
    name: "uv",
    aliases: ["poetry"],
    operands: [data],
    options: {
      "--directory": arg("names"),
      "--project": arg("names"),
      "--config-file": arg("script"),
      "--with": arg(data),
      "--with-editable": arg("script"),
      "--python": arg(data),
      ...flags("--no-project"),
    },
    subcommands: { run: { operands: [data] } },
  },
  {
    name: "conda",
    aliases: ["mamba", "micromamba"],
    operands: [data],
    subcommands: {
      run: {
        operands: [data],
        options: {
          "-n": arg(data),
          "--name": arg(data),
          "-p": arg("names"),
          "--prefix": arg("names"),
          ...flags("--no-capture-output", "--live-stream"),
        },
      },
    },
  },
  { name: "find", operands: ["names"], semantics: "find" },
  {
    name: "bunx",
    operands: [data],
    semantics: "forward",
    options: {
      ...flags("--bun", "--no-install", "--verbose", "--silent", "--help"),
      "-p": arg(data),
      "--package": arg(data),
    },
  },
  {
    name: "rustup",
    operands: [data],
    effect: unknown("unsupported toolchain command"),
    options: flags("--help", "--version", "-h", "-V"),
    subcommands: {
      run: { operands: [data] },
      show: { operands: [data], effect: "none" },
      which: { operands: [data], effect: "none", options: { "--toolchain": arg("names") } },
      toolchain: {
        operands: [data],
        subcommands: {
          list: {
            operands: [data],
            effect: "none",
            options: flags("-v", "--verbose", "-q", "--quiet"),
          },
        },
      },
    },
  },
  {
    name: "gh-tool",
    aliases: ["agent-tools-gh"],
    operands: [path],
    options: {
      "--pr": arg(data),
      "--prs": arg(data),
      "--repo": arg(data),
      "--format": arg(data),
      "--strategy": arg(data),
      "--match-head-commit": arg(data),
      "--author": arg(data),
      "--body-contains": arg(data),
      "--title": arg(data),
      "--body": arg(data),
      "--head": arg(data),
      "--base": arg(data),
      "--comment": arg(data),
      "--comment-id": arg(data),
      "--body-file": arg("content"),
      "--comment-file": arg("content"),
      "--notes-file": arg("content"),
      "-F": arg("content"),
      "--run": arg(data),
      "--job": arg(data),
      "--limit": arg(data),
      "--state": arg(data),
      "--timeout": arg(data),
      "--interval": arg(data),
      "--branch": arg(data),
      ...flags(
        "--help",
        "--version",
        "--confirm",
        "--delete-branch",
        "--watch",
        "--body-stdin",
        "--failed-steps-only",
      ),
    },
  },
  { name: "jest", operands: [path] },
  { name: "vitest", operands: [path] },
  { name: "pytest", operands: [path] },
  {
    name: "playwright",
    informationFlags: ["--help", "--version", "-h", "-V"],
    operands: [data],
    effect: unknown("unsupported test runner command"),
    options: flags("--help", "--version", "-h", "-V"),
    startupFiles: [/(?:^|\/)playwright\.config\.[cm]?[jt]s$/],
    subcommands: {
      install: { operands: [data], effect: "none", options: flags("--with-deps") },
      "show-report": { operands: [data], effect: "none" },
      "show-trace": { operands: [path], effect: "none" },
      "install-deps": { operands: [data], effect: "none" },
      codegen: { operands: [data], effect: "none" },
      test: {
        operands: ["script"],
        effect: "none",
        options: {
          "-c": arg("script"),
          "--config": arg("script"),
          "--reporter": arg(code("runtime")),
          "-j": arg(data),
          "--workers": arg(data),
          "--project": arg(data),
          "-g": arg(data),
          "--grep": arg(data),
          "--timeout": arg(data),
          "--output": arg("write"),
          ...flags(
            "--headed",
            "--list",
            "--quiet",
            "--forbid-only",
            "--fully-parallel",
            "--pass-with-no-tests",
          ),
        },
      },
    },
  },
  {
    name: "acli",
    operands: [data],
    effect: unknown("unsupported application CLI command"),
    options: flags("--help", "-h", "--version"),
    subcommands: {
      jira: {
        operands: [data],
        subcommands: {
          workitem: {
            operands: [data],
            subcommands: {
              view: {
                operands: [data],
                effect: "none",
                options: {
                  "-f": arg(data),
                  "--fields": arg(data),
                  ...flags("--json", "--web", "-w"),
                },
              },
              edit: {
                operands: [data],
                effect: "none",
                options: {
                  "-k": arg(data),
                  "--key": arg(data),
                  "-a": arg(data),
                  "--assignee": arg(data),
                  "--description": arg(data),
                  "-d": arg(data),
                  "--summary": arg(data),
                  "-s": arg(data),
                  "--description-file": arg("content"),
                  "--from-json": arg("content"),
                  "--jql": arg(data),
                  "--filter": arg(data),
                  "--labels": arg(data),
                  "-l": arg(data),
                  "--remove-labels": arg(data),
                  "--type": arg(data),
                  "-t": arg(data),
                  ...flags(
                    "--json",
                    "--yes",
                    "-y",
                    "--generate-json",
                    "--ignore-errors",
                    "--remove-assignee",
                  ),
                },
              },
              search: {
                operands: [data],
                effect: "none",
                options: {
                  "--fields": arg(data),
                  "-f": arg(data),
                  "--filter": arg(data),
                  "--jql": arg(data),
                  "-j": arg(data),
                  "--limit": arg(data),
                  "-l": arg(data),
                  ...flags("--json", "--csv", "--count", "--paginate", "--web", "-w"),
                },
              },
              comment: {
                operands: [data],
                subcommands: {
                  list: {
                    operands: [data],
                    effect: "none",
                    options: {
                      "--key": arg(data),
                      "--limit": arg(data),
                      "--order": arg(data),
                      ...flags("--json", "--paginate"),
                    },
                  },
                  create: {
                    operands: [data],
                    effect: "none",
                    options: {
                      "--key": arg(data),
                      "-k": arg(data),
                      "--body": arg(data),
                      "-b": arg(data),
                      "--body-file": arg("content"),
                      "-F": arg("content"),
                      "--jql": arg(data),
                      "--filter": arg(data),
                      ...flags("--json", "--edit-last", "-e", "--ignore-errors"),
                    },
                  },
                },
              },
            },
          },
        },
      },
      confluence: {
        operands: [data],
        subcommands: {
          page: {
            operands: [data],
            subcommands: {
              view: {
                operands: [data],
                effect: "none",
                options: {
                  "--id": arg(data),
                  "--body-format": arg(data),
                  "--status": arg(data),
                  "--version": arg(data),
                  ...flags(
                    "--json",
                    "--get-draft",
                    "--include-collaborators",
                    "--include-direct-children",
                    "--include-favorited-by-current-user-status",
                    "--include-labels",
                    "--include-likes",
                    "--include-operations",
                    "--include-properties",
                    "--include-version",
                    "--include-versions",
                    "--include-webresources",
                  ),
                },
              },
            },
          },
        },
      },
    },
  },
  {
    name: "npx",
    operands: [data],
    semantics: "forward",
    options: {
      "-c": arg(code("bash")),
      "--call": arg(code("bash")),
      "-p": arg(data),
      "--package": arg(data),
      ...flags("-y", "--yes", "--no-install"),
    },
  },
  {
    name: "printenv",
    options: flags("-0", "--null"),
    operands: ["env-name"],
    bare: source("environment listing"),
  },
  {
    name: "set",
    builtinOnly: true,
    operands: [data],
    bare: source("shell variable listing"),
    effect: unknown("shell options or positional mutation"),
  },
  {
    name: "export",
    builtinOnly: true,
    aliases: ["declare", "typeset", "readonly", "local"],
    operands: [data],
    bare: source("shell variable listing"),
    options: {
      "-p": { roles: [], issue: source("variable listing") },
      "-r": { roles: [], issue: unknown("readonly binding state") },
      ...flags("-x"),
    },
  },
  {
    name: "security",
    operands: [data],
    subcommands: {
      "find-generic-password": {
        operands: [data],
        options: {
          "-w": { roles: [], issue: source("keychain password") },
          "-g": { roles: [], issue: source("keychain password") },
          "-s": arg(data),
          "-a": arg(data),
          "-l": arg(data),
        },
      },
      "find-internet-password": {
        operands: [data],
        options: {
          "-w": { roles: [], issue: source("keychain password") },
          "-g": { roles: [], issue: source("keychain password") },
        },
      },
      "dump-keychain": { operands: [data], effect: source("keychain dump") },
    },
  },
  {
    name: "ps",
    operands: [data],
    semantics: "ps",
    options: {
      "-E": { roles: [], issue: source("process environments") },
      ...flags("-a", "-A", "-x", "-u", "-w", "-r", "-f", "-l", "-j", "-H", "--forest"),
      "-o": arg(data),
      "-O": arg(data),
      "--format": arg(data),
      "-p": arg(data),
      "--pid": arg(data),
      "-t": arg(data),
      "-U": arg(data),
      "-G": arg(data),
    },
  },
  {
    name: "launchctl",
    operands: [data],
    subcommands: { getenv: { operands: [data], effect: source("launchd environment") } },
  },
  {
    name: "docker",
    informationFlags: ["--help", "--version"],
    aliases: ["podman"],
    operands: [data],
    startup: ["DOCKER_HOST", "DOCKER_CONFIG"],
    subcommands: {
      volume: {
        operands: [data],
        subcommands: {
          ls: {
            operands: [data],
            options: {
              "--format": arg(data),
              "--filter": arg(data),
              "-f": arg(data),
              ...flags("-q", "--quiet"),
            },
          },
          list: {
            operands: [data],
            options: {
              "--format": arg(data),
              "--filter": arg(data),
              "-f": arg(data),
              ...flags("-q", "--quiet"),
            },
          },
        },
      },
      buildx: {
        operands: [data],
        subcommands: {
          history: {
            operands: [data],
            subcommands: {
              ls: {
                operands: [data],
                options: {
                  "--format": arg(data),
                  "--filter": arg(data),
                  "--builder": arg(data),
                  ...flags("--local", "--no-trunc", "-D", "--debug"),
                },
              },
            },
          },
        },
      },
      version: { operands: [data], options: { "--format": arg(data), "-f": arg(data) } },
      info: { operands: [data], options: { "--format": arg(data), "-f": arg(data) } },
      stats: {
        operands: [data],
        options: { "--format": arg(data), ...flags("--no-stream", "--no-trunc", "-a", "--all") },
      },
      ps: {
        operands: [data],
        options: {
          ...flags("-q", "-a", "--quiet", "--all", "--no-trunc"),
          "--format": arg(data),
          "--filter": arg(data),
          "-f": arg(data),
        },
      },
      logs: {
        operands: [data],
        options: {
          ...flags("-f", "--follow", "-t", "--timestamps"),
          "--since": arg(data),
          "--until": arg(data),
          "--tail": arg(data),
        },
      },
      stop: { operands: [data], options: { "-t": arg(data), "--time": arg(data) } },
      rm: { operands: [data], options: flags("-f", "-v", "--force", "--volumes") },
      build: {
        operands: [path],
        options: {
          "-f": arg("script"),
          "--file": arg("script"),
          "-t": arg(data),
          "--tag": arg(data),
          "--target": arg(data),
          "--build-arg": arg(data),
          ...flags("--no-cache", "--pull", "--quiet", "-q"),
        },
      },

      inspect: { operands: [data], effect: source("docker inspect environment") },
      exec: { operands: [data], effect: unknown("docker exec program") },
      run: { operands: [data], effect: unknown("docker run program") },
      compose: {
        operands: [data],
        options: {
          "--profile": arg(data),
          "-p": arg(data),
          "--project-name": arg(data),
          "-f": arg("script"),
          "--file": arg("script"),
          "--env-file": arg("content"),
        },
        subcommands: {
          rm: {
            operands: [data],
            options: flags("-f", "--force", "-s", "--stop", "-v", "--volumes", "--dry-run"),
          },
          ps: {
            operands: [data],
            options: {
              "--format": arg(data),
              "--filter": arg(data),
              "--status": arg(data),
              ...flags("-a", "--all", "-q", "--quiet", "--services", "--no-trunc"),
            },
          },
          config: {
            operands: [data],
            options: flags("--get", "--get-all", "--local", "--global", "--show-origin"),
            effect: source("docker compose resolved environment"),
          },
          exec: { operands: [data], effect: unknown("docker compose exec") },
          run: { operands: [data], effect: unknown("docker compose run entrypoint") },
        },
      },
    },
  },
  {
    name: "gh",
    options: {
      "-R": arg(data),
      "--repo": arg(data),
      "--json": arg(data),
      "--jq": arg(code("jq")),
      "-q": arg(code("jq")),
      "--template": arg(code("runtime")),
      "-t": arg(code("runtime")),
      "--limit": arg(data),
      "-L": arg(data),
      "--state": arg(data),
      "--search": arg(data),
      "--author": arg(data),
      "--assignee": arg(data),
      "--label": arg(data),
      "--head": arg(data),
      "--base": arg(data),
      "--topic": arg(data),
      ...flags("--help", "--version", "--web", "--comments", "--watch", "--required"),
    },
    informationFlags: ["--help", "--version"],
    operands: [data],
    semantics: "gh",
    effect: wrapper("gh", "agent-tools-gh"),
    startup: ["GH_HOST", "GH_CONFIG_DIR", "GH_BROWSER", "GH_PAGER"],
    subcommands: {
      issue: {
        operands: [data],
        subcommands: {
          list: { operands: [data], effect: "none" },
          view: { operands: [data], effect: "none" },
          search: { operands: [data], effect: "none" },
        },
      },
      pr: {
        operands: [data],
        subcommands: {
          list: { operands: [data], effect: "none" },
          view: { operands: [data], effect: "none" },
          diff: { operands: [data], effect: "none" },
          checks: { operands: [data], effect: "none" },
        },
      },
      release: {
        operands: [data],
        subcommands: {
          list: { operands: [data], effect: "none" },
          view: { operands: [data], effect: "none" },
        },
      },
      repo: { operands: [data], subcommands: { view: { operands: [data], effect: "none" } } },
      search: {
        operands: [data],
        subcommands: {
          issues: { operands: [data], effect: "none" },
          prs: { operands: [data], effect: "none" },
          repos: { operands: [data], effect: "none" },
        },
      },
      api: { operands: [data], effect: "none" },
      auth: { operands: [data], effect: source("gh authentication credentials") },
    },
  },
  {
    name: "kubectl",
    informationFlags: ["--help", "--version"],
    operands: [data],
    effect: wrapper("kubectl", "agent-tools-k8s"),
  },
  {
    name: "psql",
    informationFlags: ["--help", "--version"],
    operands: [data],
    effect: wrapper("psql", "agent-tools-db"),
  },
  {
    name: "az",
    informationFlags: ["--help", "--version"],
    operands: [data],
    effect: wrapper("az", "agent-tools-az"),
    subcommands: Object.fromEntries(
      ["devops", "pipelines", "repos", "boards", "artifacts"].map((name) => [
        name,
        { operands: [data], effect: wrapper("az (Azure DevOps)", "agent-tools-azdo") },
      ]),
    ),
  },
  {
    name: "curl",
    readsContent: true,
    operands: [data],
    semantics: "curl",
    startup: ["CURL_HOME"],
    options: {
      ...flags("--insecure"),
      ...flags(
        "-s",
        "-S",
        "-f",
        "-L",
        "-I",
        "-i",
        "-k",
        "-v",
        "--silent",
        "--show-error",
        "--fail",
        "--location",
        "--head",
        "--compressed",
        "--globoff",
        "-g",
      ),
      "-X": arg(data),
      "--request": arg(data),
      "--max-time": arg(data),
      "-m": arg(data),
      "--connect-timeout": arg(data),
      "--retry": arg(data),
      "--write-out": arg(data),
      "--data-raw": arg(data),

      "-d": arg(data),
      "--data": arg(data),
      "--data-binary": arg(data),
      "-F": arg(data),
      "--form": arg(data),
      "-T": arg(path),
      "--upload-file": arg(path),
      "-K": arg(path),
      "--config": arg(path),
      "--netrc-file": arg(path),
      "--key": arg(path),
      "--cert": arg(path),
      "-b": arg(path),
      "--cookie": arg(path),
      "-o": arg("write"),
      "--output": arg("write"),
      "-H": arg(data),
      "--header": arg(data),
      "-w": arg(data),
    },
  },
  {
    name: "cp",
    operands: [path],
    semantics: "copy",
    options: {
      "-t": { roles: ["write"], issue: unknown("copy target directory") },
      "--target-directory": { roles: ["write"], issue: unknown("copy target directory") },
      ...flags(
        "-f",
        "-n",
        "-v",
        "-p",
        "-r",
        "-R",
        "-a",
        "-b",
        "-c",
        "-d",
        "-H",
        "-i",
        "-l",
        "-L",
        "-P",
        "-s",
        "-T",
        "-u",
        "-x",
        "-X",
        "--recursive",
        "--archive",
        "--no-clobber",
        "--verbose",
      ),
    },
  },
  {
    name: "rsync",
    operands: [path],
    options: {
      ...flags("-a", "-r", "-v", "-z", "--archive", "--recursive", "--delete"),
      "-e": arg(code("bash")),
      "--rsh": arg(code("bash")),
    },
  },
  { name: "ditto", operands: [path], options: flags("-V", "-v", "--rsrc", "--norsrc") },
  {
    name: "tar",
    operands: [path],
    options: {
      ...flags(
        "-x",
        "--extract",
        "-c",
        "--create",
        "-r",
        "--append",
        "-u",
        "--update",
        "-t",
        "--list",
        "-v",
        "-z",
        "-j",
        "-J",
        "-p",
        "-a",
        "-h",
        "-P",
      ),
      "-f": arg(path),
      "--file": arg(path),
      "-C": arg("write"),
      "--directory": arg("write"),
    },
  },
  {
    name: "unzip",
    operands: [path],
    options: { ...flags("-q", "-o", "-n", "-l", "-t", "-v"), "-d": arg("write") },
  },
  {
    name: "patch",
    operands: ["write", path],
    options: {
      "-i": arg(path),
      "--input": arg(path),
      "-o": arg("write"),
      "--output": arg("write"),
      "-d": arg("write"),
      "--directory": arg("write"),
      "-p": arg(data),
      ...flags("-s", "-f", "-R", "--dry-run"),
    },
  },
  {
    name: "truncate",
    operands: ["write"],
    options: {
      "-s": arg(data),
      "--size": arg(data),
      "-r": arg(path),
      "--reference": arg(path),
      ...flags("-c", "--no-create"),
    },
  },
  {
    name: "touch",
    operands: ["write-name"],
    options: {
      "-t": arg(data),
      "-d": arg(data),
      "-r": arg(path),
      ...flags("-a", "-m", "-c", "-h", "--no-create"),
    },
  },
  {
    name: "wget",
    operands: [data],
    options: {
      "-O": arg("write"),
      "--output-document": arg("write"),
      "-o": arg("write"),
      "--output-file": arg("write"),
      "-a": arg("write"),
      "--append-output": arg("write"),
      "-P": arg("write"),
      "--directory-prefix": arg("write"),
      "-t": arg(data),
      "--tries": arg(data),
      "-T": arg(data),
      "--timeout": arg(data),
      "-U": arg(data),
      "--user-agent": arg(data),
      "--header": arg(data),
      "--limit-rate": arg(data),
      "-l": arg(data),
      "--level": arg(data),
      "-i": arg(path),
      "--input-file": arg(path),
      ...flags("-q", "-c", "-nv", "-N", "-r", "-np", "-nd", "-nc"),
    },
  },
  { name: "seq", operands: [data], semantics: "seq" },
  { name: "tr", operands: [data], stdout: "opaque", options: flags("-c", "-C", "-d", "-s", "-t") },
  {
    name: "uniq",
    readsContent: true,
    operands: [path, "write"],
    stdout: "opaque",
    options: {
      ...flags("-c", "-d", "-u", "-i"),
      "-f": arg(data),
      "-s": arg(data),
      "-w": arg(data),
      "--skip-fields": arg(data),
      "--skip-chars": arg(data),
      "--check-chars": arg(data),
    },
  },
  { name: "sleep", operands: [data] },
  {
    name: "mkdir",
    operands: ["names"],
    options: { "-m": arg(data), ...flags("-p", "-v", "--parents") },
  },
  {
    name: "rm",
    aliases: ["du", "stat", "chown", "df"],
    options: {
      ...flags("-f", "-r", "-R", "-v", "-n", "-i", "-p", "-a", "-m", "-c", "-h", "-s"),
      "-t": arg(data),
      "-d": arg(data),
    },
    operands: ["names"],
  },
  {
    name: "mv",
    operands: ["write"],
    options: {
      "-t": arg("write"),
      "--target-directory": arg("write"),
      ...flags("-T", "--no-target-directory", "-f", "-i", "-n", "-v", "-u", "-b", "-h"),
    },
  },
  {
    name: "ln",
    operands: [path],
    options: {
      "-t": arg("write"),
      "--target-directory": arg("write"),
      ...flags(
        "-s",
        "-F",
        "-f",
        "-n",
        "-v",
        "-h",
        "-T",
        "--no-target-directory",
        "-L",
        "-P",
        "-r",
        "-b",
        "-i",
      ),
    },
  },
  { name: "chmod", operands: [data, "names"], options: flags("-R", "-f", "-v", "-c") },
  {
    name: "break",
    builtinOnly: true,
    aliases: ["continue", "return", "exit"],
    operands: [data],
    effect: unknown("control transfer outside modeled status flow"),
  },
  {
    name: "test",
    aliases: ["["],
    operands: ["names"],
    options: {
      ...flags("-a", "-o", "-eq", "-ne", "-lt", "-le", "-gt", "-ge", "-nt", "-ot", "-ef"),
      ...Object.fromEntries(
        [
          "-e",
          "-f",
          "-d",
          "-L",
          "-h",
          "-r",
          "-w",
          "-x",
          "-s",
          "-b",
          "-c",
          "-p",
          "-S",
          "-t",
          "-n",
          "-z",
        ].map((option) => [option, arg("names")]),
      ),
    },
  },
  {
    name: "Get-ChildItem",
    builtinOnly: true,
    pipelineData: true,
    aliases: ["gci", "dir"],
    operands: ["names"],
    semantics: "env-provider",
    options: {
      "-Path": arg("names"),
      "-LiteralPath": arg("names"),
      "-Filter": arg("path-pattern"),
      "-Include": arg("path-pattern"),
      "-Exclude": arg("path-pattern"),
      ...flags("-Force", "-Recurse", "-File", "-Directory", "-Name", "-Hidden"),
    },
  },
  {
    name: "Get-Content",
    builtinOnly: true,
    readsContent: true,
    aliases: ["gc"],
    operands: [path],
    options: {
      "-Path": arg(path),
      "-LiteralPath": arg(path),
      "-TotalCount": arg(data),
      ...flags("-Raw"),
    },
  },
  {
    name: "Write-Output",
    builtinOnly: true,
    pipelineData: true,
    aliases: ["Write-Host"],
    operands: [data],
    stdout: "arguments",
  },
  {
    name: "Get-StoredCredential",
    aliases: ["vaultcmd"],
    operands: [data],
    effect: source("Windows credentials"),
  },
  {
    name: "op",
    informationFlags: ["--help", "--version"],
    operands: [data],
    effect: source("password manager secret"),
    subcommands: { whoami: { operands: [data], effect: "none" } },
  },
  { name: "gcloud", operands: [path] },
  { name: "aws", operands: [path] },
  { name: "bw", operands: [path] },
  { name: "pass", operands: [path] },
  {
    name: "npm",
    operands: [path],
    options: {
      "--package": arg(data),
      "-p": arg(data),
      ...flags("--yes", "-y", "-g", "--global"),
      ...flags("--version", "--help", "--silent", "-s", "--json"),
      "--prefix": arg("names"),
    },
    subcommands: {
      view: { operands: [data], options: flags("--prefer-online", "--prefer-offline") },
      run: { operands: [data] },
      "run-script": { operands: [data] },
      exec: {
        operands: [data],
        options: { "-c": arg(code("runtime")), "--call": arg(code("runtime")) },
      },
    },
  },
  { name: "git-credential-helper", namePattern: /^(?:git|docker)-credential-/, operands: [path] },
  { name: "cmdkey", operands: [data], effect: source("Windows stored credentials") },
  { name: "cmd", operands: [data], effect: unknown("cmd command language") },
  {
    name: "powershell",
    aliases: ["pwsh"],
    operands: [data],
    effect: unknown("PowerShell command invocation"),
  },
  {
    name: "Start-Process",
    builtinOnly: true,
    aliases: ["saps", "start"],
    operands: [data],
    effect: unknown("Start-Process code"),
  },
  {
    name: "Invoke-Expression",
    builtinOnly: true,
    aliases: ["iex"],
    operands: [data],
    effect: unknown("Invoke-Expression code"),
  },
];

export function isStdinScript(value: string): boolean {
  return /^(?:-|\/dev\/stdin|\/dev\/fd\/0|\/proc\/(?:self|[0-9]+)\/fd\/0)$/.test(value);
}

export function executableName(name: string): string {
  return (name.replace(/\\/g, "/").split("/").at(-1) ?? name)
    .replace(/\.(?:exe|cmd|bat|ps1)$/i, "")
    .toLowerCase();
}
export function buildRegistry(
  blocked: readonly { readonly tool: string; readonly suggestion: string }[] = [],
): Registry {
  const entries = new Map<string, ExecutableEntry>();
  const startupVariables = new Set([
    "PATH",
    "HOME",
    "XDG_CONFIG_HOME",
    "LD_PRELOAD",
    "LD_AUDIT",
    "DYLD_INSERT_LIBRARIES",
    "LESSOPEN",
    "LESSCLOSE",
    "MANPAGER",
    "BAT_PAGER",
    "GIT_PAGER",
    "VISUAL",
    "EDITOR",
    "FPATH",
    "ZDOTDIR",
    "GLOBIGNORE",
    "LIBPATH",
    "SHLIB_PATH",
    "BUN_PRELOAD",
    "PS0",
    "PS1",
    "PS2",
    "PS3",
    "PS4",
  ]);
  for (const entry of EXECUTABLES) {
    for (const name of [entry.name, ...(entry.aliases ?? [])]) {
      const key = executableName(name);
      if (entries.has(key)) throw new Error(`duplicate executable ${key}`);
      entries.set(key, entry);
    }
    for (const variable of entry.startup ?? []) startupVariables.add(variable);
  }
  return {
    entries,
    startupVariables,
    blocked: new Map(blocked.map((item) => [executableName(item.tool), item.suggestion])),
  };
}

function inertGitConfigKey(key: string): boolean {
  return /^(?:user\.(?:name|email)|color\.[A-Za-z0-9.-]+|core\.(?:quotepath|autocrlf)|advice\.[A-Za-z0-9.-]+|init\.defaultbranch|(?:commit|tag)\.gpgsign|pull\.rebase)$/i.test(
    key,
  );
}

function analyzeUnknownOperands(
  words: readonly (string | undefined)[],
  registry: Registry,
  dialect: "bash" | "powershell",
): Pick<InvocationPlan, "issues" | "refuseSuppliedStdin" | "roles"> {
  const issues: Issue[] = [];
  let refuseSuppliedStdin = false;
  const roles: Array<InvocationPlan["roles"][number]> = [];
  for (let index = 0; index < words.length; index++) {
    const operand = words[index] ?? "";
    const wordName =
      operand.startsWith("-") && operand.includes("=")
        ? operand.slice(operand.indexOf("=") + 1)
        : operand;
    const name = executableName(wordName);
    const previous = words[index - 1];
    const optionValue =
      operand.startsWith("-") ||
      (previous?.startsWith("-") && previous !== "--" && !previous.includes("="));
    const sourceWord =
      (!optionValue || name !== "env") &&
      (dialect === "powershell" || wordName.replace(/\\/g, "/").split("/").at(-1) === name);
    const entry =
      registry.entries.get(name) ??
      [...registry.entries.values()].find((candidate) => candidate.namePattern?.test(name));
    if (!entry || ["export", "set"].includes(entry.name)) continue;
    let mode: Omit<ExecutableEntry, "name"> = entry;
    let position = index + 1;
    while (words[position] !== undefined && mode.subcommands?.[words[position] ?? ""]) {
      mode = mode.subcommands[words[position] ?? ""] ?? mode;
      position++;
    }
    refuseSuppliedStdin ||=
      Boolean(mode.readsStdinCode ?? entry.readsStdinCode) ||
      ["shell", "runtime", "python"].includes(entry.semantics ?? "");
    const effect = mode.effect ?? entry.effect;
    if (sourceWord && effect && effect !== "none" && effect.rule === "secret-source")
      issues.push(effect);
    const environment = entry.semantics === "env";
    const environmentNames = entry.operands.includes("env-name");
    if (
      sourceWord &&
      entry.bare?.rule === "secret-source" &&
      !environment &&
      !environmentNames &&
      position === words.length
    )
      issues.push(entry.bare);
    let envCommand = false;
    let envNameSeen = false;
    const options = { ...entry.options, ...mode.options };
    let awkProgramSeen = false;
    let endOptions = false;
    for (; position < words.length; position++) {
      const word = words[position];
      if (word === "--" && !endOptions) {
        endOptions = true;
        continue;
      }
      if (endOptions || !word?.startsWith("-")) {
        if (environment && (word === undefined || !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)))
          envCommand = true;
        if (sourceWord && environmentNames) {
          envNameSeen = true;
          if (word === undefined)
            issues.push({
              kind: "missing-knowledge",
              rule: "opaque-env-name",
              detail: "environment name is not literal",
            });
          else roles.push({ index: 0, role: "env-name", literal: word });
        }
        if (entry.semantics === "awk" && !awkProgramSeen) {
          issues.push(
            ...(word === undefined
              ? [unknown("awk program is not literal")]
              : analyzeCode("awk", word)),
          );
          awkProgramSeen = true;
        }
        continue;
      }
      const equal = word.indexOf("=");
      const exact = options[equal < 0 ? word : word.slice(0, equal)];
      const matched: { option: Option; attached?: string }[] = [];
      if (exact)
        matched.push({ option: exact, ...(equal < 0 ? {} : { attached: word.slice(equal + 1) }) });
      else if (/^-[^-].+/.test(word)) {
        for (let offset = 1; offset < word.length; offset++) {
          const option = options[`-${word[offset]}`];
          if (!option) break;
          matched.push({
            option,
            ...(option.roles.length && offset + 1 < word.length
              ? { attached: word.slice(offset + 1) }
              : {}),
          });
          if (option.roles.length) break;
        }
      }
      for (const { option, attached } of matched) {
        if (sourceWord && option.issue?.rule === "secret-source") issues.push(option.issue);
        if (
          ["shell", "runtime", "python", "env"].includes(entry.semantics ?? "") &&
          option.roles.some((role) => typeof role !== "string")
        )
          issues.push(unknown("inline code in unknown command operands"));
        if (environment || environmentNames)
          position += Math.max(0, option.roles.length - (attached === undefined ? 0 : 1));
        if (entry.semantics === "awk") {
          if (option === options["-f"] || option === options["--file"]) awkProgramSeen = true;
          for (const role of option.roles) {
            const value = attached ?? words[++position];
            if (typeof role !== "string" && role.code === "awk") {
              issues.push(
                ...(value === undefined
                  ? [unknown("awk program is not literal")]
                  : analyzeCode("awk", value)),
              );
              awkProgramSeen = true;
            }
          }
        }
      }
    }
    if (
      sourceWord &&
      entry.bare?.rule === "secret-source" &&
      ((environment && !envCommand) || (environmentNames && !envNameSeen))
    )
      issues.push(entry.bare);
  }
  return { issues, refuseSuppliedStdin, roles };
}

export function classify(
  argv: readonly (string | undefined)[],
  registry: Registry,
  dialect: "bash" | "powershell" = "bash",
  runtimeWrapper = false,
): InvocationPlan {
  return classifyInvocation(argv, registry, dialect, runtimeWrapper, new Set(), { remaining: 32 });
}

function classifyInvocation(
  argv: readonly (string | undefined)[],
  registry: Registry,
  dialect: "bash" | "powershell",
  runtimeWrapper: boolean,
  skippedValues: ReadonlySet<number>,
  budget: { remaining: number },
): InvocationPlan {
  const roles: { index: number; role: OperandRole; literal?: string }[] = [];
  const issues: Issue[] = [];
  const children: Array<InvocationPlan["children"][number]> = [];
  const assignments: { name: string; index: number; value: string }[] = [];
  let stdout: InvocationPlan["stdout"] = "opaque";
  let stdinCode: Language | null = null;
  let unknownStdinCode = false;
  const unknownOperandIssues = (words: readonly (string | undefined)[]): readonly Issue[] => {
    const analysis = analyzeUnknownOperands(words, registry, dialect);
    roles.push(...analysis.roles);
    unknownStdinCode ||= analysis.refuseSuppliedStdin;
    return analysis.issues;
  };
  let remote = false;
  let delta: InvocationPlan["delta"] = "none";
  let codePositionals: number[] = [];
  const directoryWrites: Array<InvocationPlan["directoryWrites"][number]> = [];
  const writerCandidates: { index: number; literal: string }[] = [];
  const archiveFiles: number[] = [];
  let writesArchive = false;
  let wgetOutputDocument = false;
  let wgetInputFile = false;
  let wgetDirectoryPrefix: string | undefined = ".";
  let inPlaceBackupSuffix: string | null = null;
  let sedEmptySuffix = false;
  let maxArgs: number | null = null;
  let maxLines: number | null = null;
  let replacement: string | null = null;
  const cwdOperands: { index: number; literal?: string }[] = [];
  let entry: ExecutableEntry | undefined;
  let pythonModule: { index: number; name: string | undefined } | null = null;
  const result = (): InvocationPlan => ({
    roles,
    xargsInput: entry?.semantics === "xargs" ? { maxArgs, maxLines, replacement } : null,
    issues,
    children,
    assignments,
    stdout,
    delta,
    stdinCode,
    refuseSuppliedStdin:
      unknownStdinCode ||
      Boolean(entry?.readsStdinCode) ||
      (runtimeWrapper && pythonModule !== null),
    pipelinePaths:
      dialect === "powershell" &&
      (/^[a-z]+-[a-z]+$/i.test(executable ?? "") ||
        ["gc", "cat", "type", "sls", "cp", "copy", "mv"].includes(
          executableName(executable ?? ""),
        )) &&
      !entry?.pipelineData,
    remote,
    codePositionals,
    cwdOperands,
    inPlaceBackupSuffix,
    directoryWrites,
    startupFiles: entry?.startupFiles ?? [],
    copyDestination: entry?.semantics === "copy",
    scriptLanguage: entry?.semantics === "shell" ? "bash" : "runtime",
  });
  const executable = argv[0];
  if (executable === undefined) {
    issues.push({
      kind: "missing-knowledge",
      rule: "opaque-executable",
      detail: "executable is not literal",
    });
    return result();
  }
  const name = executableName(executable);
  const lookupName = dialect === "powershell" && name === "type" ? "get-content" : name;
  const configured = registry.blocked.get(name);

  entry =
    registry.entries.get(lookupName) ??
    [...registry.entries.values()].find((candidate) => candidate.namePattern?.test(name));
  let informationMode: Omit<ExecutableEntry, "name"> | undefined = entry;
  for (const segment of argv.slice(1, -1))
    informationMode = segment === undefined ? undefined : informationMode?.subcommands?.[segment];
  if (
    (entry?.informationFlags?.includes(argv.at(-1) ?? "") && informationMode) ||
    (configured && argv.length === 2 && ["--help", "--version"].includes(argv[1] ?? ""))
  )
    return result();
  if (configured) issues.push(wrapper(name, configured));
  if (!entry) {
    issues.push(...unknownOperandIssues(argv.slice(1)));
    argv.slice(1).forEach((_, i) => roles.push({ index: i + 1, role: path }));
    return result();
  }
  if (name === "rustup" && argv[1] === "run") {
    const toolchainIndex = argv[2] === "--install" ? 3 : 2;
    const toolchain = argv[toolchainIndex];
    if (
      toolchain === undefined ||
      toolchain.startsWith("-") ||
      argv[toolchainIndex + 1] === undefined
    )
      issues.push(unknown("toolchain and command must be literal"));
    else {
      roles.push({ index: toolchainIndex, role: "names" });
      children.push({
        start: toolchainIndex + 1,
        end: argv.length,
        appendInput: false,
        placeholder: null,
        findRoots: null,
        runtimeWrapper: true,
      });
    }
    return result();
  }
  if (
    ["nvm", "fnm", "volta", "asdf", "pyenv"].includes(name) &&
    ["exec", "run"].includes(argv[1] ?? "")
  ) {
    let start = 2;
    if (name === "nvm" && /^[0-9v]/.test(argv[start] ?? "")) start++;
    if (name === "fnm" && argv[start]?.startsWith("--using=")) start++;
    else if (name === "fnm" && argv[start] === "--using") start += 2;
    if (argv[start]?.startsWith("-"))
      issues.push(unknown("unsupported version manager execution option"));
    else
      children.push({
        start,
        end: argv.length,
        appendInput: false,
        placeholder: null,
        findRoots: null,
        runtimeWrapper: true,
      });
    return result();
  }
  const words = argv.slice(1);
  if (
    name === "set" &&
    words.length > 0 &&
    words.every((word) => word !== undefined && !word.startsWith("-") && !word.startsWith("+"))
  )
    return result();
  if (name === "brew" && words.length === 1 && ["--help", "--version"].includes(words[0] ?? ""))
    return result();

  if (
    name === "git" &&
    argv.some((word, index) => word?.startsWith("credential-") && argv[index + 1] === "get")
  )
    issues.push(source("git credential helper output"));
  if (
    (name === "gcloud" &&
      words[0] === "auth" &&
      ["print-access-token", "print-identity-token"].includes(words[1] ?? "")) ||
    (name.startsWith("git-credential-") && words.includes("get")) ||
    (name.startsWith("docker-credential-") && words.includes("get")) ||
    (name === "npm" &&
      words[0] === "config" &&
      words[1] === "get" &&
      /auth|token/i.test(words[2] ?? "")) ||
    (name === "bw" && words[0] === "get") ||
    (name === "pass" && (words.length === 0 || words[0] === "show")) ||
    (name === "aws" &&
      ((words[0] === "sts" && words[1] === "get-session-token") ||
        (words[0] === "configure" && words[1] === "get") ||
        (words[0] === "ecr" && words[1] === "get-login-password"))) ||
    (name === "security" && /^find-.*-password$/.test(words[0] ?? ""))
  )
    issues.push(source("credential command output"));
  if (name === "op" && argv[1] !== "whoami") {
    issues.push(source("password manager secret"));
    return result();
  }
  let mode: Omit<ExecutableEntry, "name"> = entry;
  let unknownSubcommandStart: number | null = null;
  let effect = entry.effect;
  let position = 1;
  const positional: number[] = [];
  let codeSeen = false;
  let shellStdin = false;
  let testRunner = false;
  const optionRoles: { index: number; role: OperandRole; literal?: string }[] = [];
  let filterOption = false;
  let endOptions = false;
  const child = (
    start: number,
    end = argv.length,
    appendInput = false,
    placeholder: string | null = null,
    findRoots: readonly string[] | null = null,
  ) => children.push({ start, end, appendInput, placeholder, findRoots });
  if (name === "docker" && (argv[1] === "exec" || (argv[1] === "compose" && argv[2] === "exec"))) {
    remote = true;
    cwdOperands.push({ index: 0, literal: "/" });
    const compose = argv[1] === "compose";
    let index = compose ? 3 : 2;
    while (argv[index]?.startsWith("-")) {
      const word = argv[index] ?? "";
      if (word === "--") {
        index++;
        break;
      }
      if (["--help", "-h"].includes(word)) return result();
      if (
        /^-[itd]+$/.test(word) ||
        ["--interactive", "--tty", "--detach", ...(compose ? ["-T", "--no-TTY"] : [])].includes(
          word,
        )
      ) {
        index++;
        continue;
      }
      const match = /^(--[^=]+)=(.*)$/.exec(word) ?? /^(-[uwe])(.+)$/.exec(word);
      const option = match?.[1] ?? word;
      const valueIndex = match ? index : index + 1;
      const value = match?.[2] ?? argv[valueIndex];
      if (
        ![
          "-u",
          "--user",
          "-w",
          "--workdir",
          "-e",
          "--env",
          "--detach-keys",
          ...(compose ? ["--index"] : []),
        ].includes(option) ||
        value === undefined
      ) {
        issues.push(unknown("unsupported Docker exec option or nonliteral value"));
        return result();
      }
      if (option === "-w" || option === "--workdir")
        cwdOperands.push({ index: valueIndex, literal: value });
      if (option === "-e" || option === "--env") {
        const binding = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(value);
        if (!binding) {
          issues.push(unknown("Docker exec environment must have a literal value"));
          return result();
        }
        assignments.push({ name: binding[1] ?? "", value: binding[2] ?? "", index: valueIndex });
      }
      index += match ? 1 : 2;
    }
    if (argv[index] === undefined || argv[index + 1] === undefined)
      issues.push(unknown("Docker exec container and executable must be literal"));
    else child(index + 1);
    return result();
  }
  if (name === "direnv" && argv[1] === "exec") {
    if (argv[2] === undefined || argv[2].startsWith("-") || argv[3] === undefined)
      issues.push(unknown("direnv exec directory and command are required"));
    roles.push({ index: 2, role: "names" });
    children.push({
      start: 3,
      end: argv.length,
      appendInput: false,
      placeholder: null,
      findRoots: null,
      runtimeWrapper: true,
    });
    return result();
  }
  if (name === "rtk") {
    let start = 1;
    while (/^(?:-v+|--verbose|--skip-env)$/.test(argv[start] ?? "")) start++;
    const subcommand = argv[start];
    if (subcommand?.startsWith("-") && !["--help", "--version"].includes(subcommand)) {
      issues.push(...unknownOperandIssues(argv.slice(start)));
      argv.slice(start).forEach((word, offset) =>
        roles.push({
          index: start + offset,
          role: path,
          ...(word?.includes("=") ? { literal: word.slice(word.indexOf("=") + 1) } : {}),
        }),
      );
      return result();
    }
    if (["proxy", "run", "err", "test", "summary", "bypass", "pipe"].includes(subcommand ?? "")) {
      let index = start + 1;
      let shell: string | undefined;
      let commandIndex: number | undefined;
      while (argv[index]?.startsWith("-")) {
        const option = argv[index];
        if (option === "--") {
          index++;
          break;
        }
        if (option === "--help" || option === "-h") return result();
        if (option === "--skip-env" || (subcommand === "pipe" && option === "--passthrough")) {
          index++;
          continue;
        }
        if (
          option === "--shell" ||
          option === "--command" ||
          option === "-c" ||
          (subcommand === "pipe" && (option === "--filter" || option === "-f"))
        ) {
          if (argv[index + 1] === undefined) {
            issues.push(unknown("missing rtk option value"));
            return result();
          }
          if (option === "--shell") shell = argv[index + 1];
          else if (option === "--command" || option === "-c") commandIndex = index + 1;
          index += 2;
          continue;
        }
        issues.push(...unknownOperandIssues([option, ...argv.slice(index + 1)]));
        roles.push({
          index,
          role: path,
          ...(option?.includes("=") ? { literal: option.slice(option.indexOf("=") + 1) } : {}),
        });
        index++;
      }
      if (shell !== undefined || commandIndex !== undefined) {
        const language = ["sh", "bash", "zsh"].includes(executableName(shell ?? "sh"))
          ? "bash"
          : ["pwsh", "powershell"].includes(executableName(shell ?? ""))
            ? "powershell"
            : null;
        if (!language) issues.push(unknown("unsupported rtk shell"));
        else roles.push({ index: commandIndex ?? index, role: code(language) });
        if (commandIndex === undefined ? index + 1 !== argv.length : index !== argv.length)
          issues.push(unknown("ambiguous rtk shell arguments"));
      } else if (subcommand === "pipe" && index === argv.length) stdout = "stdin";
      else child(index);
      return result();
    } else if (["read", "smart", "json", "log", "deps"].includes(subcommand ?? "")) {
      mode = {
        operands: ["content"],
        options: {
          "-n": arg(data),
          "--lines": arg(data),
          "--max-lines": arg(data),
          ...flags("--help", "--raw", "--smart"),
        },
      };
      position = start + 1;
    } else if (
      [
        "gain",
        "methods",
        "discover",
        "session",
        "recall",
        "cc-economics",
        "hook-audit",
        "help",
        "--help",
        "--version",
      ].includes(subcommand ?? "")
    ) {
      if (
        argv
          .slice(start + 1)
          .some((value) => value === "--reset" || value === "--write" || value === "--apply")
      )
        issues.push(unknown("rtk management mutation"));
      mode = {
        operands: [data],
        options: {
          ...flags(
            "--help",
            "-h",
            "--json",
            "--all",
            "--list",
            "--history",
            "--daily",
            "--weekly",
            "--monthly",
          ),
          "--days": arg(data),
          "--since": arg(data),
          "--limit": arg(data),
          "--format": arg(data),
        },
      };
      position = start + 1;
    } else if (
      [
        "init",
        "config",
        "trust",
        "untrust",
        "plugins",
        "learn",
        "llm-proxy",
        "telemetry",
        "verify",
        "pipeline",
        "tasks",
      ].includes(subcommand ?? "")
    ) {
      if (!argv.slice(start + 1).some((value) => value === "--help" || value === "-h"))
        issues.push(unknown("rtk management command"));
      mode = { operands: [data], options: flags("--help", "-h") };
      position = start + 1;
    } else {
      child(start);
      return result();
    }
  }
  if (name === "command") {
    let index = 1;
    let lookup = false;
    while (/^-[pvV]+$/.test(argv[index] ?? "")) {
      lookup ||= /[vV]/.test(argv[index] ?? "");
      index++;
    }
    if (lookup && (argv[index] === "--" || !argv[index]?.startsWith("-"))) return result();
  }
  if (["export", "declare", "typeset", "readonly", "local"].includes(name)) {
    delta = "assign";
    if (name === "readonly") issues.push(unknown("readonly binding state"));
    if (argv.slice(1).some((word) => /^-[^-]*[in]/.test(word ?? "")))
      issues.push(unknown("indirect or arithmetic declaration binding"));
    for (let index = 1; index < argv.length; index++) {
      const value = argv[index];
      if (
        value &&
        /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/.test(value) &&
        !/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)
      )
        issues.push(unknown("append or indexed declaration binding"));
      const match = value && /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(value);
      if (match) assignments.push({ name: match[1] ?? "", index, value: match[2] ?? "" });
    }
  }
  if (name === "printf") {
    const format = argv[1] === "--" ? argv[2] : argv[1];
    if (
      format === undefined ||
      [...format.matchAll(/%(?:%|[-+ #0]*(?:[0-9]+|\*)?(?:\.(?:[0-9]+|\*))?n)/g)].some(
        ([directive]) => directive !== "%%",
      )
    )
      issues.push(unknown("printf format can write a shell binding"));
  }
  if (
    entry.semantics === "git" &&
    argv.some((a) => /^-(?:[^-]*O|[^-]*f)/.test(a ?? "")) &&
    argv.includes("grep")
  )
    issues.push(unknown("git grep executable or file option"));
  if (entry.semantics === "gh") {
    argv.forEach((a, index) => {
      if (a?.startsWith("--jq=")) roles.push({ index, role: code("jq"), literal: a.slice(5) });
      if (a?.startsWith("-q") && a.length > 2)
        roles.push({ index, role: code("jq"), literal: a.slice(2) });
    });
    const jq = argv.findIndex((a) => a === "--jq" || a === "-q");
    if (jq >= 0) roles.push({ index: jq + 1, role: code("jq") });
    if (argv.some((a) => a === "--template" || a === "-t" || a?.startsWith("--template=")))
      issues.push(unknown("gh template code"));
    if (argv[1] === "api") {
      issues.push(wrapper("gh", "agent-tools-gh"));
      return result();
    }
    let selected = mode;
    for (const value of argv.slice(1, 3)) {
      if (value && selected.subcommands?.[value]) selected = selected.subcommands[value];
      else break;
    }
    if (
      !(
        selected.effect === "none" &&
        argv.some(
          (a, i) =>
            ((a === "-R" || a === "--repo") && Boolean(argv[i + 1])) ||
            (a?.startsWith("--repo=") && a.length > 7),
        )
      )
    )
      issues.push(
        selected.effect && selected.effect !== "none"
          ? selected.effect
          : wrapper("gh", "agent-tools-gh"),
      );
  }
  if (name === "fd") {
    const execution = argv.findIndex((word) =>
      ["-x", "-X", "--exec", "--exec-batch"].includes(word ?? ""),
    );
    if (execution >= 0) {
      if (execution === argv.length - 1) issues.push(unknown("fd execution has no executable"));
      else {
        const prefix = classify(argv.slice(0, execution), registry, dialect);
        roles.push(...prefix.roles);
        issues.push(...prefix.issues);
        child(
          execution + 1,
          argv.at(-1) === ";" ? argv.length - 1 : argv.length,
          !argv.slice(execution + 1).some((word) => word?.includes("{}")),
          "{}",
          [],
        );
      }
      return result();
    }
  }
  if (entry.semantics === "find") {
    const roots: string[] = [];
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i];
      if (a && ["-exec", "-execdir", "-ok", "-okdir"].includes(a)) {
        const end = argv.findIndex((v, n) => n > i && (v === ";" || v === "+"));
        if (end < 0) issues.push(unknown("unterminated find execution"));
        else {
          child(i + 1, end, false, "{}", roots);
          i = end;
        }
      } else if (
        a &&
        [
          "-name",
          "-iname",
          "-path",
          "-regex",
          "-type",
          "-maxdepth",
          "-mindepth",
          "-newer",
          "-newermt",
          "-mmin",
          "-mtime",
          "-size",
        ].includes(a)
      )
        i++;
      else if (a && ["-fprint", "-fls", "-fprintf"].includes(a)) {
        roles.push({ index: ++i, role: "write" });
      } else if (
        a &&
        [
          "-print",
          "-print0",
          "-delete",
          "-empty",
          "-depth",
          "-prune",
          "-a",
          "-o",
          "-and",
          "-or",
          "-not",
          "-L",
          "-H",
          "-P",
          "-x",
          "-s",
        ].includes(a)
      )
        continue;
      else if (a?.startsWith("-")) {
        issues.push(...unknownOperandIssues([a, argv[i + 1]]));
        roles.push({
          index: i,
          role: path,
          ...(a.includes("=") ? { literal: a.slice(a.indexOf("=") + 1) } : {}),
        });
        if (!a.includes("=") && argv[i + 1] !== undefined && !argv[i + 1]?.startsWith("-"))
          roles.push({ index: i + 1, role: path });
      } else if (a) roots.push(a);
    }
    return result();
  }
  while (position < argv.length) {
    if (skippedValues.has(position)) {
      position++;
      continue;
    }
    const a = argv[position];
    if (a === undefined) {
      if (["env", "forward", "timeout", "xargs"].includes(entry.semantics ?? ""))
        issues.push({
          kind: "missing-knowledge",
          rule: "opaque-executable",
          detail: "wrapper boundary is not literal",
        });
      positional.push(position++);
      if (
        entry.optionsBeforeOperands ||
        ["runtime", "python", "shell"].includes(entry.semantics ?? "")
      )
        endOptions = true;
      continue;
    }
    if (
      dialect === "bash" &&
      ((entry.optionGrammar === "echo" && !/^-[neE]+$/.test(a)) ||
        (entry.optionGrammar === "printf" && a !== "--" && !a.startsWith("-v")))
    )
      endOptions = true;
    if (a === "--" && !endOptions) {
      endOptions = true;
      position++;
      continue;
    }
    const modeName =
      entry.name === "npm" && a === "x" && mode === entry
        ? "exec"
        : entry.name === "git" && mode === entry
          ? a === "annotate"
            ? "blame"
            : ["range-diff", "format-patch"].includes(a)
              ? "log"
              : a
          : a;
    if (!endOptions && mode.subcommands?.[modeName]) {
      mode = mode.subcommands[modeName];
      effect = mode.effect ?? effect;
      if (entry.semantics === "git" && a === "config") {
        const query = argv
          .slice(position + 1)
          .filter(
            (word) =>
              !["--local", "--global", "--show-origin", "--get", "--get-all"].includes(word ?? ""),
          );
        const key = query[0];
        if (
          query.length === 1 &&
          key !== undefined &&
          (inertGitConfigKey(key) ||
            /^(?:credential\.helper|core\.(?:editor|pager)|remote\.[^.]+\.url)$/i.test(key))
        )
          effect = "none";
      }
      position++;
      continue;
    }
    const options =
      entry.semantics === "git" && mode !== entry
        ? {
            ...Object.fromEntries(
              Object.entries(entry.options ?? {}).filter(
                ([key, option]) =>
                  key.startsWith("--") &&
                  (option.issue ||
                    option.roles.some(
                      (role) =>
                        typeof role !== "string" ||
                        ["path", "content", "script", "env-name"].includes(role),
                    )),
              ),
            ),
            ...mode.options,
          }
        : { ...entry.options, ...mode.options };
    if (
      entry.name === "tar" &&
      position === 1 &&
      !endOptions &&
      /^[A-Za-z]+$/.test(a) &&
      [...a].some((letter) => "cxtru".includes(letter))
    ) {
      for (const letter of a) {
        if (!options[`-${letter}`]) issues.push(unknown(`unclassified tar option -${letter}`));
        if ("cru".includes(letter)) writesArchive = true;
        for (const role of options[`-${letter}`]?.roles ?? []) {
          const index = ++position;
          if (index >= argv.length) issues.push(unknown(`missing -${letter} argument`));
          optionRoles.push({ index, role });
          if (letter === "f") archiveFiles.push(index);
        }
      }
      position++;
      continue;
    }
    if (entry.semantics === "sed" && !endOptions && /^-[^-]/.test(a)) {
      const inPlaceIndex = a.indexOf("i", 1);
      if (
        inPlaceIndex > 0 &&
        a
          .slice(1, inPlaceIndex)
          .split("")
          .every((letter) => options[`-${letter}`]?.roles.length === 0)
      ) {
        for (const letter of a.slice(1, inPlaceIndex)) {
          const finding = options[`-${letter}`]?.issue;
          if (finding) issues.push(finding);
        }
        inPlaceBackupSuffix = a.slice(inPlaceIndex + 1);
        if (a === "-i" && argv[position + 1] === "") {
          sedEmptySuffix = true;
          position++;
        }
        position++;
        continue;
      }
    }
    if (entry.semantics === "shell" && !endOptions && /^-[euxs]*s/.test(a)) shellStdin = true;
    let optionName = a;
    let attached: string | undefined;
    const equal = dialect === "powershell" && /^-[^:]+:/.test(a) ? a.indexOf(":") : a.indexOf("=");
    if (a.startsWith("-") && equal > 0) {
      optionName = a.slice(0, equal);
      attached = a.slice(equal + 1);
    }
    if (!endOptions && !(optionName in options) && /^-[^-].+/.test(a)) {
      let offset = 1;
      const directoryWriter =
        entry.semantics === "copy" || ["mv", "install", "ln", "tar"].includes(entry.name);
      while (offset < a.length) {
        const option = options[`-${a[offset]}`];
        if (
          option?.roles.length ||
          (option?.attachedValue?.test(a.slice(offset + 1)) &&
            !a
              .slice(offset + 1)
              .split("")
              .every((letter) => `-${letter}` in options)) ||
          (!option && !directoryWriter)
        )
          break;
        if (!option) issues.push(unknown(`unclassified writer option -${a[offset]}`));
        if (entry.name === "tar" && ["c", "r", "u"].includes(a[offset] ?? "")) writesArchive = true;
        const finding = option?.issue;
        if (finding) issues.push(finding);
        offset++;
      }
      if (
        offset > 1 &&
        offset < a.length &&
        (options[`-${a[offset]}`]?.roles.length ||
          options[`-${a[offset]}`]?.attachedValue?.test(a.slice(offset + 1)))
      ) {
        optionName = `-${a[offset]}`;
        attached = offset + 1 < a.length ? a.slice(offset + 1) : undefined;
      }
    }
    if (!(optionName in options) && /^-[^-].+/.test(a)) {
      const prefix = a.slice(0, 2);
      if (options[prefix]?.roles.length || options[prefix]?.attachedValue?.test(a.slice(2))) {
        optionName = prefix;
        attached = a.slice(2);
      } else if (
        a
          .slice(1)
          .split("")
          .every((c) => options[`-${c}`]?.roles.length === 0)
      ) {
        for (const c of a.slice(1)) {
          if (entry.name === "tar" && "cru".includes(c)) writesArchive = true;
          const issue = options[`-${c}`]?.issue;
          if (issue) issues.push(issue);
        }
        position++;
        continue;
      }
    }
    const longOptions = optionName.startsWith("--")
      ? Object.entries(options).filter(([key]) => key.startsWith(optionName))
      : [];
    const option =
      options[optionName] ??
      (!entry.rejectsAbbreviations && longOptions.length === 1 ? longOptions[0]?.[1] : undefined) ??
      longOptions.find(
        ([, candidate]) =>
          candidate.issue || candidate.roles.some((role) => typeof role !== "string"),
      )?.[1] ??
      (dialect === "powershell"
        ? Object.entries(options).find(
            ([key]) => key.toLowerCase() === optionName.toLowerCase(),
          )?.[1]
        : undefined);
    if (option && !entry.rejectsAbbreviations && longOptions.length === 1 && !options[optionName])
      optionName = longOptions[0]?.[0] ?? optionName;
    if (
      !endOptions &&
      optionName.startsWith("--") &&
      !option &&
      attached !== undefined &&
      (entry.semantics === "copy" || ["mv", "ln", "install"].includes(entry.name))
    )
      writerCandidates.push({ index: position, literal: attached });
    if (entry.semantics === "git" && mode === entry && !endOptions && optionName === "-c") {
      const setting = attached ?? argv[position + 1];
      const settingEqual = setting?.indexOf("=") ?? -1;
      if (
        setting === undefined ||
        settingEqual < 1 ||
        !(
          inertGitConfigKey(setting.slice(0, settingEqual)) ||
          (/^(?:core|sequence)\.editor$/i.test(setting.slice(0, settingEqual)) &&
            ["true", ":", "false"].includes(setting.slice(settingEqual + 1)))
        )
      )
        issues.push(unknown("git config override"));
    }
    if (!endOptions && option && a.startsWith("-")) {
      if (
        entry.name === "tar" &&
        ["-c", "--create", "-r", "--append", "-u", "--update"].includes(optionName)
      )
        writesArchive = true;
      if (entry.name === "wget" && ["-O", "--output-document"].includes(optionName))
        wgetOutputDocument = true;
      if (entry.name === "wget" && ["-i", "--input-file"].includes(optionName))
        wgetInputFile = true;
      if (
        entry.name === "bun" &&
        ["--filter", "--cwd"].includes(optionName) &&
        (attached ?? argv[position + 1]) === undefined
      )
        issues.push(unknown("Bun option operand is not literal"));
      if (entry.name === "bun" && optionName === "--cwd") {
        if (cwdOperands.length) issues.push(unknown("repeated Bun working directory"));
        cwdOperands.push({
          index: attached === undefined ? position + 1 : position,
          ...(attached !== undefined ? { literal: attached } : {}),
        });
      }
      if (entry.name === "node" && optionName === "--test") testRunner = true;
      if (entry.semantics === "sed" && optionName === "--in-place")
        inPlaceBackupSuffix = attached ?? "";
      if (option.issue) issues.push(option.issue);
      if (["-e", "--expression", "--regexp", "-f", "--file"].includes(optionName))
        filterOption = true;
      for (let i = 0; i < option.roles.length; i++) {
        const role = option.roles[i] ?? data;
        const index = i === 0 && attached !== undefined ? position : ++position;
        if (entry.name === "wget" && ["-P", "--directory-prefix"].includes(optionName))
          wgetDirectoryPrefix = attached ?? argv[index];
        if (entry.name === "tar" && ["-f", "--file"].includes(optionName)) archiveFiles.push(index);
        if (
          index >= argv.length &&
          !(
            role === data &&
            ["--ws-error-highlight", "--color-moved-ws", "--line-prefix", "-l"].includes(optionName)
          )
        )
          issues.push(unknown(`missing ${optionName} argument`));
        if (
          entry.semantics === "awk" &&
          optionName === "-v" &&
          (attached ?? argv[index]) === undefined
        )
          issues.push(unknown("awk variable assignment is not literal"));
        if (
          ["git", "env"].includes(entry.semantics ?? "") &&
          ["-C", "--chdir", "--git-dir", "--work-tree"].includes(optionName) &&
          (entry.semantics !== "git" || mode === entry)
        )
          cwdOperands.push({ index, ...(attached !== undefined ? { literal: attached } : {}) });
        optionRoles.push({
          index,
          role,
          ...(entry.name === "rsync" &&
          typeof role !== "string" &&
          (attached ?? argv[index]) !== undefined
            ? { literal: `${attached ?? argv[index]} guard.invalid` }
            : i === 0 && attached !== undefined
              ? { literal: attached }
              : {}),
        });
        if (entry.semantics === "python" && optionName === "-m") {
          pythonModule = { index, name: attached ?? argv[index] };
          if (runtimeWrapper) endOptions = true;
        }
        if (typeof role !== "string") codeSeen = true;
        if (entry.semantics === "xargs") {
          const value = attached ?? argv[index];
          if (optionName === "-I") {
            replacement = value ?? null;
            if (!replacement) issues.push(unknown("xargs replacement is not literal"));
          }
          if (["-n", "-L", "-P"].includes(optionName)) {
            if (value === undefined || !/^[1-9][0-9]*$/.test(value) || Number(value) > 64)
              issues.push(unknown("xargs bound is not supported"));
            else if (optionName === "-n") maxArgs = Number(value);
            else if (optionName === "-L") maxLines = Number(value);
          }
          if (
            [replacement !== null, maxArgs !== null, maxLines !== null].filter(Boolean).length > 1
          )
            issues.push(unknown("combined xargs input modes"));
        }
        if (entry.semantics === "shell" && typeof role !== "string") {
          codePositionals = argv.slice(position + 1).map((_, n) => position + 1 + n);
          position = argv.length;
          break;
        }
      }
      position++;
      continue;
    }
    if (!endOptions && mode.numericOption && /^-[0-9]+$/.test(a)) {
      position++;
      continue;
    }
    if (!endOptions && a.startsWith("-") && a !== "-") {
      if (entry.name === "tar" && /^-[^-]$/.test(a))
        issues.push(unknown(`unclassified tar option ${a}`));
      optionRoles.push({
        index: position,
        role: path,
        ...(attached !== undefined ? { literal: attached } : {}),
      });
      issues.push(...unknownOperandIssues([a, ...argv.slice(position + 1)]));
      const next = argv[position + 1];
      if (attached === undefined && next !== undefined && !next.startsWith("-")) {
        optionRoles.push({ index: position + 1, role: path });
        if (
          (mode.subcommands ||
            ["forward", "env", "timeout", "xargs"].includes(entry.semantics ?? "")) &&
          !skippedValues.has(position + 1)
        ) {
          if (budget.remaining-- <= 0) issues.push(unknown("option arity analysis limit"));
          else {
            const alternative = classifyInvocation(
              argv,
              registry,
              dialect,
              runtimeWrapper,
              new Set([...skippedValues, position + 1]),
              budget,
            );
            roles.push(...alternative.roles);
            issues.push(...alternative.issues);
            children.push(...alternative.children);
            assignments.push(...alternative.assignments);
            cwdOperands.push(...alternative.cwdOperands);
            if (alternative.stdinCode) stdinCode = alternative.stdinCode;
            unknownStdinCode ||= alternative.refuseSuppliedStdin;
            if (alternative.delta !== "none" && alternative.delta !== delta)
              issues.push(unknown("ambiguous option state change"));
          }
        }
      }
      position++;
      continue;
    }
    if (entry.name === "git" && mode === entry.subcommands?.bisect?.subcommands?.run) {
      child(position);
      break;
    }
    if (entry.name === "git" && mode === entry.subcommands?.submodule?.subcommands?.foreach) {
      const body = argv.slice(position);
      if (body.some((word) => word === undefined))
        issues.push(unknown("submodule shell body is not literal"));
      else roles.push({ index: position, role: code("bash"), literal: body.join(" ") });
      break;
    }
    if (entry.semantics === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) {
      const eq = a.indexOf("=");
      assignments.push({ name: a.slice(0, eq), index: position, value: a.slice(eq + 1) });
      position++;
      continue;
    }
    if (
      ["forward", "env", "xargs"].includes(entry.semantics ?? "") ||
      (["uv", "conda"].includes(entry.name) && mode === entry.subcommands?.run)
    ) {
      children.push({
        start: position,
        end: argv.length,
        appendInput: entry.semantics === "xargs",
        placeholder: replacement,
        findRoots: null,
        runtimeWrapper: true,
      });
      position = argv.length;
      break;
    }
    if (entry.semantics === "timeout" && positional.length === 1) {
      children.push({
        start: position,
        end: argv.length,
        appendInput: false,
        placeholder: null,
        findRoots: null,
        runtimeWrapper: true,
      });
      position = argv.length;
      break;
    }
    if (testRunner && endOptions && a.startsWith("-"))
      issues.push(unknown("test runner option after file operand"));
    if (mode.subcommands && entry.name !== "brew") {
      unknownSubcommandStart = position;
      mode = { operands: [path], options: { ...entry.options, ...mode.options } };
    }
    if (entry.name === "brew" && mode === entry) mode = { operands: [data] };
    positional.push(position++);
    if (
      entry.optionsBeforeOperands ||
      ["runtime", "python", "shell"].includes(entry.semantics ?? "")
    )
      endOptions = true;
  }
  if (unknownSubcommandStart !== null) {
    const previous = argv[unknownSubcommandStart - 1];
    const start =
      previous?.startsWith("-") && previous !== "--" && !previous.includes("=")
        ? unknownSubcommandStart - 1
        : unknownSubcommandStart;
    issues.push(
      ...unknownOperandIssues(
        argv
          .slice(start)
          .filter(
            (_, offset) =>
              !optionRoles.some(
                (operand) => operand.index === start + offset && operand.role === data,
              ),
          ),
      ),
    );
  }
  if (
    entry.name === "docker" &&
    mode === entry.subcommands?.compose?.subcommands?.config &&
    argv.some((word) =>
      ["--services", "--volumes", "--profiles", "--images", "-q", "--quiet"].includes(word ?? ""),
    )
  )
    effect = "none";
  if (effect && effect !== "none") issues.push(effect);
  if (!positional.length && !children.length && !codeSeen && entry.bare) issues.push(entry.bare);
  roles.push(...optionRoles);
  const operands =
    (filterOption && ["sed", "awk"].includes(entry.semantics ?? "")) ||
    (filterOption &&
      (entry.name === "grep" || (entry.semantics === "git" && argv.includes("grep"))))
      ? [path]
      : mode.operands;
  for (let i = 0; i < positional.length; i++)
    roles.push({
      index: positional[i] ?? 0,
      role: shellStdin
        ? data
        : testRunner
          ? "script"
          : (operands[Math.min(i, operands.length - 1)] ?? path),
    });
  if (entry.name === "dd")
    for (const operand of roles) {
      if (optionRoles.includes(operand)) continue;
      const value = argv[operand.index] ?? "";
      if (value.startsWith("if=")) {
        operand.role = "content";
        operand.literal = value.slice(3);
      } else if (value.startsWith("of=")) {
        operand.role = "write";
        operand.literal = value.slice(3);
      } else if (!/^(?:bs|ibs|obs|count|skip|seek|conv|iflag|oflag|status)=/.test(value))
        issues.push(unknown("unsupported dd operand"));
    }
  if (
    entry.name === "npm" &&
    (mode === entry.subcommands?.run || mode === entry.subcommands?.["run-script"]) &&
    argv[positional[0] ?? -1] === "env"
  )
    issues.push(source("npm environment listing"));
  if (
    entry.name === "npm" &&
    mode === entry.subcommands?.exec &&
    !codeSeen &&
    positional[0] !== undefined
  )
    child(positional[0]);
  if (["man", "info", "tldr"].includes(entry.name))
    for (const operand of roles)
      if (operand.role === data && /[/]/.test(argv[operand.index] ?? "")) operand.role = "content";
  if (["view", "less"].includes(entry.name))
    for (const operand of roles)
      if ((argv[operand.index] ?? "").startsWith("+")) operand.role = code("runtime");
  if (entry.name === "make")
    for (const index of positional) {
      const assignment = /^([^\s=:+?!]+)(?:::?|\+|\?|!)?=(.*)$/s.exec(argv[index] ?? "");
      if (!assignment) continue;
      const value = assignment[2] ?? "";
      if (
        ["SHELL", ".SHELLFLAGS", "MAKESHELL"].includes(assignment[1] ?? "") ||
        (argv[index] ?? "").includes("!=")
      )
        roles.push({ index, role: code("runtime") });
      else {
        roles.push({ index, role: path, literal: value });
        issues.push(...unknownOperandIssues(value.split(/\s+/)));
      }
    }
  if (name === "rg" && argv.includes("--files")) {
    for (const operand of roles)
      if (
        operand.role === "path" &&
        !optionRoles.some(
          (option) =>
            option.index === operand.index &&
            !["-g", "--glob", "--iglob"].some(
              (flagName) =>
                argv[operand.index - 1] === flagName || argv[operand.index]?.startsWith(flagName),
            ),
        )
      )
        operand.role = "names";
  }
  if (entry.name === "bun") {
    const commandIndex = positional[0];
    const command = commandIndex === undefined ? undefined : argv[commandIndex];
    if (commandIndex !== undefined && command === "exec") {
      const start = argv[commandIndex + 1] === "-c" ? commandIndex + 2 : commandIndex + 1;
      if (argv.length === start + 1) roles.push({ index: start, role: code("bash") });
      else issues.push(unknown("bun exec shell body"));
    } else if (command === "repl") {
      issues.push(unknown("interactive runtime code"));
    } else if (commandIndex !== undefined && command === "test") {
      for (const operand of roles)
        if (operand.index > commandIndex && (operand.role === "path" || operand.role === "script"))
          operand.role = "test-filter";
    } else if (commandIndex !== undefined && command === "run") {
      for (let index = commandIndex + 1; index < argv.length; index++)
        roles.push({ index, role: "script" });
    }
    const scriptIndex = command === "run" ? (commandIndex ?? 0) + 1 : commandIndex;
    const script = scriptIndex === undefined ? "" : (argv[scriptIndex] ?? "");
    const wrapperName =
      /^(?:agent-tools-(gh|db|k8s|vault|az|logs)|(gh|db|k8s|vault|az|logs)-tool)$/.exec(
        executableName(script),
      );
    if (wrapperName && scriptIndex !== undefined) {
      const projectTool = wrapperName[1] ?? wrapperName[2];
      const dataOptions: Readonly<Record<string, readonly string[]>> = {
        gh: ["--title", "--body", "--comment", "--head", "--base"],
        db: ["--sql"],
        k8s: ["--cmd"],
        az: ["--cmd"],
        logs: [],
        vault: [],
      };
      const options = dataOptions[projectTool ?? ""] ?? [];
      const fileOptions =
        projectTool === "gh" ? ["--body-file", "--comment-file", "--notes-file", "-F"] : [];
      for (let index = scriptIndex + 1; index < argv.length; index++) {
        const word = argv[index];
        const optionKey = word?.split("=")[0] ?? "";
        if (options.includes(optionKey) || fileOptions.includes(optionKey)) {
          const valueIndex = word?.includes("=") ? index : ++index;
          for (let n = roles.length - 1; n >= 0; n--)
            if (roles[n]?.index === valueIndex) roles.splice(n, 1);
          roles.push({
            index: valueIndex,
            role: fileOptions.includes(optionKey) ? "content" : data,
            ...(word?.includes("=") ? { literal: word.slice(word.indexOf("=") + 1) } : {}),
          });
        }
      }
      if (
        projectTool === "vault" &&
        argv[scriptIndex + 1] === "kv" &&
        argv[scriptIndex + 2] === "keys"
      ) {
        for (const operand of roles) if (operand.index > scriptIndex) operand.role = "names";
      }
    }
    if (command?.startsWith("-")) issues.push(unknown("Bun entry point begins with an option"));
  }
  if (inPlaceBackupSuffix !== null) {
    for (const operand of roles) if (operand.role === "path") operand.role = "write";
    if ((sedEmptySuffix || positional.length === 1) && !filterOption && positional[0] !== undefined)
      roles.push({ index: positional[0], role: "write" });
  }
  if (entry.name === "install") {
    const separator = argv.indexOf("--");
    const candidates = argv.flatMap((word, index) =>
      index > 0 && ((separator >= 0 && index > separator) || !word?.startsWith("-")) ? [index] : [],
    );
    for (const index of candidates) {
      roles.push({ index, role: path }, { index, role: "write" });
      directoryWrites.push({ index, sources: candidates, directory: true });
    }
    for (const operand of optionRoles)
      if (operand.role === "write")
        directoryWrites.push({ index: operand.index, sources: candidates, directory: true });
  }
  if (entry.name === "git" && mode === entry.subcommands?.checkout) {
    const separator = argv.indexOf("--");
    for (const operand of roles)
      if (separator >= 0 ? operand.index > separator : positional.slice(1).includes(operand.index))
        operand.role = "write";
  }
  if (entry.name === "tar" && writesArchive) {
    for (const operand of optionRoles)
      if (archiveFiles.includes(operand.index)) operand.role = "write";
  }
  if (entry.name === "wget" && !wgetOutputDocument) {
    if (
      wgetInputFile &&
      (wgetDirectoryPrefix === undefined ||
        !/^\/(?:tmp|private\/tmp|(?:private\/)?var\/folders)(?:\/|$)/.test(wgetDirectoryPrefix) ||
        wgetDirectoryPrefix.split("/").includes(".."))
    )
      issues.push(unknown("wget input file output names are not known"));
    for (const index of positional) {
      const url = argv[index];
      if (url === undefined || wgetDirectoryPrefix === undefined)
        issues.push(unknown("wget output name is not known"));
      else {
        try {
          const basename = new URL(url).pathname.split("/").at(-1);
          if (basename)
            roles.push({
              index,
              role: "write",
              literal: `${wgetDirectoryPrefix}/${decodeURIComponent(basename)}`,
            });
        } catch {
          issues.push(unknown("wget output name is not known"));
        }
      }
    }
  }
  if (
    entry.semantics === "copy" ||
    ["mv", "ln", "rsync", "ditto"].includes(entry.name) ||
    (entry.name === "tmutil" && mode === entry.subcommands?.restore)
  ) {
    const targetDirectory = optionRoles.find((operand) => operand.role === "write");
    const destination = targetDirectory?.index ?? positional.at(-1);
    if (destination !== undefined) {
      const role = roles.find((item) => item.index === destination);
      if (role) roles.splice(roles.indexOf(role), 1);
      roles.push(targetDirectory ?? { index: destination, role: "write" });
      if (!argv.some((word) => word === "-T" || word === "--no-target-directory"))
        directoryWrites.push({
          index: destination,
          sources: targetDirectory ? positional : positional.slice(0, -1),
          directory: targetDirectory !== undefined || positional.length > 2,
        });
    }
  }
  for (const candidate of writerCandidates) {
    roles.push({ ...candidate, role: path }, { ...candidate, role: "write" });
    directoryWrites.push({
      index: candidate.index,
      sources: [candidate.index, ...positional],
      directory: true,
    });
  }
  stdout = mode.stdout ?? entry.stdout ?? "opaque";
  if (stdout === "stdin" && (entry.name !== "cat" || argv.length !== 1)) stdout = "opaque";
  if (
    stdout === "arguments" &&
    argv.slice(1).some((value) => value?.startsWith("-") || value?.includes("\\"))
  )
    stdout = "opaque";
  if (entry.semantics === "cd") {
    delta = "cd";
    if (positional.some((index) => argv[index] === "-"))
      issues.push(unknown("cd previous directory is not known"));
    cwdOperands.push({ index: positional[0] ?? 1 });
  }

  if (
    entry.semantics === "ps" &&
    argv.slice(1).some((a, i) => {
      const operand = optionRoles.find((role) => role.index === i + 1);
      return operand
        ? /(?:^|[,=])(?:env|environ|environment)(?:[,=]|$)/i.test(operand.literal ?? a ?? "")
        : a !== undefined && /^(?:-?[A-Za-z]*e[A-Za-z]*|--?environ.*)$/.test(a);
    })
  )
    issues.push(source("process environments"));
  if (entry.semantics === "listing" || entry.semantics === "env-provider") {
    if (argv.some((a) => /^env:/i.test(a ?? "")))
      issues.push(source("PowerShell environment provider"));
  }
  if (entry.semantics === "herdr") {
    const separator = argv.indexOf("--");
    const commandIndex = argv.findIndex(
      (word, index) =>
        (separator < 0 || index < separator) &&
        ((word === "agent" && argv[index + 1] === "start") ||
          (["tab", "window", "pane"].includes(word ?? "") &&
            ["create", "split", "run", "send-keys", "send-text"].includes(argv[index + 1] ?? ""))),
    );
    const command = argv[commandIndex];
    const action = argv[commandIndex + 1];
    const checkAgentArguments = (kind: string | undefined, start: number): void => {
      for (let index = start; index < argv.length; index++) {
        const argument = argv[index] ?? "";
        if (index === argv.length - 1 && argv[index] !== undefined && !argument.startsWith("-"))
          return;
        const attached = /^(--[^=]+)=(.*)$/.exec(argument) ?? /^(-[mcCs])=?(.+)$/.exec(argument);
        const option = attached?.[1] ?? argument;
        const value = attached ? attached[2] : argv[++index];
        const configuration =
          value !== undefined &&
          (/^model_reasoning_effort=(?:minimal|low|medium|high|xhigh|max)$/.test(value) ||
            /^sandbox_workspace_write\.network_access=(?:true|false)$/.test(value) ||
            /^shell_environment_policy\.set\.HERDR_ENV="1"$/.test(value) ||
            /^shell_environment_policy\.set\.HERDR_(?:WORKSPACE_ID|TAB_ID|PANE_ID|SOCKET_PATH)="[^"\\\r\n]*"$/.test(
              value,
            ));
        const supported =
          value !== undefined &&
          (option === "--prompt" || (value !== "" && !value.startsWith("-"))) &&
          ((["--model", "--add-dir", "--prompt"].includes(option) &&
            ["codex", "claude"].includes(kind ?? "")) ||
            (kind === "codex" &&
              (["-m", "--cd", "-C"].includes(option) ||
                (["--sandbox", "-s"].includes(option) &&
                  ["workspace-write", "read-only"].includes(value)) ||
                (option === "-c" && configuration))));
        if (!supported) {
          issues.push({
            kind: "missing-knowledge",
            rule: "agent-launch-override",
            detail: "native agent arguments must use the supported launch form",
          });
          return;
        }
      }
    };
    if (command === "agent" && action === "start" && separator >= 0) {
      let kind: string | undefined;
      for (let index = commandIndex + 2; index < separator; index++) {
        if (argv[index] === "--kind") kind = argv[index + 1];
        else if (argv[index]?.startsWith("--kind=")) kind = argv[index]?.slice(7);
      }
      checkAgentArguments(kind, separator + 1);
    }
    if (
      ["tab", "window", "pane"].includes(command ?? "") &&
      ["create", "split"].includes(action ?? "")
    ) {
      if (separator >= 0) {
        const kind = executableName(argv[separator + 1] ?? "");
        if (["codex", "claude"].includes(kind)) checkAgentArguments(kind, separator + 2);
        child(separator + 1);
      }
      const bodyIndex = argv.findIndex((value) => value === "--command");
      if (bodyIndex >= 0) roles.push({ index: bodyIndex + 1, role: code("bash") });
    }
    if (command === "pane" && ["run", "send-keys", "send-text"].includes(action ?? ""))
      issues.push(unknown("Herdr execution in unknown terminal"));
  }
  if (entry.semantics === "python") {
    if (argv.some((value) => value?.startsWith("-W") || value?.startsWith("-X")))
      issues.push(unknown("Python startup module option"));
    const module = pythonModule;
    if (module !== null) {
      if (module.name === "py_compile") {
        roles.splice(
          0,
          roles.length,
          ...argv
            .slice(module.index + 1)
            .map((_, n) => ({ index: module.index + 1 + n, role: path })),
        );
      } else if (
        !runtimeWrapper ||
        module.name === undefined ||
        [
          "timeit",
          "code",
          "pdb",
          "trace",
          "cProfile",
          "profile",
          "runpy",
          "idlelib",
          "doctest",
          "IPython",
          "bpython",
          "ptpython",
          "xonsh",
          "asyncio",
          "sqlite3",
        ].includes(module.name)
      )
        issues.push(unknown("Python module code"));
    } else if (
      !codeSeen &&
      !argv.includes("--version") &&
      !argv.includes("--help") &&
      (!positional.length || positional.some((i) => isStdinScript(argv[i] ?? "")))
    )
      stdinCode = "runtime";
  }
  if (
    entry.semantics === "runtime" &&
    ((!positional.length && !testRunner) || positional.some((i) => isStdinScript(argv[i] ?? ""))) &&
    !argv.includes("--version") &&
    !argv.includes("--help") &&
    !codeSeen
  )
    stdinCode = "runtime";
  if (entry.semantics === "shell" && !codeSeen && (shellStdin || !positional.length))
    stdinCode = "bash";
  if (entry.semantics === "joined-shell" || entry.semantics === "remote-shell") {
    const indexes = positional.slice(entry.semantics === "remote-shell" ? 1 : 0);
    const parts = indexes.map((i) => argv[i]);
    roles.splice(0, roles.length, ...optionRoles);
    const connectionOnly =
      entry.semantics === "remote-shell" &&
      positional.length === 1 &&
      argv[positional[0] ?? 0] !== undefined;
    if (!connectionOnly) {
      if (!parts.length || parts.some((part) => part === undefined))
        issues.push(unknown("joined shell command is not literal"));
      else roles.push({ index: indexes[0] ?? 0, role: code("bash"), literal: parts.join(" ") });
    }
  }
  if (entry.semantics === "eval") {
    roles.splice(0);
    issues.push(unknown("eval joins and reparses shell words"));
  }
  if (entry.semantics === "curl") {
    if (argv.some((a) => a?.includes("dev.azure.com")))
      issues.push(wrapper("curl (Azure DevOps)", "agent-tools-azdo"));
    const fileSelectors = [
      ...optionRoles.map((item) => ({ index: item.index, text: item.literal ?? argv[item.index] })),
      ...argv.slice(1).map((text, i) => ({ index: i + 1, text })),
    ];
    for (const selector of fileSelectors) {
      if (selector.text === undefined) {
        issues.push(unknown("curl operand is not literal"));
        continue;
      }
      const match = /(?:^|=)@([^;]+)|=<([^;]+)/.exec(selector.text);
      if (match)
        roles.push({ index: selector.index, role: path, literal: match[1] ?? match[2] ?? "" });
      if (/^file:/i.test(selector.text))
        roles.push({ index: selector.index, role: path, literal: selector.text });
    }
  }
  if (entry.name === "grep") {
    const types = new Map<string, readonly string[]>(Object.entries(rgTypes));
    for (const operand of optionRoles) {
      if (
        argv[operand.index - 1] === "--type-add" ||
        argv[operand.index]?.startsWith("--type-add=")
      ) {
        const spec = operand.literal ?? argv[operand.index];
        const colon = spec?.indexOf(":") ?? -1;
        if (spec === undefined || colon < 1 || spec.slice(colon + 1).startsWith("include:"))
          issues.push(unknown("unsupported rg type definition"));
        else {
          const key = spec.slice(0, colon);
          const pattern = spec.slice(colon + 1);
          types.set(key, [...(types.get(key) ?? []), pattern]);
          if (!argv.includes("--files"))
            roles.push({ index: operand.index, role: "path-pattern", literal: pattern });
        }
      }
    }
    for (const operand of roles)
      if (operand.role === "rg-type") {
        operand.role = data;
        const patterns = types.get(operand.literal ?? argv[operand.index] ?? "");
        if (!patterns) issues.push(unknown("unknown rg type"));
      }
  }
  if (entry.name === "grep" && !(name === "rg" && argv.includes("--files"))) {
    for (const operand of roles) {
      const word = argv[operand.index] ?? "";
      if (
        ["-g", "--glob", "--iglob", "--include"].includes(argv[operand.index - 1] ?? "") ||
        /^(?:--glob|--iglob|--include)=/.test(word) ||
        /^-g./.test(word)
      )
        operand.role =
          name !== "rg" &&
          (argv[operand.index - 1] === "--include" || word.startsWith("--include="))
            ? "search-filter"
            : "path-pattern";
    }
  }
  if (entry.name === "grep") {
    const recursive =
      name === "rg" ||
      argv.some((word) => /^-[^-]*[rR]/.test(word ?? "") || word === "--recursive");
    for (const operand of roles)
      if (operand.role === "path" && recursive && name !== "rg" && !optionRoles.includes(operand))
        operand.role = "search-filter";
      else if (
        operand.role === "path" &&
        (!recursive || /\.[^/]+$/.test(operand.literal ?? argv[operand.index] ?? ""))
      )
        operand.role = "content";
  }
  if (entry.name === "git" && mode === entry.subcommands?.grep) {
    const pathspecs = roles.filter((operand) => operand.role === path);
    if (
      argv.some((word) => word === "--no-index" || word === "--untracked") &&
      !pathspecs.some((operand) => {
        const value = operand.literal ?? argv[operand.index];
        return value !== undefined && value !== "." && !/[*?[{:]/.test(value);
      })
    )
      issues.push(unknown("git grep unrestricted content search"));
    for (const operand of pathspecs) {
      const value = operand.literal ?? argv[operand.index];
      if (/^:[!^]/.test(value ?? "")) {
        operand.role = data;
        continue;
      }
      if (value?.startsWith(":(")) {
        const magic = /^:\(([^)]+)\)(.*)$/.exec(value);
        if (
          !magic ||
          !(magic[1] ?? "")
            .split(",")
            .every((modifier) =>
              ["glob", "icase", "top", "literal", "exclude", "!", "^"].includes(modifier),
            )
        )
          issues.push(unknown("unsupported git pathspec magic"));
        else if (
          (magic[1] ?? "").split(",").some((modifier) => ["exclude", "!", "^"].includes(modifier))
        ) {
          operand.role = data;
          continue;
        } else operand.literal = magic[2] ?? "";
      }
      const pattern = operand.literal ?? value;
      if (pattern !== undefined && /(?:^|\/)\.[^/]*[*?[]/.test(pattern))
        operand.role = "path-pattern";
      else if (!argv.some((word) => word === "--untracked" || word === "--no-index"))
        operand.role = "search-filter";
      else if (pattern !== undefined && /[*?[{}]/.test(pattern)) operand.role = "path-pattern";
      else if (pattern !== undefined && /\.[^/]+$/.test(pattern)) operand.role = "content";
    }
  }
  if (entry.name === "git" && mode === entry.subcommands?.diff && argv.includes("--no-index"))
    for (const operand of roles) if (operand.role === path) operand.role = "content";
  const contentReader =
    mode.readsContent ??
    entry.readsContent ??
    (entry.semantics === "copy" &&
      !argv.some(
        (word) =>
          /^-[^-]*[rRa]/.test(word ?? "") || ["--recursive", "--archive"].includes(word ?? ""),
      ));
  if (contentReader)
    for (const operand of roles)
      if (
        operand.role === "path" &&
        (entry.semantics !== "git" ||
          !argv.includes("grep") ||
          /\.[^/]+$/.test(operand.literal ?? argv[operand.index] ?? "")) &&
        (entry.semantics !== "git" ||
          !["show", "cat-file"].some((command) => argv.includes(command)) ||
          (operand.literal ?? argv[operand.index] ?? "").includes(":"))
      )
        operand.role = "content";
  return result();
}

export function analyzeCode(
  language: Exclude<Language, "bash" | "powershell">,
  text: string,
): readonly Issue[] {
  if (language === "runtime") return [unknown("inline runtime code has no analyzer")];
  if (language === "jq") {
    if (isPassiveJqFilter(text)) return [];
    if (/(?:\$ENV\b|\benv\b)/.test(text)) return [source("jq environment")];
    return [unknown("jq syntax outside passive grammar")];
  }
  if (language === "awk") {
    if (/\bENVIRON\b/.test(text)) return [source("awk environment")];
    return isPassiveAwkProgram(text) ? [] : [unknown("awk syntax outside passive grammar")];
  }
  return isPassiveSedProgram(text) ? [] : [unknown("sed syntax outside passive grammar")];
}
