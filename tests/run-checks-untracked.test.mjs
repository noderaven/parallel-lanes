// scripts/run-checks: the untracked files it records before the first command
// and after the last (untracked_before and untracked_after), beside the
// tracked lists. Every test runs the real script against a real git repo with
// --cmd test 'node t.mjs', where t.mjs is committed.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { tempDir } from './platform.mjs';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const TMP = realpathSync(tempDir('pl-run-checks-untracked-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid',
};

function git(dir, ...args) {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout;
}

let counter = 0;
// A repo whose committed files are t.mjs (the check; its text is script) and
// any extra files given as {name: text}.
function repo(script, committed = {}) {
  counter += 1;
  const dir = join(TMP, `case ${counter}`);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 't.mjs'), script);
  for (const [name, text] of Object.entries(committed)) writeFileSync(join(dir, name), text);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

// Runs run-checks with the one command node t.mjs and returns its JSON.
function runChecks(dir) {
  const res = spawnSync('python3', [join(SCRIPTS, 'run-checks'), dir, '--cmd', 'test', 'node t.mjs'], {
    // TMPDIR keeps run-checks' temporary log directory inside TMP.
    encoding: 'utf8', env: { ...process.env, ...GIT_ENV, TMPDIR: TMP },
  });
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  return JSON.parse(res.stdout);
}

const NOTHING = '';
const WRITE_OUT = "import { writeFileSync } from 'node:fs';\nwriteFileSync('out.txt', 'x\\n');\n";

test('an untracked file present before the checks is listed', () => {
  const dir = repo(NOTHING);
  writeFileSync(join(dir, 'extra.js'), 'x\n');
  const report = runChecks(dir);
  assert.deepEqual(report.untracked_before, ['?? extra.js']);
  assert.ok(report.untracked_after.includes('?? extra.js'), JSON.stringify(report.untracked_after));
});

test('a file the checks create is listed only after', () => {
  const report = runChecks(repo(WRITE_OUT));
  assert.deepEqual(report.untracked_before, []);
  assert.deepEqual(report.untracked_after, ['?? out.txt']);
});

test('ignored files are not listed', () => {
  const dir = repo(NOTHING, { '.gitignore': '*.log\n' });
  writeFileSync(join(dir, 'a.log'), 'x\n');
  const report = runChecks(dir);
  assert.deepEqual(report.untracked_before, []);
  assert.deepEqual(report.untracked_after, []);
});

test('existing fields are unchanged', () => {
  const dir = repo(NOTHING, { 'value.txt': 'bad\n' });
  writeFileSync(join(dir, 'value.txt'), 'good\n');
  const report = runChecks(dir);
  assert.deepEqual(report.tracked_before, [' M value.txt']);
  assert.deepEqual(report.tracked_after, [' M value.txt']);
  assert.equal(report.clean, false);
  assert.equal(report.ok, true);

  const clean = runChecks(repo(NOTHING));
  assert.deepEqual([clean.tracked_before, clean.tracked_after], [[], []]);
  assert.equal(clean.clean, true);
});
