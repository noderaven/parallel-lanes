"""The OS lock on an open file, shared by the history index lock (_history)
and the check-file lock (_await).

Import with:
    sys.dont_write_bytecode = True
    sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
    import _oslock

On POSIX the lock is fcntl.flock(LOCK_EX) on the whole file; on Windows it is
msvcrt.locking on one byte at WIN_LOCK_OFFSET (1 GiB, past the end of the
file), so the file's text stays readable. The OS releases the lock when the
holder's process ends, however it ends, so a lock that can be taken means
its last holder is gone. Each open of the file is a separate holder, in the
same process too.
"""

import errno
import os
import sys

import _shell

# On Windows the lock is on the one byte at this offset, past any text at the
# start of the file: msvcrt.locking locks are mandatory, so a lock on the
# text itself would keep others from reading it.
WIN_LOCK_OFFSET = 2 ** 30

if _shell._is_windows(sys.platform):
    import msvcrt
else:
    import fcntl


def _held(e):
    """Whether OSError e from a non-blocking lock means another holder."""
    return e.errno in (errno.EACCES, errno.EAGAIN, errno.EWOULDBLOCK, errno.EDEADLK)


def try_lock(fd):
    """Take the lock on fd without waiting; whether it was taken. Raises
    OSError for any failure but another holder."""
    try:
        if _shell._is_windows(sys.platform):
            # msvcrt.locking locks from the current position.
            os.lseek(fd, WIN_LOCK_OFFSET, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        else:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as e:
        if _held(e):
            return False
        raise
    return True


def unlock(fd):
    """Release the lock try_lock took on fd."""
    if _shell._is_windows(sys.platform):
        os.lseek(fd, WIN_LOCK_OFFSET, os.SEEK_SET)
        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
    else:
        fcntl.flock(fd, fcntl.LOCK_UN)
