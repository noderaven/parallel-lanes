// Task prompts under the 1.6.0 check policy (spec 4.3): implementers run the
// task-checks call once before committing; fixers run focused tests only;
// reviewers see the unit's task-check evidence; no task agent gets the
// every-check run-checks line.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadHelpers, H, SKILL_DIR } from './harness.mjs';
import { BASH, tempDir } from './platform.mjs';

const {
  implementPrompt, reviewPrompt, reReviewPrompt, fixPrompt, laneChecks, wideChecks, taskChecksCommand,
  taskEvidenceLine, fixMessagesLines, fallbackImplementer, fallbackFixer, laneWhere, featureWhere, batchUnit,
  repairFixMessage, procedureLines, reserveCommand, waitCommand, longCheckRuleLines, resultPath, agentRules,
  preflightPrompt, integratePrompt, resolveConflictsPrompt, postIntegrateFixPrompt, postIntegrateReReviewPrompt,
  postIntegratePrompt, e2ePrompt, finalReviewPrompt, combinedFinalReviewPrompt, finalFixPrompt, finalReReviewPrompt,
  verifyPrompt, verifyRepairPrompt, adjudicatorPrompt, declaredFingerprint, declaredFiles, startCommand, taskChecksLines,
  shellQuote, startCheckPrompt,
} = await loadHelpers([
  'implementPrompt', 'reviewPrompt', 'reReviewPrompt', 'fixPrompt', 'laneChecks', 'wideChecks', 'taskChecksCommand',
  'taskEvidenceLine', 'fixMessagesLines', 'fallbackImplementer', 'fallbackFixer', 'laneWhere', 'featureWhere',
  'batchUnit', 'repairFixMessage', 'procedureLines', 'reserveCommand', 'waitCommand', 'longCheckRuleLines',
  'resultPath', 'agentRules', 'preflightPrompt', 'integratePrompt', 'resolveConflictsPrompt', 'postIntegrateFixPrompt',
  'postIntegrateReReviewPrompt', 'postIntegratePrompt', 'e2ePrompt', 'finalReviewPrompt', 'combinedFinalReviewPrompt',
  'finalFixPrompt', 'finalReReviewPrompt', 'verifyPrompt', 'verifyRepairPrompt', 'adjudicatorPrompt',
  'declaredFingerprint', 'declaredFiles', 'startCommand', 'taskChecksLines', 'shellQuote', 'startCheckPrompt',
]);
const fp = declaredFingerprint;

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
    `--declared-from-owners '${fp(['src/T2.js', 'tests/T2.test.mjs'])}'`, "--widen 'package.json'",
    "--widen 'tests/harness.mjs'", "--project-test 'npm test'", "--entry 'T2'",
    "--targeted 'test' 'node --test tests/t2.test.mjs'", "--targeted 'lint' 'npm run lint'",
    "--lane-cmd 'test' 'npm test'", "--lane-cmd 'lint' 'npm run lint'", '--wide-as-lane',
  ]) assert.ok(p.includes(part), part);
  // No --declared list (the prompt's owners.json sentence names the option, unquoted).
  assert.ok(!/--declared '/.test(p), p);
  assert.ok(!p.includes('--wide-cmd'), p);
  const text = flat(p);
  assert.ok(text.includes('Before you commit, run the task checks once, with the procedure below.'));
  assert.ok(text.includes('While iterating, run only the focused tests for what you change.'));
  assert.ok(text.includes('--force-full'));
  assert.ok(!p.includes('- every check at once'));
});

test('a task without an entry gets no --entry and still gets --lane-cmd and --wide-as-lane', () => {
  const m = manifest();
  const cmd = taskChecksCommand(m, t(m, 'T4'), laneWhere(m, lane(m, 'beta')), H('b'));
  assert.ok(!cmd.includes('--entry') && !cmd.includes('--targeted'), cmd);
  assert.ok(cmd.includes("--lane-cmd 'test' 'npm test'") && cmd.includes('--wide-as-lane'), cmd);
});

test('a batch unit uses its last task\'s entry and passes every --task and the fingerprint of every file', () => {
  const m = manifest();
  const unit = batchUnit([t(m, 'T2'), t(m, 'T3')]);
  const cmd = taskChecksCommand(m, unit, laneWhere(m, lane(m, 'alpha')), H('b'));
  assert.ok(cmd.includes("--unit 'T2-T3'"), cmd);
  assert.ok(cmd.includes("--task 'T2' --task 'T3'"), cmd);
  assert.ok(cmd.includes("--entry 'T3'") && cmd.includes("'node --test tests/t3.test.mjs'"), cmd);
  const files = ['src/T2.js', 'tests/T2.test.mjs', 'src/T3.js', 'tests/T3.test.mjs'];
  assert.ok(cmd.includes(`--declared-from-owners '${fp(files)}'`), cmd);
  assert.ok(!cmd.includes('--declared '), cmd);
});

test('task-checks gets no --permit without permits, and one per kept file of the unit\'s tasks', () => {
  const plain = manifest();
  const where = laneWhere(plain, lane(plain, 'alpha'));
  const p = implementPrompt(plain, t(plain, 'T2'), where, H('b'));
  assert.ok(!p.includes('--permit') && !p.includes('does not widen your checks'), p);
  const m = manifest({ run_permits: [
    { task: 'T3', files: ['tools/a.py', 'tools/b.py'], ruling: 0 },
    { task: 'T4', files: ['tools/c.py'], ruling: 1 },
    { task: 'T2', files: ['tools/d.py'], ruling: 2 },
  ] });
  const solo = taskChecksCommand(m, t(m, 'T2'), where, H('b'));
  assert.ok(solo.includes("--permit 'tools/d.py=PF-3'"), solo);
  assert.ok(!solo.includes('tools/a.py') && !solo.includes('tools/c.py'), solo);
  const unit = batchUnit([t(m, 'T2'), t(m, 'T3')]);
  const cmd = taskChecksCommand(m, unit, where, H('b'));
  for (const part of ["--permit 'tools/a.py=PF-1'", "--permit 'tools/b.py=PF-1'", "--permit 'tools/d.py=PF-3'"]) {
    assert.ok(cmd.includes(part), part);
  }
  assert.ok(!cmd.includes('tools/c.py'), cmd);
  const text = implementPrompt(m, unit, where, H('b'));
  assert.ok(text.includes('PF-1 permits T3 to change tools/a.py, tools/b.py: changing them does not widen your checks.'), text);
  assert.ok(text.includes('PF-3 permits T2 to change tools/d.py: changing them does not widen your checks.'), text);
  assert.ok(!text.includes('permits T4'), text);
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

test('a lane that overrides setup widens to its own checks: its worktree never ran the project setup', () => {
  const m = manifest({
    commands: { setup: ['npm ci', 'uv sync'], test: ['npm test', 'pytest'], lint: [], build: [] },
    lane_commands: { alpha: { setup: ['uv sync'], test: ['pytest'] }, beta: { test: ['npm test'] } },
  });
  assert.deepEqual(wideChecks(m, 'alpha'), laneChecks(m, 'alpha'));
  assert.deepEqual(wideChecks(m, 'alpha'), [{ group: 'test', command: 'pytest' }]);
  // Same setup as the project (or no setup override): project-wide as before.
  assert.deepEqual(wideChecks(m, 'beta'), [{ group: 'test', command: 'npm test' }, { group: 'test', command: 'pytest' }]);
  const same = manifest({ lane_commands: { alpha: { setup: ['npm ci'], test: ['npm test -- alpha'] } } });
  assert.deepEqual(wideChecks(same, 'alpha'), [
    { group: 'test', command: 'npm test' }, { group: 'lint', command: 'npm run lint' },
    { group: 'test', command: 'npm test -- alpha' },
  ]);
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
  // 1.6.0 deferred minor: task-1.<n>.json also matches unit 1.2's task-1.2.<n>.json files.
  assert.ok(flat(line).includes('read only the files whose policy.unit is T2'), line);
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

// ---- 1.6.6: agents write long files with Edit and Write (spec 4.6)

test('agentRules names the Bash command limit and how to add to a file', () => {
  const text = flat(agentRules());
  assert.ok(text.includes('7,000 characters'), text);
  assert.ok(text.includes('heredoc'), text);
  assert.ok(text.includes('Read it and then Edit it, or Write the whole file'), text);
  assert.ok(text.includes('shell quoting'), text);
});

test('no fix prompt says append for the fix report', () => {
  const finding = { id: 'F1', severity: 'important', file: 'src/T2.js', line: 1, issue: 'x', fix: 'y' };
  for (const m of [manifest(), manifest({ sp_dir: null })]) {
    const where = laneWhere(m, lane(m, 'alpha'));
    const p = fixPrompt(m, t(m, 'T2'), where, [finding], { status: 'done' }, H('b'));
    assert.ok(p.includes('fix report'), p);
    assert.ok(!/append a fix report/.test(flat(p)), p);
    assert.ok(flat(p).includes('with your file-editing tools'), p);
  }
});

test('fixMessagesLines names the repair message', () => {
  assert.ok(flat(fixMessagesLines().join('\n')).includes(`\`${repairFixMessage()}\``));
});

// ---- 1.6.1: one procedure for every check an agent runs (spec 4.1, 4.4)

const RESERVE = "'python3' '/skills/parallel-lanes/scripts/await-checks' reserve --ledger '/work/ledger' --name ";
const WAIT = "'python3' '/skills/parallel-lanes/scripts/await-checks' wait '<P>'";

// Every prompt the engine builds, over the standard manifest (with hooks so
// the hook prompts have their instructions).
function everyPrompt() {
  const m = manifest({ hooks: { post_integrate: 'POST-HOOK', e2e: 'E2E-HOOK' } });
  const supervised = manifest({ autonomy: 'supervised', hooks: { post_integrate: 'POST-HOOK' } });
  const where = laneWhere(m, lane(m, 'alpha'));
  const finding = { id: 'F1', severity: 'important', file: 'src/T2.js', line: 1, issue: 'x', fix: 'y' };
  const verify = { head: H('v1'), ok: false, results: [{ group: 'test', command: 'npm test', exit: 1 }] };
  const ctx = { kind: 'blocked', task: t(m, 'T2'), where, details: 'Blocked: which key?', findings: [] };
  return {
    implement: implementPrompt(m, t(m, 'T2'), where, H('b')),
    implementBatch: implementPrompt(m, batchUnit([t(m, 'T2'), t(m, 'T3')]), where, H('b')),
    review: reviewPrompt(m, t(m, 'T2'), where, H('a'), H('b')),
    reReview: reReviewPrompt(m, t(m, 'T2'), where, H('b'), H('c'), [finding]),
    fix: fixPrompt(m, t(m, 'T2'), where, [finding], { status: 'done' }, H('b')),
    preflight: preflightPrompt(m),
    integrate: integratePrompt(m, H('pre')),
    integrateHeal: integratePrompt(m, H('pre'), { testFailure: 'heal', joinStartPoint: true }),
    resolve: resolveConflictsPrompt(m, H('pre'), ['src/a.js']),
    postIntegrateFixHook: postIntegrateFixPrompt(m, 'the hook failed', 'hook'),
    postIntegrateFixTests: postIntegrateFixPrompt(m, 'npm test failed', 'tests'),
    postIntegrateReReview: postIntegrateReReviewPrompt(m, H('a'), H('b')),
    postIntegrate: postIntegratePrompt(m),
    postIntegrateRecheck: postIntegratePrompt(m, true, verify),
    e2e: e2ePrompt(m),
    finalReviewSp: finalReviewPrompt(m, 'sp', null),
    finalReviewSecurity: finalReviewPrompt(m, 'security', null),
    finalReviewCorrectness: finalReviewPrompt(m, 'correctness', null),
    combinedFinalReview: combinedFinalReviewPrompt(m, { e2e: null }),
    finalFix: finalFixPrompt(m, [finding], H('tip')),
    finalFixSupervised: finalFixPrompt(supervised, [finding], H('tip')),
    finalReReview: finalReReviewPrompt(m, H('tip'), H('f1'), [{ ...finding, dispositions: [] }], verify),
    verify: verifyPrompt(m, H('d1')),
    verifyFrom: verifyPrompt(m, H('d1'), H('d0')),
    verifyRepair: verifyRepairPrompt(m, verify, H('v1'), 1),
    startCheck: startCheckPrompt({ ...m, start_points: { ...m.start_points, prelude: H('s0') } }, verify, H('v1')),
    adjudicator: adjudicatorPrompt(m, ctx),
  };
}

test('the implementer reserves task-<id> and starts task-checks with --evidence in the background', () => {
  const m = manifest();
  const where = laneWhere(m, lane(m, 'alpha'));
  const p = implementPrompt(m, t(m, 'T2'), where, H('base'));
  assert.ok(p.includes(`${RESERVE}'task-T2'`), p);
  assert.ok(!p.includes(`${RESERVE}'task-T2' --exact`), 'a task check never reserves an exact path');
  const start = p.split('\n').find((l) => l.includes("/scripts/task-checks' "));
  assert.ok(start.includes("--evidence '<P>'"), start);
  assert.ok(taskChecksCommand(m, t(m, 'T2'), where, H('base')).includes("--evidence '<P>'"));
  // The reserve comes first, then the start in the background, then the wait.
  const reserveAt = p.indexOf(`${RESERVE}'task-T2'`);
  const startAt = p.indexOf(start);
  const waitAt = p.indexOf(WAIT, startAt);
  assert.ok(reserveAt >= 0 && reserveAt < startAt && startAt < waitAt, 'reserve, start, wait in order');
  const text = flat(p.slice(reserveAt, waitAt));
  assert.ok(text.includes('run_in_background set to true'), text);
  // A batch reserves under its unit id.
  const batch = implementPrompt(m, batchUnit([t(m, 'T2'), t(m, 'T3')]), where, H('base'));
  assert.ok(batch.includes(`${RESERVE}'task-T2-T3'`), batch);
  // The logs stay with the evidence.
  assert.ok(flat(p).includes("kept with the run's evidence: read the log instead of rerunning a command, and leave the"
    + ' file in place'), p);
});

test('procedureLines names reserve, run_in_background, wait and its exit codes 4 and 5', () => {
  const m = manifest();
  const start = "cd '/work/repo' && 'python3' '/skills/parallel-lanes/scripts/run-checks' '/work/repo' --out '<P>'";
  const lines = procedureLines(m, { name: 'probe', start });
  const text = flat(lines.join('\n'));
  assert.equal(reserveCommand(m, 'probe'), `${RESERVE}'probe'`);
  assert.equal(reserveCommand(m, 'probe', true), `${RESERVE}'probe' --exact`);
  assert.equal(waitCommand(m), WAIT);
  assert.equal(resultPath(), "'<P>'");
  // The five points of spec 4.1, in order.
  const at = (s) => {
    const i = text.indexOf(s);
    assert.ok(i >= 0, `${s}: ${text}`);
    return i;
  };
  const points = [
    at(`${RESERVE}'probe'`),
    at('replace <P> with the path it printed, keeping the single quotes'),
    at("with the Bash tool's run_in_background set to true"),
    at(start),
    at('with a 600000 ms timeout'),
    at(WAIT),
    at('Exit 4 means the check is still running: run the wait again'),
    at('change nothing in that checkout'),
    at('never finish your turn'),
    at('Exit 5 means the check stopped without a result: reserve and start it once more'),
    at('After a second stop'),
  ];
  assert.deepEqual(points, [...points].sort((a, b) => a - b), 'in the order of spec 4.1');
  assert.ok(text.includes('Every run, a rerun after a fix included, starts with its own reserve'), text);
  assert.ok(text.includes('In the start and wait commands below, replace <P> with the path it printed'), text);
  assert.ok(text.includes("write any single quote inside the path as '\\''"), text);
  assert.ok(text.includes('the checkout changed while the checks ran, run them once more, starting with a new '
    + 'reserve. Rerun only once: if the checkout changed again on that rerun, do not run the checks a third time; '
    + 'keep that result (it carries tree_changed true) and say in your notes that the checks themselves change the '
    + 'checkout.'), text);
  assert.ok(!text.includes('run them again'), text);
  // A caller can say what a rerun that changed the checkout again returns.
  const changed = flat(procedureLines(m, { name: 'x', start, changed: 'return CHANGED-TEXT.' }).join('\n'));
  assert.ok(changed.includes('do not run the checks a third time; return CHANGED-TEXT.'), changed);
  // No busy reserve handling without --exact; with it, wait on the file
  // reserve names. (Exit 75, a busy project, is the exit-code rule's.)
  assert.ok(!text.includes('status busy') && !text.includes('If reserve exits 4'), text);
  const exact = flat(procedureLines(m, { name: 'verify-x', exact: true, start }).join('\n'));
  assert.ok(exact.includes(`${RESERVE}'verify-x' --exact`), exact);
  assert.ok(exact.includes('If reserve exits 4 with status busy'), exact);
  assert.ok(exact.includes('run the wait on the file it names until the wait no longer exits 4, ignore that report, '
    + 'then reserve again'), exact);
  // A caller can say what a second stop returns.
  const own = flat(procedureLines(m, { name: 'x', start, stop: 'return STOP-TEXT.' }).join('\n'));
  assert.ok(own.includes('After a second stop, do not start it again: return STOP-TEXT.'), own);
});

// ---- 1.6.2: the exit-code contract, worded per caller (spec 4.3)

const EXITS = ['exits 124 timed out', 'exits 75 found the project busy'];
const CHANGE_NOTHING = 'do not change code, tests, timeouts or commands';

test('procedureLines carries the exit-code rule: not a defect, change nothing, say so', () => {
  const m = manifest();
  const start = "cd '/work/repo' && 'python3' '/skills/parallel-lanes/scripts/run-checks' '/work/repo' --out '<P>'";
  const text = flat(procedureLines(m, { name: 'x', start }).join('\n'));
  for (const s of EXITS) assert.ok(text.includes(s), `${s}: ${text}`);
  assert.ok(text.includes('128 or above'), text);
  assert.ok(text.includes(CHANGE_NOTHING), text);
  assert.ok(text.includes('say so in your notes'), text);
  // The long-command rule and the fixers' every-check line carry the same rule.
  const long = flat(longCheckRuleLines(m).join('\n'));
  for (const s of [...EXITS, CHANGE_NOTHING, 'say so in your notes']) assert.ok(long.includes(s), `${s}: long`);
  const finding = { id: 'F1', severity: 'important', file: 'src/T2.js', line: 1, issue: 'x', fix: 'y' };
  for (const [name, p] of [['final fix', finalFixPrompt(m, [finding], H('tip'))],
    ['post-integrate fix', postIntegrateFixPrompt(m, 'npm test failed', 'tests')]]) {
    const rule = flat(p);
    assert.ok(rule.includes(CHANGE_NOTHING) && rule.includes(EXITS[1]), name);
  }
  // A caller can word what it does with such a failure.
  const own = flat(procedureLines(m, { name: 'x', start, exits: ['OWN-EXITS-TEXT.'] }).join('\n'));
  for (const s of EXITS) assert.ok(own.includes(s), `${s}: ${own}`);
  assert.ok(own.includes('OWN-EXITS-TEXT.') && !own.includes(CHANGE_NOTHING), own);
});

test('the implementer reports a task check that failed only with those exits blocked, changing nothing', () => {
  const m = manifest();
  const where = laneWhere(m, lane(m, 'alpha'));
  const p = implementPrompt(m, t(m, 'T2'), where, H('base'));
  const start = p.indexOf('Task checks. Before you commit');
  const text = flat(p.slice(start, p.indexOf('It picks the targeted checks', start)));
  for (const s of EXITS) assert.ok(text.includes(s), `${s}: ${text}`);
  assert.ok(text.includes('failed only with such exits'), text);
  assert.ok(text.includes(CHANGE_NOTHING), text);
  assert.ok(text.includes('report blocked, naming the exits and the result file'), text);
});

test('the verify prompt reports the exits as printed and is never told to report blocked', () => {
  const m = manifest();
  for (const p of [verifyPrompt(m, H('d1')), verifyPrompt(m, H('d1'), H('d0'))]) {
    const start = p.indexOf('3. Run the checks');
    const text = flat(p.slice(start, p.indexOf(keepFilesMarker(p), start)));
    for (const s of EXITS) assert.ok(text.includes(s), `${s}: ${text}`);
    assert.ok(text.includes('report each exit as the wait printed it'), text);
    assert.ok(!/blocked/i.test(text), text);
    assert.ok(!/report(ed)? blocked/i.test(flat(p)), 'nothing in the verify prompt says report blocked');
  }
});
// Where verify's step 3 ends: the first line after it that is not indented.
function keepFilesMarker(p) {
  const lines = p.split('\n');
  const at = lines.findIndex((l) => l.startsWith('3. Run the checks'));
  return lines.slice(at + 1).find((l) => l !== '' && !l.startsWith(' '));
}

test('heal-mode integrate sets checks_unfinished when every failing command exited 75, 124, 128 or above', () => {
  const m = manifest();
  const heal = flat(integratePrompt(m, H('pre'), { testFailure: 'heal' }));
  for (const s of EXITS) assert.ok(heal.includes(s), `${s}: ${heal}`);
  assert.ok(heal.includes('When every failing command exited 75, 124, 128 or above (or a negative code)'), heal);
  assert.ok(heal.includes('tests_failed true and checks_unfinished true'), heal);
  assert.ok(heal.includes(CHANGE_NOTHING), heal);
  assert.ok(heal.includes('A failing command with any other exit is a real failure: checks_unfinished false.'), heal);
  assert.ok(heal.includes('and checks_unfinished (true when every failing command exited 75, 124, 128 or above'), heal);
  // The plain and abort-mode prompts keep the general rule and never ask for it.
  for (const p of [integratePrompt(m, H('pre')), integratePrompt(m, H('pre'), { conflictMode: 'abort' })]) {
    const text = flat(p);
    assert.ok(!text.includes('checks_unfinished'), text);
    assert.ok(text.includes(CHANGE_NOTHING) && text.includes(EXITS[0]), text);
  }
});

test('the repair prompt names 75 beside its timeout clause', () => {
  const verify = { head: H('f1'), results: [{ group: 'test', command: 'npm test', exit: 1 }] };
  const p = flat(verifyRepairPrompt(manifest(), verify, H('f1'), 1));
  assert.ok(p.includes('flaky, timeout, crash or environment failure rather than a failing check (exit 124 is a '
    + 'timeout, exit 75 a busy project)'), p);
});

test('the adjudicator is told such a failure is not a defect to fix', () => {
  const m = manifest();
  const where = laneWhere(m, lane(m, 'alpha'));
  const p = flat(adjudicatorPrompt(m, { kind: 'blocked', task: t(m, 'T2'), where, details: 'x', findings: [] }));
  assert.ok(p.includes('A check that failed only with exit 75 (the project was busy), 124 (it timed out), or 128 or '
    + 'above (killed by a signal) or a negative code is not a defect to fix'), p);
});

test('no prompt mentions Monitor, sleep or an output file', () => {
  for (const [name, p] of Object.entries(everyPrompt())) {
    assert.ok(!/monitor/i.test(p), `${name}: Monitor`);
    assert.ok(!/\bsleep/i.test(p), `${name}: sleep`);
    assert.ok(!/output file/i.test(p), `${name}: output file`);
    assert.ok(!/\.output\b/.test(p), `${name}: .output`);
  }
});

test('the general long-command rule reaches implementers and phase agents but not the adjudicator', () => {
  const m = manifest();
  const rule = longCheckRuleLines(m).join('\n');
  const text = flat(rule);
  assert.ok(text.includes('longer than 9 minutes'), text);
  assert.ok(text.includes(`${RESERVE}'long'`), text);
  assert.ok(text.includes("cd 'DIR' && 'python3' '/skills/parallel-lanes/scripts/run-checks' 'DIR' --out '<P>' "
    + "--root '/work/ledger' --cmd 'GROUP' 'COMMAND'"), text);
  // A single quote inside COMMAND is written the way shellQuote escapes it.
  assert.ok(text.includes("writing any single quote inside COMMAND as '\\''"), text);
  assert.ok(text.includes(WAIT), text);
  // It left the shared agent rules, which have no manifest.
  assert.ok(!agentRules().includes('600000'), agentRules());
  for (const [name, p] of Object.entries(everyPrompt())) {
    if (name === 'adjudicator') {
      assert.ok(!p.includes(rule) && !p.includes('longer than 9 minutes'), name);
    } else {
      // Task prompts carry it with their ledger lane's phase (1.6.5: run-checks
      // --phase); phase prompts without one.
      const phased = [null, 'prelude', 'lane', 'join'].map((ph) => longCheckRuleLines(m, ph).join('\n'));
      assert.ok(phased.some((r) => p.includes(r)), name);
    }
  }
});

test('a task prompt\'s long-command rule names the task\'s phase', () => {
  const rule = flat(longCheckRuleLines(manifest(), 'join').join('\n'));
  assert.ok(rule.includes("--root '/work/ledger' --phase 'join' --cmd 'GROUP' 'COMMAND'"), rule);
});

test('the result placeholder is single-quoted in every start command', () => {
  for (const [name, p] of Object.entries(everyPrompt())) {
    const flags = p.match(/--(out|evidence) \S+/g) || [];
    for (const f of flags) assert.ok(/^--(out|evidence) '<P>'$/.test(f), `${name}: ${f}`);
    // Outside the instruction that names it, <P> only ever appears quoted.
    assert.ok(!/[^']<P>|<P>[^']/.test(p.replace(/replace <P> /g, '')), `${name}: an unquoted <P>`);
  }
  const all = Object.values(everyPrompt()).join('\n');
  assert.ok(all.includes("--evidence '<P>'") && all.includes("--out '<P>'"));
});

// ---- The declared-files fingerprint and --wide-as-lane (1.6.6, spec 4.5) ----

const SCRIPTS = join(SKILL_DIR, 'scripts');
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid',
};
const ENV = { ...process.env, ...GIT_ENV };
const fwd = (p) => p.replace(/\\/g, '/');
const fpOf = (cmd) => (cmd.match(/--declared-from-owners '([^']+)'/) || [])[1];

// The fingerprint of a declared list, from Python _owners.fingerprint. The
// list goes over as ASCII JSON (\u escapes), so argv encoding plays no part.
function pyFingerprint(paths) {
  const code = [
    'import json, sys',
    'sys.dont_write_bytecode = True',
    `sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`,
    'import _owners',
    'print(_owners.fingerprint(json.loads(sys.argv[1])))',
  ].join('\n');
  const json = JSON.stringify(paths).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const res = spawnSync('python3', ['-B', '-c', code, json], { encoding: 'utf8', env: ENV });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim();
}

test('the task-checks and start-task commands do not grow with the Files list', () => {
  const m = manifest();
  const where = laneWhere(m, lane(m, 'alpha'));
  const one = task('T2', { files: ['src/f0.js'] });
  const many = task('T2', { files: Array.from({ length: 200 }, (_, i) => `src/f${i}.js`) });
  const checks = [one, many].map((x) => taskChecksCommand(m, x, where, H('b')));
  assert.ok(Math.abs(checks[0].length - checks[1].length) <= 2, `${checks[0].length} vs ${checks[1].length}`);
  const pkg = { pkg: { base: H('b'), head: H('h') } };
  const starts = [one, many].map((x) => startCommand(m, x, where, pkg));
  assert.ok(starts[1].includes('--declared-from-owners'), starts[1]);
  assert.ok(Math.abs(starts[0].length - starts[1].length) <= 2, `${starts[0].length} vs ${starts[1].length}`);
});

test('an e1a-sized unit\'s task-checks command is under 4,000 characters', () => {
  // A command of exactly n characters: its group, its number, then padding.
  const sized = (group, i, n) => { const head = `${group}-runner --step ${i} `; return head + 'x'.repeat(n - head.length); };
  const groups = ['test', 'lint', 'build'];
  const commands = { setup: [] };
  for (const g of groups) commands[g] = [0, 1, 2].map((i) => sized(g, i, 133));
  // PF-6: the entry sets test, lint and build itself, about 500 characters in all.
  const entry = {};
  for (const g of groups) entry[g] = [sized(`${g}-t`, 0, 166)];
  const files = Array.from({ length: 60 }, (_, i) => `src/Feature/Area${String(i).padStart(2, '0')}/` + 'y'.repeat(40) + '.cs');
  const m = manifest({ commands, task_checks: { T2: entry } });
  const cmd = taskChecksCommand(m, task('T2', { files }), laneWhere(m, lane(m, 'alpha')), H('b'));
  assert.ok(Object.values(commands).flat().join('').length >= 1150, 'about 1,200 characters of project commands');
  assert.ok(cmd.length < 4000, String(cmd.length));
  assert.ok(cmd.includes('--wide-as-lane'), cmd);
  assert.ok(cmd.includes(`--declared-from-owners '${fp(files)}'`), cmd);
});

test('--wide-as-lane only when the wide list equals the lane list', () => {
  const where = (m) => laneWhere(m, lane(m, 'alpha'));
  const plain = manifest();
  assert.ok(taskChecksCommand(plain, t(plain, 'T2'), where(plain), H('b')).includes('--wide-as-lane'));
  const own = manifest({ lane_commands: { alpha: { test: ['npm test -- alpha'] } } });
  const ownCmd = taskChecksCommand(own, t(own, 'T2'), where(own), H('b'));
  assert.ok(!ownCmd.includes('--wide-as-lane'), ownCmd);
  assert.ok(ownCmd.includes("--wide-cmd 'test' 'npm test' --wide-cmd 'lint' 'npm run lint' --wide-cmd 'test' 'npm test -- alpha'"),
    ownCmd);
  // A lane with its own setup widens to its own checks: the wide list is the lane list.
  const setup = manifest({ lane_commands: { alpha: { setup: ['uv sync'], test: ['pytest'] } } });
  const setupCmd = taskChecksCommand(setup, t(setup, 'T2'), where(setup), H('b'));
  assert.ok(setupCmd.includes('--wide-as-lane') && !setupCmd.includes('--wide-cmd'), setupCmd);
});

test('the engine\'s fingerprint matches the helpers\' for a unit', () => {
  const m = manifest();
  const unit = batchUnit([
    task('T2', { files: ['src/a.js', 'docs/caf\u00e9 menu.md'] }),
    task('T3', { files: ['docs/caf\u00e9 menu.md', "notes/it's \u{1d11e}.txt", 'src/a.js'] }),
  ]);
  const cmd = taskChecksCommand(m, unit, laneWhere(m, lane(m, 'alpha')), H('b'));
  assert.deepEqual(declaredFiles(unit), ['src/a.js', 'docs/caf\u00e9 menu.md', "notes/it's \u{1d11e}.txt"]);
  assert.equal(fpOf(cmd), pyFingerprint(declaredFiles(unit)));
  assert.equal(fpOf(cmd), fp(declaredFiles(unit)));
});

test('taskChecksLines tells the implementer to report blocked on an owners.json error', () => {
  const m = manifest();
  const text = flat(taskChecksLines(m, t(m, 'T2'), laneWhere(m, lane(m, 'alpha')), H('b')).join('\n'));
  assert.ok(text.includes('If the call fails with an error that names owners.json, report blocked with its message; '
    + 'do not run setup or pass --declared yourself.'), text);
});

const TMP = tempDir('pl-check-policy-');
after(() => rmSync(TMP, { recursive: true, force: true }));

function git(dir, ...args) {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: ENV });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim();
}

function python(script, ...args) {
  const res = spawnSync('python3', ['-B', join(SCRIPTS, script), ...args], { encoding: 'utf8', env: ENV });
  assert.equal(res.status, 0, `${script}: ${res.stderr}`);
  return res.stdout.trim();
}

const policyOf = (record) => { const { started, ...rest } = record.policy; return rest; };

test('the engine-built task-checks command gives the same policy on real git', () => {
  const dir = join(TMP, 'e2e', 'repo');
  const ledger = join(TMP, 'e2e', 'ledger');
  mkdirSync(ledger, { recursive: true });
  for (const f of ['src/a.js', 'src/b.js', 'docs/other.md']) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), '1\n');
  }
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  const unit = task('U1', { files: ['src/a.js', 'src/b.js'] });
  const m = manifest({
    repo: {
      mode: 'git', root: fwd(dir), git_dir: null, base_ref: 'main', branch: 'pl/run-1',
      worktree_root: fwd(join(TMP, 'e2e')), ledger_dir: fwd(ledger),
    },
    commands: { setup: [], test: ['node --version'], lint: ['node -v'], build: ['git --version'] },
    prelude: [],
    lanes: [{ id: 'alpha', name: 'Lane alpha', tasks: [unit] }],
    join: [],
    task_checks: { U1: { test: ['node --version'] } },
    widen_paths: [],
    skill_dir: fwd(SKILL_DIR),
  });
  // owners.json as setup writes it.
  const manifestFile = join(TMP, 'e2e', 'manifest.json');
  writeFileSync(manifestFile, JSON.stringify(m, null, 2));
  python('ledger', 'write-owners', fwd(ledger), manifestFile);
  // One declared file and one undeclared file change.
  writeFileSync(join(dir, 'src/a.js'), '2\n');
  writeFileSync(join(dir, 'docs/other.md'), '2\n');
  git(dir, 'commit', '-q', '-am', 'change');
  const head = git(dir, 'rev-parse', 'HEAD');
  const where = { dir: fwd(dir), branch: 'pl-run-1-alpha', lane: 'alpha' };
  const cmd = taskChecksCommand(m, unit, where, base);
  assert.ok(cmd.includes('--declared-from-owners') && cmd.includes('--wide-as-lane'), cmd);
  // The same call in the 1.6.5 form: the explicit list and the lane pairs.
  const old = cmd
    .split(`--declared-from-owners '${fpOf(cmd)}'`).join(unit.files.map((f) => `--declared ${shellQuote(f)}`).join(' '))
    .split('--wide-as-lane').join(laneChecks(m, 'alpha')
      .map((c) => `--wide-cmd ${shellQuote(c.group)} ${shellQuote(c.command)}`).join(' '));
  assert.ok(!old.includes('--declared-from-owners') && !old.includes('--wide-as-lane'), old);
  const records = [cmd, old].map((call) => {
    const file = python('await-checks', 'reserve', '--ledger', fwd(ledger), '--name', 'task-U1');
    const res = spawnSync(BASH, ['-c', call.split(resultPath()).join(shellQuote(file))], { encoding: 'utf8', env: ENV });
    assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
    return JSON.parse(readFileSync(file, 'utf8'));
  });
  assert.ok(!records[0].error, records[0].error);
  const outside = records.map((r) => r.policy.reasons.find((x) => x.code === 'outside_files'));
  assert.ok(outside[0], JSON.stringify(records[0].policy));
  assert.match(outside[0].detail, /docs\/other\.md/);
  assert.deepEqual(outside[0], outside[1]);
  assert.deepEqual(policyOf(records[0]), policyOf(records[1]));
  // The review's scope check uses the same fingerprint.
  const start = startCommand(m, unit, where, { pkg: { base, head } });
  const scope = start.match(/--scope '[^']+' '[^']+' --declared-from-owners '([^']+)' --owners /);
  assert.ok(scope, start);
  assert.equal(scope[1], fpOf(cmd));
});
