#!/usr/bin/env bash
# SessionStart hook: inject bootstrap.md as additional context so new,
# cleared, and compacted sessions know parallel-lanes is the default
# plan executor. jq builds the JSON so escaping is exact.
# Never fails: with bootstrap.md or jq missing it prints nothing, exit 0.
set -euo pipefail

here="$(cd "$(dirname "$0")" 2>/dev/null && pwd)" || exit 0
[ -f "$here/bootstrap.md" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
out="$(jq -n --rawfile ctx "$here/bootstrap.md" \
  '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}' 2>/dev/null)" || exit 0
printf '%s\n' "$out"
