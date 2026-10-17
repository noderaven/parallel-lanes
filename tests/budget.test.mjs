import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadHelpers, loadScript, H } from './harness.mjs';

const { makeIo, planAgents, labelTasks, agentTypeFor } =
  await loadHelpers(['makeIo', 'planAgents', 'labelTasks', 'agentTypeFor']);

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
    setup_result: {
      feature_head: H('F0'), discarded: [], worktrees: { alpha: '/work/wt/lane-alpha', beta: '/work/wt/lane-beta' },
    },
    ...overrides,
  };
}

const newState = () => ({ agents: 0, rulings: 0, refused: [] });

// A base io whose agent answers each label from a queue; unscripted labels
// throw so unexpected calls fail the test, and a queued Error is thrown.
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
        const r = queue.shift();
        if (r instanceof Error) throw r;
        return r;
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
  const { io, calls } = baseIo({ setup: [null], 'setup retry': [null], 'availability probe': [{ ok: true }] });
  const state = newState();
  const r = await makeIo(manifest(), io, state).agent('P', { label: 'setup' });
  assert.equal(r, null);
  assert.deepEqual(labels(calls), ['setup', 'setup retry', 'availability probe'], 'the probe is no retry');
  assert.equal(state.agents, 3);
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
  assert.deepEqual(labelTasks(m, 'start check'), []);
  assert.deepEqual(labelTasks(m, 'start check retry'), []);
});

test('the default max_agents estimate counts the start check once, right after verify', () => {
  const roles = planAgents(manifest()).map((a) => a.role);
  assert.equal(roles.filter((r) => r === 'start_check').length, 1);
  assert.equal(roles.indexOf('start_check'), roles.indexOf('verify') + 1);
});

// ---- Agent type ----

const typed = (extra = {}) => manifest({ agent_type: 'parallel-lanes-worker', ...extra });
const agentTypes = (calls) => calls.map((c) => ('agentType' in c ? c.agentType : null));

test('agentTypeFor leaves the e2e and post-integrate rechecks on the default agent type', () => {
  const m = typed();
  for (const label of ['e2e recheck', 'e2e recheck retry', 'post-integrate recheck', 'post-integrate recheck retry']) {
    assert.equal(agentTypeFor(m, label), null, label);
  }
  assert.equal(agentTypeFor(m, 'verify'), 'parallel-lanes-worker');
  assert.equal(agentTypeFor(m, 'start check'), 'parallel-lanes-worker');
  assert.equal(agentTypeFor(m, 'start check retry'), 'parallel-lanes-worker');
});

test('agentTypeFor names the agent type for every label but the hook agents', () => {
  const m = typed();
  assert.equal(agentTypeFor(m, 'T2 implement'), 'parallel-lanes-worker');
  assert.equal(agentTypeFor(m, 'post-integrate re-review'), 'parallel-lanes-worker');
  for (const label of ['e2e', 'e2e retry', 'post-integrate', 'post-integrate retry',
    'post-integrate fix', 'post-integrate fix retry']) {
    assert.equal(agentTypeFor(m, label), null, label);
  }
  assert.equal(agentTypeFor(manifest(), 'T2 implement'), null);
  assert.equal(agentTypeFor(manifest({ agent_type: null }), 'T2 implement'), null);
  assert.equal(agentTypeFor(manifest({ agent_type: '' }), 'T2 implement'), null);
});

test('makeIo passes agentType to every agent but the hook agents', async () => {
  const names = ['T2 implement', 'final review sp', 'T2 adjudicate', 'e2e', 'post-integrate', 'e2e retry'];
  const script = Object.fromEntries(names.map((n) => [n, [{ status: 'done' }]]));
  const { io, calls } = baseIo(script);
  const wrapped = makeIo(typed(), io, newState());
  for (const label of names) await wrapped.agent('P', { label });
  assert.deepEqual(labels(calls), names);
  assert.deepEqual(agentTypes(calls), [
    'parallel-lanes-worker', 'parallel-lanes-worker', 'parallel-lanes-worker', null, null, null,
  ]);
});

test('makeIo adds no agentType without agent_type', async () => {
  for (const m of [manifest(), manifest({ agent_type: null })]) {
    const { io, calls } = baseIo({ 'T2 implement': [{ status: 'done' }], 'final review sp': [{ findings: [] }] });
    const wrapped = makeIo(m, io, newState());
    await wrapped.agent('P', { label: 'T2 implement' });
    await wrapped.agent('P', { label: 'final review sp' });
    assert.deepEqual(agentTypes(calls), [null, null]);
  }
});

test('makeIo retries a failed typed spawn without agentType', async (t) => {
  await t.test('the first spawn throws: both are counted and later spawns go untyped', async () => {
    const { io, calls } = baseIo({
      'T2 implement': [new Error('agent type parallel-lanes-worker not found')],
      'T2 implement retry': [{ status: 'done' }],
    });
    const state = newState();
    const r = await makeIo(typed(), io, state).agent('P', { label: 'T2 implement', phase: 'Lane alpha' });
    assert.deepEqual(r, { status: 'done' });
    assert.deepEqual(labels(calls), ['T2 implement', 'T2 implement retry']);
    assert.deepEqual(agentTypes(calls), ['parallel-lanes-worker', null]);
    assert.equal(calls[1].phase, 'Lane alpha');
    assert.equal(state.agents, 2);
    assert.equal(state.untyped, true);
  });
  await t.test('the first spawn returns null: a dead agent, counted, and the type is kept', async () => {
    const { io, calls } = baseIo({ 'T2 implement': [null], 'T2 implement retry': [{ status: 'done' }] });
    const state = newState();
    const r = await makeIo(typed(), io, state).agent('P', { label: 'T2 implement' });
    assert.deepEqual(r, { status: 'done' });
    assert.deepEqual(labels(calls), ['T2 implement', 'T2 implement retry']);
    assert.deepEqual(agentTypes(calls), ['parallel-lanes-worker', null]);
    assert.equal(state.agents, 2);
    assert.ok(!state.untyped);
  });
});

test('makeIo spawns untyped after a typed spawn throws', async () => {
  const { io, calls, logs } = baseIo({
    'T2 implement': [new Error('agent type parallel-lanes-worker not found')],
    'T2 implement retry': [{ status: 'done' }],
    'T3 implement': [{ status: 'done' }],
    'T4 review': [null],
    'T4 review retry': [{ verdict: 'approve' }],
  });
  const state = newState();
  const wrapped = makeIo(typed(), io, state);
  await wrapped.agent('P', { label: 'T2 implement' });
  assert.deepEqual(await wrapped.agent('P', { label: 'T3 implement' }), { status: 'done' });
  assert.deepEqual(await wrapped.agent('P', { label: 'T4 review' }), { verdict: 'approve' });
  assert.deepEqual(labels(calls),
    ['T2 implement', 'T2 implement retry', 'T3 implement', 'T4 review', 'T4 review retry']);
  assert.deepEqual(agentTypes(calls), ['parallel-lanes-worker', null, null, null, null]);
  assert.equal(state.agents, calls.length, 'every spawn is counted, the failed typed one too');
  assert.equal(logs.filter((l) => /default type/.test(l)).length, 1);
});

test('makeIo spawns untyped after two typed agents return null and their retries succeed', async () => {
  const { io, calls } = baseIo({
    'T2 implement': [null],
    'T2 implement retry': [{ status: 'done' }],
    'T3 implement': [null],
    'T3 implement retry': [{ status: 'done' }],
    'T4 implement': [{ status: 'done' }],
  });
  const state = newState();
  const wrapped = makeIo(typed(), io, state);
  await wrapped.agent('P', { label: 'T2 implement' });
  assert.ok(!state.untyped, 'one dead typed agent keeps the type');
  await wrapped.agent('P', { label: 'T3 implement' });
  assert.equal(state.untyped, true);
  assert.deepEqual(await wrapped.agent('P', { label: 'T4 implement' }), { status: 'done' });
  assert.deepEqual(agentTypes(calls), ['parallel-lanes-worker', null, 'parallel-lanes-worker', null, null]);
  assert.equal(state.agents, 5);
});

test('a typed null whose retry also fails does not count toward the fallback', async () => {
  const { io } = baseIo({
    'T2 implement': [null], 'T2 implement retry': [null],
    'T3 implement': [null], 'T3 implement retry': [null],
    'availability probe': [{ ok: true }, { ok: true }],
  });
  const state = newState();
  const wrapped = makeIo(typed(), io, state);
  assert.equal(await wrapped.agent('P', { label: 'T2 implement' }), null);
  assert.equal(await wrapped.agent('P', { label: 'T3 implement' }), null);
  assert.ok(!state.untyped);
});

test('a typed adjudication that throws spends a ruling for each attempt', async () => {
  const { io, calls } = baseIo({
    'T2 adjudicate': [new Error('agent type parallel-lanes-worker not found')],
    'T2 adjudicate retry': [{ outcome: 'answer' }],
  });
  const state = newState();
  const r = await makeIo(typed(), io, state).agent('P', { label: 'T2 adjudicate' });
  assert.deepEqual(r, { outcome: 'answer' });
  assert.deepEqual(labels(calls), ['T2 adjudicate', 'T2 adjudicate retry']);
  assert.equal(state.rulings, 2);
  assert.equal(state.agents, 2);
});

test('the retry of a typed spawn that throws goes through the budget checks', async () => {
  const { io, calls } = baseIo({ 'T2 implement': [new Error('broken definition')], 'T2 implement retry': [1] });
  const state = newState();
  const m = typed({ limits: { review_rounds: 5, max_parallel_lanes: 3, max_agents: 1 } });
  const wrapped = makeIo(m, io, state);
  assert.deepEqual(await wrapped.agent('P', { label: 'T2 implement' }), { __budget: true });
  assert.equal(state.agents, 1, 'the failed typed spawn holds its count');
  assert.deepEqual(state.refused, ['T2 implement retry']);
  assert.deepEqual(labels(calls), ['T2 implement']);
});

test("makeIo lets an untyped spawn's throw propagate", async () => {
  const { io, calls } = baseIo({ 'T2 implement': [new Error('boom')], 'T2 implement retry': [{ status: 'done' }] });
  const state = newState();
  await assert.rejects(makeIo(manifest(), io, state).agent('P', { label: 'T2 implement' }), /boom/);
  assert.deepEqual(labels(calls), ['T2 implement']);
  assert.ok(!state.untyped);
});

// ---- Agents unavailable (spec 4.1) ----

const PROBE = 'availability probe';
const UNAVAILABLE = { __budget: true, __unavailable: true };
const LIVE = { ok: true };

// A promise the test resolves by hand, to script the order in which
// concurrent agents finish.
function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}
// Let every pending continuation run.
const settle = () => new Promise((res) => setImmediate(res));

// baseIo with queued promises: the stub awaits a queued value, so a test can
// hold an agent in flight until it resolves its deferred.
function gatedIo(script) {
  const made = baseIo(script);
  const agent = made.io.agent;
  made.io.agent = async (prompt, opts) => {
    const queue = script[opts.label];
    if (queue && queue.length > 0 && queue[0] && typeof queue[0].then === 'function') {
      made.calls.push({ prompt, ...opts });
      return queue.shift();
    }
    return agent(prompt, opts);
  };
  return made;
}

test('a dead pair with a live probe returns null, and later calls spawn as usual', async () => {
  const { io, calls } = baseIo({
    X: [null], 'X retry': [null], [PROBE]: [LIVE, LIVE], Y: [{ status: 'done' }], Z: [null], 'Z retry': [null],
  });
  const state = newState();
  const wrapped = makeIo(manifest(), io, state);
  assert.equal(await wrapped.agent('P', { label: 'X' }), null);
  assert.deepEqual(labels(calls), ['X', 'X retry', PROBE]);
  assert.ok(!state.unavailable);
  assert.equal(state.unavailableInfo, undefined);
  assert.deepEqual(state.refused, []);
  assert.deepEqual(await wrapped.agent('P', { label: 'Y' }), { status: 'done' });
  assert.equal(await wrapped.agent('P', { label: 'Z' }), null, 'a later dead pair probes again');
  assert.deepEqual(labels(calls), ['X', 'X retry', PROBE, 'Y', 'Z', 'Z retry', PROBE]);
  assert.equal(state.agents, 7);
  assert.equal(state.results, 1, 'the probe answer is not a result');
});

test('a dead pair with a dead probe latches: every later call is refused, the verify too', async () => {
  const { io, calls, logs } = baseIo({ W: [{ status: 'done' }], X: [null], 'X retry': [null], [PROBE]: [null] });
  const state = newState();
  const wrapped = makeIo(manifest(), io, state);
  await wrapped.agent('P', { label: 'W' });
  assert.deepEqual(await wrapped.agent('P', { label: 'X' }), UNAVAILABLE);
  assert.equal(state.unavailable, true);
  assert.deepEqual(state.refused, ['X']);
  assert.deepEqual(state.unavailableInfo, { trigger: 'X', probe: PROBE, results_before: 1 });
  assert.equal(logs.filter((l) => l.includes('agents unavailable')).length, 1);
  assert.ok(logs.includes('parallel-lanes: agents unavailable: X and its retry returned no result,'
    + ' and the availability probe did not answer; no further agents start'), logs.join('\n'));
  assert.deepEqual(await wrapped.agent('P', { label: 'T2 implement' }), UNAVAILABLE);
  assert.deepEqual(await wrapped.agent('P', { label: 'verify', overBudget: true }), UNAVAILABLE);
  assert.deepEqual(labels(calls), ['W', 'X', 'X retry', PROBE]);
  assert.deepEqual(state.refused, ['X', 'T2 implement', 'verify']);
  assert.equal(state.agents, 4);
  assert.equal(state.results, 1);
});

test('two concurrent dead pairs share one probe', async (t) => {
  for (const [answer, expected] of [[null, UNAVAILABLE], [LIVE, null]]) {
    await t.test(`probe ${answer === null ? 'dead' : 'live'}`, async () => {
      const d = {};
      for (const k of ['A', 'A retry', 'B', 'B retry', PROBE]) d[k] = deferred();
      const script = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, [v.promise]]));
      const { io, calls } = gatedIo(script);
      const state = newState();
      const wrapped = makeIo(manifest(), io, state);
      const a = wrapped.agent('P', { label: 'A' });
      const b = wrapped.agent('P', { label: 'B' });
      d.A.resolve(null);
      d.B.resolve(null);
      await settle();
      d['A retry'].resolve(null);
      d['B retry'].resolve(null);
      await settle();
      assert.equal(labels(calls).filter((l) => l === PROBE).length, 1);
      d[PROBE].resolve(answer);
      assert.deepEqual(await a, expected);
      assert.deepEqual(await b, expected);
      assert.deepEqual(labels(calls), ['A', 'B', 'A retry', 'B retry', PROBE]);
      if (answer === null) {
        assert.equal(state.unavailableInfo.trigger, 'A');
        assert.deepEqual(state.refused, ['A', 'B']);
      } else {
        assert.deepEqual(state.refused, []);
      }
    });
  }
});

test('a single null with a live retry runs no probe', async () => {
  const { io, calls } = baseIo({ X: [null], 'X retry': [{ status: 'done' }] });
  const state = newState();
  assert.deepEqual(await makeIo(manifest(), io, state).agent('P', { label: 'X' }), { status: 'done' });
  assert.deepEqual(labels(calls), ['X', 'X retry']);
  assert.ok(!state.unavailable);
  assert.equal(state.results, 1);
});

test('after a budget refusal a dead pair runs no probe', async () => {
  const { io, calls } = baseIo({ a: [1], verify: [null], 'verify retry': [null] });
  const state = newState();
  const wrapped = makeIo(manifest({ limits: { review_rounds: 5, max_parallel_lanes: 3, max_agents: 1 } }), io, state);
  await wrapped.agent('P', { label: 'a' });
  assert.deepEqual(await wrapped.agent('P', { label: 'b' }), { __budget: true });
  assert.equal(await wrapped.agent('P', { label: 'verify', overBudget: true }), null);
  assert.deepEqual(labels(calls), ['a', 'verify', 'verify retry']);
  assert.ok(!state.unavailable);
  assert.deepEqual(state.refused, ['b']);
});

test('a probe refused by the budget returns the budget sentinel and sets no latch', async () => {
  const { io, calls } = baseIo({ X: [null], 'X retry': [null] });
  const state = newState();
  const wrapped = makeIo(manifest({ limits: { review_rounds: 5, max_parallel_lanes: 3, max_agents: 2 } }), io, state);
  const r = await wrapped.agent('P', { label: 'X' });
  assert.deepEqual(r, { __budget: true });
  assert.ok(!('__unavailable' in r));
  assert.deepEqual(labels(calls), ['X', 'X retry']);
  assert.ok(!state.unavailable);
  assert.equal(state.unavailableInfo, undefined);
  assert.deepEqual(state.refused, [PROBE]);
});

test('an overBudget verify that dies at the agent cap probes past the cap', async (t) => {
  const cap = manifest({ limits: { review_rounds: 5, max_parallel_lanes: 3, max_agents: 1 } });
  await t.test('live probe: the verify returns null and nothing is refused', async () => {
    const { io, calls } = baseIo({ a: [1], verify: [null], 'verify retry': [null], [PROBE]: [LIVE] });
    const state = newState();
    const wrapped = makeIo(cap, io, state);
    await wrapped.agent('P', { label: 'a' });
    assert.equal(await wrapped.agent('P', { label: 'verify', overBudget: true }), null);
    assert.deepEqual(labels(calls), ['a', 'verify', 'verify retry', PROBE]);
    assert.ok(!('overBudget' in calls[3]), 'the flag is not passed on');
    assert.deepEqual(state.refused, []);
    assert.ok(!state.unavailable);
    assert.equal(state.agents, 4);
  });
  await t.test('dead probe: the latch is set', async () => {
    const { io, calls } = baseIo({ a: [1], verify: [null], 'verify retry': [null], [PROBE]: [null] });
    const state = newState();
    const wrapped = makeIo(cap, io, state);
    await wrapped.agent('P', { label: 'a' });
    assert.deepEqual(await wrapped.agent('P', { label: 'verify', overBudget: true }), UNAVAILABLE);
    assert.deepEqual(labels(calls), ['a', 'verify', 'verify retry', PROBE]);
    assert.equal(state.unavailable, true);
    assert.deepEqual(state.refused, ['verify']);
  });
});

test('a probe that throws rejects the call, sets no latch, and a later dead pair probes again', async () => {
  const { io, calls } = baseIo({
    X: [null], 'X retry': [null], [PROBE]: [new Error('probe failed'), LIVE], Y: [null], 'Y retry': [null],
  });
  const state = newState();
  const wrapped = makeIo(manifest(), io, state);
  await assert.rejects(wrapped.agent('P', { label: 'X' }), /probe failed/);
  assert.ok(!state.unavailable);
  assert.equal(state.unavailableInfo, undefined);
  assert.deepEqual(state.refused, []);
  assert.equal(await wrapped.agent('P', { label: 'Y' }), null);
  assert.deepEqual(labels(calls), ['X', 'X retry', PROBE, 'Y', 'Y retry', PROBE]);
});

test('in a typed run the probe is untyped and leaves the agent type alone', async (t) => {
  await t.test('typed null, untyped retry null', async () => {
    const { io, calls } = baseIo({ 'T2 implement': [null], 'T2 implement retry': [null], [PROBE]: [null] });
    const state = newState();
    assert.deepEqual(await makeIo(typed(), io, state).agent('P', { label: 'T2 implement' }), UNAVAILABLE);
    assert.deepEqual(labels(calls), ['T2 implement', 'T2 implement retry', PROBE]);
    assert.ok(!('agentType' in calls[2]));
    assert.ok(!state.untyped);
  });
  await t.test('typed throw, untyped retry null', async () => {
    const { io, calls } = baseIo({
      'T2 implement': [new Error('broken definition')], 'T2 implement retry': [null], [PROBE]: [LIVE],
    });
    const state = newState();
    assert.equal(await makeIo(typed(), io, state).agent('P', { label: 'T2 implement' }), null);
    assert.deepEqual(labels(calls), ['T2 implement', 'T2 implement retry', PROBE]);
    assert.ok(!('agentType' in calls[2]));
  });
});

test("the probe runs on the dead call's model at low effort and is never a ruling", async () => {
  const { io, calls } = baseIo({ 'T2 adjudicate': [null], 'T2 adjudicate retry': [null], [PROBE]: [LIVE] });
  const state = newState();
  const opts = { label: 'T2 adjudicate', phase: 'Lane alpha', model: 'opus', effort: 'high', schema: { type: 'object' } };
  assert.equal(await makeIo(manifest(), io, state).agent('P', opts), null);
  const probe = calls[2];
  assert.equal(probe.label, PROBE);
  assert.equal(probe.phase, 'Lane alpha');
  assert.equal(probe.model, 'opus');
  assert.equal(probe.effort, 'low');
  assert.deepEqual(probe.schema,
    { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] });
  assert.equal(state.agents, 3);
  assert.equal(state.rulings, 2);
  assert.deepEqual(state.spawned[2], { label: PROBE, model: 'opus', effort: 'low' });
});

// A lane's reaction to a missing result, cut to what makeIo sees: it asks
// the adjudicator. The adjudicate call is made after a refusal too, so the
// replays see that no adjudicator starts once the latch is set.
async function laneCall(wrapped, id, label) {
  const r = await wrapped.agent('P', { label, model: 'opus' });
  const missing = r === null || (r && r.__budget);
  return [r, missing ? await wrapped.agent('P', { label: `${id} adjudicate`, model: 'opus' }) : null];
}

test('replay of sc1 launch 1: 6 agents and 0 rulings', async () => {
  // Journal order: CR5 review dies, its retry dies; the implements of CV4,
  // CH2 and CA4, already spawned, die after.
  const names = ['CR5 review', 'CR5 review retry', PROBE, 'CV4 implement', 'CH2 implement', 'CA4 implement'];
  const d = Object.fromEntries(names.map((n) => [n, deferred()]));
  const { io, calls } = gatedIo(Object.fromEntries(names.map((n) => [n, [d[n].promise]])));
  const state = newState();
  const wrapped = makeIo(manifest(), io, state);
  const runs = [
    laneCall(wrapped, 'CR5', 'CR5 review'),
    laneCall(wrapped, 'CV4', 'CV4 implement'),
    laneCall(wrapped, 'CH2', 'CH2 implement'),
    laneCall(wrapped, 'CA4', 'CA4 implement'),
  ];
  for (const n of names) {
    d[n].resolve(null);
    await settle();
  }
  const out = await Promise.all(runs);
  for (const [r, adj] of out) {
    assert.deepEqual(r, UNAVAILABLE);
    assert.deepEqual(adj, UNAVAILABLE);
  }
  assert.deepEqual(labels(calls), ['CR5 review', 'CV4 implement', 'CH2 implement', 'CA4 implement',
    'CR5 review retry', PROBE]);
  assert.equal(state.agents, 6);
  assert.equal(state.rulings, 0);
  assert.equal(state.unavailableInfo.trigger, 'CR5 review');
  assert.equal(state.unavailableInfo.results_before, 0);
});

test('replay of m1a launch 1: 4 agents and 0 rulings', async () => {
  // I3 dies, its retry dies; PL2, in flight, dies later.
  const names = ['I3 implement', 'I3 implement retry', PROBE, 'PL2 implement'];
  const d = Object.fromEntries(names.map((n) => [n, deferred()]));
  const { io, calls } = gatedIo(Object.fromEntries(names.map((n) => [n, [d[n].promise]])));
  const state = newState();
  const wrapped = makeIo(manifest(), io, state);
  const runs = [laneCall(wrapped, 'I3', 'I3 implement'), laneCall(wrapped, 'PL2', 'PL2 implement')];
  for (const n of names) {
    d[n].resolve(null);
    await settle();
  }
  await Promise.all(runs);
  assert.deepEqual(labels(calls), ['I3 implement', 'PL2 implement', 'I3 implement retry', PROBE]);
  assert.equal(state.agents, 4);
  assert.equal(state.rulings, 0);
  assert.equal(state.unavailable, true);
});

// ---- Whole runs ----

const done = (base, head) => ({ status: 'done', base, head, tests: 'npm test: pass', notes: '' });
const approve = () => ({ verdict: 'approve', findings: [], cannot_verify: [] });

function cleanScript() {
  const script = {
    'pre-flight': [{ conflicts: [], rulings: [], undeclared: [], code_deps: [] }],
    integrate: [{ status: 'done', head: H('I1'), notes: 'merged' }],
    'final review sp': [{ findings: [], cannot_verify: [], head: H('T5-h') }],
    'final review security': [{ findings: [], cannot_verify: [], head: H('T5-h') }],
    'final review correctness': [{ findings: [], cannot_verify: [], head: H('T5-h') }],
    verify: [{ head: H('T5-h'), results: [{ group: 'test', command: 'npm test', exit: 0 }], ok: true, clean: true, tracked_before: [], tracked_after: [], untracked_before: [], untracked_after: [] }],
  };
  for (const id of ['T1', 'T2', 'T3', 'T4', 'T5']) {
    script[`${id} implement`] = [done(`${id}-b`, H(`${id}-h`))];
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
    if (r instanceof Error) throw r;
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

test('the run records every agent it started with its model and effort', async () => {
  const script = cleanScript();
  // A small diff: T1's review runs at medium effort.
  script['T1 implement'] = [{ ...done('T1-b', H('T1-h')), changed_lines: 12 }];
  const { result, calls } = await run(manifest(), script);
  assert.equal(result.status, 'complete');
  assert.equal(result.agent_settings.length, calls.length);
  assert.deepEqual(result.agent_settings, calls.map((c) => ({ label: c.label, model: c.model, effort: c.effort })));
  assert.deepEqual(result.agent_settings.find((a) => a.label === 'T1 review'),
    { label: 'T1 review', model: 'opus', effort: 'medium' });
  assert.deepEqual(result.agent_settings.find((a) => a.label === 'T2 review'),
    { label: 'T2 review', model: 'opus', effort: 'high' });

  // A refused call adds no entry.
  const capped = manifest({ limits: { review_rounds: 5, max_parallel_lanes: 3, max_agents: 1 } });
  const stopped = await run(capped, cleanScript());
  assert.equal(stopped.result.reason, 'budget');
  assert.deepEqual(stopped.result.agent_settings, [{ label: 'pre-flight', model: 'opus', effort: 'high' }]);
});

test('a run reports agent_type_fallback only when a failing agent type switched it to the default', async () => {
  const clean = await run(typed(), cleanScript());
  assert.equal(clean.result.status, 'complete');
  assert.equal(clean.result.agent_type_fallback, undefined);
  const script = cleanScript();
  script['pre-flight retry'] = script['pre-flight'];
  script['pre-flight'] = [new Error('agent type parallel-lanes-worker not found')];
  const { result, calls } = await run(typed(), script);
  assert.equal(result.status, 'complete');
  assert.equal(result.agent_type_fallback, true);
  assert.equal(result.agents_spawned, calls.length);
  assert.deepEqual(agentTypes(calls).slice(0, 3), ['parallel-lanes-worker', null, null]);
});

test('cap reached while two lanes run: in-flight agents finish, no new agents start, stopped/budget', async () => {
  const limits = { review_rounds: 5, max_parallel_lanes: 3, max_agents: 6 };
  const m = manifest({ limits });
  // pre-flight, T1 implement, T1 review, T2 implement, T4 implement,
  // T2 review (6, still running when T4 review is refused).
  const { result, calls } = await run(m, cleanScript(), { 'T2 review': 20 });
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'budget');
  assert.deepEqual(result.budget, { agents: 6, rulings: 0, limits: { max_agents: 6, max_rulings: 25 } });
  assert.equal(result.agents_spawned, 6);
  assert.deepEqual(labels(calls), [
    'pre-flight', 'T1 implement', 'T1 review', 'T2 implement', 'T4 implement', 'T2 review',
  ]);
  assert.equal(result.tasks.T1.status, 'done');
  assert.deepEqual(result.tasks.T1.commits, [H('F0'), H('T1-h')]);
  assert.equal(result.tasks.T2.status, 'done', 'the in-flight review finished and its task is recorded');
  assert.deepEqual(result.tasks.T2.commits, [H('T1-h'), H('T2-h')]);
  assert.equal(result.tasks.T3.status, 'blocked');
  assert.equal(result.tasks.T3.notes, 'budget exhausted: T3 implement was not run');
  assert.equal(result.tasks.T4.status, 'blocked');
  assert.equal(result.tasks.T4.notes, 'budget exhausted: T4 review was not run');
  assert.equal(result.tasks.T5.status, 'not_run');
  assert.equal(result.integrate, null);
});

test('a refused agent stops the run for budget ahead of its own stop reason', async () => {
  const m = manifest({ limits: { review_rounds: 5, max_parallel_lanes: 3, max_agents: 1 } });
  const { result, calls } = await run(m, cleanScript());
  assert.deepEqual(labels(calls), ['pre-flight']);
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'budget');
  assert.equal(result.agents_spawned, 1);
  assert.equal(result.tasks.T1.notes, 'budget exhausted: T1 implement was not run');
});

test('a refusal during the final review stops the run instead of completing it', async () => {
  // pre-flight, 10 task agents, integrate, then two of the three lenses, and
  // the project checks at the feature head (they run over the cap).
  const m = manifest({ limits: { review_rounds: 5, max_parallel_lanes: 3, max_agents: 14 } });
  const { result, calls } = await run(m, cleanScript());
  assert.equal(calls.length, 15);
  assert.equal(labels(calls).at(-1), 'verify');
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'budget');
  assert.equal(result.verify.head, H('T5-h'));
  for (const id of ['T1', 'T2', 'T3', 'T4', 'T5']) assert.equal(result.tasks[id].status, 'done');
});

// Review finding 2: cheap deterministic checks run after the last change
// even when the review budget is spent, so a budget stop still says whether
// the code that exists passes.
test('the project checks run at the final fix head even when the budget refused its re-review', async () => {
  const m = manifest({ limits: { review_rounds: 5, max_parallel_lanes: 3, max_agents: 16 } });
  const script = cleanScript();
  const finding = { file: 'src/T1.js', line: 3, issue: 'bug', fix: 'fix it', severity: 'important' };
  script['final review sp'] = [{ findings: [finding], cannot_verify: [] }];
  script['final fix'] = [{ status: 'done', head: H('FX'), tests: 'npm test: pass', notes: '', dispositions: [{ id: 'F1', status: 'fixed', reason: 'ok', evidence: 'src/a.js:3' }] }];
  script.verify = [{ head: H('FX'), results: [{ group: 'test', command: 'npm test', exit: 1 }], ok: false, clean: true, tracked_before: [], tracked_after: [], untracked_before: [], untracked_after: [] }];
  const { result, calls } = await run(m, script);
  assert.deepEqual(labels(calls).slice(-2), ['final fix', 'verify']);
  assert.ok(calls.at(-1).prompt.includes(`rev-parse HEAD must print ${H('FX')}`), calls.at(-1).prompt);
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'budget');
  assert.equal(result.agents_spawned, 17, 'the checks are counted, over the cap');
  assert.deepEqual(result.verify.results.map((r) => r.exit), [1]);
  assert.equal(result.acceptance, null, 'a stopped run is never accepted');
});

test('the checks do not run over the cap when no code exists past the lanes', async () => {
  const m = manifest({ limits: { review_rounds: 5, max_parallel_lanes: 3, max_agents: 1 } });
  const { result, calls } = await run(m, cleanScript());
  assert.deepEqual(labels(calls), ['pre-flight']);
  assert.equal(result.verify, null);
});

test('a refused final re-review stops the run for budget instead of throwing', async () => {
  // pre-flight, 10 task agents, integrate, three lenses, final fix (16).
  const m = manifest({ limits: { review_rounds: 5, max_parallel_lanes: 3, max_agents: 16 } });
  const script = cleanScript();
  const finding = { file: 'src/T1.js', line: 3, issue: 'bug', fix: 'fix it', severity: 'important' };
  script['final review sp'] = [{ findings: [finding], cannot_verify: [] }];
  script['final fix'] = [{ status: 'done', head: H('FX'), tests: 'npm test: pass', notes: '', dispositions: [{ id: 'F1', status: 'fixed', reason: 'ok', evidence: 'src/a.js:3' }] }];
  script.verify = [{ head: H('FX'), results: [{ group: 'test', command: 'npm test', exit: 0 }], ok: true, clean: true, tracked_before: [], tracked_after: [], untracked_before: [], untracked_after: [] }];
  const { result, calls } = await run(m, script);
  assert.equal(calls.length, 17);
  assert.deepEqual(labels(calls).slice(-2), ['final fix', 'verify']);
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'budget');
  assert.equal(result.agents_spawned, 17);
  assert.deepEqual(result.final.fixed, []);
  assert.deepEqual(result.final.open.map((d) => d.reason), ['final re-review not run: budget exhausted']);
  for (const id of ['T1', 'T2', 'T3', 'T4', 'T5']) assert.equal(result.tasks[id].status, 'done');
});

test('a dead agent retried once completes the run', async () => {
  const script = cleanScript();
  script['T3 implement'] = [null];
  script['T3 implement retry'] = [done('T3-b', H('T3-h'))];
  const { result, calls } = await run(manifest(), script);
  assert.equal(result.status, 'complete');
  assert.equal(result.tasks.T3.status, 'done');
  assert.ok(labels(calls).includes('T3 implement retry'));
  assert.equal(result.agents_spawned, calls.length);
});

test('rulings_spent counts the adjudications that ran, not the one the cap refused', async () => {
  const m = manifest({ limits: { review_rounds: 5, max_parallel_lanes: 3, max_rulings: 1 } });
  const script = cleanScript();
  const stuck = { status: 'blocked', head: H('F0'), tests: '', notes: 'stuck' };
  script['T1 implement'] = [stuck, stuck];
  script['T1 adjudicate'] = [{ outcome: 'answer', text: 'Ruling: try v2 - spec says so - low' }];
  const { result, calls } = await run(m, script);
  assert.equal(labels(calls).filter((l) => l === 'T1 adjudicate').length, 1);
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'budget');
  assert.equal(result.rulings_spent, 1);
  assert.equal(result.budget.rulings, 1);
});
