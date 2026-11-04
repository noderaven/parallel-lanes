"""The audit view of an archived run: build, render_md and render_summary.

Import with:
    sys.dont_write_bytecode = True
    sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
    import _audit

build(folder, repo=None, head=None) reads the run folder once
(_audit_core.load_run, which raises _audit_core.OutsideRunFolder for an input
that resolves outside it) and returns

  {"audit_version": 3, "run_id", "repo", "run", "tasks", "gaps",
   "gap_causes"}

run is _audit_run.run_sections without its facts, tasks
_audit_tasks.task_sections, gaps _audit_core.collect_gaps over the rest
(JSON pointers from the document root; one entry per gap value, the length
tool-outcomes prints) and gap_causes _audit_core.gap_causes over the same
(one entry per cause: {"pointer", "state", "note", "tasks", "values"}).
audit_version 2 (1.6.16) added gap_causes and moved the plan and spec
hashes and the plan copy's state from every task to run.checks (plan_hash,
spec_hash, section_hash); 3 (1.6.17) added each task's checks.task_check
and run.checks.task_checks, open_work.final's re_review and each of its
findings' re_review, and cites what the journal records by journal line
(<wf>/journal.jsonl L<n>, present). repo is a ref saying how far the git
facts can be trusted:
  - no repo: unavailable, "no --repo", and every git fact says so;
  - a repo that is not a git repo, or lacks the run's start point
    (_audit_run.start_point): unavailable with open_repo's reason, and every
    git fact carries that reason instead of being read;
  - no start point recorded: the repo is used unchecked, and repo is
    unavailable, "repo not checked against the run";
  - otherwise present, its value the start point the repo contains.
The document holds no timestamp of its own and no absolute path, so the same
inputs give the same bytes wherever the run folder lies.

render_md(audit) is audit.md: its first line is FIRST_LINE, then the
sections Bottom line, Summary, Acceptance, Launches, Tasks (one block per
task), Code outside recorded task ranges, Checks (with the plan and spec
hashes once, each labelled by its setup event, its ledger line among the
sources, and the plan copy for the section hashes), After delivery (only
with --head), Open work, Evidence gaps (under '<G> evidence gap(s) in <C>
cause(s)', one line per cause: '- <pointer> [<state>] - <note> (tasks <id>,
...)', the note as gap_causes gives it (masked when the cause's raw notes
differ), or '(run)' for a run-level cause, '(run: <v>, ...)' with every
value, null as unknown, when it has more than one or a single plain one) and
Terms (TERMS, fixed text). Acceptance names the verdict without the override
when an accepted by user verdict overrode one that differs from the run's
own ('- verdict without the override: <verdict> (<rule>)', the verdict as
the Bottom line names it). The Bottom line is one paragraph, each part from one
value audit computed and none from recorded text: the verdict with why
(_verdict_line: its verdict_rule, else, unavailable, its note, else,
accepted by user, 'over <acceptance.verdict_without_override>[: <its
rule>]' when audit's verdict with no override differs from the run's own
('accepted by user (over unverified: gate mismatch)'), else 'over
<overrode>' (the run's own verdict and reason kinds, as Acceptance computes
them), else the engine's reason kinds for the engine's own verdict;
accepted (gate unavailable) carries run.checks.gate_reason inside its
parenthesis, also after 'over'), ACCEPTED_BY_USER when an override's head
is present (at the delivered sha) and the verdict is not already accepted
by user, the tasks' committed, reviewed, verified and accepted counts of
true values (_task_count: each with '(<k> settled, <k> not required, <k>
unavailable)' for the kinds there are; the summary's tasks line counts the
same way) and the blocked and deferred counts above 0 ('blocked and
deferred unknown' when open_work.ledger_state is set), then '; task checks:
<k> committed after a failed check' when k > 0 (_failed_checks), 'Final
findings: <open> open, <declined> declined; open task minors: <M>' and the
cannot-verify items, the code outside recorded task ranges, the launches
missing from the archive, and '<G> evidence gap(s) in <C> cause(s)' with
NOT_GAPS (the summary's last line before the report path gives the same
counts). The Summary's open work line and the Open work header read
'<open> open and <declined> declined final finding(s), <M> open task
minor(s)': M is open_work.final's task_minors_open plus its
carried_minors_open (_autopsy.open_task_minors), '<M> listed (more may be
missing)' (_autopsy.MINORS_LOWER_BOUND; in the Summary and the header
'<M> open task minor(s) listed (more may be missing)') when a cannot_verify
quote holds _autopsy.MINORS_NOT_REACHED, and unavailable when both lists
are null; open, declined or the cannot-verify items read unavailable when
the result has no such list (open_work.final's not_recorded: older engines
have no open list), and every count when the final review is. Under the
header come the open task minors, then each carried id as '<id> open
(carried minor)'. Each open minor is placed by its id's prefix
(_minor_task: the task id when it starts with a letter, else T<id>; a
carried id's task from the ledger's minors snapshot,
open_work.final.carried_minor_tasks, when it is one of the prefix's tasks;
an exact match over T<id>), and a task block ends with '- open minors:
<id>, ...' for its own; an id that names a batch unit, no task or more than
one task is in no task block, and Open work names it once ('open task
minors in no task block'). Open work also says once 'open task minors:
not recorded by this run's engine' (NOT_RECORDED) when both lists are
null, 'no final review' (NO_FINAL_REVIEW) without one (no launch, or the
latest launch has none; nothing when the launch order is unknown, as the
final review header gives that reason), and for a lower
bound LOWER_BOUND_NOTE (a task with no line has none listed). When
open_work.ledger_state is set, the open work line's task count is
OPEN_TASKS_UNKNOWN and Open work's blocked or deferred tasks read unknown
rather than none. A task block's status lines are committed, reviewed,
verified (_verified_line: for git containment 'its last commit <sha7> is
(not) in the head the delivered verify passed at, <sha7>' instead of its
note), checked before its commit (_task_check_lines, TASK_CHECK; no line for
a task never committed, settled, or committed by an engine before 1.6.0),
accepted and result status. Checks says once 'task checks: not recorded by
this run's engine (before 1.6.0)' for run.checks.task_checks.not_recorded,
with ' for tasks <id>, ...' when they are only some of the committed,
unsettled tasks, and lists its unmatched files. A value is shown as
'<value> [<state>]', with its note after ' - ' and its sources in
parentheses; a review verdict, recorded in the journal, reads '<label> in
<wf>: <verdict>, <n> finding(s)[ (the engine read it as <x>)] [present]
(<wf>/journal.jsonl L<n>)'. Right under the final review line Open work
gives the final re-review line (_re_review_line: 'judged <head7>...', or
RE_REVIEW_FORMS' text), and after each final open or declined finding's
disposition its re-review (_finding_re_review: '- re-review: <status>',
RE_REVIEW_RULES' text, 're-review of <head7>, not the delivered sha
<delivered>: <status>' or 'resolved (the decline upheld)') with the
re-reviewer's evidence quoted; a task minor has none, nor a finding whose
engine recorded no review. Evidence validity invalid by checks_failed reads
'failed checks' (FAILED_CHECKS) on the Acceptance and Checks lines, while
audit.json keeps 'invalid' and the rule. A ruling without by reads 'ruling
by implementer (no role recorded)' (NO_ROLE), the ledger's own rule.
Recorded text appears only as Markdown quote lines ('> '), under a line
naming where it was quoted from; configured commands in it are already
check ids.

render_summary(audit, md_path) is at most 10 lines, the last 'full report:
<md_path>'.
"""

import datetime
import os
import re
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import _audit_core as core  # noqa: E402
import _audit_git  # noqa: E402
import _audit_run  # noqa: E402
import _audit_tasks  # noqa: E402
import _autopsy  # noqa: E402

FIRST_LINE = "This audit holds local paths and recorded text from the run; it is not meant to be shared as-is."
# 2 (1.6.16): gap_causes, and the plan and spec hashes in run.checks.
# 3 (1.6.17): each task's checks.task_check, and run.checks.task_checks;
# open_work.final's re_review and its findings' re_review; journal lines.
AUDIT_VERSION = 3
NO_REPO = "no --repo"
UNCHECKED = "repo not checked against the run"
# A ruling without by, as the ledger counts it (ledger ruling_records).
NO_ROLE = "implementer (no role recorded)"
FAILED_CHECKS = "failed checks"
# The summary's open task count when ledger status failed.
OPEN_TASKS_UNKNOWN = "unknown (ledger status unavailable)"
# The bottom line's last sentence, after the gap count.
NOT_GAPS = "(cannot-verify items and inferred lines are not gaps)"
# Open work's line on the open task minors when the result records neither
# list, or when there is no final review to read.
NOT_RECORDED = "not recorded by this run's engine"
NO_FINAL_REVIEW = "no final review"
# Why an open minor is under Open work only, in no task block.
UNPLACED = "each id names a batch unit, no task, or more than one task"
# Open work's line on the open task minors when their count is a lower bound.
LOWER_BOUND_NOTE = ("a task block with no open minors line has none listed; more may be missing: minors of tasks "
                    "an earlier launch approved")
# A minor id: '<prefix>-<n>' (src/engine.js taskMinorFindings).
MINOR_ID = re.compile(r"^(.+)-[0-9]+$")
LETTER_FIRST = re.compile(r"^[A-Za-z]")
# A task block's line on the task's own check, after verified.
TASK_CHECK = "checked before its commit"
# The verified line's text for git containment (the value and note in
# audit.json are unchanged): '<value> [present] - its last commit <sha7> is
# (not) in the head the delivered verify passed at, <sha7>'.
CONTAINED = "its last commit %s is in the head the delivered verify passed at, %s"
NOT_CONTAINED = "its last commit %s is not in the head the delivered verify passed at, %s"
# Open work's final re-review line for each form but judged.
RE_REVIEW_FORMS = {
    "not_recorded": "per-finding results not recorded by this run's engine",
    "no_valid_result": "no valid result",
    "not_run": "not run",
    "none": "none (no final findings)",
    "unavailable": "unavailable",
}
# A final finding's re-review line for each rule without a status of its own.
RE_REVIEW_RULES = {
    "raised": "raised by the re-review",
    "not_run": "not run",
    "contradictory": "contradictory results",
    "no_result": "no result",
}
# The Terms section: (term, definition), fixed text in this order.
TERMS = (
    ("[present]", "the value is established (from the sources named after it, when there are any). Not a gap."),
    ("[missing]", "evidence the value needs should be in the archive (or the repo) and is not. An evidence gap."),
    ("[stale]", "the evidence is for another revision or an earlier state than the one that counts, such as "
                "checks run before the delivered sha. An evidence gap."),
    ("[conflicting]", "two records of the same fact disagree, such as the result and the ledger. An evidence gap."),
    ("[unavailable]", "the value, or the comparison it needs, cannot be read or derived from what audit was given "
                      "(an older engine, no --repo, no launch or an unknown launch order); it is unknown, never 0 "
                      "or false. An evidence gap."),
    ("[inferred]", "derived from other evidence, such as a commit outside the task ranges that final.head "
                   "contains when the engine (1.2.1 or later) recorded no final re-review head: final re-review "
                   "(no recorded head). Not a gap."),
    ("invalid", "as the gate, check-verify found the result's acceptance, its verify report, the saved "
                "evidence or a recorded sha or time malformed (verify_invalid); as evidence validity, the "
                "verify result breaks the acceptance rule named beside it (checks that ran and failed read "
                "failed checks)."),
    ("verified", "a task against the delivered verify: true when its last commit is in the head the delivered "
                 "verify passed at (git containment, read with --repo); false when it is not, or when the verify "
                 "result breaks an acceptance rule (failed checks included); not_required when the manifest "
                 "configures no test, lint or build command. It is about the run's delivered checks, not the "
                 "task's own check (checked before its commit)."),
    (TASK_CHECK, "the task's own check (scripts/task-checks, engines from 1.6.0), which its implementer runs once "
                 "before committing: the checks it selected, run on the uncommitted working tree against the "
                 "task base, passed, failed, or left no result (an empty file, an unreadable one or an error "
                 "record). It covers that working tree, not the committed code, and no fix commit after it: "
                 "fixers run no task checks. Acceptance does not read it. not_required: the task's commands "
                 "include no test, lint or build command, so the engine asks for none. Known limit: the last "
                 "attempt the archive holds decides."),
    ("round(s)", "the fix rounds a task's review took, as its reviewed event records them, each a fix and a "
                 "re-review; 0 means the review approved with no fix round."),
    ("re-review", "the final re-reviewer's word on one finding, after the final fix, as the launch's journal "
                  "and the result record it: resolved means the defect is gone or the decline is right, not that "
                  "it was fixed; open means it is not; raised by the re-review is a problem the fix introduced. "
                  "The final re-review line counts these words over the final findings."),
    ("task rulings", "the ruling events the ledger records under a task: what an agent decided on the user's "
                     "behalf, quoted, with its role (a ruling without one is the implementer's)."),
    ("run-end rulings", "the rulings a run_ended event counts: the adjudications that ran in that launch, not "
                        "the task rulings."),
    ("gate", "check-verify's archive-mode outcome for the verify evidence: match, not_required, missing, stale, "
             "mismatch, invalid or unavailable, or checker_error when check-verify itself failed."),
    ("carry", "for a task the adjudicator unblocked, the text of its last adjudicator ruling, which the next "
              "launch passes to the task as its note."),
    ("context added by pre-flight", "a producer pre-flight found the task relies on without naming it in its "
                                    "Consumes (the result's preflight.undeclared): its Produces block went into "
                                    "the task's brief; it does not order the task after the producer."),
    ("cause", "gaps that share a pointer (each array index read as N), a state and a note (each sha read as "
              "<sha>, and shown so when the notes differ), listed once under Evidence gaps with the tasks whose "
              "blocks hold them, or, for a run-level cause, with run, followed by every value when there is more "
              "than one or a single string or number."),
)


# ---- build ----

def _open(repo, start, start_src):
    """(git or None, the note git facts carry when git is None, the repo ref)."""
    if repo is None:
        return None, None, core.ref(None, "unavailable", [], NO_REPO)
    git, reason = _audit_git.open_repo(repo, start)
    if git is None:
        return None, reason, core.ref(None, "unavailable", [], reason)
    if start is None:
        return git, None, core.ref(None, "unavailable", [], UNCHECKED)
    sources = ([start_src] if start_src else []) + [core.src("git:" + start, start)]
    return git, None, core.ref(start, "present", sources, "the repo contains the run's start point")


def build(folder, repo=None, head=None):
    run = core.load_run(folder)
    manifest = run.get("manifest") or {}
    pairs = core.command_pairs(manifest)
    start, start_src = _audit_run.start_point(run)
    git, git_note, repo_ref = _open(repo, start, start_src)
    sections = _audit_run.run_sections(run, git, head=head, git_note=git_note)
    facts = sections.pop("facts")
    tasks = _audit_tasks.task_sections(run, git, facts, pairs, git_note=git_note)
    run_id = manifest.get("run_id")
    audit = {
        "audit_version": AUDIT_VERSION,
        "run_id": run_id if isinstance(run_id, str) else None,
        "repo": repo_ref,
        "run": sections,
        "tasks": tasks,
    }
    gaps, causes = core.collect_gaps(audit), core.gap_causes(audit)
    audit["gaps"] = gaps
    audit["gap_causes"] = causes
    return audit


# ---- rendering helpers ----

def _is_ref(node):
    return isinstance(node, dict) and "state" in node and "sources" in node


def _scalar(value):
    if value is None:
        return "unknown"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        return value if value else '""'
    if isinstance(value, list):
        if not value:
            return "none"
        if all(isinstance(x, (str, int, float)) and not isinstance(x, bool) for x in value):
            return ", ".join(str(x) for x in value)
        return "%d item(s)" % len(value)
    return "see audit.json"


def _where(sources):
    parts = []
    for s in sources or []:
        if not isinstance(s, dict) or not s.get("path"):
            continue
        at = s.get("at")
        if at is None or (s["path"].startswith("git:") and at == s["path"][len("git:"):]):
            parts.append(s["path"])
        else:
            parts.append("%s %s" % (s["path"], at))
    return "; ".join(parts)


def _with_sources(text, sources):
    where = _where(sources)
    return "%s (%s)" % (text, where) if where else text


def _ref_text(r, value=None, state=None):
    """'<value> [<state>] - <note>' for a ref (value overrides its value,
    state the text in the brackets)."""
    if not _is_ref(r):
        return _scalar(r)
    text = "%s [%s]" % (_scalar(r.get("value")) if value is None else value,
                        r["state"] if state is None else state)
    if r.get("note"):
        text += " - %s" % r["note"]
    return text


def _ref(label, r, indent="", value=None, state=None):
    if not _is_ref(r):
        return "%s- %s: %s" % (indent, label, _scalar(r))
    return _with_sources("%s- %s: %s" % (indent, label, _ref_text(r, value, state)), r.get("sources"))


def _evidence_text(evidence, rule):
    """How audit.md names an evidence validity value: invalid by checks_failed
    is FAILED_CHECKS (audit.json keeps invalid and the rule)."""
    if evidence == "invalid" and rule == "checks_failed":
        return FAILED_CHECKS
    return None


def _quote(label, q, indent=""):
    """A line naming where the quote comes from, then its text as quote lines."""
    if not isinstance(q, dict) or not isinstance(q.get("quote"), str):
        return ["%s- %s: none" % (indent, label)]
    head = "%s- %s, quoted from %s" % (indent, label, _where(q.get("sources")) or "the run")
    if q.get("commands_replaced"):
        head += ", configured commands shown as check ids"
    lines = [head + ":"]
    for line in q["quote"].split("\n"):
        lines.append("%s  > %s" % (indent, line.rstrip("\r")))
    return lines


def _short(sha):
    return sha[:12] if isinstance(sha, str) else _scalar(sha)


def _time(seconds):
    if not isinstance(seconds, (int, float)) or isinstance(seconds, bool):
        return "unknown"
    try:
        moment = datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc)
    except (OverflowError, OSError, ValueError):
        return "unknown"
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


# ---- counts shared by the summary and audit.md ----

def _final_value(final):
    """open_work.final's value, or None when the final review is
    unavailable."""
    return final.get("value") if _is_ref(final) and isinstance(final.get("value"), dict) else None


def _final_counts(final):
    """{"present", "open", "declined", "minors", "at_least",
    "cannot_verify"} of open_work.final: present False when the final
    review is unavailable; open and declined the final findings of each
    status, cannot_verify the cannot-verify items (each None for a list the
    result does not record, its not_recorded); minors the open task minors
    plus the carried ones (_autopsy.open_task_minors over the quotes' text),
    at_least True when that is a lower bound. Each count is None when the
    final review is unavailable, and minors also when the result records
    neither list."""
    value = _final_value(final)
    if value is None:
        return {"present": False, "open": None, "declined": None, "minors": None, "at_least": False,
                "cannot_verify": None}
    cannot = value.get("cannot_verify") or []
    minors, at_least = _autopsy.open_task_minors(value.get("task_minors_open"), value.get("carried_minors_open"),
                                                 [x.get("quote") for x in cannot if isinstance(x, dict)])
    status = [f.get("status") for f in value["findings"]]
    unrecorded = value.get("not_recorded") or []
    count = lambda key: None if key in unrecorded else status.count(key)  # noqa: E731
    return {"present": True, "open": count("open"), "declined": count("declined"), "minors": minors,
            "at_least": at_least, "cannot_verify": None if "cannot_verify" in unrecorded else len(cannot)}


def _number(n):
    return "unavailable" if n is None else str(n)


def _minors_text(counts):
    """M as the bottom line prints it: a number, '<M> listed (more may be
    missing)' for a lower bound, or 'unavailable'."""
    if counts["minors"] is None:
        return "unavailable"
    if counts["at_least"]:
        return "%d %s" % (counts["minors"], _autopsy.MINORS_LOWER_BOUND)
    return str(counts["minors"])


def _open_counts(counts):
    """'<open> open and <declined> declined final finding(s), <M> open task
    minor(s)' (the Summary and the Open work header), M's lower bound read
    '<M> open task minor(s) listed (more may be missing)'."""
    if counts["minors"] is None:
        minors = "unavailable open task minor(s)"
    else:
        minors = "%d open task minor(s)%s" % (counts["minors"],
                                              " " + _autopsy.MINORS_LOWER_BOUND if counts["at_least"] else "")
    return "%s open and %s declined final finding(s), %s" % (_number(counts["open"]), _number(counts["declined"]),
                                                             minors)


def _minor_prefix(task_id):
    """The prefix the engine gives a task's minor ids (src/engine.js
    taskMinorFindings): the id when it starts with a letter, else T<id>."""
    return task_id if LETTER_FIRST.match(task_id) else "T" + task_id


def _minor_task(minor_id, task_ids, recorded=None):
    """The task id an open minor's block is, or None (Open work only). The
    id's prefix ('<prefix>-<n>') names the tasks whose _minor_prefix it is;
    recorded (a carried id's task in the ledger's minors snapshot) chooses
    among them, else one task is it, else the one whose id is the prefix
    itself (a T2 over the task 2). A batch unit '<first>-<last>', a prefix
    no task has, or a choice still open gives None."""
    m = MINOR_ID.match(minor_id) if isinstance(minor_id, str) else None
    if m is None:
        return None
    named = [t for t in task_ids if _minor_prefix(t) == m.group(1)]
    if recorded in named:
        return recorded if named.count(recorded) == 1 else None
    if len(named) == 1:
        return named[0]
    exact = [t for t in named if t == m.group(1)]
    return exact[0] if len(exact) == 1 else None


def _placed_minors(audit):
    """({task index: [minor ids]}, [ids in no task block]) of the final
    review's open task minors, then its carried ids, by _minor_task; None
    when the final review is unavailable or records neither list."""
    value = _final_value(audit["run"]["open_work"]["final"])
    if value is None or (value.get("task_minors_open") is None and value.get("carried_minors_open") is None):
        return None
    ids = [t["id"] for t in audit["tasks"]]
    recorded = value.get("carried_minor_tasks") or {}
    minors = [(f.get("id"), None) for f in value.get("task_minors_open") or [] if isinstance(f, dict)]
    minors += [(cid, recorded.get(cid)) for cid in value.get("carried_minors_open") or []]
    by_task, unplaced = {}, []
    for mid, task in minors:
        task = _minor_task(mid, ids, task)
        if task is None:
            unplaced.append(_scalar(mid))
        else:
            by_task.setdefault(ids.index(task), []).append(mid)
    return by_task, unplaced


def _counts(audit):
    run = audit["run"]
    tasks = audit["tasks"]
    entries = run["launches"]["entries"]
    launches = entries["value"] if isinstance(entries.get("value"), list) else []
    outside = run["code_outside_ranges"]
    commits = outside["value"]["commits"] if isinstance(outside.get("value"), dict) else None
    open_work = run["open_work"]
    recorded = run["launches"].get("recorded")
    recorded = recorded.get("value") if _is_ref(recorded) and isinstance(recorded.get("value"), dict) else None
    return {
        "verdict": run["acceptance"]["verdict"].get("value"),
        "launches": len(launches),
        "recorded": recorded["recorded"] if recorded is not None else None,
        "latest": run["launches"].get("latest"),
        "order": run["launches"].get("order"),
        "tasks": len(tasks),
        "outside": commits,
        "outside_note": outside.get("note"),
        "unreviewed": sum(1 for c in commits or [] if c["coverage"]["state"] == "missing"),
        "open_tasks": len(open_work.get("tasks") or []),
        # ledger status failed: the ledger's blocked and deferred tasks are unknown.
        "held_unknown": open_work.get("ledger_state") is not None,
        "final": _final_counts(open_work.get("final")),
        "gaps": len(audit["gaps"]),
        "causes": len(audit["gap_causes"]),
    }


def _gaps_text(c):
    """'<G> evidence gap(s) in <C> cause(s)', for the summary, the Bottom
    line and the Evidence gaps header."""
    return "%d evidence gap(s) in %d cause(s)" % (c["gaps"], c["causes"])


def _outside_text(c):
    if c["outside"] is None:
        return "unavailable (%s)" % c["outside_note"]
    return "%d commit(s), %d without review evidence" % (len(c["outside"]), c["unreviewed"])


def _summary_lines(audit):
    c = _counts(audit)
    lines = ["audit of run %s: verdict %s" % (audit.get("run_id") or "unknown", _scalar(c["verdict"]))]
    count = "%d" % c["launches"]
    if c["recorded"] is not None and c["recorded"] > c["launches"]:
        count = "%d archived, %d recorded" % (c["launches"], c["recorded"])
    if c["latest"] is not None:
        lines.append("launches: %s, latest %s" % (count, c["latest"]))
    else:
        lines.append("launches: %s, latest unknown (%s)" % (count, c["order"]))
    # Counted as the bottom line counts them, the unknown ones named.
    tasks = audit["tasks"]
    lines.append("tasks: %d; committed %s, reviewed %s, verified %s, accepted %s"
                 % (c["tasks"], _task_count(tasks, "committed"), _task_count(tasks, "reviewed"),
                    _task_count(tasks, "verified"), _task_count(tasks, "accepted")))
    lines.append("code outside recorded task ranges: %s" % _outside_text(c))
    held = OPEN_TASKS_UNKNOWN if c["held_unknown"] else "%d task(s)" % c["open_tasks"]
    lines.append("open work: %s, %s" % (held, _open_counts(c["final"])))
    lines.append(_gaps_text(c))
    return lines


def render_summary(audit, md_path):
    return "\n".join(_summary_lines(audit) + ["full report: %s" % md_path]) + "\n"


# ---- audit.md sections ----

def _task_count(tasks, field):
    """'<n>' tasks whose status field is true, then '(<k> settled, <k> not
    required, <k> unavailable)' for the ones of each kind there are."""
    refs = [t["status"][field] for t in tasks]
    n = sum(1 for r in refs if r.get("value") is True)
    kinds = (("settled", lambda r: r.get("value") == "settled"),
             ("not required", lambda r: r.get("value") == "not_required"),
             ("unavailable", lambda r: r.get("state") == "unavailable"))
    extra = []
    for label, test in kinds:
        k = sum(1 for r in refs if test(r))
        if k:
            extra.append("%d %s" % (k, label))
    return "%d (%s)" % (n, ", ".join(extra)) if extra else str(n)


def _gate_text(value, gate_reason):
    """A verdict as the bottom line names it: accepted (gate unavailable)
    with gate_reason (run.checks.gate_reason, check-verify's fixed reason
    code) inside its parenthesis, 'accepted (gate unavailable: <reason>)'."""
    if value == _audit_run.GATE_UNAVAILABLE_VERDICT and isinstance(gate_reason, str) and gate_reason:
        return "%s: %s)" % (value[:-1], gate_reason)
    return _scalar(value)


def _without_override(a, gate_reason):
    """(the verdict without the override as _gate_text names it, its rule or
    None) for an accepted by user verdict when that verdict (audit's, with
    no override) differs from the run's own, so a fault audit found that the
    override set aside; else None."""
    without = a.get("verdict_without_override")
    run_verdict = a.get("run_verdict")
    if a["verdict"].get("value") != "accepted by user" or not (isinstance(without, str) and without) \
            or not _is_ref(run_verdict) or without == run_verdict.get("value"):
        return None
    return _gate_text(without, gate_reason), a.get("verdict_rule_without_override")


def _overrode_text(a, gate_reason):
    """What an accepted by user verdict overrode: 'over
    <verdict_without_override>[: <its rule>]' (_without_override: 'over
    unverified: gate mismatch'); else 'over <overrode>' (the in-effect
    override's overrode: the run's own verdict and reason kinds, as
    Acceptance computes them); None when there is neither."""
    without = _without_override(a, gate_reason)
    if without is not None:
        return "over %s%s" % (without[0], ": %s" % without[1] if without[1] else "")
    overrode = [o["overrode"] for o in a.get("overrides") or [] if isinstance(o.get("overrode"), str) and o["overrode"]]
    return "over %s" % overrode[0] if overrode else None


def _verdict_line(a, gate_reason=None):
    """'Verdict: <verdict>' with why: the verdict_rule (audit's own reason),
    else, unavailable, the verdict's note, else, accepted by user, what it
    overrode (_overrode_text, always in parentheses), else, for the
    engine's own verdict, its reason kinds (unquoted, as Acceptance prints
    them); in parentheses, or after '; ' when the text has its own. The
    verdict is named by _gate_text. ACCEPTED_BY_USER follows when an
    override is in effect (its head present, at the delivered sha) and the
    verdict does not already say so: only a verdict unavailable for want of
    an acceptance object can be one."""
    verdict = a["verdict"]
    value = verdict.get("value")
    why = a.get("verdict_rule")
    run_verdict = a.get("run_verdict")
    overrides = a.get("overrides") or []
    wrap = False
    if not why and verdict.get("state") == "unavailable":
        why = verdict.get("note")
    elif not why and value == "accepted by user":
        why, wrap = _overrode_text(a, gate_reason), True
    elif not why and _is_ref(run_verdict) and value == run_verdict.get("value"):
        kinds = []
        for r in a.get("reasons") or []:
            kind = r.get("kind") if isinstance(r, dict) else None
            if isinstance(kind, str) and kind and kind not in kinds:
                kinds.append(kind)
        why = ", ".join(kinds)
    line = "Verdict: %s" % _gate_text(value, gate_reason)
    if why:
        line += ("; %s" if "(" in why and not wrap else " (%s)") % why
    # An override counts only at the delivered sha; its text is never shown.
    in_effect = any(_is_ref(o.get("head")) and o["head"]["state"] == "present" for o in overrides)
    if in_effect and value != "accepted by user":
        line += "; " + _autopsy.ACCEPTED_BY_USER
    return line + "."


def _md_bottom_line(audit, out):
    """One paragraph, each part from one value audit computed; no recorded
    text."""
    run = audit["run"]
    c = _counts(audit)
    lines = [_verdict_line(run["acceptance"], run["checks"].get("gate_reason"))]
    tasks = audit["tasks"]
    line = "Tasks: committed %s, reviewed %s, verified %s, accepted %s of %d" % (
        _task_count(tasks, "committed"), _task_count(tasks, "reviewed"), _task_count(tasks, "verified"),
        _task_count(tasks, "accepted"), len(tasks))
    open_work = run["open_work"]
    if c["held_unknown"]:
        # ledger status failed: the ledger's blocked and deferred tasks are
        # unknown, so no count is given.
        held = ["blocked and deferred unknown"]
    else:
        held = [(state, len(set(t["task"] for t in open_work["tasks"] if t["status"] == state)))
                for state in ("blocked", "deferred")]
        held = ["%d %s" % (n, state) for state, n in held if n]
    failed = _failed_checks(tasks)
    checked = "; task checks: %d committed after a failed check" % failed if failed else ""
    lines.append(line + ("; " + ", ".join(held) if held else "") + checked + ".")
    f = c["final"]
    if not f["present"]:
        lines.append("Final review unavailable; open task minors: unavailable; cannot-verify items: unavailable.")
    else:
        lines.append("Final findings: %s open, %s declined; open task minors: %s; cannot-verify items: %s."
                     % (_number(f["open"]), _number(f["declined"]), _minors_text(f), _number(f["cannot_verify"])))
    lines.append("Code outside recorded task ranges: %s." % _outside_text(c))
    missing = len(run["launches"].get("missing") or [])
    if missing and c["recorded"] is not None:
        lines.append("Launches missing from the archive: %d of %d recorded." % (missing, c["recorded"]))
    lines.append("%s %s." % (_gaps_text(c), NOT_GAPS))
    out += ["## Bottom line", ""] + lines + [""]


def _md_terms(out):
    out += ["## Terms", ""]
    out += ["- %s: %s" % (term, text) for term, text in TERMS]
    out.append("")


def _md_summary(audit, out):
    out += ["## Summary", ""]
    out += ["- " + line for line in _summary_lines(audit)]
    out.append(_ref("repo", audit["repo"]))
    out.append("")


def _md_acceptance(a, rule, out, gate_reason=None):
    """rule is run.checks.rule, the evidence validity rule, and gate_reason
    run.checks.gate_reason."""
    out += ["## Acceptance", ""]
    out.append(_ref("verdict", a["verdict"]))
    if a.get("verdict_rule"):
        out.append("- what made it unverified: %s" % a["verdict_rule"])
    without = _without_override(a, gate_reason)
    if without is not None:
        out.append("- verdict without the override: %s%s" % (without[0], " (%s)" % without[1] if without[1] else ""))
    out.append(_ref("run verdict", a["run_verdict"]))
    for r in a.get("reasons") or []:
        label = "reason %s (%s)" % (_scalar(r.get("kind")), _scalar(r.get("class")))
        if r.get("detail") is not None:
            out += _quote(label, r["detail"], "  ")
        else:
            out.append("  - %s" % label)
    for w in a.get("warnings") or []:
        out += _quote("warning", w, "  ")
    out.append("- gate: %s" % _scalar(a.get("gate")))
    failed = _evidence_text(a.get("evidence"), rule)
    out.append("- evidence: %s" % ("%s (%s)" % (failed, rule) if failed else _scalar(a.get("evidence"))))
    overrides = a.get("overrides") or []
    if not overrides:
        out.append("- user overrides: none")
    for o in overrides:
        line = _ref("user override at", o["head"])
        if o.get("overrode"):
            line += "; it overrode %s" % o["overrode"]
        out.append(line)
        if o.get("text") is not None:
            out += _quote("its text", o["text"], "  ")
    for e in a.get("run_ended") or []:
        out.append(_with_sources("- run ended: agents %s, rulings %s" % (_scalar(e.get("agents")), _scalar(e.get("rulings"))),
                                 e.get("sources")))
        if e.get("status") is not None:
            out += _quote("status", e["status"], "  ")
    out.append(_ref("delivered sha", a["delivered_sha"]))
    out.append("")


def _md_launches(launches, out):
    out += ["## Launches", ""]
    if launches.get("latest"):
        out.append("- latest launch: %s" % launches["latest"])
    else:
        out.append("- latest launch: unknown (%s)" % launches.get("order"))
    entries = launches["entries"]
    if not isinstance(entries.get("value"), list) or not entries["value"]:
        out.append(_ref("launches", entries))
    else:
        for e in entries["value"]:
            extra = []
            if e.get("dirless"):
                extra.append("no transcript dir")
            elif not e.get("has_transcripts"):
                extra.append("no transcripts")
            label = "%s, started %s%s" % (e["wf"], _time(e.get("start")), "; " + ", ".join(extra) if extra else "")
            out.append(_ref(label, e["status"]))
            if e.get("reason") is not None:
                out += _quote("reason", e["reason"], "  ")
            for gap in e.get("layout") or []:
                out.append(_ref("layout", gap, "  "))
    recorded = launches.get("recorded")
    if _is_ref(recorded):
        value = recorded.get("value")
        text = ("%d recorded, %d archived" % (value["recorded"], value["archived"])
                if isinstance(value, dict) else None)
        out.append(_ref("launches the ledger records", recorded, value=text))
    for gap in launches.get("missing") or []:
        out.append(_ref("missing launch", gap))
    out.append("")


def _sha7(sha):
    return sha[:7] if isinstance(sha, str) and sha else _scalar(sha)


def _task_entry_head(entry):
    """A commits entry's head as _audit_tasks reads it: its head, else
    (legacy) its last recorded commit, else None."""
    if isinstance(entry.get("head"), str) and entry["head"]:
        return entry["head"]
    recorded = entry.get("recorded")
    return recorded[-1] if isinstance(recorded, list) and recorded and isinstance(recorded[-1], str) else None


def _verified_line(t):
    """The verified line. Git containment says what it covers (CONTAINED,
    NOT_CONTAINED: the task's last commit, and the verify head from the
    ref's git source); every other value prints as it is."""
    r = t["status"]["verified"]
    contained = r.get("value") is True and r.get("state") == "present"
    if not contained and not (r.get("value") is False and r.get("note") == _audit_tasks.NOT_CONTAINED):
        return _ref("verified", r)
    entries = t["commits"]["entries"]
    verify = [x.get("at") for x in r.get("sources") or [] if isinstance(x, dict)
              and isinstance(x.get("path"), str) and x["path"].startswith("git:")]
    text = (CONTAINED if contained else NOT_CONTAINED) % (
        _sha7(_task_entry_head(entries[-1]) if entries else None), _sha7(verify[-1] if verify else None))
    return _with_sources("- verified: %s [%s] - %s" % (_scalar(r["value"]), r["state"], text), r.get("sources"))


def _task_check_outcome(v):
    """passed, failed or no result, from a task-check value: failed is None
    for an attempt with no result, else ok tells a pass from a failure."""
    if v.get("failed") is None:
        return "no result"
    return "passed" if v.get("ok") is True else "failed"


def _task_check_lines(t):
    """The task check's line, after verified: none when its value is null and
    present (not committed, settled, or an engine before 1.6.0); a value
    without an attempt as any ref; else '<passed|failed|no result> [<state>]
    - ' and, with a policy (reasons not null), '[<why no result>; ]<selected>
    check of the working tree against the task base <base7>' (a stale one
    'against <base7>, not the task's recorded base <base7>'), then '; HEAD
    was <head7>[, the task's own commit: this check ran after it]' when HEAD
    was not the base, the earlier attempts, '; the checkout changed while it
    ran' and the fix commits after it; without one, why it has no result (or
    no policy) and the earlier attempts. A failure lists each failing check
    under it, or that no command failed."""
    r = t.get("checks", {}).get("task_check")
    if not _is_ref(r):
        return []
    v = r.get("value")
    if not isinstance(v, dict):
        return [] if v is None and r["state"] == "present" else [_ref(TASK_CHECK, r)]
    outcome = _task_check_outcome(v)
    with_policy = v.get("reasons") is not None
    parts = []
    if not with_policy:
        parts.append(r.get("note") or _audit_run.TC_NO_POLICY)
    else:
        if outcome == "no result" and r["state"] != "stale" and r.get("note"):
            parts.append(r["note"])
        base = _sha7(v.get("base"))
        if r["state"] == "stale":
            entries = t["commits"]["entries"]
            recorded = entries[0].get("base") if entries else None
            where = "against %s, not the task's recorded base %s" % (base, _sha7(recorded))
        else:
            where = "against the task base %s" % base
        parts.append("%s check of the working tree %s" % (_scalar(v.get("selected")), where))
        head = v.get("head")
        if isinstance(head, str) and head != v.get("base"):
            own = ", the task's own commit: this check ran after it" if v.get("head_is_task_commit") else ""
            parts.append("HEAD was %s%s" % (head[:7], own))
    e = v.get("earlier") or {}
    counts = [e.get(key) or 0 for key in ("passed", "failed", "no_result")]
    if sum(counts):
        parts.append("%d earlier attempt(s): %d passed, %d failed, %d without a result" % tuple([sum(counts)] + counts))
    if with_policy and v.get("tree_changed") is True:
        parts.append("the checkout changed while it ran")
    if with_policy and v.get("fix_commits_after"):
        parts.append("%d fix commit(s) after its check: fixers run no task checks" % v["fix_commits_after"])
    lines = [_with_sources("- %s: %s [%s] - %s" % (TASK_CHECK, outcome, r["state"], "; ".join(parts)),
                           r.get("sources"))]
    if outcome == "failed":
        failed = v.get("failed") or []
        lines += ["  - %s (%s): exit %s" % (f.get("check"), _scalar(f.get("group")), _scalar(f.get("exit")))
                  for f in failed]
        if not failed:
            lines.append("  - no command failed (HEAD moved while it ran)")
    return lines


def _failed_checks(tasks):
    """The tasks committed after a failed task check: their last attempt
    failed."""
    values = [t.get("checks", {}).get("task_check", {}).get("value") for t in tasks]
    return sum(1 for v in values if isinstance(v, dict) and _task_check_outcome(v) == "failed")


def _md_task(t, out, minors=None):
    """One task block; it ends with '- open minors: <id>, ...' when minors
    (the open minors _placed_minors puts here) has any."""
    out += ["### Task %s (lane %s)" % (t["id"], _scalar(t.get("lane"))), ""]
    s = t["status"]
    out.append("Status:")
    for field in ("committed", "reviewed"):
        out.append(_ref(field, s[field]))
    out.append(_verified_line(t))
    out += _task_check_lines(t)
    out.append(_ref("accepted", s["accepted"]))
    out.append(_ref("result status", s["result_status"]))

    req = t["requirement"]
    out += ["", "Requirement:"]
    out.append(_ref("brief hash (latest review)", req["brief_hash"]))
    out.append(_ref("brief file", req["brief_file"]))

    p = t["placement"]
    out += ["", "Placement:"]
    out.append(_ref("lane", p["lane"]))
    out.append(_ref("depends on", p["depends_on"]))
    ctx = p["preflight_context"]
    out.append("- %s:" % ctx["label"])
    for launch in ctx["launches"]:
        entries = launch["entries"]
        items = entries.get("value")
        label = launch["wf"] or "no launch"
        if isinstance(items, list) and items:
            out.append(_ref(label, entries, "  ", value="%d entr(y/ies)" % len(items)))
            for item in items:
                out += _quote("from %s" % _scalar(item.get("producer")), item.get("what"), "    ")
        else:
            out.append(_ref(label, entries, "  "))

    ch = t["changes"]
    out += ["", "Changes:"]
    if not ch["rulings"]:
        out.append("- rulings: none")
    for r in ch["rulings"]:
        by = r["value"].get("by")
        out += _quote("ruling by %s" % (_scalar(by) if by else NO_ROLE), r["value"].get("text"))
    if not ch["events"]:
        out.append("- blocked, settled and reopened events: none")
    for e in ch["events"]:
        v = e["value"]
        label = v["event"]
        if v["event"] == "settled":
            label += " (%s) %s..%s" % (_scalar(v.get("outcome")), _short(v.get("base")), _short(v.get("head")))
        out.append(_ref(label, e, value="recorded"))
        if v.get("reason") is not None:
            out += _quote("reason", v["reason"], "  ")
    carry = ch["carry"]
    if isinstance(carry.get("value"), dict):
        out += _quote("carry", carry["value"])
    else:
        out.append(_ref("carry", carry, value="none" if carry["state"] == "present" else None))
    if not ch["launch_notes"]:
        out.append("- launch notes (args.notes): none")
    for n in ch["launch_notes"]:
        v = n["value"]
        if isinstance(v.get("note"), dict):
            label = "launch note of %s%s" % (v["wf"], " (the task's carry text)" if v.get("carry") else "")
            out += _quote(label, v["note"])
        else:
            out.append(_ref("launch notes of %s" % v["wf"], n, value="none"))
    out.append(_ref("deferred", ch["deferred"]))
    for e in ch["escalations"]:
        r = e["escalations"]
        items = r.get("value")
        if isinstance(items, list) and items:
            text = ", ".join("%s: %s to %s" % (x["label"], x["from_tier"], x["to_tier"]) for x in items)
            out.append(_ref("escalations in %s" % e["wf"], r, value=text))
        else:
            out.append(_ref("escalations in %s" % e["wf"], r, value="none" if isinstance(items, list) else None))

    c = t["commits"]
    out += ["", "Commits:"]
    if not c["entries"]:
        out.append("- committed or settled events: none")
    for e in c["entries"]:
        out.append(_with_sources("- %s %s..%s" % (e["event"], _scalar(e.get("base")), _scalar(e.get("head"))),
                                 [e["line"]]))
        out.append(_ref("commits", e["commits"], "  "))
        out.append(_ref("changed files", e["files"], "  "))
    legacy = c.get("legacy")
    if legacy is not None:
        out.append("- legacy task (no recorded base):")
        for rec in legacy["recorded"]:
            out.append(_with_sources("  - recorded commits: %s" % _scalar(rec.get("commits")), [rec["line"]]))
        out.append(_ref("the result's [base, head]", legacy["result"], "  "))
        out.append(_ref("agreement", legacy["agreement"], "  "))

    rv = t["review"]
    out += ["", "Review:"]
    if not rv["reviews"]:
        out.append("- reviewed events: none")
    for r in rv["reviews"]:
        out.append(_with_sources("- reviewed at %s, %s round(s)" % (_scalar(r.get("head")), _scalar(r.get("rounds"))),
                                 [r["line"]]))
        out.append(_ref("brief match", r["brief_match"], "  "))
        out.append(_ref("spec match", r["spec_match"], "  "))
    out.append(_ref("review packages", rv["packages"]))
    if not rv["verdicts"]:
        out.append("- review verdicts: none recorded")
    for v in rv["verdicts"]:
        val = v.get("value") or {}
        if v["state"] == "present":
            # Recorded in the journal; the engine's other reading in parentheses.
            text = "%s, %s finding(s)" % (_scalar(val.get("verdict")), _scalar(val.get("findings")))
            if v.get("note"):
                text += " (%s)" % v["note"]
            out.append(_with_sources("- %s in %s: %s [present]" % (val.get("label"), val.get("wf"), text),
                                     v.get("sources")))
        else:
            out.append(_ref("review verdicts", v))
    approval = rv.get("approval")
    if approval is None:
        out.append("- approval: none")
    else:
        line = _with_sources("- approval of %s" % _scalar(approval.get("head")), [approval["line"]])
        if approval.get("withdrawn_by"):
            line += "; withdrawn by %s" % _where([approval["withdrawn_by"]])
        if approval.get("stale_by"):
            line += "; made stale by %s" % _where([approval["stale_by"]])
        out.append(line)
    if minors:
        out.append("- open minors: %s" % ", ".join(minors))
    out.append("")


def _md_outside(r, out):
    out += ["## Code outside recorded task ranges", ""]
    value = r.get("value")
    if not isinstance(value, dict):
        out.append(_ref("commits", r))
    else:
        out.append(_ref("range", r, value="%s..%s" % (value.get("start_point"), value.get("delivered_sha"))))
        if not value["commits"]:
            out.append("- every commit lies in a recorded task range")
        for c in value["commits"]:
            out.append(_ref(c["commit"], c["coverage"]))
            if c.get("unreviewed_fix") is not None:
                out += _quote("final.unreviewed_fix", c["unreviewed_fix"], "  ")
    out.append("")


def _md_checks(c, out, tasks=()):
    """tasks is audit["tasks"]: the task checks line names the tasks an
    engine before 1.6.0 committed only when it is some of the committed,
    unsettled ones."""
    out += ["## Checks", ""]
    v = c["verify"]
    value = v.get("value")
    if isinstance(value, dict):
        text = "head %s, ok %s, clean %s" % (_scalar(value.get("head")), _scalar(value.get("ok")),
                                              _scalar(value.get("clean")))
        out.append(_ref("verify", v, value=text))
        for r in value.get("results") or []:
            out.append("  - %s (%s): exit %s" % (r.get("check"), _scalar(r.get("group")), _scalar(r.get("exit"))))
        for key in _audit_run.LISTS:
            out.append("  - %s: %s" % (key, _scalar(value.get(key))))
    else:
        out.append(_ref("verify", v))
    files = c.get("files") or []
    out.append("- saved evidence: %s" % (", ".join(f["path"] for f in files) if files else "none"))
    gate = c["gate"]
    line = _ref("gate", gate)
    if c.get("gate_exit") is not None:
        line += "; check-verify exit %s" % c["gate_exit"]
    out.append(line)
    out.append(_ref("evidence validity", c["evidence"],
                    value=_evidence_text(c["evidence"].get("value"), c.get("rule"))))
    if c.get("verify_head") is not None:
        out.append(_ref("verify head against delivered", c["verify_head"]))
    e2e = c.get("e2e")
    if e2e is None:
        out.append("- e2e: not configured")
    elif isinstance(e2e.get("value"), dict):
        ev = e2e["value"]
        out.append(_ref("e2e", e2e, value="checked %s, %s item(s), %s failed"
                        % (_scalar(ev.get("checked_sha")), ev.get("items"), ev.get("failed"))))
    else:
        out.append(_ref("e2e", e2e))
    task_checks = c.get("task_checks") or {}
    not_recorded = task_checks.get("not_recorded") or []
    if not_recorded:
        line = "- task checks: %s" % _audit_tasks.TC_NOT_RECORDED
        scope = [t for t in tasks if t["status"]["committed"].get("value") is True
                 and t["status"]["reviewed"].get("value") != "settled"]
        if len(not_recorded) < len(scope):
            line += " for tasks %s" % ", ".join(not_recorded)
        out.append(line)
    if task_checks.get("unmatched"):
        out.append("- task check files that match no task: %s" % ", ".join(task_checks["unmatched"]))
    # The run's input hashes, once: by setup event, its ledger line among
    # the sources.
    for kind in ("plan", "spec"):
        for i, r in enumerate(c.get("%s_hash" % kind) or [], 1):
            label = "%s hash, setup event %d" % (kind, i) if _at_line(r) else "%s hash" % kind
            out.append(_ref(label, r))
    if c.get("section_hash") is not None:
        out.append(_ref("plan copy for the section hashes", c["section_hash"]))
    out.append("")


def _at_line(r):
    """True when a ref's first source is a ledger line (L<n>)."""
    sources = r.get("sources") if _is_ref(r) else None
    at = sources[0].get("at") if sources and isinstance(sources[0], dict) else None
    return isinstance(at, str) and at.startswith("L")


def _md_after(r, out):
    out += ["## After delivery", ""]
    value = r.get("value")
    if isinstance(value, dict):
        out.append(_ref("commits from %s to %s" % (value.get("from"), value.get("to")), r,
                        value=_scalar(value.get("commits"))))
    else:
        out.append(_ref("commits", r))
    out.append("")


def _delivered_text(delivered):
    """The delivered sha as a re-review line names it: its first 7 digits when
    it is a sha, else as recorded (as l131's)."""
    if isinstance(delivered, str) and _audit_run.FULL_SHA.fullmatch(delivered):
        return delivered[:7]
    return _scalar(delivered)


def _re_review_line(r):
    """Open work's final re-review line (open_work.final.value.re_review):
    'judged <head7>[, not the delivered sha <delivered>]: <r> resolved, <o>
    open, <m> without a result[, <c> with contradictory results] of the <F>
    final finding(s); <n> new', or RE_REVIEW_FORMS' text."""
    v = r.get("value") if _is_ref(r) and isinstance(r.get("value"), dict) else None
    if v is None:
        return _ref("final re-review", r)
    if v.get("form") != "judged":
        return _ref("final re-review", r, value=RE_REVIEW_FORMS.get(v.get("form"), _scalar(v.get("form"))))
    text = "judged %s" % _sha7(v.get("head"))
    delivered = v.get("delivered")
    if isinstance(delivered, str) and delivered and delivered != v.get("head"):
        text += ", not the delivered sha %s" % _delivered_text(delivered)
    text += ": %s resolved, %s open, %s without a result" % (v.get("resolved"), v.get("open"), v.get("without_result"))
    if v.get("contradictory"):
        text += ", %s with contradictory results" % v["contradictory"]
    text += " of the %s final finding(s); %s new" % (v.get("of"), v.get("new"))
    return _ref("final re-review", r, value=text)


def _finding_re_review(f, out, indent):
    """A final finding's re-review, after its disposition: '- re-review:
    <status>' (RE_REVIEW_RULES' text when it has none of its own), its
    evidence quoted under it; none for a task minor or a finding whose
    engine recorded no review (not_recorded: the final re-review line says
    so once)."""
    r = f.get("re_review")
    v = r.get("value") if _is_ref(r) and isinstance(r.get("value"), dict) else None
    if v is None or v.get("rule") == "not_recorded":
        return
    if v.get("rule") in RE_REVIEW_RULES:
        out.append(_ref("re-review", r, indent, value=RE_REVIEW_RULES[v["rule"]]))
        return
    label, status = "re-review", _scalar(v.get("status"))
    if v.get("rule") == "other_head":
        label = "re-review of %s, not the delivered sha %s" % (_sha7(v.get("head")),
                                                                _delivered_text(v.get("delivered")))
    elif v.get("rule") == "decline_upheld":
        status += " (the decline upheld)"
    out.append(_ref(label, r, indent, value=status))
    out += _quote("re-review evidence", v.get("evidence"), indent + "  ")


def _md_finding(f, out, indent=""):
    parts = [str(f[k]) for k in ("lens", "task", "severity") if f.get(k) is not None]
    if f.get("file") is not None:
        parts.append("%s:%s" % (f["file"], _scalar(f.get("line"))))
    label = "%s %s%s" % (_scalar(f.get("id")), f.get("status"), " (%s)" % ", ".join(parts) if parts else "")
    out.append(_with_sources("%s- %s" % (indent, label), f.get("sources")))
    for key in ("issue", "reason"):
        if f.get(key) is not None:
            out += _quote(key, f[key], indent + "  ")
    d = f.get("disposition")
    if isinstance(d, dict):
        out.append("%s  - disposition: %s" % (indent, _scalar(d.get("status"))))
        for key in ("evidence", "reason"):
            if d.get(key) is not None:
                out += _quote("disposition %s" % key, d[key], indent + "    ")
    _finding_re_review(f, out, indent + "  ")


def _md_open(o, out, placed, order_unknown=False):
    """placed is _placed_minors' result: after the final review's entries,
    one line on the open task minors when there is something to say (no
    final review, none recorded, ids in no task block, a lower bound).
    order_unknown (launches archived, the latest not known) adds none: the
    final review may exist, and its header already gives the reason."""
    out += ["## Open work", ""]
    if not o["tasks"]:
        # Unknown, not none, when ledger status failed (ledger_state is set).
        out.append("- blocked or deferred tasks: %s" % ("unknown" if o.get("ledger_state") is not None else "none"))
    for t in o["tasks"]:
        out.append(_with_sources("- task %s: %s" % (t["task"], t["status"]), t.get("sources")))
        if t.get("reason") is not None:
            out += _quote("reason", t["reason"], "  ")
    if o.get("ledger_state") is not None:
        out.append(_ref("ledger state", o["ledger_state"]))
    if not o["excluded"]:
        out.append("- excluded by the manifest: none")
    for e in o["excluded"]:
        out.append(_with_sources("- excluded %s" % _scalar(e.get("id")), e.get("sources")))
        if e.get("reason") is not None:
            out += _quote("reason", e["reason"], "  ")
    stopped = o["stopped_lanes"]
    lanes = stopped.get("value")
    if isinstance(lanes, list) and lanes:
        out.append(_ref("stopped lanes", stopped, value=str(len(lanes))))
        for s in lanes:
            out.append(_with_sources("  - lane %s at task %s" % (_scalar(s.get("lane")), _scalar(s.get("task"))),
                                     s.get("sources")))
            if s.get("reason") is not None:
                out += _quote("reason", s["reason"], "    ")
    else:
        out.append(_ref("stopped lanes", stopped, value="none" if isinstance(lanes, list) else None))
    final = o["final"]
    value = final.get("value")
    counts = _final_counts(final)
    out.append(_ref("final review", final, value=_open_counts(counts)))
    if isinstance(value, dict):
        if value.get("re_review") is not None:
            out.append(_re_review_line(value["re_review"]))
        for f in value["findings"]:
            _md_finding(f, out, "  ")
        for item in value["cannot_verify"]:
            if isinstance(item, dict) and "quote" in item:
                out += _quote("cannot verify", item, "  ")
            else:
                out.append(_with_sources("  - cannot verify:", item.get("sources")))
                for key in sorted(k for k in item if k != "sources"):
                    out += _quote(key, item[key], "    ")
        for f in value["task_minors_open"] or []:
            _md_finding(f, out, "  ")
        # The carried ids the header counts, as recorded (ids only).
        for cid in value.get("carried_minors_open") or []:
            out.append("  - %s open (carried minor)" % cid)
    # Said once here, never per task.
    if _final_value(final) is None:
        if not order_unknown:
            out.append("- open task minors: %s" % NO_FINAL_REVIEW)
    elif placed is None:
        out.append("- open task minors: %s" % NOT_RECORDED)
    else:
        if placed[1]:
            out.append("- open task minors in no task block: %s (%s)" % (", ".join(placed[1]), UNPLACED))
        if counts["at_least"]:
            out.append("- open task minors: %s" % LOWER_BOUND_NOTE)
    out.append("")


def _plain(value):
    return isinstance(value, (str, int, float)) and not isinstance(value, bool)


def _cause_where(cause):
    """'(tasks <id>, ...)' for a cause under tasks; '(run)', or '(run: <v>,
    ...)' with every value ('unknown' for null) when there is more than one
    or a single plain one, for a run-level cause."""
    if cause.get("tasks") is not None:
        return "(tasks %s)" % ", ".join(str(t) for t in cause["tasks"])
    values = cause.get("values") or []
    if not values or (len(values) == 1 and not _plain(values[0])):
        return "(run)"
    return "(run: %s)" % ", ".join(str(v) if _plain(v) else _scalar(v) for v in values)


def _md_gaps(audit, out):
    """'<G> evidence gap(s) in <C> cause(s)', then one line per cause:
    '- <pointer> [<state>] - <note> (tasks <id>, ...)' or '(run...)'."""
    out += ["## Evidence gaps", ""]
    out.append(_gaps_text(_counts(audit)))
    out.append("")
    causes = audit["gap_causes"]
    for cause in causes:
        line = "- %s [%s]" % (cause["pointer"], cause["state"])
        if cause.get("note"):
            line += " - %s" % cause["note"]
        out.append("%s %s" % (line, _cause_where(cause)))
    if causes:
        out.append("")


def render_md(audit):
    out = [FIRST_LINE, "", "# Audit of run %s" % (audit.get("run_id") or "unknown"), ""]
    run = audit["run"]
    _md_bottom_line(audit, out)
    _md_summary(audit, out)
    _md_acceptance(run["acceptance"], run["checks"].get("rule"), out, run["checks"].get("gate_reason"))
    _md_launches(run["launches"], out)
    out += ["## Tasks", ""]
    if not audit["tasks"]:
        out += ["The manifest lists no task.", ""]
    placed = _placed_minors(audit)
    for i, t in enumerate(audit["tasks"]):
        _md_task(t, out, placed[0].get(i) if placed is not None else None)
    _md_outside(run["code_outside_ranges"], out)
    _md_checks(run["checks"], out, audit["tasks"])
    if run.get("after_delivery") is not None:
        _md_after(run["after_delivery"], out)
    entries = run["launches"]["entries"].get("value")
    order_unknown = run["launches"].get("latest") is None and isinstance(entries, list) and bool(entries)
    _md_open(run["open_work"], out, placed, order_unknown)
    _md_gaps(audit, out)
    _md_terms(out)
    while out and out[-1] == "":
        out.pop()
    return "\n".join(out) + "\n"
