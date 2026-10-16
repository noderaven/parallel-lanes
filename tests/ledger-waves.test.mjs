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

// ---- Task 3: reads ----

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid',
};
function git(dir, ...args) {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: mergeEnv(process.env, GIT_ENV) });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.replace(/\r\n/g, '\n').trim();
}
const jtask = (id) => ({ id, title: id, files: [], tier: 'standard', security: false });

// A repo on branch feat (initial commit W), a ledger dir, and a manifest whose
// join is ids with start point W.
function joinCase(ids) {
  counter += 1;
  const root = join(TMP, `join ${counter}`);
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'feat');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  const w = git(repo, 'rev-parse', 'HEAD');
  const ledgerDir = join(root, 'ledger');
  const manifest = join(root, 'manifest.json');
  writeFileSync(manifest, JSON.stringify({
    repo: { mode: 'git', root: repo, git_dir: null }, prelude: [], lanes: [], join: ids.map(jtask),
    start_points: { join: w },
  }));
  return { root, repo, w, ledger: ledgerDir, manifest };
}
// Commit a file on branch (created from `from` when it does not exist) and
// record the task's range from..HEAD with finish-task; returns the head.
function unitCommit(c, branch, from, taskId, name) {
  const exists = spawnSync('git', ['-C', c.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
    { env: mergeEnv(process.env, GIT_ENV) }).status === 0;
  git(c.repo, 'checkout', '-q', ...(exists ? [branch] : ['-b', branch, from]));
  writeFileSync(join(c.repo, name), `${name}\n`);
  git(c.repo, 'add', name);
  git(c.repo, 'commit', '-q', '-m', name);
  const res = run('finish-task', [c.repo, branch, from, c.ledger, 'join', '--task', taskId]);
  assert.equal(res.code, 0, res.stderr);
  return git(c.repo, 'rev-parse', 'HEAD');
}
const backfillOf = (c) => {
  const res = ledger('backfill', c.ledger, c.manifest);
  return { code: res.code, ...JSON.parse(res.stdout) };
};

test('1.6.4 ledgers give join_started false', () => {
  const dir = freshDir();
  appendOk(dir, 'prelude', { task: 'T1', event: 'started', base: 'abc' });
  appendOk(dir, 'join', { task: 'J1', event: 'committed', commits: ['abd'], base: 'abc', head: 'abd' });
  const s = statusOf(dir);
  assert.equal(s.join_started, false);
  assert.deepEqual(s.unit_branches, {});
  assert.deepEqual(s.wave_merges, []);
});

test('a started event in join.jsonl gives join_started', () => {
  const dir = freshDir();
  appendOk(dir, 'join', { task: 'J1', event: 'started', base: 'abc' });
  assert.equal(statusOf(dir).join_started, true);
});

test('unit_branches lists the latest unit branch and dir', () => {
  const dir = freshDir();
  appendOk(dir, 'join', { task: 'J2', event: 'started', base: 'abc', dir: 'C:/wt/lane-a', unit_branch: 'pl-r-u-J2' });
  appendOk(dir, 'join', { task: 'J3', event: 'started', base: 'abc', dir: 'C:/wt/lane-a', unit_branch: 'pl-r-u-J3' });
  appendOk(dir, 'join', { task: 'J3', event: 'started', base: 'abc', dir: 'C:/wt/lane-b', unit_branch: 'pl-r-u-J3' });
  appendOk(dir, 'join', { task: 'J2', event: 'started', base: 'abe', restart: true });
  assert.deepEqual(statusOf(dir).unit_branches, { J3: { branch: 'pl-r-u-J3', dir: 'C:/wt/lane-b' } });
});

test('a restart resets a done-then-blocked task', () => {
  const dir = freshDir();
  appendOk(dir, 'join', { task: 'J2', event: 'started', base: 'w0', unit_branch: 'pl-r-u-J2', dir: 'C:/wt/a' });
  appendOk(dir, 'join', { task: 'J2', event: 'committed', commits: ['h1'], base: 'w0', head: 'h1' });
  appendOk(dir, 'join', { task: 'J2', event: 'blocked', reason: 'review_rounds' });
  let s = statusOf(dir);
  assert.ok(s.done.includes('J2') && s.blocked.includes('J2'));
  appendOk(dir, 'join', { task: 'J2', event: 'started', base: 'tip', restart: true });
  s = statusOf(dir);
  assert.ok(!s.done.includes('J2'));
  assert.ok(!s.blocked.includes('J2'));
  assert.deepEqual(s.inconsistent, []);
  assert.equal(s.ranges.J2, undefined);
  appendOk(dir, 'join', { task: 'J2', event: 'committed', commits: ['h2'], base: 'tip', head: 'h2' });
  s = statusOf(dir);
  assert.deepEqual(s.ranges.J2, { base: 'tip', head: 'h2' });
  assert.deepEqual(s.inconsistent, []);
});

test('a restart at a new base is not a start mismatch', () => {
  const dir = freshDir();
  appendOk(dir, 'join', { task: 'J2', event: 'started', base: 'w0' });
  appendOk(dir, 'join', { task: 'J2', event: 'committed', commits: ['h1'], base: 'w0', head: 'h1' });
  appendOk(dir, 'join', { task: 'J2', event: 'started', base: 'other', restart: true });
  assert.deepEqual(statusOf(dir).inconsistent, []);
  const plain = freshDir();
  appendOk(plain, 'join', { task: 'J2', event: 'started', base: 'w0' });
  appendOk(plain, 'join', { task: 'J2', event: 'committed', commits: ['h1'], base: 'w0', head: 'h1' });
  appendOk(plain, 'join', { task: 'J2', event: 'started', base: 'other' });
  assert.equal(statusOf(plain).inconsistent.length, 1, 'without restart it is still a mismatch');
});

test('wave_merges lists merge events in order', () => {
  const dir = freshDir();
  appendOk(dir, '_run', { task: '_run', event: 'wave_merged', wave: 2, units: ['J2', 'J3'], head: 'm2',
    overlaps: [{ path: 'a', units: ['J2', 'J3'] }], conflict_files: [] });
  appendOk(dir, '_run', { task: '_run', event: 'wave_checked', wave: 2, head: 'm2', ok: true });
  appendOk(dir, '_run', { task: '_run', event: 'wave_merged', recovery: true, units: ['J4'], head: 'm3' });
  assert.deepEqual(statusOf(dir).wave_merges, [
    { wave: 2, units: ['J2', 'J3'], head: 'm2', overlaps: [{ path: 'a', units: ['J2', 'J3'] }], conflict_files: [] },
    { recovery: true, units: ['J4'], head: 'm3', overlaps: [], conflict_files: [] },
  ]);
});

test('backfill continues past an unfinished wave unit', () => {
  const c = joinCase(['A', 'B', 'C']);
  for (const [id, branch] of [['A', 'pl-r-u-A'], ['B', 'pl-r-u-B'], ['C', 'pl-r-u-C']]) {
    appendOk(c.ledger, 'join', { task: id, event: 'started', base: c.w, dir: 'C:/wt/x', unit_branch: branch });
  }
  const a = unitCommit(c, 'pl-r-u-A', c.w, 'A', 'a.txt');
  const cc = unitCommit(c, 'pl-r-u-C', c.w, 'C', 'c.txt');
  const out = backfillOf(c);
  assert.equal(out.code, 0, JSON.stringify(out.errors));
  assert.deepEqual(out.backfill, { A: { base: c.w, head: a }, C: { base: c.w, head: cc } });
});

test('backfill keeps chaining a serial join', () => {
  const c = joinCase(['A', 'B', 'C']);
  const a = unitCommit(c, 'feat', c.w, 'A', 'a.txt');
  unitCommit(c, 'side', a, 'C', 'c.txt');
  const out = backfillOf(c);
  assert.equal(out.code, 0, JSON.stringify(out.errors));
  assert.deepEqual(out.backfill, { A: { base: c.w, head: a } });
  assert.equal(out.join_tip, a);
});

test('join_tip is the descendant of wave and serial heads', () => {
  const c = joinCase(['A', 'B', 'D']);
  for (const [id, branch] of [['A', 'pl-r-u-A'], ['B', 'pl-r-u-B']]) {
    appendOk(c.ledger, 'join', { task: id, event: 'started', base: c.w, dir: 'C:/wt/x', unit_branch: branch });
  }
  const a = unitCommit(c, 'pl-r-u-A', c.w, 'A', 'a.txt');
  const b = unitCommit(c, 'pl-r-u-B', c.w, 'B', 'b.txt');
  git(c.repo, 'checkout', '-q', 'feat');
  git(c.repo, 'merge', '-q', '--no-ff', '-m', 'join wave 1: merge A', a);
  git(c.repo, 'merge', '-q', '--no-ff', '-m', 'join wave 1: merge B', b);
  const m = git(c.repo, 'rev-parse', 'HEAD');
  appendOk(c.ledger, '_run', { task: '_run', event: 'wave_merged', wave: 1, units: ['A', 'B'], head: m });
  appendOk(c.ledger, 'join', { task: 'D', event: 'started', base: m });
  const d = unitCommit(c, 'feat', m, 'D', 'd.txt');
  const out = backfillOf(c);
  assert.equal(out.code, 0, JSON.stringify(out.errors));
  assert.equal(out.join_tip, d);
  assert.deepEqual(out.backfill.D, { base: m, head: d });
});

test('join_tip refuses unordered heads', () => {
  const c = joinCase(['A', 'D']);
  appendOk(c.ledger, 'join', { task: 'A', event: 'started', base: c.w, dir: 'C:/wt/x', unit_branch: 'pl-r-u-A' });
  const a = unitCommit(c, 'pl-r-u-A', c.w, 'A', 'a.txt');
  git(c.repo, 'checkout', '-q', 'feat');
  git(c.repo, 'merge', '-q', '--no-ff', '-m', 'join wave 1: merge A', a);
  const m = git(c.repo, 'rev-parse', 'HEAD');
  appendOk(c.ledger, '_run', { task: '_run', event: 'wave_merged', wave: 1, units: ['A'], head: m });
  appendOk(c.ledger, 'join', { task: 'D', event: 'started', base: c.w });
  unitCommit(c, 'other', c.w, 'D', 'd.txt');
  const out = backfillOf(c);
  assert.equal(out.code, 3);
  assert.ok(out.errors.some((e) => /^join_tip: heads \S+ and \S+ do not descend from one another$/.test(e)),
    JSON.stringify(out.errors));
  assert.equal(out.join_tip, null);
});

test('no join work gives join_tip null', () => {
  const c = joinCase(['A']);
  const out = backfillOf(c);
  assert.equal(out.code, 0);
  assert.equal(out.join_tip, null);
});

test('start_bases lists the latest started base of each task not done', () => {
  const dir = freshDir();
  appendOk(dir, 'join', { task: 'J1', event: 'started', base: 'a1' });
  appendOk(dir, 'join', { task: 'J2', event: 'started', base: 'b1' });
  appendOk(dir, 'join', { task: 'J2', event: 'committed', commits: ['b2'], base: 'b1', head: 'b2' });
  appendOk(dir, 'join', { task: 'J3', event: 'started', base: 'c1', unit_branch: 'pl-r-u-J3', dir: 'C:/wt/a' });
  appendOk(dir, 'join', { task: 'J3', event: 'started', base: 'c2', restart: true });
  assert.deepEqual(statusOf(dir).start_bases, { J1: 'a1', J3: 'c2' });
});
