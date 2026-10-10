// ---- Run phases: setup, pre-flight, integration, E2E, final review ----
//
// Phase agents act on the repo only through git commands named in their
// prompts; the script itself never touches files or runs commands.

// Final review: three lenses in parallel (profile lite: one combined
// reviewer labelled `final review`), one fix agent, one re-review of every
// finding. tip is the real feature head: the first head a reviewer reported,
// else base (the feature tip the script tracked); on a resume after an
// earlier final fix the two differ. carried holds findings from before the
// final review (the post-integrate re-reviews, C2): they join the lenses'
// findings, so the one fix wave and the re-review cover them too.
// Findings get stable ids (F1...) before the fix; the fixer returns a
// disposition per id and the re-review a result per id, so a finding whose
// line or wording changes is still the same finding, and a declined finding
// is judged by the re-reviewer, not just by the fixer. The re-review runs
// whenever there are findings and a fix result, even without fix commits
// (declines still need judging). Returns {findings, fixed, declined, open,
// cannot_verify, missing_lenses, head, lens_heads, review_problem?}: head is
// the delivered feature head (the fix head when the fix committed), open
// lists every finding not fixed and not rightly declined, each with a reason;
// lens_heads is the head each lens reported and review_problem (absent when
// they all reviewed one commit) says why they did not. verifyAt(sha) runs the
// project checks (null: the project has none): once a fix agent ran,
// whatever it returned, they run at the delivered head before the re-review,
// which gets their result so it does not rerun them; the result is returned
// as final.verify (absent when no fix agent ran). taskMinors: the minor
// findings of approved task reviews (taskMinorFindings, ids T<task>-<n>):
// every lens gets them as a checklist and raises one by putting its id in
// brackets in a finding's issue; final.task_minors_open lists the ones no
// lens raised. A lens's cannot_verify entries carry its name: an object as
// lens, a plain string as a '<lens>: ' prefix.
async function runFinalReview(m, e2e, base, io, carried = [], verifyAt = null, taskMinors = []) {
  const standard = tierSettings('standard');
  const call = (label, prompt, schema) =>
    io.agent(prompt, { label, phase: 'Final review', schema, ...standard });
  // [label, lens name for findings and cannot_verify, prompt]
  const lenses = m.profile === 'lite'
    ? [['final review', 'combined', combinedFinalReviewPrompt(m, { e2e, minors: taskMinors })]]
    : [['sp', 'superpowers'], ['security', 'security'], ['correctness', 'correctness']]
      .map(([key, name]) => [`final review ${key}`, name, finalReviewPrompt(m, key, e2e, taskMinors)]);
  const results = await io.parallel(lenses.map(([label, , prompt]) => () =>
    call(label, prompt, finalReviewSchema())));
  const cannotVerify = [];
  const missing = [];
  lenses.forEach(([, name], i) => {
    const r = results[i];
    if (!r || !Array.isArray(r.findings)) missing.push(name);
    else {
      for (const item of r.cannot_verify || []) {
        cannotVerify.push(item !== null && typeof item === 'object' ? { ...item, lens: name } : `${name}: ${item}`);
      }
    }
  });
  const raised = results.flatMap((r) => (r && Array.isArray(r.findings) ? r.findings : []))
    .map((f) => (f && typeof f.issue === 'string' ? f.issue : '')).join('\n');
  const findings = withFindingIds(dedupeFindings([
    ...lenses.map(([, name], i) => ({ lens: name, findings: results[i] ? results[i].findings : null })),
    { lens: 'post-integrate re-review', findings: carried },
  ]));
  const lensHead = results.find((r) => r && isSha(r.head));
  const tip = lensHead ? lensHead.head : base;
  const lensHeads = lensHeadsOf(lenses.map(([, name]) => name), results);
  const final = {
    findings, fixed: [], declined: [], open: [], cannot_verify: cannotVerify, missing_lenses: missing, head: tip,
    lens_heads: lensHeads,
    task_minors_open: taskMinors.filter((t) => !raised.includes(`[${t.id}]`)),
  };
  const unbound = reviewProblemOf(lensHeads, results);
  if (unbound !== null) final.review_problem = unbound;
  if (findings.length === 0) return final;
  // A fix that committed is reviewed only by a re-review of its head: else
  // its commits are delivered unreviewed (unreviewed_fix, acceptance
  // final_fix_unreviewed), whatever the findings' severity.
  const settle = (dispositions, rr, why, delivered = null) => {
    Object.assign(final, settleFinalFindings(findings, dispositions, rr, why, delivered));
    const problem = reReviewProblem(rr, why, delivered);
    if (final.head !== tip && problem !== null) {
      final.unreviewed_fix = `the final fix ${tip}..${final.head} was not re-reviewed at ${final.head}: ${problem}`;
    }
    return final;
  };

  // Final fix tier (spec decision 5): Sonnet when every finding is minor or
  // every finding is in documentation; otherwise Opus. A Sonnet fix that does
  // not finish reruns once on Opus (same label); still one fix wave.
  const docsOnly = findings.every((f) => typeof f.file === 'string' && f.file.endsWith('.md'));
  const minorOnly = findings.every((f) => f.severity === 'minor');
  const fixSettings = minorOnly || docsOnly ? { model: 'sonnet', effort: 'high' } : standard;
  const callFix = (settings) => io.agent(finalFixPrompt(m, findings, tip),
    { label: 'final fix', phase: 'Final review', schema: finalFixSchema(), ...settings });
  let fix = await callFix(fixSettings);
  // A refused first call spawned no fix agent: no code changed, so the
  // caller's budget stop runs the checks.
  const fixRan = !(fix && fix.__budget);
  // Whatever a fix agent did, commits it reports are delivered code: a Sonnet
  // fix's head stands unless its Opus rerun reports a head of its own.
  // A head that is not a commit sha names no commit, so the run cannot say
  // what the fix delivered: a Sonnet fix reruns on Opus, and an Opus one
  // leaves every finding open.
  const badHead = (r) => Boolean(r && !r.__budget && present(r.head) && !isSha(r.head));
  if (fix && isSha(fix.head)) final.head = fix.head;
  if (fixSettings.model === 'sonnet' && (!fix || fix.status !== 'done' || badHead(fix))) fix = await callFix(standard);
  if (fix && isSha(fix.head)) final.head = fix.head;
  // The checks at the delivered head, before the re-review (spec: no
  // repeated checks at one commit).
  if (verifyAt !== null && fixRan) final.verify = await verifyAt(final.head);
  if (!fix || fix.__budget) return settle([], null, fix ? 'final fix not run: budget exhausted' : 'no result from final fix');
  if (fix.status !== 'done') return settle([], null, `final fix blocked: ${fix.notes}`);
  if (badHead(fix)) {
    const why = noHead(fix, 'the final fix');
    settle([], null, why);
    // Any commit it made past the tip is unknown to the run and unreviewed.
    final.unreviewed_fix = `${why}, so any commit it made past ${tip} was not re-reviewed`;
    return final;
  }
  const dispositions = Array.isArray(fix.dispositions) ? fix.dispositions : [];
  // The fixer's word on each finding, for the re-reviewer: every disposition
  // given for its id (more than one shows the contradiction).
  const verifying = findings.map((f) => ({ ...f, dispositions: dispositions.filter((d) => d && d.id === f.id) }));
  const rr = await call('final re-review', finalReReviewPrompt(m, tip, final.head, verifying, final.verify || null),
    finalReReviewSchema());
  // A refused re-review returns the budget sentinel, which has no results.
  if (!rr || !Array.isArray(rr.results)) {
    return settle(dispositions, null, rr && rr.__budget ? 'final re-review not run: budget exhausted'
      : 'no result from final re-review');
  }
  return settle(dispositions, rr, undefined, final.head);
}

// The head each final lens reported reviewing ({lens, head}): the string it
// reported, or null when it returned no result (or reported no string).
function lensHeadsOf(names, results) {
  return names.map((lens, i) => {
    const r = results[i];
    return { lens, head: r && !r.__budget && typeof r.head === 'string' ? r.head : null };
  });
}

// Why the final lenses' findings are not bound to one revision (F2), or null:
// a lens that returned findings (an array, even an empty one) without a
// commit sha as its head, or lenses that report different commit shas. The
// sentence names every lens and its head; a lens that returned no result is
// review_missing, so alone it is no problem here.
function reviewProblemOf(lensHeads, results) {
  const reviewed = (i) => Boolean(results[i] && Array.isArray(results[i].findings));
  const shas = new Set(lensHeads.filter((l) => isSha(l.head)).map((l) => l.head));
  const noSha = lensHeads.some((l, i) => reviewed(i) && !isSha(l.head));
  if (!noSha && shas.size <= 1) return null;
  const each = lensHeads.map((l, i) => (!reviewed(i) ? `${l.lens} returned no result`
    : l.head === null ? `${l.lens} reported no head` : `${l.lens} reported head ${JSON.stringify(l.head)}`));
  return `the final review lenses did not all review one commit: ${each.join(', ')}`;
}

// setup_result (scripts/setup) must name, for every lane, the worktree the
// run uses for it: its lane worktree, or the feature checkout under profile
// lite. The script cannot stat paths; scripts/setup guarantees they exist.
// Paths are compared in setup's Windows form (windowsPathForm), so a
// manifest written with '/c/wt' or 'c:\\wt' matches setup's 'C:/wt/...'.
// Returns error strings naming each lane that is missing or different.
function setupResultErrors(m) {
  if (!m.setup_result) return [];
  const errors = [];
  for (const lane of m.lanes) {
    const want = m.profile === 'lite' ? featureDir(m) : laneWhere(m, lane).dir;
    const got = m.setup_result.worktrees[lane.id];
    if (got === undefined) {
      errors.push(`setup_result.worktrees: missing a worktree for lane ${lane.id}`);
    } else if (windowsPathForm(got, true) !== windowsPathForm(want, true)) {
      errors.push(`setup_result.worktrees.${lane.id}: ${got} is not the worktree the run uses for lane ${lane.id} (${want})`);
    }
  }
  return errors;
}

// The last commit of each lane, {<lane id>: sha}: the head its lane run
// reported, else (a lane with nothing left to run) the backfill head of its
// last done task. A lane with neither is left out.
function laneTips(m, laneResults) {
  const backfill = m.backfill || {};
  const tips = {};
  for (const lane of m.lanes) {
    const lr = laneResults.find((r) => r.lane === lane.id);
    if (lr && isSha(lr.head)) {
      tips[lane.id] = lr.head;
      continue;
    }
    for (const t of lane.tasks) if (backfill[t.id]) tips[lane.id] = backfill[t.id].head;
  }
  return tips;
}

// The ids of the tasks an agent label belongs to: `<id> <role>`, or a batch
// `<first>-<last> <role>` covering first through last in plan order. Phase
// labels (setup, integrate, final review, ...) belong to no task.
function labelTasks(m, label) {
  const ids = [...m.prelude, ...m.lanes.flatMap((l) => l.tasks), ...m.join].map((t) => t.id);
  const head = label.split(' ')[0];
  if (ids.includes(head)) return [head];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      if (head === `${ids[i]}-${ids[j]}`) return ids.slice(i, j + 1);
    }
  }
  return [];
}

// A copy of the manifest whose notes carry the unblock note of each result
// (next_note) to the tasks of later whose depends_on names its task: later
// is the lanes and the join after the prelude, the join after the lanes (a
// list's own dependents get the note from runTaskList; lanes run at once, so
// a lane-to-lane note is not carried).
function withCarriedNotes(m, results, later) {
  const unblocked = results.filter((r) => present(r.next_note));
  if (unblocked.length === 0) return m;
  const notes = { ...(m.notes || {}) };
  for (const t of later) {
    for (const r of unblocked) {
      if (!(t.depends_on || []).some((d) => d.id === r.task)) continue;
      const line = `from ${r.task}, unblocked by the adjudicator: ${r.next_note}`;
      if (notes[t.id] && notes[t.id].includes(line)) continue;
      notes[t.id] = notes[t.id] ? `${notes[t.id]}\n${line}` : line;
    }
  }
  return { ...m, notes };
}

// The undeclared dependencies pre-flight reported, split into the entries
// the run keeps and the ones it drops with a reason: an entry must be an
// object with string task, producer and what, name two different task ids of
// the manifest, and name a task that is not done and reviewed (a done task
// still to review keeps its entry: its reviewer and fix agents use it).
function preflightUndeclared(m, entries) {
  const ids = new Set([...m.prelude, ...m.lanes.flatMap((l) => l.tasks), ...m.join].map((t) => t.id));
  const kept = [];
  const dropped = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const drop = (reason) => dropped.push({ entry, reason });
    const shaped = entry !== null && typeof entry === 'object' && !Array.isArray(entry) &&
      ['task', 'producer', 'what'].every((k) => typeof entry[k] === 'string');
    if (!shaped) drop('not an object with string task, producer and what');
    else if (!ids.has(entry.task)) drop(`task ${entry.task} is not in the run`);
    else if (!ids.has(entry.producer)) drop(`producer ${entry.producer} is not in the run`);
    else if (entry.task === entry.producer) drop('task and producer are the same');
    else if (taskState(m, entry.task) === 'skip') drop(`task ${entry.task} is already done and reviewed`);
    else kept.push({ task: entry.task, producer: entry.producer, what: entry.what });
  }
  return { kept, dropped };
}

// A copy of the manifest with consumes_extra: {<task>: [<producer>, ...]}
// from the kept undeclared entries, producers in entry order without
// duplicates. startCommand and the adjudicator's task-brief command pass
// them as --also, so each producer's Produces block reaches the task's
// briefs for this run (the manifest file is not changed).
function withConsumesExtra(m, kept) {
  const extra = {};
  for (const e of kept) {
    const list = extra[e.task] || (extra[e.task] = []);
    if (!list.includes(e.producer)) list.push(e.producer);
  }
  return { ...m, consumes_extra: extra };
}

// The whole run. io = {agent, log, phase, parallel}. Returns the report:
// {status:'complete'|'stopped'|'preflight_conflicts'|'invalid', run_id,
//  tasks:{<id>:{status, rounds, tier_used, commits:[base,head]|null, notes}},
//  stopped_lanes:[{lane, task, reason}], preflight:{conflicts, rulings, undeclared},
//  integrate:{status, notes, post_integrate, fix_review}, e2e:{items, checked_sha}|null,
//  final:{findings, fixed, declined, open, cannot_verify, missing_lenses, head, lens_heads,
//    review_problem?, task_minors_open},
//  verify (the run-checks result at the delivered revision, run once)|null,
//  delivered_sha, acceptance:{status, delivered_sha, reasons, warnings}|null
//  (complete runs only: status complete says the run executed to the end,
//  acceptance says whether the delivered revision meets the gates;
//  acceptanceOf), agents_spawned,
//  agent_settings ([{label, model, effort}] of every agent started, in start
//  order: state.spawned, see makeIo), rulings_spent (adjudications that ran;
//  a relaunch subtracts it from limits.max_rulings), reason (stopped runs only), errors (invalid only),
//  budget:{agents, rulings, limits} (reason budget only),
//  agent_type_fallback: true (only when a failing agent_type switched the
//  rest of the run to the default agent type; see makeIo)}.
// integrate.fix_review lists the findings of the post-integrate re-reviews
// (C2); they also reach the final fix wave. Task status is done, deferred
// (parked or unblocked by the adjudicator: never accepted), blocked, skipped
// (done and reviewed earlier), or not_run. Under profile lite no
// pre-flight agent runs (preflight has no conflicts, rulings or undeclared
// entries) and integrate stays null (validateManifest rejects lite with a
// post_integrate hook, so no configured hook is skipped).
async function runAll(manifest, io) {
  // Windows paths in forward-slash form, and hooks {} when absent, before
  // anything reads them.
  let m = normalizeManifestPaths(withDefaultHooks(manifest));
  let errors = validateManifest(m);
  if (errors.length === 0) errors = setupResultErrors(m);
  if (errors.length > 0) {
    const runId = m !== null && typeof m === 'object' && typeof m.run_id === 'string' ? m.run_id : null;
    return {
      status: 'invalid', run_id: runId, errors, tasks: {}, stopped_lanes: [], preflight: null,
      integrate: null, e2e: null, final: null, verify: null, delivered_sha: null, acceptance: null,
      agents_spawned: 0, rulings_spent: 0, agent_settings: [],
    };
  }

  // Every agent of the run spawns through the budget wrapper (budget.js).
  const state = { agents: 0, rulings: 0, refused: [], spawned: [] };
  const counted = makeIo(m, io, state);
  const standard = tierSettings('standard');
  const sonnetHigh = { model: 'sonnet', effort: 'high' };
  const call = (label, phaseName, prompt, schema) =>
    counted.agent(prompt, { label, phase: phaseName, schema, ...standard });
  const callM = (label, phaseName, prompt, schema, settings) =>
    counted.agent(prompt, { label, phase: phaseName, schema, ...settings });
  const autonomous = effectiveAutonomy(m) === 'autonomous';
  const hasChecks = checksCommand(m, null, featureDir(m)) !== null;

  // Run rulings come from this run's pre-flight only, never from the
  // manifest file.
  m = { ...m, run_rulings: [] };
  const tasks = {};
  const deferredBefore = new Set(m.deferred || []);
  for (const t of [...m.prelude, ...m.lanes.flatMap((l) => l.tasks), ...m.join]) {
    const range = taskState(m, t.id) === 'skip' ? (m.backfill || {})[t.id] : null;
    tasks[t.id] = {
      status: taskState(m, t.id) === 'skip' ? (deferredBefore.has(t.id) ? 'deferred' : 'skipped') : 'not_run',
      rounds: null,
      tier_used: null,
      commits: range ? [range.base, range.head] : null,
      notes: '',
    };
  }
  // The minor findings of approved task reviews, for the final lenses (a
  // batch's results repeat them for each task: listed once by id).
  const taskMinors = [];
  const record = (results) => {
    for (const r of results) {
      if (r.status === 'done') {
        for (const f of r.minor_findings || []) if (!taskMinors.some((x) => x.id === f.id)) taskMinors.push(f);
      }
      tasks[r.task] = {
        // A task the ledger lists as deferred stays deferred when skipped.
        status: r.status === 'skipped' && deferredBefore.has(r.task) ? 'deferred' : r.status,
        rounds: r.rounds,
        tier_used: r.tier_used,
        commits: present(r.base) && isSha(r.head) ? [r.base, r.head] : null,
        notes: r.notes,
      };
    }
  };
  const stoppedLanes = [];
  const stopAt = (lane, list) => {
    const last = list.results[list.results.length - 1];
    stoppedLanes.push({ lane, task: last && last.status !== 'done' ? last.task : null, reason: list.stopped });
  };
  let preflight = null;
  let integrate = null;
  let e2e = null;
  let final = null;
  let verify = null;
  let post = null;
  let delivered = null;
  let acceptance = null;
  // Set when a post-integrate fix's re-review returned no result (C2).
  let fixUnreviewed = false;
  // The post-integrate check's result and the revision it covered.
  let postCheck = null;
  const report = (status, reason = null) => ({
    status,
    run_id: m.run_id,
    tasks,
    stopped_lanes: stoppedLanes,
    preflight,
    integrate,
    e2e,
    final,
    verify,
    delivered_sha: delivered,
    acceptance,
    agents_spawned: state.agents,
    rulings_spent: state.rulings,
    agent_settings: state.spawned.slice(),
    ...(reason === null ? {} : { reason }),
    ...(reason === 'budget'
      ? { budget: { agents: state.agents, rulings: state.rulings, limits: effectiveLimits(m) } }
      : {}),
    ...(state.untyped ? { agent_type_fallback: true } : {}),
  });
  // The run stops (resumable) once an agent was refused: runAll checks
  // state.refused after every phase step, ahead of any other stop reason.
  // Each task whose agent was refused says so in its notes.
  const budgetReport = () => {
    const notes = new Map();
    for (const label of state.refused) {
      for (const id of labelTasks(m, label)) {
        notes.set(id, [...(notes.get(id) || []), `budget exhausted: ${label} was not run`]);
      }
    }
    for (const [id, lines] of notes) {
      const t = tasks[id];
      const text = lines.join('\n');
      t.notes = t.status === 'done' && t.notes ? `${t.notes}\n${text}` : text;
    }
    return report('stopped', 'budget');
  };

  const notices = launchNotices(m, planAgents(m));
  io.log(m.done.length > 0 ? notices.resume : notices.launch);

  // Setup: the session ran scripts/setup and passed its output (the only
  // setup; validateManifest requires it for a launch).
  const setup = m.setup_result;
  for (const item of setup.discarded || []) io.log(`parallel-lanes: discarded uncommitted change ${item}`);
  for (const p of setup.preserved || []) {
    io.log(`parallel-lanes: saved the discarded changes of ${p.worktree} as ${p.ref} (${p.commit})`);
  }
  if (!present(setup.feature_head)) return report('stopped', 'setup failed: no feature head reported');
  // The feature tip: the base of the next task on the feature branch.
  let tip = setup.feature_head;
  // Saved start points (ledger run_started events) replace the phase tip
  // only as the base of the prelude and join lists, so commits an earlier
  // attempt made at a first task before recording it are reviewed too. A
  // list that moved no head leaves the tip where the phase put it.
  const starts = m.start_points || {};
  const moved = (list) => list.results.some((r) => isSha(r.head));
  const listTip = (list) => (moved(list) ? list.head : tip);

  // Profile lite (spec D2): validateManifest above is the whole pre-flight;
  // the single lane runs on the feature branch, so there is no integration.
  const lite = m.profile === 'lite';
  if (lite) {
    preflight = { conflicts: [], rulings: [], undeclared: [] };
  } else {
    io.phase('Pre-flight');
    const pre = await call('pre-flight', 'Pre-flight', preflightPrompt(m), preflightSchema());
    if (state.refused.length > 0) return budgetReport();
    if (!pre) return report('stopped', 'no result from pre-flight');
    // Undeclared dependencies only add context: they reach the briefs of
    // their task and never stop the run or call the adjudicator.
    const { kept, dropped } = preflightUndeclared(m, pre.undeclared);
    for (const d of dropped) {
      io.log(`parallel-lanes: pre-flight: dropped undeclared entry ${JSON.stringify(d.entry)} (${d.reason})`);
    }
    for (const e of kept) io.log(`parallel-lanes: pre-flight: ${e.task} also consumes ${e.producer} (${e.what})`);
    preflight = { conflicts: pre.conflicts, rulings: [...pre.rulings], undeclared: kept };
    m = withConsumesExtra(m, kept);
    // Pre-flight's rulings bind every task and final reviewer of this run
    // (taskContext and the final review prompts show m.run_rulings).
    m = { ...m, run_rulings: [...pre.rulings] };
    if (pre.conflicts.length > 0) {
      // Supervised keeps Plan 1 (stop and wait); autonomous adjudicates (C1).
      if (!autonomous) return report('preflight_conflicts');
      const ruling = await adjudicate(m,
        { kind: 'preflight', task: null, where: null, details: pre.conflicts.join('\n'), findings: [] }, counted);
      if (state.refused.length > 0) return budgetReport();
      if (ruling.outcome === 'stop') {
        // An unavailable adjudicator (agent error) stops the run; a real stop
        // decision is a pre-flight conflict the user settles.
        if (ruling.unavailable) return report('stopped', ruling.text);
        return report('preflight_conflicts');
      }
      // The ruling joins the run rulings, so it reaches every task agent
      // still to run and the final reviewers.
      preflight.rulings.push(ruling.text);
      m = { ...m, run_rulings: [...m.run_rulings, ruling.text] };
    }
  }

  io.phase('Prelude');
  const prelude = await runTaskList(m, m.prelude, featureWhere(m, 'prelude'), starts.prelude || tip,
    counted, 'Prelude', true);
  record(prelude.results);
  m = withCarriedNotes(m, prelude.results, [...m.lanes.flatMap((l) => l.tasks), ...m.join]);
  if (prelude.stopped !== null) stopAt('prelude', prelude);
  if (state.refused.length > 0) return budgetReport();
  if (prelude.stopped !== null) return report('stopped', 'prelude stopped');
  tip = listTip(prelude);

  // The join's base, and whether it is a phase tip (P1: a backfilled first
  // task then reviews its own recorded range).
  let joinBase;
  let joinFromPhase = true;
  if (lite) {
    // The single lane continues the prelude on the feature branch: no lane
    // worktree, no sync, no integration. When the prelude moved no head the
    // lane's base is a phase tip (the saved setup start point if any), as
    // for the prelude itself. The join starts at the lane's last head; lite
    // records no join start point.
    const lane = m.lanes[0];
    const fromPhase = !moved(prelude);
    const list = await runTaskList(m, lane.tasks, featureWhere(m, lane.id),
      fromPhase ? starts.prelude || tip : tip, counted, lane.name, fromPhase);
    record(list.results);
    m = withCarriedNotes(m, list.results, m.join);
    if (list.stopped !== null) stopAt(lane.id, list);
    if (state.refused.length > 0) return budgetReport();
    if (list.stopped !== null) return report('stopped', 'lanes stopped');
    tip = listTip(list);
    joinBase = tip;
    joinFromPhase = fromPhase && !moved(list);
  } else {
    // Lane agents carry their lane's phase; lanes with nothing left are skipped.
    const laneResults = await runLanes(m, m.lanes.filter((l) => hasWork(m, l.tasks)), tip, counted);
    for (const lr of laneResults) {
      record(lr.results);
      m = withCarriedNotes(m, lr.results, m.join);
      if (lr.stopped !== null) stopAt(lr.lane, lr);
    }
    if (state.refused.length > 0) return budgetReport();
    if (stoppedLanes.length > 0) return report('stopped', 'lanes stopped');

    io.phase('Integrate');
    // A phase result that is done must also report the head it left.
    const phaseResult = (r, label) => {
      if (!r) return { status: 'failed', notes: `no result from ${label}` };
      if (r.status === 'done' && !isSha(r.head)) return { status: 'failed', notes: noHead(r, label) };
      return { status: r.status, notes: r.notes };
    };
    const preludeTip = tip;
    const BUDGET = Symbol('budget');
    // Post-integrate re-review findings (C2): reported under
    // integrate.fix_review and carried into the final fix wave.
    const fixReview = [];
    const integrateReport = (r) => ({ ...phaseResult(r, 'integrate'), post_integrate: null, fix_review: fixReview });
    // The Opus fix + scoped re-review (C2) for a post-integration failure.
    // Returns the head to rerun from (base when the fix made no commit), or
    // BUDGET when a spawn was refused.
    const fixPostIntegration = async (failureNotes, base) => {
      const fix = await callM('post-integrate fix', 'Integrate',
        postIntegrateFixPrompt(m, failureNotes), statusSchema(), standard);
      if (state.refused.length > 0) return BUDGET;
      if (fix && fix.status === 'done' && isSha(fix.head) && fix.head !== base) {
        const rr = await callM('post-integrate re-review', 'Integrate',
          postIntegrateReReviewPrompt(m, base, fix.head), postIntegrateReReviewSchema(), standard);
        if (state.refused.length > 0) return BUDGET;
        if (rr && Array.isArray(rr.findings)) fixReview.push(...rr.findings);
        else fixUnreviewed = true;
        return fix.head;
      }
      return base;
    };
    // Integrate starts on Sonnet with a prompt that never resolves conflicts
    // (D5). A conflict or any other failure escalates to an Opus rerun; in
    // autonomous mode a conflict first goes to an Opus resolver (C2).
    const joinNoHook = !m.hooks.post_integrate;
    // Each lane's last commit: a rerun counts a lane branch an earlier
    // cleanup deleted as merged when that commit is already in HEAD.
    const tips = laneTips(m, laneResults);
    let integ = await callM('integrate', 'Integrate',
      integratePrompt(m, preludeTip, { conflictMode: 'abort', joinStartPoint: joinNoHook, laneTips: tips }),
      statusSchema(), sonnetHigh);
    if (state.refused.length > 0) return budgetReport();
    // Any Sonnet result that is not a finished integration (a done without a
    // head included) escalates.
    if (phaseResult(integ, 'integrate').status !== 'done') {
      const conflicts = integ && Array.isArray(integ.conflict_files) ? integ.conflict_files : [];
      // The rerun reviews a resolution only when the resolver finished it;
      // otherwise it resolves the conflicts itself on the plain prompt.
      let resolved = null;
      if (conflicts.length > 0 && autonomous) {
        const res = await callM('resolve conflicts', 'Integrate',
          resolveConflictsPrompt(m, preludeTip, conflicts), statusSchema(), standard);
        if (state.refused.length > 0) return budgetReport();
        if (res && res.status === 'done' && isSha(res.head)) resolved = { files: conflicts, notes: res.notes };
      }
      // Every Sonnet failure or null escalates to one Opus rerun (D5).
      // Autonomous heals a residual command failure into tests_failed;
      // supervised uses the Plan 1 prompt (resolve only with confidence,
      // fail on a command failure) and stops if the rerun fails.
      integ = await callM('integrate', 'Integrate',
        integratePrompt(m, preludeTip, {
          testFailure: autonomous ? 'heal' : 'fail',
          reviewConflicts: resolved ? resolved.files : null,
          resolverNotes: resolved ? resolved.notes : null,
          joinStartPoint: joinNoHook,
          laneTips: tips,
        }), statusSchema(), standard);
      if (state.refused.length > 0) return budgetReport();
    }
    integrate = integrateReport(integ);
    if (integrate.status !== 'done') return report('stopped', `integration failed: ${integrate.notes}`);
    tip = integ.head;
    // Post-integration test failures (autonomous, C2): fix + re-review, then
    // rerun the integrate step once; still failing stops the run.
    if (autonomous && integ.tests_failed === true) {
      const from = await fixPostIntegration(integrate.notes || 'a project command failed after the merges', tip);
      if (from === BUDGET) return budgetReport();
      tip = from;
      integ = await callM('integrate', 'Integrate',
        integratePrompt(m, preludeTip, { testFailure: 'heal', joinStartPoint: joinNoHook, laneTips: tips }),
        statusSchema(), standard);
      if (state.refused.length > 0) return budgetReport();
      integrate = integrateReport(integ);
      if (integrate.status !== 'done' || integ.tests_failed === true) {
        return report('stopped', `integration failed: ${integrate.notes || 'tests still failing after the fix'}`);
      }
      tip = integ.head;
    }
    // Integrate reran the project commands at its head: the post-integrate
    // agent starting there is told their result, not to rerun them (null once
    // a post-integrate fix moved the tip, or when the project has none).
    const integrateChecks = () => (hasChecks && integ.head === tip
      ? { head: integ.head, ok: !integ.tests_failed } : null);
    if (m.hooks.post_integrate) {
      let post = await call('post-integrate', 'Integrate', postIntegratePrompt(m, false, integrateChecks()),
        statusSchema());
      if (state.refused.length > 0) return budgetReport();
      let pr = phaseResult(post, 'post-integrate');
      // Autonomous self-heal (C2): fix + re-review, then rerun the hook once.
      if (autonomous && pr.status !== 'done') {
        const from = await fixPostIntegration(pr.notes, tip);
        if (from === BUDGET) return budgetReport();
        tip = from;
        post = await call('post-integrate', 'Integrate', postIntegratePrompt(m, false, integrateChecks()),
          statusSchema());
        if (state.refused.length > 0) return budgetReport();
        pr = phaseResult(post, 'post-integrate');
      }
      integrate.post_integrate = pr;
      if (pr.status !== 'done') return report('stopped', `post-integrate failed: ${pr.notes}`);
      tip = post.head;
      // The revision the check covered: a later commit makes it stale.
      postCheck = { status: pr.status, notes: pr.notes, checked_sha: post.head };
    }
    joinBase = starts.join || tip;
  }

  io.phase('Join');
  const join = await runTaskList(m, m.join, featureWhere(m, 'join'), joinBase,
    counted, 'Join', joinFromPhase);
  record(join.results);
  if (join.stopped !== null) stopAt('join', join);
  if (state.refused.length > 0) return budgetReport();
  if (join.stopped !== null) return report('stopped', 'join stopped');
  tip = listTip(join);

  // E2E runs on Sonnet first (D5); a null result or any FAIL reruns it on
  // Opus (same label) and the Opus result is used. It records the revision
  // its checks covered.
  // checks: verify's result at the revision a recheck covers, or null.
  const runE2e = async (label, phaseName, checks = null) => {
    let r = await callM(label, phaseName, e2ePrompt(m, checks), e2eSchema(), sonnetHigh);
    if (state.refused.length > 0) return null;
    if (!r || (r.items || []).some((i) => i.result === 'FAIL')) {
      r = await callM(label, phaseName, e2ePrompt(m, checks), e2eSchema(), standard);
      if (state.refused.length > 0) return null;
    }
    return r && Array.isArray(r.items) ? { items: r.items, checked_sha: isSha(r.head) ? r.head : null }
      : { items: [], checked_sha: null, notes: `no result from ${label}` };
  };
  // The project checks at sha (scripts/run-checks through the verify agent).
  // They are cheap and deterministic, so they run past the agent cap: after
  // the last change the run has evidence even when the budget is spent.
  const verifyAt = (sha) => callM('verify', 'Verify', verifyPrompt(m, sha), verifySchema(),
    { ...sonnetHigh, overBudget: true });
  // A budget stop once every task is in: the checks still run at the
  // feature head the run reached, and the stopped report carries them.
  const budgetStopWithChecks = async (sha) => {
    if (hasChecks && present(sha)) {
      io.phase('Verify');
      verify = await verifyAt(sha);
    }
    return budgetReport();
  };

  if (m.hooks.e2e) {
    io.phase('E2E');
    e2e = await runE2e('e2e', 'E2E');
    if (state.refused.length > 0) return budgetStopWithChecks(tip);
  }

  io.phase('Final review');
  final = await runFinalReview(m, e2e, tip, counted, integrate ? integrate.fix_review : [],
    hasChecks ? verifyAt : null, taskMinors);
  // Checks that ran inside the final review (a fix agent ran) are the run's
  // verify: the report carries them once, at the top level.
  const verifiedInReview = 'verify' in final;
  if (verifiedInReview) {
    verify = final.verify;
    delete final.verify;
  }
  if (state.refused.length > 0) return verifiedInReview ? budgetReport() : budgetStopWithChecks(final.head);
  // The run's own gaps are sourced entries (source 'run'), so they warn.
  if (e2e !== null && e2e.notes) {
    final.cannot_verify.unshift({ requirement: 'the e2e check returned no result', source: 'run',
      why: e2e.notes, check_by: 'run the e2e hook at the delivered revision' });
  }
  if (fixUnreviewed) {
    final.cannot_verify.unshift({ requirement: 'the post-integrate re-review returned no result', source: 'run',
      why: 'the post-integration fix was delivered without a re-review', check_by: 're-review the post-integration fix' });
  }
  // Task minors live only in this launch's task results: the tasks an
  // earlier launch committed and reviewed are not re-run, so their approved
  // reviews' minor findings never reached the final lenses. Every resume
  // has such tasks, so this is a note (no source), not a warning.
  const earlier = [...m.prelude, ...m.lanes.flatMap((l) => l.tasks), ...m.join]
    .filter((t) => taskState(m, t.id) === 'skip').map((t) => t.id);
  if (earlier.length > 0) {
    final.cannot_verify.push(`the minor findings of the task reviews an earlier launch approved (${earlier.join(', ')})`
      + ' did not reach the final lenses or task_minors_open: a resumed run does not carry them; read those'
      + " tasks' approved reviews in the earlier launch's report");
  }
  delivered = final.head;

  // Verify: the evidence acceptance rests on, at the delivered revision.
  // The project checks always run there (scripts/run-checks), once: here
  // only when the final review ran no fix agent. The e2e and post-integrate
  // checks rerun only when a later commit made their evidence stale (the
  // post-integrate one check-only), told the project checks' result there.
  io.phase('Verify');
  if (hasChecks && !verifiedInReview) verify = await verifyAt(delivered);
  const checksHere = verify && verify.head === delivered ? verify : null;
  if (m.hooks.e2e && (!e2e || e2e.checked_sha !== delivered)) {
    e2e = await runE2e('e2e recheck', 'Verify', checksHere);
    if (state.refused.length > 0) return budgetReport();
  }
  if (m.hooks.post_integrate && !lite && (!postCheck || postCheck.checked_sha !== delivered)) {
    const r = await call('post-integrate recheck', 'Verify', postIntegratePrompt(m, true, checksHere), statusSchema());
    if (state.refused.length > 0) return budgetReport();
    const pr = phaseCheck(r, 'post-integrate recheck');
    postCheck = { ...pr, checked_sha: r && isSha(r.head) ? r.head : null };
    if (postCheck.checked_sha !== null && postCheck.checked_sha !== delivered) {
      postCheck = { status: 'failed', notes: `the recheck left HEAD at ${postCheck.checked_sha}`, checked_sha: delivered };
    }
  }
  post = postCheck;
  acceptance = acceptanceOf({
    m, tasks, final, e2e, verify, post, delivered_sha: delivered, fix_unreviewed: fixUnreviewed,
  });
  io.log(`parallel-lanes: acceptance ${acceptance.status} at ${delivered}`
    + (acceptance.reasons.length > 0 ? `: ${acceptance.reasons.map((r) => r.kind).join(', ')}` : ''));
  return report('complete');
}

// A phase agent's status result as {status, notes}: done only with a head.
function phaseCheck(r, label) {
  if (!r) return { status: 'failed', notes: `no result from ${label}` };
  if (r.status === 'done' && !isSha(r.head)) return { status: 'failed', notes: noHead(r, label) };
  return { status: r.status, notes: r.notes };
}

// Why a done phase result has no usable head: none reported, or one that is
// not a commit sha.
function noHead(r, label) {
  return present(r.head) ? `${label} reported head ${JSON.stringify(r.head)}, which is not a commit sha`
    : `${label} reported no head`;
}
