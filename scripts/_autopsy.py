"""One archived run's analysis: what got done, where the time went, tokens.

Import with:
    sys.dont_write_bytecode = True
    sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
    import _autopsy

analyze(run_folder) returns the autopsy.json object for a history run folder
(see scripts/autopsy for its fields). It reads only the folder: the
*.lanes.json manifest, the run report, every wf_<id>/ transcript dir with its
wf_<id>.json, and the *.ledger dir; never a live path from the manifest, so
archived runs from another machine or OS work too. Anything that cannot be
read or derived is "unavailable", never 0.

Transcript text is used only inside this module (to match markers); it is
never written out. Event "text" stays internal.
"""
import glob
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import _transcripts  # noqa: E402

AUTOPSY_VERSION = 1
UNAVAILABLE = _transcripts.UNAVAILABLE
TOKEN_FIELDS = _transcripts.TOKEN_FIELDS
IDLE_GAP_S = 60
TOP_AGENTS = 5

_TS = re.compile(
    r"^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d):(\d\d)(?:[.,](\d+))?"
    r"(Z|[+-]\d\d:?\d\d)?$"
)
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
_SHA = re.compile(r"^[0-9a-fA-F]{7,64}$")


# ---- small helpers ----

def parse_ts(value):
    """Seconds since the epoch for an ISO 8601 timestamp; None when it is not
    one. A timestamp without a zone is taken as UTC."""
    if not isinstance(value, str):
        return None
    m = _TS.match(value.strip())
    if not m:
        return None
    year, month, day, hour, minute, second = (int(g) for g in m.groups()[:6])
    try:
        dt = datetime(year, month, day, hour, minute, second, tzinfo=timezone.utc)
    except ValueError:
        return None
    seconds = (dt - _EPOCH).total_seconds()
    if m.group(7):
        seconds += int(m.group(7)) / (10 ** len(m.group(7)))
    zone = m.group(8)
    if zone and zone != "Z":
        sign = 1 if zone[0] == "+" else -1
        digits = zone[1:].replace(":", "")
        seconds -= sign * (int(digits[:2]) * 3600 + int(digits[2:]) * 60)
    return seconds


def iso(ts):
    """ISO 8601 UTC with milliseconds, e.g. 2026-10-10T07:00:00.000Z."""
    if ts is None:
        return UNAVAILABLE
    ms = int(round(ts * 1000))
    dt = _EPOCH + timedelta(milliseconds=ms)
    return dt.strftime("%Y-%m-%dT%H:%M:%S") + ".%03dZ" % (ms % 1000)


def seconds(value):
    """A duration in seconds to 0.1; UNAVAILABLE for None."""
    return UNAVAILABLE if value is None else round(value, 1)


def union_length(spans):
    """The total length of the union of (start, end) spans."""
    total = 0.0
    cur_start = cur_end = None
    for start, end in sorted(spans):
        if cur_end is None or start > cur_end:
            if cur_end is not None:
                total += cur_end - cur_start
            cur_start, cur_end = start, end
        elif end > cur_end:
            cur_end = end
    if cur_end is not None:
        total += cur_end - cur_start
    return total


def merged(spans):
    """The union of (start, end) spans as sorted, disjoint spans."""
    out = []
    for start, end in sorted(spans):
        if out and start <= out[-1][1]:
            if end > out[-1][1]:
                out[-1][1] = end
        else:
            out.append([start, end])
    return out


# ---- events ----

def _text_of(content):
    if isinstance(content, str):
        return content
    parts = []
    for block in content if isinstance(content, list) else []:
        if isinstance(block, dict) and isinstance(block.get("text"), str):
            parts.append(block["text"])
    return "\n".join(parts)


def _event(ts, kind, name=None, id_=None, is_error=False, text="", input_=None):
    return {"ts": ts, "kind": kind, "name": name, "id": id_, "is_error": is_error,
            "text": text, "input": input_}


def read_events_counted(jsonl_path):
    """(events, skipped): read_events' events, and the number of non-blank
    lines skipped as damaged (not valid UTF-8, or not valid JSON)."""
    events = []
    skipped = 0
    names = {}  # tool_use id -> tool name
    try:
        with open(jsonl_path, "rb") as f:
            raw_lines = f.read().split(b"\n")
    except OSError:
        return [], 0
    for raw in raw_lines:
        if not raw.strip():
            continue
        try:
            obj = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            skipped += 1
            continue
        if not isinstance(obj, dict):
            continue
        ts = parse_ts(obj.get("timestamp"))
        msg = obj.get("message")
        if ts is None or not isinstance(msg, dict):
            continue
        content = msg.get("content")
        blocks = [b for b in content if isinstance(b, dict)] if isinstance(content, list) else []
        if obj.get("type") == "assistant":
            other = [b for b in blocks if b.get("type") != "tool_use"]
            if other or not blocks:
                events.append(_event(ts, "assistant", text=_text_of(other or content)))
            for b in blocks:
                if b.get("type") != "tool_use":
                    continue
                id_ = b.get("id") if isinstance(b.get("id"), str) else None
                name = b.get("name") if isinstance(b.get("name"), str) else None
                if id_ is not None and name is not None:
                    names[id_] = name
                events.append(_event(ts, "tool_use", name=name, id_=id_,
                                     input_=b.get("input") if isinstance(b.get("input"), dict) else None))
        elif obj.get("type") == "user":
            for b in blocks:
                if b.get("type") != "tool_result":
                    continue
                id_ = b.get("tool_use_id") if isinstance(b.get("tool_use_id"), str) else None
                events.append(_event(ts, "tool_result", name=names.get(id_), id_=id_,
                                     is_error=b.get("is_error") is True,
                                     text=_text_of(b.get("content"))))
    return events, skipped


def read_events(jsonl_path):
    """The timed events of one transcript, in file order:
    {ts, kind: assistant|tool_use|tool_result, name, id, is_error, text, input}.

    The file is read as bytes and each line decoded strictly; a line that is
    not valid UTF-8 or not valid JSON is skipped (read_events_counted counts
    them). Lines without a timestamp are skipped, and so are lines that are
    neither an assistant message nor a tool result (prompts, attachments).
    An assistant line gives one assistant event for its text or thinking
    blocks and one tool_use event per tool call; a tool_result carries the
    name of the tool_use it answers. text is for matching only: it is never
    written out."""
    return read_events_counted(jsonl_path)[0]


# ---- the run folder ----

def _files(folder, pattern):
    return sorted(p for p in glob.glob(os.path.join(folder, pattern)) if os.path.isfile(p))


def find_manifest(folder):
    found = _files(folder, "*.lanes.json")
    return found[0] if found else None


def find_report(folder):
    """The first of *.report.json, *.run-report.json and report.json."""
    for pattern in ("*.report.json", "*.run-report.json", "report.json"):
        found = _files(folder, pattern)
        if found:
            return found[0]
    return None


def find_ledger(folder):
    found = sorted(p for p in glob.glob(os.path.join(folder, "*.ledger")) if os.path.isdir(p))
    return found[0] if found else None


def wf_dirs(folder):
    return sorted(p for p in glob.glob(os.path.join(folder, "wf_*")) if os.path.isdir(p))


def input_files(folder):
    """Every file autopsy reads: the manifest, the report, wf_*.json, wf_*/*
    and the ledger files."""
    paths = []
    for p in (find_manifest(folder), find_report(folder)):
        if p:
            paths.append(p)
    paths += _files(folder, "wf_*.json")
    for d in wf_dirs(folder):
        paths += _files(d, "*")
    ledger = find_ledger(folder)
    if ledger:
        for root, _dirs, names in os.walk(ledger):
            paths += [os.path.join(root, n) for n in names]
    return sorted(set(paths))


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def fingerprint(run_folder):
    """sha256 over the sorted list of [relative path, size, sha256] of every
    file autopsy reads; relative paths use '/'."""
    entries = []
    for path in input_files(run_folder):
        rel = os.path.relpath(path, run_folder).replace("\\", "/")
        try:
            entries.append([rel, os.path.getsize(path), _sha256(path)])
        except OSError:
            entries.append([rel, None, None])
    entries.sort()
    blob = json.dumps(entries, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()


# ---- loading ----

def _launch(folder, wf_dir, manifest):
    """One launch: its wf json, run-report view and agents with events."""
    name = os.path.basename(wf_dir)
    wf_json = os.path.join(folder, name + ".json")
    data = _transcripts.read_json(wf_json) if os.path.isfile(wf_json) else {}
    result = data.get("result") if isinstance(data.get("result"), dict) else None
    report = _transcripts.build_report(wf_dir, manifest)
    metas = sorted(glob.glob(os.path.join(wf_dir, "agent-*.meta.json")), key=_transcripts.start_key)
    agents = []
    # build_report lists agents in the same start_key order.
    for meta_path, entry in zip(metas, report["agents"]):
        events, skipped = read_events_counted(meta_path[:-len(".meta.json")] + ".jsonl")
        agents.append({"entry": entry, "events": events, "skipped": skipped, "launch": name})
    start_ms = data.get("startTime")
    duration_ms = data.get("durationMs")
    start = end = None
    if isinstance(start_ms, (int, float)) and not isinstance(start_ms, bool):
        start = start_ms / 1000.0
        if isinstance(duration_ms, (int, float)) and not isinstance(duration_ms, bool):
            end = start + duration_ms / 1000.0
    if start is None or end is None:
        # No workflow timing: the launch spans its agents' first to last event.
        times = [e["ts"] for a in agents for e in a["events"]]
        start, end = (min(times), max(times)) if times else (None, None)
    return {"wf": name, "result": result, "report": report, "agents": agents,
            "start": start, "end": end}


def load(run_folder):
    """The run folder read once: manifest, launches (in start order)."""
    manifest_path = find_manifest(run_folder)
    manifest = _transcripts.read_json(manifest_path) if manifest_path else {}
    launches = [_launch(run_folder, d, manifest) for d in wf_dirs(run_folder)]
    launches.sort(key=lambda l: (l["start"] is None, l["start"] or 0.0, l["wf"]))
    for launch in launches:
        for a in launch["agents"]:
            span_agent(a)
    return {"folder": run_folder, "manifest": manifest, "launches": launches}


def span_agent(agent):
    """Set an agent's start, end and tool time from its events."""
    events = agent["events"]
    if not events:
        agent["start"] = agent["end"] = agent["tool"] = None
        return
    agent["start"] = min(e["ts"] for e in events)
    agent["end"] = max(e["ts"] for e in events)
    uses = {}
    spans = []
    for e in events:
        if e["kind"] == "tool_use" and e["id"] is not None:
            uses.setdefault(e["id"], e["ts"])
        elif e["kind"] == "tool_result" and e["id"] in uses and e["ts"] >= uses[e["id"]]:
            spans.append((uses.pop(e["id"]), e["ts"]))
    agent["tool"] = union_length(spans)


def _all_agents(run):
    return [a for launch in run["launches"] for a in launch["agents"]]


# ---- done ----

def _str_or_unavailable(value):
    return value if isinstance(value, str) and value else UNAVAILABLE


def _count(value):
    return len(value) if isinstance(value, list) else UNAVAILABLE


def done_section(result):
    if not isinstance(result, dict):
        result = {}
    tasks = result.get("tasks")
    if isinstance(tasks, dict):
        done_tasks = {}
        for tid, t in tasks.items():
            t = t if isinstance(t, dict) else {}
            commits = t.get("commits")
            rounds = t.get("rounds")
            done_tasks[tid] = {
                "status": _str_or_unavailable(t.get("status")),
                "commits": [c for c in commits if isinstance(c, str) and _SHA.match(c)]
                if isinstance(commits, list) else UNAVAILABLE,
                "rounds": rounds if isinstance(rounds, int) and not isinstance(rounds, bool) else UNAVAILABLE,
                "tier_used": _str_or_unavailable(t.get("tier_used")),
            }
    else:
        done_tasks = UNAVAILABLE
    acc = result.get("acceptance")
    if isinstance(acc, dict):
        reasons = acc.get("reasons")
        acceptance = {
            "status": _str_or_unavailable(acc.get("status")),
            "reasons": [{"kind": _str_or_unavailable(r.get("kind")),
                         "class": _str_or_unavailable(r.get("class"))}
                        for r in reasons if isinstance(r, dict)]
            if isinstance(reasons, list) else UNAVAILABLE,
            "warnings": _count(acc.get("warnings")),
        }
    else:
        acceptance = UNAVAILABLE
    fin = result.get("final")
    final = {k: _count(fin.get(k)) for k in ("fixed", "declined", "open")} \
        if isinstance(fin, dict) else UNAVAILABLE
    if "e2e" not in result:
        e2e = UNAVAILABLE
    elif result["e2e"] is None:
        e2e = "none"
    else:
        items = result["e2e"].get("items") if isinstance(result["e2e"], dict) else None
        if not isinstance(items, list) or not items:
            e2e = UNAVAILABLE
        elif all(isinstance(i, dict) and i.get("result") == "PASS" for i in items):
            e2e = "pass"
        else:
            e2e = "fail"
    return {"tasks": done_tasks, "acceptance": acceptance, "final": final, "e2e": e2e}


# ---- time ----

def _phase_name(entry):
    return entry["phase"] if isinstance(entry.get("phase"), str) and entry["phase"] else UNAVAILABLE


def lane_ids(manifest):
    """{phase name: lane id}: each lane's name, else 'Lane <id>'."""
    names = {}
    lanes = [l for l in manifest.get("lanes") or [] if isinstance(l, dict) and isinstance(l.get("id"), str)]
    for lane in lanes:
        if isinstance(lane.get("name"), str) and lane["name"]:
            names.setdefault(lane["name"], lane["id"])
    for lane in lanes:
        names.setdefault("Lane " + lane["id"], lane["id"])
    return names


def _timed(agents):
    return [a for a in agents if a["start"] is not None]


def _span(agents):
    timed = _timed(agents)
    if not timed:
        return None, None
    return min(a["start"] for a in timed), max(a["end"] for a in timed)


def time_section(run):
    lanes_by_phase = lane_ids(run["manifest"])
    phases = []
    lanes = []
    gaps = []
    for launch in run["launches"]:
        groups = {}
        for a in launch["agents"]:
            groups.setdefault(_phase_name(a["entry"]), []).append(a)
        ordered = sorted(groups.items(), key=lambda kv: (_span(kv[1])[0] is None, _span(kv[1])[0] or 0.0))
        for name, members in ordered:
            start, end = _span(members)
            phases.append({"phase": name, "launch": launch["wf"], "start": iso(start), "end": iso(end),
                           "wall_s": seconds(None if start is None else end - start),
                           "agents": len(members)})
            if name in lanes_by_phase:
                complete = start is not None and len(_timed(members)) == len(members)
                busy = union_length([(a["start"], a["end"]) for a in members]) if complete else None
                lanes.append({"lane": lanes_by_phase[name], "launch": launch["wf"],
                              "start": iso(start), "end": iso(end), "busy_s": seconds(busy),
                              "idle_s": seconds(None if busy is None else (end - start) - busy)})
        # Idle gaps: spans over IDLE_GAP_S inside the launch with no agent running.
        if launch["start"] is not None:
            cursor = launch["start"]
            spans = merged([(a["start"], a["end"]) for a in _timed(launch["agents"])])
            for start, end in spans + [[launch["end"], launch["end"]]]:
                if start - cursor > IDLE_GAP_S:
                    gaps.append({"start": iso(cursor), "end": iso(start), "s": seconds(start - cursor)})
                cursor = max(cursor, end)
    agents = []
    for a in _all_agents(run):
        e = a["entry"]
        wall = None if a["start"] is None else a["end"] - a["start"]
        agents.append({
            "label": e["label"], "launch": a["launch"], "phase": _phase_name(e), "task": e["task"],
            "role": e["role"], "start": iso(a["start"]), "end": iso(a["end"]),
            "wall_s": seconds(wall), "tool_s": seconds(a["tool"]),
            "other_s": seconds(None if wall is None else max(0.0, wall - a["tool"])),
        })
    walls = [l["end"] - l["start"] if l["start"] is not None else None for l in run["launches"]]
    wall_s = seconds(sum(walls)) if walls and None not in walls else UNAVAILABLE
    return {"wall_s": wall_s, "phases": phases, "lanes": lanes, "agents": agents,
            "critical_path": {"estimate": True, "labels": critical_path(run)}, "idle_gaps": gaps}


def critical_path(run):
    """A timing-based estimate: from the last-ending agent, walk back to the
    latest-ending agent that ended before it started; labels, first to last."""
    timed = _timed(_all_agents(run))
    if not timed:
        return []
    # Ties go to the later agent in start order.
    current = max(enumerate(timed), key=lambda ia: (ia[1]["end"], ia[0]))[1]
    path = [current]
    while True:
        before = [(i, a) for i, a in enumerate(timed) if a["end"] <= current["start"] and a is not current]
        if not before:
            break
        current = max(before, key=lambda ia: (ia[1]["end"], ia[0]))[1]
        path.append(current)
    return [a["entry"]["label"] for a in reversed(path)]


# ---- tokens ----

def _incomplete(entry):
    return entry["input_tokens"] != UNAVAILABLE and entry["output_tokens"] == UNAVAILABLE


def buckets(entries, key):
    """{key(entry): bucket} in run-report's token-field shape and rules: only
    known values are summed, and a bucket holding an output-incomplete agent
    has output_tokens "unavailable" (output_tokens_min still sums)."""
    out = {}
    for e in entries:
        k = key(e)
        if k is None:
            continue
        b = out.setdefault(k, _transcripts.blank_bucket())
        b["agents"] += 1
        if e["input_tokens"] == UNAVAILABLE:
            continue
        for field in TOKEN_FIELDS + ("output_tokens_min",):
            if e[field] != UNAVAILABLE:
                b[field] += e[field]
    for e in entries:
        k = key(e)
        if k is not None and _incomplete(e):
            out[k]["output_tokens"] = UNAVAILABLE
    return out


def _agent_tokens(e):
    out = e["output_tokens"] if e["output_tokens"] != UNAVAILABLE else e["output_tokens_min"]
    return e["input_tokens"] + e["cache_creation_input_tokens"] + out


def tokens_section(run):
    entries = []
    for a in _all_agents(run):
        e = dict(a["entry"])
        e["_launch"] = a["launch"]
        entries.append(e)
    totals = buckets(entries, lambda e: "all").get("all", _transcripts.blank_bucket())
    known = [e for e in entries if e["input_tokens"] != UNAVAILABLE]
    ranked = sorted(enumerate(known), key=lambda ie: (-_agent_tokens(ie[1]), ie[0]))[:TOP_AGENTS]
    top = []
    for _i, e in ranked:
        item = {"label": e["label"], "launch": e["_launch"], "phase": _phase_name(e), "task": e["task"],
                "role": e["role"], "tier": e["tier"], "tokens": _agent_tokens(e)}
        for field in TOKEN_FIELDS + ("output_tokens_min",):
            item[field] = e[field]
        top.append(item)
    unreadable = sum(e["unreadable_lines"] for e in entries)
    partial = any(_incomplete(e) or e["unreadable_lines"] > 0 or e["input_tokens"] == UNAVAILABLE
                  for e in entries)
    return {
        "totals": totals,
        "by_phase": buckets(entries, _phase_name),
        "by_role": buckets(entries, lambda e: e["role"]),
        "by_tier": buckets(entries, lambda e: e["tier"]),
        "per_task": buckets(entries, lambda e: e["task"]),
        "top_agents": top,
        "unreadable_lines": unreadable,
        "partial": partial,
    }


# ---- the whole analysis ----

def _engine_version(run):
    if run["launches"]:
        version = _transcripts.engine_version(run["launches"][-1]["result"])
        if version != UNAVAILABLE:
            return version
    report = find_report(run["folder"])
    if report:
        version = _transcripts.read_json(report).get("engine_version")
        if isinstance(version, str) and version:
            return version
    return UNAVAILABLE


def analyze(run_folder):
    """The autopsy.json object for a history run folder."""
    run = load(run_folder)
    launches = []
    for launch in run["launches"]:
        result = launch["result"] or {}
        wall = None if launch["start"] is None else launch["end"] - launch["start"]
        launches.append({"wf": launch["wf"], "start": iso(launch["start"]), "end": iso(launch["end"]),
                         "wall_s": seconds(wall), "status": _str_or_unavailable(result.get("status"))})
    last = run["launches"][-1]["result"] if run["launches"] else None
    run_id = run["manifest"].get("run_id")
    return {
        "autopsy_version": AUTOPSY_VERSION,
        "inputs_fingerprint": fingerprint(run_folder),
        "run_id": run_id if isinstance(run_id, str) and run_id else UNAVAILABLE,
        "engine_version": _engine_version(run),
        "launches": launches,
        "done": done_section(last),
        "time": time_section(run),
        "tokens": tokens_section(run),
        "checks": {},
        "slowdowns": [],
        "detectors": {},
        "suggestions": [],
        "unexplained": [],
    }
