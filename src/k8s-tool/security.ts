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
const isSecretResource = (resource: string) =>
  resource.split(",").some((part) => /^(?:secrets?|secrets?\.[^/]+)(?:\/|$)/i.test(part));

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
    const flag = argv[verbIndex];
    if (flag !== undefined && flagsWithValues.has(flag)) verbIndex++;
    verbIndex++;
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
  if ((BLOCKED_KUBECTL_VERBS as readonly string[]).includes(verb))
    return denied(
      `'${verb}' is a mutating operation blocked for AI agents. Only read-only operations are allowed: ${ALLOWED_KUBECTL_VERBS.join(", ")}.`,
    );
  if (!(ALLOWED_KUBECTL_VERBS as readonly string[]).includes(verb))
    return denied(
      `Unknown kubectl verb '${verb}'. Only known read-only operations are allowed: ${ALLOWED_KUBECTL_VERBS.join(", ")}.`,
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
  )
    return denied(
      "Kubernetes Secret reads and file-based reads are blocked because they may expose credentials.",
      "Use a targeted non-secret resource diagnostic instead.",
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
