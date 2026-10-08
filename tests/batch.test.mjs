import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadHelpers } from './harness.mjs';

const { runLane, implementPrompt, reviewPrompt, fixPrompt, reReviewPrompt } = await loadHelpers([
  'runLane', 'implementPrompt', 'reviewPrompt', 'fixPrompt', 'reReviewPrompt',
]);

function task(id, extra = {}) {
  return { id, title: `Title ${id}`, files: [`src/${id}.js`], tier: 'light', security: false, ...extra };
}

function manifest(tasks, overrides = {}) {
  return {
    version: 1,
    run_id: 'run-1',
    plan: '/work/plan.md',
    spec: '/work/spec.md',
    commit_rules: 'COMMIT-RULES: plain ASCII, no trailers',
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
    prelude: [],
    lanes: [{ id: 'alpha', name: 'Lane alpha', tasks }],
    join: [],
    hooks: {},
    limits: { review_rounds: 5, max_parallel_lanes: 3 },
    dry_run: false,
    done: [],
    reviewed: [],
    sp_dir: '/sp/skills',
    skill_dir: '/skills/parallel-lanes',
    ...overrides,
  };
}

const WHERE = { dir: '/work/wt/lane-alpha', branch: 'pl-run-1-alpha', lane: 'alpha', sync: 'pl/run-1' };

const done = (head, changed = undefined) => ({
  status: 'done', head, tests: 'npm test: pass', notes: '',
  ...(changed === undefined ? {} : { changed_lines: changed }),
});
const blocked = (head, notes = 'stuck') => ({ status: 'blocked', head, tests: '', notes });
const approve = () => ({ verdict: 'approve', findings: [], cannot_verify: [] });
const changes = (issue) => ({
  verdict: 'changes',
  findings: [{ severity: 'important', file: 'src/a.js', line: 3, issue, fix: 'fix it' }],
  cannot_verify: [],
});
const ruled = (outcome, text, stopCondition = null) =>
  ({ outcome, text, ...(stopCondition ? { stop_condition: stopCondition } : {}) });

function stub(script) {
  const calls = [];
  const logs = [];
  const agent = async (prompt, opts) => {
    calls.push({ prompt, ...opts });
    const queue = script[opts.label];
    if (!queue || queue.length === 0) throw new Error(`unscripted agent call: ${opts.label}`);
    return queue.shift();
  };
  return { io: { agent, log: (msg) => logs.push(msg) }, calls, logs };
}

const labels = (calls) => calls.map((c) => c.label);
const ledgerEntry = (id, event, extra) => JSON.stringify({ task: id, event, ...extra });
const finishTasks = "--task 'T2' --task 'T3'";
const blockedEntry = (id) => ledgerEntry(id, 'blocked', { reason: '<reason>' });
// The approval command a reviewer runs per task (scripts/ledger reviewed).
const reviewedEntry = (id, rounds) => `scripts/ledger' reviewed '/work/ledger' 'alpha' '${id}' ${rounds} `;

test('two batched tasks run as one implementer and one review, with a result for each', async () => {
  const m = manifest([task('T2', { batch: 'x' }), task('T3', { batch: 'x' })]);
  const s = stub({ 'T2-T3 implement': [done('h1', 40)], 'T2-T3 review': [approve()] });
  const r = await runLane(m, m.lanes[0], 'b0', s.io);
  assert.deepEqual(labels(s.calls), ['T2-T3 implement', 'T2-T3 review']);
  const [impl, rev] = s.calls;
  assert.deepEqual([impl.model, impl.effort], ['sonnet', 'high']);
  assert.deepEqual([rev.model, rev.effort], ['opus', 'medium'], 'review effort from the batch changed_lines');
  for (const id of ['T2', 'T3']) {
    assert.ok(impl.prompt.includes(`/work/ledger/briefs/${id}.md`), `${id} brief file`);
    assert.ok(impl.prompt.includes(`--brief '${id}' '/work/ledger/briefs/${id}.md'`), `${id} brief command`);
    assert.ok(impl.prompt.includes(`Title ${id}`), `${id} title`);
    assert.ok(impl.prompt.includes(finishTasks), `${id} committed via finish-task`);
    assert.ok(impl.prompt.includes(blockedEntry(id)), `${id} blocked command`);
    assert.ok(rev.prompt.includes(`/work/ledger/briefs/${id}.md`), `${id} brief for the reviewer`);
    assert.ok(rev.prompt.includes(reviewedEntry(id, 0)), `${id} reviewed command`);
  }
  assert.ok(rev.prompt.includes('b0..h1'), 'one review over the combined range');
  assert.equal(r.stopped, null);
  assert.equal(r.head, 'h1');
  assert.deepEqual(r.results.map((x) => x.task), ['T2', 'T3']);
  for (const x of r.results) {
    assert.equal(x.status, 'done');
    assert.equal(x.base, 'b0');
    assert.equal(x.head, 'h1');
    assert.equal(x.tier_used, 'light');
    assert.equal(x.batch, 'T2-T3');
  }
});

test('a batch fix round and re-review cover every task of the batch', async () => {
  const m = manifest([task('T2', { batch: 'x' }), task('T3', { batch: 'x' })]);
  const s = stub({
    'T2-T3 implement': [done('h1', 10)],
    'T2-T3 review': [changes('FIX-ME')],
    'T2-T3 fix 1': [done('h2', 5)],
    'T2-T3 re-review 1': [approve()],
  });
  const r = await runLane(m, m.lanes[0], 'b0', s.io);
  assert.deepEqual(labels(s.calls), ['T2-T3 implement', 'T2-T3 review', 'T2-T3 fix 1', 'T2-T3 re-review 1']);
  const [, , fix, rr] = s.calls;
  assert.deepEqual([fix.model, fix.effort], ['sonnet', 'high']);
  assert.ok(fix.prompt.includes('FIX-ME'));
  for (const id of ['T2', 'T3']) {
    assert.ok(fix.prompt.includes(finishTasks), `${id} committed via finish-task in the fix`);
    assert.ok(rr.prompt.includes(reviewedEntry(id, 1)), `${id} reviewed command in the re-review`);
  }
  assert.ok(rr.prompt.includes('h1..h2'));
  assert.deepEqual(r.results.map((x) => [x.task, x.status, x.base, x.head, x.rounds]),
    [['T2', 'done', 'b0', 'h2', 1], ['T3', 'done', 'b0', 'h2', 1]]);
});

test('a batch escalates like a light task: the second changes verdict reruns implement at standard', async () => {
  const m = manifest([task('T2', { batch: 'x' }), task('T3', { batch: 'x' })]);
  const s = stub({
    'T2-T3 implement': [done('h1'), done('h3')],
    'T2-T3 review': [changes('first'), approve()],
    'T2-T3 fix 1': [done('h2')],
    'T2-T3 re-review 1': [changes('second')],
  });
  const r = await runLane(m, m.lanes[0], 'b0', s.io);
  assert.deepEqual(labels(s.calls), [
    'T2-T3 implement', 'T2-T3 review', 'T2-T3 fix 1', 'T2-T3 re-review 1', 'T2-T3 implement', 'T2-T3 review',
  ]);
  assert.deepEqual([s.calls[4].model, s.calls[4].effort], ['opus', 'high']);
  assert.deepEqual(r.results.map((x) => x.tier_used), ['standard', 'standard']);
});

test('a batch key that recurs after another task forms two batches', async () => {
  const m = manifest([
    task('T1', { batch: 'x' }), task('T2', { batch: 'x' }), task('T3'),
    task('T4', { batch: 'x' }), task('T5', { batch: 'x' }), task('T6', { batch: 'y' }),
  ]);
  const s = stub({
    'T1-T2 implement': [done('h2')], 'T1-T2 review': [approve()],
    'T3 implement': [done('h3')], 'T3 review': [approve()],
    'T4-T5 implement': [done('h5')], 'T4-T5 review': [approve()],
    'T6 implement': [done('h6')], 'T6 review': [approve()],
  });
  const r = await runLane(m, m.lanes[0], 'b0', s.io);
  assert.deepEqual(labels(s.calls), [
    'T1-T2 implement', 'T1-T2 review', 'T3 implement', 'T3 review',
    'T4-T5 implement', 'T4-T5 review', 'T6 implement', 'T6 review',
  ]);
  assert.ok(s.calls[2].prompt.includes('Task base: h2'), 'the next task starts at the batch head');
  assert.ok(s.calls[4].prompt.includes('Task base: h3'));
  assert.deepEqual(r.results.map((x) => [x.task, x.base, x.head]), [
    ['T1', 'b0', 'h2'], ['T2', 'b0', 'h2'], ['T3', 'h2', 'h3'],
    ['T4', 'h3', 'h5'], ['T5', 'h3', 'h5'], ['T6', 'h5', 'h6'],
  ]);
  assert.equal(r.results[2].batch, undefined, 'a lone task is not a batch');
  assert.equal(r.results[5].batch, undefined, 'a batch of one is a plain task');
});

test('a batch with one task already done and reviewed runs the other task alone', async () => {
  const m = manifest([task('T2', { batch: 'x' }), task('T3', { batch: 'x' })], {
    done: ['T2'], reviewed: ['T2'], backfill: { T2: { base: 'b0', head: 'h2' } },
  });
  const s = stub({ 'T3 implement': [done('h3')], 'T3 review': [approve()] });
  const r = await runLane(m, m.lanes[0], 'b0', s.io);
  assert.deepEqual(labels(s.calls), ['T3 implement', 'T3 review']);
  assert.ok(s.calls[0].prompt.includes('Task base: h2'));
  assert.deepEqual(r.results.map((x) => [x.task, x.status]), [['T2', 'skipped'], ['T3', 'done']]);
});

test('a batch with one task done but not reviewed reviews it alone, then runs the other alone', async () => {
  const m = manifest([task('T2', { batch: 'x' }), task('T3', { batch: 'x' })], {
    done: ['T2'], backfill: { T2: { base: 'b0', head: 'h2' } },
  });
  const s = stub({
    'T2 review': [approve()],
    'T3 implement': [done('h3')], 'T3 review': [approve()],
  });
  const r = await runLane(m, m.lanes[0], 'b0', s.io);
  assert.deepEqual(labels(s.calls), ['T2 review', 'T3 implement', 'T3 review']);
  assert.deepEqual(r.results.map((x) => [x.task, x.status, x.head]), [['T2', 'done', 'h2'], ['T3', 'done', 'h3']]);
});

test('a resumed batch with identical backfill ranges gets one combined review', async () => {
  const range = { base: 'b0', head: 'h3' };
  const m = manifest([task('T2', { batch: 'x' }), task('T3', { batch: 'x' })], {
    done: ['T2', 'T3'], backfill: { T2: range, T3: { ...range } },
  });
  const s = stub({ 'T2-T3 review': [approve()] });
  const r = await runLane(m, m.lanes[0], 'b0', s.io);
  assert.deepEqual(labels(s.calls), ['T2-T3 review']);
  assert.ok(s.calls[0].prompt.includes('b0..h3'));
  assert.equal(s.calls[0].effort, 'high', 'a resumed batch has no changed_lines count');
  for (const id of ['T2', 'T3']) assert.ok(s.calls[0].prompt.includes(reviewedEntry(id, 0)), id);
  assert.deepEqual(r.results.map((x) => [x.task, x.status, x.base, x.head]),
    [['T2', 'done', 'b0', 'h3'], ['T3', 'done', 'b0', 'h3']]);
});

test('resumed batched tasks with different backfill ranges are reviewed one by one', async () => {
  const m = manifest([task('T2', { batch: 'x' }), task('T3', { batch: 'x' })], {
    done: ['T2', 'T3'], backfill: { T2: { base: 'b0', head: 'h2' }, T3: { base: 'h2', head: 'h3' } },
  });
  const s = stub({ 'T2 review': [approve()], 'T3 review': [approve()] });
  const r = await runLane(m, m.lanes[0], 'b0', s.io);
  assert.deepEqual(labels(s.calls), ['T2 review', 'T3 review']);
  assert.ok(s.calls[1].prompt.includes('h2..h3'));
  assert.deepEqual(r.results.map((x) => x.status), ['done', 'done']);
});

test('autonomous: a blocked batch escalates, then is adjudicated as its first task', async () => {
  const m = manifest([task('T2', { batch: 'x' }), task('T3', { batch: 'x' }), task('T4')]);
  const s = stub({
    'T2-T3 implement': [blocked('b0', 'light stuck'), blocked('b0', 'BATCH-STUCK'), done('h3')],
    'T2 adjudicate': [ruled('answer', 'ANSWER-B: use v2')],
    'T2-T3 review': [approve()],
    'T4 implement': [done('h4')],
    'T4 review': [approve()],
  });
  const r = await runLane(m, m.lanes[0], 'b0', s.io);
  assert.deepEqual(labels(s.calls), [
    'T2-T3 implement', 'T2-T3 implement', 'T2 adjudicate', 'T2-T3 implement', 'T2-T3 review',
    'T4 implement', 'T4 review',
  ]);
  const adj = s.calls[2];
  assert.ok(adj.prompt.includes('BATCH-STUCK'));
  assert.ok(adj.prompt.includes('T3'), 'the adjudicator is told the batch covers T3');
  assert.ok(s.calls[3].prompt.includes('ANSWER-B: use v2'));
  assert.equal(r.stopped, null);
  assert.deepEqual(r.results.map((x) => [x.task, x.status]), [['T2', 'done'], ['T3', 'done'], ['T4', 'done']]);
  assert.deepEqual(r.results[0].rulings, ['ANSWER-B: use v2']);
});

test('autonomous: a batch parked at the round cap gives the adjudicator every settled command', async () => {
  const m = manifest([task('T2', { batch: 'x' }), task('T3', { batch: 'x' })], {
    limits: { review_rounds: 0, max_parallel_lanes: 3 },
  });
  const s = stub({
    'T2-T3 implement': [done('h1')],
    'T2-T3 review': [changes('OPEN-1')],
    'T2 adjudicate': [{ ...ruled('park', 'PARK-B'), head: 'h1' }],
  });
  const r = await runLane(m, m.lanes[0], 'b0', s.io);
  assert.deepEqual(labels(s.calls), ['T2-T3 implement', 'T2-T3 review', 'T2 adjudicate']);
  for (const outcome of ['park', 'unblock']) {
    assert.ok(s.calls[2].prompt.includes(`'b0' '/work/ledger' 'alpha' ${finishTasks} --settled ${outcome}`), outcome);
  }
  assert.deepEqual(r.results.map((x) => [x.task, x.status, x.head]), [['T2', 'deferred', 'h1'], ['T3', 'deferred', 'h1']]);
});

test('autonomous: an adjudicator stop on a batch stops the lane at its first task', async () => {
  const m = manifest([task('T2', { batch: 'x' }), task('T3', { batch: 'x' }), task('T4')]);
  const s = stub({
    'T2-T3 implement': [blocked('b0', 'a'), blocked('b0', 'b')],
    'T2 adjudicate': [ruled('stop', 'drops a table', 'destructive')],
  });
  const r = await runLane(m, m.lanes[0], 'b0', s.io);
  assert.equal(r.stopped, 'adjudicator_stop: destructive');
  assert.deepEqual(r.results.map((x) => [x.task, x.status]), [['T2', 'blocked']]);
  assert.equal(r.head, 'b0');
  assert.ok(s.logs.some((l) => /stopped at T2 /.test(l)));
});

test('autonomous: an unblocked batch carries its note to the next task', async () => {
  const m = manifest([task('T2', { batch: 'x' }), task('T3', { batch: 'x' }), task('T4')]);
  const s = stub({
    'T2-T3 implement': [blocked('b0', 'a'), blocked('b0', 'b')],
    'T2 adjudicate': [{ ...ruled('unblock', 'UNBLOCK-B: stub it'), head: 'b0' }],
    'T4 implement': [done('h4')],
    'T4 review': [approve()],
  });
  const r = await runLane(m, m.lanes[0], 'b0', s.io);
  assert.ok(s.calls[3].prompt.includes('UNBLOCK-B: stub it'));
  assert.deepEqual(r.results.map((x) => [x.task, x.status, x.head]),
    [['T2', 'deferred', 'b0'], ['T3', 'deferred', 'b0'], ['T4', 'done', 'h4']]);
});

test('supervised: a blocked batch stops the lane at its first task without adjudication', async () => {
  const m = manifest([task('T2', { batch: 'x' }), task('T3', { batch: 'x' }), task('T4')], { autonomy: 'supervised' });
  const s = stub({ 'T2-T3 implement': [blocked('b0', 'a'), blocked('b0', 'STILL-STUCK')] });
  const r = await runLane(m, m.lanes[0], 'b0', s.io);
  assert.deepEqual(labels(s.calls), ['T2-T3 implement', 'T2-T3 implement']);
  assert.ok(r.stopped.includes('STILL-STUCK'));
  assert.deepEqual(r.results.map((x) => [x.task, x.status]), [['T2', 'blocked']]);
  assert.equal(r.head, 'b0');
});

test('batch prompts keep plain ASCII and name the batch report file', () => {
  const m = manifest([]);
  const tasks = [task('T2', { batch: 'x' }), task('T3', { batch: 'x' })];
  const unit = { id: 'T2-T3', title: 'batch', files: [], tier: 'light', security: false, batch: 'x', tasks };
  const f = changes('F').findings;
  for (const mm of [m, { ...m, sp_dir: null }]) {
    const texts = [
      implementPrompt(mm, unit, WHERE, 'b0'),
      reviewPrompt(mm, unit, WHERE, 'b0', 'h1'),
      fixPrompt(mm, unit, WHERE, f, done('h1'), 'h1'),
      reReviewPrompt(mm, unit, WHERE, 'h1', 'h2', f),
    ];
    for (const text of texts) {
      assert.ok(/^[\x00-\x7f]*$/.test(text), 'plain ASCII');
      assert.ok(text.includes('/work/ledger/reports/T2-T3.md'), 'one report file for the batch');
      assert.ok(text.includes('Title T2') && text.includes('Title T3'));
    }
  }
});
