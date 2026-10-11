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

render_markdown(analysis) returns the text of autopsy.md and
render_summary(analysis, md_path) the chat summary (at most 15 lines); both
use only the analysis object and write plain ASCII.

Transcript text is used only inside this module (to match markers); it is
never written out. Event "text", notes and tool inputs stay internal: a
slowdown's evidence holds only the tool name, an exit code, a marker string
from MARKERS (or HEREDOC, RUN_CHECKS) and a program name (program_of); a
check execution is named by a check id or 'run-checks', never by the
command line or the configured command (which may carry a secret).

Checks. configured_checks gives each configured command an id: test#1 is
commands.test[0], <lane>.test#1 is lane_commands.<lane>.test[0]. A Bash
call is a check execution when its command line runs one (match_check):
- The line is read as shell words, without heredoc bodies, a backslash
  before a path character read as '/', split into simple commands at ;
  & | && || ( ) and newlines. An & inside a redirection (2>&1, >&2, &>f)
  is no separator. A line whose quoting does not parse runs no check, and
  text that only mentions one (echo "npm test", a heredoc body, bash -c
  "npm test") is no execution.
- A configured command matches a simple command whose words start with its
  words, with redirections, leading keywords, NAME=value assignments and
  prefixes such as env, timeout DURATION or npx left out of both. The
  match with the most words names the execution; a full-suite run needs a
  simple command that exactly matches a commands.test entry, or a
  run-checks call passing --cmd test.
- Certainty: a matched simple command 'ran' when no if, elif, else, then,
  while, until, for, case, do or function comes before it or leads it, and
  either every operator before it is ;, a newline, | or a background &, or
  the whole line is pipelines joined only by && (no ;, newline, background
  &, or ||) and the call exited 0 (an && list exits 0 only when every part
  ran). Otherwise it is 'inferred': it may not have run (cd DIR && check
  that failed may have failed at the cd).
The full-suite total counts the runs that ran, so it is a lower bound on
full-suite runs: runs through a wrapper (bash -c, a script) are not seen,
and the inferred runs, counted apart, may not have happened.
"""
import glob
import hashlib
import json
import math
import os
import re
import shlex
import sys
from datetime import datetime, timedelta, timezone

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import _transcripts  # noqa: E402

AUTOPSY_VERSION = 3
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
    """One launch: its wf json and agents (run-report's entries) with events."""
    name = os.path.basename(wf_dir)
    wf_json = os.path.join(folder, name + ".json")
    data = _transcripts.read_json(wf_json) if os.path.isfile(wf_json) else {}
    result = data.get("result") if isinstance(data.get("result"), dict) else None
    agents = []
    # Each entry comes with its own meta path, so events never pair with
    # another agent's entry.
    for meta_path, entry in _transcripts.agent_entries(wf_dir, manifest):
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
        # No workflow timing: the launch spans its agents' first timed line
        # (the prompt included) to their last event.
        times = [e["ts"] for a in agents for e in a["events"]]
        firsts = times + [n["ts"] for a in agents for n in a["notes"]]
        start, end = (min(firsts), max(times)) if times else (None, None)
    return {"wf": name, "result": result, "agents": agents, "start": start, "end": end}


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
    """Set an agent's start, end and tool time from its events. It starts at
    its earliest timed line, the prompt included, so the first model turn is
    part of its time; it ends at its last event."""
    events = agent["events"]
    if not events:
        agent["start"] = agent["end"] = agent["tool"] = None
        return
    agent["start"] = min([e["ts"] for e in events] + [n["ts"] for n in agent.get("notes", [])])
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
    agent of it running. None for a launch without timing, without a timed
    agent, or with an agent that has no timestamps (it may have run in what
    looks like a gap): its gaps cannot be told from missing timestamps."""
    timed = _timed(launch["agents"])
    if launch["start"] is None or not timed or len(timed) != len(launch["agents"]):
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
            # start and end are what the timed members show; the wall time
            # needs every member timed, as a lane's busy time does.
            complete = start is not None and len(_timed(members)) == len(members)
            phases.append({"phase": name, "launch": launch["wf"], "start": iso(start), "end": iso(end),
                           "wall_s": seconds(end - start if complete else None),
                           "agents": len(members)})
            if name in lanes_by_phase:
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

_incomplete = _transcripts.is_output_incomplete

# {key(entry): bucket}, summed by the same code and rules as run-report.
buckets = _transcripts.token_buckets


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
# background_check and timeout match only Claude Code's own notice on the
# first line of a Bash result (after an 'Exit code N' line, if any), never
# command output, file contents or another tool's result: a timeout notice
# starts that line, and a background notice is a line starting with
# 'Command ' that holds the marker. Claude Code writes a call that hit its
# timeout as 'Command did not complete within its 600s timeout and was moved
# to the background (ID: x)', which is both.
MARKERS = {
    "background_check": ("Command running in background with ID", "was moved to the background"),
    "timeout": ("Command did not complete within its", "Command timed out after"),
    "edit_retry": ("String to replace not found", "has been modified since", "has not been read yet"),
}
NOTICE_TOOLS = ("Bash",)
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

# Claude Code starts a failed Bash result with an 'Exit code N' line.
_EXIT = re.compile(r"\s*exit code[:\s]+(-?\d+)", re.I)
_EXIT_LINE = re.compile(r"\s*exit code[:\s]+-?\d+[^\n]*\n", re.I)
_BACKGROUND_ID = re.compile(r"(?:background with id[:\s]*|\(id:\s*)([A-Za-z0-9_-]+)", re.I)
_ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
_GIT_COMMIT = re.compile(r"\bgit\b[^\n;&|]*\bcommit\b")
_FIX_ROLE = re.compile(r"^(fix|re-review) \d+$")
# Words that lead into a command (stripped), and simple commands that run no
# program of their own (skipped), when program_of looks for the program.
_LEAD_WORDS = ("if", "then", "else", "elif", "do", "while", "until", "!", "{", "time")
_NOT_PROGRAMS = ("cd", "pushd", "popd", "for", "case", "select", "function", "fi", "done", "esac", "}",
                 "export", "set", "unset", "shopt", "trap", "umask", "ulimit", "local", "declare", "readonly")


def _marker(kind, text):
    """The first of MARKERS[kind] that text holds (any case), or None."""
    low = (text or "").lower()
    return next((m for m in MARKERS[kind] if m.lower() in low), None)


def _notice_line(call):
    """The first line of a Bash call's result, after a leading 'Exit code N'
    line; '' for any other tool, or a call without a result."""
    if call["name"] not in NOTICE_TOOLS or call["end"] is None:
        return ""
    text = call["text"] or ""
    m = _EXIT_LINE.match(text)
    if m:
        text = text[m.end():]
    return text.lstrip().split("\n", 1)[0]


def notice(kind, call):
    """The MARKERS[kind] string of Claude Code's timeout or background notice
    on the first line of a Bash call's result, or None."""
    line = _notice_line(call).lower()
    if kind == "timeout":
        return next((m for m in MARKERS[kind] if line.startswith(m.lower())), None)
    if not line.startswith("command "):
        return None
    return next((m for m in MARKERS[kind] if m.lower() in line), None)


def exit_code(text):
    """The exit code a tool result reports on its leading 'Exit code N'
    line, or None."""
    m = _EXIT.match(text or "")
    return int(m.group(1)) if m else None


def program_of(command):
    """The program a Bash command runs: in the first simple command that runs
    one (not 'cd DIR', 'export ...', a loop header or a closing keyword;
    leading keywords such as 'if' or 'do' are skipped), its first word that
    is not a NAME=value assignment or a prefix such as env, nohup or
    'timeout DURATION', reduced to its basename. None when there is none,
    or when that word still holds '=', '@' or ':' (it may carry a secret or
    a URL)."""
    if not isinstance(command, str):
        return None
    for words in _segments(without_heredoc_bodies(command)):
        i = 0
        while i < len(words) and words[i] in _LEAD_WORDS:
            i += 1
        words = words[i:]
        if not words or words[0] in _NOT_PROGRAMS or words[0].startswith("-"):
            continue
        i = _skip_prefixes(words)
        if i >= len(words):
            continue
        name = _basename(words[i])
        if not name or any(c in name for c in "=@:"):
            return None
        return name
    return None


_HEREDOC_START = re.compile(r"(?<!<)<<(?!<)(-?)\s*(?:'([^'\n]*)'|\"([^\"\n]*)\"|\\?([^\s;&|<>()'\"]+))")


def heredocs(command):
    """Whether a command line holds a heredoc (<<WORD, not a <<< here-string)."""
    return isinstance(command, str) and _HEREDOC_START.search(command) is not None


def without_heredoc_bodies(command):
    """A command line without its heredoc bodies (the lines after a <<WORD
    up to the WORD line), so their text is never read as commands."""
    out = []
    pending = []  # (delimiter, tabs stripped) of the heredocs still open
    for line in command.split("\n"):
        if pending:
            delimiter, tabs = pending[0]
            body = line.rstrip("\r")
            if (body.lstrip("\t") if tabs else body) == delimiter:
                pending.pop(0)
            continue
        out.append(line)
        for m in _HEREDOC_START.finditer(line):
            word = next(g for g in m.groups()[1:] if g is not None)
            pending.append((word, m.group(1) == "-"))
    return "\n".join(out)


_REDIRECT_CHARS = "();<>|&\n"
_WRITE_REDIRECTS = (">", ">>", ">|", "&>", "&>>")


def _pipelines(command):
    """The pipelines of a command line (heredoc bodies left out) as shell
    tokens, redirect operators as their own tokens; None when its quoting
    does not parse."""
    try:
        tokens = _shell_tokens(without_heredoc_bodies(command), _REDIRECT_CHARS)
    except ValueError:
        return None
    out = [[]]
    for token in tokens:
        if token and all(c in _REDIRECT_CHARS for c in token) and not any(c in token for c in "<>") \
                and token not in ("|", "|&"):
            out.append([])
        else:
            out[-1].append(token)
    return [p for p in out if p]


def _writes(pipeline):
    """Whether a pipeline writes a file: a > or >> redirect to a file (not
    /dev/null or a descriptor), or tee as one of its programs."""
    for i, token in enumerate(pipeline):
        if token in _WRITE_REDIRECTS and i + 1 < len(pipeline):
            target = pipeline[i + 1]
            if target and target != "/dev/null" and not all(c in _REDIRECT_CHARS for c in target):
                return True
        if _basename(token) == "tee" and (i == 0 or pipeline[i - 1] in ("|", "|&")):
            return True
    return False


def heredoc_write(command):
    """Whether a command line feeds a heredoc into a file write in the same
    pipeline (cat > f <<EOF, tee f <<EOF), as opposed to an inline script
    such as python3 - <<EOF."""
    if not heredocs(command):
        return False
    pipelines = _pipelines(command)
    if pipelines is None:
        return False
    return any("<<" in p and _writes(p) for p in pipelines)


def file_write(command):
    """Whether a command line writes a file with a redirect or tee."""
    pipelines = _pipelines(command) if isinstance(command, str) else None
    return bool(pipelines) and any(_writes(p) for p in pipelines)


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
    """A write of a file with an Edit or Write tool that succeeded."""
    return (call["name"] in WRITE_TOOLS and call["end"] is not None and not call["is_error"]
            and _marker("edit_retry", call["text"]) is None)


def _bash_wrote(call):
    """A Bash call that succeeded and writes a file (a redirect or tee)."""
    return (call["name"] == "Bash" and call["end"] is not None and not _failed(call)
            and file_write(_command(call)))


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


def _event_text(event):
    """What a later event says, for finding an ID: a tool result's or an
    assistant turn's text, or a tool call's input."""
    if event["kind"] == "tool_use":
        return json.dumps(event["input"]) if event["input"] is not None else ""
    return event["text"] or ""


def _mention_after(agent, call):
    """When a backgrounded call's ID is first mentioned in a later event
    (a tool result, a tool call's input such as BashOutput's bash_id, or
    assistant text) or notice of the same agent; None when it never is."""
    m = _BACKGROUND_ID.search(_notice_line(call))
    if not m:
        return None
    pattern = re.compile(r"(?<![A-Za-z0-9_-])" + re.escape(m.group(1)) + r"(?![A-Za-z0-9_-])")
    times = [e["ts"] for e in agent["events"][call["result_i"] + 1:] if pattern.search(_event_text(e))]
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
        timeout = notice("timeout", c)
        if timeout:
            add("timeout", [i], c["start"], c["end"], "measured", c, timeout)
        marker = notice("background_check", c)
        if marker:
            # A call moved to the background at its timeout: the timeout
            # covers the call, the background wait starts at its result.
            start = c["end"] if timeout else c["start"]
            mention = _mention_after(agent, c)
            if mention is not None:
                add("background_check", [i], start, mention, "bound", c, marker)
            elif not timeout:
                add("background_check", [i], start, c["end"], "measured", c, marker)

    failures = {}
    for i, c in enumerate(calls):
        if _bash_failed(c):
            failures.setdefault(" ".join(_command(c).split()), []).append(i)
    for indexes in failures.values():
        if len(indexes) >= 2:
            first, last = calls[indexes[0]], calls[indexes[-1]]
            add("repeated_failure", indexes, first["start"], last["end"], "measured", first)

    # Only a heredoc that feeds a file write (cat > f <<EOF) counts; a
    # failing inline script (python3 - <<EOF) is not a quoting failure. The
    # span ends at the next file write that succeeds, by a tool or by Bash.
    until = None
    for i, c in enumerate(calls):
        if not _bash_failed(c) or not heredoc_write(_command(c)):
            continue
        if until is not None and c["start"] < until:
            continue  # a retry inside the previous heredoc failure's span
        write = next((w for w in calls[i + 1:] if _wrote(w) or _bash_wrote(w)), None)
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


_model = _transcripts.agent_model


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
        # Retries and escalations exactly as run-report counts them, per
        # launch (_transcripts.escalations).
        entries = [a["entry"] for a in launch["agents"]]
        for a, earlier in zip(launch["agents"], _transcripts.escalations(entries)):
            if a["entry"]["retried"]:
                out.append(_slowdown("retry", a, a["start"], a["end"], "measured"))
            if earlier is not None:
                out.append(_slowdown("escalation", a, a["start"], a["end"], "measured"))
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
RAN = "ran"
INFERRED = "inferred"


def _squash(text):
    return " ".join(text.split())


def configured_checks(manifest):
    """[(check_id, command, full_suite)]: the manifest's commands.test, lint
    and build entries, then each lane_commands override's. check_id is
    <group>#<n> for commands.<group>[n - 1] and <lane id>.<group>#<n> for
    lane_commands.<lane id>.<group>[n - 1]; a command string already seen
    keeps its first id and is not listed again. full_suite is True for a
    commands.test entry."""
    out = []
    seen = set()

    def add(commands, prefix, full_groups):
        if not isinstance(commands, dict):
            return
        for group in CHECK_GROUPS:
            entries = commands.get(group)
            for n, command in enumerate(entries if isinstance(entries, list) else [], 1):
                if isinstance(command, str) and _squash(command) and command not in seen:
                    seen.add(command)
                    out.append(("%s%s#%d" % (prefix, group, n), command, group in full_groups))

    add(_manifest_commands(manifest), "", ("test",))
    lanes = manifest.get("lane_commands")
    for lane, commands in lanes.items() if isinstance(lanes, dict) else []:
        add(commands, "%s." % lane, ())
    return out


def _manifest_commands(manifest):
    commands = manifest.get("commands")
    return commands if isinstance(commands, dict) else {}


_SEPARATORS = ";&|()\n"
_SEGMENT_SPLIT = re.compile(r"[;&|()\n]+")
_INTERPRETER = re.compile(r"^(python[0-9.]*|py|bash|sh)(\.exe)?$", re.I)
_PREFIX_WORDS = ("env", "exec", "time", "nohup", "command")
_ARG_FLAGS = ("-X", "-W")
# timeout's options that take a value (timeout -k 5 600 cmd).
_TIMEOUT_ARG_FLAGS = ("-k", "-s", "--kill-after", "--signal")


def _shell_tokens(command, punctuation):
    """Shell words of a command line, with runs of the punctuation
    characters as their own tokens. A '#' starts a comment only at the start
    of a word (as in the shell), up to the next newline; a '#' inside a word
    (http://x/#a) is kept. Raises ValueError when the quoting does not
    parse."""
    lexer = shlex.shlex(command, posix=True, punctuation_chars=punctuation)
    lexer.whitespace = " \t\r"
    lexer.whitespace_split = True
    lexer.commenters = ""
    tokens = []
    comment = False
    for token in lexer:
        is_punctuation = bool(token) and all(c in punctuation for c in token)
        if comment:
            if is_punctuation and "\n" in token:
                comment = False
                tokens.append(token)
            continue
        if token.startswith("#"):
            comment = True
            continue
        tokens.append(token)
    return tokens


def _is_operator(token):
    return bool(token) and all(c in _SEPARATORS for c in token)


def _merge_redirections(tokens):
    """_shell_tokens(..., _SEPARATORS) with the & of each redirection joined
    back into one word (2>&1, >&2, >&-, &>f, and &> or &>> standing alone)
    and |& read as |. A & token left standing is the background operator."""
    out = []
    i = 0
    while i < len(tokens):
        token = tokens[i]
        nxt = tokens[i + 1] if i + 1 < len(tokens) else None
        if token == "&" and out and out[-1][-1:] in ("<", ">"):
            word = out.pop() + "&"
            if nxt is not None and not _is_operator(nxt):
                word += nxt
                i += 1
            out.append(word)
        elif token == "&" and nxt is not None and nxt.startswith(">"):
            out.append("&" + nxt)
            i += 1
        else:
            out.append("|" if token == "|&" else token)
        i += 1
    return out


def _segments(command):
    """The simple commands of a line as word lists: shell words split at
    ; & | ( ) and newlines (a & inside a redirection such as 2>&1 is no
    separator), or, when the quoting does not parse, plain whitespace words
    of each piece between those characters."""
    try:
        tokens = _merge_redirections(_shell_tokens(command, _SEPARATORS))
    except ValueError:
        return _plain_segments(command)
    out = [[]]
    for token in tokens:
        if _is_operator(token):
            out.append([])
        else:
            out[-1].append(token)
    return [s for s in out if s]


def _plain_segments(command):
    out = []
    for piece in _SEGMENT_SPLIT.split(command):
        words = [w.strip("'\"") for w in piece.split()]
        if words:
            out.append(words)
    return out


def _skip_prefixes(words):
    """The index of a simple command's program word: past NAME=value
    assignments, prefix words (env, exec, time, nohup, command) and
    'timeout [OPTION]... DURATION'."""
    i = 0
    while i < len(words):
        if words[i] in _PREFIX_WORDS or _ASSIGNMENT.match(words[i]):
            i += 1
        elif words[i] == "timeout":
            i += 1
            while i < len(words) and words[i].startswith("-"):
                i += 2 if words[i] in _TIMEOUT_ARG_FLAGS else 1
            i += 1
        else:
            break
    return i


def _run_checks_args(words):
    """The words after run-checks when a simple command runs it (as the
    program, or as the script of an interpreter such as python or bash),
    else None. An interpreter given -c or -m runs inline code, not a
    script."""
    i = _skip_prefixes(words)
    if i >= len(words):
        return None
    if _basename(words[i]) == RUN_CHECKS:
        return words[i + 1:]
    if not _INTERPRETER.match(_basename(words[i])):
        return None
    i += 1
    while i < len(words) and words[i].startswith("-"):
        if _INLINE_FLAG.match(words[i]):
            return None
        i += 2 if words[i] in _ARG_FLAGS else 1
    if i < len(words) and _basename(words[i]) == RUN_CHECKS:
        return words[i + 1:]
    return None


# A backslash before a path character (a Windows path separator); shlex
# would drop it.
_WINDOWS_SEPARATOR = re.compile(r"\\(?=[A-Za-z0-9_.-])")
_CONTINUATION = re.compile(r"\\\r?\n")
# A redirection word: 2>, >>, <, >|, 2>&1, &>f ...
_REDIRECTION = re.compile(r"^(\d*|&)(>>?|<|>\|)")
# The operators a run of separator characters holds.
_OPERATOR = re.compile(r"&&|\|\||\|&|;;&?|;&|[;&|()\n]")
_INLINE_FLAG = re.compile(r"^-[A-Za-z]*[cm]")
# Operators after which a simple command runs whatever came before it, and
# the only operators of a line read as one && list of pipelines.
_UNCONDITIONAL = (";", "\n", "|", "&")
_CHAIN = ("&&", "|")
# Words before which a simple command may not run (if, loops, case, a
# function body).
_CONDITIONAL_WORDS = ("if", "elif", "else", "then", "while", "until", "for", "case", "do", "function")


def _simple_commands(command):
    """The simple commands of a command line as (operators, lead, words),
    and every operator of the line. operators are those right before the
    simple command; lead holds the leading _LEAD_WORDS stripped from it;
    words are the rest, without redirections and with _skip_prefixes and
    npx skipped. Heredoc bodies are left out, a backslash before a path
    character is read as '/', so Windows paths survive, and as in the shell
    a backslash-newline joins lines and a newline after &&, || or | is no
    separator. Raises ValueError when the quoting does not parse."""
    line = _CONTINUATION.sub("", without_heredoc_bodies(command))
    line = _WINDOWS_SEPARATOR.sub("/", line).strip()
    simple = []
    every = []
    ops = []
    words = []
    for token in _merge_redirections(_shell_tokens(line, _SEPARATORS)) + [";"]:
        if not _is_operator(token):
            words.append(token)
            continue
        if words:
            simple.append((ops,) + _reduce(words))
            ops = []
            words = []
        for op in _OPERATOR.findall(token):
            if op == "\n" and ops and ops[-1] in ("&&", "||", "|"):
                continue
            op = "|" if op == "|&" else op
            ops.append(op)
            every.append(op)
    return simple, every[:-1]


def _reduce(words):
    """(lead, words) of a simple command's words: see _simple_commands."""
    kept = []
    i = 0
    while i < len(words):
        m = _REDIRECTION.match(words[i])
        if m is None:
            kept.append(words[i])
        elif all(c in "<>-" for c in words[i][m.end():]):
            i += 1  # the operator stands alone: its target is the next word
        i += 1
    i = 0
    while i < len(kept) and kept[i] in _LEAD_WORDS:
        i += 1
    lead, rest = kept[:i], kept[i:]
    while rest:
        i = _skip_prefixes(rest)
        if i < len(rest) and rest[i] == "npx":
            i += 1
        if i == 0:
            break
        rest = rest[i:]
    return lead, rest


def _certainties(simple, every, exit_code):
    """RAN or INFERRED for each simple command of a line (see match_check)."""
    chain = exit_code == 0 and all(op in _CHAIN for op in every)
    out = []
    unconditional = True
    conditional_before = False
    for ops, lead, words in simple:
        unconditional = unconditional and all(op in _UNCONDITIONAL for op in ops)
        conditional = conditional_before or any(w in _CONDITIONAL_WORDS for w in lead)
        out.append(RAN if not conditional and (unconditional or chain) else INFERRED)
        conditional_before = conditional or (bool(words) and words[0] in _CONDITIONAL_WORDS)
    return out


def _surest(certainties):
    """RAN when any is RAN, INFERRED when there are only others, else None."""
    if RAN in certainties:
        return RAN
    return INFERRED if certainties else None


def _check_words(command):
    """The words of each simple command of a configured command, reduced as
    a command line's are; None when there are none or its quoting does not
    parse."""
    try:
        simple, _every = _simple_commands(command)
    except ValueError:
        return None
    parts = [words for _ops, _lead, words in simple]
    return parts if parts and all(parts) else None


def match_check(command, checks, exit_code=None):
    """{check, certainty, full_suite} when a Bash command line runs a check
    of checks (configured_checks), else None. exit_code is the call's exit
    code (0 for a successful call without an 'Exit code N' line), or None
    when unknown.

    The line is read as shell words (heredoc bodies left out, a backslash
    before a path character read as '/') split into simple commands at
    ; & | && || ( ) and newlines; a & inside a redirection (2>&1, >&2, &>f)
    is no separator. A line whose quoting does not parse runs nothing.

    A line with a simple command that runs run-checks (as the program, or as
    an interpreter's script, after prefixes such as env or timeout DURATION;
    not an interpreter given -c or -m) is a run-checks call: check
    'run-checks', and full_suite is the certainty of the run-checks command
    passing '--cmd test', or None.

    Otherwise a configured command matches a simple command whose words
    start with its words (both without redirections, leading keywords,
    NAME=value assignments and prefixes such as env, timeout DURATION or
    npx), exactly when no words follow; a configured command of several
    simple commands matches them in a row. The match with the most words
    names the execution (the first in checks' order on a tie). full_suite
    is RAN when a simple command that exactly matches a full-suite entry is
    certain, INFERRED when only uncertain ones do, else None.

    A matched simple command is certain (RAN) when no if, elif, else, then,
    while, until, for, case, do or function comes before it or is stripped
    from it, and either every operator before it is ;, a newline, | or a
    background &, or the whole line is pipelines joined only by && and
    exit_code is 0 (an && list exits 0 only when every part ran).
    Otherwise it is INFERRED: it may not have run."""
    if not isinstance(command, str):
        return None
    try:
        simple, every = _simple_commands(command)
    except ValueError:
        return None
    certainty = _certainties(simple, every, exit_code)
    runs = [(i, args) for i, args in enumerate(_run_checks_args(words) for _ops, _lead, words in simple)
            if args is not None]
    if runs:
        tests = [certainty[i] for i, args in runs
                 if any(w == "--cmd" and args[j + 1:j + 2] == ["test"] for j, w in enumerate(args))]
        return {"check": RUN_CHECKS, "certainty": _surest([certainty[i] for i, _args in runs]),
                "full_suite": _surest(tests)}
    best = None  # (word count, check_id, certainties)
    full = []
    for check_id, configured, is_full in checks:
        parts = _check_words(configured)
        if parts is None:
            continue
        size = sum(len(p) for p in parts)
        for k in range(len(simple) - len(parts) + 1):
            here = [words for _ops, _lead, words in simple[k:k + len(parts)]]
            last = len(parts) - 1
            if here[:last] != parts[:last] or here[last][:len(parts[last])] != parts[last]:
                continue
            sure = RAN if all(c == RAN for c in certainty[k:k + len(parts)]) else INFERRED
            if best is None or size > best[0]:
                best = (size, check_id, [sure])
            elif best[1] == check_id:
                best[2].append(sure)
            if is_full and here[last] == parts[last]:
                full.append(sure)
    if best is None:
        return None
    return {"check": best[1], "certainty": _surest(best[2]), "full_suite": _surest(full)}


def _call_exit(call):
    """A call's exit code for match_check: its 'Exit code N' line, 0 for a
    successful result without one, None for a failed call without one or
    no result."""
    code = exit_code(call["text"])
    if code is None and call["end"] is not None and not call["is_error"]:
        return 0
    return code


def _execution_end(agent, call):
    """(background, end, timing) of a check call. A backgrounded call ends
    at the first later event naming its ID; a call with no such event, or
    without a result, is bound by the agent's last event."""
    background = call["input"].get("run_in_background") is True \
        or notice("background_check", call) is not None
    if call["end"] is None:
        return background, agent["end"], "bound"
    if background:
        mention = _mention_after(agent, call)
        if mention is None:
            return background, agent["end"], "bound"
        return background, mention, "measured"
    return background, call["end"], "measured"


def checks_section(run):
    """Every Bash call that runs a configured check or run-checks, named by
    check id and marked ran or inferred, with its timing; per-check totals;
    full-suite runs per role. Without any tool event in the run the section
    cannot be derived and is unavailable."""
    if not _has_tool_events(run):
        return {"executions": UNAVAILABLE, "by_check": UNAVAILABLE,
                "full_suite_runs": {"total": UNAVAILABLE, "inferred": UNAVAILABLE, "by_role": UNAVAILABLE}}
    checks = configured_checks(run["manifest"])
    on_path = set(id(a) for a in critical_agents(run))
    found = []
    for order, a in enumerate(_all_agents(run)):
        e = a["entry"]
        for call in _calls(a):
            match = match_check(_command(call), checks, _call_exit(call)) if call["name"] == "Bash" else None
            if match is None:
                continue
            background, end, timing = _execution_end(a, call)
            found.append(((call["start"], order), {
                "agent": e["label"], "phase": _phase_name(e), "role": e["role"], "check": match["check"],
                "certainty": match["certainty"], "full_suite": match["full_suite"],
                "start": iso(call["start"]), "end": iso(end), "s": seconds(end - call["start"]),
                "timing": timing, "background": background, "on_critical_path": id(a) in on_path,
            }))
    found.sort(key=lambda f: f[0])
    executions = [x for _key, x in found]
    by_check = {}
    for x in executions:
        totals = by_check.setdefault(x["check"], {"runs": 0, "inferred": 0, "total_s": 0.0})
        if x["certainty"] != RAN:
            totals["inferred"] += 1
            continue
        totals["runs"] += 1
        if _is_num(x["s"]):
            totals["total_s"] += x["s"]
    for totals in by_check.values():
        totals["total_s"] = seconds(totals["total_s"])
    by_role = {}
    for x in executions:
        if x["full_suite"] == RAN:
            by_role[x["role"]] = by_role.get(x["role"], 0) + 1
    return {"executions": executions, "by_check": by_check,
            "full_suite_runs": {"total": sum(by_role.values()),
                                "inferred": sum(1 for x in executions if x["full_suite"] == INFERRED),
                                "by_role": by_role}}


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


def stake(slowdowns):
    """The time a group of slowdowns stands for: per agent (and once for
    the run-wide ones), the length of the union of the spans the slowdowns
    with a known cost cover, summed. Slowdowns that overlap in time (three
    parallel Edits failing together) count their shared time once. None
    when no cost is known."""
    known = [s for s in slowdowns if s["_cost"] is not None]
    if not known:
        return None
    spans = {}
    for s in known:
        for owner, start, end in s["_covers"]:
            spans.setdefault(None if owner is None else id(owner), []).append((start, end))
    return sum(union_length(v) for v in spans.values())


def suggestions_section(slowdowns, unclean):
    """One suggestion per kind with a slowdown, ranked by stake_s (stake():
    the union of its slowdowns' known spans per agent; unavailable when no
    cost is known)."""
    out = []
    for kind in KINDS:
        indexes = [i for i, s in enumerate(slowdowns) if s["kind"] == kind]
        if not indexes:
            continue
        at_stake = stake([slowdowns[i] for i in indexes])
        out.append({"kind": kind, "text": SUGGESTIONS[kind],
                    "stake_s": UNAVAILABLE if at_stake is None else seconds(at_stake),
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
        times = sorted(set([a["start"]] + [e["ts"] for e in a["events"]]))
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


# ---- autopsy.md and the chat summary ----

BAR_COLUMNS = 40
SUMMARY_MAX_LINES = 15
_NON_PRINTABLE = re.compile(r"[^\x20-\x7e]")


def _ascii(value):
    """Plain ASCII on one line: anything else becomes '?'."""
    return _NON_PRINTABLE.sub("?", str(value))


def _cell(value):
    return _ascii(value).replace("|", "/")


def _is_num(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _secs(value):
    return "%.1f s" % value if _is_num(value) else UNAVAILABLE


def _tokens(value):
    return "%d" % value if _is_num(value) else UNAVAILABLE


def _when(value):
    """2026-10-10T07:00:05.000Z as 2026-10-10 07:00:05Z."""
    if parse_ts(value) is None:
        return UNAVAILABLE
    return value.replace("T", " ")[:19] + "Z"


def _hms(value):
    total = int(round(value))
    return "%dm%02ds" % (total // 60, total % 60)


def _wall(value):
    return "%s (%s)" % (_secs(value), _hms(value)) if _is_num(value) else UNAVAILABLE


def _count_word(n, word):
    return "%d %s" % (n, word if n == 1 else word + ("es" if word.endswith("ch") else "s"))


def _table(headers, rows):
    lines = ["| " + " | ".join(headers) + " |", "|" + "|".join(" --- " for _h in headers) + "|"]
    for row in rows:
        lines.append("| " + " | ".join(_cell(c) for c in row) + " |")
    return lines


def _launch_names(analysis):
    launches = analysis.get("launches")
    return launches if isinstance(launches, list) else []


def _slowest_phase(analysis):
    phases = analysis["time"]["phases"]
    timed = [p for p in phases if _is_num(p.get("wall_s"))]
    if not timed:
        return None
    best = timed[0]
    for p in timed[1:]:
        if p["wall_s"] > best["wall_s"]:
            best = p
    return best


def _slowdown_cost(s):
    cost = _secs(s["cost_s"])
    if _is_num(s["cost_s"]) and s["cost_kind"] == "bound":
        cost += " (upper bound)"
    return cost


def _evidence_text(evidence):
    parts = []
    if evidence.get("tool"):
        parts.append("tool %s" % evidence["tool"])
    if evidence.get("exit") is not None:
        parts.append("exit %s" % evidence["exit"])
    if evidence.get("marker"):
        parts.append("marker '%s'" % evidence["marker"])
    if evidence.get("program"):
        parts.append("program %s" % evidence["program"])
    return ", ".join(parts) if parts else "-"


def _md_summary(a):
    launches = _launch_names(a)
    detail = ", ".join("%s %s" % (l["wf"], l["status"]) for l in launches) or "none"
    acceptance = a["done"]["acceptance"]
    lines = [
        "- Run: %s (engine %s)" % (a["run_id"], a["engine_version"]),
        "- Wall time: %s over %s: %s" % (_wall(a["time"]["wall_s"]), _count_word(len(launches), "launch"), detail),
        "- Acceptance: %s" % (acceptance["status"] if isinstance(acceptance, dict) else UNAVAILABLE),
    ]
    slowest = _slowest_phase(a)
    if slowest is not None:
        lines.append("- Slowest phase: %s (%s)" % (slowest["phase"], _secs(slowest["wall_s"])))
    top = a["slowdowns"][0] if a["slowdowns"] else None
    lines.append("- Slowdowns: %d found%s" % (len(a["slowdowns"]),
                 "" if top is None else "; the largest is %s (%s)" % (top["kind"], _secs(top["cost_s"]))))
    lines.append("- All values are in autopsy.json beside this file. Times are UTC; "
                 "a value that cannot be derived says unavailable.")
    return lines


def _md_done(a):
    done = a["done"]
    lines = []
    tasks = done["tasks"]
    if isinstance(tasks, dict):
        for tid, t in tasks.items():
            commits = t["commits"]
            lines.append("- %s: %s; %s; %s; tier %s" % (
                tid, t["status"],
                "commits unavailable" if commits == UNAVAILABLE else _count_word(len(commits), "commit"),
                "rounds " + str(t["rounds"]), t["tier_used"]))
        if not tasks:
            lines.append("- No tasks listed.")
    else:
        lines.append("- Tasks: unavailable (the run's result file is missing or unreadable).")
    acc = done["acceptance"]
    if isinstance(acc, dict):
        reasons = acc["reasons"]
        why = "" if not isinstance(reasons, list) or not reasons else \
            " (" + ", ".join("%s: %s" % (r["kind"], r["class"]) for r in reasons) + ")"
        lines.append("- Acceptance: %s%s; warnings %s" % (acc["status"], why, acc["warnings"]))
    else:
        lines.append("- Acceptance: unavailable")
    fin = done["final"]
    if isinstance(fin, dict):
        lines.append("- Final review: %s fixed, %s declined, %s open" % (fin["fixed"], fin["declined"], fin["open"]))
    else:
        lines.append("- Final review: unavailable")
    lines.append("- End-to-end checks: %s" % done["e2e"])
    return lines


def _bar(start, end, axis_start, axis_end):
    """A BAR_COLUMNS-wide row of '.' with '#' over [start, end]."""
    span = axis_end - axis_start
    if span <= 0:
        return "#" * BAR_COLUMNS
    first = int((start - axis_start) / span * BAR_COLUMNS)
    last = int(math.ceil((end - axis_start) / span * BAR_COLUMNS))
    first = max(0, min(BAR_COLUMNS - 1, first))
    last = max(first + 1, min(BAR_COLUMNS, last))
    return "." * first + "#" * (last - first) + "." * (BAR_COLUMNS - last)


def _timeline(a):
    """Code-fenced text: per launch, a header and one bar row per lane."""
    lanes = a["time"]["lanes"]
    launches = [l for l in _launch_names(a) if any(x["launch"] == l["wf"] for x in lanes)]
    if not launches:
        return []
    width = max(len("lane " + x["lane"]) for x in lanes)
    wf_width = max(len(l["wf"]) for l in launches)
    out = ["```"]
    for launch in launches:
        rows = [x for x in lanes if x["launch"] == launch["wf"]]
        spans = [(parse_ts(x["start"]), parse_ts(x["end"])) for x in rows]
        known = [s for s in spans if s[0] is not None and s[1] is not None]
        axis_start, axis_end = parse_ts(launch["start"]), parse_ts(launch["end"])
        if (axis_start is None or axis_end is None) and known:
            axis_start, axis_end = min(s[0] for s in known), max(s[1] for s in known)
        if axis_start is None or axis_end is None:
            out.append("%s: time unavailable" % launch["wf"])
            continue
        out.append("%s: %s to %s" % (launch["wf"], _when(iso(axis_start)), _when(iso(axis_end))))
        for x, (start, end) in zip(rows, spans):
            label = "%-*s  %-*s " % (width, _ascii("lane " + x["lane"]), wf_width, launch["wf"])
            if start is None or end is None:
                out.append(label + "(time unavailable)")
                continue
            # Only the bar is clamped to the axis; the span is the lane's own.
            bar_start, bar_end = max(start, axis_start), min(max(end, start), axis_end)
            out.append("%s|%s|  span %s, busy %s" % (label, _bar(bar_start, bar_end, axis_start, axis_end),
                                                    _secs(seconds(max(end, start) - start)),
                                                    _secs(x["busy_s"])))
    out.append("```")
    return out


def _md_time(a):
    t = a["time"]
    lines = ["Wall time: %s." % _wall(t["wall_s"]), ""]
    if t["phases"]:
        lines += _table(["Phase", "Launch", "Start", "End", "Wall", "Agents"],
                        [[p["phase"], p["launch"], _when(p["start"]), _when(p["end"]), _secs(p["wall_s"]),
                          p["agents"]] for p in t["phases"]])
    else:
        lines.append("No phases found.")
    timeline = _timeline(a)
    if timeline:
        lines += ["", "Timeline: one row per lane, each launch on its own axis of %d columns; "
                  "# marks the lane's span." % BAR_COLUMNS, ""] + timeline
    labels = t["critical_path"]["labels"]
    lines += ["", "Critical path (an estimate from agent timings, not a measurement): %s" %
              (_ascii(" -> ".join(labels)) if labels else UNAVAILABLE)]
    gaps = t["idle_gaps"]
    if gaps:
        lines += ["", "Idle gaps (no agent running): %d, %s in all." % (len(gaps), _secs(sum(g["s"] for g in gaps)))]
        lines += ["- %s to %s: %s" % (_when(g["start"]), _when(g["end"]), _secs(g["s"])) for g in gaps[:5]]
    return lines


def _md_checks(a):
    checks = a["checks"]
    if checks["executions"] == UNAVAILABLE:
        return ["Check executions: unavailable (the run has no timed tool events)."]
    executions = checks["executions"]
    lines = ["%s; %d on the critical path; %d in the background." % (
        _count_word(len(executions), "execution"), sum(1 for x in executions if x["on_critical_path"]),
        sum(1 for x in executions if x["background"]))]
    if executions:
        lines += [""] + _table(["Check", "Runs", "Inferred", "Total"],
                               [[c, v["runs"], v["inferred"], _secs(v["total_s"])]
                                for c, v in checks["by_check"].items()])
        lines += ["", "Check ids name manifest commands: test#1 is commands.test[0], "
                      "<lane>.test#1 is lane_commands.<lane>.test[0]."]
    full = checks["full_suite_runs"]
    inferred = full.get("inferred")
    lines += ["", "Full-suite runs: %s%s" % (full["total"], " (+%d inferred)" % inferred
                                             if _is_num(inferred) and inferred else "")]
    if isinstance(full["by_role"], dict):
        lines += ["- %s: %d" % (_ascii(r), n) for r, n in full["by_role"].items()]
    return lines


def _md_slowdowns(a):
    if not a["slowdowns"]:
        lines = ["No slowdowns found."]
    else:
        lines = _table(["#", "Kind", "Agent", "At", "Cost", "Evidence"],
                       [[i, s["kind"], s["agent"] or "(run-wide)", _when(s["at"]), _slowdown_cost(s),
                         _evidence_text(s["evidence"])] for i, s in enumerate(a["slowdowns"], 1)])
    missing = [k for k, v in a["detectors"].items() if v != "ok"]
    if missing:
        lines += ["", "Detectors without data (they add no slowdowns): %s." % ", ".join(missing)]
    return lines


def _md_tokens(a):
    t = a["tokens"]
    tot = t["totals"]
    lines = []
    if t["partial"]:
        lines.append("These totals are minimums: some agents have no usage data, incomplete output counts "
                     "or unreadable lines, so the real totals are higher.")
        lines.append("")
    output = _tokens(tot["output_tokens"]) if _is_num(tot["output_tokens"]) else \
        ">= %s" % _tokens(tot["output_tokens_min"])
    lines.append("Totals over %s: input %s, output %s, cache read %s, cache creation %s." % (
        _count_word(tot["agents"], "agent"), _tokens(tot["input_tokens"]), output,
        _tokens(tot["cache_read_input_tokens"]), _tokens(tot["cache_creation_input_tokens"])))
    if t["unreadable_lines"] > 0:
        lines.append("Damaged transcript lines were skipped; unreadable lines: %d." % t["unreadable_lines"])
    if t["by_role"]:
        def out_of(b):
            return _tokens(b["output_tokens"]) if _is_num(b["output_tokens"]) else \
                ">= %s" % _tokens(b["output_tokens_min"])
        lines += ["", "By role:", ""] + _table(
            ["Role", "Agents", "Input", "Output", "Cache read", "Cache creation"],
            [[r, b["agents"], _tokens(b["input_tokens"]), out_of(b), _tokens(b["cache_read_input_tokens"]),
              _tokens(b["cache_creation_input_tokens"])] for r, b in t["by_role"].items()])
    if t["top_agents"]:
        lines += ["", "Largest agents:", ""] + _table(
            ["Agent", "Phase", "Tokens"], [[x["label"], x["phase"], x["tokens"]] for x in t["top_agents"]])
    return lines


def _md_suggestions(a):
    if not a["suggestions"]:
        return ["None."]
    lines = []
    for i, g in enumerate(a["suggestions"], 1):
        rows = g["slowdowns"] if isinstance(g.get("slowdowns"), list) else []
        where = "; slowdown %s %s" % ("row" if len(rows) == 1 else "rows",
                                      ", ".join("#%d" % (r + 1) for r in rows)) if rows else ""
        lines.append("%d. %s (stake %s, %s%s): %s" % (i, g["kind"], _secs(g["stake_s"]),
                                                      _count_word(g["count"], "time"), where, g["text"]))
    return lines


def _md_open(a):
    gaps = a["unexplained"]
    if not gaps:
        return ["None."]
    return ["- %s to %s, %s of %s: no slowdown above explains this time." % (
        _when(g["start"]), _when(g["end"]), _secs(g["s"]), g["agent"]) for g in gaps]


def render_markdown(analysis):
    """autopsy.md: the sections in a fixed order, plain ASCII."""
    a = analysis
    parts = [
        ["# Autopsy: %s" % a["run_id"]],
        ["## Summary", ""] + _md_summary(a),
        ["## What got done", ""] + _md_done(a),
        ["## Where time went", ""] + _md_time(a),
        ["## Checks", ""] + _md_checks(a),
        ["## Slowdowns", ""] + _md_slowdowns(a),
        ["## Tokens", ""] + _md_tokens(a),
        ["## Suggestions", ""] + _md_suggestions(a),
        ["## Open questions", ""] + _md_open(a),
    ]
    text = "\n\n".join("\n".join(p) for p in parts) + "\n"
    return "\n".join(_ascii(line) for line in text.split("\n"))


def render_summary(analysis, md_path):
    """The chat summary: at most SUMMARY_MAX_LINES lines."""
    a = analysis
    lines = ["autopsy %s: wall %s over %s" % (a["run_id"], _wall(a["time"]["wall_s"]),
                                              _count_word(len(_launch_names(a)), "launch"))]
    slowest = _slowest_phase(a)
    lines.append("slowest phase: %s" % ("unavailable" if slowest is None else
                                        "%s (%s)" % (slowest["phase"], _secs(slowest["wall_s"]))))
    slowdowns = a["slowdowns"]
    if slowdowns:
        lines.append("slowdowns (%d found), top %d:" % (len(slowdowns), min(3, len(slowdowns))))
        for s in slowdowns[:3]:
            where = s["agent"] if s["agent"] else "run-wide"
            lines.append("  %s (%s): %s" % (s["kind"], where, _slowdown_cost(s)))
    else:
        lines.append("slowdowns: none found")
    full = a["checks"]["full_suite_runs"]
    by_role = full["by_role"]
    lines.append("full-suite runs: %s%s" % (full["total"], " (%s)" % ", ".join(
        "%s %d" % (r, n) for r, n in by_role.items()) if isinstance(by_role, dict) and by_role else ""))
    tot = a["tokens"]["totals"]
    if a["tokens"]["partial"]:
        lines.append("tokens (minimums: some usage is missing or unreadable): >= %s input, >= %s output, "
                     ">= %s cache read, >= %s cache creation" % (
                         _tokens(tot["input_tokens"]), _tokens(tot["output_tokens_min"]),
                         _tokens(tot["cache_read_input_tokens"]), _tokens(tot["cache_creation_input_tokens"])))
    else:
        lines.append("tokens: %s input, %s output, %s cache read, %s cache creation" % (
            _tokens(tot["input_tokens"]), _tokens(tot["output_tokens"]),
            _tokens(tot["cache_read_input_tokens"]), _tokens(tot["cache_creation_input_tokens"])))
    top = a["suggestions"][0] if a["suggestions"] else None
    lines.append("top suggestion: %s" % ("none" if top is None else "%s: %s" % (top["kind"], top["text"])))
    lines = [_ascii(line) for line in lines[:SUMMARY_MAX_LINES - 1]]
    lines.append("full report: %s" % md_path)
    return "\n".join(lines) + "\n"
