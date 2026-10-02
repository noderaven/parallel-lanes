import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';

const SCRIPT = join(SKILL_DIR, 'scripts', 'derive-lanes');
const FIXTURE = join(SKILL_DIR, 'tests', 'fixtures', 'plan-five-lanes.md');
const TMP = mkdtempSync(join(tmpdir(), 'pl-derive-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

let counter = 0;
// Write a plan into a fresh directory whose path contains a space.
function planFile(text) {
  counter += 1;
  const dir = join(TMP, `case ${counter}`, 'my project');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'plan.md');
  writeFileSync(path, text);
  return path;
}

function derive(...args) {
  const res = spawnSync('python3', [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

function deriveJson(...args) {
  const res = derive(...args);
  assert.equal(res.code, 0, res.stderr);
  return { out: JSON.parse(res.stdout), stderr: res.stderr };
}

const byId = (out) => Object.fromEntries(out.tasks.map((t) => [t.id, t]));

// --- the condensed acme remote-ingest plan ---------------------------------

const FIXTURE_GROUPS = [
  ['T0', 'T9'],
  ['T1'],
  ['T2', 'T3', 'T4', 'T5', 'T7', 'T8', 'T11', 'T12'],
  ['T6'],
  ['T10'],
  ['T13a', 'T13b', 'T14a', 'T14b', 'T14c'],
  ['T13c'],
  ['T15'],
  ['T16'],
  ['T17'],
  ['T18', 'T19a', 'T19b'],
  ['T20'],
  ['T21'],
  ['T22'],
  ['T23'],
  ['T24'],
  ['T25'],
  ['T26'],
];

test('derive-lanes parses every task heading in plan order, including T13a-style ids', () => {
  const { out } = deriveJson(FIXTURE);
  assert.deepEqual(
    out.tasks.map((t) => t.id),
    [
      'T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10', 'T11', 'T12',
      'T13a', 'T13b', 'T13c', 'T14a', 'T14b', 'T14c', 'T15', 'T16', 'T17', 'T18',
      'T19a', 'T19b', 'T20', 'T21', 'T22', 'T23', 'T24', 'T25', 'T26',
    ],
  );
  const t = byId(out);
  assert.equal(t.T13a.title, 'Untrusted SQLite open (Section 3 steps 1-5)');
  assert.equal(t.T16.title, 'Live push test with real TLS');
  assert.equal(t.T0.title, 'Shared upload caps and public expand_paths');
});

test('derive-lanes reads backticked paths from Create/Modify/Test clauses only', () => {
  const t = byId(deriveJson(FIXTURE).out);
  assert.deepEqual(t.T1.files, [
    'acme/db/migrations.py',
    'acme/db/schema.sql',
    'tests/test_migrations.py',
  ]);
  // Parenthetical identifiers are not paths.
  assert.deepEqual(t.T3.files, [
    'acme/db/store.py',
    'acme/api/schemas.py',
    'tests/test_store_web_reads.py',
  ]);
  assert.deepEqual(t.T18.files, [
    'frontend/src/pages/ApiTokens.tsx',
    'frontend/src/pages/ApiTokens.test.tsx',
    'frontend/src/App.tsx',
  ]);
  // A Files line wrapped onto a second line keeps the paths after the wrap.
  assert.deepEqual(t.T6.files, [
    'acme/api/ingest_auth.py',
    'acme/api/auth.py',
    'tests/test_api_ingest_auth.py',
  ]);
  assert.deepEqual(t.T21.files, [
    'deploy/nginx-acme.conf.example',
    '.env.example',
    'docker-compose.yml',
    'tests/test_deploy_examples.py',
  ]);
  assert.deepEqual(t.T24.files, []);
  // Backticks outside a Files block are not files.
  assert.deepEqual(t.T25.files, []);
});

test('derive-lanes takes deps from heading brackets and Consumes lines', () => {
  const t = byId(deriveJson(FIXTURE).out);
  assert.deepEqual(t.T0.deps, []);
  assert.deepEqual(t.T2.deps, ['T1']);
  assert.deepEqual(t.T3.deps, ['T1', 'T2']);
  assert.deepEqual(t.T13c.deps, ['T13a', 'T13b']);
  assert.deepEqual(t.T17.deps, ['T0', 'T3', 'T7', 'T8', 'T11']);
  assert.deepEqual(t.T19b.deps, ['T3', 'T17', 'T19a']);
  assert.deepEqual(t.T16.deps, ['T2', 'T11', 'T12', 'T13c', 'T15', 'T20', 'T22']);
  assert.deepEqual(t.T26.deps, ['T25']);
});

test('derive-lanes groups the fixture by shared files only', () => {
  const { out } = deriveJson(FIXTURE);
  assert.deepEqual(out.groups, FIXTURE_GROUPS);
  assert.equal(out.note, undefined);
});

test('derive-lanes reports bridge files and the parts their removal leaves', () => {
  const { out } = deriveJson(FIXTURE);
  assert.deepEqual(out.bridge_files, [
    {
      file: 'acme/db/store.py',
      splits_into: [['T2'], ['T3', 'T4', 'T7', 'T8', 'T11', 'T12'], ['T5']],
    },
    {
      file: 'acme/api/schemas.py',
      splits_into: [['T2', 'T3', 'T5'], ['T4', 'T7', 'T11', 'T12'], ['T8']],
    },
    {
      file: 'acme/api/app.py',
      splits_into: [['T2', 'T3', 'T5', 'T7', 'T8'], ['T4'], ['T11', 'T12']],
    },
    {
      file: 'tests/test_architecture.py',
      splits_into: [['T13a', 'T13b'], ['T14a', 'T14b', 'T14c']],
    },
    {
      file: 'frontend/src/App.tsx',
      splits_into: [['T18'], ['T19a', 'T19b']],
    },
  ]);
});

test('derive-lanes lists deps that cross group boundaries', () => {
  const { out } = deriveJson(FIXTURE);
  const cross = out.cross_group_deps;
  const groupOf = {};
  out.groups.forEach((g, i) => g.forEach((id) => { groupOf[id] = i; }));
  for (const c of cross) {
    assert.equal(c.task_group, groupOf[c.task]);
    assert.equal(c.dep_group, groupOf[c.depends_on]);
    assert.notEqual(c.task_group, c.dep_group);
  }
  // A frontend task consumes a backend contract.
  assert.ok(cross.some((c) => c.task === 'T17' && c.depends_on === 'T7'));
  assert.deepEqual(
    cross.find((c) => c.task === 'T17' && c.depends_on === 'T7'),
    { task: 'T17', depends_on: 'T7', task_group: 9, dep_group: 2 },
  );
  // Linked by deps but not by files.
  assert.deepEqual(
    cross.filter((c) => c.task === 'T13c'),
    [
      { task: 'T13c', depends_on: 'T13a', task_group: 6, dep_group: 5 },
      { task: 'T13c', depends_on: 'T13b', task_group: 6, dep_group: 5 },
    ],
  );
  // Same-group deps are not listed.
  assert.ok(!cross.some((c) => c.task === 'T12' && c.depends_on === 'T11'));
  assert.ok(!cross.some((c) => c.task === 'T14b' && c.depends_on === 'T14a'));
  // Entries follow plan order of the depending task.
  assert.deepEqual(
    cross.filter((c) => c.task === 'T2' || c.task === 'T1'),
    [
      { task: 'T1', depends_on: 'T0', task_group: 1, dep_group: 0 },
      { task: 'T2', depends_on: 'T1', task_group: 2, dep_group: 1 },
    ],
  );
});

test('derive-lanes --max-lanes adds a note only when groups exceed it', () => {
  const over = deriveJson(FIXTURE, '--max-lanes', '5').out;
  assert.match(over.note, /18 groups/);
  assert.match(over.note, /--max-lanes 5/);
  assert.deepEqual(over.groups, FIXTURE_GROUPS);
  const fits = deriveJson('--max-lanes=18', FIXTURE).out;
  assert.equal(fits.note, undefined);
});

test('derive-lanes warns about tasks without a Files block', () => {
  const { stderr } = deriveJson(FIXTURE);
  assert.match(stderr, /warning/);
  assert.match(stderr, /T25, T26/);
});

// --- other plan shapes ------------------------------------------------------

test('derive-lanes gives one group per task and a warning when no task has Files', () => {
  const plan = planFile(
    [
      '# Plan',
      '',
      '### Task 1: First',
      'Do a thing in `a.py`.',
      '',
      '### Task 2: Second',
      '- Consumes: Task 1',
      '',
      '### Task 10: Tenth',
      'Touch `a.py` too.',
      '',
    ].join('\n'),
  );
  const res = derive(plan);
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.groups, [['1'], ['2'], ['10']]);
  assert.deepEqual(out.tasks.map((t) => t.files), [[], [], []]);
  assert.deepEqual(out.tasks[1].deps, ['1']);
  assert.deepEqual(out.bridge_files, []);
  assert.match(res.stderr, /warning: no task has a Files block/);
});

test('derive-lanes reads multi-line bullet Files blocks and ignores fenced code', () => {
  const plan = planFile(
    [
      '# Plan',
      '',
      '## Task 1: Model',
      '',
      '**Files:**',
      '- Create: `src/model.py`',
      '- Modify: `src/db.py:120-145`',
      '- Test: `tests/test_model.py`',
      '- Reference: `docs/notes.md`',
      '',
      '```markdown',
      '## Task 9: Not a task',
      '**Files:** Modify `src/db.py`',
      '- Consumes: Task 1',
      '```',
      '',
      '## Task 2: View [1]',
      '',
      '**Files:**',
      '- Create: `src/view.py`',
      '- Modify: `./src/db.py`',
      '',
      '## Task 3: Docs',
      '',
      '**Files:** Modify `README.md`',
      '- Consumes: Task 2 view, and task 1 indirectly; Tasks 1-2',
      '',
    ].join('\n'),
  );
  const { out, stderr } = deriveJson(plan);
  assert.equal(stderr, '');
  assert.deepEqual(out.tasks, [
    {
      id: '1',
      title: 'Model',
      files: ['src/model.py', 'src/db.py', 'tests/test_model.py'],
      deps: [],
    },
    { id: '2', title: 'View', files: ['src/view.py', 'src/db.py'], deps: ['1'] },
    { id: '3', title: 'Docs', files: ['README.md'], deps: ['1', '2'] },
  ]);
  assert.deepEqual(out.groups, [['1', '2'], ['3']]);
  assert.deepEqual(out.bridge_files, [
    { file: 'src/db.py', splits_into: [['1'], ['2']] },
  ]);
  assert.deepEqual(out.cross_group_deps, [
    { task: '3', depends_on: '1', task_group: 1, dep_group: 0 },
    { task: '3', depends_on: '2', task_group: 1, dep_group: 0 },
  ]);
});

test('derive-lanes treats a Task heading without the colon form as a boundary, not a task', () => {
  const plan = planFile(
    [
      '# Plan',
      '',
      '## Task overview',
      '',
      'Lanes are described below.',
      '',
      '### Task 1: A',
      '',
      '**Files:** Create `a.py`',
      '',
      '### Task 2 (join): B',
      '',
      '**Files:** Create `b.py`',
      '',
      '### Task notes',
      '',
      '**Files:** Modify `a.py`',
      '- Consumes: Task 1',
      '',
    ].join('\n'),
  );
  const { out, stderr } = deriveJson(plan);
  assert.equal(stderr, '');
  assert.deepEqual(out.tasks, [
    { id: '1', title: 'A', files: ['a.py'], deps: [] },
    { id: '2', title: 'B', files: ['b.py'], deps: [] },
  ]);
  assert.deepEqual(out.groups, [['1'], ['2']]);
});

test('derive-lanes exits 2 on usage errors', () => {
  assert.equal(derive().code, 2);
  assert.equal(derive(FIXTURE, 'extra').code, 2);
  assert.equal(derive(FIXTURE, '--max-lanes').code, 2);
  assert.equal(derive(FIXTURE, '--max-lanes', '0').code, 2);
  assert.equal(derive(FIXTURE, '--max-lanes', 'many').code, 2);
  assert.equal(derive(FIXTURE, '--bogus').code, 2);
});

test('derive-lanes exits 3 on an unreadable plan, no tasks, or duplicate ids', () => {
  const missing = derive(join(TMP, 'nope', 'plan.md'));
  assert.equal(missing.code, 3);
  assert.equal(missing.stdout, '');
  const empty = derive(planFile('# Plan\n\nNo tasks here.\n'));
  assert.equal(empty.code, 3);
  assert.match(empty.stderr, /no task headings/);
  const dup = derive(planFile('### Task 1: A\n\n### Task 1: B\n'));
  assert.equal(dup.code, 3);
  assert.match(dup.stderr, /duplicate/);
});
