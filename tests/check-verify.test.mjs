// scripts/check-verify: the verify agent's report (result.verify in the
// workflow result file) against the run-checks JSON saved at
// <ledger_dir>/checks/verify-<sha>.json during the same launch. Every status
// and exit code, the field comparison, the input validation, freshness, and
// the documented recovery commands.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { tempDir } from './platform.mjs';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const SCRIPT = join(SCRIPTS, 'check-verify');
const TMP = realpathSync(tempDir('pl-check-verify-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER = 'fedcba9876543210fedcba9876543210fedcba98';
const RESULT = { group: 'test', command: 'npm test', exit: 0 };
const LINT = { group: 'lint', command: 'npm run lint', exit: 0 };

// The verify agent's report, as run-checks prints it minus the ignored fields.
const report = (over = {}) => ({
  head: SHA, results: [{ ...RESULT }], ok: true, clean: true, tracked_before: [], tracked_after: [], ...over,
});
// What run-checks saved: the report plus checkout, branch, and log and tail per result.
const withLogs = (results) => results.map((r, i) => ({ ...r, log: `/ledger/checks/v.${i + 1}.log`, tail: 'ok' }));
const evidence = (over = {}) => {
  const base = report(over);
  return { checkout: '/repo', branch: 'main', ...base, results: Array.isArray(base.results) ? withLogs(base.results) : base.results };
};

let counter = 0;
function caseDir() {
  counter += 1;
  const dir = join(TMP, `case ${counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function run(args) {
  const res = spawnSync('python3', [SCRIPT, ...args], { encoding: 'utf8' });
  let out = null;
  try {
    out = JSON.parse(res.stdout);
  } catch {
    out = null;
  }
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, out };
}

// Writes one case and runs check-verify on it. opts (each optional):
// verify, acceptance, delivered_sha (each may be null), startTime (undefined
// leaves it out), evidence (an object, a string written as is, or null for
// no file), evidenceSha (the sha in the evidence file name), evidenceTime
// (its modification time in ms).
function check(opts = {}) {
  const has = (k) => Object.prototype.hasOwnProperty.call(opts, k);
  const dir = caseDir();
  const transcript = join(dir, 'wf_x');
  mkdirSync(transcript);
  const file = {
    result: {
      acceptance: has('acceptance') ? opts.acceptance : { status: 'accepted' },
      delivered_sha: has('delivered_sha') ? opts.delivered_sha : SHA,
      verify: has('verify') ? opts.verify : report(),
    },
  };
  const startTime = has('startTime') ? opts.startTime : Date.now() - 60000;
  if (startTime !== undefined) file.startTime = startTime;
  writeFileSync(join(dir, 'wf_x.json'), JSON.stringify(file).replace('"@@BIG@@"', '1' + '0'.repeat(400)));
  const ledger = join(dir, 'ledger');
  writeFileSync(join(dir, 'm.json'), JSON.stringify({ repo: { ledger_dir: ledger } }));
  const ev = has('evidence') ? opts.evidence : evidence();
  if (ev !== null) {
    const path = join(ledger, 'checks', `verify-${opts.evidenceSha || SHA}.json`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof ev === 'string' ? ev : JSON.stringify(ev));
    if (opts.evidenceTime !== undefined) utimesSync(path, opts.evidenceTime / 1000, opts.evidenceTime / 1000);
  }
  return run([transcript, join(dir, 'm.json')]);
}

function expectStatus(res, status, reason, code) {
  assert.ok(res.out, `stdout is not JSON: ${res.stdout} (stderr: ${res.stderr})`);
  assert.equal(res.out.status, status, res.stdout);
  assert.equal(res.out.reason, reason, res.stdout);
  assert.equal(res.code, code, res.stderr);
}
const present = (value) => ({ present: true, value });
const ABSENT = { present: false };

test('a report that matches fresh evidence', () => {
  const res = check();
  expectStatus(res, 'match', undefined, 0);
  assert.ok(res.out.path.endsWith(`verify-${SHA}.json`), res.out.path);
  assert.equal(res.out.differences, undefined);
});

test('log, tail, checkout and branch are not compared', () => {
  const verify = { ...report(), checkout: '/elsewhere', branch: 'other', results: [{ ...RESULT, log: '/a.log', tail: 'mine' }] };
  expectStatus(check({ verify }), 'match', undefined, 0);
});

test('each compared field that differs is named', () => {
  const cases = [
    ['head', OTHER, SHA],
    ['ok', false, true],
    ['clean', false, true],
    ['tracked_before', [' M a.txt'], []],
    ['tracked_after', [], ['M  b.txt']],
  ];
  for (const [field, reported, saved] of cases) {
    const res = check({ verify: report({ [field]: reported }), evidence: evidence({ [field]: saved }) });
    expectStatus(res, 'mismatch', 'verify_mismatch', 1);
    assert.deepEqual(res.out.differences, [{ field, reported: present(reported), evidence: present(saved) }], field);
  }
});

test('a field present as null on one side and absent on the other differs', () => {
  let res = check({ verify: report({ tracked_after: null }) });
  expectStatus(res, 'invalid', 'verify_invalid', 1);
  assert.match(res.out.detail, /tracked_after/);
  res = check({ verify: report({ results: [{ ...RESULT, exit: null }] }) });
  expectStatus(res, 'invalid', 'verify_invalid', 1);
  assert.match(res.out.detail, /results\[0\]\.exit/);
  const saved = evidence();
  delete saved.tracked_after;
  res = check({ evidence: saved });
  expectStatus(res, 'mismatch', 'verify_mismatch', 1);
  assert.deepEqual(res.out.differences, [{ field: 'tracked_after', reported: present([]), evidence: ABSENT }]);
});

test('results are compared in order by group, command and exit', () => {
  let res = check({ verify: report({ results: [{ ...RESULT, exit: 1 }] }) });
  expectStatus(res, 'mismatch', 'verify_mismatch', 1);
  assert.deepEqual(res.out.differences, [
    { field: 'results[0]', reported: present({ ...RESULT, exit: 1 }), evidence: present(RESULT) },
  ]);

  res = check({ verify: report({ results: [RESULT, LINT] }), evidence: evidence({ results: [LINT, RESULT] }) });
  expectStatus(res, 'mismatch', 'verify_mismatch', 1);
  assert.deepEqual(res.out.differences, [
    { field: 'results[0]', reported: present(RESULT), evidence: present(LINT) },
    { field: 'results[1]', reported: present(LINT), evidence: present(RESULT) },
  ]);

  res = check({ evidence: evidence({ results: [RESULT, LINT] }) });
  expectStatus(res, 'mismatch', 'verify_mismatch', 1);
  assert.deepEqual(res.out.differences, [{ field: 'results[1]', reported: ABSENT, evidence: present(LINT) }]);

  res = check({ verify: report({ results: [] }), evidence: evidence({ results: [] }) });
  expectStatus(res, 'match', undefined, 0);
});

test('evidence from an older run-checks without the tracked lists is a mismatch', () => {
  const saved = evidence();
  delete saved.tracked_before;
  delete saved.tracked_after;
  const res = check({ evidence: saved });
  expectStatus(res, 'mismatch', 'verify_mismatch', 1);
  assert.deepEqual(res.out.differences, [
    { field: 'tracked_before', reported: present([]), evidence: ABSENT },
    { field: 'tracked_after', reported: present([]), evidence: ABSENT },
  ]);
});

test('booleans and integers are not interchangeable', () => {
  const cases = [
    [{ verify: report({ ok: 1 }) }, /\bok\b/],
    [{ verify: report({ clean: 0 }) }, /\bclean\b/],
    [{ verify: report({ results: [{ ...RESULT, exit: true }] }) }, /results\[0\]\.exit/],
    [{ evidence: evidence({ ok: 1 }) }, /evidence.*\bok\b/],
  ];
  for (const [opts, detail] of cases) {
    const res = check(opts);
    expectStatus(res, 'invalid', 'verify_invalid', 1);
    assert.match(res.out.detail, detail);
  }
});

test('malformed results are invalid', () => {
  const { exit, ...noExit } = RESULT;
  for (const results of ['x', ['x'], [noExit]]) {
    const res = check({ verify: report({ results }) });
    expectStatus(res, 'invalid', 'verify_invalid', 1);
    assert.match(res.out.detail, /results/);
  }
});

test('a malformed delivered sha is invalid and builds no path', () => {
  for (const sha of ['../../x', 'abc', SHA.toUpperCase(), `${SHA}\n`, 123]) {
    const res = check({ delivered_sha: sha });
    expectStatus(res, 'invalid', 'verify_invalid', 1);
    assert.ok(!('path' in res.out), res.stdout);
    assert.match(res.out.detail, /delivered_sha/);
  }
  const long = 'ab'.repeat(32);
  const res = check({ delivered_sha: long, verify: report({ head: long }), evidence: evidence({ head: long }), evidenceSha: long });
  expectStatus(res, 'match', undefined, 0);
});

test('the delivered sha names the evidence, not the reported head', () => {
  const res = check({ delivered_sha: OTHER });
  expectStatus(res, 'missing', 'verify_evidence_missing', 1);
  assert.ok(res.out.path.endsWith(`verify-${OTHER}.json`), res.out.path);
});

test('without a delivered sha the reported head names the evidence', () => {
  const res = check({ delivered_sha: null });
  expectStatus(res, 'match', undefined, 0);
  assert.ok(res.out.path.endsWith(`verify-${SHA}.json`), res.out.path);
});

test('evidence older than the launch is stale', () => {
  let res = check({ evidenceTime: Date.now() - 120000 });
  expectStatus(res, 'stale', 'verify_evidence_stale', 1);
  assert.ok(res.out.path.endsWith(`verify-${SHA}.json`), res.out.path);
  for (const startTime of [undefined, '1', true, null]) {
    res = check({ startTime });
    expectStatus(res, 'invalid', 'verify_invalid', 1);
    assert.match(res.out.detail, /startTime/);
  }
  // An integer too large for a float: written as raw text, JSON.stringify cannot make it.
  res = check({ startTime: '@@BIG@@' });
  expectStatus(res, 'invalid', 'verify_invalid', 1);
  assert.match(res.out.detail, /startTime/);
});

test('no evidence file is missing evidence', () => {
  const res = check({ evidence: null });
  expectStatus(res, 'missing', 'verify_evidence_missing', 1);
  assert.ok(res.out.path.endsWith(`verify-${SHA}.json`), res.out.path);
});

test('an evidence file that is not JSON is invalid', () => {
  for (const text of ['{not json', '[]']) {
    const res = check({ evidence: text });
    expectStatus(res, 'invalid', 'verify_invalid', 1);
    assert.match(res.out.detail, /evidence/);
  }
});

test('no verify result: not required only when the run was accepted', () => {
  expectStatus(check({ verify: null, evidence: null }), 'not_required', undefined, 0);
  expectStatus(check({ verify: null, evidence: null, acceptance: { status: 'unverified' } }),
    'missing', 'verify_evidence_missing', 1);
  for (const acceptance of [null, { status: 1 }, 'accepted']) {
    const res = check({ verify: null, evidence: null, acceptance });
    expectStatus(res, 'invalid', 'verify_invalid', 1);
    assert.match(res.out.detail, /acceptance/);
  }
});

test('missing inputs exit 2', () => {
  const dir = caseDir();
  const manifest = join(dir, 'm.json');
  writeFileSync(manifest, JSON.stringify({ repo: { ledger_dir: join(dir, 'ledger') } }));
  mkdirSync(join(dir, 'wf_x'));
  // No result file beside the transcript dir.
  let res = run([join(dir, 'wf_x'), manifest]);
  assert.equal(res.code, 2, res.stdout);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /result/);
  // A result file without a result object.
  writeFileSync(join(dir, 'wf_x.json'), JSON.stringify({ startTime: 1 }));
  res = run([join(dir, 'wf_x'), manifest]);
  assert.equal(res.code, 2, res.stdout);
  writeFileSync(join(dir, 'wf_x.json'), JSON.stringify({ startTime: 1, result: { acceptance: { status: 'accepted' }, verify: null } }));
  assert.equal(run([join(dir, 'wf_x'), manifest]).code, 0);
  // A manifest that is not JSON, or has no string repo.ledger_dir.
  for (const text of ['not json', '{}', '{"repo": {"ledger_dir": 1}}']) {
    writeFileSync(manifest, text);
    res = run([join(dir, 'wf_x'), manifest]);
    assert.equal(res.code, 2, text);
    assert.equal(res.stdout, '');
    assert.match(res.stderr, /manifest/);
  }
  for (const args of [[], [join(dir, 'wf_x')], [join(dir, 'wf_x'), manifest, 'extra']]) {
    res = run(args);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /usage: check-verify TRANSCRIPT_DIR MANIFEST/);
  }
});

test('the output is one JSON line', () => {
  for (const res of [check(), check({ verify: report({ ok: false }) })]) {
    assert.ok(res.stdout.endsWith('\n'), JSON.stringify(res.stdout));
    assert.equal(res.stdout.indexOf('\n'), res.stdout.length - 1, JSON.stringify(res.stdout));
    assert.equal(typeof JSON.parse(res.stdout), 'object');
  }
});

test('_shell.result_paths lists the session result, then the sibling file', () => {
  const session = join(TMP, 'session');
  const code = [
    'import json, sys',
    'sys.dont_write_bytecode = True',
    'sys.path.insert(0, sys.argv[1])',
    'import _shell',
    'print(json.dumps([_shell.result_paths(p) for p in sys.argv[2:]]))',
  ].join('\n');
  const nested = join(session, 'subagents', 'workflows', 'wf_1');
  const plain = join(session, 'wf_2');
  const res = spawnSync('python3', ['-c', code, SCRIPTS, nested, plain], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), [
    [join(session, 'workflows', 'wf_1.json'), join(session, 'subagents', 'workflows', 'wf_1.json')],
    [join(session, 'wf_2.json')],
  ]);
});

// ---- The documented recovery (reference.md "Verify evidence") ----

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid',
};
function helper(script, args) {
  const res = spawnSync('python3', [join(SCRIPTS, script), ...args], {
    encoding: 'utf8', env: { ...process.env, ...GIT_ENV, TMPDIR: TMP },
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}
function git(dir, ...args) {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.replace(/\r\n/g, '\n').trim();
}

test('the documented recovery works', () => {
  const dir = caseDir();
  // The ledger sits outside the checkout, as a run's ledger dir does.
  const repo = join(dir, 'repo');
  const ledger = join(dir, 'ledger');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'value.txt'), 'good\n');
  git(repo, 'add', 'value.txt');
  git(repo, 'commit', '-q', '-m', 'init');
  const head = git(repo, 'rev-parse', 'HEAD');

  const out = join(ledger, 'checks', `session-verify-${head}.json`);
  const checks = helper('run-checks', [repo, '--out', out, '--root', ledger, '--cmd', 'test', 'grep -q good value.txt']);
  assert.equal(checks.code, 0, checks.stderr);
  const saved = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(saved.head, head);
  assert.equal(saved.ok, true);
  assert.ok(saved.results.length > 0 && saved.results.every((r) => r.exit === 0), JSON.stringify(saved.results));
  assert.deepEqual([saved.tracked_before, saved.tracked_after], [[], []]);

  const text = `session re-verified: ${out}; replaces verify_mismatch`;
  const accept = helper('ledger', ['accept', ledger, repo, head, text]);
  assert.equal(accept.code, 0, accept.stderr);
  const status = helper('ledger', ['status', ledger]);
  assert.equal(status.code, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).accepted, [{ head, text }]);
});
