"""The owner map: which tasks list each path in their Files list, and where
each task runs (1.6.3).

setup writes <ledger_dir>/owners.json (`ledger write-owners` writes the same
file from a manifest); the ledger's owners and undeclared commands and
start-task --owners read it.

  {"repo": {"mode", "root", "git_dir"},
   "tasks": {id: {"where": "prelude" | <lane id> | "join", "pos": n,
                  "wave": n (join tasks, when the join can run in waves)}},
   "files": {<path key>: [task ids, in run order]}}

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
            tasks[t["id"]] = {"where": where, "pos": pos}
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
    """(owner, relation) of the first other task listing path, or (None, None)."""
    others = [t for t in owners["files"].get(path_key(path), []) if t not in unit_ids]
    if not others:
        return None, None
    return others[0], relation(owners, unit_ids, others[0])
