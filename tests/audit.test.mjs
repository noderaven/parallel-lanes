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
        { label: 'final re-review', result: { head: r.fix, results: [] } },
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
  assert.equal(json.audit_version, 1);
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
  for (const heading of ['Summary', 'Acceptance', 'Launches', 'Tasks', 'Code outside recorded task ranges', 'Checks', 'Open work', 'Evidence gaps']) {
    assert.match(md, new RegExp(`^## ${heading}$`, 'm'), heading);
  }
  assert.doesNotMatch(md, /^## After delivery$/m);
  assert.match(md, /^### Task A1/m);
  assert.match(md, /^### Task A2/m);
  // The summary: at most 10 lines, the last naming audit.md.
  const lines = stdout.trimEnd().split('\n');
  assert.ok(lines.length <= 10, stdout);
  assert.match(lines[lines.length - 1], /^full report: .*audit\.md$/);
  assert.ok(existsSync(lines[lines.length - 1].slice('full report: '.length)));
  assert.match(stdout, /verdict accepted/);
  assert.match(stdout, /evidence gaps: 0/);
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
  const { json } = view(folder, ['--repo', r.dir]);
  assert.equal(json.run.acceptance.gate, 'unavailable');
  assert.equal(json.run.checks.gate.value, 'unavailable');
  assert.equal(json.run.checks.gate_reason, 'verify_evidence_time_untrusted');
  assert.equal(json.run.acceptance.verdict.value, 'accepted (gate unavailable)');
  const tasks = byTask(json);
  assert.deepEqual([tasks.A1.status.verified.value, tasks.A1.status.verified.state], [null, 'unavailable']);
  assert.ok(json.gaps.some((g) => g.where === '#/run/checks/gate' && g.state === 'unavailable'));
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
    assert.match(md, new RegExp(`evidence gaps: ${json.gaps.length}`), name);
  }
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
  const res = spawnSync('python3', [join(SCRIPTS, 'tool-outcomes'), '--run-folder', folder, '--audit-exit', '0'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.includes(`audit generated (${json.gaps.length} evidence gap(s))`), res.stdout);
  assert.ok(statSync(join(folder, 'audit', 'audit.json')).isFile());
});
