"""The owner map: which tasks list each path in their Files list, and where
each task runs (1.6.3).

setup writes <ledger_dir>/owners.json (`ledger write-owners` writes the same
file from a manifest); the ledger's owners and undeclared commands and
start-task --owners read it.

  {"repo": {"mode", "root", "git_dir"},
   "tasks": {id: {"where": "prelude" | <lane id> | "join", "pos": n,
                  "wave": n (join tasks, when the join can run in waves),
                  "declared": [paths] (the task's Files list as given, 1.6.6)}},
   "files": {<path key>: [task ids, in run order]}}

A unit's declared list (its tasks' `declared`, in order, each exact string
once) is checked against the engine's fingerprint of the same list
(declaredFingerprint in src/prompts-task.js): "N:HHHHHHHH", N the number of
paths and H the 32-bit FNV-1a hash of the paths' UTF-8 bytes joined with one
NUL byte (1.6.6).

A task changing another task's file is judged by when that task runs:
"earlier" (an earlier task of the same list, the prelude seen from a lane or
the join, a lane seen from the join), "alongside" (another lane, or another
join task of the same wave, 1.6.5), or "later". A join task's wave is the
static rule's (_waves, without pre-flight's findings): stricter than a run
that moves a task to a later wave.
"""
import json
import os
import posixpath
import re
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import _waves  # noqa: E402

PHRASES = {
    "earlier": "earlier in the run",
    "alongside": "another lane, running alongside",
    "later": "later",
}


def path_key(path):
    """A project-relative path as the ledger and validate.js compare it:
    forward slashes, normalized, lower-cased; None for an absolute path or
    one that leaves the project."""
    if not isinstance(path, str) or not path:
        return None
    p = path.replace("\\", "/")
    if p.startswith("/") or (len(p) > 1 and p[1] == ":"):
        return None
    norm = posixpath.normpath(p)
    if norm == ".." or norm.startswith("../"):
        return None
    return norm.lower()


def build(manifest):
    """The owner map of a manifest."""
    repo = manifest.get("repo") or {}
    lists = [("prelude", manifest.get("prelude") or [])]
    lists += [(lane.get("id"), lane.get("tasks") or []) for lane in manifest.get("lanes") or []]
    lists += [("join", manifest.get("join") or [])]
    tasks = {}
    files = {}
    for where, items in lists:
        for pos, t in enumerate(items):
            declared = []
            for f in t.get("files") or []:
                if f not in declared:
                    declared.append(f)
            tasks[t["id"]] = {"where": where, "pos": pos, "declared": declared}
            for f in t.get("files") or []:
                key = path_key(f)
                if key is not None and t["id"] not in files.setdefault(key, []):
                    files[key].append(t["id"])
    # A join that can run in waves (two lanes or more, not lite) records each
    # join task's wave; one that cannot runs serially, so it records none.
    join = manifest.get("join") or []
    if manifest.get("profile") != "lite" and len(manifest.get("lanes") or []) >= 2 and join:
        for tid, wave in _waves.task_waves(join).items():
            if tid in tasks:
                tasks[tid]["wave"] = wave
    return {"repo": {k: repo.get(k) for k in ("mode", "root", "git_dir")}, "tasks": tasks, "files": files}


def load(path):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict) or not isinstance(data.get("tasks"), dict) or not isinstance(data.get("files"), dict):
        raise ValueError("not an owner map")
    return data


FINGERPRINT = re.compile(r"^[1-9][0-9]*:[0-9a-f]{8}$")


def fingerprint(paths):
    """N:HHHHHHHH for a declared list: N the number of paths, H the 32-bit
    FNV-1a hash of the paths' UTF-8 bytes joined with one NUL byte (a lone
    surrogate as its 3-byte form). Match it with FINGERPRINT.fullmatch: `$`
    alone also matches before a trailing newline."""
    h = 0x811C9DC5
    for byte in b"\x00".join(p.encode("utf-8", "surrogatepass") for p in paths):
        h = ((h ^ byte) * 0x01000193) & 0xFFFFFFFF
    return f"{len(paths)}:{h:08x}"


def declared_for(owners, task_ids):
    """The unit's declared list: each task's `declared` in the given order,
    the first occurrence of each exact string kept."""
    tasks = owners.get("tasks") or {}
    out = []
    for tid in task_ids:
        entry = tasks.get(tid)
        if not isinstance(entry, dict):
            raise ValueError(f"task {tid} is not in it")
        declared = entry.get("declared")
        if not isinstance(declared, list) or not all(isinstance(p, str) for p in declared):
            raise ValueError(f"task {tid} has no declared list")
        for p in declared:
            if p not in out:
                out.append(p)
    return out


def owners_declared(path, task_ids, expected):
    """The unit's declared list from the owner map at path, checked against
    the engine's fingerprint expected. Raises ValueError(reason)."""
    try:
        owners = load(path)
    except (OSError, ValueError) as e:
        raise ValueError(f"owners.json cannot be read: {e}")
    declared = declared_for(owners, task_ids)
    actual = fingerprint(declared)
    if actual != expected:
        raise ValueError(f"expected {expected}, found {actual}")
    return declared


def relation(owners, unit_ids, other):
    """earlier, alongside or later: when other runs, seen from the unit."""
    tasks = owners["tasks"]
    me = tasks.get(unit_ids[0])
    them = tasks.get(other)
    if me is None or them is None:
        return None
    mine, theirs = me["where"], them["where"]
    if mine == theirs == "join" and "wave" in me and "wave" in them:
        if me["wave"] == them["wave"]:
            return "alongside"
        return "earlier" if them["wave"] < me["wave"] else "later"
    if mine == theirs:
        first = min(tasks[u]["pos"] for u in unit_ids if u in tasks)
        return "earlier" if them["pos"] < first else "later"
    if theirs == "prelude" or mine == "join":
        return "earlier"
    if mine == "prelude" or theirs == "join":
        return "later"
    return "alongside"


def annotate(owners, unit_ids, path):
    """What a changed path is, seen from the unit (its task ids)."""
    listed = owners["files"].get(path_key(path), [])
    others = [t for t in listed if t not in unit_ids]
    if any(t in unit_ids for t in listed):
        return "in your Files list" + "".join(f"; also in {t}'s Files" for t in others)
    if not others:
        return "no task owns it"
    return "; ".join(f"owned by {t}, {PHRASES.get(relation(owners, unit_ids, t), 'unknown')}" for t in others)


def first_owner(owners, unit_ids, path):
    """(owner, relation) of the first other task listing path, or else a
    folder holding it, nearest folder first (a folder entry covers the paths
    under it, as in task-checks); (None, None) when no other task does."""
    key = path_key(path)
    while key and key != ".":
        others = [t for t in owners["files"].get(key, []) if t not in unit_ids]
        if others:
            return others[0], relation(owners, unit_ids, others[0])
        key = posixpath.dirname(key)
    return None, None
