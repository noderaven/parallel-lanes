#!/usr/bin/env bash
# SessionStart hook: inject bootstrap.md as additional context so new,
# cleared, and compacted sessions know parallel-lanes is the default
# plan executor, plus one line per active-run marker (scripts/active-run)
# so an interrupted run is offered for resume. jq builds the JSON so
# escaping is exact.
# Never fails: with bootstrap.md or jq missing it prints nothing, exit 0;
# markers that cannot be listed add no lines.
set -euo pipefail

here="$(cd "$(dirname "$0")" 2>/dev/null && pwd)" || exit 0
[ -f "$here/bootstrap.md" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
markers="$(bash "$here/../scripts/active-run" list 2>/dev/null)" || markers='[]'
out="$(jq -n --rawfile ctx "$here/bootstrap.md" --argjson markers "$markers" '
  ($markers | map("Interrupted parallel-lanes run " + (.run_id | gsub("[[:cntrl:]]"; " "))
    + " (manifest "
    + (.manifest | gsub("[[:cntrl:]]"; " ")) + "): offer the user a one-word resume.\n")
    | add // "") as $lines
  | {hookSpecificOutput: {hookEventName: "SessionStart", additionalContext:
      ((if $lines != "" and ($ctx | endswith("\n") | not) then $ctx + "\n" else $ctx end) + $lines)}}' \
  2>/dev/null)" || exit 0
printf '%s\n' "$out"
