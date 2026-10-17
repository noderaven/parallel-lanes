"""Pin an archived plan or spec to the version a launch recorded (archive-run).

Import with:
    sys.dont_write_bytecode = True
    sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
    import _pin

recorded_inputs(ledger_dir) reads every setup run_started event of
<ledger_dir>/_run.jsonl, in file order, as {"head", "plan_sha256",
"spec_sha256"}; a field that is missing or not a string is None. A missing
or unreadable file gives [], and a line that is not a JSON object is skipped.

pin(kind, live, archived, recorded, git_cmd, repo_root) decides one file
(kind "plan" or "spec"). live is the file's live path (it need not exist;
None when there is none), archived the path of its copy in the run folder,
recorded what recorded_inputs gave, git_cmd the git command for the run's
repo (["git", "-C", root] in git mode, ["git", "--git-dir", git_dir] in
shadow mode) and repo_root the project root the live path is relative to.
It returns {"action", "source", "state", "warning"}:
  action   "keep" (leave the archived copy as it is), "write" (write
           source over the archived copy, or as a new one) or "none"
           (nothing to archive);
  source   the bytes to write with "write", else None;
  state    "kept" (the archived copy has the recorded sha), "pinned" (a new
           copy with the recorded sha), "replaced" (an archived copy that
           did not have it is replaced by one that does), or None (not
           pinned: no recorded sha, or no source has it);
  warning  None, or {"code": "<kind>_unpinned", "detail": ...} when a sha is
           recorded but no source has it; the detail names the sha and what
           was kept or copied.
The rules (spec 4.1):
  1. The recorded sha is the last event's <kind>_sha256; none: rule 5.
  2. An archived copy with that sha is kept, whatever the live file holds.
  3. Otherwise the first source with that sha is written. Sources, in order:
     the live file; then for each event's head, from the last back (each
     head once), 'git show <head>:<path>' and 'git cat-file --filters
     <head>:<path>' (the bytes a checkout writes, so a CRLF checkout
     matches). <path> is the live path relative to repo_root as git stores
     it at that head: the path itself when git holds it there, else the
     first name from 'git ls-tree -r --name-only -z <head>' equal to it
     compared without case (the tree is listed only then). A live path
     outside repo_root has no git source.
  4. No source has the sha: an archived copy is kept; without one the live
     file is copied (nothing when it is missing). Either way: the warning.
  5. No recorded sha: an archived copy is kept (never replaced); without one
     the live file is copied, as before pinning.
sha256 is taken over the bytes as they are. A git call that fails (a head
that is gone, a path git does not hold at it) is a source that does not
match. Git runs with _audit_git.git_env(), so the caller's GIT_DIR and
similar variables cannot point it at another repo. Nothing here writes.
"""
import hashlib
import json
import os
import subprocess
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import _audit_git  # noqa: E402

KINDS = ("plan", "spec")


def recorded_inputs(ledger_dir):
    """[{"head", "plan_sha256", "spec_sha256"}] of the setup run_started
    events in <ledger_dir>/_run.jsonl, in file order."""
    try:
        with open(os.path.join(ledger_dir, "_run.jsonl"), "rb") as f:
            lines = f.read().splitlines()
    except OSError:
        return []
    out = []
    for line in lines:
        try:
            event = json.loads(line.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            continue
        if not isinstance(event, dict) or event.get("event") != "run_started" or event.get("phase") != "setup":
            continue
        out.append({key: event.get(key) if isinstance(event.get(key), str) else None
                    for key in ("head", "plan_sha256", "spec_sha256")})
    return out


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def read_bytes(path):
    """The bytes of the file at path; None when it is not a readable file."""
    if not path or not os.path.isfile(path):
        return None
    try:
        with open(path, "rb") as f:
            return f.read()
    except OSError:
        return None


def git_bytes(git_cmd, args):
    """The stdout bytes of git_cmd + args; None when git fails."""
    try:
        res = subprocess.run(list(git_cmd) + list(args), env=_audit_git.git_env(), stdin=subprocess.DEVNULL,
                             capture_output=True)
    except (OSError, subprocess.SubprocessError):
        return None
    return res.stdout if res.returncode == 0 else None


def repo_path(live, repo_root):
    """The live path relative to repo_root, '/'-separated; None when it is
    outside the root (or on another drive)."""
    if not live or not repo_root:
        return None
    candidates = [(os.path.abspath(live), os.path.abspath(repo_root)),
                  (os.path.realpath(live), os.path.realpath(repo_root))]
    for path, root in candidates:
        try:
            rel = os.path.relpath(path, root)
        except ValueError:
            continue
        rel = rel.replace(os.sep, "/")
        if rel != "." and rel != ".." and not rel.startswith("../") and not os.path.isabs(rel):
            return rel
    return None


def stored_path(git_cmd, head, rel):
    """The path git stores at head for rel: the equal name, else the first
    equal without case; None when git holds neither. It lists the whole
    tree, so git_sources calls it only when rel itself is missing at head."""
    out = git_bytes(git_cmd, ["ls-tree", "-r", "--name-only", "-z", head])
    if out is None:
        return None
    names = [n.decode("utf-8", "surrogateescape") for n in out.split(b"\0") if n]
    if rel in names:
        return rel
    folded = rel.casefold()
    for name in names:
        if name.casefold() == folded:
            return name
    return None


def heads_from_last(recorded):
    """The recorded heads, from the last event back, each once."""
    out = []
    for event in reversed(recorded):
        head = event.get("head")
        if isinstance(head, str) and head and not head.startswith("-") and head not in out:
            out.append(head)
    return out


def blob_sources(git_cmd, head, path):
    """The bytes 'git show <head>:<path>' and 'git cat-file --filters
    <head>:<path>' give, each that succeeds, in that order."""
    out = []
    spec = head + ":" + path
    for args in (["show", spec], ["cat-file", "--filters", spec]):
        data = git_bytes(git_cmd, args)
        if data is not None:
            out.append(data)
    return out


def git_sources(git_cmd, recorded, rel):
    """Yields the bytes of each git source of rel, in rule 3's order: the
    exact path first; the tree is listed only when git holds no rel at a
    head."""
    for head in heads_from_last(recorded):
        found = blob_sources(git_cmd, head, rel)
        if not found:
            path = stored_path(git_cmd, head, rel)
            if path is not None and path != rel:
                found = blob_sources(git_cmd, head, path)
        for data in found:
            yield data


def result(action, source=None, state=None, warning=None):
    return {"action": action, "source": source, "state": state, "warning": warning}


def pin(kind, live, archived, recorded, git_cmd, repo_root):
    """What to do with the archived copy of the plan or spec (see the
    module docstring)."""
    if kind not in KINDS:
        raise ValueError("kind must be plan or spec: " + repr(kind))
    want = recorded[-1].get(kind + "_sha256") if recorded else None
    want = want.lower() if isinstance(want, str) and want else None
    have = read_bytes(archived)
    live_bytes = read_bytes(live)
    if want is None:
        # Rule 5: nothing to pin against.
        if have is not None:
            return result("keep")
        if live_bytes is not None:
            return result("write", live_bytes)
        return result("none")
    if have is not None and sha256(have) == want:
        return result("keep", state="kept")
    state = "replaced" if have is not None else "pinned"
    if live_bytes is not None and sha256(live_bytes) == want:
        return result("write", live_bytes, state)
    rel = repo_path(live, repo_root)
    if rel is not None:
        for data in git_sources(git_cmd, recorded, rel):
            if sha256(data) == want:
                return result("write", data, state)
    # Rule 4: no source has the recorded sha.
    name = os.path.basename(archived)
    detail = "no source of the " + kind + " " + name + " has the recorded sha256 " + want + "; "
    if have is not None:
        return result("keep", warning={"code": kind + "_unpinned",
                                       "detail": detail + "kept the archived copy (sha256 " + sha256(have) + ")"})
    if live_bytes is not None:
        return result("write", live_bytes, warning={
            "code": kind + "_unpinned",
            "detail": detail + "copied the live file (sha256 " + sha256(live_bytes) + ")"})
    return result("none", warning={"code": kind + "_unpinned",
                                   "detail": detail + "nothing archived (no live file)"})
