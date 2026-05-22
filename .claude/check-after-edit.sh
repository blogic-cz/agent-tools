#!/bin/bash
# Runs after Edit/Write - auto-fix and show warnings with JSON output

# Source the helper script from plugin
source "${CLAUDE_PLUGIN_ROOT}/scripts/check-runner.sh"

# === JS/TS (define "check" in package.json) ===
# run_check_hook "bun run check" "PostToolUse" "Linting failed"

# === .NET ===
# run_check_hook "dotnet format --verify-no-changes" "PostToolUse" "Format check failed"

# === Custom ===
# run_check_hook "your-command-here" "PostToolUse" "Custom check failed"
