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
    setup: [{ ok: true, discarded: [], worktrees: ['/work/wt/lane-alpha', '/work/wt/lane-beta'], feature_head: 'F0', notes: '' }],
    'pre-flight': [{ conflicts: [], rulings: ['Ruling: x - y - z'] }],
    integrate: [{ status: 'done', head: 'I1', notes: 'merged' }],
    'post-integrate': [{ status: 'done', head: 'P1', notes: 'contracts ok' }],
    e2e: [{ items: [{ item: 'login', result: 'PASS', evidence: 'ok' }] }],
    'final review sp': [{ findings: [finding('dup issue')], cannot_verify: [] }],
    'final review security': [{ findings: [finding('dup issue'), finding('sec issue', 'src/b.js', 9)], cannot_verify: [] }],
    'final review correctness': [{ findings: [], cannot_verify: [] }],
    'final fix': [{ status: 'done', head: 'f1', tests: 'all pass', notes: '', declined: [] }],
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

// Backfill ranges for done tasks, as SKILL.md Resume builds them.
function backfillFor(ids) {
  return Object.fromEntries(ids.map((id) => [id, { base: `${id}-old-b`, head: `${id}-old-h` }]));
}

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

  const bases = { T1: 'F0', T2: 'T1-h', T3: 'T2-h', T4: 'T1-h', T5: 'P1' };
  for (const id of ALL) {
    const t = result.tasks[id];
    assert.equal(t.status, 'done', id);
    assert.equal(t.rounds, 0);
    assert.equal(t.tier_used, 'standard');
    assert.deepEqual(t.commits, [bases[id], `${id}-h`]);
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
  // A reused feature worktree (resume) has its uncommitted changes listed and discarded.
  assert.ok(setup.includes("git -C '/work/wt/feature' status --porcelain"), setup);
  assert.match(setup, /add each line to discarded as "\/work\/wt\/feature: <line>"/);
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
  const m = manifest({ done: [...ALL], reviewed: [...ALL], backfill: backfillFor(ALL) });
  const { result, calls, logs } = await run(m, phaseScript());
  assert.equal(result.status, 'complete');
  assert.deepEqual(labels(calls).slice(0, 4), ['setup', 'pre-flight', 'integrate', 'post-integrate']);
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
        status: 'done', head: 'f1', tests: 'pass', notes: '',
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
  assert.ok(rr.includes("'T5-h..f1'"), 'the final fix range starts at the feature tip the script tracked');
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

test('a setup result without a feature head stops the run', async () => {
  const setup = [{ ok: true, discarded: [], worktrees: [], feature_head: '', notes: '' }];
  const { result, calls } = await run(manifest(), phaseScript({ setup }));
  assert.equal(result.status, 'stopped');
  assert.match(result.reason, /feature head/);
  assert.deepEqual(labels(calls), ['setup']);
});

test('an integration that reports done without a head stops before join', async () => {
  const script = { ...phaseScript({ integrate: [{ status: 'done', head: '', notes: 'merged' }] }), ...taskScript(ALL) };
  const { result, calls } = await run(manifest(), script);
  assert.equal(result.status, 'stopped');
  assert.ok(!calls.some((c) => c.phase === 'Join'));
});

test('an e2e agent that returns null is listed under final cannot_verify', async () => {
  const script = { ...phaseScript({ e2e: [null] }), ...taskScript(ALL) };
  const { result } = await run(manifest(), script);
  assert.equal(result.status, 'complete');
  assert.ok(result.final.cannot_verify.includes('the e2e check returned no result'), JSON.stringify(result.final));
});

test('a final fix that reports the starting tip as head made no commits', async () => {
  const script = {
    ...phaseScript({ 'final fix': [{ status: 'done', head: 'T5-h', tests: '', notes: '', declined: [] }] }),
    ...taskScript(ALL),
  };
  const { result, calls } = await run(manifest(), script);
  assert.ok(!labels(calls).includes('final re-review'));
  assert.deepEqual(result.final.fixed, []);
  assert.ok(result.final.declined.every((f) => f.reason === 'final fix made no commits'));
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
    for (const role of ['setup', 'pre-flight', 'implement', 'review', 'fix', 're-review', 'integrate',
      'post-integrate', 'e2e', 'final review sp', 'final fix', 'final re-review']) {
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

// Lines of a prompt that run a provided script: ledger, task-brief, or
// review-package.
const PROVIDED = /scripts\/ledger' append|scripts\/task-brief' |scripts\/review-package' /;

test('every provided ledger, task-brief, and review-package command starts in the agent checkout', async () => {
  for (const [mode, featureDir] of [['git', '/work/repo'], ['shadow', '/work/wt/feature']]) {
    const { calls } = await fullRun(mode);
    const seen = { ledger: 0, brief: 0, review: 0 };
    for (const c of calls) {
      const prefix = `cd '${agentCheckout(c.label, featureDir)}' && `;
      for (const line of c.prompt.split('\n').filter((l) => PROVIDED.test(l))) {
        assert.ok(line.trim().startsWith(prefix), `${mode} ${c.label}: ${line.trim()}`);
        if (line.includes('scripts/ledger')) seen.ledger += 1;
        if (line.includes('scripts/task-brief')) seen.brief += 1;
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
    'final fix': [{ status: 'done', head: 'FF2', tests: '', notes: '', declined: [] }],
  });
  const second = await run(m, noop);
  assert.ok(!labels(second.calls).includes('final re-review'));
  assert.deepEqual(second.result.final.fixed, []);
  assert.deepEqual(second.result.final.declined.map((f) => f.reason), ['final fix made no commits']);
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
