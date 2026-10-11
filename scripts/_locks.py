"""The active dir and the checkout lock, shared by setup and cleanup.

active_dir() is $PL_ACTIVE_DIR, default
${CLAUDE_CONFIG_DIR:-~/.claude}/parallel-lanes/active: where active-run
keeps the run markers and launch locks (<run_id>.lock).

checkout_lock(root, run_id) takes the checkout lock of the git checkout that
holds root for run_id and returns its path:
<active dir>/checkout-<st_dev>-<st_ino>.lock, keyed by the file identity of
the checkout's top level (so a symlink, another spelling or a subdirectory
of the same checkout is the same lock, and separate worktrees of one repo
are not), created atomically and holding {"run_id", "checkout"}. A lock of
this run is kept (a relaunch or resume). A lock of another run whose launch
lock still exists is refused (LockError 4, naming that run in run_id). A
lock of another run without a launch lock is stale: it is renamed aside
(one taker wins) and taken over. An unreadable or malformed lock is refused
(LockError 4, naming the file). active-run release and remove delete a
run's checkout locks.

LockError codes: 2 when root is not a directory or not in a git checkout;
3 when the lock cannot be created or written; 4 as above.
"""

import json
import os
import re
import subprocess

# Variables that would point git at another repo than the one named.
GIT_REDIRECTS = ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE",
                 "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR")
# The same pattern as runIdPattern in src/validate.js.
RUN_ID = re.compile(r"^[a-z0-9-]+$")


class LockError(Exception):
    """A lock that cannot be taken. run_id names the run that holds the
    checkout when another run's live lock is the reason, else None."""

    def __init__(self, code, message, run_id=None):
        super().__init__(message)
        self.code = code
        self.run_id = run_id


def active_dir():
    base = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
    return os.environ.get("PL_ACTIVE_DIR") or os.path.join(base, "parallel-lanes", "active")


def moved_lock_run(path):
    """The run_id of the lock file at path, or None when it cannot be read."""
    try:
        with open(path, encoding="utf-8") as f:
            held = json.load(f)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    return held.get("run_id") if isinstance(held, dict) else None


def _toplevel(root):
    env = {k: v for k, v in os.environ.items() if k not in GIT_REDIRECTS}
    return subprocess.run(["git", "-C", root, "rev-parse", "--show-toplevel"], capture_output=True, text=True,
                          encoding="utf-8", errors="surrogateescape", env=env)


def checkout_lock(root, run_id):
    """Take the checkout lock of root for run_id; return the lock's path.

    Keyed by the file identity of the checkout's top level (so a root
    inside the checkout is the same checkout); refuses (LockError 4) a
    checkout another locked run holds, takes over one whose run has no
    launch lock.
    """
    if not os.path.isdir(root):
        raise LockError(2, f"repo.root is not a directory: {root}")
    top = _toplevel(root)
    if top.returncode != 0 or not top.stdout.strip():
        raise LockError(2, f"repo.root is not inside a git checkout: {root}: {top.stderr.strip()}")
    st = os.stat(top.stdout.strip())
    adir = active_dir()
    path = os.path.join(adir, f"checkout-{st.st_dev}-{st.st_ino}.lock")
    content = json.dumps({"run_id": run_id, "checkout": root}) + "\n"

    def create():
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            return False
        except OSError as e:
            raise LockError(3, f"cannot create the checkout lock {path}: {e}")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(content)
        except OSError as e:
            # A partial lock would make every later setup refuse it as unreadable.
            try:
                os.remove(path)
            except OSError:
                pass
            raise LockError(3, f"cannot write the checkout lock {path}: {e}")
        return True

    # Two rounds: a takeover another setup wins once is read again, then refused.
    for _ in range(2):
        if create():
            return path
        try:
            with open(path, encoding="utf-8") as f:
                held = json.load(f)
        except FileNotFoundError:
            continue  # its holder released it meanwhile
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as e:
            raise LockError(4, f"the checkout lock {path} is unreadable ({e}); remove it once no run uses "
                               f"the checkout {root} (nothing was changed)")
        other = held.get("run_id") if isinstance(held, dict) else None
        if not isinstance(other, str) or not RUN_ID.fullmatch(other):
            raise LockError(4, f"the checkout lock {path} is malformed (no valid run_id); remove it once no run "
                               f"uses the checkout {root} (nothing was changed)")
        if other == run_id:
            return path
        if os.path.exists(os.path.join(adir, f"{other}.lock")):
            raise LockError(4, f"the checkout {root} is in use by run {other} (locked by another session); "
                               "finish or release that run first (nothing was changed)", run_id=other)
        # Stale: its run has no launch lock. Renaming moves whatever is at path
        # now, which may not be the lock read above, so what was moved is read
        # again and put back when it is not that stale lock.
        stale = f"{path}.{os.getpid()}.stale"
        try:
            os.rename(path, stale)
        except OSError:
            continue  # another taker won: read its lock again
        if moved_lock_run(stale) != other or os.path.exists(os.path.join(adir, f"{other}.lock")):
            if not os.path.exists(path):
                try:
                    os.rename(stale, path)
                except OSError:
                    pass
            raise LockError(4, f"the checkout lock {path} changed while setup was taking it over; another run "
                               f"is setting up the checkout {root} (nothing was changed)")
        created = create()
        try:
            os.remove(stale)
        except OSError:
            pass
        if created:
            return path
    raise LockError(4, f"the checkout lock {path} changed while setup was taking it over; another run is "
                       f"setting up the checkout {root} (nothing was changed)")
