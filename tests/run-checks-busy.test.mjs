// scripts/run-checks: a command that exits 75 (busy or temporary) is waited
// on and run once more; the second exit is its result. Every test runs the
// real script against a real git repo, with RUN_CHECKS_BUSY_WAIT_S=1. Each
// command counts its runs in a file outside the repo and exits by the count.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { tempDir } from './platform.mjs';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const TMP = realpathSync(tempDir('pl-run-checks-busy-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid',
};

function git(dir, ...args) {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  assert.equal(res.status, 0, res.stderr);
}

let serial = 0;

// A fresh repo and a counter file outside it.
function fresh() {
  serial += 1;
  const dir = join(TMP, `repo${serial}`);
  const counter = join(TMP, `count${serial}`).replace(/\\/g, '/');
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return { dir, counter };
}

// A node -e command that bumps the counter, prints "run <n> at <epoch ms>"
// and exits codes[n - 1] (the last code once the list runs out). extra is
// more JavaScript run before the exit, given n.
function counted(counter, codes, extra = '') {
  const js = `const fs = require("fs"); const p = ${JSON.stringify(counter)};`
    + ' const n = (fs.existsSync(p) ? Number(fs.readFileSync(p, "utf8")) : 0) + 1;'
    + ' fs.writeFileSync(p, String(n));'
    + ' console.log("run " + n + " at " + Date.now());'
    + ` const codes = ${JSON.stringify(codes)}; ${extra}`
    + ' process.exit(codes[Math.min(n, codes.length) - 1]);';
  return `node -e '${js}'`;
}

function runChecks(dir, ...cmds) {
  const argv = [join(SCRIPTS, 'run-checks'), dir];
  for (const [group, command] of cmds) argv.push('--cmd', group, command);
  const res = spawnSync('python3', argv, {
    encoding: 'utf8', env: { ...process.env, ...GIT_ENV, TMPDIR: TMP, RUN_CHECKS_BUSY_WAIT_S: '1' },
  });
  return { status: res.status, out: JSON.parse(res.stdout), stderr: res.stderr };
}

function runs(counter) {
  return Number(readFileSync(counter, 'utf8'));
}

test('a command that exits 75 and then 0 is retried once and passes', () => {
  const { dir, counter } = fresh();
  const { status, out, stderr } = runChecks(dir, ['test', counted(counter, [75, 0])]);
  assert.equal(status, 0, stderr);
  assert.equal(runs(counter), 2);
  assert.equal(out.ok, true);
  const [r] = out.results;
  assert.equal(r.exit, 0);
  assert.deepEqual(r.busy_retry, { first_exit: 75, waited_s: 1 });
  // The log keeps both runs' output, the first one first.
  const log = readFileSync(r.log, 'utf8');
  const first = log.match(/run 1 at (\d+)/);
  const second = log.match(/run 2 at (\d+)/);
  assert.ok(first && second, log);
  assert.ok(log.indexOf('run 1 at') < log.indexOf('run 2 at'), log);
  // started is the first attempt's, ended the second's, duration_s spans both.
  assert.ok(Date.parse(r.started) <= Number(first[1]), `${r.started} <= ${first[1]}`);
  assert.ok(Date.parse(r.ended) >= Number(second[1]), `${r.ended} >= ${second[1]}`);
  assert.ok(r.duration_s >= 1, String(r.duration_s));
  assert.ok(Number(second[1]) - Number(first[1]) >= 1000, `${first[1]} then ${second[1]}`);
});

test('a command that exits 75 twice keeps 75 and fails', () => {
  const { dir, counter } = fresh();
  const { status, out } = runChecks(dir, ['test', counted(counter, [75, 75, 0])]);
  assert.equal(status, 1);
  assert.equal(runs(counter), 2);
  assert.equal(out.ok, false);
  assert.equal(out.results[0].exit, 75);
  assert.deepEqual(out.results[0].busy_retry, { first_exit: 75, waited_s: 1 });
});

test('exits other than 75 run once, with no busy_retry', () => {
  for (const code of [1, 124, 0]) {
    const { dir, counter } = fresh();
    const { status, out } = runChecks(dir, ['test', counted(counter, [code, 0])]);
    assert.equal(status, code === 0 ? 0 : 1);
    assert.equal(runs(counter), 1, `exit ${code}`);
    assert.equal(out.results[0].exit, code);
    assert.equal('busy_retry' in out.results[0], false, `exit ${code}`);
  }
});

test('only the busy command is retried; the others run once, in order', () => {
  const { dir, counter } = fresh();
  const other = join(TMP, `other${serial}`).replace(/\\/g, '/');
  const { status, out } = runChecks(dir, ['lint', counted(other, [0])], ['test', counted(counter, [75, 0])]);
  assert.equal(status, 0);
  assert.deepEqual(out.results.map((r) => [r.group, r.exit, 'busy_retry' in r]), [['lint', 0, false], ['test', 0, true]]);
  assert.equal(runs(other), 1);
  assert.equal(runs(counter), 2);
  assert.ok(Date.parse(out.results[0].ended) <= Date.parse(out.results[1].started));
});

test('tree_changed is taken once around the whole command list', () => {
  // The busy attempt leaves an untracked file and the retry removes it: the
  // checkout ends as it began, so tree_changed is false.
  const { dir, counter } = fresh();
  const scratch = join(dir, 'scratch.txt').replace(/\\/g, '/');
  const extra = `const s = ${JSON.stringify(scratch)}; if (n === 1) fs.writeFileSync(s, "x"); else fs.rmSync(s);`;
  const { status, out } = runChecks(dir, ['test', counted(counter, [75, 0], extra)]);
  assert.equal(status, 0);
  assert.equal(runs(counter), 2);
  assert.equal(out.tree_changed, false);
  assert.equal(out.clean, true);
  assert.deepEqual(out.untracked_before, []);
  assert.deepEqual(out.untracked_after, []);

  // The retry leaves the file: the checkout changed over the list.
  const second = fresh();
  const left = join(second.dir, 'left.txt').replace(/\\/g, '/');
  const keep = `if (n === 2) fs.writeFileSync(${JSON.stringify(left)}, "x");`;
  const res = runChecks(second.dir, ['test', counted(second.counter, [75, 0], keep)]);
  assert.equal(res.out.tree_changed, true);
  assert.deepEqual(res.out.untracked_after, ['?? left.txt']);
});
