import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadHelpers, loadScript } from './harness.mjs';

const { planAgents, validateManifest, dedupeFindings, preflightPrompt, preflightSchema } = await loadHelpers([
  'planAgents', 'validateManifest', 'dedupeFindings', 'preflightPrompt', 'preflightSchema',
]);

function task(id, extra = {}) {
  return { id, title: `Task ${id}`, files: [`src/${id}.js`], tier: 'standard', security: false, ...extra };
}

function manifest(overrides = {}) {
  return {
    version: 1,
    run_id: 'run-1',
    plan: '/work/my plan.md',
    spec: '/work/spec.md',
    commit_rules: 'COMMIT-RULES: plain ASCII, no trailers',
    repo: {
      mode: 'git',
      root: '/work/repo',
      git_dir: null,
      base_ref: 'main',
      branch: 'pl/run-1',
      worktree_root: '/work/wt',
      ledger_dir: '/work/ledger',
    },
    commands: { setup: ['npm ci'], test: ['npm test'], lint: [], build: [] },
    prelude: [task('T1')],
    lanes: [
      { id: 'alpha', name: 'Lane alpha', tasks: [task('T2'), task('T3')] },
      { id: 'beta', name: 'Lane beta', tasks: [task('T4')] },
    ],
    join: [task('T5')],
    hooks: { post_integrate: 'POST-INTEGRATE: check contracts', e2e: 'E2E-HOOK: run the checklist' },
    limits: { review_rounds: 5, max_parallel_lanes: 3 },
    dry_run: false,
    done: [],
    reviewed: [],
    sp_dir: '/sp/skills',
    skill_dir: '/skills/parallel-lanes',
    // scripts/setup's output: the only setup (validateManifest requires it).
    setup_result: {
      feature_head: 'F0', discarded: [], worktrees: { alpha: '/work/wt/lane-alpha', beta: '/work/wt/lane-beta' },
    },
    ...overrides,
  };
}

// The run-checks JSON the verify agent returns for manifest()'s commands at sha.
const verified = (sha, exit = 0) => ({
  checkout: '/work/repo', branch: 'pl/run-1', head: sha,
  results: [{ group: 'test', command: 'npm test', exit }], ok: exit === 0, clean: true,
});

const done = (base, head) => ({ status: 'done', base, head, tests: 'npm test: pass', notes: '' });
const blocked = (base, notes = 'stuck') => ({ status: 'blocked', base, head: base, tests: '', notes });
const approve = () => ({ verdict: 'approve', findings: [], cannot_verify: [] });
const finding = (issue, file = 'src/a.js', line = 3) => ({ severity: 'important', file, line, issue, fix: 'fix it' });

// Results for every non-task agent of a clean run: the final review finds two
// findings (F1, F2), the fix commits f1 and fixes both, and the checks rerun
// at f1, the delivered revision.
function phaseScript(extra = {}) {
  return {
    'pre-flight': [{ conflicts: [], rulings: ['Ruling: x - y - z'], undeclared: [] }],
    integrate: [{ status: 'done', head: 'I1', notes: 'merged' }],
    'post-integrate': [{ status: 'done', head: 'P1', notes: 'contracts ok' }],
    e2e: [{ head: 'T5-h', items: [{ item: 'login', result: 'PASS', evidence: 'ok' }] }],
    'final review sp': [{ findings: [finding('dup issue')], cannot_verify: [], head: 'T5-h' }],
    'final review security': [{ findings: [finding('dup issue'), finding('sec issue', 'src/b.js', 9)], cannot_verify: [], head: 'T5-h' }],
    'final review correctness': [{ findings: [], cannot_verify: [], head: 'T5-h' }],
    'final fix': [{ status: 'done', head: 'f1', tests: 'all pass', notes: '', dispositions: [
      { id: 'F1', status: 'fixed', reason: 'fixed' }, { id: 'F2', status: 'fixed', reason: 'fixed' },
    ] }],
    'final re-review': [{ results: [
      { id: 'F1', status: 'resolved', evidence: 'gone' }, { id: 'F2', status: 'resolved', evidence: 'gone' },
    ], new_findings: [] }],
    verify: [verified('f1')],
    'e2e recheck': [{ head: 'f1', items: [{ item: 'login', result: 'PASS', evidence: 'ok' }] }],
    'post-integrate recheck': [{ status: 'done', head: 'f1', notes: 'contracts ok at f1' }],
    ...extra,
  };
}

function taskScript(ids) {
  const script = {};
  for (const id of ids) {
    script[`${id} implement`] = [done(`${id}-b`, `${id}-h`)];
    script[`${id} review`] = [approve()];
  }
  return script;
}

// Run the whole script body with stub globals. Unscripted agent labels
// throw, so unexpected calls fail the test.
async function run(m, script) {
  const calls = [];
  const logs = [];
  const phases = [];
  const agent = async (prompt, opts) => {
    calls.push({ prompt, ...opts });
    const queue = script[opts.label];
    if (!queue || queue.length === 0) throw new Error(`unscripted agent call: ${opts.label}`);
    return queue.shift();
  };
  const parallel = (thunks) => Promise.all(thunks.map((t) => t().catch(() => null)));
  const result = await loadScript({
    args: m,
    agent,
    parallel,
    phase: (title) => phases.push(title),
    log: (msg) => logs.push(msg),
  });
  return { result, calls, logs, phases };
}

const labels = (calls) => calls.map((c) => c.label);

// Distinct phases in order of first appearance.
function phaseOrder(calls) {
  const seen = [];
  for (const c of calls) if (!seen.includes(c.phase)) seen.push(c.phase);
  return seen;
}

const ALL = ['T1', 'T2', 'T3', 'T4', 'T5'];

// Backfill ranges for done tasks, as SKILL.md Resume builds them.
function backfillFor(ids) {
  return Object.fromEntries(ids.map((id) => [id, { base: `${id}-old-b`, head: `${id}-old-h` }]));
}

test('happy path: complete, phases in order, report filled in', async () => {
  const m = manifest();
  const { result, calls, logs, phases } = await run(m, { ...phaseScript(), ...taskScript(ALL) });
  assert.equal(result.status, 'complete');
  assert.equal(result.run_id, 'run-1');
  const order = ['Pre-flight', 'Prelude', 'Lane alpha', 'Lane beta', 'Integrate', 'Join', 'E2E', 'Final review', 'Verify'];
  assert.deepEqual(phaseOrder(calls), order);
  assert.deepEqual(phases, ['Pre-flight', 'Prelude', 'Integrate', 'Join', 'E2E', 'Final review', 'Verify']);
  // Lane calls all sit between the prelude and integration.
  const idx = (pred) => calls.findIndex(pred);
  const lastIdx = (pred) => calls.length - 1 - [...calls].reverse().findIndex(pred);
  const lane = (c) => c.phase.startsWith('Lane ');
  assert.ok(lastIdx((c) => c.phase === 'Prelude') < idx(lane));
  assert.ok(lastIdx(lane) < idx((c) => c.phase === 'Integrate'));
  // post_integrate is its own agent right after integrate, in the Integrate phase.
  const integ = labels(calls).indexOf('integrate');
  assert.equal(labels(calls)[integ + 1], 'post-integrate');
  assert.equal(calls[integ + 1].phase, 'Integrate');
  assert.ok(calls[integ + 1].prompt.includes('POST-INTEGRATE: check contracts'));
  assert.ok(!calls[integ].prompt.includes('POST-INTEGRATE'), 'hook text is not in the integrate prompt');

  const bases = { T1: 'F0', T2: 'T1-h', T3: 'T2-h', T4: 'T1-h', T5: 'P1' };
  for (const id of ALL) {
    const t = result.tasks[id];
    assert.equal(t.status, 'done', id);
    assert.equal(t.rounds, 0);
    assert.equal(t.tier_used, 'standard');
    assert.deepEqual(t.commits, [bases[id], `${id}-h`]);
  }
  assert.deepEqual(result.stopped_lanes, []);
  assert.deepEqual(result.preflight, { conflicts: [], rulings: ['Ruling: x - y - z'], undeclared: [] });
  assert.equal(result.integrate.status, 'done');
  assert.equal(result.integrate.post_integrate.status, 'done');
  assert.deepEqual(result.e2e.items.map((i) => i.result), ['PASS']);
  assert.equal(result.final.findings.length, 2);
  assert.deepEqual(result.final.findings.map((f) => f.id), ['F1', 'F2']);
  assert.equal(result.final.fixed.length, 2);
  assert.deepEqual(result.final.declined, []);
  assert.deepEqual(result.final.open, []);
  // The final fix moved the head, so every check reran at the delivered f1.
  assert.equal(result.delivered_sha, 'f1');
  assert.equal(result.verify.head, 'f1');
  assert.equal(result.e2e.checked_sha, 'f1');
  assert.deepEqual(result.acceptance, { status: 'accepted', delivered_sha: 'f1', reasons: [], warnings: [] });
  assert.equal(result.agents_spawned, calls.length);
  assert.equal(result.agents_spawned, planAgents(m).length, 'no fix rounds: matches the dry-run plan');
  assert.ok(logs.includes(`parallel-lanes: launching run run-1: 2 lanes, ${planAgents(m).length} agents`), JSON.stringify(logs));
  assert.ok(!logs.some((l) => l.includes('resuming')));

  // Prelude and join tasks run on the feature branch in the main checkout,
  // with their own ledger lane; lane tasks run in their worktrees.
  const t1 = calls.find((c) => c.label === 'T1 implement');
  assert.ok(t1.prompt.includes('Worktree: /work/repo (branch pl/run-1)'));
  assert.ok(t1.prompt.includes("append '/work/ledger' 'prelude'"));
  const t5 = calls.find((c) => c.label === 'T5 implement');
  assert.ok(t5.prompt.includes("append '/work/ledger' 'join'"));
  const t2 = calls.find((c) => c.label === 'T2 implement');
  assert.ok(t2.prompt.includes('Worktree: /work/wt/lane-alpha (branch pl-run-1-alpha)'));
  assert.ok(t2.prompt.includes("append '/work/ledger' 'alpha'"));
  assert.ok(t2.prompt.includes("scripts/start-task' '/work/wt/lane-alpha' '/work/my plan.md' --artifacts '/work/ledger' --sync 'pl/run-1' "),
    'lane picks up the prelude commits');

  // The script owns every review base: setup's feature head, then each
  // task's head; lanes start at the prelude tip, join at the integrated tip.
  const review = (id) => calls.find((c) => c.label === `${id} review`).prompt;
  assert.ok(review('T1').includes('F0..T1-h'));
  assert.ok(review('T2').includes('T1-h..T2-h'));
  assert.ok(review('T3').includes('T2-h..T3-h'));
  assert.ok(review('T4').includes('T1-h..T4-h'));
  assert.ok(review('T5').includes('P1..T5-h'), 'join starts after post-integrate');
  for (const id of ALL) assert.deepEqual(result.tasks[id].commits.length, 2);
});

test('mechanical phases start on sonnet high; everything else runs opus high and all carry the commit rules', async () => {
  const m = manifest();
  m.lanes[1].tasks[0].tier = 'light';
  const { calls } = await run(m, { ...phaseScript(), ...taskScript(ALL) });
  // Integrate and e2e start on Sonnet (D5); the light T4 implementer too. On a
  // clean run they succeed first try, so no Opus rerun follows.
  const sonnet = new Set(['T4 implement', 'integrate', 'e2e', 'verify', 'e2e recheck']);
  for (const c of calls) {
    assert.ok(c.prompt.includes('COMMIT-RULES: plain ASCII, no trailers'), c.label);
    assert.ok(/^[\x00-\x7f]*$/.test(c.prompt), `${c.label}: plain ASCII`);
    const want = sonnet.has(c.label) ? ['sonnet', 'high'] : ['opus', 'high'];
    assert.deepEqual([c.model, c.effort], want, c.label);
  }
});

test('a launch never spawns a setup agent: setup comes only from scripts/setup', async () => {
  const { calls } = await run(manifest(), { ...phaseScript(), ...taskScript(ALL) });
  assert.ok(!calls.some((c) => c.label === 'setup' || c.phase === 'Setup'));
  const m = manifest();
  delete m.setup_result;
  const invalid = await run(m, {});
  assert.equal(invalid.result.status, 'invalid');
  assert.ok(invalid.result.errors.some((e) => e.startsWith('setup_result: missing')), JSON.stringify(invalid.result.errors));
  assert.deepEqual(invalid.calls, []);
});

test('shadow mode: worktrees via --git-dir and a feature worktree for prelude and join', async () => {
  const m = manifest();
  m.repo.mode = 'shadow';
  m.repo.git_dir = '/shadow/abc';
  const { result, calls } = await run(m, { ...phaseScript(), ...taskScript(ALL) });
  assert.equal(result.status, 'complete');
  const t1 = calls.find((c) => c.label === 'T1 implement');
  assert.ok(t1.prompt.includes('Worktree: /work/wt/feature (branch pl/run-1)'));
  const integ = calls.find((c) => c.label === 'integrate').prompt;
  assert.ok(integ.includes('/work/wt/feature'));
});

test('integrate prompt: lane order, --no-ff, scratch check, clean-only cleanup', async () => {
  const { calls } = await run(manifest(), { ...phaseScript(), ...taskScript(ALL) });
  const p = calls.find((c) => c.label === 'integrate').prompt;
  assert.ok(p.includes('--no-ff'));
  assert.ok(p.indexOf("'pl-run-1-alpha'") < p.indexOf("'pl-run-1-beta'"), 'lane order');
  assert.ok(p.includes('.superpowers/'));
  assert.ok(p.includes('npm test') && p.includes('npm ci'));
  assert.match(p, /worktree remove/);
  assert.ok(!p.includes('--force'), 'never force-removes a worktree');
  assert.match(p, /Cleanup never fails the integration/);
});

test('shadow integrate prompt: lane branches are deleted from the feature worktree, cleanup is non-fatal', async () => {
  const m = manifest();
  m.repo.mode = 'shadow';
  m.repo.git_dir = '/shadow/abc';
  const { calls } = await run(m, { ...phaseScript(), ...taskScript(ALL) });
  const p = calls.find((c) => c.label === 'integrate').prompt;
  for (const lane of ['alpha', 'beta']) {
    assert.ok(p.includes(`git -C '/work/wt/feature' branch -d 'pl-run-1-${lane}'`), lane);
    assert.ok(p.includes(`git --git-dir='/shadow/abc' worktree remove '/work/wt/lane-${lane}'`), lane);
  }
  assert.ok(!p.includes("git --git-dir='/shadow/abc' branch -d"), 'the bare shadow HEAD is pl-base, not the feature branch');
  assert.match(p, /first of steps 1-5 that fails/);
  assert.match(p, /Cleanup never fails the integration/);
});

test('pre-flight conflicts stop before any implement (supervised)', async () => {
  const m = manifest({ autonomy: 'supervised' });
  const script = phaseScript({ 'pre-flight': [{ conflicts: ['plan contradicts spec on X'], rulings: [], undeclared: [] }] });
  const { result, calls } = await run(m, script);
  assert.equal(result.status, 'preflight_conflicts');
  assert.deepEqual(result.preflight.conflicts, ['plan contradicts spec on X']);
  assert.deepEqual(labels(calls), ['pre-flight']);
  assert.ok(!labels(calls).some((l) => l.endsWith('implement')));
});

test('a pre-flight agent that returns null twice stops the run', async () => {
  const { result, calls } = await run(manifest(),
    phaseScript({ 'pre-flight': [null], 'pre-flight retry': [null] }));
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'no result from pre-flight');
  assert.deepEqual(labels(calls), ['pre-flight', 'pre-flight retry']);
});

test('setup lists discarded changes and the refs that saved them via log', async () => {
  const m = manifest();
  m.setup_result.discarded = ['lane-alpha: M src/T2.js'];
  m.setup_result.preserved = [{ worktree: '/work/wt/lane-alpha', ref: 'refs/parallel-lanes/run-1/abandoned/lane-alpha-x', commit: 'c0' }];
  const { logs } = await run(m, { ...phaseScript(), ...taskScript(ALL) });
  assert.ok(logs.some((l) => l.includes('lane-alpha: M src/T2.js')), JSON.stringify(logs));
  assert.ok(logs.some((l) => l.includes('refs/parallel-lanes/run-1/abandoned/lane-alpha-x (c0)')), JSON.stringify(logs));
});

test('an invalid manifest returns invalid with errors and spawns nothing', async () => {
  const m = manifest();
  delete m.plan;
  const { result, calls } = await run(m, {});
  assert.equal(result.status, 'invalid');
  assert.ok(result.errors.some((e) => e.includes('plan')));
  assert.deepEqual(calls, []);
  assert.equal(result.agents_spawned, 0);
});

test('resume with every task done and reviewed: no task agents, integration still runs', async () => {
  const m = manifest({ done: [...ALL], reviewed: [...ALL], backfill: backfillFor(ALL) });
  const { result, calls, logs } = await run(m, phaseScript());
  assert.equal(result.status, 'complete');
  assert.deepEqual(labels(calls).slice(0, 3), ['pre-flight', 'integrate', 'post-integrate']);
  assert.ok(!calls.some((c) => c.phase.startsWith('Lane ') || c.phase === 'Prelude' || c.phase === 'Join'));
  for (const id of ALL) assert.equal(result.tasks[id].status, 'skipped', id);
  assert.ok(logs.includes('parallel-lanes: resuming run run-1: 5 tasks already committed'), JSON.stringify(logs));
  assert.ok(!logs.some((l) => l.includes('launching')));
});

test('resume with only lane tasks done and reviewed: lanes skipped, empty lanes do not crash', async () => {
  const m = manifest({
    prelude: [], join: [], done: ['T2', 'T3', 'T4'], reviewed: ['T2', 'T3', 'T4'], backfill: backfillFor(['T2', 'T3', 'T4']),
  });
  const { result, calls } = await run(m, phaseScript());
  assert.equal(result.status, 'complete');
  assert.ok(!calls.some((c) => c.phase.startsWith('Lane ')));
  assert.ok(labels(calls).includes('integrate'));
});

test('a done but unreviewed task is reviewed from the previous head before the lane continues', async () => {
  const m = manifest({
    done: ['T1', 'T2'],
    reviewed: ['T1'],
    backfill: { T1: { base: 'p0', head: 'p1' }, T2: { base: 'old-b', head: 'old-h' } },
  });
  const script = { ...phaseScript(), ...taskScript(['T3', 'T4', 'T5']), 'T2 review': [approve()] };
  const { result, calls, logs } = await run(m, script);
  assert.equal(result.status, 'complete');
  const l = labels(calls);
  assert.ok(!l.includes('T2 implement'));
  assert.ok(!l.includes('T1 implement') && !l.includes('T1 review'));
  assert.ok(l.indexOf('T2 review') < l.indexOf('T3 implement'));
  const rev = calls.find((c) => c.label === 'T2 review').prompt;
  // The range starts at the prelude tip (T1's head), not at the ledger's
  // first T2 commit, so commits of an unrecorded attempt are reviewed too.
  assert.ok(rev.includes('p1..old-h'));
  assert.equal(result.tasks.T2.status, 'done');
  assert.deepEqual(result.tasks.T2.commits, ['p1', 'old-h']);
  assert.deepEqual(result.tasks.T1.commits, ['p0', 'p1']);
  assert.ok(calls.find((c) => c.label === 'T3 review').prompt.includes('old-h..T3-h'));
  assert.ok(logs.includes('parallel-lanes: resuming run run-1: 2 tasks already committed'));
});

test('a backfilled review that requests changes runs the normal fix loop', async () => {
  const m = manifest({ done: ['T2'], reviewed: [], backfill: { T2: { base: 'old-b', head: 'old-h' } } });
  const script = {
    ...phaseScript(),
    ...taskScript(['T1', 'T3', 'T4', 'T5']),
    'T2 review': [{ verdict: 'changes', findings: [finding('old bug')], cannot_verify: [] }],
    'T2 fix 1': [done('old-h', 'new-h')],
    'T2 re-review 1': [approve()],
  };
  const { result, calls } = await run(m, script);
  const l = labels(calls);
  assert.ok(l.indexOf('T2 re-review 1') < l.indexOf('T3 implement'));
  assert.ok(calls.find((c) => c.label === 'T2 fix 1').prompt.includes('old bug'));
  assert.equal(result.tasks.T2.rounds, 1);
  assert.deepEqual(result.tasks.T2.commits, ['T1-h', 'new-h']);
});

test('a stopped lane yields stopped and integration does not run', async () => {
  const m = manifest({ autonomy: 'supervised' });
  const script = { ...phaseScript(), ...taskScript(['T1', 'T3', 'T4', 'T5']), 'T2 implement': [blocked('T2-b', 'need a contract change')] };
  const { result, calls } = await run(m, script);
  assert.equal(result.status, 'stopped');
  assert.equal(result.stopped_lanes.length, 1);
  assert.equal(result.stopped_lanes[0].lane, 'alpha');
  assert.equal(result.stopped_lanes[0].task, 'T2');
  assert.ok(result.stopped_lanes[0].reason.includes('need a contract change'));
  assert.ok(!labels(calls).includes('T3 implement'));
  assert.ok(labels(calls).includes('T4 review'), 'the other lane finishes');
  assert.ok(!labels(calls).includes('integrate'));
  assert.ok(!calls.some((c) => c.phase === 'Join' || c.phase === 'Final review'));
  assert.equal(result.tasks.T2.status, 'blocked');
  assert.equal(result.tasks.T3.status, 'not_run');
  assert.equal(result.tasks.T4.status, 'done');
  assert.equal(result.integrate, null);
});

test('a stopped prelude stops the run before any lane', async () => {
  const script = { ...phaseScript(), 'T1 implement': [null], 'T1 implement retry': [null] };
  const { result, calls } = await run(manifest({ autonomy: 'supervised' }), script);
  assert.equal(result.status, 'stopped');
  assert.deepEqual(labels(calls), ['pre-flight', 'T1 implement', 'T1 implement retry']);
  assert.deepEqual(result.stopped_lanes.map((s) => s.lane), ['prelude']);
  assert.ok(!calls.some((c) => c.phase.startsWith('Lane ')));
});

test('a failed integration stops before join (supervised)', async () => {
  const m = manifest({ autonomy: 'supervised' });
  const script = {
    ...phaseScript({
      integrate: [
        { status: 'failed', head: '', notes: 'build broke' },
        { status: 'failed', head: '', notes: 'build still broke' },
      ],
    }),
    ...taskScript(ALL),
  };
  const { result, calls } = await run(m, script);
  assert.equal(result.status, 'stopped');
  assert.equal(result.integrate.status, 'failed');
  assert.match(result.reason, /build still broke/);
  assert.ok(!labels(calls).includes('post-integrate'));
  assert.ok(!labels(calls).includes('post-integrate fix'));
  assert.ok(!calls.some((c) => c.phase === 'Join'));
  // Supervised escalates a non-conflict failure to one Opus rerun on the
  // plain Plan 1 prompt (no self-heal), then stops as in Plan 1.
  const integ = calls.filter((c) => c.label === 'integrate');
  assert.deepEqual(integ.map((c) => c.model), ['sonnet', 'opus']);
  assert.match(integ[1].prompt, /resolve it/);
  assert.ok(!/tests_failed/.test(integ[1].prompt), 'supervised rerun does not heal command failures');
});

test('a supervised sonnet integrate that returns null is finished by the opus rerun', async () => {
  const m = manifest({ autonomy: 'supervised' });
  const script = {
    ...phaseScript({ integrate: [null, { status: 'done', head: 'I2', notes: 'merged on opus' }], 'integrate retry': [null] }),
    ...taskScript(ALL),
  };
  const { result, calls } = await run(m, script);
  assert.equal(result.status, 'complete');
  const integ = calls.filter((c) => c.label === 'integrate');
  assert.deepEqual(integ.map((c) => c.model), ['sonnet', 'opus']);
  assert.equal(result.integrate.status, 'done');
});

test('a stopped join stops before e2e and final review', async () => {
  const script = { ...phaseScript(), ...taskScript(['T1', 'T2', 'T3', 'T4']), 'T5 implement': [blocked('x')] };
  const { result, calls } = await run(manifest({ autonomy: 'supervised' }), script);
  assert.equal(result.status, 'stopped');
  assert.deepEqual(result.stopped_lanes.map((s) => s.lane), ['join']);
  assert.ok(!calls.some((c) => c.phase === 'E2E' || c.phase === 'Final review'));
});

test('no e2e hook: no E2E agent and e2e is null; correctness lens still runs', async () => {
  const m = manifest({ hooks: {} });
  const { result, calls } = await run(m, { ...phaseScript(), ...taskScript(ALL) });
  assert.equal(result.status, 'complete');
  assert.ok(!labels(calls).includes('e2e'));
  assert.ok(!labels(calls).includes('post-integrate'));
  assert.equal(result.e2e, null);
});

test('e2e prompt: hook text, scratch dirs, servers stopped; results reach the correctness lens', async () => {
  const { calls } = await run(manifest(), { ...phaseScript(), ...taskScript(ALL) });
  const e2e = calls.find((c) => c.label === 'e2e').prompt;
  assert.ok(e2e.includes('E2E-HOOK: run the checklist'));
  assert.match(e2e, /scratch/);
  assert.match(e2e, /stop every server/i);
  const corr = calls.find((c) => c.label === 'final review correctness').prompt;
  assert.ok(corr.includes('login') && corr.includes('PASS'));
});

test('final review: three lenses in parallel, commit-rules scan, superpowers or fallback', async () => {
  for (const spDir of ['/sp/skills', null]) {
    const { calls } = await run(manifest({ sp_dir: spDir }), { ...phaseScript(), ...taskScript(ALL) });
    const lenses = calls.filter((c) => c.label.startsWith('final review'));
    assert.equal(lenses.length, 3);
    for (const c of lenses) {
      assert.match(c.prompt, /anything the commit rules forbid/);
      assert.ok(c.prompt.includes("'main..pl/run-1'"), c.label);
    }
    const sp = lenses.find((c) => c.label === 'final review sp').prompt;
    if (spDir) assert.ok(sp.includes('/sp/skills/requesting-code-review/code-reviewer.md'));
    else assert.ok(sp.includes('superpowers not found'));
  }
});

test('final review dedupe merges identical findings from two lenses', () => {
  const a = finding('dup issue');
  const b = { ...finding('dup issue'), severity: 'critical', fix: 'other fix' };
  const c = finding('dup issue', 'src/a.js', 4);
  const merged = dedupeFindings([
    { lens: 'superpowers', findings: [a] },
    { lens: 'security', findings: [b, c] },
    { lens: 'correctness', findings: null },
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0].lenses, ['superpowers', 'security']);
  assert.equal(merged[0].severity, 'critical', 'keeps the most severe');
  assert.deepEqual(merged[1].lenses, ['security']);
});

test('final fix gets the deduped findings once, by id; a decline the re-review accepts is declined', async () => {
  const script = {
    ...phaseScript({
      'final fix': [{
        status: 'done', head: 'f1', tests: 'pass', notes: '',
        dispositions: [{ id: 'F1', status: 'fixed', reason: 'done' }, { id: 'F2', status: 'declined', reason: 'false positive' }],
      }],
    }),
    ...taskScript(ALL),
  };
  const { result, calls } = await run(manifest(), script);
  const fix = calls.find((c) => c.label === 'final fix').prompt;
  assert.equal(fix.split('dup issue').length - 1, 1, 'duplicate finding listed once');
  assert.ok(fix.includes('[F1] [important] src/a.js:3 - dup issue'), fix);
  const rr = calls.find((c) => c.label === 'final re-review').prompt;
  assert.ok(rr.includes("'T5-h..f1'"), 'the final fix range starts at the feature tip the script tracked');
  assert.ok(rr.includes('fixer: declined - false positive'), 'the re-reviewer judges the decline');
  assert.deepEqual(result.final.fixed.map((f) => f.issue), ['dup issue']);
  assert.deepEqual(result.final.declined.map((f) => [f.id, f.reason]), [['F2', 'false positive']]);
  assert.deepEqual(result.final.open, []);
});

// Review finding 12: a finding is identified by its id, not its text or line.
test('a finding the re-review still sees open stays open even after it moved a line', async () => {
  const moved = { ...finding('dup issue'), line: 4 };
  const script = {
    ...phaseScript({
      'final review security': [{ findings: [finding('dup issue'), { ...finding('authz bypass', 'src/auth.js', 10), severity: 'critical' }], cannot_verify: [], head: 'T5-h' }],
      'final re-review': [{ results: [
        { id: 'F1', status: 'resolved', evidence: 'gone' },
        { id: 'F2', status: 'open', evidence: 'still bypassable, now at src/auth.js:11' },
      ], new_findings: [] }],
    }),
    ...taskScript(ALL),
  };
  const { result } = await run(manifest(), script);
  assert.deepEqual(result.final.fixed.map((f) => f.id), ['F1']);
  assert.deepEqual(result.final.open.map((f) => [f.id, f.severity]), [['F2', 'critical']]);
  assert.match(result.final.open[0].reason, /still open after the final re-review/);
  assert.equal(result.status, 'complete');
  assert.equal(result.acceptance.status, 'rejected');
  assert.ok(result.acceptance.reasons.some((r) => r.kind === 'blocking_findings' && r.detail.includes('F2')));
  void moved;
});

test('a finding without a disposition or a re-review result is open, never fixed', async () => {
  const script = {
    ...phaseScript({
      'final fix': [{ status: 'done', head: 'f1', tests: 'pass', notes: '', dispositions: [{ id: 'F1', status: 'fixed', reason: 'ok' }] }],
      'final re-review': [{ results: [{ id: 'F1', status: 'resolved', evidence: 'gone' }], new_findings: [
        { severity: 'important', file: 'src/c.js', line: 2, issue: 'the fix broke c', fix: 'restore' },
      ] }],
    }),
    ...taskScript(ALL),
  };
  const { result } = await run(manifest(), script);
  assert.deepEqual(result.final.fixed.map((f) => f.id), ['F1']);
  assert.deepEqual(result.final.open.map((f) => f.id), ['F2', 'N1']);
  assert.match(result.final.open[0].reason, /no result for it/);
  assert.equal(result.acceptance.status, 'rejected');
});

test('no final findings: no fix or re-review agent', async () => {
  const empty = [{ findings: [], cannot_verify: [] }];
  const script = {
    ...phaseScript({ 'final review sp': empty, 'final review security': [...empty] }),
    ...taskScript(ALL),
  };
  const { result, calls } = await run(manifest(), script);
  assert.equal(result.status, 'complete');
  assert.ok(!labels(calls).includes('final fix'));
  assert.deepEqual(result.final, {
    findings: [], fixed: [], declined: [], open: [], cannot_verify: [], missing_lenses: [], head: 'T5-h',
  });
  assert.equal(result.delivered_sha, 'T5-h');
  assert.ok(!labels(calls).includes('e2e recheck'), 'the e2e result already covers the delivered revision');
});

test('a final review lens that returns null is reported, never counted as clean', async () => {
  const script = {
    ...phaseScript({ 'final review correctness': [null], 'final review correctness retry': [null] }),
    ...taskScript(ALL),
  };
  const { result, calls } = await run(manifest(), script);
  assert.ok(labels(calls).includes('final review correctness retry'));
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.final.missing_lenses, ['correctness']);
  // Review finding 1: a missing reviewer is missing evidence, not a pass.
  assert.equal(result.acceptance.status, 'unverified');
  assert.ok(result.acceptance.reasons.some((r) => r.kind === 'review_missing' && r.detail.includes('correctness')));
});

test('a final fix agent that returns null leaves every finding open and the run rejected', async () => {
  const script = { ...phaseScript({ 'final fix': [null], 'final fix retry': [null], verify: [verified('T5-h')] }), ...taskScript(ALL) };
  const { result, calls } = await run(manifest(), script);
  assert.ok(labels(calls).includes('final fix retry'));
  assert.ok(!labels(calls).includes('final re-review'));
  assert.deepEqual(result.final.fixed, []);
  assert.deepEqual(result.final.open.map((f) => [f.id, f.reason]), [['F1', 'no result from final fix'], ['F2', 'no result from final fix']]);
  assert.equal(result.acceptance.status, 'rejected');
});

test('no prompt instructs a push, a pull request, or a shadow writeback', async () => {
  for (const mode of ['git', 'shadow']) {
    const m = manifest();
    if (mode === 'shadow') {
      m.repo.mode = 'shadow';
      m.repo.git_dir = '/shadow/abc';
    }
    const { calls } = await run(m, { ...phaseScript(), ...taskScript(ALL) });
    for (const c of calls) {
      for (const bad of ['git push', 'gh pr create', 'shadow writeback']) {
        assert.ok(!c.prompt.includes(bad), `${mode} ${c.label}: ${bad}`);
      }
    }
  }
});

test('validator: backfill entries and reserved lane ids', () => {
  const ok = manifest({ done: ['T2'], reviewed: [], backfill: { T2: { base: 'b', head: 'h' } } });
  assert.deepEqual(validateManifest(ok), []);

  const missing = manifest({ done: ['T2'], reviewed: [] });
  assert.ok(validateManifest(missing).some((e) => e.includes('backfill') && e.includes('T2')));

  const unknown = manifest({ backfill: { T99: { base: 'b', head: 'h' } } });
  assert.ok(validateManifest(unknown).some((e) => e.includes('backfill') && e.includes('T99')));

  const badShape = manifest({ done: ['T2'], backfill: { T2: { base: '', head: 'h' } } });
  assert.ok(validateManifest(badShape).some((e) => e.includes('backfill.T2')));

  assert.ok(validateManifest(manifest({ backfill: [] })).some((e) => e.startsWith('backfill')));

  for (const id of ['prelude', 'join']) {
    const m = manifest();
    m.lanes[0].id = id;
    assert.ok(validateManifest(m).some((e) => e.includes(id) && e.includes('reserved')), id);
  }
});

test('a setup result without a feature head is invalid and spawns nothing', async () => {
  const m = manifest();
  m.setup_result.feature_head = '';
  const { result, calls } = await run(m, phaseScript());
  assert.equal(result.status, 'invalid');
  assert.ok(result.errors.some((e) => e.includes('setup_result.feature_head')), JSON.stringify(result.errors));
  assert.deepEqual(calls, []);
});

test('an integration that reports done without a head escalates to opus, then stops before join', async () => {
  const noHead = { status: 'done', head: '', notes: 'merged' };
  const script = { ...phaseScript({ integrate: [noHead, noHead] }), ...taskScript(ALL) };
  const { result, calls } = await run(manifest(), script);
  assert.deepEqual(calls.filter((c) => c.label === 'integrate').map((c) => c.model), ['sonnet', 'opus']);
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'integration failed: integrate reported no head');
  assert.ok(!calls.some((c) => c.phase === 'Join'));
});

test('a sonnet integrate done without a head is rerun on opus, whose result is used', async () => {
  const script = {
    ...phaseScript({ integrate: [{ status: 'done', head: '', notes: 'merged' }, { status: 'done', head: 'I2', notes: 'ok' }] }),
    ...taskScript(ALL),
  };
  const { result, calls } = await run(manifest(), script);
  assert.deepEqual(calls.filter((c) => c.label === 'integrate').map((c) => c.model), ['sonnet', 'opus']);
  assert.equal(result.status, 'complete');
});

test('an e2e agent that returns null reruns on opus, then is listed under final cannot_verify', async () => {
  // Sonnet null (retried once by the budget wrapper) reruns on Opus; Opus null
  // too, so the e2e result is unavailable.
  const script = { ...phaseScript({ e2e: [null, null], 'e2e retry': [null, null] }), ...taskScript(ALL) };
  const { result, calls } = await run(manifest(), script);
  const e2eCalls = calls.filter((c) => c.label === 'e2e');
  assert.deepEqual(e2eCalls.map((c) => c.model), ['sonnet', 'opus']);
  assert.ok(labels(calls).includes('e2e retry'));
  assert.equal(result.status, 'complete');
  assert.ok(result.final.cannot_verify.includes('the e2e check returned no result'), JSON.stringify(result.final));
});

test('a final fix with no commits is still re-reviewed: its claims are checked, not trusted', async () => {
  const script = {
    ...phaseScript({
      'final fix': [{ status: 'done', head: 'T5-h', tests: '', notes: '', dispositions: [
        { id: 'F1', status: 'fixed', reason: 'already fine' }, { id: 'F2', status: 'declined', reason: 'out of scope' },
      ] }],
      'final re-review': [{ results: [
        { id: 'F1', status: 'open', evidence: 'nothing changed' }, { id: 'F2', status: 'resolved', evidence: 'out of scope indeed' },
      ], new_findings: [] }],
      verify: [verified('T5-h')],
    }),
    ...taskScript(ALL),
  };
  const { result, calls } = await run(manifest(), script);
  assert.ok(calls.find((c) => c.label === 'final re-review').prompt.includes('fix range T5-h..T5-h, no fix commits'));
  assert.deepEqual(result.final.fixed, []);
  assert.deepEqual(result.final.open.map((f) => f.id), ['F1']);
  assert.deepEqual(result.final.declined.map((f) => [f.id, f.reason]), [['F2', 'out of scope']]);
  assert.equal(result.delivered_sha, 'T5-h');
});

test('validator: run_id and lane id formats, base_ref differs from branch', () => {
  for (const runId of ['Run1', 'run_1', 'a b', 'x/y', 'r1\n', '../r']) {
    assert.ok(validateManifest(manifest({ run_id: runId })).some((e) => e.startsWith('run_id')), JSON.stringify(runId));
  }
  assert.deepEqual(validateManifest(manifest({ run_id: 'ri-1' })), []);
  for (const id of ['../x', '.hidden', 'a b', 'a/b', 'a\n', '-x']) {
    const m = manifest();
    m.lanes[0].id = id;
    assert.ok(validateManifest(m).some((e) => e.includes('lane') && e.includes('id')), JSON.stringify(id));
  }
  for (const id of ['A', 'lane_1', 'b.2', '_x']) {
    const m = manifest();
    m.lanes[0].id = id;
    m.setup_result.worktrees = { [id]: '/work/wt/lane-x', beta: '/work/wt/lane-beta' };
    assert.deepEqual(validateManifest(m), [], id);
  }
  const same = manifest();
  same.repo.branch = 'main';
  assert.ok(validateManifest(same).some((e) => e.includes('repo.branch') && e.includes('base_ref')));
});

test('validator: notes map known task ids to non-empty text', () => {
  assert.deepEqual(validateManifest(manifest({ notes: { T2: 'use v2' } })), []);
  assert.ok(validateManifest(manifest({ notes: { T99: 'x' } })).some((e) => e.includes('notes') && e.includes('T99')));
  assert.ok(validateManifest(manifest({ notes: { T2: '' } })).some((e) => e.includes('notes.T2')));
  assert.ok(validateManifest(manifest({ notes: [] })).some((e) => e.startsWith('notes')));
});

test('validator: every done task needs a backfill entry, reviewed or not', () => {
  const m = manifest({ done: ['T2'], reviewed: ['T2'] });
  assert.ok(validateManifest(m).some((e) => e.includes('backfill') && e.includes('T2')));
  m.backfill = { T2: { base: 'b', head: 'h' } };
  assert.deepEqual(validateManifest(m), []);
});

const HISTORY_RULE = 'Never amend, rebase, reset, or force-update a branch. Decline commit-message findings with a reason; ' +
  'they are reported to the user.';
const SKILL_RULE = 'Do not invoke parallel-lanes or any plan-execution skill.';
const KEEP_FILES_RULE = 'Never run git clean -x or git clean -X, and never delete ignored or untracked files';

// A run that exercises every agent role, including a fix and re-review round.
async function fullRun(mode) {
  const m = manifest();
  if (mode === 'shadow') {
    m.repo.mode = 'shadow';
    m.repo.git_dir = '/shadow/abc';
  }
  const script = {
    ...phaseScript(),
    ...taskScript(ALL),
    'T2 review': [{ verdict: 'changes', findings: [finding('bug')], cannot_verify: [] }],
    'T2 fix 1': [done('x', 'T2-h2')],
    'T2 re-review 1': [approve()],
  };
  return run(m, script);
}

test('every prompt carries the history rule, the skill rule, and the checkout rules', async () => {
  for (const mode of ['git', 'shadow']) {
    const { calls } = await fullRun(mode);
    const roles = new Set(labels(calls).map((l) => l.replace(/^T\d+ /, '').replace(/ \d+$/, '')));
    for (const role of ['pre-flight', 'implement', 'review', 'fix', 're-review', 'integrate',
      'post-integrate', 'e2e', 'final review sp', 'final fix', 'final re-review', 'verify', 'e2e recheck',
      'post-integrate recheck']) {
      assert.ok(roles.has(role), `${mode}: the run exercised ${role}`);
    }
    for (const c of calls) {
      const where = `${mode} ${c.label}`;
      assert.ok(c.prompt.includes(HISTORY_RULE), `${where}: history rule`);
      assert.ok(c.prompt.includes(SKILL_RULE), `${where}: skill rule`);
      assert.match(c.prompt, /every shell command starts with cd '[^']+' &&/i, `${where}: cd rule`);
      assert.match(c.prompt, /every project file path you read or write is absolute under /, `${where}: path rule`);
      assert.match(c.prompt, /rev-parse --abbrev-ref HEAD/, `${where}: branch check`);
    }
  }
});

test('task and feature prompts name their own checkout and branch in the checkout rules', async () => {
  const { calls } = await fullRun('git');
  const prompt = (label) => calls.find((c) => c.label === label).prompt;
  const t2 = prompt('T2 implement');
  assert.ok(t2.includes("starts with cd '/work/wt/lane-alpha' && or uses git -C '/work/wt/lane-alpha'"));
  assert.ok(t2.includes("git -C '/work/wt/lane-alpha' rev-parse --abbrev-ref HEAD prints pl-run-1-alpha"));
  assert.ok(t2.includes('absolute under /work/wt/lane-alpha'));
  for (const label of ['T1 implement', 'integrate', 'final fix']) {
    assert.ok(prompt(label).includes("git -C '/work/repo' rev-parse --abbrev-ref HEAD prints pl/run-1"), label);
  }
  const shadow = await fullRun('shadow');
  const integ = shadow.calls.find((c) => c.label === 'integrate').prompt;
  assert.ok(integ.includes("git -C '/work/wt/feature' rev-parse --abbrev-ref HEAD prints pl/run-1"));
});

test('agents on the feature checkout never delete ignored or untracked files', async () => {
  const { calls } = await fullRun('git');
  for (const label of ['integrate', 'post-integrate', 'e2e', 'final fix']) {
    assert.ok(calls.find((c) => c.label === label).prompt.includes(KEEP_FILES_RULE), label);
  }
  const integ = calls.find((c) => c.label === 'integrate').prompt;
  assert.match(integ, /this is what clean means/);
  assert.ok(!/From a clean tree/.test(integ));
});

test('the keep-files rule exempts the project setup commands and still forbids git clean -x', async () => {
  const { calls } = await fullRun('git');
  for (const label of ['integrate', 'post-integrate', 'e2e', 'final fix']) {
    const prompt = calls.find((c) => c.label === label).prompt;
    assert.ok(prompt.includes("the project's own setup commands"), `${label}: setup exemption`);
    assert.match(prompt, /npm ci/, `${label}: the exemption example`);
    assert.match(prompt, /Never run git clean -x or git clean -X/, `${label}: git clean -x still forbidden`);
  }
});

// The checkout an agent works in, from its label: lane tasks run in their
// lane worktree; prelude and join tasks and every phase agent in the feature
// checkout.
function agentCheckout(label, featureDir) {
  const id = (label.match(/^(T\d+) /) || [])[1];
  if (id === 'T2' || id === 'T3') return '/work/wt/lane-alpha';
  if (id === 'T4') return '/work/wt/lane-beta';
  return featureDir;
}

// Lines of a prompt that run a provided script: ledger, task-brief,
// review-package, start-task, or finish-task.
const PROVIDED =
  /scripts\/ledger' append|scripts\/task-brief' |scripts\/review-package' |scripts\/start-task' |scripts\/finish-task' /;

test('every provided ledger, start-task, finish-task, and review-package command starts in the agent checkout', async () => {
  for (const [mode, featureDir] of [['git', '/work/repo'], ['shadow', '/work/wt/feature']]) {
    const { calls } = await fullRun(mode);
    const seen = { ledger: 0, brief: 0, review: 0, finish: 0 };
    for (const c of calls) {
      const prefix = `cd '${agentCheckout(c.label, featureDir)}' && `;
      for (const line of c.prompt.split('\n').filter((l) => PROVIDED.test(l))) {
        assert.ok(line.trim().startsWith(prefix), `${mode} ${c.label}: ${line.trim()}`);
        if (line.includes('scripts/ledger')) seen.ledger += 1;
        if (line.includes('scripts/task-brief') || line.includes('--brief ')) seen.brief += 1;
        if (line.includes('scripts/finish-task')) seen.finish += 1;
        if (line.includes('review-package')) seen.review += 1;
      }
    }
    for (const [kind, count] of Object.entries(seen)) assert.ok(count > 0, `${mode}: saw ${kind} commands`);
  }
});

test('integrate checks the first-parent history after the prelude tip', async () => {
  const { calls } = await fullRun('git');
  const integ = calls.find((c) => c.label === 'integrate').prompt;
  assert.ok(integ.includes("log --first-parent --format='%H %P %s' 'T1-h..HEAD'"), integ);
  assert.ok(integ.includes('/work/ledger/join.jsonl'));
  assert.match(integ, /first of steps 1-5 that fails/);
});

test('reviewers report commit-message problems as minor findings that reach the task notes', async () => {
  const { calls } = await fullRun('git');
  const rev = calls.find((c) => c.label === 'T1 review').prompt;
  assert.match(rev, /commit message that breaks the commit rules as a minor finding/);
  const fix = calls.find((c) => c.label === 'final fix').prompt;
  assert.match(fix, /commit-message finding/i);

  const m = manifest();
  const minor = { severity: 'minor', file: 'commit abc1234', line: 0, issue: 'subject has a trailer', fix: 'reword' };
  const script = {
    ...phaseScript(),
    ...taskScript(ALL),
    'T1 review': [{ verdict: 'approve', findings: [minor], cannot_verify: [] }],
  };
  const { result } = await run(m, script);
  assert.ok(result.tasks.T1.notes.includes('commit abc1234'), result.tasks.T1.notes);
  assert.ok(result.tasks.T1.notes.includes('subject has a trailer'), result.tasks.T1.notes);
});

test('resume: a first prelude task done but unreviewed is reviewed on its own backfill range', async () => {
  // setup reports the feature head, which already holds T1's commits: a
  // review of feature_head..T1 head would be empty.
  const m = manifest({ done: ['T1'], reviewed: [], backfill: backfillFor(['T1']) });
  const script = {
    ...phaseScript({
      setup: [{ ok: true, discarded: [], worktrees: [], feature_head: 'T1-old-h', notes: '' }],
    }),
    ...taskScript(['T2', 'T3', 'T4', 'T5']),
    'T1 review': [approve()],
  };
  const { result, calls } = await run(m, script);
  assert.equal(result.status, 'complete');
  assert.ok(!labels(calls).includes('T1 implement'));
  const rev = calls.find((c) => c.label === 'T1 review').prompt;
  assert.ok(rev.includes('range T1-old-b..T1-old-h'), rev.split('\n')[0]);
  assert.deepEqual(result.tasks.T1.commits, ['T1-old-b', 'T1-old-h']);
  // The next tasks build on T1's head.
  assert.ok(calls.find((c) => c.label === 'T2 review').prompt.includes('T1-old-h..T2-h'));
});

test('resume: a first join task done but unreviewed is reviewed on its own backfill range', async () => {
  // The post-integrate head is past the join commits an earlier attempt made.
  const m = manifest({ done: [...ALL], reviewed: ['T1', 'T2', 'T3', 'T4'], backfill: backfillFor(ALL) });
  const script = {
    ...phaseScript({ 'post-integrate': [{ status: 'done', head: 'P9', notes: 'contracts ok' }] }),
    'T5 review': [approve()],
  };
  const { result, calls } = await run(m, script);
  assert.equal(result.status, 'complete');
  assert.ok(!labels(calls).includes('T5 implement'));
  const rev = calls.find((c) => c.label === 'T5 review').prompt;
  assert.ok(rev.includes('range T5-old-b..T5-old-h'), rev.split('\n')[0]);
  assert.deepEqual(result.tasks.T5.commits, ['T5-old-b', 'T5-old-h']);
});

test('lanes still review a first backfilled task from the prelude tip', async () => {
  const m = manifest({ done: ['T1', 'T4'], reviewed: ['T1'], backfill: backfillFor(['T1', 'T4']) });
  const script = { ...phaseScript(), ...taskScript(['T2', 'T3', 'T5']), 'T4 review': [approve()] };
  const { calls } = await run(m, script);
  assert.ok(calls.find((c) => c.label === 'T4 review').prompt.includes('range T1-old-h..T4-old-h'));
});

test('final review lenses report the feature head; the final fix starts from the real tip', async () => {
  // A resume after an earlier final fix: the feature branch is at FF2, past
  // the join tip the script knows (T5's backfill head).
  const m = manifest({ done: [...ALL], reviewed: [...ALL], backfill: backfillFor(ALL) });
  const lens = (findings) => [{ findings, cannot_verify: [], head: 'FF2' }];
  const script = phaseScript({
    'final review sp': [{ findings: [finding('dup issue')], cannot_verify: [] }],
    'final review security': lens([finding('sec issue', 'src/b.js', 9)]),
    'final review correctness': lens([]),
  });
  const { result, calls } = await run(m, script);
  assert.equal(result.status, 'complete');
  for (const c of calls.filter((x) => x.label.startsWith('final review'))) {
    assert.ok(c.schema.required.includes('head'), c.label);
    assert.ok(c.prompt.includes("git -C '/work/repo' rev-parse HEAD"), c.label);
  }
  const fix = calls.find((c) => c.label === 'final fix').prompt;
  assert.ok(fix.includes('(now at FF2)'), fix);
  assert.ok(!fix.includes('T5-old-h'));
  assert.ok(calls.find((c) => c.label === 'final re-review').prompt.includes("'FF2..f1'"));

  // A fix that returns the real tip made no new commits.
  const noop = phaseScript({
    'final review sp': lens([finding('dup issue')]),
    'final review security': lens([]),
    'final review correctness': lens([]),
    'final fix': [{ status: 'done', head: 'FF2', tests: '', notes: '', dispositions: [] }],
    'final re-review': [{ results: [], new_findings: [] }],
    verify: [verified('FF2')],
  });
  const second = await run(m, noop);
  assert.ok(second.calls.find((c) => c.label === 'final re-review').prompt.includes("'FF2..FF2'"));
  assert.deepEqual(second.result.final.fixed, []);
  assert.deepEqual(second.result.final.open.map((f) => f.reason), ['the final re-review gave no result for it']);
});

test('integrate allows earlier final-fix commits after the join tip only when every join task is done', async () => {
  const resumed = manifest({ done: [...ALL], reviewed: [...ALL], backfill: backfillFor(ALL) });
  const { calls } = await run(resumed, phaseScript());
  const integ = calls.find((c) => c.label === 'integrate').prompt;
  assert.match(integ, /final-fix commits from an earlier attempt/);
  assert.ok(integ.includes('T5-old-h'), integ);

  const fresh = await run(manifest(), { ...phaseScript(), ...taskScript(ALL) });
  const freshInteg = fresh.calls.find((c) => c.label === 'integrate').prompt;
  assert.ok(!/final-fix commits/.test(freshInteg));
});

// The output of scripts/setup for a manifest: every lane at the worktree the
// run uses for it.
function setupResultFor(m, extra = {}) {
  const worktrees = Object.fromEntries(m.lanes.map((l) => [l.id, `${m.repo.worktree_root}/lane-${l.id}`]));
  return { feature_head: 'S0', worktrees, discarded: [], ...extra };
}

test('setup_result: no setup agent, its feature head starts the prelude, lanes use its paths', async () => {
  const m = manifest();
  m.setup_result = setupResultFor(m, { discarded: ['/work/wt/lane-alpha: M src/T2.js'] });
  const script = { ...phaseScript(), ...taskScript(ALL) };
  delete script.setup;
  const { result, calls, logs, phases } = await run(m, script);
  assert.equal(result.status, 'complete');
  assert.ok(!labels(calls).includes('setup'));
  assert.equal(labels(calls)[0], 'pre-flight');
  assert.ok(!phases.includes('Setup'));
  assert.deepEqual(result.tasks.T1.commits, ['S0', 'T1-h']);
  assert.ok(calls.find((c) => c.label === 'T1 implement').prompt.includes('S0'));
  assert.ok(logs.some((l) => l.includes('/work/wt/lane-alpha: M src/T2.js')), JSON.stringify(logs));
  for (const [id, lane] of [['T2', 'alpha'], ['T3', 'alpha'], ['T4', 'beta']]) {
    const prompt = calls.find((c) => c.label === `${id} implement`).prompt;
    assert.ok(prompt.includes(m.setup_result.worktrees[lane]), `${id} works in ${lane}`);
  }
});

test('setup_result missing a lane: invalid naming the lane, no agent', async () => {
  const m = manifest();
  m.setup_result = setupResultFor(m);
  delete m.setup_result.worktrees.beta;
  const { result, calls } = await run(m, {});
  assert.equal(result.status, 'invalid');
  assert.ok(result.errors.some((e) => e.includes('beta')), JSON.stringify(result.errors));
  assert.deepEqual(calls, []);
  assert.equal(result.agents_spawned, 0);
});

test('setup_result naming a different path for a lane: invalid naming the lane, no agent', async () => {
  const m = manifest();
  m.setup_result = setupResultFor(m);
  m.setup_result.worktrees.beta = '/elsewhere/lane-beta';
  const { result, calls } = await run(m, {});
  assert.equal(result.status, 'invalid');
  const err = result.errors.find((e) => e.includes('beta'));
  assert.ok(err, JSON.stringify(result.errors));
  assert.ok(err.includes('/elsewhere/lane-beta') && err.includes('/work/wt/lane-beta'), err);
  assert.ok(!result.errors.some((e) => e.includes('alpha')), JSON.stringify(result.errors));
  assert.deepEqual(calls, []);
  assert.equal(result.agents_spawned, 0);
});

test('setup_result under profile lite maps the lane to the feature checkout', async () => {
  const m = manifest({
    profile: 'lite', hooks: {}, lanes: [{ id: 'alpha', name: 'Lane alpha', tasks: [task('T2')] }],
  });
  m.setup_result = { feature_head: 'S0', worktrees: { alpha: '/work/wt/lane-alpha' }, discarded: [] };
  const { result, calls } = await run(m, {});
  assert.equal(result.status, 'invalid');
  assert.ok(result.errors.some((e) => e.includes('alpha') && e.includes('/work/repo')), JSON.stringify(result.errors));
  assert.deepEqual(calls, []);
});

test('start_points: the saved prelude and join heads are the bases of the first tasks', async () => {
  const m = manifest({ start_points: { prelude: 'SP0', join: 'SJ0' } });
  const { result, calls } = await run(m, { ...phaseScript(), ...taskScript(ALL) });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.tasks.T1.commits, ['SP0', 'T1-h']);
  assert.ok(calls.find((c) => c.label === 'T1 review').prompt.includes('range SP0..T1-h'));
  assert.deepEqual(result.tasks.T5.commits, ['SJ0', 'T5-h']);
  assert.ok(calls.find((c) => c.label === 'T5 review').prompt.includes('range SJ0..T5-h'));
  // Lanes still start from the prelude tip.
  assert.deepEqual(result.tasks.T2.commits, ['T1-h', 'T2-h']);
});

test('start_points: a review-state first task with a backfill entry still reviews its backfill range', async () => {
  const m = manifest({
    done: ['T1'], reviewed: [], backfill: backfillFor(['T1']), start_points: { prelude: 'SP0' },
  });
  const script = {
    ...phaseScript({ setup: [{ ok: true, discarded: [], worktrees: [], feature_head: 'T1-old-h', notes: '' }] }),
    ...taskScript(['T2', 'T3', 'T4', 'T5']),
    'T1 review': [approve()],
  };
  const { result, calls } = await run(m, script);
  assert.equal(result.status, 'complete');
  const rev = calls.find((c) => c.label === 'T1 review').prompt;
  assert.ok(rev.includes('range T1-old-b..T1-old-h'), rev.split('\n')[0]);
  assert.deepEqual(result.tasks.T1.commits, ['T1-old-b', 'T1-old-h']);
});

test('start_points: an empty prelude leaves the lanes on the setup feature head', async () => {
  const m = manifest({ prelude: [], start_points: { prelude: 'SP0' } });
  const { result, calls } = await run(m, { ...phaseScript(), ...taskScript(['T2', 'T3', 'T4', 'T5']) });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.tasks.T2.commits, ['F0', 'T2-h']);
  assert.ok(calls.find((c) => c.label === 'integrate').prompt.includes('F0 is the feature tip after the prelude'));
});

// ---- H4: self-healing phases and phase tiers ----

const JOIN_START = /run_started.*"phase":"join"/;

test('autonomous pre-flight conflict: an adjudicator answer continues the run and binds every task', async () => {
  const script = {
    ...phaseScript({ 'pre-flight': [{ conflicts: ['T2 vs T4 overlap'], rulings: [], undeclared: [] }] }),
    ...taskScript(ALL),
    'run adjudicate': [{ outcome: 'answer', text: 'use the v2 contract' }],
  };
  const { result, calls } = await run(manifest(), script);
  assert.equal(result.status, 'complete');
  assert.ok(result.preflight.rulings.includes('use the v2 contract'), JSON.stringify(result.preflight));
  // The ruling reaches every not-yet-done task through its note.
  for (const id of ALL) {
    const impl = calls.find((c) => c.label === `${id} implement`).prompt;
    assert.ok(impl.includes('Pre-flight ruling (binding for this run): use the v2 contract'), id);
  }
  const adj = calls.find((c) => c.label === 'run adjudicate');
  assert.equal(adj.phase, 'Pre-flight');
  assert.deepEqual([adj.model, adj.effort], ['opus', 'high']);
  assert.ok(adj.prompt.includes('T2 vs T4 overlap'));
});

test('autonomous pre-flight conflict: park continues, stop yields preflight_conflicts, unavailable stops', async () => {
  const withAdj = (adj) => ({
    ...phaseScript({ 'pre-flight': [{ conflicts: ['c'], rulings: [], undeclared: [] }] }),
    ...taskScript(ALL),
    'run adjudicate': adj,
  });
  const park = await run(manifest(), withAdj([{ outcome: 'park', text: 'defer the overlap' }]));
  assert.equal(park.result.status, 'complete');
  assert.ok(park.result.preflight.rulings.includes('defer the overlap'));

  const stop = await run(manifest(), {
    ...phaseScript({ 'pre-flight': [{ conflicts: ['c'], rulings: [], undeclared: [] }] }),
    'run adjudicate': [{ outcome: 'stop', text: 'security call', stop_condition: 'security' }],
  });
  assert.equal(stop.result.status, 'preflight_conflicts');
  assert.ok(!labels(stop.calls).some((l) => l.endsWith('implement')));

  const un = await run(manifest(), {
    ...phaseScript({ 'pre-flight': [{ conflicts: ['c'], rulings: [], undeclared: [] }] }),
    'run adjudicate': [null],
    'run adjudicate retry': [null],
  });
  assert.equal(un.result.status, 'stopped');
  assert.equal(un.result.reason, 'no result from run adjudicate');
});

// ---- pre-flight undeclared dependencies (consumed contracts) ----

const undeclaredScript = (entries, extra = {}) =>
  phaseScript({ 'pre-flight': [{ conflicts: [], rulings: [], undeclared: entries }], ...extra });

test('pre-flight undeclared entries reach every brief of their task', async () => {
  const entry = { task: 'T2', producer: 'T1', what: 'reads the T1 format' };
  const script = {
    ...undeclaredScript([entry]),
    ...taskScript(ALL),
    'T2 review': [{ verdict: 'changes', findings: [finding('wrong format')], cannot_verify: [] }],
    'T2 fix 1': [done('T2-h', 'T2-h2')],
    'T2 re-review 1': [approve()],
  };
  const { result, calls, logs } = await run(manifest(), script);
  assert.equal(result.status, 'complete', JSON.stringify(result));
  for (const label of ['T2 implement', 'T2 review', 'T2 fix 1', 'T2 re-review 1']) {
    const c = calls.find((x) => x.label === label);
    assert.ok(c, label);
    assert.ok(c.prompt.includes("--also 'T2' 'T1'"), label);
  }
  for (const c of calls.filter((x) => x.label.startsWith('T1 '))) {
    assert.ok(!c.prompt.includes('--also'), c.label);
  }
  assert.ok(logs.includes('parallel-lanes: pre-flight: T2 also consumes T1 (reads the T1 format)'), JSON.stringify(logs));
  assert.deepEqual(result.preflight.undeclared, [entry]);
});

test('pre-flight drops malformed undeclared entries', async () => {
  const entries = [
    { task: 'T2', producer: 'T1' },
    { task: 2, producer: 'T1', what: 'numeric task' },
    { task: 'T2', producer: 'T9', what: 'unknown producer' },
    { task: 'T3', producer: 'T3', what: 'itself' },
    { task: 'T1', producer: 'T4', what: 'a done task' },
    'T2 needs T1',
  ];
  const m = manifest({ done: ['T1'], reviewed: ['T1'], backfill: backfillFor(['T1']) });
  const script = {
    ...undeclaredScript(entries, {
      setup: [{ ok: true, discarded: [], worktrees: [], feature_head: 'T1-old-h', notes: '' }],
    }),
    ...taskScript(['T2', 'T3', 'T4', 'T5']),
  };
  const { result, calls, logs } = await run(m, script);
  assert.equal(result.status, 'complete', JSON.stringify(result));
  for (const c of calls) assert.ok(!c.prompt.includes('--also'), c.label);
  const dropped = logs.filter((l) => l.startsWith('parallel-lanes: pre-flight: dropped undeclared entry '));
  assert.equal(dropped.length, entries.length, JSON.stringify(logs));
  for (const e of entries) {
    assert.ok(dropped.some((l) => l.includes(`entry ${JSON.stringify(e)} (`)), JSON.stringify(e));
  }
  assert.ok(!logs.some((l) => l.includes('also consumes')), JSON.stringify(logs));
  assert.deepEqual(result.preflight.undeclared, []);
});

test('undeclared entries do not stop a supervised run', async () => {
  const script = {
    ...undeclaredScript([{ task: 'T4', producer: 'T2', what: 'calls the T2 parser' }]),
    ...taskScript(ALL),
  };
  const { result, calls } = await run(manifest({ autonomy: 'supervised' }), script);
  assert.equal(result.status, 'complete', JSON.stringify(result));
  assert.ok(labels(calls).includes('T1 implement'), 'the run reaches the prelude');
  assert.ok(!labels(calls).some((l) => l.includes('adjudicate')), labels(calls).join(', '));
  assert.ok(calls.find((c) => c.label === 'T4 implement').prompt.includes("--also 'T4' 'T2'"));
});

test('undeclared entries for a done but unreviewed task reach its reviewer', async () => {
  const m = manifest({
    done: ['T1', 'T2'],
    reviewed: ['T1'],
    backfill: { T1: { base: 'p0', head: 'p1' }, T2: { base: 'old-b', head: 'old-h' } },
  });
  const entries = [
    { task: 'T2', producer: 'T1', what: 'reads the T1 format' },
    { task: 'T1', producer: 'T3', what: 'a done and reviewed task' },
  ];
  const script = { ...undeclaredScript(entries), ...taskScript(['T3', 'T4', 'T5']), 'T2 review': [approve()] };
  const { result, calls, logs } = await run(m, script);
  assert.equal(result.status, 'complete', JSON.stringify(result));
  assert.ok(calls.find((c) => c.label === 'T2 review').prompt.includes("--also 'T2' 'T1'"));
  assert.deepEqual(result.preflight.undeclared, [entries[0]]);
  assert.ok(logs.some((l) => l.includes('dropped undeclared entry') && l.includes('"task":"T1"')), JSON.stringify(logs));
});

test('a producer id with a dot is shell-quoted in --also', async () => {
  const m = manifest({ prelude: [task('1.5')] });
  const script = {
    ...undeclaredScript([{ task: 'T2', producer: '1.5', what: 'reads the 1.5 schema' }]),
    ...taskScript(['1.5', 'T2', 'T3', 'T4', 'T5']),
  };
  const { result, calls } = await run(m, script);
  assert.equal(result.status, 'complete', JSON.stringify(result));
  assert.ok(calls.find((c) => c.label === 'T2 implement').prompt.includes("--also 'T2' '1.5'"));
});

test('a batch gets --also per task', async () => {
  const m = manifest({
    lanes: [
      { id: 'alpha', name: 'Lane alpha', tasks: [task('T2', { tier: 'light', batch: 'x' }), task('T3', { tier: 'light', batch: 'x' })] },
      { id: 'beta', name: 'Lane beta', tasks: [task('T4')] },
    ],
  });
  const script = {
    ...undeclaredScript([{ task: 'T3', producer: 'T1', what: 'uses the T1 helper' }]),
    ...taskScript(['T1', 'T4', 'T5']),
    'T2-T3 implement': [done('T2-b', 'T3-h')],
    'T2-T3 review': [approve()],
  };
  const { result, calls } = await run(m, script);
  assert.equal(result.status, 'complete', JSON.stringify(result));
  const p = calls.find((c) => c.label === 'T2-T3 implement').prompt;
  assert.ok(p.includes("--also 'T3' 'T1'"), p);
  assert.ok(!p.includes("--also 'T2'"), p);
});

test('profile lite reports no undeclared entries', async () => {
  const m = manifest({
    profile: 'lite', hooks: {}, lanes: [{ id: 'alpha', name: 'Lane alpha', tasks: [task('T2'), task('T3')] }],
    join: [task('T4')],
  });
  m.setup_result = { feature_head: 'S0', worktrees: { alpha: '/work/repo' }, discarded: [] };
  const script = {
    ...taskScript(['T1', 'T2', 'T3', 'T4']),
    'final review': [{ findings: [], cannot_verify: [], head: 'T4-h' }],
    verify: [verified('T4-h')],
  };
  const { result, calls } = await run(m, script);
  assert.equal(result.status, 'complete', JSON.stringify(result));
  assert.ok(!labels(calls).includes('pre-flight'), labels(calls).join(', '));
  assert.deepEqual(result.preflight.undeclared, []);
  for (const c of calls) assert.ok(!c.prompt.includes('--also'), c.label);
});

test('the pre-flight prompt has check 4 and its schema requires undeclared', () => {
  const p = preflightPrompt(manifest());
  const check4 = [
    '4. Undeclared dependencies: a task in a lane that relies on something a task in another',
    '   lane or in the prelude produces (a function, a file format, markup, an API answer)',
    '   without naming that task in its Consumes. Return each in undeclared as',
    '   {task, producer, what}, what in one sentence.',
  ].join('\n');
  assert.ok(p.includes(check4), p);
  const s = preflightSchema();
  assert.ok(s.required.includes('undeclared'));
  assert.deepEqual(s.properties.undeclared.items.required, ['task', 'producer', 'what']);
  for (const f of ['task', 'producer', 'what']) assert.equal(s.properties.undeclared.items.properties[f].type, 'string');
});

test('autonomous integrate conflict: sonnet aborts, an opus resolver runs, the opus rerun reviews it', async () => {
  const script = {
    ...phaseScript({
      integrate: [
        { status: 'failed', head: '', notes: 'conflict', conflict_files: ['src/shared.js'] },
        { status: 'done', head: 'I2', notes: 'merged after resolve' },
      ],
      'resolve conflicts': [{ status: 'done', head: 'R1', notes: 'resolved' }],
    }),
    ...taskScript(ALL),
  };
  const { result, calls } = await run(manifest(), script);
  assert.equal(result.status, 'complete');
  const integ = calls.filter((c) => c.label === 'integrate');
  assert.deepEqual(integ.map((c) => c.model), ['sonnet', 'opus']);
  const resolve = calls.find((c) => c.label === 'resolve conflicts');
  assert.equal(resolve.model, 'opus');
  assert.ok(resolve.prompt.includes('src/shared.js'));
  const l = labels(calls);
  assert.ok(l.indexOf('resolve conflicts') > l.indexOf('integrate'));
  assert.ok(l.indexOf('resolve conflicts') < l.lastIndexOf('integrate'));
  assert.match(integ[0].prompt, /Do not resolve conflicts/);
  assert.match(integ[1].prompt, /Resolution review/);
  assert.ok(integ[1].prompt.includes('src/shared.js'));
  assert.equal(result.integrate.status, 'done');
});

test('a resolver that fails or returns null: the opus rerun resolves on the plain prompt', async () => {
  for (const resolved of [{ status: 'failed', head: '', notes: 'could not resolve' }, null]) {
    const script = {
      ...phaseScript({
        integrate: [
          { status: 'failed', head: '', notes: 'conflict', conflict_files: ['src/shared.js'] },
          { status: 'done', head: 'I2', notes: 'resolved on the rerun' },
        ],
        'resolve conflicts': [resolved],
        'resolve conflicts retry': [null],
      }),
      ...taskScript(ALL),
    };
    const { result, calls } = await run(manifest(), script);
    assert.equal(result.status, 'complete');
    const integ = calls.filter((c) => c.label === 'integrate');
    assert.deepEqual(integ.map((c) => c.model), ['sonnet', 'opus']);
    assert.ok(!/Resolution review/.test(integ[1].prompt), 'no claim that a prior agent resolved the conflicts');
    assert.ok(!/already resolved/.test(integ[1].prompt));
    assert.match(integ[1].prompt, /resolve it/);
    assert.ok(!/Do not resolve conflicts/.test(integ[1].prompt));
  }
});

test('a resolver that finishes hands its notes to the reviewing opus rerun', async () => {
  const script = {
    ...phaseScript({
      integrate: [
        { status: 'failed', head: '', notes: 'conflict', conflict_files: ['src/shared.js'] },
        { status: 'done', head: 'I2', notes: 'merged after resolve' },
      ],
      'resolve conflicts': [{ status: 'done', head: 'R1', notes: 'RESOLVER-NOTES: kept both exports' }],
    }),
    ...taskScript(ALL),
  };
  const { calls } = await run(manifest(), script);
  const integ = calls.filter((c) => c.label === 'integrate');
  assert.match(integ[1].prompt, /Resolution review/);
  assert.ok(integ[1].prompt.includes('RESOLVER-NOTES: kept both exports'), integ[1].prompt);
});

test('post-integrate re-review findings are reported and reach the final fix wave', async () => {
  const fxIssue = { severity: 'critical', file: 'src/fx.js', line: 7, issue: 'fix drops error handling', fix: 'restore it' };
  const quiet = {
    'final review sp': [{ findings: [], cannot_verify: [] }],
    'final review security': [{ findings: [], cannot_verify: [] }],
    'final review correctness': [{ findings: [], cannot_verify: [] }],
  };
  // Integrate tests_failed path.
  const viaInteg = await run(manifest({ hooks: { e2e: 'E2E-HOOK: run the checklist' } }), {
    ...phaseScript({
      ...quiet,
      integrate: [
        { status: 'failed', head: '', notes: 'tests red', conflict_files: [] },
        { status: 'done', head: 'I2', notes: 'merged but tests fail', tests_failed: true },
        { status: 'done', head: 'I3', notes: 'tests pass now' },
      ],
      'post-integrate fix': [{ status: 'done', head: 'FX', notes: 'fixed import' }],
      'post-integrate re-review': [{ findings: [fxIssue] }],
    }),
    ...taskScript(ALL),
  });
  assert.equal(viaInteg.result.status, 'complete');
  assert.deepEqual(viaInteg.result.integrate.fix_review.map((f) => f.issue), ['fix drops error handling']);
  const fixCall = viaInteg.calls.find((c) => c.label === 'final fix');
  assert.ok(fixCall, 'the final fix wave runs on the carried finding');
  assert.ok(fixCall.prompt.includes('fix drops error handling'));
  assert.equal(fixCall.model, 'opus');
  const carried = viaInteg.result.final.findings.find((f) => f.issue === 'fix drops error handling');
  assert.deepEqual(carried.lenses, ['post-integrate re-review']);
  assert.ok(viaInteg.result.final.fixed.some((f) => f.issue === 'fix drops error handling'));

  // Hook failure path; a re-review that returns null is listed under cannot_verify.
  const viaHook = await run(manifest(), {
    ...phaseScript({
      ...quiet,
      'post-integrate': [
        { status: 'failed', head: '', notes: 'contract drift' },
        { status: 'done', head: 'P2', notes: 'contracts ok' },
      ],
      'post-integrate fix': [{ status: 'done', head: 'PFX', notes: 'realigned contract' }],
      'post-integrate re-review': [null],
      'post-integrate re-review retry': [null],
    }),
    ...taskScript(ALL),
  });
  assert.equal(viaHook.result.status, 'complete');
  assert.deepEqual(viaHook.result.integrate.fix_review, []);
  assert.ok(viaHook.result.final.cannot_verify.includes('the post-integrate re-review returned no result'),
    JSON.stringify(viaHook.result.final.cannot_verify));
});

test('autonomous integrate failure without conflicts: one opus rerun, no resolver', async () => {
  const script = {
    ...phaseScript({
      integrate: [
        { status: 'failed', head: '', notes: 'command failed', conflict_files: [] },
        { status: 'done', head: 'I2', notes: 'fixed on opus' },
      ],
    }),
    ...taskScript(ALL),
  };
  const { result, calls } = await run(manifest(), script);
  assert.equal(result.status, 'complete');
  assert.ok(!labels(calls).includes('resolve conflicts'));
  const integ = calls.filter((c) => c.label === 'integrate');
  assert.deepEqual(integ.map((c) => c.model), ['sonnet', 'opus']);
  assert.match(integ[1].prompt, /resolve it/);
  assert.ok(!/Do not resolve conflicts/.test(integ[1].prompt));
});

test('autonomous post-integration test failure: opus fix + scoped re-review, then the integrate step reruns', async () => {
  const m = manifest({ hooks: { post_integrate: 'POST-INTEGRATE: check contracts' } });
  const script = {
    ...phaseScript({
      integrate: [
        { status: 'failed', head: '', notes: 'tests red', conflict_files: [] },
        { status: 'done', head: 'I2', notes: 'merged but tests fail', tests_failed: true },
        { status: 'done', head: 'I3', notes: 'tests pass now' },
      ],
      'post-integrate fix': [{ status: 'done', head: 'FX', notes: 'fixed import' }],
      'post-integrate re-review': [{ findings: [] }],
    }),
    ...taskScript(ALL),
  };
  const { result, calls } = await run(m, script);
  assert.equal(result.status, 'complete');
  const l = labels(calls).filter((x) => ['integrate', 'post-integrate fix', 'post-integrate re-review'].includes(x));
  assert.deepEqual(l, ['integrate', 'integrate', 'post-integrate fix', 'post-integrate re-review', 'integrate']);
  const fix = calls.find((c) => c.label === 'post-integrate fix');
  assert.equal(fix.model, 'opus');
  assert.ok(fix.prompt.includes('merged but tests fail'), fix.prompt);
  const rr = calls.find((c) => c.label === 'post-integrate re-review');
  assert.deepEqual([rr.model, rr.effort], ['opus', 'high']);
  assert.ok(rr.prompt.includes('I2..FX'), rr.prompt.split('\n')[0]);
  assert.equal(result.integrate.status, 'done');
});

test('autonomous post-integration test failure that stays red after one rerun stops the run', async () => {
  const m = manifest({ hooks: { post_integrate: 'POST-INTEGRATE: check contracts' } });
  const script = {
    ...phaseScript({
      integrate: [
        { status: 'failed', head: '', notes: 'tests red', conflict_files: [] },
        { status: 'done', head: 'I2', notes: 'still red', tests_failed: true },
        { status: 'done', head: 'I3', notes: 'still red again', tests_failed: true },
      ],
      'post-integrate fix': [{ status: 'done', head: 'FX', notes: 'tried' }],
      'post-integrate re-review': [{ findings: [] }],
    }),
    ...taskScript(ALL),
  };
  const { result, calls } = await run(m, script);
  assert.equal(result.status, 'stopped');
  assert.match(result.reason, /integration failed/);
  assert.ok(!labels(calls).includes('post-integrate'), 'the hook never runs');
});

test('autonomous post_integrate hook failure: opus fix + re-review, then the hook reruns', async () => {
  const script = {
    ...phaseScript({
      'post-integrate': [
        { status: 'failed', head: '', notes: 'contract drift' },
        { status: 'done', head: 'P2', notes: 'contracts ok' },
      ],
      'post-integrate fix': [{ status: 'done', head: 'PFX', notes: 'realigned contract' }],
      'post-integrate re-review': [{ findings: [] }],
    }),
    ...taskScript(ALL),
  };
  const { result, calls } = await run(manifest(), script);
  assert.equal(result.status, 'complete');
  const l = labels(calls).filter((x) => x.startsWith('post-integrate'));
  assert.deepEqual(l, ['post-integrate', 'post-integrate fix', 'post-integrate re-review', 'post-integrate',
    'post-integrate recheck']);
  assert.ok(calls.find((c) => c.label === 'post-integrate fix').prompt.includes('contract drift'));
  assert.ok(calls.find((c) => c.label === 'post-integrate re-review').prompt.includes('I1..PFX'));
  assert.equal(result.integrate.post_integrate.status, 'done');
});

test('e2e FAIL on sonnet reruns on opus and the opus result is used', async () => {
  const script = {
    ...phaseScript({
      e2e: [
        { items: [{ item: 'login', result: 'FAIL', evidence: 'boom' }] },
        { items: [{ item: 'login', result: 'PASS', evidence: 'ok' }] },
      ],
    }),
    ...taskScript(ALL),
  };
  const { result, calls } = await run(manifest(), script);
  assert.equal(result.status, 'complete');
  const e2e = calls.filter((c) => c.label === 'e2e');
  assert.deepEqual(e2e.map((c) => c.model), ['sonnet', 'opus']);
  assert.deepEqual(result.e2e.items.map((i) => i.result), ['PASS']);
});

test('e2e all PASS on sonnet does not rerun on opus', async () => {
  const { calls } = await run(manifest(), { ...phaseScript(), ...taskScript(ALL) });
  const e2e = calls.filter((c) => c.label === 'e2e');
  assert.deepEqual(e2e.map((c) => c.model), ['sonnet']);
});

test('final fix tier: sonnet for minor-only or docs-only findings, opus otherwise, sonnet null reruns on opus', async () => {
  const minorF = (file = 'src/a.js') => ({ severity: 'minor', file, line: 1, issue: 'nit', fix: 'tidy' });
  const okFix = { status: 'done', head: 'f1', tests: 'pass', notes: '', declined: [] };
  const oneLens = (findings) => ({
    'final review sp': [{ findings, cannot_verify: [] }],
    'final review security': [{ findings: [], cannot_verify: [] }],
    'final review correctness': [{ findings: [], cannot_verify: [] }],
    'final re-review': [{ findings: [] }],
  });

  const minor = await run(manifest(), {
    ...phaseScript({ ...oneLens([minorF()]), 'final fix': [okFix] }), ...taskScript(ALL),
  });
  assert.equal(minor.calls.find((c) => c.label === 'final fix').model, 'sonnet');

  const docs = await run(manifest(), {
    ...phaseScript({ ...oneLens([finding('typo', 'README.md', 2)]), 'final fix': [okFix] }), ...taskScript(ALL),
  });
  assert.equal(docs.calls.find((c) => c.label === 'final fix').model, 'sonnet');

  const mixed = await run(manifest(), { ...phaseScript(), ...taskScript(ALL) });
  assert.equal(mixed.calls.find((c) => c.label === 'final fix').model, 'opus');

  const nul = await run(manifest(), {
    ...phaseScript({ ...oneLens([minorF()]), 'final fix': [null, okFix], 'final fix retry': [null] }),
    ...taskScript(ALL),
  });
  const fixes = nul.calls.filter((c) => c.label === 'final fix');
  assert.deepEqual(fixes.map((c) => c.model), ['sonnet', 'opus']);
  assert.equal(nul.result.status, 'complete');
});

test('supervised integrate conflict escalates to one opus rerun with no resolver', async () => {
  const m = manifest({ autonomy: 'supervised' });
  const script = {
    ...phaseScript({
      integrate: [
        { status: 'failed', head: '', notes: 'conflict', conflict_files: ['src/shared.js'] },
        { status: 'done', head: 'I2', notes: 'resolved with confidence' },
      ],
    }),
    ...taskScript(ALL),
  };
  const { result, calls } = await run(m, script);
  assert.equal(result.status, 'complete');
  assert.ok(!labels(calls).includes('resolve conflicts'));
  const integ = calls.filter((c) => c.label === 'integrate');
  assert.deepEqual(integ.map((c) => c.model), ['sonnet', 'opus']);
  assert.match(integ[1].prompt, /resolve it/);
  assert.ok(!/tests_failed/.test(integ[1].prompt), 'supervised rerun does not heal command failures');
});

test('the finishing integrate-phase agent records the join start point (A4)', async () => {
  const withHook = await run(manifest(), { ...phaseScript(), ...taskScript(ALL) });
  const post = withHook.calls.find((c) => c.label === 'post-integrate').prompt;
  assert.match(post, JOIN_START);
  const integWith = withHook.calls.find((c) => c.label === 'integrate').prompt;
  assert.ok(!JOIN_START.test(integWith), 'integrate does not carry it when post-integrate finishes the phase');

  const noHook = await run(manifest({ hooks: { e2e: 'E2E-HOOK: run the checklist' } }),
    { ...phaseScript(), ...taskScript(ALL) });
  const integNo = noHook.calls.find((c) => c.label === 'integrate').prompt;
  assert.match(integNo, JOIN_START);

  // Without the hook, the Opus integrate reruns that finish the phase on the
  // self-heal paths carry it too.
  const noHookM = manifest({ hooks: { e2e: 'E2E-HOOK: run the checklist' } });
  const conflict = await run(noHookM, {
    ...phaseScript({
      integrate: [
        { status: 'failed', head: '', notes: 'conflict', conflict_files: ['src/shared.js'] },
        { status: 'done', head: 'I2', notes: 'merged after resolve' },
      ],
      'resolve conflicts': [{ status: 'done', head: 'R1', notes: 'resolved' }],
    }),
    ...taskScript(ALL),
  });
  const conflictInteg = conflict.calls.filter((c) => c.label === 'integrate');
  assert.match(conflictInteg[conflictInteg.length - 1].prompt, JOIN_START);
  assert.ok(!JOIN_START.test(conflict.calls.find((c) => c.label === 'resolve conflicts').prompt));

  const healed = await run(noHookM, {
    ...phaseScript({
      integrate: [
        { status: 'failed', head: '', notes: 'tests red', conflict_files: [] },
        { status: 'done', head: 'I2', notes: 'merged but tests fail', tests_failed: true },
        { status: 'done', head: 'I3', notes: 'tests pass now' },
      ],
      'post-integrate fix': [{ status: 'done', head: 'FX', notes: 'fixed import' }],
      'post-integrate re-review': [{ findings: [] }],
    }),
    ...taskScript(ALL),
  });
  const healedInteg = healed.calls.filter((c) => c.label === 'integrate');
  assert.equal(healedInteg.length, 3);
  for (const c of healedInteg.slice(1)) {
    assert.match(c.prompt, JOIN_START);
    // In heal mode the join start point is recorded only when no command fails.
    assert.match(c.prompt, /only when you return tests_failed false/);
  }
  assert.ok(!/tests_failed false/.test(healedInteg[0].prompt), 'the sonnet first pass does not heal');
});

test('heal mode: a tests_failed integrate holds cleanup back, and every rerun knows each lane tip', async () => {
  const { result, calls } = await run(manifest(), {
    ...phaseScript({
      integrate: [
        { status: 'failed', head: '', notes: 'tests red', conflict_files: [] },
        { status: 'done', head: 'I2', notes: 'merged but tests fail', tests_failed: true },
        { status: 'done', head: 'I3', notes: 'tests pass now' },
      ],
      'post-integrate fix': [{ status: 'done', head: 'FX', notes: 'fixed import' }],
      'post-integrate re-review': [{ findings: [] }],
    }),
    ...taskScript(ALL),
  });
  assert.equal(result.status, 'complete');
  const integ = calls.filter((c) => c.label === 'integrate');
  assert.equal(integ.length, 3);
  for (const c of integ) {
    assert.ok(c.prompt.includes('- pl-run-1-alpha: T3-h'), 'lane alpha tip');
    assert.ok(c.prompt.includes('- pl-run-1-beta: T4-h'), 'lane beta tip');
    assert.match(c.prompt, /merge-base --is-ancestor <sha> HEAD/);
  }
  for (const c of integ.slice(1)) {
    assert.match(c.prompt, /When you return tests_failed true, skip this step entirely/);
  }
  assert.ok(!/skip this step entirely/.test(integ[0].prompt), 'the first pass cleans up as before');
});

test('resume: a lane with nothing left to run gives integrate its backfill tip', async () => {
  const m = manifest({ done: ['T4'], reviewed: ['T4'], backfill: backfillFor(['T4']) });
  const { result, calls } = await run(m, { ...phaseScript(), ...taskScript(['T1', 'T2', 'T3', 'T5']) });
  assert.equal(result.status, 'complete');
  const integ = calls.find((c) => c.label === 'integrate').prompt;
  assert.ok(integ.includes('- pl-run-1-beta: T4-old-h'), integ);
});

test('resume: a task the adjudicator parked with no commits is skipped and the lane goes on from its range', async () => {
  // Ledger after the earlier run: T1 committed and reviewed; T2 blocked, then
  // settled (park) at T1-old-h with no commits.
  const m = manifest({
    done: ['T1', 'T2'],
    reviewed: ['T1', 'T2'],
    backfill: { T1: { base: 'T1-old-b', head: 'T1-old-h' }, T2: { base: 'T1-old-h', head: 'T1-old-h' } },
  });
  const { result, calls } = await run(m, { ...phaseScript(), ...taskScript(['T3', 'T4', 'T5']) });
  assert.equal(result.status, 'complete');
  assert.ok(!labels(calls).some((l) => l.startsWith('T2 ')), 'the parked task never runs again');
  assert.equal(result.tasks.T2.status, 'skipped');
  assert.deepEqual(result.tasks.T2.commits, ['T1-old-h', 'T1-old-h']);
  assert.deepEqual(result.tasks.T3.commits, ['T1-old-h', 'T3-h']);
  assert.ok(calls.find((c) => c.label === 'T3 review').prompt.includes('range T1-old-h..T3-h'));
});

test('validator: profile lite with hooks.post_integrate makes the run invalid, never skips the hook', async () => {
  const m = manifest({
    profile: 'lite', prelude: [], join: [], lanes: [{ id: 'alpha', name: 'Lane alpha', tasks: [task('T2')] }],
  });
  const { result, calls } = await run(m, {});
  assert.equal(result.status, 'invalid');
  assert.ok(result.errors.some((e) => e.includes('hooks.post_integrate')), JSON.stringify(result.errors));
  assert.equal(result.rulings_spent, 0);
  assert.deepEqual(calls, []);
});

test('integratePrompt: a lane without a known tip falls back to its ledger; plan 1 cleanup is unchanged', async () => {
  const { integratePrompt } = await loadHelpers(['integratePrompt']);
  const m = manifest();
  const p = integratePrompt(m, 'T1-h', { laneTips: { alpha: 'A9' } });
  assert.ok(p.includes('- pl-run-1-alpha: A9'));
  assert.ok(p.includes('- pl-run-1-beta: the last sha of the last committed event in /work/ledger/beta.jsonl'));
  assert.match(p, /6\. Only when steps 1-5 passed, clean up each lane:/);
  const heal = integratePrompt(m, 'T1-h', { testFailure: 'heal' });
  assert.match(heal, /6\. Only when steps 1-5 passed and you return tests_failed false/);
  assert.match(heal, /When you return tests_failed true, skip this step entirely/);
});

// --- review findings 1 and 2: acceptance, decided in code at the delivered revision

const acceptanceOf = async (extra, m = manifest()) => (await run(m, { ...phaseScript(), ...taskScript(ALL), ...extra })).result;

test('acceptance: an e2e that fails twice keeps a complete run from being accepted', async () => {
  const fail = { head: 'f1', items: [{ item: 'login', result: 'FAIL', evidence: '500' }] };
  const result = await acceptanceOf({ 'e2e recheck': [fail, fail] });
  assert.equal(result.status, 'complete', 'the run executed to the end');
  assert.equal(result.acceptance.status, 'rejected');
  assert.deepEqual(result.acceptance.reasons.map((r) => r.kind), ['e2e_failed']);
});

test('acceptance: a failing check at the delivered revision rejects the run, whatever the fixer said', async () => {
  const result = await acceptanceOf({ verify: [verified('f1', 1)] });
  assert.equal(result.acceptance.status, 'rejected');
  assert.deepEqual(result.acceptance.reasons.map((r) => r.kind), ['checks_failed']);
  assert.match(result.acceptance.reasons[0].detail, /npm test \(exit 1\)/);
});

test('acceptance: checks run at another revision, or not all of them, are missing evidence', async () => {
  let result = await acceptanceOf({ verify: [verified('T5-h')] });
  assert.equal(result.acceptance.status, 'unverified');
  assert.deepEqual(result.acceptance.reasons.map((r) => r.kind), ['checks_stale']);
  result = await acceptanceOf({ verify: [{ ...verified('f1'), results: [] }] });
  assert.equal(result.acceptance.status, 'unverified');
  assert.deepEqual(result.acceptance.reasons.map((r) => r.kind), ['checks_incomplete']);
  result = await acceptanceOf({ verify: [null], 'verify retry': [null] });
  assert.deepEqual(result.acceptance.reasons.map((r) => r.kind), ['checks_missing']);
});

test('acceptance: a final fix makes the earlier e2e evidence stale, so e2e reruns at the delivered revision', async () => {
  const { result, calls } = await run(manifest(), { ...phaseScript(), ...taskScript(ALL) });
  const order = labels(calls);
  assert.ok(order.indexOf('e2e') < order.indexOf('final fix'));
  assert.ok(order.indexOf('final fix') < order.indexOf('e2e recheck'));
  assert.equal(calls.find((c) => c.label === 'e2e recheck').phase, 'Verify');
  assert.equal(result.e2e.checked_sha, 'f1');
  const stale = await acceptanceOf({ 'e2e recheck': [{ head: 'T5-h', items: [{ item: 'login', result: 'PASS', evidence: 'ok' }] }] });
  assert.equal(stale.acceptance.status, 'unverified');
  assert.deepEqual(stale.acceptance.reasons.map((r) => r.kind), ['e2e_stale']);
});

test('acceptance: the post-integrate recheck is check-only and must leave HEAD where it was', async () => {
  const { calls } = await run(manifest(), { ...phaseScript(), ...taskScript(ALL) });
  const recheck = calls.find((c) => c.label === 'post-integrate recheck').prompt;
  assert.match(recheck, /verify only\. Change no file, make no commit/);
  assert.ok(!recheck.includes('"event":"run_started"'), 'a recheck records no start point');
  const moved = await acceptanceOf({ 'post-integrate recheck': [{ status: 'done', head: 'sneaky', notes: 'ok' }] });
  assert.equal(moved.acceptance.status, 'rejected');
  assert.ok(moved.acceptance.reasons.some((r) => r.kind === 'post_integrate_failed' && r.detail.includes('sneaky')));
});

test('acceptance: a deferred task keeps the run from being accepted, now and on a resume', async () => {
  const blocked = { status: 'blocked', head: 'T2-b', tests: '', notes: 'stuck' };
  const result = await acceptanceOf({
    'T2 implement': [blocked], 'T2 adjudicate': [{ outcome: 'park', text: 'park it', head: 'T1-h' }],
  });
  assert.equal(result.tasks.T2.status, 'deferred');
  assert.equal(result.status, 'complete');
  assert.equal(result.acceptance.status, 'rejected');
  assert.ok(result.acceptance.reasons.some((r) => r.kind === 'deferred_task' && r.detail.includes('T2')));
  const resumed = manifest({ done: [...ALL], reviewed: [...ALL], deferred: ['T2'], backfill: backfillFor(ALL) });
  const later = (await run(resumed, phaseScript())).result;
  assert.equal(later.tasks.T2.status, 'deferred');
  assert.ok(later.acceptance.reasons.some((r) => r.kind === 'deferred_task' && r.detail.includes('T2')));
});

test('acceptance: minor findings and cannot-verify items are warnings, not reasons', async () => {
  const minor = { ...finding('naming'), severity: 'minor' };
  const result = await acceptanceOf({
    'final review sp': [{ findings: [minor], cannot_verify: ['load under 1k users'], head: 'T5-h' }],
    'final review security': [{ findings: [], cannot_verify: [], head: 'T5-h' }],
    'final fix': [{ status: 'done', head: 'f1', tests: '', notes: '', dispositions: [{ id: 'F1', status: 'declined', reason: 'style' }] }],
    'final re-review': [{ results: [{ id: 'F1', status: 'open', evidence: 'still named oddly' }], new_findings: [] }],
  });
  assert.equal(result.acceptance.status, 'accepted');
  assert.deepEqual(result.acceptance.reasons, []);
  assert.ok(result.acceptance.warnings.some((w) => w.includes('open minor finding F1')));
  assert.ok(result.acceptance.warnings.some((w) => w.includes('load under 1k users')));
});

test('an unblock note reaches a join task that depends on the unblocked lane task', async () => {
  const m = manifest();
  m.join[0].depends_on = [{ id: 'T2', kind: 'contract' }];
  const blocked = { status: 'blocked', head: 'T1-h', tests: '', notes: 'upstream missing' };
  const { calls } = await run(m, {
    ...phaseScript(), ...taskScript(ALL),
    'T2 implement': [blocked], 'T2 adjudicate': [{ outcome: 'unblock', text: 'UNBLOCK-X: stub the v2 shape', head: 'T1-h' }],
  });
  assert.ok(calls.find((c) => c.label === 'T5 implement').prompt.includes('UNBLOCK-X: stub the v2 shape'));
});

test('a deferred task stays deferred in the report when its lane resumes with other work', async () => {
  const m = manifest({ done: ['T2'], reviewed: ['T2'], deferred: ['T2'], backfill: { T2: { base: 'T1-h', head: 'T1-h' } } });
  const { result } = await run(m, { ...phaseScript(), ...taskScript(ALL) });
  assert.equal(result.tasks.T2.status, 'deferred');
  assert.equal(result.acceptance.status, 'rejected');
});
