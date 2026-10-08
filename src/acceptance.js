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
// re-review at all). rr is the re-review result {results, new_findings}, or
// null when none ran (whyNot says why). New findings are open with ids N1...
function settleFinalFindings(findings, dispositions, rr, whyNot = 'not re-reviewed') {
  const said = new Map();
  for (const d of Array.isArray(dispositions) ? dispositions : []) {
    if (d && typeof d.id === 'string' && (d.status === 'fixed' || d.status === 'declined')) said.set(d.id, d);
  }
  const verdict = new Map();
  if (rr && Array.isArray(rr.results)) {
    for (const r of rr.results) if (r && typeof r.id === 'string') verdict.set(r.id, r);
  }
  const fixed = [];
  const declined = [];
  const open = [];
  for (const f of findings) {
    const d = said.get(f.id) || null;
    const v = verdict.get(f.id) || null;
    const withNotes = { ...f, disposition: d, review: v };
    if (rr === null) open.push({ ...withNotes, reason: whyNot });
    else if (!v || v.status !== 'resolved') {
      open.push({ ...withNotes, reason: v ? 'still open after the final re-review' : 'the final re-review gave no result for it' });
    } else if (d && d.status === 'declined') declined.push({ ...withNotes, reason: d.reason });
    else fixed.push(withNotes);
  }
  const fresh = rr && Array.isArray(rr.new_findings) ? withFindingIds(rr.new_findings, 'N') : [];
  for (const f of fresh) open.push({ ...f, reason: 'new in the final fix' });
  return { fixed, declined, open };
}

// The test, lint and build commands the verify step must have run, in order
// ({group, command}).
function expectedChecks(m) {
  const out = [];
  for (const group of ['test', 'lint', 'build']) for (const command of m.commands[group] || []) out.push({ group, command });
  return out;
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
    for (const lens of final.missing_lenses || []) add('review_missing', 'missing', `the ${lens} final review returned no result`);
    const open = final.open || [];
    const blocking = open.filter(isBlocking);
    if (blocking.length > 0) {
      add('blocking_findings', 'failed', blocking.map((f) => `${f.id} [${f.severity}] ${f.file}:${f.line} ${f.issue} (${f.reason})`).join('; '));
    }
    for (const f of open.filter((x) => !isBlocking(x))) warnings.push(`open minor finding ${f.id}: ${f.file}:${f.line} ${f.issue}`);
    for (const item of final.cannot_verify || []) warnings.push(`cannot verify: ${item}`);
  } else {
    add('review_missing', 'missing', 'the final review did not run');
  }

  const status = reasons.some((r) => r.class === 'failed') ? 'rejected'
    : reasons.length > 0 ? 'unverified' : 'accepted';
  return { status, delivered_sha: sha, reasons, warnings };
}
