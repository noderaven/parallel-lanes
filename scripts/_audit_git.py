"""Read-only git access for scripts/audit.

Import with:
    sys.dont_write_bytecode = True
    sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
    import _audit_git

Every git call, repo discovery included, runs 'git --no-optional-locks
<args>' with GIT_OPTIONAL_LOCKS=0, GIT_NO_LAZY_FETCH=1 and
GIT_NO_REPLACE_OBJECTS=1 set, and with GIT_DIR, GIT_WORK_TREE,
GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY, GIT_COMMON_DIR,
GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_CONFIG_PARAMETERS, GIT_CONFIG_COUNT,
every GIT_CONFIG_KEY_<n> and GIT_CONFIG_VALUE_<n>, GIT_NAMESPACE and
GIT_REPLACE_REF_BASE removed from the environment, so nothing in the
caller's environment points git at another repo's objects, adds config, or
rewrites the recorded history (replace refs). Output is decoded as UTF-8. Nothing
here fetches, writes config, changes refs or touches the index.

open_repo(path, must_contain) returns (Git, None) or (None, reason). path is
a worktree or a git dir. A must_contain sha that is not a commit in the repo
gives (None, "the repo does not contain <short sha>"); a None must_contain
opens the repo unchecked (the caller notes "repo not checked against the
run").

Git(git_dir) runs every call with --git-dir=<git_dir>:
    has_commit(sha)            True or False
    is_ancestor(a, b)          True, False, or None when unknown
    rev_list(tip, exclude)     shas reachable from tip but from none of
                               exclude, oldest first, or None
    range_commits(base, head)  rev_list(head, [base])
    changed_files(base, head)  the paths of 'git diff --name-only -z
                               --no-renames base head', as written, or None
A revision that is not a string, is empty or starts with '-' is never passed
to git: has_commit gives False and the others None.
"""

import os
import subprocess

DROP_ENV = ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR",
            "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_NAMESPACE",
            "GIT_REPLACE_REF_BASE")
DROP_PREFIXES = ("GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_")


def git_env():
    env = {}
    for key, value in os.environ.items():
        upper = key.upper()
        if upper not in DROP_ENV and not upper.startswith(DROP_PREFIXES):
            env[key] = value
    env["GIT_OPTIONAL_LOCKS"] = "0"
    env["GIT_NO_LAZY_FETCH"] = "1"
    env["GIT_NO_REPLACE_OBJECTS"] = "1"
    return env


def run_git(args):
    """Runs git --no-optional-locks <args>; returns (exit code, stdout), or
    (None, "") when git cannot be started."""
    try:
        res = subprocess.run(["git", "--no-optional-locks"] + list(args), env=git_env(),
                             stdin=subprocess.DEVNULL, capture_output=True, text=True,
                             encoding="utf-8", errors="replace")
    except (OSError, subprocess.SubprocessError):
        return None, ""
    return res.returncode, res.stdout


def _rev(value):
    return isinstance(value, str) and value != "" and not value.startswith("-")


class Git(object):
    def __init__(self, git_dir):
        self.git_dir = git_dir

    def _run(self, args):
        return run_git(["--git-dir=" + self.git_dir] + list(args))

    def has_commit(self, sha):
        if not _rev(sha):
            return False
        code, _ = self._run(["cat-file", "-e", sha + "^{commit}"])
        return code == 0

    def is_ancestor(self, a, b):
        if not (_rev(a) and _rev(b)) or not (self.has_commit(a) and self.has_commit(b)):
            return None
        code, _ = self._run(["merge-base", "--is-ancestor", a, b])
        if code == 0:
            return True
        if code == 1:
            return False
        return None

    def rev_list(self, tip, exclude):
        exclude = list(exclude)
        if not _rev(tip) or not all(_rev(sha) for sha in exclude):
            return None
        code, out = self._run(["rev-list", "--topo-order", "--reverse", tip, "--not"] + exclude + ["--"])
        if code != 0:
            return None
        return [line.strip() for line in out.splitlines() if line.strip()]

    def range_commits(self, base, head):
        return self.rev_list(head, [base])

    def changed_files(self, base, head):
        if not (_rev(base) and _rev(head)):
            return None
        code, out = self._run(["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff",
                               base, head, "--"])
        if code != 0:
            return None
        return [name for name in out.split("\0") if name]


def _git_dir(path):
    for args in (["-C", path, "rev-parse", "--absolute-git-dir"],
                 ["--git-dir=" + path, "rev-parse", "--absolute-git-dir"]):
        code, out = run_git(args)
        if code is None:
            return None, "git is not available"
        if code == 0 and out.strip():
            return out.strip(), None
    return None, "not a git repo: %s" % (path,)


def open_repo(path, must_contain):
    git_dir, reason = _git_dir(path)
    if git_dir is None:
        return None, reason
    git = Git(git_dir)
    if must_contain is not None and not git.has_commit(must_contain):
        return None, "the repo does not contain %s" % (str(must_contain)[:7],)
    return git, None
