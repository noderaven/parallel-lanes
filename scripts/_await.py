"""The check-file lock: how a check's writer and its waiters share one report
file (FILE).

Import with:
    sys.dont_write_bytecode = True
    sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
    import _await

The writer of FILE (the outermost one: run-checks, or task-checks, which
passes run-checks --lock-held) holds hold(FILE) from start to finish. hold
keeps an OS lock (_oslock) on the sidecar FILE + SIDECAR, writes nothing to
it, and deletes it: on POSIX while it still holds the lock (a departure from
the order spec 4.3 gives, release then delete: in that gap a second holder
could lock the inode that is about to be deleted), on Windows after releasing
the lock, since an open file cannot be deleted there. The writer replaces FILE in one
step (_shell.write_text_atomic) before it releases the lock.

A waiter never holds anything between polls. writer_alive(FILE) takes the
sidecar's lock without waiting and releases it at once: a lock it cannot take
means a live writer. The OS releases the lock when the writer's process ends,
however it ends, so a lock that can be taken while FILE is still empty means
the writer is gone; a killed writer leaves its sidecar behind, which the next
hold reuses. The waiter's order is writer_alive, then read_report: a writer
that finishes between the two is still seen.

On Windows Python opens files without delete sharing, so deleting the
sidecar fails while a waiter's probe has it open, and opening it fails
(PermissionError) while a delete is pending. Neither is an error here: a
leftover sidecar is harmless, a pending delete means no live writer, and hold
retries the open.
"""

import contextlib
import json
import os
import stat
import sys
import time

import _oslock
import _shell

SIDECAR = ".lock"

# How hold retries the sidecar's lock: a waiter's probe holds it only for an
# instant, so every _RETRY_S seconds for up to _WAIT_S seconds.
_RETRY_S = 0.05
_WAIT_S = 5

_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_BINARY = getattr(os, "O_BINARY", 0)


def _same_file(fd, path):
    """Whether path still names the file open on fd (not deleted and made
    again by another holder in the meantime)."""
    try:
        now = os.stat(path, follow_symlinks=False)
    except OSError:
        return False
    held = os.fstat(fd)
    return (now.st_dev, now.st_ino) == (held.st_dev, held.st_ino)


@contextlib.contextmanager
def hold(path):
    """Hold the check-file lock of path (a lock on path + SIDECAR); yields
    the sidecar's path.

    The sidecar is opened, created if missing (never through a symlink where
    the platform can refuse one), and locked; the lock is retried every 0.05
    s for up to 5 s, then OSError is raised. On the way out on POSIX
    the sidecar is deleted while the lock is still held, then the lock is
    released and the sidecar closed; on Windows the lock is released and the
    sidecar closed, then deleted. A failed delete is ignored.
    """
    lock = path + SIDECAR
    flags = os.O_RDWR | os.O_CREAT | _BINARY | _NOFOLLOW
    deadline = time.monotonic() + _WAIT_S
    windows = _shell._is_windows(sys.platform)
    fd = None
    while True:
        try:
            fd = os.open(lock, flags, 0o644)
        except PermissionError:
            # On Windows: the sidecar is being deleted; retry below.
            if not windows:
                raise
        if fd is not None:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                os.close(fd)
                raise OSError("cannot lock " + lock + ": not a regular file")
            try:
                taken = _oslock.try_lock(fd)
            except OSError:
                os.close(fd)
                raise
            if taken and _same_file(fd, lock):
                break
            if taken:
                _oslock.unlock(fd)
            os.close(fd)
            fd = None
        if time.monotonic() >= deadline:
            raise OSError(lock + " is held by another process; waited " + str(_WAIT_S) + " s")
        time.sleep(_RETRY_S)
    try:
        yield lock
    finally:
        if not windows:
            # POSIX: delete while the lock is still held, so a process that
            # then locks the old inode fails _same_file and retries.
            with contextlib.suppress(OSError):
                os.remove(lock)
        with contextlib.suppress(OSError):
            _oslock.unlock(fd)
        os.close(fd)
        if windows:
            # Windows cannot delete an open file: release and close first.
            with contextlib.suppress(OSError):
                os.remove(lock)


def writer_alive(path):
    """Whether a writer holds the check-file lock of path now.

    The sidecar is opened without creating it: a missing sidecar, or one
    Windows refuses to open (PermissionError: a delete is pending), means no
    live writer. When its lock can be taken, it is released at once and the
    answer is False; when it is held, True."""
    try:
        fd = os.open(path + SIDECAR, os.O_RDONLY | _BINARY | _NOFOLLOW)
    except (FileNotFoundError, PermissionError):
        return False
    try:
        if _oslock.try_lock(fd):
            with contextlib.suppress(OSError):
                _oslock.unlock(fd)
            return False
        return True
    finally:
        os.close(fd)


def read_report(path):
    """The JSON object in path, or None when the file is missing, empty,
    unreadable, not JSON or not an object. The file is opened, read and
    closed in one go, so a waiter never keeps it open."""
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except OSError:
        return None
    try:
        report = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    return report if isinstance(report, dict) else None
