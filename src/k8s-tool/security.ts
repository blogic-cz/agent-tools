import { posix } from "node:path";

export const ALLOWED_KUBECTL_VERBS = [
  "get",
  "describe",
  "logs",
  "top",
  "explain",
  "api-resources",
  "api-versions",
  "version",
  "cluster-info",
  "auth",
  "wait",
  "exec",
  "config",
] as const;
export const BLOCKED_KUBECTL_VERBS = [
  "delete",
  "drain",
  "cordon",
  "uncordon",
  "taint",
  "apply",
  "patch",
  "edit",
  "replace",
  "create",
  "scale",
  "rollout",
  "set",
  "label",
  "annotate",
  "expose",
  "autoscale",
  "run",
  "cp",
] as const;

export type K8sSecurityCheckResult = {
  allowed: boolean;
  command: string;
  argv?: string[];
  reason?: string;
  hint?: string;
  verb?: string;
};

export function parseKubectlCommand(cmd: string): string[] | undefined {
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
    } else if (char === "'" || char === '"') quote = char;
    else if (/[$`;&|<>()[\]]/.test(char)) return undefined;
    else if (/\s/.test(char)) {
      if (word) {
        argv.push(word);
        word = "";
      }
    } else word += char;
  }
  if (quote || escaped) return undefined;
  if (word) argv.push(word);
  return argv.length ? argv : undefined;
}

const flagsWithValues = new Set([
  "-n",
  "--namespace",
  "-o",
  "--output",
  "-l",
  "--selector",
  "--field-selector",
  "-L",
  "--label-columns",
  "--chunk-size",
  "--sort-by",
  "--subresource",
  "--template",
  "--context",
  "--kubeconfig",
  "--request-timeout",
  "-s",
  "--server",
  "--as",
  "--as-group",
  "--as-uid",
  "--token",
  "--certificate-authority",
  "--cache-dir",
  "--client-certificate",
  "--client-key",
  "--cluster",
  "--password",
  "--profile",
  "--profile-output",
  "--tls-server-name",
  "--user",
  "--username",
]);
const controlledFlags = new Set([
  "-s",
  "--context",
  "--kubeconfig",
  "--server",
  "--token",
  "--user",
  "--username",
  "--password",
  "--profile",
  "--profile-output",
  "--as",
  "--as-group",
  "--as-uid",
  "--certificate-authority",
  "--client-certificate",
  "--client-key",
  "--cluster",
  "--tls-server-name",
  "--insecure-skip-tls-verify",
  "--insecure-skip-tls-verify-backend",
]);
const attachedShortValueFlags = ["-n", "-o", "-l", "-L"] as const;
const flagsWithoutValues = new Set([
  "-A",
  "--all-namespaces",
  "--allow-missing-template-keys",
  "--ignore-not-found",
  "--no-headers",
  "--output-watch-events",
  "-R",
  "--recursive",
  "--server-print",
  "--show-events",
  "--show-kind",
  "--show-labels",
  "--show-managed-fields",
  "--use-openapi-print-columns",
  "-w",
  "--watch",
  "--watch-only",
]);
const isSecretResourceType = (resource: string) => /^secrets?(?:\.[^/]*)?(?:\/|$)/i.test(resource);
const isSecretResource = (resource: string) => resource.split(",").some(isSecretResourceType);
const isOnlySecretResource = (resource: string) => resource.split(",").every(isSecretResourceType);

const readOnlyKubectlOperations = [...ALLOWED_KUBECTL_VERBS, "rollout status|history"];

const prefixValueFlags = new Set([
  "-n",
  "--namespace",
  "--request-timeout",
  "--context",
  "-o",
  "--output",
  "-v",
  "--v",
  "-l",
  "--selector",
  "--log-flush-frequency",
]);
const prefixBooleanFlags = new Set([
  "--match-server-version",
  "--warnings-as-errors",
  "--disable-compression",
]);
const secretValueFlags = new Set([
  "-n",
  "--namespace",
  "-l",
  "--selector",
  "--field-selector",
  "-L",
  "--label-columns",
  "--chunk-size",
  "--request-timeout",
  "-o",
  "--output",
]);
const secretBooleanFlags = new Set([
  "-A",
  "--all-namespaces",
  "--no-headers",
  "--show-labels",
  "--ignore-not-found",
  "--show-kind",
]);
const rolloutValueFlags = new Set([
  "-n",
  "--namespace",
  "--timeout",
  "--revision",
  "-l",
  "--selector",
  "--request-timeout",
]);

function readFlag(
  argv: string[],
  index: number,
  values: Set<string>,
  booleans: Set<string>,
): { next: number; flag: string; value?: string } | undefined {
  const arg = argv[index];
  if (!arg) return undefined;
  const equal = arg.indexOf("=");
  const exact = equal < 0 ? arg : arg.slice(0, equal);
  if (booleans.has(exact)) {
    if (equal >= 0 && !["true", "false"].includes(arg.slice(equal + 1))) return undefined;
    return { next: index + 1, flag: exact };
  }
  let flag = exact;
  let value = equal < 0 ? undefined : arg.slice(equal + 1);
  if (!values.has(flag)) {
    const short = arg.slice(0, 2);
    if (arg.startsWith("--") || !values.has(short) || arg.length <= 2) return undefined;
    flag = short;
    value = arg.slice(2).replace(/^=/, "");
  }
  const next = value === undefined ? index + 2 : index + 1;
  value ??= argv[index + 1];
  if (!value || value.startsWith("-")) return undefined;
  return { next, flag, value };
}

function closedReadArgs(argv: string[], start: number, rollout: boolean): boolean {
  const values = new Set(rollout ? rolloutValueFlags : secretValueFlags);
  if (rollout && argv[start - 1] === "history") {
    values.add("-o");
    values.add("--output");
  }
  const booleans = rollout ? new Set(["-w", "--watch"]) : secretBooleanFlags;
  const operands: string[] = [];
  let output: string | undefined;
  for (let i = start; i < argv.length;) {
    const arg = argv[i];
    if (!arg) return false;
    if (!arg.startsWith("-")) {
      operands.push(arg);
      i++;
      continue;
    }
    const parsed = readFlag(argv, i, values, booleans);
    if (!parsed) return false;
    if (parsed.flag === "-o" || parsed.flag === "--output") {
      if (output !== undefined) return false;
      output = parsed.value;
    }
    i = parsed.next;
  }
  if (!operands.length) return false;
  const resourceType = rollout
    ? /^(?:deployments?|deploy|daemonsets?|ds|statefulsets?|sts)(?:(?:\.v1)?\.apps)?$/i
    : /^(?:secrets?)(?:\.v1\.?)?$/i;
  let named = false;
  for (const [i, operand] of operands.entries()) {
    for (const part of operand.split(",")) {
      const pieces = part.split("/");
      if (pieces.length > 2) return false;
      if (i === 0 || pieces.length === 2) {
        if (!resourceType.test(pieces[0] ?? "")) return false;
        if (pieces.length === 2) {
          if (!/^[a-z0-9][a-z0-9.-]*$/.test(pieces[1] ?? "")) return false;
          named = true;
        }
      } else {
        if (!/^[a-z0-9][a-z0-9.-]*$/.test(part)) return false;
        named = true;
      }
    }
  }
  return rollout
    ? named &&
        (argv[start - 1]?.toLowerCase() !== "history" ||
          output === undefined ||
          isAllowedRolloutHistoryOutput(output))
    : isSafeSecretOutput(output);
}

function isMetadataPath(path: string): boolean {
  const leaf = path.replace(/^\.items\[\*\]/, "");
  return (
    /^\.(?:type|metadata\.(?:name|namespace|uid|resourceVersion|generation|creationTimestamp|deletionTimestamp|ownerReferences|finalizers))$/.test(
      leaf,
    ) || /^\.metadata\.labels(?:\.[A-Za-z0-9_-]+|\['[A-Za-z0-9_./-]+'\])?$/.test(leaf)
  );
}

function isMetadataJsonPath(format: string): boolean {
  let cursor = 0;
  let expressions = 0;
  let range = false;
  while (cursor < format.length) {
    const open = format.indexOf("{", cursor);
    const strayClose = format.indexOf("}", cursor);
    if (strayClose !== -1 && (open === -1 || strayClose < open)) return false;
    if (open === -1) break;
    const close = format.indexOf("}", open + 1);
    const nestedOpen = format.indexOf("{", open + 1);
    if (close === -1 || (nestedOpen !== -1 && nestedOpen < close)) return false;
    const expression = format.slice(open + 1, close).trim();
    if (expression === "range .items[*]" && !range) range = true;
    else if (expression === "end" && range) range = false;
    else if (
      !isMetadataPath(expression) &&
      !/^(?:"(?:[^"\\{}]|\\[nrt\\"])*"|'(?:[^'\\{}]|\\[nrt\\'])*')$/.test(expression)
    )
      return false;
    expressions++;
    cursor = close + 1;
  }
  return expressions > 0 && !range;
}

function splitCustomColumns(columns: string): string[] | undefined {
  const result: string[] = [];
  let start = 0;
  let bracketDepth = 0;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < columns.length; i++) {
    const char = columns[i];
    if (char === undefined) return undefined;
    if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === "'" || char === '"') quote = char;
    else if (char === "[") bracketDepth++;
    else if (char === "]") {
      if (bracketDepth === 0) return undefined;
      bracketDepth--;
    } else if (char === "," && bracketDepth === 0) {
      result.push(columns.slice(start, i));
      start = i + 1;
    }
  }
  if (quote || bracketDepth !== 0) return undefined;
  result.push(columns.slice(start));
  return result;
}

function isMetadataCustomColumns(format: string): boolean {
  const columns = splitCustomColumns(format);
  return (
    columns !== undefined &&
    columns.length > 0 &&
    columns.every((column) => {
      const separator = column.indexOf(":");
      return (
        separator > 0 &&
        column.slice(0, separator).trim() !== "" &&
        isMetadataPath(column.slice(separator + 1).trim())
      );
    })
  );
}

function isSafeSecretOutput(output: string | undefined): boolean {
  if (output === undefined || output === "wide" || output === "name") return true;
  if (output.startsWith("jsonpath=")) return isMetadataJsonPath(output.slice(9));
  if (output.startsWith("custom-columns=")) return isMetadataCustomColumns(output.slice(15));
  return false;
}

function isAllowedRolloutHistoryOutput(output: string): boolean {
  return (
    ["yaml", "json", "name"].includes(output) ||
    output.startsWith("jsonpath=") ||
    output.startsWith("go-template=")
  );
}

function outputFormatName(value: string | undefined): string | undefined {
  return value?.slice(0, value.indexOf("=") < 0 ? undefined : value.indexOf("=")).toLowerCase();
}

function shortOutputValue(
  argv: string[],
  index: number,
): { value: string | undefined; next: number } | undefined {
  const arg = argv[index];
  if (arg === undefined || !arg.startsWith("-") || arg.startsWith("--")) return undefined;
  const equals = arg.indexOf("=");
  const shortFlags = arg.slice(1, equals < 0 ? undefined : equals);
  const outputIndex = shortFlags.indexOf("o");
  if (outputIndex < 0 || !/^[ARw]*$/.test(shortFlags.slice(0, outputIndex))) return undefined;
  let value = arg.slice(outputIndex + 2).replace(/^=/, "");
  if (value === "" && equals >= 0) value = arg.slice(equals + 1);
  if (value === "") return { value: argv[index + 1], next: index + 2 };
  return { value, next: index + 1 };
}

function hasFileOutputFormat(argv: string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) return true;
    let value =
      arg === "-o" || arg === "--output"
        ? argv[i + 1]
        : arg.startsWith("--output=")
          ? arg.slice("--output=".length)
          : shortOutputValue(argv, i)?.value;
    if (outputFormatName(value)?.includes("file")) return true;
  }
  return false;
}

function hasSafeWaitOutput(argv: string[], start: number): boolean {
  for (let i = start; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) return false;
    const separate = arg === "-o" || arg === "--output" || arg === "--template";
    const attached = arg.startsWith("--output=") || arg.startsWith("--template=");
    const clustered = shortOutputValue(argv, i);
    if (!separate && !attached && !clustered) continue;
    const value = separate
      ? argv[++i]
      : attached
        ? arg.slice(arg.indexOf("=") + 1)
        : clustered?.value;
    if (clustered) i = clustered.next - 1;
    if (value !== "name") return false;
  }
  return true;
}

function waitSecretOperandResult(
  argv: string[],
  start: number,
): "secret" | "unsupported" | undefined {
  const values = new Set([
    "-n",
    "--namespace",
    "-o",
    "--output",
    "--template",
    "--for",
    "--timeout",
    "-l",
    "--selector",
    "--field-selector",
    "--request-timeout",
  ]);
  const booleans = new Set(["-A", "--all-namespaces", "--all", "--ignore-not-found"]);
  for (let i = start; i < argv.length;) {
    const arg = argv[i];
    if (arg === undefined) return "unsupported";
    if (arg.startsWith("-")) {
      const parsed = readFlag(argv, i, values, booleans);
      if (!parsed) return "unsupported";
      i = parsed.next;
      continue;
    }
    if (isSecretResource(arg)) return "secret";
    i++;
  }
  return undefined;
}

function resourceOperand(argv: string[], verbIndex: number): string | null | undefined {
  let flagsEnded = false;
  for (let i = verbIndex + 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) return undefined;
    if (!flagsEnded && arg === "--") {
      flagsEnded = true;
      continue;
    }
    if (!flagsEnded && arg.startsWith("-")) {
      const [flag] = arg.split("=", 1);
      if (flag !== undefined && flagsWithValues.has(flag)) {
        if (!arg.includes("=")) i++;
        continue;
      }
      if (
        attachedShortValueFlags.some(
          (shortFlag) => arg.startsWith(shortFlag) && arg.length > shortFlag.length,
        )
      )
        continue;
      if (flag !== undefined && flagsWithoutValues.has(flag)) continue;
      return null;
    }
    return arg;
  }
}

export function isSafeLogPath(path: string): boolean {
  const normalizedPath = posix.normalize(path);
  return (
    path.startsWith("/") &&
    !path.split("/").includes("..") &&
    /^\/(?!proc(?:\/|$)|sys(?:\/|$)|var\/run\/secrets(?:\/|$)).*\.log$/.test(normalizedPath) &&
    !normalizedPath.toLowerCase().includes("serviceaccount")
  );
}

function execAllowed(argv: string[], separator: number): boolean {
  const command = argv[separator + 1];
  const args = argv.slice(separator + 2);
  if (!command) return false;
  if (command === "redis-cli")
    return (
      (args.length === 1 && args[0] === "PING") ||
      ((args.length === 1 || args.length === 2) && args[0]?.toUpperCase() === "INFO")
    );
  if (command === "ls")
    return args.every((arg) => arg === "-la" || (arg.startsWith("/") && !arg.includes("..")));
  return false;
}

export function isKubectlCommandAllowed(cmd: string): K8sSecurityCheckResult {
  const argv = parseKubectlCommand(cmd);
  if (!argv)
    return { allowed: false, command: cmd, reason: "Empty, malformed, or shell syntax command." };
  let verbIndex = 0;
  while (argv[verbIndex]?.startsWith("-")) {
    if (argv[verbIndex] === "-v" || argv[verbIndex] === "--v")
      return {
        allowed: false,
        command: cmd,
        reason: "Unsupported flag before kubectl verb.",
        hint: "Place flags after the verb.",
      };
    const parsed = readFlag(argv, verbIndex, prefixValueFlags, prefixBooleanFlags);
    if (!parsed)
      return {
        allowed: false,
        command: cmd,
        reason: "Unsupported flag before kubectl verb.",
        hint: "Place flags after the verb.",
      };
    verbIndex = parsed.next;
  }
  const verb = argv[verbIndex]?.toLowerCase();
  if (!verb) return { allowed: false, command: cmd, reason: "Empty kubectl command." };
  const denied = (reason: string, hint?: string): K8sSecurityCheckResult => ({
    allowed: false,
    command: cmd,
    verb,
    reason,
    hint,
  });
  const readOnlyRollout =
    verb === "rollout" && ["status", "history"].includes(argv[verbIndex + 1]?.toLowerCase() ?? "");
  if ((BLOCKED_KUBECTL_VERBS as readonly string[]).includes(verb) && !readOnlyRollout)
    return denied(
      `'${verb}' is a mutating operation blocked for AI agents. Only read-only operations are allowed: ${readOnlyKubectlOperations.join(", ")}.`,
    );
  if (!(ALLOWED_KUBECTL_VERBS as readonly string[]).includes(verb) && !readOnlyRollout)
    return denied(
      `Unknown kubectl verb '${verb}'. Only known read-only operations are allowed: ${readOnlyKubectlOperations.join(", ")}.`,
    );
  const controlledFlag = argv.find((arg) => {
    const flag = arg.split("=", 1)[0] ?? "";
    return controlledFlags.has(flag) || (arg.startsWith("-s") && !arg.startsWith("--"));
  });
  if (controlledFlag !== undefined)
    return denied(
      `Cluster, authentication, and impersonation flag '${controlledFlag}' is controlled by the selected profile.`,
      "Remove the override and select the intended Kubernetes profile instead.",
    );
  if (readOnlyRollout && !closedReadArgs(argv, verbIndex + 2, true))
    return denied("Unsupported rollout resource or flag.");
  const subcommand = argv[verbIndex + 1]?.toLowerCase();
  if (
    verb === "config" &&
    (subcommand === undefined || !["view", "get-contexts", "current-context"].includes(subcommand))
  )
    return denied(
      "Only read-only kubectl config subcommands are allowed.",
      "Use config view, config get-contexts, or config current-context.",
    );
  if (verb === "auth" && !["can-i", "whoami"].includes(subcommand ?? ""))
    return denied(
      "Only read-only kubectl auth subcommands are allowed.",
      "Use auth can-i or auth whoami.",
    );
  if (verb === "cluster-info" && subcommand === "dump")
    return denied(
      "cluster-info dump is blocked because it may expose sensitive diagnostic data.",
      "Use cluster-info without dump.",
    );
  const resource = resourceOperand(argv, verbIndex);
  if (verb === "wait") {
    const waitOperandResult = waitSecretOperandResult(argv, verbIndex + 1);
    if (waitOperandResult === "secret")
      return denied(
        "Kubernetes Secret reads through wait are blocked because they may expose credentials.",
      );
    if (waitOperandResult === "unsupported")
      return denied("Unsupported kubectl wait flag or operand.");
    if (!hasSafeWaitOutput(argv, 0)) return denied("Only name output is allowed for kubectl wait.");
  }
  const hasSensitiveInputFlag = argv.some(
    (arg) =>
      arg === "-f" ||
      arg.startsWith("-f") ||
      arg === "--filename" ||
      arg === "-k" ||
      arg.startsWith("-k") ||
      arg === "--kustomize" ||
      /^(?:--filename|--kustomize)=/.test(arg) ||
      /^--raw(?:=|$)/.test(arg),
  );
  if ((verb === "get" || verb === "describe") && hasSensitiveInputFlag)
    return denied(
      "Kubernetes Secret reads and file-based reads are blocked because they may expose credentials.",
      "Use a targeted non-secret resource diagnostic instead.",
    );
  if ((verb === "get" || verb === "describe") && resource === null)
    return denied(
      "Unsupported flag before the resource operand.",
      "Use a documented get/describe flag or place the resource first.",
    );
  const hasNamedSecretResource = argv
    .slice(verbIndex + 1)
    .some((arg) => arg.includes("/") && isSecretResource(arg));
  if (
    (verb === "get" || verb === "describe") &&
    ((resource !== undefined && resource !== null && isSecretResource(resource)) ||
      hasNamedSecretResource)
  ) {
    const resourceIsOnlySecret =
      resource !== undefined && resource !== null && isOnlySecretResource(resource);
    const secretArgs = argv.filter((_, index) => index !== verbIndex);
    if (verb === "describe" || !resourceIsOnlySecret || !closedReadArgs(secretArgs, 0, false))
      return denied(
        "Kubernetes Secret reads and file-based reads are blocked because they may expose credentials.",
        "Use a targeted non-secret resource diagnostic instead.",
      );
  }
  if (hasFileOutputFormat(argv))
    return denied(
      "Kubernetes file-based output formats are blocked because they can read local files.",
    );
  if (verb === "config" && argv.includes("view") && argv.some((arg) => /^--raw(?:=|$)/.test(arg)))
    return denied(
      "Raw kubeconfig output is blocked because it may expose credentials.",
      "Use 'config view' without --raw.",
    );
  if (verb === "exec") {
    const separator = argv.indexOf("--", verbIndex + 1);
    if (separator < 0 || !execAllowed(argv, separator))
      return denied(
        "Only narrow diagnostic commands are allowed in pods.",
        "Use redis-cli PING/INFO or ls. Use logs-tool to read log files.",
      );
  }
  return { allowed: true, command: cmd, argv, verb };
}
