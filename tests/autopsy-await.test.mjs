// scripts/_autopsy.py and the 1.6.1 long-check procedure (spec 4.5): a check
// started with run_in_background and its result path (run-checks --out F,
// task-checks --evidence F), then waited on with await-checks wait F, is one
// check execution timed from its report; task-check evidence is matched by
// that path; checks.waits counts the procedure, its waits and stops, and the
// improvised waits (Monitor errors, blocked sleeps, reads of the harness's
// tasks/<id>.output files). Each test builds a small run folder in a temp
// dir the way tests/autopsy-check-policy.test.mjs does: a *.lanes.json
// manifest, wf_<n>.json result files, wf_<n>/agent-<k>.jsonl transcripts
// with their meta files, and the ledger dir with its checks/ files.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { tempDir } from './platform.mjs';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const SCRIPT = join(SCRIPTS, 'autopsy');
const TMP = tempDir('pl-autopsy-await-');
after(() => rmSync(TMP, { recursive: true, force: true }));

const T = (hms) => `2026-10-12T${hms}.000Z`;
const ms = (hms) => Date.parse(T(hms));
const BASE = 'b'.repeat(40);
const TEST_CMD = 'npm test';
const TARGETED = 'node --test tests/a.test.mjs';
const LEDGER = 'C:/src/plans/p.c1.ledger';

function manifest() {
  return {
    version: 1,
    run_id: 'c1',
    plan: 'C:/src/plans/p.md',
    spec: null,
    repo: {
      mode: 'git', root: 'C:/src/proj', branch: 'feat', base: 'main', worktree_root: 'C:/src/proj-wt',
      ledger_dir: LEDGER,
    },
    commands: { setup: [], test: [TEST_CMD], lint: [], build: [] },
    prelude: [],
    lanes: [{ id: 'a', name: 'Lane a', tasks: [{ id: 'A1', title: 'A1', tier: 'standard' }] }],
    join: [],
  };
}

// The command lines of the procedure, as the engine's prompts build them.
const PY = "'python3'";
const reserve = (name) => `${PY} '/skill/scripts/await-checks' reserve --ledger '${LEDGER}' --name '${name}'`;
const wait = (file) => `${PY} '/skill/scripts/await-checks' wait '${file}'`;
const taskChecks = (unit, evidence = null) => `cd '/w/lane-a' && ${PY} '/skill/scripts/task-checks' '/w/lane-a'`
  + ` --base ${BASE} --ledger '${LEDGER}' --unit '${unit}' --lane a --task '${unit}'`
  + `${evidence ? ` --evidence '${evidence}'` : ''} --targeted test '${TARGETED}' --lane-cmd test '${TEST_CMD}'`;
const runChecks = (out) => `cd '/w' && ${PY} '/skill/scripts/run-checks' '/w'${out ? ` --out '${out}'` : ''}`
  + ` --root '${LEDGER}' --cmd test '${TEST_CMD}'`;
const checksFile = (name) => `${LEDGER}/checks/${name}`;

// Tool calls: {name = 'Bash', input, start, end (null: no result), text,
// error}. bash() is a Bash call; exit N > 0 puts Claude Code's 'Exit code N'
// line first and marks the result an error.
function bash(command, start, end, { exit = 0, text = 'out', background = false } = {}) {
  const input = background ? { command, run_in_background: true } : { command, timeout: 600000 };
  return { name: 'Bash', input, start, end, text: exit ? `Exit code ${exit}\n${text}` : text, error: exit !== 0 };
}
const started = (id) => `Command running in background with ID: ${id}. Output is being written to: `
  + `C:/Users/u/AppData/Local/Temp/claude/p/s/tasks/${id}.output`;
const RUNNING = (file) => JSON.stringify({ status: 'running', file, waited_s: 540 });
const STOPPED = (file) => JSON.stringify({ status: 'stopped', file, reason: 'died' });

// One agent's transcript lines: the prompt, each call and its result, and a
// last assistant line at end.
function transcript(id, { start, end, calls = [] }) {
  const lines = [{ type: 'user', timestamp: T(start), message: { role: 'user', content: 'Do the task.' } }];
  const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  calls.forEach((c, i) => {
    const tu = `tu_${id}_${i + 1}`;
    lines.push({ type: 'assistant', timestamp: T(c.start), message: {
      id: `m_${id}_${i + 1}`, role: 'assistant', model: 'claude-sonnet-4-6', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: tu, name: c.name || 'Bash', input: c.input }], usage } });
    if (c.end === null) return;
    lines.push({ type: 'user', timestamp: T(c.end), message: { role: 'user', content: [{
      type: 'tool_result', tool_use_id: tu, content: c.text, is_error: c.error === true }] } });
  });
  lines.push({ type: 'assistant', timestamp: T(end), message: {
    id: `m_${id}_end`, role: 'assistant', model: 'claude-sonnet-4-6', stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'Done.' }], usage } });
  return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
}

// run-checks' report: one result per [started, ended] pair.
function report(spans, ok = true) {
  return {
    checkout: '/w', branch: 'pl/a', head: 'c'.repeat(40), ok, clean: true, tree_changed: false,
    results: spans.map(([s, e], i) => ({ group: 'test', command: TEST_CMD, exit: ok ? 0 : 1, started: T(s), ended: T(e),
      duration_s: (ms(e) - ms(s)) / 1000, log: `${LEDGER}/checks/x.${i + 1}.log`, tail: '' })),
    tracked_before: [], tracked_after: [], untracked_before: [], untracked_after: [],
  };
}

// task-checks' evidence: the report plus policy.
function evidence({ unit, started, selected = 'targeted', ok = true, spans = null }) {
  const out = report(spans || [[started, started]], ok);
  out.policy = {
    unit, tasks: [unit], lane: 'a', base: BASE, started: T(started), entry: unit, selected, reasons: [],
    changed: ['src/a.js'], offered: { targeted: [{ group: 'test', command: TARGETED }],
      lane: [{ group: 'test', command: TEST_CMD }], wide: [{ group: 'test', command: TEST_CMD }] },
    project_test_executed: selected !== 'targeted',
  };
  return out;
}

let runs = 0;
// A run folder: agents [{label, phase, start, end, calls}], files {name in
// the ledger's checks/: object or raw text}, the engine version.
function buildRun({ agents = [], files = {}, version = '1.6.1' } = {}) {
  runs += 1;
  const dir = join(TMP, `run${runs}`);
  mkdirSync(join(dir, 'p.c1.ledger', 'checks'), { recursive: true });
  writeFileSync(join(dir, 'p.lanes.json'), JSON.stringify(manifest(), null, 2));
  writeFileSync(join(dir, 'p.c1.ledger', '_run.jsonl'), `${JSON.stringify({ event: 'run_started', run_id: 'c1' })}\n`);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, 'p.c1.ledger', 'checks', name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  writeFileSync(join(dir, 'wf_1.json'), JSON.stringify({
    runId: 'wf_1', workflowName: 'parallel-lanes', status: 'completed', startTime: ms('10:00:00'),
    durationMs: 3600000, result: { status: 'complete', run_id: 'c1', version, tasks: {} },
  }));
  mkdirSync(join(dir, 'wf_1'), { recursive: true });
  agents.forEach((a, k) => {
    const id = `1x${k + 1}`;
    writeFileSync(join(dir, 'wf_1', `agent-${id}.meta.json`), JSON.stringify({
      agentType: 'workflow-subagent', description: a.label, workflowPhase: a.phase || 'Lane a', model: 'sonnet' }));
    writeFileSync(join(dir, 'wf_1', `agent-${id}.jsonl`), transcript(id, a));
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
const NOTHING = { monitor_errors: 0, sleep_blocked: 0, harness_output_reads: 0 };
// The slowdowns of tool calls (the fixtures' launches leave idle gaps).
const TOOL_KINDS = ['background_check', 'timeout', 'repeated_failure', 'heredoc_failure', 'edit_retry',
  'long_tool_call', 'check_rerun'];
const kinds = (json) => json.slowdowns.map((s) => s.kind).filter((k) => TOOL_KINDS.includes(k));

test('a procedure check is one measured execution timed from its report', () => {
  const out = checksFile('integrate.1.json');
  const dir = buildRun({
    agents: [{ label: 'integrate', phase: 'Integrate', start: '10:00:00', end: '10:13:00', calls: [
      bash(reserve('integrate'), '10:00:05', '10:00:06', { text: out }),
      bash(runChecks(out), '10:00:10', '10:00:11', { background: true, text: started('bx1') }),
      bash(wait(out), '10:00:12', '10:09:12', { exit: 4, text: RUNNING(out) }),
      bash(wait(out), '10:09:13', '10:11:13', { exit: 4, text: RUNNING(out) }),
      bash(wait(out), '10:11:14', '10:12:01', { text: JSON.stringify(report([['10:00:12', '10:05:00'],
        ['10:05:00', '10:11:58']])) }),
    ] }],
    files: { 'integrate.1.json': report([['10:00:12', '10:05:00'], ['10:05:00', '10:11:58']]) },
  });
  const { json } = autopsy(dir);
  const x = json.checks.executions;
  assert.equal(x.length, 1);
  assert.deepEqual([x[0].check, x[0].certainty, x[0].timing, x[0].background, x[0].start, x[0].end, x[0].s],
    ['run-checks', 'ran', 'measured', true, T('10:00:12'), T('10:11:58'), 706]);
  assert.deepEqual(json.checks.by_check, { 'run-checks': { runs: 1, inferred: 0, untimed: 0, total_s: 706 } });
  // Neither the start nor its waits are slowdowns: no background run, no
  // timeout, no long call (the first wait blocked for 540 s), and the waits
  // that exit 4 are no repeated failure.
  assert.deepEqual(kinds(json), []);
  assert.deepEqual(json.checks.waits, { checks_via_procedure: 1, wait_calls: 3, stopped: 0, improvised: NOTHING,
    unwaited: [], left_running: [] });
  // The waits are the check execution's time (checks section), not open
  // questions: d1a listed five 541.6 s waits as unexplained.
  assert.deepEqual(json.unexplained, []);
  // The same calls without a wait are the 1.6.0 background run.
  const bare = buildRun({
    agents: [{ label: 'integrate', phase: 'Integrate', start: '10:00:00', end: '10:13:00', calls: [
      bash(runChecks(out), '10:00:10', '10:00:11', { background: true, text: started('bx1') }),
    ] }],
    files: { 'integrate.1.json': report([['10:00:12', '10:05:00']]) },
  });
  const old = autopsy(bare).json;
  assert.deepEqual(old.checks.executions.map((e) => [e.timing, e.background, e.start]),
    [['unavailable', true, T('10:00:10')]]);
  assert.deepEqual(kinds(old), ['background_check']);
});

test('a procedure task check matches its evidence by path', () => {
  const three = checksFile('task-A1.3.json');
  const dir = buildRun({
    agents: [{ label: 'A1 implement', start: '10:00:00', end: '10:10:00', calls: [
      // A call without --evidence keeps 1.6.0's matching: unit and time.
      bash(taskChecks('A1'), '10:00:05', '10:00:40'),
      bash(reserve('task-A1'), '10:01:00', '10:01:01', { text: three }),
      bash(taskChecks('A1', three), '10:01:02', '10:01:03', { background: true, text: started('bx2') }),
      bash(wait(three), '10:01:04', '10:03:00', { text: '{"ok": true}' }),
    ] }],
    files: {
      'task-A1.1.json': evidence({ unit: 'A1', started: '10:00:06', selected: 'lane' }),
      // Written in the procedure's span by another run: 1.6.0's rule (the
      // earliest started in the span) would take it.
      'task-A1.2.json': evidence({ unit: 'A1', started: '10:01:30', selected: 'widened', ok: false }),
      'task-A1.3.json': evidence({ unit: 'A1', started: '10:01:40', spans: [['10:01:41', '10:02:51']] }),
    },
  });
  const checks = autopsy(dir).json.checks;
  assert.deepEqual(checks.executions.map((x) => [x.check, x.selected, x.timing, x.s]), [
    ['task-checks', 'lane', 'measured', 35],
    ['task-checks', 'targeted', 'measured', 70],
  ]);
  assert.deepEqual(checks.task_check_calls,
    { total: 2, by_selected: { ...NONE, lane: 1, targeted: 1 }, failed: 0, reasons: {} });
  assert.deepEqual(checks.project_test_runs, { total: 1, by_role: { implement: 1 }, unavailable: 0 });
});

test('a procedure start whose result file is empty is unavailable, not a pass', () => {
  const one = checksFile('task-A1.1.json');
  const two = checksFile('task-A1.2.json');
  const dir = buildRun({
    agents: [{ label: 'A1 implement', start: '10:00:00', end: '10:10:00', calls: [
      bash(reserve('task-A1'), '10:00:05', '10:00:06', { text: one }),
      bash(taskChecks('A1', one), '10:00:07', '10:00:08', { background: true, text: started('bx1') }),
      bash(wait(one), '10:00:09', '10:01:30', { exit: 5, text: STOPPED(one) }),
      // The rerun's evidence must stay its own.
      bash(reserve('task-A1'), '10:01:40', '10:01:41', { text: two }),
      bash(taskChecks('A1', two), '10:01:42', '10:01:43', { background: true, text: started('bx2') }),
      bash(wait(two), '10:01:44', '10:03:00', { text: '{"ok": true}' }),
    ] }],
    files: {
      'task-A1.1.json': '',
      'task-A1.2.json': evidence({ unit: 'A1', started: '10:01:45', spans: [['10:01:46', '10:02:56']] }),
    },
  });
  const checks = autopsy(dir).json.checks;
  assert.deepEqual(checks.executions.map((x) => [x.selected, x.timing, x.s, x.end, x.full_suite]), [
    ['unavailable', 'unavailable', 'unavailable', 'unavailable', 'inferred'],
    ['targeted', 'measured', 70, T('10:02:56'), 'ran'],
  ]);
  assert.deepEqual(checks.task_check_calls,
    { total: 2, by_selected: { ...NONE, targeted: 1, unavailable: 1 }, failed: 0, reasons: {} });
  assert.deepEqual(checks.by_check, { 'task-checks': { runs: 2, inferred: 0, untimed: 1, total_s: 70 } });
  assert.equal(checks.waits.stopped, 1);
});

test('waits counts procedure checks, wait calls and stops', () => {
  const one = checksFile('verify-abc.json');
  const long = checksFile('long.1.json');
  const fore = checksFile('long.2.json');
  const lone = checksFile('long.3.json');
  const dir = buildRun({
    agents: [
      { label: 'verify', phase: 'Verify', start: '10:00:00', end: '10:10:00', calls: [
        bash(`${reserve('verify-abc')} --exact`, '10:00:05', '10:00:06', { text: one }),
        bash(runChecks(one), '10:00:07', '10:00:08', { background: true, text: started('bx1') }),
        bash(wait(one), '10:00:09', '10:01:00', { exit: 4, text: RUNNING(one) }),
        bash(wait(one), '10:01:01', '10:02:00', { exit: 5, text: STOPPED(one) }),
        bash(`${reserve('verify-abc')} --exact`, '10:02:05', '10:02:06', { text: one }),
        bash(runChecks(one), '10:02:07', '10:02:08', { background: true, text: started('bx2') }),
        bash(wait(one), '10:02:09', '10:04:00', { text: '{"ok": true}' }),
      ] },
      { label: 'final fix', phase: 'Final review', start: '10:05:00', end: '10:20:00', calls: [
        // A start without a reserve is still one execution, but not the
        // whole procedure.
        bash(runChecks(long), '10:05:07', '10:05:08', { background: true, text: started('bx3') }),
        bash(wait(long), '10:05:09', '10:06:00', { text: '{"ok": true}' }),
        // A foreground call and a background call without a wait are no
        // procedure.
        bash(runChecks(fore), '10:06:10', '10:07:00'),
        bash(runChecks(lone), '10:07:10', '10:07:11', { background: true, text: started('bx4') }),
      ] },
    ],
    files: {
      'verify-abc.json': report([['10:02:10', '10:03:50']]),
      'long.1.json': report([['10:05:10', '10:05:50']]),
      'long.2.json': report([['10:06:11', '10:06:59']]),
    },
  });
  const { json, md } = autopsy(dir);
  assert.deepEqual(json.checks.waits, { checks_via_procedure: 2, wait_calls: 4, stopped: 1, improvised: NOTHING,
    unwaited: [{ agent: 'final fix', file: lone }], left_running: [] });
  assert.deepEqual(json.checks.executions.map((x) => [x.agent, x.timing, x.s]), [
    // --exact reuses its path: the stopped start has no report of its own.
    ['verify', 'unavailable', 'unavailable'],
    ['verify', 'measured', 100],
    ['final fix', 'measured', 40],
    ['final fix', 'measured', 50],
    ['final fix', 'unavailable', 'unavailable'],
  ]);
  assert.deepEqual(kinds(json), ['background_check']);
  assert.match(md, /^Checks via the procedure: 2; 4 wait calls; 1 stopped$/m);
  assert.match(md, /^Improvised waits: Monitor errors 0, blocked sleeps 0, harness output reads 0$/m);
  for (const label of ['Checks via the procedure', 'Improvised waits']) {
    const lines = md.split('\n');
    const at = lines.findIndex((l) => l.startsWith(`${label}:`));
    assert.ok(at >= 0, label);
    assert.ok(lines[at + 1].startsWith('  '), `${label} has a definition line`);
  }
  // procedure_file reads the result path of a background start only.
  const call = (command, background = true) => ({ name: 'Bash', input: background
    ? { command, run_in_background: true } : { command } });
  const calls = [
    call(runChecks(long)), call(taskChecks('A1', one)), call(runChecks(long), false), call(runChecks(null)),
    call(taskChecks('A1')), call(`echo run-checks --out '${long}'`), call(wait(long)),
    call("py C:\\skill\\scripts\\run-checks C:\\w --out C:\\l\\checks\\integrate.1.json --cmd test 'npm test'"),
    { name: 'Read', input: { file_path: long, run_in_background: true } },
  ];
  assert.deepEqual(python([
    'print(json.dumps([_autopsy.procedure_file(c) for c in json.loads(sys.argv[1])]))',
  ], [JSON.stringify(calls)]), [long, one, null, null, null, null, null, 'C:/l/checks/integrate.1.json', null]);
  assert.equal(python(['print(json.dumps(_autopsy.AWAIT_CHECKS))']), 'await-checks');
});

test('improvised counts Monitor errors, blocked sleeps and harness output reads per call', () => {
  const task = 'C:/Users/u/AppData/Local/Temp/claude/p/s/tasks/abc.output';
  const winTask = 'C:\\Users\\u\\AppData\\Local\\Temp\\claude\\p\\s\\tasks\\abc.output';
  const monitor = (start, end) => ({ name: 'Monitor', input: { command: `until grep -q ok '${task}'; do sleep 10; done` },
    start, end, error: true, text: '<tool_use_error>Error: No such tool available: Monitor. Monitor is not among the '
      + 'tools available here. Continue with the tools you have.</tool_use_error>' });
  const blocked = `sleep 240; cat "${task}" | tail -20`;
  const dir = buildRun({
    version: '1.6.0',
    agents: [{ label: 'verify', phase: 'Verify', start: '10:00:00', end: '10:30:00', calls: [
      monitor('10:00:05', '10:00:06'),
      monitor('10:00:07', '10:00:08'),
      // One blocked call is both a blocked sleep and a read.
      { name: 'Bash', input: { command: blocked, timeout: 300000 }, start: '10:00:10', end: '10:00:11', error: true,
        text: `<tool_use_error>Blocked: sleep 240 followed by: cat "${task}" tail -20</tool_use_error>` },
      { name: 'Read', input: { file_path: winTask }, start: '10:00:20', end: '10:00:21', text: '1 {"ok": true}' },
      bash(`f='${winTask}'; for i in $(seq 1 55); do [ -s "$f" ] && break; sleep 10; done; cat "$f"`,
        '10:00:30', '10:09:30'),
      // A call without a result still named the file.
      { name: 'Bash', input: { command: `tail -5 '${task}'` }, start: '10:10:00', end: null },
      // Not counted: another tool naming the file, names that only look
      // alike, and the texts appearing later in a result.
      { name: 'Grep', input: { pattern: 'ok', path: task }, start: '10:11:00', end: '10:11:01', text: 'x' },
      bash('cat src/tasks/abc.outputs; ls tasks/', '10:12:00', '10:12:01'),
      bash('grep -r Monitor log.txt', '10:13:00', '10:13:01',
        { text: 'log.txt: No such tool available: Monitor\nlog.txt: Blocked: sleep 1' }),
    ] }],
  });
  const { json, md } = autopsy(dir);
  assert.deepEqual(json.checks.waits.improvised, { monitor_errors: 2, sleep_blocked: 1, harness_output_reads: 4 });
  assert.match(md, /^Improvised waits: Monitor errors 2, blocked sleeps 1, harness output reads 4$/m);
});

test('an older run says checks_via_procedure unavailable', () => {
  const agents = [{ label: 'A1 implement', start: '10:00:00', end: '10:05:00', calls: [
    { name: 'Monitor', input: { command: 'x' }, start: '10:00:05', end: '10:00:06', error: true,
      text: '<tool_use_error>Error: No such tool available: Monitor.</tool_use_error>' },
    bash(taskChecks('A1'), '10:00:10', '10:00:40'),
  ] }];
  const files = { 'task-A1.1.json': evidence({ unit: 'A1', started: '10:00:11' }) };
  for (const version of ['1.6.0', '1.5.1', 'unavailable']) {
    const { json, md } = autopsy(buildRun({ agents, files, version }));
    assert.deepEqual(json.checks.waits, { checks_via_procedure: 'unavailable', wait_calls: 0, stopped: 0,
      improvised: { ...NOTHING, monitor_errors: 1 }, unwaited: [], left_running: [] }, version);
    assert.match(md, /^Checks via the procedure: unavailable; 0 wait calls; 0 stopped$/m);
  }
  // From 1.6.1 on, no procedure call is a count of 0.
  const { json } = autopsy(buildRun({ agents, files, version: '1.6.1' }));
  assert.equal(json.checks.waits.checks_via_procedure, 0);
  // An await-checks call shows the procedure whatever the version says.
  const one = checksFile('task-A1.2.json');
  const { json: mixed } = autopsy(buildRun({ version: '1.6.0', agents: [{ label: 'A1 implement', start: '10:00:00',
    end: '10:05:00', calls: [
      bash(reserve('task-A1'), '10:00:05', '10:00:06', { text: one }),
      bash(taskChecks('A1', one), '10:00:07', '10:00:08', { background: true, text: started('bx1') }),
      bash(wait(one), '10:00:09', '10:01:00', { text: '{"ok": true}' }),
    ] }] }));
  assert.equal(mixed.checks.waits.checks_via_procedure, 1);
  // Without any timed tool event the counts cannot be derived.
  const untimed = buildRun({ agents: [] });
  assert.equal(python(['print(json.dumps(_autopsy.waits_section(_autopsy.load(sys.argv[1]))))'], [untimed]),
    'unavailable');
  assert.match(autopsy(untimed).md, /^Checks via the procedure: unavailable$/m);
});

test('the version is 6', () => {
  assert.equal(python(['print(json.dumps(_autopsy.AUTOPSY_VERSION))']), 6);
  const dir = buildRun({ agents: [{ label: 'A1 implement', start: '10:00:05', end: '10:01:00' }] });
  assert.equal(autopsy(dir).json.autopsy_version, 6);
});

test('checks.waits lists background checks never waited on, and checks left running when the waits stopped', () => {
  const out = checksFile('integrate.1.json');
  const late = checksFile('task-A1.1.json');
  const dir = buildRun({
    agents: [
      { label: 'integrate', phase: 'Integrate', start: '10:00:00', end: '10:13:00', calls: [
        bash(reserve('integrate'), '10:00:05', '10:00:06', { text: out }),
        bash(runChecks(out), '10:00:10', '10:00:11', { background: true, text: started('bx1') }),
      ] },
      { label: 'A1 implement', start: '10:00:00', end: '10:20:00', calls: [
        bash(reserve('task-A1'), '10:00:05', '10:00:06', { text: late }),
        bash(taskChecks('A1', late), '10:00:10', '10:00:11', { background: true, text: started('bx2') }),
        bash(wait(late), '10:00:12', '10:09:12', { exit: 4, text: RUNNING(late) }),
      ] },
    ],
  });
  const { json, md } = autopsy(dir);
  assert.deepEqual(json.checks.waits.unwaited, [{ agent: 'integrate', file: out }]);
  assert.deepEqual(json.checks.waits.left_running, [{ agent: 'A1 implement', file: late }]);
  assert.ok(md.includes('Background checks never waited on: 1 (integrate)'), md);
  assert.ok(md.includes('Checks left running when the waits stopped: 1 (A1 implement)'), md);
});
