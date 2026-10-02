// Model settings. The sonnet and light tiers apply to implementers of
// sonnet and light tasks only; reviewers always run standard. Integrate,
// e2e, and minor-only or docs-only final fixes start on Sonnet with settings
// of their own (phases.js).
function tierSettings(tier) {
  return tier === 'sonnet' || tier === 'light'
    ? { model: 'sonnet', effort: 'high' }
    : { model: 'opus', effort: 'high' };
}

// The agents a run would spawn, in run order:
// [{phase, lane|null, task|null, role, model, effort}].
// Per task: none if done and reviewed, a review if done only, else implement
// plus review. A batch (batchGroup) is one unit: one implement (unless it
// was committed in an earlier run) and one review, with task = the unit id
// (`<first>-<last>`, as in its agent labels). Implementers run on their
// task's tier. Reviews are listed at high effort: the diff size that allows
// medium (reviewSettings) is not known before the run. Fix rounds are not
// predictable, so each task review counts as one; a task can add up to 2x
// review_rounds more (fix plus re-review). No setup agent when setup_result
// is present (scripts/setup ran). Profile lite has no pre-flight, integrate
// or post-integrate agent and one combined final reviewer. Integrate and e2e
// start on Sonnet. final_fix (Opus; Sonnet when every finding is minor or
// docs-only) and final_re_review are listed as the upper bound; they run
// only when the final reviews report findings. Retries, adjudications,
// escalations, conflict resolution, and post-integrate fixes are not
// predictable either; the max_agents budget covers them. Expects a valid
// manifest.
function planAgents(m) {
  const agents = [];
  const standard = tierSettings('standard');
  const sonnetHigh = { model: 'sonnet', effort: 'high' };
  const lite = m.profile === 'lite';
  const add = (phase, lane, task, role, settings) =>
    agents.push({ phase, lane, task, role, ...settings });
  const addTasks = (phase, lane, tasks) => {
    for (let i = 0; i < tasks.length;) {
      const group = batchGroup(m, tasks, i);
      i += group.length;
      const state = taskState(m, group[0].id);
      if (state === 'skip') continue;
      const unit = group.length > 1 ? batchUnit(group) : group[0];
      if (state === 'run') add(phase, lane, unit.id, 'implement', tierSettings(unit.tier));
      add(phase, lane, unit.id, 'review', standard);
    }
  };

  if (!m.setup_result) add('Setup', null, null, 'setup', standard);
  if (!lite) add('Pre-flight', null, null, 'preflight', standard);
  addTasks('Prelude', null, m.prelude);
  for (const lane of m.lanes) addTasks(lane.name, lane.id, lane.tasks);
  if (!lite) {
    add('Integrate', null, null, 'integrate', sonnetHigh);
    if (m.hooks.post_integrate) add('Integrate', null, null, 'post_integrate', standard);
  }
  addTasks('Join', null, m.join);
  if (m.hooks.e2e) add('E2E', null, null, 'e2e', sonnetHigh);
  const lenses = lite
    ? ['final_review_combined']
    : ['final_review_sp', 'final_review_security', 'final_review_correctness'];
  for (const role of [...lenses, 'final_fix', 'final_re_review']) {
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
