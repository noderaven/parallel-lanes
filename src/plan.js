// Model settings. Light applies to implementers of light tasks only; every
// other agent (reviewers included) runs standard.
function tierSettings(tier) {
  return tier === 'light'
    ? { model: 'sonnet', effort: 'medium' }
    : { model: 'opus', effort: 'high' };
}

// The agents a run would spawn, in run order:
// [{phase, lane|null, task|null, role, model, effort}].
// Per task: none if done and reviewed, a review if done only, else implement
// plus review. Fix rounds are not predictable, so each task review counts as
// one; a task can add up to 2x review_rounds more (fix plus re-review).
// final_fix and final_re_review are listed as the upper bound; they run only
// when the final reviews report findings. Expects a valid manifest.
function planAgents(m) {
  const agents = [];
  const standard = tierSettings('standard');
  const add = (phase, lane, task, role, settings) =>
    agents.push({ phase, lane, task, role, ...settings });
  const done = new Set(m.done);
  const reviewed = new Set(m.reviewed);
  const addTasks = (phase, lane, tasks) => {
    for (const t of tasks) {
      if (done.has(t.id) && reviewed.has(t.id)) continue;
      if (!done.has(t.id)) add(phase, lane, t.id, 'implement', tierSettings(t.tier));
      add(phase, lane, t.id, 'review', standard);
    }
  };

  add('Setup', null, null, 'setup', standard);
  add('Pre-flight', null, null, 'preflight', standard);
  addTasks('Prelude', null, m.prelude);
  for (const lane of m.lanes) addTasks(lane.name, lane.id, lane.tasks);
  add('Integrate', null, null, 'integrate', standard);
  if (m.hooks.post_integrate) add('Integrate', null, null, 'post_integrate', standard);
  addTasks('Join', null, m.join);
  if (m.hooks.e2e) add('E2E', null, null, 'e2e', standard);
  for (const role of ['final_review_sp', 'final_review_security', 'final_review_correctness', 'final_fix', 'final_re_review']) {
    add('Final review', null, null, role, standard);
  }
  return agents;
}

// Lanes that would run at once: lanes with at least one planned agent,
// capped by limits.max_parallel_lanes.
function lanesEffective(m, agents) {
  const active = new Set(agents.filter((a) => a.lane !== null).map((a) => a.lane));
  return Math.min(active.size, m.limits.max_parallel_lanes);
}

// Progress phase of a ledger lane: prelude and join tasks have their own
// phases; lane tasks use the lane's name.
function lanePhase(m, laneId) {
  if (laneId === 'prelude') return 'Prelude';
  if (laneId === 'join') return 'Join';
  const lane = m.lanes.find((l) => l.id === laneId);
  return lane ? lane.name : laneId;
}

// Where a lane's tasks run: its own worktree and run branch. sync is the
// feature branch the lane fast-forwards to before implementing (it holds the
// prelude commits made after setup created the lane branch).
function laneWhere(m, lane) {
  return {
    dir: `${m.repo.worktree_root}/lane-${lane.id}`,
    branch: `pl-${m.run_id}-${lane.id}`,
    lane: lane.id,
    sync: m.repo.branch,
  };
}

// The checkout of the feature branch: the main checkout in git mode; in
// shadow mode a worktree of the shadow repo (the project folder itself is
// never written during a run).
function featureDir(m) {
  return m.repo.mode === 'shadow' ? `${m.repo.worktree_root}/feature` : m.repo.root;
}

// Where prelude and join tasks run, with their ledger lane.
function featureWhere(m, ledgerLane) {
  return { dir: featureDir(m), branch: m.repo.branch, lane: ledgerLane };
}

// Scratch files for a task, kept in the ledger dir (outside every repo).
function taskFiles(m, task) {
  const dir = m.repo.ledger_dir;
  return {
    brief: `${dir}/briefs/${task.id}.md`,
    report: `${dir}/reports/${task.id}.md`,
    reviews: `${dir}/reviews`,
  };
}

// What a run does with a task: 'skip' (done and reviewed), 'review'
// (done, not reviewed: backfill review first), or 'run'.
function taskState(m, id) {
  if (!m.done.includes(id)) return 'run';
  return m.reviewed.includes(id) ? 'skip' : 'review';
}

// Tasks of a group (prelude, a lane, join) that still need an agent.
function hasWork(m, tasks) {
  return tasks.some((t) => taskState(m, t.id) !== 'skip');
}
