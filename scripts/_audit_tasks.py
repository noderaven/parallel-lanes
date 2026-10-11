"""The per-task sections of scripts/audit.

Import with:
    sys.dont_write_bytecode = True
    sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
    import _audit_tasks

task_sections(run, git, facts, pairs, git_note=None) returns one dict per
_audit_core.manifest_tasks entry, in run order (prelude, lanes, join):
{"id", "lane", "requirement", "placement", "changes", "commits", "review",
"status"}.

run is _audit_core.load_run's dict, git an _audit_git.Git or None, pairs
_audit_core.command_pairs(manifest), and facts the run-level facts:
{"verdict", "gate", "evidence", "verify_head", "accepted_run",
"order_known"}. Without git every git fact is unavailable, its note
git_note, or "no --repo" when git_note is None.

Every derived value is an _audit_core.ref, and every recorded text an
_audit_core.quote (configured commands become <check:<id>>). A task's
ledger events are the ledger lines whose event names it, in ledger order
(files by name, then lines), which is also the order ledger status reads
them in. Sources under the ledger are relative to the run folder, with the
ledger dir as their first part (for example p.t1.ledger/briefs/A1.md).

  requirement  section_hash (_brief.section_sha256 of the archived plan
               copy), brief_hash (the latest review's brief_sha256 against
               it: present, stale, or unavailable when either is missing),
               brief_file (briefs/<id>.md, "latest regeneration, not
               hashed"), plan_hash and spec_hash (one ref per setup
               run_started event: its recorded hash against the archived
               copy's sha256).
  placement    lane, depends_on, and preflight_context: per launch, the
               result's preflight.undeclared entries naming the task, with
               'what' quoted ("context added by pre-flight (not ordering)";
               no such key is unavailable).
  changes      rulings (quoted, with by), events (blocked, settled and
               reopened, reasons quoted), carry (ledger status), launch_notes
               (args.notes[id] per launch, quoted; carry is true only when
               the text equals the task's carry text), deferred (ledger
               status) and escalations (per launch: _transcripts.escalations
               over the archived transcripts; unavailable for a launch
               without transcripts, or whose dir sits in a
               <session>/subagents/workflows layout, where _transcripts
               would read a session-level result outside the run folder).
  commits      entries: each committed and settled event as recorded, with
               commits (git range_commits(base, head): missing when the range
               does not resolve) and files (git changed_files(base, head));
               legacy (tasks in ledger status' legacy list, else None): the
               events' commits lists beside the result's [base, head], which
               agree when the last recorded commit is the result's head and,
               with git, every recorded commit lies in rev_list(head, [base]).
  review       reviews (one per reviewed event, with spec_match), packages
               (<ledger>/reviews/<id>-*), verdicts (from the journal's
               '<id> review' and '<id> re-review <n>' structured results, a
               trailing ' retry' being the same round with the later result
               kept: only the verdict and the count of findings, inferred)
               and approval (by event order: a reviewed event approves its
               head, a later reopened withdraws it, a later committed event
               with another head makes it stale).
  status       committed, reviewed, verified, accepted and result_status, as
               in the spec's table.

spec_match compares a review's spec_sha256 with the sha256 of the archived
spec copy, else with the spec_sha256 of the latest setup run_started event
before the review in ledger order; it is unavailable when the review
recorded none ("recorded before 1.4.4") or there is nothing to compare.
"""

import hashlib
import os
import re
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import _audit_core as core  # noqa: E402
import _brief  # noqa: E402
import _transcripts  # noqa: E402

NO_REPO = "no --repo"
PREFLIGHT_LABEL = "context added by pre-flight (not ordering)"
TRANSITIONS = ("committed", "settled")
UNREVIEWED_STATUSES = ("skipped", "not_run")

ref = core.ref
src = core.src


def _pointer_key(key):
    return str(key).replace("~", "~0").replace("/", "~1")


def _line_src(le):
    return src(le["file"], "L%d" % le["line"])


def _wf_file(launch):
    return launch["wf"] + ".json"


def _read_text(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except (OSError, UnicodeDecodeError):
        return None


def _file_sha256(path):
    try:
        with open(path, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()
    except OSError:
        return None


def _is_sha_pair(value):
    return isinstance(value, list) and len(value) == 2 and all(isinstance(v, str) and v for v in value)


def _task_pointer(manifest, task_id):
    """The JSON pointer of task_id's entry in the manifest, or None."""
    m = manifest if isinstance(manifest, dict) else {}

    def find(items, prefix):
        for i, t in enumerate(items if isinstance(items, list) else []):
            if isinstance(t, dict) and t.get("id") == task_id:
                return "%s/%d" % (prefix, i)
        return None

    found = find(m.get("prelude"), "#/prelude")
    lanes = m.get("lanes")
    for li, lane in enumerate(lanes if isinstance(lanes, list) else []):
        if found is None and isinstance(lane, dict):
            found = find(lane.get("tasks"), "#/lanes/%d/tasks" % li)
    return found if found is not None else find(m.get("join"), "#/join")


def _event_head(ev):
    """A committed or settled event's head: its head, else (legacy) its last
    commits entry, else None."""
    head = ev.get("head")
    if isinstance(head, str) and head:
        return head
    commits = ev.get("commits")
    if isinstance(commits, list) and commits and isinstance(commits[-1], str):
        return commits[-1]
    return None


class _Ctx(object):
    """What every task of one run shares."""

    def __init__(self, run, git, facts, pairs, git_note):
        self.run = run
        self.folder = run["folder"]
        self.manifest = run.get("manifest") or {}
        self.git = git
        self.facts = facts if isinstance(facts, dict) else {}
        self.pairs = pairs
        self.git_note = git_note if git_note is not None else NO_REPO
        self.ledger = run.get("ledger")
        self.status = run.get("ledger_status")
        self.status_note = run.get("ledger_status_error") or "no ledger status"
        self.lines = [le for le in run.get("ledger_lines") or [] if isinstance(le.get("event"), dict)]
        self.setups = [le for le in self.lines
                       if le["event"].get("event") == "run_started" and le["event"].get("phase") == "setup"]
        self.plan_path = run.get("plan_path")
        self.spec_path = run.get("spec_path")
        self.plan_text = _read_text(os.path.join(self.folder, self.plan_path)) if self.plan_path else None
        self.plan_sha = _file_sha256(os.path.join(self.folder, self.plan_path)) if self.plan_path else None
        self.spec_sha = _file_sha256(os.path.join(self.folder, self.spec_path)) if self.spec_path else None
        self.escalations = {}  # wf -> ([entry], [earlier tier or None]) or a reason

    def quote(self, text, sources):
        return core.quote(text, sources, self.pairs)

    def ledger_src(self):
        return [src(self.ledger)] if self.ledger else []

    def ledger_rel(self, *parts):
        return "/".join((self.ledger,) + parts)

    def launch_escalations(self, launch):
        wf = launch["wf"]
        if wf not in self.escalations:
            self.escalations[wf] = self._escalations(launch)
        return self.escalations[wf]

    def _escalations(self, launch):
        if not launch.get("has_transcripts") or not launch.get("dir"):
            return "no transcripts archived"
        for path in (os.path.abspath(launch["dir"]), os.path.realpath(launch["dir"])):
            parent = os.path.dirname(path.rstrip("/\\"))
            if os.path.basename(parent) == "workflows" and \
                    os.path.basename(os.path.dirname(parent)) == "subagents":
                return ("the launch dir sits in a subagents/workflows layout, where reading its "
                        "transcripts would read a session-level result outside the run folder")
        entries = [e for _m, e in _transcripts.agent_entries(launch["dir"], self.manifest)]
        return entries, _transcripts.escalations(entries)


# ---- requirement ----

def _section_hash(ctx, task_id):
    if ctx.plan_path is None:
        return ref(None, "unavailable", [], "no plan copy archived")
    if ctx.plan_text is None:
        return ref(None, "unavailable", [src(ctx.plan_path)], "the plan copy could not be read")
    try:
        return ref(_brief.section_sha256(ctx.plan_text, task_id), "present", [src(ctx.plan_path)])
    except _brief.BriefError as e:
        return ref(None, "missing", [src(ctx.plan_path)], "the plan copy has no usable section: %s" % e)


def _brief_hash(section, reviews):
    if not reviews:
        return ref(None, "unavailable", [], "no review recorded")
    le = reviews[-1]
    recorded = le["event"].get("brief_sha256")
    sources = [_line_src(le)]
    if not isinstance(recorded, str):
        return ref(None, "unavailable", sources, "the review recorded no brief hash")
    if section["value"] is None:
        return ref(recorded, "unavailable", sources, "no plan section to compare")
    sources += section["sources"]
    if recorded == section["value"]:
        return ref(recorded, "present", sources)
    return ref(recorded, "stale", sources, "the review approved another version of the task's plan section")


def _brief_file(ctx, task_id):
    if not ctx.ledger:
        return ref(None, "unavailable", [], "no ledger")
    rel = ctx.ledger_rel("briefs", task_id + ".md")
    if os.path.isfile(os.path.join(ctx.folder, rel)):
        return ref(rel, "present", [src(rel)], "latest regeneration, not hashed")
    return ref(rel, "unavailable", [src(rel)], "no brief file archived (latest regeneration, not hashed)")


def _input_hashes(ctx, key, copy_path, copy_sha, what):
    if not ctx.setups:
        return [ref(None, "unavailable", ctx.ledger_src(), "no setup run_started recorded")]
    out = []
    for le in ctx.setups:
        ev = le["event"]
        sources = [_line_src(le)]
        if key not in ev:
            out.append(ref(None, "unavailable", sources, "the launch recorded no %s hash" % what))
            continue
        recorded = ev[key]
        if copy_path:
            sources.append(src(copy_path))
        if recorded is None:
            if copy_sha is None:
                out.append(ref(None, "present", sources, "the launch recorded no %s" % what))
            else:
                out.append(ref(None, "stale", sources, "the launch recorded no %s, but the archive holds one" % what))
        elif copy_sha is None:
            out.append(ref(recorded, "unavailable", sources, "no %s copy archived to compare" % what))
        elif recorded == copy_sha:
            out.append(ref(recorded, "present", sources))
        else:
            out.append(ref(recorded, "stale", sources, "the archived %s copy differs from this launch's" % what))
    return out


def _requirement(ctx, task_id, events):
    section = _section_hash(ctx, task_id)
    reviews = [le for le in events if le["event"].get("event") == "reviewed"]
    return {
        "section_hash": section,
        "brief_hash": _brief_hash(section, reviews),
        "brief_file": _brief_file(ctx, task_id),
        "plan_hash": _input_hashes(ctx, "plan_sha256", ctx.plan_path, ctx.plan_sha, "plan"),
        "spec_hash": _input_hashes(ctx, "spec_sha256", ctx.spec_path, ctx.spec_sha, "spec"),
    }


# ---- placement ----

def _placement(ctx, task, lane, pointer):
    manifest_path = ctx.run.get("manifest_path")
    where = [src(manifest_path, pointer)] if manifest_path else []
    deps = task.get("depends_on")
    ids = []
    for d in deps if isinstance(deps, list) else []:
        if isinstance(d, str):
            ids.append(d)
        elif isinstance(d, dict) and isinstance(d.get("id"), str):
            ids.append(d["id"])
    dep_src = [src(manifest_path, pointer + "/depends_on")] if manifest_path and "depends_on" in task else where
    launches = []
    for launch in ctx.run.get("launches") or []:
        wf_file = _wf_file(launch)
        result = launch.get("result")
        pre = result.get("preflight") if isinstance(result, dict) else None
        undeclared = pre.get("undeclared") if isinstance(pre, dict) else None
        if result is None:
            entries = ref(None, "unavailable", [src(wf_file)], "no result recorded")
        elif not isinstance(undeclared, list):
            entries = ref(None, "unavailable", [src(wf_file)], "no preflight.undeclared recorded (before r131)")
        else:
            items = []
            for k, e in enumerate(undeclared):
                if isinstance(e, dict) and e.get("task") == task["id"]:
                    at = src(wf_file, "#/result/preflight/undeclared/%d" % k)
                    items.append({"producer": e.get("producer"), "what": ctx.quote(e.get("what"), [at])})
            entries = ref(items, "present", [src(wf_file, "#/result/preflight/undeclared")])
        launches.append({"wf": launch["wf"], "entries": entries})
    if not launches:
        launches.append({"wf": None, "entries": ref(None, "unavailable", [], "no launch")})
    return {
        "lane": ref(lane, "present", where),
        "depends_on": ref(ids, "present", dep_src),
        "preflight_context": {"label": PREFLIGHT_LABEL, "launches": launches},
    }


# ---- changes ----

def _changes(ctx, task_id, events, carry_text):
    rulings, recorded = [], []
    for le in events:
        ev = le["event"]
        kind = ev.get("event")
        at = [_line_src(le)]
        if kind == "ruling":
            rulings.append(ref({"text": ctx.quote(ev.get("text"), at), "by": ev.get("by")}, "present", at))
        elif kind in ("blocked", "settled", "reopened"):
            value = {"event": kind}
            if kind == "settled":
                value.update({"outcome": ev.get("outcome"), "base": ev.get("base"), "head": ev.get("head")})
            if isinstance(ev.get("reason"), str):
                value["reason"] = ctx.quote(ev["reason"], at)
            recorded.append(ref(value, "present", at))

    if ctx.status is None:
        carry = ref(None, "unavailable", ctx.ledger_src(), ctx.status_note)
        deferred = ref(None, "unavailable", ctx.ledger_src(), ctx.status_note)
    else:
        if carry_text is None:
            carry = ref(None, "present", ctx.ledger_src(), "no carry")
        else:
            lines = [le for le in events if le["event"].get("event") == "ruling"
                     and le["event"].get("by") == "adjudicator" and le["event"].get("text") == carry_text]
            at = [_line_src(lines[-1])] if lines else ctx.ledger_src()
            carry = ref(ctx.quote(carry_text, at), "present", at)
        is_deferred = task_id in (ctx.status.get("deferred") or [])
        transitions = [le for le in events if le["event"].get("event") in TRANSITIONS]
        at = [_line_src(transitions[-1])] if is_deferred and transitions else ctx.ledger_src()
        deferred = ref(is_deferred, "present", at)

    notes = []
    for launch in ctx.run.get("launches") or []:
        wf_file = _wf_file(launch)
        data = launch.get("data")
        args = data.get("args") if isinstance(data, dict) else None
        if data is None:
            notes.append(ref({"wf": launch["wf"], "note": None, "carry": None}, "unavailable",
                             [src(wf_file)], "no result file"))
            continue
        if not isinstance(args, dict):
            notes.append(ref({"wf": launch["wf"], "note": None, "carry": None}, "unavailable",
                             [src(wf_file)], "no args recorded"))
            continue
        text = args.get("notes").get(task_id) if isinstance(args.get("notes"), dict) else None
        if isinstance(text, str):
            at = [src(wf_file, "#/args/notes/%s" % _pointer_key(task_id))]
            notes.append(ref({"wf": launch["wf"], "note": ctx.quote(text, at),
                              "carry": carry_text is not None and text == carry_text}, "present", at))

    escalations = []
    for launch in ctx.run.get("launches") or []:
        found = ctx.launch_escalations(launch)
        if isinstance(found, str):
            escalations.append({"wf": launch["wf"], "escalations": ref(None, "unavailable", [], found)})
            continue
        entries, earlier = found
        items, sources = [], []
        for entry, prev in zip(entries, earlier):
            if prev is not None and entry.get("task") == task_id:
                items.append({"label": entry["label"], "from_tier": prev, "to_tier": entry["tier"]})
                sources.append(src("transcript:%s/%s" % (launch["wf"], entry["label"])))
        escalations.append({"wf": launch["wf"],
                            "escalations": ref(items, "present", sources or [src(launch["wf"])])})

    return {
        "rulings": rulings,
        "events": recorded,
        "carry": carry,
        "launch_notes": notes,
        "deferred": deferred,
        "escalations": escalations,
    }


# ---- commits ----

def _git_ref(ctx, at, base, head, fetch, missing_note):
    if not (isinstance(base, str) and base and isinstance(head, str) and head):
        return ref(None, "unavailable", at, "the event records no base")
    if ctx.git is None:
        return ref(None, "unavailable", at, ctx.git_note)
    value = fetch(base, head)
    if value is None:
        return ref(None, "missing", at, missing_note)
    return ref(value, "present", at + [src("git:" + head, head)])


def _legacy(ctx, task_id, events, result_launch):
    committed = [le for le in events if le["event"].get("event") == "committed"]
    recorded = [{"commits": le["event"].get("commits"), "line": _line_src(le)} for le in committed]
    pair = None
    if result_launch is not None:
        pair = (result_launch["result"]["tasks"][task_id] or {}).get("commits")
    if not _is_sha_pair(pair):
        result = ref(None, "unavailable", [src(_wf_file(result_launch))] if result_launch else [],
                     "the result records no [base, head]")
        agreement = ref(None, "unavailable", [], "the result records no [base, head]")
        return {"recorded": recorded, "result": result, "agreement": agreement}
    at = src(_wf_file(result_launch), "#/result/tasks/%s/commits" % _pointer_key(task_id))
    result = ref(pair, "present", [at])
    if not committed:
        return {"recorded": recorded, "result": result,
                "agreement": ref(None, "unavailable", [at], "no committed event recorded")}
    sources = [_line_src(committed[-1]), at]
    last = _event_head(committed[-1]["event"])
    if last != pair[1]:
        agreement = ref(False, "conflicting", sources,
                        "the last recorded commit %s is not the result's head %s" % (last, pair[1]))
    elif ctx.git is None:
        agreement = ref(True, "present", sources, "agree by head; the range is not checked: %s" % ctx.git_note)
    else:
        within = ctx.git.rev_list(pair[1], [pair[0]])
        if within is None:
            agreement = ref(None, "missing", sources, "the result's range does not resolve in the repo")
        else:
            inside = set(within)
            outside = [c for le in committed for c in le["event"].get("commits") or [] if c not in inside]
            if outside:
                agreement = ref(False, "conflicting", sources + [src("git:" + pair[1], pair[1])],
                                "recorded commits outside the result's range: %s" % ", ".join(outside))
            else:
                agreement = ref(True, "present", sources + [src("git:" + pair[1], pair[1])])
    return {"recorded": recorded, "result": result, "agreement": agreement}


def _commits(ctx, task_id, events, is_legacy, result_launch):
    entries = []
    for le in events:
        ev = le["event"]
        if ev.get("event") not in TRANSITIONS:
            continue
        at = [_line_src(le)]
        base, head = ev.get("base"), ev.get("head")
        git = ctx.git
        entries.append({
            "event": ev.get("event"),
            "base": base,
            "head": head,
            "recorded": ev.get("commits"),
            "line": at[0],
            "commits": _git_ref(ctx, at, base, head, git.range_commits if git else None,
                                "the range does not resolve in the repo"),
            "files": _git_ref(ctx, at, base, head, git.changed_files if git else None,
                              "git could not list the changed files"),
        })
    return {"entries": entries, "legacy": _legacy(ctx, task_id, events, result_launch) if is_legacy else None}


# ---- review ----

def _ledger_order(le):
    """Ledger order: files by name, then physical lines (load_run's order)."""
    return (le["file"], le["line"])


def _spec_match(ctx, le):
    ev = le["event"]
    at = [_line_src(le)]
    if "spec_sha256" not in ev:
        return ref(None, "unavailable", at, "recorded before 1.4.4")
    recorded = ev["spec_sha256"]
    if ctx.spec_sha is not None:
        want, sources = ctx.spec_sha, at + [src(ctx.spec_path)]
    else:
        before = [s for s in ctx.setups
                  if _ledger_order(s) < _ledger_order(le) and "spec_sha256" in s["event"]]
        if not before:
            return ref(recorded, "unavailable", at, "no archived spec copy and no launch spec hash to compare")
        want, sources = before[-1]["event"]["spec_sha256"], at + [_line_src(before[-1])]
    if recorded == want:
        return ref(recorded, "present", sources)
    return ref(recorded, "stale", sources, "the review read another spec than the run's")


def _review_label(task_id):
    return re.compile(r"^%s (review|re-review \d+)( retry)?$" % re.escape(task_id))


def _verdicts(ctx, task_id):
    pattern = _review_label(task_id)
    out = []
    for launch in ctx.run.get("launches") or []:
        journal = os.path.join(launch["dir"], "journal.jsonl") if launch.get("dir") else None
        if journal is None or not os.path.isfile(journal):
            status = core.task_status(launch, task_id)
            if launch.get("result") is None or (status is not None and status not in UNREVIEWED_STATUSES):
                out.append(ref(None, "unavailable", [src(_wf_file(launch))], "no journal archived for %s" % launch["wf"]))
            continue
        rounds, order = {}, []
        for entry in core.structured_results(launch):
            label = entry.get("label")
            match = pattern.match(label) if isinstance(label, str) else None
            if not match:
                continue
            base = label[:-len(" retry")] if match.group(2) else label
            kept = rounds.get(base)
            if kept is None:
                order.append(base)
            if kept is None or isinstance(entry.get("result"), dict) or not isinstance(kept.get("result"), dict):
                rounds[base] = entry
        for base in order:
            entry = rounds[base]
            result = entry.get("result")
            at = [src("transcript:%s/%s" % (launch["wf"], entry["label"]))]
            if not isinstance(result, dict):
                out.append(ref({"wf": launch["wf"], "label": base, "verdict": None, "findings": None},
                               "unavailable", at, "no structured result"))
                continue
            findings = result.get("findings")
            out.append(ref({"wf": launch["wf"], "label": base, "verdict": result.get("verdict"),
                            "findings": len(findings) if isinstance(findings, list) else None}, "inferred", at))
    return out


def _packages(ctx, task_id):
    if not ctx.ledger:
        return ref(None, "unavailable", [], "no ledger")
    rel = ctx.ledger_rel("reviews")
    path = os.path.join(ctx.folder, rel)
    if not os.path.isdir(path):
        return ref(None, "unavailable", [src(rel)], "no reviews dir archived")
    names = sorted(n for n in os.listdir(path)
                   if n.startswith(task_id + "-") and os.path.isfile(os.path.join(path, n)))
    paths = [ctx.ledger_rel("reviews", n) for n in names]
    return ref(paths, "present", [src(p) for p in paths] or [src(rel)])


def _approval(events):
    """The approval standing after the task's events, by event order, or None:
    {"head", "line", "withdrawn_by", "stale_by"}."""
    approval = None
    for le in events:
        ev = le["event"]
        kind = ev.get("event")
        if kind == "reviewed":
            approval = {"head": ev.get("head"), "line": _line_src(le), "withdrawn_by": None, "stale_by": None}
        elif approval is None:
            continue
        elif kind == "reopened" and approval["withdrawn_by"] is None:
            approval["withdrawn_by"] = _line_src(le)
        elif kind == "committed" and approval["stale_by"] is None and approval["head"] is not None \
                and _event_head(ev) != approval["head"]:
            approval["stale_by"] = _line_src(le)
    return approval


def _review(ctx, task_id, events):
    reviews = []
    for le in events:
        ev = le["event"]
        if ev.get("event") != "reviewed":
            continue
        reviews.append({
            "rounds": ev.get("rounds"),
            "head": ev.get("head"),
            "brief_sha256": ev.get("brief_sha256"),
            "spec_sha256": ev.get("spec_sha256"),
            "line": _line_src(le),
            "spec_match": _spec_match(ctx, le),
        })
    return {
        "reviews": reviews,
        "packages": _packages(ctx, task_id),
        "verdicts": _verdicts(ctx, task_id),
        "approval": _approval(events),
    }


# ---- status ----

def _blocked_after(events):
    """The last blocked event after the task's last committed or settled
    event (all its events when it has none), or None."""
    found = None
    for le in events:
        kind = le["event"].get("event")
        if kind in TRANSITIONS:
            found = None
        elif kind == "blocked":
            found = le
    return found


def _committed_status(ctx, events):
    if not ctx.ledger:
        return ref(None, "unavailable", [], "no ledger")
    committed = [le for le in events if le["event"].get("event") == "committed"]
    return ref(bool(committed), "present", [_line_src(committed[-1])] if committed else ctx.ledger_src())


def _reviewed_status(ctx, events, approval):
    if not ctx.ledger:
        return ref(None, "unavailable", [], "no ledger")
    transitions = [le for le in events if le["event"].get("event") in TRANSITIONS]
    if transitions and transitions[-1]["event"].get("event") == "settled":
        last = transitions[-1]
        return ref("settled", "present", [_line_src(last)],
                   "settled by adjudicator (%s)" % last["event"].get("outcome"))
    committed = [le for le in events if le["event"].get("event") == "committed"]
    if not committed:
        return ref(False, "present", ctx.ledger_src(), "not committed")
    last = committed[-1]
    last_head = _event_head(last["event"])
    sources = [_line_src(last)]
    if approval is None:
        return ref(False, "missing", sources, "no review recorded")
    sources = [approval["line"]] + sources
    if approval["withdrawn_by"] is not None:
        return ref(False, "stale", sources + [approval["withdrawn_by"]], "reopened after its review")
    if approval["head"] is None:
        return ref(None, "unavailable", sources, "review recorded no head")
    if approval["stale_by"] is not None or approval["head"] != last_head:
        return ref(False, "stale", sources,
                   "the review approved %s, not the last committed head %s" % (approval["head"], last_head))
    return ref(True, "present", sources)


def _verified_status(ctx, task_head, head_src):
    f = ctx.facts
    evidence = f.get("evidence")
    if evidence == "not_required":
        return ref("not_required", "present", [], "the manifest configures no test, lint or build command")
    if not f.get("order_known"):
        return ref(None, "unavailable", [], "launch order unknown")
    if evidence == "invalid":
        return ref(False, "present", [], "the verify evidence is invalid")
    if evidence != "valid":
        return ref(None, "unavailable", [], "the verify evidence is %s" % (evidence,))
    if ctx.git is None:
        return ref(None, "unavailable", [], ctx.git_note)
    verify_head = f.get("verify_head")
    if not verify_head:
        return ref(None, "unavailable", [], "no verify head")
    if task_head is None:
        return ref(None, "unavailable", head_src, "the task recorded no head")
    sources = head_src + [src("git:" + verify_head, verify_head)]
    contained = ctx.git.is_ancestor(task_head, verify_head)
    if contained is None:
        return ref(None, "unavailable", sources, "the repo cannot tell whether the verify head contains the task head")
    if contained:
        return ref(True, "present", sources)
    return ref(False, "present", sources, "the verify head does not contain the task head")


def _accepted_status(ctx, events, result_status):
    f = ctx.facts
    if f.get("verdict") == "unavailable":
        return ref(None, "unavailable", [], "the run verdict is unavailable")
    transitions = [le for le in events if le["event"].get("event") in TRANSITIONS]
    settled = bool(transitions) and transitions[-1]["event"].get("event") == "settled"
    blocked = _blocked_after(events)
    sources = list(result_status["sources"][:1])
    if not f.get("accepted_run"):
        return ref(False, "present", sources, "the run is not accepted")
    if result_status["value"] != "done":
        return ref(False, "present", sources, "the result does not report the task done")
    if settled or blocked:
        return ref(False, "present", sources + [_line_src(transitions[-1] if settled else blocked)],
                   "the task is settled" if settled else "the task is blocked")
    return ref(True, "present", sources)


def _result_status(ctx, task_id, events, is_legacy):
    launch = core.task_launch(ctx.run, task_id)
    if launch is None:
        for candidate in reversed(ctx.run.get("launches") or []):
            if core.task_status(candidate, task_id) is not None:
                launch = candidate
                break
    if launch is None:
        return ref(None, "unavailable", [], "no launch result reports this task")
    status = core.task_status(launch, task_id)
    key = _pointer_key(task_id)
    sources = [src(_wf_file(launch), "#/result/tasks/%s/status" % key)]
    if not ctx.ledger:
        return ref(status, "present", sources)
    kinds = [le["event"].get("event") for le in events]
    transitions = [le for le in events if le["event"].get("event") in TRANSITIONS]
    conflicts, ledger_src = [], []
    if status == "done" and not transitions:
        conflicts.append("the result says done; the ledger records no committed or settled event")
        ledger_src = ctx.ledger_src()
    if status == "not_run" and "committed" in kinds:
        conflicts.append("the result says not_run; the ledger records a committed event")
        ledger_src = [_line_src([le for le in events if le["event"].get("event") == "committed"][-1])]
    st = ctx.status or {}
    for item in st.get("inconsistent") or []:
        if isinstance(item, dict) and item.get("task") == task_id:
            conflicts.append("the ledger is inconsistent: %s" % item.get("reason"))
            ledger_src = ledger_src or ctx.ledger_src()
    recorded = (st.get("ranges") or {}).get(task_id)
    pair = (launch["result"]["tasks"][task_id] or {}).get("commits")
    if not is_legacy and isinstance(recorded, dict) and _is_sha_pair(pair) and transitions \
            and [recorded.get("base"), recorded.get("head")] != pair:
        conflicts.append("the result's range %s..%s is not the recorded range %s..%s"
                         % (pair[0], pair[1], recorded.get("base"), recorded.get("head")))
        sources.append(src(_wf_file(launch), "#/result/tasks/%s/commits" % key))
        for le in (transitions[0], transitions[-1]):
            if _line_src(le) not in ledger_src:
                ledger_src.append(_line_src(le))
    if conflicts:
        return ref(status, "conflicting", sources + ledger_src, "; ".join(conflicts))
    note = None
    if status == "blocked" and "committed" in kinds and _blocked_after(events) is not None:
        note = "committed, blocked, unapproved"
    return ref(status, "present", sources, note)


# ---- the sections ----

def task_sections(run, git, facts, pairs, git_note=None):
    ctx = _Ctx(run, git, facts, pairs, git_note)
    out = []
    for task, lane in core.manifest_tasks(ctx.manifest):
        task_id = task["id"]
        events = [le for le in ctx.lines if le["event"].get("task") == task_id]
        is_legacy = task_id in (ctx.status.get("legacy") or []) if ctx.status is not None else \
            any(le["event"].get("event") == "committed" and "base" not in le["event"] for le in events)
        carry_text = (ctx.status.get("carry") or {}).get(task_id) if ctx.status is not None else None
        result_status = _result_status(ctx, task_id, events, is_legacy)
        review = _review(ctx, task_id, events)

        transitions = [le for le in events if le["event"].get("event") in TRANSITIONS]
        task_head = _event_head(transitions[-1]["event"]) if transitions else None
        head_src = [_line_src(transitions[-1])] if transitions else []
        out.append({
            "id": task_id,
            "lane": lane,
            "requirement": _requirement(ctx, task_id, events),
            "placement": _placement(ctx, task, lane, _task_pointer(ctx.manifest, task_id)),
            "changes": _changes(ctx, task_id, events, carry_text),
            "commits": _commits(ctx, task_id, events, is_legacy, core.task_launch(run, task_id)),
            "review": review,
            "status": {
                "committed": _committed_status(ctx, events),
                "reviewed": _reviewed_status(ctx, events, review["approval"]),
                "verified": _verified_status(ctx, task_head, head_src),
                "accepted": _accepted_status(ctx, events, result_status),
                "result_status": result_status,
            },
        })
    return out
