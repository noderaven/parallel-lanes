// scripts/await-checks: reserve a check's result file, and wait for the check
// that writes it (spec 4.2). Every test runs the real script with python3;
// writers are Python children that hold the check-file lock with
// _await.hold, as run-checks and task-checks do.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { IS_WINDOWS, SYMLINKS, mergeEnv, samePath, tempDir } from './platform.mjs';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const SCRIPT = join(SCRIPTS, 'await-checks');
const TMP = realpathSync(tempDir('pl-await-checks-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const PRELUDE = [
  'import json, os, sys, time',
  'sys.dont_write_bytecode = True',
  `sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`,
  'import _await, _shell',
  '',
].join('\n');

const env = (extra = {}) => mergeEnv(process.env, extra);

// Runs await-checks with args; returns { status, stdout, stderr }.
function run(args, extra = {}) {
  const res = spawnSync('python3', [SCRIPT, ...args], { encoding: 'utf8', env: env(extra) });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

// Starts await-checks with args in the background; resolves to
// { status, stdout, stderr } when it ends.
function runAsync(args, extra = {}) {
  const child = spawn('python3', [SCRIPT, ...args], { env: env(extra) });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

// Starts PRELUDE + code with args in the background; resolves once the child
// printed `ready` on stdout. closed resolves to { status, stdout, stderr }.
async function start(code, args = []) {
  const child = spawn('python3', ['-c', PRELUDE + code, ...args], { env: env() });
  let stdout = '';
  let stderr = '';
  let exited = false;
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const closed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (status) => { exited = true; resolve({ status, stdout, stderr }); });
  });
  const deadline = Date.now() + 60000;
  while (!stdout.includes('ready') && !exited && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!stdout.includes('ready')) {
    child.kill();
    assert.fail(`the child did not get ready: ${stderr}`);
  }
  return { child, closed };
}

function kill(child) {
  if (IS_WINDOWS) child.kill();
  else child.kill('SIGKILL');
}

// A child that holds the check-file lock of sys.argv[1] until its stdin closes.
const HOLDER = [
  'with _await.hold(sys.argv[1]):',
  "    print('ready', flush=True)",
  '    sys.stdin.read()',
].join('\n');

let counter = 0;
// A fresh ledger directory (its path holds a space).
function ledger(name = 'ledger') {
  counter += 1;
  const dir = join(TMP, `case ${counter}`, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// A fresh result file under a fresh ledger's checks/, with the given text.
function resultFile(text = '', name = 'task-1.1.json') {
  const dir = join(ledger(), 'checks');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, text);
  return file;
}

// The single JSON line on stdout, parsed.
function oneJson(stdout) {
  assert.match(stdout, /^[^\n]+\n$/, `not one line: ${JSON.stringify(stdout)}`);
  return JSON.parse(stdout);
}

// --- reserve ----------------------------------------------------------------

test('reserve numbers files from 1 and never reuses one', () => {
  const dir = ledger();
  const first = run(['reserve', '--ledger', dir, '--name', 'x']);
  const second = run(['reserve', '--ledger', dir, '--name', 'x']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.match(first.stdout, /^[^\n]+\n$/);
  assert.ok(samePath(first.stdout.trim(), join(dir, 'checks', 'x.1.json')), first.stdout);
  assert.ok(samePath(second.stdout.trim(), join(dir, 'checks', 'x.2.json')), second.stdout);
  for (const name of ['x.1.json', 'x.2.json']) {
    assert.equal(readFileSync(join(dir, 'checks', name), 'utf8'), '');
  }
});

test('concurrent reserves never share a path', async () => {
  const dir = ledger();
  const results = await Promise.all(
    Array.from({ length: 10 }, () => runAsync(['reserve', '--ledger', dir, '--name', 'integrate'])),
  );
  for (const res of results) assert.equal(res.status, 0, res.stderr);
  const paths = results.map((res) => res.stdout.trim());
  assert.equal(new Set(paths).size, 10, paths.join('\n'));
  assert.deepEqual(
    readdirSync(join(dir, 'checks')).sort(),
    Array.from({ length: 10 }, (_, i) => `integrate.${i + 1}.json`).sort(),
  );
});

test('reserve --exact empties an existing file', () => {
  const dir = ledger();
  mkdirSync(join(dir, 'checks'));
  const file = join(dir, 'checks', 'verify-abc.json');
  writeFileSync(file, '{"ok": true, "results": []}\n');
  const res = run(['reserve', '--ledger', dir, '--name', 'verify-abc', '--exact']);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(samePath(res.stdout.trim(), file), res.stdout);
  assert.equal(readFileSync(file, 'utf8'), '');
  // Also when the file does not exist yet.
  const fresh = run(['reserve', '--exact', '--name', 'verify-def', '--ledger', dir]);
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.equal(readFileSync(join(dir, 'checks', 'verify-def.json'), 'utf8'), '');
});

test('reserve --exact is busy while a writer holds the lock', async () => {
  const dir = ledger();
  mkdirSync(join(dir, 'checks'));
  const file = join(dir, 'checks', 'verify-abc.json');
  const old = '{"ok": false, "results": []}\n';
  writeFileSync(file, old);
  const holder = await start(HOLDER, [file]);
  let busy;
  try {
    busy = run(['reserve', '--ledger', dir, '--name', 'verify-abc', '--exact']);
  } finally {
    kill(holder.child);
    await holder.closed;
  }
  assert.equal(busy.status, 4, busy.stderr);
  const out = oneJson(busy.stdout);
  assert.deepEqual(Object.keys(out), ['status', 'file']);
  assert.equal(out.status, 'busy');
  assert.ok(samePath(out.file, file), out.file);
  assert.equal(readFileSync(file, 'utf8'), old, 'a busy reserve writes nothing');
  // The killed writer left its sidecar behind (Review Focus 2).
  assert.ok(existsSync(file + '.lock'), 'the stale sidecar is still there');
  const again = run(['reserve', '--ledger', dir, '--name', 'verify-abc', '--exact']);
  assert.equal(again.status, 0, again.stderr);
  assert.ok(samePath(again.stdout.trim(), file), again.stdout);
  assert.equal(readFileSync(file, 'utf8'), '');
});

test('reserve refuses an unsafe name or a path outside the ledger', () => {
  for (const name of ['../x', 'a/b', 'a\\b', '.hidden', '', 'x\n', '-x']) {
    const dir = ledger();
    for (const exact of [[], ['--exact']]) {
      const res = run(['reserve', '--ledger', dir, '--name', name, ...exact]);
      assert.equal(res.status, 2, `${JSON.stringify(name)}: ${res.stderr}`);
      assert.equal(res.stdout, '');
    }
    assert.deepEqual(readdirSync(dir), [], `${JSON.stringify(name)} wrote nothing`);
  }
  for (const bad of [['--name', 'x'], ['--ledger', ledger()], ['--ledger', ledger(), '--name', 'x', '--bogus'],
    ['--ledger', join(TMP, 'missing ledger'), '--name', 'x']]) {
    const res = run(['reserve', ...bad]);
    assert.equal(res.status, 2, `${bad.join(' ')}: ${res.stderr}`);
  }
  assert.equal(existsSync(join(TMP, 'missing ledger')), false);
});

test('reserve refuses a checks directory that points outside the ledger', { skip: !SYMLINKS && 'symlinks unavailable' }, () => {
  const dir = ledger();
  const outside = join(dir, '..', 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(dir, 'checks'), 'junction');
  for (const exact of [[], ['--exact']]) {
    const res = run(['reserve', '--ledger', dir, '--name', 'x', ...exact]);
    assert.equal(res.status, 2, res.stderr);
    assert.equal(res.stdout, '');
  }
  assert.deepEqual(readdirSync(outside), [], 'nothing was written outside the ledger');
});

test('reserve refuses a result path that is a symlink', { skip: !SYMLINKS && 'symlinks unavailable' }, () => {
  const dir = ledger();
  mkdirSync(join(dir, 'checks'));
  const target = join(dir, 'target.json');
  writeFileSync(target, 'keep\n');
  symlinkSync(target, join(dir, 'checks', 'verify-abc.json'));
  const res = run(['reserve', '--ledger', dir, '--name', 'verify-abc', '--exact']);
  assert.equal(res.status, 2, res.stderr);
  assert.equal(readFileSync(target, 'utf8'), 'keep\n');
});

test('reserve accepts a ledger path with a space and a /c/ form', () => {
  const dir = ledger('my ledger');
  const given = IS_WINDOWS ? dir.replace(/^([A-Za-z]):\\/, (_, d) => `/${d.toLowerCase()}/`).replace(/\\/g, '/') : dir;
  if (IS_WINDOWS) assert.match(given, /^\/[a-z]\//);
  const res = run(['reserve', '--ledger', given, '--name', 'integrate']);
  assert.equal(res.status, 0, res.stderr);
  const printed = res.stdout.trim();
  if (IS_WINDOWS) assert.match(printed, /^[A-Z]:\/[^\\]*$/, printed);
  assert.ok(samePath(printed, join(dir, 'checks', 'integrate.1.json')), printed);
  assert.equal(readFileSync(join(dir, 'checks', 'integrate.1.json'), 'utf8'), '');
});

// --- wait -------------------------------------------------------------------

test('wait returns a complete ok report as printed', () => {
  const line = '{"checkout": "C:/x y", "results": [], "ok": true, "clean": true}';
  const file = resultFile(line + '\n');
  const res = run(['wait', file]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, line + '\n');
  assert.equal(res.stderr, '');
});

test('wait returns a failed report with exit 1', () => {
  const line = '{"results": [{"exit": 1}], "ok": false}';
  const res = run(['wait', resultFile(line + '\n')]);
  assert.equal(res.status, 1, res.stderr);
  assert.equal(res.stdout, line + '\n');
});

test('wait returns an error record with exit 3', () => {
  const line = '{"results": [], "ok": false, "error": "not a git checkout"}';
  const res = run(['wait', resultFile(line + '\n')]);
  assert.equal(res.status, 3, res.stderr);
  assert.equal(res.stdout, line + '\n');
});

test('wait says running at --max', async () => {
  const file = resultFile('');
  const holder = await start(HOLDER, [file]);
  let res;
  try {
    res = run(['wait', file, '--max', '3']);
  } finally {
    holder.child.stdin.end();
    await holder.closed;
  }
  assert.equal(res.status, 4, res.stderr);
  const out = oneJson(res.stdout);
  assert.deepEqual(Object.keys(out), ['status', 'file', 'waited_s']);
  assert.equal(out.status, 'running');
  assert.ok(samePath(out.file, file), out.file);
  assert.ok(Number.isInteger(out.waited_s) && out.waited_s >= 3, JSON.stringify(out));
});

test('wait treats a slow start as running inside the grace', () => {
  const file = resultFile('');
  const old = Date.now() / 1000 - 50;
  utimesSync(file, old, old);
  const res = run(['wait', file, '--max', '3']);
  assert.equal(res.status, 4, res.stderr);
  assert.equal(oneJson(res.stdout).status, 'running');
  assert.equal(existsSync(file + '.lock'), false, 'wait made no sidecar');
});

test('wait says not_started after the grace', () => {
  const file = resultFile('');
  const old = Date.now() / 1000 - 120;
  utimesSync(file, old, old);
  const res = run(['wait', file, '--max', '30'], { AWAIT_CHECKS_GRACE_S: '1' });
  assert.equal(res.status, 5, res.stderr);
  const out = oneJson(res.stdout);
  assert.deepEqual(Object.keys(out), ['status', 'file', 'reason']);
  assert.equal(out.status, 'stopped');
  assert.equal(out.reason, 'not_started');
  assert.ok(samePath(out.file, file), out.file);
});

test('wait says died after a killed writer', async () => {
  const file = resultFile('');
  const holder = await start(HOLDER, [file]);
  // This waiter sees the lock held, then the writer dies.
  const waiting = runAsync(['wait', file, '--max', '60'], { AWAIT_CHECKS_GRACE_S: '1' });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  kill(holder.child);
  await holder.closed;
  const res = await waiting;
  assert.equal(res.status, 5, res.stderr);
  const out = oneJson(res.stdout);
  assert.equal(out.status, 'stopped');
  assert.equal(out.reason, 'died');
  assert.ok(samePath(out.file, file), out.file);
  // A waiter that never saw the writer still says died: its sidecar is left.
  assert.ok(existsSync(file + '.lock'), 'the killed writer left its sidecar');
  const later = run(['wait', file, '--max', '30'], { AWAIT_CHECKS_GRACE_S: '1' });
  assert.equal(later.status, 5, later.stderr);
  assert.equal(oneJson(later.stdout).reason, 'died');
});

test('wait does not return a report while its writer still holds the lock', async () => {
  const file = resultFile('');
  const writer = await start([
    'with _await.hold(sys.argv[1]):',
    "    _shell.write_text_atomic(sys.argv[1], json.dumps({'results': [], 'ok': True}) + '\\n')",
    "    print('ready', flush=True)",
    '    time.sleep(2)',
    "    _shell.write_text_atomic(sys.argv[1], json.dumps({'results': [], 'ok': True, 'policy': {'selected': 'targeted'}}) + '\\n')",
  ].join('\n'), [file]);
  const res = run(['wait', file, '--max', '30']);
  const done = await writer.closed;
  assert.equal(done.status, 0, done.stderr);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(oneJson(res.stdout).policy, { selected: 'targeted' });
});

test('wait warns on tree_changed', () => {
  const line = '{"results": [], "ok": true, "clean": false, "tree_changed": true}';
  const res = run(['wait', resultFile(line + '\n')]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, line + '\n');
  assert.equal(res.stderr, 'await-checks: the checkout changed while the checks ran; rerun them\n');
  const quiet = run(['wait', resultFile('{"results": [], "ok": true, "tree_changed": false}\n')]);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(quiet.stderr, '');
});

test('wait checks --max bounds', () => {
  const file = resultFile('{"results": [], "ok": true}\n');
  for (const max of ['0', '571', 'abc', '-1', '2.5', '']) {
    const res = run(['wait', file, '--max', max]);
    assert.equal(res.status, 2, `--max ${max}: ${res.stderr}`);
    assert.equal(res.stdout, '');
  }
  for (const args of [[], ['--max', '5'], [file, '--max'], [file, '--bogus']]) {
    const res = run(['wait', ...args]);
    assert.equal(res.status, 2, `${args.join(' ')}: ${res.stderr}`);
  }
  assert.equal(run(['bogus']).status, 2);
  assert.equal(run([]).status, 2);
  assert.equal(run(['wait', file, '--max', '1']).status, 0);
  assert.equal(run(['wait', file, '--max', '570']).status, 0);
});

test('wait returns a complete report beside a stale sidecar', () => {
  // The writer crashed after its replace and before deleting the sidecar.
  const line = '{"results": [], "ok": true}';
  const file = resultFile(line + '\n');
  writeFileSync(file + '.lock', '');
  const res = run(['wait', file, '--max', '3']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, line + '\n');
});

test('wait says anything else is an error once the grace has passed', () => {
  const file = resultFile('not json\n');
  const res = run(['wait', file, '--max', '30'], { AWAIT_CHECKS_GRACE_S: '1' });
  assert.equal(res.status, 3, res.stderr);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /^await-checks: /);
});

test('a writer can replace FILE while wait polls it', { skip: !IS_WINDOWS && 'Windows only' }, async () => {
  const file = resultFile('');
  const waiting = runAsync(['wait', file, '--max', '60']);
  const writer = await start([
    'errors = []',
    'with _await.hold(sys.argv[1]):',
    "    print('ready', flush=True)",
    '    for i in range(20):',
    '        try:',
    "            _shell.write_text_atomic(sys.argv[1], json.dumps({'results': [], 'ok': True, 'n': i, 'pad': 'x' * 4000}) + '\\n')",
    '        except Exception as e:',
    '            errors.append(type(e).__name__ + ": " + str(e))',
    '        time.sleep(0.2)',
    "    _shell.write_text_atomic(sys.argv[1], json.dumps({'results': [], 'ok': True, 'n': 20}) + '\\n')",
    "print(json.dumps({'errors': errors[:5]}))",
  ].join('\n'), [file]);
  const done = await writer.closed;
  const res = await waiting;
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(JSON.parse(done.stdout.split('\n').filter(Boolean).pop()), { errors: [] });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(oneJson(res.stdout).n, 20);
  assert.ok(statSync(file).size > 0);
});
