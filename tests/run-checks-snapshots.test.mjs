// scripts/run-checks reads git status twice per call (spec 4.11): one
// --untracked-files=all snapshot before the commands and one after, from
// which it derives the tracked and untracked lists and clean. The lists must
// equal what the five separate status calls of 1.5.2 gave; clean no longer
// follows status.showUntrackedFiles=no. (A failed status exiting 3 is
// covered by tests/boundaries.test.mjs.)

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { tempDir } from './platform.mjs';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const TMP = realpathSync(tempDir('pl-run-checks-snapshots-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid',
};

function git(dir, ...args) {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  return res.stdout;
}

function gitOk(dir, ...args) {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout;
}

const lines = (text) => text.split('\n').filter((l) => l.length > 0);

let counter = 0;
function repo(files) {
  counter += 1;
  const dir = join(TMP, `case ${counter}`);
  mkdirSync(dir, { recursive: true });
  gitOk(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 't.mjs'), '');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  gitOk(dir, 'add', '-A');
  gitOk(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

function runChecks(dir, env = {}) {
  const res = spawnSync('python3', [join(SCRIPTS, 'run-checks'), dir, '--cmd', 'test', 'node t.mjs'], {
    encoding: 'utf8', env: { ...process.env, ...GIT_ENV, TMPDIR: TMP, ...env },
  });
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  return JSON.parse(res.stdout);
}

test('the lists match 1.5.2\'s on a mixed tree', () => {
  const dir = repo({ 'staged.js': '1\n', 'unstaged.js': '1\n', 'old.js': '1\n', 'gone.js': '1\n' });
  writeFileSync(join(dir, 'staged.js'), '2\n');
  gitOk(dir, 'add', 'staged.js');
  writeFileSync(join(dir, 'unstaged.js'), '2\n');
  gitOk(dir, 'mv', 'old.js', 'new.js');
  unlinkSync(join(dir, 'gone.js'));
  mkdirSync(join(dir, 'deep', 'er'), { recursive: true });
  writeFileSync(join(dir, 'deep', 'er', 'x.js'), 'x\n');
  writeFileSync(join(dir, 'loose.txt'), 'x\n');
  // What 1.5.2's separate calls printed.
  const tracked = lines(gitOk(dir, 'status', '--porcelain', '--untracked-files=no'));
  const untracked = lines(gitOk(dir, 'status', '--porcelain', '--untracked-files=all')).filter((l) => l.startsWith('?? '));
  const report = runChecks(dir);
  assert.deepEqual(report.tracked_before, tracked);
  assert.deepEqual(report.tracked_after, tracked);
  assert.deepEqual(report.untracked_before, untracked);
  assert.deepEqual(report.untracked_after, untracked);
  assert.ok(untracked.includes('?? deep/er/x.js'), JSON.stringify(untracked));
  assert.equal(report.clean, false);
});

test('a clean checkout is clean with empty lists', () => {
  const report = runChecks(repo({ 'a.js': '1\n' }));
  assert.deepEqual([report.tracked_before, report.untracked_before, report.tracked_after, report.untracked_after], [[], [], [], []]);
  assert.equal(report.clean, true);
});

test('a conflicted file is a tracked line', () => {
  const dir = repo({ 'f.txt': 'base\n' });
  gitOk(dir, 'switch', '-q', '-c', 'side');
  writeFileSync(join(dir, 'f.txt'), 'side\n');
  gitOk(dir, 'commit', '-q', '-am', 'side');
  gitOk(dir, 'switch', '-q', 'main');
  writeFileSync(join(dir, 'f.txt'), 'main\n');
  gitOk(dir, 'commit', '-q', '-am', 'main');
  git(dir, 'merge', 'side');
  const report = runChecks(dir);
  assert.ok(report.tracked_before.includes('UU f.txt'), JSON.stringify(report.tracked_before));
  assert.deepEqual(report.untracked_before, []);
});

test('status.showUntrackedFiles=no still makes clean false with an untracked file', () => {
  const dir = repo({ 'a.js': '1\n' });
  gitOk(dir, 'config', 'status.showUntrackedFiles', 'no');
  writeFileSync(join(dir, 'extra.js'), 'x\n');
  const report = runChecks(dir);
  assert.deepEqual(report.untracked_before, ['?? extra.js']);
  assert.equal(report.clean, false);
});

test('a submodule with untracked files is not a tracked change, as in 1.5.2', () => {
  const sub = repo({ 'lib.js': '1\n' });
  const dir = repo({ 'a.js': '1\n' });
  const res = spawnSync('git', ['-C', dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'sub'],
    { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  assert.equal(res.status, 0, res.stderr);
  gitOk(dir, 'commit', '-q', '-m', 'add sub');
  writeFileSync(join(dir, 'sub', 'scratch.txt'), 'x\n');
  const tracked = lines(gitOk(dir, 'status', '--porcelain', '--untracked-files=no'));
  const report = runChecks(dir);
  assert.deepEqual(report.tracked_before, tracked);
  assert.deepEqual(report.tracked_before, []);
  assert.deepEqual(report.tracked_after, []);
});

test('exactly two status calls per run', () => {
  const dir = repo({ 'a.js': '1\n' });
  const trace = join(TMP, `trace ${counter}.txt`);
  runChecks(dir, { GIT_TRACE: trace });
  const statusCalls = lines(readFileSync(trace, 'utf8')).filter((l) => /git(\.exe)?['"]? status\b|built-in: git status\b/.test(l));
  assert.equal(statusCalls.length, 2, statusCalls.join('\n'));
});
