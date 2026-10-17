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

The index lock is an OS lock on <history dir>/index.lock, a file that is
created once and never deleted (do not delete it by hand either: a holder
keeps its lock on the old file). The lock itself is _oslock's: on POSIX it
is fcntl.flock(LOCK_EX) on the whole file; on Windows it is msvcrt.locking on
one byte at _oslock.WIN_LOCK_OFFSET (1 GiB, past the end of the file), so the
text stays readable. The OS
releases the lock when the holder's process ends, however it ends, so there
is no stale lock to take over and the file's age means nothing. The holder
writes its pid, time and host into the file for people reading it; the
contents are never part of the protocol.

An unreleased branch (release-1.5.0) used another protocol: an index.lock
created with O_EXCL, holding JSON with a token, and deleted on exit. That
lock was never released. This lock ignores a leftover file from it and
takes the lock at once. Before using this lock, ensure no unreleased old
writers (archive-run run from an old checkout) are running: mixing the two
protocols is unsupported, and there is no guard against it.
"""

import contextlib
import datetime
import json
import os
import socket
import stat
import sys
import tempfile
import time

import _oslock
import _shell

INDEX = "index.json"
LOCK = "index.lock"
VERSION = 1

# The keys of an index entry. folder is relative to the history dir; project
# is repo.root, or the shadow's project root; platform is sys.platform;
# first_launch and last_launch are ISO 8601 UTC; launches_recorded is the
# launch count the run's ledger recorded (_launches), or "unavailable".
ENTRY_KEYS = (
    "run_id", "folder", "ledger_dir",
    "project", "plan", "engine_version",
    "machine", "platform",
    "first_launch", "last_launch",
    "launches", "launches_recorded", "status", "acceptance",
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


# ---- selecting runs (shared by scripts/history and scripts/worth-it) ----

UNAVAILABLE = "unavailable"


def _windows_form(p):
    return p[1:3] == ":/" or p.startswith("//")


def matches_project(entry, name):
    """Whether the entry's project path is name, or ends in the component
    name."""
    project = entry.get("project")
    if not isinstance(project, str) or not project or project == UNAVAILABLE:
        return False
    key = _key_form(project)
    if key == _key_form(name):
        return True
    last = key.rstrip("/").rsplit("/", 1)[-1]
    return last == (name.lower() if _windows_form(key) else name)


def run_folder(hdir, entry):
    """The entry's folder as an absolute path inside hdir; None when it has
    no usable folder name or the name leads outside hdir."""
    folder = entry.get("folder")
    if not isinstance(folder, str) or not folder or os.path.isabs(folder) or _shell._drive_form(folder):
        return None
    path = os.path.normpath(os.path.join(hdir, folder))
    if os.path.normcase(path) == os.path.normcase(os.path.normpath(hdir)) or not inside(path, hdir):
        return None
    return path


# ---- one run's figures (1.6.4) ----

# The engine's phase labels, matched exactly: a lane may be named "Lane verify".
FIXED_PHASES = ("Pre-flight", "Integrate", "E2E", "Final review", "Verify")
FINAL_PHASE = "Final review"


def _ts(value):
    """Epoch seconds of an ISO 8601 UTC stamp ('...Z'), or None."""
    if not isinstance(value, str):
        return None
    try:
        return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _union(spans):
    total, start, end = 0.0, None, None
    for s, e in sorted(spans):
        if start is None:
            start, end = s, e
        elif s > end:
            total += end - start
            start, end = s, e
        else:
            end = max(end, e)
    return total + (end - start if start is not None else 0.0)


def _task_ids(manifest):
    ids = set()
    groups = [manifest.get("prelude"), manifest.get("join")]
    lanes = manifest.get("lanes")
    groups += [lane.get("tasks") for lane in lanes if isinstance(lane, dict)] if isinstance(lanes, list) else []
    for group in groups:
        for task in group if isinstance(group, list) else []:
            if isinstance(task, dict) and isinstance(task.get("id"), str):
                ids.add(task["id"])
    return ids


def latest_task_launch(analysis, manifest):
    """(launch, {task id: summed agent wall seconds}) for the latest launch
    (by its earliest task-agent start) whose agents include agents of a
    manifest task; None when there is none or the data is missing."""
    time_ = analysis.get("time") if isinstance(analysis, dict) else None
    agents = time_.get("agents") if isinstance(time_, dict) else None
    if not isinstance(agents, list) or not isinstance(manifest, dict):
        return None
    ids = _task_ids(manifest)
    launches = {}
    for a in agents:
        if not isinstance(a, dict) or a.get("task") not in ids:
            continue
        if not (a.get("launch") is None or isinstance(a.get("launch"), str)):
            continue
        start, end = _ts(a.get("start")), _ts(a.get("end"))
        if start is None or end is None or end < start:
            continue
        launches.setdefault(a.get("launch"), []).append((a["task"], start, end))
    if not launches:
        return None
    launch = max(launches, key=lambda wf: min(s for _, s, _ in launches[wf]))
    per_task = {}
    for task, start, end in launches[launch]:
        per_task[task] = per_task.get(task, 0.0) + (end - start)
    return launch, per_task


def run_figures(analysis, manifest):
    """One run's figures from its autopsy analysis, for the latest launch (by
    its earliest task-agent start) whose agents include agents of a manifest
    task: {launch, tasks, task_s, fixed_s, final_review_s, wall_s}. task_s is
    the mean over that launch's tasks of each task's summed agent wall time
    (every agent with that task: implement, review, fix, re-review,
    adjudicate); fixed_s the union of its FIXED_PHASES, final_review_s of its
    FINAL_PHASE, wall_s the span of its phases. None when no launch ran task
    agents or the data is missing."""
    time_ = analysis.get("time") if isinstance(analysis, dict) else None
    phases = time_.get("phases") if isinstance(time_, dict) else None
    found = latest_task_launch(analysis, manifest)
    if found is None or not isinstance(phases, list):
        return None
    launch, per_task = found
    spans = []
    for p in phases:
        if isinstance(p, dict) and p.get("launch") == launch:
            start, end = _ts(p.get("start")), _ts(p.get("end"))
            if start is not None and end is not None and end >= start:
                spans.append((p.get("phase"), start, end))
    if not spans:
        return None
    return {
        "launch": launch,
        "tasks": len(per_task),
        "task_s": round(sum(per_task.values()) / len(per_task), 1),
        "fixed_s": round(_union([(s, e) for name, s, e in spans if name in FIXED_PHASES]), 1),
        "final_review_s": round(_union([(s, e) for name, s, e in spans if name == FINAL_PHASE]), 1),
        "wall_s": round(max(e for _, _, e in spans) - min(s for _, s, _ in spans), 1),
    }


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


@contextlib.contextmanager
def index_lock(hdir, wait_s=30):
    """Hold <hdir>/index.lock, an exclusive lock on index.json; yields its path.

    The lock is an OS lock on the file (see the module docstring), released
    when the holder exits or its process ends; the file is never deleted.
    While another process holds it, the lock is retried every _RETRY_S
    seconds for up to wait_s seconds (wait_s=0 tries once), then
    HistoryError is raised; the first time it is found held, a notice that
    it waits goes to stderr. Once held, the file is rewritten with the
    holder's pid, time and host (for people reading it). A history dir where
    the lock file cannot be created raises HistoryError at once (on Windows
    a PermissionError is retried as held, as a file being deleted refuses
    it there).
    """
    os.makedirs(hdir, exist_ok=True)
    path = os.path.join(hdir, LOCK)
    # O_NOFOLLOW (POSIX): a symlink at the lock path is refused, so the
    # holder details never overwrite the file it points to.
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    deadline = time.monotonic() + wait_s
    waiting = False
    fd = None
    try:
        while True:
            if fd is None:
                try:
                    fd = os.open(path, flags, 0o644)
                except PermissionError as e:
                    if not _shell._is_windows(sys.platform):
                        raise HistoryError("cannot create " + path + ": " + str(e))
                except OSError as e:
                    raise HistoryError("cannot create " + path + ": " + str(e))
                if fd is not None and not stat.S_ISREG(os.fstat(fd).st_mode):
                    os.close(fd)
                    fd = None
                    raise HistoryError("cannot create " + path + ": not a regular file")
            if fd is not None:
                try:
                    if _oslock.try_lock(fd):
                        break
                except OSError as e:
                    raise HistoryError("cannot lock " + path + ": " + str(e))
            if time.monotonic() >= deadline:
                raise HistoryError(
                    path + " is held by another process (" + (_read_lock(path) or "no details")
                    + "); waited " + str(wait_s) + " s"
                )
            if not waiting:
                waiting = True
                sys.stderr.write("parallel-lanes: waiting for " + path + ", held by another process\n")
                sys.stderr.flush()
            time.sleep(_RETRY_S)
        try:
            details = json.dumps({"pid": os.getpid(), "time": _utc_now(), "host": socket.gethostname()})
            os.lseek(fd, 0, os.SEEK_SET)
            os.ftruncate(fd, 0)
            os.write(fd, details.encode("utf-8"))
            yield path
        finally:
            # Closing the file releases the lock too; unlocking first ends
            # it before anything else this process does on the way out.
            with contextlib.suppress(OSError):
                _oslock.unlock(fd)
    finally:
        if fd is not None:
            os.close(fd)
