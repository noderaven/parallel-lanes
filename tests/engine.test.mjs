import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadHelpers } from './harness.mjs';

const {
  runTask, runLane, runLanes,
  implementPrompt, reviewPrompt, fixPrompt, reReviewPrompt, ledgerCommand,
} = await loadHelpers([
  'runTask', 'runLane', 'runLanes',
  'implementPrompt', 'reviewPrompt', 'fixPrompt', 'reReviewPrompt', 'ledgerCommand',
]);

function task(id, extra = {}) {
  return { id, title: `Task ${id}`, files: [`src/${id}.js`], tier: 'standard', security: false, ...extra };
}

function manifest(overrides = {}) {
  return {
    version: 1,
    run_id: 'run-1',
    plan: '/work/my plan.md',
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
    commands: { setup: ['npm ci'], test: ['npm test'], lint: [], build: [] },
    prelude: [],
    lanes: [
      { id: 'alpha', name: 'Lane alpha', tasks: [task('T2'), task('T3')] },
      { id: 'beta', name: 'Lane beta', tasks: [task('T4')] },
    ],
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

const WHERE = { dir: '/work/wt/lane-alpha', branch: 'pl-run-1-alpha', lane: 'alpha' };

const done = (base, head) => ({ status: 'done', base, head, tests: 'npm test: pass', notes: '' });
const blocked = (base, notes = 'stuck') => ({ status: 'blocked', base, head: base, tests: '', notes });
const approve = (cannot = []) => ({ verdict: 'approve', findings: [], cannot_verify: cannot });
const finding = (issue) => ({ severity: 'important', file: 'src/a.js', line: 3, issue, fix: 'fix it' });
const changes = (issue = 'bug') => ({ verdict: 'changes', findings: [finding(issue)], cannot_verify: [] });

// Stub agent driven by a script of per-label result queues. Records every
// call; an unscripted label throws so tests see unexpected calls.
function stub(script, { delay = 0 } = {}) {
  const calls = [];
  const logs = [];
  let inFlight = 0;
  const stats = { maxInFlight: 0 };
  const agent = async (prompt, opts) => {
    calls.push({ prompt, ...opts });
    inFlight += 1;
    stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, delay));
      const queue = script[opts.label];
      if (!queue || queue.length === 0) throw new Error(`unscripted agent call: ${opts.label}`);
      return queue.shift();
    } finally {
      inFlight -= 1;
    }
  };
  return { io: { agent, log: (msg) => logs.push(msg) }, calls, logs, stats };
}

const labels = (calls) => calls.map((c) => c.label);

test('approve the first time: implement then review, no fix rounds', async () => {
  const m = manifest();
  const s = stub({ 'T2 implement': [done('b0', 'h1')], 'T2 review': [approve()] });
  const r = await runTask(m, task('T2'), WHERE, 'b0', s.io);
  assert.deepEqual(labels(s.calls), ['T2 implement', 'T2 review']);
  assert.equal(r.task, 'T2');
  assert.equal(r.status, 'done');
  assert.equal(r.base, 'b0');
  assert.equal(r.head, 'h1');
  assert.equal(r.rounds, 0);
  assert.equal(r.tier_used, 'standard');
  for (const c of s.calls) assert.equal(c.phase, 'Lane alpha');
  assert.equal(s.calls[0].model, 'opus');
  assert.equal(s.calls[0].effort, 'high');
  assert.deepEqual(s.calls[0].schema.required.slice().sort(), ['head', 'notes', 'status', 'tests']);
  assert.deepEqual(s.calls[1].schema.required.slice().sort(), ['cannot_verify', 'findings', 'verdict']);
  assert.ok(s.calls[1].prompt.includes('b0') && s.calls[1].prompt.includes('h1'));
});

test('changes then approve after 2 rounds: fix and re-review on the fix range', async () => {
  const m = manifest();
  const s = stub({
    'T2 implement': [done('b0', 'h1')],
    'T2 review': [changes('first')],
    'T2 fix 1': [done('h1', 'h2')],
    'T2 re-review 1': [changes('second')],
    'T2 fix 2': [done('h2', 'h3')],
    'T2 re-review 2': [approve()],
  });
  const r = await runTask(m, task('T2'), WHERE, 'b0', s.io);
  assert.deepEqual(labels(s.calls), [
    'T2 implement', 'T2 review', 'T2 fix 1', 'T2 re-review 1', 'T2 fix 2', 'T2 re-review 2',
  ]);
  assert.equal(r.status, 'done');
  assert.equal(r.rounds, 2);
  assert.equal(r.base, 'b0');
  assert.equal(r.head, 'h3');
  const fix1 = s.calls[2].prompt;
  assert.ok(fix1.includes('first'), 'fix 1 gets the review findings');
  const rr1 = s.calls[3].prompt;
  assert.ok(rr1.includes('h1') && rr1.includes('h2'), 're-review 1 covers h1..h2');
  assert.ok(rr1.includes('first'), 're-review 1 verifies the findings it was given');
  assert.ok(s.calls[4].prompt.includes('second'), 'fix 2 gets the re-review findings');
  const rr2 = s.calls[5].prompt;
  assert.ok(rr2.includes('h2') && rr2.includes('h3'), 're-review 2 covers h2..h3');
  for (const c of s.calls.filter((x) => /review/.test(x.label))) {
    assert.equal(c.model, 'opus');
    assert.equal(c.effort, 'high');
  }
});

test('5 rounds of changes stop the lane with reason review_rounds', async () => {
  const m = manifest();
  const script = {
    'T2 implement': [done('b0', 'h0')],
    'T2 review': [changes()],
  };
  for (let n = 1; n <= 5; n += 1) {
    script[`T2 fix ${n}`] = [done(`h${n - 1}`, `h${n}`)];
    script[`T2 re-review ${n}`] = [changes()];
  }
  const s = stub(script);
  const r = await runLane(m, m.lanes[0], 'b0', s.io);
  assert.equal(r.lane, 'alpha');
  assert.equal(r.stopped, 'review_rounds');
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].status, 'blocked');
  assert.equal(r.results[0].rounds, 5);
  assert.ok(!labels(s.calls).includes('T2 fix 6'));
  assert.ok(!labels(s.calls).includes('T3 implement'), 'the lane stops at its first non-done task');
});

test('a light task escalates to standard after the second changes verdict', async () => {
  const m = manifest();
  const s = stub({
    'T2 implement': [done('b0', 'h1'), done('h2', 'h3')],
    'T2 review': [changes('first'), approve()],
    'T2 fix 1': [done('h1', 'h2')],
    'T2 re-review 1': [changes('second')],
  });
  const r = await runTask(m, task('T2', { tier: 'light' }), WHERE, 'b0', s.io);
  assert.deepEqual(labels(s.calls), [
    'T2 implement', 'T2 review', 'T2 fix 1', 'T2 re-review 1', 'T2 implement', 'T2 review',
  ]);
  const [impl1, rev1, fix1, , impl2, rev2] = s.calls;
  assert.deepEqual([impl1.model, impl1.effort], ['sonnet', 'medium']);
  assert.deepEqual([fix1.model, fix1.effort], ['sonnet', 'medium']);
  assert.deepEqual([rev1.model, rev1.effort], ['opus', 'high']);
  assert.deepEqual([impl2.model, impl2.effort], ['opus', 'high'], 'next implement call uses opus/high');
  assert.ok(impl2.prompt.includes('second'), 'the escalated implementer sees the open findings');
  assert.ok(rev2.prompt.includes('b0') && rev2.prompt.includes('h3'), 'the full task range is reviewed again');
  assert.equal(r.status, 'done');
  assert.equal(r.tier_used, 'standard');
  assert.equal(r.base, 'b0');
  assert.equal(r.head, 'h3');
  assert.equal(r.rounds, 1);
});

test('a light task escalates to standard after a blocked implement', async () => {
  const m = manifest();
  const s = stub({
    'T2 implement': [blocked('b0', 'cannot find the parser'), done('b0', 'h1')],
    'T2 review': [approve()],
  });
  const r = await runTask(m, task('T2', { tier: 'light' }), WHERE, 'b0', s.io);
  assert.deepEqual(labels(s.calls), ['T2 implement', 'T2 implement', 'T2 review']);
  assert.equal(s.calls[0].model, 'sonnet');
  assert.equal(s.calls[1].model, 'opus');
  assert.equal(s.calls[1].effort, 'high');
  assert.ok(s.calls[1].prompt.includes('cannot find the parser'));
  assert.equal(r.status, 'done');
  assert.equal(r.tier_used, 'standard');
});

for (const [name, fixResult] of [['reports blocked', blocked('h1', 'fix stuck')], ['returns null', null]]) {
  test(`a light task escalates to standard when its fix round ${name}`, async () => {
    const m = manifest();
    const s = stub({
      'T2 implement': [done('b0', 'h1'), done('h1', 'h2')],
      'T2 review': [changes('first'), approve()],
      'T2 fix 1': [fixResult],
    });
    const r = await runTask(m, task('T2', { tier: 'light' }), WHERE, 'b0', s.io);
    assert.deepEqual(labels(s.calls), ['T2 implement', 'T2 review', 'T2 fix 1', 'T2 implement', 'T2 review']);
    const [, , fix1, impl2, rev2] = s.calls;
    assert.deepEqual([fix1.model, fix1.effort], ['sonnet', 'medium']);
    assert.deepEqual([impl2.model, impl2.effort], ['opus', 'high'], 'next implement call uses opus/high');
    assert.ok(impl2.prompt.includes('first'), 'the escalated implementer sees the open findings');
    assert.ok(rev2.prompt.includes('b0') && rev2.prompt.includes('h2'), 'the full task range is reviewed again');
    assert.equal(r.status, 'done');
    assert.equal(r.tier_used, 'standard');
    assert.equal(r.base, 'b0');
    assert.equal(r.head, 'h2');
  });
}

test('a standard task does not escalate; a blocked implement blocks the task', async () => {
  const m = manifest();
  const s = stub({ 'T2 implement': [blocked('b0', 'contract change needed')] });
  const r = await runTask(m, task('T2'), WHERE, 'b0', s.io);
  assert.deepEqual(labels(s.calls), ['T2 implement']);
  assert.equal(r.status, 'blocked');
  assert.ok(r.notes.includes('contract change needed'));
});

test('a null agent result counts as blocked, never as approved', async () => {
  const m = manifest();
  for (const script of [
    { 'T2 implement': [null] },
    { 'T2 implement': [done('b0', 'h1')], 'T2 review': [null] },
    { 'T2 implement': [done('b0', 'h1')], 'T2 review': [changes()], 'T2 fix 1': [null] },
    {
      'T2 implement': [done('b0', 'h1')],
      'T2 review': [changes()],
      'T2 fix 1': [done('h1', 'h2')],
      'T2 re-review 1': [null],
    },
  ]) {
    const s = stub(script);
    const r = await runTask(m, task('T2'), WHERE, 'b0', s.io);
    assert.equal(r.status, 'blocked', JSON.stringify(Object.keys(script)));
    assert.match(r.notes, /no result/);
  }
});

test('a light task whose escalated implement also returns null is blocked', async () => {
  const m = manifest();
  const s = stub({ 'T2 implement': [null, null] });
  const r = await runTask(m, task('T2', { tier: 'light' }), WHERE, 'b0', s.io);
  assert.equal(r.status, 'blocked');
  assert.equal(r.tier_used, 'standard');
  assert.equal(s.calls.length, 2);
});

test('an implement that reports done without commits is blocked before review', async () => {
  const m = manifest();
  const s = stub({ 'T2 implement': [done('b0', 'b0')] });
  const r = await runTask(m, task('T2'), WHERE, 'b0', s.io);
  assert.equal(r.status, 'blocked');
  assert.deepEqual(labels(s.calls), ['T2 implement']);
});

test('one blocked lane stops while another lane finishes', async () => {
  const m = manifest();
  const s = stub({
    'T2 implement': [blocked('b0')],
    'T4 implement': [done('c0', 'c1')],
    'T4 review': [approve()],
  });
  const results = await runLanes(m, m.lanes, 'b0', s.io);
  assert.equal(results.length, 2);
  const [alpha, beta] = results;
  assert.equal(alpha.lane, 'alpha');
  assert.ok(alpha.stopped);
  assert.equal(alpha.results.length, 1);
  assert.ok(!labels(s.calls).includes('T3 implement'));
  assert.equal(beta.lane, 'beta');
  assert.equal(beta.stopped, null);
  assert.equal(beta.results[0].status, 'done');
  const t4 = s.calls.find((c) => c.label === 'T4 implement');
  assert.equal(t4.phase, 'Lane beta');
  assert.ok(t4.prompt.includes('/work/wt/lane-beta'), 'lane worktree path');
  assert.ok(t4.prompt.includes('pl-run-1-beta'), 'lane branch');
});

test('never more than max_parallel_lanes lanes in flight', async () => {
  const lanes = [];
  const script = {};
  for (let i = 1; i <= 5; i += 1) {
    const id = `L${i}`;
    lanes.push({ id: `lane${i}`, name: `Lane ${i}`, tasks: [task(`${id}a`), task(`${id}b`)] });
    for (const t of [`${id}a`, `${id}b`]) {
      script[`${t} implement`] = [done(`${t}-base`, `${t}-head`)];
      script[`${t} review`] = [approve()];
    }
  }
  const m = manifest({ lanes, limits: { review_rounds: 5, max_parallel_lanes: 2 } });
  const s = stub(script, { delay: 5 });
  const results = await runLanes(m, lanes, 'b0', s.io);
  assert.equal(s.stats.maxInFlight, 2);
  assert.deepEqual(results.map((r) => r.lane), lanes.map((l) => l.id), 'results in lane order');
  assert.ok(results.every((r) => r.stopped === null && r.results.length === 2));
});

test('prelude and join tasks use their phase and ledger lane', async () => {
  const m = manifest();
  for (const [lane, phaseName] of [['prelude', 'Prelude'], ['join', 'Join']]) {
    const s = stub({ 'T9 implement': [done('b0', 'h1')], 'T9 review': [approve()] });
    const where = { dir: '/work/repo', branch: 'pl/run-1', lane };
    await runTask(m, task('T9'), where, 'b0', s.io);
    for (const c of s.calls) {
      assert.equal(c.phase, phaseName);
      assert.ok(c.prompt.includes(`append '/work/ledger' '${lane}'`), c.prompt);
    }
  }
});

function allPrompts(m) {
  const t = task('T2');
  const fs = [finding('the bug')];
  return {
    implement: implementPrompt(m, t, WHERE, 'b0'),
    review: reviewPrompt(m, t, WHERE, 'b0', 'h1'),
    fix: fixPrompt(m, t, WHERE, fs, done('b0', 'h1'), 'h1'),
    reReview: reReviewPrompt(m, t, WHERE, 'h1', 'h2', fs),
  };
}

test('prompts name the superpowers files when sp_dir is set', () => {
  const p = allPrompts(manifest());
  const sdd = '/sp/skills/subagent-driven-development';
  assert.ok(p.implement.includes(`${sdd}/implementer-prompt.md`));
  assert.ok(p.fix.includes(`${sdd}/implementer-prompt.md`));
  assert.ok(p.review.includes(`${sdd}/task-reviewer-prompt.md`));
  assert.ok(p.reReview.includes(`${sdd}/re-review-prompt.md`));
  assert.ok(p.review.includes(`${sdd}/scripts/review-package`));
  assert.ok(p.reReview.includes(`${sdd}/scripts/review-package`));
  for (const text of Object.values(p)) assert.ok(!text.includes('superpowers not found'));
});

test('prompts use the built-in fallback when sp_dir is null', () => {
  const p = allPrompts(manifest({ sp_dir: null }));
  for (const [name, text] of Object.entries(p)) {
    assert.ok(text.includes('Built-in instructions (superpowers not found)'), name);
    assert.ok(!text.includes('implementer-prompt.md') && !text.includes('review-package'), name);
  }
});

test('every prompt carries the shared requirements', () => {
  for (const spDir of ['/sp/skills', null]) {
    const m = manifest({ sp_dir: spDir });
    for (const [name, text] of Object.entries(allPrompts(m))) {
      const where = `${name} (sp_dir ${spDir})`;
      assert.ok(text.includes('COMMIT-RULES: plain ASCII, no trailers'), `${where}: commit_rules`);
      assert.ok(text.includes('/work/my plan.md'), `${where}: plan path`);
      assert.ok(text.includes('/work/spec.md'), `${where}: spec path`);
      assert.ok(
        text.includes("'/skills/parallel-lanes/scripts/task-brief' '/work/my plan.md' 'T2' '/work/ledger/briefs/T2.md'"),
        `${where}: task-brief command`,
      );
      assert.ok(text.includes('/work/wt/lane-alpha'), `${where}: worktree path`);
      assert.ok(text.includes('npm test') && text.includes('npm ci'), `${where}: project commands`);
      assert.ok(text.includes("'/skills/parallel-lanes/scripts/ledger' append '/work/ledger' 'alpha'"), `${where}: ledger command`);
      assert.ok(text.includes('report blocked for any change to a contract another lane consumes'), `${where}: contract rule`);
      assert.ok(text.includes('Ruling: decision - why - cost if wrong'), `${where}: ruling format`);
      assert.ok(/^[\x00-\x7f]*$/.test(text), `${where}: plain ASCII`);
    }
  }
});

test('each prompt names the ledger event its agent records', () => {
  const p = allPrompts(manifest());
  assert.ok(p.implement.includes('"event":"committed"'));
  assert.ok(p.implement.includes('"event":"blocked"'));
  assert.ok(p.fix.includes('"event":"committed"'));
  assert.ok(p.review.includes('"event":"reviewed","rounds":0'));
  assert.ok(p.reReview.includes('"event":"reviewed","rounds":1'));
  for (const name of ['review', 'reReview']) assert.match(p[name], /read-only/);
});

test('ledgerCommand starts in the checkout of the agent that runs it', () => {
  const m = manifest();
  const cmd = ledgerCommand(m, 'alpha', { task: 'T2', event: 'blocked', reason: 'x' }, "/work/it's here");
  assert.equal(cmd, "cd '/work/it'\\''s here' && python3 '/skills/parallel-lanes/scripts/ledger' append " +
    '\'/work/ledger\' \'alpha\' \'{"task":"T2","event":"blocked","reason":"x"}\'');
  for (const dir of [undefined, null, '']) {
    assert.throws(() => ledgerCommand(m, 'alpha', { task: 'T2' }, dir), /checkout/);
  }
});

test('task prompts run provided commands from the task worktree', () => {
  const p = allPrompts(manifest());
  const prefix = "cd '/work/wt/lane-alpha' && ";
  for (const [name, text] of Object.entries(p)) {
    const lines = text.split('\n').filter((l) => /scripts\/(ledger|task-brief|review-package)' /.test(l));
    assert.ok(lines.length > 0, name);
    for (const line of lines) assert.ok(line.trim().startsWith(prefix), `${name}: ${line.trim()}`);
  }
  assert.ok(p.review.includes(`${prefix}mkdir -p '/work/ledger/reviews' && bash `), 'review-package order');
});

test('lane_commands override the project commands for that lane', () => {
  const m = manifest({ lane_commands: { alpha: { test: ['uv run pytest -q'] } } });
  const text = implementPrompt(m, task('T2'), WHERE, 'b0');
  assert.ok(text.includes('uv run pytest -q'));
  assert.ok(!text.includes('npm test'));
  assert.ok(text.includes('npm ci'));
});

test('the script owns the task base: an implementer-reported base is ignored', async () => {
  const m = manifest();
  const s = stub({
    'T2 implement': [{ status: 'done', base: 'agent-base', head: 'h1', tests: 'pass', notes: '' }],
    'T2 review': [approve()],
  });
  const r = await runTask(m, task('T2'), WHERE, 'own-base', s.io);
  assert.equal(r.base, 'own-base');
  assert.equal(r.head, 'h1');
  const [impl, rev] = s.calls;
  assert.ok(impl.prompt.includes('own-base'), 'the implementer is told its base');
  assert.match(impl.prompt, /HEAD may already hold commits from an earlier attempt/);
  assert.ok(rev.prompt.includes('own-base..h1'), 'the review covers the script-owned range');
  assert.ok(!rev.prompt.includes('agent-base'));
});

test('a rerun implementer that keeps commits from an earlier attempt is reviewed from the base', async () => {
  const m = manifest();
  // HEAD already holds h-old from a failed attempt; the agent adds h-new.
  const s = stub({ 'T2 implement': [done('h-old', 'h-new')], 'T2 review': [approve()] });
  await runTask(m, task('T2'), WHERE, 'b0', s.io);
  assert.ok(s.calls[1].prompt.includes('b0..h-new'));
});

test('an implement that reports the base as head is blocked (no new commits)', async () => {
  const m = manifest();
  const s = stub({ 'T2 implement': [done('whatever', 'b0')] });
  const r = await runTask(m, task('T2'), WHERE, 'b0', s.io);
  assert.equal(r.status, 'blocked');
  assert.match(r.notes, /no new commits/);
  assert.deepEqual(labels(s.calls), ['T2 implement']);
});

test('a fix that reports the current head is blocked, never re-reviewed on an empty range', async () => {
  const m = manifest();
  const s = stub({
    'T2 implement': [done('b0', 'h1')],
    'T2 review': [changes()],
    'T2 fix 1': [done('h0', 'h1')],
  });
  const r = await runTask(m, task('T2'), WHERE, 'b0', s.io);
  assert.equal(r.status, 'blocked');
  assert.match(r.notes, /no new commits/);
  assert.deepEqual(labels(s.calls), ['T2 implement', 'T2 review', 'T2 fix 1']);
  assert.ok(s.calls[2].prompt.includes('h1'), 'the fix agent is told the current head');
});

test('lane tasks chain bases: each task starts at the previous task head', async () => {
  const m = manifest();
  const s = stub({
    'T2 implement': [done('x', 'h2')],
    'T2 review': [approve()],
    'T3 implement': [done('y', 'h3')],
    'T3 review': [approve()],
  });
  const r = await runLane(m, m.lanes[0], 'tip', s.io);
  assert.equal(r.stopped, null);
  assert.equal(r.head, 'h3');
  const prompt = (label) => s.calls.find((c) => c.label === label).prompt;
  assert.ok(prompt('T2 review').includes('tip..h2'));
  assert.ok(prompt('T3 implement').includes('h2'));
  assert.ok(prompt('T3 review').includes('h2..h3'));
});

test('implement and fix prompts always regenerate the task brief', () => {
  const p = allPrompts(manifest());
  for (const name of ['implement', 'fix']) {
    assert.match(p[name], /overwrites any older copy/, name);
    assert.ok(!p[name].includes('If it does not exist'), name);
  }
});

test('a user note for a task reaches only that task\'s prompts', () => {
  const m = manifest({ notes: { T2: 'USER-ANSWER: use the v2 endpoint' } });
  for (const [name, text] of Object.entries(allPrompts(m))) {
    assert.ok(text.includes('USER-ANSWER: use the v2 endpoint'), name);
  }
  const other = implementPrompt(m, task('T3'), WHERE, 'b0');
  assert.ok(!other.includes('USER-ANSWER'));
});
