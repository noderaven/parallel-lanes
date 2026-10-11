"""doctor's checks: what blocks a launch, read from the machine without changing it.

Import with:
    sys.dont_write_bytecode = True
    sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
    import _doctor

run_checks(manifest, probes) runs every check and returns
    {"status": "ok" | "blocked",
     "failures": [{"check", "detail", "fix"}],
     "warnings": [{"check", "detail"}],
     "skipped": [{"check", "reason"}],
     "checks": [{"check", "outcome": "passed" | "warning" | "failed" | "skipped"}],
     "observed_at": "YYYY-MM-DDTHH:MM:SSZ",
     "doctor_version": "<the skill's VERSION>" | "unavailable",
     "run_id": "<the manifest's run_id>" | null}
status is "blocked" when there is at least one failure. The manifest's repo
paths are used as given (the doctor CLI puts them in the C:/... form first).

checks lists every name in CHECKS, in that order (the order the checks run),
with the outcome each check recorded: every check_* records exactly one of
passed, warn, fail or skip on every path. A check that recorded nothing (a
bug) is listed as skipped, with a skipped entry of reason not_recorded, and
never as passed; a check recorded more than once keeps its worst outcome
(failed, then warning, then skipped, then passed). observed_at is the UTC
time the checks began; doctor_version is read_version() of the skill dir;
run_id is the manifest's run_id when it is a non-empty string.

Every platform read goes through a Probes object, so a test can replace any
of them; default_probes() reads this machine. Nothing here writes a file, a
ref or a config value, and nothing fetches: git runs with
GIT_OPTIONAL_LOCKS=0 (git status does not refresh the index) and
GIT_NO_LAZY_FETCH=1 (a partial clone does not fetch a missing object), and
the upstream tip is read with git ls-remote.

Hard failures (they block a launch):
- git_identity: git var GIT_COMMITTER_IDENT fails with user.useConfigOnly
  set (so git does not invent user@host), after the -c user.name=... and
  -c user.email=... pairs commit_rules passes.
- base_not_current: the local repo.base_ref does not contain its upstream's
  tip. The detail is behind (the base is an ancestor of the tip), diverged
  (neither contains the other) or unknown (the tip is not in the local repo,
  or a shallow repo cannot show the ancestry). A failure for a new run, a
  warning on a resume (repo.branch exists). An unreachable remote is a
  warning; a base with no upstream is skipped.
- python: the manifest's python (shell-quoted, default python3) does not
  run Python 3.8 or newer.
- dirty_checkout (git mode): repo.root has uncommitted changes or untracked,
  non-ignored files. Skipped as not_applicable in shadow mode.
- shadow_repo (shadow mode): repo.git_dir is missing, is not a complete
  shadow (pl-baseline and pl-project), or git cannot read its baseline.
  Skipped as not_applicable in git mode.

Warnings (they never block). A read that fails, or a probe that raises, is a
warning with detail unknown; a check that does not apply to the platform is
skipped as not_applicable.
- memory: under 4 GB of physical memory available, or (Windows) available
  commit under 10% of the commit limit.
- disk: under 5 GB free on the drive of repo.worktree_root, or of its
  nearest existing parent.
- python_alias (Windows): the manifest's python is in a WindowsApps folder
  (a bare name is looked up on PATH first).
- heavy_processes: on Windows AppXSvc's working set over 1500 MB; elsewhere a
  1-minute load average over the CPU count.
- active_runs: active-run list has a locked run other than this run_id.
- defender (Windows): repo.worktree_root is not under a Defender exclusion.
  The detail is only "not covered" or "unknown"; the exclusion paths are
  compared here and never printed or returned.
- concurrency: CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS is unset, or lower
  than min(limits.max_parallel_lanes, lane count).
"""

import base64
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time

import _shell

# The skill's folder: the scripts folder's parent, which holds VERSION.
SKILL_DIR = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))

# Every check, in the order run_checks runs them.
CHECKS = ("git_identity", "base_not_current", "python", "dirty_checkout", "shadow_repo",
          "memory", "disk", "python_alias", "heavy_processes", "active_runs", "defender",
          "concurrency")
# A check recorded more than once keeps the outcome ranked highest.
_OUTCOME_RANK = {"passed": 0, "skipped": 1, "warning": 2, "failed": 3}

# Variables that would point git at another repo than the one named.
GIT_REDIRECTS = ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE",
                 "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR")
LS_REMOTE_TIMEOUT_S = 15
PYTHON_TIMEOUT_S = 30
MIN_PYTHON = (3, 8)
# How many dirty paths a dirty_checkout detail names.
DIRTY_NAMED = 10

DIRTY_FIX = (
    "commit source files the work needs; add only known generated output to "
    ".gitignore; never ignore a file a check reads. Then launch again."
)

GB = 1024 ** 3
MB = 1024 ** 2
MIN_MEMORY = 4 * GB
MIN_COMMIT_SHARE = 0.10
MIN_DISK = 5 * GB
MAX_APPX_WORKING_SET = 1500 * MB
POWERSHELL_TIMEOUT_S = 15
READ_TIMEOUT_S = 15
ACTIVE_RUN_TIMEOUT_S = 30
CONCURRENCY_VARIABLE = "CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS"
_WINDOWS_APPS = re.compile(r"(^|[\\/])WindowsApps([\\/]|$)", re.IGNORECASE)

# One PowerShell call reads both Windows values, each on its own so that one
# failing (Get-MpPreference needs Defender, and elevation to see the list)
# leaves the other. It prints {"appx": bytes|null, "exclusions": [...]|null}.
_WINDOWS_READS = """
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$r = @{}
try {
  $s = Get-CimInstance Win32_Service -Filter "Name='AppXSvc'"
  if ($s -and $s.ProcessId) { $r.appx = (Get-Process -Id $s.ProcessId).WorkingSet64 } else { $r.appx = 0 }
} catch { $r.appx = $null }
try {
  $x = (Get-MpPreference).ExclusionPath
  if ($null -eq $x) { $r.exclusions = @() } else { $r.exclusions = @($x) }
} catch { $r.exclusions = $null }
$r | ConvertTo-Json -Compress
"""


class Result:
    """A finished command: its exit code, stdout and stderr."""

    def __init__(self, code, out="", err=""):
        self.code = code
        self.out = out
        self.err = err


class Probes:
    """The platform reads the checks make. Each can be replaced by a test.

    git(args) -> Result: git with args, in the environment env.
    ls_remote(prefix, remote, ref) -> Result, or None when the remote did not
        answer within LS_REMOTE_TIMEOUT_S seconds.
    run(argv, timeout) -> Result, or None when argv cannot be started or
        does not finish in time.
    memory() -> {"available": bytes of physical memory available, and on
        Windows "commit_limit" and "commit_available" in bytes}, or None.
    disk_free(path) -> the free bytes on path's drive, or None.
    load_average() -> (1-minute load average, CPU count), or None.
    appx_working_set() -> AppXSvc's working set in bytes (0 when it has no
        process), or None. Windows only.
    defender_exclusions() -> Defender's exclusion paths, or None when they
        cannot be read. Windows only.
    active_runs() -> the entries active-run list prints, or None.
    which(name) -> the file name resolves to on env's PATH, or None.
    env: the environment the commands run in.
    platform: sys.platform's value for the machine checked.
    A probe may also raise; the check then treats the read as failed.
    """

    def __init__(self, env=None, platform=None, git=None, ls_remote=None, run=None,
                 memory=None, disk_free=None, load_average=None, appx_working_set=None,
                 defender_exclusions=None, active_runs=None, which=None):
        self.env = dict(os.environ) if env is None else env
        self.platform = sys.platform if platform is None else platform
        self.git = git or self._git
        self.ls_remote = ls_remote or self._ls_remote
        self.run = run or self._run
        self.memory = memory or self._memory
        self.disk_free = disk_free or self._disk_free
        self.load_average = load_average or self._load_average
        self.appx_working_set = appx_working_set or self._appx_working_set
        self.defender_exclusions = defender_exclusions or self._defender_exclusions
        self.active_runs = active_runs or self._active_runs
        self.which = which or self._which
        self._windows = None

    def _git_env(self):
        env = {k: v for k, v in self.env.items() if k not in GIT_REDIRECTS}
        env["GIT_OPTIONAL_LOCKS"] = "0"
        env["GIT_NO_LAZY_FETCH"] = "1"
        return env

    def _command(self, argv, env, timeout=None, stderr=subprocess.PIPE):
        # subprocess.run's timeout is not a bound: on TimeoutExpired it kills
        # only argv's own process and then waits until every handle to the
        # pipes closes. A child that inherited them (git ls-remote starts
        # git-remote-https or ssh) keeps that wait going until it ends by
        # itself, which on a stalled network can be never. So on a timeout
        # the whole process tree is killed and the pipes are not waited on.
        # With a timeout on POSIX, the command gets its own session so that
        # os.killpg reaches every process it started.
        tree = timeout is not None and sys.platform != "win32"
        try:
            proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                    stderr=stderr, text=True, encoding="utf-8",
                                    errors="replace", env=env, start_new_session=tree)
        except OSError:
            return None
        try:
            out, err = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            _kill_tree(proc)
            return None
        return Result(proc.returncode, out or "", err or "")

    def _git(self, args):
        res = self._command(["git"] + list(args), self._git_env())
        return res if res is not None else Result(127, "", "git could not run")

    def _ls_remote(self, prefix, remote, ref):
        env = self._git_env()
        # Never wait for a password prompt: an unanswered remote is a warning.
        env["GIT_TERMINAL_PROMPT"] = "0"
        env["GCM_INTERACTIVE"] = "never"
        # The check never reads stderr. Sending it to DEVNULL means the
        # transport git starts (git-remote-https, ssh), which inherits git's
        # stderr, holds no pipe of ours; _command still kills the whole tree
        # on a timeout, so the 15 s bound holds either way.
        return self._command(["git"] + list(prefix) + ["ls-remote", remote, ref], env,
                             timeout=LS_REMOTE_TIMEOUT_S, stderr=subprocess.DEVNULL)

    def _run(self, argv, timeout):
        return self._command(argv, self.env, timeout=timeout)

    def _memory(self):
        if self.platform == "win32":
            return _windows_memory()
        if self.platform == "darwin":
            return self._mac_memory()
        with open("/proc/meminfo", encoding="utf-8") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    return {"available": int(line.split()[1]) * 1024}
        return None

    def _mac_memory(self):
        """free + inactive + speculative pages from vm_stat, capped at hw.memsize."""
        res = self.run(["vm_stat"], READ_TIMEOUT_S)
        if res is None or res.code != 0:
            return None
        size = re.search(r"page size of (\d+) bytes", res.out)
        pages = {}
        for line in res.out.splitlines():
            name, _, value = line.partition(":")
            value = value.strip().rstrip(".")
            if value.isdigit():
                pages[name.strip()] = int(value)
        if not size or "Pages free" not in pages:
            return None
        names = ("Pages free", "Pages inactive", "Pages speculative")
        available = sum(pages.get(n, 0) for n in names) * int(size.group(1))
        total = self.run(["sysctl", "-n", "hw.memsize"], READ_TIMEOUT_S)
        if total is not None and total.code == 0 and total.out.strip().isdigit():
            available = min(available, int(total.out.strip()))
        return {"available": available}

    def _disk_free(self, path):
        return shutil.disk_usage(path).free

    def _load_average(self):
        cpus = os.cpu_count()
        if not cpus:
            return None
        return (os.getloadavg()[0], cpus)

    def _windows_reads(self):
        """The one PowerShell call's result, made at most once per Probes."""
        if self._windows is None:
            script = base64.b64encode(_WINDOWS_READS.encode("utf-16-le")).decode("ascii")
            res = self.run(["powershell", "-NoProfile", "-NonInteractive",
                            "-EncodedCommand", script], POWERSHELL_TIMEOUT_S)
            reads = {}
            if res is not None and res.code == 0:
                try:
                    # PowerShell may start its output with a byte order mark.
                    parsed = json.loads(res.out.strip().lstrip(chr(0xFEFF)))
                except ValueError:
                    parsed = None
                if isinstance(parsed, dict):
                    reads = parsed
            self._windows = reads
        return self._windows

    def _appx_working_set(self):
        return self._windows_reads().get("appx")

    def _defender_exclusions(self):
        return self._windows_reads().get("exclusions")

    def _active_runs(self):
        here = os.path.dirname(os.path.realpath(__file__)).replace("\\", "/")
        res = self.run(_shell.bash_argv(here + "/active-run", "list"), ACTIVE_RUN_TIMEOUT_S)
        if res is None or res.code != 0:
            return None
        return json.loads(res.out)

    def _which(self, name):
        return shutil.which(name, path=_shell._getenv(self.env, "PATH"))


def _windows_memory():
    """GlobalMemoryStatusEx's available memory and commit, in bytes, or None."""
    import ctypes
    from ctypes import wintypes

    class MemoryStatusEx(ctypes.Structure):
        _fields_ = [
            ("dwLength", wintypes.DWORD),
            ("dwMemoryLoad", wintypes.DWORD),
            ("ullTotalPhys", ctypes.c_ulonglong),
            ("ullAvailPhys", ctypes.c_ulonglong),
            ("ullTotalPageFile", ctypes.c_ulonglong),
            ("ullAvailPageFile", ctypes.c_ulonglong),
            ("ullTotalVirtual", ctypes.c_ulonglong),
            ("ullAvailVirtual", ctypes.c_ulonglong),
            ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
        ]

    status = MemoryStatusEx()
    status.dwLength = ctypes.sizeof(MemoryStatusEx)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
        return None
    # ullTotalPageFile and ullAvailPageFile are the commit limit and the
    # commit still available, despite their names.
    return {
        "available": status.ullAvailPhys,
        "commit_limit": status.ullTotalPageFile,
        "commit_available": status.ullAvailPageFile,
    }


def _kill_tree(proc):
    """Kill proc and every process it started, without waiting on its pipes."""
    try:
        if sys.platform == "win32":
            # /T kills the tree by parent pid, so it runs before proc dies.
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=10)
        else:
            os.killpg(proc.pid, signal.SIGKILL)
    except (OSError, subprocess.SubprocessError):
        pass
    try:
        proc.kill()
    except OSError:
        pass
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass


def default_probes():
    """Probes that read this machine."""
    return Probes()


def read_version(skill_dir):
    """The stripped contents of skill_dir/VERSION, or "unavailable"."""
    try:
        with open(os.path.join(skill_dir, "VERSION"), encoding="utf-8") as f:
            version = f.read().strip()
    except (OSError, UnicodeDecodeError):
        return "unavailable"
    return version or "unavailable"


class _Report:
    def __init__(self):
        self.failures = []
        self.warnings = []
        self.skipped = []
        self.outcomes = {}

    def _record(self, check, outcome):
        old = self.outcomes.get(check)
        if old is None or _OUTCOME_RANK[outcome] > _OUTCOME_RANK[old]:
            self.outcomes[check] = outcome

    def passed(self, check):
        self._record(check, "passed")

    def fail(self, check, detail, fix):
        self.failures.append({"check": check, "detail": detail, "fix": fix})
        self._record(check, "failed")

    def warn(self, check, detail):
        self.warnings.append({"check": check, "detail": detail})
        self._record(check, "warning")

    def skip(self, check, reason):
        self.skipped.append({"check": check, "reason": reason})
        self._record(check, "skipped")

    def result(self):
        skipped = list(self.skipped)
        checks = []
        for name in CHECKS:
            outcome = self.outcomes.get(name)
            if outcome is None:
                # A check that recorded nothing is never shown as passed.
                outcome = "skipped"
                skipped.append({"check": name, "reason": "not_recorded"})
            checks.append({"check": name, "outcome": outcome})
        return {
            "status": "blocked" if self.failures else "ok",
            "failures": self.failures,
            "warnings": self.warnings,
            "skipped": skipped,
            "checks": checks,
        }


def _text(value):
    return value if isinstance(value, str) and value else None


def _shadow_problem(git_dir, probes):
    """Why git_dir is not a usable shadow repo, or None when it is."""
    if not git_dir:
        return "repo.git_dir is not set"
    if not os.path.isdir(git_dir):
        return "missing: " + git_dir
    for name in ("pl-baseline", "pl-project"):
        if not os.path.isfile(os.path.join(git_dir, name)):
            return "not a complete shadow (no " + name + "): " + git_dir
    try:
        with open(os.path.join(git_dir, "pl-baseline"), encoding="utf-8") as f:
            baseline = f.read().strip()
    except (OSError, UnicodeDecodeError):
        return "broken (pl-baseline cannot be read): " + git_dir
    res = probes.git(["--git-dir=" + git_dir, "rev-parse", "--verify", "--quiet",
                      "--end-of-options", baseline + "^{commit}"])
    if not baseline or res.code != 0:
        return "broken (git cannot read its baseline commit): " + git_dir
    return None


def _git_prefix(repo, probes):
    """The git arguments that select the run's repo, or None without one."""
    if repo.get("mode") == "shadow":
        git_dir = _text(repo.get("git_dir"))
        if _shadow_problem(git_dir, probes) is not None:
            return None
        return ["--git-dir=" + git_dir]
    root = _text(repo.get("root"))
    if not root or not os.path.isdir(root):
        return None
    if probes.git(["-C", root, "rev-parse", "--git-dir"]).code != 0:
        return None
    return ["-C", root]


# -c NAME=VALUE in commit_rules: the pair quoted, NAME="VALUE", or a bare word.
_CONFIG_PAIR = re.compile(
    r"""(?:^|[\s`(])-c\s+(?:"([^"]*)"|'([^']*)'|([\w.]+=(?:"[^"]*"|'[^']*'))|([^\s`]+))""")
_IDENTITY_KEYS = ("user.name=", "user.email=")


def identity_pairs(commit_rules):
    """The -c user.name=... and -c user.email=... pairs commit_rules passes."""
    pairs = []
    for m in _CONFIG_PAIR.finditer(commit_rules or ""):
        if m.group(4) is not None:
            # A bare word may end a sentence or a parenthesis.
            pair = m.group(4).rstrip(".,;:)")
        else:
            pair = next(g for g in m.groups()[:3] if g is not None)
        key, eq, value = pair.partition("=")
        if eq and (key.lower() + "=") in _IDENTITY_KEYS and value.strip(" \"'"):
            pairs.append(key + "=" + value.strip(" \"'"))
    return pairs


def check_git_identity(manifest, probes, prefix, report):
    rules = manifest.get("commit_rules")
    pairs = identity_pairs(rules if isinstance(rules, str) else "")
    args = list(prefix) if prefix else ["-C", tempfile.gettempdir()]
    for pair in pairs:
        args += ["-c", pair]
    args += ["-c", "user.useConfigOnly=true", "var", "GIT_COMMITTER_IDENT"]
    res = probes.git(args)
    if res.code == 0 and res.out.strip():
        report.passed("git_identity")
        return
    report.fail(
        "git_identity",
        "git has no committer identity (git var GIT_COMMITTER_IDENT fails)",
        "set one with git config --global user.name NAME and git config --global "
        "user.email EMAIL, or name one that commit_rules passes as git -c "
        "user.name=... -c user.email=... commit.",
    )


def _ancestor(probes, prefix, a, b):
    """True when commit a is an ancestor of b, False when not, None when git cannot tell."""
    res = probes.git(list(prefix) + ["merge-base", "--is-ancestor", a, b])
    if res.code == 0:
        return True
    if res.code == 1:
        return False
    return None


def _base_fix(detail, name, remote, merge):
    upstream = remote + " " + merge
    if detail == "behind":
        return ("update the local " + name + " to " + upstream + ": git fetch " + remote
                + ", then git merge --ff-only on " + name + ". doctor never fetches.")
    if detail == "diverged":
        return ("the local " + name + " and " + upstream + " each have commits the other "
                "lacks: reconcile them the way the project does (merge or rebase), or set "
                "repo.base_ref to the commit the run should start from.")
    return ("the tip of " + upstream + " is not in the local repo: git fetch " + remote
            + " (git fetch --unshallow in a shallow clone), then bring " + name
            + " up to date. doctor never fetches.")


def check_base_not_current(manifest, probes, prefix, report):
    check = "base_not_current"
    repo = manifest.get("repo") or {}
    base = _text(repo.get("base_ref"))
    if prefix is None or base is None:
        report.skip(check, "no_repo")
        return
    # Without --verify, rev-parse echoes --end-of-options on a line of its own.
    full = probes.git(list(prefix) + ["rev-parse", "--symbolic-full-name", "--end-of-options", base])
    full_name = full.out.strip().splitlines()[-1] if full.code == 0 and full.out.strip() else ""
    if not full_name.startswith("refs/heads/"):
        report.skip(check, "no_upstream")
        return
    name = full_name[len("refs/heads/"):]
    remote = probes.git(list(prefix) + ["config", "--get", "branch." + name + ".remote"]).out.strip()
    merge = probes.git(list(prefix) + ["config", "--get", "branch." + name + ".merge"]).out.strip()
    if not remote or not merge or remote.startswith("-"):
        report.skip(check, "no_upstream")
        return
    branch = _text(repo.get("branch"))
    resume = branch is not None and probes.git(
        list(prefix) + ["show-ref", "--verify", "--quiet", "refs/heads/" + branch]).code == 0

    listing = probes.ls_remote(prefix, remote, merge)
    if listing is None or listing.code != 0:
        report.warn(check, "unreachable: the upstream " + remote + " did not answer, so the base was not compared")
        return
    tip = None
    for line in listing.out.splitlines():
        sha, _, ref = line.partition("\t")
        if ref.strip() == merge:
            tip = sha.strip()
    if not tip:
        report.warn(check, "the upstream branch " + merge + " is not on " + remote)
        return
    local = probes.git(list(prefix) + ["rev-parse", "--verify", "--quiet", "--end-of-options", base + "^{commit}"])
    local_sha = local.out.strip()
    if local.code != 0 or not local_sha:
        report.skip(check, "no_base")
        return

    if local_sha == tip:
        report.passed(check)
        return
    present = probes.git(list(prefix) + ["cat-file", "-e", tip + "^{commit}"]).code == 0
    if not present:
        detail = "unknown"
    else:
        contains = _ancestor(probes, prefix, tip, local_sha)
        if contains:
            report.passed(check)
            return
        behind = _ancestor(probes, prefix, local_sha, tip)
        shallow = probes.git(list(prefix) + ["rev-parse", "--is-shallow-repository"]).out.strip() == "true"
        if contains is None or behind is None:
            detail = "unknown"
        elif behind:
            detail = "behind"
        elif shallow:
            # A shallow repo's history is cut, so "neither contains the other" is unproven.
            detail = "unknown"
        else:
            detail = "diverged"
    if resume:
        report.warn(check, detail)
    else:
        report.fail(check, detail, _base_fix(detail, name, remote, merge))


def _python_argv(manifest):
    """(text, argv): the manifest's python command (python3 when unset or
    blank) and its shell words ([] when its quoting does not parse)."""
    python = manifest.get("python")
    python = python if isinstance(python, str) and python.strip() else "python3"
    try:
        argv = shlex.split(python)
    except ValueError:
        argv = []
    return python, argv


def check_python(manifest, probes, report):
    check = "python"
    fix = ("set the manifest's python to a Python 3.8 or newer (scripts/find-python "
           "prints one), shell-quoted.")
    python, argv = _python_argv(manifest)
    if not argv:
        report.fail(check, "python is not a shell-quoted command", fix)
        return
    if probes.platform == "win32":
        argv[0] = _shell._drive_form(argv[0]) or argv[0]
    res = probes.run(argv + ["-c", "import sys; print('%d.%d.%d' % sys.version_info[:3])"],
                     PYTHON_TIMEOUT_S)
    if res is None:
        report.fail(check, "python does not run: " + argv[0], fix)
        return
    if res.code != 0:
        report.fail(check, "python exited " + str(res.code) + ": " + argv[0], fix)
        return
    m = re.match(r"^(\d+)\.(\d+)\.(\d+)$", res.out.strip())
    if not m:
        report.fail(check, "python did not report a version: " + argv[0], fix)
        return
    if (int(m.group(1)), int(m.group(2))) < MIN_PYTHON:
        report.fail(check, "python is " + res.out.strip() + ", older than 3.8: " + argv[0], fix)
    else:
        report.passed(check)


def _dirty_paths(porcelain):
    """The paths in git status --porcelain -z output."""
    paths = []
    entries = porcelain.split("\0")
    i = 0
    while i < len(entries):
        entry = entries[i]
        i += 1
        if len(entry) < 4:
            continue
        paths.append(entry[3:])
        # A rename or copy, in the index (X) or the work tree (Y, as for an
        # intent-to-add file), is followed by its source path.
        if entry[0] in "RC" or entry[1] in "RC":
            i += 1
    return paths


def check_dirty_checkout(manifest, probes, prefix, report):
    check = "dirty_checkout"
    repo = manifest.get("repo") or {}
    if repo.get("mode") == "shadow":
        report.skip(check, "not_applicable")
        return
    root = _text(repo.get("root")) or ""
    if prefix is None:
        report.fail(check, "repo.root is not a git checkout: " + root,
                    "point repo.root at the project's git checkout, or use shadow mode for "
                    "a folder that is not a git repo.")
        return
    # --untracked-files is explicit: without it git follows the user's
    # status.showUntrackedFiles, and =no would hide untracked files.
    res = probes.git(list(prefix) + ["status", "--porcelain", "-z", "--untracked-files=normal"])
    if res.code != 0:
        report.fail(check, "git status failed in " + root, DIRTY_FIX)
        return
    paths = _dirty_paths(res.out)
    if not paths:
        report.passed(check)
        return
    named = ", ".join(paths[:DIRTY_NAMED])
    more = len(paths) - DIRTY_NAMED
    detail = str(len(paths)) + " uncommitted or untracked path(s): " + named
    if more > 0:
        detail += " (and " + str(more) + " more)"
    report.fail(check, detail, DIRTY_FIX)


def check_shadow_repo(manifest, probes, report):
    check = "shadow_repo"
    repo = manifest.get("repo") or {}
    if repo.get("mode") != "shadow":
        report.skip(check, "not_applicable")
        return
    problem = _shadow_problem(_text(repo.get("git_dir")), probes)
    if problem is not None:
        report.fail(check, problem,
                    "run shadow init on the project folder (it prints the shadow's git_dir) "
                    "and set repo.git_dir to it; a broken shadow must be removed with "
                    "shadow remove first.")
    else:
        report.passed(check)


def _read(probe, *args):
    """probe(*args), or None when it raises: a failed read is never a failure."""
    try:
        return probe(*args)
    except Exception:
        return None


def _amount(value):
    """value when it is a number of at least 0, else None."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
        return None
    return value


def _gb(n):
    return "%.1f GB" % (n / float(GB))


def _worktree_root(manifest):
    return _text((manifest.get("repo") or {}).get("worktree_root"))


def check_memory(probes, report):
    check = "memory"
    value = _read(probes.memory)
    available = _amount(value.get("available")) if isinstance(value, dict) else None
    if available is None:
        report.warn(check, "unknown")
        return
    problems = []
    if available < MIN_MEMORY:
        problems.append(_gb(available) + " of physical memory available (under 4 GB)")
    if probes.platform == "win32":
        limit = _amount(value.get("commit_limit"))
        free = _amount(value.get("commit_available"))
        if limit and free is not None and free < limit * MIN_COMMIT_SHARE:
            problems.append(_gb(free) + " of the " + _gb(limit) + " commit limit available "
                            "(under 10%)")
    if problems:
        report.warn(check, "; ".join(problems))
    else:
        report.passed(check)


def _nearest_existing(path):
    """path, or its nearest parent that is a directory; None when there is none."""
    current = os.path.abspath(path)
    while not os.path.isdir(current):
        parent = os.path.dirname(current)
        if parent == current:
            return None
        current = parent
    return current


def check_disk(manifest, probes, report):
    check = "disk"
    root = _worktree_root(manifest)
    if root is None:
        report.skip(check, "no_worktree_root")
        return
    if probes.platform == "win32":
        # A Git Bash root (/c/x) is C:/x, as check_defender reads it.
        root = _shell._drive_form(root) or root
    existing = _nearest_existing(root)
    free = _amount(_read(probes.disk_free, existing)) if existing else None
    if free is None:
        report.warn(check, "unknown")
    elif free < MIN_DISK:
        report.warn(check, _gb(free) + " free on the drive of " + existing.replace("\\", "/") + " (under 5 GB)")
    else:
        report.passed(check)


def check_python_alias(manifest, probes, report):
    check = "python_alias"
    if probes.platform != "win32":
        report.skip(check, "not_applicable")
        return
    python, argv = _python_argv(manifest)
    program = argv[0] if argv else python
    if "/" not in program and "\\" not in program:
        program = _read(probes.which, program) or program
    # The unsplit text too: shlex drops the backslashes of an unquoted C:\... path.
    for candidate in (program, python):
        if isinstance(candidate, str) and _WINDOWS_APPS.search(candidate):
            report.warn(check, "the manifest's python is the WindowsApps alias, which is "
                        "slow to start: " + candidate)
            return
    report.passed(check)


def check_heavy_processes(probes, report):
    check = "heavy_processes"
    if probes.platform == "win32":
        working_set = _amount(_read(probes.appx_working_set))
        if working_set is None:
            report.warn(check, "unknown")
        elif working_set > MAX_APPX_WORKING_SET:
            report.warn(check, "AppXSvc's working set is %d MB (over 1500 MB)"
                        % (working_set // MB))
        else:
            report.passed(check)
        return
    value = _read(probes.load_average)
    try:
        load, cpus = value
    except (TypeError, ValueError):
        load = cpus = None
    load, cpus = _amount(load), _amount(cpus)
    if load is None or not cpus:
        report.warn(check, "unknown")
    elif load > cpus:
        report.warn(check, "the 1-minute load average %.1f is over the CPU count %d"
                    % (load, cpus))
    else:
        report.passed(check)


def check_active_runs(manifest, probes, report):
    check = "active_runs"
    runs = _read(probes.active_runs)
    if not isinstance(runs, list):
        report.warn(check, "unknown")
        return
    own = manifest.get("run_id")
    others = sorted(set(
        r["run_id"] for r in runs
        if isinstance(r, dict) and r.get("locked") is True
        and isinstance(r.get("run_id"), str) and r["run_id"] != own))
    if others:
        report.warn(check, "another run holds a launch lock: " + ", ".join(others))
    else:
        report.passed(check)


def _folded(path):
    return _shell._fold(_shell._drive_form(path) or path)


def _covers(exclusion, root):
    excluded = _folded(exclusion)
    return excluded != "" and (root == excluded or root.startswith(excluded + "/"))


def check_defender(manifest, probes, report):
    check = "defender"
    if probes.platform != "win32":
        report.skip(check, "not_applicable")
        return
    root = _worktree_root(manifest)
    if root is None:
        report.skip(check, "no_worktree_root")
        return
    exclusions = _read(probes.defender_exclusions)
    # Without elevation Defender lists one "N/A: Must be an administrator..." entry.
    if (not isinstance(exclusions, list)
            or not all(isinstance(e, str) for e in exclusions)
            or any(e.startswith("N/A") for e in exclusions)):
        report.warn(check, "unknown")
        return
    folded = _folded(root)
    if not any(_covers(e, folded) for e in exclusions):
        report.warn(check, "not covered")
    else:
        report.passed(check)


def check_concurrency(manifest, probes, report):
    check = "concurrency"
    lanes = manifest.get("lanes")
    count = len(lanes) if isinstance(lanes, list) else 0
    limits = manifest.get("limits") if isinstance(manifest.get("limits"), dict) else {}
    cap = limits.get("max_parallel_lanes")
    at_once = min(cap, count) if isinstance(cap, int) and not isinstance(cap, bool) else count
    value = _shell._getenv(probes.env, CONCURRENCY_VARIABLE)
    if value is None or not value.strip():
        report.warn(check, CONCURRENCY_VARIABLE + " is unset, so the Workflow tool's own cap "
                    "applies; the run has " + str(at_once) + " lane(s) at once")
        return
    try:
        agents = int(value.strip())
    except ValueError:
        report.warn(check, CONCURRENCY_VARIABLE + " is not a number")
        return
    if agents < at_once:
        report.warn(check, CONCURRENCY_VARIABLE + " is " + str(agents) + ", lower than the "
                    + str(at_once) + " lanes at once")
    else:
        report.passed(check)


def run_checks(manifest, probes):
    """Every doctor check against manifest, through probes; see the module doc."""
    observed_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    report = _Report()
    repo = manifest.get("repo") if isinstance(manifest.get("repo"), dict) else {}
    manifest = dict(manifest, repo=repo)
    prefix = _git_prefix(repo, probes)
    check_git_identity(manifest, probes, prefix, report)
    check_base_not_current(manifest, probes, prefix, report)
    check_python(manifest, probes, report)
    check_dirty_checkout(manifest, probes, prefix, report)
    check_shadow_repo(manifest, probes, report)
    check_memory(probes, report)
    check_disk(manifest, probes, report)
    check_python_alias(manifest, probes, report)
    check_heavy_processes(probes, report)
    check_active_runs(manifest, probes, report)
    check_defender(manifest, probes, report)
    check_concurrency(manifest, probes, report)
    result = report.result()
    result["observed_at"] = observed_at
    result["doctor_version"] = read_version(SKILL_DIR)
    run_id = manifest.get("run_id")
    result["run_id"] = run_id if isinstance(run_id, str) and run_id else None
    return result
