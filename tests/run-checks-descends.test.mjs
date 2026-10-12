// scripts/run-checks --descends-from SHA (spec 4.5, head eligibility): the
// checks run only when SHA is an ancestor of HEAD; otherwise nothing runs and
// the JSON says so. Every test runs the real script against a real git repo
// whose committed t.mjs writes ran.txt, so a run is visible.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { tempDir } from './platform.mjs';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const TMP = realpathSync(tempDir('pl-run-checks-descends-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid',
};
const T_MJS = "import { writeFileSync } from 'node:fs';\nwriteFileSync('ran.txt', 'x\\n');\n";

function git(dir, ...args) {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim();
}

let counter = 0;
// A repo with two commits on main: {dir, first, second}. ran.txt is ignored
// so the check leaves the checkout clean.
function repo() {
  counter += 1;
  const dir = join(TMP, `case ${counter}`);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 't.mjs'), T_MJS);
  writeFileSync(join(dir, '.gitignore'), 'ran.txt\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'one');
  const first = git(dir, 'rev-parse', 'HEAD');
  writeFileSync(join(dir, 'b.txt'), 'b\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'two');
  return { dir, first, second: git(dir, 'rev-parse', 'HEAD') };
}

function runChecks(dir, ...extra) {
  const res = spawnSync('python3', [join(SCRIPTS, 'run-checks'), dir, '--cmd', 'test', 'node t.mjs', ...extra], {
    encoding: 'utf8', env: { ...process.env, ...GIT_ENV, TMPDIR: TMP },
  });
  let json = null;
  try { json = JSON.parse(res.stdout); } catch { /* left null */ }
  return { status: res.status, json, stderr: res.stderr };
}

test('a descendant head runs the checks and records descends_from ok', () => {
  const r = repo();
  const { status, json } = runChecks(r.dir, '--descends-from', r.first);
  assert.equal(status, 0);
  assert.deepEqual(json.descends_from, { sha: r.first, ok: true });
  assert.equal(json.results.length, 1);
  assert.equal(json.ok, true);
  assert.ok(existsSync(join(r.dir, 'ran.txt')));
});

test('a non-descendant head runs nothing and exits 1', () => {
  const r = repo();
  // An unrelated root commit on another branch, checked out.
  git(r.dir, 'switch', '-q', '--orphan', 'other');
  writeFileSync(join(r.dir, 't.mjs'), T_MJS);
  writeFileSync(join(r.dir, '.gitignore'), 'ran.txt\n');
  git(r.dir, 'add', '-A');
  git(r.dir, 'commit', '-q', '-m', 'unrelated');
  const head = git(r.dir, 'rev-parse', 'HEAD');
  const out = join(TMP, `out ${counter}`, 'verify.json');
  const { status, json } = runChecks(r.dir, '--descends-from', r.second, '--out', out);
  assert.equal(status, 1);
  assert.deepEqual(json.results, []);
  assert.equal(json.ok, false);
  assert.deepEqual(json.descends_from, { sha: r.second, ok: false });
  assert.equal(json.head, head);
  for (const key of ['checkout', 'branch', 'clean', 'tracked_before', 'tracked_after', 'untracked_before', 'untracked_after']) {
    assert.ok(key in json, key);
  }
  assert.ok(!existsSync(join(r.dir, 'ran.txt')), 'no command ran');
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), json);
});

test('an unknown sha runs nothing and exits 1', () => {
  const r = repo();
  const { status, json } = runChecks(r.dir, '--descends-from', '0123456789abcdef0123456789abcdef01234567');
  assert.equal(status, 1);
  assert.deepEqual(json.results, []);
  assert.equal(json.descends_from.ok, false);
  assert.ok(!existsSync(join(r.dir, 'ran.txt')));
});

test('a value that is not a hex sha is a usage error', () => {
  const r = repo();
  assert.equal(runChecks(r.dir, '--descends-from', '--all').status, 2);
  assert.equal(runChecks(r.dir, '--descends-from', 'main').status, 2);
});

test('without the option the output has no descends_from', () => {
  const r = repo();
  const { status, json } = runChecks(r.dir);
  assert.equal(status, 0);
  assert.ok(!('descends_from' in json));
});
