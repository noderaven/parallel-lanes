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

// What scripts/setup reports for manifest(): every lane's worktree.
function setupResult() {
  return {
    feature_head: 'S0',
    discarded: [],
    worktrees: { alpha: '/work/wt/lane-alpha', beta: '/work/wt/lane-beta' },
  };
}

// One lane on the feature branch (profile lite).
function liteManifest(overrides = {}) {
  return manifest({
    profile: 'lite',
    lanes: [{ id: 'alpha', name: 'Lane alpha', tasks: [task('T2', ['src/a.js']), task('T3', ['src/a2.js'])] }],
    ...overrides,
  });
}

// Lane alpha's two tasks are light and share a batch key.
function batchedManifest(overrides = {}) {
  const m = manifest(overrides);
  m.lanes[0].tasks = [
    task('T2', ['src/a.js'], { tier: 'light', batch: 'docs' }),
    task('T3', ['src/a2.js'], { tier: 'light', batch: 'docs' }),
  ];
  return m;
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

test('a light task implementer runs at sonnet/high and its reviewer at opus/high', () => {
  const m = manifest();
  m.lanes[1].tasks[0].tier = 'light';
  const [implement, review] = forTask(planAgents(m), 'T4');
  assert.deepEqual([implement.role, implement.model, implement.effort], ['implement', 'sonnet', 'high']);
  assert.deepEqual([review.role, review.model, review.effort], ['review', 'opus', 'high']);
});

test('a sonnet task implementer runs at sonnet/high and its reviewer at opus/high', () => {
  const m = manifest();
  m.lanes[0].tasks[1].tier = 'sonnet';
  const [implement, review] = forTask(planAgents(m), 'T3');
  assert.deepEqual([implement.role, implement.model, implement.effort], ['implement', 'sonnet', 'high']);
  assert.deepEqual([review.role, review.model, review.effort], ['review', 'opus', 'high']);
});

test('integrate and e2e run at sonnet/high; every other agent but a light implementer at opus/high', () => {
  const m = manifest({ hooks: { post_integrate: 'check', e2e: 'run' } });
  m.join[0].tier = 'light';
  const sonnet = new Set(['integrate', 'e2e']);
  for (const a of planAgents(m)) {
    const want = sonnet.has(a.role) || (a.task === 'T5' && a.role === 'implement')
      ? ['sonnet', 'high'] : ['opus', 'high'];
    assert.deepEqual([a.model, a.effort], want, `${a.role} ${a.task}`);
  }
});

test('no setup agent when setup_result is present', () => {
  const m = manifest({ setup_result: setupResult() });
  const agents = planAgents(m);
  assert.deepEqual(agents.filter((a) => a.role === 'setup'), []);
  assert.equal(agents.length, planAgents(manifest()).length - 1);
  assert.equal(agents[0].role, 'preflight');
});

test('lite plan: no pre-flight, integrate or post-integrate; one combined final reviewer', () => {
  const agents = planAgents(liteManifest({ hooks: { e2e: 'run e2e' } }));
  const rows = agents.map((a) => [a.phase, a.lane, a.task, a.role, a.model]);
  assert.deepEqual(rows, [
    ['Setup', null, null, 'setup', 'opus'],
    ['Prelude', null, 'T1', 'implement', 'opus'],
    ['Prelude', null, 'T1', 'review', 'opus'],
    ['Lane alpha', 'alpha', 'T2', 'implement', 'opus'],
    ['Lane alpha', 'alpha', 'T2', 'review', 'opus'],
    ['Lane alpha', 'alpha', 'T3', 'implement', 'opus'],
    ['Lane alpha', 'alpha', 'T3', 'review', 'opus'],
    ['Join', null, 'T5', 'implement', 'opus'],
    ['Join', null, 'T5', 'review', 'opus'],
    ['E2E', null, null, 'e2e', 'sonnet'],
    ['Final review', null, null, 'final_review_combined', 'opus'],
    ['Final review', null, null, 'final_fix', 'opus'],
    ['Final review', null, null, 'final_re_review', 'opus'],
  ]);
});

test('batched light tasks plan one implement and one review for the batch', () => {
  const m = batchedManifest();
  const lane = planAgents(m).filter((a) => a.lane === 'alpha');
  assert.deepEqual(lane.map((a) => [a.task, a.role, a.model, a.effort]), [
    ['T2-T3', 'implement', 'sonnet', 'high'],
    ['T2-T3', 'review', 'opus', 'high'],
  ]);
});

test('a batch committed in an earlier run plans one backfill review', () => {
  const range = { base: 'b0', head: 'h0' };
  const m = batchedManifest({ done: ['T2', 'T3'], reviewed: [], backfill: { T2: range, T3: range } });
  const lane = planAgents(m).filter((a) => a.lane === 'alpha');
  assert.deepEqual(lane.map((a) => [a.task, a.role]), [['T2-T3', 'review']]);
});

test('final fix is listed at opus/high as the upper bound', () => {
  const fix = planAgents(manifest()).find((a) => a.role === 'final_fix');
  assert.deepEqual([fix.model, fix.effort], ['opus', 'high']);
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
  const m = manifest({ done: ['T4'], reviewed: ['T4'], backfill: { T4: { base: 'b', head: 'h' } } });
  assert.equal((await dryRun(m)).result.lanes_effective, 1);

  const wide = manifest();
  wide.lanes.push({ id: 'gamma', name: 'Lane gamma', tasks: [task('T6', ['src/c.js'])] });
  wide.lanes.push({ id: 'delta', name: 'Lane delta', tasks: [task('T7', ['src/d.js'])] });
  wide.limits.max_parallel_lanes = 3;
  assert.equal((await dryRun(wide)).result.lanes_effective, 3);
});

// Parity: a run whose task reviews all approve the first time, and whose
// final reviewers report one finding the final fix resolves (so final_fix
// and final_re_review run), spawns exactly the agents the dry run lists, on
// the same models and efforts.
const FINDING = { severity: 'important', file: 'src/a.js', line: 3, issue: 'one issue', fix: 'fix it' };

function parityAgent(label) {
  if (label === 'setup') {
    return { ok: true, discarded: [], worktrees: [], feature_head: 'F0', notes: '' };
  }
  if (label === 'pre-flight') return { conflicts: [], rulings: [] };
  if (label === 'integrate') return { status: 'done', head: 'I1', notes: 'merged' };
  if (label === 'post-integrate') return { status: 'done', head: 'P1', notes: 'ok' };
  if (label === 'e2e') return { items: [{ item: 'login', result: 'PASS', evidence: 'ok' }] };
  if (label.startsWith('final review')) return { findings: [{ ...FINDING }], cannot_verify: [] };
  if (label === 'final fix') return { status: 'done', head: 'f1', tests: 'pass', notes: '', declined: [] };
  if (label === 'final re-review') return { findings: [] };
  const implement = /^(\S+) implement$/.exec(label);
  if (implement) return { status: 'done', head: `${implement[1]}-h`, tests: 'pass', notes: '' };
  if (/^\S+ review$/.test(label)) return { verdict: 'approve', findings: [], cannot_verify: [] };
  throw new Error(`unexpected agent call: ${label}`);
}

async function parityRun(m) {
  const calls = [];
  const result = await loadScript({
    args: { ...m, dry_run: false },
    agent: async (prompt, opts) => {
      calls.push(opts);
      return parityAgent(opts.label);
    },
    parallel: (thunks) => Promise.all(thunks.map((t) => t())),
  });
  return { result, calls };
}

const settings = (list) => list.map((a) => `${a.model}/${a.effort}`).sort();

async function assertParity(m) {
  const planned = planAgents(m);
  const { result, calls } = await parityRun(m);
  assert.equal(result.status, 'complete', JSON.stringify(result));
  assert.deepEqual(result.final.fixed.map((f) => f.issue), ['one issue']);
  assert.equal(result.agents_spawned, calls.length);
  assert.equal(result.agents_spawned, planned.length,
    `spawned ${calls.map((c) => c.label).join(', ')}; planned ${planned.map((a) => `${a.task || ''} ${a.role}`).join(', ')}`);
  assert.deepEqual(settings(calls), settings(planned));
}

const HOOKS = { post_integrate: 'check contracts', e2e: 'run the e2e checklist' };

test('parity: a full run spawns exactly the planned agents', async () => {
  const m = manifest({ hooks: HOOKS });
  m.lanes[0].tasks[1].tier = 'sonnet';
  m.lanes[1].tasks[0].tier = 'light';
  await assertParity(m);
});

test('parity: a lite run spawns exactly the planned agents', async () => {
  await assertParity(liteManifest({ hooks: { e2e: 'run the e2e checklist' } }));
});

test('parity: a run with batched tasks spawns exactly the planned agents', async () => {
  await assertParity(batchedManifest({ hooks: HOOKS }));
});

test('parity: a run with setup_result spawns exactly the planned agents', async () => {
  await assertParity(manifest({ hooks: HOOKS, setup_result: setupResult() }));
});

test('parity: a lite run with setup_result spawns exactly the planned agents', async () => {
  await assertParity(liteManifest({
    setup_result: { feature_head: 'S0', discarded: [], worktrees: { alpha: '/work/repo' } },
  }));
});
