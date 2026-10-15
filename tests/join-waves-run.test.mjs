// Join waves through the whole run (1.6.5 design 4.3-4.9): the wave merge
// agent, the wave resolver, the checks after the last multi-unit wave and
// their fix, integration keeping the lane worktrees, and the final lenses
// told the overlaps. Stub agents through loadScript.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadHelpers, loadScript, H } from './harness.mjs';

const { waveResolvePrompt, waveChecksFixPrompt, waveChecksPrompt } = await loadHelpers([
  'waveResolvePrompt', 'waveChecksFixPrompt', 'waveChecksPrompt',
]);

function task(id, deps, extra = {}) {
  return {
    id, title: `Task ${id}`, files: [`src/${id}.js`], tier: 'standard', security: false,
    ...(deps === undefined ? {} : { depends_on: deps.map((d) => ({ id: d, kind: 'code' })) }), ...extra,
  };
}

function manifest(overrides = {}) {
  return {
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
    // Waves: [J1, J2], then [J3].
    join: [task('J1', []), task('J2', []), task('J3', ['J1', 'J2'])],
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
    ...overrides,
  };
}

const done = (base, head) => ({ status: 'done', base, head, tests: 'npm test: pass', notes: '' });
const blocked = (base, notes = 'stuck') => ({ status: 'blocked', base, head: base, tests: '', notes });
const approve = () => ({ verdict: 'approve', findings: [], cannot_verify: [] });
const verified = (sha) => ({
  checkout: '/work/repo', branch: 'pl/run-1', head: sha, results: [{ group: 'test', command: 'npm test', exit: 0 }],
  ok: true, clean: true, tracked_before: [], tracked_after: [], untracked_before: [], untracked_after: [],
});
const merged = (head, extra = {}) => ({
  status: 'done', head, merged: ['J1', 'J2'], conflict_unit: null, conflict_files: [], overlaps: [], checks: null,
  notes: '', ...extra,
});
const lens = (head) => ({ findings: [], cannot_verify: [], head });

// Every agent of a clean run whose join ends at tip.
function script(tip, extra = {}) {
  return {
    'pre-flight': [{ conflicts: [], rulings: [], undeclared: [], code_deps: [] }],
    'A1 implement': [done('a', H('A1'))], 'A1 review': [approve()],
    'B1 implement': [done('b', H('B1'))], 'B1 review': [approve()],
    integrate: [{ status: 'done', head: H('I1'), notes: 'merged' }],
    'J1 implement': [done(H('I1'), H('J1'))], 'J1 review': [approve()],
    'J2 implement': [done(H('I1'), H('J2'))], 'J2 review': [approve()],
    'wave 1 merge': [merged(H('M1'))],
    'J3 implement': [done(H('M1'), H('J3'))], 'J3 review': [approve()],
    'final review sp': [lens(tip)], 'final review security': [lens(tip)], 'final review correctness': [lens(tip)],
    verify: [verified(tip)],
    ...extra,
  };
}

async function run(m, scripted) {
  const calls = [];
  const logs = [];
  const agent = async (prompt, opts) => {
    calls.push({ prompt, ...opts });
    const queue = scripted[opts.label];
    if (opts.label === 'availability probe' && !queue) return { ok: true };
    if (!queue || queue.length === 0) throw new Error(`unscripted agent call: ${opts.label}`);
    return queue.shift();
  };
  const parallel = (thunks) => Promise.all(thunks.map((t) => t().catch(() => null)));
  const result = await loadScript({ args: m, agent, parallel, phase: () => {}, log: (msg) => logs.push(msg) });
  return { result, calls, logs };
}
const labels = (calls) => calls.map((c) => c.label);
const callOf = (calls, label) => calls.find((c) => c.label === label);
const at = (calls, label) => labels(calls).indexOf(label);

test('each multi-unit wave is merged before the next starts', async () => {
  const { result, calls } = await run(manifest(), script(H('J3')));
  assert.equal(result.status, 'complete', JSON.stringify(result.reason || result.errors));
  assert.ok(at(calls, 'J1 review') < at(calls, 'wave 1 merge') && at(calls, 'J2 review') < at(calls, 'wave 1 merge'));
  assert.ok(at(calls, 'wave 1 merge') < at(calls, 'J3 implement'));
  const mergePrompt = callOf(calls, 'wave 1 merge').prompt;
  assert.ok(mergePrompt.includes("/scripts/merge-wave' '/work/repo' '/work/ledger' --wave '1'"), mergePrompt);
  assert.ok(mergePrompt.includes(`--unit 'J1' '${H('I1')}' '${H('J1')}' --unit 'J2' '${H('I1')}' '${H('J2')}'`), mergePrompt);
  assert.equal(callOf(calls, 'wave 1 merge').model, 'sonnet');
  assert.ok(callOf(calls, 'J3 implement').prompt.includes(`Task base: ${H('M1')}`));
  assert.deepEqual(result.join_waves.map((w) => [w.wave, w.units, w.head]),
    [[1, ['J1', 'J2'], H('M1')], [2, ['J3'], H('J3')]]);
  assert.equal(result.tasks.J3.status, 'done');
});

test('a conflict goes to one resolver per conflict, then merges again', async () => {
  const conflict = merged(H('I1'), { status: 'conflict', merged: ['J1'], conflict_unit: 'J2', conflict_files: ['src/x.js'] });
  const { result, calls } = await run(manifest(), script(H('J3'), {
    'wave 1 merge': [conflict, merged(H('M1'))],
    'wave 1 resolve J2': [{ status: 'done', head: H('R1'), notes: 'kept both' }],
  }));
  assert.equal(result.status, 'complete', JSON.stringify(result.reason));
  assert.deepEqual(labels(calls).filter((l) => l.startsWith('wave')), ['wave 1 merge', 'wave 1 resolve J2', 'wave 1 merge']);
  const resolver = callOf(calls, 'wave 1 resolve J2');
  assert.ok(resolver.prompt.includes(H('J2')) && resolver.prompt.includes('src/x.js'));
  assert.equal(resolver.model, 'opus');
  assert.deepEqual(result.join_waves[0].resolved_files, ['src/x.js']);
});

test('a failed resolver stops the run', async () => {
  const conflict = merged(H('I1'), { status: 'conflict', merged: ['J1'], conflict_unit: 'J2', conflict_files: ['src/x.js'] });
  const { result, calls } = await run(manifest(), script(H('J3'), {
    'wave 1 merge': [conflict],
    'wave 1 resolve J2': [{ status: 'failed', head: H('I1'), notes: 'cannot reconcile' }],
  }));
  assert.equal(result.status, 'stopped');
  assert.match(result.reason, /join stopped/);
  assert.ok(!labels(calls).includes('J3 implement'));
  assert.match(result.stopped_lanes.find((s) => s.lane === 'join').reason, /resolver could not merge J2.*cannot reconcile/);
});

test('a supervised conflict stops with the sha to merge by hand', async () => {
  const conflict = merged(H('I1'), { status: 'conflict', merged: ['J1'], conflict_unit: 'J2', conflict_files: ['src/x.js'] });
  const { result, calls } = await run(manifest({ autonomy: 'supervised' }), script(H('J3'), { 'wave 1 merge': [conflict] }));
  assert.equal(result.status, 'stopped');
  assert.ok(!labels(calls).some((l) => l.includes('resolve')));
  const why = result.stopped_lanes.find((s) => s.lane === 'join').reason;
  assert.ok(why.includes(H('J2')) && /by hand/.test(why) && why.includes('src/x.js'), why);
});

const withChecks = (extra = {}) => manifest({
  task_checks: { J1: { test: ['npm test -- j1'] }, J2: { test: ['npm test -- j2'] } }, ...extra,
});

test('the last multi-unit wave\'s checks run in its merge', async () => {
  const { result, calls } = await run(withChecks(), script(H('J3'), {
    'wave 1 merge': [merged(H('M1'), { checks: { ok: true, unfinished: false, notes: 'pass' } })],
  }));
  assert.equal(result.status, 'complete', JSON.stringify(result.reason));
  const p = callOf(calls, 'wave 1 merge').prompt;
  assert.ok(p.includes("--phase 'join' --cmd 'test' 'npm test -- j1' --cmd 'test' 'npm test -- j2'"), p);
  assert.ok(p.includes('"event":"wave_checked"'), p);
  assert.deepEqual(result.join_waves[0].checks, { ok: true, unfinished: false, notes: 'pass', fixed: false });
});

test('failing wave checks get a fix, a re-review and a recheck', async () => {
  const { result, calls } = await run(withChecks(), script(H('J3'), {
    'wave 1 merge': [merged(H('M1'), { checks: { ok: false, unfinished: false, notes: 'npm test -- j2 failed' } })],
    'wave checks fix': [{ status: 'done', head: H('W1'), notes: 'fixed' }],
    'wave checks re-review': [{ findings: [] }],
    'wave checks': [{ status: 'done', head: H('W1'), ok: true, unfinished: false, notes: 'pass' }],
    'J3 implement': [done(H('W1'), H('J3'))],
  }));
  assert.equal(result.status, 'complete', JSON.stringify(result.reason));
  assert.ok(at(calls, 'wave checks fix') < at(calls, 'wave checks re-review'));
  assert.ok(at(calls, 'wave checks re-review') < at(calls, 'wave checks'));
  assert.ok(at(calls, 'wave checks') < at(calls, 'J3 implement'));
  assert.ok(callOf(calls, 'wave checks fix').prompt.includes('npm test -- j2 failed'));
  assert.equal(callOf(calls, 'wave checks fix').model, 'opus');
  assert.ok(callOf(calls, 'J3 implement').prompt.includes(`Task base: ${H('W1')}`));
  assert.equal(result.join_waves[0].head, H('W1'));
  assert.equal(result.join_waves[0].checks.ok, true);
  assert.equal(result.join_waves[0].checks.fixed, true);
});

test('still failing wave checks do not stop an autonomous run', async () => {
  const { result } = await run(withChecks(), script(H('J3'), {
    'wave 1 merge': [merged(H('M1'), { checks: { ok: false, unfinished: false, notes: 'red' } })],
    'wave checks fix': [{ status: 'done', head: H('W1'), notes: 'tried' }],
    'wave checks re-review': [{ findings: [] }],
    'wave checks': [{ status: 'done', head: H('W1'), ok: false, unfinished: false, notes: 'still red' }],
    'J3 implement': [done(H('W1'), H('J3'))],
  }));
  assert.equal(result.status, 'complete', JSON.stringify(result.reason));
  assert.equal(result.join_waves[0].checks.ok, false);
  assert.match(result.join_waves[0].checks.notes, /still red/);
  assert.ok(result.final.cannot_verify.some((c) => typeof c === 'object' && /wave 1 checks/.test(c.requirement)),
    JSON.stringify(result.final.cannot_verify));
});

test('supervised failing wave checks stop', async () => {
  const { result, calls } = await run(withChecks({ autonomy: 'supervised' }), script(H('J3'), {
    'wave 1 merge': [merged(H('M1'), { checks: { ok: false, unfinished: false, notes: 'red' } })],
  }));
  assert.equal(result.status, 'stopped');
  assert.ok(!labels(calls).includes('wave checks fix'));
  assert.match(result.stopped_lanes.find((s) => s.lane === 'join').reason, /wave checks failed: red/);
});

test('unfinished wave checks get no fix', async () => {
  const { result, calls } = await run(withChecks(), script(H('J3'), {
    'wave 1 merge': [merged(H('M1'), { checks: { ok: false, unfinished: true, notes: 'timed out' } })],
  }));
  assert.equal(result.status, 'complete', JSON.stringify(result.reason));
  assert.ok(!labels(calls).includes('wave checks fix'));
  assert.equal(result.join_waves[0].checks.unfinished, true);
});

test('an unreviewed wave checks fix is reported', async () => {
  const { result } = await run(withChecks(), script(H('J3'), {
    'wave 1 merge': [merged(H('M1'), { checks: { ok: false, unfinished: false, notes: 'red' } })],
    'wave checks fix': [{ status: 'done', head: H('W1'), notes: 'fixed' }],
    'wave checks re-review': [null], 'wave checks re-review retry': [null],
    'wave checks': [{ status: 'done', head: H('W1'), ok: true, unfinished: false, notes: 'pass' }],
    'J3 implement': [done(H('W1'), H('J3'))],
  }));
  assert.equal(result.status, 'complete', JSON.stringify(result.reason));
  assert.ok(result.final.cannot_verify.some((c) => typeof c === 'object' && /wave checks re-review returned no result/.test(c.requirement)),
    JSON.stringify(result.final.cannot_verify));
});

test('integration keeps the lane worktrees when waves run', async () => {
  const { calls } = await run(manifest(), script(H('J3')));
  assert.ok(!callOf(calls, 'integrate').prompt.includes('worktree remove'));
  const serial = manifest({ join: [task('J1'), task('J2')] });
  const plain = await run(serial, script(H('J2'), {
    'J2 implement': [done(H('J1'), H('J2'))], 'wave 1 merge': [], 'J3 implement': [], 'J3 review': [],
  }));
  assert.equal(plain.result.status, 'complete', JSON.stringify(plain.result.reason));
  assert.ok(callOf(plain.calls, 'integrate').prompt.includes('worktree remove'), 'a serial join cleans up as before');
  assert.equal(plain.result.join_waves, null);
});

test('lenses are told overlaps and resolved conflicts', async () => {
  const conflict = merged(H('I1'), { status: 'conflict', merged: ['J1'], conflict_unit: 'J2', conflict_files: ['src/c.js'] });
  const { calls } = await run(manifest(), script(H('J3'), {
    'wave 1 merge': [conflict, merged(H('M1'), { overlaps: [{ path: 'src/shared.js', units: ['J1', 'J2'] }] })],
    'wave 1 resolve J2': [{ status: 'done', head: H('R1'), notes: 'kept both' }],
  }));
  for (const name of ['final review sp', 'final review security', 'final review correctness']) {
    const p = callOf(calls, name).prompt;
    assert.ok(p.includes('src/shared.js (J1, J2)'), `${name}: overlaps`);
    assert.ok(p.includes('src/c.js'), `${name}: resolved conflicts`);
  }
});

test('waveResolvePrompt aborts on failure', () => {
  const p = waveResolvePrompt(manifest(), 1, { id: 'J2', head: H('J2') }, ['src/x.js']);
  assert.ok(p.includes("git -C '/work/repo' merge --abort"), p);
  assert.ok(p.includes("'join wave 1: merge J2'"), p);
  assert.ok(p.includes(H('J2')) && p.includes('src/x.js'));
});

test('waveChecksFixPrompt uses the fix message', () => {
  const p = waveChecksFixPrompt(manifest(), 'npm test failed');
  assert.ok(p.includes('fix: make the wave checks pass'), p);
  assert.ok(p.includes('npm test failed'));
  const c = waveChecksPrompt(manifest(), 2, [{ group: 'test', command: 'npm test -- j1' }]);
  assert.ok(c.includes("--phase 'join' --cmd 'test' 'npm test -- j1'"), c);
  assert.ok(c.includes('"wave":2'), c);
});
