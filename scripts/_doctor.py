"""doctor's checks: what blocks a launch, read from the machine without changing it.

Import with:
    sys.dont_write_bytecode = True
    sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
    import _doctor

run_checks(manifest, probes) runs every check and returns
    {"status": "ok" | "blocked",
     "failures": [{"check", "detail", "fix"}],
     "warnings": [{"check", "detail"}],
     "skipped": [{"check", "reason"}]}
status is "blocked" when there is at least one failure. The manifest's repo
paths are used as given (the doctor CLI puts them in the C:/... form first).

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
"""

import os
import re
import shlex
import signal
import subprocess
import sys
import tempfile

import _shell

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
    env: the environment the commands run in.
    platform: sys.platform's value for the machine checked.
    """

    def __init__(self, env=None, platform=None, git=None, ls_remote=None, run=None):
        self.env = dict(os.environ) if env is None else env
        self.platform = sys.platform if platform is None else platform
        self.git = git or self._git
        self.ls_remote = ls_remote or self._ls_remote
        self.run = run or self._run

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


class _Report:
    def __init__(self):
        self.failures = []
        self.warnings = []
        self.skipped = []

    def fail(self, check, detail, fix):
        self.failures.append({"check": check, "detail": detail, "fix": fix})

    def warn(self, check, detail):
        self.warnings.append({"check": check, "detail": detail})

    def skip(self, check, reason):
        self.skipped.append({"check": check, "reason": reason})

    def result(self):
        return {
            "status": "blocked" if self.failures else "ok",
            "failures": self.failures,
            "warnings": self.warnings,
            "skipped": self.skipped,
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
        return
    present = probes.git(list(prefix) + ["cat-file", "-e", tip + "^{commit}"]).code == 0
    if not present:
        detail = "unknown"
    else:
        contains = _ancestor(probes, prefix, tip, local_sha)
        if contains:
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


def check_python(manifest, probes, report):
    check = "python"
    fix = ("set the manifest's python to a Python 3.8 or newer (scripts/find-python "
           "prints one), shell-quoted.")
    python = manifest.get("python")
    python = python if isinstance(python, str) and python.strip() else "python3"
    try:
        argv = shlex.split(python)
    except ValueError:
        argv = []
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


def run_checks(manifest, probes):
    """Every doctor check against manifest, through probes; see the module doc."""
    report = _Report()
    repo = manifest.get("repo") if isinstance(manifest.get("repo"), dict) else {}
    manifest = dict(manifest, repo=repo)
    prefix = _git_prefix(repo, probes)
    check_git_identity(manifest, probes, prefix, report)
    check_base_not_current(manifest, probes, prefix, report)
    check_python(manifest, probes, report)
    check_dirty_checkout(manifest, probes, prefix, report)
    check_shadow_repo(manifest, probes, report)
    return report.result()
