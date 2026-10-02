#!/usr/bin/env bash
# SessionStart hook: inject bootstrap.md as additional context so new,
# cleared, and compacted sessions know parallel-lanes is the default
# plan executor. jq builds the JSON so escaping is exact.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
jq -n --rawfile ctx "$here/bootstrap.md" \
  '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}'
