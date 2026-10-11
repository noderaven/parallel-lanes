# Path helpers for the bash scripts. Source this file; do not run it:
#   . "$(dirname "${BASH_SOURCE[0]}")/_paths.sh"
#
# pl_is_windows  true under Git Bash, MSYS, or Cygwin. PL_UNAME replaces the
#                output of uname -s (used by the tests).
# abs_dir DIR    print the absolute physical path of DIR; exit 1 when DIR is
#                missing. A relative DIR is taken from the current directory,
#                never from CDPATH. On Windows the path takes the C:/ form.
# native PATH    print PATH as the host's tools expect it: the C:/ form on
#                Windows, unchanged elsewhere.
# pl_history_dir print the run history dir, resolved as _history.history_dir
#                resolves it without an override: PL_HISTORY_DIR, else
#                ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/parallel-lanes/history.
#                A relative path is taken from the current directory; on
#                Windows the result takes the C:/ form.

pl_is_windows() {
  case "${PL_UNAME:-$(uname -s)}" in
    MINGW* | MSYS* | CYGWIN*) return 0 ;;
  esac
  return 1
}

native() {
  if pl_is_windows; then
    cygpath -m "$1"
  else
    printf '%s\n' "$1"
  fi
}

abs_dir() {
  local dir
  [ -d "$1" ] || return 1
  # An empty CDPATH keeps cd from resolving DIR elsewhere (and printing it);
  # -- lets DIR start with a dash.
  dir="$(CDPATH= cd -- "$1" && pwd -P)" || return 1
  native "$dir"
}

pl_history_dir() {
  local dir
  if [ -n "${PL_HISTORY_DIR:-}" ]; then
    dir="$PL_HISTORY_DIR"
  else
    dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/parallel-lanes/history"
  fi
  case "$dir" in
    /* | [A-Za-z]:[\\/]* | \\\\*) ;;
    *) dir="$(pwd -P)/$dir" ;;
  esac
  native "$dir"
}
