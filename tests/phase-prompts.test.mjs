// Phase prompts under the 1.6.0 check policy (spec 4.4-4.7): integration
// runs the delivery inventory once; the post-integration fixer on the
// test-failure path and the autonomous final fixer run focused checks only;
// verify can check that a repair head descends from where the repair
// started; the repair agent's prompt and schema; the re-review of repairs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadHelpers, H } from './harness.mjs';

const {
  integratePrompt, postIntegrateFixPrompt, finalFixPrompt, verifyPrompt, verifySchema, verifyRepairPrompt,
  repairSchema, finalReReviewPrompt, finalChecks, finalSetup, repairFixMessage, postIntegratePrompt,
} = await loadHelpers([
  'integratePrompt', 'postIntegrateFixPrompt', 'finalFixPrompt', 'verifyPrompt', 'verifySchema', 'verifyRepairPrompt',
  'repairSchema', 'finalReReviewPrompt', 'finalChecks', 'finalSetup', 'repairFixMessage', 'postIntegratePrompt',
]);

function task(id) {
  return { id, title: `Task ${id}`, files: [`src/${id}.js`], tier: 'standard', security: false };
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
      { id: 'alpha', name: 'Lane alpha', tasks: [task('T2')] },
      { id: 'beta', name: 'Lane beta', tasks: [task('T3')] },
    ],
    join: [task('T4')],
    hooks: {},
    limits: { review_rounds: 5, max_parallel_lanes: 3 },
    dry_run: false,
    done: [],
    reviewed: [],
    sp_dir: null,
    skill_dir: '/skills/parallel-lanes',
    ...overrides,
  };
}

const flat = (s) => s.replace(/\s+/g, ' ');
// The run-checks calls a prompt hands out, without the general long-command
// rule's template (its DIR, GROUP and COMMAND are placeholders).
const runChecksLines = (p) => p.split('\n')
  .filter((l) => l.includes("/scripts/run-checks' ") && !l.includes("--cmd 'GROUP' 'COMMAND'"));
const RESERVE = "'python3' '/skills/parallel-lanes/scripts/await-checks' reserve --ledger '/work/ledger' --name ";
const WAIT = "'python3' '/skills/parallel-lanes/scripts/await-checks' wait '<P>'";
const LOGS = "kept with the run's evidence. Read the log instead of rerunning a command, and leave the file in place.";
// The --cmd pairs of a run-checks line, in order.
function cmdPairs(line) {
  const out = [];
  const re = /--cmd '([^']*)' '((?:[^']|'\\'')*)'/g;
  let match;
  while ((match = re.exec(line)) !== null) out.push({ group: match[1], command: match[2].split("'\\''").join("'") });
  return out;
}

test('integration runs finalSetup and one run-checks over finalChecks', () => {
  const m = manifest({
    lane_commands: { alpha: { test: ['npm test -- alpha'], setup: ['npm ci -w alpha'] }, beta: { lint: [] } },
  });
  for (const opts of [{ conflictMode: 'abort' }, { testFailure: 'heal' }, {}]) {
    const p = integratePrompt(m, H('pre'), opts);
    const lines = runChecksLines(p);
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.deepEqual(cmdPairs(lines[0]), finalChecks(m));
    // The union of 1.5.2's blocks, each distinct pair once (checked by hand).
    assert.deepEqual(cmdPairs(lines[0]), [
      { group: 'test', command: 'npm test' }, { group: 'lint', command: 'npm run lint' },
      { group: 'test', command: 'npm test -- alpha' },
    ]);
    assert.ok(p.includes(finalSetup(m).join(' && ')), p);
    assert.deepEqual(finalSetup(m), ['npm ci', 'npm ci -w alpha']);
    assert.ok(!p.includes('Lane alpha commands') && !p.includes('Lane beta commands'), p);
    assert.ok(!p.includes('- every check at once'), p);
    assert.ok(flat(p).includes(LOGS), 'the log note is there');
  }
});

test('integration without lane_commands lists 1.5.2\'s commands', () => {
  const m = manifest();
  const p = integratePrompt(m, H('pre'));
  assert.deepEqual(cmdPairs(runChecksLines(p)[0]), [{ group: 'test', command: 'npm test' }, { group: 'lint', command: 'npm run lint' }]);
  assert.ok(p.includes('npm ci'));
});

test('task_checks does not change the integration prompt', () => {
  const m = manifest();
  const withChecks = manifest({ task_checks: { T2: { test: ['node --test t2'] } }, widen_paths: ['src/'] });
  assert.equal(integratePrompt(withChecks, H('pre')), integratePrompt(m, H('pre')));
});

test('integration heal, fail, step 4 and step 6 text is unchanged', () => {
  const m = manifest();
  const heal = flat(integratePrompt(m, H('pre'), { testFailure: 'heal' }));
  const plain = flat(integratePrompt(m, H('pre')));
  // Lines 1.5.2 produced, word for word.
  assert.ok(heal.includes('Fix only small, obvious integration breakage (commit it per the commit rules). If a project command '
    + 'still fails after that, return status done with the merges committed and tests_failed true (a later fix agent handles it); '
    + 'do not fail for a command failure.'), heal);
  assert.ok(plain.includes('Fix only small, obvious integration breakage (commit it per the commit rules); otherwise fail.'), plain);
  assert.ok(plain.includes(`4. History: ${H('pre')} is the feature tip after the prelude.`), plain);
  assert.ok(plain.includes('6. Only when steps 1-5 passed, clean up each lane:'), plain);
  assert.ok(heal.includes('6. Only when steps 1-5 passed and you return tests_failed false (every project command passes), clean up each lane.'), heal);
  assert.ok(plain.includes('3. In the tree step 1 found clean, rerun setup and then every check'), plain);
});

test('step 4 allows repair commits once every join task is done', () => {
  const m = manifest({ done: ['T4'], reviewed: ['T4'], backfill: { T4: { base: H('jb'), head: H('jh') } } });
  const p = flat(integratePrompt(m, H('pre')));
  assert.ok(p.includes(`final-fix commits from an earlier attempt of this run may follow the last join commit ${H('jh')}`), p);
  assert.ok(p.includes(repairFixMessage()), p);
  const notDone = flat(integratePrompt(manifest(), H('pre')));
  assert.ok(!notDone.includes(repairFixMessage()), notDone);
});

test('the post-integration fix is focused on the tests path and unchanged on the hook path', () => {
  const m = manifest();
  const hook = flat(postIntegrateFixPrompt(m, 'the hook failed'));
  assert.equal(postIntegrateFixPrompt(m, 'the hook failed', 'hook'), postIntegrateFixPrompt(m, 'the hook failed'));
  assert.ok(hook.includes('Rerun every project command afterwards and confirm they pass:'), hook);
  assert.ok(hook.includes('Return status done when the commands pass, otherwise failed'), hook);
  const tests = flat(postIntegrateFixPrompt(m, 'npm test failed', 'tests'));
  assert.ok(!tests.includes('Rerun every project command'), tests);
  assert.ok(tests.includes('run the focused tests that cover your change; do not run the full project commands: the '
    + 'integration rerun after you runs every command'), tests);
  assert.ok(tests.includes('Return status done when your fix is committed and the focused tests pass, otherwise failed'), tests);
});

test('the final fix is focused in autonomous runs and reruns everything in supervised ones', () => {
  const f = [{ id: 'F1', severity: 'important', file: 'src/a.js', line: 1, issue: 'x', fix: 'y' }];
  const auto = flat(finalFixPrompt(manifest(), f, H('tip')));
  assert.ok(!auto.includes('Rerun every project command'), auto);
  assert.ok(auto.includes('Run the focused checks that cover each fix; do not run the full project commands: verify runs '
    + 'every check at the delivered revision right after you, and a failure there goes to a repair agent.'), auto);
  const supervised = flat(finalFixPrompt(manifest({ autonomy: 'supervised' }), f, H('tip')));
  assert.ok(supervised.includes('Rerun every project command afterwards:'), supervised);
  assert.ok(supervised.includes('- every check at once'), supervised);
});

test('verify with from appends --descends-from and asks for descends_from', () => {
  const m = manifest();
  const plain = verifyPrompt(m, H('d1'));
  assert.ok(!plain.includes('--descends-from'), plain);
  assert.ok(!plain.includes('descends_from'), plain);
  const p = verifyPrompt(m, H('d1'), H('d0'));
  const line = runChecksLines(p)[0];
  assert.ok(line.endsWith(`--descends-from '${H('d0')}'`), line);
  assert.ok(line.includes("--out '<P>' --root '/work/ledger'"), line);
  assert.ok(flat(p).includes('untracked_before, untracked_after, descends_from'), p);
});

test('verifySchema accepts log and tail in results, and descends_from', () => {
  const s = verifySchema();
  const item = s.properties.results.items;
  assert.equal(item.properties.log.type, 'string');
  assert.equal(item.properties.tail.type, 'string');
  assert.deepEqual(item.required, ['group', 'command', 'exit']);
  assert.deepEqual(s.properties.descends_from.required, ['sha', 'ok']);
  assert.ok(!s.required.includes('descends_from'));
  // 1.6.1: tree_changed and stopped are optional.
  assert.deepEqual(s.properties.tree_changed, { type: 'boolean' });
  assert.deepEqual(s.properties.stopped, { type: 'string' });
  assert.ok(!s.required.includes('tree_changed') && !s.required.includes('stopped'));
});

// ---- 1.6.1: the long-check procedure in phase prompts (spec 4.1, 4.4)

test('integrate reserves integrate and keeps logs with the evidence', () => {
  const m = manifest();
  for (const opts of [{ conflictMode: 'abort' }, { testFailure: 'heal' }, {}]) {
    const p = integratePrompt(m, H('pre'), opts);
    const text = flat(p);
    const line = runChecksLines(p)[0];
    assert.ok(line.includes("--out '<P>' --root '/work/ledger'"), line);
    assert.ok(text.includes(`${RESERVE}'integrate'`), text);
    assert.ok(!text.includes(`${RESERVE}'integrate' --exact`), text);
    assert.ok(text.indexOf(`${RESERVE}'integrate'`) < text.indexOf(flat(line)), 'reserve before the start');
    assert.ok(text.indexOf(flat(line)) < text.indexOf(WAIT), 'the wait after the start');
    assert.ok(text.includes("run_in_background set to true"), text);
    assert.ok(text.includes(LOGS), text);
    assert.ok(!text.includes('temporary directory') && !text.includes('remove that directory'), text);
  }
});

test('verify reserves verify-<sha> with --exact and still writes under the ledger with --root', () => {
  const m = manifest();
  const p = verifyPrompt(m, H('d1'));
  const text = flat(p);
  const line = runChecksLines(p)[0];
  assert.equal(runChecksLines(p).length, 1);
  assert.ok(text.includes(`${RESERVE}'verify-${H('d1')}' --exact`), text);
  assert.ok(line.includes("--out '<P>' --root '/work/ledger'"), line);
  assert.ok(!line.includes('--descends-from'), line);
  assert.ok(text.includes('If reserve exits 4 with status busy'), text);
  assert.ok(text.includes(WAIT), text);
  // tree_changed when printed; what to return after a second stop.
  assert.ok(text.includes('tree_changed when run-checks printed true or false'), text);
  assert.ok(text.includes('After a second stop, do not start it again: return results [], ok false, clean = whether '
    + `git -C '/work/repo' status --porcelain --untracked-files=all prints nothing, empty tracked_before, tracked_after, `
    + 'untracked_before and untracked_after lists, head = the output of'), text);
  assert.ok(text.includes('and stopped naming both outcomes the wait printed'), text);
  // Checks that change the checkout run twice at most; verify then returns that JSON.
  assert.ok(text.includes('do not run the checks a third time; return the JSON of that rerun as the wait printed '
    + 'it, with tree_changed true.'), text);
});

test('the repair\'s verify (from set) also uses --exact and --descends-from', () => {
  const m = manifest();
  const p = verifyPrompt(m, H('r1'), H('f1'));
  const text = flat(p);
  const line = runChecksLines(p)[0];
  assert.ok(text.includes(`${RESERVE}'verify-${H('r1')}' --exact`), text);
  assert.ok(line.includes("--out '<P>' --root '/work/ledger'"), line);
  assert.ok(line.endsWith(`--descends-from '${H('f1')}'`), line);
});

test('post-integrate, post-integrate-fix (hook) and supervised final-fix use their reserve names', () => {
  const m = manifest({ hooks: { post_integrate: 'POST-HOOK' } });
  const f = [{ id: 'F1', severity: 'important', file: 'src/a.js', line: 1, issue: 'x', fix: 'y' }];
  const cases = {
    'post-integrate': postIntegratePrompt(m),
    'post-integrate-fix': postIntegrateFixPrompt(m, 'the hook failed', 'hook'),
    'final-fix': finalFixPrompt(manifest({ autonomy: 'supervised' }), f, H('tip')),
  };
  for (const [name, p] of Object.entries(cases)) {
    const text = flat(p);
    assert.ok(text.includes(`${RESERVE}'${name}'`), `${name}: ${text}`);
    assert.ok(!text.includes(`${RESERVE}'${name}' --exact`), name);
    const lines = runChecksLines(p);
    assert.equal(lines.length, 1, name);
    assert.ok(lines[0].includes("--out '<P>' --root '/work/ledger'"), lines[0]);
    assert.ok(text.includes('- every check at once'), name);
    assert.ok(text.includes(LOGS), name);
  }
});

test('the autonomous final fix and the tests-path post-integrate fixer get no every-check call', () => {
  const m = manifest();
  const f = [{ id: 'F1', severity: 'important', file: 'src/a.js', line: 1, issue: 'x', fix: 'y' }];
  for (const p of [finalFixPrompt(m, f, H('tip')), postIntegrateFixPrompt(m, 'npm test failed', 'tests')]) {
    assert.ok(!p.includes('- every check at once'), p);
    assert.equal(runChecksLines(p).length, 0, p);
    for (const name of ['final-fix', 'post-integrate-fix']) assert.ok(!p.includes(`${RESERVE}'${name}'`), name);
  }
});

test('the repair prompt names each failing command, its log and tail, and forbids weakening checks', () => {
  const m = manifest();
  const verify = {
    head: H('f1'), ok: false, results: [
      { group: 'test', command: 'npm test', exit: 1, log: '/work/ledger/checks/verify-x.1.log', tail: 'TAIL-ONE' },
      { group: 'lint', command: 'npm run lint', exit: 0, log: '/work/ledger/checks/verify-x.2.log', tail: 'clean' },
      { group: 'test', command: 'npm run e2e', exit: 2 },
    ],
  };
  const p = verifyRepairPrompt(m, verify, H('f1'), 1);
  const text = flat(p);
  assert.ok(text.includes('npm test (exit 1)') && text.includes('/work/ledger/checks/verify-x.1.log') && text.includes('TAIL-ONE'), p);
  assert.ok(!text.includes('npm run lint (exit 0)'), 'a passing check is not listed');
  assert.ok(text.includes('npm run e2e (exit 2)') && text.includes(`log: beside /work/ledger/checks/verify-${H('f1')}.json`), p);
  assert.ok(text.includes(`\`${repairFixMessage()}\``), p);
  assert.ok(/never weaken, skip or delete a check, test or acceptance criterion/i.test(text), p);
  assert.ok(text.includes('report blocked'), p);
  assert.ok(/timeout, crash or environment failure/.test(text), p);
  assert.ok(text.includes('/work/plan.md') && text.includes('/work/spec.md'), p);
  assert.ok(text.includes(`diff --shortstat '${H('f1')}' HEAD`), 'implementResultText counts from the repair start');
  const s = repairSchema();
  assert.deepEqual(s.required, ['status', 'head', 'tests', 'notes']);
  assert.deepEqual(s.properties.status.enum, ['done', 'blocked']);
});

test('the re-review lists repairs and handles no findings', () => {
  const m = manifest();
  const repairs = [{ attempt: 1, from: H('f1'), head: H('r1'), failed: ['npm test'] }];
  const p = flat(finalReReviewPrompt(m, H('tip'), H('r1'), [], null, repairs));
  assert.ok(p.includes('No findings are under verification: judge the repair commits in the range'), p);
  assert.ok(p.includes(`repair 1: ${H('f1')}..${H('r1')}`) && p.includes('npm test'), p);
  assert.ok(/judge the repair commits as fix code/i.test(p), p);
  const f = [{ id: 'F1', severity: 'important', file: 'src/a.js', line: 1, issue: 'x', fix: 'y', dispositions: [] }];
  const withFindings = flat(finalReReviewPrompt(m, H('tip'), H('r1'), f, null, repairs));
  assert.ok(withFindings.includes('[F1]') && withFindings.includes('repair 1:'), withFindings);
  const none = flat(finalReReviewPrompt(m, H('tip'), H('f1'), f));
  assert.ok(!none.includes('repair 1:'), none);
});

// ---- F2 review fixes (2026-10-11) ----

test('a repair problem has no id: the re-reviewer reports it in new_findings', () => {
  const m = manifest();
  const repairs = [{ attempt: 1, from: H('f1'), head: H('r1'), failed: ['npm test'], status: 'done', notes: 'fixed the parser' }];
  const p = flat(finalReReviewPrompt(m, H('tip'), H('r1'), [], null, repairs));
  assert.ok(p.includes('Repairs have no id: report any problem in a repair only in new_findings; a weakened, skipped '
    + 'or deleted check is at least important.'), p);
  assert.ok(p.includes('results = [] (no finding is under verification)'), p);
  assert.ok(!p.includes('For every id above'), p);
  assert.ok(!p.includes('one {id, status "resolved" or "open", evidence} per id above'), p);
  // Each repair entry carries its status, notes and evidence path, and the
  // criteria name work-arounds.
  assert.ok(p.includes('status done') && p.includes('fixed the parser'), p);
  assert.ok(p.includes(`/work/ledger/checks/verify-${H('f1')}.json`), p);
  assert.ok(/worked around a flaky, environment or out-of-scope failure/.test(p), p);
  assert.ok(p.includes('the failing checks it addressed') || p.includes('addressed'), p);
  // With findings and repairs, the per-id text stays and the repair rule is added.
  const f = [{ id: 'F1', severity: 'important', file: 'src/a.js', line: 1, issue: 'x', fix: 'y', dispositions: [] }];
  const both = flat(finalReReviewPrompt(m, H('tip'), H('r1'), f, null, repairs));
  assert.ok(both.includes('For every id above') && both.includes('Repairs have no id'), both);
});

test('the tests-path post-integration fixer may rerun the failing command to reproduce it', () => {
  const p = flat(postIntegrateFixPrompt(manifest(), 'npm test failed', 'tests'));
  assert.ok(p.includes('You may rerun the failing command named above to reproduce the failure.'), p);
});

test('the repair prompt forbids changing the commands or what they run, and names flaky failures', () => {
  const verify = { head: H('f1'), results: [{ group: 'test', command: 'npm test', exit: 1 }] };
  const p = flat(verifyRepairPrompt(manifest(), verify, H('f1'), 1));
  assert.ok(p.includes('never change the commands, lane_commands or task_checks, or the test runner configuration, to '
    + 'make them pass'), p);
  assert.ok(p.includes('Fixing a wrong test is allowed when the test, not the code, is wrong: say why in notes.'), p);
  assert.ok(/flaky, timeout, crash or environment failure/.test(p), p);
});

test('integration with no check commands says so in step 3', () => {
  const m = manifest({ commands: { setup: [], test: [], lint: [], build: [] } });
  const p = integratePrompt(m, H('pre'));
  assert.equal(runChecksLines(p).length, 0);
  assert.ok(p.includes('(no test, lint or build command)'), p);
});
