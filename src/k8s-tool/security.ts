/**
 * K8s Security Module
 *
 * Validates kubectl commands before execution. Only read-only operations
 * are allowed for AI agents. Mutating operations (delete, apply, patch, etc.)
 * are blocked to prevent accidental or unauthorized changes to clusters.
 */

/** Kubectl verbs that are safe for AI agents (read-only / non-destructive) */
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
  "diff",
  "wait",
  "exec",
  "port-forward",
  "config",
] as const;

/** Kubectl verbs that are explicitly blocked (mutating / destructive) */
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
  reason?: string;
  verb?: string;
};

/**
 * Checks if a kubectl command is allowed for AI agent execution.
 * Extracts the kubectl verb and validates against allow/block lists.
 *
 * Handles piped commands by checking only the kubectl portion (before first pipe).
 */
export function isKubectlCommandAllowed(cmd: string): K8sSecurityCheckResult {
  const trimmed = cmd.trim();

  // Handle piped commands — only validate the kubectl verb (before first |)
  const kubectlPart = trimmed.split("|")[0].trim();

  // Extract verb: first non-flag word
  const words = kubectlPart.split(/\s+/).filter((w) => !w.startsWith("-"));
  const verb = words[0]?.toLowerCase();

  if (!verb) {
    return { allowed: false, command: cmd, reason: "Empty kubectl command." };
  }

  // Explicit blocklist — clear message about what's blocked and why
  if ((BLOCKED_KUBECTL_VERBS as readonly string[]).includes(verb)) {
    return {
      allowed: false,
      command: cmd,
      verb,
      reason: `'${verb}' is a mutating operation blocked for AI agents. Only read-only operations are allowed: ${ALLOWED_KUBECTL_VERBS.join(", ")}.`,
    };
  }

  // Allowlist — unknown verbs are also blocked for safety
  if (!(ALLOWED_KUBECTL_VERBS as readonly string[]).includes(verb)) {
    return {
      allowed: false,
      command: cmd,
      verb,
      reason: `Unknown kubectl verb '${verb}'. Only known read-only operations are allowed: ${ALLOWED_KUBECTL_VERBS.join(", ")}.`,
    };
  }

  return { allowed: true, command: cmd, verb };
}
