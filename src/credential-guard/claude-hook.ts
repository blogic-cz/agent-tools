#!/usr/bin/env bun
/**
 * Claude Code PreToolUse hook wrapper.
 *
 * Reads JSON from stdin (Claude Code hook protocol), runs the credential guard,
 * and exits with code 2 + stderr message if blocked, or 0 if allowed.
 *
 * Usage in .claude/settings.json:
 *   { "hooks": { "PreToolUse": [{ "matcher": ".*", "hooks": [{ "type": "command",
 *     "command": "bun node_modules/@blogic-cz/agent-tools/src/credential-guard/claude-hook.ts" }] }] } }
 */

export {};

let sanitize: (text: string) => string = () => "Credential guard could not inspect this request.";
try {
  const { redactSensitiveText } = await import("#shared/content-security");
  sanitize = redactSensitiveText;
  const { loadConfig } = await import("#config/loader");
  const { createCredentialGuard } = await import("./index");
  const data: { tool_name: string; tool_input?: Record<string, unknown> } = JSON.parse(
    await Bun.stdin.text(),
  );
  const config = await loadConfig();
  createCredentialGuard(config?.credentialGuard).handleToolExecuteBefore(
    { tool: data.tool_name },
    { args: data.tool_input ?? {} },
  );
} catch (error: unknown) {
  const message = sanitize(error instanceof Error ? error.message : String(error));
  await new Promise<void>((resolve) => {
    process.stderr.write(message.slice(0, 8000), () => resolve());
  });
  process.exitCode = 2;
}
