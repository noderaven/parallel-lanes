"""Transcript parsing shared by run-report and the other run tools.

Import with:
    sys.dont_write_bytecode = True
    sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
    import _transcripts

build_report(transcript_dir, manifest) returns the run-report dict (see the
docstring of run-report for its fields); read_usage and the label and result
helpers are the pieces it is made of. Anything that cannot be read or derived
is UNAVAILABLE, never a guess.
"""
import glob
import json
import os
import re
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import _shell  # noqa: E402

UNAVAILABLE = "unavailable"
TOKEN_FIELDS = ("input_tokens", "output_tokens",
                "cache_read_input_tokens", "cache_creation_input_tokens")


def read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def manifest_task_ids(manifest):
    ids = []
    for t in manifest.get("prelude") or []:
        ids.append(t.get("id"))
    for lane in manifest.get("lanes") or []:
        for t in lane.get("tasks") or []:
            ids.append(t.get("id"))
    for t in manifest.get("join") or []:
        ids.append(t.get("id"))
    return {i for i in ids if isinstance(i, str)}


def workflow_result(transcript_dir):
    """The result object of the workflow result file (see
    _shell.result_paths); None when no readable result file is found."""
    for path in _shell.result_paths(transcript_dir):
        if os.path.isfile(path):
            result = read_json(path).get("result")
            return result if isinstance(result, dict) else None
    return None


def engine_version(result):
    """result.version, the skill version the workflow ran as; UNAVAILABLE
    when there is no result or no non-empty string version in it."""
    version = result.get("version") if isinstance(result, dict) else None
    return version if isinstance(version, str) and version else UNAVAILABLE


def agent_efforts(result):
    """{label: [effort, ...]} from the workflow result's
    result.agent_settings, in start order; {} without a result."""
    settings = result.get("agent_settings") if isinstance(result, dict) else None
    efforts = {}
    for s in settings if isinstance(settings, list) else []:
        if isinstance(s, dict) and isinstance(s.get("label"), str):
            effort = s.get("effort")
            efforts.setdefault(s["label"], []).append(effort if isinstance(effort, str) and effort else UNAVAILABLE)
    return efforts


def is_task_word(word, ids):
    if word in ids:
        return True
    for m in re.finditer("-", word):
        if word[:m.start()] in ids and word[m.end():] in ids:
            return True
    return False


def parse_label(label, ids):
    """Return (task, role, retried) for an agent label."""
    retried = False
    if label.endswith(" retry"):
        label = label[:-len(" retry")].rstrip()
        retried = True
    first, _, rest = label.partition(" ")
    if rest and is_task_word(first, ids):
        return first, rest, retried, label
    return None, label, retried, label


def model_tier(model):
    if isinstance(model, str):
        low = model.lower()
        for tier in ("opus", "sonnet", "haiku"):
            if tier in low:
                return tier
    return None


def read_usage(path):
    """Return (resolved_model, sums, models, complete, unreadable), or
    (None, None, {}, True, unreadable) when there are no usage lines.

    A transcript writes one assistant message over several lines that share
    its message.id, each repeating that message's usage (output_tokens as a
    running value). Each message counts once, with the last usage seen for
    its id (and requestId when present); lines without an id count each.
    complete is False when a counted line has stop_reason null (its
    output_tokens is a mid-stream value) or when unreadable is above 0.
    unreadable counts non-blank lines that are not valid JSON or not valid
    UTF-8; a line with invalid UTF-8 is still parsed best-effort after
    replacement, so invalid UTF-8 never raises.
    """
    model = None
    models = {}
    counted = set()
    usages = {}
    anonymous = []
    unreadable = 0
    try:
        # Bytes split on \n only, so a U+2028 inside a string stays in its line.
        with open(path, "rb") as f:
            for raw in f:
                try:
                    line = raw.decode("utf-8")
                except UnicodeDecodeError:
                    # Damaged bytes may have been a key or a count: the line is
                    # unreadable (the totals are partial), but what it still
                    # holds is read as far as it goes.
                    unreadable += 1
                    line = raw.decode("utf-8", errors="replace")
                    damaged = True
                else:
                    damaged = False
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except ValueError:
                    if not damaged:
                        unreadable += 1
                    continue
                msg = obj.get("message") if isinstance(obj, dict) else None
                if not isinstance(msg, dict):
                    continue
                usage = msg.get("usage")
                if not isinstance(usage, dict):
                    continue
                final = not ("stop_reason" in msg and msg["stop_reason"] is None)
                mid = msg.get("id")
                rid = obj.get("requestId")
                key = (mid, rid if isinstance(rid, str) else None) if isinstance(mid, str) and mid else None
                if isinstance(msg.get("model"), str):
                    model = msg["model"]
                    # Each message counts once per model, on the first line that names it.
                    if key is None or (key, model) not in counted:
                        models[model] = models.get(model, 0) + 1
                        if key is not None:
                            counted.add((key, model))
                if key is not None:
                    usages[key] = (usage, final)
                else:
                    anonymous.append((usage, final))
    except OSError:
        return None, None, {}, True, 0
    if not usages and not anonymous:
        return None, None, {}, True, unreadable
    sums = {k: 0 for k in TOKEN_FIELDS}
    complete = unreadable == 0
    for usage, final in list(usages.values()) + anonymous:
        complete = complete and final
        for k in TOKEN_FIELDS:
            v = usage.get(k)
            if isinstance(v, int) and not isinstance(v, bool):
                sums[k] += v
    return model, sums, models, complete, unreadable


def first_timestamp(path):
    """First timestamp field in a jsonl transcript, or None."""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                ts = obj.get("timestamp") if isinstance(obj, dict) else None
                if isinstance(ts, str) and ts:
                    return ts
    except OSError:
        pass
    return None


def start_key(meta_path):
    """Chronological sort key: first transcript timestamp, else meta mtime."""
    from datetime import datetime, timezone
    ts = first_timestamp(meta_path[:-len(".meta.json")] + ".jsonl")
    if ts:
        try:
            return (datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp(), meta_path)
        except ValueError:
            pass
    try:
        return (os.path.getmtime(meta_path), meta_path)
    except OSError:
        return (0.0, meta_path)


def blank_bucket():
    b = {k: 0 for k in TOKEN_FIELDS}
    b["output_tokens_min"] = 0
    b["agents"] = 0
    return b


def is_output_incomplete(entry):
    """An agent with usage whose output count is incomplete."""
    return entry["input_tokens"] != UNAVAILABLE and entry["output_tokens"] == UNAVAILABLE


def token_buckets(entries, key):
    """{key(entry): bucket} of agent entries (an entry whose key is None is
    left out), in first-seen order: blank_bucket's fields with agents counted
    and only known values summed. A bucket holding an output-incomplete
    agent has output_tokens UNAVAILABLE (output_tokens_min still sums)."""
    out = {}
    for e in entries:
        k = key(e)
        if k is None:
            continue
        b = out.setdefault(k, blank_bucket())
        b["agents"] += 1
        if e["input_tokens"] == UNAVAILABLE:
            continue
        for field in TOKEN_FIELDS + ("output_tokens_min",):
            if e[field] != UNAVAILABLE:
                b[field] += e[field]
    for e in entries:
        k = key(e)
        if k is not None and is_output_incomplete(e):
            out[k]["output_tokens"] = UNAVAILABLE
    return out


def agent_model(entry):
    """The model an agent ran: resolved, else requested (maybe UNAVAILABLE)."""
    return entry["resolved_model"] if entry["resolved_model"] != UNAVAILABLE else entry["requested_model"]


def escalations(entries):
    """[earlier tier or None] per agent entry of one launch, in order: an
    escalation is the same label (without ' retry') running again at
    another model tier than its latest run; it names that run's tier."""
    out = []
    last_model = {}  # stripped label -> (tier, model) of its latest run
    for a in entries:
        model = agent_model(a)
        prev = last_model.get(a["base_label"])
        escalated = prev is not None and model != UNAVAILABLE and prev[1] != UNAVAILABLE \
            and model_tier(model) != model_tier(prev[1])
        out.append(prev[0] if escalated else None)
        last_model[a["base_label"]] = (a["tier"], model)
    return out


def agent_entries(transcript_dir, manifest):
    """[(meta path, entry)] for every agent-*.meta.json of a transcript dir,
    in start_key order. entry is build_report's agent entry plus base_label
    (the label without ' retry') and retried; build_report drops those two."""
    ids = manifest_task_ids(manifest)
    efforts = agent_efforts(workflow_result(transcript_dir))
    metas = sorted(glob.glob(os.path.join(glob.escape(transcript_dir), "agent-*.meta.json")), key=start_key)
    agents = []
    for meta_path in metas:
        stem = meta_path[:-len(".meta.json")]
        meta = read_json(meta_path)
        label = next((meta[k] for k in ("description", "label")
                      if isinstance(meta.get(k), str)), "")
        phase = next((meta[k] for k in ("workflowPhase", "phase")
                      if isinstance(meta.get(k), str)), None)
        task, role, retried, base_label = parse_label(label, ids)
        requested = meta.get("model") if isinstance(meta.get("model"), str) else None
        resolved, sums, models, complete, unreadable = read_usage(stem + ".jsonl")
        tier = model_tier(resolved) or model_tier(requested) or UNAVAILABLE
        queue = efforts.get(label)
        effort = queue.pop(0) if queue else UNAVAILABLE
        entry = {
            "label": label,
            "phase": phase,
            "task": task,
            "role": role,
            "tier": tier,
            "requested_model": requested if requested else UNAVAILABLE,
            "resolved_model": resolved if resolved else UNAVAILABLE,
            "effort": effort,
        }
        entry["resolved_models"] = models
        entry["unreadable_lines"] = unreadable
        for k in TOKEN_FIELDS:
            entry[k] = sums[k] if sums is not None else UNAVAILABLE
        entry["output_tokens_min"] = sums["output_tokens"] if sums is not None else UNAVAILABLE
        if sums is not None and not complete:
            entry["output_tokens"] = UNAVAILABLE
        entry["base_label"] = base_label
        entry["retried"] = retried
        agents.append((meta_path, entry))
    return agents


def build_report(transcript_dir, manifest):
    result = workflow_result(transcript_dir)
    agents = [entry for _meta, entry in agent_entries(transcript_dir, manifest)]
    tiers = token_buckets(agents, lambda a: a["tier"])
    for bucket in tiers.values():
        bucket["escalations"] = 0
        bucket["fix_rounds"] = 0
    totals = token_buckets(agents, lambda a: "all").get("all", blank_bucket())
    unavailable = sum(1 for a in agents if a["input_tokens"] == UNAVAILABLE)
    output_incomplete = sum(1 for a in agents if is_output_incomplete(a))
    unreadable_lines = sum(a["unreadable_lines"] for a in agents)
    models = {}
    retries = sum(1 for a in agents if a["retried"])
    for a, earlier in zip(agents, escalations(agents)):
        for m in a["resolved_models"]:
            models[m] = models.get(m, 0) + 1
        if a["task"] is not None and re.match(r"^fix \d+$", a["role"]):
            tiers[a["tier"]]["fix_rounds"] += 1
        # An escalation counts under the earlier tier.
        if earlier is not None:
            tiers[earlier]["escalations"] += 1
    for a in agents:
        del a["base_label"]
        del a["retried"]
    return {
        "engine_version": engine_version(result),
        "agents": agents,
        "tiers": tiers,
        "totals": totals,
        "models": models,
        "unavailable": unavailable,
        "output_incomplete": output_incomplete,
        "unreadable_lines": unreadable_lines,
        "escalations": sum(b["escalations"] for b in tiers.values()),
        "fix_rounds": sum(b["fix_rounds"] for b in tiers.values()),
        "retries": retries,
    }
