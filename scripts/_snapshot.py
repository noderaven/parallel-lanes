"""Save a worktree's uncommitted changes under the run's abandoned refs
before they are discarded. Shared by setup (a reused worktree) and
start-task (a lane worktree switched to a join unit's branch, 1.6.5).

Import with:
    sys.dont_write_bytecode = True
    sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
    import _snapshot
"""

import datetime
import os
import re
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True

# Variables that would point git at another repo than the one named.
GIT_REDIRECTS = ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE",
                 "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR")
ENV = {k: v for k, v in os.environ.items() if k not in GIT_REDIRECTS}


class Failure(Exception):
    """A git step failed: code is the exit code the caller should use."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def run_git(args, check=True):
    res = subprocess.run(["git", *args], capture_output=True, text=True, encoding="utf-8",
                         errors="surrogateescape", env=ENV)
    if check and res.returncode != 0:
        raise Failure(1, f"git {' '.join(args)} failed: {res.stderr.strip()}")
    return res


def snapshot(path, run_id, by="setup"):
    """Save the changes of the worktree at path in commits and point a run
    ref at the last one; the files in the worktree are untouched.

    The staged version first: git write-tree on the worktree's own index.
    When that tree differs from HEAD's, it is committed on HEAD (the index
    commit). Then every tracked change and untracked, non-ignored file goes,
    through a temporary index, into a commit on top of the index commit, or
    of HEAD when nothing was staged. write-tree can fail (an unmerged index,
    a held index.lock): index_saved is then false, index_error holds git's
    message, and the working snapshot is still made on HEAD. by names the
    script in the commit messages.
    Returns {"worktree", "ref", "commit", "index_commit", "index_saved"} and,
    when index_saved is false, "index_error"."""
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    # The folder name as a ref component: run worktrees are lane-<id> or
    # feature; any other character a ref cannot hold (a space) becomes '-'.
    name = re.sub(r"[^A-Za-z0-9._-]", "-", os.path.basename(os.path.normpath(path))).lstrip(".") or "worktree"
    ref = f"refs/parallel-lanes/{run_id}/abandoned/{name}-{stamp}"
    # Outside the raising helper: a failed write-tree is recorded, never fatal.
    # It may refresh the index file, which the reset --hard after the snapshot
    # replaces anyway.
    staged = subprocess.run(["git", "-C", path, "write-tree"], capture_output=True, text=True,
                            encoding="utf-8", errors="surrogateescape", env=ENV)
    index_saved = staged.returncode == 0
    index_commit = None
    with tempfile.TemporaryDirectory() as tmp:
        env = dict(ENV, GIT_INDEX_FILE=os.path.join(tmp, "index"))

        def git(*args):
            res = subprocess.run(["git", "-C", path, *args], capture_output=True, text=True,
                                 encoding="utf-8", errors="surrogateescape", env=env)
            if res.returncode != 0:
                raise Failure(1, f"saving the changes in {path} failed: git {args[0]}: {res.stderr.strip()}")
            return res.stdout.strip()

        identity = ("-c", "user.name=parallel-lanes", "-c", "user.email=parallel-lanes@localhost")
        if index_saved and staged.stdout.strip() != git("rev-parse", "--verify", "HEAD^{tree}"):
            index_commit = git(*identity, "commit-tree", staged.stdout.strip(), "-p", "HEAD", "-m",
                               f"parallel-lanes {run_id}: staged changes in {path} saved before {by} discarded them")
        git("read-tree", "HEAD")
        git("add", "-A")
        tree = git("write-tree")
        commit = git(*identity, "commit-tree", tree, "-p", index_commit or "HEAD", "-m",
                     f"parallel-lanes {run_id}: uncommitted changes in {path} saved before {by} discarded them")
        git("update-ref", ref, commit)
    entry = {"worktree": path, "ref": ref, "commit": commit, "index_commit": index_commit,
             "index_saved": index_saved}
    if not index_saved:
        entry["index_error"] = staged.stderr.strip() or f"git write-tree exited {staged.returncode}"
    return entry


def discard_changes(path, run_id, discarded, preserved, by="setup"):
    """Snapshot the worktree's uncommitted changes (when any) into preserved,
    list each status line in discarded, then reset and clean the worktree."""
    status = run_git(["-C", path, "status", "--porcelain"]).stdout
    for line in status.splitlines():
        if line:
            discarded.append(f"{path}: {line}")
    if status:
        preserved.append(snapshot(path, run_id, by))
        run_git(["-C", path, "reset", "-q", "--hard", "HEAD"])
        run_git(["-C", path, "clean", "-q", "-fd"])
