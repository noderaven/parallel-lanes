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
  repairFixMessage, procedureLines, reserveCommand, waitCommand, longCheckRuleLines, resultPath, agentRules,
  preflightPrompt, integratePrompt, resolveConflictsPrompt, postIntegrateFixPrompt, postIntegrateReReviewPrompt,
  postIntegratePrompt, e2ePrompt, finalReviewPrompt, combinedFinalReviewPrompt, finalFixPrompt, finalReReviewPrompt,
  verifyPrompt, verifyRepairPrompt, adjudicatorPrompt,
} = await loadHelpers([
  'implementPrompt', 'reviewPrompt', 'reReviewPrompt', 'fixPrompt', 'laneChecks', 'wideChecks', 'taskChecksCommand',
  'taskEvidenceLine', 'fixMessagesLines', 'fallbackImplementer', 'fallbackFixer', 'laneWhere', 'featureWhere',
  'batchUnit', 'repairFixMessage', 'procedureLines', 'reserveCommand', 'waitCommand', 'longCheckRuleLines',
  'resultPath', 'agentRules', 'preflightPrompt', 'integratePrompt', 'resolveConflictsPrompt', 'postIntegrateFixPrompt',
  'postIntegrateReReviewPrompt', 'postIntegratePrompt', 'e2ePrompt', 'finalReviewPrompt', 'combinedFinalReviewPrompt',
  'finalFixPrompt', 'finalReReviewPrompt', 'verifyPrompt', 'verifyRepairPrompt', 'adjudicatorPrompt',
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
  assert.ok(text.includes('Before you commit, run the task checks once, with the procedure below.'));
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
    + 'above (killed by a signal) is not a defect to fix'), p);
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
      assert.ok(p.includes(rule), name);
    }
  }
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
