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
