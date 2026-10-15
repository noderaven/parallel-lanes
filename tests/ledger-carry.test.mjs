// 1.6.3 review carry-over: ruling roles, ids, scope and overrides; the
// rulings print; carry-launch and open-minor snapshots; the owner map.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { tempDir, mergeEnv } from './platform.mjs';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const TMP = tempDir('pl-carry-');
after(() => rmSync(TMP, { recursive: true, force: true }));

let counter = 0;
function freshDir(name = 'ledger') {
  counter += 1;
  const dir = join(TMP, `case ${counter}`, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function run(script, args, env = {}) {
  const res = spawnSync('python3', [join(SCRIPTS, script), ...args], {
    encoding: 'utf8', env: mergeEnv(process.env, env),
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}
const ledger = (...args) => run('ledger', args);

function appendOk(dir, lane, entry) {
  const res = ledger('append', dir, lane, JSON.stringify(entry));
  assert.equal(res.code, 0, res.stderr);
}

function rulingsOut(dir, ...extra) {
  const res = ledger('rulings', dir, ...extra);
  assert.equal(res.code, 0, res.stderr);
  return res.stdout;
}

// ---- Task 1: fields, ids, rulings ----

test('append refuses a ruling role, scope or overrides of the wrong kind', () => {
  const dir = freshDir();
  for (const bad of [{ by: 'boss' }, { scope: 'all' }, { overrides: 'x' }, { files: 'a.js' }, { pf: 'P1' }]) {
    const res = ledger('append', dir, 'alpha', JSON.stringify({ task: 'T2', event: 'ruling', text: 'R', ...bad }));
    assert.equal(res.code, 2, `${JSON.stringify(bad)}: ${res.stderr}`);
  }
  appendOk(dir, 'alpha', {
    task: 'T2', event: 'ruling', text: 'R', by: 'implementer', scope: 'run', overrides: ['alpha-R1'],
    files: ['src/a.js'],
  });
  appendOk(dir, '_run', { task: '_run', event: 'ruling', text: 'P', by: 'preflight', pf: 'PF-1', wf: 'wf_abcdef-123' });
});

test('minors and carried events belong to _run only', () => {
  const dir = freshDir();
  assert.equal(ledger('append', dir, 'alpha', JSON.stringify({ task: 'T2', event: 'minors', open: [] })).code, 2);
  assert.equal(ledger('append', dir, '_run', JSON.stringify({ task: '_run', event: 'minors', open: 'x' })).code, 2);
  appendOk(dir, '_run', { task: '_run', event: 'minors', wf: 'wf_abcdef-123', open: [], covered: [] });
  appendOk(dir, '_run', { task: '_run', event: 'carried', wf: 'wf_abcdef-123', pf: {}, bound: [] });
});

test('rulings numbers each file in append order and prints role, task and scope', () => {
  const dir = freshDir();
  appendOk(dir, 'alpha', { task: 'T2', event: 'ruling', text: 'Ruling: a - b - c', by: 'implementer' });
  appendOk(dir, 'alpha', { task: 'T3', event: 'ruling', text: 'Ruling: d - e - f', by: 'adjudicator', scope: 'run' });
  appendOk(dir, 'beta', { task: 'T4', event: 'ruling', text: 'Ruling: g - h - i' });
  const out = rulingsOut(dir);
  assert.ok(out.includes('alpha-R1 [implementer, T2, lane] Ruling: a - b - c'), out);
  assert.ok(out.includes('alpha-R2 [adjudicator, T3, run] Ruling: d - e - f'), out);
  // A ruling with no by is an implementer's (written before 1.6.3).
  assert.ok(out.includes('beta-R1 [implementer, T4, lane] Ruling: g - h - i'), out);
});

test('rulings --lane shows _run, the prelude, the lane and run-scope rulings only', () => {
  const dir = freshDir();
  appendOk(dir, '_run', { task: '_run', event: 'ruling', text: 'RUN', by: 'adjudicator' });
  appendOk(dir, 'prelude', { task: 'T1', event: 'ruling', text: 'PRE', by: 'implementer' });
  appendOk(dir, 'alpha', { task: 'T2', event: 'ruling', text: 'ALPHA', by: 'implementer' });
  appendOk(dir, 'beta', { task: 'T4', event: 'ruling', text: 'BETA', by: 'implementer' });
  appendOk(dir, 'beta', { task: 'T4', event: 'ruling', text: 'BETA-RUN', by: 'implementer', scope: 'run' });
  const out = rulingsOut(dir, '--lane', 'alpha');
  for (const want of ['RUN', 'PRE', 'ALPHA', 'BETA-RUN']) assert.ok(out.includes(`] ${want}`), `${want}: ${out}`);
  assert.ok(!out.includes('] BETA\n'), out);
  assert.ok(out.includes('beta-R2 ['), 'ids count the whole file, not the filtered view');
});

test('an overridden ruling is listed apart with the ruling that overrode it', () => {
  const dir = freshDir();
  appendOk(dir, 'alpha', { task: 'T2', event: 'ruling', text: 'OLD', by: 'implementer' });
  appendOk(dir, 'alpha', { task: 'T3', event: 'ruling', text: 'NEW', by: 'adjudicator', overrides: ['alpha-R1'] });
  appendOk(dir, 'alpha', { task: 'T3', event: 'ruling', text: 'GHOST', by: 'adjudicator', overrides: ['zeta-R9'] });
  const out = rulingsOut(dir);
  const [inForce, overridden] = out.split('Overridden:');
  assert.ok(inForce.includes('alpha-R2 [adjudicator, T3, lane] NEW (overrides alpha-R1)'), out);
  assert.ok(inForce.includes('(overrides zeta-R9 (unknown))'), out);
  assert.ok(!inForce.includes('] OLD'), out);
  assert.ok(overridden.includes('alpha-R1 by alpha-R2'), out);
});

test('rulings lists the files a ruling permits, and prints (none) for an empty ledger', () => {
  const dir = freshDir();
  assert.equal(rulingsOut(dir).trim(), '(none)');
  appendOk(dir, 'alpha', { task: 'T2', event: 'ruling', text: 'MAY', by: 'adjudicator', files: ['src/b.js', 'src/c.js'] });
  assert.ok(rulingsOut(dir).includes('MAY (files src/b.js, src/c.js)'));
});

// ---- Task 2: carry-launch, open-minor snapshots, status ----

const minor = (id, task, issue = `issue ${id}`) => ({ id, severity: 'minor', file: `src/${task}.js`, line: 3, issue, fix: 'fix it' });

// A Claude config dir holding one session's workflow result file, as the
// Workflow tool writes it; returns {config, transcripts} (the transcript dir).
function launchFile(config, wf, { rulings = [], adjudicated = null, tasks = {}, final = null, args = {} } = {}) {
  const session = join(config, 'projects', 'C--work', 'sess-1');
  mkdirSync(join(session, 'workflows'), { recursive: true });
  const transcripts = join(session, 'subagents', 'workflows', wf);
  mkdirSync(transcripts, { recursive: true });
  const result = {
    status: 'complete', run_id: 'run-1', tasks,
    preflight: { conflicts: [], rulings, undeclared: [], schedule: [], adjudicated },
    final,
  };
  writeFileSync(join(session, 'workflows', `${wf}.json`), JSON.stringify({ runId: wf, args, result }));
  return transcripts;
}
const done = (minors) => ({ status: 'done', rounds: 0, tier_used: 'standard', commits: null, notes: '',
  ...(minors === undefined ? {} : { minor_findings: minors, rulings: [] }) });
const finalOf = (taskOpen, carriedOpen = []) => ({ findings: [], task_minors_open: taskOpen.map((id) => ({ id })),
  carried_minors_open: carriedOpen });

function carry(dir, source, env = {}) {
  const res = run('ledger', ['carry-launch', dir, source], env);
  return { ...res, json: res.code === 0 ? JSON.parse(res.stdout) : null };
}
function statusOf(dir) {
  const res = ledger('status', dir);
  assert.equal(res.code, 0, res.stderr);
  return JSON.parse(res.stdout);
}

test('carry-launch records pre-flight rulings, skipping the adjudication the adjudicator already recorded', () => {
  const dir = freshDir();
  const config = freshDir('config');
  appendOk(dir, '_run', { task: '_run', event: 'ruling', by: 'adjudicator', text: 'Ruling: ADJ - w - c' });
  const t = launchFile(config, 'wf_aaaaaa-111', { rulings: ['Ruling: A - w - c', 'ADJ', 'Ruling: B - w - c'], adjudicated: 1 });
  const out = carry(dir, t);
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(out.json, { carried: 'wf_aaaaaa-111', rulings: 2, open_minors: 0 });
  const printed = rulingsOut(dir);
  assert.ok(printed.includes('_run-R2 [preflight, _run, run] Ruling: A - w - c'), printed);
  assert.ok(printed.includes('_run-R3 [preflight, _run, run] Ruling: B - w - c'), printed);
  assert.equal(printed.split('ADJ').length, 2, 'the adjudication appears once');
});

test('carry-launch finds a launch by its wf id under the Claude config dir, and runs once per launch', () => {
  const dir = freshDir();
  const config = freshDir('config');
  launchFile(config, 'wf_bbbbbb-222', { rulings: ['R1'], tasks: { T1: done([minor('T1-1', 'T1')]) } });
  const first = carry(dir, 'wf_bbbbbb-222', { CLAUDE_CONFIG_DIR: config });
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(first.json, { carried: 'wf_bbbbbb-222', rulings: 1, open_minors: 1 });
  const before = readFileSync(join(dir, '_run.jsonl'), 'utf8');
  const again = carry(dir, 'wf_bbbbbb-222', { CLAUDE_CONFIG_DIR: config });
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual(again.json, { carried: 'wf_bbbbbb-222', already: true });
  assert.equal(readFileSync(join(dir, '_run.jsonl'), 'utf8'), before);
});

test('carry-launch with no readable result writes nothing and exits 3', () => {
  const dir = freshDir();
  const config = freshDir('config');
  const res = carry(dir, 'wf_cccccc-333', { CLAUDE_CONFIG_DIR: config });
  assert.equal(res.code, 3, res.stdout);
  assert.equal(statusOf(dir).minors.open.length, 0);
});

test('open minors carry across three launches: raised ones drop, a re-reviewed task replaces its own', () => {
  const dir = freshDir();
  const config = freshDir('config');
  // Launch 1 stopped before the final review: every minor stays open.
  carry(dir, launchFile(config, 'wf_l1aaaa-001', {
    tasks: { T1: done([minor('T1-1', 'T1'), minor('T1-2', 'T1')]), T2: done([minor('T2-1', 'T2')]) },
  }));
  assert.deepEqual(statusOf(dir).minors, { open: ['T1-1', 'T1-2', 'T2-1'], covered: ['T1', 'T2'] });
  // Launch 2: its final raised T1-1 (carried) and T3-1 (its own).
  carry(dir, launchFile(config, 'wf_l2aaaa-002', {
    tasks: { T1: { status: 'skipped' }, T2: { status: 'skipped' }, T3: done([minor('T3-1', 'T3'), minor('T3-2', 'T3')]) },
    final: finalOf(['T3-2'], ['T1-2', 'T2-1']),
    args: { carried_minors: { open: ['T1-1', 'T1-2', 'T2-1'], covered: ['T1', 'T2'] } },
  }));
  assert.deepEqual(statusOf(dir).minors, { open: ['T1-2', 'T2-1', 'T3-2'], covered: ['T1', 'T2', 'T3'] });
  // Launch 3 reviews T2 again: its old entry is replaced by the new review's.
  carry(dir, launchFile(config, 'wf_l3aaaa-003', {
    tasks: { T2: done([minor('T2-1', 'T2', 'the new wording')]) },
    final: finalOf(['T2-1'], ['T1-2', 'T3-2']),
    args: { carried_minors: { open: ['T1-2', 'T3-2'], covered: ['T1', 'T2', 'T3'] } },
  }));
  const printed = ledger('minors', dir).stdout;
  assert.ok(printed.includes('[T2-1] T2 src/T2.js:3 - the new wording (fix: fix it)'), printed);
  assert.ok(!printed.includes('issue T2-1'), printed);
  assert.deepEqual(statusOf(dir).minors.open, ['T1-2', 'T3-2', 'T2-1']);
});

test('a 1.6.2 result carries no minors and covers none of its tasks', () => {
  const dir = freshDir();
  const config = freshDir('config');
  carry(dir, launchFile(config, 'wf_old162-001', { tasks: { T1: done(undefined) } }));
  assert.deepEqual(statusOf(dir).minors, { open: [], covered: [] });
  assert.equal(ledger('minors', dir).stdout.trim(), '(none)');
});

test("a ruling that overrides a launch's PF-n resolves to that launch's carried pre-flight ruling", () => {
  const dir = freshDir();
  const config = freshDir('config');
  appendOk(dir, 'alpha', { task: 'T2', event: 'ruling', by: 'adjudicator', text: 'NEW', overrides: ['PF-2'] });
  carry(dir, launchFile(config, 'wf_pfaaaa-001', { rulings: ['ONE', 'TWO'] }));
  const out = rulingsOut(dir);
  assert.ok(out.includes('alpha-R1 [adjudicator, T2, lane] NEW (overrides _run-R2)'), out);
  assert.ok(out.split('Overridden:')[1].includes('_run-R2 by alpha-R1'), out);
  assert.deepEqual(statusOf(dir).overrides,
    [{ id: 'alpha-R1', by: 'adjudicator', task: 'T2', overrides: ['_run-R2'], unknown: [] }]);
});

test('a 1.6.2 result with pre-flight conflicts: the last pre-flight ruling is the adjudication, carried once', () => {
  const dir = freshDir();
  const config = freshDir('config');
  appendOk(dir, '_run', { task: '_run', event: 'ruling', by: 'adjudicator', text: 'Ruling: clarify_plan - x - y' });
  const session = join(config, 'projects', 'C--work', 'sess-1');
  mkdirSync(join(session, 'workflows'), { recursive: true });
  // 1.6.2 had no preflight.adjudicated: it pushed the adjudication last.
  const result = { status: 'complete', tasks: {}, final: null,
    preflight: { conflicts: ['FP3 vs check-metas'], rulings: ['Ruling: A - w - c', 'Change to FP3 for this run'], undeclared: [], schedule: [] } };
  writeFileSync(join(session, 'workflows', 'wf_old162-adj.json'), JSON.stringify({ runId: 'wf_old162-adj', args: {}, result }));
  const out = carry(dir, 'wf_old162-adj', { CLAUDE_CONFIG_DIR: config });
  assert.deepEqual(out.json, { carried: 'wf_old162-adj', rulings: 1, open_minors: 0 }, out.stderr);
  assert.ok(!rulingsOut(dir).includes('Change to FP3'));
});
