#!/usr/bin/env bash
# PostToolUse hook (matcher "Skill"): announce when the parallel-lanes skill
# is invoked, bare or namespaced (e.g. "plugin:parallel-lanes").
# Reads the hook event JSON on stdin; prints nothing for anything else.
# The notice names the version in the skill's VERSION file ("parallel-lanes
# v1.1.0 invoked"), or omits it when that file is missing or not x.y.z.
# Never fails: a hook error must not disturb the session.
set -euo pipefail

skill=$(jq -r 'if .tool_name == "Skill" then (.tool_input.skill // "") else "" end' 2>/dev/null) || skill=""

if [ "$skill" = "parallel-lanes" ] || [[ "$skill" == *:parallel-lanes ]]; then
  version="$(cat "$(dirname "$0")/../VERSION" 2>/dev/null)" || version=""
  re='^[0-9]+\.[0-9]+\.[0-9]+$'
  if [[ "$version" =~ $re ]]; then
    printf '{"systemMessage":"parallel-lanes v%s invoked"}\n' "$version"
  else
    printf '%s\n' '{"systemMessage":"parallel-lanes invoked"}'
  fi
fi
exit 0
