import { posix } from "node:path";

export const CODE_OR_PROSE_EXTENSION =
  /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|cs|py|go|rs|java|kt|rb|php|sh|md|mdx)$/i;

export const DEFAULT_BLOCKED_PATH_PATTERNS: RegExp[] = [
  /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?(?![^/]*\.pub$)(?:[-_.][^/]*|~)?$/i,
  /(?:^|\/)\.htpasswd(?:~|\.bak|\.orig)?$/i,
  /(?:^|\/)service-account[^/]*\.json$/i,
  /\.env$/,
  /\.env\.[^./]+$/,
  /(?:^|\/)\.env(?!\.(?:example|sample|template))[^/]*(?:\/|$)/i,
  /(?:^|\/)(?:\.netrc|_netrc|\.npmrc|\.pypirc|\.pgpass|\.my\.cnf|\.vault-token|\.sentryclirc)(?:~|\.bak|\.orig)?$/i,
  /(?:^|\/)\.docker\/config\.json(?:~|\.bak|\.orig)?$/i,
  /(?:^|\/)\.config\/(?:gh\/hosts\.yml|hub)(?:~|\.bak|\.orig)?$/i,
  /(?:^|\/)\.m2\/settings\.xml(?:~|\.bak|\.orig)?$/i,
  /(?:^|\/)\.composer\/auth\.json(?:~|\.bak|\.orig)?$/i,
  /\.(?:pem|key|p12|pfx)(?:~|\.bak|\.orig)?$/i,
  /(?:^|\/)(?:secrets?|credentials?)(?:\/|$)/i,
  /(?:^|\/)\.(?:aws|ssh|kube|gnupg|azure)(?:\/|$)/i,
  /(?:^|\/)(?:kubeconfig[^/]*|(?![^/]+\.md(?![\s\S]))[^/]*kubeconfig[^/]*)(?:\/|$)/i,
];

export const DEFAULT_ALLOWED_PATH_PATTERNS: RegExp[] = [
  /\.env\.(?:example|template|sample)[^/]*$/i,
];

const PROCESS_ENVIRONMENT_PATH =
  /^(?:\/|(?:\.\.\/)*)proc\/(?:self|thread-self|[0-9]+|\$\$|\$\{\$\})(?:\/task\/(?:[0-9]+|\$\$|\$\{\$\}))?\/environ$/;

export type PathContext = {
  readonly home: string;
  readonly cwd: string;
  readonly contentRead?: boolean;
  readonly additionalBlockedPaths?: readonly RegExp[];
  readonly additionalAllowedPaths?: readonly RegExp[];
};
export function normalizePath(path: string, home = "~", cwd = "."): string {
  let value = path.replace(/\\/g, "/").replace(/^file:\/\//i, "");
  value = value.replace(
    /^(?:~(?=\/|$)|%USERPROFILE%|%HOME%|\$HOME|\$\{HOME\}|\$env:USERPROFILE)/i,
    home.replace(/\\/g, "/"),
  );
  if (/^(?:env:|(?:microsoft\.powershell\.core\/)?environment::)/i.test(value))
    return value.toLowerCase();
  value = value
    .split("/")
    .map((segment, index) => {
      if (segment === "." || segment === ".." || (index === 0 && /^[A-Za-z]:$/.test(segment)))
        return segment;
      return segment.split(":")[0]?.replace(/[. ]+$/, "") ?? "";
    })
    .join("/");
  if (!value.startsWith("/") && !/^[A-Za-z]:\//.test(value))
    value = `${cwd.replace(/\\/g, "/")}/${value}`;
  return posix.normalize(value).toLowerCase();
}
function matches(pattern: RegExp, value: string): boolean {
  return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")).test(value);
}
export function isSensitivePath(path: string, context: PathContext): boolean {
  const normalized = normalizePath(path, context.home, context.cwd);
  if (
    /^(?:env:|(?:microsoft\.powershell\.core\/)?environment::)/i.test(normalized) ||
    PROCESS_ENVIRONMENT_PATH.test(normalized) ||
    PROCESS_ENVIRONMENT_PATH.test(
      path
        .replace(/\\/g, "/")
        .replace(/^(?:\.\/)+/, "")
        .toLowerCase(),
    )
  )
    return true;
  const allowed = [...DEFAULT_ALLOWED_PATH_PATTERNS, ...(context.additionalAllowedPaths ?? [])];
  const raw = path.replace(/\\/g, "/");
  if (allowed.some((pattern) => matches(pattern, normalized) || matches(pattern, raw)))
    return false;
  const basename = raw.split("/").at(-1) ?? "";
  if (
    context.contentRead !== false &&
    /secret|credential|token|password|passwd|api[-_]?key|private[-_]key/i.test(basename) &&
    !CODE_OR_PROSE_EXTENSION.test(basename)
  )
    return true;
  return [...DEFAULT_BLOCKED_PATH_PATTERNS, ...(context.additionalBlockedPaths ?? [])].some(
    (pattern) => matches(pattern, normalized) || matches(pattern, raw),
  );
}

export function expandGlobAlternatives(pattern: string): readonly string[] | null {
  if (/[[]/.test(pattern)) return null;
  let variants = [""];
  let rest = pattern;
  while (rest.includes("{")) {
    const start = rest.indexOf("{");
    const end = rest.indexOf("}", start);
    if (end < 0) return null;
    const inner = rest.slice(start + 1, end);
    if (inner.includes("{") || !inner.includes(",")) return null;
    const choices = inner.split(",");
    if (variants.length * choices.length > 64) return null;
    const prefix = rest.slice(0, start);
    variants = variants.flatMap((value) => choices.map((choice) => value + prefix + choice));
    rest = rest.slice(end + 1);
  }
  const result = variants.map((value) => value + rest);
  return result.some((value) => /[{}[]/.test(value)) ? null : result;
}
