import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadHelpers } from './harness.mjs';

const {
  runTask, runLane, runLanes,
  implementPrompt, reviewPrompt, fixPrompt, reReviewPrompt, ledgerCommand,
  implementSchema, implementResultText, finalFixSchema, reviewSettings,
  finalFixPrompt, agentRules,
} = await loadHelpers([
  'runTask', 'runLane', 'runLanes',
  'implementPrompt', 'reviewPrompt', 'fixPrompt', 'reReviewPrompt', 'ledgerCommand',
  'implementSchema', 'implementResultText', 'finalFixSchema', 'reviewSettings',
  'finalFixPrompt', 'agentRules',
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
  const m = manifest({ autonomy: 'supervised' });
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
  assert.deepEqual([impl1.model, impl1.effort], ['sonnet', 'high']);
  assert.deepEqual([fix1.model, fix1.effort], ['sonnet', 'high']);
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
    assert.deepEqual([fix1.model, fix1.effort], ['sonnet', 'high']);
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
  const m = manifest({ autonomy: 'supervised' });
  const s = stub({ 'T2 implement': [blocked('b0', 'contract change needed')] });
  const r = await runTask(m, task('T2'), WHERE, 'b0', s.io);
  assert.deepEqual(labels(s.calls), ['T2 implement']);
  assert.equal(r.status, 'blocked');
  assert.ok(r.notes.includes('contract change needed'));
});

test('a null agent result counts as blocked, never as approved', async () => {
  const m = manifest({ autonomy: 'supervised' });
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
  const m = manifest({ autonomy: 'supervised' });
  const s = stub({ 'T2 implement': [null, null] });
  const r = await runTask(m, task('T2', { tier: 'light' }), WHERE, 'b0', s.io);
  assert.equal(r.status, 'blocked');
  assert.equal(r.tier_used, 'standard');
  assert.equal(s.calls.length, 2);
});

test('an implement that reports done without commits is blocked before review', async () => {
  const m = manifest({ autonomy: 'supervised' });
  const s = stub({ 'T2 implement': [done('b0', 'b0')] });
  const r = await runTask(m, task('T2'), WHERE, 'b0', s.io);
  assert.equal(r.status, 'blocked');
  assert.deepEqual(labels(s.calls), ['T2 implement']);
});

test('one blocked lane stops while another lane finishes', async () => {
  const m = manifest({ autonomy: 'supervised' });
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
        text.includes("'/skills/parallel-lanes/scripts/start-task' '/work/wt/lane-alpha' '/work/my plan.md' ") &&
          text.includes("--brief 'T2' '/work/ledger/briefs/T2.md'"),
        `${where}: start-task brief command`,
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
  assert.ok(p.implement.includes("scripts/finish-task' "), 'implement records committed via finish-task');
  assert.ok(p.implement.includes('"event":"blocked"'));
  assert.ok(p.fix.includes("scripts/finish-task' "), 'fix records committed via finish-task');
  assert.ok(p.fix.includes('"event":"blocked"'));
  // Approvals go through ledger reviewed, which reads the section hash and
  // the head from the files (review finding 8).
  assert.ok(p.review.includes("scripts/ledger' reviewed '/work/ledger' 'alpha' 'T2' 0 '/work/my plan.md' '/work/wt/lane-alpha'"), p.review);
  assert.ok(p.reReview.includes("scripts/ledger' reviewed '/work/ledger' 'alpha' 'T2' 1 '/work/my plan.md' '/work/wt/lane-alpha'"));
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
    const lines = text.split('\n')
      .filter((l) => /scripts\/(ledger|task-brief|review-package|start-task|finish-task)' /.test(l));
    assert.ok(lines.length > 0, name);
    for (const line of lines) assert.ok(line.trim().startsWith(prefix), `${name}: ${line.trim()}`);
  }
  assert.ok(p.review.includes(`${prefix}python3 '/skills/parallel-lanes/scripts/start-task' `), 'start-task first');
});

test('a reviewer start failure is a start-task finding the fix and retry prompts route to blocked', () => {
  const m = manifest();
  const p = allPrompts(m);
  for (const text of [p.review, p.reReview]) {
    assert.ok(text.includes('stop and return verdict "changes" with one critical finding (file "start-task", line 0)'));
    assert.ok(!text.includes('report blocked with its message'));
  }
  const note = 'A finding with file "start-task" is the reviewer\'s start command failing';
  assert.ok(!p.fix.includes(note), 'no note without a start-task finding');
  const startFinding = { severity: 'critical', file: 'start-task', line: 0, issue: 'exit 1', fix: 'n/a' };
  assert.ok(fixPrompt(m, task('T2'), WHERE, [startFinding], done('b0', 'h1'), 'h1').includes(note));
  const retry = { reason: 'review cap', findings: [startFinding] };
  assert.ok(implementPrompt(m, task('T2'), WHERE, 'b0', retry).includes(note));
  for (const text of Object.values(p)) assert.ok(text.includes('The start command in this prompt regenerates'));
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
  const m = manifest({ autonomy: 'supervised' });
  const s = stub({ 'T2 implement': [done('whatever', 'b0')] });
  const r = await runTask(m, task('T2'), WHERE, 'b0', s.io);
  assert.equal(r.status, 'blocked');
  assert.match(r.notes, /no new commits/);
  assert.deepEqual(labels(s.calls), ['T2 implement']);
});

test('a fix that reports the current head is blocked, never re-reviewed on an empty range', async () => {
  const m = manifest({ autonomy: 'supervised' });
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

// ---- Adjudication (autonomous mode, spec C1) ----

const question = (base, q) => ({ status: 'question', head: base, tests: '', notes: '', question: q });
// head: for park and unblock, the head finish-task --settled printed (the
// adjudicator returns it).
const ruled = (outcome, text, stopCondition, head = null) =>
  ({ outcome, text, ...(stopCondition ? { stop_condition: stopCondition } : {}), ...(head ? { head } : {}) });
const settled = (outcome, text, head) => ruled(outcome, text, undefined, head);

test('autonomous: a blocked implement is adjudicated; an answer reruns implement with it as a note', async () => {
  const m = manifest();
  const s = stub({
    'T2 implement': [blocked('b0', 'which parser?'), done('b0', 'h1')],
    'T2 adjudicate': [ruled('answer', 'ANSWER-1: use the v2 parser')],
    'T2 review': [approve()],
  });
  const r = await runTask(m, task('T2'), WHERE, 'b0', s.io);
  assert.deepEqual(labels(s.calls), ['T2 implement', 'T2 adjudicate', 'T2 implement', 'T2 review']);
  const [, adj, impl2, rev] = s.calls;
  assert.deepEqual([adj.model, adj.effort, adj.phase], ['opus', 'high', 'Lane alpha']);
  assert.match(adj.prompt, /Why you were called: blocked/);
  assert.ok(adj.prompt.includes('which parser?'), 'the blocked reason reaches the adjudicator');
  assert.ok(adj.prompt.includes('/work/ledger/reports/T2.md'), 'the report file reaches the adjudicator');
  assert.ok(adj.prompt.includes('b0'), 'the diff range reaches the adjudicator');
  assert.ok(impl2.prompt.includes('ANSWER-1: use the v2 parser'), 'the answer is the task note');
  assert.ok(rev.prompt.includes('ANSWER-1'), 'the reviewer sees the note too');
  assert.ok(rev.prompt.includes('b0..h1'));
  assert.equal(r.status, 'done');
  assert.equal(r.head, 'h1');
  assert.deepEqual(r.rulings, ['ANSWER-1: use the v2 parser']);
});

test('autonomous: a question is adjudicated; clarify_plan amends the brief for the rerun', async () => {
  const m = manifest();
  const s = stub({
    'T2 implement': [question('b0', 'QUESTION-1: v1 or v2?'), done('b0', 'h1')],
    'T2 adjudicate': [ruled('clarify_plan', 'AMEND-1: the brief means v2')],
    'T2 review': [approve()],
  });
  const r = await runTask(m, task('T2'), WHERE, 'b0', s.io);
  assert.deepEqual(labels(s.calls), ['T2 implement', 'T2 adjudicate', 'T2 implement', 'T2 review']);
  const [impl1, adj, impl2, rev] = s.calls;
  assert.ok(impl1.schema.properties.status.enum.includes('question'));
  assert.match(adj.prompt, /Why you were called: question/);
  assert.ok(adj.prompt.includes('QUESTION-1: v1 or v2?'));
  for (const c of [impl2, rev]) {
    assert.ok(c.prompt.includes('AMEND-1: the brief means v2'), c.label);
    assert.match(c.prompt, /[Aa]mendment to the task brief/, c.label);
  }
  assert.equal(r.status, 'done');
  assert.deepEqual(r.rulings, ['AMEND-1: the brief means v2']);
});

test('autonomous: a light task that blocks escalates to standard before any adjudication', async () => {
  const m = manifest();
  const s = stub({
    'T2 implement': [blocked('b0', 'light stuck'), blocked('b0', 'standard stuck'), done('b0', 'h1')],
    'T2 adjudicate': [ruled('answer', 'ANSWER-2')],
    'T2 review': [approve()],
  });
  const r = await runTask(m, task('T2', { tier: 'light' }), WHERE, 'b0', s.io);
  assert.deepEqual(labels(s.calls),
    ['T2 implement', 'T2 implement', 'T2 adjudicate', 'T2 implement', 'T2 review']);
  assert.deepEqual(s.calls.map((c) => c.model), ['sonnet', 'opus', 'opus', 'opus', 'opus']);
  assert.ok(s.calls[2].prompt.includes('standard stuck'));
  assert.equal(r.status, 'done');
  assert.equal(r.tier_used, 'standard');
});

test('autonomous: a light task question is adjudicated without escalating', async () => {
  const m = manifest();
  const s = stub({
    'T2 implement': [question('b0', 'which file?'), done('b0', 'h1')],
    'T2 adjudicate': [ruled('answer', 'ANSWER-3: src/a.js')],
    'T2 review': [approve()],
  });
  const r = await runTask(m, task('T2', { tier: 'light' }), WHERE, 'b0', s.io);
  assert.deepEqual(labels(s.calls), ['T2 implement', 'T2 adjudicate', 'T2 implement', 'T2 review']);
  assert.equal(s.calls[0].model, 'sonnet');
  assert.equal(s.calls[2].model, 'sonnet', 'the rerun keeps the current tier');
  assert.ok(s.calls[2].prompt.includes('ANSWER-3: src/a.js'));
  assert.equal(r.status, 'done');
  assert.equal(r.tier_used, 'light');
});

test('autonomous: a fix question is adjudicated and the rerun implement sees the open findings', async () => {
  const m = manifest();
  const s = stub({
    'T2 implement': [done('b0', 'h1'), done('h1', 'h2')],
    'T2 review': [changes('FINDING-1'), approve()],
    'T2 fix 1': [question('h1', 'rename or keep?')],
    'T2 adjudicate': [ruled('answer', 'keep the name')],
  });
  const r = await runTask(m, task('T2'), WHERE, 'b0', s.io);
  assert.deepEqual(labels(s.calls),
    ['T2 implement', 'T2 review', 'T2 fix 1', 'T2 adjudicate', 'T2 implement', 'T2 review']);
  const [, , , adj, impl2, rev2] = s.calls;
  assert.match(adj.prompt, /Why you were called: question/);
  assert.ok(adj.prompt.includes('rename or keep?'));
  assert.ok(adj.prompt.includes('FINDING-1'), 'the open findings reach the adjudicator');
  assert.ok(impl2.prompt.includes('FINDING-1') && impl2.prompt.includes('keep the name'));
  assert.ok(rev2.prompt.includes('b0..h2'), 'the whole task range is reviewed again');
  assert.equal(r.status, 'done');
  assert.equal(r.head, 'h2');
});

test('autonomous: a fix that fails at standard is adjudicated as blocked', async () => {
  const m = manifest();
  const s = stub({
    'T2 implement': [done('b0', 'h1')],
    'T2 review': [changes()],
    'T2 fix 1': [blocked('h1', 'FIX-STUCK')],
    'T2 adjudicate': [ruled('stop', 'needs a credential rotation', 'security')],
  });
  const r = await runTask(m, task('T2'), WHERE, 'b0', s.io);
  assert.deepEqual(labels(s.calls), ['T2 implement', 'T2 review', 'T2 fix 1', 'T2 adjudicate']);
  assert.match(s.calls[3].prompt, /Why you were called: blocked/);
  assert.ok(s.calls[3].prompt.includes('FIX-STUCK'));
  assert.equal(r.status, 'blocked');
  assert.equal(r.notes, 'adjudicator_stop: security');
  assert.deepEqual(r.rulings, ['needs a credential rotation']);
});

test('autonomous: a review with no result is adjudicated as blocked; an answer reruns and re-reviews', async () => {
  const m = manifest();
  const s = stub({
    // The rerun may keep the reviewed commits as they are (head unchanged).
    'T2 implement': [done('b0', 'h1'), done('h1', 'h1')],
    'T2 review': [null, approve()],
    'T2 adjudicate': [ruled('answer', 'the work is complete; confirm and return')],
  });
  const r = await runTask(m, task('T2'), WHERE, 'b0', s.io);
  assert.deepEqual(labels(s.calls),
    ['T2 implement', 'T2 review', 'T2 adjudicate', 'T2 implement', 'T2 review']);
  assert.match(s.calls[2].prompt, /Why you were called: blocked/);
  assert.ok(s.calls[2].prompt.includes('no result from T2 review'));
  assert.ok(s.calls[4].prompt.includes('b0..h1'));
  assert.equal(r.status, 'done');
  assert.equal(r.head, 'h1');
});

test('autonomous: the round cap is adjudicated; an answer reruns implement and resets the fix rounds', async () => {
  const m = manifest({ limits: { review_rounds: 1, max_parallel_lanes: 3 } });
  const s = stub({
    'T2 implement': [done('b0', 'h1'), done('h2', 'h3')],
    'T2 review': [changes('CAP-1'), changes('AFTER-1')],
    'T2 fix 1': [done('h1', 'h2'), done('h3', 'h4')],
    'T2 re-review 1': [changes('CAP-2'), approve()],
    'T2 adjudicate': [ruled('answer', 'ANSWER-CAP: drop the cache')],
  });
  const r = await runTask(m, task('T2'), WHERE, 'b0', s.io);
  assert.deepEqual(labels(s.calls), [
    'T2 implement', 'T2 review', 'T2 fix 1', 'T2 re-review 1', 'T2 adjudicate',
    'T2 implement', 'T2 review', 'T2 fix 1', 'T2 re-review 1',
  ]);
  const adj = s.calls[4];
  assert.match(adj.prompt, /Why you were called: round_cap/);
  assert.ok(adj.prompt.includes('CAP-2'), 'the open findings reach the adjudicator');
  assert.ok(adj.prompt.includes('Diff range: b0..h2'));
  for (const outcome of ['park', 'unblock']) {
    assert.ok(adj.prompt.includes("scripts/finish-task' '/work/wt/lane-alpha' 'pl-run-1-alpha' 'b0' '/work/ledger' "
      + `'alpha' --task 'T2' --settled ${outcome}`), `details carry the finish-task --settled command for ${outcome}`);
  }
  assert.ok(adj.prompt.includes("append '/work/ledger' 'alpha'"), 'the ruling ledger command');
  const impl2 = s.calls[5];
  assert.ok(impl2.prompt.includes('CAP-2') && impl2.prompt.includes('ANSWER-CAP: drop the cache'));
  assert.ok(s.calls[6].prompt.includes('b0..h3'));
  assert.equal(r.status, 'done');
  assert.equal(r.rounds, 1);
  assert.equal(r.head, 'h4');
});

test('autonomous: park at the round cap completes the task with the findings deferred', async () => {
  const m = manifest({ limits: { review_rounds: 1, max_parallel_lanes: 3 } });
  const s = stub({
    'T2 implement': [done('b0', 'h1')],
    'T2 review': [changes('OPEN-1')],
    'T2 fix 1': [done('h1', 'h2')],
    'T2 re-review 1': [changes('OPEN-2')],
    'T2 adjudicate': [settled('park', 'PARK-1: cosmetic, defer', 'h2')],
  });
  const r = await runTask(m, task('T2'), WHERE, 'b0', s.io);
  assert.equal(r.status, 'deferred', 'a parked task is deferred, never done (review finding 13)');
  assert.equal(r.base, 'b0');
  assert.equal(r.head, 'h2');
  assert.equal(r.rounds, 1);
  assert.match(r.notes, /deferred, not accepted: parked/);
  assert.match(r.notes, /deferred finding \[important\]: src\/a\.js:3 - OPEN-2/);
  assert.ok(r.notes.includes('PARK-1: cosmetic, defer'));
  assert.deepEqual(r.rulings, ['PARK-1: cosmetic, defer']);
});

test('autonomous: park or unblock with no new commits is deferred at the head the settled command printed', async () => {
  for (const outcome of ['park', 'unblock']) {
    const m = manifest();
    const s = stub({
      'T2 implement': [blocked('b0', 'nothing to do')],
      'T2 adjudicate': [settled(outcome, `${outcome} it`, 'b0')],
    });
    const r = await runTask(m, task('T2'), WHERE, 'b0', s.io);
    assert.equal(r.status, 'deferred', outcome);
    assert.equal(r.base, 'b0', outcome);
    assert.equal(r.head, 'b0', outcome);
  }
});

// Review finding 6: a blocked implementer's partial commits stay with its
// task: the adjudicator sees them and the deferred range ends at the head git
// has, not at the base.
test('autonomous: commits a blocked implementer made stay in the task range when it is parked', async () => {
  const m = manifest();
  const s = stub({
    'T2 implement': [{ status: 'blocked', head: 'partial', tests: '', notes: 'stuck halfway' }],
    'T2 adjudicate': [settled('park', 'park the half', 'partial')],
  });
  const r = await runTask(m, task('T2'), WHERE, 'b0', s.io);
  assert.ok(s.calls[1].prompt.includes('Diff range: b0..partial'), 'the adjudicator sees the partial commits');
  assert.equal(r.status, 'deferred');
  assert.deepEqual([r.base, r.head], ['b0', 'partial']);
});

test('autonomous: a park without the settled head is an invalid ruling and stops the task', async () => {
  const m = manifest();
  const s = stub({
    'T2 implement': [blocked('b0', 'stuck')],
    'T2 adjudicate': [ruled('park', 'park it')],
  });
  const r = await runTask(m, task('T2'), WHERE, 'b0', s.io);
  assert.equal(r.status, 'blocked');
  assert.equal(r.notes, 'adjudicator_stop: plan_broken');
  assert.deepEqual(r.rulings, []);
});

test('autonomous: allow_deferral false refuses park and unblock', async () => {
  const m = manifest({ allow_deferral: false });
  const s = stub({
    'T2 implement': [blocked('b0', 'stuck')],
    'T2 adjudicate': [settled('park', 'park it', 'b0')],
  });
  const r = await runTask(m, task('T2'), WHERE, 'b0', s.io);
  assert.equal(r.status, 'blocked');
  assert.equal(r.notes, 'adjudicator_stop: deferral_not_allowed');
  assert.match(s.calls[1].prompt, /Deferral is not allowed in this run/);
  assert.ok(!s.calls[1].prompt.includes('--settled'));
});

test('autonomous: unblock completes the task and carries its text to the next task as a note', async () => {
  const m = manifest();
  const s = stub({
    'T2 implement': [blocked('b0', 'upstream contract missing')],
    'T2 adjudicate': [settled('unblock', 'UNBLOCK-1: stub the contract as {ok: true}', 'b0')],
    'T3 implement': [done('b0', 'h3')],
    'T3 review': [approve()],
  });
  const r = await runLane(m, m.lanes[0], 'b0', s.io);
  assert.equal(r.stopped, null);
  assert.deepEqual(labels(s.calls), ['T2 implement', 'T2 adjudicate', 'T3 implement', 'T3 review']);
  assert.equal(r.results[0].status, 'deferred');
  assert.equal(r.results[0].head, 'b0');
  assert.ok(r.results[0].notes.includes('UNBLOCK-1'));
  const t3 = s.calls[2].prompt;
  assert.ok(t3.includes('UNBLOCK-1: stub the contract as {ok: true}'), 'the next task gets the note');
  assert.ok(s.calls[3].prompt.includes('b0..h3'), 'the next task base is the unblocked task head');
  assert.equal(r.head, 'h3');
});

test('autonomous: stop ends the lane with adjudicator_stop and its condition', async () => {
  const m = manifest();
  const s = stub({
    'T2 implement': [blocked('b0', 'would drop the prod table')],
    'T2 adjudicate': [ruled('stop', 'irreversible', 'destructive')],
  });
  const r = await runLane(m, m.lanes[0], 'b0', s.io);
  assert.equal(r.stopped, 'adjudicator_stop: destructive');
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].status, 'blocked');
  assert.ok(!labels(s.calls).includes('T3 implement'));
});

test('autonomous: an adjudicator with no result stops the lane as an agent error', async () => {
  const m = manifest();
  const s = stub({ 'T2 implement': [blocked('b0')], 'T2 adjudicate': [null] });
  const r = await runLane(m, m.lanes[0], 'b0', s.io);
  assert.equal(r.stopped, 'no result from T2 adjudicate');
  assert.deepEqual(r.results[0].rulings, []);
  assert.ok(!labels(s.calls).includes('T3 implement'));
});

test('autonomous: an invalid adjudicator result stops the lane, never approves', async () => {
  const m = manifest();
  const s = stub({ 'T2 implement': [blocked('b0')], 'T2 adjudicate': [{ outcome: 'approve', text: 'ok' }] });
  const r = await runLane(m, m.lanes[0], 'b0', s.io);
  assert.equal(r.stopped, 'adjudicator_stop: plan_broken');
  assert.deepEqual(labels(s.calls), ['T2 implement', 'T2 adjudicate']);
});

test('autonomous: at most 2 adjudications per task; a third need stops with adjudication_cap', async () => {
  const m = manifest();
  const s = stub({
    'T2 implement': [blocked('b0', 'one'), blocked('b0', 'two'), blocked('b0', 'three')],
    'T2 adjudicate': [ruled('answer', 'RULING-A'), ruled('clarify_plan', 'RULING-B')],
  });
  const r = await runLane(m, m.lanes[0], 'b0', s.io);
  assert.deepEqual(labels(s.calls), [
    'T2 implement', 'T2 adjudicate', 'T2 implement', 'T2 adjudicate', 'T2 implement',
  ]);
  assert.equal(r.stopped, 'adjudication_cap');
  assert.equal(r.results[0].status, 'blocked');
  assert.deepEqual(r.results[0].rulings, ['RULING-A', 'RULING-B']);
  const third = s.calls[4].prompt;
  assert.ok(third.includes('RULING-A') && third.includes('RULING-B'), 'rulings accumulate for the task');
});

test('a task result lists rulings, empty without adjudication', async () => {
  const m = manifest();
  const s = stub({ 'T2 implement': [done('b0', 'h1')], 'T2 review': [approve()] });
  const r = await runTask(m, task('T2'), WHERE, 'b0', s.io);
  assert.deepEqual(r.rulings, []);
});

test('supervised: a question counts as blocked with the question in the notes, no adjudication', async () => {
  const m = manifest({ autonomy: 'supervised' });
  const s = stub({ 'T2 implement': [question('b0', 'QUESTION-S: v1 or v2?')] });
  const r = await runLane(m, m.lanes[0], 'b0', s.io);
  assert.deepEqual(labels(s.calls), ['T2 implement']);
  assert.equal(r.results[0].status, 'blocked');
  assert.ok(r.results[0].notes.includes('QUESTION-S: v1 or v2?'));
  assert.ok(r.stopped.includes('QUESTION-S'));
  assert.deepEqual(r.results[0].rulings, []);
});

test('supervised: blocked tasks and the round cap stop the lane without adjudication', async () => {
  const m = manifest({ autonomy: 'supervised', limits: { review_rounds: 1, max_parallel_lanes: 3 } });
  const s = stub({
    'T2 implement': [done('b0', 'h1')],
    'T2 review': [changes()],
    'T2 fix 1': [done('h1', 'h2')],
    'T2 re-review 1': [changes()],
  });
  const r = await runLane(m, m.lanes[0], 'b0', s.io);
  assert.equal(r.stopped, 'review_rounds');
  assert.ok(!labels(s.calls).some((l) => l.endsWith('adjudicate')));
});

test('implement schema allows a question without requiring one', () => {
  const sc = implementSchema();
  assert.deepEqual(sc.properties.status.enum, ['done', 'blocked', 'question']);
  assert.equal(sc.properties.question.type, 'string');
  assert.deepEqual(sc.required.slice().sort(), ['head', 'notes', 'status', 'tests']);
});

test('implementResultText: one argument keeps the final-fix wording; task prompts offer the question status', () => {
  const plain = implementResultText('/work/repo');
  assert.ok(plain.includes('status "done" or "blocked"'));
  assert.ok(!plain.includes('"question"'));
  const p = allPrompts(manifest());
  for (const name of ['implement', 'fix']) {
    assert.ok(p[name].includes('"question"'), name);
  }
  assert.ok(!p.implement.includes('report blocked with the question instead'));
});

// ---- Sonnet tiers and review effort (spec D4, D5) ----

const sized = (base, head, lines) => ({ ...done(base, head), changed_lines: lines });

test('a sonnet task escalates to standard after the first changes verdict', async () => {
  const m = manifest();
  const s = stub({
    'T2 implement': [done('b0', 'h1'), done('h1', 'h2')],
    'T2 review': [changes('FIRST-FINDING'), approve()],
  });
  const r = await runTask(m, task('T2', { tier: 'sonnet' }), WHERE, 'b0', s.io);
  assert.deepEqual(labels(s.calls), ['T2 implement', 'T2 review', 'T2 implement', 'T2 review']);
  const [impl1, rev1, impl2, rev2] = s.calls;
  assert.deepEqual([impl1.model, impl1.effort], ['sonnet', 'high']);
  assert.deepEqual([rev1.model, rev1.effort], ['opus', 'high']);
  assert.deepEqual([impl2.model, impl2.effort], ['opus', 'high'], 'next implement call uses opus/high');
  assert.ok(impl2.prompt.includes('FIRST-FINDING'), 'the escalated implementer sees the open findings');
  assert.ok(rev2.prompt.includes('b0..h2'), 'the whole task range is reviewed again');
  assert.equal(r.status, 'done');
  assert.equal(r.tier_used, 'standard');
  assert.equal(r.rounds, 0);
  assert.equal(r.head, 'h2');
  assert.match(r.notes, /escalated to standard/);
});

test('a light task does not escalate on the first changes verdict, only on the second', async () => {
  const m = manifest();
  const s = stub({
    'T2 implement': [done('b0', 'h1')],
    'T2 review': [changes('first')],
    'T2 fix 1': [done('h1', 'h2')],
    'T2 re-review 1': [approve()],
  });
  const r = await runTask(m, task('T2', { tier: 'light' }), WHERE, 'b0', s.io);
  assert.deepEqual(labels(s.calls), ['T2 implement', 'T2 review', 'T2 fix 1', 'T2 re-review 1']);
  assert.deepEqual([s.calls[2].model, s.calls[2].effort], ['sonnet', 'high']);
  assert.equal(r.tier_used, 'light');
});

for (const [name, first] of [['blocked', blocked('b0', 'sonnet stuck')], ['null', null]]) {
  test(`a sonnet task escalates to standard after a ${name} implement`, async () => {
    const m = manifest({ autonomy: 'supervised' });
    const s = stub({ 'T2 implement': [first, done('b0', 'h1')], 'T2 review': [approve()] });
    const r = await runTask(m, task('T2', { tier: 'sonnet' }), WHERE, 'b0', s.io);
    assert.deepEqual(labels(s.calls), ['T2 implement', 'T2 implement', 'T2 review']);
    assert.deepEqual(s.calls.map((c) => c.model), ['sonnet', 'opus', 'opus']);
    assert.equal(r.status, 'done');
    assert.equal(r.tier_used, 'standard');
  });
}

test('autonomous: a sonnet task that blocks escalates to standard before any adjudication', async () => {
  const m = manifest();
  const s = stub({
    'T2 implement': [blocked('b0', 'sonnet stuck'), blocked('b0', 'standard stuck'), done('b0', 'h1')],
    'T2 adjudicate': [ruled('answer', 'ANSWER-S')],
    'T2 review': [approve()],
  });
  const r = await runTask(m, task('T2', { tier: 'sonnet' }), WHERE, 'b0', s.io);
  assert.deepEqual(labels(s.calls),
    ['T2 implement', 'T2 implement', 'T2 adjudicate', 'T2 implement', 'T2 review']);
  assert.deepEqual(s.calls.map((c) => c.model), ['sonnet', 'opus', 'opus', 'opus', 'opus']);
  assert.ok(s.calls[2].prompt.includes('standard stuck'));
  assert.equal(r.status, 'done');
  assert.equal(r.tier_used, 'standard');
});

test('review effort: medium under 60 changed lines, high at 60, for security, or when missing', async () => {
  const cases = [
    [{}, 59, 'medium'],
    [{}, 60, 'high'],
    [{}, 0, 'medium'],
    [{ security: true }, 5, 'high'],
    [{}, undefined, 'high'],
  ];
  for (const [extra, lines, effort] of cases) {
    const m = manifest();
    const impl = lines === undefined ? done('b0', 'h1') : sized('b0', 'h1', lines);
    const s = stub({ 'T2 implement': [impl], 'T2 review': [approve()] });
    await runTask(m, task('T2', extra), WHERE, 'b0', s.io);
    const rev = s.calls[1];
    assert.deepEqual([rev.model, rev.effort], ['opus', effort], JSON.stringify([extra, lines]));
  }
});

test('reviewSettings: opus always; medium only for a known non-security diff under 60 lines', () => {
  assert.deepEqual(reviewSettings(task('T2'), 59), { model: 'opus', effort: 'medium' });
  assert.deepEqual(reviewSettings(task('T2'), 60), { model: 'opus', effort: 'high' });
  assert.deepEqual(reviewSettings(task('T2', { security: true }), 5), { model: 'opus', effort: 'high' });
  for (const bad of [undefined, null, -1, 12.5, '12']) {
    assert.deepEqual(reviewSettings(task('T2'), bad), { model: 'opus', effort: 'high' }, String(bad));
  }
});

test('a re-review takes the fix result changed_lines, not the implement one', async () => {
  for (const [implLines, fixLines, revEffort, reEffort] of [[200, 10, 'high', 'medium'], [10, 100, 'medium', 'high']]) {
    const m = manifest();
    const s = stub({
      'T2 implement': [sized('b0', 'h1', implLines)],
      'T2 review': [changes()],
      'T2 fix 1': [sized('h1', 'h2', fixLines)],
      'T2 re-review 1': [approve()],
    });
    await runTask(m, task('T2'), WHERE, 'b0', s.io);
    assert.deepEqual(labels(s.calls), ['T2 implement', 'T2 review', 'T2 fix 1', 'T2 re-review 1']);
    assert.equal(s.calls[1].effort, revEffort);
    assert.equal(s.calls[3].effort, reEffort);
    assert.equal(s.calls[3].model, 'opus');
  }
});

test('the review after an escalated rerun takes the rerun implement changed_lines', async () => {
  const m = manifest();
  const s = stub({
    'T2 implement': [sized('b0', 'h1', 10), sized('h1', 'h2', 80)],
    'T2 review': [changes(), approve()],
  });
  await runTask(m, task('T2', { tier: 'sonnet' }), WHERE, 'b0', s.io);
  assert.deepEqual(s.calls.map((c) => [c.label, c.model, c.effort]), [
    ['T2 implement', 'sonnet', 'high'],
    ['T2 review', 'opus', 'medium'],
    ['T2 implement', 'opus', 'high'],
    ['T2 review', 'opus', 'high'],
  ]);
});

test('a resumed task without a changed_lines count is reviewed at high effort', async () => {
  const m = manifest();
  const s = stub({ 'T2 review': [approve()] });
  await runTask(m, task('T2'), WHERE, 'b0', s.io, { base: 'b0', head: 'h1' });
  assert.deepEqual([s.calls[0].model, s.calls[0].effort], ['opus', 'high']);
});

test('implement schema offers an optional integer changed_lines', () => {
  const sc = implementSchema();
  assert.equal(sc.properties.changed_lines.type, 'integer');
  assert.ok(!sc.required.includes('changed_lines'));
});

// The subset of JSON schema the result schemas use: required keys present,
// present properties of the declared type.
function schemaErrors(schema, value) {
  const errors = [];
  for (const key of schema.required || []) if (!(key in value)) errors.push(`missing ${key}`);
  const typeOf = (v) => (Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
  for (const [key, v] of Object.entries(value)) {
    const prop = schema.properties[key];
    if (!prop) continue;
    const t = typeOf(v);
    if (!(t === prop.type || (prop.type === 'number' && t === 'integer'))) errors.push(`${key}: ${t}`);
  }
  return errors;
}

test('a final-fix result without changed_lines still validates against finalFixSchema', () => {
  const sc = finalFixSchema();
  assert.equal(sc.properties.changed_lines.type, 'integer');
  assert.ok(!sc.required.includes('changed_lines'));
  const result = { status: 'done', head: 'h9', tests: 'npm test: pass', notes: '', dispositions: [] };
  assert.deepEqual(schemaErrors(sc, result), []);
  assert.deepEqual(schemaErrors(sc, { ...result, changed_lines: 12 }), []);
});

test('implementResultText asks for changed_lines over the agent range; the one-argument form fits the final fix', () => {
  const plain = implementResultText('/work/repo');
  assert.match(plain, /changed_lines/);
  assert.match(plain, /--shortstat/);
  assert.ok(plain.includes("git -C '/work/repo' diff --shortstat <start> HEAD"));
  const p = allPrompts(manifest());
  assert.match(p.implement, /changed_lines/);
  assert.ok(p.implement.includes("scripts/finish-task' '/work/wt/lane-alpha' 'pl-run-1-alpha' 'b0' "),
    'implement counts from the task base');
  assert.ok(p.fix.includes("scripts/finish-task' '/work/wt/lane-alpha' 'pl-run-1-alpha' 'h1' "),
    'a fix counts from the head it builds on');
});

test('implement prompt opens with start-task and syncs when the lane needs it', () => {
  const m = manifest();
  const synced = implementPrompt(m, task('T2'), { ...WHERE, sync: 'pl/run-1' }, 'b0');
  assert.ok(synced.includes(
    "cd '/work/wt/lane-alpha' && python3 '/skills/parallel-lanes/scripts/start-task' '/work/wt/lane-alpha' " +
    "'/work/my plan.md' --artifacts '/work/ledger' --sync 'pl/run-1' --brief 'T2' '/work/ledger/briefs/T2.md'"), synced);
  const plain = implementPrompt(m, task('T2'), WHERE, 'b0');
  assert.ok(plain.includes(
    "cd '/work/wt/lane-alpha' && python3 '/skills/parallel-lanes/scripts/start-task' '/work/wt/lane-alpha' " +
    "'/work/my plan.md' --artifacts '/work/ledger' --brief 'T2' '/work/ledger/briefs/T2.md'"), plain);
  assert.ok(!plain.includes('--sync'));
});

test('review prompts pass the review package to start-task', () => {
  const p = allPrompts(manifest());
  const pkg = (base, head) => "--package '/sp/skills/subagent-driven-development/scripts/review-package' " +
    `'${base}' '${head}' '/work/ledger/reviews/T2-${base}..${head}.diff'`;
  assert.ok(p.review.includes(pkg('b0', 'h1')), p.review);
  assert.ok(p.reReview.includes(pkg('h1', 'h2')), p.reReview);
  for (const name of ['review', 'reReview']) {
    assert.ok(p[name].includes("scripts/start-task' "), name);
    assert.ok(!p[name].includes('mkdir -p'), name);
  }
  for (const name of ['implement', 'fix']) assert.ok(!p[name].includes('--package'), name);
});

test('review prompts without superpowers keep the git log and diff steps', () => {
  const p = allPrompts(manifest({ sp_dir: null }));
  assert.ok(!p.review.includes('--package'));
  assert.ok(!p.reReview.includes('--package'));
  assert.ok(p.review.includes("git -C '/work/wt/lane-alpha' diff 'b0..h1'"));
  assert.ok(p.review.includes("git -C '/work/wt/lane-alpha' log --oneline 'b0..h1'"));
  assert.ok(p.reReview.includes("git -C '/work/wt/lane-alpha' diff 'h1..h2'"));
});

test('implement and fix prompts record commits with finish-task from their start commit', () => {
  const p = allPrompts(manifest());
  const finish = (from) => "cd '/work/wt/lane-alpha' && python3 '/skills/parallel-lanes/scripts/finish-task' " +
    `'/work/wt/lane-alpha' 'pl-run-1-alpha' '${from}' '/work/ledger' 'alpha' --task 'T2'`;
  assert.ok(p.implement.includes(finish('b0')), p.implement);
  assert.ok(p.fix.includes(finish('h1')), p.fix);
  for (const name of ['implement', 'fix']) {
    assert.ok(!p[name].includes('"event":"committed"'), `${name}: no separate committed ledger command`);
  }
});

test('batch prompts pass every task to start-task and finish-task', () => {
  const m = manifest();
  const unit = {
    id: 'T3-T4', title: 'Task T3', files: ['src/T3.js', 'src/T4.js'], tier: 'light', security: false, batch: 'x',
    tasks: [task('T3', { tier: 'light', batch: 'x' }), task('T4', { tier: 'light', batch: 'x' })],
  };
  const fs = [finding('the bug')];
  const p = {
    implement: implementPrompt(m, unit, WHERE, 'b0'),
    review: reviewPrompt(m, unit, WHERE, 'b0', 'h1'),
    fix: fixPrompt(m, unit, WHERE, fs, done('b0', 'h1'), 'h1'),
    reReview: reReviewPrompt(m, unit, WHERE, 'h1', 'h2', fs),
  };
  for (const [name, text] of Object.entries(p)) {
    assert.ok(text.includes("--brief 'T3' '/work/ledger/briefs/T3.md' --brief 'T4' '/work/ledger/briefs/T4.md'"),
      `${name}: every brief`);
  }
  for (const name of ['implement', 'fix']) {
    assert.ok(p[name].includes("--task 'T3' --task 'T4'"), `${name}: every task`);
    assert.ok(!p[name].includes('--commit'), `${name}: the range comes from git, not a typed list`);
  }
  assert.ok(p.review.includes("'/work/ledger/reviews/T3-T4-b0..h1.diff'"), 'one package for the batch range');
});

test('task prompts carry no separate brief, fast-forward, or shortstat command', () => {
  for (const spDir of ['/sp/skills', null]) {
    const m = manifest({ sp_dir: spDir });
    const p = allPrompts(m);
    p.implementSynced = implementPrompt(m, task('T2'), { ...WHERE, sync: 'pl/run-1' }, 'b0');
    for (const [name, text] of Object.entries(p)) {
      for (const banned of ['scripts/task-brief', 'merge --ff-only', '--shortstat']) {
        assert.ok(!text.includes(banned), `${name} (sp_dir ${spDir}): ${banned}`);
      }
    }
  }
});

test('the final fix prompt still counts changed_lines with shortstat', () => {
  const text = finalFixPrompt(manifest(), [finding('the bug')], 'tip0');
  assert.ok(text.includes('diff --shortstat'), text);
});

test('every agent gets the combine-commands rule', () => {
  assert.ok(agentRules().includes('Combine independent shell commands into one call'));
});

test('autonomous: a park or unblock without commits gives the adjudicator settled commands at base', async () => {
  const m = manifest();
  const s = stub({
    'T2 implement': [blocked('b0', 'nothing to do')],
    'T2 adjudicate': [settled('park', 'PARK-0', 'b0')],
  });
  const r = await runTask(m, task('T2'), WHERE, 'b0', s.io);
  assert.equal(r.status, 'deferred');
  const adj = s.calls[1].prompt;
  for (const outcome of ['park', 'unblock']) {
    assert.ok(adj.includes(`'b0' '/work/ledger' 'alpha' --task 'T2' --settled ${outcome}`), `${outcome} command from base`);
  }
});

test('autonomous: a security task with an important finding open cannot be parked or unblocked', async () => {
  for (const outcome of ['park', 'unblock']) {
    const m = manifest({ limits: { review_rounds: 0, max_parallel_lanes: 3 } });
    const s = stub({
      'T2 implement': [done('b0', 'h1')],
      'T2 review': [changes('SEC-1')],
      'T2 adjudicate': [ruled(outcome, `${outcome} it`)],
    });
    const r = await runTask(m, task('T2', { security: true }), WHERE, 'b0', s.io);
    assert.equal(r.status, 'blocked', outcome);
    assert.equal(r.notes, 'adjudicator_stop: security', outcome);
    const adj = s.calls[2].prompt;
    assert.match(adj, /This task is security-flagged/);
    assert.ok(!adj.includes('--settled'), 'no settled command for a security task');
    assert.deepEqual(r.rulings, [`refused (security-gated): ${outcome} it`], outcome);
  }
});

// Review finding 13: deferring a security requirement is never inferred from
// the absence of findings; a security task blocked before its first review
// cannot be parked either.
test('autonomous: a security task is never parked, even blocked before any review or with only minor findings', async () => {
  const before = stub({
    'T2 implement': [blocked('b0', 'stuck before any code')],
    'T2 adjudicate': [settled('park', 'PARK-EARLY', 'b0')],
  });
  let r = await runTask(manifest(), task('T2', { security: true }), WHERE, 'b0', before.io);
  assert.equal(r.status, 'blocked');
  assert.equal(r.notes, 'adjudicator_stop: security');
  assert.deepEqual(labels(before.calls), ['T2 implement', 'T2 adjudicate'], 'no reviewer, no settled range');
  const m = manifest({ limits: { review_rounds: 0, max_parallel_lanes: 3 } });
  const minor = { verdict: 'changes', findings: [{ ...finding('NIT-1'), severity: 'minor' }], cannot_verify: [] };
  const later = stub({
    'T2 implement': [done('b0', 'h1')],
    'T2 review': [minor],
    'T2 adjudicate': [settled('park', 'PARK-NIT', 'h1')],
  });
  r = await runTask(m, task('T2', { security: true }), WHERE, 'b0', later.io);
  assert.equal(r.status, 'blocked');
  assert.equal(r.notes, 'adjudicator_stop: security');
});

// Review finding 3: the gate decides from the findings, not the label.
test('an approval that carries a critical finding is acted on as changes, with its severity kept', async () => {
  const crit = { severity: 'critical', file: 'src/auth.js', line: 10, issue: 'authz bypass', fix: 'check the role' };
  const s = stub({
    'T2 implement': [done('b0', 'h1')],
    'T2 review': [{ verdict: 'approve', findings: [crit], cannot_verify: [] }],
    'T2 fix 1': [done('h1', 'h2')],
    'T2 re-review 1': [{ verdict: 'approve', findings: [{ ...crit, severity: 'minor', issue: 'naming' }], cannot_verify: [] }],
  });
  const r = await runTask(manifest(), task('T2'), WHERE, 'b0', s.io);
  assert.deepEqual(labels(s.calls), ['T2 implement', 'T2 review', 'T2 fix 1', 'T2 re-review 1']);
  assert.ok(s.calls[2].prompt.includes('authz bypass'), 'the fixer gets the critical finding');
  assert.ok(s.logs.some((l) => l.includes('approved with a critical or important finding')));
  assert.equal(r.status, 'done');
  assert.match(r.notes, /minor finding: src\/auth\.js:10 - naming/);
});

test('the fix after a contradicted approval reopens any approval the reviewer recorded', async () => {
  const crit = { severity: 'critical', file: 'src/auth.js', line: 10, issue: 'authz bypass', fix: 'check the role' };
  const s = stub({
    'T2 implement': [done('b0', 'h1')],
    'T2 review': [{ verdict: 'approve', findings: [crit], cannot_verify: [] }],
    'T2 fix 1': [done('h1', 'h2')],
    'T2 re-review 1': [approve()],
  });
  await runTask(manifest(), task('T2'), WHERE, 'b0', s.io);
  const fix = s.calls.find((c) => c.label === 'T2 fix 1').prompt;
  assert.ok(fix.includes('"event":"reopened"'), fix);
  assert.ok(s.calls.find((c) => c.label === 'T2 review').prompt.includes("'/work/wt/lane-alpha' 'h1' <blocking>"),
    'the approval command names the reviewed head and asks for the blocking count');
});

test('a contradicted approval on a sonnet task is reopened by the escalated implement', async () => {
  const crit = { severity: 'critical', file: 'src/auth.js', line: 10, issue: 'authz bypass', fix: 'check the role' };
  const s = stub({
    'T2 implement': [done('b0', 'h1'), done('h1', 'h2')],
    'T2 review': [{ verdict: 'approve', findings: [crit], cannot_verify: [] }, approve()],
  });
  await runTask(manifest(), task('T2', { tier: 'sonnet' }), WHERE, 'b0', s.io);
  const impls = s.calls.filter((c) => c.label === 'T2 implement');
  assert.equal(impls.length, 2, 'the changes verdict escalates the sonnet task to a standard rerun');
  assert.ok(!impls[0].prompt.includes('"event":"reopened"'));
  assert.ok(impls[1].prompt.includes('"event":"reopened"'), 'the rerun reopens the contradicted approval');
});

test('a changes verdict with no findings is not a usable review', async () => {
  const s = stub({
    'T2 implement': [done('b0', 'h1')],
    'T2 review': [{ verdict: 'changes', findings: [], cannot_verify: [] }],
  });
  const r = await runTask(manifest({ autonomy: 'supervised' }), task('T2'), WHERE, 'b0', s.io);
  assert.equal(r.status, 'blocked');
  assert.match(r.notes, /invalid result from T2 review: changes with no findings/);
});

test('autonomous: an unblock note goes to the task that depends on it, not just the next one', async () => {
  const m = manifest({ lanes: [{ id: 'alpha', name: 'Lane alpha', tasks: [
    task('T2'), task('T3'), task('T5', { depends_on: [{ id: 'T2', kind: 'contract' }] }),
  ] }] });
  const s = stub({
    'T2 implement': [blocked('b0', 'upstream missing')],
    'T2 adjudicate': [settled('unblock', 'UNBLOCK-DEP: use the v2 shape', 'b0')],
    'T3 implement': [done('b0', 'h3')],
    'T3 review': [approve()],
    'T5 implement': [done('h3', 'h5')],
    'T5 review': [approve()],
  });
  await runLane(m, m.lanes[0], 'b0', s.io);
  const prompt = (label) => s.calls.find((c) => c.label === label).prompt;
  assert.ok(!prompt('T3 implement').includes('UNBLOCK-DEP'));
  assert.ok(prompt('T5 implement').includes('UNBLOCK-DEP: use the v2 shape'));
});

test('a non-security task is not told it is security-flagged', async () => {
  const m = manifest();
  const s = stub({ 'T2 implement': [blocked('b0')], 'T2 adjudicate': [ruled('park', 'P')] });
  await runTask(m, task('T2'), WHERE, 'b0', s.io);
  assert.ok(!/security-flagged/.test(s.calls[1].prompt));
});

test('autonomous: an invalid or budget-refused adjudication is not listed as a ruling', async () => {
  for (const r0 of [{ outcome: 'approve', text: 'ok' }, { __budget: true }]) {
    const m = manifest();
    const s = stub({ 'T2 implement': [blocked('b0')], 'T2 adjudicate': [r0] });
    const r = await runTask(m, task('T2'), WHERE, 'b0', s.io);
    assert.equal(r.status, 'blocked');
    assert.deepEqual(r.rulings, [], JSON.stringify(r0));
  }
});

// 1.2.1: review gaps.
test('the implementer records its task base through start-task before it writes; reviews and fixes do not', () => {
  const p = allPrompts(manifest());
  assert.ok(p.implement.includes("--record-start '/work/ledger' 'alpha' 'b0'"), p.implement);
  for (const name of ['review', 'fix', 'reReview']) assert.ok(!p[name].includes('--record-start'), name);
});

test('reviews get the files their range changes outside the Files list, and judge each', () => {
  const m = manifest();
  const batchTasks = [task('T2', { files: ['src/T2.js', 'docs/a.md'] }), task('T3')];
  const unit = { id: 'T2-T3', title: 'batch', files: [], tier: 'light', security: false, batch: 'k', tasks: batchTasks };
  for (const [text, base, head] of [
    [reviewPrompt(m, task('T2'), WHERE, 'b0', 'h1'), 'b0', 'h1'],
    [reReviewPrompt(m, task('T2'), WHERE, 'h1', 'h2', [finding('x')]), 'h1', 'h2'],
  ]) {
    assert.ok(text.includes(`--scope '${base}' '${head}' --declared 'src/T2.js'`), text);
    assert.ok(text.includes("files changed outside the task's Files list"), text);
    assert.ok(/a change the task did not need[^.]*is an important finding/.test(text.replace(/\n/g, ' ')), text);
  }
  const batch = reviewPrompt(m, unit, WHERE, 'b0', 'h1');
  assert.ok(batch.includes("--declared 'src/T2.js' --declared 'docs/a.md' --declared 'src/T3.js'"), batch);
  // Without superpowers the scope list still comes from start-task.
  assert.ok(reviewPrompt(manifest({ sp_dir: null }), task('T2'), WHERE, 'b0', 'h1').includes("--scope 'b0' 'h1'"));
  // A task with no Files list has nothing to compare against.
  const bare = reviewPrompt(m, task('T2', { files: [] }), WHERE, 'b0', 'h1');
  assert.ok(!bare.includes('--scope') && !bare.includes('outside the task'), bare);
});

// Review finding 14: the prompts impose no content or commit convention of
// their own; the project's commit_rules are the only source, so UTF-8 text
// and trailers the project asks for stay allowed.
test('prompts carry only the project rules: no ASCII or trailer rule of their own', async () => {
  const { finalReviewPrompt, combinedFinalReviewPrompt, integratePrompt, e2ePrompt, verifyPrompt,
    postIntegratePrompt, preflightPrompt } = await loadHelpers(['finalReviewPrompt', 'combinedFinalReviewPrompt',
    'integratePrompt', 'e2ePrompt', 'verifyPrompt', 'postIntegratePrompt', 'preflightPrompt']);
  const rules = 'Write UTF-8 freely (docs are in French: café). End every commit with a Signed-off-by: trailer.';
  const m = manifest({ commit_rules: rules, hooks: { e2e: 'run the app', post_integrate: 'smoke test' } });
  const fs = [{ ...finding('the bug'), id: 'F1' }];
  const prompts = {
    ...allPrompts(m),
    finalSp: finalReviewPrompt(m, 'sp', null),
    finalSecurity: finalReviewPrompt(m, 'security', null),
    finalCorrectness: finalReviewPrompt(m, 'correctness', null),
    combined: combinedFinalReviewPrompt(m, { e2e: null }),
    finalFix: finalFixPrompt(m, fs, 'h1'),
    integrate: integratePrompt(m, 'p0', {}),
    e2e: e2ePrompt(m),
    verify: verifyPrompt(m, 'h1'),
    postIntegrate: postIntegratePrompt(m),
    preflight: preflightPrompt(m),
  };
  for (const [name, text] of Object.entries(prompts)) {
    assert.ok(text.includes(rules), `${name}: the project's rules`);
    const own = text.split(rules).join('');
    assert.ok(!/ASCII/i.test(own), `${name}: an ASCII rule of its own`);
    assert.ok(!/trailer|co-authored|AI (name|attribution)|Claude/i.test(own), `${name}: a trailer or AI rule of its own`);
  }
});
