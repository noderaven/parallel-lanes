// scripts/_audit_tasks.py: the per-task sections of scripts/audit
// (requirement, placement, changes, commits, review and the four status
// fields), built from an archived run folder and, optionally, a repo.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './platform.mjs';
import { DEFAULT_PLAN, LEDGER, makeRepo, makeRun, pythonJSON } from './audit-helpers.mjs';

const SPEC = '# Design\n\nThe spec.\n';
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const PLAN_SHA = sha256(DEFAULT_PLAN);
const SPEC_SHA = sha256(SPEC);
const SECTION = pythonJSON([
  'import _brief',
  'plan = json.loads(sys.argv[1])',
  'print(json.dumps({t: _brief.section_sha256(plan, t) for t in ("A1", "A2")}))',
], [JSON.stringify(DEFAULT_PLAN)]);

// Fake shas for runs audited without a repo.
const S = (c) => c.repeat(40);

const made = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function facts(over = {}) {
  return {
    verdict: 'accepted', gate: 'match', evidence: 'valid', evidence_rule: null, verify_head: null, accepted_run: true,
    order_known: true, ...over,
  };
}

// task_sections of a run folder: {A1: section, A2: section}, plus order.
function audit(folder, f, { repo = null, gitNote = null } = {}) {
  const out = pythonJSON([
    'import _audit_core as c, _audit_git as g, _audit_tasks as t',
    'folder, f, repo, note = sys.argv[1], json.loads(sys.argv[2]), sys.argv[3], json.loads(sys.argv[4])',
    'run = c.load_run(folder)',
    'git = g.open_repo(repo, None)[0] if repo else None',
    'kw = {"git_note": note} if note is not None else {}',
    'print(json.dumps(t.task_sections(run, git, f, c.command_pairs(run["manifest"]), **kw)))',
  ], [folder, JSON.stringify(f), repo || '', JSON.stringify(gitNote)]);
  const byId = {};
  for (const s of out) byId[s.id] = s;
  byId.order = out.map((s) => s.id);
  return byId;
}

const setup = (head, over = {}) => ({ task: '_run', event: 'run_started', phase: 'setup', head, plan_sha256: PLAN_SHA, spec_sha256: SPEC_SHA, ...over });
const started = (task, base) => ({ task, event: 'started', base });
const committed = (task, base, head, commits) => ({ task, event: 'committed', commits: commits || [head], base, head });
const reviewed = (task, head, over = {}) => ({ task, event: 'reviewed', rounds: 1, brief_sha256: SECTION[task], head, spec_sha256: SPEC_SHA, ...over });
const launch = (tasks, over = {}) => ({ wf: 'wf_1', startTime: 1760000000000, durationMs: 60000, result: { tasks, preflight: { undeclared: [] } }, args: {}, ...over });

// One reviewed A1 (base s0, head s1) in a launch that reports it done.
function reviewedRun(s0, s1, extra = []) {
  return {
    ledger: {
      '_run.jsonl': [setup(s0)],
      'a.jsonl': [started('A1', s0), committed('A1', s0, s1), reviewed('A1', s1), ...extra],
    },
    launches: [launch({ A1: { status: 'done', commits: [s0, s1] }, A2: { status: 'not_run', commits: null } })],
    files: { [`${LEDGER}/briefs/A1.md`]: 'brief\n' },
  };
}

const vs = (r) => [r.value, r.state];

test('a reviewed, verified, accepted task', () => {
  const repo = makeRepo(3);
  const [s0, s1, s2] = repo.shas;
  const out = audit(makeRun(reviewedRun(s0, s1)), facts({ verify_head: s2 }), { repo: repo.dir });
  assert.deepEqual(out.order, ['A1', 'A2']);
  const a1 = out.A1;
  assert.equal(a1.lane, 'a');
  assert.deepEqual(vs(a1.status.committed), [true, 'present']);
  assert.deepEqual(vs(a1.status.reviewed), [true, 'present']);
  assert.deepEqual(vs(a1.status.verified), [true, 'present']);
  assert.deepEqual(vs(a1.status.accepted), [true, 'present']);
  assert.deepEqual(vs(a1.status.result_status), ['done', 'present']);
  assert.deepEqual(a1.commits.entries.map((e) => [e.event, e.base, e.head, e.commits.value, e.commits.state]),
    [['committed', s0, s1, [s1], 'present']]);
  assert.deepEqual(a1.commits.entries[0].files.value, ['f2.txt']);
  assert.deepEqual(a1.commits.entries[0].line, { path: `${LEDGER}/a.jsonl`, at: 'L2' });
  assert.equal(a1.commits.legacy, null);
  // The plan and spec hashes and the plan copy are run-level (run.checks):
  // a task holds only its own brief hash and brief file.
  assert.deepEqual(Object.keys(a1.requirement), ['brief_hash', 'brief_file']);
  assert.doesNotMatch(JSON.stringify(out.A2), new RegExp(PLAN_SHA));
  assert.deepEqual(vs(a1.review.reviews[0].spec_match), [SPEC_SHA, 'present']);
  assert.deepEqual(vs(a1.placement.depends_on), [[], 'present']);
  assert.deepEqual(out.A2.placement.depends_on.value, ['A1']);
  assert.deepEqual(out.A2.placement.depends_on.sources, [{ path: 'p.lanes.json', at: '#/lanes/0/tasks/1/depends_on' }]);
  // A2 never ran: not committed, not accepted, and no conflict.
  assert.deepEqual(vs(out.A2.status.committed), [false, 'present']);
  assert.deepEqual(vs(out.A2.status.accepted), [false, 'present']);
  assert.deepEqual(vs(out.A2.status.result_status), ['not_run', 'present']);
});

test('reopened withdraws approval', () => {
  const [s0, s1] = [S('a'), S('b')];
  const reopened = { task: 'A1', event: 'reopened', reason: 'the spec changed' };
  const withdrawn = audit(makeRun(reviewedRun(s0, s1, [reopened])), facts());
  assert.deepEqual(vs(withdrawn.A1.status.reviewed), [false, 'stale']);
  assert.deepEqual(withdrawn.A1.review.approval.withdrawn_by, { path: `${LEDGER}/a.jsonl`, at: 'L4' });
  assert.deepEqual(withdrawn.A1.changes.events.map((e) => [e.value.event, e.value.reason.quote]), [['reopened', 'the spec changed']]);
  const again = audit(makeRun(reviewedRun(s0, s1, [reopened, reviewed('A1', s1)])), facts());
  assert.deepEqual(vs(again.A1.status.reviewed), [true, 'present']);
  assert.equal(again.A1.review.reviews.length, 2);
});

test('a later commit makes the approval stale', () => {
  const [s0, s1, s2] = [S('a'), S('b'), S('c')];
  const out = audit(makeRun(reviewedRun(s0, s1, [committed('A1', s1, s2)])), facts());
  assert.deepEqual(vs(out.A1.status.reviewed), [false, 'stale']);
  assert.deepEqual(out.A1.review.approval.stale_by, { path: `${LEDGER}/a.jsonl`, at: 'L4' });
  assert.equal(out.A1.commits.entries.length, 2);
});

test('a legacy review without head is unavailable', () => {
  const [s0, s1] = [S('a'), S('b')];
  const out = audit(makeRun({
    ledger: { 'a.jsonl': [{ task: 'A1', event: 'committed', commits: [s1] }, { event: 'reviewed', rounds: 0, task: 'A1' }] },
    launches: [launch({ A1: { status: 'done', commits: [s0, s1] } })],
  }), facts());
  assert.deepEqual(vs(out.A1.status.reviewed), [null, 'unavailable']);
  assert.equal(out.A1.review.reviews[0].head, null);
  assert.equal(out.A1.status.reviewed.note, 'review recorded no head');
  // No run_started: the task gets no plan or spec hash gap of its own (the
  // run-level one is in run.checks).
  assert.deepEqual(Object.keys(out.A1.requirement), ['brief_hash', 'brief_file']);
});

test('a pre-1.4.4 review', () => {
  const [s0, s1] = [S('a'), S('b')];
  const spec = reviewedRun(s0, s1);
  const r = reviewed('A1', s1);
  delete r.spec_sha256;
  spec.ledger['a.jsonl'][2] = r;
  const out = audit(makeRun(spec), facts());
  assert.equal(out.A1.review.reviews[0].spec_match.state, 'unavailable');
  assert.match(out.A1.review.reviews[0].spec_match.note, /before 1\.4\.4/);
  assert.deepEqual(vs(out.A1.status.reviewed), [true, 'present']);
});

test('settled tasks', () => {
  const [s0, s1] = [S('a'), S('b')];
  const out = audit(makeRun({
    ledger: {
      'a.jsonl': [
        started('A1', s0),
        { task: 'A1', event: 'blocked', reason: 'stuck' },
        { task: 'A1', event: 'ruling', by: 'adjudicator', text: 'go on without it' },
        { task: 'A1', event: 'settled', outcome: 'unblock', base: s0, head: s1 },
      ],
    },
    launches: [launch({ A1: { status: 'deferred', commits: [s0, s1] } })],
  }), facts());
  const a1 = out.A1;
  assert.deepEqual(vs(a1.status.reviewed), ['settled', 'present']);
  assert.match(a1.status.reviewed.note, /settled by adjudicator \(unblock\)/);
  assert.deepEqual(vs(a1.status.accepted), [false, 'present']);
  assert.deepEqual(vs(a1.status.result_status), ['deferred', 'present']);
  assert.deepEqual(vs(a1.changes.deferred), [true, 'present']);
  assert.equal(a1.changes.carry.value.quote, 'go on without it');
  assert.deepEqual(a1.changes.rulings.map((r) => [r.value.text.quote, r.value.by]), [['go on without it', 'adjudicator']]);
  assert.deepEqual(a1.changes.events.map((e) => e.value.event), ['blocked', 'settled']);
});

test('partial work', () => {
  const [s0, s1] = [S('a'), S('b')];
  const out = audit(makeRun({
    ledger: { 'a.jsonl': [started('A1', s0), committed('A1', s0, s1), { task: 'A1', event: 'blocked', reason: 'review failed' }] },
    launches: [launch({ A1: { status: 'blocked', commits: [s0, s1] } })],
  }), facts());
  const a1 = out.A1;
  assert.deepEqual(vs(a1.status.result_status), ['blocked', 'present']);
  assert.match(a1.status.result_status.note, /committed, blocked, unapproved/);
  assert.deepEqual(vs(a1.status.reviewed), [false, 'missing']);
  assert.deepEqual(vs(a1.status.accepted), [false, 'present']);
});

test('a result head that differs from the recorded range conflicts', () => {
  const [s0, s1, s2] = [S('a'), S('b'), S('c')];
  const spec = reviewedRun(s0, s1);
  spec.launches = [launch({ A1: { status: 'done', commits: [s0, s2] } })];
  const out = audit(makeRun(spec), facts());
  assert.equal(out.A1.status.result_status.state, 'conflicting');
  assert.deepEqual(out.A1.status.result_status.sources, [
    { path: 'wf_1.json', at: '#/result/tasks/A1/status' },
    { path: 'wf_1.json', at: '#/result/tasks/A1/commits' },
    { path: `${LEDGER}/a.jsonl`, at: 'L2' },
  ]);
  // The same range agrees.
  assert.equal(audit(makeRun(reviewedRun(s0, s1)), facts()).A1.status.result_status.state, 'present');
});

test('the result says done without a commit, or not_run after one', () => {
  const [s0, s1] = [S('a'), S('b')];
  const out = audit(makeRun({
    ledger: { 'a.jsonl': [started('A2', s0), committed('A2', s0, s1)] },
    launches: [launch({ A1: { status: 'done', commits: [s0, s1] }, A2: { status: 'not_run', commits: null } })],
  }), facts());
  assert.equal(out.A1.status.result_status.state, 'conflicting');
  assert.equal(out.A2.status.result_status.state, 'conflicting');
});

test('legacy commits agree by head', () => {
  const repo = makeRepo(3);
  const [s0, s1, s2] = repo.shas;
  const run = (head) => makeRun({
    ledger: { 'a.jsonl': [{ task: 'A1', event: 'committed', commits: [s1, s2] }] },
    launches: [launch({ A1: { status: 'done', commits: [s0, head] } })],
  });
  const agree = audit(run(s2), facts(), { repo: repo.dir }).A1.commits.legacy;
  assert.equal(agree.agreement.state, 'present');
  assert.deepEqual(agree.recorded.map((r) => r.commits), [[s1, s2]]);
  assert.deepEqual(agree.result.value, [s0, s2]);
  const noRepo = audit(run(s2), facts()).A1.commits.legacy;
  assert.equal(noRepo.agreement.state, 'present');
  const differ = audit(run(s1), facts(), { repo: repo.dir }).A1;
  assert.equal(differ.commits.legacy.agreement.state, 'conflicting');
  // For a legacy task the last committed head is its last commits entry.
  assert.equal(differ.status.committed.value, true);
});

test('the brief hash is the plan section\'s', () => {
  const [s0, s1] = [S('a'), S('b')];
  const out = audit(makeRun(reviewedRun(s0, s1)), facts());
  const req = out.A1.requirement;
  // The section hash is compared, not listed: the plan copy is a run check.
  assert.equal(req.section_hash, undefined);
  assert.deepEqual(vs(req.brief_hash), [SECTION.A1, 'present']);
  assert.deepEqual(req.brief_hash.sources, [{ path: `${LEDGER}/a.jsonl`, at: 'L3' }, { path: 'p.md', at: null }]);
  assert.notEqual(SECTION.A1, sha256('brief\n'));
  assert.equal(req.brief_file.value, `${LEDGER}/briefs/A1.md`);
  assert.match(req.brief_file.note, /latest regeneration, not hashed/);
  const spec = reviewedRun(s0, s1);
  spec.ledger['a.jsonl'][2] = reviewed('A1', s1, { brief_sha256: sha256('brief\n') });
  assert.equal(audit(makeRun(spec), facts()).A1.requirement.brief_hash.state, 'stale');
  // Without a plan copy the brief hash has nothing to compare with.
  const noPlan = audit(makeRun({ ...reviewedRun(s0, s1), plan: null }), facts()).A1.requirement;
  assert.deepEqual([...vs(noPlan.brief_hash), noPlan.brief_hash.note], [SECTION.A1, 'unavailable', 'no plan section to compare']);
  assert.equal(noPlan.section_hash, undefined);
  // A plan copy without the task's section: the task's own gap, on its brief hash.
  const lacking = audit(makeRun({ ...reviewedRun(s0, s1), plan: DEFAULT_PLAN.split('### Task A2')[0] }), facts());
  assert.deepEqual([...vs(lacking.A2.requirement.brief_hash), lacking.A2.requirement.brief_hash.note],
    [null, 'missing', "the plan copy has no usable section: no heading for task 'A2'"]);
  assert.deepEqual(lacking.A2.requirement.brief_hash.sources, [{ path: 'p.md', at: null }]);
  assert.deepEqual(vs(lacking.A1.requirement.brief_hash), [SECTION.A1, 'present']);
  // A reviewed task whose section the plan copy lacks: its brief hash (the
  // review's recorded hash) is missing and its review's brief match
  // unavailable, two gaps, and none for a section hash of its own.
  const noA1 = `# Plan\n\n${DEFAULT_PLAN.slice(DEFAULT_PLAN.indexOf('### Task A2'))}`;
  const reviewedLacking = audit(makeRun({ ...reviewedRun(s0, s1), plan: noA1 }), facts()).A1;
  assert.deepEqual([...vs(reviewedLacking.requirement.brief_hash), reviewedLacking.requirement.brief_hash.note],
    [SECTION.A1, 'missing', "the plan copy has no usable section: no heading for task 'A1'"]);
  assert.deepEqual(reviewedLacking.requirement.brief_hash.sources, [{ path: `${LEDGER}/a.jsonl`, at: 'L3' }, { path: 'p.md', at: null }]);
  assert.equal(reviewedLacking.review.reviews[0].brief_match.state, 'unavailable');
  const gapsOf = (node, where = '#') => {
    if (Array.isArray(node)) return node.flatMap((x, i) => gapsOf(x, `${where}/${i}`));
    if (node === null || typeof node !== 'object') return [];
    const own = Array.isArray(node.sources) && ['missing', 'stale', 'conflicting', 'unavailable'].includes(node.state)
      ? [`${where} ${node.state}`] : [];
    return own.concat(Object.entries(node).filter(([k]) => k !== 'sources').flatMap(([k, v]) => gapsOf(v, `${where}/${k}`)));
  };
  assert.deepEqual(gapsOf(reviewedLacking).filter((g) => /brief|section/.test(g)),
    ['#/requirement/brief_hash missing', '#/review/reviews/0/brief_match unavailable']);
  assert.equal(reviewedLacking.requirement.section_hash, undefined);
  // Every review's brief hash is compared, not only the latest one's.
  const twice = reviewedRun(s0, s1, [reviewed('A1', s1)]);
  twice.ledger['a.jsonl'][2] = reviewed('A1', s1, { brief_sha256: sha256('brief\n') });
  const reviews = audit(makeRun(twice), facts()).A1.review.reviews;
  assert.deepEqual(reviews.map((r) => r.brief_match.state), ['stale', 'present']);
  assert.match(reviews[0].brief_match.note, /another version of the task's plan section/);
  const noBrief = reviewedRun(s0, s1);
  noBrief.ledger['a.jsonl'][2] = reviewed('A1', s1, { brief_sha256: undefined });
  assert.equal(audit(makeRun(noBrief), facts()).A1.review.reviews[0].brief_match.state, 'unavailable');
});

test('without a spec copy, a review is compared with a launch spec hash in any ledger file', () => {
  const [s0, s1] = [S('a'), S('b')];
  // A lane file whose name sorts before _run.jsonl still finds the setup.
  const upper = reviewedRun(s0, s1);
  upper.ledger = { '_run.jsonl': upper.ledger['_run.jsonl'], 'B.jsonl': upper.ledger['a.jsonl'] };
  const m = audit(makeRun({ ...upper, spec: null }), facts()).A1.review.reviews[0].spec_match;
  assert.deepEqual(vs(m), [SPEC_SHA, 'present']);
  assert.equal(m.note, undefined);
  assert.ok(m.sources.some((x) => x.path === `${LEDGER}/_run.jsonl` && x.at === 'L1'));
  // With several launches in another file, the latest is used and the order noted.
  const several = reviewedRun(s0, s1);
  several.ledger['_run.jsonl'] = [setup(s0, { spec_sha256: sha256('old spec\n') }), setup(s0)];
  const n = audit(makeRun({ ...several, spec: null }), facts()).A1.review.reviews[0].spec_match;
  assert.deepEqual(vs(n), [SPEC_SHA, 'present']);
  assert.match(n.note, /launch order relative to the review is not established/);
  assert.ok(n.sources.some((x) => x.path === `${LEDGER}/_run.jsonl` && x.at === 'L2'));
});

test('which launch', () => {
  const [s0, s1] = [S('a'), S('b')];
  const spec = reviewedRun(s0, s1);
  spec.launches = [
    launch({ A1: { status: 'done', commits: [s0, s1] } }),
    launch({ A1: { status: 'skipped', commits: [s0, s1] } }, { wf: 'wf_2', startTime: 1760000900000 }),
  ];
  const out = audit(makeRun(spec), facts());
  assert.deepEqual(vs(out.A1.status.result_status), ['done', 'present']);
  assert.deepEqual(out.A1.status.result_status.sources[0], { path: 'wf_1.json', at: '#/result/tasks/A1/status' });
});

test('launch notes are never user answers', () => {
  const [s0, s1] = [S('a'), S('b')];
  const out = audit(makeRun({
    ledger: {
      'a.jsonl': [
        started('A1', s0),
        { task: 'A1', event: 'ruling', by: 'adjudicator', text: 'carry this on' },
        { task: 'A1', event: 'settled', outcome: 'unblock', base: s0, head: s1 },
      ],
    },
    launches: [launch({ A1: { status: 'deferred', commits: [s0, s1] } }, { args: { notes: { A1: 'carry this on', A2: 'the user said yes' } } })],
  }), facts());
  assert.deepEqual(out.A1.changes.launch_notes.map((n) => [n.value.wf, n.value.note.quote, n.value.carry]), [['wf_1', 'carry this on', true]]);
  assert.deepEqual(out.A2.changes.launch_notes.map((n) => [n.value.note.quote, n.value.carry]), [['the user said yes', false]]);
  assert.deepEqual(out.A2.changes.launch_notes[0].sources, [{ path: 'wf_1.json', at: '#/args/notes/A2' }]);
  assert.doesNotMatch(JSON.stringify(out), /user answer|user_answer/i);
});

test('not_required and unknown stay distinct', () => {
  const repo = makeRepo(3);
  const [s0, s1, s2] = repo.shas;
  const folder = makeRun(reviewedRun(s0, s1));
  const notRequired = audit(folder, facts({ evidence: 'not_required', gate: 'not_required' }), { repo: repo.dir });
  assert.deepEqual(vs(notRequired.A1.status.verified), ['not_required', 'present']);
  const unknown = audit(folder, facts({ evidence: 'unavailable', gate: 'unavailable', verify_head: s2 }), { repo: repo.dir });
  assert.deepEqual(vs(unknown.A1.status.verified), [null, 'unavailable']);
  const invalid = audit(folder, facts({ evidence: 'invalid', evidence_rule: 'checks_stale', verify_head: s2 }), { repo: repo.dir });
  assert.deepEqual(vs(invalid.A1.status.verified), [false, 'present']);
  assert.equal(invalid.A1.status.verified.note, 'the verify evidence is invalid');
  // Checks that ran and failed say so, at the verify head.
  const failed = audit(folder, facts({ evidence: 'invalid', evidence_rule: 'checks_failed', verify_head: s2 }), { repo: repo.dir });
  assert.deepEqual(vs(failed.A1.status.verified), [false, 'present']);
  assert.equal(failed.A1.status.verified.note, `the verify at ${s2.slice(0, 7)} failed (checks_failed)`);
  const headless = audit(folder, facts({ evidence: 'invalid', evidence_rule: 'checks_failed' }), { repo: repo.dir });
  assert.equal(headless.A1.status.verified.note, 'the verify failed (checks_failed)');
  const order = audit(folder, facts({ verify_head: s2, order_known: false }), { repo: repo.dir });
  assert.deepEqual(vs(order.A1.status.verified), [null, 'unavailable']);
  const noAncestor = audit(folder, facts({ verify_head: s0 }), { repo: repo.dir });
  assert.deepEqual(vs(noAncestor.A1.status.verified), [false, 'present']);
  // audit.json keeps the containment note (audit.md words the line).
  assert.equal(noAncestor.A1.status.verified.note, 'the verify head does not contain the task head');
  const verdict = audit(folder, facts({ verdict: 'unavailable', accepted_run: false }), { repo: repo.dir });
  assert.deepEqual(vs(verdict.A1.status.accepted), [null, 'unavailable']);
});

test('a gate-unavailable run leaves accepted unavailable only where it would be true', () => {
  const [s0, s1] = [S('a'), S('b')];
  const gate = facts({ verdict: 'accepted (gate unavailable)', gate: 'unavailable', evidence: 'unavailable', accepted_run: false });
  const accepted = (out) => [out.status.accepted.value, out.status.accepted.state, out.status.accepted.note];
  // A1 is done and reviewed; A2 never ran.
  const out = audit(makeRun(reviewedRun(s0, s1)), gate);
  assert.deepEqual(accepted(out.A1), [null, 'unavailable', 'the acceptance gate is unavailable']);
  assert.deepEqual(out.A1.status.accepted.sources, [{ path: 'wf_1.json', at: '#/result/tasks/A1/status' }]);
  assert.deepEqual(accepted(out.A2), [false, 'present', 'the result does not report the task done']);
  // A done task that is settled, or blocked after its last commit, stays false.
  const settled = audit(makeRun(reviewedRun(s0, s1, [{ task: 'A1', event: 'settled', outcome: 'unblock', base: s0, head: s1 }])), gate);
  assert.deepEqual(accepted(settled.A1), [false, 'present', 'the task is settled']);
  const blocked = audit(makeRun(reviewedRun(s0, s1, [{ task: 'A1', event: 'blocked', reason: 'stuck' }])), gate);
  assert.deepEqual(accepted(blocked.A1), [false, 'present', 'the task is blocked']);
  // Every other verdict keeps the order: a run that is not accepted says so first.
  for (const verdict of ['unverified', 'rejected']) {
    const other = audit(makeRun(reviewedRun(s0, s1)), facts({ verdict, accepted_run: false }));
    assert.deepEqual(accepted(other.A1), [false, 'present', 'the run is not accepted'], verdict);
    assert.deepEqual(accepted(other.A2), [false, 'present', 'the run is not accepted'], verdict);
  }
  assert.deepEqual(accepted(audit(makeRun(reviewedRun(s0, s1)), facts()).A1), [true, 'present', undefined]);
});

test('the gate-unavailable verdict is one constant, _audit_run\'s', () => {
  const out = pythonJSON([
    'import _audit_run as r, _audit_tasks as t',
    'v = r.derive_verdict("accepted", "unavailable", "unavailable", None, "d" * 40, True)',
    'src = open(t.__file__, encoding="utf-8").read()',
    'print(json.dumps([r.GATE_UNAVAILABLE_VERDICT, t.GATE_UNAVAILABLE_VERDICT is r.GATE_UNAVAILABLE_VERDICT,',
    '                  v is r.GATE_UNAVAILABLE_VERDICT, "GATE_UNAVAILABLE_VERDICT = " in src]))',
  ]);
  assert.deepEqual(out, ['accepted (gate unavailable)', true, true, false]);
});

test('without a repo every git fact is unavailable', () => {
  const [s0, s1] = [S('a'), S('b')];
  const folder = makeRun(reviewedRun(s0, s1));
  const out = audit(folder, facts({ verify_head: s1 }));
  const a1 = out.A1;
  assert.deepEqual(vs(a1.status.verified), [null, 'unavailable']);
  assert.equal(a1.status.verified.note, 'no --repo');
  assert.deepEqual([a1.commits.entries[0].commits.state, a1.commits.entries[0].commits.note], ['unavailable', 'no --repo']);
  assert.deepEqual([a1.commits.entries[0].files.state, a1.commits.entries[0].files.note], ['unavailable', 'no --repo']);
  const noted = audit(folder, facts({ verify_head: s1 }), { gitNote: 'the repo does not contain aaaaaaa' }).A1;
  assert.equal(noted.status.verified.note, 'the repo does not contain aaaaaaa');
  assert.equal(noted.commits.entries[0].commits.note, 'the repo does not contain aaaaaaa');
  // A range that does not resolve in a repo is missing.
  const repo = makeRepo(1);
  const missing = audit(folder, facts({ verify_head: s1 }), { repo: repo.dir }).A1;
  assert.equal(missing.commits.entries[0].commits.state, 'missing');
});

test('quotes replace commands', () => {
  const [s0, s1] = [S('a'), S('b')];
  const out = audit(makeRun(reviewedRun(s0, s1, [
    { task: 'A1', event: 'ruling', text: 'Ruling: run npm test zqcmd after pip install zqsetup - why - cost' },
    { task: 'A1', event: 'blocked', reason: 'npm test zqcmd failed' },
  ])), facts());
  const text = JSON.stringify(out);
  assert.doesNotMatch(text, /zqcmd|zqsetup/);
  const ruling = out.A1.changes.rulings[0].value.text;
  assert.equal(ruling.quote, 'Ruling: run <check:test#1> after <check:setup#1> - why - cost');
  assert.equal(ruling.commands_replaced, true);
  assert.deepEqual(ruling.sources, [{ path: `${LEDGER}/a.jsonl`, at: 'L4' }]);
});

test('review packages, verdicts and pre-flight context', () => {
  const [s0, s1] = [S('a'), S('b')];
  const spec = reviewedRun(s0, s1);
  spec.files[`${LEDGER}/reviews/A1-r1.md`] = 'package\n';
  spec.files[`${LEDGER}/reviews/A10-r1.md`] = 'other\n';
  spec.launches = [launch({ A1: { status: 'done', commits: [s0, s1] } }, {
    result: {
      tasks: { A1: { status: 'done', commits: [s0, s1] } },
      preflight: { undeclared: [{ task: 'A1', producer: 'A2', what: 'reads npm test zqcmd output' }, { task: 'A2', producer: 'A1', what: 'x' }] },
    },
    journal: [
      { label: 'A1 implement', result: { status: 'done', head: s1 } },
      { label: 'A1 review', result: { verdict: 'changes', findings: [{ text: 'zqprompt' }, { text: 'b' }], cannot_verify: [] } },
      { label: 'A1 re-review 1' },
      { label: 'A1 re-review 1 retry', result: { verdict: 'approve', findings: [], cannot_verify: [] } },
    ],
  }), { wf: 'wf_0', startTime: 1, dirless: true, result: { tasks: {} } }];
  const a1 = audit(makeRun(spec), facts()).A1;
  assert.deepEqual(a1.review.packages.value, [`${LEDGER}/reviews/A1-r1.md`]);
  // Recorded in the journal: present, each citing its result's line (the
  // retry's for a round it retried; L1 is the launched line).
  assert.deepEqual(a1.review.verdicts.map((v) => [v.value.label, v.value.verdict, v.value.findings, v.state, v.sources, v.note]), [
    ['A1 review', 'changes', 2, 'present', [{ path: 'wf_1/journal.jsonl', at: 'L5' }], undefined],
    ['A1 re-review 1', 'approve', 0, 'present', [{ path: 'wf_1/journal.jsonl', at: 'L8' }], undefined],
  ]);
  assert.doesNotMatch(JSON.stringify(a1), /zqprompt|zqcmd/);
  const pre = a1.placement.preflight_context;
  assert.equal(pre.label, 'context added by pre-flight (not ordering)');
  assert.deepEqual(pre.launches.map((l) => [l.wf, l.entries.state]), [['wf_0', 'unavailable'], ['wf_1', 'present']]);
  assert.deepEqual(pre.launches[1].entries.value.map((e) => [e.producer, e.what.quote]), [['A2', 'reads <check:test#1> output']]);
});

test('a journal verdict the engine read differently says so, for engines from 1.2.0 only', () => {
  const [s0, s1] = [S('a'), S('b')];
  const journal = [
    { label: 'A1 review', result: { verdict: 'approve', findings: [{ severity: 'important', issue: 'i' }] } },
    { label: 'A1 re-review 1', result: { verdict: 'changes', findings: [] } },
    { label: 'A1 re-review 2', result: { verdict: 'lgtm', findings: [] } },
    { label: 'A1 re-review 3', result: { verdict: 'approve', findings: [{ severity: 'minor', issue: 'm' }] } },
    { label: 'A1 re-review 4' },
  ];
  const verdicts = (version) => {
    const spec = reviewedRun(s0, s1);
    const result = { tasks: { A1: { status: 'done', commits: [s0, s1] } }, preflight: { undeclared: [] } };
    if (version !== undefined) result.version = version;
    spec.launches = [launch({}, { result, journal })];
    return audit(makeRun(spec), facts()).A1.review.verdicts;
  };
  const modern = verdicts('1.2.0');
  assert.deepEqual(modern.map((v) => [v.value.label, v.value.verdict, v.state, v.note, v.sources[0].at]), [
    ['A1 review', 'approve', 'present', 'the engine read it as changes', 'L3'],
    ['A1 re-review 1', 'changes', 'present', 'the engine read it as invalid', 'L5'],
    ['A1 re-review 2', 'lgtm', 'present', 'the engine read it as invalid', 'L7'],
    ['A1 re-review 3', 'approve', 'present', undefined, 'L9'],
    // A started entry with no result cites its started line.
    ['A1 re-review 4', null, 'unavailable', 'no structured result', 'L10'],
  ]);
  assert.deepEqual(modern[4].sources, [{ path: 'wf_1/journal.jsonl', at: 'L10' }]);
  // checkedReview shipped in 1.2.0: an older engine, or one that records no
  // version, read the verdict as written.
  for (const version of ['1.1.0', undefined]) {
    assert.deepEqual(verdicts(version).map((v) => v.note), [undefined, undefined, undefined, undefined, 'no structured result'],
      String(version));
  }
});

test('escalations come from the archived transcripts only', () => {
  const [s0, s1] = [S('a'), S('b')];
  const spec = reviewedRun(s0, s1);
  spec.launches = [launch({ A1: { status: 'done', commits: [s0, s1] } }, {
    agents: [
      { label: 'A1 implement', model: 'claude-sonnet-4-5', lines: [{ timestamp: '2026-10-01T00:00:01Z' }] },
      { label: 'A1 implement', model: 'claude-opus-4-1', lines: [{ timestamp: '2026-10-01T00:00:02Z' }] },
    ],
  }), launch({}, { wf: 'wf_2', startTime: 1760000900000, dirless: true })];
  const folder = makeRun(spec);
  const esc = audit(folder, facts()).A1.changes.escalations;
  assert.deepEqual(esc.map((e) => [e.wf, e.escalations.state]), [['wf_1', 'present'], ['wf_2', 'unavailable']]);
  assert.deepEqual(esc[0].escalations.value, [{ label: 'A1 implement', from_tier: 'sonnet', to_tier: 'opus' }]);
  // Escalations come from the transcripts, and cite them as transcript:.
  assert.deepEqual(esc[0].escalations.sources, [{ path: 'transcript:wf_1/A1 implement', at: null }]);
  // In a <session>/subagents/workflows layout the transcripts are not read:
  // that would prefer a session-level result outside the run folder.
  const top = tempDir('pl-audit-layout-');
  made.push(top);
  const moved = join(top, 'subagents', 'workflows');
  mkdirSync(join(top, 'subagents'), { recursive: true });
  cpSync(folder, moved, { recursive: true });
  mkdirSync(join(top, 'workflows'));
  writeFileSync(join(top, 'workflows', 'wf_1.json'), '{"result": {"tasks": {}}}\n');
  const layout = audit(moved, facts()).A1.changes.escalations;
  assert.equal(layout[0].escalations.state, 'unavailable');
  assert.match(layout[0].escalations.note, /outside the run folder/);
});

// ---- the task's own check before its commit (1.6.17) ----

const CHECKS = `${LEDGER}/checks`;
const AT = (minute) => `2026-10-12T10:${String(minute).padStart(2, '0')}:00.000Z`;
// Free text the audit must never copy: checkout, logs, tails, error records
// and reason details.
const CANARIES = /zqcheckout|zqlog|zqtail|zqerror|zqdetail|zqcmd/;

// A task-checks evidence file (run-checks' JSON plus task-checks' policy)
// for unit at base: passing, at minute 0.
function taskCheck(unit, base, over = {}, policy = {}) {
  return {
    checkout: '/home/x/proj-wt/zqcheckout',
    branch: 'feat',
    head: base,
    results: [{ group: 'test', command: 'npm test zqcmd', exit: 0, log: '/tmp/zqlog/task.1.log', tail: 'ok zqtail', duration_s: 1 }],
    ok: true,
    clean: false,
    tracked_before: [],
    tracked_after: [],
    untracked_before: [],
    untracked_after: [],
    tree_changed: false,
    policy: {
      unit, tasks: [unit], lane: 'a', base, started: AT(0), entry: null, selected: 'lane',
      reasons: [{ code: 'no_entry', detail: 'no task_checks entry zqdetail' }], changed: ['a1.txt'], ...policy,
    },
    ...over,
  };
}
const failing = (unit, base, exits = [1], over = {}) => taskCheck(unit, base, {
  ok: false,
  results: exits.map((exit) => ({ group: 'test', command: 'npm test zqcmd', exit, log: '/tmp/zqlog/x.log', tail: 'FAIL zqtail' })),
  ...over,
});
const errorRecord = (policy) => ({ results: [], ok: false, error: 'run-checks crashed zqerror', policy });

// A launch whose result records engine version.
const engine = (version, tasks, over = {}) => launch(tasks, {
  result: { ...(version === undefined ? {} : { version }), tasks, preflight: { undeclared: [] } }, ...over,
});
const files = (named) => Object.fromEntries(Object.entries(named)
  .map(([name, data]) => [`${CHECKS}/${name}`, typeof data === 'string' ? data : JSON.stringify(data)]));

// reviewedRun (A1 s0..s1, reviewed) in a 1.6.0 launch, with check files.
function checkedRun(s0, s1, named, extra = []) {
  const spec = reviewedRun(s0, s1, extra);
  spec.launches = [engine('1.6.0', { A1: { status: 'done', commits: [s0, s1] }, A2: { status: 'not_run', commits: null } })];
  spec.files = { ...spec.files, ...files(named) };
  return spec;
}
const tc = (section) => section.checks.task_check;

test('the task check before its commit: a pass', () => {
  const [s0, s1] = [S('a'), S('b')];
  const spec = checkedRun(s0, s1, { 'task-A1.1.json': taskCheck('A1', s0), 'task-A2.1.json': taskCheck('A2', s1) });
  const out = audit(makeRun(spec), facts());
  const r = tc(out.A1);
  assert.deepEqual([r.state, r.note], ['present', undefined]);
  assert.deepEqual(r.sources, [{ path: `${CHECKS}/task-A1.1.json`, at: null }]);
  assert.deepEqual(r.value, {
    file: `${CHECKS}/task-A1.1.json`, unit: 'A1', attempt: 1, selected: 'lane', reasons: ['no_entry'], ok: true, failed: [],
    base: s0, head: s0, head_is_task_commit: false, tree_changed: false, earlier: { passed: 0, failed: 0, no_result: 0 },
    fix_commits_after: 0,
  });
  // Not a status: the Bottom line's four counts are unchanged.
  assert.deepEqual(Object.keys(out.A1.status), ['committed', 'reviewed', 'verified', 'accepted', 'result_status']);
  // A2 never committed: no line and no gap, even with a file.
  assert.deepEqual([tc(out.A2).value, tc(out.A2).state, tc(out.A2).note], [null, 'present', 'not committed']);
  // Reason codes only: no checkout, log, tail or detail text.
  assert.doesNotMatch(JSON.stringify(out), CANARIES);
  // It needs no git: with a repo the value is the same.
  const repo = makeRepo(2);
  const withRepo = audit(makeRun(checkedRun(repo.shas[0], repo.shas[1], { 'task-A1.1.json': taskCheck('A1', repo.shas[0]) })),
    facts(), { repo: repo.dir });
  assert.deepEqual([tc(withRepo.A1).value.ok, tc(withRepo.A1).state], [true, 'present']);
});

test('the task check before its commit: a failure, and one where no command failed', () => {
  const [s0, s1] = [S('a'), S('b')];
  const out = audit(makeRun(checkedRun(s0, s1, { 'task-A1.1.json': failing('A1', s0, [1, 0]) })), facts());
  const r = tc(out.A1);
  assert.deepEqual([r.value.ok, r.value.failed, r.state, r.note], [false, [{ check: 'test#1', group: 'test', exit: 1 }], 'present', undefined]);
  // ok false with every exit 0 (HEAD moved while it ran) is a failure with no failing command.
  const moved = tc(audit(makeRun(checkedRun(s0, s1, { 'task-A1.1.json': failing('A1', s0, [0]) })), facts()).A1);
  assert.deepEqual([moved.value.ok, moved.value.failed, moved.state], [false, [], 'present']);
  assert.doesNotMatch(JSON.stringify(out), CANARIES);
});

test('several attempts: the last decides, the earlier ones are counted', () => {
  const [s0, s1] = [S('a'), S('b')];
  const pass = taskCheck('A1', s0);
  const fail = failing('A1', s0);
  const of = (named) => {
    const r = tc(audit(makeRun(checkedRun(s0, s1, named)), facts()).A1);
    return [r.value.ok, r.value.failed, r.state, r.value.file.slice(CHECKS.length + 1), r.value.attempt, r.value.earlier];
  };
  assert.deepEqual(of({ 'task-A1.1.json': fail, 'task-A1.2.json': pass }),
    [true, [], 'present', 'task-A1.2.json', 2, { passed: 0, failed: 1, no_result: 0 }]);
  assert.deepEqual(of({ 'task-A1.1.json': pass, 'task-A1.2.json': pass }),
    [true, [], 'present', 'task-A1.2.json', 2, { passed: 1, failed: 0, no_result: 0 }]);
  assert.deepEqual(of({ 'task-A1.1.json': '', 'task-A1.2.json': fail }),
    [false, [{ check: 'test#1', group: 'test', exit: 1 }], 'present', 'task-A1.2.json', 2, { passed: 0, failed: 0, no_result: 1 }]);
  // n orders as a number: 10 after 9 and 2.
  assert.deepEqual(of({ 'task-A1.2.json': fail, 'task-A1.10.json': pass, 'task-A1.9.json': '' }),
    [true, [], 'present', 'task-A1.10.json', 10, { passed: 0, failed: 1, no_result: 1 }]);
  // A pass, then a reserved file never written: the last decides.
  assert.deepEqual(of({ 'task-A1.1.json': pass, 'task-A1.2.json': '' }),
    [null, null, 'unavailable', 'task-A1.2.json', 2, { passed: 1, failed: 0, no_result: 0 }]);
});

test('a last attempt with no result is unavailable, and its note says why', () => {
  const [s0, s1] = [S('a'), S('b')];
  const of = (data) => tc(audit(makeRun(checkedRun(s0, s1, { 'task-A1.1.json': data })), facts()).A1);
  for (const [data, note] of [
    ['', 'the file is empty: reserved, never written'],
    ['not json', 'the file cannot be read'],
    ['[1]', 'the file cannot be read'],
    [errorRecord(null), 'an error record with no policy'],
  ]) {
    const r = of(data);
    assert.deepEqual([r.value.ok === true, r.value.failed, r.state, r.note], [false, null, 'unavailable', note], note);
    // No policy: no selection, reasons or base; the unit is the file name's.
    assert.deepEqual([r.value.unit, r.value.selected, r.value.reasons, r.value.base, r.value.head], ['A1', null, null, null, null]);
    assert.deepEqual(r.sources, [{ path: `${CHECKS}/task-A1.1.json`, at: null }]);
  }
  // An error record with its policy keeps the selection.
  const r = of(errorRecord(taskCheck('A1', s0).policy));
  assert.deepEqual([r.value.ok, r.value.failed, r.state, r.note, r.value.selected, r.value.reasons, r.value.base],
    [false, null, 'unavailable', 'an error record', 'lane', ['no_entry'], s0]);
  assert.doesNotMatch(JSON.stringify(r), CANARIES);
});

test('a batch file counts for each of its tasks; a file without a policy matches by its name', () => {
  const [s0, s1] = [S('a'), S('b')];
  const batch = (named) => {
    const spec = checkedRun(s0, s1, named, [started('A2', s0), committed('A2', s0, s1), reviewed('A2', s1)]);
    spec.launches = [engine('1.6.0', { A1: { status: 'done', commits: [s0, s1] }, A2: { status: 'done', commits: [s0, s1] } })];
    return audit(makeRun(spec), facts());
  };
  const both = batch({ 'task-A1-A2.1.json': taskCheck('A1-A2', s0, {}, { tasks: ['A1', 'A2'] }) });
  for (const id of ['A1', 'A2']) {
    assert.deepEqual([tc(both[id]).value.unit, tc(both[id]).value.file, tc(both[id]).state],
      ['A1-A2', `${CHECKS}/task-A1-A2.1.json`, 'present'], id);
  }
  // An empty batch file has no policy: its name's parts are both manifest ids.
  const empty = batch({ 'task-A1-A2.1.json': taskCheck('A1-A2', s0, {}, { tasks: ['A1', 'A2'] }), 'task-A1-A2.2.json': '' });
  for (const id of ['A1', 'A2']) {
    const r = tc(empty[id]);
    assert.deepEqual([r.value.unit, r.value.attempt, r.state, r.value.earlier], ['A1-A2', 2, 'unavailable',
      { passed: 1, failed: 0, no_result: 0 }], id);
  }
  // Across names, by each name's earliest policy.started; a name with none last.
  const order = batch({
    'task-A1.1.json': taskCheck('A1', s0, {}, { started: AT(30) }),
    'task-A1-A2.1.json': failing('A1-A2', s0, [1], { policy: { ...taskCheck('A1-A2', s0).policy, tasks: ['A1', 'A2'], started: AT(10) } }),
  });
  assert.deepEqual([tc(order.A1).value.file, tc(order.A1).value.earlier], [`${CHECKS}/task-A1.1.json`, { passed: 0, failed: 1, no_result: 0 }]);
  assert.equal(tc(order.A2).value.file, `${CHECKS}/task-A1-A2.1.json`);
  const last = batch({ 'task-A1.1.json': '', 'task-A1-A2.1.json': taskCheck('A1-A2', s0, {}, { tasks: ['A1', 'A2'] }) });
  assert.deepEqual([tc(last.A1).value.file, tc(last.A1).state], [`${CHECKS}/task-A1.1.json`, 'unavailable']);
});

test('fix commits after the check come from the ledger', () => {
  const [s0, s1, s2, s3] = [S('a'), S('b'), S('c'), S('d')];
  const of = (extra) => tc(audit(makeRun(checkedRun(s0, s1, { 'task-A1.1.json': taskCheck('A1', s0) }, extra)), facts()).A1)
    .value.fix_commits_after;
  assert.equal(of([]), 0);
  assert.equal(of([committed('A1', s1, s2), reviewed('A1', s2)]), 1);
  assert.equal(of([committed('A1', s1, s2), committed('A1', s2, s3), reviewed('A1', s3)]), 2);
  // An escalated implement commits from the task base again, after its own
  // check: no fix commit after it, whatever the rounds.
  assert.equal(of([committed('A1', s0, s2), reviewed('A1', s2, { rounds: 0 })]), 0);
  // A rerun after a fix also commits from the task base.
  assert.equal(of([committed('A1', s1, s2), committed('A1', s0, s3), reviewed('A1', s3)]), 0);
});

test('HEAD at the check, the checkout changing, and a base that is not the task\'s', () => {
  const [s0, s1] = [S('a'), S('b')];
  const of = (data) => tc(audit(makeRun(checkedRun(s0, s1, { 'task-A1.1.json': data })), facts()).A1);
  const other = of(taskCheck('A1', s0, { head: S('e') }));
  assert.deepEqual([other.value.head, other.value.head_is_task_commit, other.state], [S('e'), false, 'present']);
  // HEAD is the task's own commit: the check ran after it.
  const own = of(taskCheck('A1', s0, { head: s1 }));
  assert.deepEqual([own.value.head, own.value.head_is_task_commit, own.state], [s1, true, 'present']);
  // Any commit a committed event lists is the task's own, not only its head.
  const spec = checkedRun(s0, s1, { 'task-A1.1.json': taskCheck('A1', s0, { head: S('9') }) });
  spec.ledger['a.jsonl'][1] = committed('A1', s0, s1, [S('9'), s1]);
  const first = tc(audit(makeRun(spec), facts()).A1);
  assert.deepEqual([first.value.head, first.value.head_is_task_commit], [S('9'), true]);
  assert.equal(of(taskCheck('A1', s0, { tree_changed: true })).value.tree_changed, true);
  assert.equal(of(taskCheck('A1', s0, { tree_changed: undefined })).value.tree_changed, null);
  // A policy base other than the task's recorded range base is stale.
  const stale = of(taskCheck('A1', S('f'), { head: S('f') }));
  assert.deepEqual([stale.value.base, stale.value.ok, stale.state, stale.note],
    [S('f'), true, 'stale', `the check ran against ${S('f')}, not the task's recorded base ${s0}`]);
});

test('no task-check file: missing when the engine asks for one, not_required when it does not', () => {
  const [s0, s1, s2, s3] = [S('a'), S('b'), S('c'), S('d')];
  const run = (manifest) => audit(makeRun({
    manifest: { prelude: [{ id: 'P1', title: 'Pre' }], join: [{ id: 'J1', title: 'Join' }], ...manifest },
    ledger: {
      'p.jsonl': [started('P1', s0), committed('P1', s0, s1)],
      'a.jsonl': [started('A1', s1), committed('A1', s1, s2)],
      'j.jsonl': [started('J1', s2), committed('J1', s2, s3)],
    },
    launches: [engine('1.6.0', { P1: { status: 'done', commits: [s0, s1] }, A1: { status: 'done', commits: [s1, s2] },
      J1: { status: 'done', commits: [s2, s3] } })],
  }), facts());
  const rows = (out) => ['P1', 'A1', 'J1', 'A2'].map((id) => [id, tc(out[id]).value, tc(out[id]).state]);
  const missing = "no task-check file archived, though the task's commands include a test, lint or build command";
  const none = "the task's commands include no test, lint or build command: the engine asks for no task check";
  // The project's test command: every committed task should have one.
  const project = run({});
  assert.deepEqual(rows(project), [['P1', null, 'missing'], ['A1', null, 'missing'], ['J1', null, 'missing'], ['A2', null, 'present']]);
  assert.equal(tc(project.A1).note, missing);
  assert.deepEqual(tc(project.A1).sources, [{ path: `${LEDGER}/a.jsonl`, at: 'L2' }]);
  // Only lane a has a command: prelude and join use the project's.
  const lane = run({ commands: { test: [] }, lane_commands: { a: { test: ['npm test zqlane'] } } });
  assert.deepEqual(rows(lane), [['P1', 'not_required', 'present'], ['A1', null, 'missing'], ['J1', 'not_required', 'present'],
    ['A2', null, 'present']]);
  assert.deepEqual([tc(lane.P1).note, tc(lane.P1).sources], [none, [{ path: 'p.lanes.json', at: null }]]);
  // A lane whose own group is empty overrides the project's, as the engine reads it.
  const emptied = run({ lane_commands: { a: { test: [] } } });
  assert.deepEqual(rows(emptied).map((r) => r[2]), ['missing', 'present', 'missing', 'present']);
  assert.equal(tc(emptied.A1).value, 'not_required');
});

test('a task with no file is judged by the engines of the launches that report it', () => {
  const [s0, s1, s2] = [S('a'), S('b'), S('c')];
  const ledger = { 'a.jsonl': [started('A1', s0), committed('A1', s0, s1), started('A2', s1), committed('A2', s1, s2)] };
  const later = { wf: 'wf_2', startTime: 1760000900000 };
  const both = { A1: { status: 'done', commits: [s0, s1] }, A2: { status: 'done', commits: [s1, s2] } };
  const of = (launches) => {
    const out = audit(makeRun({ ledger, launches }), facts());
    return ['A1', 'A2'].map((id) => [tc(out[id]).value, tc(out[id]).state, tc(out[id]).note]);
  };
  const notRecorded = [null, 'present', "not recorded by this run's engine (before 1.6.0)"];
  const missing = [null, 'missing', "no task-check file archived, though the task's commands include a test, lint or build command"];
  // Before 1.6.0, or no version (before 1.4.3): no line and no gap.
  assert.deepEqual(of([engine('1.5.1', both)]), [notRecorded, notRecorded]);
  assert.deepEqual(of([engine(undefined, both)]), [notRecorded, notRecorded]);
  // Mixed launches: a skipped or not_run report does not count; any
  // reporting launch before 1.6.0 does.
  assert.deepEqual(of([engine('1.5.1', { A1: both.A1, A2: { status: 'not_run', commits: null } }),
    engine('1.6.0', { A1: { status: 'skipped', commits: [s0, s1] }, A2: both.A2 }, later)]), [notRecorded, missing]);
  assert.deepEqual(of([engine('1.5.1', { A1: both.A1 }), engine('1.6.0', both, later)]), [notRecorded, missing]);
  const sources = tc(audit(makeRun({ ledger, launches: [engine(undefined, both)] }), facts()).A1).sources;
  assert.deepEqual(sources, [{ path: 'wf_1.json', at: '#/result' }]);
  // No launch result reports the task: its engine is unknown, a gap.
  const unknown = [null, 'unavailable', 'no launch result reports this task; its engine is unknown'];
  assert.deepEqual(of([]), [unknown, unknown]);
  assert.deepEqual(of([engine('1.6.0', { A1: { status: 'not_run', commits: null } })]), [unknown, unknown]);
  // A version audit cannot read is no engine before 1.6.0 either.
  const unreadable = [null, 'unavailable', 'a launch result that reports this task records an engine version audit cannot read'];
  assert.deepEqual(of([engine('dev', both)]), [unreadable, unreadable]);
});

test('a settled task gets no line, even with files', () => {
  const [s0, s1] = [S('a'), S('b')];
  const out = audit(makeRun({
    ledger: { 'a.jsonl': [started('A1', s0), committed('A1', s0, s1), { task: 'A1', event: 'blocked', reason: 'stuck' },
      { task: 'A1', event: 'settled', outcome: 'park', base: s0, head: s1 }] },
    launches: [engine('1.6.0', { A1: { status: 'deferred', commits: [s0, s1] } })],
    files: files({ 'task-A1.1.json': taskCheck('A1', s0) }),
  }), facts());
  const r = tc(out.A1);
  assert.deepEqual([r.value, r.state, r.note, r.sources], [null, 'present', 'settled by adjudicator', [{ path: `${LEDGER}/a.jsonl`, at: 'L4' }]]);
  // No ledger: nothing is known committed, and the task check is no gap.
  const none = tc(audit(makeRun({ ledger: null, launches: [engine('1.6.0', { A1: { status: 'done', commits: [s0, s1] } })] }), facts()).A1);
  assert.deepEqual([none.value, none.state, none.note], [null, 'present', 'no ledger']);
});

test('an implement retried at its own tier after an API error is no escalation', () => {
  // Review focus 4: A1 implement (opus) ends on Claude Code's API error line
  // (model <synthetic>) and its retry runs at opus; A1 review has only a
  // synthetic line and no requested model.
  const [s0, s1] = [S('a'), S('b')];
  const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const line = (timestamp, model) => ({ type: 'assistant', timestamp, message: { id: `m${timestamp}`, model, usage } });
  const spec = reviewedRun(s0, s1);
  spec.launches = [launch({ A1: { status: 'done', commits: [s0, s1] } }, {
    agents: [
      { label: 'A1 implement', model: 'opus',
        lines: [line('2026-10-01T00:00:01Z', 'claude-opus-4-1'), line('2026-10-01T00:00:02Z', '<synthetic>')] },
      { label: 'A1 implement retry', model: 'opus', lines: [line('2026-10-01T00:00:03Z', 'claude-opus-4-1')] },
      { label: 'A1 review', lines: [line('2026-10-01T00:00:04Z', '<synthetic>')] },
    ],
  })];
  const esc = audit(makeRun(spec), facts()).A1.changes.escalations;
  assert.deepEqual(esc.map((e) => [e.wf, e.escalations.state, e.escalations.value]), [['wf_1', 'present', []]]);
});
