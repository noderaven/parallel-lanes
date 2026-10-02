// ---- Run phases: setup, pre-flight, integration, E2E, final review ----
//
// Phase agents act on the repo only through git commands named in their
// prompts; the script itself never touches files or runs commands.

// Final review: three lenses in parallel, one fix agent, one scoped
// re-review of tip..fix head. tip is the real feature head: the first head a
// lens reported, else base (the feature tip the script tracked); on a resume
// after an earlier final fix the two differ. Returns {findings, fixed,
// declined, cannot_verify}; declined entries carry a reason (declined by the
// fix agent, not fixed, or still open after the re-review).
async function runFinalReview(m, e2e, base, io) {
  const standard = tierSettings('standard');
  const call = (label, prompt, schema) =>
    io.agent(prompt, { label, phase: 'Final review', schema, ...standard });
  const lenses = [['sp', 'superpowers'], ['security', 'security'], ['correctness', 'correctness']];
  const results = await io.parallel(lenses.map(([key]) => () =>
    call(`final review ${key}`, finalReviewPrompt(m, key, e2e), finalReviewSchema())));
  const cannotVerify = [];
  lenses.forEach(([, name], i) => {
    const r = results[i];
    if (!r) cannotVerify.push(`the ${name} review returned no result`);
    else for (const item of r.cannot_verify || []) cannotVerify.push(`${name}: ${item}`);
  });
  const findings = dedupeFindings(lenses.map(([, name], i) =>
    ({ lens: name, findings: results[i] ? results[i].findings : null })));
  const final = { findings, fixed: [], declined: [], cannot_verify: cannotVerify };
  if (findings.length === 0) return final;
  const lensHead = results.find((r) => r && present(r.head));
  const tip = lensHead ? lensHead.head : base;

  const declineAll = (reason) => {
    final.declined = findings.map((f) => ({ ...f, reason }));
    return final;
  };
  const fix = await call('final fix', finalFixPrompt(m, findings, tip), finalFixSchema());
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
  if (!rr) {
    for (const f of attempted) final.declined.push({ ...f, reason: 'no result from final re-review' });
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

// The whole run. io = {agent, log, phase, parallel}. Returns the report:
// {status:'complete'|'stopped'|'preflight_conflicts'|'invalid', run_id,
//  tasks:{<id>:{status, rounds, tier_used, commits:[base,head]|null, notes}},
//  stopped_lanes:[{lane, task, reason}], preflight:{conflicts, rulings},
//  integrate:{status, notes, post_integrate}, e2e:{items}|null,
//  final:{findings, fixed, declined, cannot_verify}, agents_spawned,
//  reason (stopped runs only), errors (invalid only),
//  budget:{agents, rulings, limits} (reason budget only)}.
// Task status is done, blocked, skipped (done and reviewed earlier), or
// not_run.
async function runAll(m, io) {
  let errors = validateManifest(m);
  if (errors.length === 0) errors = setupResultErrors(m);
  if (errors.length > 0) {
    const runId = m !== null && typeof m === 'object' && typeof m.run_id === 'string' ? m.run_id : null;
    return {
      status: 'invalid', run_id: runId, errors, tasks: {}, stopped_lanes: [], preflight: null,
      integrate: null, e2e: null, final: null, agents_spawned: 0,
    };
  }

  // Every agent of the run spawns through the budget wrapper (budget.js).
  const state = { agents: 0, rulings: 0, refused: [] };
  const counted = makeIo(m, io, state);
  const standard = tierSettings('standard');
  const call = (label, phaseName, prompt, schema) =>
    counted.agent(prompt, { label, phase: phaseName, schema, ...standard });

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
    ...(reason === null ? {} : { reason }),
    ...(reason === 'budget'
      ? { budget: { agents: state.agents, rulings: state.rulings, limits: effectiveLimits(m) } }
      : {}),
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
  const listTip = (list) => (list.results.some((r) => present(r.head)) ? list.head : tip);

  io.phase('Pre-flight');
  const pre = await call('pre-flight', 'Pre-flight', preflightPrompt(m), preflightSchema());
  if (state.refused.length > 0) return budgetReport();
  if (!pre) return report('stopped', 'no result from pre-flight');
  preflight = { conflicts: pre.conflicts, rulings: pre.rulings };
  if (pre.conflicts.length > 0) return report('preflight_conflicts');

  io.phase('Prelude');
  const prelude = await runTaskList(m, m.prelude, featureWhere(m, 'prelude'), starts.prelude || tip,
    counted, 'Prelude', true);
  record(prelude.results);
  if (prelude.stopped !== null) stopAt('prelude', prelude);
  if (state.refused.length > 0) return budgetReport();
  if (prelude.stopped !== null) return report('stopped', 'prelude stopped');
  tip = listTip(prelude);

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
  const integ = await call('integrate', 'Integrate', integratePrompt(m, tip), statusSchema());
  if (state.refused.length > 0) return budgetReport();
  integrate = { ...phaseResult(integ, 'integrate'), post_integrate: null };
  if (integrate.status !== 'done') return report('stopped', `integration failed: ${integrate.notes}`);
  tip = integ.head;
  if (m.hooks.post_integrate) {
    const post = await call('post-integrate', 'Integrate', postIntegratePrompt(m), statusSchema());
    if (state.refused.length > 0) return budgetReport();
    integrate.post_integrate = phaseResult(post, 'post-integrate');
    if (integrate.post_integrate.status !== 'done') {
      return report('stopped', `post-integrate failed: ${integrate.post_integrate.notes}`);
    }
    tip = post.head;
  }

  io.phase('Join');
  const join = await runTaskList(m, m.join, featureWhere(m, 'join'), starts.join || tip,
    counted, 'Join', true);
  record(join.results);
  if (join.stopped !== null) stopAt('join', join);
  if (state.refused.length > 0) return budgetReport();
  if (join.stopped !== null) return report('stopped', 'join stopped');
  tip = listTip(join);

  if (m.hooks.e2e) {
    io.phase('E2E');
    const r = await call('e2e', 'E2E', e2ePrompt(m), e2eSchema());
    if (state.refused.length > 0) return budgetReport();
    e2e = r ? { items: r.items } : { items: [], notes: 'no result from e2e' };
  }

  io.phase('Final review');
  final = await runFinalReview(m, e2e, tip, counted);
  if (state.refused.length > 0) return budgetReport();
  if (e2e !== null && e2e.notes) final.cannot_verify.unshift('the e2e check returned no result');
  return report('complete');
}
