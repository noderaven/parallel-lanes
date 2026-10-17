// The run's git identity (1.6.7 design 4.2): setup_result.git_identity goes
// as -c options on every merge and commit the engine spells out, and as
// --git-config to merge-wave. Without it the prompts carry no identity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadHelpers, H } from './harness.mjs';

const {
  integratePrompt, resolveConflictsPrompt, waveMergePrompt, waveResolvePrompt, gitIdentityArgs,
} = await loadHelpers([
  'integratePrompt', 'resolveConflictsPrompt', 'waveMergePrompt', 'waveResolvePrompt', 'gitIdentityArgs',
]);

function task(id) {
  return { id, title: `Task ${id}`, files: [`src/${id}.js`], tier: 'standard', security: false };
}

function manifest(identity) {
  const m = {
    version: 1,
    run_id: 'run-1',
    plan: '/work/plan.md',
    spec: '/work/spec.md',
    commit_rules: 'plain ASCII',
    repo: {
      mode: 'git', root: '/work/repo', git_dir: null, base_ref: 'main', branch: 'pl/run-1',
      worktree_root: '/work/wt', ledger_dir: '/work/ledger',
    },
    commands: { setup: ['npm ci'], test: ['npm test'], lint: [], build: [] },
    prelude: [],
    lanes: [
      { id: 'alpha', name: 'Lane alpha', tasks: [task('A1')] },
      { id: 'beta', name: 'Lane beta', tasks: [task('B1')] },
    ],
    join: [task('J1'), task('J2')],
    hooks: {},
    limits: { review_rounds: 5, max_parallel_lanes: 3 },
    dry_run: false,
    done: [],
    reviewed: [],
    sp_dir: null,
    skill_dir: '/skills/parallel-lanes',
    setup_result: {
      feature_head: H('F0'), discarded: [], worktrees: { alpha: '/work/wt/lane-alpha', beta: '/work/wt/lane-beta' },
    },
  };
  if (identity !== undefined) m.setup_result.git_identity = identity;
  return m;
}

const IDENTITY = ["user.name=Riley O'Q", 'user.email=r@x.invalid'];
const ARGS = "-c 'user.name=Riley O'\\''Q' -c 'user.email=r@x.invalid' ";
const DIR = "'/work/repo'";
const UNITS = [{ id: 'J1', base: H('I1'), head: H('J1') }, { id: 'J2', base: H('I1'), head: H('J2') }];

// Every prompt the identity reaches, built from one manifest.
function prompts(m) {
  return {
    'integrate resolve': integratePrompt(m, H('P0'), { conflictMode: 'resolve' }),
    'integrate abort': integratePrompt(m, H('P0'), { conflictMode: 'abort', testFailure: 'heal' }),
    resolver: resolveConflictsPrompt(m, H('P0'), ['src/x.js']),
    'wave merge': waveMergePrompt(m, 1, UNITS),
    'recovery merge': waveMergePrompt(m, null, UNITS),
    'wave resolver': waveResolvePrompt(m, 1, UNITS[1], ['src/x.js']),
    'recovery resolver': waveResolvePrompt(m, null, UNITS[1], ['src/x.js']),
  };
}

test('gitIdentityArgs shell-quotes each pair as a -c option with a trailing space', () => {
  assert.equal(gitIdentityArgs(manifest(IDENTITY)), ARGS);
  assert.equal(gitIdentityArgs(manifest(['user.email=r@x.invalid'])), "-c 'user.email=r@x.invalid' ");
  assert.equal(gitIdentityArgs(manifest([])), '');
  assert.equal(gitIdentityArgs(manifest()), '');
  const dry = manifest();
  delete dry.setup_result;
  assert.equal(gitIdentityArgs(dry), '');
});

test('every lane merge of integrate and the lane resolver carries the identity', () => {
  const p = prompts(manifest(IDENTITY));
  for (const name of ['integrate resolve', 'integrate abort', 'resolver']) {
    const lines = p[name].split('\n').filter((l) => l.includes('merge --no-ff'));
    assert.equal(lines.length, 2, `${name}: one merge per lane`);
    for (const line of lines) {
      assert.ok(line.includes(`git -C ${DIR} ${ARGS}merge --no-ff -m <message> `), `${name}: ${line}`);
    }
  }
});

test('the resolving prompts spell out the commit with the identity', () => {
  const p = prompts(manifest(IDENTITY));
  for (const name of ['integrate resolve', 'resolver', 'wave resolver', 'recovery resolver']) {
    assert.ok(p[name].includes(`\`git -C ${DIR} ${ARGS}commit --no-edit\``), name);
  }
  assert.ok(!p['integrate abort'].includes('commit --no-edit'), 'abort mode commits no merge');
});

test('the wave resolver merges with the identity', () => {
  const p = prompts(manifest(IDENTITY));
  assert.ok(p['wave resolver'].includes(
    `git -C ${DIR} ${ARGS}merge --no-ff -m 'chore: join wave 1: merge J2' '${H('J2')}'`), p['wave resolver']);
  assert.ok(p['recovery resolver'].includes(
    `git -C ${DIR} ${ARGS}merge --no-ff -m 'chore: join recovery: merge J2' '${H('J2')}'`), p['recovery resolver']);
});

test('the wave merge passes each pair to merge-wave as --git-config', () => {
  const p = prompts(manifest(IDENTITY));
  const pairs = "--git-config 'user.name=Riley O'\\''Q' --git-config 'user.email=r@x.invalid'";
  assert.ok(p['wave merge'].includes(`'/work/ledger' ${pairs} --wave '1' --unit`), p['wave merge']);
  assert.ok(p['recovery merge'].includes(`'/work/ledger' ${pairs} --recovery --unit`), p['recovery merge']);
});

test('with no identity the prompts carry none', () => {
  const dry = manifest();
  delete dry.setup_result;
  const none = prompts(manifest());
  for (const m of [manifest([]), dry]) {
    const p = prompts(m);
    for (const [name, text] of Object.entries(p)) assert.equal(text, none[name], name);
  }
  for (const [name, text] of Object.entries(none)) {
    assert.ok(!text.includes("-c 'user."), `${name}: no -c option`);
    assert.ok(!text.includes('--git-config'), `${name}: no --git-config`);
  }
  for (const name of ['integrate resolve', 'resolver', 'wave resolver', 'recovery resolver']) {
    assert.ok(none[name].includes(`\`git -C ${DIR} commit --no-edit\``), name);
  }
  assert.ok(none['wave merge'].includes(`'/work/ledger' --wave '1' --unit`), none['wave merge']);
  assert.ok(none['integrate resolve'].includes(`git -C ${DIR} merge --no-ff -m <message> `));
});
