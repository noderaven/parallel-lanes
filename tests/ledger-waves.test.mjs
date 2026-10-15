// 1.6.5 join waves in the ledger: concurrent appends take a lock, a reader
// skips a half-written last line, the wave events and the started fields
// (design 4.5); restarts, join_started, unit branches, wave merges, the
// join's backfill and join_tip.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { tempDir, mergeEnv } from './platform.mjs';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const TMP = tempDir('pl-ledger-waves-');
after(() => rmSync(TMP, { recursive: true, force: true }));

let counter = 0;
function freshDir(name = 'ledger') {
  counter += 1;
  const dir = join(TMP, `case ${counter}`, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function run(script, args, env = {}, cwd = undefined) {
  const res = spawnSync('python3', ['-B', join(SCRIPTS, script), ...args], {
    encoding: 'utf8', env: mergeEnv(process.env, env), cwd,
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}
const ledger = (...args) => run('ledger', args);

function appendOk(dir, lane, entry) {
  const res = ledger('append', dir, lane, JSON.stringify(entry));
  assert.equal(res.code, 0, res.stderr);
}

function statusOf(dir, ...extra) {
  const res = ledger('status', dir, ...extra);
  assert.equal(res.code, 0, res.stderr);
  return JSON.parse(res.stdout);
}

const lines = (dir, lane) => readFileSync(join(dir, `${lane}.jsonl`), 'ascii').split('\n').filter((l) => l !== '');

// A Python child that loads scripts/ledger as a module.
const LOADER = [
  'import sys, os',
  'sys.dont_write_bytecode = True',
  `sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`,
  'from importlib.machinery import SourceFileLoader',
  `L = SourceFileLoader("ledger_mod", ${JSON.stringify(join(SCRIPTS, 'ledger'))}).load_module()`,
];

function child(code) {
  return spawn('python3', ['-B', '-c', [...LOADER, ...code].join('\n')], { env: mergeEnv(process.env) });
}
const exited = (p) => new Promise((resolve) => p.on('exit', (code) => resolve(code)));

// Holds the lane's append lock until killed; resolves once it is held.
function holdLock(dir, lane) {
  const p = spawn('python3', ['-B', '-c', [
    'import sys, os, time',
    'sys.dont_write_bytecode = True',
    `sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`,
    'import _oslock',
    `fd = os.open(${JSON.stringify(join(dir, `${lane}.jsonl`))}, os.O_RDWR | os.O_CREAT, 0o600)`,
    'assert _oslock.try_lock(fd)',
    'print("held", flush=True)',
    'time.sleep(60)',
  ].join('\n')], { env: mergeEnv(process.env) });
  return new Promise((resolve, reject) => {
    p.stdout.on('data', (d) => { if (String(d).includes('held')) resolve(p); });
    p.on('exit', (code) => reject(new Error(`lock holder exited ${code}`)));
  });
}

function appendAsync(dir, lane, entry, env = {}) {
  const start = Date.now();
  const p = spawn('python3', ['-B', join(SCRIPTS, 'ledger'), 'append', dir, lane, JSON.stringify(entry)],
    { env: mergeEnv(process.env, env) });
  let stderr = '';
  p.stderr.on('data', (d) => { stderr += d; });
  return new Promise((resolve) => p.on('exit', (code) => resolve({ code, stderr, ms: Date.now() - start })));
}

// ---- Task 2: writes ----

test('concurrent appenders all land', async () => {
  const dir = freshDir();
  const kids = [];
  for (let k = 0; k < 8; k += 1) {
    kids.push(child([
      'for i in range(50):',
      `    L.append_entries(${JSON.stringify(dir)}, "alpha", [{"task": "T${k}", "event": "ruling", "text": "r%d" % i}])`,
    ]));
  }
  const codes = await Promise.all(kids.map(exited));
  assert.deepEqual(codes, new Array(8).fill(0));
  const got = lines(dir, 'alpha');
  assert.equal(got.length, 400);
  for (const l of got) JSON.parse(l);
});

test('a held lock makes an append wait', async () => {
  const dir = freshDir();
  const holder = await holdLock(dir, 'alpha');
  const pending = appendAsync(dir, 'alpha', { task: 'T1', event: 'ruling', text: 'r' });
  setTimeout(() => holder.kill(), 1000);
  const r = await pending;
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.ms >= 900, `appended after ${r.ms} ms`);
  assert.equal(lines(dir, 'alpha').length, 1);
});

test('a lock held past the wait refuses and writes nothing', async () => {
  const dir = freshDir();
  appendOk(dir, 'alpha', { task: 'T1', event: 'ruling', text: 'first' });
  const holder = await holdLock(dir, 'alpha');
  try {
    const r = await appendAsync(dir, 'alpha', { task: 'T1', event: 'ruling', text: 'second' },
      { LEDGER_LOCK_WAIT_S: '1' });
    assert.equal(r.code, 3, r.stderr);
    assert.match(r.stderr, /alpha\.jsonl stayed locked for 1 s/);
  } finally {
    holder.kill();
  }
  assert.equal(lines(dir, 'alpha').length, 1);
});

test('a partial last line is ignored', () => {
  const dir = freshDir();
  appendOk(dir, 'alpha', { task: 'T1', event: 'started', base: 'abc' });
  appendFileSync(join(dir, 'alpha.jsonl'), '{"task":"T1","ev');
  const s = statusOf(dir);
  assert.deepEqual(s.done, []);
  assert.equal(ledger('append', dir, 'beta', JSON.stringify({ task: 'T2', event: 'ruling', text: 'r' })).code, 0);
});

test('a bad middle line still fails', () => {
  const dir = freshDir();
  appendOk(dir, 'alpha', { task: 'T1', event: 'started', base: 'abc' });
  appendFileSync(join(dir, 'alpha.jsonl'), '{"task":"T1","ev\n');
  appendOk(dir, 'alpha', { task: 'T1', event: 'started', base: 'abc' });
  assert.equal(ledger('status', dir).code, 3);
  const dir2 = freshDir();
  writeFileSync(join(dir2, 'alpha.jsonl'), '{"task":"T1","event":"nope"}');
  assert.equal(ledger('status', dir2).code, 3, 'a complete-looking but invalid last line without a newline');
});

test('wave_merged and wave_checked are accepted on _run only', () => {
  const dir = freshDir();
  appendOk(dir, '_run', { task: '_run', event: 'wave_merged', wave: 2, units: ['DJ2', 'DJ4'], head: 'abc',
    overlaps: [{ path: 'a.cs', units: ['DJ2', 'DJ4'] }], conflict_files: [] });
  appendOk(dir, '_run', { task: '_run', event: 'wave_merged', recovery: true, units: ['DJ2'], head: 'abd' });
  appendOk(dir, '_run', { task: '_run', event: 'wave_checked', wave: 3, head: 'abe', ok: true });
  appendOk(dir, '_run', { task: '_run', event: 'wave_checked', wave: 3, head: 'abe', ok: false, unfinished: true });
  for (const bad of [
    { task: 'DJ2', event: 'wave_merged', wave: 2, units: ['DJ2'], head: 'abc' },
    { task: 'DJ2', event: 'wave_checked', wave: 2, head: 'abc', ok: true },
    { task: '_run', event: 'wave_merged', wave: 2, units: [], head: 'abc' },
    { task: '_run', event: 'wave_merged', wave: 0, units: ['a'], head: 'abc' },
    { task: '_run', event: 'wave_merged', wave: 2, units: ['a'] },
    { task: '_run', event: 'wave_merged', wave: 2, units: ['a'], head: 'abc', overlaps: 'x' },
    { task: '_run', event: 'wave_checked', wave: 2, head: 'abc', ok: 'yes' },
    { task: '_run', event: 'wave_checked', wave: 2, head: 'abc', ok: true, unfinished: true },
    { task: '_run', event: 'wave_checked', head: 'abc', ok: true },
  ]) {
    assert.equal(ledger('append', dir, '_run', JSON.stringify(bad)).code, 2, JSON.stringify(bad));
  }
});

test('wave_merged needs exactly one of wave and recovery', () => {
  const dir = freshDir();
  for (const bad of [
    { task: '_run', event: 'wave_merged', units: ['a'], head: 'abc' },
    { task: '_run', event: 'wave_merged', wave: 1, recovery: true, units: ['a'], head: 'abc' },
    { task: '_run', event: 'wave_merged', recovery: false, units: ['a'], head: 'abc' },
  ]) {
    assert.equal(ledger('append', dir, '_run', JSON.stringify(bad)).code, 2, JSON.stringify(bad));
  }
});

test('started accepts dir, unit_branch and restart', () => {
  const dir = freshDir();
  appendOk(dir, 'join', { task: 'DJ2', event: 'started', base: 'abc', dir: 'C:/wt/lane-a',
    unit_branch: 'pl-d1a-u-DJ2' });
  appendOk(dir, 'join', { task: 'DJ2', event: 'started', base: 'abd', restart: true });
});

test('started refuses a unit_branch of another form', () => {
  const dir = freshDir();
  for (const bad of [
    { task: 'DJ2', event: 'started', base: 'abc', unit_branch: 'pl-d1a-a' },
    { task: 'DJ2', event: 'started', base: 'abc', unit_branch: '' },
    { task: 'DJ2', event: 'started', base: 'abc', dir: '' },
    { task: 'DJ2', event: 'started', base: 'abc', restart: false },
  ]) {
    assert.equal(ledger('append', dir, 'join', JSON.stringify(bad)).code, 2, JSON.stringify(bad));
  }
});
