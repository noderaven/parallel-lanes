"""The run history: where it lives, how a run is identified, and index.json.

Import with:
    sys.dont_write_bytecode = True
    sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
    import _history

history_dir() is the one resolver for the history dir: an explicit override,
else PL_HISTORY_DIR, else <CLAUDE_CONFIG_DIR or ~/.claude>/parallel-lanes/history.
pl_history_dir in _paths.sh resolves it the same way for bash callers.

A run is identified by its run_id plus the manifest's repo.ledger_dir
(run_key), because run ids repeat across projects and machines. Paths stored
in the index, and the ledger dir in a run key, are normalised by norm_path:
backslashes become '/' and drive paths take the C:/ form, but a '/'-rooted
path is kept as written. They never go through _shell.native_path, so a run
archived on Linux keeps its /home/... paths on Windows.

<history dir>/index.json is {"version": 1, "runs": [entry, ...]}, one entry per
run, with the keys in ENTRY_KEYS. Change it only inside index_lock(), which
holds <history dir>/index.lock: read_index, choose a folder, update the entry,
then write_index.
"""

import contextlib
import json
import os
import socket
import sys
import tempfile
import time
import uuid

import _shell

INDEX = "index.json"
LOCK = "index.lock"
VERSION = 1

# The keys of an index entry. folder is relative to the history dir; project
# is repo.root, or the shadow's project root; platform is sys.platform;
# first_launch and last_launch are ISO 8601 UTC.
ENTRY_KEYS = (
    "run_id", "folder", "ledger_dir",
    "project", "plan", "engine_version",
    "machine", "platform",
    "first_launch", "last_launch",
    "launches", "status", "acceptance",
)

# How often index_lock retries while another process holds the lock.
_RETRY_S = 0.2


class HistoryError(Exception):
    """The history dir or its index cannot be used; the message says why."""


def history_dir(override=None, env=None):
    """The absolute history dir, with '/' separators.

    override, else PL_HISTORY_DIR, else
    <CLAUDE_CONFIG_DIR or ~/.claude>/parallel-lanes/history. An empty value
    counts as unset. env defaults to os.environ. On Windows the result takes
    the C:/ form (_shell.native_path), so a Git Bash path such as /c/x works.
    """
    env = os.environ if env is None else env
    path = override or _shell._getenv(env, "PL_HISTORY_DIR")
    if not path:
        config = _shell._getenv(env, "CLAUDE_CONFIG_DIR") or os.path.join(_home(env), ".claude")
        path = os.path.join(config, "parallel-lanes", "history")
    windows = _shell._is_windows(sys.platform)
    if windows:
        path = _shell.native_path(path)
    path = os.path.abspath(path)
    if windows:
        path = _shell._drive_form(path) or path.replace("\\", "/")
    return path


def _home(env):
    """The home folder os.path.expanduser('~') would use, read from env."""
    name = "USERPROFILE" if _shell._is_windows(sys.platform) else "HOME"
    return _shell._getenv(env, name) or os.path.expanduser("~")


def norm_path(p):
    """p as the index stores it: drive paths (C:\\x, c:/x, and on Windows
    the Git Bash form /c/x) in the C:/ form, other backslashes as '/', no
    trailing '/'. A '/'-rooted path from another system is kept as written."""
    if not isinstance(p, str) or not p:
        return p
    # /c/x is a Git Bash drive path only on Windows; elsewhere a '/'-rooted
    # path is a real path of that machine.
    out = None if p.startswith("/") and not _shell._is_windows(sys.platform) else _shell._drive_form(p)
    if out is None:
        out = p if p.startswith("/") else p.replace("\\", "/")
    stripped = out.rstrip("/")
    if not stripped or stripped.endswith(":"):
        return stripped + "/"
    return stripped


def _key_form(p):
    """norm_path(p) for comparison: a Windows path (C:/x or //server/share)
    is case-insensitive wherever it is read."""
    p = norm_path(p)
    if isinstance(p, str) and (p[1:3] == ":/" or p.startswith("//")):
        return p.lower()
    return p


def run_key(manifest):
    """(run_id, repo.ledger_dir) of a manifest, the ledger dir normalised."""
    try:
        return manifest["run_id"], norm_path(manifest["repo"]["ledger_dir"])
    except (KeyError, TypeError):
        raise HistoryError("the manifest has no run_id or repo.ledger_dir")


def find_run(index, run_id, ledger_dir):
    """The index entry with this run_id and ledger dir, or None."""
    want = _key_form(ledger_dir)
    for entry in index.get("runs", []):
        if entry.get("run_id") == run_id and _key_form(entry.get("ledger_dir")) == want:
            return entry
    return None


def inside(path, folder):
    """Whether path is folder or lies under it, after resolving both
    (symlinks included). Case-insensitive on Windows, where a Git Bash drive
    path (/c/x) is read as C:/x."""
    windows = _shell._is_windows(sys.platform)

    def resolved(p):
        if windows:
            p = _shell._drive_form(p) or p
        return os.path.normcase(os.path.realpath(p))

    p, f = resolved(path), resolved(folder)
    if p == f:
        return True
    return p.startswith(f.rstrip(os.sep) + os.sep)


def _empty():
    return {"version": VERSION, "runs": []}


def read_index(hdir):
    """<hdir>/index.json; an empty index when the file is missing.

    Raises HistoryError when it cannot be read or is not a version 1 index
    with a list of entry objects."""
    path = os.path.join(hdir, INDEX)
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except FileNotFoundError:
        return _empty()
    except OSError as e:
        raise HistoryError("cannot read " + path + ": " + str(e))
    try:
        index = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as e:
        raise HistoryError(path + " is not valid JSON: " + str(e))
    if not isinstance(index, dict) or not isinstance(index.get("runs"), list):
        raise HistoryError(path + " is not a run index: it needs a runs list")
    if index.get("version") != VERSION:
        raise HistoryError(path + " has version " + json.dumps(index.get("version"))
                           + "; this parallel-lanes reads version " + str(VERSION))
    if not all(isinstance(entry, dict) for entry in index["runs"]):
        raise HistoryError(path + " is not a run index: every run must be an object")
    return index


def _order(entry):
    return (str(entry.get("first_launch") or ""), str(entry.get("run_id") or ""))


def write_index(hdir, index):
    """Write index to <hdir>/index.json atomically (a temp file in hdir, then
    os.replace), its runs sorted by first_launch, then run_id. index itself
    is not changed."""
    out = dict(index)
    out["version"] = out.get("version", VERSION)
    out["runs"] = sorted(index.get("runs", []), key=_order)
    data = (json.dumps(out, indent=2) + "\n").encode("utf-8")
    os.makedirs(hdir, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=INDEX + ".", suffix=".tmp", dir=hdir)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, os.path.join(hdir, INDEX))
    except BaseException:
        with contextlib.suppress(OSError):
            os.remove(tmp)
        raise


def _utc_now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _read_lock(path):
    try:
        with open(path, "rb") as f:
            return f.read().decode("utf-8", "replace").strip()
    except OSError:
        return ""


def _put_back(moved, path):
    """Return a lock moved away by mistake to path, only while path is free
    (os.link never replaces a file; neither does os.rename on Windows)."""
    try:
        os.link(moved, path)
    except OSError:
        if not _shell._is_windows(sys.platform):
            return
        with contextlib.suppress(OSError):
            os.rename(moved, path)
        return
    with contextlib.suppress(OSError):
        os.remove(moved)


def _take_over(path, age, stale_s):
    """Move a stale lock out of the way; whether the lock path is free now.

    The rename is atomic, so of several processes taking over the same stale
    lock only one moves it. The staleness was judged before the rename: if
    the stale lock was released and a fresh one created in between, the
    moved file is fresh, so it is put back (while the lock path is still
    free) and the lock counts as held. A gap remains: when a third process
    creates a lock in the moment between the rename and the put-back, the
    fresh lock cannot go back, and its holder and the next one may both
    hold the lock."""
    moved = path + ".stale-" + uuid.uuid4().hex
    try:
        os.rename(path, moved)
    except OSError:
        return False
    try:
        fresh = time.time() - os.stat(moved).st_mtime <= stale_s
    except OSError:
        fresh = False
    if fresh:
        _put_back(moved, path)
        return False
    holder = _read_lock(moved)
    with contextlib.suppress(OSError):
        os.remove(moved)
    sys.stderr.write(
        "parallel-lanes: taking over the stale lock " + path + " ("
        + str(int(age)) + " s old, over the " + str(int(stale_s)) + " s limit; held by "
        + (holder or "an unknown process") + ")\n"
    )
    return True


@contextlib.contextmanager
def index_lock(hdir, wait_s=30, stale_s=600):
    """Hold <hdir>/index.lock, an exclusive lock on index.json.

    The lock file is created with O_CREAT | O_EXCL and holds the pid and the
    time (for people reading it); it is removed on exit. While another
    process holds it, the lock is retried every 0.2 s for up to wait_s
    seconds, then HistoryError is raised. A lock file whose mtime is more
    than stale_s seconds old is left over from a crash: it is taken over,
    with a notice on stderr. The first time the lock is found held, a
    notice that it waits goes to stderr. A history dir that refuses the
    lock file (PermissionError outside Windows) raises HistoryError at once.
    """
    os.makedirs(hdir, exist_ok=True)
    path = os.path.join(hdir, LOCK)
    token = uuid.uuid4().hex
    content = json.dumps({"pid": os.getpid(), "time": _utc_now(), "host": socket.gethostname(),
                          "token": token})
    deadline = time.monotonic() + wait_s
    waiting = False
    while True:
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
            break
        except FileExistsError:
            pass
        except PermissionError as e:
            # Windows refuses (PermissionError) to create a file while
            # another process is still deleting it: treat it as held there.
            # Elsewhere it means the dir cannot be written.
            if not _shell._is_windows(sys.platform):
                raise HistoryError("cannot create " + path + ": " + str(e))
        try:
            age = time.time() - os.stat(path).st_mtime
        except OSError:
            # Released in between (retried after the pause below), or a
            # folder that refuses the lock: never a stale lock.
            age = 0
        if age > stale_s and _take_over(path, age, stale_s):
            continue
        if time.monotonic() >= deadline:
            raise HistoryError(
                path + " is held by another process (" + (_read_lock(path) or "no details")
                + "); waited " + str(wait_s) + " s. If no archive-run or reindex is running,"
                " remove " + path + "."
            )
        if not waiting:
            waiting = True
            sys.stderr.write("parallel-lanes: waiting for " + path + ", held by another process\n")
            sys.stderr.flush()
        time.sleep(_RETRY_S)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(content.encode("utf-8"))
        yield path
    finally:
        # Remove only our own lock: one taken over as stale belongs to its
        # new holder now.
        if token in _read_lock(path):
            with contextlib.suppress(OSError):
                os.remove(path)
