// scripts/audit end to end: the audit command over archived run folders
// (built by tests/audit-helpers.mjs), with the real check-verify and ledger
// status, a real repo where a test names one, and scripts/tool-outcomes
// reading what it wrote.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { SYMLINKS, tempDir } from './platform.mjs';
import { DEFAULT_PLAN, LEDGER, SCRIPTS, commit, makeRepo, makeRun, pythonJSON } from './audit-helpers.mjs';

const AUDIT = join(SCRIPTS, 'audit');
const FIRST_LINE = 'This audit holds local paths and recorded text from the run; it is not meant to be shared as-is.';
const START = 1760000000000;
const DURATION = 3600000;
const SPEC = '# Design\n\nThe spec.\n';
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const PLAN_SHA = sha256(DEFAULT_PLAN);
const SPEC_SHA = sha256(SPEC);
const SECTION = pythonJSON([
  'import _brief',
  'plan = json.loads(sys.argv[1])',
  'print(json.dumps({t: _brief.section_sha256(plan, t) for t in ("A1", "A2")}))',
], [JSON.stringify(DEFAULT_PLAN)]);
const S = (c) => c.repeat(40);

const made = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
function fresh(prefix) {
  const dir = tempDir(prefix);
  made.push(dir);
  return dir;
}

// ---- running the tools ----

function audit(folder, args = [], env = {}, script = AUDIT) {
  const res = spawnSync('python3', [script, folder, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

// Runs audit, asserts exit 0 and returns {json (parsed), jsonText, md, stdout}.
function view(folder, args = [], env = {}, script = AUDIT) {
  const res = audit(folder, args, env, script);
  assert.equal(res.code, 0, res.stderr);
  const out = join(folder, 'audit');
  const jsonText = readFileSync(join(out, 'audit.json'), 'utf8');
  return { json: JSON.parse(jsonText), jsonText, md: readFileSync(join(out, 'audit.md'), 'utf8'), stdout: res.stdout };
}

function gitRead(dir, ...args) {
  const r = spawnSync('git', ['--no-optional-locks', '-C', dir, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

// ---- fixtures ----

function verifyAt(head, extra = {}) {
  return {
    checkout: '/home/x/proj-wt/feat',
    branch: 'feat',
    head,
    results: [{ group: 'test', command: 'npm test zqcmd', exit: 0, log: '/tmp/pl/1.log', tail: 'ok zqtail' }],
    ok: true,
    clean: true,
    tracked_before: [],
    tracked_after: [],
    untracked_before: [],
    untracked_after: [],
    ...extra,
  };
}

// A repo with the run's start point p0, the task commits a1 and a2 and a
// final fix; extra files go in a1's commit.
function repoRun({ a1File = 'a1.txt' } = {}) {
  const { dir, shas } = makeRepo(1);
  const p0 = shas[0];
  const a1 = commit(dir, a1File);
  const a2 = commit(dir, 'a2.txt');
  const fix = commit(dir, 'fix.txt');
  return { dir, p0, a1, a2, fix };
}

const setup = (head) => ({ task: '_run', event: 'run_started', phase: 'setup', head, plan_sha256: PLAN_SHA, spec_sha256: SPEC_SHA });
const reviewed = (task, head, rounds = 1) => ({ task, event: 'reviewed', rounds, brief_sha256: SECTION[task], head, spec_sha256: SPEC_SHA });
const usage = { type: 'assistant', timestamp: '2025-10-09T09:00:00.000Z', message: { id: 'm1', model: 'claude-sonnet-4-5', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } } };

// An accepted run: A1 is p0..a1 and A2 a1..a2, both reviewed; the lenses saw
// a2 and the final re-review the fix, which was delivered; the verify
// evidence is clean, matches and was written during the launch.
function acceptedSpec(r, o = {}) {
  const delivered = r.fix;
  const verify = o.verify || verifyAt(delivered);
  const evidence = `${LEDGER}/checks/verify-${delivered}.json`;
  const a2Head = o.a2Head || r.a2;
  const result = {
    version: '1.5.1',
    status: 'complete',
    run_id: 't1',
    tasks: { A1: { status: 'done', commits: [r.p0, r.a1], notes: '' }, A2: { status: 'done', commits: [r.a1, a2Head], notes: '' } },
    preflight: { undeclared: [] },
    stopped_lanes: [],
    final: {
      findings: [], fixed: [], declined: [], open: [], cannot_verify: [], missing_lenses: [], head: r.fix,
      lens_heads: [{ lens: 'superpowers', head: r.a2 }], task_minors_open: [],
    },
    verify,
    e2e: null,
    delivered_sha: delivered,
    acceptance: { status: 'accepted', delivered_sha: delivered, reasons: [], warnings: [] },
    ...(o.result || {}),
  };
  return {
    ledger: {
      '_run.jsonl': [setup(o.start || r.p0), ...(o.runEvents || []),
        { task: '_run', event: 'run_ended', status: 'complete', agents: 7, rulings: 0 }],
      'a.jsonl': [
        { task: 'A1', event: 'started', base: r.p0 },
        { task: 'A1', event: 'committed', commits: [r.a1], base: r.p0, head: r.a1 },
        reviewed('A1', r.a1, 2),
        { task: 'A2', event: 'started', base: r.a1 },
        { task: 'A2', event: 'committed', commits: [a2Head], base: r.a1, head: a2Head },
        reviewed('A2', a2Head),
        ...(o.taskEvents || []),
      ],
    },
    launches: [{
      wf: 'wf_aaaaaa',
      startTime: START,
      durationMs: DURATION,
      args: { notes: {} },
      result,
      journal: [
        { label: 'A1 implement', result: { status: 'DONE' } },
        { label: 'A1 review', result: { verdict: 'changes', findings: [{ severity: 'important', issue: 'fix it zqprompt' }] } },
        { label: 'A1 re-review 1', result: { verdict: 'approve', findings: [] } },
        { label: 'A2 implement', result: { status: 'DONE' } },
        { label: 'A2 review', result: { verdict: 'approve', findings: [] } },
        { label: 'final review superpowers', result: { head: r.a2, findings: [] } },
        { label: 'final re-review', result: { head: r.fix, results: [], new_findings: [] } },
      ],
      agents: [
        { label: 'A1 implement', model: 'sonnet', lines: [{ type: 'user', message: { role: 'user', content: 'do it zqprompt' } }, usage] },
        { label: 'A1 review', model: 'sonnet', lines: [usage] },
        { label: 'A2 implement', model: 'sonnet', lines: [usage] },
      ],
      ...(o.launch || {}),
    }],
    files: {
      [`${LEDGER}/briefs/A1.md`]: 'brief A1\n',
      [`${LEDGER}/briefs/A2.md`]: 'brief A2\n',
      [`${LEDGER}/reviews/A1-r1.md`]: 'package\n',
      [`${LEDGER}/reviews/A2-r1.md`]: 'package\n',
      [evidence]: JSON.stringify(o.evidence || verify),
      ...(o.files || {}),
    },
    mtimes: { [evidence]: o.evidenceMtime === undefined ? START / 1000 + 60 : o.evidenceMtime },
    ...(o.run || {}),
  };
}

const byTask = (json) => Object.fromEntries(json.tasks.map((t) => [t.id, t]));

// The lines of an audit.md section (from its heading to the next), blank
// lines left out.
function mdSection(md, heading) {
  const lines = md.split('\n');
  const start = lines.indexOf(`## ${heading}`);
  assert.ok(start >= 0, `no ## ${heading}: ${md}`);
  const next = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  return lines.slice(start + 1, next < 0 ? lines.length : next).filter((l) => l !== '');
}

// The lines of one task's block in audit.md (from its '### Task <id> ('
// heading to the next heading), blank lines left out.
function taskBlock(md, id) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`### Task ${id} (`));
  assert.ok(start >= 0, `no task block ${id}: ${md}`);
  const next = lines.findIndex((l, i) => i > start && l.startsWith('#'));
  return lines.slice(start + 1, next < 0 ? lines.length : next).filter((l) => l !== '');
}

// Why an open minor is under Open work only (audit.md).
const UNPLACED = 'each id names a batch unit, no task, or more than one task';

// audit.md before its Terms section, the fixed text that names every label.
function beforeTerms(md) {
  const at = md.indexOf('\n## Terms\n');
  return at < 0 ? md : md.slice(0, at + 1);
}

// ---- the source walker ----

function jsonPointer(doc, pointer) {
  let node = doc;
  for (const raw of pointer.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(node) && /^\d+$/.test(key) && Number(key) < node.length) node = node[Number(key)];
    else if (node !== null && typeof node === 'object' && !Array.isArray(node) && Object.hasOwn(node, key)) node = node[key];
    else return false;
  }
  return true;
}

function transcriptLabels(folder, wf) {
  const labels = new Set();
  const dir = join(folder, wf);
  if (!existsSync(dir)) return labels;
  const journal = join(dir, 'journal.jsonl');
  if (existsSync(journal)) {
    for (const line of readFileSync(journal, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const e = JSON.parse(line);
      if (e.type === 'started') labels.add(e.label);
    }
  }
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.meta.json')) labels.add(JSON.parse(readFileSync(join(dir, name), 'utf8')).description);
  }
  return labels;
}

// Every source in the audit resolves; returns the number checked.
function walkSources(folder, json, repo = null) {
  const problems = [];
  let checked = 0;
  const check = (s, state, where) => {
    checked += 1;
    const absentOk = state === 'missing' || state === 'unavailable';
    const fail = (why) => problems.push(`${where}: ${JSON.stringify(s)}: ${why}`);
    if (typeof s.path !== 'string' || !s.path) return fail('no path');
    if (s.path.startsWith('git:')) {
      const sha = s.path.slice(4);
      if (s.at !== null && s.at !== sha) fail('at is not the sha');
      if (!repo) return fail('a git source without a repo');
      const r = spawnSync('git', ['--no-optional-locks', '-C', repo, 'cat-file', '-e', `${sha}^{commit}`]);
      if (r.status !== 0 && !absentOk) fail('no such commit');
      return undefined;
    }
    if (s.path.startsWith('transcript:')) {
      const rest = s.path.slice('transcript:'.length);
      const wf = rest.slice(0, rest.indexOf('/'));
      const label = rest.slice(rest.indexOf('/') + 1);
      if (!existsSync(join(folder, `${wf}.json`)) && !existsSync(join(folder, wf))) return fail('no such launch');
      if (!transcriptLabels(folder, wf).has(label)) fail('no such label');
      return undefined;
    }
    const path = join(folder, ...s.path.split('/'));
    if (!existsSync(path)) {
      if (!absentOk) fail('no such file');
      return undefined;
    }
    if (typeof s.at === 'string' && /^L\d+$/.test(s.at)) {
      const text = readFileSync(path, 'utf8');
      const lines = text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
      const n = Number(s.at.slice(1));
      if (n < 1 || n > lines) fail(`line ${n} is not within ${lines} lines`);
    } else if (typeof s.at === 'string' && s.at.startsWith('#/')) {
      if (!jsonPointer(JSON.parse(readFileSync(path, 'utf8')), s.at) && !absentOk) fail('the pointer does not resolve');
    } else if (s.at !== null && s.at !== undefined) {
      fail('unknown locator');
    }
    return undefined;
  };
  const walk = (node, where) => {
    if (Array.isArray(node)) {
      node.forEach((x, i) => walk(x, `${where}/${i}`));
    } else if (node !== null && typeof node === 'object') {
      if (Array.isArray(node.sources)) {
        const state = typeof node.state === 'string' ? node.state : null;
        node.sources.forEach((s) => check(s, state, where));
      }
      for (const [k, v] of Object.entries(node)) if (k !== 'sources') walk(v, `${where}/${k}`);
    }
  };
  walk({ repo: json.repo, run: json.run, tasks: json.tasks }, '#');
  assert.deepEqual(problems, []);
  return checked;
}

// ---- tests ----

test('an accepted run with a repo', () => {
  const r = repoRun();
  const folder = makeRun(acceptedSpec(r));
  const { json, md, stdout } = view(folder, ['--repo', r.dir]);
  assert.equal(json.audit_version, 2);
  assert.deepEqual(Object.keys(json), ['audit_version', 'run_id', 'repo', 'run', 'tasks', 'gaps', 'gap_causes']);
  assert.deepEqual(json.gap_causes, []);
  assert.equal(json.run_id, 't1');
  assert.equal(json.run.acceptance.verdict.value, 'accepted');
  assert.equal(json.run.acceptance.gate, 'match');
  assert.equal(json.run.checks.evidence.value, 'valid');
  assert.equal(json.run.facts, undefined);
  const tasks = byTask(json);
  for (const id of ['A1', 'A2']) {
    for (const field of ['committed', 'reviewed', 'verified', 'accepted']) {
      assert.deepEqual([tasks[id].status[field].value, tasks[id].status[field].state], [true, 'present'], `${id} ${field}`);
    }
  }
  assert.deepEqual(json.gaps, []);
  assert.equal(md.split('\n')[0], FIRST_LINE);
  // The Bottom line follows the title; Terms ends the file.
  assert.deepEqual(md.split('\n').filter((l) => l.startsWith('## ')), ['## Bottom line', '## Summary', '## Acceptance',
    '## Launches', '## Tasks', '## Code outside recorded task ranges', '## Checks', '## Open work', '## Evidence gaps',
    '## Terms']);
  assert.deepEqual(md.split('\n').slice(2, 5), ['# Audit of run t1', '', '## Bottom line']);
  assert.deepEqual(mdSection(md, 'Bottom line'), [
    'Verdict: accepted.',
    'Tasks: committed 2, reviewed 2, verified 2, accepted 2 of 2.',
    'Final findings: 0 open, 0 declined; open task minors: 0; cannot-verify items: 0.',
    'Code outside recorded task ranges: 1 commit(s), 0 without review evidence.',
    '0 evidence gap(s) in 0 cause(s) (cannot-verify items and inferred lines are not gaps).',
  ]);
  assert.ok(stdout.split('\n').includes('open work: 0 task(s), 0 open and 0 declined final finding(s), 0 open task minor(s)'),
    stdout);
  assert.ok(stdout.split('\n').includes('tasks: 2; committed 2, reviewed 2, verified 2, accepted 2'), stdout);
  // No open minor: no task block has a line and Open work adds no note.
  assert.doesNotMatch(md, /^- open minors|^- open task minors/m);
  assert.doesNotMatch(md, /^## After delivery$/m);
  assert.match(md, /^### Task A1/m);
  assert.match(md, /^### Task A2/m);
  // The summary: at most 10 lines, the last naming audit.md.
  const lines = stdout.trimEnd().split('\n');
  assert.ok(lines.length <= 10, stdout);
  assert.match(lines[lines.length - 1], /^full report: .*audit\.md$/);
  assert.ok(existsSync(lines[lines.length - 1].slice('full report: '.length)));
  assert.match(stdout, /verdict accepted/);
  assert.ok(lines.includes('0 evidence gap(s) in 0 cause(s)'), stdout);
  assert.deepEqual(mdSection(md, 'Evidence gaps'), ['0 evidence gap(s) in 0 cause(s)']);
  // --json prints the same document.
  const res = audit(folder, ['--repo', r.dir, '--json']);
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), json);
  // The hand-back's --head at the delivered sha adds no gap.
  const atTip = view(folder, ['--repo', r.dir, '--head', r.fix]).json;
  assert.deepEqual(atTip.gaps, []);
  assert.deepEqual([atTip.run.after_delivery.state, atTip.run.after_delivery.value.commits], ['present', []]);
});

test('every source resolves', () => {
  const r = repoRun();
  const folder = makeRun(acceptedSpec(r));
  const { json } = view(folder, ['--repo', r.dir, '--head', 'main']);
  assert.ok(walkSources(folder, json, r.dir) > 40);
  // Gaps may point at absent evidence, which the walker allows by state.
  const legacy = makeRun({
    ledger: { 'a.jsonl': [{ task: 'A1', event: 'committed', commits: [S('b')] }, { task: 'A1', event: 'reviewed', rounds: 0 }] },
    launches: [{ wf: 'wf_old', startTime: START, durationMs: DURATION, result: { tasks: { A1: { status: 'done', commits: [S('a'), S('b')] } } }, dirless: true }],
  });
  walkSources(legacy, view(legacy).json);
});

test('late evidence gives accepted (gate unavailable)', () => {
  const r = repoRun();
  const folder = makeRun(acceptedSpec(r, { evidenceMtime: START / 1000 + DURATION / 1000 + 600 }));
  const { json, md, stdout } = view(folder, ['--repo', r.dir]);
  assert.equal(json.run.acceptance.gate, 'unavailable');
  assert.equal(json.run.checks.gate.value, 'unavailable');
  assert.equal(json.run.checks.gate_reason, 'verify_evidence_time_untrusted');
  assert.equal(json.run.acceptance.verdict.value, 'accepted (gate unavailable)');
  const tasks = byTask(json);
  assert.deepEqual([tasks.A1.status.verified.value, tasks.A1.status.verified.state], [null, 'unavailable']);
  assert.ok(json.gaps.some((g) => g.where === '#/run/checks/gate' && g.state === 'unavailable'));
  // A done task's acceptance is unknown, not false, and a gap.
  for (const [i, id] of [[0, 'A1'], [1, 'A2']]) {
    const a = tasks[id].status.accepted;
    assert.deepEqual([a.value, a.state, a.note], [null, 'unavailable', 'the acceptance gate is unavailable'], id);
    assert.ok(json.gaps.some((g) => g.where === `#/tasks/${i}/status/accepted` && g.state === 'unavailable'), id);
  }
  const line = '- accepted: unknown [unavailable] - the acceptance gate is unavailable (wf_aaaaaa.json #/result/tasks/';
  assert.equal(md.split('\n').filter((l) => l.startsWith(line)).length, 2, md);
  // The summary's tasks line counts as the bottom line does, the unknown ones named.
  const counted = 'tasks: 2; committed 2, reviewed 2, verified 0 (2 unavailable), accepted 0 (2 unavailable)';
  assert.ok(stdout.split('\n').includes(counted), stdout);
  assert.ok(mdSection(md, 'Summary').includes(`- ${counted}`), md);
  // The bottom line names check-verify's reason and the unknown ones.
  assert.deepEqual(mdSection(md, 'Bottom line').slice(0, 2), [
    'Verdict: accepted (gate unavailable: verify_evidence_time_untrusted).',
    'Tasks: committed 2, reviewed 2, verified 0 (2 unavailable), accepted 0 (2 unavailable) of 2.',
  ]);
  // A gate unavailable without a reason from check-verify (no ledger in the
  // archive, so check-verify was not run) keeps the bare verdict.
  const noLedger = view(makeRun(acceptedSpec(r, { run: { ledger: null, files: {}, mtimes: {} } })), ['--repo', r.dir]);
  assert.deepEqual([noLedger.json.run.acceptance.verdict.value, noLedger.json.run.checks.gate_reason],
    ['accepted (gate unavailable)', null]);
  assert.equal(mdSection(noLedger.md, 'Bottom line')[0], 'Verdict: accepted (gate unavailable).');
});

// A verify head before the delivered sha, saved as evidence that matches the
// report: check-verify says match, the evidence rules do not.
function staleVerifyRun() {
  const r = repoRun();
  return { r, folder: makeRun(acceptedSpec(r, { verify: verifyAt(r.a2) })) };
}

test('a match over bad evidence is unverified', () => {
  const { r, folder } = staleVerifyRun();
  const { json, md } = view(folder, ['--repo', r.dir]);
  assert.equal(json.run.acceptance.gate, 'match');
  assert.equal(json.run.checks.evidence.value, 'invalid');
  assert.equal(json.run.checks.rule, 'checks_stale');
  assert.equal(json.run.acceptance.verdict.value, 'unverified');
  assert.equal(json.run.acceptance.verdict_rule, 'checks_stale');
  assert.match(md, /checks_stale/);
  const tasks = byTask(json);
  assert.deepEqual([tasks.A1.status.verified.value, tasks.A1.status.verified.state], [false, 'present']);
  assert.deepEqual([tasks.A1.status.accepted.value, tasks.A1.status.accepted.state], [false, 'present']);
  // Only checks that ran and failed read as failed checks.
  const lines = md.split('\n');
  assert.ok(lines.includes('- evidence: invalid'), md);
  assert.ok(lines.some((l) => l.startsWith('- evidence validity: invalid [stale] - checks_stale')), md);
  assert.ok(lines.includes('- verified: false [present] - the verify evidence is invalid'), md);
  assert.doesNotMatch(beforeTerms(md), /failed checks/);
  assert.equal(mdSection(md, 'Bottom line')[0], 'Verdict: unverified (checks_stale).');
});

test('a verify whose checks failed reads failed checks in audit.md', () => {
  const r = repoRun();
  const failing = verifyAt(r.fix, {
    ok: false,
    results: [{ group: 'test', command: 'npm test zqcmd', exit: 1, log: '/tmp/pl/1.log', tail: 'FAIL zqtail' }],
  });
  const folder = makeRun(acceptedSpec(r, { verify: failing }));
  const { json, md } = view(folder, ['--repo', r.dir]);
  assert.equal(json.run.acceptance.gate, 'match');
  assert.equal(json.run.acceptance.verdict.value, 'unverified');
  // audit.json keeps invalid and its rule.
  assert.equal(json.run.acceptance.evidence, 'invalid');
  assert.deepEqual([json.run.checks.evidence.value, json.run.checks.evidence.state, json.run.checks.rule],
    ['invalid', 'present', 'checks_failed']);
  const lines = md.split('\n');
  assert.ok(lines.includes('- evidence: failed checks (checks_failed)'), md);
  assert.ok(lines.some((l) => l.startsWith('- evidence validity: failed checks [present] - checks_failed (')), md);
  const note = `the verify at ${r.fix.slice(0, 7)} failed (checks_failed)`;
  for (const t of json.tasks) assert.deepEqual([t.status.verified.value, t.status.verified.note], [false, note], t.id);
  assert.equal(lines.filter((l) => l === `- verified: false [present] - ${note}`).length, 2, md);
  assert.doesNotMatch(md, /evidence is invalid|evidence: invalid|validity: invalid/);
  assert.equal(mdSection(md, 'Bottom line')[0], 'Verdict: unverified (checks_failed).');
});

test('audit.md labels transcript verdicts, rulings without a role and lens-covered commits', () => {
  const r = repoRun();
  const folder = makeRun(acceptedSpec(r, {
    taskEvents: [
      { task: 'A1', event: 'ruling', text: 'keep it small' },
      { task: 'A1', event: 'ruling', by: 'adjudicator', text: 'go on' },
    ],
  }));
  const { json, md } = view(folder, ['--repo', r.dir]);
  const lines = beforeTerms(md).split('\n');
  // Review verdicts come from the journal.
  const label = '[inferred: read from the transcript]';
  assert.deepEqual(lines.filter((l) => l.includes(label)), [
    `- A1 review in wf_aaaaaa: changes, 1 finding(s) ${label} (transcript:wf_aaaaaa/A1 review)`,
    `- A1 re-review 1 in wf_aaaaaa: approve, 0 finding(s) ${label} (transcript:wf_aaaaaa/A1 re-review 1)`,
    `- A2 review in wf_aaaaaa: approve, 0 finding(s) ${label} (transcript:wf_aaaaaa/A2 review)`,
  ]);
  // Other inferred lines keep the bare state.
  assert.deepEqual(lines.filter((l) => l.includes('[inferred]')),
    [`- ${r.fix}: final re-review [inferred] (transcript:wf_aaaaaa/final re-review)`]);
  // A ruling without by is the implementer's, as the ledger counts it;
  // audit.json keeps what was recorded.
  assert.ok(lines.includes(`- ruling by implementer (no role recorded), quoted from ${LEDGER}/a.jsonl L7:`), md);
  assert.ok(lines.includes(`- ruling by adjudicator, quoted from ${LEDGER}/a.jsonl L8:`), md);
  assert.doesNotMatch(md, /ruling by unknown/);
  assert.deepEqual(byTask(json).A1.changes.rulings.map((x) => x.value.by), [null, 'adjudicator']);

  // A commit outside the task ranges that a lens head contains names that head.
  const spec = acceptedSpec(r);
  spec.launches[0].result.final.lens_heads = [{ lens: 'superpowers', head: r.fix }];
  const lens = view(makeRun(spec), ['--repo', r.dir]);
  const entry = lens.json.run.code_outside_ranges.value.commits.find((c) => c.commit === r.fix);
  const note = `contained in the final review's head ${r.fix.slice(0, 7)}`;
  assert.deepEqual([entry.coverage.value, entry.coverage.state, entry.coverage.note], ['final review', 'present', note]);
  assert.ok(lens.md.split('\n').includes(
    `- ${r.fix}: final review [present] - ${note} (wf_aaaaaa.json #/result/final/lens_heads/0/head; git:${r.fix})`), lens.md);
});

test('open counts add the open task minors and the carried ones', () => {
  const r = repoRun();
  const minor = (id) => ({ id, task: id.split('-')[0], severity: 'minor', file: 'a1.txt', line: 1, issue: 'nit', fix: 'x' });
  // The engine's note on a resume whose earlier tasks' minors no snapshot covers.
  const earlier = 'the minor findings of the task reviews an earlier launch approved (A1) did not reach the final'
    + " lenses or task_minors_open: no carried snapshot covers them; read those tasks' approved reviews in the"
    + " earlier launch's report";
  const finalWith = (extra) => ({
    findings: [], fixed: [], declined: [], cannot_verify: [], missing_lenses: [], head: r.fix,
    lens_heads: [{ lens: 'superpowers', head: r.a2 }],
    open: [{ id: 'F1', lens: 'security', severity: 'important', file: 'a1.txt', line: 1, issue: 'bad' }],
    ...extra,
  });
  // The final value in audit.json, the Summary's and stdout's open work
  // lines, the Open work header, the bottom line's final review line, each
  // task block's open minors line and Open work's notes on the minors.
  const counts = (final) => {
    const { json, md, stdout } = view(makeRun(acceptedSpec(r, { result: { final } })), ['--repo', r.dir]);
    return {
      final: json.run.open_work.final.value,
      summary: md.split('\n').find((l) => l.startsWith('- open work: ')),
      stdout: stdout.split('\n').find((l) => l.startsWith('open work: ')),
      header: mdSection(md, 'Open work').find((l) => l.startsWith('- final review: ')),
      // The entries under the header that name a minor (ids A1-1, T9-1 ...).
      listed: mdSection(md, 'Open work').filter((l) => /^ {2}- [A-Z]\d-\d open/.test(l)).map((l) => l.replace(/ \(A\d.*$/, '')),
      bottom: mdSection(md, 'Bottom line').find((l) => /^Final (findings|review)/.test(l)),
      blocks: Object.fromEntries(['A1', 'A2'].map((id) => [id, taskBlock(md, id).filter((l) => /open minors/.test(l))])),
      notes: mdSection(md, 'Open work').filter((l) => l.startsWith('- open task minors')),
      md,
    };
  };
  const declined = [{ id: 'F2', severity: 'minor', file: 'a1.txt', line: 2, issue: 'meh', reason: 'not needed' }];

  // The task minors no final lens raised plus the carried ones.
  const both = counts(finalWith({ task_minors_open: [minor('A1-1'), minor('A2-1')], carried_minors_open: ['T9-1'], declined }));
  assert.deepEqual(both.final.task_minors_open.map((f) => f.id), ['A1-1', 'A2-1']);
  assert.deepEqual(both.final.carried_minors_open, ['T9-1']);
  const three = '1 open and 1 declined final finding(s), 3 open task minor(s)';
  assert.equal(both.summary, `- open work: 0 task(s), ${three}`);
  assert.equal(both.stdout, `open work: 0 task(s), ${three}`);
  assert.equal(both.header, `- final review: ${three} [present] (wf_aaaaaa.json #/result/final)`);
  assert.equal(both.bottom, 'Final findings: 1 open, 1 declined; open task minors: 3; cannot-verify items: 0.');
  // Under the header: the task minors, then the carried ids as recorded.
  assert.deepEqual(both.listed, ['  - A1-1 open', '  - A2-1 open', '  - T9-1 open (carried minor)']);
  // Each task block ends with the ids its prefix places there; T9 names no
  // task, so T9-1 is under Open work only.
  assert.deepEqual(both.blocks, { A1: ['- open minors: A1-1'], A2: ['- open minors: A2-1'] });
  assert.equal(taskBlock(both.md, 'A1').at(-1), '- open minors: A1-1');
  assert.deepEqual(both.notes, [`- open task minors in no task block: T9-1 (${UNPLACED})`]);

  // The engine's note makes the count a lower bound: a task with no line
  // has none listed, said once under Open work.
  const lower = counts(finalWith({ task_minors_open: [minor('A2-1')], carried_minors_open: [], cannot_verify: [earlier] }));
  const listed = '1 open and 0 declined final finding(s), 1 open task minor(s) listed (more may be missing)';
  assert.equal(lower.summary, `- open work: 0 task(s), ${listed}`);
  assert.equal(lower.stdout, `open work: 0 task(s), ${listed}`);
  assert.equal(lower.header, `- final review: ${listed} [present] (wf_aaaaaa.json #/result/final)`);
  assert.equal(lower.bottom,
    'Final findings: 1 open, 0 declined; open task minors: 1 listed (more may be missing); cannot-verify items: 1.');
  assert.deepEqual(lower.blocks, { A1: [], A2: ['- open minors: A2-1'] });
  assert.deepEqual(lower.notes, ['- open task minors: a task block with no open minors line has none listed; more may be'
    + ' missing: minors of tasks an earlier launch approved']);
  assert.doesNotMatch(lower.md, /at least/);

  // An engine before carried minors counts its task minors alone.
  const older = counts(finalWith({ task_minors_open: [minor('A1-1')] }));
  assert.equal(older.final.carried_minors_open, null);
  assert.equal(older.stdout, 'open work: 0 task(s), 1 open and 0 declined final finding(s), 1 open task minor(s)');
  assert.deepEqual(older.blocks, { A1: ['- open minors: A1-1'], A2: [] });
  assert.deepEqual(older.notes, []);

  // An older engine's final records no open list: its count is unavailable,
  // never 0.
  const noOpen = counts(finalWith({ open: undefined, declined, task_minors_open: [] }));
  assert.deepEqual(noOpen.final.not_recorded, ['open']);
  assert.equal(noOpen.header,
    '- final review: unavailable open and 1 declined final finding(s), 0 open task minor(s) [present] (wf_aaaaaa.json #/result/final)');
  assert.equal(noOpen.bottom, 'Final findings: unavailable open, 1 declined; open task minors: 0; cannot-verify items: 0.');

  // Neither key: unavailable, never 0; Open work says once that the engine
  // recorded none, and no task block has a line.
  const none = counts(finalWith({}));
  assert.deepEqual([none.final.task_minors_open, none.final.carried_minors_open], [null, null]);
  const unknown = '1 open and 0 declined final finding(s), unavailable open task minor(s)';
  assert.equal(none.summary, `- open work: 0 task(s), ${unknown}`);
  assert.equal(none.stdout, `open work: 0 task(s), ${unknown}`);
  assert.equal(none.header, `- final review: ${unknown} [present] (wf_aaaaaa.json #/result/final)`);
  assert.equal(none.bottom, 'Final findings: 1 open, 0 declined; open task minors: unavailable; cannot-verify items: 0.');
  assert.deepEqual(none.blocks, { A1: [], A2: [] });
  assert.deepEqual(none.notes, ["- open task minors: not recorded by this run's engine"]);
  assert.equal(none.md.split('not recorded').length, 2, none.md);

  // No final review: every count is unavailable, and Open work says why.
  const noFinal = counts(undefined);
  const neither = 'unavailable open and unavailable declined final finding(s), unavailable open task minor(s)';
  assert.equal(noFinal.summary, `- open work: 0 task(s), ${neither}`);
  assert.equal(noFinal.stdout, `open work: 0 task(s), ${neither}`);
  assert.equal(noFinal.header,
    `- final review: ${neither} [unavailable] - the latest launch has no final review result (wf_aaaaaa.json #/result)`);
  assert.equal(noFinal.bottom, 'Final review unavailable; open task minors: unavailable; cannot-verify items: unavailable.');
  assert.deepEqual(noFinal.blocks, { A1: [], A2: [] });
  assert.deepEqual(noFinal.notes, ['- open task minors: no final review']);
  assert.doesNotMatch(noFinal.md, /not recorded/);
});

test('each task block lists its open minors by id prefix; a batch unit or no task stays under Open work', () => {
  // Tasks A1 and A2, and the numeric 2, T2 and 3 (the engine prefixes a
  // task id that does not start with a letter with T).
  const manifest = {
    lanes: [
      { id: 'a', name: 'Lane a', tasks: [{ id: 'A1', title: 'First' }, { id: 'A2', title: 'Second' }] },
      { id: 'b', name: 'Lane b',
        tasks: [{ id: '2', title: 'Two' }, { id: 'T2', title: 'T two' }, { id: '3', title: 'Three' }] },
    ],
  };
  const minor = (id) => ({ id, severity: 'minor', file: 'a.txt', line: 1, issue: 'nit', fix: 'x' });
  const final = {
    open: [], declined: [], fixed: [], cannot_verify: [], findings: [],
    // A1-A2 is a batch unit; Z9 names no task; T2 is task T2's exactly; T3
    // is task 3's; 'odd' has no -<n>.
    task_minors_open: ['A1-1', 'A1-2', 'A2-1', 'A1-A2-1', 'Z9-1', 'T2-1', 'T3-1', 'odd'].map(minor),
    carried_minors_open: ['A2-7', 'T9-1', 'T2-5'],
  };
  // The ledger's minors snapshot names T2-5's task (2, which settles the T2
  // that two tasks share) and T9-1's (A2, whose prefix is not T9: ignored).
  const snapshot = {
    task: '_run', event: 'minors', wf: 'wf_aaaaaa', covered: ['2', 'A2'],
    open: [{ id: 'T2-5', task: '2', file: 'a.txt', line: 1, issue: 'i', fix: 'f' },
      { id: 'T9-1', task: 'A2', file: 'a.txt', line: 1, issue: 'i', fix: 'f' }],
  };
  const folder = makeRun({
    manifest,
    ledger: { '_run.jsonl': [snapshot] },
    launches: [{ wf: 'wf_aaaaaa', startTime: START, durationMs: DURATION, result: { tasks: {}, final } }],
  });
  const { json, md } = view(folder);
  assert.deepEqual(json.run.open_work.final.value.carried_minor_tasks, { 'T9-1': 'A2', 'T2-5': '2' });
  const lines = Object.fromEntries(['A1', 'A2', '2', 'T2', '3']
    .map((id) => [id, taskBlock(md, id).filter((l) => /open minors/.test(l))]));
  assert.deepEqual(lines, {
    A1: ['- open minors: A1-1, A1-2'],
    A2: ['- open minors: A2-1, A2-7'],
    2: ['- open minors: T2-5'],
    T2: ['- open minors: T2-1'],
    3: ['- open minors: T3-1'],
  });
  assert.deepEqual(mdSection(md, 'Open work').filter((l) => l.startsWith('- open task minors')),
    [`- open task minors in no task block: A1-A2-1, Z9-1, odd, T9-1 (${UNPLACED})`]);
  // Every minor is still listed with its details under the final review.
  assert.equal(mdSection(md, 'Open work').filter((l) => /^ {2}- \S+ open/.test(l)).length, 11);

  // The placement alone: an exact match wins over T<id>; a task id listed
  // twice is ambiguous; the snapshot chooses only among the prefix's tasks.
  const place = pythonJSON([
    'import _audit',
    'cases = json.loads(sys.argv[1])',
    'print(json.dumps([_audit._minor_task(*c) for c in cases]))',
  ], [JSON.stringify([
    ['T2-1', ['2', 'T2'], null], ['T2-1', ['2'], null], ['T2-1', ['T2'], null], ['T2-1', ['2', 'T2'], '2'],
    ['A1-1', ['A1', 'A1'], null], ['A1-A2-1', ['A1', 'A2'], 'A1'], ['T9-1', ['A2'], 'A2'], ['x', ['x'], null],
    [null, ['A1'], null], ['TA1-1', ['A1'], null], ['T2-12', ['2'], null],
  ])]);
  assert.deepEqual(place, ['T2', '2', 'T2', '2', null, null, null, null, null, null, '2']);
});

test('the bottom line says what is unavailable and invents nothing', () => {
  // Like sh1: the ledger records a launch the archive lacks; A1 was
  // committed and reviewed, A2 is blocked.
  const ended = { task: '_run', event: 'run_ended', status: 'complete', agents: 3, rulings: 0 };
  const folder = makeRun({
    ledger: {
      '_run.jsonl': [setup(S('0')), ended],
      'a.jsonl': [
        { task: 'A1', event: 'started', base: S('0') },
        { task: 'A1', event: 'committed', commits: [S('1')], base: S('0'), head: S('1') },
        reviewed('A1', S('1')),
        { task: 'A2', event: 'blocked', reason: 'stuck zqblocked' },
      ],
    },
  });
  const { json, md } = view(folder);
  const bottom = mdSection(md, 'Bottom line');
  assert.deepEqual(bottom, [
    'Verdict: unavailable (no launch).',
    'Tasks: committed 1, reviewed 1, verified 0 (2 unavailable), accepted 0 (2 unavailable) of 2; 1 blocked.',
    'Final review unavailable; open task minors: unavailable; cannot-verify items: unavailable.',
    'Code outside recorded task ranges: unavailable (no --repo).',
    'Launches missing from the archive: 1 of 1 recorded.',
    `${json.gaps.length} evidence gap(s) in ${json.gap_causes.length} cause(s) (cannot-verify items and inferred lines are not gaps).`,
  ]);
  assert.ok(json.gap_causes.length > 0 && json.gap_causes.length < json.gaps.length);
  assert.ok(json.gaps.length > 0);
  assert.doesNotMatch(bottom.join('\n'), /zqblocked/);

  // A launch without a start: the launch order is unknown.
  const unordered = view(makeRun({
    launches: [{ wf: 'wf_a', durationMs: DURATION, result: {
      acceptance: { status: 'accepted', reasons: [], warnings: [] },
      final: { open: [], declined: [], cannot_verify: [], task_minors_open: [] },
    } }],
  }));
  assert.deepEqual(mdSection(unordered.md, 'Bottom line').slice(0, 4), [
    'Verdict: unavailable (launch order unknown).',
    'Tasks: committed 0, reviewed 0, verified 0 (2 unavailable), accepted 0 (2 unavailable) of 2.',
    'Final review unavailable; open task minors: unavailable; cannot-verify items: unavailable.',
    'Code outside recorded task ranges: unavailable (no --repo).',
  ]);

  // ledger status fails on a line that is not JSON: the blocked and
  // deferred tasks are unknown, not none.
  const broken = view(makeRun({ ledger: { 'a.jsonl': [{ task: 'A2', event: 'blocked', reason: 'stuck' }, 'not json'] } }));
  assert.equal(broken.json.run.open_work.ledger_state.state, 'unavailable');
  assert.equal(mdSection(broken.md, 'Bottom line')[1],
    'Tasks: committed 0, reviewed 0, verified 0 (2 unavailable), accepted 0 (2 unavailable) of 2; blocked and deferred unknown.');
  // The Summary, stdout and Open work give no 0 and no none for them.
  const neither = 'unavailable open and unavailable declined final finding(s), unavailable open task minor(s)';
  const openLine = `open work: unknown (ledger status unavailable), ${neither}`;
  assert.ok(mdSection(broken.md, 'Summary').includes(`- ${openLine}`), broken.md);
  assert.ok(broken.stdout.split('\n').includes(openLine), broken.stdout);
  const held = mdSection(broken.md, 'Open work').filter((l) => l.startsWith('- blocked or deferred tasks: '));
  assert.deepEqual(held, ['- blocked or deferred tasks: unknown']);
  // A ledger status that worked keeps the count and none.
  assert.ok(unordered.stdout.split('\n').includes(`open work: 0 task(s), ${neither}`), unordered.stdout);
  assert.ok(mdSection(unordered.md, 'Open work').includes('- blocked or deferred tasks: none'), unordered.md);
  // Its one launch has a final review that audit cannot pick as the latest:
  // the header gives the reason, and no line says there is none or that the
  // engine recorded none.
  const unorderedOpen = mdSection(unordered.md, 'Open work');
  assert.ok(unorderedOpen.some((l) => l.startsWith('- final review: ') && l.includes('[unavailable] - launch order unknown')),
    unordered.md);
  assert.deepEqual(unorderedOpen.filter((l) => l.startsWith('- open task minors')), []);
  assert.doesNotMatch(unordered.md, /no final review|not recorded/);
});

test('the bottom line gives the engine\'s reasons for its own verdict', () => {
  const r = repoRun();
  const acceptance = {
    status: 'unverified', delivered_sha: r.fix, warnings: [],
    reasons: [{ kind: 'checks_stale', class: 'missing', detail: 'stale zqdetail' },
      { kind: 'final_fix_unreviewed', class: 'missing', detail: 'unreviewed zqdetail' },
      { kind: 'checks_stale', class: 'missing', detail: 'again zqdetail' }],
  };
  const { json, md } = view(makeRun(acceptedSpec(r, { result: { acceptance } })), ['--repo', r.dir]);
  assert.deepEqual([json.run.acceptance.verdict.value, json.run.acceptance.verdict_rule], ['unverified', null]);
  const bottom = mdSection(md, 'Bottom line');
  assert.equal(bottom[0], 'Verdict: unverified (checks_stale, final_fix_unreviewed).');
  assert.doesNotMatch(bottom.join('\n'), /zqdetail/);
});

test('the bottom line names a user override at the delivered head, never its text', () => {
  const r = repoRun();
  const failing = verifyAt(r.fix, {
    ok: false,
    results: [{ group: 'test', command: 'npm test zqcmd', exit: 1, log: '/tmp/pl/1.log', tail: 'FAIL zqtail' }],
  });
  const accept = (head) => ({ task: '_run', event: 'accepted', head, text: 'ship it zqoverride' });
  const unverified = {
    status: 'unverified', delivered_sha: r.fix, warnings: [],
    reasons: [{ kind: 'checks_failed', class: 'failed', detail: 'failing zqdetail' }],
  };
  const overridden = makeRun(acceptedSpec(r, { verify: failing, result: { acceptance: unverified }, runEvents: [accept(r.fix)] }));
  const { json, md } = view(overridden, ['--repo', r.dir]);
  assert.equal(json.run.acceptance.verdict.value, 'accepted by user');
  assert.equal(json.run.acceptance.overrides[0].overrode, 'unverified: checks_failed');
  const bottom = mdSection(md, 'Bottom line');
  // The verdict already says it and names what the user overrode (the run's
  // verdict and reason kinds); the override's text is never shown.
  assert.deepEqual(bottom.slice(0, 2), [
    'Verdict: accepted by user (over unverified: checks_failed).',
    'Tasks: committed 2, reviewed 2, verified 0, accepted 2 of 2.',
  ]);
  assert.doesNotMatch(bottom.join('\n'), /zqoverride|zqdetail/);
  // Without what it overrode, the verdict stands alone.
  const bare = pythonJSON([
    'import _audit',
    'a = _audit.build(sys.argv[1], repo=sys.argv[2])',
    'for o in a["run"]["acceptance"]["overrides"]:',
    '    o["overrode"] = None',
    'md = _audit.render_md(a).split("\\n")',
    'print(json.dumps(md[md.index("## Bottom line") + 2]))',
  ], [overridden, r.dir]);
  assert.equal(bare, 'Verdict: accepted by user.');
  // A result without an acceptance object: the verdict is unavailable, the
  // override at the delivered sha still in effect. Its note has its own
  // parenthesis, so it follows '; '.
  const older = view(makeRun(acceptedSpec(r, { result: { acceptance: undefined }, runEvents: [accept(r.fix)] })),
    ['--repo', r.dir]);
  assert.equal(older.json.run.acceptance.verdict.value, 'unavailable');
  assert.equal(mdSection(older.md, 'Bottom line')[0],
    'Verdict: unavailable; no acceptance object (an older engine); accepted by the user at the delivered head.');
  // An override at another head is not in effect.
  const stale = view(makeRun(acceptedSpec(r, { verify: failing, runEvents: [accept(r.a2)] })), ['--repo', r.dir]);
  assert.equal(stale.json.run.acceptance.verdict.value, 'unverified');
  assert.equal(mdSection(stale.md, 'Bottom line')[0], 'Verdict: unverified (checks_failed).');
  // The engine's own verdict is the one the override overrode: the
  // no-override verdict is the same, so the run's reason kinds stay.
  assert.deepEqual([json.run.acceptance.verdict_without_override, json.run.acceptance.verdict_rule_without_override],
    ['unverified', null]);
});

test('the bottom line names the fault audit found that an override overrode', () => {
  const r = repoRun();
  const accept = { task: '_run', event: 'accepted', head: r.fix, text: 'ship it zqoverride' };
  // The run said accepted; the saved evidence disagrees with its verify
  // report, so check-verify says mismatch and audit would say unverified.
  const mismatch = view(makeRun(acceptedSpec(r, { evidence: verifyAt(r.fix, { ok: false }), runEvents: [accept] })),
    ['--repo', r.dir]);
  const a = mismatch.json.run.acceptance;
  assert.deepEqual([a.verdict.value, a.gate, a.verdict_rule, a.verdict_without_override, a.verdict_rule_without_override],
    ['accepted by user', 'mismatch', null, 'unverified', 'gate mismatch']);
  assert.equal(a.overrides[0].overrode, 'accepted');
  assert.equal(mdSection(mismatch.md, 'Bottom line')[0], 'Verdict: accepted by user (over unverified: gate mismatch).');
  // Acceptance keeps what the override overrode, the run's own verdict.
  assert.ok(mismatch.md.split('\n').some((l) => l.startsWith('- user override at: ') && l.endsWith('; it overrode accepted')),
    mismatch.md);
  // Late evidence: audit would say accepted (gate unavailable), with
  // check-verify's reason inside its parenthesis.
  const late = makeRun(acceptedSpec(r, { evidenceMtime: START / 1000 + DURATION / 1000 + 600, runEvents: [accept] }));
  const lateView = view(late, ['--repo', r.dir]);
  assert.deepEqual([lateView.json.run.acceptance.verdict_without_override, lateView.json.run.acceptance.verdict_rule_without_override],
    ['accepted (gate unavailable)', null]);
  assert.equal(mdSection(lateView.md, 'Bottom line')[0],
    'Verdict: accepted by user (over accepted (gate unavailable: verify_evidence_time_untrusted)).');
  // Without a gate reason the no-override verdict stands bare.
  const bare = pythonJSON([
    'import _audit',
    'a = _audit.build(sys.argv[1], repo=sys.argv[2])',
    'a["run"]["checks"]["gate_reason"] = None',
    'md = _audit.render_md(a).split("\\n")',
    'print(json.dumps(md[md.index("## Bottom line") + 2]))',
  ], [late, r.dir]);
  assert.equal(bare, 'Verdict: accepted by user (over accepted (gate unavailable)).');
  assert.doesNotMatch(mdSection(mismatch.md, 'Bottom line').join('\n') + mdSection(lateView.md, 'Bottom line').join('\n'),
    /zqoverride/);
});

test('audit.md ends with its terms', () => {
  const r = repoRun();
  const accepted = view(makeRun(acceptedSpec(r)), ['--repo', r.dir]).md;
  const empty = view(makeRun({})).md;
  const terms = mdSection(accepted, 'Terms');
  // Fixed text, the last section of every audit.md.
  assert.deepEqual(mdSection(empty, 'Terms'), terms);
  for (const md of [accepted, empty]) {
    assert.equal(md.split('\n').filter((l) => l.startsWith('## ')).at(-1), '## Terms');
    assert.ok(md.endsWith(`${terms.at(-1)}\n`));
  }
  const named = terms.map((l) => {
    const m = /^- (\[[^\]]+\]|[^:[]+): \S/.exec(l);
    assert.ok(m, l);
    return m[1];
  });
  assert.deepEqual(named, [
    '[present]', '[missing]', '[stale]', '[conflicting]', '[unavailable]', '[inferred]',
    '[inferred: read from the transcript]', 'invalid', 'round(s)', 'task rulings', 'run-end rulings', 'gate', 'carry',
    'context added by pre-flight', 'cause',
  ]);
  assert.equal(terms.at(-1), '- cause: gaps that share a pointer (each array index read as N), a state and a note (each '
    + 'sha read as <sha>; the first note is shown), listed once under Evidence gaps with the tasks whose blocks hold '
    + 'them, or with run and every value for a run-level cause.');
  // The four gap states say they are gaps; the others say they are not.
  for (const l of terms.slice(0, 7)) {
    const gap = /^- \[(missing|stale|conflicting|unavailable)\]/.test(l);
    assert.ok(l.endsWith(gap ? 'An evidence gap.' : 'Not a gap.'), l);
  }
  // A present value may name no source; an unavailable one may show a value
  // whose comparison is missing.
  assert.ok(terms[0].startsWith('- [present]: the value is established (from the sources named after it, when there are any).'),
    terms[0]);
  assert.ok(terms[4].startsWith('- [unavailable]: the value, or the comparison it needs, cannot be read or derived'), terms[4]);
});

test('a verify head that is not delivered is stale', () => {
  const { r, folder } = staleVerifyRun();
  const { json } = view(folder, ['--repo', r.dir]);
  assert.equal(json.run.checks.verify_head.state, 'stale');
  assert.equal(json.run.checks.verify_head.value, r.a2);
  assert.ok(json.gaps.some((g) => g.where === '#/run/checks/verify_head' && g.state === 'stale'));
});

test('a range not in the repo is missing', () => {
  const r = repoRun();
  const folder = makeRun(acceptedSpec(r, { a2Head: S('c') }));
  const { json } = view(folder, ['--repo', r.dir]);
  const entry = byTask(json).A2.commits.entries[0];
  assert.equal(entry.head, S('c'));
  assert.equal(entry.commits.state, 'missing');
  assert.ok(json.gaps.some((g) => g.where === '#/tasks/1/commits/entries/0/commits' && g.state === 'missing'));
});

test('privacy', () => {
  const r = repoRun();
  const spec = acceptedSpec(r, {
    verify: verifyAt(r.fix, {
      ok: false,
      results: [
        { group: 'test', command: 'npm test zqcmd', exit: 1, log: '/tmp/zqtail/1.log', tail: 'FAIL zqtail' },
        { group: 'test', command: 'ls', exit: 0, log: '/tmp/zqtail/2.log', tail: 'a b zqtail' },
      ],
    }),
    result: {
      acceptance: {
        status: 'rejected',
        delivered_sha: r.fix,
        reasons: [{ kind: 'checks_failed', class: 'failed', detail: 'failing at the head: npm test zqcmd (exit 1), then ls zqreason' }],
        warnings: [],
      },
    },
    taskEvents: [{ task: 'A1', event: 'ruling', by: 'adjudicator', text: 'run pip install zqsetup first, then ls' }],
    files: { [`${LEDGER}/doctor-wf_aaaaaa-001.json`]: JSON.stringify({ launch: { wf: 'wf_aaaaaa' }, doctor: { detail: 'zqdoctor' } }) },
  });
  spec.manifest = { commands: { setup: ['pip install zqsetup'], test: ['npm test zqcmd', 'ls'], lint: [], build: [] } };
  const folder = makeRun(spec);

  // A copy of scripts/ whose check-verify is a decoy printing zqcv.
  const scripts = join(fresh('pl-audit-scripts-'), 'scripts');
  cpSync(SCRIPTS, scripts, { recursive: true });
  writeFileSync(join(scripts, 'check-verify'), [
    'import json, sys',
    'print(json.dumps({"status": "mismatch", "reason": "verify_mismatch", "path": "/zqcv",',
    '                  "differences": [{"field": "zqcv", "reported": {"present": True, "value": "zqcv"}}], "detail": "zqcv"}))',
    'sys.exit(1)',
    '',
  ].join('\n'));
  const { json, jsonText, md, stdout } = view(folder, ['--repo', r.dir], {}, join(scripts, 'audit'));
  assert.equal(json.run.acceptance.gate, 'mismatch');
  assert.equal(json.run.checks.gate_reason, 'verify_mismatch');
  for (const text of [jsonText, md, stdout]) {
    for (const canary of ['zqcmd', 'zqsetup', 'zqprompt', 'zqtail', 'zqcv', 'zqdoctor']) {
      assert.doesNotMatch(text, new RegExp(canary), canary);
    }
  }
  assert.doesNotMatch(stdout, /zqreason/);
  // Configured commands became check ids inside the quotes.
  assert.match(jsonText, /<check:setup#1>/);
  assert.match(jsonText, /<check:test#1>/);
  assert.match(jsonText, /<check:test#2>/);

  // In audit.json, zqreason and every quote live only in "quote" strings,
  // which hold no bare ls.
  const quotes = [];
  const walk = (node, key) => {
    if (typeof node === 'string') {
      if (key === 'quote') quotes.push(node);
      else assert.doesNotMatch(node, /zqreason/, `zqreason outside a quote (key ${key})`);
    } else if (Array.isArray(node)) {
      node.forEach((x) => walk(x, key));
    } else if (node !== null && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, k);
    }
  };
  walk(json, null);
  assert.ok(quotes.some((q) => /zqreason/.test(q)));
  const bareLs = /(^|[^A-Za-z0-9_])ls([^A-Za-z0-9_]|$)/;
  for (const q of quotes) assert.doesNotMatch(q, bareLs, q);
  // In audit.md, zqreason appears only on quote lines, which hold no bare ls.
  const mdLines = md.split('\n');
  const quoteLines = mdLines.filter((l) => /^\s*> /.test(l) || /^\s*>$/.test(l));
  assert.ok(quoteLines.some((l) => /zqreason/.test(l)));
  for (const l of mdLines) if (/zqreason/.test(l)) assert.match(l, /^\s*> /, l);
  for (const l of quoteLines) assert.doesNotMatch(l, bareLs, l);
});

test('Unicode survives', () => {
  // Built from code points, so this source stays ASCII.
  const u = (...codes) => String.fromCodePoint(...codes);
  const name = `na${u(0xef)}ve-${u(0xe9)}t${u(0xe9)}-${u(0x4e2d)}.txt`;
  const ruling = `keep the caf${u(0xe9)} ${u(0xfc)}ber-rule ${u(0x2013)} ${u(0x4e2d, 0x6587)}`;
  const r = repoRun({ a1File: name });
  // Written as the ledger writes it: ASCII, with \u escapes.
  const event = JSON.stringify({ task: 'A1', event: 'ruling', by: 'adjudicator', text: ruling })
    .replace(/[^\x00-\x7f]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
  assert.match(event, /^[\x20-\x7e]+$/);
  const folder = makeRun(acceptedSpec(r, { taskEvents: [event] }));
  const { json, jsonText, md } = view(folder, ['--repo', r.dir]);
  // The real path: ledger status reads the ledger, so the run is not degraded.
  assert.deepEqual(json.gaps.filter((g) => /ledger status/.test(g.note || '')), []);
  assert.deepEqual(json.gaps, []);
  const a1 = byTask(json).A1;
  assert.deepEqual(a1.commits.entries[0].files.value, [name]);
  assert.equal(a1.changes.rulings[0].value.text.quote, ruling);
  for (const text of [jsonText, md]) {
    assert.ok(text.includes(name), 'the file name');
    assert.ok(text.includes(ruling), 'the ruling');
  }
});

// The files under root (relative, '/' separators) with their mtime and
// sha256; dirs too, with their mtime when withDirs.
function tree(root, { skip = [], withDirs = false } = {}) {
  const out = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const rel = relative(root, p).split(sep).join('/');
      if (skip.includes(rel)) continue;
      const st = lstatSync(p);
      if (st.isDirectory()) {
        out[`${rel}/`] = withDirs ? String(st.mtimeMs) : 'dir';
        walk(p);
      } else {
        out[rel] = `${st.mtimeMs} ${sha256(readFileSync(p))}`;
      }
    }
  };
  walk(root);
  return out;
}

function repoState(dir) {
  return {
    refs: gitRead(dir, 'for-each-ref'),
    config: readFileSync(join(dir, '.git', 'config'), 'utf8'),
    head: readFileSync(join(dir, '.git', 'HEAD'), 'utf8'),
    index: sha256(readFileSync(join(dir, '.git', 'index'))),
    status: gitRead(dir, 'status', '--porcelain'),
  };
}

test('audit changes nothing but its output', () => {
  const r = repoRun();
  const folder = makeRun(acceptedSpec(r));
  const active = fresh('pl-audit-active-');
  writeFileSync(join(active, 'r9.lock'), 'held\n');
  const env = { PL_ACTIVE_DIR: active };
  const before = tree(folder);
  const repoBefore = repoState(r.dir);
  const activeBefore = tree(active, { withDirs: true });

  const first = view(folder, ['--repo', r.dir, '--head', 'main'], env);
  assert.deepEqual(tree(folder, { skip: ['audit'] }), before);
  const settled = tree(folder, { skip: ['audit'], withDirs: true });
  const second = view(folder, ['--repo', r.dir, '--head', 'main'], env);
  assert.deepEqual(tree(folder, { skip: ['audit'], withDirs: true }), settled);
  assert.deepEqual(readdirSync(join(folder, 'audit')).sort(), ['audit.json', 'audit.md']);
  assert.equal(second.jsonText, first.jsonText);
  assert.equal(second.md, first.md);
  assert.equal(second.stdout, first.stdout);
  assert.deepEqual(repoState(r.dir), repoBefore);
  assert.deepEqual(tree(active, { withDirs: true }), activeBefore);
});

test('no live paths', () => {
  const r = repoRun();
  const folder = makeRun(acceptedSpec(r));
  const plain = view(folder, ['--repo', r.dir]);

  // A decoy repo and ledger dir, with a plan and spec of the archived names.
  const decoy = makeRepo(2);
  const decoyLedger = join(fresh('pl-audit-decoy-'), 'p.t1.ledger');
  mkdirSync(join(decoyLedger, 'checks'), { recursive: true });
  writeFileSync(join(decoyLedger, 'a.jsonl'), `${JSON.stringify({ task: 'A1', event: 'blocked', reason: 'decoy' })}\n`);
  writeFileSync(join(decoyLedger, 'checks', `verify-${r.fix}.json`), '{"decoy": true}');
  writeFileSync(join(dirname(decoyLedger), 'p.md'), '# Decoy plan\n');
  writeFileSync(join(dirname(decoyLedger), 'p-design.md'), '# Decoy spec\n');
  const manifestPath = join(folder, 'p.lanes.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.repo.root = decoy.dir;
  manifest.repo.worktree_root = decoy.dir;
  manifest.repo.ledger_dir = decoyLedger;
  manifest.plan = join(dirname(decoyLedger), 'p.md');
  manifest.spec = join(dirname(decoyLedger), 'p-design.md');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const decoyBefore = [tree(decoy.dir, { withDirs: true }), tree(dirname(decoyLedger), { withDirs: true })];

  const live = view(folder, ['--repo', r.dir]);
  assert.equal(live.jsonText, plain.jsonText);
  assert.equal(live.md, plain.md);
  assert.deepEqual([tree(decoy.dir, { withDirs: true }), tree(dirname(decoyLedger), { withDirs: true })], decoyBefore);
});

test('legacy layouts get a view', () => {
  const old = (result, extra = {}) => ({ wf: 'wf_old', startTime: START, durationMs: DURATION, result, ...extra });
  const done = { tasks: { A1: { status: 'done', commits: [S('a'), S('b')] } } };
  const cases = {
    'no wf_ dir': [makeRun({}), (g) => g.where === '#/run/launches/entries' && g.note === 'no launch'],
    'commits-only events, head-less reviews, no run_started': [makeRun({
      ledger: { 'a.jsonl': [{ task: 'A1', event: 'committed', commits: [S('b')] }, { task: 'A1', event: 'reviewed', rounds: 0 }] },
      launches: [old({ ...done, acceptance: { status: 'accepted', reasons: [], warnings: [] } })],
    }), (g) => g.where === '#/tasks/0/status/reviewed' && g.note === 'review recorded no head'],
    'an acceptance-less result': [makeRun({ launches: [old(done)] }),
      (g) => g.where === '#/run/acceptance/verdict' && g.state === 'unavailable'],
    'a dirless launch': [makeRun({ launches: [old(done, { dirless: true })] }),
      (g) => g.where.startsWith('#/run/launches/entries/value/0/layout') && g.note === 'no transcripts archived'],
  };
  for (const [name, [folder, expected]] of Object.entries(cases)) {
    const { json, md } = view(folder);
    assert.ok(json.gaps.some(expected), `${name}: ${JSON.stringify(json.gaps)}`);
    assert.equal(md.split('\n')[0], FIRST_LINE, name);
    const listed = mdSection(md, 'Evidence gaps');
    assert.equal(listed[0], `${json.gaps.length} evidence gap(s) in ${json.gap_causes.length} cause(s)`, name);
    assert.equal(listed.length, json.gap_causes.length + 1, name);
  }
});

test('Evidence gaps lists each cause once, with its tasks or the run', () => {
  const ended = { task: '_run', event: 'run_ended', status: 'complete', agents: 3, rulings: 0 };
  const carried = { task: '_run', event: 'carried', wf: 'wf_bbbbbb', rulings: 0 };
  const result = { tasks: { A1: { status: 'done', commits: [S('0'), S('1')] }, A2: { status: 'not_run', commits: null } } };
  const folder = makeRun({
    ledger: {
      '_run.jsonl': [setup(S('0')), ended, carried, ended, ended],
      'a.jsonl': [{ task: 'A1', event: 'started', base: S('0') }, { task: 'A1', event: 'committed', commits: [S('1')], base: S('0'), head: S('1') }],
    },
    launches: [{ wf: 'wf_aaaaaa', startTime: START, durationMs: DURATION, result, dirless: true }],
  });
  const { json, md, stdout } = view(folder);
  const both = `${json.gaps.length} evidence gap(s) in ${json.gap_causes.length} cause(s)`;
  const listed = mdSection(md, 'Evidence gaps');
  assert.equal(listed[0], both);
  // One line per cause, each once.
  const lines = listed.slice(1);
  assert.equal(lines.length, json.gap_causes.length);
  assert.equal(new Set(lines).size, lines.length);
  for (const line of [
    '- #/repo [unavailable] - no --repo (run)',
    // A run-level cause lists every value: a named launch and an unnamed one.
    '- #/run/launches/missing/N [missing] - the ledger records this launch; its transcripts are not archived (run: wf_bbbbbb, unknown)',
    // A cause in every task, and causes in some.
    '- #/tasks/N/requirement/brief_hash [unavailable] - no review recorded (tasks A1, A2)',
    '- #/tasks/N/status/reviewed [missing] - no review recorded (tasks A1)',
    '- #/tasks/N/commits/entries/N/commits [unavailable] - no --repo (tasks A1)',
  ]) assert.ok(lines.includes(line), `${line}\n${md}`);
  assert.doesNotMatch(md, /#\/tasks\/\d/);
  // audit.json keeps every per-task value in gaps.
  assert.equal(json.gaps.filter((g) => /^#\/tasks\/\d+\/requirement\/brief_hash$/.test(g.where)).length, 2);
  assert.deepEqual(json.gap_causes.find((g) => g.pointer === '#/tasks/N/requirement/brief_hash'),
    { pointer: '#/tasks/N/requirement/brief_hash', state: 'unavailable', note: 'no review recorded', tasks: ['A1', 'A2'], values: null });
  assert.deepEqual(json.gap_causes.find((g) => g.pointer === '#/run/launches/missing/N').values, ['wf_bbbbbb', null]);
  // The Bottom line and the Summary give both counts.
  assert.equal(mdSection(md, 'Bottom line').at(-1), `${both} (cannot-verify items and inferred lines are not gaps).`);
  assert.ok(mdSection(md, 'Summary').includes(`- ${both}`), md);
  assert.ok(stdout.split('\n').includes(both), stdout);
});

test('the plan and spec hashes print once, in Checks, by setup event and ledger line', () => {
  const r = repoRun();
  const { json, md } = view(makeRun(acceptedSpec(r, { runEvents: [setup(r.p0)] })), ['--repo', r.dir]);
  assert.deepEqual(json.gaps, []);
  const run = `${LEDGER}/_run.jsonl`;
  assert.deepEqual(mdSection(md, 'Checks').filter((l) => /^- (plan|spec) (hash|copy)/.test(l)), [
    `- plan hash, setup event 1: ${PLAN_SHA} [present] (${run} L1; p.md)`,
    `- plan hash, setup event 2: ${PLAN_SHA} [present] (${run} L2; p.md)`,
    `- spec hash, setup event 1: ${SPEC_SHA} [present] (${run} L1; p-design.md)`,
    `- spec hash, setup event 2: ${SPEC_SHA} [present] (${run} L2; p-design.md)`,
    '- plan copy for the section hashes: p.md [present] (p.md)',
  ]);
  // In no task block: audit.md holds each hash only there (a review's own
  // spec match stays with its review).
  assert.equal(md.split(PLAN_SHA).length - 1, 2);
  assert.deepEqual(md.split('\n').filter((l) => l.includes(SPEC_SHA) && !l.startsWith('- spec hash, setup event ')),
    [`  - spec match: ${SPEC_SHA} [present] (${LEDGER}/a.jsonl L3; p-design.md)`,
      `  - spec match: ${SPEC_SHA} [present] (${LEDGER}/a.jsonl L6; p-design.md)`]);
  assert.doesNotMatch(md, /plan section hash|hash, launch \d/);
  for (const t of json.tasks) assert.deepEqual(Object.keys(t.requirement), ['brief_hash', 'brief_file'], t.id);
  // Without a plan copy: one run-level gap, printed once in Checks.
  const noPlan = view(makeRun({ ...acceptedSpec(r), plan: null }), ['--repo', r.dir]);
  assert.deepEqual(noPlan.json.gaps.filter((g) => g.note === 'no plan copy archived').map((g) => g.where),
    ['#/run/checks/section_hash']);
  assert.deepEqual(noPlan.md.split('\n').filter((l) => /no plan copy archived( \(run\))?$/.test(l)), [
    '- plan copy for the section hashes: unknown [unavailable] - no plan copy archived',
    '- #/run/checks/section_hash [unavailable] - no plan copy archived (run)',
  ]);
});

test('a task keeps every fact its states rest on; "no ledger" is one cause per fact', () => {
  const result = { tasks: { A1: { status: 'done', commits: [S('0'), S('1')] }, A2: { status: 'done', commits: [S('1'), S('2')] } } };
  const { json, md } = view(makeRun({ ledger: null, launches: [{ wf: 'wf_aaaaaa', startTime: START, durationMs: DURATION, result }] }));
  json.tasks.forEach((t, i) => {
    for (const field of ['committed', 'reviewed']) {
      assert.deepEqual([t.status[field].state, t.status[field].note], ['unavailable', 'no ledger'], `${t.id} ${field}`);
      assert.ok(json.gaps.some((g) => g.where === `#/tasks/${i}/status/${field}` && g.note === 'no ledger'), `${t.id} ${field}`);
    }
  });
  for (const field of ['committed', 'reviewed']) {
    assert.equal(md.split('\n').filter((l) => l === `- ${field}: unknown [unavailable] - no ledger`).length, 2, field);
  }
  assert.deepEqual(json.gap_causes.filter((g) => g.note === 'no ledger').map((g) => [g.pointer, g.tasks, g.values]), [
    ['#/tasks/N/requirement/brief_file', ['A1', 'A2'], null],
    ['#/tasks/N/changes/carry', ['A1', 'A2'], null],
    ['#/tasks/N/changes/deferred', ['A1', 'A2'], null],
    ['#/tasks/N/review/packages', ['A1', 'A2'], null],
    ['#/tasks/N/status/committed', ['A1', 'A2'], null],
    ['#/tasks/N/status/reviewed', ['A1', 'A2'], null],
  ]);
  assert.ok(mdSection(md, 'Evidence gaps').includes('- #/tasks/N/status/committed [unavailable] - no ledger (tasks A1, A2)'), md);
});

test('the summary counts recorded launches the archive is missing', () => {
  const ended = { task: '_run', event: 'run_ended', status: 'complete', agents: 3, rulings: 0 };
  const result = { tasks: { A1: { status: 'done', commits: [S('a')] } } };
  const one = { wf: 'wf_aaaaaa', startTime: START, durationMs: DURATION, result };
  const { json, md, stdout } = view(makeRun({ ledger: { '_run.jsonl': [ended, ended] }, launches: [one] }));
  assert.ok(stdout.split('\n').includes('launches: 1 archived, 2 recorded, latest wf_aaaaaa'), stdout);
  assert.ok(md.includes('- launches: 1 archived, 2 recorded, latest wf_aaaaaa\n'), md);
  assert.ok(md.includes('- missing launch: unknown [missing] - the ledger records this launch; its transcripts are not archived'), md);
  assert.equal(json.gaps.filter((g) => g.where.startsWith('#/run/launches/missing')).length, 1);
  // Equal counts keep the old line.
  const same = view(makeRun({ ledger: { '_run.jsonl': [ended] }, launches: [one] }));
  assert.ok(same.stdout.split('\n').includes('launches: 1, latest wf_aaaaaa'), same.stdout);
});

test('a Linux-origin manifest needs no cygpath', () => {
  const r = repoRun();
  const folder = makeRun(acceptedSpec(r));
  const env = { CLAUDE_CODE_GIT_BASH_PATH: join(fresh('pl-audit-nobash-'), 'no-such-bash.exe') };
  const { json } = view(folder, ['--repo', r.dir], env);
  assert.equal(json.run.acceptance.gate, 'match');
  assert.equal(json.run.acceptance.verdict.value, 'accepted');
});

test('--out is refused inside the sources', () => {
  const r = repoRun();
  const spec = acceptedSpec(r);
  spec.launches[0].wf = 'wf_x';
  const folder = makeRun(spec);
  const holder = fresh('pl-audit-holder-');
  writeFileSync(join(holder, 'q.lanes.json'), '{}\n');
  // Dirs not made yet that would read as a launch or a ledger are refused too.
  const unmade = [join(folder, 'wf_new'), join(folder, 'wf_new', 'sub'), join(folder, 'q.ledger')];
  for (const out of [folder, join(folder, LEDGER, 'checks'), join(folder, 'wf_x'), join(folder, 'wf_x', 'sub'), holder, ...unmade]) {
    const res = audit(folder, ['--out', out]);
    assert.equal(res.code, 2, `${out}: ${res.stdout}`);
    assert.match(res.stderr, /--out/);
    assert.equal(existsSync(join(out, 'audit.json')), false, out);
    assert.equal(existsSync(join(out, 'audit.md')), false, out);
    assert.equal(existsSync(join(folder, 'audit')), false, out);
  }
  for (const out of unmade) assert.equal(existsSync(out), false, out);
  // An --out that cannot be made is exit 2 with the reason, not a traceback.
  const file = join(fresh('pl-audit-file-'), 'a-file');
  writeFileSync(file, 'x\n');
  const blocked = audit(folder, ['--out', join(file, 'sub')]);
  assert.equal(blocked.code, 2, blocked.stderr);
  assert.match(blocked.stderr, /^audit: cannot write /);
  assert.doesNotMatch(blocked.stderr, /Traceback/);
  // Elsewhere it writes there, and only there.
  const elsewhere = join(fresh('pl-audit-out-'), 'out');
  const res = audit(folder, ['--out', elsewhere]);
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(readdirSync(elsewhere).sort(), ['audit.json', 'audit.md']);
  assert.equal(existsSync(join(folder, 'audit')), false);
});

test('usage errors exit 2 and write nothing', () => {
  const folder = makeRun({});
  const noManifest = makeRun({ manifest: null });
  const cases = [
    [folder, '--head', 'main'],
    [folder, '--bogus'],
    [noManifest],
    [join(folder, 'missing')],
  ];
  for (const [dir, ...args] of cases) {
    const res = audit(dir, args);
    assert.equal(res.code, 2, `${args}: ${res.stderr}`);
    assert.equal(existsSync(join(dir, 'audit')), false);
  }
  const none = spawnSync('python3', [AUDIT], { encoding: 'utf8' });
  assert.equal(none.status, 2);
});

test('an input outside the run folder is refused', { skip: !SYMLINKS && 'symlinks unavailable' }, () => {
  const folder = makeRun({ launches: [{ wf: 'wf_a', startTime: START, durationMs: DURATION, result: {} }] });
  const outside = join(dirname(folder), 'elsewhere.jsonl');
  writeFileSync(outside, `${JSON.stringify({ task: 'A1', event: 'blocked', reason: 'outside' })}\n`);
  symlinkSync(outside, join(folder, LEDGER, 'a.jsonl'));
  const res = audit(folder);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /outside the run folder/);
  assert.match(res.stderr, /a\.jsonl/);
  assert.equal(existsSync(join(folder, 'audit')), false);
});

test('audit writes through no planted link', { skip: !SYMLINKS && 'symlinks unavailable' }, () => {
  const folder = makeRun(acceptedSpec(repoRun()));
  const outside = join(dirname(folder), 'victim.txt');
  writeFileSync(outside, 'keep me\n');
  mkdirSync(join(folder, 'audit'));
  for (const name of ['.audit.json.tmp', '.audit.md.tmp']) symlinkSync(outside, join(folder, 'audit', name));
  view(folder);
  assert.equal(readFileSync(outside, 'utf8'), 'keep me\n');
  for (const name of ['audit.json', 'audit.md']) assert.ok(lstatSync(join(folder, 'audit', name)).isFile(), name);
  // A default audit/ that resolves outside the run folder is refused.
  const linked = makeRun({});
  const elsewhere = fresh('pl-audit-elsewhere-');
  symlinkSync(elsewhere, join(linked, 'audit'), 'junction');
  const res = audit(linked);
  assert.equal(res.code, 2, res.stderr);
  assert.match(res.stderr, /resolves outside the run folder/);
  assert.deepEqual(readdirSync(elsewhere), []);
});

test('a run folder whose path holds glob characters', () => {
  const folder = makeRun(acceptedSpec(repoRun()));
  const odd = join(dirname(folder), 'run [1]');
  // Keep the mtimes: the verify evidence must stay inside the launch window.
  cpSync(folder, odd, { recursive: true, preserveTimestamps: true });
  const { json } = view(odd);
  assert.equal(json.run.launches.latest, 'wf_aaaaaa');
  assert.equal(byTask(json).A1.status.committed.value, true);
  assert.equal(json.run.checks.gate.value, 'match');
});

test('a repo without the start point', () => {
  const r = repoRun();
  const folder = makeRun(acceptedSpec(r));
  // Another history (makeRepo's first commits can share their shas).
  const other = makeRepo(0);
  commit(other.dir, 'other.txt');
  const { json } = view(folder, ['--repo', other.dir]);
  const reason = `the repo does not contain ${r.p0.slice(0, 7)}`;
  assert.deepEqual([json.repo.state, json.repo.note], ['unavailable', reason]);
  assert.deepEqual([json.run.code_outside_ranges.state, json.run.code_outside_ranges.note], ['unavailable', reason]);
  const entry = byTask(json).A1.commits.entries[0];
  assert.deepEqual([entry.commits.state, entry.commits.note], ['unavailable', reason]);
  assert.deepEqual([entry.files.state, entry.files.note], ['unavailable', reason]);
  assert.equal(byTask(json).A1.status.verified.note, reason);
  // No start point at all: the repo is used, and noted as not checked.
  const unanchored = makeRun({
    ledger: { 'a.jsonl': [{ task: 'A1', event: 'committed', commits: [r.a1] }] },
    launches: [{ wf: 'wf_a', startTime: START, durationMs: DURATION, result: { tasks: { A1: { status: 'done', commits: [r.p0, r.a1] } }, delivered_sha: r.a1 } }],
  });
  const loose = view(unanchored, ['--repo', r.dir]).json;
  assert.deepEqual([loose.repo.state, loose.repo.note], ['unavailable', 'repo not checked against the run']);
  assert.equal(loose.run.code_outside_ranges.note, 'no start point recorded');
});

test('the run-tools line counts the gaps', () => {
  const folder = makeRun({ launches: [{ wf: 'wf_old', startTime: START, durationMs: DURATION, result: {}, dirless: true }] });
  const { json } = view(folder);
  assert.ok(json.gaps.length > 0);
  const outcomes = () => spawnSync('python3', [join(SCRIPTS, 'tool-outcomes'), '--run-folder', folder, '--audit-exit', '0'],
    { encoding: 'utf8' });
  const res = outcomes();
  assert.equal(res.status, 0, res.stderr);
  // Every gap counts, not every cause.
  assert.ok(json.gap_causes.length < json.gaps.length);
  assert.ok(res.stdout.includes(`audit generated (${json.gaps.length} evidence gap(s))`), res.stdout);
  assert.ok(statSync(join(folder, 'audit', 'audit.json')).isFile());
  // tool-outcomes reads only gaps: an audit.json of version 1 (no
  // gap_causes) still gives its count.
  const v1 = { ...json, audit_version: 1 };
  delete v1.gap_causes;
  writeFileSync(join(folder, 'audit', 'audit.json'), JSON.stringify(v1));
  const old = outcomes();
  assert.equal(old.status, 0, old.stderr);
  assert.ok(old.stdout.includes(`audit generated (${json.gaps.length} evidence gap(s))`), old.stdout);
});
