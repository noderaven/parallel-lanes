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
import { dirname, join } from 'node:path';
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

// Every file of a superpowers install that a run uses (find-superpowers
// requires them all). prompt: false leaves out the implementer prompt;
// skip names one more file to leave out.
const SP_FILES = [
  'subagent-driven-development/implementer-prompt.md',
  'subagent-driven-development/task-reviewer-prompt.md',
  'subagent-driven-development/re-review-prompt.md',
  'subagent-driven-development/scripts/review-package',
  'requesting-code-review/code-reviewer.md',
];

function fakeInstall(dir, { pkgVersion, pluginVersion, prompt = true, skip = null }) {
  for (const rel of SP_FILES) {
    if ((!prompt && rel.endsWith('implementer-prompt.md')) || rel === skip) continue;
    mkdirSync(dirname(join(dir, 'skills', rel)), { recursive: true });
    writeFileSync(join(dir, 'skills', rel), 'file\n');
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

test('find-superpowers exits 3 when the search roots have no candidates at all', () => {
  const res = findSuperpowers({ PL_SEARCH_ROOTS: `${workDir()}:` });
  assert.equal(res.code, 3);
  assert.equal(res.stdout, '');
  assert.equal(res.stderr, '');
});

test('find-superpowers skips an install that lacks a file a run needs', () => {
  const root = workDir();
  fakeInstall(join(root, 'complete'), { pkgVersion: '6.4.2' });
  fakeInstall(join(root, 'newer but partial'), { pkgVersion: '9.0.0', skip: 'subagent-driven-development/re-review-prompt.md' });
  const res = findSuperpowers({ PL_SEARCH_ROOTS: root });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout.trim(), join(root, 'complete', 'skills'));
});

test('find-superpowers searches the CLAUDE_CONFIG_DIR plugin cache by default', () => {
  const config = join(workDir(), 'config dir');
  fakeInstall(join(config, 'plugins', 'cache', 'mkt', 'superpowers', '6.4.2'), { pkgVersion: '6.4.2' });
  const env = { CLAUDE_CONFIG_DIR: config, HOME: join(workDir(), 'empty home') };
  delete process.env.PL_SEARCH_ROOTS;
  const res = findSuperpowers(env);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout.trim(), join(config, 'plugins', 'cache', 'mkt', 'superpowers', '6.4.2', 'skills'));
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

// Writes planText to a fresh plan file and runs task-brief for id with any
// extra args. Returns the result and the brief text (null when not written).
function briefFor(planText, id, ...extra) {
  const dir = workDir();
  const plan = join(dir, 'plan file.md');
  writeFileSync(plan, planText);
  const out = join(dir, 'briefs', `${id} brief.md`);
  const res = taskBrief(plan, id, out, ...extra);
  return { res, brief: existsSync(out) ? readFileSync(out, 'utf8') : null };
}

const appendedHeadings = (brief) =>
  brief.split('\n').filter((l) => l.startsWith('## Produces of Task '));

const CONSUMER = [
  '### Task C1: Consumer',
  '',
  '**Interfaces:**',
  '- Consumes: G1, G2; `DAYS` (core).',
  '- Produces: `check(plan)`.',
  '',
  'Body of C1.',
];
const PRODUCERS = [
  '### Task G1: Generator',
  '',
  '**Interfaces:**',
  '- Consumes: nothing.',
  '- Produces:',
  '  - `gen(n)` returns a list of weeks.',
  '    Each week has a stage divider.',
  '',
  '  - Dividers sit at the top, one per week.',
  '',
  'Body of G1.',
  '',
  '### Task G2: Second generator',
  '',
  '- Produces: `days()` returns DAYS.',
  '  Continued on a deeper line.',
  '- Another bullet.',
  '',
];

test('task-brief appends the Produces of tasks named in Consumes', () => {
  const plan = ['# Plan', '', ...CONSUMER, '', ...PRODUCERS].join('\n');
  const { res, brief } = briefFor(plan, 'C1');
  assert.equal(res.code, 0, res.stderr);
  const own = [...CONSUMER, ''].join('\n');
  const g1 = [
    '## Produces of Task G1: Generator (consumed by this task)',
    '',
    '- Produces:',
    '  - `gen(n)` returns a list of weeks.',
    '    Each week has a stage divider.',
    '',
    '  - Dividers sit at the top, one per week.',
  ].join('\n');
  const g2 = [
    '## Produces of Task G2: Second generator (consumed by this task)',
    '',
    '- Produces: `days()` returns DAYS.',
    '  Continued on a deeper line.',
  ].join('\n');
  assert.equal(brief, `${own}\n${g1}\n\n${g2}\n`);
});

test('task-brief reads numeric ids only after Task or Tasks', () => {
  const lines = ['# Plan', ''];
  for (const id of ['2', '3', '4', '5', '6', '9', '10', '13']) {
    lines.push(`### Task ${id}: Number ${id}`, '', `- Produces: out${id}.`, '');
  }
  lines.push(
    '### Task 8: Consumer',
    '',
    "- Consumes: the API contract (Task 4); Task 3's output; Tasks 10 and 13; Tasks 5, 6 and 9; 3 mi a week 2",
    '',
  );
  const { res, brief } = briefFor(lines.join('\n'), '8');
  assert.equal(res.code, 0, res.stderr);
  const ids = appendedHeadings(brief).map((h) => h.match(/^## Produces of Task (\S+):/)[1]);
  assert.deepEqual(ids, ['3', '4', '5', '6', '9', '10', '13']);
});

test('task-brief stops a Produces block at the next bullet at its indent', () => {
  const plan = [
    '### Task A1: Producer',
    '',
    '**Interfaces:**',
    '- Produces: `api()`.',
    '  - returns 404 no_profile when the profile is absent or invalid.',
    '',
    '- [ ] **Step 1: Write the failing test**',
    '',
    '### Task B1: Consumer',
    '',
    '- Consumes: A1.',
    '',
  ].join('\n');
  const { res, brief } = briefFor(plan, 'B1');
  assert.equal(res.code, 0, res.stderr);
  assert.ok(!brief.includes('Step 1'), brief);
  assert.ok(
    brief.endsWith(
      '## Produces of Task A1: Producer (consumed by this task)\n\n' +
        '- Produces: `api()`.\n' +
        '  - returns 404 no_profile when the profile is absent or invalid.\n',
    ),
    JSON.stringify(brief),
  );
});

test('task-brief copies a single-line Produces block', () => {
  const plan = [
    '### Task A1: Producer',
    '',
    '- Produces: `foo(x)` returns a string.',
    'Prose after the bullet.',
    '',
    '### Task B1: Consumer',
    '',
    '- Consumes: A1.',
    '',
  ].join('\n');
  const { res, brief } = briefFor(plan, 'B1');
  assert.equal(res.code, 0, res.stderr);
  assert.equal(
    brief,
    '### Task B1: Consumer\n\n- Consumes: A1.\n\n' +
      '## Produces of Task A1: Producer (consumed by this task)\n\n' +
      '- Produces: `foo(x)` returns a string.\n',
  );
});

test('task-brief notes a missing Produces block and exits 0', () => {
  const plan = [
    '### Task A1: Producer',
    '',
    'No interfaces here.',
    '',
    '### Task B1: Consumer',
    '',
    '- Consumes: A1.',
    '',
  ].join('\n');
  const { res, brief } = briefFor(plan, 'B1');
  assert.equal(res.code, 0, res.stderr);
  assert.equal(
    brief,
    '### Task B1: Consumer\n\n- Consumes: A1.\n\n' +
      '## Produces of Task A1: Producer (consumed by this task)\n\n' +
      'Task A1 has no Produces block in the plan.\n',
  );
});

test('task-brief notes an --also id with no heading and exits 0', () => {
  const plan = [
    '### Task A1: Producer',
    '',
    '- Produces: `foo()`.',
    '',
    '### Task B1: Consumer',
    '',
    'Body of B1.',
    '',
  ].join('\n');
  const { res, brief } = briefFor(plan, 'B1', '--also', 'Z9', '--also', 'A1');
  assert.equal(res.code, 0, res.stderr);
  assert.equal(
    brief,
    '### Task B1: Consumer\n\nBody of B1.\n\n' +
      '## Produces of Task A1: Producer (consumed by this task)\n\n' +
      '- Produces: `foo()`.\n\n' +
      'Task Z9 has no heading in the plan.\n',
  );
});

test('task-brief leaves a brief without a Consumes bullet unchanged', () => {
  const { res, brief } = briefFor(PLAN, 'T13a');
  assert.equal(res.code, 0, res.stderr);
  const lines = PLAN.split('\n');
  const start = lines.indexOf('### Task T13a: Lettered');
  const end = lines.indexOf('### Task T13b: Next');
  assert.equal(brief, `${lines.slice(start, end - 1).join('\n')}\n`);
  assert.equal(appendedHeadings(brief).length, 0);
});

test('task-brief reads a Consumes bullet without an Interfaces heading', () => {
  const plan = [
    '### Task A1: Producer',
    '',
    '- Produces: `foo()`.',
    '',
    '### Task B1: Consumer',
    '',
    'Some prose first.',
    '',
    '- Consumes: the foo helper',
    '  from A1, used twice.',
    '',
  ].join('\n');
  const { res, brief } = briefFor(plan, 'B1');
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(appendedHeadings(brief), [
    '## Produces of Task A1: Producer (consumed by this task)',
  ]);
});

test('task-brief skips self-references, duplicates, and ids inside code fences', () => {
  const plan = [
    '### Task G1: Producer',
    '',
    '- Produces: `g1()`.',
    '',
    '### Task G9: Fenced only',
    '',
    '- Produces: `g9()`.',
    '',
    '### Task C1: Consumer',
    '',
    '```markdown',
    '- Consumes: G9',
    '```',
    '',
    '- Consumes: C1 itself, G1 and again G1.',
    '',
  ].join('\n');
  const { res, brief } = briefFor(plan, 'C1', '--also', 'G1', '--also', 'C1');
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(appendedHeadings(brief), [
    '## Produces of Task G1: Producer (consumed by this task)',
  ]);
  assert.ok(!brief.includes('g9()'), brief);
  assert.ok(!brief.includes('has no'), brief);
});

test('task-brief exits 2 for --also without an id', () => {
  const plan = '### Task A1: One\n\nBody.\n';
  for (const extra of [['--also'], ['--also', ''], ['--other', 'A1']]) {
    const { res, brief } = briefFor(plan, 'A1', ...extra);
    assert.equal(res.code, 2, `${extra.join(' ')}: ${res.stderr}`);
    assert.equal(brief, null);
  }
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

// The keys ledger status has always printed, with their original meaning.
const core = ({ done, reviewed, blocked, start_points, carry }) => ({ done, reviewed, blocked, start_points, carry });

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

  assert.deepEqual(core(status(dir)), {
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
  assert.deepEqual(core(status(dir)), { done: ['T13a'], reviewed: [], blocked: [], start_points: {}, carry: {} });
  appendOk(dir, 'alpha', { task: 'T13a', event: 'reviewed', rounds: 3 });
  assert.deepEqual(status(dir).reviewed, ['T13a']);
});

test('ledger: a commit after a block clears the block', () => {
  const dir = workDir();
  appendOk(dir, 'alpha', { task: 'T7', event: 'blocked', reason: 'flaky' });
  assert.deepEqual(core(status(dir)), { done: [], reviewed: [], blocked: ['T7'], start_points: {}, carry: {} });
  appendOk(dir, 'alpha', { task: 'T7', event: 'committed', commits: ['333'] });
  assert.deepEqual(core(status(dir)), { done: ['T7'], reviewed: [], blocked: [], start_points: {}, carry: {} });
});

test('ledger: a settled task is done and reviewed, even after a block and with no commits', () => {
  const dir = workDir();
  appendOk(dir, 'alpha', { task: 'T2', event: 'blocked', reason: 'upstream missing' });
  appendOk(dir, 'alpha', { task: 'T2', event: 'ruling', text: 'Ruling: park - minor - low' });
  appendOk(dir, 'alpha', { task: 'T2', event: 'settled', outcome: 'park', base: 'b0', head: 'b0' });
  appendOk(dir, 'alpha', { task: 'T3', event: 'committed', commits: ['c1'] });
  appendOk(dir, 'alpha', { task: 'T3', event: 'settled', outcome: 'unblock', base: 'b0', head: 'c1' });
  assert.deepEqual(core(status(dir)), { done: ['T2', 'T3'], reviewed: ['T2', 'T3'], blocked: [], start_points: {}, carry: {} });
  // A later commit makes the task unreviewed again, as after a review.
  appendOk(dir, 'alpha', { task: 'T3', event: 'committed', commits: ['c2'] });
  assert.deepEqual(status(dir).reviewed, ['T2']);
});

test('ledger: run_started events give the earliest start points per phase', () => {
  const dir = workDir();
  appendOk(dir, '_run', { task: '_run', event: 'run_started', phase: 'setup', head: 'aaa111' });
  appendOk(dir, 'prelude', { task: 'P1', event: 'committed', commits: ['bbb222'] });
  assert.deepEqual(core(status(dir)), {
    done: ['P1'],
    reviewed: [],
    blocked: [],
    start_points: { prelude: 'aaa111' },
    carry: {},
  });
  appendOk(dir, '_run', { task: '_run', event: 'run_started', phase: 'setup', head: 'ccc333' });
  appendOk(dir, '_run', { task: '_run', event: 'run_started', phase: 'join', head: 'ddd444' });
  appendOk(dir, '_run', { task: '_run', event: 'run_started', phase: 'join', head: 'eee555' });
  assert.deepEqual(core(status(dir)), {
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
  assert.deepEqual(core(status(dir)), { done: [], reviewed: [], blocked: [], start_points: { join: 'fff666' }, carry: {} });
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
  assert.deepEqual(core(status(dir)), { done: [], reviewed: [], blocked: [], start_points: {}, carry: {} });
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

test('task-brief does not read G1.5 as a reference to G1', () => {
  const plan = [
    '# Plan', '',
    '### Task G1: First', '', '- Produces: `one()`.', '',
    '### Task G1.5: Between', '', '- Produces: `onefive()`.', '',
    '### Task C1: Consumer', '', "- Consumes: G1.5's output.", '',
    '### Task C2: Other consumer', '', '- Consumes: G1. Also G1.5.', '',
  ].join('\n');
  const a = briefFor(plan, 'C1');
  assert.equal(a.res.code, 0, a.res.stderr);
  assert.deepEqual(appendedHeadings(a.brief).map((h) => h.split(':')[0]), ['## Produces of Task G1.5']);
  const b = briefFor(plan, 'C2');
  assert.deepEqual(appendedHeadings(b.brief).map((h) => h.split(':')[0]), [
    '## Produces of Task G1', '## Produces of Task G1.5',
  ]);
});

test('task-brief ends a Task list at an item that is followed by a word', () => {
  const lines = ['# Plan', ''];
  for (const id of ['3', '4', '10']) lines.push(`### Task ${id}: Number ${id}`, '', `- Produces: out${id}.`, '');
  lines.push('### Task 8: Consumer', '', '- Consumes: Task 10 and 3 mi a week; Task 4 and 3 mi.', '');
  const { res, brief } = briefFor(lines.join('\n'), '8');
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(appendedHeadings(brief).map((h) => h.split(':')[0]), [
    '## Produces of Task 4', '## Produces of Task 10',
  ]);
});

test('task-brief copies a fenced contract that starts right after the Produces bullet', () => {
  const plan = [
    '# Plan', '',
    '### Task A1: Producer', '',
    '- Produces:', '```js', '- not a bullet', 'export const a = 1;', '```', '',
    '- Next bullet.', '',
    '### Task C1: Consumer', '', '- Consumes: A1', '',
  ].join('\n');
  const { res, brief } = briefFor(plan, 'C1');
  assert.equal(res.code, 0, res.stderr);
  assert.ok(brief.endsWith(
    '(consumed by this task)\n\n- Produces:\n```js\n- not a bullet\nexport const a = 1;\n```\n'), brief);
});

test('task-brief runs a fence opened inside a Produces block to its close', () => {
  const plan = [
    '# Plan', '',
    '### Task A1: Producer', '',
    '- Produces: the api.', '  ```js', 'less indented body', '- also not a bullet', '  ```', '',
    '- Next bullet.', '',
    '### Task C1: Consumer', '', '- Consumes: A1', '',
  ].join('\n');
  const { res, brief } = briefFor(plan, 'C1');
  assert.equal(res.code, 0, res.stderr);
  assert.ok(brief.endsWith('- Produces: the api.\n  ```js\nless indented body\n- also not a bullet\n  ```\n'), brief);
});
