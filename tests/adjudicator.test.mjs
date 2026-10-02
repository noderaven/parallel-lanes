import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadHelpers } from './harness.mjs';

const { adjudicatorSchema, adjudicatorPrompt, adjudicate, ledgerCommand, agentRules } = await loadHelpers([
  'adjudicatorSchema', 'adjudicatorPrompt', 'adjudicate', 'ledgerCommand', 'agentRules',
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
    prelude: [task('T1')],
    lanes: [
      { id: 'alpha', name: 'Lane alpha', tasks: [task('T2'), task('T3')] },
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
const RULING = 'Ruling: <decision> - <why> - <cost if wrong>';
const STOP_CONDITIONS = [
  'irreversible/destructive operation',
  'security-sensitive decision',
  "side effect outside the run's worktrees",
  'a plan so broken every path is a guess',
];

function blockedCtx(overrides = {}) {
  return {
    kind: 'blocked',
    task: task('T2'),
    where: WHERE,
    details: 'Range: abc..def\nReport: /work/ledger/reports/T2.md\nBlocked: which config key?',
    findings: [],
    ...overrides,
  };
}

function preflightCtx(overrides = {}) {
  return {
    kind: 'preflight',
    task: null,
    where: null,
    details: 'Conflicts: T2 and T4 both edit src/shared.js',
    findings: [],
    ...overrides,
  };
}

// Stub io whose agent returns the given results in order and records calls.
function stub(...results) {
  const calls = [];
  const agent = async (prompt, opts) => {
    calls.push({ prompt, ...opts });
    if (results.length === 0) throw new Error(`unscripted agent call: ${opts.label}`);
    return results.shift();
  };
  return { io: { agent, log: () => {} }, calls };
}

test('adjudicatorSchema: outcome enum, text, optional stop_condition', () => {
  const s = adjudicatorSchema();
  assert.equal(s.type, 'object');
  assert.deepEqual(s.properties.outcome, {
    type: 'string', enum: ['answer', 'clarify_plan', 'park', 'unblock', 'stop'],
  });
  assert.deepEqual(s.properties.text, { type: 'string' });
  assert.deepEqual(s.properties.stop_condition, {
    type: 'string', enum: ['destructive', 'security', 'outside_side_effect', 'plan_broken'],
  });
  assert.deepEqual(s.required, ['outcome', 'text']);
});

test('adjudicatorPrompt: stop conditions verbatim, outcomes, ruling format, context', () => {
  const m = manifest();
  const ctx = blockedCtx({
    findings: [{ severity: 'important', file: 'src/a.js', line: 3, issue: 'off by one', fix: 'use <=' }],
  });
  const p = adjudicatorPrompt(m, ctx);
  for (const condition of STOP_CONDITIONS) assert.ok(p.includes(condition), `stop condition: ${condition}`);
  for (const key of ['destructive', 'security', 'outside_side_effect', 'plan_broken']) {
    assert.ok(p.includes(key), `stop_condition key: ${key}`);
  }
  for (const outcome of ['answer', 'clarify_plan', 'park', 'unblock', 'stop']) {
    assert.ok(p.includes(`${outcome}:`) || p.includes(`${outcome} `), `outcome: ${outcome}`);
  }
  assert.ok(p.includes('Ruling: decision - why - cost if wrong'), 'ruling format');
  assert.ok(p.includes('Plan: /work/my plan.md'), 'plan path');
  assert.ok(p.includes('Spec: /work/spec.md'), 'spec path');
  assert.ok(p.includes('COMMIT-RULES: plain ASCII, no trailers'), 'commit_rules');
  assert.ok(p.includes(agentRules()), 'agentRules');
  assert.ok(p.includes(ctx.details), 'details');
  assert.ok(p.includes('src/a.js:3 - off by one'), 'findings');
  assert.ok(p.includes('T2'), 'task id');
  assert.ok(/blocked/.test(p), 'kind');
});

test('adjudicatorPrompt: task-brief command when a task is set, cd-prefixed', () => {
  const p = adjudicatorPrompt(manifest(), blockedCtx());
  const brief = "cd '/work/wt/lane-alpha' && python3 '/skills/parallel-lanes/scripts/task-brief' " +
    "'/work/my plan.md' 'T2' '/work/ledger/briefs/T2.md'";
  assert.ok(p.includes(brief), 'task-brief command');
});

test('adjudicatorPrompt: no task-brief command when task is null', () => {
  const p = adjudicatorPrompt(manifest(), preflightCtx());
  assert.ok(!p.includes('scripts/task-brief'), 'no task-brief command');
});

test('adjudicatorPrompt: ruling ledger command for the task lane, cd where.dir', () => {
  const m = manifest();
  const p = adjudicatorPrompt(m, blockedCtx());
  const cmd = ledgerCommand(m, 'alpha', { task: 'T2', event: 'ruling', text: RULING }, WHERE.dir);
  assert.ok(cmd.startsWith("cd '/work/wt/lane-alpha' && "));
  assert.ok(p.includes(cmd), 'ruling ledger command for lane alpha');
});

test('adjudicatorPrompt: ruling ledger command for lane _run in featureDir when where is null', () => {
  const m = manifest();
  const p = adjudicatorPrompt(m, preflightCtx());
  const cmd = ledgerCommand(m, '_run', { task: '_run', event: 'ruling', text: RULING }, '/work/repo');
  assert.ok(cmd.startsWith("cd '/work/repo' && "));
  assert.ok(p.includes(cmd), 'ruling ledger command for lane _run');
  assert.ok(p.includes(preflightCtx().details), 'pre-flight conflicts');

  const shadow = manifest({ repo: { ...m.repo, mode: 'shadow' } });
  const sp = adjudicatorPrompt(shadow, preflightCtx());
  assert.ok(sp.includes("cd '/work/wt/feature' && python3 "), 'shadow mode uses the feature worktree');
});

test('adjudicatorPrompt: every provided ledger command starts with cd to the agent checkout', () => {
  const m = manifest();
  for (const [ctx, dir] of [[blockedCtx(), WHERE.dir], [preflightCtx(), '/work/repo']]) {
    const p = adjudicatorPrompt(m, ctx);
    const lines = p.split('\n').filter((l) => l.includes('scripts/ledger'));
    assert.ok(lines.length > 0);
    for (const line of lines) assert.ok(line.trim().startsWith(`cd '${dir}' && `), line);
  }
});

test('adjudicatorPrompt: tells the agent to run ledger commands named in details', () => {
  const p = adjudicatorPrompt(manifest(), blockedCtx({ kind: 'round_cap' }));
  assert.ok(/ledger command/.test(p) && /details|above/.test(p));
  assert.ok(p.includes('round_cap') || /review round cap/i.test(p), 'round cap kind');
});

test('adjudicate: valid outcomes pass through', async () => {
  const m = manifest();
  for (const r of [
    { outcome: 'answer', text: 'use key foo' },
    { outcome: 'clarify_plan', text: 'the brief means bar' },
    { outcome: 'park', text: 'defer finding 1' },
    { outcome: 'unblock', text: 'stub the helper' },
    { outcome: 'stop', text: 'drops a table', stop_condition: 'destructive' },
    { outcome: 'stop', text: 'auth policy', stop_condition: 'security' },
    { outcome: 'stop', text: 'pushes to remote', stop_condition: 'outside_side_effect' },
    { outcome: 'stop', text: 'plan contradicts itself', stop_condition: 'plan_broken' },
  ]) {
    const { io } = stub({ ...r });
    assert.deepEqual(await adjudicate(m, blockedCtx(), io), r);
  }
});

test('adjudicate: label, phase, model, schema for a task', async () => {
  const m = manifest();
  const { io, calls } = stub({ outcome: 'answer', text: 'x' });
  await adjudicate(m, blockedCtx(), io);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].label, 'T2 adjudicate');
  assert.equal(calls[0].phase, 'Lane alpha');
  assert.equal(calls[0].model, 'opus');
  assert.equal(calls[0].effort, 'high');
  assert.deepEqual(calls[0].schema, adjudicatorSchema());
  assert.equal(calls[0].prompt, adjudicatorPrompt(m, blockedCtx()));
});

test('adjudicate: prelude task uses the Prelude phase', async () => {
  const m = manifest();
  const where = { dir: '/work/repo', branch: 'pl/run-1', lane: 'prelude' };
  const { io, calls } = stub({ outcome: 'answer', text: 'x' });
  await adjudicate(m, blockedCtx({ task: task('T1'), where, kind: 'question' }), io);
  assert.equal(calls[0].label, 'T1 adjudicate');
  assert.equal(calls[0].phase, 'Prelude');
});

test('adjudicate: pre-flight uses run adjudicate and the Pre-flight phase', async () => {
  const { io, calls } = stub({ outcome: 'park', text: 'serialize T2 and T4' });
  await adjudicate(manifest(), preflightCtx(), io);
  assert.equal(calls[0].label, 'run adjudicate');
  assert.equal(calls[0].phase, 'Pre-flight');
  assert.equal(calls[0].model, 'opus');
  assert.equal(calls[0].effort, 'high');
});

test('adjudicate: null result -> stop, unavailable', async () => {
  for (const r of [null, undefined]) {
    const { io } = stub(r);
    assert.deepEqual(await adjudicate(manifest(), blockedCtx(), io), {
      outcome: 'stop', text: 'no result from T2 adjudicate', stop_condition: 'plan_broken', unavailable: true,
    });
  }
  const { io } = stub(null);
  assert.deepEqual(await adjudicate(manifest(), preflightCtx(), io), {
    outcome: 'stop', text: 'no result from run adjudicate', stop_condition: 'plan_broken', unavailable: true,
  });
});

test('adjudicate: schema-invalid result -> stop plan_broken, not unavailable', async () => {
  const invalid = {
    outcome: 'stop', text: 'adjudicator returned an invalid result', stop_condition: 'plan_broken', invalid: true,
  };
  for (const r of [
    'answer',
    [],
    {},
    { outcome: 'approve', text: 'looks fine' },
    { outcome: 'answer' },
    { outcome: 'answer', text: 42 },
    { text: 'no outcome' },
    { outcome: 'answer', text: 'x', stop_condition: 'bored' },
  ]) {
    const { io } = stub(r);
    const out = await adjudicate(manifest(), blockedCtx(), io);
    assert.deepEqual(out, invalid, JSON.stringify(r));
    assert.ok(!('unavailable' in out));
  }
});

test('adjudicate: stop without a valid stop_condition -> stop plan_broken', async () => {
  const invalid = {
    outcome: 'stop', text: 'adjudicator returned an invalid result', stop_condition: 'plan_broken', invalid: true,
  };
  for (const r of [
    { outcome: 'stop', text: 'just stop' },
    { outcome: 'stop', text: 'just stop', stop_condition: 'tired' },
    { outcome: 'stop', text: 'just stop', stop_condition: null },
  ]) {
    const { io } = stub(r);
    assert.deepEqual(await adjudicate(manifest(), blockedCtx(), io), invalid, JSON.stringify(r));
  }
});

test('adjudicate: an agent cannot claim unavailable; extra fields are dropped', async () => {
  const { io } = stub({ outcome: 'stop', text: 'x', stop_condition: 'security', unavailable: true, extra: 1 });
  assert.deepEqual(await adjudicate(manifest(), blockedCtx(), io),
    { outcome: 'stop', text: 'x', stop_condition: 'security' });
});
