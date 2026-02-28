import type { InvokeParams, SecurityCheckResult } from "./types";

import {
  ALLOWED_SUBCOMMANDS,
  BLOCKED_SUBCOMMANDS,
  ALLOWED_INVOKE_AREAS,
  ALLOWED_INVOKE_RESOURCES,
  BLOCKED_INVOKE_AREAS,
  BLOCKED_INVOKE_RESOURCES,
} from "./config";
import { extractOptionValue } from "./extract-option-value";

export function isCommandAllowed(cmd: string): SecurityCheckResult {
  const rawCommandWords = cmd.trim().split(/\s+/);
  const commandWords = cmd
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => !w.startsWith("-"));

  if (commandWords.includes("invoke")) {
    const area = extractOptionValue(rawCommandWords, "--area");
    const resource = extractOptionValue(rawCommandWords, "--resource");

    if (!area || !resource) {
      return {
        allowed: false,
        command: cmd,
        reason: "Invoke command requires both --area and --resource options.",
      };
    }

    const method = extractOptionValue(rawCommandWords, "--http-method");

    if (method && method.toLowerCase() !== "get") {
      return {
        allowed: false,
        command: cmd,
        reason: "Invoke command only allows read-only HTTP method GET.",
      };
    }

    const invokeSecurityCheck = isInvokeAllowed({
      area: area.toLowerCase(),
      resource: resource.toLowerCase(),
    });

    if (!invokeSecurityCheck.allowed) {
      return {
        allowed: false,
        command: cmd,
        reason: invokeSecurityCheck.reason,
      };
    }

    return { allowed: true, command: cmd };
  }

  const allowedOperationIndex = commandWords.findIndex((word) =>
    ALLOWED_SUBCOMMANDS.includes(word as (typeof ALLOWED_SUBCOMMANDS)[number]),
  );

  if (allowedOperationIndex === -1) {
    const blockedWord = commandWords.find((word) =>
      BLOCKED_SUBCOMMANDS.includes(word as (typeof BLOCKED_SUBCOMMANDS)[number]),
    );

    if (blockedWord) {
      return {
        allowed: false,
        command: cmd,
        reason: `Command contains blocked operation '${blockedWord}'. Only read-only operations allowed: ${ALLOWED_SUBCOMMANDS.join(", ")}`,
      };
    }

    return {
      allowed: false,
      command: cmd,
      reason: `Command must contain a read-only operation: ${ALLOWED_SUBCOMMANDS.join(", ")}. Example: "pipelines list", "repos show --id 123"`,
    };
  }

  for (let i = allowedOperationIndex + 1; i < commandWords.length; i++) {
    if (BLOCKED_SUBCOMMANDS.includes(commandWords[i] as (typeof BLOCKED_SUBCOMMANDS)[number])) {
      return {
        allowed: false,
        command: cmd,
        reason: `Command contains blocked operation '${commandWords[i]}' after allowed operation. Only read-only operations allowed: ${ALLOWED_SUBCOMMANDS.join(", ")}`,
      };
    }
  }

  return { allowed: true, command: cmd };
}

export function isInvokeAllowed(params: InvokeParams): SecurityCheckResult {
  const { area, resource } = params;

  if (BLOCKED_INVOKE_AREAS.includes(area as (typeof BLOCKED_INVOKE_AREAS)[number])) {
    return {
      allowed: false,
      reason: `Area '${area}' is blocked. Dangerous areas not allowed: ${BLOCKED_INVOKE_AREAS.join(", ")}`,
    };
  }

  if (!ALLOWED_INVOKE_AREAS.includes(area as (typeof ALLOWED_INVOKE_AREAS)[number])) {
    return {
      allowed: false,
      reason: `Area '${area}' is not in allowed list. Allowed areas: ${ALLOWED_INVOKE_AREAS.join(", ")}`,
    };
  }

  const blockedResources = BLOCKED_INVOKE_RESOURCES[area];
  if (blockedResources?.includes(resource)) {
    return {
      allowed: false,
      reason: `Resource '${resource}' in area '${area}' is blocked. Write resources not allowed.`,
    };
  }

  const allowedResources = ALLOWED_INVOKE_RESOURCES[area];
  if (!allowedResources?.includes(resource)) {
    return {
      allowed: false,
      reason: `Resource '${resource}' is not in allowed list for area '${area}'. Allowed resources: ${allowedResources?.join(", ") ?? "none"}`,
    };
  }

  return { allowed: true };
}
