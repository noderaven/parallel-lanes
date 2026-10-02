// ---- Execution engine: per-task loop and lanes ----
//
// Every function below is pure over its parameters (no top-level const/let),
// so tests can load them with loadHelpers. The run functions take a trailing
// io object {agent, log} that defaults to the Workflow globals.

// Run one task through implement -> review -> fix/re-review rounds.
// Returns {task, status:'done'|'blocked', base, head, rounds, tier_used, notes};
// for a blocked task notes is the reason (exactly 'review_rounds' at the cap).
// base is owned by the script (the previous task's head, or the feature tip):
// every review range starts there, so commits of an earlier failed attempt
// are reviewed too. resume ({base, head}, optional) is a task committed in an
// earlier run but not reviewed: implement is skipped and the loop starts with
// the review of base..resume.head.
async function runTask(m, task, where, base, io = { agent, log }, resume = null) {
  const phaseName = lanePhase(m, where.lane);
  const standard = tierSettings('standard');
  let tierUsed = task.tier;
  let head = null;
  let rounds = 0;
  let changesSeen = 0;
  let latest = null;
  let verdict = null;
  const extra = [];

  const result = (status, notes) =>
    ({ task: task.id, status, base, head, rounds, tier_used: tierUsed, notes });
  const call = (role, prompt, settings, schema) =>
    io.agent(prompt, { label: `${task.id} ${role}`, phase: phaseName, schema, ...settings });
  const escalate = (reason) => {
    tierUsed = 'standard';
    extra.push(`escalated to standard: ${reason}`);
    io.log(`${task.id}: escalating to standard (${reason})`);
  };
  // An implement or fix result that moved the branch past from; else why
  // it did not.
  const failure = (r, label, from) => {
    if (r === null || r === undefined) return `no result from ${label}`;
    if (r.status !== 'done') return `${label} blocked: ${r.notes}`;
    if (!present(r.head)) return `${label} reported no head`;
    if (r.head === from) return `${label} reported done with no new commits`;
    return null;
  };
  // Implement, escalating a light task once if it does not finish.
  const implement = async (retry) => {
    for (;;) {
      const from = head === null ? base : head;
      const r = await call('implement', implementPrompt(m, task, where, base, retry),
        tierSettings(tierUsed), implementSchema());
      const why = failure(r, `${task.id} implement`, from);
      if (why === null) {
        head = r.head;
        latest = r;
        return null;
      }
      if (tierUsed !== 'light') return why;
      escalate(why);
      retry = { reason: why, findings: null };
    }
  };
  let reviewLabel = 'review';
  const review = () => {
    reviewLabel = 'review';
    return call('review', reviewPrompt(m, task, where, base, head, rounds), standard, reviewSchema());
  };

  // Escalate a light task: rerun implement at standard from the current
  // head with the open findings, then review the whole task range again.
  const rerunAtStandard = async (reason, findings) => {
    escalate(reason);
    const blockedWhy = await implement({ reason, findings });
    if (blockedWhy !== null) return blockedWhy;
    verdict = await review();
    return null;
  };

  let why = null;
  if (resume) {
    head = resume.head;
    latest = { status: 'done', head, tests: '(committed in an earlier run)', notes: '' };
  } else {
    why = await implement(null);
    if (why !== null) return result('blocked', why);
  }

  verdict = await review();
  for (;;) {
    if (!verdict || (verdict.verdict !== 'approve' && verdict.verdict !== 'changes')) {
      return result('blocked', `no result from ${task.id} ${reviewLabel}`);
    }
    if (verdict.verdict === 'approve') break;
    changesSeen += 1;
    const findings = verdict.findings;
    if (changesSeen === 2 && tierUsed === 'light') {
      why = await rerunAtStandard('review requested changes twice', findings);
      if (why !== null) return result('blocked', why);
      continue;
    }
    if (rounds >= m.limits.review_rounds) return result('blocked', 'review_rounds');
    rounds += 1;
    const fixLabel = `fix ${rounds}`;
    const fix = await call(fixLabel, fixPrompt(m, task, where, findings, latest, head),
      tierSettings(tierUsed), implementSchema());
    why = failure(fix, `${task.id} ${fixLabel}`, head);
    if (why !== null && tierUsed === 'light') {
      why = await rerunAtStandard(why, findings);
      if (why !== null) return result('blocked', why);
      continue;
    }
    if (why !== null) return result('blocked', why);
    const prevHead = head;
    head = fix.head;
    latest = fix;
    reviewLabel = `re-review ${rounds}`;
    verdict = await call(reviewLabel,
      reReviewPrompt(m, task, where, prevHead, head, findings, rounds), standard, reviewSchema());
  }

  const notes = [...extra];
  if (latest.notes) notes.push(latest.notes);
  for (const f of verdict.findings || []) notes.push(`minor finding: ${f.file}:${f.line} - ${f.issue}`);
  for (const item of verdict.cannot_verify || []) notes.push(`cannot verify: ${item}`);
  return result('done', notes.join('\n'));
}

// Run tasks in order at where, starting from base; skip done-and-reviewed
// tasks, review done-only tasks first; stop at the first task that is not
// done. Each task's base is the previous task's head (a skipped task's from
// its backfill entry). Returns {results, stopped:reason|null, head} where head
// is the last known head (base when no task moved it).
// baseIsPhaseTip: base is a head a phase agent reported (setup's feature head,
// the integrate or post-integrate head). On a resume that tip can already sit
// at or past this list's commits, so a done but unreviewed task that no
// earlier task in the list precedes is reviewed on its backfill range instead.
async function runTaskList(m, tasks, where, base, io, name, baseIsPhaseTip = false) {
  const results = [];
  let prev = base;
  let prevIsPhaseTip = baseIsPhaseTip;
  for (const task of tasks) {
    const state = taskState(m, task.id);
    const range = (m.backfill || {})[task.id];
    if (state === 'skip') {
      results.push({
        task: task.id, status: 'skipped', base: range ? range.base : null, head: range ? range.head : null,
        rounds: null, tier_used: null, notes: '',
      });
      if (range) {
        prev = range.head;
        prevIsPhaseTip = false;
      }
      continue;
    }
    const taskBase = state === 'review' && range && prevIsPhaseTip ? range.base : prev;
    const r = state === 'review' && !range
      ? { task: task.id, status: 'blocked', base: prev, head: null, rounds: 0, tier_used: task.tier, notes: 'done but not reviewed, and no backfill commits' }
      : await runTask(m, task, where, taskBase, io, state === 'review' ? range : null);
    results.push(r);
    if (r.status !== 'done') {
      io.log(`${name}: stopped at ${task.id} (${r.notes})`);
      return { results, stopped: r.notes, head: prev };
    }
    prev = r.head;
    prevIsPhaseTip = false;
  }
  return { results, stopped: null, head: prev };
}

// Run a lane's tasks in order in its worktree, the first from base (the
// feature tip the lane fast-forwards to); stop at the first task that is not
// done. Returns {lane, results, stopped:reason|null, head}.
async function runLane(m, lane, base, io = { agent, log }) {
  const r = await runTaskList(m, lane.tasks, laneWhere(m, lane), base, io, lane.name);
  return { lane: lane.id, ...r };
}

// Run lanes with at most limits.max_parallel_lanes in flight (a promise
// pool); results come back in lane order. A lane that throws stops only
// itself. base is the feature tip every lane starts from.
async function runLanes(m, lanes, base, io = { agent, log }) {
  const results = new Array(lanes.length);
  let next = 0;
  const worker = async () => {
    while (next < lanes.length) {
      const i = next;
      next += 1;
      try {
        results[i] = await runLane(m, lanes[i], base, io);
      } catch (e) {
        results[i] = { lane: lanes[i].id, results: [], stopped: `error: ${e && e.message}`, head: base };
      }
    }
  };
  const width = Math.min(m.limits.max_parallel_lanes, lanes.length);
  const workers = [];
  for (let w = 0; w < width; w += 1) workers.push(worker());
  await Promise.all(workers);
  return results;
}
