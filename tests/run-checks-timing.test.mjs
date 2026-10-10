// scripts/run-checks: the started, ended and duration_s fields of each result.
// Every test runs the real script against a real git repo with two --cmd
// entries, one of them sleeping 0.3 s through node -e.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { tempDir } from './platform.mjs';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const TMP = realpathSync(tempDir('pl-run-checks-timing-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid',
};
const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const FAST = 'node -e "process.exit(0)"';
const SLOW = 'node -e "setTimeout(() => process.exit(3), 300)"';

function git(dir, ...args) {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  assert.equal(res.status, 0, res.stderr);
}

// Runs run-checks on a fresh repo with a fast command (group lint) and a
// slow one (group test, exit 3); returns the parsed JSON line.
function runBoth() {
  const dir = join(TMP, 'repo');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  const res = spawnSync('python3', [join(SCRIPTS, 'run-checks'), dir, '--cmd', 'lint', FAST, '--cmd', 'test', SLOW], {
    encoding: 'utf8', env: { ...process.env, ...GIT_ENV, TMPDIR: TMP },
  });
  assert.equal(res.status, 1, `${res.stdout}\n${res.stderr}`);
  return JSON.parse(res.stdout);
}

test('each result records when it started and ended and how long it took', () => {
  const out = runBoth();
  assert.equal(out.results.length, 2);
  for (const r of out.results) {
    assert.match(r.started, STAMP);
    assert.match(r.ended, STAMP);
    assert.ok(Date.parse(r.started) < Date.parse(r.ended), `${r.started} < ${r.ended}`);
    assert.equal(typeof r.duration_s, 'number');
    assert.equal(r.duration_s, Math.round(r.duration_s * 1000) / 1000);
  }
  assert.ok(out.results[1].duration_s >= 0.3, String(out.results[1].duration_s));
  assert.ok(Date.parse(out.results[0].ended) <= Date.parse(out.results[1].started));
});

test('the results keep their order and other fields', () => {
  const out = runBoth();
  assert.deepEqual(out.results.map((r) => [r.group, r.command, r.exit]), [['lint', FAST, 0], ['test', SLOW, 3]]);
  for (const r of out.results) {
    assert.equal(typeof r.log, 'string');
    assert.equal(r.tail, '');
  }
  assert.equal(out.ok, false);
});
