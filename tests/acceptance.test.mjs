// acceptanceOf, one failure class at a time (review finding 1: a test for
// each class). Every other gate holds in each case, so the reason listed is
// the one under test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadHelpers } from './harness.mjs';

const { acceptanceOf } = await loadHelpers(['acceptanceOf']);

const SHA = 'd1';
const passing = () => ({
  m: { commands: { test: ['npm test'], lint: [], build: [] }, hooks: {}, profile: 'full', deferred: [] },
  tasks: { T1: { status: 'done', notes: '' } },
  final: { open: [], missing_lenses: [], cannot_verify: [] },
  e2e: null,
  verify: {
    head: SHA, results: [{ group: 'test', command: 'npm test', exit: 0 }], ok: true, clean: true,
    tracked_before: [], tracked_after: [],
  },
  post: null,
  delivered_sha: SHA,
  fix_unreviewed: false,
});
const kinds = (a) => a.reasons.map((r) => [r.kind, r.class]);

test('the passing input is accepted, with no reason or warning', () => {
  const a = acceptanceOf(passing());
  assert.deepEqual([a.status, a.reasons, a.warnings], ['accepted', [], []]);
});

test('a task that is not done rejects the run', () => {
  const input = passing();
  input.tasks.T2 = { status: 'blocked', notes: 'stuck' };
  const a = acceptanceOf(input);
  assert.equal(a.status, 'rejected');
  assert.deepEqual(kinds(a), [['task_not_done', 'failed']]);
  assert.match(a.reasons[0].detail, /task T2 is blocked/);
});

test('a configured e2e check with no items is missing evidence', () => {
  const input = passing();
  input.m.hooks.e2e = 'run the checklist';
  for (const e2e of [null, { items: [], checked_sha: SHA }]) {
    const a = acceptanceOf({ ...input, e2e });
    assert.equal(a.status, 'unverified');
    assert.deepEqual(kinds(a), [['e2e_missing', 'missing']]);
  }
});

test('a configured post-integration check that never ran, or ran at another revision, is missing evidence', () => {
  const input = passing();
  input.m.hooks.post_integrate = 'smoke test';
  let a = acceptanceOf(input);
  assert.equal(a.status, 'unverified');
  assert.deepEqual(kinds(a), [['post_integrate_missing', 'missing']]);
  a = acceptanceOf({ ...input, post: { status: 'done', checked_sha: 'older', notes: '' } });
  assert.equal(a.status, 'unverified');
  assert.deepEqual(kinds(a), [['post_integrate_stale', 'missing']]);
  assert.match(a.reasons[0].detail, /covered older, not d1/);
  // Profile lite has no integration, so the hook has nothing to cover.
  assert.equal(acceptanceOf({ ...input, m: { ...input.m, profile: 'lite' } }).status, 'accepted');
});

test('a post-integration fix nobody re-reviewed is missing evidence', () => {
  const a = acceptanceOf({ ...passing(), fix_unreviewed: true });
  assert.equal(a.status, 'unverified');
  assert.deepEqual(kinds(a), [['fix_unreviewed', 'missing']]);
});

test('checks that leave the checkout dirty are a warning, not a failure', () => {
  const input = passing();
  input.verify = { ...input.verify, clean: false };
  const a = acceptanceOf(input);
  assert.equal(a.status, 'accepted');
  assert.deepEqual(a.warnings, [`the project checks left uncommitted changes in the checkout at ${SHA}`
    + ' (git status was not clean afterwards)']);
});

test('a verify result that does not say whether the checkout is clean is a warning', () => {
  const input = passing();
  const { clean, ...rest } = input.verify;
  void clean;
  const a = acceptanceOf({ ...input, verify: rest });
  assert.equal(a.status, 'accepted');
  assert.deepEqual(a.warnings, [`the project checks did not report whether the checkout was clean at ${SHA}`]);
});

// ---- Checks on uncommitted tracked changes (1.4.0, F1) ----

const unclean = (a) => a.reasons.find((r) => r.kind === 'checks_unclean');

test('checks run on uncommitted tracked changes are not accepted', () => {
  const input = passing();
  input.verify = { ...input.verify, tracked_before: [' M value.txt'], tracked_after: [' M value.txt'] };
  const a = acceptanceOf(input);
  assert.equal(a.status, 'unverified');
  assert.deepEqual(kinds(a), [['checks_unclean', 'missing']]);
  assert.ok(unclean(a).detail.includes('value.txt'), unclean(a).detail);
});

test('a staged change before the checks is not accepted', () => {
  const input = passing();
  input.verify = { ...input.verify, tracked_before: ['M  value.txt'], tracked_after: [] };
  const a = acceptanceOf(input);
  assert.equal(a.status, 'unverified');
  assert.deepEqual(kinds(a), [['checks_unclean', 'missing']]);
  assert.ok(unclean(a).detail.includes('value.txt'), unclean(a).detail);
});

test('checks that change a tracked file are not accepted', () => {
  const input = passing();
  input.verify = { ...input.verify, tracked_before: [], tracked_after: [' M package-lock.json'] };
  const a = acceptanceOf(input);
  assert.equal(a.status, 'unverified');
  assert.deepEqual(kinds(a), [['checks_unclean', 'missing']]);
  assert.ok(unclean(a).detail.includes('package-lock.json'), unclean(a).detail);
});

test('a verify result without the tracked lists is not accepted', () => {
  const input = passing();
  const { tracked_before: before, tracked_after: after, ...rest } = input.verify;
  void before;
  void after;
  const a = acceptanceOf({ ...input, verify: rest });
  assert.equal(a.status, 'unverified');
  assert.deepEqual(kinds(a), [['checks_unclean', 'missing']]);
  assert.match(unclean(a).detail, /did not report/);
  assert.match(unclean(a).detail, /tracked/);
});

test('failing checks on a dirty checkout are rejected, not just unverified', () => {
  const input = passing();
  input.verify = {
    ...input.verify, ok: false, results: [{ group: 'test', command: 'npm test', exit: 1 }], tracked_before: [' M value.txt'],
  };
  const a = acceptanceOf(input);
  assert.equal(a.status, 'rejected');
  assert.ok(a.reasons.some((r) => r.kind === 'checks_failed'), JSON.stringify(a.reasons));
});

test('untracked build output stays a warning', () => {
  const input = passing();
  input.verify = { ...input.verify, clean: false, tracked_before: [], tracked_after: [] };
  const a = acceptanceOf(input);
  assert.equal(a.status, 'accepted');
  assert.deepEqual(a.warnings, [`the project checks left uncommitted changes in the checkout at ${SHA}`
    + ' (git status was not clean afterwards)']);
});

test('a final fix nobody re-reviewed at the delivered revision is missing evidence', () => {
  const input = passing();
  input.final = { ...input.final, unreviewed_fix: 'the final fix T0..d1 was not re-reviewed: no result from final re-review' };
  const a = acceptanceOf(input);
  assert.equal(a.status, 'unverified');
  assert.deepEqual(kinds(a), [['final_fix_unreviewed', 'missing']]);
});

// ---- Structured cannot_verify (1.3.1) ----

test('mixed cannot_verify entries: only sourced ones warn', () => {
  const input = passing();
  input.final = {
    ...input.final,
    cannot_verify: [
      { requirement: 'bash 3.2', source: 'spec Testing', why: 'no macOS', check_by: 'CI' },
      'Tested: node --test passes',
    ],
  };
  const a = acceptanceOf(input);
  assert.equal(a.status, 'accepted');
  assert.equal(a.warnings.length, 1, JSON.stringify(a.warnings));
  assert.ok(a.warnings[0].includes('bash 3.2 (spec Testing)'), a.warnings[0]);
  assert.ok(!a.warnings.some((w) => w.includes('Tested: node --test passes')), JSON.stringify(a.warnings));
});

test('the engine\'s own gap notes still warn', () => {
  const input = passing();
  input.final = {
    ...input.final,
    cannot_verify: [{ requirement: 'the e2e check returned no result', source: 'run', why: 'no result', check_by: 'rerun' }],
  };
  const a = acceptanceOf(input);
  assert.equal(a.warnings.length, 1, JSON.stringify(a.warnings));
  assert.ok(a.warnings[0].includes('the e2e check returned no result'), a.warnings[0]);
});

test('an entry with an empty source does not warn', () => {
  const input = passing();
  input.final = { ...input.final, cannot_verify: [{ requirement: 'r', source: '', why: 'w', check_by: 'c' }] };
  assert.deepEqual(acceptanceOf(input).warnings, []);
});
