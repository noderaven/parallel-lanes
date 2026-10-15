// Join waves in the engine (1.6.5 design 4.2-4.5): runJoinWaves runs each
// multi-unit wave's units side by side on unit branches in lane worktrees and
// hands them to a merge; a single-unit wave runs on the feature checkout.
// Stubbed agents and a stubbed merge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadHelpers, H } from './harness.mjs';

const {
  runJoinWaves, unitWhere, wavePlan, startCommand,
} = await loadHelpers(['runJoinWaves', 'unitWhere', 'wavePlan', 'startCommand']);

function task(id, deps, extra = {}) {
  return {
    id, title: `Task ${id}`, files: [`src/${id}.js`], tier: 'standard', security: false,
    ...(deps === undefined ? {} : { depends_on: deps.map((d) => ({ id: d, kind: 'code' })) }), ...extra,
  };
}

function manifest(overrides = {}) {
  return {
    version: 1,
    run_id: 'run-1',
    plan: '/work/plan.md',
    spec: '/work/spec.md',
    commit_rules: 'plain ASCII',
    repo: {
      mode: 'git', root: '/work/repo', git_dir: null, base_ref: 'main', branch: 'pl/run-1',
      worktree_root: '/work/wt', ledger_dir: '/work/ledger',
    },
    commands: { setup: ['npm ci'], test: ['npm test'], lint: [], build: [] },
    prelude: [],
    lanes: [
      { id: 'alpha', name: 'Lane alpha', tasks: [task('A1')] },
      { id: 'beta', name: 'Lane beta', tasks: [task('B1')] },
      { id: 'gamma', name: 'Lane gamma', tasks: [task('C1')] },
    ],
    join: [task('J1', []), task('J2', ['J1']), task('J3', ['J1'])],
    hooks: {},
    limits: { review_rounds: 5, max_parallel_lanes: 3 },
    dry_run: false,
    done: [],
    reviewed: [],
    sp_dir: null,
    skill_dir: '/skills/parallel-lanes',
    autonomy: 'supervised',
    ...overrides,
  };
}
const DIRS = ['/work/wt/lane-alpha', '/work/wt/lane-beta', '/work/wt/lane-gamma'];

const done = (base, head) => ({ status: 'done', base, head, tests: 'npm test: pass', notes: '' });
const blocked = (base, notes = 'stuck') => ({ status: 'blocked', base, head: base, tests: '', notes });
const approve = () => ({ verdict: 'approve', findings: [], cannot_verify: [] });

// Stub agent: per-label result queues, or functions of the call. Records
// every call with its start and end order.
function stub(script) {
  const calls = [];
  const logs = [];
  let clock = 0;
  const agent = async (prompt, opts) => {
    const call = { prompt, ...opts, started: clock += 1 };
    calls.push(call);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const queue = script[opts.label];
    if (!queue || queue.length === 0) throw new Error(`unscripted agent call: ${opts.label}`);
    const next = queue.shift();
    const out = typeof next === 'function' ? await next(call) : next;
    call.ended = clock += 1;
    return out;
  };
  return { io: { agent, log: (msg) => logs.push(msg) }, calls, logs };
}
// A merge stub: records its calls and returns a new head per wave.
function merger(result = null) {
  const calls = [];
  const merge = async (wave, unitResults, base) => {
    calls.push({ wave, units: unitResults.map((u) => u.unit.id), statuses: unitResults.map((u) => u.result.status), base });
    return result ? result(wave) : { head: H(`merge${wave}`) };
  };
  return { merge, calls };
}
const plan = (m) => wavePlan(m).waves;
const callOf = (s, label) => s.calls.find((c) => c.label === label);

test('units of a wave run concurrently in lane worktrees on unit branches', async () => {
  const m = manifest();
  const s = stub({
    'J1 implement': [done(H('t0'), H('j1'))], 'J1 review': [approve()],
    'J2 implement': [done(H('j1'), H('j2'))], 'J2 review': [approve()],
    'J3 implement': [done(H('j1'), H('j3'))], 'J3 review': [approve()],
  });
  const mg = merger();
  const r = await runJoinWaves(m, plan(m), H('t0'), DIRS, s.io, mg.merge);
  assert.equal(r.stopped, null);
  const j2 = callOf(s, 'J2 implement');
  const j3 = callOf(s, 'J3 implement');
  assert.ok(j2.started < j3.ended && j3.started < j2.ended, 'J2 and J3 overlap');
  assert.ok(j2.prompt.includes("--unit-branch 'pl-run-1-u-J2'"), j2.prompt);
  assert.ok(j2.prompt.includes(`cd '${DIRS[0]}'`), 'J2 takes the first lane worktree');
  assert.ok(j3.prompt.includes("--unit-branch 'pl-run-1-u-J3'") && j3.prompt.includes(`cd '${DIRS[1]}'`));
  assert.ok(j2.prompt.includes(`--unit-branch 'pl-run-1-u-J2' '${H('j1')}' --run-id 'run-1'`), 'from the wave base');
  assert.deepEqual(mg.calls, [{ wave: 2, units: ['J2', 'J3'], statuses: ['done', 'done'], base: H('j1') }]);
  assert.equal(r.head, H('merge2'));
  assert.deepEqual(r.results.map((x) => [x.task, x.status]), [['J1', 'done'], ['J2', 'done'], ['J3', 'done']]);
  assert.deepEqual(r.waves.map((w) => [w.wave, w.units, w.head]),
    [[1, ['J1'], H('j1')], [2, ['J2', 'J3'], H('merge2')]]);
});

test('unit events go to join', async () => {
  const m = manifest();
  const s = stub({
    'J1 implement': [done(H('t0'), H('j1'))], 'J1 review': [approve()],
    'J2 implement': [done(H('j1'), H('j2'))], 'J2 review': [approve()],
    'J3 implement': [done(H('j1'), H('j3'))], 'J3 review': [approve()],
  });
  await runJoinWaves(m, plan(m), H('t0'), DIRS, s.io, merger().merge);
  const p = callOf(s, 'J2 implement').prompt;
  assert.ok(p.includes(`--record-start '/work/ledger' 'join' '${H('j1')}'`), p);
  assert.ok(p.includes("--rulings '/work/ledger' '-'"), 'a join unit sees every lane\'s rulings');
  assert.ok(!p.includes('--sync'), 'no lane sync');
  assert.ok(p.includes("--phase 'join'"), 'its checks run in the join phase');
  for (const c of s.calls) assert.equal(c.phase, 'Join');
});

test('a single-unit wave runs on the feature checkout', async () => {
  const m = manifest();
  const s = stub({
    'J1 implement': [done(H('t0'), H('j1'))], 'J1 review': [approve()],
    'J2 implement': [done(H('j1'), H('j2'))], 'J2 review': [approve()],
    'J3 implement': [done(H('j1'), H('j3'))], 'J3 review': [approve()],
  });
  await runJoinWaves(m, plan(m), H('t0'), DIRS, s.io, merger().merge);
  const p = callOf(s, 'J1 implement').prompt;
  assert.ok(p.includes("cd '/work/repo'"), p);
  assert.ok(!p.includes('--unit-branch'), p);
});

test('the next wave starts from the merge head', async () => {
  const m = manifest({ join: [task('J1', []), task('J2', []), task('J3', ['J1', 'J2'])] });
  const s = stub({
    'J1 implement': [done(H('t0'), H('j1'))], 'J1 review': [approve()],
    'J2 implement': [done(H('t0'), H('j2'))], 'J2 review': [approve()],
    'J3 implement': [done(H('merge1'), H('j3'))], 'J3 review': [approve()],
  });
  const mg = merger();
  const r = await runJoinWaves(m, plan(m), H('t0'), DIRS, s.io, mg.merge);
  assert.ok(callOf(s, 'J3 implement').prompt.includes(`Task base: ${H('merge1')}`));
  assert.equal(r.head, H('j3'), 'the last single-unit wave moves the tip');
  assert.equal(mg.calls.length, 1);
});

test('a wave wider than the pool reuses a finished unit\'s worktree', async () => {
  const m = manifest({ limits: { review_rounds: 5, max_parallel_lanes: 2 },
    join: [task('J1', []), task('J2', []), task('J3', [])] });
  const s = stub({
    'J1 implement': [done(H('t0'), H('j1'))], 'J1 review': [approve()],
    'J2 implement': [done(H('t0'), H('j2'))], 'J2 review': [approve()],
    'J3 implement': [done(H('t0'), H('j3'))], 'J3 review': [approve()],
  });
  const mg = merger();
  const r = await runJoinWaves(m, plan(m), H('t0'), DIRS, s.io, mg.merge);
  assert.equal(r.stopped, null);
  const dirOf = (id) => DIRS.find((d) => callOf(s, `${id} implement`).prompt.includes(`cd '${d}'`));
  assert.equal(dirOf('J1'), DIRS[0]);
  assert.equal(dirOf('J2'), DIRS[1]);
  assert.ok([DIRS[0], DIRS[1]].includes(dirOf('J3')), 'only the two usable worktrees');
  const j3 = callOf(s, 'J3 implement');
  const before = callOf(s, `${dirOf('J3') === DIRS[0] ? 'J1' : 'J2'} review`);
  assert.ok(before.ended < j3.started, 'J3 starts after the unit before it in that worktree finished');
  assert.deepEqual(mg.calls[0].units, ['J1', 'J2', 'J3']);
});

test('no unit starts after a sibling stops', async () => {
  const m = manifest({ limits: { review_rounds: 5, max_parallel_lanes: 2 },
    join: [task('J1', []), task('J2', []), task('J3', [])] });
  const s = stub({
    'J1 implement': [blocked(H('t0'), 'cannot build')],
    'J2 implement': [done(H('t0'), H('j2'))], 'J2 review': [approve()],
  });
  const mg = merger();
  const r = await runJoinWaves(m, plan(m), H('t0'), DIRS, s.io, mg.merge);
  assert.ok(!s.calls.some((c) => c.label.startsWith('J3')), 'J3 never starts');
  assert.deepEqual(mg.calls, [{ wave: 1, units: ['J1', 'J2'], statuses: ['blocked', 'done'], base: H('t0') }]);
  assert.match(r.stopped, /cannot build/);
  assert.equal(r.head, H('merge1'), 'the finished unit is merged before the join stops');
  assert.deepEqual(r.results.map((x) => [x.task, x.status]), [['J1', 'blocked'], ['J2', 'done']]);
});

test('a merge that stops ends the join at the wave base', async () => {
  const m = manifest({ join: [task('J1', []), task('J2', [])] });
  const s = stub({
    'J1 implement': [done(H('t0'), H('j1'))], 'J1 review': [approve()],
    'J2 implement': [done(H('t0'), H('j2'))], 'J2 review': [approve()],
  });
  const r = await runJoinWaves(m, plan(m), H('t0'), DIRS, s.io, merger(() => ({ stopped: 'conflict in a.js' })).merge);
  assert.equal(r.stopped, 'conflict in a.js');
  assert.equal(r.head, H('t0'));
});

test('a batch runs as one wave unit', async () => {
  const light = (id, deps) => task(id, deps, { tier: 'light', batch: 'k' });
  const m = manifest({ join: [task('J1', []), light('J2', []), light('J3', [])] });
  assert.deepEqual(plan(m), [['J1', 'J2-J3']]);
  const s = stub({
    'J1 implement': [done(H('t0'), H('j1'))], 'J1 review': [approve()],
    'J2-J3 implement': [done(H('t0'), H('j23'))], 'J2-J3 review': [approve()],
  });
  const r = await runJoinWaves(m, plan(m), H('t0'), DIRS, s.io, merger().merge);
  assert.ok(callOf(s, 'J2-J3 implement').prompt.includes("--unit-branch 'pl-run-1-u-J2-J3'"));
  assert.deepEqual(r.results.map((x) => [x.task, x.batch || null, x.head]),
    [['J1', null, H('j1')], ['J2', 'J2-J3', H('j23')], ['J3', 'J2-J3', H('j23')]]);
});

test('an unblock note goes to the dependent unit, else the next wave', async () => {
  const m = manifest({ autonomy: 'autonomous',
    join: [task('J1', []), task('J2', []), task('J3', ['J2']), task('J4', ['J1'])] });
  // waves: [J1, J2], [J3, J4]
  assert.deepEqual(plan(m), [['J1', 'J2'], ['J3', 'J4']]);
  const unblock = { outcome: 'unblock', text: 'use the stub', head: H('j2') };
  const s = stub({
    'J1 implement': [done(H('t0'), H('j1'))], 'J1 review': [approve()],
    'J2 implement': [{ status: 'question', base: H('t0'), head: H('t0'), tests: '', notes: '', question: 'which?' }],
    'J2 adjudicate': [unblock],
    'J3 implement': [done(H('merge1'), H('j3'))], 'J3 review': [approve()],
    'J4 implement': [done(H('merge1'), H('j4'))], 'J4 review': [approve()],
  });
  const r = await runJoinWaves(m, plan(m), H('t0'), DIRS, s.io, merger().merge);
  assert.equal(r.results.find((x) => x.task === 'J2').status, 'deferred');
  assert.ok(callOf(s, 'J3 implement').prompt.includes('from J2, unblocked by the adjudicator: use the stub'));
  assert.ok(!callOf(s, 'J4 implement').prompt.includes('unblocked by the adjudicator'));
});

test('setup commands go to the unit\'s start command', () => {
  const m = manifest({ commands: { setup: ['npm ci', 'make seed'], test: ['npm test'], lint: [], build: [] } });
  const where = unitWhere(m, m.join[1], DIRS[0], H('w'));
  assert.deepEqual(where, { dir: DIRS[0], branch: 'pl-run-1-u-J2', lane: 'join', unit_branch: 'pl-run-1-u-J2', from: H('w') });
  const cmd = startCommand(m, m.join[1], where, { start: H('w') });
  assert.ok(cmd.includes(`--unit-branch 'pl-run-1-u-J2' '${H('w')}' --run-id 'run-1' --setup 'npm ci' --setup 'make seed'`), cmd);
  const review = startCommand(m, m.join[1], where, {});
  assert.ok(!review.includes('--unit-branch'), 'only the implement start switches branches');
});

test('the join head is the last tip', async () => {
  const m = manifest({ join: [task('J1', []), task('J2', [])] });
  const s = stub({
    'J1 implement': [done(H('t0'), H('j1'))], 'J1 review': [approve()],
    'J2 implement': [done(H('t0'), H('j2'))], 'J2 review': [approve()],
  });
  const r = await runJoinWaves(m, plan(m), H('t0'), DIRS, s.io, merger().merge);
  assert.equal(r.head, H('merge1'));
  assert.notEqual(r.head, H('j2'));
});
