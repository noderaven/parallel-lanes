// scripts/task-checks (spec 4.2): it picks the checks a task runs before
// committing (targeted, lane or widened), runs them through run-checks, and
// records the selection in <ledger>/checks/task-<unit>.<n>.json. Every test
// runs the real script against a real git repo whose committed t.mjs is the
// check; the three offered lists differ only in t.mjs's argument, so the
// recorded results show which list ran.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { IS_WINDOWS, SYMLINKS, tempDir } from './platform.mjs';

const SCRIPT = join(SKILL_DIR, 'scripts', 'task-checks');
const TMP = realpathSync(tempDir('pl-task-checks-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid',
};

function git(dir, ...args) {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim();
}

let counter = 0;
// A repo with t.mjs (exits with the code in FAIL.txt when that file exists)
// and the given committed files; returns {dir, ledger, base}.
function repo(committed = {}) {
  counter += 1;
  const dir = join(TMP, `case ${counter}`, 'repo');
  const ledger = join(TMP, `case ${counter}`, 'ledger');
  mkdirSync(dir, { recursive: true });
  mkdirSync(ledger, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 't.mjs'),
    "import { existsSync, readFileSync } from 'node:fs';\n"
    + "process.exit(existsSync('FAIL.txt') ? Number(readFileSync('FAIL.txt', 'utf8')) : 0);\n");
  for (const [name, text] of Object.entries(committed)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return { dir, ledger, base: git(dir, 'rev-parse', 'HEAD') };
}

const T = 'node t.mjs T';
const L = 'node t.mjs L';
const W = 'node t.mjs W';

// Runs task-checks with unit U1 (task U1), the given extra arguments, and the
// lane and wide lists; entry: true adds --entry U1 --targeted test T.
function run(r, { entry = true, args = [], unit = 'U1', tasks = [unit], lane = 'alpha', entryId = null } = {}) {
  const argv = [SCRIPT, r.dir, '--base', r.base, '--ledger', r.ledger, '--unit', unit, '--lane', lane,
    ...tasks.flatMap((t) => ['--task', t]),
    ...(entry ? ['--entry', entryId || tasks[tasks.length - 1], '--targeted', 'test', T] : []),
    '--lane-cmd', 'test', L, '--wide-cmd', 'test', W, '--project-test', W, ...args];
  const res = spawnSync('python3', argv, { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  let json = null;
  try { json = JSON.parse(res.stdout); } catch { /* left null */ }
  return { status: res.status, json, stderr: res.stderr };
}

const ran = (json) => json.results.map((x) => x.command);
const codes = (json) => json.policy.reasons.map((x) => x.code);

test('no entry selects lane and runs the lane list', () => {
  const r = repo({ 'src/a.js': '1\n' });
  writeFileSync(join(r.dir, 'src/a.js'), '2\n');
  const { status, json } = run(r, { entry: false, args: ['--declared', 'src/a.js'] });
  assert.equal(status, 0);
  assert.equal(json.policy.selected, 'lane');
  assert.deepEqual(codes(json), ['no_entry']);
  assert.deepEqual(ran(json), [L]);
  assert.equal(json.policy.entry, null);
  assert.equal(json.policy.offered.targeted, null);
});

test('an entry with every change covered selects targeted', () => {
  const r = repo({ 'src/a.js': '1\n' });
  writeFileSync(join(r.dir, 'src/a.js'), '2\n');
  const { status, json } = run(r, { args: ['--declared', 'src/a.js', '--widen', 'package.json'] });
  assert.equal(status, 0);
  assert.equal(json.policy.selected, 'targeted');
  assert.deepEqual(json.policy.reasons, []);
  assert.deepEqual(ran(json), [T]);
  assert.deepEqual(json.policy.changed, ['src/a.js']);
  assert.equal(json.policy.entry, 'U1');
  assert.deepEqual(json.policy.offered, {
    targeted: [{ group: 'test', command: T }], lane: [{ group: 'test', command: L }], wide: [{ group: 'test', command: W }],
  });
  assert.equal(json.policy.unit, 'U1');
  assert.deepEqual(json.policy.tasks, ['U1']);
  assert.equal(json.policy.lane, 'alpha');
  assert.equal(json.policy.base, r.base);
  assert.match(json.policy.started, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
});

test('a change outside the Files list widens', () => {
  const r = repo({ 'src/a.js': '1\n', 'src/b.js': '1\n' });
  writeFileSync(join(r.dir, 'src/b.js'), '2\n');
  const { json } = run(r, { args: ['--declared', 'src/a.js'] });
  assert.equal(json.policy.selected, 'widened');
  assert.equal(json.policy.reasons[0].code, 'outside_files');
  assert.match(json.policy.reasons[0].detail, /src\/b\.js/);
  assert.deepEqual(ran(json), [W]);
});

test('a widen path widens even inside the Files list', () => {
  const r = repo({ 'package.json': '{}\n' });
  writeFileSync(join(r.dir, 'package.json'), '{"x":1}\n');
  const { json } = run(r, { args: ['--declared', 'package.json', '--widen', 'package.json'] });
  assert.equal(json.policy.selected, 'widened');
  assert.deepEqual(codes(json), ['widen_path']);
});

test('an untracked file outside the Files list widens', () => {
  const r = repo({ 'src/a.js': '1\n' });
  writeFileSync(join(r.dir, 'new.js'), 'x\n');
  const { json } = run(r, { args: ['--declared', 'src/a.js'] });
  assert.deepEqual(codes(json), ['outside_files']);
  assert.deepEqual(json.policy.changed, ['new.js']);
});

test('a rename counts both paths', () => {
  const r = repo({ 'src/a.js': '1\n' });
  git(r.dir, 'mv', 'src/a.js', 'src/z.js');
  const kept = run(r, { args: ['--declared', 'src/a.js'] });
  assert.deepEqual(kept.json.policy.changed, ['src/a.js', 'src/z.js']);
  assert.deepEqual(codes(kept.json), ['outside_files']);
  const both = run(r, { args: ['--declared', 'src/a.js', '--declared', 'src/z.js'] });
  assert.equal(both.json.policy.selected, 'targeted');
});

test('a directory entry covers files under it, and backslash entries match', () => {
  const r = repo({ 'src/sub/a.js': '1\n' });
  writeFileSync(join(r.dir, 'src/sub/a.js'), '2\n');
  writeFileSync(join(r.dir, 'src/sub/b.js'), 'new\n');
  assert.equal(run(r, { args: ['--declared', 'src/'] }).json.policy.selected, 'targeted');
  assert.equal(run(r, { args: ['--declared', 'src\\sub\\'] }).json.policy.selected, 'targeted');
  assert.equal(run(r, { args: ['--declared', 'src\\sub\\a.js', '--declared', 'src/sub/b.js'] }).json.policy.selected, 'targeted');
  // A file entry does not cover a sibling that shares its prefix.
  assert.equal(run(r, { args: ['--declared', 'src/sub/a'] }).json.policy.selected, 'widened');
});

test('matching is case-sensitive', () => {
  // Only src/a.js is created; src/A.js is declared and never created (on
  // Windows both names are one file).
  const r = repo();
  mkdirSync(join(r.dir, 'src'));
  writeFileSync(join(r.dir, 'src/a.js'), 'new\n');
  const { json } = run(r, { args: ['--declared', 'src/A.js'] });
  assert.deepEqual(codes(json), ['outside_files']);
});

test('names with spaces and non-ASCII characters are matched exactly', () => {
  const r = repo({ 'a b.js': '1\n', 'caf\u00e9.js': '1\n' });
  writeFileSync(join(r.dir, 'a b.js'), '2\n');
  writeFileSync(join(r.dir, 'caf\u00e9.js'), '2\n');
  const { json } = run(r, { args: ['--declared', 'a b.js', '--declared', 'caf\u00e9.js'] });
  assert.deepEqual(json.policy.changed, ['a b.js', 'caf\u00e9.js']);
  assert.equal(json.policy.selected, 'targeted');
});

test('a name with a double quote is matched exactly', { skip: IS_WINDOWS && 'NTFS forbids " in file names' }, () => {
  const r = repo({ 'q"x.js': '1\n' });
  writeFileSync(join(r.dir, 'q"x.js'), '2\n');
  const { json } = run(r, { args: ['--declared', 'q"x.js'] });
  assert.deepEqual(json.policy.changed, ['q"x.js']);
  assert.equal(json.policy.selected, 'targeted');
});

test('force-full widens with its reason', () => {
  const r = repo({ 'src/a.js': '1\n' });
  writeFileSync(join(r.dir, 'src/a.js'), '2\n');
  const { json } = run(r, { args: ['--declared', 'src/a.js', '--force-full', 'touches the shared config loader'] });
  assert.equal(json.policy.selected, 'widened');
  assert.deepEqual(json.policy.reasons, [{ code: 'forced', detail: 'touches the shared config loader' }]);
});

test('several widening reasons are all recorded, in order', () => {
  const r = repo({ 'src/a.js': '1\n', 'package.json': '{}\n' });
  writeFileSync(join(r.dir, 'package.json'), '{"x":1}\n');
  const { json } = run(r, { args: ['--declared', 'src/a.js', '--widen', 'package.json', '--force-full', 'why'] });
  assert.deepEqual(codes(json), ['outside_files', 'widen_path', 'forced']);
});

test('a bad base widens with git_failed', () => {
  const r = repo({ 'src/a.js': '1\n' });
  const { status, json } = run({ ...r, base: '0123456789abcdef0123456789abcdef01234567' }, { args: ['--declared', 'src/a.js'] });
  assert.equal(status, 0);
  assert.deepEqual(codes(json), ['git_failed']);
  assert.deepEqual(json.policy.changed, []);
  assert.deepEqual(ran(json), [W]);
});

test('no Files list widens with no_files', () => {
  const r = repo();
  const { json } = run(r);
  assert.deepEqual(codes(json), ['no_files']);
  assert.equal(json.policy.selected, 'widened');
});

test('two calls write two evidence files and never overwrite', () => {
  const r = repo({ 'src/a.js': '1\n' });
  run(r, { args: ['--declared', 'src/a.js'] });
  writeFileSync(join(r.ledger, 'checks', 'marker.txt'), 'x');
  const first = readFileSync(join(r.ledger, 'checks', 'task-U1.1.json'), 'utf8');
  run(r, { entry: false, args: ['--declared', 'src/a.js'] });
  assert.equal(readFileSync(join(r.ledger, 'checks', 'task-U1.1.json'), 'utf8'), first);
  const second = JSON.parse(readFileSync(join(r.ledger, 'checks', 'task-U1.2.json'), 'utf8'));
  assert.equal(second.policy.selected, 'lane');
  assert.equal(JSON.parse(first).policy.selected, 'targeted');
});

test('a batch unit id is its own name', () => {
  const r = repo({ 'src/a.js': '1\n' });
  run(r, { unit: 'A1-A3', tasks: ['A1', 'A2', 'A3'], args: ['--declared', 'src/a.js'] });
  run(r, { unit: 'A1', args: ['--declared', 'src/a.js'] });
  const files = readdirSync(join(r.ledger, 'checks')).filter((f) => f.endsWith('.json')).sort();
  assert.deepEqual(files, ['task-A1-A3.1.json', 'task-A1.1.json']);
  const batch = JSON.parse(readFileSync(join(r.ledger, 'checks', 'task-A1-A3.1.json'), 'utf8'));
  assert.deepEqual(batch.policy.tasks, ['A1', 'A2', 'A3']);
  assert.equal(batch.policy.entry, 'A3');
});

test('unsafe ids and paths are refused with exit 2', () => {
  const r = repo();
  for (const [opts, what] of [
    [{ unit: '../x' }, 'unit'],
    [{ tasks: ['a/b'], unit: 'U1' }, 'task'],
    [{ args: ['--declared', '/etc/x'] }, 'absolute declared'],
    [{ args: ['--declared', 'C:/x'] }, 'drive declared'],
    [{ args: ['--widen', 'a/../../b'] }, 'widen leaving the project'],
  ]) {
    const res = run(r, opts);
    assert.equal(res.status, 2, `${what}: ${res.stderr}`);
  }
  assert.ok(!existsSync(join(r.ledger, 'checks')), 'nothing was written');
});

test('a Files entry src/../x.js normalizes and is accepted; ../x is refused', () => {
  const r = repo({ 'x.js': '1\n' });
  writeFileSync(join(r.dir, 'x.js'), '2\n');
  const ok = run(r, { args: ['--declared', 'src/../x.js'] });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.json.policy.selected, 'targeted');
  assert.equal(run(r, { args: ['--declared', '../x'] }).status, 2);
});

test('usage errors exit 2', () => {
  const r = repo();
  const base = ['--base', r.base, '--ledger', r.ledger, '--unit', 'U1', '--lane', 'alpha', '--task', 'U1'];
  const call = (...argv) => spawnSync('python3', [SCRIPT, r.dir, ...argv], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).status;
  assert.equal(call(...base, '--wide-cmd', 'test', W), 2, 'no --lane-cmd');
  assert.equal(call(...base, '--lane-cmd', 'test', L), 2, 'no --wide-cmd');
  assert.equal(call(...base, '--lane-cmd', 'test', L, '--wide-cmd', 'test', W, '--targeted', 'test', T), 2, '--targeted without --entry');
  assert.equal(call(...base, '--lane-cmd', 'test', L, '--wide-cmd', 'test', W, '--entry', 'U1'), 2, '--entry without --targeted');
  assert.equal(call(...base, '--lane-cmd', 'test', L, '--wide-cmd', 'test', W, '--bogus'), 2, 'unknown option');
});

test('project_test_executed is true only when an executed command equals a project test', () => {
  const r = repo({ 'src/a.js': '1\n' });
  assert.equal(run(r, { args: ['--declared', 'src/a.js'] }).json.policy.project_test_executed, false);
  assert.equal(run(r, { args: ['--force-full', 'x'] }).json.policy.project_test_executed, true);
});

test('a failing check exits 1 with ok false and the policy', () => {
  const r = repo({ 'src/a.js': '1\n' });
  writeFileSync(join(r.dir, 'FAIL.txt'), '3');
  const { status, json } = run(r, { args: ['--declared', 'src/a.js', '--declared', 'FAIL.txt'] });
  assert.equal(status, 1);
  assert.equal(json.ok, false);
  assert.equal(json.results[0].exit, 3);
  assert.equal(json.policy.selected, 'targeted');
});

test('run-checks giving no JSON yields an error record and exit 3', () => {
  const r = repo();
  const notRepo = join(TMP, 'not-a-repo');
  mkdirSync(notRepo, { recursive: true });
  const { status, json } = run({ ...r, dir: notRepo }, { args: ['--declared', 'x.js'] });
  assert.equal(status, 3);
  assert.deepEqual(json.results, []);
  assert.equal(json.ok, false);
  assert.ok(typeof json.error === 'string' && json.error.length > 0);
  assert.deepEqual(codes(json), ['git_failed']);
  const saved = JSON.parse(readFileSync(join(r.ledger, 'checks', 'task-U1.1.json'), 'utf8'));
  assert.equal(saved.error, json.error);
});

// ---- review fixes (T1 review, 2026-10-11) ----

test('no entry plus a widening reason stays lane, with both reasons', () => {
  const r = repo({ 'src/a.js': '1\n' });
  writeFileSync(join(r.dir, 'new.js'), 'x\n');
  const { json } = run(r, { entry: false, args: ['--declared', 'src/a.js'] });
  assert.equal(json.policy.selected, 'lane');
  assert.deepEqual(codes(json), ['no_entry', 'outside_files']);
  assert.deepEqual(ran(json), [L]);
});

test('an unsafe lane or entry alone is refused with exit 2', () => {
  const r = repo();
  assert.equal(run(r, { lane: '../x' }).status, 2);
  assert.equal(run(r, { entryId: 'a/b' }).status, 2);
  assert.ok(!existsSync(join(r.ledger, 'checks')));
});

test('a base that is not a sha is a usage error and runs no git', () => {
  const r = repo();
  const injected = join(TMP, `injected ${counter}.txt`);
  const res = run({ ...r, base: `--output=${injected}` });
  assert.equal(res.status, 2, res.stderr);
  assert.ok(!existsSync(injected));
  assert.ok(!existsSync(join(r.ledger, 'checks')));
});

test('an unexpected error exits 3, never 1', () => {
  const r = repo();
  const file = join(TMP, `ledger-file ${counter}`);
  writeFileSync(file, 'not a directory');
  const res = run({ ...r, ledger: file }, { args: ['--declared', 't.mjs'] });
  assert.equal(res.status, 3, `${res.status}: ${res.stderr}`);
});

test('a git path with a backslash is never covered', { skip: IS_WINDOWS && 'Windows file names cannot hold a backslash' }, () => {
  const r = repo();
  writeFileSync(join(r.dir, 'src\\x.js'), 'x\n');
  const { json } = run(r, { args: ['--declared', 'src/', '--declared', 'src/x.js'] });
  assert.deepEqual(codes(json), ['outside_files']);
  assert.equal(json.policy.selected, 'widened');
});

test('an error record carries policy.started', () => {
  const r = repo();
  const notRepo = join(TMP, `not-a-repo ${counter}`);
  mkdirSync(notRepo, { recursive: true });
  const { status, json } = run({ ...r, dir: notRepo }, { args: ['--declared', 'x.js'] });
  assert.equal(status, 3);
  assert.match(json.policy.started, /Z$/);
});

test('an evidence path outside the ledger exits 3 and writes nothing outside', { skip: !SYMLINKS && 'symlinks unavailable' }, () => {
  const r = repo();
  const outside = join(TMP, `outside ${counter}`);
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, join(r.ledger, 'checks'), 'junction');
  const res = run(r, { args: ['--declared', 'x.js'] });
  assert.equal(res.status, 3, res.stderr);
  assert.deepEqual(readdirSync(outside), []);
});
