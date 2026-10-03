#!/usr/bin/env bash
# Install the parallel-lanes skill for Claude Code.
#
# usage: bash install.sh [--uninstall]
#
# Run it from a clone of this repo (or an unzipped copy that holds
# parallel-lanes/). Copies the skill to ~/.claude/skills/parallel-lanes
# (without .git), copies its parallel-lanes-worker agent type to
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
claude_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
dest="$claude_dir/skills/parallel-lanes"
settings="$claude_dir/settings.json"
agent_file="$claude_dir/agents/parallel-lanes-worker.md"
start_cmd="bash $dest/hooks/session-start.sh"
notice_cmd="bash $dest/hooks/notice.sh"

die() { echo "install: $*" >&2; exit 1; }

for tool in jq git python3; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required but not installed"
done

backup_settings() {
  [ -f "$settings" ] || return 0
  local bak="$settings.bak.$(date +%Y%m%d%H%M%S)"
  cp "$settings" "$bak"
  echo "Backed up settings to $bak"
}

# Drop every hook entry whose command points at this skill's hooks dir.
strip_filter='
  def strip: map(.hooks |= map(select((.command // "") | contains("/skills/parallel-lanes/hooks/") | not)))
             | map(select(.hooks | length > 0));
  if .hooks then
    .hooks |= with_entries(.value |= strip) | .hooks |= with_entries(select(.value | length > 0))
  else . end'

if [ "${1:-}" = "--uninstall" ]; then
  if [ -f "$settings" ]; then
    backup_settings
    tmp="$(mktemp)"
    jq "$strip_filter" "$settings" > "$tmp" && mv "$tmp" "$settings"
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

if [ -f "$here/SKILL.md" ]; then
  src="$here"
elif [ -f "$here/parallel-lanes/SKILL.md" ]; then
  src="$here/parallel-lanes"
else
  die "SKILL.md not found next to install.sh or in parallel-lanes/"
fi

mkdir -p "$claude_dir/skills"
if [ "$src" = "$(cd "$dest" 2>/dev/null && pwd)" ]; then
  echo "Skill already at $dest; installing the agent type and registering hooks only"
else
  if [ -e "$dest" ]; then
    echo "Updating existing $dest"
    rm -rf "$dest"
  fi
  mkdir -p "$dest"
  tar -C "$src" --exclude=.git --exclude=tests/tmp -cf - . | tar -C "$dest" -xf -
  chmod +x "$dest"/hooks/*.sh "$dest"/scripts/*
  echo "Installed skill to $dest"
fi

mkdir -p "$claude_dir/agents"
cp "$dest/agents/parallel-lanes-worker.md" "$agent_file"
echo "Installed agent type parallel-lanes-worker to $agent_file"

[ -f "$settings" ] || echo '{}' > "$settings"
jq empty "$settings" 2>/dev/null || die "$settings is not valid JSON; fix it and rerun"
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
