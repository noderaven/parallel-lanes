#!/usr/bin/env bash
# PostToolUse hook (matcher "Skill"): announce when the parallel-lanes skill
# is invoked, bare or namespaced (e.g. "plugin:parallel-lanes").
# Reads the hook event JSON on stdin; prints nothing for anything else.
# Never fails: a hook error must not disturb the session.
set -euo pipefail

skill=$(jq -r 'if .tool_name == "Skill" then (.tool_input.skill // "") else "" end' 2>/dev/null) || skill=""

if [ "$skill" = "parallel-lanes" ] || [[ "$skill" == *:parallel-lanes ]]; then
  printf '%s\n' '{"systemMessage":"parallel-lanes invoked"}'
fi
exit 0
