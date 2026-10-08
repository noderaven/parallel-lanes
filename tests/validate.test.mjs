import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR, loadHelpers, loadScript } from './harness.mjs';

const {
  validateManifest, manifestRequiredKeys, runIdPattern, laneIdPattern, agentTypePattern,
  effectiveAutonomy, effectiveLimits, planAgents, tierSettings,
} = await loadHelpers([
  'validateManifest',
  'manifestRequiredKeys',
  'runIdPattern',
  'laneIdPattern',
  'agentTypePattern',
  'effectiveAutonomy',
  'effectiveLimits',
  'planAgents',
  'tierSettings',
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
    setup_result: {
      feature_head: 'S0', discarded: [], worktrees: { alpha: '/work/wt/lane-alpha', beta: '/work/wt/lane-beta' },
    },
  };
}

function assertError(errors, ...fragments) {
  assert.ok(
    errors.some((e) => fragments.every((f) => e.includes(f))),
    `expected an error mentioning ${fragments.join(' and ')}; got ${JSON.stringify(errors)}`,
  );
}

test('harness runs the script body with stubs: a run starts with the pre-flight agent', async () => {
  const labels = [];
  const result = await loadScript({
    args: validManifest(),
    agent: async (prompt, opts) => {
      labels.push(opts.label);
      return null;
    },
  });
  assert.deepEqual(labels, ['pre-flight', 'pre-flight retry']);
  assert.equal(result.status, 'stopped');
});

// --- review findings 4 and 9, and the explicit records -----------------------

test('a launch needs setup_result; a dry run does not', () => {
  const m = validManifest();
  delete m.setup_result;
  assertError(validateManifest(m), 'setup_result: missing');
  assert.deepEqual(validateManifest({ ...m, dry_run: true }), []);
});

test('a task id that is not a safe file name is reported', () => {
  for (const id of ['../../victim', 'a/b', '.hidden', '-x']) {
    const m = validManifest();
    m.join[0].id = id;
    assertError(validateManifest(m), JSON.stringify(id), 'must match');
  }
});

test('a file that is absolute or leaves the project is reported', () => {
  for (const f of ['/etc/passwd', '../outside.js', 'src/../../x.js']) {
    const m = validManifest();
    m.lanes[0].tasks[0].files = [f];
    assertError(validateManifest(m), JSON.stringify(f), 'leaves the project');
  }
});

test('two lanes claiming one file through an alias or another case are reported', () => {
  for (const alias of ['src/../src/a.js', './src//a.js', 'SRC/a.js']) {
    const m = validManifest();
    m.lanes[1].tasks[0].files.push(alias);
    assertError(validateManifest(m), 'claimed by lanes alpha and beta');
  }
});

test('a recorded overlap lets two lanes share a file; a bad record is reported', () => {
  const m = validManifest();
  m.lanes[1].tasks[0].files.push('src/a.js');
  m.overlaps = [{ file: 'src/a.js', tasks: ['T2', 'T3'], reason: 'both register a route', merge_owner: 'T2' }];
  assert.deepEqual(validateManifest(m), []);
  m.overlaps[0].merge_owner = 'T9';
  assertError(validateManifest(m), 'merge_owner');
  m.overlaps[0] = { file: 'src/a.js', tasks: ['T2', 'T4'], reason: 'x', merge_owner: 'T2' };
  assertError(validateManifest(m), 'task T4 does not list src/a.js');
});

test('an overlap may say how the merged file is checked; the integrator is told to check it', async () => {
  const { integratePrompt } = await loadHelpers(['integratePrompt']);
  const m = validManifest();
  m.lanes[1].tasks[0].files.push('src/a.js');
  m.overlaps = [{ file: 'src/a.js', tasks: ['T2', 'T3'], reason: 'both register a route', merge_owner: 'T2',
    validation: 'npm test -- routes' }];
  assert.deepEqual(validateManifest(m), []);
  const p = integratePrompt(m, 'p0', {});
  assert.ok(p.includes('src/a.js') && p.includes('after the merge, check it: npm test -- routes'), p);
  m.overlaps[0].validation = '';
  assertError(validateManifest(m), 'overlaps[0].validation');
});

test('depends_on: unknown ids, cycles, and code dependencies the run order cannot meet are reported', () => {
  const dep = (id, kind = 'code') => ({ id, kind });
  let m = validManifest();
  m.lanes[0].tasks[0].depends_on = [dep('T1'), dep('T3', 'contract')];
  m.join[0].depends_on = [dep('T2'), dep('T3')];
  assert.deepEqual(validateManifest(m), [], 'prelude, contract and join dependencies are met');
  m = validManifest();
  m.lanes[0].tasks[0].depends_on = [dep('T3')];
  assertError(validateManifest(m), 'code dependency on T3', 'cannot be met');
  m = validManifest();
  m.prelude[0].depends_on = [dep('T4')];
  assertError(validateManifest(m), 'code dependency on T4');
  m = validManifest();
  m.lanes[0].tasks[0].depends_on = [dep('T9')];
  assertError(validateManifest(m), 'unknown task T9');
  m = validManifest();
  m.lanes[0].tasks[0].depends_on = [dep('T3', 'contract')];
  m.lanes[1].tasks[0].depends_on = [dep('T2', 'contract')];
  assertError(validateManifest(m), 'dependency cycle');
  m = validManifest();
  m.lanes[0].tasks[0].depends_on = [{ id: 'T1', kind: 'maybe' }];
  assertError(validateManifest(m), "depends_on must be a list of {id, kind: 'code' or 'contract'}");
});

test('excluded, deferred and allow_deferral are checked', () => {
  let m = validManifest();
  m.excluded = [{ id: 'T9', reason: 'operator step' }];
  assert.deepEqual(validateManifest(m), []);
  m.excluded.push({ id: 'T2', reason: 'x' }, { id: 'T9', reason: 'again' }, { id: 'T10' });
  const errors = validateManifest(m);
  assertError(errors, 'task T2 is also in the run');
  assertError(errors, 'task T9 appears more than once');
  assertError(errors, 'excluded[3]: must be {id, reason}');
  m = validManifest();
  m.deferred = ['T2'];
  assertError(validateManifest(m), 'deferred: task T2 is not done');
  m = validManifest();
  m.allow_deferral = 'no';
  assertError(validateManifest(m), 'allow_deferral: must be a boolean');
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

test('autonomy: optional, autonomous or supervised, default autonomous', () => {
  const m = validManifest();
  assert.equal(effectiveAutonomy(m), 'autonomous');
  for (const value of ['autonomous', 'supervised']) {
    m.autonomy = value;
    assert.deepEqual(validateManifest(m), [], value);
    assert.equal(effectiveAutonomy(m), value);
  }
  m.autonomy = 'auto';
  assertError(validateManifest(m), 'autonomy');
});

test('profile: optional, lite or full; anything else is reported', () => {
  const m = validManifest();
  m.profile = 'full';
  assert.deepEqual(validateManifest(m), []);
  m.profile = 'tiny';
  assertError(validateManifest(m), 'profile');
});

function liteManifest(laneTasks = 2) {
  const m = validManifest();
  m.profile = 'lite';
  m.lanes = [{
    id: 'alpha',
    name: 'Lane alpha',
    tasks: Array.from({ length: laneTasks }, (_, i) => task(`L${i + 1}`, [`src/l${i + 1}.js`])),
  }];
  m.setup_result = { feature_head: 'S0', discarded: [], worktrees: { alpha: '/work/repo' } };
  return m;
}

test('lite profile: one lane, at most 8 tasks, no security task is valid', () => {
  assert.deepEqual(validateManifest(liteManifest(6)), []);
});

test('lite profile with a security task is reported naming the rule', () => {
  for (const group of ['prelude', 'join', 'lane']) {
    const m = liteManifest();
    const t = group === 'lane' ? m.lanes[0].tasks[0] : m[group][0];
    t.security = true;
    assertError(validateManifest(m), 'profile lite', 'security', t.id);
  }
});

test('lite profile with more than one lane is reported naming the rule', () => {
  const m = liteManifest();
  m.lanes.push({ id: 'beta', name: 'Lane beta', tasks: [task('B1', ['src/b.js'])] });
  assertError(validateManifest(m), 'profile lite', 'exactly one lane', '2');
});

test('lite profile with no lane is reported naming the rule', () => {
  const m = liteManifest();
  m.lanes = [];
  assertError(validateManifest(m), 'profile lite', 'exactly one lane', '0');
});

test('lite profile with more than 8 tasks across prelude, lane and join is reported naming the rule', () => {
  // 1 prelude + 7 lane + 1 join = 9 tasks.
  assertError(validateManifest(liteManifest(7)), 'profile lite', 'at most 8 tasks', '9');
  // 1 prelude + 6 lane + 1 join = 8 tasks: allowed.
  assert.deepEqual(validateManifest(liteManifest(6)), []);
});

test('full profile allows several lanes and security tasks', () => {
  const m = validManifest();
  m.profile = 'full';
  m.lanes[0].tasks[0].security = true;
  assert.deepEqual(validateManifest(m), []);
});

test('task tier: standard, sonnet, or light; anything else is reported', () => {
  const m = validManifest();
  m.lanes[0].tasks[0].tier = 'sonnet';
  assert.deepEqual(validateManifest(m), []);
  m.lanes[0].tasks[0].tier = 'haiku';
  assertError(validateManifest(m), 'T2', 'tier');
});

test('a sonnet task with security set is reported', () => {
  const m = validManifest();
  m.lanes[0].tasks[0].tier = 'sonnet';
  m.lanes[0].tasks[0].security = true;
  assertError(validateManifest(m), 'T2', 'sonnet', 'security');
});

test('sonnet and light tiers run Sonnet at high effort; standard runs Opus at high', () => {
  assert.deepEqual(tierSettings('sonnet'), { model: 'sonnet', effort: 'high' });
  assert.deepEqual(tierSettings('light'), { model: 'sonnet', effort: 'high' });
  assert.deepEqual(tierSettings('standard'), { model: 'opus', effort: 'high' });
});

test('batch: a non-empty string on a light task is valid', () => {
  const m = validManifest();
  m.lanes[0].tasks = [
    task('T2', ['src/a.js'], { tier: 'light', batch: 'docs' }),
    task('T6', ['src/a2.js'], { tier: 'light', batch: 'docs' }),
  ];
  assert.deepEqual(validateManifest(m), []);
});

test('batch on a standard or sonnet task is reported', () => {
  for (const tier of ['standard', 'sonnet']) {
    const m = validManifest();
    m.lanes[0].tasks[0].tier = tier;
    m.lanes[0].tasks[0].batch = 'docs';
    assertError(validateManifest(m), 'T2', 'batch', 'light');
  }
});

test('an empty or non-string batch key is reported', () => {
  for (const batch of ['', 3, null]) {
    const m = validManifest();
    m.lanes[0].tasks[0].tier = 'light';
    m.lanes[0].tasks[0].batch = batch;
    assertError(validateManifest(m), 'T2', 'batch');
  }
});

test('limits.max_agents and limits.max_rulings: optional integers with lower bounds', () => {
  const m = validManifest();
  m.limits.max_agents = 1;
  m.limits.max_rulings = 0;
  assert.deepEqual(validateManifest(m), []);
  for (const bad of [0, -1, 1.5, '3']) {
    const n = validManifest();
    n.limits.max_agents = bad;
    assertError(validateManifest(n), 'limits.max_agents');
  }
  for (const bad of [-1, 2.5, '0', null]) {
    const n = validManifest();
    n.limits.max_rulings = bad;
    assertError(validateManifest(n), 'limits.max_rulings');
  }
});

test('effectiveLimits defaults: max_agents 2 x the dry-run estimate, max_rulings 25', () => {
  const m = validManifest();
  assert.deepEqual(effectiveLimits(m), { max_agents: 2 * planAgents(m).length, max_rulings: 25 });
  m.limits.max_agents = 7;
  m.limits.max_rulings = 0;
  assert.deepEqual(effectiveLimits(m), { max_agents: 7, max_rulings: 0 });
});

function setupResult(m) {
  return {
    feature_head: 'abc123',
    worktrees: Object.fromEntries(m.lanes.map((l) => [l.id, `/work/wt/lane-${l.id}`])),
    discarded: ['lane-alpha: M src/a.js'],
  };
}

test('setup_result naming every lane is valid', () => {
  const m = validManifest();
  m.setup_result = setupResult(m);
  assert.deepEqual(validateManifest(m), []);
  m.setup_result.discarded = [];
  assert.deepEqual(validateManifest(m), []);
});

test('setup_result missing a lane is reported naming the lane', () => {
  const m = validManifest();
  m.setup_result = setupResult(m);
  delete m.setup_result.worktrees.beta;
  assertError(validateManifest(m), 'setup_result.worktrees', 'beta');
});

test('setup_result shape errors are reported', () => {
  const cases = [
    [(r) => { r.feature_head = ''; }, 'setup_result.feature_head'],
    [(r) => { delete r.discarded; }, 'setup_result.discarded'],
    [(r) => { r.discarded = ['']; }, 'setup_result.discarded'],
    [(r) => { r.worktrees = []; }, 'setup_result.worktrees'],
    [(r) => { r.worktrees.alpha = 'relative/path'; }, 'setup_result.worktrees.alpha'],
    [(r) => { r.worktrees.gamma = '/work/wt/lane-gamma'; }, 'setup_result.worktrees.gamma'],
  ];
  for (const [mutate, fragment] of cases) {
    const m = validManifest();
    m.setup_result = setupResult(m);
    mutate(m.setup_result);
    assertError(validateManifest(m), fragment);
  }
  const m = validManifest();
  m.setup_result = 'done';
  assertError(validateManifest(m), 'setup_result');
});

test('start_points: optional prelude and join shas', () => {
  const m = validManifest();
  m.start_points = {};
  assert.deepEqual(validateManifest(m), []);
  m.start_points = { prelude: 'abc', join: 'def' };
  assert.deepEqual(validateManifest(m), []);
  m.start_points = { prelude: '' };
  assertError(validateManifest(m), 'start_points.prelude');
  m.start_points = { lanes: 'abc' };
  assertError(validateManifest(m), 'start_points.lanes');
  m.start_points = ['abc'];
  assertError(validateManifest(m), 'start_points');
});

test('schema documents every addendum field', () => {
  const schema = JSON.parse(readFileSync(join(SKILL_DIR, 'manifest.schema.json'), 'utf8'));
  const p = schema.properties;
  assert.deepEqual(p.autonomy.enum, ['autonomous', 'supervised']);
  assert.deepEqual(p.profile.enum, ['lite', 'full']);
  assert.deepEqual(p.limits.properties.max_agents, { type: 'integer', minimum: 1 });
  assert.deepEqual(p.limits.properties.max_rulings, { type: 'integer', minimum: 0 });
  assert.deepEqual(schema.$defs.task.properties.tier.enum, ['standard', 'sonnet', 'light']);
  assert.ok('batch' in schema.$defs.task.properties);
  assert.deepEqual([...p.setup_result.required].sort(), ['discarded', 'feature_head', 'worktrees']);
  assert.deepEqual(Object.keys(p.start_points.properties).sort(), ['join', 'prelude']);
  assert.deepEqual(p.agent_type, { anyOf: [{ type: 'null' }, { type: 'string', pattern: '^[a-z0-9-]+$' }] });
});

test('schema documents the explicit records and the task id pattern the validator enforces', () => {
  const schema = JSON.parse(readFileSync(join(SKILL_DIR, 'manifest.schema.json'), 'utf8'));
  const p = schema.properties;
  assert.equal(schema.$defs.task.properties.id.pattern, laneIdPattern());
  assert.deepEqual(schema.$defs.task.properties.depends_on.items.properties.kind.enum, ['code', 'contract']);
  for (const key of ['overlaps', 'excluded', 'allow_deferral', 'deferred']) assert.ok(key in p, key);
  assert.deepEqual([...p.overlaps.items.required].sort(), ['file', 'merge_owner', 'reason', 'tasks']);
  assert.ok('validation' in p.overlaps.items.properties);
  assert.ok('preserved' in p.setup_result.properties);
  assert.ok(schema.allOf.some((r) => r.then && r.then.required && r.then.required.includes('setup_result')));
});

test('agent_type is optional, null, or a lowercase name', () => {
  assert.equal(agentTypePattern(), '^[a-z0-9-]+$');
  const message = 'agent_type: must be null or a name matching ^[a-z0-9-]+$';
  const m = validManifest();
  assert.deepEqual(validateManifest(m), []);
  for (const value of [null, 'parallel-lanes-worker']) {
    m.agent_type = value;
    assert.deepEqual(validateManifest(m), [], `agent_type ${JSON.stringify(value)}`);
  }
  for (const value of ['', 'Bad Name', 7]) {
    m.agent_type = value;
    assert.deepEqual(validateManifest(m), [message], `agent_type ${JSON.stringify(value)}`);
  }
});

test('lite profile with hooks.post_integrate is reported naming the rule', () => {
  const m = liteManifest();
  m.hooks = { post_integrate: 'check the contracts' };
  assertError(validateManifest(m), 'profile lite', 'hooks.post_integrate');
  m.hooks = { e2e: 'run the checklist' };
  assert.deepEqual(validateManifest(m), []);
});
