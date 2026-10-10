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
never written out. Event "text", notes and tool inputs stay internal: a
slowdown's evidence holds only the tool name, an exit code, a marker string
from MARKERS (or HEREDOC, RUN_CHECKS) and a program name (program_of); a
check execution's command is a configured string from the manifest or
'run-checks', never the command line.
"""
import glob
import hashlib
import json
import os
import re
import shlex
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
    events, skipped, _notes = read_transcript(jsonl_path)
    return events, skipped


def read_transcript(jsonl_path):
    """(events, skipped, notes): read_events_counted's two values, and notes:
    [{ts, text}] for each timed user line that carries text rather than tool
    results (the prompt, and notices such as a background command's
    completion). Notes are for matching only, like event text."""
    events = []
    notes = []
    skipped = 0
    names = {}  # tool_use id -> tool name
    try:
        with open(jsonl_path, "rb") as f:
            raw_lines = f.read().split(b"\n")
    except OSError:
        return [], 0, []
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
            if not any(b.get("type") == "tool_result" for b in blocks):
                text = _text_of(content)
                if text:
                    notes.append({"ts": ts, "text": text})
            for b in blocks:
                if b.get("type") != "tool_result":
                    continue
                id_ = b.get("tool_use_id") if isinstance(b.get("tool_use_id"), str) else None
                events.append(_event(ts, "tool_result", name=names.get(id_), id_=id_,
                                     is_error=b.get("is_error") is True,
                                     text=_text_of(b.get("content"))))
    return events, skipped, notes


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
        events, skipped, notes = read_transcript(meta_path[:-len(".meta.json")] + ".jsonl")
        agents.append({"entry": entry, "events": events, "skipped": skipped, "notes": notes,
                       "launch": name})
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


def launch_idle_gaps(launch):
    """[(start, end)]: the spans over IDLE_GAP_S inside a launch with no
    agent of it running. None for a launch without timing or without a
    timed agent: its gaps cannot be told from missing timestamps."""
    if launch["start"] is None or not _timed(launch["agents"]):
        return None
    gaps = []
    cursor = launch["start"]
    spans = merged([(a["start"], a["end"]) for a in _timed(launch["agents"])])
    for start, end in spans + [[launch["end"], launch["end"]]]:
        if start - cursor > IDLE_GAP_S:
            gaps.append((cursor, start))
        cursor = max(cursor, end)
    return gaps


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
        for start, end in launch_idle_gaps(launch) or []:
            gaps.append({"start": iso(start), "end": iso(end), "s": seconds(end - start)})
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
    return [a["entry"]["label"] for a in critical_agents(run)]


def critical_agents(run):
    """The agents on critical_path, first to last."""
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
    return list(reversed(path))


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


# ---- slowdowns ----

# The marker strings the detectors look for in tool results, matched
# case-insensitively. A slowdown's evidence.marker is one of these (or HEREDOC
# or RUN_CHECKS), never text taken from the transcript.
MARKERS = {
    "background_check": ("Command running in background with ID",),
    "timeout": ("timed out",),
    "edit_retry": ("String to replace not found", "has been modified since", "has not been read yet"),
}
HEREDOC = "<<"
RUN_CHECKS = "run-checks"
LONG_CALL_S = 120
TOP_UNEXPLAINED = 5
WRITE_TOOLS = ("Edit", "Write", "MultiEdit", "NotebookEdit")
TOOL_KINDS = ("background_check", "timeout", "repeated_failure", "heredoc_failure", "edit_retry",
              "long_tool_call", "check_rerun")
KINDS = ("background_check", "timeout", "repeated_failure", "heredoc_failure", "edit_retry",
         "extra_review_round", "escalation", "retry", "relaunch", "long_tool_call", "idle_gap",
         "check_rerun")

# One suggestion per kind: a likely cause, then a change to try.
SUGGESTIONS = {
    "background_check": "A check likely went to the background and the agent waited for it. Try running "
                        "checks in the foreground with a timeout long enough for the suite.",
    "timeout": "A tool call likely hit its time limit. Try a longer timeout for slow commands, or a "
               "narrower command while iterating.",
    "repeated_failure": "The same command likely failed again with nothing changed in between. Try "
                        "reading the first failure's output and fixing its cause before rerunning.",
    "heredoc_failure": "Shell quoting in a heredoc likely broke a file write. Try writing files with the "
                       "Edit or Write tools instead of shell heredocs.",
    "edit_retry": "An edit likely failed because the file was unread, had changed, or did not hold the "
                  "text. Try reading the file again right before editing it.",
    "extra_review_round": "Review likely found problems the implementer did not catch. Try clearer "
                          "acceptance criteria in the task, or running the full checks before review.",
    "escalation": "A task likely needed a stronger model than its tier gave it. Try a higher tier for "
                  "tasks like it.",
    "retry": "An agent likely ended without a usable result and was run again. Try reading its "
             "transcript for the cause before the next run.",
    "relaunch": "The run likely stopped and was launched again. Try finding why the earlier launch "
                "stopped before resuming.",
    "long_tool_call": "A single tool call likely ran for over 2 minutes. Try a narrower command while "
                      "iterating, and the full suite once before committing.",
    "idle_gap": "No agent ran for over a minute, likely while the session waited between phases. Try "
                "checking what the session was doing then.",
    "check_rerun": "A check likely ran again with nothing changed in between. Try reading the earlier "
                   "run's output instead of rerunning it.",
}
UNCLEAN_TEXT = ("Commit any file a check needs; add only known generated output to .gitignore; "
                "never ignore a file a check reads.")
UNCLEAN_NAMES = 10

_EXIT = re.compile(r"exit code[:\s]+(-?\d+)", re.I)
_BACKGROUND_ID = re.compile(r"command running in background with id[:\s]*([A-Za-z0-9_-]+)", re.I)
_ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
_GIT_COMMIT = re.compile(r"\bgit\b[^\n;&|]*\bcommit\b")
_FIX_ROLE = re.compile(r"^(fix|re-review) \d+$")


def _marker(kind, text):
    """The first of MARKERS[kind] that text holds (any case), or None."""
    low = (text or "").lower()
    return next((m for m in MARKERS[kind] if m.lower() in low), None)


def exit_code(text):
    """The exit code a tool result reports ('Exit code N'), or None."""
    m = _EXIT.search(text or "")
    return int(m.group(1)) if m else None


def program_of(command):
    """The program a Bash command runs: its first word that is not a
    NAME=value assignment or 'env', reduced to its basename. None when there
    is none, or when that word still holds '=', '@' or ':' (it may carry a
    secret or a URL)."""
    for word in _words(command):
        if word == "env" or _ASSIGNMENT.match(word):
            continue
        name = _basename(word)
        if not name or any(c in name for c in "=@:"):
            return None
        return name
    return None


def _words(command):
    """A command line's shell words ([] for a non-string); split on
    whitespace when its quoting does not parse."""
    if not isinstance(command, str):
        return []
    try:
        return shlex.split(command)
    except ValueError:
        return command.split()


def _basename(word):
    return re.split(r"[/\\]", word)[-1]


def _calls(agent):
    """An agent's tool calls in call order: {name, input, start, end,
    result_i, is_error, text}; end is None when no result answers it."""
    calls = []
    waiting = {}
    for i, e in enumerate(agent["events"]):
        if e["kind"] == "tool_use":
            call = {"name": e["name"], "input": e["input"] or {}, "start": e["ts"], "end": None,
                    "result_i": None, "is_error": False, "text": ""}
            calls.append(call)
            if e["id"] is not None:
                waiting[e["id"]] = call
        elif e["kind"] == "tool_result" and e["id"] in waiting:
            call = waiting.pop(e["id"])
            if e["ts"] >= call["start"]:
                call.update(end=e["ts"], result_i=i, is_error=e["is_error"], text=e["text"])
    return calls


def _command(call):
    command = call["input"].get("command")
    return command if isinstance(command, str) else None


def _failed(call):
    code = exit_code(call["text"])
    return call["end"] is not None and (call["is_error"] or (code is not None and code != 0))


def _bash_failed(call):
    return call["name"] == "Bash" and _command(call) is not None and _failed(call)


def _wrote(call):
    """A write of a file that succeeded."""
    return (call["name"] in WRITE_TOOLS and call["end"] is not None and not call["is_error"]
            and _marker("edit_retry", call["text"]) is None)


def _slowdown(kind, agent, start, end, cost_kind, call=None, marker=None, covers=None):
    """An internal slowdown: the public fields, plus _cost (seconds or None),
    _at and _covers [(agent or None, start, end)], the spans it explains (an
    agent's own time, or any agent's time for None)."""
    cost = None if start is None or end is None else end - start
    if covers is None:
        covers = [] if cost is None else [(agent, start, end)]
    return {
        "kind": kind,
        "agent": agent["entry"]["label"] if agent is not None else None,
        "_at": start,
        "_cost": cost,
        "cost_kind": cost_kind,
        "evidence": {
            "tool": call["name"] if call is not None else None,
            "exit": exit_code(call["text"]) if call is not None else None,
            "marker": marker,
            "program": program_of(_command(call)) if call is not None else None,
        },
        "_covers": covers,
    }


def _mention_after(agent, call):
    """When a backgrounded call's ID is first mentioned in a later tool
    result or notice of the same agent; None when it never is."""
    m = _BACKGROUND_ID.search(call["text"])
    if not m:
        return None
    pattern = re.compile(r"(?<![A-Za-z0-9_-])" + re.escape(m.group(1)) + r"(?![A-Za-z0-9_-])")
    times = [e["ts"] for e in agent["events"][call["result_i"] + 1:]
             if e["kind"] == "tool_result" and pattern.search(e["text"])]
    times += [n["ts"] for n in agent.get("notes", []) if pattern.search(n["text"])]
    later = [t for t in times if t >= call["end"]]
    return min(later) if later else None


def tool_slowdowns(agent, test_commands):
    """The slowdowns found in one agent's tool calls (TOOL_KINDS)."""
    calls = _calls(agent)
    out = []
    counted = set()

    def add(kind, indexes, start, end, cost_kind, call, marker=None):
        out.append(_slowdown(kind, agent, start, end, cost_kind, call, marker))
        counted.update(indexes)

    for i, c in enumerate(calls):
        if c["end"] is None:
            continue
        marker = _marker("background_check", c["text"])
        if marker:
            mention = _mention_after(agent, c)
            if mention is None:
                add("background_check", [i], c["start"], c["end"], "measured", c, marker)
            else:
                add("background_check", [i], c["start"], mention, "bound", c, marker)
        marker = _marker("timeout", c["text"])
        if marker:
            add("timeout", [i], c["start"], c["end"], "measured", c, marker)

    failures = {}
    for i, c in enumerate(calls):
        if _bash_failed(c):
            failures.setdefault(" ".join(_command(c).split()), []).append(i)
    for indexes in failures.values():
        if len(indexes) >= 2:
            first, last = calls[indexes[0]], calls[indexes[-1]]
            add("repeated_failure", indexes, first["start"], last["end"], "measured", first)

    until = None
    for i, c in enumerate(calls):
        if not _bash_failed(c) or HEREDOC not in _command(c):
            continue
        if until is not None and c["start"] < until:
            continue  # a retry inside the previous heredoc failure's span
        write = next((w for w in calls[i + 1:] if _wrote(w)), None)
        if write is None:
            add("heredoc_failure", [i], c["start"], c["end"], "measured", c, HEREDOC)
            until = c["end"]
        else:
            add("heredoc_failure", [i], c["start"], write["end"], "bound", c, HEREDOC)
            until = write["end"]

    until = {}
    for i, c in enumerate(calls):
        if c["name"] not in WRITE_TOOLS or c["end"] is None:
            continue
        marker = _marker("edit_retry", c["text"])
        path = c["input"].get("file_path")
        if not marker or not isinstance(path, str):
            continue
        if path in until and c["start"] < until[path]:
            continue  # a retry inside the previous retry's span
        fixed = next((w for w in calls[i + 1:] if _wrote(w) and w["input"].get("file_path") == path), None)
        end = c["end"] if fixed is None else fixed["end"]
        add("edit_retry", [i], c["start"], end, "measured", c, marker)
        until[path] = end

    last_run = {}
    for i, c in enumerate(calls):
        command = _command(c) if c["name"] == "Bash" else None
        if command is None or not (RUN_CHECKS in command or any(t in command for t in test_commands)):
            continue
        key = " ".join(command.split())
        prev = last_run.get(key)
        last_run[key] = i
        if prev is None or c["end"] is None:
            continue
        changed = any(b["name"] in WRITE_TOOLS
                      or (b["name"] == "Bash" and _GIT_COMMIT.search(_command(b) or ""))
                      for b in calls[prev + 1:i])
        if not changed:
            add("check_rerun", [i], c["start"], c["end"], "measured", c,
                RUN_CHECKS if RUN_CHECKS in command else None)

    for i, c in enumerate(calls):
        if i not in counted and c["end"] is not None and c["end"] - c["start"] > LONG_CALL_S:
            add("long_tool_call", [i], c["start"], c["end"], "measured", c)
    return out


def _model(entry):
    return entry["resolved_model"] if entry["resolved_model"] != UNAVAILABLE else entry["requested_model"]


def run_slowdowns(run):
    """The slowdowns found in roles, launches and idle gaps."""
    out = []
    fixes = {}
    for a in _all_agents(run):
        e = a["entry"]
        if e["task"] is not None and _FIX_ROLE.match(e["role"]):
            fixes.setdefault(e["task"], []).append(a)
    for members in fixes.values():
        timed = _timed(members)
        first = timed[0] if timed else members[0]
        sd = _slowdown("extra_review_round", first, first["start"], None, "measured",
                       covers=[(a, a["start"], a["end"]) for a in timed])
        sd["_cost"] = sum(a["end"] - a["start"] for a in timed) if len(timed) == len(members) else None
        out.append(sd)
    for launch in run["launches"]:
        # Escalations as run-report counts them: the same label (without
        # ' retry') running again at another model tier in the same launch.
        last_model = {}
        for a in launch["agents"]:
            label = a["entry"]["label"]
            retried = label.endswith(" retry")
            base = label[:-len(" retry")].rstrip() if retried else label
            if retried:
                out.append(_slowdown("retry", a, a["start"], a["end"], "measured"))
            model = _model(a["entry"])
            prev = last_model.get(base)
            if prev is not None and model != UNAVAILABLE and prev != UNAVAILABLE \
                    and _transcripts.model_tier(model) != _transcripts.model_tier(prev):
                out.append(_slowdown("escalation", a, a["start"], a["end"], "measured"))
            last_model[base] = model
    for launch in run["launches"][:-1]:
        out.append(_slowdown("relaunch", None, launch["start"], launch["end"], "measured"))
    for launch in run["launches"]:
        for start, end in launch_idle_gaps(launch) or []:
            out.append(_slowdown("idle_gap", None, start, end, "measured"))
    return out


def _has_tool_events(run):
    return any(e["kind"] in ("tool_use", "tool_result") for a in _all_agents(run) for e in a["events"])


def detector_status(run):
    """{kind: 'ok' | 'not_available'}: a detector is not_available when its
    inputs are missing from every agent or launch."""
    agents = _all_agents(run)
    tool_events = _has_tool_events(run)
    labels = any(a["entry"]["label"] for a in agents)
    models = labels and any(_model(a["entry"]) != UNAVAILABLE for a in agents)
    available = {
        "extra_review_round": labels,
        "escalation": models,
        "retry": labels,
        "relaunch": bool(run["launches"]),
        "idle_gap": any(launch_idle_gaps(l) is not None for l in run["launches"]),
    }
    for kind in TOOL_KINDS:
        available[kind] = tool_events
    return {k: "ok" if available[k] else "not_available" for k in KINDS}


def find_slowdowns(run, detectors):
    """Internal slowdowns of every available detector, largest cost first
    (unknown costs last), then by time and kind."""
    commands = run["manifest"].get("commands")
    tests = commands.get("test") if isinstance(commands, dict) else None
    test_commands = [t for t in tests if isinstance(t, str) and t.strip()] if isinstance(tests, list) else []
    found = run_slowdowns(run)
    for a in _all_agents(run):
        found += tool_slowdowns(a, test_commands)
    found = [s for s in found if detectors[s["kind"]] == "ok"]
    found.sort(key=lambda s: (s["_cost"] is None, -(s["_cost"] or 0.0), s["_at"] is None, s["_at"] or 0.0,
                              KINDS.index(s["kind"])))
    return found


def public_slowdown(s):
    return {"kind": s["kind"], "agent": s["agent"], "at": iso(s["_at"]), "cost_s": seconds(s["_cost"]),
            "cost_kind": s["cost_kind"], "evidence": s["evidence"]}


# ---- checks ----

CHECK_GROUPS = ("test", "lint", "build")


def _squash(text):
    return " ".join(text.split())


def configured_checks(manifest):
    """[(command, full_suite)]: the manifest's commands.test, lint and build
    entries, then each lane_commands override's, without repeats. full_suite
    is True for a commands.test entry."""
    out = []
    seen = set()

    def add(commands, full_groups):
        if not isinstance(commands, dict):
            return
        for group in CHECK_GROUPS:
            entries = commands.get(group)
            for command in entries if isinstance(entries, list) else []:
                if isinstance(command, str) and _squash(command) and command not in seen:
                    seen.add(command)
                    out.append((command, group in full_groups))

    add(_manifest_commands(manifest), ("test",))
    lanes = manifest.get("lane_commands")
    for commands in lanes.values() if isinstance(lanes, dict) else []:
        add(commands, ())
    return out


def _manifest_commands(manifest):
    commands = manifest.get("commands")
    return commands if isinstance(commands, dict) else {}


def match_check(command, checks):
    """(name, full_suite) when a Bash command line runs a check, else None.

    A line with a word whose basename is run-checks is a run-checks call:
    name 'run-checks', and a full-suite run when it passes '--cmd test'.
    Otherwise name is the longest of checks' commands the line holds
    (whitespace-normalised), first in checks' order on a tie."""
    if not isinstance(command, str):
        return None
    # Shell words, and plain words too: shlex drops the backslashes of an
    # unquoted Windows path.
    for words in (_words(command), [w.strip("'\"") for w in command.split()]):
        if any(_basename(w) == RUN_CHECKS for w in words):
            full = any(w == "--cmd" and words[i + 1:i + 2] == ["test"] for i, w in enumerate(words))
            return RUN_CHECKS, full
    line = _squash(command)
    best = None
    for name, full in checks:
        if _squash(name) in line and (best is None or len(_squash(name)) > len(_squash(best[0]))):
            best = (name, full)
    return best


def _execution_end(agent, call):
    """(background, end, timing) of a check call. A backgrounded call ends
    at the first later event naming its ID; a call with no such event, or
    without a result, is bound by the agent's last event."""
    background = call["input"].get("run_in_background") is True \
        or (call["end"] is not None and _marker("background_check", call["text"]) is not None)
    if call["end"] is None:
        return background, agent["end"], "bound"
    if background:
        mention = _mention_after(agent, call)
        if mention is None:
            return background, agent["end"], "bound"
        return background, mention, "measured"
    return background, call["end"], "measured"


def checks_section(run):
    """Every Bash call that runs a configured check or run-checks, with its
    timing; per-command totals; full-suite runs per role. Without any tool
    event in the run the section cannot be derived and is unavailable."""
    if not _has_tool_events(run):
        return {"executions": UNAVAILABLE, "by_command": UNAVAILABLE,
                "full_suite_runs": {"total": UNAVAILABLE, "by_role": UNAVAILABLE}}
    checks = configured_checks(run["manifest"])
    on_path = set(id(a) for a in critical_agents(run))
    found = []
    for order, a in enumerate(_all_agents(run)):
        e = a["entry"]
        for call in _calls(a):
            match = match_check(_command(call), checks) if call["name"] == "Bash" else None
            if match is None:
                continue
            background, end, timing = _execution_end(a, call)
            found.append(((call["start"], order), match[1], {
                "agent": e["label"], "phase": _phase_name(e), "role": e["role"], "command": match[0],
                "start": iso(call["start"]), "end": iso(end), "s": seconds(end - call["start"]),
                "timing": timing, "background": background, "on_critical_path": id(a) in on_path,
            }))
    found.sort(key=lambda f: f[0])
    executions = [x for _key, _full, x in found]
    by_command = {}
    for x in executions:
        totals = by_command.setdefault(x["command"], {"runs": 0, "total_s": 0.0})
        totals["runs"] += 1
        totals["total_s"] += x["s"]
    for totals in by_command.values():
        totals["total_s"] = seconds(totals["total_s"])
    by_role = {}
    for _key, full, x in found:
        if full:
            by_role[x["role"]] = by_role.get(x["role"], 0) + 1
    return {"executions": executions, "by_command": by_command,
            "full_suite_runs": {"total": sum(by_role.values()), "by_role": by_role}}


# ---- suggestions ----

def untracked_paths(run_folder):
    """The paths run-checks listed as untracked ('?? <path>') in the saved
    verify evidence (<ledger>/checks/verify-*.json), sorted and unique."""
    ledger = find_ledger(run_folder)
    paths = set()
    for path in _files(os.path.join(ledger, "checks"), "verify-*.json") if ledger else []:
        data = _transcripts.read_json(path)
        for key in ("untracked_before", "untracked_after"):
            lines = data.get(key)
            for line in lines if isinstance(lines, list) else []:
                if isinstance(line, str) and line.startswith("?? ") and line[3:].strip():
                    paths.add(line[3:].strip())
    return sorted(paths)


def unclean_suggestion(run_folder, done):
    """The unclean_checks suggestion when acceptance reports checks_unclean,
    else None. It names the untracked files by path only."""
    acc = done.get("acceptance")
    reasons = acc.get("reasons") if isinstance(acc, dict) else None
    if not isinstance(reasons, list) or not any(r.get("kind") == "checks_unclean" for r in reasons):
        return None
    paths = untracked_paths(run_folder)
    if paths:
        names = ", ".join(paths[:UNCLEAN_NAMES])
        if len(paths) > UNCLEAN_NAMES:
            names += ", and %d more" % (len(paths) - UNCLEAN_NAMES)
        cause = "The checks likely ran with untracked files in the checkout: %s." % names
    else:
        cause = "The checks likely ran on uncommitted changes or with untracked files in the checkout."
    return {"kind": "unclean_checks", "text": cause + " " + UNCLEAN_TEXT, "stake_s": 0, "count": 0,
            "slowdowns": []}


def suggestions_section(slowdowns, unclean):
    """One suggestion per kind with a slowdown, ranked by stake_s (the sum of
    its slowdowns' known costs; unavailable when none is known)."""
    out = []
    for kind in KINDS:
        indexes = [i for i, s in enumerate(slowdowns) if s["kind"] == kind]
        if not indexes:
            continue
        costs = [slowdowns[i]["_cost"] for i in indexes if slowdowns[i]["_cost"] is not None]
        out.append({"kind": kind, "text": SUGGESTIONS[kind],
                    "stake_s": seconds(sum(costs)) if costs else UNAVAILABLE,
                    "count": len(indexes), "slowdowns": indexes})
    if unclean is not None:
        out.append(unclean)
    order = list(KINDS) + ["unclean_checks"]
    out.sort(key=lambda g: (g["stake_s"] == UNAVAILABLE,
                            -(g["stake_s"] if g["stake_s"] != UNAVAILABLE else 0), order.index(g["kind"])))
    return out


# ---- unexplained ----

def _uncovered(start, end, covers):
    """The parts of (start, end) outside the merged, sorted covers."""
    pieces = []
    cursor = start
    for s, e in covers:
        if e <= cursor:
            continue
        if s >= end:
            break
        if s > cursor:
            pieces.append((cursor, s))
        cursor = max(cursor, e)
    if cursor < end:
        pieces.append((cursor, end))
    return pieces


def unexplained_section(run, slowdowns):
    """The largest TOP_UNEXPLAINED spans over IDLE_GAP_S that no slowdown
    covers. Each agent's time is cut at its events (a model turn, a tool
    call); a slowdown covers its own agent's time, and one without an agent
    (relaunch, idle gap) covers any agent's."""
    found = []
    for a in _timed(_all_agents(run)):
        covers = merged([(s, e) for sd in slowdowns for owner, s, e in sd["_covers"]
                         if owner is None or owner is a])
        times = sorted(set(e["ts"] for e in a["events"]))
        for start, end in zip(times, times[1:]):
            for s, e in _uncovered(start, end, covers):
                if e - s > IDLE_GAP_S:
                    found.append((s, e, a["entry"]["label"]))
    found.sort(key=lambda f: (-(f[1] - f[0]), f[0]))
    return [{"start": iso(s), "end": iso(e), "s": seconds(e - s), "agent": label}
            for s, e, label in found[:TOP_UNEXPLAINED]]


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
    done = done_section(last)
    detectors = detector_status(run)
    found = find_slowdowns(run, detectors)
    slowdowns = [public_slowdown(s) for s in found]
    return {
        "autopsy_version": AUTOPSY_VERSION,
        "inputs_fingerprint": fingerprint(run_folder),
        "run_id": run_id if isinstance(run_id, str) and run_id else UNAVAILABLE,
        "engine_version": _engine_version(run),
        "launches": launches,
        "done": done,
        "time": time_section(run),
        "tokens": tokens_section(run),
        "checks": checks_section(run),
        "slowdowns": slowdowns,
        "detectors": detectors,
        "suggestions": suggestions_section(found, unclean_suggestion(run_folder, done)),
        "unexplained": unexplained_section(run, found),
    }
