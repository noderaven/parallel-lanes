// scripts/_audit_run.py: the run-level sections of scripts/audit (launches,
// code outside the recorded task ranges, checks, acceptance, after delivery
// and open work), evidence validity and the derived verdict. check-verify is
// stubbed except where a test names the real one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SYMLINKS } from './platform.mjs';
import { loadHelpers } from './harness.mjs';
import { DEFAULT_PLAN, DEFAULT_RUN, LEDGER, commit, makeRepo, makeRun, pythonJSON } from './audit-helpers.mjs';

const { finalChecks } = await loadHelpers(['finalChecks']);

const D = 'd'.repeat(40);
const OTHER = 'e'.repeat(40);
const START = 1700000000000;

function verifyAt(head, extra = {}) {
  return {
    checkout: '/home/x/proj-wt/zqtail',
    branch: 'feat',
    head,
    results: [{ group: 'test', command: 'npm test zqcmd', exit: 0, log: '/tmp/zqtail/1.log', tail: 'ok zqtail' }],
    ok: true,
    clean: true,
    tracked_before: [],
    tracked_after: [],
    untracked_before: [],
    untracked_after: [],
    ...extra,
  };
}

function finalAt(head, extra = {}) {
  return {
    findings: [], fixed: [], declined: [], open: [], cannot_verify: [], missing_lenses: [], head,
    lens_heads: [{ lens: 'superpowers', head }, { lens: 'security', head }, { lens: 'correctness', head }],
    task_minors_open: [],
    ...extra,
  };
}

// An accepted, complete result at delivered.
function accepted(delivered, extra = {}) {
  return {
    version: '1.5.1',
    status: 'complete',
    run_id: 't1',
    tasks: { A1: { status: 'done', commits: null, notes: '' }, A2: { status: 'done', commits: null, notes: '' } },
    stopped_lanes: [],
    final: finalAt(delivered),
    verify: verifyAt(delivered),
    e2e: null,
    delivered_sha: delivered,
    acceptance: { status: 'accepted', delivered_sha: delivered, reasons: [], warnings: [] },
    ...extra,
  };
}

function launch(result, extra = {}) {
  return { wf: 'wf_aaaaaa', startTime: START, durationMs: 60000, result, journal: [], ...extra };
}

// run_sections over a run folder. opts: gate/reason/exit for the stub
// check-verify (real: true uses the default one), repo (opened unchecked),
// head, git_note.
function sections(folder, opts = {}) {
  const o = { gate: 'match', reason: null, exit: 0, repo: null, head: null, real: false, git_note: null, ...opts };
  return pythonJSON([
    'import _audit_core as c, _audit_git as g, _audit_run as r',
    'run = c.load_run(sys.argv[1])',
    'o = json.loads(sys.argv[2])',
    'git = g.open_repo(o["repo"], None)[0] if o["repo"] else None',
    'stub = lambda run, launch: {"status": o["gate"], "reason": o["reason"], "exit": o["exit"]}',
    'kw = {} if o["real"] else {"check_verify": stub}',
    'print(json.dumps(r.run_sections(run, git, head=o["head"], git_note=o["git_note"], **kw)))',
  ], [folder, JSON.stringify(o)]);
}

const python = (lines, args = []) => pythonJSON(['import _audit_core as c, _audit_run as r', ...lines], args);

test('derive_verdict covers every case', () => {
  const cases = [
    // [run_verdict, gate, evidence, override, delivered, order_known, expected]
    [null, 'match', 'valid', null, D, true, 'unavailable'],
    ['accepted', 'match', 'valid', null, D, false, 'unavailable'],
    ['rejected', 'match', 'invalid', { head: D, text: 'ok' }, D, true, 'accepted by user'],
    ['accepted', 'match', 'valid', null, D, true, 'accepted'],
    ['accepted', 'not_required', 'not_required', null, D, true, 'accepted'],
    ['accepted', 'unavailable', 'unavailable', null, D, true, 'accepted (gate unavailable)'],
    ['accepted', 'checker_error', 'unavailable', null, D, true, 'accepted (gate unavailable)'],
    ['accepted', 'missing', 'unavailable', null, D, true, 'unverified'],
    ['accepted', 'stale', 'unavailable', null, D, true, 'unverified'],
    ['accepted', 'mismatch', 'unavailable', null, D, true, 'unverified'],
    ['accepted', 'invalid', 'unavailable', null, D, true, 'unverified'],
    ['accepted', 'match', 'invalid', null, D, true, 'unverified'],
    // not_required claimed while checks are configured
    ['accepted', 'not_required', 'unavailable', null, D, true, 'unverified'],
    // not_required mismatches the other way: a match with nothing configured
    // and a match without the integrity lists fall through to the run verdict
    ['accepted', 'match', 'not_required', null, D, true, 'accepted'],
    ['accepted', 'match', 'unavailable', null, D, true, 'accepted'],
    ['rejected', 'match', 'valid', null, D, true, 'rejected'],
    ['unverified', 'missing', 'unavailable', null, D, true, 'unverified'],
    // an override at another head changes nothing
    ['rejected', 'match', 'invalid', [{ head: OTHER, text: 'old' }], D, true, 'rejected'],
    ['rejected', 'match', 'invalid', [{ head: OTHER, text: 'old' }, { head: D, text: 'new' }], D, true, 'accepted by user'],
  ];
  const out = python([
    'print(json.dumps([r.derive_verdict(*case[:6]) for case in json.loads(sys.argv[1])]))',
  ], [JSON.stringify(cases)]);
  cases.forEach((c, i) => assert.equal(out[i], c[6], JSON.stringify(c)));
});

test('expected_checks mirrors the engine finalChecks', () => {
  const lanes = [{ id: 'a', tasks: [] }, { id: 'b', tasks: [] }, { id: 'c', tasks: [] }];
  const manifests = [
    { commands: { setup: [], test: ['npm test'], lint: [], build: [] }, lanes,
      lane_commands: { a: { test: ['npm test', 'pytest -q'] }, b: { lint: ['ruff check .'] } } },
    { commands: { setup: [], test: ['npm test'], lint: ['eslint'], build: [] }, lanes,
      // an empty list overrides; the dict order is not the lane order
      lane_commands: { c: { build: ['make'] }, b: { lint: ['make'], test: ['npm test', 'go test ./...'] }, a: { test: [] } } },
    { commands: { setup: ['npm ci'], test: [], lint: [], build: [] }, lanes },
    { commands: { setup: [], test: ['t', 't'], lint: [], build: [] }, lanes, lane_commands: { z: { test: ['zz'] } } },
  ];
  const out = python(['print(json.dumps([r.expected_checks(m) for m in json.loads(sys.argv[1])]))'],
    [JSON.stringify(manifests)]);
  manifests.forEach((m, i) => {
    assert.deepEqual(out[i], finalChecks(m).map((x) => [x.group, x.command]), JSON.stringify(m));
  });
});

test('evidence validity names the rule', () => {
  const m = { commands: { test: ['npm test zqcmd'], lint: ['eslint .'], build: [] }, lanes: [] };
  const both = [{ group: 'test', command: 'npm test zqcmd', exit: 0 }, { group: 'lint', command: 'eslint .', exit: 0 }];
  const ok = verifyAt(D, { results: both });
  const noLists = { ...ok };
  delete noLists.untracked_before;
  const cases = [
    [m, ok, 'match', ['valid', null]],
    [{ commands: { test: [], lint: [], build: [] } }, null, 'not_required', ['not_required', null]],
    [m, ok, 'unavailable', ['unavailable', null]],
    [m, null, 'match', ['invalid', 'checks_missing']],
    [m, { ...ok, results: 'x' }, 'match', ['invalid', 'checks_missing']],
    [m, { ...ok, head: OTHER }, 'match', ['invalid', 'checks_stale']],
    [m, { ...ok, results: both.slice(0, 1) }, 'match', ['invalid', 'checks_incomplete']],
    [m, { ...ok, results: [both[1], both[0]] }, 'match', ['invalid', 'checks_incomplete']],
    [m, { ...ok, ok: false }, 'match', ['invalid', 'checks_failed']],
    [m, { ...ok, results: [both[0], { ...both[1], exit: 1 }] }, 'match', ['invalid', 'checks_failed']],
    [m, noLists, 'match', ['unavailable', 'integrity_not_recorded']],
    [m, { ...ok, tracked_after: [' M a.js'] }, 'match', ['invalid', 'checks_unclean']],
    [m, { ...ok, untracked_before: ['?? x'] }, 'match', ['invalid', 'checks_unclean']],
  ];
  const out = python(['print(json.dumps([r.evidence_validity(m, v, sys.argv[2], g) for m, v, g, _ in json.loads(sys.argv[1])]))'],
    [JSON.stringify(cases), D]);
  cases.forEach((c, i) => assert.deepEqual(out[i], c[3], JSON.stringify(c[1])));

  // Through run_sections: a match over bad evidence is unverified, the rule named.
  const bad = {
    checks_stale: verifyAt(OTHER),
    checks_failed: verifyAt(D, { ok: false, results: [{ group: 'test', command: 'npm test zqcmd', exit: 1 }] }),
    checks_incomplete: verifyAt(D, { results: [] }),
    checks_unclean: verifyAt(D, { tracked_after: [' M a.js'] }),
  };
  for (const [rule, verify] of Object.entries(bad)) {
    const s = sections(makeRun({ launches: [launch(accepted(D, { verify }))] }));
    assert.equal(s.facts.verdict, 'unverified', rule);
    assert.equal(s.facts.evidence, 'invalid', rule);
    assert.equal(s.facts.evidence_rule, rule, rule);
    assert.equal(s.checks.evidence.value, 'invalid', rule);
    assert.equal(s.checks.evidence.note, rule);
    assert.equal(s.acceptance.verdict.value, 'unverified');
    assert.equal(s.acceptance.verdict_rule, rule);
  }
  const unrecorded = verifyAt(D);
  delete unrecorded.untracked_before;
  const s = sections(makeRun({ launches: [launch(accepted(D, { verify: unrecorded }))] }));
  assert.equal(s.checks.evidence.value, 'unavailable');
  assert.equal(s.checks.evidence.state, 'unavailable');
  assert.equal(s.checks.evidence.note, 'integrity_not_recorded');
  assert.equal(s.facts.evidence_rule, 'integrity_not_recorded');
  // A match whose lists were not recorded falls through to the run verdict.
  assert.equal(s.facts.verdict, 'accepted');
  const good = sections(makeRun({ launches: [launch(accepted(D))] }));
  assert.equal(good.facts.verdict, 'accepted');
  assert.deepEqual(good.facts, {
    verdict: 'accepted', gate: 'match', evidence: 'valid', evidence_rule: null, verify_head: D, accepted_run: true,
    order_known: true,
  });
  assert.equal(good.checks.verify_head.state, 'present');
  const stale = sections(makeRun({ launches: [launch(accepted(D, { verify: verifyAt(OTHER) }))] }));
  assert.equal(stale.checks.verify_head.state, 'stale');
});

// A repo with two commits before the run (p1, p2), the task commits a1 and
// a2, an integration commit (merge) and a final fix (fix); the run starts at
// p2, A1 is p2..a1 and A2 a1..a2.
function fixtureRepo() {
  const { dir, shas } = makeRepo(2);
  const [p1, p2] = shas;
  const a1 = commit(dir, 'a1.txt');
  const a2 = commit(dir, 'a2.txt');
  const merge = commit(dir, 'merge.txt');
  const fix = commit(dir, 'fix.txt');
  return { dir, p1, p2, a1, a2, merge, fix };
}

function rangedLedger(r, { started = true } = {}) {
  return {
    '_run.jsonl': started ? [{ task: '_run', event: 'run_started', phase: 'setup', head: r.p2, plan_sha256: null, spec_sha256: null }] : [],
    'a.jsonl': [
      { task: 'A1', event: 'committed', commits: [r.a1], base: r.p2, head: r.a1 },
      { task: 'A2', event: 'committed', commits: [r.a2], base: r.a1, head: r.a2 },
    ],
  };
}

function coverage(s) {
  return Object.fromEntries(s.code_outside_ranges.value.commits.map((e) => [e.commit, e.coverage]));
}

test('the final re-review covers the final fix', () => {
  const r = fixtureRepo();
  const final = finalAt(r.fix, { lens_heads: [{ lens: 'superpowers', head: r.merge }, { lens: 'security', head: r.merge }] });
  const run = (result, extra = {}) => sections(makeRun({ ledger: rangedLedger(r), launches: [launch(result, extra.launch)], ...extra.run }),
    { repo: r.dir });

  // A recorded re-review head.
  let s = run(accepted(r.fix, { final }), { launch: { journal: [{ label: 'final re-review', result: { head: r.fix, results: [], new_findings: [] } }] } });
  let cov = coverage(s);
  assert.deepEqual(Object.keys(cov), [r.merge, r.fix]);
  assert.equal(cov[r.merge].state, 'present');
  assert.equal(cov[r.merge].value, 'final review');
  // A lane merge a lens head contains names that head.
  assert.equal(cov[r.merge].note, `contained in the final review's head ${r.merge.slice(0, 7)}`);
  assert.equal(cov[r.fix].state, 'inferred');
  assert.equal(cov[r.fix].note, undefined);
  assert.equal(cov[r.fix].value, 'final re-review');
  assert.deepEqual(cov[r.fix].sources, [{ path: 'transcript:wf_aaaaaa/final re-review', at: null }]);

  // Without it, on engine 1.4.2 with no unreviewed_fix.
  s = run(accepted(r.fix, { final, version: '1.4.2' }));
  cov = coverage(s);
  assert.equal(cov[r.fix].state, 'inferred');
  assert.equal(cov[r.fix].value, 'final re-review (no recorded head)');
  // The archived report's engine_version when the result has none.
  const noVersion = accepted(r.fix, { final });
  delete noVersion.version;
  s = run(noVersion, { run: { files: { 'p.t1.report.json': JSON.stringify({ engine_version: '1.4.2' }) } } });
  assert.equal(coverage(s)[r.fix].value, 'final re-review (no recorded head)');

  // An engine older than 1.2.1, or an unknown version.
  for (const result of [accepted(r.fix, { final, version: '1.2.0' }), accepted(r.fix, { final, version: 'dev' }), noVersion]) {
    cov = coverage(run(result));
    assert.equal(cov[r.fix].state, 'missing', result.version);
    assert.equal(cov[r.fix].value, 'no review evidence');
  }

  // unreviewed_fix set: missing and quoted, commands replaced.
  const text = `the final fix ${r.merge}..${r.fix} was not re-reviewed: npm test zqcmd zqreason`;
  s = run(accepted(r.fix, { final: { ...final, unreviewed_fix: text }, version: '1.4.2' }));
  const entry = s.code_outside_ranges.value.commits.find((e) => e.commit === r.fix);
  assert.equal(entry.coverage.state, 'missing');
  assert.equal(entry.unreviewed_fix.quote, `the final fix ${r.merge}..${r.fix} was not re-reviewed: <check:test#1> zqreason`);
  assert.equal(entry.unreviewed_fix.commands_replaced, true);
  assert.doesNotMatch(JSON.stringify(s), /zqcmd/);
});

test('a repair commit counts as reviewed only through a valid final re-review', () => {
  // fix is the repair commit past the lenses' head (merge), delivered by a
  // 1.6.0 run whose final re-review judged it.
  const r = fixtureRepo();
  const final = finalAt(r.fix, { lens_heads: [{ lens: 'superpowers', head: r.merge }] });
  const unreviewed = `the repair reported ${r.fix}, which was not re-reviewed`;
  const covered = (rr, fix = null) => {
    const result = accepted(r.fix, { version: '1.6.0', final: fix ? { ...final, unreviewed_fix: fix } : final });
    const s = sections(makeRun({ ledger: rangedLedger(r), launches: [launch(result, { journal: [{ label: 'final re-review', result: rr }] })] }),
      { repo: r.dir });
    return coverage(s)[r.fix];
  };
  const valid = covered({ head: r.fix, results: [], new_findings: [] });
  assert.deepEqual([valid.value, valid.state], ['final re-review', 'inferred']);
  assert.deepEqual(valid.sources, [{ path: 'transcript:wf_aaaaaa/final re-review', at: null }]);
  // Anything else gives no coverage: the commit falls through to
  // final.unreviewed_fix (which the engine sets then) or to no evidence.
  const invalid = {
    null: null,
    'another head': { head: r.merge, results: [], new_findings: [] },
    'no results': { head: r.fix, new_findings: [] },
    'no new_findings': { head: r.fix, results: [] },
    'results not a list': { head: r.fix, results: 'none', new_findings: [] },
    'not an object': [r.fix],
  };
  for (const [name, rr] of Object.entries(invalid)) {
    const cov = covered(rr, unreviewed);
    assert.deepEqual([cov.value, cov.state], ['final.unreviewed_fix', 'missing'], name);
  }
  for (const name of ['another head', 'no results', 'no new_findings', 'results not a list']) {
    const cov = covered(invalid[name]);
    assert.deepEqual([cov.value, cov.state], ['no review evidence', 'missing'], name);
  }
});

test('lens heads fall back to structured results', () => {
  const r = fixtureRepo();
  const final = finalAt(r.fix, { lens_heads: null });
  for (const label of ['final review sp', 'final review']) {
    const s = sections(makeRun({
      ledger: rangedLedger(r),
      launches: [launch(accepted(r.fix, { final }), { journal: [{ label, result: { head: r.merge, findings: [] } }] })],
    }), { repo: r.dir });
    const cov = coverage(s);
    assert.equal(cov[r.merge].state, 'present', label);
    assert.equal(cov[r.merge].value, 'final review');
    assert.equal(cov[r.merge].note, `contained in the final review's head ${r.merge.slice(0, 7)}`, label);
    assert.ok(cov[r.merge].sources.some((x) => x.path === `transcript:wf_aaaaaa/${label}`));
  }
});

test('the range stops at the start point', () => {
  const r = fixtureRepo();
  const result = accepted(r.fix, { final: finalAt(r.fix, { lens_heads: [{ lens: 'superpowers', head: r.fix }] }) });
  for (const started of [true, false]) {
    const s = sections(makeRun({ ledger: rangedLedger(r, { started }), launches: [launch(result)] }), { repo: r.dir });
    assert.equal(s.code_outside_ranges.state, 'present');
    assert.equal(s.code_outside_ranges.value.start_point, r.p2);
    // p1 and p2 lie before the start; a1 and a2 are task ranges.
    assert.deepEqual(s.code_outside_ranges.value.commits.map((e) => e.commit), [r.merge, r.fix]);
    assert.ok(s.code_outside_ranges.value.commits.every((e) => e.coverage.state === 'present'));
  }
  // Legacy commits (no base) are task ranges too.
  const legacy = {
    '_run.jsonl': [{ task: '_run', event: 'run_started', phase: 'setup', head: r.p2 }],
    'a.jsonl': [{ task: 'A1', event: 'committed', commits: [r.a1] }, { task: 'A2', event: 'committed', commits: [r.a2.slice(0, 12)] }],
  };
  const s = sections(makeRun({ ledger: legacy, launches: [launch(result)] }), { repo: r.dir });
  assert.deepEqual(s.code_outside_ranges.value.commits.map((e) => e.commit), [r.merge, r.fix]);
});

test('no start point is unavailable', () => {
  const r = fixtureRepo();
  const legacy = { 'a.jsonl': [{ task: 'A1', event: 'committed', commits: [r.a1] }] };
  const s = sections(makeRun({ ledger: legacy, launches: [launch(accepted(r.fix))] }), { repo: r.dir });
  assert.equal(s.code_outside_ranges.state, 'unavailable');
  assert.equal(s.code_outside_ranges.note, 'no start point recorded');
  // Without a repo, and with a refusal reason passed through.
  const folder = makeRun({ ledger: rangedLedger(r), launches: [launch(accepted(r.fix))] });
  assert.equal(sections(folder).code_outside_ranges.note, 'no --repo');
  const noted = sections(folder, { head: 'main', git_note: 'the repo does not contain abc1234' });
  assert.equal(noted.code_outside_ranges.note, 'the repo does not contain abc1234');
  assert.equal(noted.after_delivery.state, 'unavailable');
  assert.equal(noted.after_delivery.note, 'the repo does not contain abc1234');
  // A delivered_sha that is not a full sha.
  const short = sections(makeRun({ ledger: rangedLedger(r), launches: [launch(accepted(r.fix.slice(0, 12)))] }), { repo: r.dir });
  assert.equal(short.code_outside_ranges.state, 'unavailable');
});

test('after delivery lists the commits past delivered_sha', () => {
  const r = fixtureRepo();
  const folder = makeRun({ ledger: rangedLedger(r), launches: [launch(accepted(r.merge))] });
  assert.equal(sections(folder, { repo: r.dir }).after_delivery, null);
  const s = sections(folder, { repo: r.dir, head: 'main' });
  assert.equal(s.after_delivery.state, 'unavailable');
  assert.equal(s.after_delivery.note, 'no run evidence');
  assert.deepEqual(s.after_delivery.value.commits, [r.fix]);
  // No commits after the delivered sha: nothing lacks run evidence.
  const tip = sections(makeRun({ ledger: rangedLedger(r), launches: [launch(accepted(r.fix))] }), { repo: r.dir, head: 'main' });
  assert.deepEqual([tip.after_delivery.state, tip.after_delivery.note], ['present', 'no commits after the delivered sha']);
  assert.deepEqual(tip.after_delivery.value.commits, []);
});

test('a failing ledger status is named, and its open work is a gap', () => {
  const r = fixtureRepo();
  const ledger = rangedLedger(r);
  ledger['a.jsonl'].push({ task: 'A2', event: 'blocked', reason: 'stuck' }, 'not json');
  const s = sections(makeRun({ ledger, launches: [launch(accepted(r.fix))] }), { repo: r.dir });
  assert.equal(s.code_outside_ranges.state, 'unavailable');
  assert.match(s.code_outside_ranges.note, /^ledger status exited [1-9]/);
  assert.equal(s.open_work.ledger_state.state, 'unavailable');
  assert.match(s.open_work.ledger_state.note, /blocked and deferred tasks are unknown: ledger status exited [1-9]/);
  // A ledger status that works leaves ledger_state null.
  const ok = sections(makeRun({ ledger: rangedLedger(r), launches: [launch(accepted(r.fix))] }), { repo: r.dir });
  assert.equal(ok.open_work.ledger_state, null);
});

test('launch order unknown makes the verdict unavailable', () => {
  const folder = makeRun({
    launches: [launch(accepted(D)), launch(accepted(D), { wf: 'wf_bbbbbb', startTime: undefined })],
  });
  const s = sections(folder);
  assert.equal(s.facts.verdict, 'unavailable');
  assert.equal(s.facts.order_known, false);
  assert.equal(s.facts.verify_head, null);
  assert.equal(s.facts.accepted_run, false);
  assert.equal(s.acceptance.verdict.state, 'unavailable');
  assert.equal(s.acceptance.verdict.note, 'launch order unknown');
  assert.equal(s.checks.gate.value, 'unavailable');
  assert.deepEqual(s.launches.entries.value.map((l) => l.wf), ['wf_aaaaaa', 'wf_bbbbbb']);
});

test('launches list layout gaps; no launch is unavailable', () => {
  const s = sections(makeRun({
    launches: [
      launch(accepted(D), { agents: [{ label: 'A1 implement', lines: [] }] }),
      launch(accepted(D), { wf: 'wf_dirless', startTime: START + 1000, dirless: true }),
      launch({ ...accepted(D), status: 'stopped', reason: 'budget zqreason' }, { wf: 'wf_bad.name', startTime: START + 2000 }),
    ],
    files: { 'wf_noresult/journal.jsonl': '' },
  }));
  const byWf = Object.fromEntries(s.launches.entries.value.map((l) => [l.wf, l]));
  assert.equal(byWf.wf_aaaaaa.has_transcripts, true);
  assert.deepEqual(byWf.wf_aaaaaa.layout, []);
  assert.equal(byWf.wf_aaaaaa.status.value, 'complete');
  assert.equal(byWf.wf_dirless.dirless, true);
  assert.deepEqual(byWf.wf_dirless.layout.map((g) => g.state), ['unavailable']);
  assert.equal(byWf['wf_bad.name'].reason.quote, 'budget zqreason');
  assert.ok(byWf['wf_bad.name'].layout.some((g) => /does not match/.test(g.note)));
  assert.equal(byWf.wf_noresult.status.state, 'unavailable');
  assert.ok(byWf.wf_noresult.layout.some((g) => g.state === 'missing' && g.value === 'wf_noresult.json'));
  const none = sections(makeRun({}));
  assert.equal(none.launches.entries.state, 'unavailable');
  assert.equal(none.facts.verdict, 'unavailable');
});

const ENDED = { task: '_run', event: 'run_ended', status: 'complete', agents: 3, rulings: 0 };
const MISSING_NOTE = 'the ledger records this launch; its transcripts are not archived';
const LEDGER_SRC = [{ path: LEDGER, at: null }];
// _audit.build's gaps and gap_causes.
const built = (folder) => pythonJSON([
  'import _audit',
  'a = _audit.build(sys.argv[1])',
  'print(json.dumps({"gaps": a["gaps"], "causes": a["gap_causes"]}))',
], [folder]);
const auditGaps = (folder) => built(folder).gaps;

test('two recorded launches and one archived give one missing gap', () => {
  const folder = makeRun({ ledger: { '_run.jsonl': [ENDED, ENDED] }, launches: [launch(accepted(D))] });
  const s = sections(folder);
  assert.deepEqual(s.launches.recorded,
    { value: { recorded: 2, archived: 1, named: [] }, state: 'present', sources: LEDGER_SRC });
  assert.deepEqual(s.launches.missing, [{ value: null, state: 'missing', sources: LEDGER_SRC, note: MISSING_NOTE }]);
  const gaps = auditGaps(folder).filter((g) => g.where.startsWith('#/run/launches/missing'));
  assert.deepEqual(gaps, [{ where: '#/run/launches/missing/0', state: 'missing', value: null, note: MISSING_NOTE }]);
  // Equal counts add no gap.
  const equal = makeRun({ ledger: { '_run.jsonl': [ENDED] }, launches: [launch(accepted(D))] });
  const e = sections(equal);
  assert.deepEqual(e.launches.recorded.value, { recorded: 1, archived: 1, named: [] });
  assert.deepEqual(e.launches.missing, []);
  assert.deepEqual(auditGaps(equal).filter((g) => g.where.startsWith('#/run/launches/missing')), []);
  // Without a ledger the recorded count is unavailable and nothing is missing.
  const none = sections(makeRun({ ledger: null, launches: [launch(accepted(D))] }));
  assert.deepEqual([none.launches.recorded.state, none.launches.recorded.note], ['unavailable', 'no ledger in the archive']);
  assert.deepEqual(none.launches.missing, []);
  // Three unnamed missing launches: three gaps, one cause keeping all three
  // values, never merged into one.
  const three = built(makeRun({ ledger: { '_run.jsonl': [ENDED, ENDED, ENDED, ENDED] }, launches: [launch(accepted(D))] }));
  assert.equal(three.gaps.filter((g) => g.where.startsWith('#/run/launches/missing')).length, 3);
  assert.deepEqual(three.causes.filter((g) => g.pointer.startsWith('#/run/launches/missing')),
    [{ pointer: '#/run/launches/missing/N', state: 'missing', note: MISSING_NOTE, tasks: null, values: [null, null, null] }]);
});

test('named missing launches are listed by wf id', () => {
  const carried = (wf) => ({ task: '_run', event: 'carried', wf, rulings: 0 });
  const folder = makeRun({
    ledger: { '_run.jsonl': [ENDED, carried('wf_aaaaaa'), ENDED, carried('wf_bbbbbb'), ENDED, ENDED] },
    launches: [launch(accepted(D))],
    files: { [`${LEDGER}/doctor-wf_cccccc.json`]: '{}\n' },
  });
  const s = sections(folder);
  assert.deepEqual(s.launches.recorded.value,
    { recorded: 4, archived: 1, named: ['wf_aaaaaa', 'wf_bbbbbb', 'wf_cccccc'] });
  // Named ones first, then one unnamed launch.
  assert.deepEqual(s.launches.missing.map((g) => [g.value, g.state, g.note]),
    [['wf_bbbbbb', 'missing', MISSING_NOTE], ['wf_cccccc', 'missing', MISSING_NOTE], [null, 'missing', MISSING_NOTE]]);
  const b = built(folder);
  assert.deepEqual(b.gaps.filter((g) => g.where.startsWith('#/run/launches/missing')).map((g) => g.where),
    ['#/run/launches/missing/0', '#/run/launches/missing/1', '#/run/launches/missing/2']);
  // One run-level cause whose values keep the wf ids, in order.
  assert.deepEqual(b.causes.filter((g) => g.pointer.startsWith('#/run/launches/missing')),
    [{ pointer: '#/run/launches/missing/N', state: 'missing', note: MISSING_NOTE, tasks: null,
      values: ['wf_bbbbbb', 'wf_cccccc', null] }]);
});

test('the plan and spec hashes are run checks, one per setup event with its ledger line', () => {
  const sha256 = (text) => createHash('sha256').update(text).digest('hex');
  const [planSha, specSha] = [sha256(DEFAULT_PLAN), sha256(DEFAULT_RUN.spec)];
  const setup = (over = {}) => ({ task: '_run', event: 'run_started', phase: 'setup', head: D, plan_sha256: planSha, spec_sha256: specSha, ...over });
  const folder = makeRun({ ledger: { '_run.jsonl': [setup(), ENDED, setup({ plan_sha256: OTHER })] }, launches: [launch(accepted(D))] });
  const c = sections(folder).checks;
  const at = (n) => ({ path: `${LEDGER}/_run.jsonl`, at: `L${n}` });
  const plan = { path: 'p.md', at: null };
  assert.deepEqual(c.plan_hash, [
    { value: planSha, state: 'present', sources: [at(1), plan] },
    { value: OTHER, state: 'stale', sources: [at(3), plan], note: "the archived plan copy differs from this launch's" },
  ]);
  assert.deepEqual(c.spec_hash.map((r) => [r.value, r.state, r.sources[0]]), [[specSha, 'present', at(1)], [specSha, 'present', at(3)]]);
  assert.deepEqual(c.section_hash, { value: 'p.md', state: 'present', sources: [plan] });
  // The stale setup event is one run-level gap, not one per task.
  const b = built(folder);
  assert.deepEqual(b.gaps.filter((g) => /plan_hash|spec_hash|section_hash/.test(g.where)).map((g) => g.where),
    ['#/run/checks/plan_hash/1']);
  assert.deepEqual(b.causes.filter((g) => g.pointer.includes('plan_hash')),
    [{ pointer: '#/run/checks/plan_hash/N', state: 'stale', note: "the archived plan copy differs from this launch's",
      tasks: null, values: [OTHER] }]);
  // No setup event: one unavailable entry each.
  const none = sections(makeRun({ ledger: { '_run.jsonl': [ENDED] }, launches: [launch(accepted(D))] })).checks;
  assert.deepEqual([none.plan_hash, none.spec_hash].map((l) => l.map((r) => [r.state, r.note, r.sources])),
    [[['unavailable', 'no setup run_started recorded', LEDGER_SRC]], [['unavailable', 'no setup run_started recorded', LEDGER_SRC]]]);
  // Without a plan copy, or with one that cannot be read, the section hashes
  // are unavailable once.
  const noPlan = makeRun({ plan: null, launches: [launch(accepted(D))] });
  assert.deepEqual(sections(noPlan).checks.section_hash,
    { value: null, state: 'unavailable', sources: [], note: 'no plan copy archived' });
  assert.deepEqual(built(noPlan).gaps.filter((g) => g.note === 'no plan copy archived').map((g) => g.where),
    ['#/run/checks/section_hash']);
  const unreadable = makeRun({ launches: [launch(accepted(D))] });
  writeFileSync(join(unreadable, 'p.md'), Buffer.from([0xff, 0xfe, 0xfd]));
  assert.deepEqual(sections(unreadable).checks.section_hash,
    { value: null, state: 'unavailable', sources: [plan], note: 'the plan copy could not be read' });
});

test('e2e is stale only when both shas are recorded and differ', () => {
  const NO_CHECKED = 'the end-to-end check recorded no sha';
  const NO_DELIVERED = 'the run recorded no delivered sha';
  const cases = [
    // [checked_sha (undefined: no key), delivered_sha, state, note]
    [D, D, 'present', undefined],
    [OTHER, D, 'stale', `the end-to-end check covered ${OTHER}, not the delivered ${D}`],
    [null, D, 'unavailable', NO_CHECKED],
    [undefined, D, 'unavailable', NO_CHECKED],
    ['', D, 'unavailable', NO_CHECKED],
    [D, null, 'unavailable', NO_DELIVERED],
    [null, null, 'unavailable', `${NO_CHECKED}; ${NO_DELIVERED}`],
    [undefined, undefined, 'unavailable', `${NO_CHECKED}; ${NO_DELIVERED}`],
  ];
  for (const [checked, delivered, state, note] of cases) {
    const result = accepted(D, { e2e: { checked_sha: checked, items: [{ result: 'PASS' }, { result: 'FAIL' }] } });
    if (delivered === undefined) delete result.delivered_sha;
    else result.delivered_sha = delivered;
    const folder = makeRun({ launches: [launch(result)] });
    const e2e = sections(folder).checks.e2e;
    const name = JSON.stringify([checked, delivered]);
    assert.deepEqual([e2e.state, e2e.note], [state, note], name);
    assert.deepEqual(e2e.value, { checked_sha: checked === undefined ? null : checked, items: 2, failed: 1 }, name);
    // Stale and unavailable are both gaps: the gap count stays, and each is
    // one run-level cause with its value.
    const b = built(folder);
    const gaps = b.gaps.filter((g) => g.where === '#/run/checks/e2e');
    assert.deepEqual(gaps.map((g) => [g.state, g.note]), state === 'present' ? [] : [[state, note]], name);
    assert.deepEqual(b.causes.filter((g) => g.pointer === '#/run/checks/e2e').map((g) => [g.state, g.note, g.tasks, g.values]),
      state === 'present' ? [] : [[state, note, null, [e2e.value]]], name);
  }
});

test('an override at another head is stale and changes nothing', () => {
  const rejected = accepted(D, {
    acceptance: { status: 'rejected', delivered_sha: D, reasons: [{ kind: 'checks_failed', class: 'failed', detail: `failing at ${D}: npm test zqcmd (exit 1)` }], warnings: ['w npm test zqcmd'] },
  });
  const other = { task: '_run', event: 'accepted', head: OTHER, text: 'fine at the old one' };
  let s = sections(makeRun({ ledger: { '_run.jsonl': [other] }, launches: [launch(rejected)] }));
  assert.equal(s.facts.verdict, 'rejected');
  assert.equal(s.acceptance.overrides[0].head.state, 'stale');
  assert.equal(s.acceptance.overrides[0].head.note, 'it accepted an earlier revision');
  assert.deepEqual(s.acceptance.overrides[0].head.sources, [{ path: `${LEDGER}/_run.jsonl`, at: 'L1' }]);
  assert.equal(s.acceptance.overrides[0].text.quote, 'fine at the old one');
  assert.equal(s.acceptance.reasons[0].detail.quote, `failing at ${D}: <check:test#1> (exit 1)`);
  assert.equal(s.acceptance.warnings[0].quote, 'w <check:test#1>');

  s = sections(makeRun({ ledger: { '_run.jsonl': [other, '', { ...other, head: D, text: 'accept it' }] }, launches: [launch(rejected)] }));
  assert.equal(s.facts.verdict, 'accepted by user');
  assert.equal(s.facts.accepted_run, true);
  assert.equal(s.acceptance.overrides[1].head.state, 'present');
  assert.equal(s.acceptance.overrides[1].overrode, 'rejected: checks_failed');
  assert.deepEqual(s.acceptance.overrides[1].head.sources, [{ path: `${LEDGER}/_run.jsonl`, at: 'L3' }]);
  // Without the override the verdict is the run's own.
  assert.deepEqual([s.acceptance.verdict_without_override, s.acceptance.verdict_rule_without_override], ['rejected', null]);
});

test('acceptance gives the verdict without the override and its rule', () => {
  const accept = { task: '_run', event: 'accepted', head: D, text: 'ship it' };
  const keys = (s) => [s.facts.verdict, s.acceptance.verdict_rule, s.acceptance.verdict_without_override,
    s.acceptance.verdict_rule_without_override];
  const withOverride = makeRun({ ledger: { '_run.jsonl': [accept] }, launches: [launch(accepted(D))] });
  const without = makeRun({ launches: [launch(accepted(D))] });
  // [gate, with the override, without it]
  const cases = [
    ['mismatch', ['accepted by user', null, 'unverified', 'gate mismatch'],
      ['unverified', 'gate mismatch', 'unverified', 'gate mismatch']],
    ['unavailable', ['accepted by user', null, 'accepted (gate unavailable)', null],
      ['accepted (gate unavailable)', null, 'accepted (gate unavailable)', null]],
    ['match', ['accepted by user', null, 'accepted', null], ['accepted', null, 'accepted', null]],
  ];
  for (const [gate, over, bare] of cases) {
    assert.deepEqual(keys(sections(withOverride, { gate })), over, gate);
    assert.deepEqual(keys(sections(without, { gate })), bare, gate);
  }
  // The two keys follow verdict_rule.
  const order = Object.keys(sections(withOverride).acceptance);
  assert.deepEqual(order.slice(order.indexOf('verdict_rule'), order.indexOf('verdict_rule') + 3),
    ['verdict_rule', 'verdict_without_override', 'verdict_rule_without_override']);
  // No launch: unavailable, as the verdict is.
  const none = sections(makeRun({}));
  assert.deepEqual(keys(none), ['unavailable', null, 'unavailable', null]);
});

test('carried minor tasks come from the ledger minors snapshot', () => {
  const minors = (wf, open) => ({ task: '_run', event: 'minors', wf, open, covered: [] });
  const entry = (id, task) => ({ id, task, file: 'a.js', line: 1, issue: 'zqissue', fix: 'f' });
  const result = accepted(D, { final: finalAt(D, { carried_minors_open: ['A1-1', 'T2-1', 'Z9-1'] }) });
  const s = sections(makeRun({
    ledger: { '_run.jsonl': [
      minors('wf_old', [entry('A1-1', 'A1'), entry('T2-1', '2')]),
      // The latest snapshot that lists an id names its task.
      minors('wf_aaaaaa', [entry('T2-1', 'T2'), entry('Q1-1', 'Q1'), { id: 'Z9-1' }]),
    ] },
    launches: [launch(result)],
  }));
  assert.deepEqual(s.open_work.final.value.carried_minor_tasks, { 'A1-1': 'A1', 'T2-1': 'T2' });
  assert.doesNotMatch(JSON.stringify(s.open_work.final.value), /zqissue/);
  // No carried list: null; a carried list without a snapshot: {}.
  const empty = sections(makeRun({ launches: [launch(accepted(D, { final: finalAt(D, { carried_minors_open: [] }) }))] }));
  assert.deepEqual(empty.open_work.final.value.carried_minor_tasks, {});
});

test('checker_error mapping', () => {
  const out = python([
    'cases = [(2, json.dumps({"status": "match"})), (3, ""), (1, "garbage"), (0, json.dumps({"status": "bogus"})),',
    '         (1, json.dumps({"status": "checker_error"})), (0, json.dumps(["match"])),',
    '         (1, json.dumps({"status": "mismatch", "reason": "zqreason", "differences": ["zqcv"], "path": "zqcv"})),',
    '         (1, json.dumps({"status": "unavailable", "reason": "verify_evidence_time_untrusted"})),',
    '         (0, json.dumps({"status": "match", "path": "zqcv"}))]',
    'print(json.dumps([r.parse_check_verify(code, text) for code, text in cases]))',
  ]);
  assert.deepEqual(out.map((x) => [x.status, x.reason, x.exit]), [
    ['checker_error', null, 2],
    ['checker_error', null, 3],
    ['checker_error', null, 1],
    ['checker_error', null, 0],
    ['checker_error', null, 1],
    ['checker_error', null, 0],
    ['mismatch', null, 1],
    ['unavailable', 'verify_evidence_time_untrusted', 1],
    ['match', null, 0],
  ]);
  assert.doesNotMatch(JSON.stringify(out), /zqcv|zqreason/);

  // A stub status outside GATES is a checker_error too.
  const folder = makeRun({ launches: [launch(accepted(D))] });
  for (const gate of ['bogus', 'checker_error']) {
    const s = sections(folder, { gate, exit: 1 });
    assert.equal(s.facts.gate, 'checker_error');
    assert.equal(s.facts.verdict, 'accepted (gate unavailable)');
  }

  // run_check_verify itself, against a check-verify that prints garbage.
  const stub = join(dirname(folder), 'stub');
  mkdirSync(stub);
  writeFileSync(join(stub, 'check-verify'), 'import sys\nprint("not json zqcv")\nsys.exit(1)\n');
  const res = python([
    'run = c.load_run(sys.argv[1])',
    'r.SCRIPTS = sys.argv[2]',
    'print(json.dumps(r.run_check_verify(run, c.latest_launch(run)[0])))',
  ], [folder, stub]);
  assert.equal(res.status, 'checker_error');
  assert.equal(res.exit, 1);
  assert.equal(res.reason, null);
  assert.doesNotMatch(JSON.stringify(res), /zqcv/);
});

test('run_check_verify is not run without a ledger or a known latest launch', () => {
  const noLedger = makeRun({ ledger: null, launches: [launch(accepted(D))] });
  let out = python([
    'run = c.load_run(sys.argv[1])',
    'print(json.dumps([r.run_check_verify(run, c.latest_launch(run)[0]), r.run_check_verify(run, None)]))',
  ], [noLedger]);
  assert.deepEqual(out.map((x) => x.status), ['unavailable', 'unavailable']);
  assert.match(out[0].note, /no ledger/);
  // Through run_sections the default check-verify keeps the gate unavailable.
  const s = sections(noLedger, { real: true });
  assert.equal(s.facts.gate, 'unavailable');
  assert.equal(s.facts.verdict, 'accepted (gate unavailable)');
  assert.match(s.checks.gate.note, /no ledger/);
});

test('an evidence file outside the run folder is not read', { skip: !SYMLINKS && 'symlinks unavailable' }, () => {
  const folder = makeRun({ launches: [launch(accepted(D))] });
  const outside = join(dirname(folder), 'evidence.json');
  writeFileSync(outside, JSON.stringify(verifyAt(D)));
  const out = python([
    'import os',
    'run = c.load_run(sys.argv[1])',
    'checks = os.path.join(sys.argv[1], run["ledger"], "checks")',
    'os.makedirs(checks)',
    'os.symlink(sys.argv[2], os.path.join(checks, "verify-" + sys.argv[3] + ".json"))',
    'print(json.dumps(r.run_check_verify(run, c.latest_launch(run)[0])))',
  ], [folder, outside, D]);
  assert.equal(out.status, 'unavailable');
  assert.match(out.note, /outside the run folder/);
});

test('checks never carry commands or tails', () => {
  const verify = verifyAt(D, {
    results: [
      { group: 'test', command: 'npm test zqcmd', exit: 0, log: '/tmp/zqtail.log', tail: 'zqtail' },
      { group: 'lint', command: 'make zqother', exit: 0, log: '/tmp/zqtail2.log', tail: 'zqtail' },
    ],
  });
  const s = sections(makeRun({
    launches: [launch(accepted(D, { verify }))],
    files: { [`${LEDGER}/checks/verify-${D}.json`]: JSON.stringify(verify), [`${LEDGER}/checks/session-verify-${D}.json`]: '{}' },
  }));
  const text = JSON.stringify(s);
  assert.doesNotMatch(text, /zqtail|zqcmd|zqother/);
  assert.deepEqual(s.checks.verify.value.results, [
    { check: 'test#1', group: 'test', exit: 0 },
    { check: 'unmatched#1', group: 'lint', exit: 0 },
  ]);
  assert.equal(s.checks.verify.value.head, D);
  assert.deepEqual(s.checks.files.map((f) => f.path), [
    `${LEDGER}/checks/session-verify-${D}.json`,
    `${LEDGER}/checks/verify-${D}.json`,
  ]);
  assert.equal(s.checks.gate.value, 'match');
  // An absent verify result with checks configured is missing.
  const none = sections(makeRun({ launches: [launch(accepted(D, { verify: null }))] }), { gate: 'not_required' });
  assert.equal(none.checks.verify.state, 'missing');
  assert.equal(none.facts.verdict, 'unverified');
  assert.equal(none.acceptance.verdict_rule, 'not_required claimed while checks are configured');
});

test('the real check-verify flags late evidence', () => {
  const verify = verifyAt(D);
  const evidence = `${LEDGER}/checks/verify-${D}.json`;
  const folder = makeRun({
    launches: [launch(accepted(D))],
    files: { [evidence]: JSON.stringify(verify) },
    mtimes: { [evidence]: START / 1000 + 7200 },
  });
  const s = sections(folder, { real: true });
  assert.equal(s.facts.gate, 'unavailable');
  assert.equal(s.checks.gate.note, 'verify_evidence_time_untrusted');
  assert.equal(s.facts.verdict, 'accepted (gate unavailable)');
});

test('open work is listed', () => {
  const result = accepted(D, {
    status: 'complete',
    tasks: { A1: { status: 'done', commits: null, notes: '' }, A2: { status: 'blocked', commits: null, notes: 'stuck' } },
    stopped_lanes: [{ lane: 'a', task: 'A2', reason: 'review_rounds npm test zqcmd' }],
    final: finalAt(D, {
      open: [{ id: 'F1', lens: 'security', severity: 'important', file: 'x.js', line: 3, issue: 'bad zqreason', fix: 'f',
        reason: 'still open after the final re-review', disposition: { id: 'F1', status: 'fixed', evidence: 'did it' } }],
      declined: [{ id: 'F2', severity: 'minor', file: 'y.js', line: 1, issue: 'meh', reason: 'not needed',
        disposition: { id: 'F2', status: 'declined', evidence: 'e', reason: 'not needed' } }],
      cannot_verify: ['superpowers: cannot run pip install zqsetup', { requirement: 'r', source: 'run', why: 'w', check_by: 'c' }],
      task_minors_open: [{ id: 'A1-1', severity: 'minor', file: 'a.txt', line: 1, issue: 'nit', fix: 'x' }],
    }),
  });
  const s = sections(makeRun({
    manifest: { excluded: [{ id: 'X9', reason: 'manual step' }] },
    ledger: { 'a.jsonl': [{ task: 'A2', event: 'blocked', reason: 'stuck here' }] },
    launches: [launch(result)],
  }));
  const ow = s.open_work;
  assert.deepEqual(ow.tasks.map((t) => [t.task, t.status, t.reason && t.reason.quote]), [['A2', 'blocked', 'stuck here']]);
  assert.ok(ow.tasks[0].sources.some((x) => x.path === `${LEDGER}/a.jsonl` && x.at === 'L1'));
  assert.ok(ow.tasks[0].sources.some((x) => x.path === 'wf_aaaaaa.json'));
  const f = ow.final.value;
  assert.deepEqual(f.findings.map((x) => [x.id, x.status, x.issue.quote]), [['F1', 'open', 'bad zqreason'], ['F2', 'declined', 'meh']]);
  assert.equal(f.findings[0].disposition.evidence.quote, 'did it');
  assert.equal(f.findings[1].reason.quote, 'not needed');
  assert.equal(f.cannot_verify[0].quote, 'superpowers: cannot run <check:setup#1>');
  assert.equal(f.cannot_verify[1].why.quote, 'w');
  assert.deepEqual(f.task_minors_open.map((x) => [x.id, x.issue.quote]), [['A1-1', 'nit']]);
  // A result without carried_minors_open (before 1.6.3) has none recorded.
  assert.equal(f.carried_minors_open, null);
  assert.equal(f.carried_minor_tasks, null);
  // Both finding lists are recorded; an older engine's final has no open list.
  assert.deepEqual(f.not_recorded, []);
  const older = { ...result, final: { ...result.final } };
  delete older.final.open;
  const o = sections(makeRun({ launches: [launch(older)] })).open_work.final.value;
  assert.deepEqual([o.not_recorded, o.findings.map((x) => x.id)], [['open'], ['F2']]);
  assert.deepEqual(ow.excluded.map((x) => [x.id, x.reason.quote]), [['X9', 'manual step']]);
  assert.deepEqual(ow.stopped_lanes.value.map((x) => [x.lane, x.task, x.reason.quote]), [['a', 'A2', 'review_rounds <check:test#1>']]);
  assert.doesNotMatch(JSON.stringify(s), /zqcmd|zqsetup/);
});

test('audit treats an empty verify-<sha>.json as invalid or missing, never present', () => {
  const evidence = `${LEDGER}/checks/verify-${D}.json`;
  const folder = makeRun({
    launches: [launch(accepted(D))],
    files: { [evidence]: '' },
    mtimes: { [evidence]: START / 1000 + 60 },
  });
  const s = sections(folder, { real: true });
  assert.equal(s.facts.gate, 'invalid');
  assert.ok(['unavailable', 'missing'].includes(s.checks.gate.state), s.checks.gate.state);
  assert.notEqual(s.facts.verdict, 'accepted');
});
