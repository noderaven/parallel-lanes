import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadHelpers, loadScript } from './harness.mjs';

const { planAgents } = await loadHelpers(['planAgents']);

function task(id, files, extra = {}) {
  return { id, title: `Task ${id}`, files, tier: 'standard', security: false, ...extra };
}

function manifest(overrides = {}) {
  return {
    version: 1,
    run_id: 'run-1',
    plan: '/work/plan.md',
    spec: null,
    commit_rules: 'plain ASCII, no trailers',
    repo: {
      mode: 'git',
      root: '/work/repo',
      git_dir: null,
      base_ref: 'main',
      branch: 'pl/run-1',
      worktree_root: '/work/wt',
      ledger_dir: '/work/ledger',
    },
    commands: { setup: [], test: ['npm test'], lint: [], build: [] },
    prelude: [task('T1', ['src/shared.js'])],
    lanes: [
      { id: 'alpha', name: 'Lane alpha', tasks: [task('T2', ['src/a.js']), task('T3', ['src/a2.js'])] },
      { id: 'beta', name: 'Lane beta', tasks: [task('T4', ['src/b.js'])] },
    ],
    join: [task('T5', ['README.md'])],
    hooks: {},
    limits: { review_rounds: 5, max_parallel_lanes: 3 },
    dry_run: true,
    done: [],
    reviewed: [],
    sp_dir: null,
    skill_dir: '/skills/parallel-lanes',
    ...overrides,
  };
}

// Run the script as a dry run; any agent/parallel/pipeline call is recorded.
async function dryRun(m) {
  const calls = [];
  const record = (name) => () => {
    calls.push(name);
    return Promise.resolve(null);
  };
  const result = await loadScript({
    args: m,
    agent: record('agent'),
    parallel: record('parallel'),
    pipeline: record('pipeline'),
  });
  return { result, calls };
}

const forTask = (agents, id) => agents.filter((a) => a.task === id);
const roles = (agents) => agents.map((a) => a.role);

test('dry run returns the plan without calling agent, parallel or pipeline', async () => {
  const { result, calls } = await dryRun(manifest());
  assert.deepEqual(calls, []);
  assert.equal(result.dry_run, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.agents, planAgents(manifest()));
  assert.ok(result.agents.length > 0);
});

test('full plan lists every role in run order with phase, lane and task', () => {
  const agents = planAgents(manifest({ hooks: { post_integrate: 'check contracts', e2e: 'run e2e' } }));
  const rows = agents.map((a) => [a.phase, a.lane, a.task, a.role]);
  assert.deepEqual(rows, [
    ['Setup', null, null, 'setup'],
    ['Pre-flight', null, null, 'preflight'],
    ['Prelude', null, 'T1', 'implement'],
    ['Prelude', null, 'T1', 'review'],
    ['Lane alpha', 'alpha', 'T2', 'implement'],
    ['Lane alpha', 'alpha', 'T2', 'review'],
    ['Lane alpha', 'alpha', 'T3', 'implement'],
    ['Lane alpha', 'alpha', 'T3', 'review'],
    ['Lane beta', 'beta', 'T4', 'implement'],
    ['Lane beta', 'beta', 'T4', 'review'],
    ['Integrate', null, null, 'integrate'],
    ['Integrate', null, null, 'post_integrate'],
    ['Join', null, 'T5', 'implement'],
    ['Join', null, 'T5', 'review'],
    ['E2E', null, null, 'e2e'],
    ['Final review', null, null, 'final_review_sp'],
    ['Final review', null, null, 'final_review_security'],
    ['Final review', null, null, 'final_review_correctness'],
    ['Final review', null, null, 'final_fix'],
    ['Final review', null, null, 'final_re_review'],
  ]);
});

test('tasks in done and reviewed produce no agents', () => {
  const agents = planAgents(manifest({ done: ['T1', 'T2', 'T5'], reviewed: ['T1', 'T2', 'T5'] }));
  assert.deepEqual(forTask(agents, 'T1'), []);
  assert.deepEqual(forTask(agents, 'T2'), []);
  assert.deepEqual(forTask(agents, 'T5'), []);
  assert.deepEqual(roles(forTask(agents, 'T3')), ['implement', 'review']);
});

test('a task in done but not reviewed produces a review agent only', () => {
  const agents = planAgents(manifest({ done: ['T2'], reviewed: [] }));
  assert.deepEqual(roles(forTask(agents, 'T2')), ['review']);
});

test('a light task implementer runs at sonnet/medium and its reviewer at opus/high', () => {
  const m = manifest();
  m.lanes[1].tasks[0].tier = 'light';
  const [implement, review] = forTask(planAgents(m), 'T4');
  assert.deepEqual([implement.role, implement.model, implement.effort], ['implement', 'sonnet', 'medium']);
  assert.deepEqual([review.role, review.model, review.effort], ['review', 'opus', 'high']);
});

test('every agent other than a light implementer runs at opus/high', () => {
  const m = manifest({ hooks: { post_integrate: 'check', e2e: 'run' } });
  m.join[0].tier = 'light';
  for (const a of planAgents(m)) {
    if (a.task === 'T5' && a.role === 'implement') continue;
    assert.deepEqual([a.model, a.effort], ['opus', 'high'], `${a.role} ${a.task}`);
  }
});

test('an invalid manifest returns its errors and no agents', async () => {
  const m = manifest();
  delete m.plan;
  m.lanes[1].tasks[0].files.push('src/a.js');
  const { result, calls } = await dryRun(m);
  assert.deepEqual(calls, []);
  assert.equal(result.dry_run, true);
  assert.ok(result.errors.some((e) => e.includes('plan')), JSON.stringify(result.errors));
  assert.ok(result.errors.some((e) => e.includes('src/a.js')), JSON.stringify(result.errors));
  assert.deepEqual(result.agents, []);
  assert.equal(result.lanes_effective, 0);
});

test('an e2e agent is present only when hooks.e2e is set', () => {
  assert.deepEqual(planAgents(manifest()).filter((a) => a.role === 'e2e'), []);
  const withE2e = planAgents(manifest({ hooks: { e2e: 'run the e2e checklist' } }));
  assert.deepEqual(withE2e.filter((a) => a.role === 'e2e').map((a) => a.phase), ['E2E']);
});

test('a post_integrate agent is present only when hooks.post_integrate is set', () => {
  assert.deepEqual(planAgents(manifest()).filter((a) => a.role === 'post_integrate'), []);
  const withHook = planAgents(manifest({ hooks: { post_integrate: 'check contracts' } }));
  assert.equal(withHook.filter((a) => a.role === 'post_integrate').length, 1);
});

test('lanes_effective counts lanes with work, capped by max_parallel_lanes', async () => {
  const m = manifest({ done: ['T4'], reviewed: ['T4'] });
  assert.equal((await dryRun(m)).result.lanes_effective, 1);

  const wide = manifest();
  wide.lanes.push({ id: 'gamma', name: 'Lane gamma', tasks: [task('T6', ['src/c.js'])] });
  wide.lanes.push({ id: 'delta', name: 'Lane delta', tasks: [task('T7', ['src/d.js'])] });
  wide.limits.max_parallel_lanes = 3;
  assert.equal((await dryRun(wide)).result.lanes_effective, 3);
});
