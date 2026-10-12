// Task prompts under the 1.6.0 check policy (spec 4.3): implementers run the
// task-checks call once before committing; fixers run focused tests only;
// reviewers see the unit's task-check evidence; no task agent gets the
// every-check run-checks line.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadHelpers, H } from './harness.mjs';

const {
  implementPrompt, reviewPrompt, reReviewPrompt, fixPrompt, laneChecks, wideChecks, taskChecksCommand,
  taskEvidenceLine, fixMessagesLines, fallbackImplementer, fallbackFixer, laneWhere, featureWhere, batchUnit,
  repairFixMessage,
} = await loadHelpers([
  'implementPrompt', 'reviewPrompt', 'reReviewPrompt', 'fixPrompt', 'laneChecks', 'wideChecks', 'taskChecksCommand',
  'taskEvidenceLine', 'fixMessagesLines', 'fallbackImplementer', 'fallbackFixer', 'laneWhere', 'featureWhere',
  'batchUnit', 'repairFixMessage',
]);

function task(id, extra = {}) {
  return { id, title: `Task ${id}`, files: [`src/${id}.js`, `tests/${id}.test.mjs`], tier: 'standard', security: false, ...extra };
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
    commands: { setup: ['npm ci'], test: ['npm test'], lint: ['npm run lint'], build: [] },
    prelude: [task('T1')],
    lanes: [
      { id: 'alpha', name: 'Lane alpha', tasks: [task('T2'), task('T3')] },
      { id: 'beta', name: 'Lane beta', tasks: [task('T4')] },
    ],
    join: [task('T5')],
    hooks: {},
    limits: { review_rounds: 5, max_parallel_lanes: 3 },
    dry_run: false,
    done: [],
    reviewed: [],
    sp_dir: '/sp/skills',
    skill_dir: '/skills/parallel-lanes',
    task_checks: { T2: { test: ['node --test tests/t2.test.mjs'] }, T3: { test: ['node --test tests/t3.test.mjs'] } },
    widen_paths: ['package.json', 'tests/harness.mjs'],
    ...overrides,
  };
}

const lane = (m, id) => m.lanes.find((l) => l.id === id);
const t = (m, id) => [...m.prelude, ...m.lanes.flatMap((l) => l.tasks), ...m.join].find((x) => x.id === id);
const flat = (s) => s.replace(/\s+/g, ' ');

test('an implement prompt carries the task-checks call with the entry', () => {
  const m = manifest();
  const where = laneWhere(m, lane(m, 'alpha'));
  const p = implementPrompt(m, t(m, 'T2'), where, H('base'));
  assert.match(p, /scripts\/task-checks' '\/work\/wt\/lane-alpha'/);
  for (const part of [
    `--base '${H('base')}'`, "--ledger '/work/ledger'", "--unit 'T2'", "--lane 'alpha'", "--task 'T2'",
    "--declared 'src/T2.js'", "--declared 'tests/T2.test.mjs'", "--widen 'package.json'", "--widen 'tests/harness.mjs'",
    "--project-test 'npm test'", "--entry 'T2'", "--targeted 'test' 'node --test tests/t2.test.mjs'",
    "--targeted 'lint' 'npm run lint'", "--lane-cmd 'test' 'npm test'", "--lane-cmd 'lint' 'npm run lint'",
    "--wide-cmd 'test' 'npm test'",
  ]) assert.ok(p.includes(part), part);
  const text = flat(p);
  assert.ok(text.includes('Before you commit, run the task checks once, as one call.'));
  assert.ok(text.includes('While iterating, run only the focused tests for what you change.'));
  assert.ok(text.includes('--force-full'));
  assert.ok(!p.includes('- every check at once'));
});

test('a task without an entry gets no --entry and still gets --lane-cmd and --wide-cmd', () => {
  const m = manifest();
  const cmd = taskChecksCommand(m, t(m, 'T4'), laneWhere(m, lane(m, 'beta')), H('b'));
  assert.ok(!cmd.includes('--entry') && !cmd.includes('--targeted'), cmd);
  assert.ok(cmd.includes("--lane-cmd 'test' 'npm test'") && cmd.includes("--wide-cmd 'test' 'npm test'"), cmd);
});

test('a batch unit uses its last task\'s entry and passes every --task and --declared', () => {
  const m = manifest();
  const unit = batchUnit([t(m, 'T2'), t(m, 'T3')]);
  const cmd = taskChecksCommand(m, unit, laneWhere(m, lane(m, 'alpha')), H('b'));
  assert.ok(cmd.includes("--unit 'T2-T3'"), cmd);
  assert.ok(cmd.includes("--task 'T2' --task 'T3'"), cmd);
  assert.ok(cmd.includes("--entry 'T3'") && cmd.includes("'node --test tests/t3.test.mjs'"), cmd);
  for (const f of ['src/T2.js', 'tests/T2.test.mjs', 'src/T3.js', 'tests/T3.test.mjs']) assert.ok(cmd.includes(`--declared '${f}'`), f);
});

test('prelude and join tasks get project-wide --wide-cmd lists', () => {
  const m = manifest({ lane_commands: { alpha: { test: ['npm test -- alpha'] } } });
  for (const [id, ledgerLane] of [['T1', 'prelude'], ['T5', 'join']]) {
    const cmd = taskChecksCommand(m, t(m, id), featureWhere(m, ledgerLane), H('b'));
    assert.ok(cmd.includes(`--lane '${ledgerLane}'`), cmd);
    assert.ok(cmd.includes("scripts/task-checks' '/work/repo'"), cmd);
    assert.ok(!cmd.includes('npm test -- alpha'), 'another lane\'s override is not in the wide list');
  }
  assert.deepEqual(wideChecks(m, 'prelude'), [{ group: 'test', command: 'npm test' }, { group: 'lint', command: 'npm run lint' }]);
});

test('a lite manifest\'s task runs in the feature checkout', () => {
  const m = manifest({ profile: 'lite', lanes: [{ id: 'alpha', name: 'Lane alpha', tasks: [task('T2')] }], prelude: [], join: [] });
  const cmd = taskChecksCommand(m, t(m, 'T2'), featureWhere(m, 'alpha'), H('b'));
  assert.ok(cmd.startsWith("cd '/work/repo' && "), cmd);
  assert.ok(cmd.includes("--lane 'alpha'"), cmd);
});

test('wideChecks adds only the task\'s own lane overrides', () => {
  const m = manifest({ lane_commands: { alpha: { test: ['npm test -- alpha'] }, beta: { lint: ['lint-beta'] } } });
  assert.deepEqual(wideChecks(m, 'alpha'), [
    { group: 'test', command: 'npm test' }, { group: 'lint', command: 'npm run lint' },
    { group: 'test', command: 'npm test -- alpha' },
  ]);
  assert.deepEqual(wideChecks(m, 'beta'), [
    { group: 'test', command: 'npm test' }, { group: 'lint', command: 'npm run lint' },
    { group: 'lint', command: 'lint-beta' },
  ]);
  assert.deepEqual(laneChecks(m, 'alpha'), [{ group: 'test', command: 'npm test -- alpha' }, { group: 'lint', command: 'npm run lint' }]);
});

test('no lane checks means no task-checks call and no task-checks text', () => {
  const m = manifest({ commands: { setup: [], test: [], lint: [], build: [] }, task_checks: {} });
  const where = laneWhere(m, lane(m, 'alpha'));
  assert.equal(taskChecksCommand(m, t(m, 'T2'), where, H('b')), null);
  const p = implementPrompt(m, t(m, 'T2'), where, H('b'));
  assert.ok(!p.includes('task-checks') && !flat(p).includes('run the task checks once'), p);
});

test('fix, review and re-review prompts have no task-checks call and no every-check line', () => {
  const m = manifest();
  const where = laneWhere(m, lane(m, 'alpha'));
  const finding = { id: 'F1', severity: 'important', file: 'src/T2.js', line: 1, issue: 'x', fix: 'y' };
  const prompts = {
    review: reviewPrompt(m, t(m, 'T2'), where, H('a'), H('b')),
    reReview: reReviewPrompt(m, t(m, 'T2'), where, H('b'), H('c'), [finding]),
    fix: fixPrompt(m, t(m, 'T2'), where, [finding], { status: 'done' }, H('b')),
  };
  for (const [name, p] of Object.entries(prompts)) {
    assert.ok(!p.includes('scripts/task-checks'), name);
    assert.ok(!p.includes('- every check at once'), name);
  }
  const fix = flat(prompts.fix);
  assert.ok(fix.includes('Rerun the tests that cover the amended code; do not run the task checks or the full suite'), fix);
});

test('review prompts name the unit\'s evidence files and invite a finding on a wrong selection', () => {
  const m = manifest();
  const where = laneWhere(m, lane(m, 'alpha'));
  const line = taskEvidenceLine(m, t(m, 'T2'));
  assert.ok(line.includes('/work/ledger/checks/task-T2.<n>.json'), line);
  assert.ok(flat(line).includes('Report a wrong selection as a finding'), line);
  assert.ok(reviewPrompt(m, t(m, 'T2'), where, H('a'), H('b')).includes(line));
  assert.ok(reReviewPrompt(m, t(m, 'T2'), where, H('b'), H('c'), []).includes(line));
  assert.ok(taskEvidenceLine(m, batchUnit([t(m, 'T2'), t(m, 'T3')])).includes('task-T2-T3.<n>.json'));
});

test('the fix fallback is not the implement fallback', () => {
  const impl = fallbackImplementer();
  const fix = fallbackFixer();
  assert.notEqual(impl, fix);
  assert.ok(fix.startsWith('Built-in instructions (superpowers not found):'), fix);
  assert.ok(flat(impl).includes('run the task checks command once before committing'), impl);
  assert.ok(!flat(impl).includes('full project test suite'), impl);
  assert.ok(!flat(fix).includes('task checks command once'), fix);
  const m = manifest({ sp_dir: null });
  const where = laneWhere(m, lane(m, 'alpha'));
  const finding = { id: 'F1', severity: 'important', file: 'src/T2.js', line: 1, issue: 'x', fix: 'y' };
  assert.ok(fixPrompt(m, t(m, 'T2'), where, [finding], { status: 'done' }, H('b')).includes(fix));
  assert.ok(implementPrompt(m, t(m, 'T2'), where, H('b')).includes(impl));
});

test('fixMessagesLines names the repair message', () => {
  assert.ok(flat(fixMessagesLines().join('\n')).includes(`\`${repairFixMessage()}\``));
});
