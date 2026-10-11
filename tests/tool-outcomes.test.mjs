// scripts/tool-outcomes: the hand-back's one "Run tools:" line (doctor,
// archive, autopsy, cleanup) and its --json form. Each case writes its own
// autopsy.json (autopsy version 4) into a temp run folder by hand.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { IS_WINDOWS, tempDir } from './platform.mjs';

const SCRIPT = join(SKILL_DIR, 'scripts', 'tool-outcomes');
const TMP = tempDir('pl-tool-outcomes-');
after(() => rmSync(TMP, { recursive: true, force: true }));

// Every output this file sees, for the acceptance-words check at the end.
const SEEN = [];

let counter = 0;
// A new run folder holding autopsy.json: an object is written as JSON, a
// string as is, and null writes no file.
function runFolder(autopsy) {
  counter += 1;
  const dir = join(TMP, `run ${counter}`);
  mkdirSync(dir, { recursive: true });
  if (autopsy !== null) {
    const text = typeof autopsy === 'string' ? autopsy : JSON.stringify(autopsy, null, 2);
    writeFileSync(join(dir, 'autopsy.json'), text);
  }
  return dir;
}

// The folder as tool-outcomes prints it: _shell.native_path's C:/... form on
// Windows, unchanged elsewhere.
const shown = (dir) => (IS_WINDOWS ? dir.replace(/\\/g, '/').replace(/^[a-z]:/, (d) => d.toUpperCase()) : dir);

function run(...args) {
  const res = spawnSync('python3', [SCRIPT, ...args], { encoding: 'utf8' });
  SEEN.push(res.stdout, res.stderr);
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

// Runs tool-outcomes and returns its one line, after checking it exited 0
// and printed exactly one line.
function line(...args) {
  const res = run(...args);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /^Run tools: [^\n]*\n$/);
  return res.stdout.slice(0, -1);
}

const launch = (wf) => ({ wf, start: 1760173200, end: 1760173800, wall_s: 600, status: 'completed' });

const entry = (over = {}) => ({
  wf: 'wf_abc123',
  state: 'recorded',
  reason: null,
  observed_at: '2026-10-11T08:55:00Z',
  before_start_s: 300,
  doctor_version: '1.5.1',
  status: 'ok',
  checks: [],
  possible_contributors: [],
  ...over,
});

const unavailable = (wf) => entry({
  wf, state: 'unavailable', reason: 'launch conditions unavailable', observed_at: null,
  before_start_s: null, doctor_version: null, status: null,
});

const check = (name, outcome, read = true, detail = null) => ({ check: name, outcome, detail, read });

const autopsy = (entries, launches = entries.map((e) => launch(e.wf))) => ({
  autopsy_version: 4, run_id: 'r1', launches, launch_conditions: entries,
});

// The first case: one recorded launch warning memory and defender, both
// contributors.
const FIRST = autopsy([entry({
  checks: [check('memory', 'warning', true, '1.2 GB free of 16 GB'), check('defender', 'warning', true, 'not covered')],
  possible_contributors: [
    { check: 'memory', slowdowns: { long_tool_call: 1 } },
    { check: 'defender', slowdowns: { timeout: 1 } },
  ],
})]);

const ok = (dir, ...more) => ['--run-folder', dir, '--autopsy-exit', '0', ...more];

test('the line covers each tool', () => {
  const dir = runFolder(FIRST);
  assert.equal(
    line('--archive-exit', '0', ...ok(dir, '--cleanup', 'awaiting')),
    `Run tools: doctor before wf_abc123: ok, 2 warning(s) (memory, defender); archived to ${shown(dir)}; `
      + 'autopsy generated (2 possible contributor(s)); cleanup awaiting approval',
  );
});

test('unread checks are named as not read', () => {
  const dir = runFolder(autopsy([entry({ checks: [check('defender', 'warning', false, 'unknown')] })]));
  const out = line(...ok(dir));
  assert.match(out, /^Run tools: doctor before wf_abc123: ok, 1 not read \(defender\); /);
  assert.doesNotMatch(out, /warning/);

  const mixed = runFolder(autopsy([entry({
    checks: [
      check('memory', 'warning'), check('python', 'failed'), check('defender', 'warning', false, 'unknown'),
      check('git', 'passed'), check('shadow_repo', 'skipped'),
    ],
  })]));
  assert.match(
    line(...ok(mixed)),
    /^Run tools: doctor before wf_abc123: ok, 1 warning\(s\) \(memory\), 1 failed \(python\), 1 not read \(defender\); /,
  );
});

test('failures name their tool', () => {
  const dir = runFolder(FIRST);
  const out = line('--run-folder', dir, '--archive-exit', '2', '--autopsy-exit', '1');
  assert.ok(out.includes('; archive failed (exit 2); '), out);
  assert.ok(out.includes('; autopsy failed (exit 1); '), out);
  assert.ok(out.startsWith('Run tools: launch conditions not checked (autopsy failed); '), out);
  assert.doesNotMatch(out, /memory/);
});

test('missing pieces are named', () => {
  assert.equal(
    line(),
    'Run tools: launch conditions not checked (autopsy not run); archive not run; autopsy not run; cleanup not offered',
  );

  const older = runFolder({ autopsy_version: 3, run_id: 'r1', launches: [launch('wf_abc123')] });
  const garbage = runFolder('{"launch_conditions": [');
  const absent = runFolder(null);
  for (const dir of [older, garbage, absent]) {
    const out = line(...ok(dir));
    assert.ok(out.startsWith('Run tools: launch conditions not checked (autopsy unreadable); '), out);
    assert.ok(out.includes('; autopsy generated (contributors unavailable); '), out);
  }
  const noLaunches = runFolder(autopsy([]));
  assert.ok(line(...ok(noLaunches)).startsWith(
    'Run tools: launch conditions not checked (no launches); '), 'no launches');
  assert.ok(line(...ok(noLaunches)).includes('; autopsy generated (0 possible contributor(s)); '));
  const noFolder = line('--autopsy-exit', '0', '--archive-exit', '0');
  assert.equal(
    noFolder,
    'Run tools: launch conditions not checked (autopsy unreadable); archived; '
      + 'autopsy generated (contributors unavailable); cleanup not offered',
  );

  assert.ok(line('--cleanup', 'done').endsWith('; cleanup done'));
  assert.ok(line('--cleanup', 'declined').endsWith('; cleanup declined'));
  assert.ok(line('--cleanup', 'failed').endsWith('; cleanup failed'));
  assert.ok(line('--cleanup', 'none').endsWith('; cleanup not offered'));

  const nullStatus = runFolder(autopsy([entry({ status: null })]));
  assert.match(line(...ok(nullStatus)), /^Run tools: doctor before wf_abc123: status unavailable; /);
});

test("the doctor part follows autopsy's binding", () => {
  const earlier = entry({
    wf: 'wf_one111',
    checks: [check('memory', 'warning')],
    possible_contributors: [{ check: 'memory', slowdowns: { timeout: 1 } }],
  });
  const refused = runFolder(autopsy([earlier, unavailable('wf_two222')]));
  const out = line(...ok(refused, '--conditions-refused', 'observation_reused'));
  assert.ok(
    out.startsWith('Run tools: launch conditions not recorded (observation_reused) (earlier launches: see autopsy); '),
    out,
  );
  assert.doesNotMatch(out, /memory/);
  assert.match(line(...ok(refused)), /^Run tools: launch conditions not recorded \(earlier launches: see autopsy\); /);

  const late = runFolder(autopsy([entry({
    state: 'inconsistent', reason: 'observed after the launch started', status: null, doctor_version: null,
    observed_at: null, before_start_s: null,
  })]));
  assert.match(line(...ok(late)), /^Run tools: launch conditions inconsistent \(observed after the launch started\); /);

  const odd = runFolder(autopsy([entry({ state: 'inconsistent', reason: 'zqreason in a new wording', status: null })]));
  const oddOut = line(...ok(odd));
  assert.match(oddOut, /^Run tools: launch conditions inconsistent; /);
  assert.doesNotMatch(oddOut, /zqreason/);
});

test('a blocked relaunch is shown', () => {
  const out = line('--relaunch-blocked', 'python,shadow_repo');
  assert.ok(out.includes(', relaunch blocked by doctor (python, shadow_repo); '), out);

  const dir = runFolder(FIRST);
  assert.match(
    line(...ok(dir, '--relaunch-blocked', 'python')),
    /^Run tools: doctor before wf_abc123: ok, 2 warning\(s\) \(memory, defender\), relaunch blocked by doctor \(python\); /,
  );
});

test('no doctor details appear', () => {
  const dir = runFolder(autopsy([entry({
    checks: [
      check('disk', 'warning', true, 'zqpath has 1 GB free'),
      check('git', 'failed', true, 'remote zqhost unreachable'),
      check('C:/zqpath', 'warning', true, 'zqpath'),
    ],
    possible_contributors: [{ check: 'C:/zqpath', slowdowns: { timeout: 1 } }],
  })]));
  const out = line(...ok(dir));
  assert.match(out, /^Run tools: doctor before wf_abc123: ok, 1 warning\(s\) \(disk\), 1 failed \(git\); /);
  const badWf = runFolder(autopsy([entry({ wf: 'wf_../zqpath' })]));
  const badOut = line(...ok(badWf));
  // A name or id ending in a newline is not a name: it would split the line.
  const nl = runFolder(autopsy([entry({
    wf: 'wf_abc123\n',
    checks: [check('disk\n', 'warning', true, 'x'), check('git', 'failed', true, 'x')],
  })]));
  assert.match(line(...ok(nl)), /^Run tools: doctor before the launch: ok, 1 failed \(git\); /);
  for (const text of [out, badOut, JSON.stringify(JSON.parse(run('--json', ...ok(dir)).stdout))]) {
    assert.doesNotMatch(text, /zqpath|zqhost/);
  }
});

test('usage errors exit 2', () => {
  for (const args of [
    ['--cleanup', 'maybe'],
    ['--conditions-refused', 'not_a_code'],
    ['--relaunch-blocked', 'python,a/b'],
    ['--relaunch-blocked', ''],
    ['--relaunch-blocked', 'python\n'],
    ['--archive-exit', '2\n'],
    ['--autopsy-exit', '0\n'],
    ['--archive-exit', 'x'],
    ['--autopsy-exit', '1.5'],
    ['--run-folder', ''],
    ['--unknown'],
    ['extra'],
  ]) {
    const res = run(...args);
    assert.equal(res.code, 2, `${args.join(' ')}: ${res.stdout}${res.stderr}`);
    assert.equal(res.stdout, '', args.join(' '));
  }
});

test("--json gives each tool's state", () => {
  const dir = runFolder(FIRST);
  const res = run('--json', '--archive-exit', '0', ...ok(dir, '--cleanup', 'awaiting'));
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /^\{[^\n]*\}\n$/);
  assert.deepEqual(JSON.parse(res.stdout), {
    doctor: { state: 'recorded', detail: 'doctor before wf_abc123: ok, 2 warning(s) (memory, defender)' },
    archive: { state: 'archived', detail: `archived to ${shown(dir)}` },
    autopsy: { state: 'generated', detail: 'autopsy generated (2 possible contributor(s))' },
    cleanup: { state: 'awaiting', detail: 'cleanup awaiting approval' },
  });

  const none = run('--json');
  assert.equal(none.code, 0, none.stderr);
  assert.deepEqual(JSON.parse(none.stdout), {
    doctor: { state: 'not_checked', detail: 'launch conditions not checked (autopsy not run)' },
    archive: { state: 'not_run', detail: 'archive not run' },
    autopsy: { state: 'not_run', detail: 'autopsy not run' },
    cleanup: { state: 'not_offered', detail: 'cleanup not offered' },
  });

  const refused = runFolder(autopsy([unavailable('wf_abc123')]));
  const states = JSON.parse(run('--json', '--archive-exit', '3', '--autopsy-exit', '0', '--run-folder', refused,
    '--cleanup', 'declined').stdout);
  assert.deepEqual(
    Object.fromEntries(Object.entries(states).map(([k, v]) => [k, v.state])),
    { doctor: 'not_recorded', archive: 'failed', autopsy: 'generated', cleanup: 'declined' },
  );
  const odd = runFolder(autopsy([entry({ state: 'inconsistent', reason: 'snapshot unreadable' })]));
  assert.equal(JSON.parse(run('--json', ...ok(odd)).stdout).doctor.state, 'inconsistent');
  assert.equal(JSON.parse(run('--json', '--autopsy-exit', '9').stdout).autopsy.state, 'failed');
});

test('a Git Bash run folder works on Windows', { skip: !IS_WINDOWS }, () => {
  const dir = runFolder(FIRST);
  const msys = shown(dir).replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
  assert.equal(
    line('--archive-exit', '0', ...ok(msys)),
    `Run tools: doctor before wf_abc123: ok, 2 warning(s) (memory, defender); archived to ${shown(dir)}; `
      + 'autopsy generated (2 possible contributor(s)); cleanup not offered',
  );
});

// Last, so it covers every output above.
test('acceptance is never mentioned', () => {
  assert.ok(SEEN.length > 20);
  for (const text of SEEN) {
    assert.doesNotMatch(text, /accept|reject|unverified|check-verify|verified/i);
  }
});
