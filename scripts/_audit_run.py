"""The run-level sections of scripts/audit: launches, code outside the
recorded task ranges, checks, acceptance and the derived verdict, after
delivery, and open work.

Import with:
    sys.dont_write_bytecode = True
    sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
    import _audit_run

run_sections(run, git, head=None, check_verify=run_check_verify,
git_note=None) takes a run from _audit_core.load_run and a _audit_git.Git
(or None: every git fact is then unavailable, note git_note or "no --repo")
and returns {"launches", "code_outside_ranges", "checks", "acceptance",
"after_delivery", "open_work", "facts"}. Every derived value is an
_audit_core.ref; recorded text is an _audit_core.quote with configured
commands replaced by <check:<id>>. facts ({"verdict", "gate", "evidence",
"evidence_rule", "verify_head", "accepted_run", "order_known"}) are the run
facts the per-task sections take; evidence_rule is evidence_validity's rule
(None when no rule decided it).

launches also compares the launches the archived ledger records
(_launches.recorded_launches) with the ones archived: recorded is a ref of
{"recorded", "archived", "named"} (unavailable without a ledger), and
missing holds one missing ref per recorded launch the archive lacks when it
records more (the named wf ids with no launch here, then None per unnamed
one); equal counts give none.

Run-level facts come from the latest launch (_audit_core.latest_launch);
when the launch order is unknown they are unavailable, never taken from an
arbitrary launch.

The gate is check-verify's archive mode (run_check_verify): 'check-verify
<run folder>/<wf> <manifest> --ledger <ledger dir>', of which only the
status, a known reason code and the exit code are kept. It is not run, and
the gate is unavailable with a note, without a ledger in the archive, without
a known latest launch, or when one of its inputs resolves outside the run
folder. Exit 2 or 3 (or any exit but 0 and 1), output that is not one JSON
object, or a status outside GATES is checker_error.

Evidence validity (evidence_validity) re-applies the engine's acceptance
rules (src/acceptance.js) to the archived verify result, and the verdict
(derive_verdict) combines the run verdict, the gate, the evidence and the
user's override, in the order the audit spec gives.

checks.e2e is stale only when the end-to-end check's checked_sha and the
delivered sha are both recorded (non-empty strings) and differ; when one is
missing it is unavailable, its note naming what is missing (E2E_NO_CHECKED,
E2E_NO_DELIVERED, or both joined by "; "). A commit outside the task ranges
that a final lens head contains is present with the note LENS_NOTE (that
head's first 7 digits); one that the final re-review's recorded head
contains (_re_review_head) is present with RE_REVIEW_NOTE, cited by that
result's journal line (<wf>/journal.jsonl L<n>); only the rule for an
engine that recorded no re-review head (final re-review (no recorded
head)) is inferred.

The plan and spec hashes are run-level facts, in checks once (never per
task; input_hashes): plan_hash and spec_hash hold one ref per setup
run_started event, in ledger order, its sources that ledger line and the
archived copy: the recorded hash against the copy's sha256 (present when
they agree, or when neither exists; stale when they differ, or when the
launch recorded none but the archive holds a copy; unavailable without a
copy to compare, or when the event has no such key). Without a setup event
each is one unavailable ref, "no setup run_started recorded". section_hash
is the plan copy the tasks' section hashes are read from: present, its
value the copy's path, else unavailable ("no plan copy archived", "the plan
copy could not be read").

checks.task_checks (1.6.17) is {"not_recorded", "unmatched"}: the committed
tasks, not settled last, with no task-check file that a launch before 1.6.0
reports (task_check_engine), in run order, and the task-check files that
match no task. task_check_index reads those files (each task's attempts in
order), task_check_engine says which engine judges a task without one, and
task_has_checks whether the engine asks for one; _audit_tasks builds each
task's checks.task_check from them.

start_point(run) is the run's start point: the earliest setup run_started
head (ledger status' start_points.prelude), else the base of the first task,
in manifest run order, with a recorded range; with its ledger source. When
'ledger status' failed on an archived ledger, code_outside_ranges names that
failure instead of "no start point recorded", and open_work.ledger_state is
unavailable with it (else ledger_state is None), so the tasks the ledger
lists as blocked or deferred count as a gap rather than as absent.

open_work.final, from the latest launch's final review result, is a ref of
{"findings" (open and declined), "cannot_verify", "task_minors_open" (the
result's findings, quoted; None when the result has no such list, as before
1.3.1), "carried_minors_open" (the result's carried minor ids, its strings;
None when it has none, as before 1.6.3), "carried_minor_tasks" ({id: task
id} for the carried ids a ledger minors snapshot lists with a task that
is a manifest task id, the latest snapshot that lists each; None with
carried_minors_open),
"not_recorded" (which of "open", "declined" and "cannot_verify" the result
has no list for, as older engines have no open list: that count is
unknown, not 0; cannot_verify is then []), "re_review" (_re_review)}.

re_review is the final re-review, from the latest launch's journal and
result only (no git), its last final re-review entry (RE_REVIEW_LABELS)
deciding: {form, head, delivered (the result's delivered_sha as recorded),
resolved, open, without_result, contradictory, of, new}. form judged (a
valid result: head, results and new_findings; each id of final.findings
counted by the statuses its results give it: none, more than one, resolved,
or another, so of = the four counts; new the new findings), not_recorded
(findings only: before 1.2.0), no_valid_result (any other result, or a
started entry with none), not_run (no entry, with final findings; note
RE_REVIEW_NOT_RUN), none (no entry and no final findings), each present
with the journal line for judged and no_valid_result; unavailable without
a journal (NO_JOURNAL) or with one whose file cannot be read
(UNREADABLE_JOURNAL; _audit_core.read_journal tells them apart).

Each final finding (open or declined, never a task minor) has re_review
(_finding_re_review): {rule, status, head, delivered, evidence (the
review's evidence, quoted)}, present, never a gap, rule the first that
applies of raised, not_recorded, no_result_recorded (a null review with no
journal or an unreadable one: its note that journal note and REASON_SAYS),
not_run, no_valid_result, contradictory, no_result, other_head,
decline_upheld and result.

acceptance also holds verdict_without_override (derive_verdict with no
override) and verdict_rule_without_override (_verdict_rule when that verdict
is unverified for an accepted run, else None), so a verdict of accepted by
user can name the fault audit found that the override set aside.
GATE_UNAVAILABLE_VERDICT is the one constant for accepted (gate
unavailable).

after_delivery (with --head) lists the commits reachable from the head but
not from the delivered sha: unavailable, "no run evidence", when there are
any, present with an empty list ("no commits after the delivered sha") when
there are none.
"""

import glob
import json
import os
import re
import subprocess
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import _audit_core as c  # noqa: E402
import _autopsy  # noqa: E402
import _launches as launch_counts  # noqa: E402  (the name _launches is the section below)

SCRIPTS = os.path.dirname(os.path.realpath(__file__))
MISSING_LAUNCH = "the ledger records this launch; its transcripts are not archived"
# The note of a commit outside the task ranges that a final lens head contains.
LENS_NOTE = "contained in the final review's head %s"
# The note of one that the final re-review's recorded head contains.
RE_REVIEW_NOTE = "judged %s"
# The final re-review's journal labels (a budget retry is the same call).
RE_REVIEW_LABELS = ("final re-review", "final re-review retry")
# The final re-review line's note when no journal entry ran it.
RE_REVIEW_NOT_RUN = "each finding's reason says why"
# Why a launch's journal gives nothing (read_journal), and what a null
# review's line adds then.
NO_JOURNAL = "no journal archived for %s"
UNREADABLE_JOURNAL = "the journal for %s could not be read"
REASON_SAYS = "; its reason says why"
# A finding id the engine gives the re-review's new findings (N1, N2, ...).
NEW_FINDING_ID = re.compile(r"^N[0-9]+$")
# What an e2e entry without both shas lacks (both, joined by "; ").
E2E_NO_CHECKED = "the end-to-end check recorded no sha"
E2E_NO_DELIVERED = "the run recorded no delivered sha"

GATES = ("match", "not_required", "missing", "stale", "mismatch", "invalid", "unavailable", "checker_error")
# The verdict of an accepted run whose gate check-verify could not judge
# (derive_verdict); _audit_tasks and _audit use this one constant.
GATE_UNAVAILABLE_VERDICT = "accepted (gate unavailable)"
# What check-verify itself prints; checker_error is audit's own.
CHECKER_STATUSES = GATES[:-1]
REASONS = ("verify_invalid", "verify_evidence_missing", "verify_evidence_stale", "verify_mismatch",
           "verify_evidence_time_untrusted")
# The evidence state each gate gives.
GATE_STATES = {"match": "present", "not_required": "present", "missing": "missing", "stale": "stale",
               "mismatch": "conflicting", "invalid": "unavailable", "unavailable": "unavailable",
               "checker_error": "unavailable"}
# The evidence state of each validity rule (the engine's reason classes:
# a check that ran and failed is present evidence of a failure).
RULE_STATES = {"checks_missing": "missing", "checks_stale": "stale", "checks_incomplete": "missing",
               "checks_failed": "present", "checks_unclean": "missing",
               "integrity_not_recorded": "unavailable"}
INTEGRITY = ("tracked_before", "tracked_after", "untracked_before")
LISTS = ("tracked_before", "tracked_after", "untracked_before", "untracked_after")
# The first engine that records final.unreviewed_fix.
UNREVIEWED_FIX_ENGINE = (1, 2, 1)
FULL_SHA = re.compile(r"[0-9a-fA-F]{40}|[0-9a-fA-F]{64}")
CHECKER_SHA = re.compile(r"[0-9a-f]{40}|[0-9a-f]{64}")
WF_NAME = re.compile(r"^wf_[A-Za-z0-9_-]+$")
EVIDENCE_NAME = re.compile(r"^(session-verify|verify)-([0-9a-f]{40}|[0-9a-f]{64})\.json$")
CHECK_GROUPS = ("test", "lint", "build")
# The task checks (scripts/task-checks): <ledger>/checks/task-<unit>.<n>.json
# (the unit parsed greedily), written from this engine on.
TASK_CHECK_NAME = re.compile(r"^task-(.+)\.([1-9][0-9]*)\.json$")
TASK_CHECK_ENGINE = (1, 6, 0)
# Why a task-check attempt has no result, or says nothing of its policy.
TC_EMPTY = "the file is empty: reserved, never written"
TC_UNREADABLE = "the file cannot be read"
TC_ERROR_NO_POLICY = "an error record with no policy"
TC_ERROR = "an error record"
TC_NO_RESULT = "no command result recorded"
TC_NO_POLICY = "the file records no policy"


# ---- check-verify ----

def _gate(status, note=None, reason=None, code=None):
    return {"status": status, "reason": reason, "exit": code, "note": note}


def parse_check_verify(code, stdout):
    """{"status", "reason", "exit", "note"} from check-verify's exit code and
    stdout. Only the status, a known reason code and the exit code are kept;
    an exit other than 0 and 1, output that is not one JSON object, or a
    status check-verify does not print is checker_error."""
    if code not in (0, 1):
        return _gate("checker_error", "check-verify exited %s" % (code,), code=code)
    try:
        data = json.loads(stdout.strip()) if isinstance(stdout, str) else None
    except ValueError:
        data = None
    if not isinstance(data, dict):
        return _gate("checker_error", "check-verify printed no JSON object", code=code)
    status = data.get("status")
    if not isinstance(status, str) or status not in CHECKER_STATUSES:
        return _gate("checker_error", "check-verify printed an unknown status", code=code)
    reason = data.get("reason")
    return _gate(status, reason=reason if reason in REASONS else None, code=code)


def _delivered_or_head(result):
    """The sha check-verify takes: delivered_sha, else verify.head."""
    result = result if isinstance(result, dict) else {}
    delivered = result.get("delivered_sha")
    if delivered is not None:
        return delivered
    verify = result.get("verify")
    return verify.get("head") if isinstance(verify, dict) else None


def run_check_verify(run, launch):
    """check-verify's archive mode for launch (the latest launch):
    {"status", "reason", "exit", "note"}. It is not run (status unavailable,
    note the cause) without a launch, a ledger or a manifest, or when one of
    its inputs (the manifest, <wf>.json, the ledger's *.jsonl files, the
    evidence file) resolves outside the run folder."""
    if launch is None:
        return _gate("unavailable", "no known latest launch")
    if not run.get("ledger"):
        return _gate("unavailable", "no ledger in the archive")
    if not run.get("manifest_path"):
        return _gate("unavailable", "no manifest in the archive")
    folder = run["folder"]
    ledger = os.path.join(folder, run["ledger"])
    manifest = os.path.join(folder, run["manifest_path"])
    launch_dir = os.path.join(folder, launch["wf"])
    inputs = [manifest, launch_dir + ".json"] + sorted(glob.glob(os.path.join(glob.escape(ledger), "*.jsonl")))
    sha = _delivered_or_head(launch.get("result"))
    if isinstance(sha, str) and CHECKER_SHA.fullmatch(sha):
        inputs.append(os.path.join(ledger, "checks", "verify-%s.json" % sha))
    for path in inputs:
        if not c.inside(folder, path):
            return _gate("unavailable", "%s resolves outside the run folder; check-verify was not run"
                         % os.path.relpath(path, folder).replace("\\", "/"))
    try:
        res = subprocess.run([sys.executable, os.path.join(SCRIPTS, "check-verify"), launch_dir, manifest,
                              "--ledger", ledger],
                             stdin=subprocess.DEVNULL, capture_output=True, text=True,
                             encoding="utf-8", errors="replace", timeout=300)
    except (OSError, subprocess.SubprocessError):
        return _gate("checker_error", "check-verify could not run")
    return parse_check_verify(res.returncode, res.stdout)


def _normal_gate(out):
    """A check_verify return value with a status outside GATES (or no dict)
    turned into checker_error, and an unknown reason dropped."""
    if not isinstance(out, dict) or out.get("status") not in GATES:
        return _gate("checker_error", "check-verify gave an unknown status",
                     code=out.get("exit") if isinstance(out, dict) else None)
    reason = out.get("reason")
    return _gate(out["status"], out.get("note"), reason if reason in REASONS else None, out.get("exit"))


# ---- evidence validity and the verdict ----

def _truthy(value):
    """JavaScript truthiness, for mirroring the engine's || chains."""
    if value is None or value is False:
        return False
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value == value and value != 0
    if isinstance(value, str):
        return value != ""
    return True


def _command_group(m, lane_id, name):
    """src/prompts-task.js commandGroup: a lane's own lane_commands entry for
    the group when it has one (an empty list included), else commands."""
    own = {}
    lane_commands = m.get("lane_commands")
    if lane_id is not None and isinstance(lane_commands, dict) and _truthy(lane_commands.get(lane_id)):
        own = lane_commands[lane_id]
    if isinstance(own, dict) and name in own and _truthy(own[name]):
        group = own[name]
    else:
        commands = m.get("commands")
        group = commands.get(name) if isinstance(commands, dict) else None
    return [x for x in group if isinstance(x, str)] if isinstance(group, list) else []


def expected_checks(manifest):
    """[(group, command)] the verify step must have run, in order: the
    engine's finalChecks (src/prompts-task.js). test, lint and build of
    commands, then for each lane in manifest.lanes order and each group the
    lane's commands, a (group, command) pair already listed left out."""
    m = manifest if isinstance(manifest, dict) else {}
    out = []
    for group in CHECK_GROUPS:
        out += [(group, command) for command in _command_group(m, None, group)]
    lanes = m.get("lanes")
    for lane in lanes if isinstance(lanes, list) else []:
        lane_id = lane.get("id") if isinstance(lane, dict) else None
        if lane_id is None:
            continue
        for group in CHECK_GROUPS:
            for command in _command_group(m, lane_id, group):
                if (group, command) not in out:
                    out.append((group, command))
    return out


def _zero(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value == 0


def evidence_validity(manifest, verify, delivered_sha, gate):
    """(value, rule): value valid, invalid, unavailable or not_required; rule
    None or the name of the rule that decided it. The engine's acceptance
    rules over the archived verify result, which a check-verify match alone
    does not establish."""
    want = expected_checks(manifest)
    if not want:
        return "not_required", None
    if gate != "match":
        return "unavailable", None
    if not isinstance(verify, dict) or not isinstance(verify.get("results"), list):
        return "invalid", "checks_missing"
    if verify.get("head") != delivered_sha:
        return "invalid", "checks_stale"
    results = verify["results"]
    got = [(r.get("group"), r.get("command")) if isinstance(r, dict) else None for r in results]
    if got != want:
        return "invalid", "checks_incomplete"
    if verify.get("ok") is not True or not all(_zero(r.get("exit")) for r in results):
        return "invalid", "checks_failed"
    if any(key not in verify or verify[key] is None for key in INTEGRITY):
        return "unavailable", "integrity_not_recorded"
    if any(not isinstance(verify[key], list) or verify[key] for key in INTEGRITY):
        return "invalid", "checks_unclean"
    return "valid", None


def _overrides(override):
    if isinstance(override, dict):
        return [override]
    return [o for o in override if isinstance(o, dict)] if isinstance(override, list) else []


def _matching_override(override, delivered_sha):
    """The last override (an accepted event, or a list of them) whose head
    is delivered_sha, or None."""
    if not isinstance(delivered_sha, str) or not delivered_sha:
        return None
    found = None
    for o in _overrides(override):
        if o.get("head") == delivered_sha:
            found = o
    return found


def derive_verdict(run_verdict, gate, evidence, override, delivered_sha, order_known):
    """The derived verdict, in the spec's order. override is the ledger's
    accepted event, or a list of them; one at another head changes
    nothing."""
    if run_verdict is None or not order_known:
        return "unavailable"
    if _matching_override(override, delivered_sha) is not None:
        return "accepted by user"
    if run_verdict == "accepted":
        if (gate == "match" and evidence == "valid") or (gate == "not_required" and evidence == "not_required"):
            return "accepted"
        if gate in ("unavailable", "checker_error"):
            return GATE_UNAVAILABLE_VERDICT
        if gate in ("missing", "stale", "mismatch", "invalid") or evidence == "invalid" \
                or (gate == "not_required" and evidence != "not_required"):
            return "unverified"
    return run_verdict


def _verdict_rule(gate, evidence, rule):
    """What made an accepted run unverified."""
    if gate in ("missing", "stale", "mismatch", "invalid"):
        return "gate %s" % gate
    if evidence == "invalid":
        return rule
    return "not_required claimed while checks are configured"


# ---- sources ----

def _pointer(keys):
    return "".join("/" + str(k).replace("~", "~0").replace("/", "~1") for k in keys)


def _wf_src(launch, *keys):
    """A source in <wf>.json at #/result/<keys>, cut back to the deepest part
    of the path that exists; at None without a result file."""
    path = launch["wf"] + ".json"
    data = launch.get("data")
    if not isinstance(data, dict) or "result" not in data:
        return c.src(path, None)
    node, done = data["result"], ["result"]
    for key in keys:
        if isinstance(node, dict) and key in node:
            node = node[key]
        elif isinstance(node, list) and isinstance(key, int) and 0 <= key < len(node):
            node = node[key]
        else:
            break
        done.append(key)
    return c.src(path, "#" + _pointer(done))


def _events(run):
    """[(event, source)] for every parsed ledger event, in ledger order."""
    return [(line["event"], c.src(line["file"], "L%d" % line["line"]))
            for line in run.get("ledger_lines") or [] if isinstance(line.get("event"), dict)]


def _status(run):
    status = run.get("ledger_status")
    return status if isinstance(status, dict) else {}


def _status_failure(run):
    """Why 'ledger status' gave nothing for an archived ledger, or None (no
    ledger, or a status was read)."""
    if not run.get("ledger") or isinstance(run.get("ledger_status"), dict):
        return None
    return run.get("ledger_status_error") or "ledger status gave no result"


def _ledger_src(run):
    return [c.src(run["ledger"], None)] if run.get("ledger") else []


def _full_sha(value):
    return isinstance(value, str) and FULL_SHA.fullmatch(value) is not None


def _q(text, sources, pairs):
    return c.quote(text, sources, pairs) if isinstance(text, str) else None


# ---- start point ----

def start_point(run):
    """(sha, source) of the run's start point, or (None, None): ledger
    status' start_points.prelude (the earliest setup run_started head), else
    the base of the first task in manifest run order that has a recorded
    range."""
    status = _status(run)
    events = _events(run)
    points = status.get("start_points")
    prelude = points.get("prelude") if isinstance(points, dict) else None
    if isinstance(prelude, str) and prelude:
        for event, source in events:
            if event.get("event") == "run_started" and event.get("phase") == "setup" \
                    and event.get("head") == prelude:
                return prelude, source
        return prelude, c.src(run["ledger"], None)
    ranges = status.get("ranges")
    ranges = ranges if isinstance(ranges, dict) else {}
    for task, _lane in c.manifest_tasks(run.get("manifest")):
        rng = ranges.get(task["id"])
        base = rng.get("base") if isinstance(rng, dict) else None
        if isinstance(base, str) and base:
            for event, source in events:
                if event.get("task") == task["id"] and event.get("event") in ("committed", "settled") \
                        and event.get("base") == base:
                    return base, source
            return base, c.src(run["ledger"], None)
    return None, None


# ---- launches ----

def _launches(run, pairs):
    launches = run.get("launches") or []
    if not launches:
        return c.ref([], "unavailable", [], "no launch")
    entries = []
    for launch in launches:
        wf = launch["wf"]
        result = launch.get("result")
        layout = []
        if launch.get("data") is None:
            layout.append(c.ref(wf + ".json", "missing", [c.src(wf + ".json")], "no result file"))
            status = c.ref(None, "unavailable", [], "no result file")
        elif not isinstance(result, dict) or not isinstance(result.get("status"), str):
            status = c.ref(None, "unavailable", [_wf_src(launch, "status")], "the result records no status")
        else:
            status = c.ref(result["status"], "present", [_wf_src(launch, "status")])
        if not launch.get("has_transcripts"):
            layout.append(c.ref(wf + "/", "unavailable", [], "no transcripts archived"))
        if not WF_NAME.match(wf):
            layout.append(c.ref(wf, "unavailable", [], "the name does not match wf_[A-Za-z0-9_-]+"))
        reason = result.get("reason") if isinstance(result, dict) else None
        entries.append({
            "wf": wf,
            "start": launch.get("start"),
            "status": status,
            "reason": _q(reason, [_wf_src(launch, "reason")], pairs),
            "has_transcripts": bool(launch.get("has_transcripts")),
            "dirless": launch.get("dir") is None,
            "layout": layout,
        })
    sources = [c.src(l["wf"] + ".json") for l in launches if l.get("data") is not None]
    return c.ref(entries, "present", sources)


def _recorded(run):
    """(the recorded ref, the missing refs): the launches the archived ledger
    records (_launches.recorded_launches) against the launches archived here.
    When it records more, each one missing is a gap: the named wf ids with no
    launch here first, then None for each unnamed one."""
    if not run.get("ledger"):
        return c.ref(None, "unavailable", [], "no ledger in the archive"), []
    recorded = launch_counts.recorded_launches(os.path.join(run["folder"], run["ledger"]))
    sources = [c.src(run["ledger"], None)]
    archived = set(l["wf"] for l in run.get("launches") or [])
    count, named = recorded["count"], recorded["named"]
    value = {"recorded": count, "archived": len(archived), "named": named}
    missing = []
    if count > len(archived):
        absent = [wf for wf in named if wf not in archived]
        absent += [None] * max(0, count - len(archived) - len(absent))
        missing = [c.ref(wf, "missing", sources, MISSING_LAUNCH) for wf in absent]
    return c.ref(value, "present", sources), missing


# ---- code outside recorded task ranges ----

def _parse_version(text):
    """A version string's leading digits as a tuple of ints, or None."""
    match = re.match(r"(\d+(?:\.\d+)*)", text) if isinstance(text, str) else None
    return tuple(int(x) for x in match.group(1).split(".")) if match else None


def result_version(launch):
    """A launch's result.version as a tuple of ints, or None (no version:
    before 1.4.3, or one that does not parse)."""
    result = launch.get("result")
    return _parse_version(result.get("version") if isinstance(result, dict) else None)


def _version(run, launch):
    """(the engine version as a tuple of ints or None, its source)."""
    result = launch.get("result") or {}
    text, source = result.get("version"), _wf_src(launch, "version")
    if not (isinstance(text, str) and text):
        text, source = None, None
        report = run.get("report_path")
        if report:
            try:
                with open(os.path.join(run["folder"], report), encoding="utf-8") as f:
                    data = json.load(f)
            except (OSError, ValueError):
                data = None
            if isinstance(data, dict) and isinstance(data.get("engine_version"), str):
                text, source = data["engine_version"], c.src(report, "#/engine_version")
    return _parse_version(text), source


def _lens_heads(launch, final):
    """[(head, source)]: final.lens_heads, else the structured results of the
    lens agents (labels 'final review <lens>' or exactly 'final review')."""
    heads = []
    listed = final.get("lens_heads")
    for i, entry in enumerate(listed if isinstance(listed, list) else []):
        head = entry.get("head") if isinstance(entry, dict) else None
        if isinstance(head, str) and head:
            heads.append((head, _wf_src(launch, "final", "lens_heads", i, "head")))
    if heads:
        return heads
    for entry in c.structured_results(launch):
        label, result = entry["label"], entry["result"]
        if label is None or not (label == "final review" or label.startswith("final review ")):
            continue
        head = result.get("head") if isinstance(result, dict) else None
        if isinstance(head, str) and head:
            heads.append((head, c.journal_src(launch, entry["line"])))
    return heads


def _valid_re_review(result):
    """A final re-review result that judged a head: an object with a string
    head and results and new_findings lists (spec 5.5)."""
    head = result.get("head") if isinstance(result, dict) else None
    return isinstance(head, str) and bool(head) and isinstance(result.get("results"), list) \
        and isinstance(result.get("new_findings"), list)


def _re_review_head(launch):
    """(head, source) of the last 'final re-review' structured result that
    records a head (a budget retry included), when that result is a valid
    review (_valid_re_review), its source the result's journal line. False
    when the last result that records a head is not valid: it covers
    nothing, and no head-less rule may stand in for it. None when no result
    records a head."""
    found = None
    for entry in c.structured_results(launch):
        label, result = entry["label"], entry["result"]
        if label not in RE_REVIEW_LABELS:
            continue
        head = result.get("head") if isinstance(result, dict) else None
        if isinstance(head, str) and head:
            found = (head, c.journal_src(launch, entry["line"])) if _valid_re_review(result) else False
    return found


def _recorded_ranges(run, git):
    """(the commits of every committed or settled event with a base, the
    commits lists of the events without one)."""
    covered, legacy = set(), []
    for event, _source in _events(run):
        if event.get("event") not in ("committed", "settled"):
            continue
        base, head = event.get("base"), event.get("head")
        if isinstance(base, str) and base and isinstance(head, str) and head:
            commits = git.rev_list(head, [base])
            if commits:
                covered.update(commits)
        elif event.get("event") == "committed":
            listed = event.get("commits")
            legacy += [x.lower() for x in listed if isinstance(x, str) and x] if isinstance(listed, list) else []
    return covered, legacy


def _in_legacy(sha, legacy):
    sha = sha.lower()
    return any(sha == x or (len(x) >= 7 and sha.startswith(x)) for x in legacy)


def _code_outside(run, git, git_note, launch, why, pairs):
    if git is None:
        return c.ref(None, "unavailable", [], git_note or "no --repo")
    if launch is None:
        return c.ref(None, "unavailable", [], why)
    result = launch.get("result") or {}
    delivered = result.get("delivered_sha")
    d_src = _wf_src(launch, "delivered_sha")
    if not _full_sha(delivered):
        return c.ref(None, "unavailable", [d_src], "delivered_sha is not a sha of 40 or 64 hex digits")
    start, s_src = start_point(run)
    if start is None:
        failed = _status_failure(run)
        if failed is not None:
            return c.ref(None, "unavailable", _ledger_src(run), failed)
        return c.ref(None, "unavailable", [], "no start point recorded")
    commits = git.rev_list(delivered, [start])
    if commits is None:
        return c.ref(None, "unavailable", [d_src, s_src],
                     "the repo cannot list the commits from %s to %s" % (start[:7], delivered[:7]))
    covered, legacy = _recorded_ranges(run, git)
    outside = [sha for sha in commits if sha not in covered and not _in_legacy(sha, legacy)]

    final = result.get("final") if isinstance(result.get("final"), dict) else {}
    lens = _lens_heads(launch, final)
    lens_shas = set(head for head, _ in lens)
    rr = _re_review_head(launch)
    version, v_src = _version(run, launch)
    fix = final.get("unreviewed_fix")
    final_head = final.get("head")
    no_head_rule = (rr is None and version is not None and version >= UNREVIEWED_FIX_ENGINE and not fix
                    and isinstance(final_head, str) and final_head and final_head not in lens_shas)
    entries = []
    for sha in outside:
        entry = {"commit": sha}
        lens_hit = next(((head, source) for head, source in lens if git.is_ancestor(sha, head)), None)
        if lens_hit is not None:
            entry["coverage"] = c.ref("final review", "present", [lens_hit[1], c.src("git:" + lens_hit[0])],
                                      LENS_NOTE % lens_hit[0][:7])
        elif rr and git.is_ancestor(sha, rr[0]):
            entry["coverage"] = c.ref("final re-review", "present", [rr[1], c.src("git:" + rr[0])],
                                      RE_REVIEW_NOTE % rr[0][:7])
        elif no_head_rule and git.is_ancestor(sha, final_head):
            sources = [_wf_src(launch, "final", "head")] + ([v_src] if v_src is not None else [])
            entry["coverage"] = c.ref("final re-review (no recorded head)", "inferred", sources)
        elif fix:
            f_src = _wf_src(launch, "final", "unreviewed_fix")
            entry["coverage"] = c.ref("final.unreviewed_fix", "missing", [f_src], "final.unreviewed_fix is set")
            entry["unreviewed_fix"] = _q(fix, [f_src], pairs)
        else:
            entry["coverage"] = c.ref("no review evidence", "missing", [_wf_src(launch, "final")],
                                      "no review evidence")
        entries.append(entry)
    value = {"start_point": start, "delivered_sha": delivered, "commits": entries}
    return c.ref(value, "present", [s_src, d_src])


# ---- checks ----

def _check_ids(manifest, results):
    ids = {}
    for cid, command, _full in _autopsy.configured_checks(manifest if isinstance(manifest, dict) else {}):
        ids.setdefault(command, cid)
    unmatched = {}
    out = []
    for r in results:
        r = r if isinstance(r, dict) else {}
        command = r.get("command")
        if command in ids:
            cid = ids[command]
        else:
            key = command if isinstance(command, str) else None
            if key not in unmatched:
                unmatched[key] = "unmatched#%d" % (len(unmatched) + 1)
            cid = unmatched[key]
        out.append({"check": cid, "group": r.get("group"), "exit": r.get("exit")})
    return out


def _evidence_files(run):
    if not run.get("ledger"):
        return []
    checks = os.path.join(run["folder"], run["ledger"], "checks")
    try:
        names = sorted(os.listdir(checks))
    except OSError:
        return []
    out = []
    for name in names:
        match = EVIDENCE_NAME.match(name)
        if match and os.path.isfile(os.path.join(checks, name)):
            out.append({"path": "%s/checks/%s" % (run["ledger"], name), "kind": match.group(1),
                        "sha": match.group(2)})
    return out


def _checks(run, launch, why, gate, evidence, rule, want):
    manifest = run.get("manifest")
    files = _evidence_files(run)
    out = {"verify": None, "files": files, "gate": None, "evidence": None, "verify_head": None, "e2e": None}
    if launch is None:
        out["verify"] = c.ref(None, "unavailable", [], why)
    else:
        result = launch.get("result") or {}
        verify = result.get("verify")
        v_src = _wf_src(launch, "verify")
        if isinstance(verify, dict):
            value = dict((key, verify.get(key)) for key in ("head", "ok", "clean") + LISTS)
            results = verify.get("results")
            value["results"] = _check_ids(manifest, results) if isinstance(results, list) else None
            out["verify"] = c.ref(value, "present", [v_src])
            delivered = result.get("delivered_sha")
            h_sources = [_wf_src(launch, "verify", "head"), _wf_src(launch, "delivered_sha")]
            if verify.get("head") == delivered and isinstance(delivered, str):
                out["verify_head"] = c.ref(verify.get("head"), "present", h_sources)
            else:
                out["verify_head"] = c.ref(verify.get("head"), "stale", h_sources,
                                           "the checks ran at %s, not at the delivered %s"
                                           % (verify.get("head"), delivered))
        elif want:
            out["verify"] = c.ref(None, "missing", [v_src], "no verify result, and checks are configured")
        else:
            out["verify"] = c.ref(None, "present", [v_src], "no test, lint or build command is configured")
        out["e2e"] = _e2e(run, launch, result)
    g_sources = [s for s in (_evidence_source(run, launch, files),) if s is not None]
    if launch is not None:
        g_sources.append(_wf_src(launch, "verify"))
    note = gate.get("note") or gate.get("reason")
    out["gate"] = c.ref(gate["status"], GATE_STATES[gate["status"]], g_sources, note)
    out["gate_reason"] = gate.get("reason")
    out["gate_exit"] = gate.get("exit")
    if evidence == "invalid":
        e_state = RULE_STATES.get(rule, "missing")
    elif evidence == "unavailable":
        e_state = "unavailable"
    else:
        e_state = RULE_STATES.get(rule, "present")
    e_note = rule
    if evidence == "unavailable" and rule is None:
        e_note = "the gate is %s" % gate["status"]
    out["evidence"] = c.ref(evidence, e_state, g_sources, e_note)
    out["rule"] = rule
    out["task_checks"] = _task_checks(run, task_check_index(run))
    out.update(input_hashes(run))
    return out


def _hashes(run, setups, key, copy_path, what):
    """One ref per setup event: its recorded key against the archived copy."""
    if not setups:
        return [c.ref(None, "unavailable", _ledger_src(run), "no setup run_started recorded")]
    copy_sha = c.file_sha256(os.path.join(run["folder"], copy_path)) if copy_path else None
    out = []
    for event, source in setups:
        sources = [source]
        if key not in event:
            out.append(c.ref(None, "unavailable", sources, "the launch recorded no %s hash" % what))
            continue
        recorded = event[key]
        if copy_path:
            sources.append(c.src(copy_path))
        if recorded is None:
            if copy_sha is None:
                out.append(c.ref(None, "present", sources, "the launch recorded no %s" % what))
            else:
                out.append(c.ref(None, "stale", sources, "the launch recorded no %s, but the archive holds one" % what))
        elif copy_sha is None:
            out.append(c.ref(recorded, "unavailable", sources, "no %s copy archived to compare" % what))
        elif recorded == copy_sha:
            out.append(c.ref(recorded, "present", sources))
        else:
            out.append(c.ref(recorded, "stale", sources, "the archived %s copy differs from this launch's" % what))
    return out


def input_hashes(run):
    """{"plan_hash", "spec_hash", "section_hash"}: the run-level input facts
    (see the module docstring)."""
    setups = [(e, s) for e, s in _events(run) if e.get("event") == "run_started" and e.get("phase") == "setup"]
    plan = run.get("plan_path")
    if plan is None:
        section = c.ref(None, "unavailable", [], "no plan copy archived")
    elif c.read_text(os.path.join(run["folder"], plan)) is None:
        section = c.ref(None, "unavailable", [c.src(plan)], "the plan copy could not be read")
    else:
        section = c.ref(plan, "present", [c.src(plan)])
    return {
        "plan_hash": _hashes(run, setups, "plan_sha256", plan, "plan"),
        "spec_hash": _hashes(run, setups, "spec_sha256", run.get("spec_path"), "spec"),
        "section_hash": section,
    }


def _evidence_source(run, launch, files):
    """The saved verify evidence for the latest launch, when it exists."""
    if launch is None:
        return None
    sha = _delivered_or_head(launch.get("result"))
    for f in files:
        if f["kind"] == "verify" and f["sha"] == sha:
            return c.src(f["path"])
    return None


def _e2e(run, launch, result):
    hooks = (run.get("manifest") or {}).get("hooks")
    configured = isinstance(hooks, dict) and _truthy(hooks.get("e2e"))
    e2e = result.get("e2e")
    source = _wf_src(launch, "e2e")
    if not isinstance(e2e, dict):
        return c.ref(None, "missing", [source], "the end-to-end check returned no result") if configured else None
    items = e2e.get("items")
    items = items if isinstance(items, list) else []
    checked = e2e.get("checked_sha")
    value = {"checked_sha": checked, "items": len(items),
             "failed": sum(1 for i in items if not (isinstance(i, dict) and i.get("result") == "PASS"))}
    delivered = result.get("delivered_sha")
    # stale needs two recorded shas that differ; a missing one is unavailable.
    lacking = [note for sha, note in ((checked, E2E_NO_CHECKED), (delivered, E2E_NO_DELIVERED))
               if not (isinstance(sha, str) and sha)]
    if lacking:
        return c.ref(value, "unavailable", [source], "; ".join(lacking))
    if checked == delivered:
        return c.ref(value, "present", [source])
    return c.ref(value, "stale", [source], "the end-to-end check covered %s, not the delivered %s"
                 % (checked, delivered))


# ---- task checks ----

def _read_check(path):
    """(the JSON object in a task-check file, None), or (None, why it gives
    none: TC_EMPTY or TC_UNREADABLE)."""
    try:
        with open(path, "rb") as f:
            text = f.read().decode("utf-8")
    except (OSError, UnicodeDecodeError):
        return None, TC_UNREADABLE
    if not text.strip():
        return None, TC_EMPTY
    try:
        data = json.loads(text)
    except ValueError:
        return None, TC_UNREADABLE
    return (data, None) if isinstance(data, dict) else (None, TC_UNREADABLE)


def _check_attempt(manifest, rel, stem, n, data, why):
    """One task-check file as an attempt (see task_check_index)."""
    policy = data.get("policy") if data is not None else None
    policy = policy if isinstance(policy, dict) else None
    results = data.get("results") if data is not None else None
    ok = data.get("ok") if data is not None else None
    if data is None:
        outcome, reason = "no result", why
    elif ok is True:
        outcome, reason = "passed", None
    elif isinstance(results, list) and results:
        outcome, reason = "failed", None
    elif "error" in data:
        outcome, reason = "no result", TC_ERROR if policy is not None else TC_ERROR_NO_POLICY
    else:
        outcome, reason = "no result", TC_NO_RESULT
    if policy is None and reason is None:
        reason = TC_NO_POLICY
    failed = None
    if outcome == "passed":
        failed = []
    elif outcome == "failed":
        failed = [x for x in _check_ids(manifest, results) if not _zero(x["exit"])]

    def text(obj, key):
        value = obj.get(key) if isinstance(obj, dict) else None
        return value if isinstance(value, str) and value else None

    reasons = None
    if policy is not None:
        listed = policy.get("reasons")
        reasons = [r["code"] for r in listed if isinstance(r, dict) and isinstance(r.get("code"), str)] \
            if isinstance(listed, list) else []
    tree_changed = data.get("tree_changed") if data is not None else None
    return {
        "file": rel, "stem": stem, "attempt": n, "outcome": outcome, "reason": reason,
        "unit": text(policy, "unit") or stem, "selected": text(policy, "selected"), "reasons": reasons,
        "ok": ok if isinstance(ok, bool) else None, "failed": failed, "base": text(policy, "base"),
        "head": text(data, "head"), "tree_changed": tree_changed if isinstance(tree_changed, bool) else None,
        "started": text(policy, "started"), "policy": policy,
    }


def _check_tasks(attempt, ids):
    """The manifest task ids (in run order) one task-check file is for: by
    its policy's unit and tasks; without a policy, by its stem: an exact id,
    else a batch unit '<first>-<last>' whose two parts are ids (each)."""
    policy = attempt["policy"]
    if policy is not None:
        listed = policy.get("tasks")
        named = [x for x in listed if isinstance(x, str)] if isinstance(listed, list) else []
        if isinstance(policy.get("unit"), str):
            named.append(policy["unit"])
        return [t for t in ids if t in named]
    stem = attempt["stem"]
    if stem in ids:
        return [stem]
    for first in ids:
        last = stem[len(first) + 1:]
        if stem.startswith(first + "-") and last in ids:
            return [t for t in ids if t in (first, last)]
    return []


def _ordered_attempts(attempts):
    """By n within a stem; stems by their earliest policy.started (ISO 8601
    stamps of one form, compared as text), a stem with none last, then by
    name."""
    stems = {}
    for a in attempts:
        stems.setdefault(a["stem"], []).append(a)

    def key(stem):
        started = [a["started"] for a in stems[stem] if a["started"] is not None]
        return (not started, min(started) if started else "", stem)

    out = []
    for stem in sorted(stems, key=key):
        out += sorted(stems[stem], key=lambda a: a["attempt"])
    return out


def task_check_index(run):
    """{"attempts": {task id: [attempt, ...] in order}, "unmatched": [path]}
    over the ledger's checks/task-<unit>.<n>.json files (TASK_CHECK_NAME, the
    unit parsed greedily). Each attempt is {"file", "stem", "attempt" (n),
    "outcome" (passed: ok true; failed: ok not true, results not empty; no
    result: an empty or unreadable file or an error record), "reason" (why
    it has no result, or TC_NO_POLICY), "unit", "selected", "reasons" (the
    policy's reason codes only; None without a policy), "ok", "failed"
    ([{check, group, exit}] of each non-zero exit, check ids as Checks gives
    them; [] for a pass; None for no result), "base", "head",
    "tree_changed", "started", "policy"}. A file counts for every task
    _check_tasks names, else it is listed in unmatched (name order). Only
    the policy's reason codes and the results' check ids, groups and exits
    are kept: never a file's error, tail, log or checkout."""
    manifest = run.get("manifest") or {}
    ids = [t["id"] for t, _lane in c.manifest_tasks(manifest)]
    by_task, unmatched = {}, []
    checks = os.path.join(run["folder"], run["ledger"], "checks") if run.get("ledger") else None
    try:
        names = sorted(os.listdir(checks)) if checks else []
    except OSError:
        names = []
    for name in names:
        match = TASK_CHECK_NAME.match(name)
        path = os.path.join(checks, name)
        if match is None or not os.path.isfile(path):
            continue
        rel = "%s/checks/%s" % (run["ledger"], name)
        data, why = _read_check(path)
        attempt = _check_attempt(manifest, rel, match.group(1), int(match.group(2)), data, why)
        tasks = _check_tasks(attempt, ids)
        if not tasks:
            unmatched.append(rel)
        for tid in tasks:
            by_task.setdefault(tid, []).append(attempt)
    return {"attempts": dict((tid, _ordered_attempts(a)) for tid, a in by_task.items()), "unmatched": unmatched}


def task_check_engine(run, task_id):
    """(kind, sources): which engine judges a committed task with no
    task-check file, by every launch whose result reports it with a status
    other than skipped or not_run, each by its result.version only (the
    report's engine_version is the latest launch's, not each one's).
    "before": one of them ran an engine before 1.6.0 (TASK_CHECK_ENGINE), or
    records no version (before 1.4.3); "unknown": none reports the task;
    "unreadable": one records a version that does not parse; else
    "recorded". sources are those launches' version sources."""
    reporting = [l for l in run.get("launches") or []
                 if c.task_status(l, task_id) not in (None, "skipped", "not_run")]
    if not reporting:
        return "unknown", []
    before, unreadable = [], []
    for launch in reporting:
        text = launch["result"].get("version")
        version = _parse_version(text)
        if text is None or text == "":
            before.append(_wf_src(launch, "version"))
        elif version is None:
            unreadable.append(_wf_src(launch, "version"))
        elif version < TASK_CHECK_ENGINE:
            before.append(_wf_src(launch, "version"))
    if before:
        return "before", before
    if unreadable:
        return "unreadable", unreadable
    return "recorded", [_wf_src(l, "version") for l in reporting]


def task_has_checks(manifest, lane):
    """Whether the engine asks a task's implementer for a task check: its
    lane (the project's for prelude and join) has a test, lint or build
    command (src/prompts-task.js taskChecksCommand over laneChecks)."""
    m = manifest if isinstance(manifest, dict) else {}
    lane_id = None if lane in ("prelude", "join") else lane
    return any(_command_group(m, lane_id, group) for group in CHECK_GROUPS)


def _task_checks(run, index):
    """{"not_recorded": [task id], "unmatched": [path]}: the committed tasks
    whose last committed or settled event is no settled one, with no
    task-check file, that a launch before 1.6.0 reports (task_check_engine),
    in run order; and the task-check files that match no task."""
    events = {}
    for event, _source in _events(run):
        if isinstance(event.get("task"), str) and event.get("event") in ("committed", "settled"):
            events.setdefault(event["task"], []).append(event.get("event"))
    not_recorded = []
    for task, _lane in c.manifest_tasks(run.get("manifest")):
        kinds = events.get(task["id"]) or []
        if "committed" not in kinds or kinds[-1] == "settled" or index["attempts"].get(task["id"]):
            continue
        if task_check_engine(run, task["id"])[0] == "before":
            not_recorded.append(task["id"])
    return {"not_recorded": not_recorded, "unmatched": list(index["unmatched"])}


# ---- acceptance ----

def _acceptance(run, launch, why, facts, gate, evidence, rule, accepted_events, pairs):
    out = {"run_verdict": None, "reasons": [], "warnings": [], "gate": gate["status"], "evidence": evidence,
           "overrides": [], "verdict": None, "verdict_rule": None, "verdict_without_override": None,
           "verdict_rule_without_override": None, "run_ended": [], "delivered_sha": None}
    result = (launch.get("result") if launch is not None else None) or {}
    acceptance = result.get("acceptance")
    run_verdict = acceptance.get("status") if isinstance(acceptance, dict) else None
    run_verdict = run_verdict if isinstance(run_verdict, str) else None
    delivered = result.get("delivered_sha") if launch is not None else None
    if launch is None:
        out["run_verdict"] = c.ref(None, "unavailable", [], why)
        out["delivered_sha"] = c.ref(None, "unavailable", [], why)
    else:
        status_src = _wf_src(launch, "acceptance", "status")
        if run_verdict is None:
            out["run_verdict"] = c.ref(None, "unavailable", [status_src], "no acceptance object (an older engine)")
        else:
            out["run_verdict"] = c.ref(run_verdict, "present", [status_src])
        reasons = acceptance.get("reasons") if isinstance(acceptance, dict) else None
        for i, r in enumerate(reasons if isinstance(reasons, list) else []):
            r = r if isinstance(r, dict) else {}
            out["reasons"].append({"kind": r.get("kind"), "class": r.get("class"),
                                   "detail": _q(r.get("detail"), [_wf_src(launch, "acceptance", "reasons", i,
                                                                          "detail")], pairs)})
        warnings = acceptance.get("warnings") if isinstance(acceptance, dict) else None
        for i, w in enumerate(warnings if isinstance(warnings, list) else []):
            out["warnings"].append(_q(w, [_wf_src(launch, "acceptance", "warnings", i)], pairs))
        d_src = _wf_src(launch, "delivered_sha")
        if isinstance(delivered, str) and delivered:
            out["delivered_sha"] = c.ref(delivered, "present", [d_src])
        else:
            out["delivered_sha"] = c.ref(None, "unavailable", [d_src], "the result records no delivered_sha")

    in_effect = _matching_override([e for e, _ in accepted_events], delivered) if facts["order_known"] else None
    for event, source in accepted_events:
        head = event.get("head")
        entry = {"head": None, "text": _q(event.get("text"), [source], pairs), "overrode": None}
        if not facts["order_known"] or not (isinstance(delivered, str) and delivered):
            entry["head"] = c.ref(head, "unavailable", [source], why or "no delivered_sha to compare it with")
        elif head == delivered:
            entry["head"] = c.ref(head, "present", [source])
            if event is in_effect:
                kinds = [r.get("kind") for r in (acceptance.get("reasons") or []) if isinstance(r, dict)
                         and isinstance(r.get("kind"), str)] if isinstance(acceptance, dict) \
                    and isinstance(acceptance.get("reasons"), list) else []
                entry["overrode"] = "%s: %s" % (run_verdict, ", ".join(kinds)) if kinds else run_verdict
        else:
            entry["head"] = c.ref(head, "stale", [source], "it accepted an earlier revision")
        out["overrides"].append(entry)

    verdict = facts["verdict"]
    v_sources = [out["run_verdict"]["sources"][0]] if out["run_verdict"]["sources"] else []
    if verdict == "unavailable":
        note = why if not facts["order_known"] else "no acceptance object (an older engine)"
        out["verdict"] = c.ref(verdict, "unavailable", v_sources, note)
    else:
        out["verdict"] = c.ref(verdict, "present", v_sources)
        if verdict == "unverified" and run_verdict == "accepted":
            out["verdict_rule"] = _verdict_rule(gate["status"], evidence, rule)
    # What the verdict would be with no override, so the bottom line can name
    # a fault audit found that the user's override set aside.
    without = derive_verdict(run_verdict, gate["status"], evidence, None, delivered, facts["order_known"])
    out["verdict_without_override"] = without
    if without == "unverified" and run_verdict == "accepted":
        out["verdict_rule_without_override"] = _verdict_rule(gate["status"], evidence, rule)

    for event, source in _events(run):
        if event.get("event") == "run_ended":
            out["run_ended"].append({"status": _q(event.get("status"), [source], pairs),
                                     "agents": event.get("agents"), "rulings": event.get("rulings"),
                                     "sources": [source]})
    return out


# ---- after delivery ----

def _after_delivery(git, git_note, launch, why, head):
    if head is None:
        return None
    if git is None:
        return c.ref(None, "unavailable", [], git_note or "no --repo")
    if launch is None:
        return c.ref(None, "unavailable", [], why)
    delivered = (launch.get("result") or {}).get("delivered_sha")
    d_src = _wf_src(launch, "delivered_sha")
    if not _full_sha(delivered):
        return c.ref(None, "unavailable", [d_src], "delivered_sha is not a sha of 40 or 64 hex digits")
    commits = git.rev_list(head, [delivered])
    if commits is None:
        return c.ref(None, "unavailable", [d_src], "the repo cannot list the commits from %s to %s"
                     % (delivered[:7], head))
    value = {"from": delivered, "to": head, "commits": commits}
    if not commits:
        return c.ref(value, "present", [d_src], "no commits after the delivered sha")
    return c.ref(value, "unavailable", [d_src], "no run evidence")


# ---- open work ----

def _finding(f, status, sources, pairs):
    f = f if isinstance(f, dict) else {}
    out = {"status": status}
    for key in ("id", "lens", "task", "severity", "file", "line"):
        if key in f:
            out[key] = f[key]
    out["issue"] = _q(f.get("issue"), sources, pairs)
    out["reason"] = _q(f.get("reason"), sources, pairs)
    d = f.get("disposition")
    if isinstance(d, dict):
        out["disposition"] = {"status": d.get("status"), "evidence": _q(d.get("evidence"), sources, pairs),
                              "reason": _q(d.get("reason"), sources, pairs)}
    else:
        out["disposition"] = None
    out["sources"] = list(sources)
    return out


def _last_re_review(entries):
    """The last final re-review entry of a journal's entries
    (RE_REVIEW_LABELS: a budget retry is the call the engine used), or
    None."""
    found = None
    for entry in entries or []:
        if entry["label"] in RE_REVIEW_LABELS:
            found = entry
    return found


def journal_note(launch, why):
    """Why a launch's journal gives nothing (why: read_journal's reason):
    NO_JOURNAL or UNREADABLE_JOURNAL."""
    return (NO_JOURNAL if why == c.JOURNAL_ABSENT else UNREADABLE_JOURNAL) % launch["wf"]


def _statuses(results, fid):
    """The statuses a re-review's results give the id fid, each distinct one
    once, in order."""
    seen, out = set(), []
    for r in results if isinstance(results, list) else []:
        if isinstance(r, dict) and r.get("id") == fid:
            key = json.dumps(r.get("status"), sort_keys=True)
            if key not in seen:
                seen.add(key)
                out.append(r.get("status"))
    return out


def _re_review(launch, final, entry, why):
    """open_work.final's re_review, from the latest launch's journal (its last
    final re-review entry decides; why is read_journal's reason it gives
    nothing, else None) and result, no git: {form, head, delivered, resolved,
    open, without_result, contradictory, of, new}."""
    delivered = (launch.get("result") or {}).get("delivered_sha")
    value = {"form": None, "head": None, "delivered": delivered if isinstance(delivered, str) else None,
             "resolved": None, "open": None, "without_result": None, "contradictory": None, "of": None, "new": None}
    if why is not None:
        value["form"] = "unavailable"
        return c.ref(value, "unavailable", [], journal_note(launch, why))
    if entry is None:
        findings = any(isinstance(final.get(k), list) and final[k] for k in ("findings", "fixed", "declined", "open"))
        value["form"] = "not_run" if findings else "none"
        return c.ref(value, "present", [], RE_REVIEW_NOT_RUN if findings else None)
    result, at = entry["result"], [c.journal_src(launch, entry["line"])]
    if _valid_re_review(result):
        counts = {"resolved": 0, "open": 0, "without_result": 0, "contradictory": 0}
        listed = final.get("findings")
        for f in listed if isinstance(listed, list) else []:
            statuses = _statuses(result["results"], f.get("id") if isinstance(f, dict) else None)
            kind = ("without_result" if not statuses else "contradictory" if len(statuses) > 1
                    else "resolved" if statuses[0] == "resolved" else "open")
            counts[kind] += 1
        value.update(counts, form="judged", head=result["head"], of=sum(counts.values()),
                     new=len(result["new_findings"]))
        return c.ref(value, "present", at)
    if isinstance(result, dict) and isinstance(result.get("findings"), list) \
            and "results" not in result and "new_findings" not in result:
        value["form"] = "not_recorded"
        return c.ref(value, "present", [])
    value["form"] = "no_valid_result"
    return c.ref(value, "present", at)


def _finding_re_review(f, key, i, launch, entry, why, form, pairs):
    """A final open or declined finding's re_review, {rule, status, head,
    delivered, evidence}, present: the first rule that applies of raised (an
    open N<k>, the re-review's own), not_recorded (no review key: before
    1.2.0); for a null review no_result_recorded (no journal, or one that
    cannot be read, why: audit cannot tell why it is null; the note says so
    and that the finding's reason says why), not_run (the journal holds no
    final re-review entry), no_valid_result (the run line's form: the last
    entry is started only, null or no valid result), contradictory (its
    results give the id more than one status) or no_result; then
    other_head (the re-review judged another head than the delivered sha),
    decline_upheld (declined, resolved) and result. form is the run line's
    (_re_review). The evidence is the review's, quoted."""
    f = f if isinstance(f, dict) else {}
    at = _wf_src(launch, "final", key, i, "review")
    value = {"rule": None, "status": None, "head": None, "delivered": None, "evidence": None}
    result = entry["result"] if entry is not None else None
    line = [c.journal_src(launch, entry["line"])] if entry is not None else []
    review = f.get("review")
    if key == "open" and isinstance(f.get("id"), str) and NEW_FINDING_ID.match(f["id"]):
        value["rule"] = "raised"
        return c.ref(value, "present", [at])
    if "review" not in f:
        value["rule"] = "not_recorded"
        return c.ref(value, "present", [at])
    if not isinstance(review, dict):
        if why is not None:
            value["rule"] = "no_result_recorded"
            sources = [at] + ([c.journal_src(launch)] if why == c.JOURNAL_UNREADABLE else [])
            return c.ref(value, "present", sources, journal_note(launch, why) + REASON_SAYS)
        if entry is None:
            value["rule"] = "not_run"
            return c.ref(value, "present", [at, c.journal_src(launch)])
        if form == "no_valid_result":
            value["rule"] = "no_valid_result"
        else:
            results = result.get("results") if isinstance(result, dict) else None
            value["rule"] = "contradictory" if len(_statuses(results, f.get("id"))) > 1 else "no_result"
        return c.ref(value, "present", [at] + line)
    value["status"] = review.get("status")
    value["evidence"] = _q(review.get("evidence"), [at], pairs)
    head = result.get("head") if isinstance(result, dict) else None
    delivered = (launch.get("result") or {}).get("delivered_sha")
    if isinstance(head, str) and head and isinstance(delivered, str) and delivered and head != delivered:
        value.update(rule="other_head", head=head, delivered=delivered)
        return c.ref(value, "present", [at] + line)
    value["rule"] = "decline_upheld" if key == "declined" and value["status"] == "resolved" else "result"
    return c.ref(value, "present", [at])


def _cannot_verify(item, source, pairs):
    if isinstance(item, str):
        return _q(item, [source], pairs)
    if not isinstance(item, dict):
        return None
    out = {}
    for key, value in item.items():
        if isinstance(value, str):
            out[key] = _q(value, [source], pairs)
    out["sources"] = [source]
    return out


def _open_tasks(run, pairs):
    status = _status(run)
    blocked = set(x for x in status.get("blocked") or [] if isinstance(x, str))
    deferred = set(x for x in status.get("deferred") or [] if isinstance(x, str))
    events = _events(run)
    out = []
    for task, _lane in c.manifest_tasks(run.get("manifest")):
        tid = task["id"]
        launch = c.task_launch(run, tid)
        result_status = c.task_status(launch, tid) if launch is not None else None
        # The ledger's state, sourced at the task's last blocked (or settled)
        # event, and the result's status, each where it says so.
        for state, event_name, listed in (("blocked", "blocked", blocked), ("deferred", "settled", deferred)):
            sources, reason = [], None
            if tid in listed:
                last = [(e, s) for e, s in events if e.get("task") == tid and e.get("event") == event_name]
                if last:
                    sources.append(last[-1][1])
                    if state == "blocked":
                        reason = _q(last[-1][0].get("reason"), [last[-1][1]], pairs)
            if result_status == state:
                sources.append(_wf_src(launch, "tasks", tid, "status"))
            if sources:
                out.append({"task": tid, "status": state, "reason": reason, "sources": sources})
    return out


def _open_work(run, launch, why, pairs):
    manifest = run.get("manifest") or {}
    excluded = []
    listed = manifest.get("excluded")
    for i, e in enumerate(listed if isinstance(listed, list) else []):
        e = e if isinstance(e, dict) else {}
        source = c.src(run.get("manifest_path"), "#" + _pointer(["excluded", i]))
        excluded.append({"id": e.get("id"), "reason": _q(e.get("reason"), [source], pairs), "sources": [source]})
    out = {"tasks": _open_tasks(run, pairs), "ledger_state": None, "excluded": excluded, "stopped_lanes": None,
           "final": None}
    failed = _status_failure(run)
    if failed is not None:
        out["ledger_state"] = c.ref(None, "unavailable", _ledger_src(run),
                                    "the ledger's blocked and deferred tasks are unknown: %s" % failed)
    if launch is None:
        out["stopped_lanes"] = c.ref(None, "unavailable", [], why)
        out["final"] = c.ref(None, "unavailable", [], why)
        return out
    result = launch.get("result") or {}
    stopped = result.get("stopped_lanes")
    lanes = []
    for i, s in enumerate(stopped if isinstance(stopped, list) else []):
        s = s if isinstance(s, dict) else {}
        source = _wf_src(launch, "stopped_lanes", i)
        lanes.append({"lane": s.get("lane"), "task": s.get("task"), "reason": _q(s.get("reason"), [source], pairs),
                      "sources": [source]})
    if isinstance(stopped, list):
        out["stopped_lanes"] = c.ref(lanes, "present", [_wf_src(launch, "stopped_lanes")])
    else:
        out["stopped_lanes"] = c.ref(None, "unavailable", [_wf_src(launch, "stopped_lanes")],
                                     "the result records no stopped_lanes")
    final = result.get("final")
    if not isinstance(final, dict):
        out["final"] = c.ref(None, "unavailable", [_wf_src(launch, "final")],
                             "the latest launch has no final review result")
        return out
    entries, why = c.read_journal(launch)
    entry = _last_re_review(entries)
    re_review = _re_review(launch, final, entry, why)
    findings = []
    for key, state in (("open", "open"), ("declined", "declined")):
        items = final.get(key)
        for i, f in enumerate(items if isinstance(items, list) else []):
            finding = _finding(f, state, [_wf_src(launch, "final", key, i)], pairs)
            finding["re_review"] = _finding_re_review(f, key, i, launch, entry, why, re_review["value"]["form"], pairs)
            findings.append(finding)
    cannot = final.get("cannot_verify")
    cannot = [_cannot_verify(item, _wf_src(launch, "final", "cannot_verify", i), pairs)
              for i, item in enumerate(cannot if isinstance(cannot, list) else [])]
    # Each minors list is None when the result has no such list (older
    # engines), never [].
    minors = final.get("task_minors_open")
    minors = [_finding(f, "open", [_wf_src(launch, "final", "task_minors_open", i)], pairs)
              for i, f in enumerate(minors)] if isinstance(minors, list) else None
    carried = final.get("carried_minors_open")
    carried = [x for x in carried if isinstance(x, str)] if isinstance(carried, list) else None
    value = {"findings": findings, "re_review": re_review,
             "cannot_verify": [x for x in cannot if x is not None], "task_minors_open": minors,
             "carried_minors_open": carried, "carried_minor_tasks": _carried_tasks(run, carried),
             # Older engines' finals have no open list: its count is unknown, not 0.
             "not_recorded": [key for key in ("open", "declined", "cannot_verify")
                              if not isinstance(final.get(key), list)]}
    out["final"] = c.ref(value, "present", [_wf_src(launch, "final")])
    return out


def _carried_tasks(run, carried):
    """{carried id: task id} for the carried ids a ledger minors snapshot
    (carry-launch's) lists with a task, the latest snapshot that lists each,
    in carried order, keeping only tasks that are manifest task ids; None
    when the result has no carried list."""
    if carried is None:
        return None
    ids = set(t["id"] for t, _lane in c.manifest_tasks(run.get("manifest")))
    found = {}
    for event, _source in reversed(_events(run)):
        if event.get("task") != "_run" or event.get("event") != "minors" or not isinstance(event.get("open"), list):
            continue
        for m in event["open"]:
            if isinstance(m, dict) and m.get("id") in carried and m["id"] not in found \
                    and isinstance(m.get("task"), str) and m["task"]:
                found[m["id"]] = m["task"]
    return {cid: found[cid] for cid in carried if cid in found and found[cid] in ids}


# ---- the sections ----

def run_sections(run, git, head=None, check_verify=run_check_verify, git_note=None):
    """The run-level sections and the run facts (see the module docstring).
    head is the --head ref (after_delivery is None without it)."""
    manifest = run.get("manifest") or {}
    pairs = c.command_pairs(manifest)
    launch, why = c.latest_launch(run)
    order_known = launch is not None
    result = (launch.get("result") if launch is not None else None) or {}

    if launch is None:
        gate = _gate("unavailable", why)
    elif not run.get("ledger"):
        gate = _gate("unavailable", "no ledger in the archive")
    else:
        gate = _normal_gate(check_verify(run, launch))

    verify = result.get("verify")
    delivered = result.get("delivered_sha")
    evidence, rule = evidence_validity(manifest, verify, delivered, gate["status"])
    accepted_events = [(e, s) for e, s in _events(run) if e.get("event") == "accepted"]
    acceptance = result.get("acceptance")
    run_verdict = acceptance.get("status") if isinstance(acceptance, dict) else None
    run_verdict = run_verdict if isinstance(run_verdict, str) else None
    verdict = derive_verdict(run_verdict, gate["status"], evidence, [e for e, _ in accepted_events],
                             delivered, order_known)
    verify_head = verify.get("head") if order_known and isinstance(verify, dict) else None
    facts = {
        "verdict": verdict,
        "gate": gate["status"],
        "evidence": evidence,
        "evidence_rule": rule,
        "verify_head": verify_head if isinstance(verify_head, str) else None,
        "accepted_run": verdict in ("accepted", "accepted by user"),
        "order_known": order_known,
    }
    want = expected_checks(manifest)
    recorded, missing = _recorded(run)
    return {
        "launches": {"latest": launch["wf"] if launch is not None else None, "order": why,
                     "entries": _launches(run, pairs), "recorded": recorded, "missing": missing},
        "code_outside_ranges": _code_outside(run, git, git_note, launch, why, pairs),
        "checks": _checks(run, launch, why, gate, evidence, rule, want),
        "acceptance": _acceptance(run, launch, why, facts, gate, evidence, rule, accepted_events, pairs),
        "after_delivery": _after_delivery(git, git_note, launch, why, head),
        "open_work": _open_work(run, launch, why, pairs),
        "facts": facts,
    }
