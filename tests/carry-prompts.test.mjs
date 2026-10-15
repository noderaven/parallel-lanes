// 1.6.3 review carry-over in the agents' prompts: the rulings in force, the
// owner map, observed failures, and a relaunch's pre-flight.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadHelpers, H } from './harness.mjs';

const {
  implementPrompt, reviewPrompt, fixPrompt, reReviewPrompt, adjudicatorPrompt, finalReviewPrompt,
  combinedFinalReviewPrompt, finalFixPrompt, finalReReviewPrompt, verifyRepairPrompt, preflightPrompt,
} = await loadHelpers([
  'implementPrompt', 'reviewPrompt', 'fixPrompt', 'reReviewPrompt', 'adjudicatorPrompt', 'finalReviewPrompt',
  'combinedFinalReviewPrompt', 'finalFixPrompt', 'finalReReviewPrompt', 'verifyRepairPrompt', 'preflightPrompt',
]);

const task = (id, extra = {}) => ({ id, title: `Task ${id}`, files: [`src/${id}.js`], tier: 'standard', security: false, ...extra });
function manifest(overrides = {}) {
  return {
    version: 1, run_id: 'run-1', plan: '/work/plan.md', spec: '/work/spec.md', commit_rules: 'plain ASCII',
    repo: {
      mode: 'git', root: '/work/repo', git_dir: null, base_ref: 'main', branch: 'pl/run-1',
      worktree_root: '/work/wt', ledger_dir: '/work/ledger',
    },
    commands: { setup: [], test: ['npm test'], lint: [], build: [] },
    prelude: [task('T1')],
    lanes: [{ id: 'alpha', name: 'Lane alpha', tasks: [task('T2')] }],
    join: [task('T4')],
    hooks: {}, limits: { review_rounds: 5, max_parallel_lanes: 3 }, dry_run: false, done: [], reviewed: [],
    sp_dir: null, skill_dir: '/skills/parallel-lanes', ...overrides,
  };
}
const ALPHA = { dir: '/work/wt/lane-alpha', branch: 'pl-run-1-alpha', lane: 'alpha' };
const JOIN = { dir: '/work/repo', branch: 'pl/run-1', lane: 'join' };
const LEDGER = "'python3' '/skills/parallel-lanes/scripts/ledger'";
const RULINGS_CMD = `${LEDGER} rulings '/work/ledger'`;
const finding = { severity: 'important', file: 'src/a.js', line: 3, issue: 'x', fix: 'y' };
const done = { status: 'done', head: H('h1'), tests: 'ok', notes: '' };

function taskPrompts(m, where, t = task('T2')) {
  return {
    implement: implementPrompt(m, t, where, H('b0')),
    review: reviewPrompt(m, t, where, H('b0'), H('h1')),
    fix: fixPrompt(m, t, where, [finding], done, H('h1')),
    reReview: reReviewPrompt(m, t, where, H('h1'), H('h2'), [finding]),
  };
}

test('every task agent starts with the rulings in force for its lane; join agents get them all', () => {
  for (const [name, p] of Object.entries(taskPrompts(manifest(), ALPHA))) {
    assert.ok(p.includes("--rulings '/work/ledger' 'alpha'"), name);
  }
  for (const [name, p] of Object.entries(taskPrompts(manifest(), JOIN, task('T4')))) {
    assert.ok(p.includes("--rulings '/work/ledger' '-'"), name);
  }
});

test('reviewers get the owner map with their scope list, and the four-way scope rule', () => {
  const { review, reReview } = taskPrompts(manifest(), ALPHA);
  for (const p of [review, reReview]) {
    assert.ok(p.includes("--owners '/work/ledger/owners.json'"), p);
    assert.ok(p.includes('owned by a task earlier in the run'), p);
    assert.ok(p.includes('another lane running alongside, or a later task: an important finding unless a pre-flight or'
      + ' adjudicator ruling in force covers it'), p);
    assert.ok(p.includes("also in another task's Files: check the plan's split of that file"), p);
  }
});

test('implementers check owners before going outside their Files list, record observed failures, and override by id', () => {
  const p = implementPrompt(manifest(), task('T2'), ALPHA, H('b0'));
  assert.ok(p.includes(`${LEDGER} owners '/work/ledger' --task 'T2' '<path relative to the worktree>'`), p);
  assert.ok(p.includes('Observed: <test or command> failed - <why outside this task> - <rerun result>'), p);
  assert.ok(p.includes('"scope": "run"'), p);
  assert.ok(p.includes('"overrides": ['), p);
  assert.ok(p.includes('may override only an implementer ruling of its own lane'), p);
  // P7 (d1a): DJ4's rulings explained its edits to earlier lanes' files in text only; with
  // "files" the ruling names them. It permits nothing (task-checks counts an adjudicator's only).
  const flat = p.replace(/\s+/g, ' ');
  assert.ok(flat.includes('When you change a file outside your Files list, record a ruling saying why with "files": ['), p);
  assert.ok(flat.includes('it permits nothing'), p);
});

test('the adjudicator reads every ruling and may scope, override and permit files', () => {
  const ctx = { kind: 'blocked', task: task('T2'), where: ALPHA, details: 'stuck', findings: [] };
  const p = adjudicatorPrompt(manifest(), ctx);
  assert.ok(p.includes(RULINGS_CMD), p);
  for (const field of ['"scope": "run"', '"overrides": [', '"files": [']) assert.ok(p.includes(field), field);
});

test('final reviewers, the final fix, the re-review and the verify repair read every ruling', () => {
  const m = manifest();
  const verify = { ok: false, head: H('f1'), results: [{ group: 'test', command: 'npm test', exit: 1, log: '/l', tail: 'x' }] };
  const prompts = {
    lens: finalReviewPrompt(m, 'correctness', null, []),
    combined: combinedFinalReviewPrompt(m, { e2e: null, minors: [] }),
    fix: finalFixPrompt(m, [{ ...finding, id: 'F1' }], H('t0')),
    reReview: finalReReviewPrompt(m, H('t0'), H('f1'), [{ ...finding, id: 'F1', dispositions: [] }], verify, []),
    repair: verifyRepairPrompt(m, verify, H('f1'), 1),
  };
  for (const [name, p] of Object.entries(prompts)) assert.ok(p.includes(RULINGS_CMD), name);
  for (const p of [prompts.lens, prompts.combined]) {
    assert.ok(p.includes('A finding that a ruling in force settles is not raised unless it is critical or important;'
      + ' then raise it and cite the ruling\'s id.'), p);
    assert.ok(p.includes(`${LEDGER} undeclared '/work/ledger'`), p);
    // d1a F22: "another lane's file" made a lens demand a ruling for an earlier lane's file,
    // which the task rules allow; the lens rule must match them.
    const flat = p.replace(/\s+/g, ' ');
    assert.ok(flat.includes('A file of a task earlier in the run needs no ruling'), p);
    assert.ok(flat.includes('a task in another lane running alongside, or a later task'), p);
    assert.ok(!flat.includes("another lane's or a later task's file"), p);
  }
});

test("a relaunch's pre-flight checks only the tasks still to run, bound by the earlier rulings", () => {
  const fresh = preflightPrompt(manifest());
  assert.ok(!fresh.includes('Built tasks'), fresh);
  const m = manifest({ done: ['T1', 'T2'], reviewed: ['T1'], inputs_changed: { plan: true, spec: false } });
  const p = preflightPrompt(m);
  assert.ok(p.includes('Built tasks (done in an earlier launch; never rule on their code): T1, T2'), p);
  assert.ok(p.includes(RULINGS_CMD), p);
  assert.ok(p.includes('A matter an earlier ruling settled is not a conflict and gets no new ruling'), p);
  assert.ok(p.includes('The plan changed since the last launch; the spec did not.'), p);
  const unknown = preflightPrompt(manifest({ done: ['T1'], reviewed: ['T1'] }));
  assert.ok(unknown.includes('Whether the plan or the spec changed since the last launch is not known.'), unknown);
});

test("a relaunch with carried minors but no task done still gets the earlier rulings in pre-flight", () => {
  const m = manifest({ carried_minors: { open: [], covered: [] } });
  const p = preflightPrompt(m);
  assert.ok(p.includes(RULINGS_CMD), p);
  assert.ok(p.includes('Built tasks (done in an earlier launch; never rule on their code): (none)'), p);
});

test('the owners command in the implement prompt asks for a quoted path relative to the worktree', () => {
  const p = implementPrompt(manifest(), task('T2'), ALPHA, H('b0'));
  assert.ok(p.includes("--task 'T2' '<path relative to the worktree>'"), p);
});
