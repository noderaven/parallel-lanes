// scripts/_history.py and pl_history_dir in scripts/_paths.sh: where the run
// history lives, how a run is identified, and index.json with its lock. Each
// test runs a Python snippet with scripts/ on sys.path and reads its JSON
// output.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { BASH, IS_WINDOWS, lf, mergeEnv, tempDir } from './platform.mjs';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const PATHS = join(SCRIPTS, '_paths.sh');
const TMP = realpathSync(tempDir('pl-history-dir-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const PRELUDE = [
  'import json, os, sys',
  'sys.dont_write_bytecode = True',
  `sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`,
  'import _history, _shell',
  'def attempt(f):',
  '    try:',
  "        return {'ok': f()}",
  '    except Exception as e:',
  "        return {'error': type(e).__name__, 'message': str(e)}",
  '',
].join('\n');

// The environment without the history variables a developer may have set.
function cleanEnv(extra = {}) {
  const env = mergeEnv(process.env, extra);
  for (const key of Object.keys(env)) {
    if (['PL_HISTORY_DIR', 'CLAUDE_CONFIG_DIR'].includes(key.toUpperCase()) && !(key in extra)) delete env[key];
  }
  return env;
}

// Runs PRELUDE + code with args; code prints one JSON value, returned parsed
// with the stderr text.
function py(code, { args = [], env = {} } = {}) {
  const res = spawnSync('python3', ['-c', PRELUDE + code, ...args], { encoding: 'utf8', env: cleanEnv(env) });
  assert.equal(res.status, 0, `python failed: ${res.stderr}`);
  return { out: JSON.parse(res.stdout), stderr: lf(res.stderr) };
}

let counter = 0;
function freshDir(name) {
  counter += 1;
  const dir = join(TMP, `${name}-${counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('history_dir prefers the override, then PL_HISTORY_DIR, then the config dir', () => {
  const config = freshDir('config');
  const override = join(freshDir('override'), 'parallel-lanes', 'history');
  const fromEnv = join(freshDir('env'), 'parallel-lanes', 'history');
  const code = 'print(json.dumps(_history.history_dir(sys.argv[1] or None)))';
  const results = [
    py(code, { args: [override], env: { PL_HISTORY_DIR: fromEnv, CLAUDE_CONFIG_DIR: config } }).out,
    py(code, { args: [''], env: { PL_HISTORY_DIR: fromEnv, CLAUDE_CONFIG_DIR: config } }).out,
    py(code, { args: [''], env: { CLAUDE_CONFIG_DIR: config } }).out,
  ];
  const expected = [override, fromEnv, join(config, 'parallel-lanes', 'history')];
  results.forEach((got, i) => {
    assert.ok(got.endsWith('/parallel-lanes/history'), got);
    assert.ok(!got.includes('\\'), got);
    assert.equal(got.toLowerCase(), expected[i].replace(/\\/g, '/').toLowerCase());
  });
  // An explicit env mapping is read in place of os.environ.
  const mapped = py(`print(json.dumps(_history.history_dir(env={'CLAUDE_CONFIG_DIR': sys.argv[1]})))`, { args: [config] }).out;
  assert.equal(mapped, results[2]);
});

const ENTRY = (runId, ledger, first) => ({
  run_id: runId, folder: `${first.slice(0, 10)}-${runId}`, ledger_dir: ledger, project: '/p', plan: '/p/plan.md',
  engine_version: '1.5.0', machine: 'm', platform: 'linux', first_launch: first, last_launch: first,
  launches: 1, status: 'complete', acceptance: 'passed',
});

test('the index round-trips and is sorted', () => {
  const hdir = freshDir('index');
  const later = ENTRY('r2', '/a/r2.ledger', '2026-10-10T09:00:00Z');
  const earlier = ENTRY('r1', '/a/r1.ledger', '2026-10-09T09:00:00Z');
  const { out } = py([
    "_history.write_index(sys.argv[1], {'version': 1, 'runs': json.loads(sys.argv[2])})",
    'print(json.dumps([_history.read_index(sys.argv[1]), sorted(os.listdir(sys.argv[1]))]))',
  ].join('\n'), { args: [hdir, JSON.stringify([later, earlier])] });
  const [index, files] = out;
  assert.deepEqual(index, { version: 1, runs: [earlier, later] });
  assert.deepEqual(files, ['index.json'], 'no temp file is left behind');
  assert.ok(!readFileSync(join(hdir, 'index.json')).includes(13), 'index.json holds no CR');
  const missing = py('print(json.dumps(_history.read_index(sys.argv[1])))', { args: [freshDir('empty')] }).out;
  assert.deepEqual(missing, { version: 1, runs: [] });
});

test('a malformed index raises HistoryError', () => {
  const cases = ['{', '[]', '{"version": 1, "runs": {}}', '{"version": 2, "runs": []}'];
  for (const content of cases) {
    const hdir = freshDir('bad');
    writeFileSync(join(hdir, 'index.json'), content);
    const { out } = py('print(json.dumps(attempt(lambda: _history.read_index(sys.argv[1]))))', { args: [hdir] });
    assert.equal(out.error, 'HistoryError', `${content}: ${JSON.stringify(out)}`);
    assert.ok(out.message.includes('index.json'), out.message);
  }
});

test('find_run matches run id and ledger dir together', () => {
  const runs = [ENTRY('r1', 'C:/src/one/r1.ledger', '2026-10-09T09:00:00Z'), ENTRY('r1', '/home/u/two/r1.ledger', '2026-10-10T09:00:00Z')];
  const { out } = py([
    "index = {'version': 1, 'runs': json.loads(sys.argv[1])}",
    'def folder(run_id, ledger):',
    '    found = _history.find_run(index, run_id, ledger)',
    "    return found and found['folder']",
    'print(json.dumps([',
    "    folder('r1', 'C:/src/one/r1.ledger'),",
    "    folder('r1', 'C:\\\\src\\\\one\\\\r1.ledger'),",
    "    folder('r1', '/home/u/two/r1.ledger'),",
    "    folder('r1', '/home/u/other/r1.ledger'),",
    "    folder('r2', '/home/u/two/r1.ledger'),",
    "    _history.run_key({'run_id': 'r1', 'repo': {'ledger_dir': 'c:\\\\src\\\\one\\\\r1.ledger'}}),",
    "    _history.run_key({'run_id': 'r1', 'repo': {'ledger_dir': '/home/u/two/r1.ledger'}}),",
    ']))',
  ].join('\n'), { args: [JSON.stringify(runs)] });
  assert.deepEqual(out, [
    '2026-10-09-r1', '2026-10-09-r1', '2026-10-10-r1', null, null,
    ['r1', 'C:/src/one/r1.ledger'], ['r1', '/home/u/two/r1.ledger'],
  ]);
});

test('inside is case-insensitive on Windows only', () => {
  const { out } = py([
    'print(json.dumps({',
    "    'platform': sys.platform,",
    "    'windows': _history.inside('C:/A/b', 'c:/a'),",
    "    'posix_case': _history.inside('/A/b', '/a'),",
    "    'posix_same': _history.inside('/a/b', '/a'),",
    "    'equal': _history.inside(sys.argv[1], sys.argv[1]),",
    "    'sibling': _history.inside(sys.argv[1] + '-2', sys.argv[1]),",
    "    'parent': _history.inside(os.path.dirname(sys.argv[1]), sys.argv[1]),",
    '}))',
  ].join('\n'), { args: [TMP] });
  if (out.platform === 'win32') assert.equal(out.windows, true);
  else {
    assert.equal(out.posix_case, false);
    assert.equal(out.posix_same, true);
  }
  assert.equal(out.equal, true);
  assert.equal(out.sibling, false);
  assert.equal(out.parent, false);
});

test('the index lock excludes a second holder and recovers a stale one', () => {
  const hdir = freshDir('lock');
  const lock = join(hdir, 'index.lock');
  const take = [
    'def take(wait_s):',
    '    with _history.index_lock(sys.argv[1], wait_s=wait_s):',
    "        return os.path.exists(os.path.join(sys.argv[1], 'index.lock'))",
  ].join('\n');
  const { out } = py([
    take,
    'with _history.index_lock(sys.argv[1]):',
    "    with open(os.path.join(sys.argv[1], 'index.lock'), encoding='utf-8') as f:",
    '        held = json.load(f)',
    '    second = attempt(lambda: take(0.5))',
    "print(json.dumps({'held_pid': held['pid'] == os.getpid(), 'second': second, 'after': attempt(lambda: take(0.5))}))",
  ].join('\n'), { args: [hdir] });
  assert.equal(out.held_pid, true);
  assert.equal(out.second.error, 'HistoryError', JSON.stringify(out.second));
  assert.ok(out.second.message.includes('index.lock'), out.second.message);
  assert.deepEqual(out.after, { ok: true });
  assert.ok(!existsSync(lock), 'the lock is removed on exit');

  writeFileSync(lock, '{"pid": 1, "time": "2026-10-10T00:00:00Z"}');
  const old = new Date(Date.now() - 20 * 60 * 1000);
  utimesSync(lock, old, old);
  const stale = py([take, 'print(json.dumps(attempt(lambda: take(0.5))))'].join('\n'), { args: [hdir] });
  assert.deepEqual(stale.out, { ok: true });
  assert.match(stale.stderr, /stale/);
  assert.ok(!existsSync(lock), 'the taken-over lock is removed on exit');
});

test('a fresh lock found at a stale takeover is put back, not taken', () => {
  const hdir = freshDir('fresh takeover');
  const lock = join(hdir, 'index.lock');
  writeFileSync(lock, '{"pid": 2, "token": "fresh"}');
  // As if the lock was judged stale just before a new holder replaced it.
  const { out } = py("print(json.dumps(_history._take_over(os.path.join(sys.argv[1], 'index.lock'), 9999, 600)))",
    { args: [hdir] });
  assert.equal(out, false);
  assert.equal(readFileSync(lock, 'utf8'), '{"pid": 2, "token": "fresh"}');
});

test('a history dir that refuses the lock file fails at once', {
  skip: IS_WINDOWS || (process.getuid && process.getuid() === 0),
}, () => {
  const hdir = freshDir('read only');
  chmodSync(hdir, 0o555);
  try {
    const start = Date.now();
    const { out } = py('print(json.dumps(attempt(lambda: _history.index_lock(sys.argv[1], wait_s=20).__enter__())))',
      { args: [hdir] });
    assert.equal(out.error, 'HistoryError', JSON.stringify(out));
    assert.match(out.message, /cannot create .*index\.lock/);
    assert.ok(Date.now() - start < 10000, 'it did not wait for the lock');
  } finally {
    chmodSync(hdir, 0o755);
  }
});

test('norm_path reads /c/x as a drive only on Windows', () => {
  const { out } = py("print(json.dumps([_history.norm_path(p) for p in ['/a/r1.ledger', 'c:\\\\x\\\\y', 'D:/z/']]))");
  assert.deepEqual(out, [IS_WINDOWS ? 'A:/r1.ledger' : '/a/r1.ledger', 'C:/x/y', 'D:/z']);
});

test('pl_history_dir in _paths.sh matches history_dir', () => {
  const config = freshDir('config sh');
  const env = { CLAUDE_CONFIG_DIR: config };
  const res = spawnSync(BASH, ['-c', `. '${PATHS}'; pl_history_dir`], { encoding: 'utf8', env: cleanEnv(env) });
  assert.equal(res.status, 0, res.stderr);
  const bash = lf(res.stdout).trim();
  const { out } = py('print(json.dumps([_history.history_dir(), _shell.native_path(sys.argv[1])]))', { args: [bash], env });
  assert.equal(out[1], out[0]);
  // PL_HISTORY_DIR wins over the config dir in bash too.
  const fromEnv = join(freshDir('env sh'), 'h');
  const res2 = spawnSync(BASH, ['-c', `. '${PATHS}'; pl_history_dir`], {
    encoding: 'utf8', env: cleanEnv({ ...env, PL_HISTORY_DIR: fromEnv }),
  });
  assert.equal(res2.status, 0, res2.stderr);
  const both = py('print(json.dumps([_history.history_dir(), _shell.native_path(sys.argv[1])]))', {
    args: [lf(res2.stdout).trim()], env: { ...env, PL_HISTORY_DIR: fromEnv },
  }).out;
  assert.equal(both[1], both[0]);
  if (!IS_WINDOWS) assert.equal(both[0], fromEnv);
});
