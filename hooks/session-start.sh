#!/usr/bin/env bash
# SessionStart hook: inject bootstrap.md as additional context so new,
# cleared, and compacted sessions know parallel-lanes is the default
# plan executor, plus one line per active-run marker (scripts/active-run):
# a stopped run is offered for resume; a run whose launch lock is held may
# still be running in another session and is not. jq builds the JSON so
# escaping is exact.
# Never fails: with bootstrap.md or jq missing it prints nothing, exit 0;
# markers that cannot be listed add no lines.
set -euo pipefail

here="$(cd "$(dirname "$0")" 2>/dev/null && pwd)" || exit 0
[ -f "$here/bootstrap.md" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0
# On Windows jq.exe gets the C:/ form: Git Bash's own path conversion skips
# some paths (one with a ';', for instance). Without the helper, or when it
# fails, the path is used as it is.
ctx_file="$here/bootstrap.md"
if [ -f "$here/../scripts/_paths.sh" ] && . "$here/../scripts/_paths.sh" 2>/dev/null && pl_is_windows; then
  ctx_file="$(native "$ctx_file" 2>/dev/null)" || ctx_file="$here/bootstrap.md"
fi
markers="$(bash "$here/../scripts/active-run" list 2>/dev/null)" || markers='[]'
out="$(jq -n --rawfile ctx "$ctx_file" --argjson markers "$markers" '
  ($markers | map(
      (.run_id | gsub("[[:cntrl:]]"; " ")) as $id
      | (.manifest | gsub("[[:cntrl:]]"; " ")) as $manifest
      | if .locked == true then
          "parallel-lanes run " + $id + " (manifest " + $manifest + ") may still be running in another"
          + " session (its launch lock is held): do not resume, relaunch, or set it up unless the user"
          + " confirms that session has ended.\n"
        else
          "Interrupted parallel-lanes run " + $id + " (manifest " + $manifest
          + "): offer the user a one-word resume.\n"
        end)
    | add // "") as $lines
  | {hookSpecificOutput: {hookEventName: "SessionStart", additionalContext:
      ((if $lines != "" and ($ctx | endswith("\n") | not) then $ctx + "\n" else $ctx end) + $lines)}}' \
  2>/dev/null)" || exit 0
printf '%s\n' "$out"
