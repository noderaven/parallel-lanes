"""The launches a run's ledger recorded (archive-run and the audit, spec 4.2).

Import with:
    sys.dont_write_bytecode = True
    sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
    import _launches

recorded_launches(ledger_dir) gives {"count": int, "named": [wf ids]}:
  named  the sorted distinct wf ids the ledger names: the 'wf' of every
         carried event in <ledger_dir>/_run.jsonl and the <id> of every
         doctor-<id>.json file in ledger_dir (1.6.3 and later);
  count  the larger of the number of run_ended events in _run.jsonl (one
         per launch the session recorded, relaunches included, never a dry
         run) and len(named) (a launch whose session died has no
         run_ended).
Setup run_started events are not counted: a resume may run setup twice in
one launch. A missing or unreadable file counts as none, and a line that is
not a JSON object is skipped. Nothing here writes.
"""
import glob
import json
import os

_DOCTOR_PREFIX = "doctor-"
_DOCTOR_SUFFIX = ".json"


def _events(ledger_dir):
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
        if isinstance(event, dict):
            out.append(event)
    return out


def _doctor_ids(ledger_dir):
    out = []
    pattern = os.path.join(glob.escape(ledger_dir), _DOCTOR_PREFIX + "*" + _DOCTOR_SUFFIX)
    for path in glob.glob(pattern):
        name = os.path.basename(path)
        wf = name[len(_DOCTOR_PREFIX):-len(_DOCTOR_SUFFIX)]
        if wf and os.path.isfile(path):
            out.append(wf)
    return out


def recorded_launches(ledger_dir):
    """{"count": int, "named": [wf ids sorted]} for the ledger in ledger_dir."""
    ended = 0
    named = set()
    for event in _events(ledger_dir):
        kind = event.get("event")
        if kind == "run_ended":
            ended += 1
        elif kind == "carried" and isinstance(event.get("wf"), str) and event["wf"]:
            named.add(event["wf"])
    named.update(_doctor_ids(ledger_dir))
    named = sorted(named)
    return {"count": max(ended, len(named)), "named": named}
