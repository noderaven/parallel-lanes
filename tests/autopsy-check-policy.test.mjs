// scripts/_autopsy.py and the 1.6.0 check policy: task-checks calls matched
// to their evidence files (<ledger>/checks/task-*.json, written by hand here
// in the shape of spec 4.2), project test runs, repairs and skipped setups,
// task_checks commands as configured checks, and the legacy full_suite_runs.
// Each test builds a small run folder in a temp dir, the way
// tests/autopsy.test.mjs's fixtures are laid out: a *.lanes.json manifest,
// wf_<n>.json result files, wf_<n>/agent-<k>.jsonl transcripts with their
// meta files, and the ledger dir.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { tempDir } from './platform.mjs';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const SCRIPT = join(SCRIPTS, 'autopsy');
const FIXTURES = join(SKILL_DIR, 'tests', 'fixtures', 'autopsy');
const TMP = tempDir('pl-autopsy-policy-');
after(() => rmSync(TMP, { recursive: true, force: true }));

const T = (hms) => `2026-10-10T${hms}.000Z`;
const ms = (hms) => Date.parse(T(hms));
const BASE = 'b'.repeat(40);
const TEST_CMD = 'npm test';
const TARGETED = 'node --test --test-concurrency=4 tests/a.test.mjs';

function manifest(extra = {}) {
  return {
    version: 1,
    run_id: 'c1',
    plan: 'C:/src/plans/p.md',
    spec: null,
    repo: {
      mode: 'git', root: 'C:/src/proj', branch: 'feat', base: 'main', worktree_root: 'C:/src/proj-wt',
      ledger_dir: 'C:/src/plans/p.c1.ledger',
    },
    commands: { setup: [], test: [TEST_CMD], lint: ['eslint .'], build: [] },
    prelude: [],
    lanes: [
      { id: 'a', name: 'Lane a', tasks: [{ id: 'A1', title: 'A1', tier: 'standard' }, { id: 'A2', title: 'A2', tier: 'standard' },
        { id: 'A3', title: 'A3', tier: 'standard' }] },
      { id: 'b', name: 'Lane b', tasks: [{ id: 'B1', title: 'B1', tier: 'standard' }] },
    ],
    join: [],
    ...extra,
  };
}

// A task-checks command line as the engine builds it.
function taskChecks(unit, tasks = [unit]) {
  return `cd '/w/lane-a' && 'python3' '/skill/scripts/task-checks' '/w/lane-a' --base ${BASE} --ledger '/l'`
    + ` --unit '${unit}' --lane a ${tasks.map((t) => `--task '${t}'`).join(' ')}`
    + ` --lane-cmd test '${TEST_CMD}' --wide-cmd test '${TEST_CMD}'`;
}

// One agent's transcript lines: the prompt, a tool call per call
// ({command, start, end, exit}), and a last assistant line at end.
function transcript(id, { start, end, calls = [] }) {
  const lines = [{ type: 'user', timestamp: T(start), message: { role: 'user', content: 'Do the task.' } }];
  const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  calls.forEach((c, i) => {
    const tu = `tu_${id}_${i + 1}`;
    lines.push({ type: 'assistant', timestamp: T(c.start), message: {
      id: `m_${id}_${i + 1}`, role: 'assistant', model: 'claude-sonnet-4-6', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: tu, name: 'Bash', input: { command: c.command } }], usage } });
    const failed = c.exit !== undefined && c.exit !== 0;
    lines.push({ type: 'user', timestamp: T(c.end), message: { role: 'user', content: [{
      type: 'tool_result', tool_use_id: tu, content: failed ? `Exit code ${c.exit}\nout` : 'out', is_error: failed }] } });
  });
  lines.push({ type: 'assistant', timestamp: T(end), message: {
    id: `m_${id}_end`, role: 'assistant', model: 'claude-sonnet-4-6', stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'Done.' }], usage } });
  return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
}

// The evidence file task-checks writes: run-checks' JSON plus policy.
function evidence({ unit, tasks = [unit], selected = 'targeted', reasons = [], started, ok = true,
  results = null, projectTest = false, error = undefined }) {
  const ran = results !== null ? results
    : [{ group: 'test', command: selected === 'targeted' ? TARGETED : TEST_CMD, exit: ok ? 0 : 1, started,
      ended: started, duration_s: 1, log: '/l/checks/x.1.log', tail: '' }];
  const out = {
    checkout: '/w/lane-a', branch: 'pl/a', head: 'c'.repeat(40), results: ran, ok, clean: true,
    tracked_before: [], tracked_after: [], untracked_before: [], untracked_after: [],
    policy: {
      unit, tasks, lane: 'a', base: BASE, started, entry: selected === 'lane' ? null : tasks[tasks.length - 1],
      selected, reasons, changed: ['src/a.js'],
      offered: { targeted: selected === 'lane' ? null : [{ group: 'test', command: TARGETED }],
        lane: [{ group: 'test', command: TEST_CMD }], wide: [{ group: 'test', command: TEST_CMD }] },
      project_test_executed: projectTest,
    },
  };
  if (error !== undefined) out.error = error;
  return out;
}

let runs = 0;
// A run folder: launches [{result, agents: [{label, phase, start, end,
// calls}]}], evidence {file name: object or raw text}, and the manifest.
function buildRun({ m = manifest(), launches = [{}], evidenceFiles = {} } = {}) {
  runs += 1;
  const dir = join(TMP, `run${runs}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'p.lanes.json'), JSON.stringify(m, null, 2));
  const ledger = join(dir, 'p.c1.ledger');
  mkdirSync(join(ledger, 'checks'), { recursive: true });
  writeFileSync(join(ledger, '_run.jsonl'), `${JSON.stringify({ event: 'run_started', run_id: 'c1' })}\n`);
  for (const [name, body] of Object.entries(evidenceFiles)) {
    writeFileSync(join(ledger, 'checks', name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  launches.forEach((launch, i) => {
    const wf = `wf_${i + 1}`;
    const agents = launch.agents || [];
    const start = launch.start || '10:00:00';
    writeFileSync(join(dir, `${wf}.json`), JSON.stringify({
      runId: wf, workflowName: 'parallel-lanes', status: 'completed', startTime: ms(start),
      durationMs: launch.durationMs || 3600000,
      result: launch.result || { status: 'complete', run_id: 'c1', version: '1.6.0', tasks: {} },
    }));
    mkdirSync(join(dir, wf), { recursive: true });
    agents.forEach((a, k) => {
      const id = `${i + 1}x${k + 1}`;
      writeFileSync(join(dir, wf, `agent-${id}.meta.json`), JSON.stringify({
        agentType: 'workflow-subagent', description: a.label, workflowPhase: a.phase || 'Lane a', model: 'sonnet' }));
      writeFileSync(join(dir, wf, `agent-${id}.jsonl`), transcript(id, a));
    });
  });
  return dir;
}

function autopsy(dir) {
  const r = spawnSync('python3', [SCRIPT, dir, '--quiet'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return {
    json: JSON.parse(readFileSync(join(dir, 'autopsy.json'), 'utf8')),
    md: readFileSync(join(dir, 'autopsy.md'), 'utf8'),
  };
}

// Runs a Python snippet with scripts/ importable; returns its stdout as JSON.
function python(lines, args = []) {
  const code = [
    'import json, sys',
    'sys.dont_write_bytecode = True',
    `sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`,
    'import _autopsy',
    ...lines,
  ].join('\n');
  const r = spawnSync('python3', ['-c', code, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const NONE = { targeted: 0, lane: 0, widened: 0, unavailable: 0 };
const pick = (x) => [x.agent, x.check, x.certainty, x.selected, x.full_suite];

test('a task-checks call is a check execution matched to its evidence', () => {
  const dir = buildRun({
    launches: [{ agents: [{ label: 'A1 implement', start: '10:00:05', end: '10:05:00',
      calls: [{ command: taskChecks('A1'), start: '10:00:10', end: '10:00:40' }] }] }],
    evidenceFiles: { 'task-A1.1.json': evidence({ unit: 'A1', started: T('10:00:11') }) },
  });
  const { json, md } = autopsy(dir);
  const checks = json.checks;
  assert.deepEqual(checks.executions.map(pick), [['A1 implement', 'task-checks', 'ran', 'targeted', 'ran']]);
  assert.equal(checks.executions[0].s, 30);
  assert.deepEqual(checks.by_check, { 'task-checks': { runs: 1, inferred: 0, untimed: 0, total_s: 30 } });
  assert.deepEqual(checks.task_check_calls,
    { total: 1, by_selected: { ...NONE, targeted: 1 }, failed: 0, reasons: {} });
  // The targeted run's test group counts as a check call with a test group,
  // not as a project test run.
  assert.deepEqual(checks.full_suite_runs, { total: 1, inferred: 0, by_role: { implement: 1 } });
  assert.deepEqual(checks.project_test_runs, { total: 0, by_role: {}, unavailable: 0 });
  // A task-checks call is recognised as run-checks' is: as the program or an
  // interpreter's script, never as text.
  const lines = [taskChecks('A1'), "py C:\\skill\\scripts\\task-checks C:\\w --unit A1", 'echo task-checks',
    'git diff scripts/task-checks', "bash -c 'task-checks x'"];
  assert.deepEqual(python([
    'checks = _autopsy.configured_checks(json.loads(sys.argv[1]))',
    'print(json.dumps([_autopsy.match_check(line, checks, 0) for line in json.loads(sys.argv[2])]))',
  ], [JSON.stringify(manifest()), JSON.stringify(lines)]), [
    { check: 'task-checks', certainty: 'ran', full_suite: null },
    { check: 'task-checks', certainty: 'ran', full_suite: null },
    null, null, null,
  ]);
  // autopsy.md names each counter with its definition.
  assert.match(md, /^Task-check calls: 1 \(targeted 1, lane 0, widened 0, unavailable 0\); 0 failed$/m);
  assert.match(md, /^Project test runs: 0$/m);
  assert.match(md, /^Check calls with a test group: 1$/m);
  for (const label of ['Task-check calls', 'Project test runs', 'Check calls with a test group', 'Repairs', 'Setup']) {
    const at = md.split('\n').findIndex((l) => l.startsWith(`${label}:`));
    assert.ok(at >= 0, label);
    const rest = md.split('\n').slice(at + 1);
    assert.ok(rest.find((l) => !l.startsWith('- ')).startsWith('  '), `${label} has a definition line`);
  }
});

test('targeted evidence is not a project test run; lane evidence with a project test is', () => {
  const dir = buildRun({
    launches: [{ agents: [
      { label: 'A1 implement', start: '10:00:05', end: '10:05:00',
        calls: [{ command: taskChecks('A1'), start: '10:00:10', end: '10:00:40' }] },
      { label: 'B1 implement', phase: 'Lane b', start: '10:00:06', end: '10:06:00',
        calls: [{ command: taskChecks('B1'), start: '10:01:10', end: '10:02:40' }] },
    ] }],
    evidenceFiles: {
      'task-A1.1.json': evidence({ unit: 'A1', started: T('10:00:11') }),
      'task-B1.1.json': evidence({ unit: 'B1', selected: 'lane', reasons: [{ code: 'no_entry', detail: 'no task_checks entry' }],
        started: T('10:01:11'), projectTest: true }),
    },
  });
  const checks = autopsy(dir).json.checks;
  assert.deepEqual(checks.executions.map(pick), [
    ['A1 implement', 'task-checks', 'ran', 'targeted', 'ran'],
    ['B1 implement', 'task-checks', 'ran', 'lane', 'ran'],
  ]);
  assert.deepEqual(checks.project_test_runs, { total: 1, by_role: { implement: 1 }, unavailable: 0 });
  assert.deepEqual(checks.full_suite_runs, { total: 2, inferred: 0, by_role: { implement: 2 } });
  assert.deepEqual(checks.task_check_calls,
    { total: 2, by_selected: { ...NONE, targeted: 1, lane: 1 }, failed: 0, reasons: { no_entry: 1 } });
});

test('a focused run-checks --cmd test is a legacy full-suite run but not a project test run', () => {
  const runChecks = (cmds) => `cd '/w' && 'python3' '/skill/scripts/run-checks' '/w' ${cmds}`;
  const dir = buildRun({
    launches: [{ agents: [
      { label: 'A1 implement', start: '10:00:05', end: '10:05:00',
        calls: [{ command: runChecks(`--cmd test '${TARGETED}'`), start: '10:00:10', end: '10:00:40' }] },
      { label: 'verify', phase: 'Verify', start: '10:06:00', end: '10:09:00',
        calls: [{ command: runChecks(`--cmd test '${TEST_CMD}' --cmd lint 'eslint .'`), start: '10:06:10', end: '10:07:00' }] },
      { label: 'final fix', phase: 'Final review', start: '10:10:00', end: '10:12:00',
        calls: [{ command: `cd /w && ${TEST_CMD}`, start: '10:10:10', end: '10:11:00' }] },
    ] }],
  });
  const checks = autopsy(dir).json.checks;
  assert.deepEqual(checks.full_suite_runs,
    { total: 3, inferred: 0, by_role: { implement: 1, verify: 1, 'final fix': 1 } });
  assert.deepEqual(checks.project_test_runs, { total: 2, by_role: { verify: 1, 'final fix': 1 }, unavailable: 0 });
  assert.deepEqual(checks.task_check_calls, { total: 0, by_selected: NONE, failed: 0, reasons: {} });
});

test('missing or malformed evidence is unavailable, never zero', () => {
  const noSelected = evidence({ unit: 'B1', started: T('10:01:11') });
  delete noSelected.policy.selected;
  const badStart = evidence({ unit: 'A2', started: 'soon' });
  const dir = buildRun({
    launches: [{ agents: [
      { label: 'A1 implement', start: '10:00:05', end: '10:05:00',
        calls: [{ command: taskChecks('A1'), start: '10:00:10', end: '10:00:40' }] },
      { label: 'B1 implement', phase: 'Lane b', start: '10:00:06', end: '10:06:00',
        calls: [{ command: taskChecks('B1'), start: '10:01:10', end: '10:02:40', exit: 1 }] },
      { label: 'A2 implement', start: '10:05:10', end: '10:07:00',
        calls: [{ command: taskChecks('A2'), start: '10:05:20', end: '10:05:40' }] },
    ] }],
    evidenceFiles: {
      'task-A1.1.json': '{"policy": ',
      'task-B1.1.json': noSelected,
      'task-A2.1.json': badStart,
    },
  });
  const { json, md } = autopsy(dir);
  const checks = json.checks;
  assert.deepEqual(checks.executions.map((x) => [x.agent, x.selected, x.full_suite]), [
    ['A1 implement', 'unavailable', 'inferred'],
    ['B1 implement', 'unavailable', 'inferred'],
    ['A2 implement', 'unavailable', 'inferred'],
  ]);
  assert.deepEqual(checks.task_check_calls,
    { total: 3, by_selected: { ...NONE, unavailable: 3 }, failed: 0, reasons: {} });
  assert.deepEqual(checks.project_test_runs, { total: 0, by_role: {}, unavailable: 3 });
  // Without evidence a call may have run the test group: inferred, not 0.
  assert.deepEqual(checks.full_suite_runs, { total: 0, inferred: 3, by_role: {} });
  assert.match(md, /^Project test runs: 0 \(\+3 unavailable\)$/m);
  assert.match(md, /^Task-check calls: 3 \(targeted 0, lane 0, widened 0, unavailable 3\); 0 failed$/m);
  // task_check_evidence keeps only valid files and counts the rest.
  assert.deepEqual(python([
    'print(json.dumps(_autopsy.task_check_evidence(_autopsy.load(sys.argv[1]))))',
  ], [dir]), [[], 3]);
});

test('two calls of one unit match their own evidence by time', () => {
  // The file numbers run against time: matching is by policy.started.
  const dir = buildRun({
    launches: [{ agents: [{ label: 'A1 implement', start: '10:00:05', end: '10:05:00', calls: [
      { command: taskChecks('A1'), start: '10:00:10', end: '10:00:40' },
      { command: taskChecks('A1'), start: '10:02:00', end: '10:02:30', exit: 1 },
    ] }] }],
    evidenceFiles: {
      'task-A1.1.json': evidence({ unit: 'A1', selected: 'widened', ok: false, started: T('10:02:01'),
        reasons: [{ code: 'outside_files', detail: 'src/z.js' }, { code: 'forced', detail: 'targeted list invalid' }] }),
      'task-A1.2.json': evidence({ unit: 'A1', started: T('10:00:11') }),
    },
  });
  const checks = autopsy(dir).json.checks;
  assert.deepEqual(checks.executions.map(pick), [
    ['A1 implement', 'task-checks', 'ran', 'targeted', 'ran'],
    ['A1 implement', 'task-checks', 'ran', 'widened', 'ran'],
  ]);
  assert.deepEqual(checks.task_check_calls, {
    total: 2, by_selected: { ...NONE, targeted: 1, widened: 1 }, failed: 1, reasons: { outside_files: 1, forced: 1 },
  });
  const found = python(['print(json.dumps(_autopsy.task_check_evidence(_autopsy.load(sys.argv[1]))))'], [dir]);
  assert.equal(found[1], 0);
  assert.deepEqual(found[0].map((e) => [e.unit, e.tasks, e.selected, e.codes, e.ok, e.started, e.project_test,
    e.test_group, e.path.replaceAll('\\', '/').split('/').slice(-2).join('/')]), [
    ['A1', ['A1'], 'widened', ['outside_files', 'forced'], false, T('10:02:01'), false, true, 'checks/task-A1.1.json'],
    ['A1', ['A1'], 'targeted', [], true, T('10:00:11'), false, true, 'checks/task-A1.2.json'],
  ]);
});

test('evidence of batch A1-A3 is never matched to unit A1', () => {
  const batch = evidence({ unit: 'A1-A3', tasks: ['A1', 'A2', 'A3'], started: T('10:00:11') });
  // A1's call, with only the batch's evidence inside its span.
  let checks = autopsy(buildRun({
    launches: [{ agents: [{ label: 'A1 implement', start: '10:00:05', end: '10:05:00',
      calls: [{ command: taskChecks('A1'), start: '10:00:10', end: '10:00:40' }] }] }],
    evidenceFiles: { 'task-A1-A3.1.json': batch },
  })).json.checks;
  assert.deepEqual(checks.executions.map(pick), [['A1 implement', 'task-checks', 'ran', 'unavailable', 'inferred']]);
  // The batch's own call matches it, and A1's evidence is never the batch's.
  checks = autopsy(buildRun({
    launches: [{ agents: [{ label: 'A1-A3 implement', start: '10:00:05', end: '10:05:00',
      calls: [{ command: taskChecks('A1-A3', ['A1', 'A2', 'A3']), start: '10:00:10', end: '10:00:40' }] }] }],
    evidenceFiles: { 'task-A1.1.json': evidence({ unit: 'A1', started: T('10:00:12') }), 'task-A1-A3.1.json': batch },
  })).json.checks;
  assert.deepEqual(checks.executions.map(pick), [['A1-A3 implement', 'task-checks', 'ran', 'targeted', 'ran']]);
  assert.equal(checks.task_check_calls.total, 1);
});

test('an error record (no results) matches by policy.started', () => {
  const dir = buildRun({
    launches: [{ agents: [{ label: 'A1 implement', start: '10:00:05', end: '10:05:00',
      calls: [{ command: taskChecks('A1'), start: '10:00:10', end: '10:00:40', exit: 3 }] }] }],
    evidenceFiles: { 'task-A1.1.json': evidence({ unit: 'A1', selected: 'widened', ok: false, results: [],
      reasons: [{ code: 'git_failed', detail: 'git diff exited 128' }], started: T('10:00:11'), error: 'run-checks gave no JSON' }) },
  });
  const checks = autopsy(dir).json.checks;
  // Nothing ran: no test group, so no check call with a test group.
  assert.deepEqual(checks.executions.map(pick), [['A1 implement', 'task-checks', 'ran', 'widened', null]]);
  assert.deepEqual(checks.task_check_calls,
    { total: 1, by_selected: { ...NONE, widened: 1 }, failed: 1, reasons: { git_failed: 1 } });
  assert.deepEqual(checks.full_suite_runs, { total: 0, inferred: 0, by_role: {} });
  assert.deepEqual(checks.project_test_runs, { total: 0, by_role: {}, unavailable: 0 });
});

test('repairs and skipped setups are counted; absent data is unavailable', () => {
  const repair = (attempt, eligible, status) => ({
    attempt, from: 'd'.repeat(40), observed_head: 'e'.repeat(40), eligible, head: eligible ? 'e'.repeat(40) : 'd'.repeat(40),
    failed: [TEST_CMD], status, notes: '' });
  const result = (repairs) => ({ status: 'complete', run_id: 'c1', version: '1.6.0', tasks: {},
    final: { findings: [], fixed: [], declined: [], open: [], repairs } });
  const m = manifest({
    commands: { setup: ['npm ci'], test: [TEST_CMD], lint: [], build: [] },
    lanes: [...manifest().lanes, { id: 'c', name: 'Lane c', tasks: [{ id: 'C1', title: 'C1', tier: 'standard' }] }],
    lane_commands: { b: { setup: [] } },
    setup_result: { feature_head: 'f'.repeat(40), discarded: [], preserved: [], worktrees: {}, setup_skipped: ['a'] },
  });
  const dir = buildRun({ m, launches: [
    { start: '10:00:00', durationMs: 60000, result: result([repair(1, true, 'done')]) },
    { start: '11:00:00', durationMs: 60000, result: result([repair(2, false, 'blocked')]) },
  ] });
  const { json, md } = autopsy(dir);
  assert.deepEqual(json.checks.repairs, { attempts: 2, eligible: 1, by_status: { done: 1, blocked: 1 } });
  assert.deepEqual(json.checks.setup, { skipped: ['a'], no_setup_commands: ['b'] });
  assert.match(md, /^Repairs: 2 attempts, 1 eligible head \(done 1, blocked 1\)$/m);
  assert.match(md, /^Setup: skipped for a; no setup commands: b$/m);
  // A 1.6.0 report with no repair says 0; an older report has no
  // final.repairs and a manifest without setup_skipped says nothing.
  let checks = autopsy(buildRun({ launches: [{ result: result([]) }] })).json.checks;
  assert.deepEqual(checks.repairs, { attempts: 0, eligible: 0, by_status: {} });
  assert.equal(checks.setup, 'unavailable');
  const old = result([]);
  delete old.final.repairs;
  const oldManifest = manifest({ setup_result: { feature_head: 'f'.repeat(40), discarded: [], preserved: [], worktrees: {} } });
  const res = autopsy(buildRun({ m: oldManifest, launches: [{ result: old }] }));
  checks = res.json.checks;
  assert.equal(checks.repairs, 'unavailable');
  assert.equal(checks.setup, 'unavailable');
  assert.match(res.md, /^Repairs: unavailable$/m);
  assert.match(res.md, /^Setup: unavailable$/m);
});

test('task_checks commands are configured checks with task ids', () => {
  const m = manifest({
    lane_commands: { b: { test: [`${TEST_CMD} -- b`] } },
    task_checks: {
      A1: { test: [TARGETED], lint: ['eslint src/a.js'] },
      A2: { test: [TEST_CMD, 'node --test tests/b.test.mjs'] },
    },
  });
  assert.deepEqual(python(['print(json.dumps(_autopsy.configured_checks(json.loads(sys.argv[1]))))'], [JSON.stringify(m)]), [
    ['test#1', TEST_CMD, true], ['lint#1', 'eslint .', false], ['b.test#1', `${TEST_CMD} -- b`, false],
    ['A1.task.test#1', TARGETED, false], ['A1.task.lint#1', 'eslint src/a.js', false],
    ['A2.task.test#2', 'node --test tests/b.test.mjs', false],
  ]);
  // A targeted command run by hand is classified by its id; it is no
  // full-suite run.
  const dir = buildRun({ m, launches: [{ agents: [{ label: 'A1 fix 1', start: '10:00:05', end: '10:05:00',
    calls: [{ command: `cd /w && ${TARGETED}`, start: '10:00:10', end: '10:00:40' }] }] }] });
  const checks = autopsy(dir).json.checks;
  assert.deepEqual(checks.executions.map((x) => [x.check, x.certainty, x.full_suite]), [['A1.task.test#1', 'ran', null]]);
  assert.deepEqual(checks.project_test_runs, { total: 0, by_role: {}, unavailable: 0 });
});

test('legacy full_suite_runs is unchanged on the existing fixtures', () => {
  const expected = {
    run1: { total: 2, inferred: 0, by_role: { implement: 1, verify: 1 } },
    run2: { total: 3, inferred: 0, by_role: { implement: 3 } },
    run3: { total: 4, inferred: 0, by_role: { implement: 2, verify: 1, 'final fix': 1 } },
  };
  for (const [name, full] of Object.entries(expected)) {
    const dir = join(TMP, `fixture-${name}`);
    cpSync(join(FIXTURES, name), dir, { recursive: true });
    const { json, md } = autopsy(dir);
    assert.deepEqual(json.checks.full_suite_runs, full, name);
    assert.match(md, new RegExp(`^Check calls with a test group: ${full.total}$`, 'm'), name);
    // Archives from before 1.6.0: no task-checks call, no repairs, no setup_skipped.
    assert.deepEqual(json.checks.task_check_calls, { total: 0, by_selected: NONE, failed: 0, reasons: {} }, name);
    assert.equal(json.checks.repairs, 'unavailable', name);
    assert.equal(json.checks.setup, 'unavailable', name);
  }
  // run3's verify passes commands.test exactly to run-checks: every full-suite
  // run there is a project test run.
  const dir = join(TMP, 'fixture-run3');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'autopsy.json'), 'utf8')).checks.project_test_runs,
    { total: 4, by_role: { implement: 2, verify: 1, 'final fix': 1 }, unavailable: 0 });
  assert.ok(existsSync(join(dir, 'autopsy.md')));
});

test('AUTOPSY_VERSION is 5', () => {
  assert.deepEqual(python(['print(json.dumps([_autopsy.AUTOPSY_VERSION, _autopsy.SUGGESTIONS["long_tool_call"]]))']), [
    5, 'A single tool call likely ran for over 2 minutes. Try a narrower command while iterating, and the task '
      + 'checks once before committing.',
  ]);
  const dir = buildRun({ launches: [{ agents: [{ label: 'A1 implement', start: '10:00:05', end: '10:01:00' }] }] });
  assert.equal(autopsy(dir).json.autopsy_version, 5);
});
