// The join wave rule (1.6.5 design 4.1): src/waves.js (the engine's, authoritative)
// and scripts/_waves.py (setup's owner map, worth-it) give the same waves on
// the shared fixtures in tests/fixtures/waves/cases.json. The real cases come
// from the archived d1a, sb1, sc1 and m1a manifests with every file path
// anonymised (f<n>, equality kept).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadHelpers, SKILL_DIR } from './harness.mjs';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const CASES = JSON.parse(readFileSync(join(SKILL_DIR, 'tests', 'fixtures', 'waves', 'cases.json'), 'utf8'));

const {
  joinWaves, waveDeps, wavePlan, unitBranch, joinUnits, waveWidth, joinStarted,
} = await loadHelpers([
  'joinWaves', 'waveDeps', 'wavePlan', 'unitBranch', 'joinUnits', 'waveWidth', 'joinStarted',
]);

// Runs a Python snippet with scripts/ importable (no bytecode); stdin is JSON,
// stdout is JSON.
function python(lines, input) {
  const code = [
    'import json, sys',
    'sys.dont_write_bytecode = True',
    `sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`,
    'import _waves',
    ...lines,
  ].join('\n');
  const r = spawnSync('python3', ['-B', '-c', code], { encoding: 'utf8', input: JSON.stringify(input) });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const task = (id, deps, extra = {}) => ({
  id, title: `Task ${id}`, files: [`src/${id}.cs`], tier: 'standard', security: false,
  ...(deps === undefined ? {} : { depends_on: deps.map((d) => ({ id: d, kind: 'code' })) }), ...extra,
});

function manifest(overrides = {}) {
  return {
    run_id: 'run-1', profile: 'standard',
    lanes: [{ id: 'a', tasks: [task('A1')] }, { id: 'b', tasks: [task('B1')] }, { id: 'c', tasks: [task('C1')] }],
    join: [task('J1', []), task('J2', ['J1']), task('J3', ['J1'])],
    limits: { max_parallel_lanes: 3, review_rounds: 5 },
    done: [], reviewed: [], deferred: [],
    ...overrides,
  };
}

test('the JS rule gives every fixture case its expected waves', () => {
  for (const c of CASES) assert.deepEqual(joinWaves(c.units, c.edges), c.expected, c.name);
});

test('the Python rule gives every fixture case its expected waves', () => {
  const got = python([
    'cases = json.load(sys.stdin)',
    'print(json.dumps([_waves.waves(c["units"], [(e["unit"], e["producer"]) for e in c["edges"]]) for c in cases]))',
  ], CASES);
  CASES.forEach((c, i) => assert.deepEqual(got[i], c.expected, c.name));
});

test('the real archived joins give the waves the design names', () => {
  const sizes = Object.fromEntries(CASES.filter((c) => ['d1a', 'sb1', 'sc1', 'm1a'].includes(c.name))
    .map((c) => [c.name, joinWaves(c.units, c.edges).map((w) => w.length)]));
  assert.deepEqual(sizes, { d1a: [1, 2, 4], sb1: [2, 2], sc1: [2, 1, 1, 1], m1a: [2, 1] });
});

test('waveDeps merges a batch\'s dependencies and drops its own ids', () => {
  const unit = { id: 'J2-J3', tasks: [task('J2', ['J1', 'L1']), task('J3', ['J2', 'J1'])] };
  assert.deepEqual(waveDeps(unit), ['J1', 'L1']);
  assert.deepEqual(waveDeps(task('J1', [])), []);
  assert.equal(waveDeps(task('J1')), null);
});

test('waveDeps is null when one task of a batch has no depends_on field', () => {
  assert.equal(waveDeps({ id: 'J2-J3', tasks: [task('J2', ['J1']), task('J3')] }), null);
});

test('joinUnits forms batches as the run does', () => {
  const light = (id, deps) => task(id, deps, { tier: 'light', batch: 'b' });
  const m = manifest({ join: [task('J1', []), light('J2', ['J1']), light('J3', ['J1']), task('J4', ['J3'])] });
  assert.deepEqual(joinUnits(m).map((u) => u.id), ['J1', 'J2-J3', 'J4']);
  assert.deepEqual(joinWaves(joinUnits(m)), [['J1'], ['J2-J3'], ['J4']]);
});

test('wavePlan runs waves when two units can run side by side', () => {
  assert.deepEqual(wavePlan(manifest()), { mode: 'waves', reason: null, waves: [['J1'], ['J2', 'J3']] });
});

test('wavePlan says why a join runs serially', () => {
  const serial = (m) => wavePlan(m).reason;
  assert.equal(serial(manifest({ profile: 'lite' })), 'lite');
  assert.equal(serial(manifest({ join_started: true })), 'join started');
  assert.equal(serial(manifest({ done: ['J1'], reviewed: ['J1'] })), 'join started');
  assert.equal(serial(manifest({ done: ['J1'], deferred: ['J1'] })), 'join started');
  assert.equal(serial(manifest({ lanes: [{ id: 'a', tasks: [task('A1')] }] })), 'fewer than two usable lane worktrees');
  assert.equal(serial(manifest({
    lanes: [{ id: 'a', tasks: [task('A1')] }, { id: 'b', tasks: [task('B1')] }],
    lane_commands: { b: { setup: ['make b'] } },
  })), 'fewer than two usable lane worktrees');
  assert.equal(serial(manifest({ limits: { max_parallel_lanes: 1, review_rounds: 5 } })),
    'fewer than two usable lane worktrees');
  assert.equal(serial(manifest({ join: [task('J1'), task('J2'), task('J3')] })), 'no wave has two units');
  for (const m of [manifest({ profile: 'lite' }), manifest({ join_started: true })]) {
    assert.equal(wavePlan(m).mode, 'serial');
    assert.deepEqual(wavePlan(m).waves, [['J1'], ['J2', 'J3']]);
  }
});

test('waveWidth counts lane worktrees without a setup of their own', () => {
  assert.equal(waveWidth(manifest()), 3);
  assert.equal(waveWidth(manifest({ limits: { max_parallel_lanes: 2, review_rounds: 5 } })), 2);
  assert.equal(waveWidth(manifest({ lane_commands: { a: { setup: ['x'] }, b: { test: ['y'] } } })), 2);
});

test('joinStarted reads the flag and the join tasks\' state', () => {
  assert.equal(joinStarted(manifest()), false);
  assert.equal(joinStarted(manifest({ join_started: false })), false);
  assert.equal(joinStarted(manifest({ join_started: true })), true);
  assert.equal(joinStarted(manifest({ done: ['A1'], reviewed: ['A1'] })), false);
  assert.equal(joinStarted(manifest({ done: ['J2'] })), true);
});

test('wavePlan takes extra edges', () => {
  const plan = wavePlan(manifest(), [{ unit: 'J3', producer: 'J2' }]);
  assert.deepEqual(plan, { mode: 'serial', reason: 'no wave has two units', waves: [['J1'], ['J2'], ['J3']] });
});

test('unitBranch names the unit branch', () => {
  assert.equal(unitBranch(manifest(), { id: 'DJ3' }), 'pl-run-1-u-DJ3');
  assert.equal(unitBranch(manifest(), { id: 'J2-J3' }), 'pl-run-1-u-J2-J3');
});

test('_waves.task_waves and join_units', () => {
  const d1a = CASES.find((c) => c.name === 'd1a');
  const got = python(['tasks = json.load(sys.stdin)', 'print(json.dumps(_waves.task_waves(tasks)))'], d1a.units);
  assert.equal(got.DJ5, 3);
  assert.equal(got.DJ1, 1);
  assert.equal(got.DJ4, 2);
  const batch = [{ id: 'J1', files: ['a'], depends_on: [] },
    { id: 'J2', files: ['b'], batch: 'k', depends_on: [{ id: 'J1' }] },
    { id: 'J3', files: ['c'], batch: 'k', depends_on: [{ id: 'J1' }] },
    { id: 'J4', files: ['d'], depends_on: [{ id: 'J3' }] }];
  const units = python(['tasks = json.load(sys.stdin)', 'print(json.dumps(_waves.join_units(tasks)))'], batch);
  assert.deepEqual(units.map((u) => [u.id, u.tasks]), [['J1', ['J1']], ['J2-J3', ['J2', 'J3']], ['J4', ['J4']]]);
  assert.deepEqual(units[1].depends_on, ['J1']);
  const waves = python(['tasks = json.load(sys.stdin)', 'print(json.dumps(_waves.task_waves(tasks)))'], batch);
  assert.deepEqual(waves, { J1: 1, J2: 2, J3: 2, J4: 3 });
});

// ---- owners.json: join waves and alongside (design 4.8) ----

function owners(lines, input) {
  return python(['import _owners', ...lines], input);
}
const ownerManifest = (extra = {}) => ({
  repo: { mode: 'git', root: '/r', git_dir: null },
  prelude: [{ id: 'P1', files: ['p.cs'] }],
  lanes: [{ id: 'a', tasks: [{ id: 'A1', files: ['a.cs'] }] }, { id: 'b', tasks: [{ id: 'B1', files: ['b.cs'] }] }],
  join: [{ id: 'J1', files: ['j1.cs'], depends_on: [] }, { id: 'J2', files: ['j2.cs'], depends_on: [] },
    { id: 'J3', files: ['j3.cs'], depends_on: [{ id: 'J1' }] }],
  ...extra,
});
const relations = (m) => owners([
  'm = json.load(sys.stdin)',
  'o = _owners.build(m)',
  'print(json.dumps({"waves": {t: v.get("wave") for t, v in o["tasks"].items() if v["where"] == "join"},',
  '  "J1-J2": _owners.relation(o, ["J1"], "J2"), "J2-J1": _owners.relation(o, ["J2"], "J1"),',
  '  "J3-J2": _owners.relation(o, ["J3"], "J2"), "J1-J3": _owners.relation(o, ["J1"], "J3"),',
  '  "J1-A1": _owners.relation(o, ["J1"], "A1")}))',
], m);

test('join tasks in one wave are alongside', () => {
  const r = relations(ownerManifest());
  assert.deepEqual(r.waves, { J1: 1, J2: 1, J3: 2 });
  assert.equal(r['J1-J2'], 'alongside');
  assert.equal(r['J2-J1'], 'alongside');
  assert.equal(r['J1-A1'], 'earlier', 'a lane is still earlier than the join');
});

test('join tasks in different waves are earlier and later', () => {
  const r = relations(ownerManifest());
  assert.equal(r['J3-J2'], 'earlier');
  assert.equal(r['J1-J3'], 'later');
});

test('owners.json without wave keeps the old relation', () => {
  const r = owners([
    'm = json.load(sys.stdin)',
    'o = _owners.build(m)',
    'for t in o["tasks"].values(): t.pop("wave", None)',
    'print(json.dumps([_owners.relation(o, ["J1"], "J2"), _owners.relation(o, ["J2"], "J1")]))',
  ], ownerManifest());
  assert.deepEqual(r, ['later', 'earlier']);
});

test('a join that cannot run in waves gets no wave in owners.json', () => {
  for (const extra of [{ profile: 'lite' }, { lanes: [{ id: 'a', tasks: [{ id: 'A1', files: ['a.cs'] }] }] }]) {
    const r = relations(ownerManifest(extra));
    assert.deepEqual(r.waves, { J1: null, J2: null, J3: null });
    assert.equal(r['J1-J2'], 'later');
  }
});

test('wave labels are Join phase agents to autopsy, not task agents', () => {
  const got = python([
    'import _transcripts',
    'ids = json.load(sys.stdin)',
    'labels = ["wave 2 merge", "wave 2 resolve J2", "wave checks fix", "wave checks re-review", "wave checks",',
    '          "recovery merge", "recovery resolve J2", "J2 implement"]',
    'print(json.dumps([list(_transcripts.parse_label(l, ids)[:2]) for l in labels]))',
  ], ['J1', 'J2']);
  assert.deepEqual(got, [
    [null, 'wave 2 merge'], [null, 'wave 2 resolve J2'], [null, 'wave checks fix'], [null, 'wave checks re-review'],
    [null, 'wave checks'], [null, 'recovery merge'], [null, 'recovery resolve J2'], ['J2', 'implement'],
  ]);
});
