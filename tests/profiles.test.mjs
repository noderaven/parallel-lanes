// Profiles (spec D2): lite runs its single lane on the feature branch with
// no integrate, no pre-flight agent, and one combined final reviewer; full
// keeps the Plan 1 phases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadHelpers, loadScript } from './harness.mjs';

const { combinedFinalReviewPrompt } = await loadHelpers(['combinedFinalReviewPrompt']);

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
    lanes: [{ id: 'alpha', name: 'Lane alpha', tasks: [task('T2'), task('T3')] }],
    join: [task('T4')],
    hooks: {},
    limits: { review_rounds: 5, max_parallel_lanes: 3 },
    dry_run: false,
    done: [],
    reviewed: [],
    sp_dir: '/sp/skills',
    skill_dir: '/skills/parallel-lanes',
    autonomy: 'supervised',
    profile: 'lite',
    ...overrides,
  };
}

// A lite manifest with the setup script's result: the lane maps to the
// feature checkout.
function liteManifest(overrides = {}) {
  const m = manifest(overrides);
  m.setup_result = { feature_head: 'S0', worktrees: { alpha: '/work/repo' }, discarded: [] };
  return m;
}

const done = (base, head) => ({ status: 'done', base, head, tests: 'npm test: pass', notes: '' });
const approve = () => ({ verdict: 'approve', findings: [], cannot_verify: [] });
const finding = (issue, file = 'src/a.js', line = 3) => ({ severity: 'important', file, line, issue, fix: 'fix it' });

function taskScript(ids) {
  const script = {};
  for (const id of ids) {
    script[`${id} implement`] = [done(`${id}-b`, `${id}-h`)];
    script[`${id} review`] = [approve()];
  }
  return script;
}

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
// The run-checks JSON the verify agent returns for these manifests' commands.
const verified = (sha) => ({ head: sha, results: [{ group: 'test', command: 'npm test', exit: 0 }], ok: true, clean: true });
const LITE = ['T1', 'T2', 'T3', 'T4'];

test('lite: no setup, pre-flight, integrate or post-integrate agent; one combined final reviewer', async () => {
  const m = liteManifest();
  const script = {
    ...taskScript(LITE),
    'final review': [{ findings: [finding('combined issue')], cannot_verify: ['e2e: none'], head: 'T4-h' }],
    'final fix': [{ status: 'done', head: 'f1', tests: 'all pass', notes: '', dispositions: [{ id: 'F1', status: 'fixed', reason: 'ok' }] }],
    'final re-review': [{ results: [{ id: 'F1', status: 'resolved', evidence: 'gone' }], new_findings: [] }],
    verify: [verified('f1')],
  };
  const { result, calls, phases } = await run(m, script);
  assert.equal(result.status, 'complete', JSON.stringify(result));
  const names = labels(calls);
  for (const absent of ['setup', 'pre-flight', 'integrate', 'post-integrate']) {
    assert.ok(!names.includes(absent), `${absent} must not run: ${names.join(', ')}`);
  }
  assert.ok(!phases.includes('Setup') && !phases.includes('Pre-flight') && !phases.includes('Integrate'), phases.join(', '));
  const reviewers = calls.filter((c) => c.label.startsWith('final review'));
  assert.deepEqual(reviewers.map((c) => c.label), ['final review']);
  assert.equal(reviewers[0].model, 'opus');
  assert.equal(reviewers[0].phase, 'Final review');
  assert.ok(reviewers[0].schema.required.includes('head'));
  // The single fix wave and its re-review follow, from the reviewer's head.
  assert.deepEqual(names.slice(-3), ['final fix', 'final re-review', 'verify']);
  assert.equal(result.acceptance.status, 'accepted');
  assert.ok(calls.find((c) => c.label === 'final fix').prompt.includes('(now at T4-h)'));
  assert.deepEqual(result.final.fixed.map((f) => f.issue), ['combined issue']);
  assert.deepEqual(result.final.cannot_verify, ['combined: e2e: none']);
  assert.deepEqual(result.preflight, { conflicts: [], rulings: [], undeclared: [] });
  assert.equal(result.integrate, null);
  assert.equal(result.agents_spawned, calls.length);
});

test('lite: the lane works in the feature checkout on the feature branch with ledger lane = lane id', async () => {
  const m = liteManifest();
  const script = {
    ...taskScript(LITE),
    'final review': [{ findings: [], cannot_verify: [], head: 'T4-h' }],
    verify: [verified('T4-h')],
  };
  const { result, calls } = await run(m, script);
  assert.equal(result.status, 'complete');
  for (const id of ['T2', 'T3']) {
    const prompt = calls.find((c) => c.label === `${id} implement`).prompt;
    assert.ok(prompt.includes('Worktree: /work/repo (branch pl/run-1)'), prompt);
    assert.ok(!prompt.includes('lane-alpha'), `${id} names no lane worktree`);
    assert.ok(!prompt.includes('pl-run-1-alpha'), `${id} names no lane branch`);
    assert.ok(prompt.includes("scripts/start-task' "), `${id} opens with start-task`);
    assert.ok(!prompt.includes('--sync'), `${id} has no sync step`);
    assert.ok(prompt.includes("'/work/ledger' 'alpha' "), `${id} ledger lane is the lane id`);
    assert.equal(calls.find((c) => c.label === `${id} implement`).phase, 'Lane alpha');
  }
  // One branch: the lane continues from the prelude, the join from the lane.
  assert.deepEqual(result.tasks.T1.commits, ['S0', 'T1-h']);
  assert.deepEqual(result.tasks.T2.commits, ['T1-h', 'T2-h']);
  assert.deepEqual(result.tasks.T3.commits, ['T2-h', 'T3-h']);
  assert.deepEqual(result.tasks.T4.commits, ['T3-h', 'T4-h']);
});

test('lite: an empty prelude starts the lane at the saved setup start point', async () => {
  const m = liteManifest({ prelude: [], start_points: { prelude: 'SP0', join: 'SJ0' } });
  const script = {
    ...taskScript(['T2', 'T3', 'T4']),
    'final review': [{ findings: [], cannot_verify: [], head: 'T4-h' }],
    verify: [verified('T4-h')],
  };
  const { result } = await run(m, script);
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.tasks.T2.commits, ['SP0', 'T2-h']);
  // Lite records no join start point: the join starts at the lane's last head.
  assert.deepEqual(result.tasks.T4.commits, ['T3-h', 'T4-h']);
});

test('lite: a backfilled first lane task after an empty prelude reviews its own range', async () => {
  const m = liteManifest({
    prelude: [],
    done: ['T2'],
    reviewed: [],
    backfill: { T2: { base: 'T2-old-b', head: 'T2-old-h' } },
  });
  m.setup_result.feature_head = 'T2-old-h';
  const script = {
    ...taskScript(['T3', 'T4']),
    'T2 review': [approve()],
    'final review': [{ findings: [], cannot_verify: [], head: 'T4-h' }],
    verify: [verified('T4-h')],
  };
  const { result, calls } = await run(m, script);
  assert.equal(result.status, 'complete');
  const rev = calls.find((c) => c.label === 'T2 review').prompt;
  assert.ok(rev.includes('range T2-old-b..T2-old-h'), rev.split('\n')[0]);
  assert.deepEqual(result.tasks.T3.commits, ['T2-old-h', 'T3-h']);
});

test('lite: a stopped lane stops the run before the join', async () => {
  const m = liteManifest();
  const script = {
    ...taskScript(['T1', 'T2']),
    'T3 implement': [{ status: 'blocked', base: 'T2-h', head: 'T2-h', tests: '', notes: 'stuck' }],
  };
  const { result, calls } = await run(m, script);
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'lanes stopped');
  assert.deepEqual(result.stopped_lanes.map((s) => [s.lane, s.task]), [['alpha', 'T3']]);
  assert.ok(!labels(calls).some((l) => l.startsWith('T4') || l.startsWith('final')));
});

test('lite without setup_result is invalid for a launch: there is no setup agent', async () => {
  const { result, calls } = await run(manifest(), {});
  assert.equal(result.status, 'invalid');
  assert.ok(result.errors.some((e) => e.startsWith('setup_result: missing')));
  assert.deepEqual(calls, []);
});

test('combined final review prompt names all three lenses and asks for head', () => {
  const m = manifest({ prelude: [task('T1', { security: true })], profile: 'full' });
  const prompt = combinedFinalReviewPrompt(m, { e2e: { items: [{ item: 'login', result: 'PASS', evidence: 'ok' }] } });
  assert.match(prompt, /whole-branch lens/i);
  assert.match(prompt, /security lens/i);
  assert.match(prompt, /correctness lens/i);
  assert.ok(prompt.includes('/sp/skills/requesting-code-review/code-reviewer.md'), prompt);
  assert.ok(prompt.includes('Tasks flagged security-sensitive: T1'), prompt);
  assert.ok(prompt.includes('"item":"login"'), prompt);
  assert.match(prompt, /head = the full sha printed by\s+git -C '\/work\/repo' rev-parse HEAD/);
  assert.ok(prompt.includes('main..pl/run-1'), prompt);
  assert.match(prompt, /anything the commit rules forbid/);
  const fallback = combinedFinalReviewPrompt({ ...m, sp_dir: null }, { e2e: null });
  assert.ok(fallback.includes('superpowers not found'), fallback);
  assert.ok(fallback.includes('(no e2e hook)'), fallback);
});

test('full profile unchanged: pre-flight, integrate, the three lenses and verify run', async () => {
  const m = manifest({ profile: 'full', hooks: { post_integrate: 'POST' } });
  m.setup_result = { feature_head: 'F0', worktrees: { alpha: '/work/wt/lane-alpha' }, discarded: [] };
  const script = {
    'pre-flight': [{ conflicts: [], rulings: [], undeclared: [] }],
    integrate: [{ status: 'done', head: 'I1', notes: 'merged' }],
    'post-integrate': [{ status: 'done', head: 'P1', notes: '' }],
    ...taskScript(LITE),
    'final review sp': [{ findings: [], cannot_verify: [], head: 'P1' }],
    'final review security': [{ findings: [], cannot_verify: [], head: 'P1' }],
    'final review correctness': [{ findings: [], cannot_verify: [], head: 'P1' }],
    verify: [verified('P1')],
  };
  const { result, calls } = await run(m, script);
  assert.equal(result.status, 'complete');
  assert.deepEqual(labels(calls).filter((l) => !/^T\d/.test(l)),
    ['pre-flight', 'integrate', 'post-integrate', 'final review sp', 'final review security', 'final review correctness', 'verify']);
  const t2 = calls.find((c) => c.label === 'T2 implement').prompt;
  assert.ok(t2.includes('Worktree: /work/wt/lane-alpha (branch pl-run-1-alpha)'), t2);
  assert.deepEqual(result.tasks.T4.commits, ['P1', 'T4-h']);
});
