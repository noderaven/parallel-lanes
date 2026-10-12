// scripts/_oslock.py, scripts/_await.py and _shell.write_text_atomic: the OS
// lock shared with the history index, the check-file lock (a sidecar
// <FILE>.lock held by the writer of FILE), and the atomic report write. Each
// test drives Python with spawn or spawnSync, scripts/ on sys.path.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR, holdLock } from './harness.mjs';
import { IS_WINDOWS, mergeEnv, tempDir } from './platform.mjs';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const TMP = realpathSync(tempDir('pl-await-lock-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const PRELUDE = [
  'import json, os, sys, time',
  'sys.dont_write_bytecode = True',
  `sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`,
  'import _await, _history, _oslock, _shell',
  'def attempt(f):',
  '    try:',
  "        return {'ok': f()}",
  '    except Exception as e:',
  "        return {'error': type(e).__name__, 'message': str(e)}",
  '',
].join('\n');

// The environment without the history variables a developer may have set.
function cleanEnv() {
  const env = mergeEnv(process.env);
  for (const key of Object.keys(env)) {
    if (['PL_HISTORY_DIR', 'CLAUDE_CONFIG_DIR'].includes(key.toUpperCase())) delete env[key];
  }
  return env;
}

// Runs PRELUDE + code with args; code prints one JSON value, returned parsed.
function py(code, args = []) {
  const res = spawnSync('python3', ['-c', PRELUDE + code, ...args], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(res.status, 0, `python failed: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

// Starts PRELUDE + code with args in the background; resolves once the child
// printed `ready` on stdout. close() resolves to { status, stdout, stderr }.
async function start(code, args = [], ready = 'ready') {
  const child = spawn('python3', ['-c', PRELUDE + code, ...args], { env: cleanEnv() });
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
  while (!stdout.includes(ready) && !exited && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!stdout.includes(ready)) {
    child.kill();
    assert.fail(`the child did not get ready: ${stderr}`);
  }
  return { child, closed };
}

let counter = 0;
function freshDir(name) {
  counter += 1;
  const dir = join(TMP, `${name} ${counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// A child that holds the check-file lock of sys.argv[1] until its stdin closes.
const HOLDER = [
  'with _await.hold(sys.argv[1]):',
  "    print('ready', flush=True)",
  '    sys.stdin.read()',
].join('\n');

const ALIVE = 'print(json.dumps(_await.writer_alive(sys.argv[1])))';

test('history index lock still excludes a second holder after the move', async () => {
  const hdir = freshDir('history');
  const holder = await holdLock(hdir);
  try {
    const out = py([
      'second = attempt(lambda: _history.index_lock(sys.argv[1], wait_s=0).__enter__())',
      "moved = not any(hasattr(_history, n) for n in ('_try_lock', '_unlock', '_held', '_WIN_LOCK_OFFSET'))",
      "print(json.dumps({'second': second, 'moved': moved, 'offset': _oslock.WIN_LOCK_OFFSET}))",
    ].join('\n'), [hdir]);
    assert.equal(out.second.error, 'HistoryError', JSON.stringify(out.second));
    assert.match(out.second.message, /index\.lock is held by another process/);
    assert.equal(out.moved, true, '_history uses _oslock instead of its own copies');
    assert.equal(out.offset, 2 ** 30);
  } finally {
    await holder.release();
  }
  const free = py('print(json.dumps(attempt(lambda: _history.index_lock(sys.argv[1], wait_s=5).__enter__() and True)))', [hdir]);
  assert.deepEqual(free, { ok: true });
});

test('hold creates the sidecar, writer_alive is true while held and false after, and the sidecar is gone', async () => {
  const file = join(freshDir('hold'), 'task-1.1.json');
  writeFileSync(file, '');
  assert.equal(py('print(json.dumps(_await.SIDECAR))'), '.lock');
  const holder = await start(HOLDER, [file]);
  try {
    assert.ok(existsSync(file + '.lock'), 'hold created the sidecar');
    assert.equal(py(ALIVE, [file]), true);
  } finally {
    holder.child.stdin.end();
  }
  const res = await holder.closed;
  assert.equal(res.status, 0, res.stderr);
  assert.equal(existsSync(file + '.lock'), false, 'hold deleted the sidecar');
  assert.equal(py(ALIVE, [file]), false);
});

test('writer_alive is false when no sidecar exists', () => {
  const file = join(freshDir('no sidecar'), 'task-1.1.json');
  writeFileSync(file, '');
  assert.equal(py(ALIVE, [file]), false);
  assert.equal(existsSync(file + '.lock'), false, 'writer_alive did not create the sidecar');
});

test('a waiter probe during hold does not make the writer fail', async () => {
  const dir = freshDir('probe');
  const file = join(dir, 'verify-abc.json');
  const stop = join(dir, 'stop');
  writeFileSync(file, '');
  // The waiter probes for at least 2 s and until the writer is done.
  const waiter = await start([
    "print('ready', flush=True)",
    'begin = time.monotonic()',
    'probes = 0',
    'errors = []',
    'while time.monotonic() - begin < 60 and (time.monotonic() - begin < 2 or not os.path.exists(sys.argv[2])):',
    '    try:',
    '        _await.writer_alive(sys.argv[1])',
    '        probes += 1',
    '    except Exception as e:',
    '        errors.append(type(e).__name__ + ": " + str(e))',
    "print(json.dumps({'probes': probes, 'errors': errors[:5]}))",
  ].join('\n'), [file, stop]);
  let writer;
  try {
    writer = py([
      'results = []',
      'for i in range(20):',
      '    def once():',
      '        with _await.hold(sys.argv[1]):',
      '            time.sleep(0.02)',
      '        return True',
      '    results.append(attempt(once))',
      'print(json.dumps(results))',
    ].join('\n'), [file]);
  } finally {
    writeFileSync(stop, '');
  }
  const res = await waiter.closed;
  assert.equal(res.status, 0, res.stderr);
  const probe = JSON.parse(res.stdout.split('\n').filter(Boolean).pop());
  assert.deepEqual(writer, Array(20).fill({ ok: true }));
  assert.ok(probe.probes > 0, JSON.stringify(probe));
  assert.deepEqual(probe.errors, []);
});

test('a writer killed while holding frees the lock', async () => {
  const file = join(freshDir('killed'), 'task-2.1.json');
  writeFileSync(file, '');
  const holder = await start(HOLDER, [file]);
  assert.equal(py(ALIVE, [file]), true);
  if (IS_WINDOWS) holder.child.kill();
  else holder.child.kill('SIGKILL');
  await holder.closed;
  assert.equal(py(ALIVE, [file]), false);
  assert.ok(existsSync(file + '.lock'), 'the killed writer left its sidecar behind');
  // A later writer takes the lock despite the stale sidecar.
  const again = py([
    'def once():',
    '    with _await.hold(sys.argv[1]):',
    '        return True',
    'print(json.dumps(attempt(once)))',
  ].join('\n'), [file]);
  assert.deepEqual(again, { ok: true });
});

test('write_text_atomic replaces under a concurrent reader', { skip: !IS_WINDOWS && 'Windows only' }, async () => {
  const dir = freshDir('atomic');
  const file = join(dir, 'integrate.1.json');
  const stop = join(dir, 'stop');
  writeFileSync(file, '{"n": -1}\n');
  // The reader opens, reads and closes, as wait does on each poll; it records
  // any read that is not one complete line.
  const reader = await start([
    "print('ready', flush=True)",
    'begin = time.monotonic()',
    'reads = 0',
    'partial = []',
    'while time.monotonic() - begin < 60 and (time.monotonic() - begin < 2 or not os.path.exists(sys.argv[2])):',
    '    try:',
    "        with open(sys.argv[1], 'rb') as f:",
    '            data = f.read()',
    '    except OSError:',
    '        continue',
    '    reads += 1',
    '    try:',
    "        json.loads(data.decode('utf-8'))",
    '    except ValueError:',
    '        partial.append(repr(data[:40]))',
    "print(json.dumps({'reads': reads, 'partial': partial[:5]}))",
  ].join('\n'), [file, stop]);
  let writes;
  try {
    writes = py([
      'errors = []',
      'for i in range(200):',
      '    try:',
      "        _shell.write_text_atomic(sys.argv[1], json.dumps({'n': i, 'pad': 'x' * 4000}) + '\\n')",
      '    except Exception as e:',
      '        errors.append(type(e).__name__ + ": " + str(e))',
      "with open(sys.argv[1], 'rb') as f:",
      '    last = f.read()',
      "print(json.dumps({'errors': errors[:5], 'last': json.loads(last.decode('utf-8'))['n'], 'crlf': b'\\r' in last}))",
    ].join('\n'), [file]);
  } finally {
    writeFileSync(stop, '');
  }
  const res = await reader.closed;
  assert.equal(res.status, 0, res.stderr);
  const read = JSON.parse(res.stdout.split('\n').filter(Boolean).pop());
  assert.deepEqual(writes, { errors: [], last: 199, crlf: false });
  assert.ok(read.reads > 0, JSON.stringify(read));
  assert.deepEqual(read.partial, []);
});

test('write_text_atomic writes UTF-8 with LF line endings and leaves no temp file', () => {
  const dir = freshDir('atomic text');
  const file = join(dir, 'out.json');
  const out = py([
    "_shell.write_text_atomic(sys.argv[1], 'a\\nb \\u00e9\\n')",
    "_shell.write_text_atomic(sys.argv[1], 'c\\nd\\n')",
    "with open(sys.argv[1], 'rb') as f:",
    '    data = f.read()',
    "print(json.dumps({'data': data.decode('utf-8'), 'files': sorted(os.listdir(os.path.dirname(sys.argv[1])))}))",
  ].join('\n'), [file]);
  assert.deepEqual(out, { data: 'c\nd\n', files: ['out.json'] });
});

test('read_report is None for empty, partial and non-object files', () => {
  const dir = freshDir('read report');
  const cases = {
    empty: '',
    partial: '{"results": [{"ok": tr',
    list: '[1, 2]',
    number: '3',
    binary: Buffer.from([0xff, 0xfe, 0x00]),
    good: '{"results": [], "ok": true}\n',
  };
  for (const [name, text] of Object.entries(cases)) {
    writeFileSync(join(dir, name), text);
  }
  const out = py([
    'names = sys.argv[2:]',
    "print(json.dumps({n: _await.read_report(os.path.join(sys.argv[1], n)) for n in names}))",
  ].join('\n'), [dir, ...Object.keys(cases), 'missing']);
  assert.deepEqual(out, {
    empty: null, partial: null, list: null, number: null, binary: null, missing: null,
    good: { results: [], ok: true },
  });
});
