import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR, loadHelpers, loadScript } from './harness.mjs';

const { validateManifest, manifestRequiredKeys, runIdPattern, laneIdPattern } = await loadHelpers([
  'validateManifest',
  'manifestRequiredKeys',
  'runIdPattern',
  'laneIdPattern',
]);

function task(id, files, extra = {}) {
  return { id, title: `Task ${id}`, files, tier: 'standard', security: false, ...extra };
}

function validManifest() {
  return {
    version: 1,
    run_id: 'run-1',
    plan: '/work/plan.md',
    spec: null,
    commit_rules: 'plain ASCII, no trailers',
    repo: {
      mode: 'git',
      root: '/work/repo',
      git_dir: null,
      base_ref: 'main',
      branch: 'pl/run-1',
      worktree_root: '/work/wt',
      ledger_dir: '/work/ledger',
    },
    commands: { setup: [], test: ['npm test'], lint: [], build: [] },
    prelude: [task('T1', ['src/shared.js'])],
    lanes: [
      { id: 'alpha', name: 'Lane alpha', tasks: [task('T2', ['src/a.js'])] },
      { id: 'beta', name: 'Lane beta', tasks: [task('T3', ['src/b.js'])] },
    ],
    join: [task('T4', ['README.md'])],
    hooks: {},
    limits: { review_rounds: 5, max_parallel_lanes: 3 },
    dry_run: false,
    done: [],
    reviewed: [],
    sp_dir: null,
    skill_dir: '/skills/parallel-lanes',
  };
}

function assertError(errors, ...fragments) {
  assert.ok(
    errors.some((e) => fragments.every((f) => e.includes(f))),
    `expected an error mentioning ${fragments.join(' and ')}; got ${JSON.stringify(errors)}`,
  );
}

test('harness runs the script body with stubs: a run starts with the setup agent', async () => {
  const labels = [];
  const result = await loadScript({
    args: validManifest(),
    agent: async (prompt, opts) => {
      labels.push(opts.label);
      return null;
    },
  });
  assert.deepEqual(labels, ['setup']);
  assert.equal(result.status, 'stopped');
});

test('valid minimal manifest has no errors', () => {
  assert.deepEqual(validateManifest(validManifest()), []);
});

test('missing plan is reported', () => {
  const m = validManifest();
  delete m.plan;
  assertError(validateManifest(m), 'plan');
});

test('the same file in two lanes names the file and both lanes', () => {
  const m = validManifest();
  m.lanes[1].tasks[0].files.push('src/a.js');
  assertError(validateManifest(m), 'src/a.js', 'alpha', 'beta');
});

test('a task id used twice across prelude, lanes and join is reported', () => {
  const m = validManifest();
  m.join[0].id = 'T2';
  assertError(validateManifest(m), 'T2');
});

test('a light task with security set is reported', () => {
  const m = validManifest();
  m.lanes[0].tasks[0].tier = 'light';
  m.lanes[0].tasks[0].security = true;
  assertError(validateManifest(m), 'T2', 'light');
});

test('review_rounds below 1 is reported', () => {
  const m = validManifest();
  m.limits.review_rounds = 0;
  assertError(validateManifest(m), 'review_rounds');
});

test('shadow mode without git_dir is reported', () => {
  const m = validManifest();
  m.repo.mode = 'shadow';
  assertError(validateManifest(m), 'git_dir');
});

test('done containing an unknown task id is reported', () => {
  const m = validManifest();
  m.done = ['T2', 'T99'];
  assertError(validateManifest(m), 'done', 'T99');
});

test('schema required list matches the validator required keys', () => {
  const schema = JSON.parse(readFileSync(join(SKILL_DIR, 'manifest.schema.json'), 'utf8'));
  assert.deepEqual([...schema.required].sort(), [...manifestRequiredKeys()].sort());
});

test('schema id patterns match the validator and the ledger lane rule', () => {
  const schema = JSON.parse(readFileSync(join(SKILL_DIR, 'manifest.schema.json'), 'utf8'));
  assert.equal(schema.properties.run_id.pattern, runIdPattern());
  const laneId = schema.properties.lanes.items.properties.id;
  assert.ok(laneId.allOf.some((s) => s.pattern === laneIdPattern()), JSON.stringify(laneId));
  const ledger = readFileSync(join(SKILL_DIR, 'scripts', 'ledger'), 'utf8');
  assert.ok(ledger.includes(`re.compile(r"${laneIdPattern()}")`), 'ledger LANE regex differs from laneIdPattern');
  assert.ok(ledger.includes('LANE.fullmatch('), 'ledger must fullmatch lane names');
  assert.ok('notes' in schema.properties, 'schema documents notes');
});
