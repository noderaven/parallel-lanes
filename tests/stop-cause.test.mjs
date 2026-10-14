// scripts/stop-cause: tells a usage-limit stop from other agent deaths by
// the tool's "[<label>] failed: ..." lines in a launch's workflow result
// file. The sc1 and m1a fixtures hold the real limit texts of those runs
// (no project text); the other cases write their own result file.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { tempDir } from './platform.mjs';

const SCRIPT = join(SKILL_DIR, 'scripts', 'stop-cause');
const FIXTURES = join(SKILL_DIR, 'tests', 'fixtures', 'stop-cause');
const TMP = tempDir('pl-stop-cause-');
after(() => rmSync(TMP, { recursive: true, force: true }));

function run(...args) {
  const res = spawnSync('python3', [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

// Runs stop-cause and returns its one JSON line, parsed, after checking it
// exited 0, printed exactly one line and nothing on stderr.
function cause(dir) {
  const res = run(dir);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /^[^\n]+\n$/);
  assert.equal(res.stderr, '');
  return JSON.parse(res.stdout);
}

let counter = 0;
// A transcript dir path whose sibling <dir>.json holds the given result
// file: an object is written as JSON, a string as is.
function launch(resultFile) {
  counter += 1;
  const dir = join(TMP, `case ${counter}`, 'wf_x');
  mkdirSync(dir, { recursive: true });
  const text = typeof resultFile === 'string' ? resultFile : JSON.stringify(resultFile, null, 2);
  writeFileSync(`${dir}.json`, text);
  return dir;
}

const withLogs = (logs) => launch({ runId: 'wf_x', status: 'completed', result: { status: 'stopped' }, logs });

// Every file under dir with its content and mtime, to show nothing is
// written.
function snapshot(dir) {
  const out = {};
  for (const name of readdirSync(dir, { recursive: true }).sort()) {
    const path = join(dir, name);
    const st = statSync(path);
    out[name] = st.isFile() ? [readFileSync(path, 'latin1'), st.mtimeMs] : 'dir';
  }
  return out;
}

const SC1 = join(FIXTURES, 'sc1', 'wf_sc1');
// m1a's result file sits where a live session keeps it:
// <session>/workflows/<name>.json for <session>/subagents/workflows/<name>.
const M1A = join(FIXTURES, 'm1a', 'subagents', 'workflows', 'wf_m1a');

test('sc1: the review and its retry hit the session limit', () => {
  // The fixture holds the real separator (U+00B7, escaped in the JSON).
  const logs = JSON.parse(readFileSync(`${SC1}.json`, 'utf8')).logs;
  assert.ok(logs[1].includes(` ${String.fromCharCode(0xb7)} resets `), logs[1]);
  assert.deepEqual(cause(SC1), { usage_limit: true, resets: '11:20pm (America/Los_Angeles)', lines: 2 });
});

test('m1a: an implement hit the session limit, found in the session layout', () => {
  assert.deepEqual(cause(M1A), { usage_limit: true, resets: '5am (America/Los_Angeles)', lines: 1 });
});

test('the output line is plain ASCII with the documented keys in order', () => {
  const res = run(SC1);
  assert.equal(res.stdout, '{"usage_limit": true, "resets": "11:20pm (America/Los_Angeles)", "lines": 2}\n');
});

test('a limit line without "resets" counts, with resets null', () => {
  const dir = withLogs([
    "[A1 implement] failed: You've hit your usage limit",
    '[A1 implement retry] failed: You hit your limit',
  ]);
  assert.deepEqual(cause(dir), { usage_limit: true, resets: null, lines: 2 });
});

test('the first limit line that names a reset gives resets', () => {
  const dir = withLogs([
    "[A1 implement] failed: You've hit your session limit",
    "[A1 implement retry] failed: You've hit your session limit \u00b7 resets 3pm (Europe/Paris)",
    "[B1 review] failed: You've hit your weekly limit \u00b7 resets Mon 9am (Europe/Paris)",
  ]);
  assert.deepEqual(cause(dir), { usage_limit: true, resets: '3pm (Europe/Paris)', lines: 3 });
});

test('only ordinary failures: no usage limit', () => {
  const dir = withLogs([
    '[X implement] failed: some other error',
    '[X implement retry] failed: some other error',
    'X: adjudicated blocked -> stop',
  ]);
  assert.deepEqual(cause(dir), { usage_limit: false, resets: null, lines: 0 });
});

test('unknown wording reads as no usage limit', () => {
  const dir = withLogs(['[X implement] failed: Rate limit reached, try again later']);
  assert.deepEqual(cause(dir), { usage_limit: false, resets: null, lines: 0 });
});

test('an engine log line quoting an agent is not counted', () => {
  const dir = withLogs([
    "CV2: adjudicated question -> the agent said You've hit your session limit \u00b7 resets 5am (America/Los_Angeles)",
    "CV2: [CV2 implement] failed: You've hit your session limit",
    "[CV2 implement] retrying: You've hit your session limit",
  ]);
  assert.deepEqual(cause(dir), { usage_limit: false, resets: null, lines: 0 });
});

test('log entries that are not strings are skipped', () => {
  const dir = withLogs([null, 7, { text: "[A] failed: You've hit your session limit" },
    "[A1 implement] failed: You've hit your session limit \u00b7 resets 5am (UTC)"]);
  assert.deepEqual(cause(dir), { usage_limit: true, resets: '5am (UTC)', lines: 1 });
});

test('an empty logs list: no usage limit', () => {
  assert.deepEqual(cause(withLogs([])), { usage_limit: false, resets: null, lines: 0 });
});

test('no result file: exit 3 with a reason', () => {
  const res = run(join(TMP, 'missing', 'wf_none'));
  assert.equal(res.code, 3);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /^stop-cause: no workflow result file/);
});

test('a result file that is not JSON, or not an object: exit 3', () => {
  for (const text of ['{ not json', '[1, 2]']) {
    const res = run(launch(text));
    assert.equal(res.code, 3, text);
    assert.equal(res.stdout, '');
    assert.match(res.stderr, /^stop-cause: /);
  }
});

test('a result without logs, or with logs that is not a list: exit 3', () => {
  for (const file of [{ runId: 'wf_x', result: {} }, { runId: 'wf_x', logs: 'text' }]) {
    const res = run(launch(file));
    assert.equal(res.code, 3, JSON.stringify(file));
    assert.equal(res.stdout, '');
    assert.match(res.stderr, /^stop-cause: no logs list in /);
  }
});

test('no argument, or more than one: exit 2 with the usage', () => {
  for (const args of [[], [SC1, M1A]]) {
    const res = run(...args);
    assert.equal(res.code, 2);
    assert.equal(res.stdout, '');
    assert.match(res.stderr, /usage: stop-cause TRANSCRIPT_DIR/);
  }
});

test('stop-cause never writes: the fixtures are unchanged', () => {
  const before = snapshot(FIXTURES);
  cause(SC1);
  cause(M1A);
  run(join(FIXTURES, 'sc1', 'wf_missing'));
  assert.deepEqual(snapshot(FIXTURES), before);
});

test('the script, this test and the fixtures are plain ASCII', () => {
  const files = [SCRIPT, join(SKILL_DIR, 'tests', 'stop-cause.test.mjs'), `${SC1}.json`,
    join(FIXTURES, 'm1a', 'workflows', 'wf_m1a.json')];
  for (const file of files) {
    assert.ok(readFileSync(file).every((b) => b < 0x80), `${file} has a non-ASCII byte`);
  }
});
