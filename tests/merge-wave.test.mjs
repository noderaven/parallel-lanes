// scripts/merge-wave (1.6.5 design 4.3): merges a join wave's units into the
// feature checkout by recorded sha, in the order given, idempotently; a
// conflict is aborted and reported; overlaps are the paths two units both
// changed; a wave_merged event goes to the ledger. Real git, real ledger.
// 1.6.7: --git-config gives the merges the run's identity; a merge git
// refuses (no identity, a hook, a held index.lock) is status failed, exit 4;
// every call that merged, conflicted or was refused is recorded.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { tempDir, mergeEnv } from './platform.mjs';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const TMP = realpathSync(tempDir('pl-merge-wave-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid',
};

function git(dir, ...args) {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: mergeEnv(process.env, GIT_ENV) });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.replace(/\r\n/g, '\n').trim();
}

// No identity at all (1.6.7): no global or system config, no GIT_AUTHOR_* or
// GIT_COMMITTER_* variables (nor EMAIL, which git reads as an email), so a
// case repo with user.useConfigOnly set cannot commit without -c pairs.
const EMPTY_CONFIG = join(TMP, 'empty.gitconfig');
writeFileSync(EMPTY_CONFIG, '');
const NO_ID = { GIT_CONFIG_GLOBAL: EMPTY_CONFIG, GIT_CONFIG_NOSYSTEM: '1' };
function noIdEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^GIT_(AUTHOR|COMMITTER)_/i.test(k) && k.toUpperCase() !== 'EMAIL') env[k] = v;
  }
  return { ...env, ...NO_ID };
}

const parsed = (stdout) => {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
};

// mergeWave(c, ...args[, { env }]): runs merge-wave on the case; env, when
// given, is the whole environment (default: process.env with GIT_ENV).
function mergeWave(c, ...args) {
  const opts = args.length && typeof args[args.length - 1] === 'object' ? args.pop() : {};
  const res = spawnSync('python3', ['-B', join(SCRIPTS, 'merge-wave'), c.repo, c.ledger, ...args],
    { encoding: 'utf8', env: opts.env || mergeEnv(process.env, GIT_ENV) });
  return { code: res.status, out: parsed(res.stdout), stderr: res.stderr };
}

function mergeWaveAsync(c, args, env = mergeEnv(process.env, GIT_ENV)) {
  const p = spawn('python3', ['-B', join(SCRIPTS, 'merge-wave'), c.repo, c.ledger, ...args], { env });
  let stdout = '';
  let stderr = '';
  p.stdout.on('data', (d) => { stdout += d; });
  p.stderr.on('data', (d) => { stderr += d; });
  return { child: p, done: new Promise((resolve) => p.on('close', (code) => resolve({ code, out: parsed(stdout), stderr }))) };
}

const events = (c) => (existsSync(join(c.ledger, '_run.jsonl'))
  ? readFileSync(join(c.ledger, '_run.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : []);

let counter = 0;
// A repo on feat at W with shared.txt (five lines); unit branches made by
// unit(c, id, edits) from W, each a commit writing files.
function newCase() {
  counter += 1;
  const root = join(TMP, `case ${counter}`);
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'feat');
  writeFileSync(join(repo, 'shared.txt'), 'one\ntwo\nthree\nfour\nfive\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  return { root, repo, ledger: join(root, 'ledger'), w: git(repo, 'rev-parse', 'HEAD') };
}
// A unit branch from W with one commit setting each file of files to its
// text; returns ['--unit', id, W, head].
function unit(c, id, files, from = c.w) {
  git(c.repo, 'checkout', '-q', '-b', `pl-r-u-${id}`, from);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(c.repo, name), text);
  git(c.repo, 'add', '-A');
  git(c.repo, 'commit', '-q', '-m', `unit ${id}`);
  const head = git(c.repo, 'rev-parse', 'HEAD');
  git(c.repo, 'checkout', '-q', 'feat');
  return ['--unit', id, from, head];
}
const firstParents = (c) => git(c.repo, 'log', '--first-parent', '--format=%s', `${c.w}..HEAD`).split('\n').filter(Boolean);

test('merges in the given order', () => {
  const c = newCase();
  const a = unit(c, 'A', { 'a.txt': 'a\n' });
  const b = unit(c, 'B', { 'b.txt': 'b\n' });
  const r = mergeWave(c, '--wave', '2', ...b, ...a);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.out.status, 'merged');
  assert.deepEqual(r.out.merged, ['B', 'A']);
  assert.deepEqual(r.out.skipped, []);
  assert.deepEqual(firstParents(c), ['chore: join wave 2: merge A', 'chore: join wave 2: merge B']);
  assert.equal(r.out.head, git(c.repo, 'rev-parse', 'HEAD'));
  const [ev] = events(c);
  assert.deepEqual(ev, { task: '_run', event: 'wave_merged', wave: 2, units: ['B', 'A'], merged: ['B', 'A'],
    head: r.out.head, overlaps: [], conflict_files: [] });
});

test('a rerun skips merged units and changes nothing', () => {
  const c = newCase();
  const a = unit(c, 'A', { 'a.txt': 'a\n' });
  const b = unit(c, 'B', { 'b.txt': 'b\n' });
  const first = mergeWave(c, '--wave', '1', ...a, ...b);
  assert.equal(first.code, 0, first.stderr);
  const again = mergeWave(c, '--wave', '1', ...a, ...b);
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual(again.out.merged, []);
  assert.deepEqual(again.out.skipped, ['A', 'B']);
  assert.equal(again.out.head, first.out.head);
  assert.equal(git(c.repo, 'rev-parse', 'HEAD'), first.out.head);
  assert.equal(events(c).length, 1, 'nothing merged, nothing recorded');
});

test('a conflict aborts and reports the unit and files', () => {
  const c = newCase();
  const a = unit(c, 'A', { 'shared.txt': 'one\nTWO-A\nthree\nfour\nfive\n' });
  const b = unit(c, 'B', { 'shared.txt': 'one\nTWO-B\nthree\nfour\nfive\n', 'b.txt': 'b\n' });
  const r = mergeWave(c, '--wave', '1', ...a, ...b);
  assert.equal(r.code, 1, r.stderr);
  assert.equal(r.out.status, 'conflict');
  assert.deepEqual(r.out.merged, ['A']);
  assert.equal(r.out.conflict_unit, 'B');
  assert.deepEqual(r.out.conflict_files, ['shared.txt']);
  assert.equal(git(c.repo, 'status', '--porcelain'), '', 'the checkout is clean after the abort');
  assert.equal(r.out.head, git(c.repo, 'rev-parse', 'HEAD'));
  const [ev] = events(c);
  assert.deepEqual(ev.units, ['A']);
  assert.deepEqual(ev.conflict_files, ['shared.txt']);
});

test('after a manual resolution a rerun merges the rest', () => {
  const c = newCase();
  const a = unit(c, 'A', { 'shared.txt': 'one\nTWO-A\nthree\nfour\nfive\n' });
  const b = unit(c, 'B', { 'shared.txt': 'one\nTWO-B\nthree\nfour\nfive\n' });
  const d = unit(c, 'D', { 'd.txt': 'd\n' });
  assert.equal(mergeWave(c, '--wave', '1', ...a, ...b, ...d).code, 1);
  // The resolver merges B by hand.
  spawnSync('git', ['-C', c.repo, 'merge', '--no-ff', '-m', 'join wave 1: merge B', b[3]],
    { env: mergeEnv(process.env, GIT_ENV) });
  writeFileSync(join(c.repo, 'shared.txt'), 'one\nTWO-A-B\nthree\nfour\nfive\n');
  git(c.repo, 'add', '-A');
  git(c.repo, 'commit', '-q', '--no-edit');
  const r = mergeWave(c, '--wave', '1', ...a, ...b, ...d);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.out.skipped, ['A', 'B']);
  assert.deepEqual(r.out.merged, ['D']);
});

test('overlaps lists paths two units changed', () => {
  const c = newCase();
  const a = unit(c, 'A', { 'shared.txt': 'ONE\ntwo\nthree\nfour\nfive\n', 'a.txt': 'a\n' });
  const b = unit(c, 'B', { 'shared.txt': 'one\ntwo\nthree\nfour\nFIVE\n' });
  const d = unit(c, 'D', { 'd.txt': 'd\n' });
  const r = mergeWave(c, '--wave', '3', ...a, ...b, ...d);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.out.overlaps, [{ path: 'shared.txt', units: ['A', 'B'] }]);
  assert.equal(readFileSync(join(c.repo, 'shared.txt'), 'utf8'), 'ONE\ntwo\nthree\nfour\nFIVE\n');
  assert.deepEqual(events(c)[0].overlaps, [{ path: 'shared.txt', units: ['A', 'B'] }]);
});

test('a batch unit is merged once', () => {
  const c = newCase();
  const batch = unit(c, 'J2-J3', { 'j2.txt': '2\n', 'j3.txt': '3\n' });
  const r = mergeWave(c, '--wave', '2', ...batch);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.out.merged, ['J2-J3']);
  assert.deepEqual(firstParents(c), ['chore: join wave 2: merge J2-J3']);
});

test('a dirty checkout is refused', () => {
  const c = newCase();
  const a = unit(c, 'A', { 'a.txt': 'a\n' });
  writeFileSync(join(c.repo, 'stray.txt'), 'x\n');
  const r = mergeWave(c, '--wave', '1', ...a);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /uncommitted changes/);
  assert.equal(git(c.repo, 'rev-parse', 'HEAD'), c.w);
});

test('--recovery records recovery in the event', () => {
  const c = newCase();
  const a = unit(c, 'A', { 'a.txt': 'a\n' });
  const r = mergeWave(c, '--recovery', ...a);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(firstParents(c), ['chore: join recovery: merge A']);
  const [ev] = events(c);
  assert.equal(ev.recovery, true);
  assert.equal('wave' in ev, false);
});

test('--recovery with no unit reports HEAD and records nothing', () => {
  const c = newCase();
  const r = mergeWave(c, '--recovery');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.out, { status: 'merged', head: c.w, merged: [], skipped: [], conflict_unit: null,
    conflict_files: [], overlaps: [], in_history: [], notes: [], failed_unit: null, error: null });
  assert.deepEqual(events(c), []);
});

test('an unknown sha is refused', () => {
  const c = newCase();
  const r = mergeWave(c, '--wave', '1', '--unit', 'A', c.w, '0'.repeat(40));
  assert.equal(r.code, 3);
  assert.equal(git(c.repo, 'rev-parse', 'HEAD'), c.w);
});

test('usage errors exit 2', () => {
  const c = newCase();
  const a = unit(c, 'A', { 'a.txt': 'a\n' });
  for (const args of [[...a], ['--wave', '0', ...a], ['--wave', '1', '--recovery', ...a], ['--wave', '1'],
    ['--wave', '1', '--unit', 'A', c.w], ['--wave', '1', '--unit', '../x', a[2], a[3]]]) {
    assert.equal(mergeWave(c, ...args).code, 2, args.join(' '));
  }
});

test('--known units are reported in_history without being merged', () => {
  const c = newCase();
  const a = unit(c, 'A', { 'a.txt': 'a\n' });
  const b = unit(c, 'B', { 'b.txt': 'b\n' });
  assert.equal(mergeWave(c, '--wave', '1', ...a).code, 0);
  const r = mergeWave(c, '--recovery', '--known', 'A', a[3], '--known', 'B', b[3]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.out.merged, []);
  assert.deepEqual(r.out.in_history, ['A']);
  assert.deepEqual(events(c).length, 1, 'nothing merged, nothing recorded');
  const both = mergeWave(c, '--recovery', '--unit', ...b.slice(1), '--known', 'A', a[3]);
  assert.equal(both.code, 0, both.stderr);
  assert.deepEqual(both.out.in_history, ['B', 'A']);
  assert.equal(mergeWave(c, '--recovery', '--known', 'A').code, 2, 'a --known needs ID and HEAD');
});

// ---- 1.6.7: the run's identity, refused merges, every merge recorded ----

// A case whose repo commits only with an identity from config (the setup
// commits above used GIT_ENV's variables), with units A and B.
function noIdCase() {
  const c = newCase();
  const a = unit(c, 'A', { 'a.txt': 'a\n' });
  const b = unit(c, 'B', { 'b.txt': 'b\n' });
  git(c.repo, 'config', 'user.useConfigOnly', 'true');
  return { c, a, b };
}
const IDENTITY = ['--git-config', 'user.name=Riley Q', '--git-config', 'user.email=r@x.invalid'];
const mergeInProgress = (c) => spawnSync('git', ['-C', c.repo, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'],
  { env: mergeEnv(process.env, GIT_ENV) }).status === 0;

test('a refused merge is reported as failed, not as a conflict', () => {
  const { c, a, b } = noIdCase();
  const r = mergeWave(c, '--wave', '1', ...a, ...b, { env: noIdEnv() });
  assert.equal(r.code, 4, r.stderr);
  assert.equal(r.out.status, 'failed');
  assert.equal(r.out.failed_unit, 'A');
  assert.match(r.out.error, /identity unknown/i);
  assert.ok(r.out.error.length <= 2000);
  assert.deepEqual(r.out.merged, []);
  assert.equal(r.out.conflict_unit, null);
  assert.equal(git(c.repo, 'status', '--porcelain'), '');
  assert.equal(mergeInProgress(c), false);
  assert.equal(git(c.repo, 'rev-parse', 'HEAD'), c.w);
  const evs = events(c);
  assert.equal(evs.length, 1);
  assert.deepEqual(evs[0].units, []);
  assert.deepEqual(evs[0].merged, []);
  assert.deepEqual(evs[0].failed, { unit: 'A', error: r.out.error });
  assert.equal('conflict_unit' in evs[0], false);
  assert.equal(evs[0].head, c.w);
});

test("--git-config commits with the run's identity", () => {
  const { c, a, b } = noIdCase();
  const r = mergeWave(c, '--wave', '1', ...a, ...b, ...IDENTITY, { env: noIdEnv() });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.out.status, 'merged');
  assert.deepEqual(r.out.merged, ['A', 'B']);
  assert.equal(r.out.failed_unit, null);
  assert.equal(r.out.error, null);
  assert.equal(git(c.repo, 'log', '-2', '--first-parent', '--format=%an <%ae>|%cn <%ce>'),
    'Riley Q <r@x.invalid>|Riley Q <r@x.invalid>\nRiley Q <r@x.invalid>|Riley Q <r@x.invalid>');
  assert.deepEqual(firstParents(c), ['chore: join wave 1: merge B', 'chore: join wave 1: merge A']);
  const [ev] = events(c);
  assert.deepEqual(ev.merged, ['A', 'B']);
  assert.deepEqual(ev.units, ['A', 'B']);
});

test('a refusal after a merge keeps the earlier unit', () => {
  const { c, a, b } = noIdCase();
  const hook = join(c.repo, '.git', 'hooks', 'pre-merge-commit');
  mkdirSync(join(c.repo, '.git', 'hooks'), { recursive: true });
  writeFileSync(hook, '#!/bin/sh\ngit diff --cached --name-only | grep -qx b.txt && exit 1\nexit 0\n');
  chmodSync(hook, 0o755);
  const r = mergeWave(c, '--wave', '1', ...IDENTITY, ...a, ...b, { env: noIdEnv() });
  assert.equal(r.code, 4, r.stderr);
  assert.equal(r.out.status, 'failed');
  assert.deepEqual(r.out.merged, ['A']);
  assert.equal(r.out.failed_unit, 'B');
  assert.ok(r.out.error);
  assert.deepEqual(r.out.in_history, ['A']);
  assert.equal(mergeInProgress(c), false);
  assert.equal(git(c.repo, 'status', '--porcelain'), '');
  assert.equal(r.out.head, git(c.repo, 'rev-parse', 'HEAD'));
  assert.deepEqual(firstParents(c), ['chore: join wave 1: merge A']);
  const [ev] = events(c);
  assert.deepEqual(ev.units, ['A']);
  assert.deepEqual(ev.merged, ['A']);
  assert.deepEqual(ev.failed, { unit: 'B', error: r.out.error });
  assert.equal(ev.head, r.out.head);
});

test('a held index.lock is retried once', async () => {
  const c = newCase();
  const a = unit(c, 'A', { 'a.txt': 'a\n' });
  const lock = join(c.repo, '.git', 'index.lock');
  writeFileSync(lock, '');
  // Held for 1.5 s, less than the 2 s retry wait: only a merge retried after
  // that wait succeeds, so a passing call took at least 2 s. Without the
  // retry the call fails while the lock is held, or (with a slow start)
  // merges at once in under 2 s; either fails this test.
  const started = Date.now();
  const run = mergeWaveAsync(c, ['--wave', '1', ...a]);
  setTimeout(() => rmSync(lock, { force: true }), 1500);
  const r = await run.done;
  const elapsed = Date.now() - started;
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.out.merged, ['A']);
  assert.ok(elapsed >= 2000, `the merge was retried after the 2 s wait (took ${elapsed} ms)`);

  const held = newCase();
  const h = unit(held, 'A', { 'a.txt': 'a\n' });
  writeFileSync(join(held.repo, '.git', 'index.lock'), '');
  const r2 = await mergeWaveAsync(held, ['--wave', '1', ...h]).done;
  rmSync(join(held.repo, '.git', 'index.lock'), { force: true });
  assert.equal(r2.code, 4, r2.stderr);
  assert.equal(r2.out.status, 'failed');
  assert.equal(r2.out.failed_unit, 'A');
  assert.ok(r2.out.error.includes('index.lock'), r2.out.error);
  assert.equal(git(held.repo, 'rev-parse', 'HEAD'), held.w);
});

test('a conflict on the first unit is recorded', () => {
  const c = newCase();
  writeFileSync(join(c.repo, 'shared.txt'), 'one\nTWO-FEAT\nthree\nfour\nfive\n');
  git(c.repo, 'commit', '-q', '-am', 'feat change');
  const featHead = git(c.repo, 'rev-parse', 'HEAD');
  const a = unit(c, 'A', { 'shared.txt': 'one\nTWO-A\nthree\nfour\nfive\n' });
  const r = mergeWave(c, '--wave', '1', ...a);
  assert.equal(r.code, 1, r.stderr);
  assert.equal(r.out.status, 'conflict');
  assert.equal(r.out.conflict_unit, 'A');
  assert.equal(r.out.failed_unit, null);
  assert.equal(git(c.repo, 'status', '--porcelain'), '');
  const evs = events(c);
  assert.equal(evs.length, 1);
  assert.deepEqual(evs[0], { task: '_run', event: 'wave_merged', wave: 1, units: [], merged: [], head: featHead,
    overlaps: [], conflict_files: ['shared.txt'], conflict_unit: 'A' });
});

test('--git-config refuses other keys', () => {
  const c = newCase();
  const a = unit(c, 'A', { 'a.txt': 'a\n' });
  for (const pair of ['user.signingkey=x', 'user.name=', 'core.editor=x', 'user.name']) {
    const r = mergeWave(c, '--wave', '1', ...a, '--git-config', pair);
    assert.equal(r.code, 2, pair);
    assert.match(r.stderr, /--git-config takes user\.name=VALUE or user\.email=VALUE/, pair);
  }
  assert.equal(mergeWave(c, '--wave', '1', ...a, '--git-config').code, 2, 'a --git-config needs a value');
  assert.equal(git(c.repo, 'rev-parse', 'HEAD'), c.w);
});

test('--git-config keys are matched in any case and passed lower case', () => {
  const { c, a } = noIdCase();
  const r = mergeWave(c, '--git-config', 'User.Name=O Neil', '--wave', '1', '--git-config', 'USER.EMAIL=o@x.invalid', ...a,
    { env: noIdEnv() });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(git(c.repo, 'log', '-1', '--format=%an <%ae>'), 'O Neil <o@x.invalid>');
});
