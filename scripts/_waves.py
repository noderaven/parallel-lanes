"""The join wave rule (1.6.5 design 4.1), as src/waves.js has it.

The engine's JS rule is authoritative; this copy serves setup's owner map
(_owners.build) and worth-it. tests/waves.test.mjs holds both to the shared
fixtures in tests/fixtures/waves/cases.json.

A unit is {"id", "files", optional "depends_on", optional "tasks"}: a batch
unit lists its tasks (ids, or task objects with an "id"). depends_on entries
are ids or objects with an "id".
"""
import re
import sys

sys.dont_write_bytecode = True


def _id(item):
    return item.get("id") if isinstance(item, dict) else item


def _task_ids(unit):
    tasks = unit.get("tasks")
    return [_id(t) for t in tasks] if isinstance(tasks, list) else [unit["id"]]


def deps(unit):
    """The ids a unit depends on, less its own; None when it (or any task
    of a batch given as task objects) has no depends_on field."""
    tasks = unit.get("tasks")
    holders = [t for t in tasks if isinstance(t, dict)] if isinstance(tasks, list) else []
    if not holders:
        holders = [unit]
    if any(not isinstance(t.get("depends_on"), list) for t in holders):
        return None
    own = set(_task_ids(unit))
    out = []
    for t in holders:
        for d in t["depends_on"]:
            i = _id(d)
            if i not in own and i not in out:
                out.append(i)
    return out


def file_key(path):
    """A declared file as the rule compares it: '\\' as '/', repeated '/'
    and leading './' dropped, lower-cased."""
    key = re.sub(r"/+", "/", str(path).replace("\\", "/"))
    while key.startswith("./"):
        key = key[2:]
    return key.lower()


def overlap(a, b):
    """Whether two declared paths (file_key) can name one file: equal, or
    one is a folder holding the other (a file holds no paths, so the shorter
    is a folder, named with or without a trailing '/'), as filesOverlap in
    src/waves.js."""
    x, y = a.rstrip("/"), b.rstrip("/")
    return x == y or x == "" or y == "" or y.startswith(x + "/") or x.startswith(y + "/")


def waves(units, edges=()):
    """The waves of units in plan order, as lists of unit ids. edges:
    (unit_id, producer_id) pairs; a producer that is not earlier is
    ignored, as is a depends_on id of a later unit."""
    edges = list(edges)
    wave = []
    for i, unit in enumerate(units):
        earlier = units[:i]
        mine = deps(unit)
        on = set()
        for j, e in enumerate(earlier):
            if mine is None or any(t in mine for t in _task_ids(e)):
                on.add(j)
        for u, producer in edges:
            if u != unit["id"]:
                continue
            for j, e in enumerate(earlier):
                if e["id"] == producer:
                    on.add(j)
        w = 1 + max([wave[j] for j in on] or [0])
        files = [file_key(f) for f in unit.get("files") or []]

        def clash(n):
            return any(wave[j] == n and any(overlap(file_key(f), k) for f in e.get("files") or [] for k in files)
                       for j, e in enumerate(earlier))

        while clash(w):
            w += 1
        wave.append(w)
    out = [[] for _ in range(max(wave or [0]))]
    for unit, w in zip(units, wave):
        out[w - 1].append(unit["id"])
    return [w for w in out if w]


def join_units(join_tasks):
    """The join's units, statically: consecutive tasks with the same
    non-empty batch key form one unit {"id": "<first>-<last>", "tasks":
    [ids], "files", "depends_on"} (depends_on None when a task has no
    field); any other task is a unit of its own with the same keys."""
    units = []
    i = 0
    while i < len(join_tasks):
        j = i + 1
        key = join_tasks[i].get("batch")
        if key:
            while j < len(join_tasks) and join_tasks[j].get("batch") == key:
                j += 1
        group = join_tasks[i:j]
        unit = {"id": group[0]["id"] if len(group) == 1 else "%s-%s" % (group[0]["id"], group[-1]["id"]),
                "tasks": [t["id"] for t in group],
                "files": [f for t in group for f in t.get("files") or []]}
        unit["depends_on"] = deps({"id": unit["id"], "tasks": group})
        if unit["depends_on"] is None:
            del unit["depends_on"]
        units.append(unit)
        i = j
    return units


def task_waves(join_tasks):
    """{task id: 1-based wave} for every join task (a batch's tasks share
    their unit's wave)."""
    units = join_units(join_tasks)
    out = {}
    for n, ids in enumerate(waves(units), 1):
        for uid in ids:
            unit = next(u for u in units if u["id"] == uid)
            for t in unit["tasks"]:
                out[t] = n
    return out
