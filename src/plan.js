// A drive path ('C:\\x\\y', 'c:/x/y') in the one form scripts/setup prints
// (_shell.native_path): upper-case drive letter, '/' separators. With
// msys true, an MSYS drive path ('/c/x', what Git Bash prints) becomes
// 'C:/x' too. Anything else is returned unchanged.
function windowsPathForm(v, msys) {
  if (typeof v !== 'string') return v;
  if (/^[A-Za-z]:[\\/]/.test(v)) return v[0].toUpperCase() + ':/' + v.slice(3).split('\\').join('/');
  const drive = msys ? /^\/([A-Za-z])(\/|$)/.exec(v) : null;
  if (drive) return drive[1].toUpperCase() + ':/' + v.slice(drive[0].length);
  return v;
}

const MANIFEST_PATH_KEYS = ['plan', 'spec', 'skill_dir', 'sp_dir', 'python'];
const MANIFEST_REPO_PATH_KEYS = ['root', 'git_dir', 'worktree_root', 'ledger_dir'];

// The manifest with its Windows paths in the form scripts/setup prints, so
// the worktree paths the run derives match setup_result: each path field
// written as 'C:\\x\\y' or 'c:/x/y' becomes 'C:/x/y' (Git Bash and the
// helpers accept it, and it needs no escaping in prompts). When any path
// field is a drive path (a Windows manifest), '/c/x' fields become 'C:/x'
// as well; on Linux and macOS '/c/x' is an ordinary path and stays. A pure
// string change on a copy; other values, and anything that is not an
// object, are returned unchanged.
function normalizeManifestPaths(m) {
  if (m === null || typeof m !== 'object' || Array.isArray(m)) return m;
  const repo = m.repo !== null && typeof m.repo === 'object' && !Array.isArray(m.repo) ? m.repo : null;
  const values = [
    ...MANIFEST_PATH_KEYS.map((k) => m[k]),
    ...(repo ? MANIFEST_REPO_PATH_KEYS.map((k) => repo[k]) : []),
  ];
  const msys = values.some((v) => typeof v === 'string' && /^[A-Za-z]:[\\/]/.test(v));
  const out = { ...m };
  for (const key of MANIFEST_PATH_KEYS) {
    if (key in out) out[key] = windowsPathForm(out[key], msys);
  }
  if (repo) {
    out.repo = { ...repo };
    for (const key of MANIFEST_REPO_PATH_KEYS) {
      if (key in out.repo) out.repo[key] = windowsPathForm(out.repo[key], msys);
    }
  }
  return out;
}

// The manifest with hooks {} when it has no hooks key (hooks is optional; a
// present value, even an invalid one, is kept for validateManifest to
// check). A copy; anything that is not an object is returned unchanged.
// Applied with normalizeManifestPaths before anything reads the manifest.
function withDefaultHooks(m) {
  if (m === null || typeof m !== 'object' || Array.isArray(m) || 'hooks' in m) return m;
  return { ...m, hooks: {} };
}

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
// review_rounds more (fix plus re-review). There is no setup agent:
// scripts/setup runs before the launch. Profile lite has no pre-flight,
// integrate or post-integrate agent and one combined final reviewer.
// Integrate and e2e start on Sonnet. final_fix (Opus; Sonnet when every
// finding is minor or docs-only) and final_re_review are listed as the upper
// bound; they run only when the final reviews report findings. Verify: the
// verify agent (Sonnet) runs the project checks at the delivered revision
// once, whenever a project or lane test, lint or build command exists
// (finalChecks): after the final fix and before the final re-review (which
// gets its result), or after the lenses when they found nothing; it is
// listed in that place; e2e_recheck and
// post_integrate_recheck are listed as the upper bound: they run only when a
// later commit made the earlier result stale. Retries, adjudications,
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
  for (const role of [...lenses, 'final_fix']) add('Final review', null, null, role, standard);
  if (finalChecks(m).length > 0) add('Verify', null, null, 'verify', sonnetHigh);
  add('Final review', null, null, 'final_re_review', standard);
  if (m.hooks.e2e) add('Verify', null, null, 'e2e_recheck', sonnetHigh);
  if (!lite && m.hooks.post_integrate) add('Verify', null, null, 'post_integrate_recheck', standard);
  return agents;
}

// The lines the session prints when it launches the run (launch) or
// relaunches it with tasks already committed (resume), and runAll logs:
// launch counts the distinct lanes among agents (planAgents(m)) and the
// agents; resume counts m.done. Expects a valid manifest.
function launchNotices(m, agents) {
  const lanes = new Set(agents.filter((a) => a.lane !== null).map((a) => a.lane)).size;
  return {
    launch: `parallel-lanes: launching run ${m.run_id}: ${lanes} lanes, ${agents.length} agents`,
    resume: `parallel-lanes: resuming run ${m.run_id}: ${m.done.length} tasks already committed`,
  };
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
