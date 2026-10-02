import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadHelpers, loadScript } from './harness.mjs';

const { makeIo, planAgents, labelTasks } = await loadHelpers(['makeIo', 'planAgents', 'labelTasks']);

function task(id, extra = {}) {
  return { id, title: `Task ${id}`, files: [`src/${id}.js`], tier: 'standard', security: false, ...extra };
}

function manifest(overrides = {}) {
  return {
    version: 1,
    run_id: 'run-1',
    plan: '/work/plan.md',
    spec: '/work/spec.md',
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
    prelude: [task('T1')],
    lanes: [
      { id: 'alpha', name: 'Lane alpha', tasks: [task('T2'), task('T3')] },
      { id: 'beta', name: 'Lane beta', tasks: [task('T4')] },
    ],
    join: [task('T5')],
    hooks: {},
    limits: { review_rounds: 5, max_parallel_lanes: 3 },
    dry_run: false,
    done: [],
    reviewed: [],
    sp_dir: null,
    skill_dir: '/skills/parallel-lanes',
    ...overrides,
  };
}

const newState = () => ({ agents: 0, rulings: 0, refused: [] });

// A base io whose agent answers each label from a queue; unscripted labels
// throw so unexpected calls fail the test.
function baseIo(script) {
  const calls = [];
  const logs = [];
  return {
    calls,
    logs,
    io: {
      log: (msg) => logs.push(msg),
      phase: () => {},
      parallel: (thunks) => Promise.all(thunks.map((t) => t())),
      agent: async (prompt, opts) => {
        calls.push({ prompt, ...opts });
        const queue = script[opts.label];
        if (!queue || queue.length === 0) throw new Error(`unscripted agent call: ${opts.label}`);
        return queue.shift();
      },
    },
  };
}

const labels = (calls) => calls.map((c) => c.label);

test('a null result is retried once with the same opts and the retry result is used', async () => {
  const { io, calls } = baseIo({ 'T1 implement': [null], 'T1 implement retry': [{ status: 'done' }] });
  const state = newState();
  const wrapped = makeIo(manifest(), io, state);
  const opts = { label: 'T1 implement', phase: 'Prelude', schema: { type: 'object' }, model: 'opus', effort: 'high' };
  const r = await wrapped.agent('PROMPT', opts);
  assert.deepEqual(r, { status: 'done' });
  assert.deepEqual(labels(calls), ['T1 implement', 'T1 implement retry']);
  assert.deepEqual(calls[1], { prompt: 'PROMPT', ...opts, label: 'T1 implement retry' });
  assert.equal(state.agents, 2);
  assert.deepEqual(state.refused, []);
  assert.equal(wrapped.log, io.log, 'the other io members pass through');
});

test('a null retry result is returned as null and not retried again', async () => {
  const { io, calls } = baseIo({ setup: [null], 'setup retry': [null] });
  const state = newState();
  const r = await makeIo(manifest(), io, state).agent('P', { label: 'setup' });
  assert.equal(r, null);
  assert.deepEqual(labels(calls), ['setup', 'setup retry']);
  assert.equal(state.agents, 2);
});

test('a call past max_agents is refused without spawning, and every later call too', async () => {
  const { io, calls, logs } = baseIo({ a: [1], b: [2], c: [3], d: [4] });
  const state = newState();
  const wrapped = makeIo(manifest({ limits: { review_rounds: 5, max_parallel_lanes: 3, max_agents: 2 } }), io, state);
  assert.equal(await wrapped.agent('P', { label: 'a' }), 1);
  assert.equal(await wrapped.agent('P', { label: 'b' }), 2);
  assert.deepEqual(await wrapped.agent('P', { label: 'c' }), { __budget: true });
  assert.deepEqual(await wrapped.agent('P', { label: 'd' }), { __budget: true });
  assert.deepEqual(labels(calls), ['a', 'b']);
  assert.equal(state.agents, 2);
  assert.deepEqual(state.refused, ['c', 'd']);
  assert.ok(logs.some((l) => l.includes('budget exhausted: c was not run')));
});

test('a retry passes the same checks: at the agent cap it is refused', async () => {
  const { io, calls } = baseIo({ e2e: [null] });
  const state = newState();
  const wrapped = makeIo(manifest({ limits: { review_rounds: 5, max_parallel_lanes: 3, max_agents: 1 } }), io, state);
  assert.deepEqual(await wrapped.agent('P', { label: 'e2e' }), { __budget: true });
  assert.deepEqual(labels(calls), ['e2e']);
  assert.deepEqual(state.refused, ['e2e retry']);
});

test('the rulings cap counts only adjudicate labels, retries included, and lets exactly max_rulings run', async () => {
  const { io, calls } = baseIo({
    'T1 implement': [{ status: 'done' }],
    'T1 adjudicate': [null],
    'T1 adjudicate retry': [{ outcome: 'answer' }],
    'final review sp': [{ findings: [] }],
    'run adjudicate': [{ outcome: 'answer' }],
  });
  const state = newState();
  const m = manifest({ limits: { review_rounds: 5, max_parallel_lanes: 3, max_rulings: 3 } });
  const wrapped = makeIo(m, io, state);
  await wrapped.agent('P', { label: 'T1 implement' });
  assert.equal(state.rulings, 0);
  assert.deepEqual(await wrapped.agent('P', { label: 'T1 adjudicate' }), { outcome: 'answer' });
  assert.equal(state.rulings, 2, 'the adjudication and its retry are two rulings');
  await wrapped.agent('P', { label: 'final review sp' });
  assert.equal(state.rulings, 2);
  assert.deepEqual(await wrapped.agent('P', { label: 'run adjudicate' }), { outcome: 'answer' });
  assert.equal(state.rulings, 3);
  assert.deepEqual(await wrapped.agent('P', { label: 'T2 adjudicate' }), { __budget: true });
  assert.equal(state.rulings, 3, 'a refused adjudication is not counted as spent');
  assert.deepEqual(labels(calls),
    ['T1 implement', 'T1 adjudicate', 'T1 adjudicate retry', 'final review sp', 'run adjudicate']);
  assert.equal(state.agents, 5);
  assert.deepEqual(state.refused, ['T2 adjudicate']);
});

test('max_rulings 0: no adjudication runs', async () => {
  const { io, calls } = baseIo({ 'T1 adjudicate': [{ outcome: 'answer' }] });
  const state = newState();
  const m = manifest({ limits: { review_rounds: 5, max_parallel_lanes: 3, max_rulings: 0 } });
  assert.deepEqual(await makeIo(m, io, state).agent('P', { label: 'T1 adjudicate' }), { __budget: true });
  assert.deepEqual(calls, []);
  assert.equal(state.agents, 0);
  assert.equal(state.rulings, 0);
  assert.deepEqual(state.refused, ['T1 adjudicate']);
});

test('default max_agents is 2 x the planAgents estimate', async () => {
  const m = manifest();
  const cap = 2 * planAgents(m).length;
  const script = {};
  for (let i = 0; i <= cap; i += 1) script[`a${i}`] = [i];
  const { io, calls } = baseIo(script);
  const state = newState();
  const wrapped = makeIo(m, io, state);
  for (let i = 0; i < cap; i += 1) assert.equal(await wrapped.agent('P', { label: `a${i}` }), i);
  assert.deepEqual(await wrapped.agent('P', { label: `a${cap}` }), { __budget: true });
  assert.equal(calls.length, cap);
  assert.equal(state.agents, cap);
});

test('labelTasks maps an agent label to its tasks: one id, a batch range, or none', () => {
  const m = manifest();
  assert.deepEqual(labelTasks(m, 'T3 implement'), ['T3']);
  assert.deepEqual(labelTasks(m, 'T4 re-review 2 retry'), ['T4']);
  assert.deepEqual(labelTasks(m, 'T1-T3 review'), ['T1', 'T2', 'T3']);
  assert.deepEqual(labelTasks(m, 'final review sp'), []);
  assert.deepEqual(labelTasks(m, 'run adjudicate'), []);
});

// ---- Whole runs ----

const done = (base, head) => ({ status: 'done', base, head, tests: 'npm test: pass', notes: '' });
const approve = () => ({ verdict: 'approve', findings: [], cannot_verify: [] });

function cleanScript() {
  const script = {
    setup: [{ ok: true, discarded: [], worktrees: [], feature_head: 'F0', notes: '' }],
    'pre-flight': [{ conflicts: [], rulings: [] }],
    integrate: [{ status: 'done', head: 'I1', notes: 'merged' }],
    'final review sp': [{ findings: [], cannot_verify: [] }],
    'final review security': [{ findings: [], cannot_verify: [] }],
    'final review correctness': [{ findings: [], cannot_verify: [] }],
  };
  for (const id of ['T1', 'T2', 'T3', 'T4', 'T5']) {
    script[`${id} implement`] = [done(`${id}-b`, `${id}-h`)];
    script[`${id} review`] = [approve()];
  }
  return script;
}

// Run the script body; delays maps a label to milliseconds its stub waits.
async function run(m, script, delays = {}) {
  const calls = [];
  const agent = async (prompt, opts) => {
    calls.push({ prompt, ...opts });
    const queue = script[opts.label];
    if (!queue || queue.length === 0) throw new Error(`unscripted agent call: ${opts.label}`);
    const r = queue.shift();
    if (delays[opts.label]) await new Promise((res) => setTimeout(res, delays[opts.label]));
    return r;
  };
  const parallel = (thunks) => Promise.all(thunks.map((t) => t().catch(() => null)));
  const result = await loadScript({ args: m, agent, parallel, phase: () => {}, log: () => {} });
  return { result, calls };
}

test('a clean run under the default budget completes and counts every agent', async () => {
  const m = manifest();
  const { result, calls } = await run(m, cleanScript());
  assert.equal(result.status, 'complete');
  assert.equal(result.agents_spawned, calls.length);
  assert.equal(result.rulings_spent, 0);
  assert.equal(result.budget, undefined);
});

test('cap reached while two lanes run: in-flight agents finish, no new agents start, stopped/budget', async () => {
  const limits = { review_rounds: 5, max_parallel_lanes: 3, max_agents: 7 };
  const m = manifest({ limits });
  // setup, pre-flight, T1 implement, T1 review, T2 implement, T4 implement,
  // T2 review (7, still running when T4 review is refused).
  const { result, calls } = await run(m, cleanScript(), { 'T2 review': 20 });
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'budget');
  assert.deepEqual(result.budget, { agents: 7, rulings: 0, limits: { max_agents: 7, max_rulings: 25 } });
  assert.equal(result.agents_spawned, 7);
  assert.deepEqual(labels(calls), [
    'setup', 'pre-flight', 'T1 implement', 'T1 review', 'T2 implement', 'T4 implement', 'T2 review',
  ]);
  assert.equal(result.tasks.T1.status, 'done');
  assert.deepEqual(result.tasks.T1.commits, ['F0', 'T1-h']);
  assert.equal(result.tasks.T2.status, 'done', 'the in-flight review finished and its task is recorded');
  assert.deepEqual(result.tasks.T2.commits, ['T1-h', 'T2-h']);
  assert.equal(result.tasks.T3.status, 'blocked');
  assert.equal(result.tasks.T3.notes, 'budget exhausted: T3 implement was not run');
  assert.equal(result.tasks.T4.status, 'blocked');
  assert.equal(result.tasks.T4.notes, 'budget exhausted: T4 review was not run');
  assert.equal(result.tasks.T5.status, 'not_run');
  assert.equal(result.integrate, null);
});

test('a refused phase agent stops the run for budget ahead of its own stop reason', async () => {
  const m = manifest({ limits: { review_rounds: 5, max_parallel_lanes: 3, max_agents: 1 } });
  const { result, calls } = await run(m, cleanScript());
  assert.deepEqual(labels(calls), ['setup']);
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'budget');
  assert.equal(result.preflight, null);
  assert.equal(result.agents_spawned, 1);
  assert.equal(result.tasks.T1.status, 'not_run');
});

test('a refusal during the final review stops the run instead of completing it', async () => {
  // setup, pre-flight, 10 task agents, integrate, then the three lenses.
  const m = manifest({ limits: { review_rounds: 5, max_parallel_lanes: 3, max_agents: 14 } });
  const { result, calls } = await run(m, cleanScript());
  assert.equal(calls.length, 14);
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'budget');
  for (const id of ['T1', 'T2', 'T3', 'T4', 'T5']) assert.equal(result.tasks[id].status, 'done');
});

test('a refused final re-review stops the run for budget instead of throwing', async () => {
  // setup, pre-flight, 10 task agents, integrate, three lenses, final fix (17).
  const m = manifest({ limits: { review_rounds: 5, max_parallel_lanes: 3, max_agents: 17 } });
  const script = cleanScript();
  const finding = { file: 'src/T1.js', line: 3, issue: 'bug', fix: 'fix it', severity: 'important' };
  script['final review sp'] = [{ findings: [finding], cannot_verify: [] }];
  script['final fix'] = [{ status: 'done', head: 'FX', tests: 'npm test: pass', notes: '', declined: [] }];
  const { result, calls } = await run(m, script);
  assert.equal(calls.length, 17);
  assert.equal(labels(calls).at(-1), 'final fix');
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'budget');
  assert.equal(result.agents_spawned, 17);
  assert.deepEqual(result.final.fixed, []);
  assert.deepEqual(result.final.declined.map((d) => d.reason), ['final re-review not run: budget exhausted']);
  for (const id of ['T1', 'T2', 'T3', 'T4', 'T5']) assert.equal(result.tasks[id].status, 'done');
});

test('a dead agent retried once completes the run', async () => {
  const script = cleanScript();
  script['T3 implement'] = [null];
  script['T3 implement retry'] = [done('T3-b', 'T3-h')];
  const { result, calls } = await run(manifest(), script);
  assert.equal(result.status, 'complete');
  assert.equal(result.tasks.T3.status, 'done');
  assert.ok(labels(calls).includes('T3 implement retry'));
  assert.equal(result.agents_spawned, calls.length);
});

test('rulings_spent counts the adjudications that ran, not the one the cap refused', async () => {
  const m = manifest({ limits: { review_rounds: 5, max_parallel_lanes: 3, max_rulings: 1 } });
  const script = cleanScript();
  const stuck = { status: 'blocked', head: 'F0', tests: '', notes: 'stuck' };
  script['T1 implement'] = [stuck, stuck];
  script['T1 adjudicate'] = [{ outcome: 'answer', text: 'Ruling: try v2 - spec says so - low' }];
  const { result, calls } = await run(m, script);
  assert.equal(labels(calls).filter((l) => l === 'T1 adjudicate').length, 1);
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'budget');
  assert.equal(result.rulings_spent, 1);
  assert.equal(result.budget.rulings, 1);
});
