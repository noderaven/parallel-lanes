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
"verify_head", "accepted_run", "order_known"}) are the run facts the
per-task sections take.

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

start_point(run) is the run's start point: the earliest setup run_started
head (ledger status' start_points.prelude), else the base of the first task,
in manifest run order, with a recorded range; with its ledger source. When
'ledger status' failed on an archived ledger, code_outside_ranges names that
failure instead of "no start point recorded", and open_work.ledger_state is
unavailable with it (else ledger_state is None), so the tasks the ledger
lists as blocked or deferred count as a gap rather than as absent.

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

SCRIPTS = os.path.dirname(os.path.realpath(__file__))

GATES = ("match", "not_required", "missing", "stale", "mismatch", "invalid", "unavailable", "checker_error")
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
            return "accepted (gate unavailable)"
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


# ---- code outside recorded task ranges ----

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
    match = re.match(r"(\d+(?:\.\d+)*)", text) if isinstance(text, str) else None
    if match is None:
        return None, source
    return tuple(int(x) for x in match.group(1).split(".")), source


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
            heads.append((head, c.src("transcript:%s/%s" % (launch["wf"], label))))
    return heads


def _re_review_head(launch):
    """(head, source) of the last 'final re-review' structured result that
    records a head (a budget retry included), when that result is a valid
    review: an object with a string head and results and new_findings
    lists (spec 5.5). False when the last result that records a head is not
    valid: it covers nothing, and no head-less rule may stand in for it.
    None when no result records a head."""
    found = None
    for entry in c.structured_results(launch):
        label, result = entry["label"], entry["result"]
        if label not in ("final re-review", "final re-review retry"):
            continue
        head = result.get("head") if isinstance(result, dict) else None
        if isinstance(head, str) and head:
            valid = isinstance(result.get("results"), list) and isinstance(result.get("new_findings"), list)
            found = (head, c.src("transcript:%s/%s" % (launch["wf"], label))) if valid else False
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
            entry["coverage"] = c.ref("final review", "present", [lens_hit[1], c.src("git:" + lens_hit[0])])
        elif rr and git.is_ancestor(sha, rr[0]):
            entry["coverage"] = c.ref("final re-review", "inferred", [rr[1]])
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
    return out


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
    value = {"checked_sha": e2e.get("checked_sha"), "items": len(items),
             "failed": sum(1 for i in items if not (isinstance(i, dict) and i.get("result") == "PASS"))}
    delivered = result.get("delivered_sha")
    if isinstance(delivered, str) and e2e.get("checked_sha") == delivered:
        return c.ref(value, "present", [source])
    return c.ref(value, "stale", [source], "the end-to-end check covered %s, not the delivered %s"
                 % (e2e.get("checked_sha"), delivered))


# ---- acceptance ----

def _acceptance(run, launch, why, facts, gate, evidence, rule, accepted_events, pairs):
    out = {"run_verdict": None, "reasons": [], "warnings": [], "gate": gate["status"], "evidence": evidence,
           "overrides": [], "verdict": None, "verdict_rule": None, "run_ended": [], "delivered_sha": None}
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
    findings = []
    for key, state in (("open", "open"), ("declined", "declined")):
        items = final.get(key)
        for i, f in enumerate(items if isinstance(items, list) else []):
            findings.append(_finding(f, state, [_wf_src(launch, "final", key, i)], pairs))
    cannot = final.get("cannot_verify")
    cannot = [_cannot_verify(item, _wf_src(launch, "final", "cannot_verify", i), pairs)
              for i, item in enumerate(cannot if isinstance(cannot, list) else [])]
    minors = final.get("task_minors_open")
    minors = [_finding(f, "open", [_wf_src(launch, "final", "task_minors_open", i)], pairs)
              for i, f in enumerate(minors if isinstance(minors, list) else [])]
    value = {"findings": findings, "cannot_verify": [x for x in cannot if x is not None], "task_minors_open": minors}
    out["final"] = c.ref(value, "present", [_wf_src(launch, "final")])
    return out


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
        "verify_head": verify_head if isinstance(verify_head, str) else None,
        "accepted_run": verdict in ("accepted", "accepted by user"),
        "order_known": order_known,
    }
    want = expected_checks(manifest)
    return {
        "launches": {"latest": launch["wf"] if launch is not None else None, "order": why,
                     "entries": _launches(run, pairs)},
        "code_outside_ranges": _code_outside(run, git, git_note, launch, why, pairs),
        "checks": _checks(run, launch, why, gate, evidence, rule, want),
        "acceptance": _acceptance(run, launch, why, facts, gate, evidence, rule, accepted_events, pairs),
        "after_delivery": _after_delivery(git, git_note, launch, why, head),
        "open_work": _open_work(run, launch, why, pairs),
        "facts": facts,
    }
