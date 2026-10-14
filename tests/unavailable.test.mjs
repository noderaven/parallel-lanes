// Agents unavailable, the run side (1.6.2 spec 4.1, part 2): once makeIo's
// availability probe latches, runAll stops with reason agents_unavailable at
// every stop point, the refusal texts say so, and a refused verify is never
// stored. Whole runs with scripted agents: an unscripted label throws, so a
// call the run should not make fails the test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadHelpers, loadScript, H } from './harness.mjs';

const { adjudicate, refusalText, refusalCause, validRepairReview } = await loadHelpers([
  'adjudicate', 'refusalText', 'refusalCause', 'validRepairReview',
]);

const PROBE = 'availability probe';

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
      mode: 'git', root: '/work/repo', git_dir: null, base_ref: 'main', branch: 'pl/run-1',
      worktree_root: '/work/wt', ledger_dir: '/work/ledger',
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

const supervised = (extra = {}) => manifest({ autonomy: 'supervised', ...extra });

const done = (base, head) => ({ status: 'done', base, head, tests: 'npm test: pass', notes: '' });
const approve = () => ({ verdict: 'approve', findings: [], cannot_verify: [] });
const finding = (issue) => ({ severity: 'important', file: 'src/T1.js', line: 3, issue, fix: 'fix it' });
const verified = (sha, exit = 0, extra = {}) => ({
  head: sha, results: [{ group: 'test', command: 'npm test', exit, log: `/work/ledger/checks/${sha}.log`, tail: '' }],
  ok: exit === 0, clean: true, tracked_before: [], tracked_after: [], untracked_before: [], untracked_after: [],
  ...extra,
});
const fixed = (head) => ({ status: 'done', head, tests: 'npm test: pass', notes: '',
  dispositions: [{ id: 'F1', status: 'fixed', reason: 'fixed', evidence: 'src/T1.js:3' }] });
const resolved = (head) => ({ head, results: [{ id: 'F1', status: 'resolved', evidence: 'gone' }], new_findings: [] });

function cleanScript() {
  const script = {
    'pre-flight': [{ conflicts: [], rulings: [], undeclared: [], code_deps: [] }],
    integrate: [{ status: 'done', head: H('I1'), notes: 'merged' }],
    'final review sp': [{ findings: [], cannot_verify: [], head: H('T5-h') }],
    'final review security': [{ findings: [], cannot_verify: [], head: H('T5-h') }],
    'final review correctness': [{ findings: [], cannot_verify: [], head: H('T5-h') }],
    verify: [verified(H('T5-h'))],
  };
  for (const id of ['T1', 'T2', 'T3', 'T4', 'T5']) {
    script[`${id} implement`] = [done(`${id}-b`, H(`${id}-h`))];
    script[`${id} review`] = [approve()];
  }
  return script;
}

// The dead pair of label (the call and its automatic retry return null) and
// a probe that does not answer: makeIo latches agents unavailable.
const dies = (label) => ({ [label]: [null], [`${label} retry`]: [null], [PROBE]: [null] });

// Run the script body; delays maps a label to milliseconds its stub waits
// before it answers.
async function run(m, script, delays = {}) {
  const calls = [];
  const logs = [];
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
  const result = await loadScript({ args: m, agent, parallel, phase: () => {}, log: (msg) => logs.push(msg) });
  return { result, calls, logs };
}

const labels = (calls) => calls.map((c) => c.label);

// The stop every case below shares: no adjudicator, the reason, the field.
function assertUnavailable(result, calls, trigger, resultsBefore) {
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'agents_unavailable');
  assert.deepEqual(result.agents_unavailable, { trigger, probe: PROBE, results_before: resultsBefore });
  assert.equal(result.budget, undefined, 'the budget field belongs to reason budget only');
  assert.equal(result.acceptance, null);
  assert.ok(!labels(calls).some((l) => / adjudicate( retry)?$/.test(l)), labels(calls).join(', '));
  assert.ok(!(result.verify && result.verify.__budget), 'a refused verify is never stored');
  assert.equal(labels(calls).filter((l) => l === PROBE).length, 1, 'one probe');
}

test('refusalText and refusalCause name the latch, else the budget', () => {
  assert.equal(refusalText({ unavailable: true }, 'T2 review'), 'agents unavailable: T2 review was not run');
  assert.equal(refusalText({ refused: ['x'] }, 'T2 review'), 'budget exhausted: T2 review was not run');
  assert.equal(refusalCause({ unavailable: true }), 'agents unavailable');
  assert.equal(refusalCause({}), 'budget exhausted');
  assert.equal(validRepairReview({ __budget: true, __unavailable: true }, H('r1')),
    'the final re-review was not run: agents unavailable');
  assert.equal(validRepairReview({ __budget: true }, H('r1')), 'the final re-review was not run: budget exhausted');
});

test('a lane implement and its retry die and the probe dies: stopped agents_unavailable, no adjudicate, no verify', async () => {
  const script = { ...cleanScript(), ...dies('T2 implement') };
  // T4's implement is still running when the latch is set: its review is refused.
  const { result, calls, logs } = await run(manifest(), script, { 'T4 implement': 30 });
  // pre-flight, T1 implement and T1 review returned results before the latch.
  assertUnavailable(result, calls, 'T2 implement', 3);
  assert.ok(!labels(calls).includes('verify'), labels(calls).join(', '));
  assert.ok(!labels(calls).includes('integrate'));
  assert.equal(result.tasks.T1.status, 'done');
  assert.equal(result.tasks.T2.status, 'blocked');
  assert.equal(result.tasks.T2.notes, 'agents unavailable: T2 implement was not run');
  assert.equal(result.tasks.T3.status, 'not_run');
  assert.equal(result.tasks.T4.status, 'blocked');
  assert.deepEqual(result.tasks.T4.commits, [H('T1-h'), H('T4-h')], 'the in-flight implement is recorded');
  assert.equal(result.tasks.T4.notes, 'agents unavailable: T4 review was not run');
  assert.equal(result.tasks.T5.status, 'not_run');
  assert.deepEqual(result.stopped_lanes.map((s) => [s.lane, s.task, s.reason]), [
    ['alpha', 'T2', 'agents unavailable: T2 implement was not run'],
    ['beta', 'T4', 'agents unavailable: T4 review was not run'],
  ]);
  assert.equal(result.verify, null);
  assert.ok(logs.includes('parallel-lanes: agents unavailable: T4 review was not run'), logs.join('\n'));
  assert.ok(!logs.some((l) => l.includes('budget exhausted')), logs.join('\n'));
});

test('an in-flight review that returns after the latch keeps its task done with its notes unchanged', async () => {
  const script = { ...cleanScript(), ...dies('T2 implement') };
  // T4 review starts before T2's implement dies and answers after the latch.
  const { result, calls } = await run(manifest(), script, { 'T2 implement': 10, 'T4 review': 40 });
  assertUnavailable(result, calls, 'T2 implement', 4);
  assert.ok(labels(calls).indexOf('T4 review') < labels(calls).indexOf(PROBE), labels(calls).join(', '));
  assert.equal(result.tasks.T4.status, 'done');
  assert.deepEqual(result.tasks.T4.commits, [H('T1-h'), H('T4-h')]);
  assert.equal(result.tasks.T4.notes, '');
  assert.equal(result.tasks.T2.notes, 'agents unavailable: T2 implement was not run');
  assert.deepEqual(result.stopped_lanes.map((s) => s.lane), ['alpha']);
});

test('a lane stopped at review_rounds before the latch keeps that cause', async () => {
  const changes = { verdict: 'changes', findings: [finding('bug')], cannot_verify: [] };
  const script = {
    ...cleanScript(),
    'T2 review': [changes],
    'T2 fix 1': [done('T2-b', H('T2-h2'))],
    'T2 re-review 1': [changes],
    ...dies('T4 implement'),
  };
  const m = supervised({ limits: { review_rounds: 1, max_parallel_lanes: 3 } });
  const { result, calls } = await run(m, script, { 'T4 implement': 30 });
  // pre-flight, T1 implement and review, T2 implement, review, fix 1 and re-review 1.
  assertUnavailable(result, calls, 'T4 implement', 7);
  const lanes = Object.fromEntries(result.stopped_lanes.map((s) => [s.lane, s]));
  assert.deepEqual(lanes.alpha, { lane: 'alpha', task: 'T2', reason: 'review_rounds' });
  assert.deepEqual(lanes.beta, { lane: 'beta', task: 'T4', reason: 'agents unavailable: T4 implement was not run' });
  assert.equal(result.tasks.T2.notes, 'review_rounds');
});

test('pre-flight and its retry die and the probe dies: agents_unavailable, not no result from pre-flight', async () => {
  const script = { ...cleanScript(), ...dies('pre-flight') };
  const { result, calls } = await run(manifest(), script);
  assertUnavailable(result, calls, 'pre-flight', 0);
  assert.deepEqual(labels(calls), ['pre-flight', 'pre-flight retry', PROBE]);
  for (const id of ['T1', 'T2', 'T3', 'T4', 'T5']) assert.equal(result.tasks[id].status, 'not_run');
  assert.equal(result.verify, null);
});

test('the run adjudicate pair dies and the probe dies: agents_unavailable', async () => {
  const script = {
    ...cleanScript(),
    'pre-flight': [{ conflicts: ['T2 and T4 both rename the config key'], rulings: [], undeclared: [], code_deps: [] }],
    ...dies('run adjudicate'),
  };
  const { result, calls } = await run(manifest(), script);
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'agents_unavailable');
  assert.deepEqual(result.agents_unavailable, { trigger: 'run adjudicate', probe: PROBE, results_before: 1 });
  assert.deepEqual(labels(calls), ['pre-flight', 'run adjudicate', 'run adjudicate retry', PROBE]);
  assert.deepEqual(result.preflight.rulings, []);
  assert.equal(result.rulings_spent, 2, 'the adjudications that ran are counted');
});

test('a supervised post-integrate pair dies and the probe dies: agents_unavailable', async () => {
  const script = { ...cleanScript(), ...dies('post-integrate') };
  const m = supervised({ hooks: { post_integrate: 'run the smoke test' } });
  const { result, calls } = await run(m, script);
  // pre-flight, 8 lane and prelude task agents, integrate.
  assertUnavailable(result, calls, 'post-integrate', 10);
  assert.deepEqual(labels(calls).slice(-4), ['integrate', 'post-integrate', 'post-integrate retry', PROBE]);
  assert.equal(result.integrate.status, 'done');
  assert.equal(result.verify, null);
  assert.equal(result.tasks.T5.status, 'not_run');
});

test('supervised, no hooks: a verify that dies with a dead probe does not report complete', async () => {
  const script = { ...cleanScript(), ...dies('verify') };
  const { result, calls } = await run(supervised(), script);
  // pre-flight, 10 task agents, integrate, 3 lenses: 15 results.
  assertUnavailable(result, calls, 'verify', 15);
  assert.equal(result.verify, null);
  assert.equal(result.final.verify, undefined);
  assert.equal(result.delivered_sha, H('T5-h'));
  for (const id of ['T1', 'T2', 'T3', 'T4', 'T5']) assert.equal(result.tasks[id].status, 'done');
});

test('supervised, no hooks: the final re-review dies with a dead probe: stopped, the earlier verify kept', async () => {
  const script = {
    ...cleanScript(),
    'final review sp': [{ findings: [finding('bug')], cannot_verify: [], head: H('T5-h') }],
    'final fix': [fixed(H('FX'))],
    verify: [verified(H('FX'))],
    ...dies('final re-review'),
  };
  const { result, calls } = await run(supervised(), script);
  assertUnavailable(result, calls, 'final re-review', 17);
  assert.deepEqual(labels(calls).slice(-4), ['verify', 'final re-review', 'final re-review retry', PROBE]);
  // The checks ran at the fix head before the re-review died: real evidence.
  assert.equal(result.verify.head, H('FX'));
  assert.equal(result.final.verify, undefined);
  assert.deepEqual(result.final.open.map((d) => d.reason), ['final re-review not run: agents unavailable']);
});

test('supervised, no hooks: the final fix dies with a dead probe: no verify agent, verify null', async () => {
  const script = {
    ...cleanScript(),
    'final review sp': [{ findings: [finding('bug')], cannot_verify: [], head: H('T5-h') }],
    ...dies('final fix'),
  };
  const { result, calls } = await run(supervised(), script);
  assertUnavailable(result, calls, 'final fix', 15);
  assert.ok(!labels(calls).includes('verify'), labels(calls).join(', '));
  assert.equal(result.verify, null);
  assert.equal(result.final.verify, undefined);
  assert.deepEqual(result.final.open.map((d) => d.reason), ['final fix not run: agents unavailable']);
});

test('a repair window with a probe: the re-review is not refused (reserve 7)', async () => {
  // pre-flight, 10 task agents, integrate, 3 lenses, final fix, verify: 17
  // before the repair; exactly the reserve is left.
  const m = manifest({ limits: { review_rounds: 5, max_parallel_lanes: 3, max_agents: 17 + 7 } });
  const script = {
    ...cleanScript(),
    'final review sp': [{ findings: [finding('bug')], cannot_verify: [], head: H('T5-h') }],
    'final fix': [fixed(H('f1'))],
    // The repair needs its retry; the verify of its head dies with a live
    // probe (3 agents), and the re-review needs its retry too.
    verify: [verified(H('f1'), 1), null],
    'verify retry': [null],
    [PROBE]: [{ ok: true }],
    'verify repair 1': [null],
    'verify repair 1 retry': [{ status: 'done', head: H('r1'), tests: 'focused: pass', notes: '' }],
    'final re-review': [null],
    'final re-review retry': [resolved(H('r1'))],
  };
  const { result, calls } = await run(m, script);
  assert.equal(result.status, 'complete', JSON.stringify(result.reason));
  assert.ok(labels(calls).includes('final re-review retry'));
  assert.equal(result.agents_spawned, 24);
  assert.equal(result.agents_unavailable, undefined);
  assert.equal(result.final.repairs.length, 1);
});

test('a live probe: the run goes on as today, adjudicated, and the field is absent', async () => {
  const script = {
    ...cleanScript(),
    'T2 implement': [null, done('T2-b', H('T2-h'))],
    'T2 implement retry': [null],
    [PROBE]: [{ ok: true }],
    'T2 adjudicate': [{ outcome: 'answer', text: 'Ruling: retry as planned - a transient death - low' }],
  };
  const { result, calls } = await run(manifest(), script);
  assert.equal(result.status, 'complete', JSON.stringify(result.reason));
  assert.equal(result.agents_unavailable, undefined);
  assert.equal(labels(calls).filter((l) => l === PROBE).length, 1);
  assert.ok(labels(calls).includes('T2 adjudicate'));
  assert.equal(result.tasks.T2.status, 'done');
});

test('adjudicate reads the refusal sentinel as refused: no ruling, no adjudicator_stop', async () => {
  const io = (r) => ({ log: () => {}, agent: async () => r });
  const ctx = { kind: 'blocked', task: task('T2'), where: { dir: '/work/wt/lane-alpha', branch: 'b', lane: 'alpha' },
    details: 'stuck', findings: [] };
  const m = manifest();
  assert.deepEqual(await adjudicate(m, ctx, io({ __budget: true, __unavailable: true })),
    { outcome: 'stop', refused: true, text: 'agents unavailable: T2 adjudicate was not run' });
  assert.deepEqual(await adjudicate(m, ctx, io({ __budget: true })),
    { outcome: 'stop', refused: true, text: 'budget exhausted: T2 adjudicate was not run' });

  // In a run: T2's implement is blocked and its adjudicate pair dies with the
  // probe; the task records no ruling and is not stopped as plan_broken.
  const stuck = { status: 'blocked', head: H('T1-h'), tests: '', notes: 'stuck' };
  const script = { ...cleanScript(), 'T2 implement': [stuck], ...dies('T2 adjudicate') };
  const { result, calls } = await run(manifest(), script, { 'T4 implement': 30 });
  assert.equal(result.reason, 'agents_unavailable');
  assert.equal(result.agents_unavailable.trigger, 'T2 adjudicate');
  assert.equal(labels(calls).filter((l) => / adjudicate( retry)?$/.test(l)).length, 2);
  assert.equal(result.tasks.T2.status, 'blocked');
  assert.equal(result.tasks.T2.notes, 'agents unavailable: T2 adjudicate was not run');
  assert.ok(!result.stopped_lanes.some((s) => /adjudicator_stop/.test(s.reason)), JSON.stringify(result.stopped_lanes));
  assert.deepEqual(result.stopped_lanes.find((s) => s.lane === 'alpha').reason, 'agents unavailable: T2 adjudicate was not run');
});

test('a repair refused under the latch has status unavailable', async () => {
  const m = manifest();
  const script = {
    ...cleanScript(),
    'final review sp': [{ findings: [finding('bug')], cannot_verify: [], head: H('T5-h') }],
    'final fix': [fixed(H('f1'))],
    verify: [verified(H('f1'), 1)],
    ...dies('verify repair 1'),
  };
  const { result, calls } = await run(m, script);
  assertUnavailable(result, calls, 'verify repair 1', 17);
  assert.deepEqual(result.final.repairs.map((r) => r.status), ['unavailable']);
  assert.ok(!labels(calls).includes('final re-review'), labels(calls).join(', '));
});
