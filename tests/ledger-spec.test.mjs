// Audit C4: an approval records the spec it was reviewed against, and a spec
// change makes it stale on a resume. Real git repos, the real finish-task and
// ledger scripts.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { tempDir } from './platform.mjs';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const TMP = realpathSync(tempDir('pl-ledger-spec-'));
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
  return res.stdout.replace(/\r\n/g, '\n').trim();
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
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

const PLAN = '# P\n\n### Task T1: one\n\nDo one.\n\n### Task T2: two\n\nDo two.\n';
const SPEC_CHANGED = 'the spec changed since its review';
const LEGACY_CHANGED = 'the spec changed since the last launch and the review did not record it';

let counter = 0;
// A repo on branch feat with an initial commit, a plan, a spec, a ledger dir
// and a manifest whose prelude is [T1, T2], T2 depending on T1.
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
  const spec = join(root, 'spec.md');
  write(spec, 'spec v1\n');
  const ledger = join(root, 'ledger');
  const manifest = join(root, 'manifest.json');
  const task = (id, more = {}) => ({ id, title: id, files: [], tier: 'standard', security: false, ...more });
  write(manifest, JSON.stringify({
    repo: { mode: 'git', root: repo, git_dir: null },
    prelude: [task('T1'), task('T2', { depends_on: [{ id: 'T1', kind: 'code' }] })], lanes: [], join: [],
    start_points: { prelude: start },
  }));
  return { root, repo, start, plan, spec, ledger, manifest };
}
const commit = (c, name) => {
  write(join(c.repo, name), `${name}\n`);
  git(c.repo, 'add', name);
  git(c.repo, 'commit', '-q', '-m', name);
  return git(c.repo, 'rev-parse', 'HEAD');
};
const finish = (c, from, task) => ok(py('finish-task', c.repo, 'feat', from, c.ledger, 'prelude', '--task', task));
const append = (c, entry) => ok(py('ledger', 'append', c.ledger, 'prelude', JSON.stringify(entry)));
const reviewed = (c, task, head, ...spec) =>
  py('ledger', 'reviewed', c.ledger, 'prelude', task, '0', c.plan, c.repo, head, '0', ...spec);
const events = (c) => readFileSync(join(c.ledger, 'prelude.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const lastReviewed = (c) => events(c).filter((e) => e.event === 'reviewed').at(-1);
const status = (c, ...more) => ok(py('ledger', 'status', c.ledger, '--plan', c.plan, ...more));

// One committed task T1, ready for an approval.
function oneTask() {
  const c = newCase();
  const h = commit(c, 'a.txt');
  finish(c, c.start, 'T1');
  return { c, h };
}

test('reviewed with a spec records its hash', () => {
  const { c, h } = oneTask();
  ok(reviewed(c, 'T1', h, c.spec));
  assert.equal(lastReviewed(c).spec_sha256, sha(c.spec));
});

test('reviewed with - records null', () => {
  const { c, h } = oneTask();
  ok(reviewed(c, 'T1', h, '-'));
  const ev = lastReviewed(c);
  assert.ok('spec_sha256' in ev);
  assert.equal(ev.spec_sha256, null);
});

test('the 9-argument form still records without a spec hash', () => {
  const { c, h } = oneTask();
  const res = reviewed(c, 'T1', h);
  assert.equal(res.code, 0, res.stderr);
  const ev = lastReviewed(c);
  assert.equal(ev.head, h);
  assert.ok(!('spec_sha256' in ev));
});

test('reviewed refuses a spec it cannot read, and records nothing', () => {
  const { c, h } = oneTask();
  const before = readFileSync(join(c.ledger, 'prelude.jsonl'), 'utf8');
  const res = reviewed(c, 'T1', h, join(c.root, 'missing.md'));
  assert.equal(res.code, 3);
  assert.equal(readFileSync(join(c.ledger, 'prelude.jsonl'), 'utf8'), before);
});

test('a malformed spec_sha256 in a reviewed event is refused', () => {
  const { c } = oneTask();
  const res = py('ledger', 'append', c.ledger, 'prelude',
    JSON.stringify({ task: 'T1', event: 'reviewed', rounds: 0, spec_sha256: 'abc' }));
  assert.equal(res.code, 2);
  assert.match(res.stderr, /spec_sha256/);
});

test('a changed spec makes the approval stale', () => {
  const { c, h } = oneTask();
  ok(reviewed(c, 'T1', h, c.spec));
  write(c.spec, 'spec v2\n');
  const s = status(c, '--spec', c.spec);
  assert.deepEqual(s.stale, [{ task: 'T1', reason: SPEC_CHANGED }]);
  assert.deepEqual(s.reviewed, []);
  assert.deepEqual(s.done, ['T1']);
});

test('an unchanged spec keeps the approval', () => {
  const { c, h } = oneTask();
  ok(reviewed(c, 'T1', h, c.spec));
  const s = status(c, '--spec', c.spec);
  assert.deepEqual(s.stale, []);
  assert.deepEqual(s.reviewed, ['T1']);
});

test('a spec that is now absent makes an approval that recorded one stale, and not one that recorded none', () => {
  const { c, h } = oneTask();
  ok(reviewed(c, 'T1', h, c.spec));
  let s = status(c);
  assert.deepEqual(s.stale, [{ task: 'T1', reason: SPEC_CHANGED }]);
  assert.deepEqual(s.reviewed, []);
  ok(reviewed(c, 'T1', h, '-'));
  s = status(c);
  assert.deepEqual(s.stale, []);
  assert.deepEqual(s.reviewed, ['T1']);
  // A spec that appeared after a review recorded none is a change too.
  s = status(c, '--spec', c.spec);
  assert.deepEqual(s.stale, [{ task: 'T1', reason: SPEC_CHANGED }]);
  // Without --plan nothing is checked, as before.
  assert.deepEqual(ok(py('ledger', 'status', c.ledger)).reviewed, ['T1']);
});

test('a legacy approval is stale only when the spec changed since the launch', () => {
  const { c, h } = oneTask();
  append(c, { task: '_run', event: 'run_started', phase: 'setup', head: c.start,
    plan_sha256: sha(c.plan), spec_sha256: sha(c.spec) });
  ok(reviewed(c, 'T1', h));
  let s = status(c, '--spec', c.spec);
  assert.deepEqual(s.stale, []);
  assert.deepEqual(s.reviewed, ['T1']);
  write(c.spec, 'spec v2\n');
  s = status(c, '--spec', c.spec);
  assert.equal(s.inputs.spec_changed, true);
  assert.deepEqual(s.stale, [{ task: 'T1', reason: LEGACY_CHANGED }]);
  assert.deepEqual(s.reviewed, []);
});

test('staleness spreads to dependents', () => {
  const c = newCase();
  const h1 = commit(c, 'a.txt');
  finish(c, c.start, 'T1');
  const h2 = commit(c, 'b.txt');
  finish(c, h1, 'T2');
  ok(reviewed(c, 'T1', h1, c.spec));
  // T2's approval records no spec and no launch reports a change, so only
  // its dependency on T1 can make it stale.
  ok(reviewed(c, 'T2', h2));
  assert.deepEqual(status(c, '--spec', c.spec, '--manifest', c.manifest).reviewed, ['T1', 'T2']);
  write(c.spec, 'spec v2\n');
  const s = status(c, '--spec', c.spec, '--manifest', c.manifest);
  assert.deepEqual(s.stale, [
    { task: 'T1', reason: SPEC_CHANGED },
    { task: 'T2', reason: 'it depends on T1, whose approval is stale' },
  ]);
  assert.deepEqual(s.reviewed, []);
});
