import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const TMP = mkdtempSync(join(tmpdir(), 'pl-scripts-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

let counter = 0;
// A fresh directory whose path contains a space, as in a real project dir.
function workDir() {
  counter += 1;
  const dir = join(TMP, `case ${counter}`, 'my project');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function run(interpreter, script, args, env = {}) {
  const res = spawnSync(interpreter, [join(SCRIPTS, script), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

const findSuperpowers = (env) => run('bash', 'find-superpowers', [], env);
const taskBrief = (...args) => run('python3', 'task-brief', args);
const ledger = (...args) => run('python3', 'ledger', args);

// --- find-superpowers -------------------------------------------------------

function fakeInstall(dir, { pkgVersion, pluginVersion, prompt = true }) {
  mkdirSync(join(dir, 'skills', 'subagent-driven-development'), { recursive: true });
  if (prompt) {
    writeFileSync(
      join(dir, 'skills', 'subagent-driven-development', 'implementer-prompt.md'),
      'prompt\n',
    );
  }
  if (pkgVersion) {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'superpowers', version: pkgVersion }, null, 2),
    );
  }
  if (pluginVersion) {
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(dir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'superpowers', version: pluginVersion }, null, 2),
    );
  }
}

test('find-superpowers picks the newest install', () => {
  const root = workDir();
  fakeInstall(join(root, 'old'), { pkgVersion: '6.1.0', pluginVersion: '6.1.0' });
  fakeInstall(join(root, 'new'), { pkgVersion: '6.4.2' });
  const res = findSuperpowers({ PL_SEARCH_ROOTS: root });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout, `${join(root, 'new', 'skills')}\n`);
});

test('find-superpowers compares versions numerically across roots', () => {
  const rootA = workDir();
  const rootB = workDir();
  fakeInstall(join(rootA, 'a'), { pkgVersion: '6.4.2' });
  fakeInstall(join(rootB, 'b'), { pluginVersion: '6.10.0' });
  fakeInstall(join(rootB, 'c'), { pkgVersion: '9.0.0', prompt: false });
  const res = findSuperpowers({ PL_SEARCH_ROOTS: `${rootA}:${rootB}` });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout, `${join(rootB, 'b', 'skills')}\n`);
});

test('find-superpowers exits 3 with no output when nothing is installed', () => {
  const root = workDir();
  fakeInstall(join(root, 'incomplete'), { pkgVersion: '6.4.2', prompt: false });
  const res = findSuperpowers({ PL_SEARCH_ROOTS: `${root}:${join(root, 'missing')}` });
  assert.equal(res.code, 3);
  assert.equal(res.stdout, '');
});

test('find-superpowers rejects arguments with exit 2', () => {
  const res = run('bash', 'find-superpowers', ['extra'], { PL_SEARCH_ROOTS: workDir() });
  assert.equal(res.code, 2);
});

// --- task-brief ---------------------------------------------------------------

const PLAN = [
  '# Plan',
  '',
  '## Phase 1',
  '',
  '### Task 1: First',
  '',
  'Body of task 1.',
  '',
  '### Task 1a: Variant',
  '',
  'Body of task 1a.',
  '',
  '### Task 10: Tenth',
  '',
  'Body of task 10.',
  '',
  '### Task T13a: Lettered',
  '',
  'Do the T13a thing.',
  '',
  '```markdown',
  '### Task T99: not a real heading',
  '### Task T13b: also not a heading',
  '```',
  '',
  '#### Sub-heading inside T13a',
  '',
  'Still T13a.',
  '',
  '### Task T13b: Next',
  '',
  'Body of T13b.',
  '',
  '### Task 20: Empty',
  '',
  '### Task 21: Last',
  '',
  'Body of task 21.',
  '',
  '## Appendix',
  '',
  'Not part of any task.',
  '',
].join('\n');

function writePlan() {
  const dir = workDir();
  const plan = join(dir, 'plan file.md');
  writeFileSync(plan, PLAN);
  return { dir, plan };
}

test('task-brief extracts T13a, keeps its fenced code, and stops before T13b', () => {
  const { dir, plan } = writePlan();
  const out = join(dir, 'briefs', 'T13a brief.md');
  const res = taskBrief(plan, 'T13a', out);
  assert.equal(res.code, 0, res.stderr);
  const brief = readFileSync(out, 'utf8');
  assert.ok(brief.startsWith('### Task T13a: Lettered\n'), brief);
  assert.ok(brief.includes('Do the T13a thing.'));
  assert.ok(brief.includes('### Task T99: not a real heading'));
  assert.ok(brief.includes('#### Sub-heading inside T13a'));
  assert.ok(brief.includes('Still T13a.'));
  assert.ok(!brief.includes('Body of T13b.'));
  assert.ok(brief.endsWith('Still T13a.\n'), JSON.stringify(brief));
});

test('task-brief matches the id as a whole token', () => {
  const { dir, plan } = writePlan();
  const out = join(dir, 'task-1.md');
  const res = taskBrief(plan, '1', out);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(readFileSync(out, 'utf8'), '### Task 1: First\n\nBody of task 1.\n');
});

test('task-brief ignores headings inside fenced code', () => {
  const { dir, plan } = writePlan();
  const out = join(dir, 'T99.md');
  const res = taskBrief(plan, 'T99', out);
  assert.equal(res.code, 3);
  assert.equal(existsSync(out), false);
});

test('task-brief exits 3 for a missing id and writes nothing', () => {
  const { dir, plan } = writePlan();
  const out = join(dir, 'missing.md');
  const res = taskBrief(plan, 'T404', out);
  assert.equal(res.code, 3);
  assert.match(res.stderr, /T404/);
  assert.equal(existsSync(out), false);
});

test('task-brief exits 3 for an empty section', () => {
  const { dir, plan } = writePlan();
  const out = join(dir, 'empty.md');
  const res = taskBrief(plan, '20', out);
  assert.equal(res.code, 3);
  assert.equal(existsSync(out), false);
});

test('task-brief stops the last task at a higher-level heading', () => {
  const { dir, plan } = writePlan();
  const out = join(dir, 'last.md');
  const res = taskBrief(plan, '21', out);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(readFileSync(out, 'utf8'), '### Task 21: Last\n\nBody of task 21.\n');
});

test('task-brief treats regex characters in the id literally', () => {
  const { dir, plan } = writePlan();
  const res = taskBrief(plan, 'T1.a', join(dir, 'x.md'));
  assert.equal(res.code, 3);
});

test('task-brief refuses a task id with two headings', () => {
  const dir = workDir();
  const plan = join(dir, 'dup.md');
  writeFileSync(plan, '### Task 5: One\n\nA.\n\n### Task 5: Two\n\nB.\n');
  const out = join(dir, 'dup-brief.md');
  assert.equal(taskBrief(plan, '5', out).code, 3);
  assert.equal(existsSync(out), false);
});

test('task-brief requires the colon form and stops at a bare Task heading', () => {
  const dir = workDir();
  const plan = join(dir, 'bare.md');
  writeFileSync(
    plan,
    '## Task overview\n\nIntro.\n\n### Task 1: A\n\nBody A.\n\n### Task notes\n\nNotes.\n',
  );
  assert.equal(taskBrief(plan, 'overview', join(dir, 'o.md')).code, 3);
  const out = join(dir, 'one.md');
  const res = taskBrief(plan, '1', out);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(readFileSync(out, 'utf8'), '### Task 1: A\n\nBody A.\n');
});

test('task-brief exits 2 on a usage error', () => {
  const res = taskBrief('only-one-arg');
  assert.equal(res.code, 2);
});

// --- ledger --------------------------------------------------------------------

function appendOk(dir, lane, entry) {
  const res = ledger('append', dir, lane, JSON.stringify(entry));
  assert.equal(res.code, 0, res.stderr);
}

function status(dir) {
  const res = ledger('status', dir);
  assert.equal(res.code, 0, res.stderr);
  return JSON.parse(res.stdout);
}

test('ledger round-trips events across two lanes', () => {
  const dir = join(workDir(), 'ledger dir');
  appendOk(dir, 'alpha', { task: 'T1', event: 'committed', commits: ['abc1234'] });
  appendOk(dir, 'alpha', { task: 'T1', event: 'reviewed', rounds: 2 });
  appendOk(dir, 'beta', { task: 'T2', event: 'committed', commits: ['def5678', 'aaa0000'] });
  appendOk(dir, 'beta', { task: 'T3', event: 'ruling', text: 'keep the old name' });
  appendOk(dir, 'beta', { task: 'T3', event: 'blocked', reason: 'tests hang' });

  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const alphaLines = readFileSync(join(dir, 'alpha.jsonl'), 'utf8').trim().split('\n');
  assert.equal(alphaLines.length, 2);
  assert.deepEqual(JSON.parse(alphaLines[0]), {
    task: 'T1',
    event: 'committed',
    commits: ['abc1234'],
  });
  assert.ok(existsSync(join(dir, 'beta.jsonl')));

  assert.deepEqual(status(dir), {
    done: ['T1', 'T2'],
    reviewed: ['T1'],
    blocked: ['T3'],
    start_points: {},
    carry: {},
  });
});

test('ledger: a commit after a review makes the task unreviewed again', () => {
  const dir = workDir();
  appendOk(dir, 'alpha', { task: 'T13a', event: 'committed', commits: ['111'] });
  appendOk(dir, 'alpha', { task: 'T13a', event: 'reviewed', rounds: 1 });
  assert.deepEqual(status(dir).reviewed, ['T13a']);
  appendOk(dir, 'alpha', { task: 'T13a', event: 'committed', commits: ['222'] });
  assert.deepEqual(status(dir), { done: ['T13a'], reviewed: [], blocked: [], start_points: {}, carry: {} });
  appendOk(dir, 'alpha', { task: 'T13a', event: 'reviewed', rounds: 3 });
  assert.deepEqual(status(dir).reviewed, ['T13a']);
});

test('ledger: a commit after a block clears the block', () => {
  const dir = workDir();
  appendOk(dir, 'alpha', { task: 'T7', event: 'blocked', reason: 'flaky' });
  assert.deepEqual(status(dir), { done: [], reviewed: [], blocked: ['T7'], start_points: {}, carry: {} });
  appendOk(dir, 'alpha', { task: 'T7', event: 'committed', commits: ['333'] });
  assert.deepEqual(status(dir), { done: ['T7'], reviewed: [], blocked: [], start_points: {}, carry: {} });
});

test('ledger: a settled task is done and reviewed, even after a block and with no commits', () => {
  const dir = workDir();
  appendOk(dir, 'alpha', { task: 'T2', event: 'blocked', reason: 'upstream missing' });
  appendOk(dir, 'alpha', { task: 'T2', event: 'ruling', text: 'Ruling: park - minor - low' });
  appendOk(dir, 'alpha', { task: 'T2', event: 'settled', outcome: 'park', base: 'b0', head: 'b0' });
  appendOk(dir, 'alpha', { task: 'T3', event: 'committed', commits: ['c1'] });
  appendOk(dir, 'alpha', { task: 'T3', event: 'settled', outcome: 'unblock', base: 'b0', head: 'c1' });
  assert.deepEqual(status(dir), { done: ['T2', 'T3'], reviewed: ['T2', 'T3'], blocked: [], start_points: {}, carry: {} });
  // A later commit makes the task unreviewed again, as after a review.
  appendOk(dir, 'alpha', { task: 'T3', event: 'committed', commits: ['c2'] });
  assert.deepEqual(status(dir).reviewed, ['T2']);
});

test('ledger: run_started events give the earliest start points per phase', () => {
  const dir = workDir();
  appendOk(dir, '_run', { task: '_run', event: 'run_started', phase: 'setup', head: 'aaa111' });
  appendOk(dir, 'prelude', { task: 'P1', event: 'committed', commits: ['bbb222'] });
  assert.deepEqual(status(dir), {
    done: ['P1'],
    reviewed: [],
    blocked: [],
    start_points: { prelude: 'aaa111' },
    carry: {},
  });
  appendOk(dir, '_run', { task: '_run', event: 'run_started', phase: 'setup', head: 'ccc333' });
  appendOk(dir, '_run', { task: '_run', event: 'run_started', phase: 'join', head: 'ddd444' });
  appendOk(dir, '_run', { task: '_run', event: 'run_started', phase: 'join', head: 'eee555' });
  assert.deepEqual(status(dir), {
    done: ['P1'],
    reviewed: [],
    blocked: [],
    start_points: { prelude: 'aaa111', join: 'ddd444' },
    carry: {},
  });
  const lines = readFileSync(join(dir, '_run.jsonl'), 'utf8').trim().split('\n');
  assert.deepEqual(JSON.parse(lines[0]), {
    task: '_run',
    event: 'run_started',
    phase: 'setup',
    head: 'aaa111',
  });
});

test('ledger: a join start point alone omits the prelude key', () => {
  const dir = workDir();
  appendOk(dir, '_run', { task: '_run', event: 'run_started', phase: 'join', head: 'fff666' });
  assert.deepEqual(status(dir), { done: [], reviewed: [], blocked: [], start_points: { join: 'fff666' }, carry: {} });
});

// Node's spawn() starts children too far apart to hit a first-append race, so
// one bash process launches every append of a trial in the background at once.
const RACE = `
ledger="$1"; base="$2"; trials="$3"; lanes="$4"
for t in $(seq 1 "$trials"); do
  for l in $(seq 1 "$lanes"); do
    ( python3 "$ledger" append "$base/trial $t/fresh ledger" "lane$l" \\
        "{\\"task\\":\\"T$l\\",\\"event\\":\\"committed\\",\\"commits\\":[\\"a\\"]}"
      echo "$t $l $?" ) &
  done
  wait
done
`;

test('ledger: concurrent first appends to a missing directory all succeed', () => {
  const base = workDir();
  const trials = 25;
  const lanes = 8;
  const res = spawnSync(
    'bash',
    ['-c', RACE, 'race', join(SCRIPTS, 'ledger'), base, String(trials), String(lanes)],
    { encoding: 'utf8' },
  );
  assert.equal(res.status, 0, res.stderr);
  const rows = res.stdout.trim().split('\n');
  assert.equal(rows.length, trials * lanes);
  const failed = rows.filter((row) => !row.endsWith(' 0'));
  assert.deepEqual(failed, [], res.stderr);
  const expected = Array.from({ length: lanes }, (_, i) => `T${i + 1}`).sort();
  for (let t = 1; t <= trials; t += 1) {
    const dir = join(base, `trial ${t}`, 'fresh ledger');
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.deepEqual(status(dir).done.sort(), expected);
  }
});

test('ledger append refuses a DIR that is a file with exit 3', () => {
  const file = join(workDir(), 'not a dir');
  writeFileSync(file, '');
  const res = ledger('append', file, 'alpha', JSON.stringify({ task: 'T1', event: 'blocked', reason: 'x' }));
  assert.equal(res.code, 3, res.stderr);
});

test('ledger status of a missing directory is empty', () => {
  const dir = join(workDir(), 'never created');
  assert.deepEqual(status(dir), { done: [], reviewed: [], blocked: [], start_points: {}, carry: {} });
  assert.equal(existsSync(dir), false);
});

test('ledger append rejects malformed entries with exit 2', () => {
  const dir = workDir();
  const bad = [
    'not json',
    '[]',
    JSON.stringify({ event: 'committed', commits: ['a'] }),
    JSON.stringify({ task: 'T1' }),
    JSON.stringify({ task: 'T1', event: 'exploded' }),
    JSON.stringify({ task: 'T1', event: 'committed' }),
    JSON.stringify({ task: 'T1', event: 'committed', commits: 'abc' }),
    JSON.stringify({ task: 'T1', event: 'reviewed' }),
    JSON.stringify({ task: 'T1', event: 'reviewed', rounds: true }),
    JSON.stringify({ task: 'T1', event: 'ruling' }),
    JSON.stringify({ task: 'T1', event: 'blocked' }),
    JSON.stringify({ task: '_run', event: 'run_started', head: 'abc' }),
    JSON.stringify({ task: '_run', event: 'run_started', phase: 'integrate', head: 'abc' }),
    JSON.stringify({ task: '_run', event: 'run_started', phase: 'setup' }),
    JSON.stringify({ task: '_run', event: 'run_started', phase: 'setup', head: '' }),
    JSON.stringify({ task: '_run', event: 'run_started', phase: 'join', head: 7 }),
    JSON.stringify({ task: 'T1', event: 'settled', base: 'a', head: 'a' }),
    JSON.stringify({ task: 'T1', event: 'settled', outcome: 'stop', base: 'a', head: 'a' }),
    JSON.stringify({ task: 'T1', event: 'settled', outcome: 'park', head: 'a' }),
    JSON.stringify({ task: 'T1', event: 'settled', outcome: 'unblock', base: 'a', head: '' }),
  ];
  for (const entry of bad) {
    const res = ledger('append', dir, 'alpha', entry);
    assert.equal(res.code, 2, `expected exit 2 for ${entry}`);
  }
  assert.equal(existsSync(join(dir, 'alpha.jsonl')), false);
});

test('ledger append refuses an unsafe lane name with exit 3', () => {
  const dir = workDir();
  const entry = JSON.stringify({ task: 'T1', event: 'blocked', reason: 'x' });
  for (const lane of ['../escape', 'a/b', '.hidden', '', 'alpha\n']) {
    const res = ledger('append', dir, lane, entry);
    assert.equal(res.code, 3, `expected exit 3 for lane ${JSON.stringify(lane)}`);
  }
});

test('ledger exits 2 on usage errors', () => {
  assert.equal(ledger().code, 2);
  assert.equal(ledger('status').code, 2);
  assert.equal(ledger('append', 'dir', 'lane').code, 2);
  assert.equal(ledger('frobnicate', 'dir').code, 2);
});

test('ledger: carry holds the last adjudicator ruling after the last commit of a task whose final outcome is unblock', () => {
  const dir = workDir();
  appendOk(dir, 'alpha', { task: 'T3', event: 'ruling', by: 'adjudicator', text: 'Ruling: answer before commit - x - y' });
  appendOk(dir, 'alpha', { task: 'T3', event: 'committed', commits: ['c1'] });
  appendOk(dir, 'alpha', { task: 'T3', event: 'ruling', by: 'adjudicator', text: 'Ruling: stub the client - unblocks T4 - rework' });
  appendOk(dir, 'alpha', { task: 'T3', event: 'ruling', text: 'Ruling: implementer naming choice - small - low' });
  appendOk(dir, 'alpha', { task: 'T3', event: 'settled', outcome: 'unblock', base: 'b0', head: 'c1' });
  appendOk(dir, 'alpha', { task: 'T5', event: 'ruling', by: 'adjudicator', text: 'Ruling: park - minor - low' });
  appendOk(dir, 'alpha', { task: 'T5', event: 'settled', outcome: 'park', base: 'b1', head: 'b1' });
  appendOk(dir, 'beta', { task: 'T7', event: 'ruling', text: 'Ruling: implementer only - x - y' });
  appendOk(dir, 'beta', { task: 'T7', event: 'settled', outcome: 'unblock', base: 'b2', head: 'b2' });
  // Only the adjudicator's ruling after the last commit carries; implementer rulings never do.
  assert.deepEqual(status(dir).carry, { T3: 'Ruling: stub the client - unblocks T4 - rework' });
  // A later commit means the task ran again; its unblock note no longer carries.
  appendOk(dir, 'alpha', { task: 'T3', event: 'committed', commits: ['c9'] });
  assert.deepEqual(status(dir).carry, {});
});
