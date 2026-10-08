// Recovery records (review findings 5 and 8, and the deferred status of
// finding 13): the ledger's task ranges, their reconciliation with git on a
// resume, and approvals bound to the requirements and the code they covered.
// Real git repos, the real finish-task and ledger scripts.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'pl-recovery-')));
after(() => rmSync(TMP, { recursive: true, force: true }));
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid',
};

function sh(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', env: ENV });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}
function git(dir, ...args) {
  const res = sh('git', ['-C', dir, ...args]);
  assert.equal(res.code, 0, res.stderr);
  return res.stdout.trim();
}
const py = (script, ...args) => sh('python3', [join(SCRIPTS, script), ...args]);
function ok(res) {
  assert.equal(res.code, 0, res.stderr);
  return res.stdout.trim() ? JSON.parse(res.stdout) : null;
}
function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const PLAN = '# P\n\n### Task T1: one\n\nDo one.\n\n### Task T2: two\n\nDo two.\n';

let counter = 0;
// A repo on branch feat with an initial commit, a plan, a ledger dir and a
// manifest whose prelude is [T1, T2] and whose start point is the initial commit.
function newCase() {
  counter += 1;
  const root = join(TMP, `case ${counter}`);
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'feat');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  const start = git(repo, 'rev-parse', 'HEAD');
  const plan = join(root, 'plan.md');
  write(plan, PLAN);
  const ledger = join(root, 'ledger');
  const manifest = join(root, 'manifest.json');
  const task = (id) => ({ id, title: id, files: [], tier: 'standard', security: false });
  write(manifest, JSON.stringify({
    repo: { mode: 'git', root: repo, git_dir: null }, prelude: [task('T1'), task('T2')], lanes: [], join: [],
    start_points: { prelude: start },
  }));
  return { root, repo, start, plan, ledger, manifest };
}
const commit = (c, name) => {
  write(join(c.repo, name), `${name}\n`);
  git(c.repo, 'add', name);
  git(c.repo, 'commit', '-q', '-m', name);
  return git(c.repo, 'rev-parse', 'HEAD');
};
const finish = (c, from, ...args) => ok(py('finish-task', c.repo, 'feat', from, c.ledger, 'prelude', ...args));
const append = (c, entry) => ok(py('ledger', 'append', c.ledger, 'prelude', JSON.stringify(entry)));

// Review finding 5, end to end: commit A is made but never recorded, the retry
// records only B; a resume must review base..B, never A..B.
test('backfill gives an interrupted task its real base, not the parent of its first listed commit', () => {
  const c = newCase();
  const a = commit(c, 'a.txt');
  const b = commit(c, 'b.txt');
  finish(c, c.start, '--task', 'T1', '--commit', b);
  const out = ok(py('ledger', 'backfill', c.ledger, c.manifest));
  assert.deepEqual(out.backfill, { T1: { base: c.start, head: b } });
  assert.notEqual(out.backfill.T1.base, a);
  assert.deepEqual(out.errors, []);
});

test('backfill chains a fix round onto its task range', () => {
  const c = newCase();
  const h1 = commit(c, 'a.txt');
  finish(c, c.start, '--task', 'T1');
  const h2 = commit(c, 'fix.txt');
  finish(c, h1, '--task', 'T1');
  assert.deepEqual(ok(py('ledger', 'backfill', c.ledger, c.manifest)).backfill, { T1: { base: c.start, head: h2 } });
});

test('backfill refuses a recorded range git does not confirm, instead of narrowing it', () => {
  const c = newCase();
  const a = commit(c, 'a.txt');
  // A hand-written event that lists a commit list git does not give for the range.
  append(c, { task: 'T1', event: 'committed', base: c.start, head: a, commits: ['0000000000000000000000000000000000000000'] });
  const res = py('ledger', 'backfill', c.ledger, c.manifest);
  assert.equal(res.code, 3);
  assert.match(JSON.parse(res.stdout).errors[0], /recorded commits differ from git rev-list/);
});

test('backfill refuses events whose bases do not chain', () => {
  const c = newCase();
  const a = commit(c, 'a.txt');
  const b = commit(c, 'b.txt');
  append(c, { task: 'T1', event: 'committed', base: c.start, head: a, commits: [a] });
  append(c, { task: 'T1', event: 'committed', base: b, head: b, commits: [b] });
  const res = py('ledger', 'backfill', c.ledger, c.manifest);
  assert.equal(res.code, 3);
  assert.match(res.stdout, /neither the task base/);
});

test('backfill derives a legacy task base from the list order, and says so', () => {
  const c = newCase();
  const a = commit(c, 'a.txt');
  const b = commit(c, 'b.txt');
  // Events written before finish-task recorded ranges: no base or head.
  append(c, { task: 'T1', event: 'committed', commits: [a] });
  append(c, { task: 'T2', event: 'committed', commits: [b] });
  const status = ok(py('ledger', 'status', c.ledger));
  assert.deepEqual(status.legacy, ['T1', 'T2']);
  const out = ok(py('ledger', 'backfill', c.ledger, c.manifest));
  assert.deepEqual(out.backfill, { T1: { base: c.start, head: a }, T2: { base: a, head: b } });
  assert.deepEqual(out.derived, ['T1', 'T2']);
});

// Review finding 8: an approval is bound to the requirements and the code it
// covered; a changed requirement makes it stale.
test('ledger reviewed binds an approval to the section hash and head; a changed section makes it stale', () => {
  const c = newCase();
  const h = commit(c, 'a.txt');
  finish(c, c.start, '--task', 'T1');
  ok(py('ledger', 'reviewed', c.ledger, 'prelude', 'T1', '0', c.plan, c.repo, h, '0'));
  let status = ok(py('ledger', 'status', c.ledger, '--plan', c.plan));
  assert.deepEqual(status.reviewed, ['T1']);
  assert.deepEqual(status.stale, []);
  write(c.plan, PLAN.replace('Do one.', 'Do one, and also validate the input.'));
  status = ok(py('ledger', 'status', c.ledger, '--plan', c.plan));
  assert.deepEqual(status.reviewed, []);
  assert.deepEqual(status.stale, [{ task: 'T1', reason: "the task's section of the plan changed since its review" }]);
  assert.deepEqual(status.done, ['T1']);
  assert.equal(status.ranges.T1.head, h);
});

test('an approval of another head than the recorded one is stale', () => {
  const c = newCase();
  commit(c, 'a.txt');
  finish(c, c.start, '--task', 'T1');
  append(c, { task: 'T1', event: 'reviewed', rounds: 0, brief_sha256: '0'.repeat(64), head: c.start });
  const status = ok(py('ledger', 'status', c.ledger));
  assert.deepEqual(status.reviewed, ['T1'], 'without --plan the review counts as before');
  // With --plan, the hash is wrong and so is the head; the hash is reported.
  const withPlan = ok(py('ledger', 'status', c.ledger, '--plan', c.plan));
  assert.deepEqual(withPlan.reviewed, []);
  assert.equal(withPlan.stale.length, 1);
});

test('a review recorded without a hash is unbound and not trusted when the plan is checked', () => {
  const c = newCase();
  commit(c, 'a.txt');
  finish(c, c.start, '--task', 'T1');
  append(c, { task: 'T1', event: 'reviewed', rounds: 1 });
  const status = ok(py('ledger', 'status', c.ledger, '--plan', c.plan));
  assert.deepEqual(status.unbound, ['T1']);
  assert.deepEqual(status.reviewed, []);
});

test('ledger status reports a changed plan or spec against the hashes setup recorded', () => {
  const c = newCase();
  const spec = join(c.root, 'spec.md');
  write(spec, 'spec v1\n');
  const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
  append(c, { task: '_run', event: 'run_started', phase: 'setup', head: c.start, plan_sha256: sha(c.plan), spec_sha256: sha(spec) });
  let inputs = ok(py('ledger', 'status', c.ledger, '--plan', c.plan, '--spec', spec)).inputs;
  assert.deepEqual(inputs, { plan_changed: false, spec_changed: false });
  write(spec, 'spec v2\n');
  inputs = ok(py('ledger', 'status', c.ledger, '--plan', c.plan, '--spec', spec)).inputs;
  assert.deepEqual(inputs, { plan_changed: false, spec_changed: true });
});

test('a settled task is listed as deferred; a later commit clears it', () => {
  const c = newCase();
  finish(c, c.start, '--task', 'T1', '--settled', 'park');
  let status = ok(py('ledger', 'status', c.ledger, '--plan', c.plan));
  assert.deepEqual(status.deferred, ['T1']);
  assert.deepEqual(status.done, ['T1']);
  assert.deepEqual(status.reviewed, ['T1'], 'settled counts as reviewed for scheduling only');
  commit(c, 'a.txt');
  finish(c, c.start, '--task', 'T1');
  status = ok(py('ledger', 'status', c.ledger));
  assert.deepEqual(status.deferred, []);
});

// The reviewer review: an approval records the head of the range it reviewed,
// not the checkout's later HEAD, and never carries a blocking finding.
test('ledger reviewed records the reviewed head, not a later checkout HEAD', () => {
  const c = newCase();
  const h1 = commit(c, 'a.txt');
  finish(c, c.start, '--task', 'T1');
  commit(c, 'b.txt');
  finish(c, h1, '--task', 'T2');
  ok(py('ledger', 'reviewed', c.ledger, 'prelude', 'T1', '0', c.plan, c.repo, h1, '0'));
  const status = ok(py('ledger', 'status', c.ledger, '--plan', c.plan));
  assert.deepEqual(status.stale, []);
  assert.deepEqual(status.reviewed, ['T1']);
});

test('ledger reviewed refuses an approval with blocking findings or a head outside the checkout', () => {
  const c = newCase();
  const h = commit(c, 'a.txt');
  finish(c, c.start, '--task', 'T1');
  let res = py('ledger', 'reviewed', c.ledger, 'prelude', 'T1', '0', c.plan, c.repo, h, '1');
  assert.equal(res.code, 3);
  assert.match(res.stderr, /not an approval/);
  res = py('ledger', 'reviewed', c.ledger, 'prelude', 'T1', '0', c.plan, c.repo, '0'.repeat(40), '0');
  assert.equal(res.code, 3);
  assert.deepEqual(ok(py('ledger', 'status', c.ledger)).reviewed, []);
});

test('a reopened event voids an earlier approval', () => {
  const c = newCase();
  const h = commit(c, 'a.txt');
  finish(c, c.start, '--task', 'T1');
  ok(py('ledger', 'reviewed', c.ledger, 'prelude', 'T1', '0', c.plan, c.repo, h, '0'));
  append(c, { task: 'T1', event: 'reopened', reason: 'approved with a blocking finding' });
  const status = ok(py('ledger', 'status', c.ledger, '--plan', c.plan));
  assert.deepEqual(status.reviewed, []);
  assert.deepEqual(status.done, ['T1']);
});
