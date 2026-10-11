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
  return { verdict: 'accepted', gate: 'match', evidence: 'valid', verify_head: null, accepted_run: true, order_known: true, ...over };
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
  assert.deepEqual(a1.requirement.plan_hash.map(vs), [[PLAN_SHA, 'present']]);
  assert.deepEqual(a1.requirement.spec_hash.map(vs), [[SPEC_SHA, 'present']]);
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
  // No run_started: the plan and spec hashes are unavailable, not stale.
  assert.deepEqual(out.A1.requirement.plan_hash.map((r) => r.state), ['unavailable']);
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
  assert.deepEqual(vs(req.section_hash), [SECTION.A1, 'present']);
  assert.deepEqual(vs(req.brief_hash), [SECTION.A1, 'present']);
  assert.notEqual(SECTION.A1, sha256('brief\n'));
  assert.equal(req.brief_file.value, `${LEDGER}/briefs/A1.md`);
  assert.match(req.brief_file.note, /latest regeneration, not hashed/);
  const spec = reviewedRun(s0, s1);
  spec.ledger['a.jsonl'][2] = reviewed('A1', s1, { brief_sha256: sha256('brief\n') });
  assert.equal(audit(makeRun(spec), facts()).A1.requirement.brief_hash.state, 'stale');
  assert.equal(audit(makeRun({ ...reviewedRun(s0, s1), plan: null }), facts()).A1.requirement.section_hash.state, 'unavailable');
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
  const invalid = audit(folder, facts({ evidence: 'invalid', verify_head: s2 }), { repo: repo.dir });
  assert.deepEqual(vs(invalid.A1.status.verified), [false, 'present']);
  const order = audit(folder, facts({ verify_head: s2, order_known: false }), { repo: repo.dir });
  assert.deepEqual(vs(order.A1.status.verified), [null, 'unavailable']);
  const noAncestor = audit(folder, facts({ verify_head: s0 }), { repo: repo.dir });
  assert.deepEqual(vs(noAncestor.A1.status.verified), [false, 'present']);
  const verdict = audit(folder, facts({ verdict: 'unavailable', accepted_run: false }), { repo: repo.dir });
  assert.deepEqual(vs(verdict.A1.status.accepted), [null, 'unavailable']);
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
  assert.deepEqual(a1.review.verdicts.map((v) => [v.value.label, v.value.verdict, v.value.findings, v.state, v.sources[0].path]), [
    ['A1 review', 'changes', 2, 'inferred', 'transcript:wf_1/A1 review'],
    ['A1 re-review 1', 'approve', 0, 'inferred', 'transcript:wf_1/A1 re-review 1 retry'],
  ]);
  assert.doesNotMatch(JSON.stringify(a1), /zqprompt|zqcmd/);
  const pre = a1.placement.preflight_context;
  assert.equal(pre.label, 'context added by pre-flight (not ordering)');
  assert.deepEqual(pre.launches.map((l) => [l.wf, l.entries.state]), [['wf_0', 'unavailable'], ['wf_1', 'present']]);
  assert.deepEqual(pre.launches[1].entries.value.map((e) => [e.producer, e.what.quote]), [['A2', 'reads <check:test#1> output']]);
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
