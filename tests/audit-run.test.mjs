// scripts/_audit_run.py: the run-level sections of scripts/audit (launches,
// code outside the recorded task ranges, checks, acceptance, after delivery
// and open work), evidence validity and the derived verdict. check-verify is
// stubbed except where a test names the real one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SYMLINKS } from './platform.mjs';
import { loadHelpers } from './harness.mjs';
import { LEDGER, commit, makeRepo, makeRun, pythonJSON } from './audit-helpers.mjs';

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
  // A match whose lists were not recorded falls through to the run verdict.
  assert.equal(s.facts.verdict, 'accepted');
  const good = sections(makeRun({ launches: [launch(accepted(D))] }));
  assert.equal(good.facts.verdict, 'accepted');
  assert.deepEqual(good.facts, {
    verdict: 'accepted', gate: 'match', evidence: 'valid', verify_head: D, accepted_run: true, order_known: true,
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
  let s = run(accepted(r.fix, { final }), { launch: { journal: [{ label: 'final re-review', result: { head: r.fix, results: [] } }] } });
  let cov = coverage(s);
  assert.deepEqual(Object.keys(cov), [r.merge, r.fix]);
  assert.equal(cov[r.merge].state, 'present');
  assert.equal(cov[r.merge].value, 'final review');
  assert.equal(cov[r.fix].state, 'inferred');
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
  assert.deepEqual(ow.excluded.map((x) => [x.id, x.reason.quote]), [['X9', 'manual step']]);
  assert.deepEqual(ow.stopped_lanes.value.map((x) => [x.lane, x.task, x.reason.quote]), [['a', 'A2', 'review_rounds <check:test#1>']]);
  assert.doesNotMatch(JSON.stringify(s), /zqcmd|zqsetup/);
});
