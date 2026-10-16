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
  const m = manifest({ autonomy: 'supervised' });
  m.setup_result.git_identity = ["user.name=Riley O'Q", 'user.email=r@x.invalid'];
  const { result, calls } = await run(m, script(H('J3'), { 'wave 1 merge': [conflict] }));
  assert.equal(result.status, 'stopped');
  assert.ok(!labels(calls).some((l) => l.includes('resolve')));
  const why = result.stopped_lanes.find((s) => s.lane === 'join').reason;
  assert.ok(why.includes(H('J2')) && /by hand/.test(why) && why.includes('src/x.js'), why);
  const args = "-c 'user.name=Riley O'\\''Q' -c 'user.email=r@x.invalid' ";
  assert.ok(why.includes(`git -C '/work/repo' ${args}merge --no-ff -m 'join wave 1: merge J2' ${H('J2')}`),
    `the exact command: ${why}`);
  assert.ok(why.includes(`git -C '/work/repo' ${args}commit --no-edit`), `the commit: ${why}`);
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

// ---- Task 10: a relaunch after waves ran: recovery merge, restarts, serial from the tip ----

const { integratePrompt, recoveryUnits, validateManifest } = await loadHelpers(['integratePrompt', 'recoveryUnits', 'validateManifest']);

// A relaunch of manifest(): the lanes and J1 (wave 1, on the feature checkout)
// done and reviewed; wave 2's J2 and J3 ran on unit branches; join_started.
// over: the manifest fields to change (done, reviewed, backfill, ...).
function relaunch(over = {}) {
  const base = manifest();
  const range = (id, b) => ({ base: b, head: H(id) });
  return {
    ...base,
    done: ['A1', 'B1', 'J1', 'J2'],
    reviewed: ['A1', 'B1', 'J1', 'J2'],
    backfill: { A1: range('A1', 'a'), B1: range('B1', 'b'), J1: range('J1', H('I1')), J2: range('J2', H('J1')) },
    start_points: { prelude: H('F0'), join: H('I1') },
    join_started: true,
    unit_branches: {
      J2: { branch: 'pl-run-1-u-J2', dir: '/work/wt/lane-alpha' },
      J3: { branch: 'pl-run-1-u-J3', dir: '/work/wt/lane-beta' },
    },
    ...over,
  };
}
function relaunchScript(tip, extra = {}) {
  return {
    'pre-flight': [{ conflicts: [], rulings: [], undeclared: [], code_deps: [] }],
    integrate: [{ status: 'done', head: H('I1'), notes: 'already merged' }],
    'recovery merge': [{ status: 'done', head: H('R1'), merged: ['J2'], conflict_unit: '', conflict_files: [],
      overlaps: [], notes: '' }],
    'J3 implement': [done(H('R1'), H('J3'))], 'J3 review': [approve()],
    'final review sp': [lens(tip)], 'final review security': [lens(tip)], 'final review correctness': [lens(tip)],
    verify: [verified(tip)],
    ...extra,
  };
}

test('relaunch merges reviewed wave units then continues from the tip', async () => {
  const { result, calls } = await run(relaunch(), relaunchScript(H('J3')));
  assert.equal(result.status, 'complete', JSON.stringify(result.reason || result.errors));
  const rec = callOf(calls, 'recovery merge');
  assert.ok(rec.prompt.includes("--recovery --unit 'J2'"), rec.prompt);
  assert.ok(rec.prompt.includes(`--unit 'J2' '${H('J1')}' '${H('J2')}'`), 'by recorded range');
  assert.ok(!rec.prompt.includes("--unit 'J3'"));
  assert.ok(at(calls, 'integrate') < at(calls, 'recovery merge') && at(calls, 'recovery merge') < at(calls, 'J3 implement'));
  const j3 = callOf(calls, 'J3 implement').prompt;
  assert.ok(j3.includes(`Task base: ${H('R1')}`), 'the restart starts at the recovery head');
  assert.ok(j3.includes("cd '/work/repo'"), 'on the feature checkout');
  assert.ok(j3.includes('--restart'), 'its started event is a restart');
  assert.ok(!j3.includes('--unit-branch'), 'no unit branch on the continuation');
  assert.ok(j3.includes('pl-run-1-u-J3') && j3.includes('/work/wt/lane-beta'), 'it is told where its earlier work is');
  assert.ok(j3.includes('refs/parallel-lanes/run-1/abandoned/lane-beta-'), 'and the abandoned refs');
  assert.match(j3, /partial/);
  const review = callOf(calls, 'J3 review').prompt;
  assert.ok(review.includes(`${H('R1')}..${H('J3')}`), 'its review covers only its own range');
  assert.equal(result.tasks.J3.status, 'done');
  assert.equal(result.final.head, H('J3'));
  assert.ok(!labels(calls).some((l) => /^J[12] /.test(l)), 'merged and reviewed units are not run again');
});

test('a done but unreviewed wave unit restarts and is not recovered', async () => {
  const m = relaunch({ done: ['A1', 'B1', 'J1', 'J2', 'J3'], reviewed: ['A1', 'B1', 'J1', 'J2'],
    backfill: { ...relaunch().backfill, J3: { base: H('J1'), head: H('J3old') } } });
  const { result, calls } = await run(m, relaunchScript(H('J3')));
  assert.equal(result.status, 'complete', JSON.stringify(result.reason || result.errors));
  assert.ok(!callOf(calls, 'recovery merge').prompt.includes("--unit 'J3'"));
  const j3 = callOf(calls, 'J3 implement').prompt;
  assert.ok(j3.includes('--restart'));
  assert.match(j3, /complete/);
  assert.ok(!labels(calls).includes('J3 review') || at(calls, 'J3 implement') < at(calls, 'J3 review'),
    'implemented again, not only reviewed');
});

test('the recovery merge runs with nothing to merge', async () => {
  const m = relaunch({ done: ['A1', 'B1', 'J1'], reviewed: ['A1', 'B1', 'J1'],
    backfill: { A1: relaunch().backfill.A1, B1: relaunch().backfill.B1, J1: relaunch().backfill.J1 } });
  const { result, calls } = await run(m, relaunchScript(H('J3'), {
    'recovery merge': [{ status: 'done', head: H('J1'), merged: [], conflict_unit: '', conflict_files: [], overlaps: [], notes: '' }],
    'J2 implement': [done(H('J1'), H('J2'))], 'J2 review': [approve()],
    'J3 implement': [done(H('J2'), H('J3'))],
  }));
  assert.equal(result.status, 'complete', JSON.stringify(result.reason || result.errors));
  assert.ok(callOf(calls, 'recovery merge').prompt.includes("--recovery"));
  assert.ok(callOf(calls, 'J2 implement').prompt.includes(`Task base: ${H('J1')}`));
  assert.ok(callOf(calls, 'J3 implement').prompt.includes(`Task base: ${H('J2')}`), 'serial from the tip');
});

test('a supervised recovery conflict stops', async () => {
  const { result, calls } = await run(relaunch({ autonomy: 'supervised' }), relaunchScript(H('J3'), {
    'recovery merge': [{ status: 'conflict', head: H('I1'), merged: [], conflict_unit: 'J2', conflict_files: ['src/x.js'],
      overlaps: [], notes: '' }],
  }));
  assert.equal(result.status, 'stopped');
  assert.ok(!labels(calls).includes('J3 implement'));
  const why = result.stopped_lanes.find((s) => s.lane === 'join').reason;
  assert.ok(why.includes(H('J2')) && /by hand/.test(why), why);
});

test('an autonomous recovery conflict goes to a resolver', async () => {
  const { result, calls } = await run(relaunch(), relaunchScript(H('J3'), {
    'recovery merge': [
      { status: 'conflict', head: H('I1'), merged: [], conflict_unit: 'J2', conflict_files: ['src/x.js'], overlaps: [], notes: '' },
      { status: 'done', head: H('R1'), merged: [], conflict_unit: '', conflict_files: [], overlaps: [], notes: '' },
    ],
    'recovery resolve J2': [{ status: 'done', head: H('R1'), notes: 'kept both' }],
  }));
  assert.equal(result.status, 'complete', JSON.stringify(result.reason));
  assert.ok(callOf(calls, 'recovery resolve J2').prompt.includes("'join recovery: merge J2'"));
});

test('a relaunch of a serial join keeps the serial path', async () => {
  const m = relaunch({ unit_branches: {}, done: ['A1', 'B1', 'J1'], reviewed: ['A1', 'B1', 'J1'],
    backfill: { A1: relaunch().backfill.A1, B1: relaunch().backfill.B1, J1: relaunch().backfill.J1 } });
  const { result, calls } = await run(m, relaunchScript(H('J3'), {
    'J2 implement': [done(H('J1'), H('J2'))], 'J2 review': [approve()],
    'J3 implement': [done(H('J2'), H('J3'))],
  }));
  assert.equal(result.status, 'complete', JSON.stringify(result.reason || result.errors));
  assert.ok(!labels(calls).includes('recovery merge'));
  assert.ok(!callOf(calls, 'J2 implement').prompt.includes('--restart'));
});

test('recoveryUnits takes reviewed or deferred units with a unit branch', () => {
  const m = relaunch({ done: ['A1', 'B1', 'J1', 'J2', 'J3'], reviewed: ['A1', 'B1', 'J1', 'J2'], deferred: ['J3'],
    backfill: { ...relaunch().backfill, J3: { base: H('J1'), head: H('J3') } } });
  assert.deepEqual(recoveryUnits(m), [
    { id: 'J2', base: H('J1'), head: H('J2') },
    { id: 'J3', base: H('J1'), head: H('J3') },
  ]);
  assert.deepEqual(recoveryUnits(relaunch({ unit_branches: {} })), []);
});

test('the audit allowance uses join_tip', () => {
  const m = relaunch({ done: ['A1', 'B1', 'J1', 'J2', 'J3'], reviewed: ['A1', 'B1', 'J1', 'J2', 'J3'],
    backfill: { ...relaunch().backfill, J3: { base: H('R1'), head: H('J3') } }, join_tip: H('W9') });
  const p = integratePrompt(m, H('pre'), {});
  assert.ok(p.includes(`may follow the last join commit ${H('W9')}`), p);
  assert.ok(p.includes("'join wave <n>: merge <unit>'") && p.includes("'join recovery: merge <unit>'"), p);
  assert.ok(p.includes('fix: make the wave checks pass'), p);
});

// ---- Task 11: pre-flight sees the waves ----

test('pre-flight is shown the waves', async () => {
  const { calls } = await run(manifest(), script(H('J3')));
  const p = callOf(calls, 'pre-flight').prompt;
  assert.ok(p.includes('wave 1: J1, J2') && p.includes('wave 2: J3'), p);
  assert.ok(p.includes('the run moves the task to a later wave'), p);
});

test('an earlier-producer finding moves the unit to a later wave and is reported', async () => {
  const m = manifest({ join: [task('J1', []), task('J2', []), task('J3', [])] });
  const { result, calls } = await run(m, script(H('J3'), {
    'pre-flight': [{ conflicts: [], rulings: [], undeclared: [{ task: 'J3', producer: 'J2', what: 'a test helper' }],
      code_deps: [] }],
    'J3 implement': [done(H('M1'), H('J3'))],
  }));
  assert.equal(result.status, 'complete', JSON.stringify(result.reason || result.errors));
  assert.deepEqual(result.preflight.wave_moves, [{ unit: 'J3', from: 1, to: 2, producer: 'J2' }]);
  assert.ok(callOf(calls, 'wave 1 merge').prompt.includes("--unit 'J2'") && !callOf(calls, 'wave 1 merge').prompt.includes("--unit 'J3'"));
  assert.ok(at(calls, 'wave 1 merge') < at(calls, 'J3 implement'));
  assert.ok(callOf(calls, 'J3 implement').prompt.includes("cd '/work/repo'"), 'J3 runs alone, on the feature checkout');
});

test('a later-producer code dependency is still a schedule conflict', async () => {
  const { result } = await run(manifest(), script(H('J3'), {
    'pre-flight': [{ conflicts: [], rulings: [], undeclared: [], code_deps: [{ task: 'J1', producer: 'J2', what: 'calls it' }] }],
  }));
  assert.equal(result.status, 'preflight_conflicts');
  assert.match(result.preflight.schedule[0].fix, /move J1 to join after J2/);
});

test('a serial join\'s pre-flight prompt is unchanged', async () => {
  const m = manifest({ join: [task('J1'), task('J2')] });
  const { calls } = await run(m, script(H('J2'), {
    'J2 implement': [done(H('J1'), H('J2'))], 'wave 1 merge': [], 'J3 implement': [], 'J3 review': [],
  }));
  assert.ok(!callOf(calls, 'pre-flight').prompt.includes('Join waves'));
});

// ---- Final review fixes ----

test('a stale merged wave unit is reviewed over its range, not redone', async () => {
  const m = relaunch({ reviewed: ['A1', 'B1', 'J1'] });
  const { result, calls } = await run(m, relaunchScript(H('J3'), {
    'recovery merge': [{ status: 'done', head: H('R1'), merged: [], in_history: ['J2'], conflict_unit: '',
      conflict_files: [], overlaps: [], notes: '' }],
    'J2 review': [approve()],
  }));
  assert.equal(result.status, 'complete', JSON.stringify(result.reason || result.errors));
  const rec = callOf(calls, 'recovery merge').prompt;
  assert.ok(rec.includes(`--known 'J2' '${H('J2')}'`), rec);
  assert.ok(!labels(calls).includes('J2 implement'), 'merged work is not redone');
  assert.ok(callOf(calls, 'J2 review').prompt.includes(`${H('J1')}..${H('J2')}`), 'reviewed over its recorded range');
  assert.ok(callOf(calls, 'J3 implement').prompt.includes(`Task base: ${H('R1')}`), 'the tip does not move back');
  assert.equal(result.final.head, H('J3'));
});

test('a stale feature-checkout unit does not move the join head back', async () => {
  const m = relaunch({ reviewed: ['A1', 'B1', 'J2'] });
  const { result, calls } = await run(m, relaunchScript(H('J3'), {
    'recovery merge': [{ status: 'done', head: H('R1'), merged: [], in_history: ['J2'], conflict_unit: '',
      conflict_files: [], overlaps: [], notes: '' }],
    'J1 review': [approve()],
  }));
  assert.equal(result.status, 'complete', JSON.stringify(result.reason || result.errors));
  assert.ok(callOf(calls, 'J1 review').prompt.includes(`${H('I1')}..${H('J1')}`));
  assert.ok(callOf(calls, 'J3 implement').prompt.includes(`Task base: ${H('R1')}`), 'J3 starts at the tip, not at J1');
  assert.equal(result.final.head, H('J3'));
});

test('a serial unit stopped part-way restarts its range at its started base', async () => {
  const m = relaunch({ unit_branches: { J2: { branch: 'pl-run-1-u-J2', dir: '/work/wt/lane-alpha' } },
    start_bases: { J3: H('S3') } });
  const { result, calls } = await run(m, relaunchScript(H('J3'), {
    'J3 implement': [done(H('S3'), H('J3'))],
  }));
  assert.equal(result.status, 'complete', JSON.stringify(result.reason || result.errors));
  const p = callOf(calls, 'J3 implement').prompt;
  assert.ok(p.includes(`Task base: ${H('S3')}`), 'its earlier partial commits stay in its range');
  assert.ok(!p.includes('--restart'));
});

test('start_bases must name tasks of the run', () => {
  assert.ok(validateManifest(relaunch({ start_bases: { J3: H('S3') } })).length === 0);
  assert.ok(validateManifest(relaunch({ start_bases: { NOPE: H('S3') } })).some((e) => e.includes('start_bases')));
  assert.ok(validateManifest(relaunch({ start_bases: [] })).some((e) => e.includes('start_bases')));
});
