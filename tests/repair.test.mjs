// The bounded repair loop after a failing verify (spec 4.5, 4.7) and the
// report's check records (spec 4.10). Engine-flow tests run the whole script
// with scripted agents, as tests/run.test.mjs does: an unscripted label
// throws, so an unexpected repair attempt fails the test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadHelpers, loadScript, H } from './harness.mjs';

const { repairDue, repairHeadEligible, validRepairReview, nonDefectFailure } = await loadHelpers([
  'repairDue', 'repairHeadEligible', 'validRepairReview', 'nonDefectFailure',
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
    commands: { setup: [], test: ['npm test'], lint: [], build: [] },
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
    setup_result: { feature_head: H('F0'), discarded: [], worktrees: { alpha: '/work/wt/lane-alpha', beta: '/work/wt/lane-beta' } },
    ...overrides,
  };
}

const ALL = ['T1', 'T2', 'T3', 'T4'];
const TIP = H('T4-h');

// The run-checks JSON at sha; from adds descends_from (ok unless given).
function verified(sha, exit = 0, extra = {}) {
  return {
    checkout: '/work/repo', branch: 'pl/run-1', head: sha,
    results: [{ group: 'test', command: 'npm test', exit, log: `/work/ledger/checks/verify-${sha}.1.log`, tail: `tail ${exit}` }],
    ok: exit === 0, clean: true, tracked_before: [], tracked_after: [], untracked_before: [], untracked_after: [], ...extra,
  };
}
const descends = (sha, from, exit = 0) => verified(sha, exit, { descends_from: { sha: from, ok: true } });
const repaired = (head, status = 'done') => ({ status, head, tests: 'npm test -- focused: pass', notes: '' });
const finding = (issue) => ({ severity: 'important', file: 'src/a.js', line: 3, issue, fix: 'fix it' });

function taskScript(ids) {
  const script = {};
  for (const id of ids) {
    script[`${id} implement`] = [{ status: 'done', base: `${id}-b`, head: H(`${id}-h`), tests: 'pass', notes: '' }];
    script[`${id} review`] = [{ verdict: 'approve', findings: [], cannot_verify: [] }];
  }
  return script;
}

// Final review with one finding (F1), fixed at f1.
function withFix(extra = {}) {
  return {
    'pre-flight': [{ conflicts: [], rulings: [], undeclared: [], code_deps: [] }],
    integrate: [{ status: 'done', head: H('I1'), notes: 'merged' }],
    'final review sp': [{ findings: [finding('bug')], cannot_verify: [], head: TIP }],
    'final review security': [{ findings: [], cannot_verify: [], head: TIP }],
    'final review correctness': [{ findings: [], cannot_verify: [], head: TIP }],
    'final fix': [{ status: 'done', head: H('f1'), tests: 'focused pass', notes: '', dispositions: [
      { id: 'F1', status: 'fixed', reason: 'fixed', evidence: 'src/a.js:3' }] }],
    ...extra,
  };
}

// Final review with no findings.
function noFindings(extra = {}) {
  const none = () => [{ findings: [], cannot_verify: [], head: TIP }];
  return {
    'pre-flight': [{ conflicts: [], rulings: [], undeclared: [], code_deps: [] }],
    integrate: [{ status: 'done', head: H('I1'), notes: 'merged' }],
    'final review sp': none(), 'final review security': none(), 'final review correctness': none(),
    ...extra,
  };
}

const resolved = (head) => ({ head, results: [{ id: 'F1', status: 'resolved', evidence: 'gone' }], new_findings: [] });

// Unscripted labels throw, except makeIo's availability probe after a dead
// pair: unless a test scripts it, it answers (the agents are available).
async function run(m, script) {
  const calls = [];
  const agent = async (prompt, opts) => {
    calls.push({ prompt, ...opts });
    const queue = script[opts.label];
    if (opts.label === 'availability probe' && !queue) return { ok: true };
    if (!queue || queue.length === 0) throw new Error(`unscripted agent call: ${opts.label}`);
    return queue.shift();
  };
  const parallel = (thunks) => Promise.all(thunks.map((t) => t().catch(() => null)));
  const result = await loadScript({ args: m, agent, parallel, phase: () => {}, log: () => {} });
  return { result, calls };
}

const labels = (calls) => calls.map((c) => c.label);
const kinds = (result) => result.acceptance.reasons.map((r) => r.kind);

// ---- 1.6.2: 75 and 124 start no repair and still fail (spec 4.3) ----

test('a verify failing only with 75 or 124 starts no repair and the run is rejected for failed checks', async () => {
  for (const exit of [75, 124]) {
    const { result, calls } = await run(manifest(), {
      ...withFix({
        verify: [verified(H('f1'), exit)],
        'final re-review': [resolved(H('f1'))],
      }),
      ...taskScript(ALL),
    });
    assert.ok(!labels(calls).some((l) => l.startsWith('verify repair')), `exit ${exit}: ${labels(calls)}`);
    assert.equal(result.acceptance.status, 'rejected', `exit ${exit}`);
    assert.ok(kinds(result).includes('checks_failed'), `exit ${exit}: ${kinds(result)}`);
    assert.deepEqual(result.final.repairs, [], `exit ${exit}`);
  }
});

// ---- after a final fix ----

test('fail, repair, pass, valid re-review: accepted', async () => {
  const { result, calls } = await run(manifest(), {
    ...withFix({
      verify: [verified(H('f1'), 1), descends(H('r1'), H('f1'))],
      'verify repair 1': [repaired(H('r1'))],
      'final re-review': [resolved(H('r1'))],
    }),
    ...taskScript(ALL),
  });
  assert.equal(result.acceptance.status, 'accepted', JSON.stringify(result.acceptance));
  assert.equal(result.delivered_sha, H('r1'));
  assert.equal(result.final.head, H('r1'));
  assert.equal(result.verify.head, H('r1'));
  assert.deepEqual(result.final.repairs.map((r) => [r.attempt, r.from, r.head, r.eligible, r.failed]),
    [[1, H('f1'), H('r1'), true, ['npm test']]]);
  const verifies = calls.filter((c) => c.label === 'verify');
  assert.ok(verifies[1].prompt.includes(`--descends-from '${H('f1')}'`), verifies[1].prompt);
  const repair = calls.find((c) => c.label === 'verify repair 1');
  assert.equal(repair.phase, 'Verify');
  assert.equal(repair.model, 'opus');
  const rr = calls.find((c) => c.label === 'final re-review').prompt;
  assert.ok(rr.includes(`${TIP}..${H('r1')}`) && rr.includes('repair 1:'), rr);
});

test('fail, fail, pass: accepted with two repairs', async () => {
  const { result } = await run(manifest(), {
    ...withFix({
      verify: [verified(H('f1'), 1), descends(H('r1'), H('f1'), 1), descends(H('r2'), H('r1'))],
      'verify repair 1': [repaired(H('r1'))],
      'verify repair 2': [repaired(H('r2'))],
      'final re-review': [resolved(H('r2'))],
    }),
    ...taskScript(ALL),
  });
  assert.equal(result.acceptance.status, 'accepted', JSON.stringify(result.acceptance));
  assert.deepEqual(result.final.repairs.map((r) => r.head), [H('r1'), H('r2')]);
  assert.equal(result.delivered_sha, H('r2'));
});

test('three failures: rejected checks_failed, two repairs, no third', async () => {
  const { result, calls } = await run(manifest(), {
    ...withFix({
      verify: [verified(H('f1'), 1), descends(H('r1'), H('f1'), 1), descends(H('r2'), H('r1'), 1)],
      'verify repair 1': [repaired(H('r1'))],
      'verify repair 2': [repaired(H('r2'))],
      'final re-review': [resolved(H('r2'))],
    }),
    ...taskScript(ALL),
  });
  assert.equal(result.acceptance.status, 'rejected');
  assert.deepEqual(kinds(result), ['checks_failed']);
  assert.equal(result.final.repairs.length, 2);
  assert.ok(!labels(calls).includes('verify repair 3'));
});

// ---- the repair agent's result ----

test('a repair without a new commit: no second verify; rejected', async () => {
  const { result, calls } = await run(manifest(), {
    ...withFix({
      verify: [verified(H('f1'), 1)],
      'verify repair 1': [repaired(H('f1'))],
      'final re-review': [resolved(H('f1'))],
    }),
    ...taskScript(ALL),
  });
  assert.equal(labels(calls).filter((l) => l === 'verify').length, 1);
  assert.equal(result.acceptance.status, 'rejected');
  assert.equal(result.final.repairs[0].eligible, false);
  assert.equal(result.delivered_sha, H('f1'));
});

test('a repair that commits and reports blocked: verified, then stops', async () => {
  const { result, calls } = await run(manifest(), {
    ...withFix({
      verify: [verified(H('f1'), 1), descends(H('r1'), H('f1'), 1)],
      'verify repair 1': [repaired(H('r1'), 'blocked')],
      'final re-review': [resolved(H('r1'))],
    }),
    ...taskScript(ALL),
  });
  assert.equal(labels(calls).filter((l) => l === 'verify').length, 2);
  assert.ok(!labels(calls).includes('verify repair 2'));
  assert.equal(result.delivered_sha, H('r1'));
  assert.equal(result.final.repairs[0].status, 'blocked');
  assert.equal(result.acceptance.status, 'rejected');
});

test('a non-descendant, a head mismatch or a non-sha head is ineligible: final_fix_unreviewed with the observed head', async () => {
  const cases = [
    ['not a descendant', verified(H('r1'), 0, { results: [], ok: false, descends_from: { sha: H('f1'), ok: false } }), H('r1'), H('r1')],
    ['head mismatch', verified(H('x9'), 0), H('r1'), H('x9')],
  ];
  for (const [name, second, reported, branchHead] of cases) {
    const { result } = await run(manifest(), {
      ...withFix({
        verify: [verified(H('f1'), 1), second],
        'verify repair 1': [repaired(reported)],
        'final re-review': [resolved(branchHead)],
      }),
      ...taskScript(ALL),
    });
    assert.notEqual(result.acceptance.status, 'accepted', name);
    assert.ok(kinds(result).includes('final_fix_unreviewed'), `${name}: ${JSON.stringify(result.acceptance)}`);
    assert.equal(result.final.repairs[0].observed_head, reported, name);
    assert.equal(result.final.repairs[0].eligible, false, name);
    assert.equal(result.final.head, branchHead, name);
  }
  const { result, calls } = await run(manifest(), {
    ...withFix({
      verify: [verified(H('f1'), 1)],
      'verify repair 1': [repaired('see below')],
      'final re-review': [resolved(H('f1'))],
    }),
    ...taskScript(ALL),
  });
  assert.equal(labels(calls).filter((l) => l === 'verify').length, 1);
  assert.ok(kinds(result).includes('final_fix_unreviewed'), JSON.stringify(result.acceptance));
  assert.equal(result.final.repairs[0].observed_head, 'see below');
});

test('a repair returning null is retried as the same attempt', async () => {
  const { result, calls } = await run(manifest(), {
    ...withFix({
      verify: [verified(H('f1'), 1), descends(H('r1'), H('f1'))],
      'verify repair 1': [null],
      'verify repair 1 retry': [repaired(H('r1'))],
      'final re-review': [resolved(H('r1'))],
    }),
    ...taskScript(ALL),
  });
  assert.ok(labels(calls).includes('verify repair 1 retry'));
  assert.equal(result.final.repairs.length, 1);
  assert.equal(result.acceptance.status, 'accepted', JSON.stringify(result.acceptance));
});

// ---- budget ----

// Agents of the fix path up to and including the first verify: pre-flight,
// 4 implement + 4 review, integrate, 3 lenses, final fix, verify.
const BEFORE_REPAIR = 15;

test('no reserve left: no repair, completed and rejected, nothing refused', async () => {
  const m = manifest({ limits: { review_rounds: 5, max_parallel_lanes: 3, max_agents: BEFORE_REPAIR + 5 } });
  const { result, calls } = await run(m, {
    ...withFix({ verify: [verified(H('f1'), 1)], 'final re-review': [resolved(H('f1'))] }),
    ...taskScript(ALL),
  });
  assert.equal(result.status, 'complete');
  assert.ok(!labels(calls).some((l) => l.startsWith('verify repair')));
  assert.deepEqual(kinds(result), ['checks_failed']);
  assert.deepEqual(result.final.repairs, []);
});

test('the reserve keeps the re-review affordable after every retry', async () => {
  // Exactly the reserve is left: the repair and its verify each need their
  // retry, and the re-review still runs.
  const m = manifest({ limits: { review_rounds: 5, max_parallel_lanes: 3, max_agents: BEFORE_REPAIR + 7 } });
  const { result, calls } = await run(m, {
    ...withFix({
      verify: [verified(H('f1'), 1), null],
      'verify retry': [descends(H('r1'), H('f1'))],
      'verify repair 1': [null],
      'verify repair 1 retry': [repaired(H('r1'))],
      'final re-review': [null],
      'final re-review retry': [resolved(H('r1'))],
    }),
    ...taskScript(ALL),
  });
  assert.equal(result.status, 'complete', JSON.stringify(result.reason));
  assert.ok(labels(calls).includes('final re-review retry'));
  assert.equal(result.acceptance.status, 'accepted', JSON.stringify(result.acceptance));
});

test('validRepairReview closes on every bad re-review result', () => {
  const r1 = H('r1');
  assert.equal(validRepairReview({ head: r1, results: [], new_findings: [] }, r1), null);
  for (const bad of [null, undefined, { __budget: true }, { head: H('zz'), results: [], new_findings: [] },
    { head: r1, results: [] }, { head: r1, new_findings: [] }, { head: r1, results: 'x', new_findings: [] }, 'x']) {
    assert.equal(typeof validRepairReview(bad, r1), 'string', JSON.stringify(bad));
  }
});

// ---- no repair due ----

test('a blocked, null or bad-head final fix: no repair', async () => {
  for (const fix of [{ status: 'blocked', head: TIP, tests: '', notes: 'stuck' }, null, { status: 'done', head: 'see below', tests: '', notes: '' }]) {
    const script = {
      ...withFix({ verify: [verified(H('f1'), 1)] }),
      ...taskScript(ALL),
    };
    script['final fix'] = [fix, fix === null ? null : undefined].filter((x) => x !== undefined);
    script['final fix retry'] = [null];
    script.verify = [verified(fix && fix.head && /^[0-9a-f]+$/.test(fix.head) ? fix.head : TIP, 1)];
    const { result, calls } = await run(manifest(), script);
    assert.ok(!labels(calls).some((l) => l.startsWith('verify repair')), JSON.stringify(fix));
    assert.notEqual(result.acceptance.status, 'accepted');
  }
});

test('repairDue: only a complete, clean, exact inventory with an ordinary failing exit', () => {
  const m = manifest();
  const sha = H('f1');
  assert.equal(repairDue(m, verified(sha, 1), sha), true);
  assert.equal(repairDue(m, verified(sha, 0), sha), false, 'nothing failed');
  assert.equal(repairDue(m, verified(H('x'), 1), sha), false, 'head mismatch');
  assert.equal(repairDue(m, { ...verified(sha, 1), results: undefined }, sha), false, 'no results');
  assert.equal(repairDue(m, null, sha), false, 'no result');
  assert.equal(repairDue(m, verified(sha, 1, { tracked_before: [' M src/a.js'] }), sha), false, 'unclean');
  assert.equal(repairDue(m, verified(sha, 1, { untracked_before: ['?? x.js'] }), sha), false, 'untracked before');
  assert.equal(repairDue(m, verified(sha, 1, { head_after: H('y') }), sha), false, 'head_after');
  const other = verified(sha, 1);
  other.results[0].command = 'npm run other';
  assert.equal(repairDue(m, other, sha), false, 'inventory mismatch');
  for (const exit of [75, 124, 128, 137, 255, -9]) assert.equal(repairDue(m, verified(sha, exit), sha), false, `exit ${exit}`);
  assert.equal(repairDue(m, verified(sha, 2), sha), true, 'exit 2');
  assert.equal(repairDue(m, verified(sha, 8), sha), true, 'exit 8');
});

// 1.6.2 (spec 4.3): one predicate for the exits that mark no defect.
test('nonDefectFailure: a failure made only of 75, 124, 128 and above, or negative exits', () => {
  const exits = (...codes) => codes.map((exit) => ({ group: 'test', command: `c${exit}`, exit }));
  for (const codes of [[75], [124], [137], [-9], [75, 124], [0, 75]]) {
    assert.equal(nonDefectFailure(exits(...codes)), true, JSON.stringify(codes));
  }
  for (const codes of [[1], [8], [1, 124], [0], []]) {
    assert.equal(nonDefectFailure(exits(...codes)), false, JSON.stringify(codes));
  }
  assert.equal(nonDefectFailure([{ exit: null }]), true, 'a non-number counts as non-defect');
});

test('repairDue: a mix of a real failure and a timeout is still due; 75 and 124 together are not', () => {
  const m = manifest({ commands: { setup: [], test: ['npm test'], lint: ['npm run lint'], build: [] } });
  const sha = H('f1');
  const two = (a, b) => ({
    ...verified(sha, a), ok: false, results: [
      { group: 'test', command: 'npm test', exit: a, log: '/work/ledger/checks/a.log', tail: '' },
      { group: 'lint', command: 'npm run lint', exit: b, log: '/work/ledger/checks/b.log', tail: '' },
    ],
  });
  assert.equal(repairDue(m, two(1, 124), sha), true, '1 and 124');
  assert.equal(repairDue(m, two(75, 124), sha), false, '75 and 124');
  assert.equal(repairDue(m, two(0, 75), sha), false, '0 and 75');
  assert.equal(repairDue(m, two(0, 8), sha), true, '0 and 8');
});

test('repairHeadEligible needs the reported head and a descends_from ok for the repair start', () => {
  const sha = H('r1');
  const from = H('f1');
  assert.equal(repairHeadEligible(descends(sha, from), sha, from), true);
  assert.equal(repairHeadEligible(verified(sha), sha, from), false, 'no descends_from');
  assert.equal(repairHeadEligible(verified(sha, 0, { descends_from: { sha: from, ok: false } }), sha, from), false);
  assert.equal(repairHeadEligible(descends(H('x'), from), sha, from), false, 'head mismatch');
  assert.equal(repairHeadEligible(descends(sha, sha), sha, from), false, 'descends_from names another sha');
  assert.equal(repairHeadEligible(null, sha, from), false);
});

// ---- F3 review fixes (2026-10-11) ----

const { repairReserve } = await loadHelpers(['repairReserve']);
const HOOKS = { post_integrate: 'POST: check contracts', e2e: 'E2E: run it' };

test('repairReserve counts the hook rechecks a repair makes necessary', () => {
  assert.equal(repairReserve(manifest()), 7);
  assert.equal(repairReserve(manifest({ hooks: { e2e: 'x' } })), 11);
  assert.equal(repairReserve(manifest({ hooks: { post_integrate: 'x' } })), 9);
  assert.equal(repairReserve(manifest({ hooks: HOOKS })), 13);
});

test('with hooks and only 6 free agents, no repair: the run completes rejected, never stops on budget', async () => {
  // Agents up to the failing verify with both hooks and no findings:
  // pre-flight, 4 implement + 4 review, integrate, post-integrate, e2e,
  // 3 lenses, verify = 16; 6 free is below the reserve of 13.
  const m = manifest({ hooks: HOOKS, limits: { review_rounds: 5, max_parallel_lanes: 3, max_agents: 22 } });
  const { result, calls } = await run(m, {
    ...noFindings({ verify: [verified(TIP, 1)] }),
    'post-integrate': [{ status: 'done', head: H('P1'), notes: 'ok' }],
    e2e: [{ head: TIP, items: [{ item: 'x', result: 'PASS', evidence: 'ok' }] }],
    'post-integrate recheck': [{ status: 'done', head: TIP, notes: 'ok' }],
    ...taskScript(ALL),
  });
  assert.equal(result.status, 'complete', JSON.stringify(result.reason));
  assert.ok(!labels(calls).some((l) => l.startsWith('verify repair')));
  assert.deepEqual(kinds(result), ['checks_failed']);
  assert.equal(result.check_policy.repair_reserve, 13);
});

test('a repair head whose verify returned nothing is unreviewed with its own sentence', async () => {
  const { result } = await run(manifest(), {
    ...withFix({
      verify: [verified(H('f1'), 1), null],
      'verify retry': [null],
      'verify repair 1': [repaired(H('r1'))],
      'final re-review': [resolved(H('r1'))],
    }),
    ...taskScript(ALL),
  });
  const reason = result.acceptance.reasons.find((r) => r.kind === 'final_fix_unreviewed');
  assert.ok(reason && reason.detail.includes(`no verify result at ${H('r1')}`), JSON.stringify(result.acceptance));
  assert.notEqual(result.acceptance.status, 'accepted');
});

test('a done final fix without a head gets no repair', async () => {
  const script = { ...withFix({ verify: [verified(TIP, 1)], 'final re-review': [resolved(TIP)] }), ...taskScript(ALL) };
  script['final fix'] = [{ status: 'done', head: '', tests: '', notes: '', dispositions: [
    { id: 'F1', status: 'fixed', reason: 'fixed', evidence: 'src/a.js:3' }] }];
  const { calls } = await run(manifest(), script);
  assert.ok(!labels(calls).some((l) => l.startsWith('verify repair')));
});

test('supervised with no findings: no repair, rejected as today', async () => {
  const { result, calls } = await run(manifest({ autonomy: 'supervised' }), {
    ...noFindings({ verify: [verified(TIP, 1)] }),
    ...taskScript(ALL),
  });
  assert.ok(!labels(calls).some((l) => l.startsWith('verify repair')));
  assert.deepEqual(kinds(result), ['checks_failed']);
});

// ---- no final findings ----

test('no findings: fail, repair, pass, then a final re-review', async () => {
  const valid = await run(manifest(), {
    ...noFindings({
      verify: [verified(TIP, 1), descends(H('r1'), TIP)],
      'verify repair 1': [repaired(H('r1'))],
      'final re-review': [{ head: H('r1'), results: [], new_findings: [] }],
    }),
    ...taskScript(ALL),
  });
  assert.equal(valid.result.acceptance.status, 'accepted', JSON.stringify(valid.result.acceptance));
  assert.equal(valid.result.delivered_sha, H('r1'));
  const rr = valid.calls.find((c) => c.label === 'final re-review');
  assert.ok(rr.prompt.includes(`${TIP}..${H('r1')}`) && rr.prompt.includes('No findings are under verification'), rr.prompt);
  const blocking = await run(manifest(), {
    ...noFindings({
      verify: [verified(TIP, 1), descends(H('r1'), TIP)],
      'verify repair 1': [repaired(H('r1'))],
      'final re-review': [{ head: H('r1'), results: [], new_findings: [finding('the repair deleted a test')] }],
    }),
    ...taskScript(ALL),
  });
  assert.equal(blocking.result.acceptance.status, 'rejected');
  assert.deepEqual(blocking.result.final.open.map((f) => f.id), ['N1']);
});

test('no findings: null, another head, or a malformed re-review gives final_fix_unreviewed', async () => {
  for (const [name, results] of [
    ['null', { 'final re-review': [null], 'final re-review retry': [null] }],
    ['another head', { 'final re-review': [{ head: TIP, results: [], new_findings: [] }] }],
    ['malformed', { 'final re-review': [{ head: H('r1'), results: [] }] }],
  ]) {
    const { result } = await run(manifest(), {
      ...noFindings({
        verify: [verified(TIP, 1), descends(H('r1'), TIP)],
        'verify repair 1': [repaired(H('r1'))],
        ...results,
      }),
      ...taskScript(ALL),
    });
    assert.notEqual(result.acceptance.status, 'accepted', name);
    assert.ok(kinds(result).includes('final_fix_unreviewed'), `${name}: ${JSON.stringify(result.acceptance)}`);
  }
});

// ---- delivered head ----

test('final.head, delivered_sha, verify.head, and the e2e and post-integrate rechecks name the repaired head', async () => {
  const hooks = { post_integrate: 'POST: check contracts', e2e: 'E2E: run it' };
  const r1 = H('r1');
  for (const [name, script] of [
    ['after a fix', withFix({
      verify: [verified(H('f1'), 1), descends(r1, H('f1'))],
      'verify repair 1': [repaired(r1)],
      'final re-review': [resolved(r1)],
    })],
    ['no findings', noFindings({
      verify: [verified(TIP, 1), descends(r1, TIP)],
      'verify repair 1': [repaired(r1)],
      'final re-review': [{ head: r1, results: [], new_findings: [] }],
    })],
  ]) {
    const { result } = await run(manifest({ hooks }), {
      ...script,
      'post-integrate': [{ status: 'done', head: H('P1'), notes: 'ok' }],
      e2e: [{ head: TIP, items: [{ item: 'x', result: 'PASS', evidence: 'ok' }] }],
      'e2e recheck': [{ head: r1, items: [{ item: 'x', result: 'PASS', evidence: 'ok' }] }],
      'post-integrate recheck': [{ status: 'done', head: r1, notes: 'ok' }],
      ...taskScript(ALL),
    });
    assert.equal(result.final.head, r1, name);
    assert.equal(result.delivered_sha, r1, name);
    assert.equal(result.verify.head, r1, name);
    assert.equal(result.e2e.checked_sha, r1, name);
    assert.equal(result.acceptance.status, 'accepted', `${name}: ${JSON.stringify(result.acceptance)}`);
  }
});

// ---- supervised and relaunches ----

test('supervised: no repair, rejected as today', async () => {
  const { result, calls } = await run(manifest({ autonomy: 'supervised' }), {
    ...withFix({ verify: [verified(H('f1'), 1)], 'final re-review': [resolved(H('f1'))] }),
    ...taskScript(ALL),
  });
  assert.ok(!labels(calls).some((l) => l.startsWith('verify repair')));
  assert.deepEqual(kinds(result), ['checks_failed']);
  assert.equal(result.check_policy.repair_limit, 0);
});

test('repairs_spent 1 allows one attempt; 2 allows none', async () => {
  const one = await run(manifest({ repairs_spent: 1 }), {
    ...withFix({
      verify: [verified(H('f1'), 1), descends(H('r1'), H('f1'), 1)],
      'verify repair 2': [repaired(H('r1'))],
      'final re-review': [resolved(H('r1'))],
    }),
    ...taskScript(ALL),
  });
  assert.deepEqual(one.result.final.repairs.map((r) => r.attempt), [2]);
  assert.equal(one.result.acceptance.status, 'rejected');
  const none = await run(manifest({ repairs_spent: 2 }), {
    ...withFix({ verify: [verified(H('f1'), 1)], 'final re-review': [resolved(H('f1'))] }),
    ...taskScript(ALL),
  });
  assert.ok(!labels(none.calls).some((l) => l.startsWith('verify repair')));
});

test('a resume after exhaustion runs no repair and reviews the branch afresh', async () => {
  const backfill = Object.fromEntries(ALL.map((id) => [id, { base: `${id}-b`, head: H(`${id}-h`) }]));
  const m = manifest({ done: ALL, reviewed: ALL, backfill, repairs_spent: 2 });
  const { result, calls } = await run(m, {
    ...noFindings({ verify: [verified(TIP, 1)] }),
  });
  assert.ok(labels(calls).includes('final review sp'), 'the lenses review the branch again');
  assert.ok(!labels(calls).some((l) => l.startsWith('verify repair')));
  assert.equal(result.acceptance.status, 'rejected');
});

// ---- reports ----

test('stopped reports carry final.repairs and check_policy', async () => {
  // No reserve and no room for the re-review: the run stops on budget.
  const m = manifest({ limits: { review_rounds: 5, max_parallel_lanes: 3, max_agents: BEFORE_REPAIR } });
  const { result } = await run(m, {
    ...withFix({ verify: [verified(H('f1'), 1)] }),
    ...taskScript(ALL),
  });
  assert.equal(result.status, 'stopped');
  assert.deepEqual(result.final.repairs, []);
  assert.deepEqual(result.check_policy, {
    task_checks: {}, widen_paths: [], repair_limit: 2, repairs_spent: 0, repair_reserve: 7,
    final_inventory_count: 1, autonomy: 'autonomous',
  });
});

test('setup_skipped and the check policy reach the report', async () => {
  const m = manifest({
    task_checks: { T2: { test: ['node --test t2'] } }, widen_paths: ['package.json'],
    done: ['T3'], reviewed: ['T3'], backfill: { T3: { base: 'T3-b', head: H('T3-h') } },
  });
  m.setup_result = { ...m.setup_result, setup_skipped: ['beta'] };
  const { result } = await run(m, {
    ...noFindings({ verify: [verified(TIP)] }),
    ...taskScript(['T1', 'T2', 'T4']),
  });
  assert.deepEqual(result.setup_skipped, ['beta']);
  assert.deepEqual(result.check_policy.task_checks, { T2: { test: ['node --test t2'] } });
  assert.deepEqual(result.check_policy.widen_paths, ['package.json']);
  assert.deepEqual(result.final.repairs, []);
  const plain = await run(manifest(), { ...noFindings({ verify: [verified(TIP)] }), ...taskScript(ALL) });
  assert.deepEqual(plain.result.setup_skipped, []);
});

// ---- 1.6.8: the start check after a failing verify (spec 4.4) ----

const { startCheckDue, classifyStartCheck } = await loadHelpers(['startCheckDue', 'classifyStartCheck']);

const SP = H('s');
const started = (overrides = {}) => manifest({ start_points: { prelude: SP }, ...overrides });
// One command's start-check entry for the verify command npm test.
const atStartOf = (exit, head, start, notRun = [], extra = {}) => ({
  verify_command: 'npm test', start_command: 'npm test -- -t slow', narrowed: true, exit_at_start: exit,
  failed_at_head: head, failed_at_start: start, not_run: notRun, ...extra,
});
const startResult = (results, extra = {}) => ({
  status: 'checked', start_sha: SP, evidence: '/work/ledger/checks/start.1.json', results, notes: '', ...extra,
});
const failsAtStart = () => startResult([atStartOf(1, ['slow test'], ['slow test'])]);
const passesAtStart = () => startResult([atStartOf(0, ['slow test'], [])]);
const partlyAtStart = () => startResult([atStartOf(1, ['slow test', 'new test'], ['slow test'])]);

test('a failing verify starts one start check before the first repair', async () => {
  const { result, calls } = await run(started(), {
    ...withFix({
      verify: [verified(H('f1'), 1), descends(H('r1'), H('f1'))],
      'start check': [passesAtStart()],
      'verify repair 1': [repaired(H('r1'))],
      'final re-review': [resolved(H('r1'))],
    }),
    ...taskScript(ALL),
  });
  const order = labels(calls).filter((l) => ['verify', 'start check', 'verify repair 1'].includes(l));
  assert.deepEqual(order, ['verify', 'start check', 'verify repair 1', 'verify']);
  const sc = calls.find((c) => c.label === 'start check');
  assert.equal(sc.phase, 'Verify');
  assert.equal(sc.model, 'sonnet');
  assert.equal(sc.effort, 'high');
  assert.equal(result.final.start_check.status, 'checked');
  assert.equal(result.final.start_check.verify_head, H('f1'));
  assert.deepEqual(result.final.start_check.commands.map((c) => c.at_start), ['passes']);
  assert.equal(result.acceptance.status, 'accepted', JSON.stringify(result.acceptance));
});

test('a start check runs at both verify sites', async () => {
  for (const [name, script, head] of [
    ['after a final fix', withFix({
      verify: [verified(H('f1'), 1), descends(H('r1'), H('f1'))],
      'verify repair 1': [repaired(H('r1'))],
      'final re-review': [resolved(H('r1'))],
    }), H('f1')],
    ['no final fix', noFindings({
      verify: [verified(TIP, 1), descends(H('r1'), TIP)],
      'verify repair 1': [repaired(H('r1'))],
      'final re-review': [{ head: H('r1'), results: [], new_findings: [] }],
    }), TIP],
  ]) {
    const { result, calls } = await run(started(), { ...script, 'start check': [passesAtStart()], ...taskScript(ALL) });
    const l = labels(calls);
    assert.equal(l.filter((x) => x === 'start check').length, 1, `${name}: ${l}`);
    assert.ok(l.indexOf('start check') < l.indexOf('verify repair 1'), `${name}: ${l}`);
    assert.equal(result.final.start_check.verify_head, head, name);
    const p = calls.find((c) => c.label === 'start check').prompt;
    assert.ok(p.includes(head) && p.includes(SP), name);
  }
});

test('no start check without start_points', async () => {
  const { result, calls } = await run(manifest(), {
    ...withFix({
      verify: [verified(H('f1'), 1), descends(H('r1'), H('f1'))],
      'verify repair 1': [repaired(H('r1'))],
      'final re-review': [resolved(H('r1'))],
    }),
    ...taskScript(ALL),
  });
  assert.ok(!labels(calls).includes('start check'));
  assert.ok(!('start_check' in result.final), JSON.stringify(result.final));
});

test('no start check when the start point is the head', async () => {
  const { result, calls } = await run(started({ start_points: { prelude: H('f1') } }), {
    ...withFix({
      verify: [verified(H('f1'), 1), descends(H('r1'), H('f1'))],
      'verify repair 1': [repaired(H('r1'))],
      'final re-review': [resolved(H('r1'))],
    }),
    ...taskScript(ALL),
  });
  assert.ok(!labels(calls).includes('start check'));
  assert.ok(!('start_check' in result.final));
  assert.equal(startCheckDue(started({ start_points: { prelude: H('f1') } }), verified(H('f1'), 1), H('f1')), false);
  assert.equal(startCheckDue(started(), verified(H('f1'), 1), H('f1')), true);
  assert.equal(startCheckDue(started({ start_points: { prelude: 'not a sha' } }), verified(H('f1'), 1), H('f1')), false);
  assert.equal(startCheckDue(started(), verified(H('f1'), 0), H('f1')), false, 'nothing failed');
});

test('no start check for a non-defect failure', async () => {
  for (const exit of [75, 124, 137]) {
    const { result, calls } = await run(started(), {
      ...withFix({ verify: [verified(H('f1'), exit)], 'final re-review': [resolved(H('f1'))] }),
      ...taskScript(ALL),
    });
    assert.ok(!labels(calls).includes('start check'), `exit ${exit}`);
    assert.ok(!('start_check' in result.final), `exit ${exit}`);
  }
});

test('no start check at the budget-stop verify', async () => {
  // Pre-flight, 4 implement + 4 review, integrate and 3 lenses spend 13: the
  // final fix is refused and the budget stop runs the checks at the tip.
  const m = started({ limits: { review_rounds: 5, max_parallel_lanes: 3, max_agents: 13 } });
  const { result, calls } = await run(m, { ...withFix({ verify: [verified(TIP, 1)] }), ...taskScript(ALL) });
  assert.equal(result.status, 'stopped');
  assert.ok(labels(calls).includes('verify'));
  assert.ok(!labels(calls).includes('start check'));
  assert.ok(!('start_check' in result.final));
});

test('a start check runs only once in a launch', async () => {
  const { result, calls } = await run(started(), {
    ...withFix({
      verify: [verified(H('f1'), 1), descends(H('r1'), H('f1'), 1), descends(H('r2'), H('r1'), 1)],
      'start check': [passesAtStart()],
      'verify repair 1': [repaired(H('r1'))],
      'verify repair 2': [repaired(H('r2'))],
      'final re-review': [resolved(H('r2'))],
    }),
    ...taskScript(ALL),
  });
  assert.equal(labels(calls).filter((l) => l === 'start check').length, 1);
  assert.equal(result.final.repairs.length, 2);
  assert.equal(result.final.start_check.verify_head, H('f1'));
});

test('every command fails at the start: no repair', async () => {
  for (const [name, script] of [
    ['after a final fix', withFix({ verify: [verified(H('f1'), 1)], 'final re-review': [resolved(H('f1'))] })],
    ['no final fix', noFindings({ verify: [verified(TIP, 1)] })],
  ]) {
    const { result, calls } = await run(started(), { ...script, 'start check': [failsAtStart()], ...taskScript(ALL) });
    assert.ok(!labels(calls).some((l) => l.startsWith('verify repair')), `${name}: ${labels(calls)}`);
    assert.deepEqual(result.final.repairs, [], name);
    assert.equal(result.final.start_check.all_fail, true, name);
    assert.equal(result.acceptance.status, 'rejected', name);
    assert.ok(kinds(result).includes('checks_failed_at_start'), `${name}: ${kinds(result)}`);
    assert.ok(!kinds(result).includes('checks_failed'), name);
  }
  // The final re-review gets the findings beside the failing verify.
  const { calls } = await run(started(), {
    ...withFix({ verify: [verified(H('f1'), 1)], 'final re-review': [resolved(H('f1'))] }),
    'start check': [failsAtStart()], ...taskScript(ALL),
  });
  const rr = calls.find((c) => c.label === 'final re-review').prompt;
  assert.ok(rr.includes(`fails at the start point ${SP} too`) && rr.includes('slow test'), rr);
});

test('partly: repairs run and their prompt names the tests', async () => {
  const { result, calls } = await run(started(), {
    ...withFix({
      verify: [verified(H('f1'), 1), descends(H('r1'), H('f1'))],
      'start check': [partlyAtStart()],
      'verify repair 1': [repaired(H('r1'))],
      'final re-review': [resolved(H('r1'))],
    }),
    ...taskScript(ALL),
  });
  assert.deepEqual(result.final.start_check.commands.map((c) => c.at_start), ['partly']);
  assert.equal(result.final.repairs.length, 1);
  const p = calls.find((c) => c.label === 'verify repair 1').prompt;
  assert.ok(p.includes('npm test: partly') && p.includes('slow test') && p.includes('new test'), p);
  assert.ok(p.includes(SP), p);
});

test('a supervised run gets the start check and no repair', async () => {
  for (const [name, script] of [
    ['after a final fix', withFix({ verify: [verified(H('f1'), 1)], 'final re-review': [resolved(H('f1'))] })],
    ['no final fix', noFindings({ verify: [verified(TIP, 1)] })],
  ]) {
    const { result, calls } = await run(started({ autonomy: 'supervised' }), {
      ...script, 'start check': [passesAtStart()], ...taskScript(ALL),
    });
    assert.ok(labels(calls).includes('start check'), name);
    assert.ok(!labels(calls).some((l) => l.startsWith('verify repair')), name);
    assert.deepEqual(kinds(result), ['checks_failed'], name);
  }
});

test('no room for the start check: unavailable and no call', async () => {
  // 13 agents up to the lenses, then verify (counted, past the cap): none left.
  const m = started({ limits: { review_rounds: 5, max_parallel_lanes: 3, max_agents: 14 } });
  const { result, calls } = await run(m, { ...noFindings({ verify: [verified(TIP, 1)] }), ...taskScript(ALL) });
  assert.equal(result.status, 'complete', JSON.stringify(result.reason));
  assert.ok(!labels(calls).includes('start check'));
  assert.equal(result.final.start_check.status, 'unavailable');
  assert.equal(result.final.start_check.why, 'budget');
  assert.equal(result.final.start_check.all_fail, false);
  assert.deepEqual(kinds(result), ['checks_failed']);
});

test('one agent left after a final fix: the re-review gets it, not the start check', async () => {
  // 13 agents up to the lenses, the final fix and its verify: one left.
  const m = started({ limits: { review_rounds: 5, max_parallel_lanes: 3, max_agents: 16 } });
  const { result, calls } = await run(m, {
    ...withFix({ verify: [verified(H('f1'), 1)], 'final re-review': [resolved(H('f1'))] }),
    'start check': [passesAtStart()], ...taskScript(ALL),
  });
  assert.equal(result.status, 'complete', JSON.stringify(result.reason));
  assert.ok(!labels(calls).includes('start check'), `${labels(calls)}`);
  assert.ok(labels(calls).includes('final re-review'), `${labels(calls)}`);
  assert.equal(result.final.start_check.status, 'unavailable');
  assert.equal(result.final.start_check.why, 'budget');
  assert.deepEqual(kinds(result), ['checks_failed']);
});

// The engine's guards (spec 4.4 "The engine classifies").
test('classifyStartCheck: each guard gives the expected at_start', () => {
  const m = started();
  const sha = H('f1');
  const v = verified(sha, 1);
  const at = (r) => classifyStartCheck(m, v, sha, r).commands.map((c) => c.at_start);
  assert.deepEqual(at(failsAtStart()), ['fails']);
  const good = classifyStartCheck(m, v, sha, failsAtStart());
  assert.deepEqual([good.status, good.all_fail, good.some_fail, good.start_sha, good.verify_head, good.evidence],
    ['checked', true, true, SP, sha, '/work/ledger/checks/start.1.json']);
  assert.deepEqual(at(failsAtStart()), ['fails']);
  assert.deepEqual(at({ ...failsAtStart(), start_sha: H('other') }), ['unknown'], 'start sha');
  for (const evidence of ['/work/ledger/checks/verify-x.json', '/elsewhere/checks/start.1.json',
    '/work/ledger/checks/start.json', '/work/ledger/checks/start.1.json.bak', '']) {
    assert.deepEqual(at({ ...failsAtStart(), evidence }), ['unknown'], `evidence ${evidence}`);
  }
  assert.deepEqual(at(passesAtStart()), ['passes'], 'exit 0');
  assert.deepEqual(at(startResult([atStartOf(0, ['slow test'], [], ['slow test'])])), ['unknown'], 'exit 0, not run');
  for (const exit of [126, 127, 124, 75, 137, -1, null]) {
    assert.deepEqual(at(startResult([atStartOf(exit, ['slow test'], ['slow test'])])), ['unknown'], `exit ${exit}`);
  }
  assert.deepEqual(at(startResult([atStartOf(1, ['slow test'], ['slow test'], ['other test'])])), ['unknown'], 'not_run');
  assert.deepEqual(at(partlyAtStart()), ['partly'], 'a head failure missing at the start');
  assert.deepEqual(at(startResult([atStartOf(1, ['slow test'], [])])), ['unknown'], 'none fails at the start');
  assert.deepEqual(at(startResult([atStartOf(1, [], [])])), ['unknown'], 'no test names');
  // Not checked: no command is classified.
  const notChecked = classifyStartCheck(m, v, sha, { ...failsAtStart(), status: 'unavailable' });
  assert.deepEqual([notChecked.status, notChecked.commands, notChecked.all_fail], ['unavailable', [], false]);
  // A wrong start sha or evidence path says why.
  assert.match(classifyStartCheck(m, v, sha, { ...failsAtStart(), start_sha: H('other') }).why, /start sha/);
  assert.match(classifyStartCheck(m, v, sha, { ...failsAtStart(), evidence: '/x/start.1.json' }).why, /evidence/);
  assert.ok(!('why' in good), 'a sound result has no why');
  // A failing command the agent left out is unknown, so not every one fails.
  const two = verified(sha, 1, { results: [...verified(sha, 1).results,
    { group: 'lint', command: 'npm run lint', exit: 2, log: '/work/ledger/checks/l.log', tail: '' }] });
  const m2 = started({ commands: { setup: [], test: ['npm test'], lint: ['npm run lint'], build: [] } });
  const partial = classifyStartCheck(m2, two, sha, failsAtStart());
  assert.deepEqual(partial.commands.map((c) => [c.verify_command, c.at_start]),
    [['npm test', 'fails'], ['npm run lint', 'unknown']]);
  assert.deepEqual([partial.all_fail, partial.some_fail], [false, true]);
  // A Windows ledger: backslashes and another drive-letter case still match.
  const win = started({ repo: { ...manifest().repo, ledger_dir: 'C:/Work/Ledger' } });
  const winPath = ['c:', 'work', 'ledger', 'checks', 'start.2.json'].join(String.fromCharCode(92));
  assert.deepEqual(classifyStartCheck(win, v, sha, { ...failsAtStart(), evidence: winPath }).commands
    .map((c) => c.at_start), ['fails']);
});

test('classifyStartCheck: a null or malformed result is unavailable', () => {
  const m = started();
  const sha = H('f1');
  for (const r of [null, undefined, 'x', { status: 'checked' }, { status: 'maybe', results: [] }, { __budget: true }]) {
    const c = classifyStartCheck(m, verified(sha, 1), sha, r);
    assert.equal(c.status, 'unavailable', JSON.stringify(r));
    assert.deepEqual([c.all_fail, c.some_fail, c.verify_head], [false, false, sha], JSON.stringify(r));
    assert.equal(typeof c.why, 'string', JSON.stringify(r));
  }
  const said = classifyStartCheck(m, verified(sha, 1), sha, { status: 'unavailable', start_sha: SP, evidence: '',
    results: [], notes: 'a folder is in the way' });
  assert.deepEqual([said.status, said.all_fail, said.notes], ['unavailable', false, 'a folder is in the way']);
});
