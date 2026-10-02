import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadHelpers, loadScript } from './harness.mjs';

const { planAgents, validateManifest, dedupeFindings } = await loadHelpers([
  'planAgents', 'validateManifest', 'dedupeFindings',
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
    ...overrides,
  };
}

const done = (base, head) => ({ status: 'done', base, head, tests: 'npm test: pass', notes: '' });
const blocked = (base, notes = 'stuck') => ({ status: 'blocked', base, head: base, tests: '', notes });
const approve = () => ({ verdict: 'approve', findings: [], cannot_verify: [] });
const finding = (issue, file = 'src/a.js', line = 3) => ({ severity: 'important', file, line, issue, fix: 'fix it' });

// Results for every non-task agent of a clean run.
function phaseScript(extra = {}) {
  return {
    setup: [{ ok: true, discarded: [], worktrees: ['/work/wt/lane-alpha', '/work/wt/lane-beta'], notes: '' }],
    'pre-flight': [{ conflicts: [], rulings: ['Ruling: x - y - z'] }],
    integrate: [{ status: 'done', notes: 'merged' }],
    'post-integrate': [{ status: 'done', notes: 'contracts ok' }],
    e2e: [{ items: [{ item: 'login', result: 'PASS', evidence: 'ok' }] }],
    'final review sp': [{ findings: [finding('dup issue')], cannot_verify: [] }],
    'final review security': [{ findings: [finding('dup issue'), finding('sec issue', 'src/b.js', 9)], cannot_verify: [] }],
    'final review correctness': [{ findings: [], cannot_verify: [] }],
    'final fix': [{ status: 'done', base: 'f0', head: 'f1', tests: 'all pass', notes: '', declined: [] }],
    'final re-review': [{ findings: [] }],
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

test('happy path: complete, phases in order, report filled in', async () => {
  const m = manifest();
  const { result, calls, logs, phases } = await run(m, { ...phaseScript(), ...taskScript(ALL) });
  assert.equal(result.status, 'complete');
  assert.equal(result.run_id, 'run-1');
  const order = ['Setup', 'Pre-flight', 'Prelude', 'Lane alpha', 'Lane beta', 'Integrate', 'Join', 'E2E', 'Final review'];
  assert.deepEqual(phaseOrder(calls), order);
  assert.deepEqual(phases, ['Setup', 'Pre-flight', 'Prelude', 'Integrate', 'Join', 'E2E', 'Final review']);
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

  for (const id of ALL) {
    const t = result.tasks[id];
    assert.equal(t.status, 'done', id);
    assert.equal(t.rounds, 0);
    assert.equal(t.tier_used, 'standard');
    assert.deepEqual(t.commits, [`${id}-b`, `${id}-h`]);
  }
  assert.deepEqual(result.stopped_lanes, []);
  assert.deepEqual(result.preflight, { conflicts: [], rulings: ['Ruling: x - y - z'] });
  assert.equal(result.integrate.status, 'done');
  assert.equal(result.integrate.post_integrate.status, 'done');
  assert.deepEqual(result.e2e.items.map((i) => i.result), ['PASS']);
  assert.equal(result.final.findings.length, 2);
  assert.equal(result.final.fixed.length, 2);
  assert.deepEqual(result.final.declined, []);
  assert.equal(result.agents_spawned, calls.length);
  assert.equal(result.agents_spawned, planAgents(m).length, 'no fix rounds: matches the dry-run plan');
  assert.ok(logs.includes('parallel-lanes: launching run run-1: 2 lanes, 20 agents'), JSON.stringify(logs));
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
  assert.ok(t2.prompt.includes("merge --ff-only 'pl/run-1'"), 'lane picks up the prelude commits');
});

test('every non-light agent runs at opus/high and every prompt carries the commit rules', async () => {
  const m = manifest();
  m.lanes[1].tasks[0].tier = 'light';
  const { calls } = await run(m, { ...phaseScript(), ...taskScript(ALL) });
  for (const c of calls) {
    assert.ok(c.prompt.includes('COMMIT-RULES: plain ASCII, no trailers'), c.label);
    assert.ok(/^[\x00-\x7f]*$/.test(c.prompt), `${c.label}: plain ASCII`);
    if (c.label === 'T4 implement') assert.deepEqual([c.model, c.effort], ['sonnet', 'medium']);
    else assert.deepEqual([c.model, c.effort], ['opus', 'high'], c.label);
  }
});

test('setup prompt: branch, lane worktrees, discard and list, setup commands', async () => {
  const { calls } = await run(manifest(), { ...phaseScript(), ...taskScript(ALL) });
  const setup = calls.find((c) => c.label === 'setup').prompt;
  assert.ok(setup.includes("'/work/wt/lane-alpha'") && setup.includes("'pl-run-1-alpha'"));
  assert.ok(setup.includes("'/work/wt/lane-beta'") && setup.includes("'pl-run-1-beta'"));
  assert.ok(setup.includes("git -C '/work/repo' worktree add"));
  assert.ok(setup.includes("'main'") && setup.includes("'pl/run-1'"));
  assert.match(setup, /discard/i);
  assert.ok(setup.includes('npm ci'));
});

test('shadow mode: worktrees via --git-dir and a feature worktree for prelude and join', async () => {
  const m = manifest();
  m.repo.mode = 'shadow';
  m.repo.git_dir = '/shadow/abc';
  const { result, calls } = await run(m, { ...phaseScript(), ...taskScript(ALL) });
  assert.equal(result.status, 'complete');
  const setup = calls.find((c) => c.label === 'setup').prompt;
  assert.ok(setup.includes("git --git-dir='/shadow/abc' worktree add"));
  assert.ok(setup.includes("'/work/wt/feature'"));
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
  assert.match(p, /first of steps 1-4 that fails/);
  assert.match(p, /Cleanup never fails the integration/);
});

test('pre-flight conflicts stop before any implement', async () => {
  const m = manifest();
  const script = phaseScript({ 'pre-flight': [{ conflicts: ['plan contradicts spec on X'], rulings: [] }] });
  const { result, calls } = await run(m, script);
  assert.equal(result.status, 'preflight_conflicts');
  assert.deepEqual(result.preflight.conflicts, ['plan contradicts spec on X']);
  assert.deepEqual(labels(calls), ['setup', 'pre-flight']);
  assert.ok(!labels(calls).some((l) => l.endsWith('implement')));
});

test('a pre-flight agent that returns null stops the run', async () => {
  const { result, calls } = await run(manifest(), phaseScript({ 'pre-flight': [null] }));
  assert.equal(result.status, 'stopped');
  assert.deepEqual(labels(calls), ['setup', 'pre-flight']);
});

test('a failed setup stops the run before pre-flight', async () => {
  for (const r of [null, { ok: false, discarded: [], worktrees: [], notes: 'main checkout is dirty' }]) {
    const { result, calls } = await run(manifest(), phaseScript({ setup: [r] }));
    assert.equal(result.status, 'stopped');
    assert.deepEqual(labels(calls), ['setup']);
  }
});

test('setup lists discarded uncommitted changes via log', async () => {
  const script = {
    ...phaseScript({
      setup: [{ ok: true, discarded: ['lane-alpha: M src/T2.js'], worktrees: [], notes: '' }],
    }),
    ...taskScript(ALL),
  };
  const { logs } = await run(manifest(), script);
  assert.ok(logs.some((l) => l.includes('lane-alpha: M src/T2.js')), JSON.stringify(logs));
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
  const m = manifest({ done: [...ALL], reviewed: [...ALL] });
  const { result, calls, logs } = await run(m, phaseScript());
  assert.equal(result.status, 'complete');
  assert.deepEqual(labels(calls).slice(0, 4), ['setup', 'pre-flight', 'integrate', 'post-integrate']);
  assert.ok(!calls.some((c) => c.phase.startsWith('Lane ') || c.phase === 'Prelude' || c.phase === 'Join'));
  for (const id of ALL) assert.equal(result.tasks[id].status, 'skipped', id);
  assert.ok(logs.includes('parallel-lanes: resuming run run-1: 5 tasks already committed'), JSON.stringify(logs));
  assert.ok(!logs.some((l) => l.includes('launching')));
});

test('resume with only lane tasks done and reviewed: lanes skipped, empty lanes do not crash', async () => {
  const m = manifest({ prelude: [], join: [], done: ['T2', 'T3', 'T4'], reviewed: ['T2', 'T3', 'T4'] });
  const { result, calls } = await run(m, phaseScript());
  assert.equal(result.status, 'complete');
  assert.ok(!calls.some((c) => c.phase.startsWith('Lane ')));
  assert.ok(labels(calls).includes('integrate'));
});

test('a done but unreviewed task is reviewed on its backfill range before the lane continues', async () => {
  const m = manifest({
    done: ['T1', 'T2'],
    reviewed: ['T1'],
    backfill: { T2: { base: 'old-b', head: 'old-h' } },
  });
  const script = { ...phaseScript(), ...taskScript(['T3', 'T4', 'T5']), 'T2 review': [approve()] };
  const { result, calls, logs } = await run(m, script);
  assert.equal(result.status, 'complete');
  const l = labels(calls);
  assert.ok(!l.includes('T2 implement'));
  assert.ok(!l.includes('T1 implement') && !l.includes('T1 review'));
  assert.ok(l.indexOf('T2 review') < l.indexOf('T3 implement'));
  const rev = calls.find((c) => c.label === 'T2 review').prompt;
  assert.ok(rev.includes('old-b..old-h'));
  assert.equal(result.tasks.T2.status, 'done');
  assert.deepEqual(result.tasks.T2.commits, ['old-b', 'old-h']);
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
  assert.deepEqual(result.tasks.T2.commits, ['old-b', 'new-h']);
});

test('a stopped lane yields stopped and integration does not run', async () => {
  const m = manifest();
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
  const script = { ...phaseScript(), 'T1 implement': [null] };
  const { result, calls } = await run(manifest(), script);
  assert.equal(result.status, 'stopped');
  assert.deepEqual(result.stopped_lanes.map((s) => s.lane), ['prelude']);
  assert.ok(!calls.some((c) => c.phase.startsWith('Lane ')));
});

test('a failed integration stops before join', async () => {
  const script = { ...phaseScript({ integrate: [{ status: 'failed', notes: 'conflict in x' }] }), ...taskScript(ALL) };
  const { result, calls } = await run(manifest(), script);
  assert.equal(result.status, 'stopped');
  assert.equal(result.integrate.status, 'failed');
  assert.ok(!labels(calls).includes('post-integrate'));
  assert.ok(!calls.some((c) => c.phase === 'Join'));
});

test('a stopped join stops before e2e and final review', async () => {
  const script = { ...phaseScript(), ...taskScript(['T1', 'T2', 'T3', 'T4']), 'T5 implement': [blocked('x')] };
  const { result, calls } = await run(manifest(), script);
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

test('final review: three lenses in parallel, AI-trace scan, superpowers or fallback', async () => {
  for (const spDir of ['/sp/skills', null]) {
    const { calls } = await run(manifest({ sp_dir: spDir }), { ...phaseScript(), ...taskScript(ALL) });
    const lenses = calls.filter((c) => c.label.startsWith('final review'));
    assert.equal(lenses.length, 3);
    for (const c of lenses) {
      assert.match(c.prompt, /AI/);
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

test('final fix gets the deduped findings once; declined and unresolved items are reported', async () => {
  const script = {
    ...phaseScript({
      'final fix': [{
        status: 'done', base: 'f0', head: 'f1', tests: 'pass', notes: '',
        declined: [{ file: 'src/b.js', line: 9, issue: 'sec issue', reason: 'false positive' }],
      }],
      'final re-review': [{ findings: [] }],
    }),
    ...taskScript(ALL),
  };
  const { result, calls } = await run(manifest(), script);
  const fix = calls.find((c) => c.label === 'final fix').prompt;
  assert.equal(fix.split('dup issue').length - 1, 1, 'duplicate finding listed once');
  const rr = calls.find((c) => c.label === 'final re-review').prompt;
  assert.ok(rr.includes("'f0..f1'"));
  assert.deepEqual(result.final.fixed.map((f) => f.issue), ['dup issue']);
  assert.deepEqual(result.final.declined.map((f) => [f.issue, f.reason]), [['sec issue', 'false positive']]);
});

test('a finding still open after the re-review is reported as declined', async () => {
  const script = {
    ...phaseScript({ 'final re-review': [{ findings: [finding('dup issue')] }] }),
    ...taskScript(ALL),
  };
  const { result } = await run(manifest(), script);
  assert.deepEqual(result.final.fixed.map((f) => f.issue), ['sec issue']);
  assert.deepEqual(result.final.declined.map((f) => f.issue), ['dup issue']);
  assert.match(result.final.declined[0].reason, /re-review/);
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
  assert.deepEqual(result.final, { findings: [], fixed: [], declined: [], cannot_verify: [] });
});

test('a final review lens that returns null is reported, never counted as clean', async () => {
  const script = { ...phaseScript({ 'final review correctness': [null] }), ...taskScript(ALL) };
  const { result } = await run(manifest(), script);
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.final.cannot_verify, ['the correctness review returned no result']);
});

test('a final fix agent that returns null leaves every finding declined', async () => {
  const script = { ...phaseScript({ 'final fix': [null] }), ...taskScript(ALL) };
  const { result, calls } = await run(manifest(), script);
  assert.ok(!labels(calls).includes('final re-review'));
  assert.deepEqual(result.final.fixed, []);
  assert.equal(result.final.declined.length, 2);
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
