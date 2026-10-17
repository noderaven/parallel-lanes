#!/usr/bin/env bash
# Install the parallel-lanes skill for Claude Code.
#
# usage: bash install.sh [--uninstall]
#
# Run it from a clone of this repo (or an unzipped copy that holds
# parallel-lanes/). Copies the skill to ~/.claude/skills/parallel-lanes
# (from a git checkout its tracked files only, else everything but .git),
# staged and checked first so a failed copy keeps the old install; copies its
# parallel-lanes-worker agent type to
# ~/.claude/agents/parallel-lanes-worker.md, and registers its two hooks in
# ~/.claude/settings.json (backed up first):
#   SessionStart (startup|clear|compact) -> hooks/session-start.sh
#   PostToolUse  (Skill)                 -> hooks/notice.sh
# Run from the installed folder itself, it only installs the agent type and
# registers the hooks.
# Running it again updates the skill and the agent type and leaves hooks that
# already exist alone.
# --uninstall removes the hooks, the agent type file, and the skill directory.
# Run records under ~/.claude/parallel-lanes/ are never touched.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { echo "install: $*" >&2; exit 1; }

# The skill's files: next to this script, or in parallel-lanes/ of an
# unzipped copy. Empty when neither holds SKILL.md (only --uninstall works).
if [ -f "$here/SKILL.md" ]; then
  src="$here"
elif [ -f "$here/parallel-lanes/SKILL.md" ]; then
  src="$here/parallel-lanes"
else
  src=""
fi
if [ -n "$src" ]; then
  . "$src/scripts/_paths.sh"
else
  pl_is_windows() { return 1; }
  native() { printf '%s\n' "$1"; }
fi


for tool in jq git; do
  command -v "$tool" >/dev/null 2>&1 && continue
  if [ "$tool" = jq ] && pl_is_windows; then
    die "jq is required but not installed (on Windows: winget install jqlang.jq, then reopen Git Bash)"
  fi
  die "$tool is required but not installed"
done

claude_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
# On Windows the config dir takes the C:/ form: jq.exe gets it as is, with no
# Git Bash path conversion to depend on, and the hook commands name it the
# same way whatever form CLAUDE_CONFIG_DIR or HOME used.
if pl_is_windows; then
  claude_dir="$(native "$claude_dir" 2>/dev/null)" || claude_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
fi
dest="$claude_dir/skills/parallel-lanes"
settings="$claude_dir/settings.json"
agent_file="$claude_dir/agents/parallel-lanes-worker.md"
# The hook commands run through a shell, so the paths are single-quoted
# (a config dir may contain spaces or quotes).
shquote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
start_cmd="bash $(shquote "$dest/hooks/session-start.sh")"
notice_cmd="bash $(shquote "$dest/hooks/notice.sh")"

backup_settings() {
  [ -f "$settings" ] || return 0
  local bak="$settings.bak.$(date +%Y%m%d%H%M%S)"
  cp "$settings" "$bak"
  echo "Backed up settings to $bak"
}

# Drop every hook entry whose command points at this skill's hooks dir, with
# either separator (an older install on Windows may have written backslashes).
strip_filter='
  def strip: map(.hooks |= map(select((.command // "") | test("[/\\\\]skills[/\\\\]parallel-lanes[/\\\\]hooks[/\\\\]") | not)))
             | map(select(.hooks | length > 0));
  if .hooks then
    .hooks |= with_entries(.value |= strip) | .hooks |= with_entries(select(.value | length > 0))
  else . end'

# Claude Code reads settings.json as exactly one JSON object. jq on its own
# accepts an empty file or several documents, so slurp and count them. A
# missing file is fine (the install creates it).
check_settings() {
  [ -f "$settings" ] || return 0
  jq -e -s 'length == 1 and (.[0] | type) == "object"' "$settings" >/dev/null 2>&1 \
    || die "$settings is not a single JSON object (or not valid JSON); fix it and rerun"
}

if [ "${1:-}" = "--uninstall" ]; then
  check_settings
  if [ -f "$settings" ]; then
    backup_settings
    tmp="$(mktemp)"
    jq "$strip_filter" "$settings" > "$tmp" && mv "$tmp" "$settings" \
      || { rm -f "$tmp"; die "could not edit $settings; nothing removed"; }
    echo "Removed parallel-lanes hooks from $settings"
  fi
  if [ -e "$agent_file" ]; then
    rm -f "$agent_file"
    echo "Removed $agent_file"
  fi
  if [ "$here" = "$(cd "$dest" 2>/dev/null && pwd)" ]; then
    echo "Left $dest in place (it is the folder this script runs from); delete it by hand"
  else
    rm -rf "$dest"
    echo "Removed $dest"
  fi
  exit 0
fi
[ $# -eq 0 ] || die "usage: bash install.sh [--uninstall]"
[ -n "$src" ] || die "SKILL.md not found next to install.sh or in parallel-lanes/"

# Any working Python 3.8 or later will do (python3, python, or py -3); the
# skill finds the same one at run time. find-python explains a failure.
bash "$src/scripts/find-python" >/dev/null || die "Python 3.8 or later is required but none works"

# An unreadable settings.json stops the script before the old skill dir goes.
check_settings

mkdir -p "$claude_dir/skills"
if [ "$src" = "$(cd "$dest" 2>/dev/null && pwd)" ]; then
  echo "Skill already at $dest; installing the agent type and registering hooks only"
else
  # Stage the new copy, check it, then swap it in, so a failed copy never
  # leaves the skill missing (1.6.10). The staged and old copies sit outside
  # skills/, where Claude Code would see a second SKILL.md. From a git
  # checkout only tracked files are copied (untracked notes and logs stay
  # out); from an unzipped copy, everything but .git and tests/tmp.
  stage="$claude_dir/.parallel-lanes-install.$$"
  old="$claude_dir/.parallel-lanes-old.$$"
  rm -rf "$stage" "$old"
  mkdir -p "$stage"
  copied=1
  if git -C "$src" ls-files --error-unmatch SKILL.md >/dev/null 2>&1; then
    list="$(mktemp)"
    git -C "$src" ls-files -z | while IFS= read -r -d '' f; do
      # A tracked file deleted in the work tree is not copied.
      [ -e "$src/$f" ] && printf '%s\0' "$f"
    done > "$list"
    tar -C "$src" --null -T "$list" -cf - | tar -C "$stage" -xf - || copied=0
    rm -f "$list"
  else
    tar -C "$src" --exclude=.git --exclude=tests/tmp -cf - . | tar -C "$stage" -xf - || copied=0
  fi
  for f in SKILL.md VERSION run.workflow.js agents/parallel-lanes-worker.md; do
    [ "$copied" = 1 ] && cmp -s "$src/$f" "$stage/$f" && continue
    rm -rf "$stage"
    die "the new copy is incomplete ($f did not copy); the installed skill is unchanged"
  done
  chmod +x "$stage"/hooks/*.sh "$stage"/scripts/*
  if [ -e "$dest" ]; then
    echo "Updating existing $dest"
    if ! mv "$dest" "$old"; then
      rm -rf "$stage"
      die "cannot move the installed skill aside (is a file in it open?); it is unchanged"
    fi
    if ! mv "$stage" "$dest"; then
      mv "$old" "$dest"
      rm -rf "$stage"
      die "cannot put the new copy in place; the installed skill is unchanged"
    fi
    rm -rf "$old"
  else
    mv "$stage" "$dest"
  fi
  echo "Installed skill to $dest"
fi

mkdir -p "$claude_dir/agents"
cp "$dest/agents/parallel-lanes-worker.md" "$agent_file"
echo "Installed agent type parallel-lanes-worker to $agent_file"

[ -f "$settings" ] || echo '{}' > "$settings"
check_settings
backup_settings
tmp="$(mktemp)"
jq --arg start "$start_cmd" --arg notice "$notice_cmd" "$strip_filter"'
  | .hooks //= {}
  | .hooks.SessionStart = ((.hooks.SessionStart // []) + [{matcher: "startup|clear|compact",
      hooks: [{type: "command", command: $start}]}])
  | .hooks.PostToolUse = ((.hooks.PostToolUse // []) + [{matcher: "Skill",
      hooks: [{type: "command", command: $notice}]}])' "$settings" > "$tmp"
mv "$tmp" "$settings"
echo "Registered hooks in $settings"

if ! ls "$claude_dir"/plugins/cache/*/superpowers/*/skills/subagent-driven-development/implementer-prompt.md \
     >/dev/null 2>&1; then
  cat <<'EOF'

Superpowers was not found. parallel-lanes works without it (agents fall back
to built-in prompts), but it is designed to pair with it. To install, run
inside Claude Code:
  /plugin marketplace add obra/superpowers
  /plugin install superpowers@superpowers-dev
EOF
fi

echo
echo "Done. Restart Claude Code (or run /clear) so the hooks load."
