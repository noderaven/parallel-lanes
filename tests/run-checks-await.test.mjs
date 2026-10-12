// scripts/run-checks: tree_changed (a content fingerprint taken before the
// first command and after the last), the check-file lock on --out (held from
// validation to the report, skipped with --lock-held), the atomic --out write,
// and the error record a failure after validation leaves in --out. Every test
// runs the real script against a real git repo, except the fingerprint seam
// test, which loads run-checks as a module.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { IS_WINDOWS, SYMLINKS, tempDir } from './platform.mjs';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const RUN_CHECKS = join(SCRIPTS, 'run-checks');
const TMP = realpathSync(tempDir('pl-run-checks-await-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid',
  // A scratch directory under TMP is never taken for part of an outer repo.
  GIT_CEILING_DIRECTORIES: TMP,
};
// TMPDIR keeps run-checks' temporary log directory inside TMP.
const ENV = { ...process.env, ...GIT_ENV, TMPDIR: TMP };
const REAL_PYTHON = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout.trim();

function git(dir, ...args) {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: ENV });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout;
}

let counter = 0;
// A fresh directory under TMP whose name holds a space.
function fresh(name) {
  counter += 1;
  const dir = join(TMP, `${name} ${counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// A repo with one commit holding a.txt.
function repo() {
  const dir = fresh('repo');
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

function runChecks(args, env = ENV) {
  return spawnSync('python3', [RUN_CHECKS, ...args], { encoding: 'utf8', env });
}

// The JSON line of a run that exited with code.
function reportOf(res, code = 0) {
  assert.equal(res.status, code, `${res.stdout}\n${res.stderr}`);
  return JSON.parse(res.stdout);
}

// Runs one command in dir and returns the report.
function runOne(dir, command) {
  return reportOf(runChecks([dir, '--cmd', 'test', command]));
}

// Whether a writer holds the check-file lock of file now (_await.writer_alive).
function writerAlive(file) {
  const code = [
    'import json, sys',
    'sys.dont_write_bytecode = True',
    `sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`,
    'import _await',
    'print(json.dumps(_await.writer_alive(sys.argv[1])))',
  ].join('\n');
  const res = spawnSync('python3', ['-c', code, file], { encoding: 'utf8', env: ENV });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

// Starts run-checks in the background; closed resolves to { status, stdout, stderr }.
function startChecks(args) {
  const child = spawn('python3', [RUN_CHECKS, ...args], { env: ENV });
  let stdout = '';
  let stderr = '';
  const state = { exited: false };
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const closed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (status) => { state.exited = true; resolve({ status, stdout, stderr }); });
  });
  return { child, closed, state };
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

// The error record run-checks left in file.
function errorRecord(file) {
  const text = readFileSync(file, 'utf8');
  assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'), JSON.stringify(text));
  const record = JSON.parse(text);
  assert.deepEqual(Object.keys(record).sort(), ['error', 'ok', 'results']);
  assert.deepEqual(record.results, []);
  assert.equal(record.ok, false);
  assert.equal(typeof record.error, 'string');
  return record;
}

// ---- tree_changed ----

test('tree_changed is false when nothing changes', () => {
  const dir = repo();
  writeFileSync(join(dir, 'a.txt'), 'edited\n');
  writeFileSync(join(dir, 'u.txt'), 'u\n');
  const report = runOne(dir, 'true');
  assert.equal(report.tree_changed, false);
  assert.equal(report.ok, true);
});

test('tree_changed is true when a command edits an already-modified file', () => {
  const dir = repo();
  writeFileSync(join(dir, 'a.txt'), 'edited\n');
  const report = runOne(dir, 'echo more >> a.txt');
  // The porcelain snapshots cannot see this edit (m1a I7); the fingerprint can.
  assert.deepEqual(report.tracked_before, [' M a.txt']);
  assert.deepEqual(report.tracked_after, report.tracked_before);
  assert.equal(report.tree_changed, true);
});

test('tree_changed is true when a command creates an untracked file', () => {
  const report = runOne(repo(), 'echo x > new.txt');
  assert.deepEqual(report.untracked_after, ['?? new.txt']);
  assert.equal(report.tree_changed, true);
});

test('tree_changed handles binary untracked files and names with spaces and non-ASCII', () => {
  const dir = repo();
  // Built from char codes so this file stays ASCII.
  const unicode = `caf${String.fromCharCode(0xe9)} n${String.fromCharCode(0xe4)}me.txt`;
  writeFileSync(join(dir, 'bin file.dat'), Buffer.from([0, 1, 2, 255, 0, 10, 13, 0]));
  writeFileSync(join(dir, unicode), 'x\n');
  mkdirSync(join(dir, 'sub dir'));
  writeFileSync(join(dir, 'sub dir', 'y z.bin'), Buffer.from([255, 254, 0]));
  // Stable over a run that changes nothing: never null, never a false change.
  assert.equal(runOne(dir, 'true').tree_changed, false);
  assert.equal(runOne(dir, "printf '\\001' >> 'bin file.dat'").tree_changed, true);
  assert.equal(runOne(dir, "printf '\\001' >> 'sub dir/y z.bin'").tree_changed, true);
  // node reads the escape, so the command line itself stays ASCII.
  assert.equal(runOne(dir, `node -e "require('fs').appendFileSync('caf\\u00e9 n\\u00e4me.txt', 'y')"`).tree_changed, true);
  assert.equal(readFileSync(join(dir, unicode), 'utf8'), 'x\ny');
  assert.equal(runOne(dir, 'true').tree_changed, false);
});

test('tree_changed is not null with an untracked nested repository or symlinks', { skip: !SYMLINKS && 'symlinks unavailable' }, () => {
  const dir = repo();
  // git ls-files --others lists a nested repository as "nested/", which
  // git hash-object cannot hash; nor can it hash a dangling symlink or one to
  // a directory.
  mkdirSync(join(dir, 'nested'));
  git(join(dir, 'nested'), 'init', '-q');
  writeFileSync(join(dir, 'nested', 'f.txt'), 'x\n');
  symlinkSync(join(dir, 'nowhere'), join(dir, 'dangling'));
  mkdirSync(join(dir, 'target dir'));
  writeFileSync(join(dir, 'target dir', 't.txt'), 't\n');
  symlinkSync(join(dir, 'target dir'), join(dir, 'dir link'), 'dir');
  assert.equal(runOne(dir, 'true').tree_changed, false);
  assert.equal(runOne(dir, 'echo y >> new.txt').tree_changed, true);
});

test('tree_changed is null when a fingerprint fails', () => {
  const plain = fresh('not a checkout');
  const dir = repo();
  const code = [
    'import importlib.machinery, importlib.util, json, sys',
    'sys.dont_write_bytecode = True',
    "loader = importlib.machinery.SourceFileLoader('run_checks', sys.argv[1])",
    'mod = importlib.util.module_from_spec(importlib.util.spec_from_loader(loader.name, loader))',
    'loader.exec_module(mod)',
    'print(json.dumps({',
    "    'plain': mod.fingerprint(sys.argv[2]),",
    "    'repo': mod.fingerprint(sys.argv[3]),",
    "    'changed': [mod.tree_changed(None, 'a'), mod.tree_changed('a', None), mod.tree_changed(None, None),",
    "                mod.tree_changed('a', 'a'), mod.tree_changed('a', 'b')],",
    '}))',
  ].join('\n');
  const res = spawnSync('python3', ['-c', code, RUN_CHECKS, plain, dir], { encoding: 'utf8', env: ENV });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.plain, null);
  assert.match(out.repo, /^[0-9a-f]{64}$/);
  assert.deepEqual(out.changed, [null, null, null, false, true]);
});

test('tree_changed is false in the --descends-from early report', () => {
  const dir = repo();
  const res = runChecks([dir, '--descends-from', '0000000', '--cmd', 'test', 'echo x > new.txt']);
  const report = reportOf(res, 1);
  assert.deepEqual(report.results, []);
  assert.equal(report.tree_changed, false);
  assert.equal(existsSync(join(dir, 'new.txt')), false);
});

// ---- the check-file lock ----

test('run-checks holds the lock for the whole run', async () => {
  const dir = repo();
  const out = join(fresh('lock'), 'task-1.1.json');
  writeFileSync(out, '');
  const run = startChecks([dir, '--out', out, '--cmd', 'test', 'sleep 2']);
  let alive = false;
  const deadline = Date.now() + 30000;
  while (!alive && !run.state.exited && Date.now() < deadline) {
    if (existsSync(out + '.lock')) alive = writerAlive(out);
    await tick();
  }
  const res = await run.closed;
  assert.equal(alive, true, 'writer_alive was true during the run');
  assert.equal(res.status, 0, res.stderr);
  assert.equal(existsSync(out + '.lock'), false, 'the sidecar is gone');
  assert.equal(writerAlive(out), false);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), JSON.parse(res.stdout));
});

test('--lock-held takes no lock', async () => {
  const dir = repo();
  const out = join(fresh('lock held'), 'task-1.1.json');
  writeFileSync(out, '');
  const run = startChecks([dir, '--out', out, '--lock-held', '--cmd', 'test', 'sleep 1']);
  let polls = 0;
  let seen = false;
  while (!run.state.exited) {
    seen = seen || existsSync(out + '.lock');
    polls += 1;
    await tick();
  }
  const res = await run.closed;
  assert.equal(res.status, 0, res.stderr);
  assert.ok(polls > 5, `polled ${polls} times`);
  assert.equal(seen, false, 'no sidecar during the run');
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).ok, true);
});

test('--out is written atomically', async () => {
  const dir = repo();
  const out = join(fresh('atomic'), 'task-1.1.json');
  writeFileSync(out, '');
  // Twenty commands with a 4 KB tail each make a report of about 90 KB.
  const cmds = [];
  for (let n = 1; n <= 20; n += 1) cmds.push('--cmd', `t${n}`, "printf '%04100d\\n' 0");
  const run = startChecks([dir, '--out', out, ...cmds]);
  let reads = 0;
  let last = '';
  for (;;) {
    const exited = run.state.exited;
    let text;
    try {
      text = readFileSync(out, 'utf8');
    } catch (e) {
      // A read that meets the replace itself is no read at all.
      if (['ENOENT', 'EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { await tick(1); continue; }
      throw e;
    }
    reads += 1;
    if (text !== '') {
      assert.ok(text.endsWith('\n') && text.indexOf('\n') === text.length - 1, `a partial report: ${text.length} chars`);
      JSON.parse(text);
    }
    last = text;
    if (exited) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  const res = await run.closed;
  assert.equal(res.status, 0, res.stderr);
  assert.ok(reads > 10, `read ${reads} times`);
  assert.equal(last, res.stdout);
  assert.ok(last.length > 80000, `report of ${last.length} chars`);
});

// ---- error records ----

test('a failure after validation leaves an error record: no bash', { skip: !IS_WINDOWS && !SYMLINKS && 'symlinks unavailable' }, () => {
  const dir = repo();
  const out = join(fresh('no bash'), 'task-1.1.json');
  writeFileSync(out, '');
  let python = 'python3';
  let env = { ...ENV, CLAUDE_CODE_GIT_BASH_PATH: join(TMP, 'no-such-bash.exe') };
  if (!IS_WINDOWS) {
    // PATH holds only python3: no bash can be found on it.
    const bin = fresh('python only');
    python = join(bin, 'python3');
    symlinkSync(REAL_PYTHON, python);
    env = { ...ENV, PATH: bin };
  }
  const res = spawnSync(python, [RUN_CHECKS, dir, '--out', out, '--cmd', 'test', 'true'], { encoding: 'utf8', env });
  assert.equal(res.status, 3, res.stderr);
  assert.equal(res.stdout, '');
  assert.doesNotMatch(res.stderr, /Traceback/);
  assert.match(errorRecord(out).error, /CLAUDE_CODE_GIT_BASH_PATH/);
  assert.equal(existsSync(out + '.lock'), false);
});

test('a failure after validation leaves an error record: not a checkout', () => {
  const plain = fresh('plain');
  const out = join(fresh('not a checkout'), 'task-1.1.json');
  const res = runChecks([plain, '--out', out, '--cmd', 'test', 'true']);
  assert.equal(res.status, 3, res.stderr);
  assert.equal(res.stdout, '');
  assert.match(errorRecord(out).error, /not a git checkout/);
  assert.equal(existsSync(out + '.lock'), false);
});

test('a failure after validation leaves an error record: a log outside the root', { skip: !SYMLINKS && 'symlinks unavailable' }, () => {
  const dir = repo();
  const root = fresh('root');
  const out = join(root, 'checks', 'task-1.1.json');
  mkdirSync(dirname(out));
  const elsewhere = join(fresh('elsewhere'), 'x.log');
  writeFileSync(elsewhere, '');
  symlinkSync(elsewhere, join(root, 'checks', 'task-1.1.1.log'));
  const res = runChecks([dir, '--out', out, '--root', root, '--cmd', 'test', 'true']);
  assert.equal(res.status, 3, res.stderr);
  assert.match(errorRecord(out).error, /log path .* is outside/);
  assert.equal(readFileSync(elsewhere, 'utf8'), '');
});

test('with --lock-held a failure leaves no error record', () => {
  const plain = fresh('plain held');
  const out = join(fresh('held failure'), 'task-1.1.json');
  writeFileSync(out, '');
  const res = runChecks([plain, '--out', out, '--lock-held', '--cmd', 'test', 'true']);
  assert.equal(res.status, 3, res.stderr);
  assert.equal(readFileSync(out, 'utf8'), '');
});

test('a usage error before validation writes nothing', () => {
  const dir = repo();
  const folder = fresh('usage');
  const out = join(folder, 'task-1.1.json');
  // A --cmd without its command.
  let res = runChecks([dir, '--out', out, '--cmd', 'test']);
  assert.equal(res.status, 2, res.stderr);
  assert.match(res.stderr, /usage: run-checks/);
  // FILE outside ROOT fails its own validation.
  res = runChecks([dir, '--out', out, '--root', fresh('other root'), '--cmd', 'test', 'true']);
  assert.equal(res.status, 3, res.stderr);
  assert.match(res.stderr, /is outside/);
  assert.equal(existsSync(out), false);
  assert.equal(existsSync(out + '.lock'), false);
});
