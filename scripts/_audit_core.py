"""The shared core of scripts/audit: evidence references, the gap list,
quoting, run loading and launch order.

Import with:
    sys.dont_write_bytecode = True
    sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
    import _audit_core

Evidence references. Every derived value is ref(value, state, sources,
note=None): {"value", "state", "sources"[, "note"]}, state one of STATES,
each source src(path, at): path relative to the run folder with '/'
separators, or git:<sha>, or transcript:<wf>/<label>; at a ledger line
(L<n>, physical line numbers, blank lines counted), a JSON pointer (#/...),
a sha, or None. collect_gaps(obj) lists every nested ref whose state is in
GAP_STATES, in document order, as {"where": <JSON pointer>, "state",
"value", "note"}.

Quoting. Recorded text is quoted as written, except that every configured
command (command_pairs: the ids of _autopsy.configured_checks, plus
setup#<n> for commands.setup[n - 1] and <lane>.setup#<n> for
lane_commands.<lane>.setup[n - 1]) becomes <check:<id>>. replace_commands
does this in one regex pass, longest command first, so an inserted token is
never rewritten. quote(text, sources, pairs) gives {"quote", "sources",
"commands_replaced"}.

The archive boundary. load_run(folder) reads only the run folder: the
*.lanes.json manifest, the plan and spec copies (the folder's files named
by the basename of the manifest's plan and spec, split on '/' and '\\'),
the *.ledger dir (its *.jsonl lines, and the parsed output of 'ledger
status <ledger dir>' run with no other flag), and the launches (the union
of wf_* dirs and wf_*.json files; a launch's result comes only from
<folder>/<wf>.json). Before reading anything it checks every input path
(the manifest, the run report, the plan and spec copies, the wf_*.json
files, and every file and dir under the wf_* dirs and the ledger) with
inside(); one that resolves outside the folder (a symlink or junction)
raises OutsideRunFolder naming it. It never reads a live path from the
manifest.

Launch order. Launches are ordered by start (startTime / 1000), launches
without one last, then by wf name. latest_launch needs every launch to have
a start; task_launch takes the last launch in that order whose result
reports the task with a status other than skipped or not_run.
"""

import glob
import json
import math
import os
import re
import subprocess
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import _autopsy  # noqa: E402

SCRIPTS = os.path.dirname(os.path.realpath(__file__))

STATES = ("present", "missing", "stale", "conflicting", "unavailable", "inferred")
GAP_STATES = ("missing", "stale", "conflicting", "unavailable")


# ---- evidence references ----

def src(path, at=None):
    return {"path": path, "at": at}


def ref(value, state, sources, note=None):
    if state not in STATES:
        raise ValueError("unknown evidence state %r" % (state,))
    out = {"value": value, "state": state, "sources": list(sources)}
    if note is not None:
        out["note"] = note
    return out


def _is_ref(node):
    return isinstance(node, dict) and "state" in node and "sources" in node


def _pointer_key(key):
    return str(key).replace("~", "~0").replace("/", "~1")


def collect_gaps(obj):
    """[{"where", "state", "value", "note"}] for every nested ref whose state
    is in GAP_STATES, in document order (a ref before the refs inside its
    value). where is a JSON pointer from the root of obj ('#' for obj)."""
    gaps = []

    def walk(node, where):
        if isinstance(node, dict):
            is_ref = _is_ref(node)
            if is_ref and isinstance(node["state"], str) and node["state"] in GAP_STATES:
                gaps.append({"where": where, "state": node["state"], "value": node.get("value"),
                             "note": node.get("note")})
            for key, value in node.items():
                if is_ref and key == "sources":
                    continue
                walk(value, "%s/%s" % (where, _pointer_key(key)))
        elif isinstance(node, (list, tuple)):
            for i, value in enumerate(node):
                walk(value, "%s/%d" % (where, i))

    walk(obj, "#")
    return gaps


# ---- quoting ----

def command_pairs(manifest):
    """[(id, command)] for every configured command, setup included, longest
    command first (ties keep configured order). A command string already
    listed, or one that is empty or only whitespace, is not listed again."""
    m = manifest if isinstance(manifest, dict) else {}
    pairs = [(cid, command) for cid, command, _full in _autopsy.configured_checks(m)]
    seen = set(command for _cid, command in pairs)

    def add_setup(commands, prefix):
        if not isinstance(commands, dict):
            return
        entries = commands.get("setup")
        for n, command in enumerate(entries if isinstance(entries, list) else [], 1):
            if isinstance(command, str) and command.strip() and command not in seen:
                seen.add(command)
                pairs.append(("%ssetup#%d" % (prefix, n), command))

    add_setup(m.get("commands"), "")
    lanes = m.get("lane_commands")
    for lane, commands in lanes.items() if isinstance(lanes, dict) else []:
        add_setup(commands, "%s." % lane)
    pairs.sort(key=lambda p: -len(p[1]))
    return pairs


def replace_commands(text, pairs):
    """(text with every command of pairs replaced by <check:<id>>, whether any
    was). One compiled alternation, longest command first, scanned once, so
    a token it inserts is never rewritten. Commands of every length count;
    an empty or whitespace-only command is ignored."""
    if not isinstance(text, str):
        return text, False
    ids = {}
    for cid, command in sorted(pairs, key=lambda p: -len(p[1]) if isinstance(p[1], str) else 0):
        if isinstance(command, str) and command.strip():
            ids.setdefault(command, cid)
    if not ids:
        return text, False
    pattern = re.compile("|".join(re.escape(command) for command in ids))
    hits = []

    def token(match):
        hits.append(True)
        return "<check:%s>" % ids[match.group(0)]

    out = pattern.sub(token, text)
    return out, bool(hits)


def quote(text, sources, pairs):
    out, replaced = replace_commands(text, pairs)
    return {"quote": out, "sources": list(sources), "commands_replaced": replaced}


# ---- the archive boundary ----

class OutsideRunFolder(ValueError):
    """An input path that resolves outside the run folder; .path names it."""

    def __init__(self, path):
        ValueError.__init__(self, "%s resolves outside the run folder; it is not read" % path)
        self.path = path


def inside(root, path):
    """True when path, resolved with symlinks and junctions, is root or lies
    inside root (also resolved). Case is ignored where the platform does
    (os.path.normcase); different drives are not inside."""
    try:
        r = os.path.normcase(os.path.realpath(root))
        p = os.path.normcase(os.path.realpath(path))
        return os.path.commonpath([r, p]) == r
    except (ValueError, OSError):
        return False


def _guard(folder, path):
    if not inside(folder, path):
        raise OutsideRunFolder(path)
    return path


def _guard_tree(folder, top):
    """Check top and every file and dir under it (a linked dir is checked,
    not entered)."""
    _guard(folder, top)
    for root, dirs, files in os.walk(top):
        for name in dirs + files:
            _guard(folder, os.path.join(root, name))


def _rel(folder, path):
    return os.path.relpath(path, folder).replace("\\", "/")


def _read_object(path):
    """The JSON object in path, or None when it is unreadable or no object."""
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _basename(value):
    if not isinstance(value, str):
        return None
    name = re.split(r"[/\\]", value)[-1]
    return name if name not in ("", ".", "..") else None


def _copy(folder, value):
    name = _basename(value)
    if name is None:
        return None
    path = os.path.join(folder, name)
    if not os.path.isfile(path):
        return None
    _guard(folder, path)
    return name


def _ledger_lines(folder, ledger_dir):
    out = []
    for path in sorted(glob.glob(os.path.join(ledger_dir, "*.jsonl"))):
        if not os.path.isfile(path):
            continue
        rel = _rel(folder, path)
        try:
            with open(path, "rb") as f:
                text = f.read().decode("utf-8", errors="replace")
        except OSError:
            continue
        for n, raw in enumerate(text.split("\n"), 1):
            line = raw.rstrip("\r")
            if not line.strip():
                continue
            try:
                event = json.loads(line)
            except ValueError:
                event = None
            out.append({"file": rel, "line": n, "event": event if isinstance(event, dict) else None})
    return out


def _ledger_status(ledger_dir):
    """(parsed 'ledger status' output, None) or (None, a short reason)."""
    try:
        res = subprocess.run([sys.executable, os.path.join(SCRIPTS, "ledger"), "status", ledger_dir],
                             stdin=subprocess.DEVNULL, capture_output=True, text=True,
                             encoding="utf-8", errors="replace", timeout=300)
    except (OSError, subprocess.SubprocessError):
        return None, "ledger status could not run"
    if res.returncode != 0:
        return None, "ledger status exited %d" % res.returncode
    try:
        data = json.loads(res.stdout)
    except ValueError:
        data = None
    if not isinstance(data, dict):
        return None, "ledger status printed no JSON object"
    return data, None


def _launch(folder, wf):
    wf_dir = os.path.join(folder, wf)
    has_dir = os.path.isdir(wf_dir)
    wf_json = os.path.join(folder, wf + ".json")
    data = _read_object(wf_json) if os.path.isfile(wf_json) else None
    result = data.get("result") if data is not None else None
    start = end = None
    if data is not None and _number(data.get("startTime")):
        start = data["startTime"] / 1000.0
        duration = data.get("durationMs")
        if _number(duration) and duration >= 0:
            end = start + duration / 1000.0
    return {
        "wf": wf,
        "dir": wf_dir if has_dir else None,
        "data": data,
        "result": result if isinstance(result, dict) else None,
        "start": start,
        "end": end,
        "has_transcripts": has_dir and bool(glob.glob(os.path.join(wf_dir, "agent-*.meta.json"))),
    }


def load_run(folder):
    """The run folder read once. Returns {"folder" (absolute), "manifest" (the
    parsed object, {} when absent or unreadable), "manifest_path",
    "report_path", "plan_path", "spec_path", "ledger" (each relative, or
    None), "ledger_lines", "ledger_status", "ledger_status_error",
    "launches"}. ledger_lines is [{"file", "line", "event"}] for every
    *.jsonl in the ledger, files in name order: line is the physical 1-based
    line number (blank lines counted, and giving no entry), event the parsed
    object or None. Each launch is {"wf", "dir" (absolute, or None), "data"
    (<folder>/<wf>.json's object, or None), "result" (its result object, or
    None), "start", "end" (seconds, or None), "has_transcripts"}, in display
    order. Raises OutsideRunFolder for an input that resolves outside the
    folder."""
    folder = os.path.abspath(folder)
    manifest_file = _autopsy.find_manifest(folder)
    if manifest_file:
        _guard(folder, manifest_file)
    report_file = _autopsy.find_report(folder)
    if report_file:
        _guard(folder, report_file)
    ledger_dir = _autopsy.find_ledger(folder)
    if ledger_dir:
        _guard_tree(folder, ledger_dir)
    names = set(os.path.basename(d) for d in _autopsy.wf_dirs(folder))
    for path in glob.glob(os.path.join(folder, "wf_*.json")):
        if os.path.isfile(path):
            _guard(folder, path)
            names.add(os.path.basename(path)[:-len(".json")])
    for d in _autopsy.wf_dirs(folder):
        _guard_tree(folder, d)

    manifest = (_read_object(manifest_file) if manifest_file else None) or {}
    plan_path = _copy(folder, manifest.get("plan"))
    spec_path = _copy(folder, manifest.get("spec"))

    if ledger_dir:
        lines = _ledger_lines(folder, ledger_dir)
        status, status_error = _ledger_status(ledger_dir)
    else:
        lines, status, status_error = [], None, "no ledger"

    launches = [_launch(folder, wf) for wf in names]
    launches.sort(key=lambda l: (l["start"] is None, l["start"] or 0.0, l["wf"]))
    return {
        "folder": folder,
        "manifest": manifest,
        "manifest_path": _rel(folder, manifest_file) if manifest_file else None,
        "report_path": _rel(folder, report_file) if report_file else None,
        "plan_path": plan_path,
        "spec_path": spec_path,
        "ledger": _rel(folder, ledger_dir) if ledger_dir else None,
        "ledger_lines": lines,
        "ledger_status": status,
        "ledger_status_error": status_error,
        "launches": launches,
    }


# ---- launches ----

def latest_launch(run):
    """(the latest launch, None) when every launch has a start, else (None,
    "launch order unknown"); (None, "no launch") without launches."""
    launches = run.get("launches") or []
    if not launches:
        return None, "no launch"
    if any(l["start"] is None for l in launches):
        return None, "launch order unknown"
    return launches[-1], None


def task_status(launch, task_id):
    """result.tasks[task_id].status of a launch when it is a string, else None."""
    result = launch.get("result")
    tasks = result.get("tasks") if isinstance(result, dict) else None
    entry = tasks.get(task_id) if isinstance(tasks, dict) else None
    status = entry.get("status") if isinstance(entry, dict) else None
    return status if isinstance(status, str) else None


def task_launch(run, task_id):
    """The last launch in display order (by start, launches without one
    last) whose result reports task_id with a status other than skipped and
    not_run; None when there is none."""
    for launch in reversed(run.get("launches") or []):
        status = task_status(launch, task_id)
        if status is not None and status not in ("skipped", "not_run"):
            return launch
    return None


def structured_results(launch):
    """[{"label", "agent_id", "result"}] from <launch dir>/journal.jsonl: each
    {"type": "started"} entry, in order, joined by agentId to its
    {"type": "result"} entry (result None when it has none). A dirless
    launch, or a missing or unreadable journal, gives []."""
    if not launch.get("dir"):
        return []
    try:
        with open(os.path.join(launch["dir"], "journal.jsonl"), "rb") as f:
            text = f.read().decode("utf-8", errors="replace")
    except OSError:
        return []
    started, results = [], {}
    for line in text.split("\n"):
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not isinstance(entry, dict) or not isinstance(entry.get("agentId"), str):
            continue
        if entry.get("type") == "started":
            started.append(entry)
        elif entry.get("type") == "result":
            results.setdefault(entry["agentId"], []).append(entry.get("result"))
    out = []
    for entry in started:
        queue = results.get(entry["agentId"]) or []
        label = entry.get("label")
        out.append({"label": label if isinstance(label, str) else None, "agent_id": entry["agentId"],
                    "result": queue.pop(0) if queue else None})
    return out


def manifest_tasks(manifest):
    """[(task object, lane id or "prelude" or "join")] in run order: prelude,
    the lanes in order, join. Entries without a string id are left out."""
    m = manifest if isinstance(manifest, dict) else {}

    def tasks(items):
        return [t for t in (items if isinstance(items, list) else [])
                if isinstance(t, dict) and isinstance(t.get("id"), str)]

    out = [(t, "prelude") for t in tasks(m.get("prelude"))]
    for lane in m.get("lanes") if isinstance(m.get("lanes"), list) else []:
        if isinstance(lane, dict):
            out += [(t, lane.get("id")) for t in tasks(lane.get("tasks"))]
    out += [(t, "join") for t in tasks(m.get("join"))]
    return out
