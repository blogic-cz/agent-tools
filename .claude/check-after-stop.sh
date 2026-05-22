#!/bin/bash
# Runs on Stop - quality gate with JSON output
# NOTE: This hook only runs if edits were made during the conversation.
#       Pure analysis sessions will skip this hook entirely.

# Source the helper script from plugin
source "${CLAUDE_PLUGIN_ROOT}/scripts/check-runner.sh"

# === JS/TS (define "check" in package.json) ===
# run_check_hook "bun run check" "Stop" "Linting failed"

# === .NET ===
# run_check_hook "dotnet build" "Stop" "Build failed"

# === Custom ===
# run_check_hook "your-command-here" "Stop" "Custom check failed"
