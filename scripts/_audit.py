"""The audit view of an archived run: build, render_md and render_summary.

Import with:
    sys.dont_write_bytecode = True
    sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
    import _audit

build(folder, repo=None, head=None) reads the run folder once
(_audit_core.load_run, which raises _audit_core.OutsideRunFolder for an input
that resolves outside it) and returns

  {"audit_version": 1, "run_id", "repo", "run", "tasks", "gaps"}

run is _audit_run.run_sections without its facts, tasks
_audit_tasks.task_sections, and gaps _audit_core.collect_gaps over the rest
(JSON pointers from the document root). repo is a ref saying how far the
git facts can be trusted:
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
sections Summary, Acceptance, Launches, Tasks (one block per task), Code
outside recorded task ranges, Checks, After delivery (only with --head), Open
work and Evidence gaps. A value is shown as '<value> [<state>]', with its
note after ' - ' and its sources in parentheses. Recorded text appears only
as Markdown quote lines ('> '), under a line naming where it was quoted
from; configured commands in it are already check ids.

render_summary(audit, md_path) is at most 10 lines, the last 'full report:
<md_path>'.
"""

import datetime
import os
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import _audit_core as core  # noqa: E402
import _audit_git  # noqa: E402
import _audit_run  # noqa: E402
import _audit_tasks  # noqa: E402

FIRST_LINE = "This audit holds local paths and recorded text from the run; it is not meant to be shared as-is."
NO_REPO = "no --repo"
UNCHECKED = "repo not checked against the run"


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
        "audit_version": 1,
        "run_id": run_id if isinstance(run_id, str) else None,
        "repo": repo_ref,
        "run": sections,
        "tasks": tasks,
    }
    audit["gaps"] = core.collect_gaps(audit)
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


def _ref_text(r, value=None):
    """'<value> [<state>] - <note>' for a ref (value overrides its value)."""
    if not _is_ref(r):
        return _scalar(r)
    text = "%s [%s]" % (_scalar(r.get("value")) if value is None else value, r["state"])
    if r.get("note"):
        text += " - %s" % r["note"]
    return text


def _ref(label, r, indent="", value=None):
    if not _is_ref(r):
        return "%s- %s: %s" % (indent, label, _scalar(r))
    return _with_sources("%s- %s: %s" % (indent, label, _ref_text(r, value)), r.get("sources"))


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

def _counts(audit):
    run = audit["run"]
    tasks = audit["tasks"]
    status = lambda field: sum(1 for t in tasks if t["status"][field].get("value") is True)  # noqa: E731
    entries = run["launches"]["entries"]
    launches = entries["value"] if isinstance(entries.get("value"), list) else []
    outside = run["code_outside_ranges"]
    commits = outside["value"]["commits"] if isinstance(outside.get("value"), dict) else None
    open_work = run["open_work"]
    final = open_work.get("final")
    findings = final["value"]["findings"] if _is_ref(final) and isinstance(final.get("value"), dict) else []
    return {
        "verdict": run["acceptance"]["verdict"].get("value"),
        "launches": len(launches),
        "latest": run["launches"].get("latest"),
        "order": run["launches"].get("order"),
        "tasks": len(tasks),
        "committed": status("committed"),
        "reviewed": status("reviewed"),
        "verified": status("verified"),
        "accepted": status("accepted"),
        "outside": commits,
        "outside_note": outside.get("note"),
        "unreviewed": sum(1 for c in commits or [] if c["coverage"]["state"] == "missing"),
        "open_tasks": len(open_work.get("tasks") or []),
        "findings": len(findings),
        "gaps": len(audit["gaps"]),
    }


def _summary_lines(audit):
    c = _counts(audit)
    lines = ["audit of run %s: verdict %s" % (audit.get("run_id") or "unknown", _scalar(c["verdict"]))]
    if c["latest"] is not None:
        lines.append("launches: %d, latest %s" % (c["launches"], c["latest"]))
    else:
        lines.append("launches: %d, latest unknown (%s)" % (c["launches"], c["order"]))
    lines.append("tasks: %d; committed %d, reviewed %d, verified %d, accepted %d"
                 % (c["tasks"], c["committed"], c["reviewed"], c["verified"], c["accepted"]))
    if c["outside"] is None:
        lines.append("code outside recorded task ranges: unavailable (%s)" % c["outside_note"])
    else:
        lines.append("code outside recorded task ranges: %d commit(s), %d without review evidence"
                     % (len(c["outside"]), c["unreviewed"]))
    lines.append("open work: %d task(s), %d open or declined finding(s)" % (c["open_tasks"], c["findings"]))
    lines.append("evidence gaps: %d" % c["gaps"])
    return lines


def render_summary(audit, md_path):
    return "\n".join(_summary_lines(audit) + ["full report: %s" % md_path]) + "\n"


# ---- audit.md sections ----

def _md_summary(audit, out):
    out += ["## Summary", ""]
    out += ["- " + line for line in _summary_lines(audit)]
    out.append(_ref("repo", audit["repo"]))
    out.append("")


def _md_acceptance(a, out):
    out += ["## Acceptance", ""]
    out.append(_ref("verdict", a["verdict"]))
    if a.get("verdict_rule"):
        out.append("- what made it unverified: %s" % a["verdict_rule"])
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
    out.append("- evidence: %s" % _scalar(a.get("evidence")))
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
    out.append("")


def _md_task(t, out):
    out += ["### Task %s (lane %s)" % (t["id"], _scalar(t.get("lane"))), ""]
    s = t["status"]
    out.append("Status:")
    for field in ("committed", "reviewed", "verified", "accepted"):
        out.append(_ref(field, s[field]))
    out.append(_ref("result status", s["result_status"]))

    req = t["requirement"]
    out += ["", "Requirement:"]
    out.append(_ref("plan section hash", req["section_hash"]))
    out.append(_ref("brief hash (latest review)", req["brief_hash"]))
    out.append(_ref("brief file", req["brief_file"]))
    for i, r in enumerate(req.get("plan_hash") or [], 1):
        out.append(_ref("plan hash, launch %d" % i, r))
    for i, r in enumerate(req.get("spec_hash") or [], 1):
        out.append(_ref("spec hash, launch %d" % i, r))

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
        out += _quote("ruling by %s" % _scalar(r["value"].get("by")), r["value"].get("text"))
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
        if v["state"] == "inferred":
            text = "%s, %s finding(s)" % (_scalar(val.get("verdict")), _scalar(val.get("findings")))
            out.append(_ref("%s in %s" % (val.get("label"), val.get("wf")), v, value=text))
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


def _md_checks(c, out):
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
    out.append(_ref("evidence validity", c["evidence"]))
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
    out.append("")


def _md_after(r, out):
    out += ["## After delivery", ""]
    value = r.get("value")
    if isinstance(value, dict):
        out.append(_ref("commits from %s to %s" % (value.get("from"), value.get("to")), r,
                        value=_scalar(value.get("commits"))))
    else:
        out.append(_ref("commits", r))
    out.append("")


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


def _md_open(o, out):
    out += ["## Open work", ""]
    if not o["tasks"]:
        out.append("- blocked or deferred tasks: none")
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
    if not isinstance(value, dict):
        out.append(_ref("final review", final))
    else:
        out.append(_ref("final review", final, value="%d open or declined finding(s)" % len(value["findings"])))
        for f in value["findings"]:
            _md_finding(f, out, "  ")
        for item in value["cannot_verify"]:
            if isinstance(item, dict) and "quote" in item:
                out += _quote("cannot verify", item, "  ")
            else:
                out.append(_with_sources("  - cannot verify:", item.get("sources")))
                for key in sorted(k for k in item if k != "sources"):
                    out += _quote(key, item[key], "    ")
        for f in value["task_minors_open"]:
            _md_finding(f, out, "  ")
    out.append("")


def _md_gaps(gaps, out):
    out += ["## Evidence gaps", ""]
    out.append("evidence gaps: %d" % len(gaps))
    out.append("")
    for g in gaps:
        line = "- %s: %s" % (g["where"], g["state"])
        value = g.get("value")
        if isinstance(value, (str, int, float)) and not isinstance(value, bool):
            line += " (%s)" % value
        if g.get("note"):
            line += " - %s" % g["note"]
        out.append(line)
    if gaps:
        out.append("")


def render_md(audit):
    out = [FIRST_LINE, "", "# Audit of run %s" % (audit.get("run_id") or "unknown"), ""]
    run = audit["run"]
    _md_summary(audit, out)
    _md_acceptance(run["acceptance"], out)
    _md_launches(run["launches"], out)
    out += ["## Tasks", ""]
    if not audit["tasks"]:
        out += ["The manifest lists no task.", ""]
    for t in audit["tasks"]:
        _md_task(t, out)
    _md_outside(run["code_outside_ranges"], out)
    _md_checks(run["checks"], out)
    if run.get("after_delivery") is not None:
        _md_after(run["after_delivery"], out)
    _md_open(run["open_work"], out)
    _md_gaps(audit["gaps"], out)
    while out and out[-1] == "":
        out.pop()
    return "\n".join(out) + "\n"
