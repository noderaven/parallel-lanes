// ---- Run phases: setup, pre-flight, integration, E2E, final review ----
//
// Phase agents act on the repo only through git commands named in their
// prompts; the script itself never touches files or runs commands.

// Final review: three lenses in parallel (profile lite: one combined
// reviewer labelled `final review`), one fix agent, one scoped re-review of
// tip..fix head. tip is the real feature head: the first head a reviewer
// reported, else base (the feature tip the script tracked); on a resume
// after an earlier final fix the two differ. Returns {findings, fixed,
// declined, cannot_verify}; declined entries carry a reason (declined by the
// fix agent, not fixed, or still open after the re-review). carried holds
// findings from before the final review (the post-integrate re-reviews, C2):
// they join the lenses' findings, so the one fix wave and the final
// re-review cover them too.
async function runFinalReview(m, e2e, base, io, carried = []) {
  const standard = tierSettings('standard');
  const call = (label, prompt, schema) =>
    io.agent(prompt, { label, phase: 'Final review', schema, ...standard });
  // [label, lens name for findings and cannot_verify, prompt]
  const lenses = m.profile === 'lite'
    ? [['final review', 'combined', combinedFinalReviewPrompt(m, { e2e })]]
    : [['sp', 'superpowers'], ['security', 'security'], ['correctness', 'correctness']]
      .map(([key, name]) => [`final review ${key}`, name, finalReviewPrompt(m, key, e2e)]);
  const results = await io.parallel(lenses.map(([label, , prompt]) => () =>
    call(label, prompt, finalReviewSchema())));
  const cannotVerify = [];
  lenses.forEach(([, name], i) => {
    const r = results[i];
    if (!r) cannotVerify.push(`the ${name} review returned no result`);
    else for (const item of r.cannot_verify || []) cannotVerify.push(`${name}: ${item}`);
  });
  const findings = dedupeFindings([
    ...lenses.map(([, name], i) => ({ lens: name, findings: results[i] ? results[i].findings : null })),
    { lens: 'post-integrate re-review', findings: carried },
  ]);
  const final = { findings, fixed: [], declined: [], cannot_verify: cannotVerify };
  if (findings.length === 0) return final;
  const lensHead = results.find((r) => r && present(r.head));
  const tip = lensHead ? lensHead.head : base;

  const declineAll = (reason) => {
    final.declined = findings.map((f) => ({ ...f, reason }));
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
  if (fixSettings.model === 'sonnet' && (!fix || fix.status !== 'done')) fix = await callFix(standard);
  if (!fix) return declineAll('no result from final fix');
  if (fix.status !== 'done') return declineAll(`final fix blocked: ${fix.notes}`);
  const declinedKeys = new Set((fix.declined || []).map(findingKey));
  final.declined = (fix.declined || []).map((d) => {
    const f = findings.find((x) => findingKey(x) === findingKey(d));
    return { ...(f || d), reason: d.reason };
  });
  const attempted = findings.filter((f) => !declinedKeys.has(findingKey(f)));
  if (attempted.length === 0) return final;
  if (!present(fix.head) || fix.head === tip) {
    for (const f of attempted) final.declined.push({ ...f, reason: 'final fix made no commits' });
    return final;
  }
  const rr = await call('final re-review', finalReReviewPrompt(m, tip, fix.head, attempted),
    finalReReviewSchema());
  // A refused re-review returns the budget sentinel, which has no findings.
  if (!rr || !Array.isArray(rr.findings)) {
    const reason = rr && rr.__budget ? 'final re-review not run: budget exhausted'
      : 'no result from final re-review';
    for (const f of attempted) final.declined.push({ ...f, reason });
    return final;
  }
  const openKeys = new Set(rr.findings.map(findingKey));
  final.fixed = attempted.filter((f) => !openKeys.has(findingKey(f)));
  for (const f of rr.findings) final.declined.push({ ...f, reason: 'still open after the final re-review' });
  return final;
}

// setup_result (scripts/setup) must name, for every lane, the worktree the
// run uses for it: its lane worktree, or the feature checkout under profile
// lite. The script cannot stat paths; scripts/setup guarantees they exist.
// Returns error strings naming each lane that is missing or different.
function setupResultErrors(m) {
  if (!m.setup_result) return [];
  const errors = [];
  for (const lane of m.lanes) {
    const want = m.profile === 'lite' ? featureDir(m) : laneWhere(m, lane).dir;
    const got = m.setup_result.worktrees[lane.id];
    if (got === undefined) {
      errors.push(`setup_result.worktrees: missing a worktree for lane ${lane.id}`);
    } else if (got !== want) {
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
    if (lr && present(lr.head)) {
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

// A copy of the manifest whose notes for every not-yet-done task gain the
// pre-flight ruling (spec C1). taskContext shows a task's note, so the ruling
// binds every task agent for this run without an engine change.
function preflightResolved(m, text) {
  const line = `Pre-flight ruling (binding for this run): ${text}`;
  const notes = { ...(m.notes || {}) };
  const done = new Set(m.done);
  for (const t of [...m.prelude, ...m.lanes.flatMap((l) => l.tasks), ...m.join]) {
    if (done.has(t.id)) continue;
    notes[t.id] = notes[t.id] ? `${notes[t.id]}\n${line}` : line;
  }
  return { ...m, notes };
}

// The whole run. io = {agent, log, phase, parallel}. Returns the report:
// {status:'complete'|'stopped'|'preflight_conflicts'|'invalid', run_id,
//  tasks:{<id>:{status, rounds, tier_used, commits:[base,head]|null, notes}},
//  stopped_lanes:[{lane, task, reason}], preflight:{conflicts, rulings},
//  integrate:{status, notes, post_integrate, fix_review}, e2e:{items}|null,
//  final:{findings, fixed, declined, cannot_verify}, agents_spawned,
//  rulings_spent (adjudications that ran; a relaunch subtracts it from
//  limits.max_rulings), reason (stopped runs only), errors (invalid only),
//  budget:{agents, rulings, limits} (reason budget only),
//  agent_type_fallback: true (only when a failing agent_type switched the
//  rest of the run to the default agent type; see makeIo)}.
// integrate.fix_review lists the findings of the post-integrate re-reviews
// (C2); they also reach the final fix wave. Task status is done, blocked,
// skipped (done and reviewed earlier), or not_run. Under profile lite no
// pre-flight agent runs (preflight has no conflicts or rulings) and
// integrate stays null (validateManifest rejects lite with a post_integrate
// hook, so no configured hook is skipped).
async function runAll(m, io) {
  let errors = validateManifest(m);
  if (errors.length === 0) errors = setupResultErrors(m);
  if (errors.length > 0) {
    const runId = m !== null && typeof m === 'object' && typeof m.run_id === 'string' ? m.run_id : null;
    return {
      status: 'invalid', run_id: runId, errors, tasks: {}, stopped_lanes: [], preflight: null,
      integrate: null, e2e: null, final: null, agents_spawned: 0, rulings_spent: 0,
    };
  }

  // Every agent of the run spawns through the budget wrapper (budget.js).
  const state = { agents: 0, rulings: 0, refused: [] };
  const counted = makeIo(m, io, state);
  const standard = tierSettings('standard');
  const sonnetHigh = { model: 'sonnet', effort: 'high' };
  const call = (label, phaseName, prompt, schema) =>
    counted.agent(prompt, { label, phase: phaseName, schema, ...standard });
  const callM = (label, phaseName, prompt, schema, settings) =>
    counted.agent(prompt, { label, phase: phaseName, schema, ...settings });
  const autonomous = effectiveAutonomy(m) === 'autonomous';

  const tasks = {};
  for (const t of [...m.prelude, ...m.lanes.flatMap((l) => l.tasks), ...m.join]) {
    const range = taskState(m, t.id) === 'skip' ? (m.backfill || {})[t.id] : null;
    tasks[t.id] = {
      status: taskState(m, t.id) === 'skip' ? 'skipped' : 'not_run',
      rounds: null,
      tier_used: null,
      commits: range ? [range.base, range.head] : null,
      notes: '',
    };
  }
  const record = (results) => {
    for (const r of results) {
      tasks[r.task] = {
        status: r.status,
        rounds: r.rounds,
        tier_used: r.tier_used,
        commits: present(r.base) && present(r.head) ? [r.base, r.head] : null,
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
  // Set when a post-integrate fix's re-review returned no result (C2).
  let fixUnreviewed = false;
  const report = (status, reason = null) => ({
    status,
    run_id: m.run_id,
    tasks,
    stopped_lanes: stoppedLanes,
    preflight,
    integrate,
    e2e,
    final,
    agents_spawned: state.agents,
    rulings_spent: state.rulings,
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

  const planned = planAgents(m);
  if (m.done.length > 0) {
    io.log(`parallel-lanes: resuming run ${m.run_id}: ${m.done.length} tasks already committed`);
  } else {
    const lanesWithWork = new Set(planned.filter((a) => a.lane !== null).map((a) => a.lane)).size;
    io.log(`parallel-lanes: launching run ${m.run_id}: ${lanesWithWork} lanes, ${planned.length} agents`);
  }

  // Setup: the session ran scripts/setup and passed its output; without it
  // (a hand-written manifest) the Setup agent does the same work.
  let setup = m.setup_result;
  if (!setup) {
    io.phase('Setup');
    setup = await call('setup', 'Setup', setupPrompt(m), setupSchema());
    if (state.refused.length > 0) return budgetReport();
    if (!setup || setup.ok !== true) {
      return report('stopped', `setup failed: ${setup ? setup.notes : 'no result from setup'}`);
    }
  }
  for (const item of setup.discarded || []) io.log(`parallel-lanes: discarded uncommitted change ${item}`);
  if (!present(setup.feature_head)) return report('stopped', 'setup failed: no feature head reported');
  // The feature tip: the base of the next task on the feature branch.
  let tip = setup.feature_head;
  // Saved start points (ledger run_started events) replace the phase tip
  // only as the base of the prelude and join lists, so commits an earlier
  // attempt made at a first task before recording it are reviewed too. A
  // list that moved no head leaves the tip where the phase put it.
  const starts = m.start_points || {};
  const moved = (list) => list.results.some((r) => present(r.head));
  const listTip = (list) => (moved(list) ? list.head : tip);

  // Profile lite (spec D2): validateManifest above is the whole pre-flight;
  // the single lane runs on the feature branch, so there is no integration.
  const lite = m.profile === 'lite';
  if (lite) {
    preflight = { conflicts: [], rulings: [] };
  } else {
    io.phase('Pre-flight');
    const pre = await call('pre-flight', 'Pre-flight', preflightPrompt(m), preflightSchema());
    if (state.refused.length > 0) return budgetReport();
    if (!pre) return report('stopped', 'no result from pre-flight');
    preflight = { conflicts: pre.conflicts, rulings: [...pre.rulings] };
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
      // The ruling binds every not-yet-done task: taskContext shows each
      // task's note, so the ruling reaches every task agent.
      preflight.rulings.push(ruling.text);
      m = preflightResolved(m, ruling.text);
    }
  }

  io.phase('Prelude');
  const prelude = await runTaskList(m, m.prelude, featureWhere(m, 'prelude'), starts.prelude || tip,
    counted, 'Prelude', true);
  record(prelude.results);
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
      if (lr.stopped !== null) stopAt(lr.lane, lr);
    }
    if (state.refused.length > 0) return budgetReport();
    if (stoppedLanes.length > 0) return report('stopped', 'lanes stopped');

    io.phase('Integrate');
    // A phase result that is done must also report the head it left.
    const phaseResult = (r, label) => {
      if (!r) return { status: 'failed', notes: `no result from ${label}` };
      if (r.status === 'done' && !present(r.head)) return { status: 'failed', notes: `${label} reported no head` };
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
      if (fix && fix.status === 'done' && present(fix.head) && fix.head !== base) {
        const rr = await callM('post-integrate re-review', 'Integrate',
          postIntegrateReReviewPrompt(m, base, fix.head), finalReReviewSchema(), standard);
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
        if (res && res.status === 'done' && present(res.head)) resolved = { files: conflicts, notes: res.notes };
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
    if (m.hooks.post_integrate) {
      let post = await call('post-integrate', 'Integrate', postIntegratePrompt(m), statusSchema());
      if (state.refused.length > 0) return budgetReport();
      let pr = phaseResult(post, 'post-integrate');
      // Autonomous self-heal (C2): fix + re-review, then rerun the hook once.
      if (autonomous && pr.status !== 'done') {
        const from = await fixPostIntegration(pr.notes, tip);
        if (from === BUDGET) return budgetReport();
        tip = from;
        post = await call('post-integrate', 'Integrate', postIntegratePrompt(m), statusSchema());
        if (state.refused.length > 0) return budgetReport();
        pr = phaseResult(post, 'post-integrate');
      }
      integrate.post_integrate = pr;
      if (pr.status !== 'done') return report('stopped', `post-integrate failed: ${pr.notes}`);
      tip = post.head;
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

  if (m.hooks.e2e) {
    io.phase('E2E');
    // E2E runs on Sonnet first (D5); a null result or any FAIL reruns it on
    // Opus (same label) and the Opus result is used.
    let r = await callM('e2e', 'E2E', e2ePrompt(m), e2eSchema(), sonnetHigh);
    if (state.refused.length > 0) return budgetReport();
    if (!r || (r.items || []).some((i) => i.result === 'FAIL')) {
      r = await callM('e2e', 'E2E', e2ePrompt(m), e2eSchema(), standard);
      if (state.refused.length > 0) return budgetReport();
    }
    e2e = r ? { items: r.items } : { items: [], notes: 'no result from e2e' };
  }

  io.phase('Final review');
  final = await runFinalReview(m, e2e, tip, counted, integrate ? integrate.fix_review : []);
  if (state.refused.length > 0) return budgetReport();
  if (e2e !== null && e2e.notes) final.cannot_verify.unshift('the e2e check returned no result');
  if (fixUnreviewed) final.cannot_verify.unshift('the post-integrate re-review returned no result');
  return report('complete');
}
