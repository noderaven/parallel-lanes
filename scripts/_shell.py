"""Platform helpers shared by the Python scripts: Git Bash, paths, LF output.

Import with:
    sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
    import _shell

find_bash() is the one way to find the bash to start. On Windows the order is:
CLAUDE_CODE_GIT_BASH_PATH (it must name an existing bash.exe, bash, sh.exe or
sh, as Claude Code requires, or find_bash fails naming it), then bash on PATH
(skipping the WSL launchers in %SystemRoot%\\System32 and under
%LOCALAPPDATA%\\Microsoft\\WindowsApps), then C:/Program Files/Git and
C:/Program Files (x86)/Git. A <git>/usr/bin/bash.exe result becomes
<git>/bin/bash.exe when that exists: the launcher puts Git's tools on PATH. On
Linux and macOS it is the bash on PATH. Failure raises BashNotFound.

native_path() gives the one path form passed between components on Windows,
C:/... (what cygpath -m prints); elsewhere it returns its argument unchanged.

setup_io() and write_text() keep output LF and UTF-8 on every platform.
"""

import os
import re
import shutil
import subprocess
import sys

VARIABLE = "CLAUDE_CODE_GIT_BASH_PATH"
# The file names Claude Code accepts for CLAUDE_CODE_GIT_BASH_PATH.
_BASH_NAMES = ("bash.exe", "bash", "sh.exe", "sh")
_STANDARD = (
    "C:/Program Files/Git/bin/bash.exe",
    "C:/Program Files (x86)/Git/bin/bash.exe",
)
_DRIVE = re.compile(r"^([A-Za-z]):(?:[\\/](.*))?$", re.DOTALL)
_MSYS_DRIVE = re.compile(r"^/([A-Za-z])(?:/(.*))?$", re.DOTALL)

_cached_bash = None


class BashNotFound(Exception):
    """No usable bash; the message says what to set or install."""


class CygpathNotFound(BashNotFound):
    """cygpath, needed for a POSIX path on Windows, is missing or failed."""


def _is_windows(platform):
    return platform == "win32"


def _getenv(env, name):
    """env[name], matching the name case-insensitively as Windows does."""
    if name in env:
        return env[name]
    lower = name.lower()
    for key, value in env.items():
        if key.lower() == lower:
            return value
    return None


def _fold(p):
    """A Windows path for comparison: lower case, '/' separators, no trailing '/'."""
    return p.replace("\\", "/").lower().rstrip("/")


def _under(p, folder):
    return _fold(p).startswith(_fold(folder) + "/")


def _drive_form(p):
    """C:/... for a drive path (C:\\x, c:/x) or an MSYS drive path (/c/x); else None."""
    m = _DRIVE.match(p) or _MSYS_DRIVE.match(p)
    if not m:
        return None
    return m.group(1).upper() + ":/" + (m.group(2) or "").replace("\\", "/")


def _not_found(detail):
    return BashNotFound(
        detail + ". parallel-lanes needs Git Bash on Windows: install Git for Windows, "
        "or set " + VARIABLE + " to its bash.exe (for example "
        "C:/Program Files/Git/bin/bash.exe). On Linux and macOS, put bash on PATH."
    )


def _is_wsl_launcher(p, env):
    root = _getenv(env, "SystemRoot") or "C:\\Windows"
    if _under(p, root + "/System32"):
        return True
    local = _getenv(env, "LOCALAPPDATA")
    return bool(local) and _under(p, local + "/Microsoft/WindowsApps")


def _prefer_launcher(p, isfile):
    """<git>/bin/bash.exe in place of <git>/usr/bin/bash.exe when it exists."""
    folded = _fold(p)
    for tail in ("/usr/bin/bash.exe", "/usr/bin/bash"):
        if folded.endswith(tail):
            launcher = p[: len(p) - len(tail)] + "/bin/bash.exe"
            if isfile(launcher):
                return launcher
    return p


def _find_windows_bash(env, which, isfile):
    configured = _getenv(env, VARIABLE)
    if configured:
        native = _drive_form(configured) or configured
        name = native.replace("\\", "/").rsplit("/", 1)[-1].lower()
        if not isfile(configured):
            raise _not_found(VARIABLE + " is set to " + configured + ", which is not a file")
        if name not in _BASH_NAMES:
            raise _not_found(
                VARIABLE + " is set to " + configured + ", which is not bash.exe, bash, sh.exe or sh"
            )
        return _prefer_launcher(native, isfile)
    on_path = which("bash")
    if on_path and not _is_wsl_launcher(on_path, env):
        return _prefer_launcher(_drive_form(on_path) or on_path, isfile)
    for standard in _STANDARD:
        if isfile(standard):
            return standard
    raise _not_found("no Git Bash found on PATH or in C:/Program Files")


def find_bash(env=None, platform=None, which=None, isfile=None):
    """The absolute path of the bash to start; raises BashNotFound.

    Defaults: os.environ, sys.platform, shutil.which (on env's PATH),
    os.path.isfile. The result is cached per process only for a call with
    every default.
    """
    global _cached_bash
    defaults = env is None and platform is None and which is None and isfile is None
    if defaults and _cached_bash is not None:
        return _cached_bash
    env = os.environ if env is None else env
    platform = sys.platform if platform is None else platform
    if which is None:
        path = _getenv(env, "PATH")
        which = lambda name: shutil.which(name, path=path)  # noqa: E731
    isfile = os.path.isfile if isfile is None else isfile
    if _is_windows(platform):
        found = _find_windows_bash(env, which, isfile)
    else:
        found = which("bash")
        if not found:
            raise _not_found("no bash found on PATH")
    if defaults:
        _cached_bash = found
    return found


def _default_cygpath():
    """<git root>/usr/bin/cygpath.exe for the Git Bash find_bash returns."""
    folder = find_bash().replace("\\", "/").rsplit("/", 1)[0]
    folded = folder.lower()
    if folded.endswith("/usr/bin"):
        root = folder[: -len("/usr/bin")]
    elif folded.endswith("/bin"):
        root = folder[: -len("/bin")]
    else:
        return folder + "/cygpath.exe"
    return root + "/usr/bin/cygpath.exe"


def native_path(p, platform=None, cygpath=None):
    """p in the one Windows form, C:/... ; unchanged on other platforms.

    On Windows: C:\\x and c:/x become C:/x, /c/x becomes C:/x, UNC and
    relative paths get '/' separators, and any other '/'-rooted path (/tmp/x)
    is converted with cygpath -m. cygpath defaults to
    <git root>/usr/bin/cygpath.exe next to find_bash()'s result; when it is
    missing or fails, CygpathNotFound (a BashNotFound) is raised.
    """
    platform = sys.platform if platform is None else platform
    if not _is_windows(platform):
        return p
    drive = _drive_form(p)
    if drive is not None:
        return drive
    if not p.startswith("/") or p.startswith("//"):
        return p.replace("\\", "/")
    if cygpath is None:
        cygpath = _default_cygpath()
    try:
        res = subprocess.run([cygpath, "-m", p], stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, universal_newlines=True)
    except OSError as e:
        raise CygpathNotFound(
            "cannot convert " + p + " to a Windows path: cygpath " + cygpath
            + " could not run (" + str(e) + "). Install Git for Windows, or set "
            + VARIABLE + " to the bash.exe of a complete Git for Windows installation."
        )
    out = res.stdout.strip("\r\n")
    if res.returncode != 0 or not out:
        raise CygpathNotFound(
            "cannot convert " + p + " to a Windows path: cygpath " + cygpath
            + " exited " + str(res.returncode) + ": " + res.stderr.strip()
        )
    return _drive_form(out) or out


def bash_argv(*args):
    """[find_bash(), *args]: an argument list that starts the right bash."""
    return [find_bash()] + list(args)


def setup_io():
    """Make stdout and stderr UTF-8 with LF line endings on every platform."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", newline="\n")


def write_text(path, text):
    """Write text to path as UTF-8 with LF line endings."""
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
