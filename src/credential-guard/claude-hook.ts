#!/usr/bin/env bun
/**
 * Claude Code PreToolUse hook wrapper.
 *
 * Reads JSON from stdin (Claude Code hook protocol), runs the credential guard,
 * and exits with code 2 + stderr message if blocked, or 0 if allowed.
 *
 * Usage in .claude/settings.json:
 *   { "hooks": { "PreToolUse": [{ "matcher": ".*", "hooks": [{ "type": "command",
 *     "command": "bun node_modules/@blogic/agent-tools/src/credential-guard/claude-hook.ts" }] }] } }
 */

import { handleToolExecuteBefore } from "./index";

const stdin = await Bun.stdin.text();

try {
  const data: {
    tool_name: string;
    tool_input?: Record<string, unknown>;
  } = JSON.parse(stdin);

  handleToolExecuteBefore({ tool: data.tool_name }, { args: data.tool_input ?? {} });
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(message);
  process.exit(2);
}
