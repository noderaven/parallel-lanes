// ---- Acceptance: does the delivered revision meet the run's gates ----
//
// A run that executed to the end (status complete) is not thereby accepted.
// acceptanceOf decides from the evidence alone, in code: every check that
// must hold is tied to the revision it covered, and anything missing, stale,
// failing, still open, or deferred keeps the run from being accepted.

// A finding that blocks acceptance (and a task approval).
function isBlocking(f) {
  return Boolean(f) && (f.severity === 'critical' || f.severity === 'important');
}

// Give findings stable ids in order (F1, F2, ... or another prefix), so a
// fix and its re-review talk about the same finding even when its line or
// wording changes.
function withFindingIds(findings, prefix = 'F') {
  return findings.map((f, i) => ({ ...f, id: `${prefix}${i + 1}` }));
}

// The fate of each final finding once the fixer and the re-reviewer spoke:
// fixed (the fixer fixed it and the re-review found it resolved), declined
// (the fixer declined it and the re-review agreed), or open (anything else:
// no disposition, a re-review that says open or leaves the id out, or no
// re-review at all). rr is the re-review result {head, results, new_findings},
// or null when none ran (whyNot says why). New findings are open with ids N1...
// Answers are checked across fields, not just for shape, in this order: a
// re-review of another revision than delivered (the fix head) settles nothing
// (its new findings are still kept, open); two different answers for one id
// leave it open; so do a missing disposition, a disposition whose evidence is
// empty or only whitespace, a missing or non-resolved re-review result, and a
// re-review result whose evidence is empty or only whitespace.
// reReviewProblem says why a re-review result settles nothing, or null.
function reReviewProblem(rr, whyNot, delivered) {
  if (rr === null) return whyNot;
  if (delivered !== null && rr.head !== delivered) {
    return present(rr.head) ? `the final re-review judged ${rr.head}, not the delivered ${delivered}`
      : 'the final re-review did not say which revision it judged';
  }
  return null;
}

function settleFinalFindings(findings, dispositions, rr, whyNot = 'not re-reviewed', delivered = null) {
  // id -> the one answer given, or null when the answers disagree.
  const byId = (list, ok) => {
    const out = new Map();
    for (const x of Array.isArray(list) ? list : []) {
      if (!x || typeof x.id !== 'string' || !ok(x)) continue;
      const prev = out.get(x.id);
      out.set(x.id, prev === undefined || (prev !== null && prev.status === x.status) ? (prev || x) : null);
    }
    return out;
  };
  const said = byId(dispositions, (d) => d.status === 'fixed' || d.status === 'declined');
  const verdict = rr && Array.isArray(rr.results) ? byId(rr.results, () => true) : new Map();
  const none = reReviewProblem(rr, whyNot, delivered);
  const fixed = [];
  const declined = [];
  const open = [];
  for (const f of findings) {
    const d = said.get(f.id) || null;
    const v = verdict.get(f.id) || null;
    const withNotes = { ...f, disposition: d, review: v };
    if (none !== null) open.push({ ...withNotes, reason: none });
    else if (verdict.get(f.id) === null) open.push({ ...withNotes, reason: 'the final re-review gave contradictory results for it' });
    else if (said.get(f.id) === null) open.push({ ...withNotes, reason: 'the final fix gave contradictory dispositions for it' });
    else if (!d) open.push({ ...withNotes, reason: 'the final fix gave no disposition for it' });
    else if (!hasText(d.evidence)) open.push({ ...withNotes, reason: 'the final fix gave no evidence for it' });
    else if (!v || v.status !== 'resolved') {
      open.push({ ...withNotes, reason: v ? 'still open after the final re-review' : 'the final re-review gave no result for it' });
    } else if (!hasText(v.evidence)) open.push({ ...withNotes, reason: 'the final re-review gave no evidence for it' });
    else if (d.status === 'declined') declined.push({ ...withNotes, reason: d.reason });
    else fixed.push(withNotes);
  }
  const fresh = rr && Array.isArray(rr.new_findings) ? withFindingIds(rr.new_findings, 'N') : [];
  for (const f of fresh) open.push({ ...f, reason: 'new in the final fix' });
  return { fixed, declined, open };
}

// The test, lint and build commands the verify step must have run, in order
// ({group, command}): the final inventory, lane checks included.
function expectedChecks(m) {
  return finalChecks(m);
}

// Why a verify result at sha does not cover the commit itself, or null when
// git status showed no tracked or staged change before and after the checks
// (run-checks' tracked_before and tracked_after, porcelain lines). A result
// without the lists cannot show that, so it does not cover the commit either.
function uncleanChecksDetail(verify, sha) {
  const parts = [];
  for (const [field, when] of [['tracked_before', 'before'], ['tracked_after', 'after']]) {
    const lines = verify[field];
    if (!Array.isArray(lines)) parts.push(`they did not report tracked changes ${when} the commands (${field})`);
    else if (lines.length > 0) {
      parts.push(`uncommitted tracked changes ${when} the commands: ${lines.map((l) => JSON.stringify(l)).join(', ')}`);
    }
  }
  return parts.length === 0 ? null : `the project checks at ${sha} do not cover the commit: ${parts.join('; ')}`;
}

// input: {m, tasks (the run report's), final, e2e ({checked_sha, items}|null),
// verify (run-checks JSON|null), post ({status, checked_sha}|null),
// delivered_sha, fix_unreviewed}. Returns {status 'accepted'|'unverified'|
// 'rejected', delivered_sha, reasons: [{kind, class 'failed'|'missing',
// detail}], warnings: [string]}. rejected: something failed or is open or
// deferred; unverified: nothing failed, but required evidence is missing or
// covers another revision.
function acceptanceOf(input) {
  const { m, tasks, final, e2e, verify, post } = input;
  const sha = input.delivered_sha;
  const reasons = [];
  const warnings = [];
  const add = (kind, cls, detail) => reasons.push({ kind, class: cls, detail });

  const deferred = new Set(m.deferred || []);
  for (const [id, t] of Object.entries(tasks)) {
    if (t.status === 'deferred' || (t.status === 'skipped' && deferred.has(id))) {
      add('deferred_task', 'failed', `task ${id} was deferred by the adjudicator, not delivered: ${t.notes || 'see the ledger'}`);
    } else if (t.status !== 'done' && t.status !== 'skipped') {
      add('task_not_done', 'failed', `task ${id} is ${t.status}`);
    }
  }

  const want = expectedChecks(m);
  if (want.length === 0) {
    warnings.push('no test, lint or build command is configured, so no check ran at the delivered revision');
  } else if (!verify || !Array.isArray(verify.results)) {
    add('checks_missing', 'missing', 'the project checks did not run at the delivered revision');
  } else if (verify.head !== sha) {
    add('checks_stale', 'missing', `the project checks ran at ${verify.head}, not at the delivered ${sha}`);
  } else if (verify.results.length !== want.length
    || want.some((w, i) => verify.results[i].group !== w.group || verify.results[i].command !== w.command)) {
    add('checks_incomplete', 'missing', 'the verify step did not run exactly the configured test, lint and build commands');
  } else if (verify.ok !== true || verify.results.some((r) => r.exit !== 0)) {
    const failed = verify.results.filter((r) => r.exit !== 0).map((r) => `${r.command} (exit ${r.exit})`);
    add('checks_failed', 'failed', failed.length > 0 ? `failing at ${sha}: ${failed.join(', ')}` : `checks reported not ok at ${sha}`);
  }
  // Checks that ran on uncommitted tracked or staged changes, or changed a
  // tracked file, tested something other than the delivered commit.
  const unclean = want.length > 0 && verify && verify.head === sha ? uncleanChecksDetail(verify, sha) : null;
  if (unclean !== null) add('checks_unclean', 'missing', unclean);
  // Checks that leave files behind (build output that is not ignored, a
  // generated file) do not change what was delivered, but the user should
  // know the checkout was not clean after them.
  if (want.length > 0 && verify && verify.head === sha && unclean === null && verify.clean !== true) {
    warnings.push(verify.clean === false
      ? `the project checks left uncommitted changes in the checkout at ${sha} (git status was not clean afterwards)`
      : `the project checks did not report whether the checkout was clean at ${sha}`);
  }

  if (m.hooks.e2e) {
    if (!e2e || !Array.isArray(e2e.items) || e2e.items.length === 0) {
      add('e2e_missing', 'missing', 'the end-to-end check returned no items');
    } else if (e2e.checked_sha !== sha) {
      add('e2e_stale', 'missing', `the end-to-end check covered ${e2e.checked_sha || 'an unknown revision'}, not ${sha}`);
    } else {
      const failed = e2e.items.filter((i) => i.result !== 'PASS');
      if (failed.length > 0) add('e2e_failed', 'failed', `end-to-end FAIL at ${sha}: ${failed.map((i) => i.item).join(', ')}`);
    }
  }

  if (m.hooks.post_integrate && m.profile !== 'lite') {
    if (!post) add('post_integrate_missing', 'missing', 'the post-integration check did not run at the delivered revision');
    else if (post.checked_sha !== sha) {
      add('post_integrate_stale', 'missing', `the post-integration check covered ${post.checked_sha || 'an unknown revision'}, not ${sha}`);
    } else if (post.status !== 'done') add('post_integrate_failed', 'failed', `post-integration check failed: ${post.notes}`);
  }

  if (input.fix_unreviewed) add('fix_unreviewed', 'missing', 'a post-integration fix was not re-reviewed');
  if (final) {
    if (final.unreviewed_fix) add('final_fix_unreviewed', 'missing', final.unreviewed_fix);
    for (const lens of final.missing_lenses || []) add('review_missing', 'missing', `the ${lens} final review returned no result`);
    // Lenses that did not all review one commit (F2): their findings are not
    // bound to the delivered revision.
    if (hasText(final.review_problem)) add('review_unbound', 'missing', final.review_problem);
    const open = final.open || [];
    const blocking = open.filter(isBlocking);
    if (blocking.length > 0) {
      add('blocking_findings', 'failed', blocking.map((f) => `${f.id} [${f.severity}] ${f.file}:${f.line} ${f.issue} (${f.reason})`).join('; '));
    }
    for (const f of open.filter((x) => !isBlocking(x))) warnings.push(`open minor finding ${f.id}: ${f.file}:${f.line} ${f.issue}`);
    // Only sourced entries warn; a plain string is a note in the report.
    for (const item of (final.cannot_verify || []).filter(isSourced)) {
      warnings.push(`cannot verify: ${present(item.lens) ? `${item.lens}: ` : ''}${cannotVerifyText(item)}`);
    }
  } else {
    add('review_missing', 'missing', 'the final review did not run');
  }

  const status = reasons.some((r) => r.class === 'failed') ? 'rejected'
    : reasons.length > 0 ? 'unverified' : 'accepted';
  return { status, delivered_sha: sha, reasons, warnings };
}
