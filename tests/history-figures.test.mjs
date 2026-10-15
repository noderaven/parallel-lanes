// _history.run_figures (1.6.4): one run's task time, fixed phases and final
// review from its autopsy, shared by scripts/history and scripts/worth-it; and
// the project matching and run folder helpers moved there from scripts/history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';

const SCRIPTS = join(SKILL_DIR, 'scripts');

// Runs a Python snippet with scripts/ importable (no bytecode); returns its stdout as JSON.
function python(lines, input = null) {
  const code = [
    'import json, sys',
    'sys.dont_write_bytecode = True',
    `sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`,
    'import _history',
    ...lines,
  ].join('\n');
  const r = spawnSync('python3', ['-B', '-c', code], { encoding: 'utf8', input });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const T = (hms) => `2026-10-15T${hms}.000Z`;
const agent = (task, role, launch, start, end) => ({ label: `${task} ${role}`, task, role, launch, start: T(start), end: T(end) });
const phase = (name, launch, start, end) => ({ phase: name, launch, start: T(start), end: T(end) });
const MANIFEST = { prelude: [], join: [], lanes: [{ id: 'a', tasks: [{ id: 'A1' }, { id: 'B1' }] }] };
const figures = (analysis, manifest = MANIFEST) =>
  python(['a, m = json.load(sys.stdin)', 'print(json.dumps(_history.run_figures(a, m)))'], JSON.stringify([analysis, manifest]));

// Launch wf_b started first (10:00) and ran no task; wf_a (later, 12:00, though its id
// sorts first) ran A1 and B1; wf_c (14:00) ran only phases.
const ANALYSIS = {
  time: {
    agents: [
      agent('A1', 'implement', 'wf_b', '10:01:00', '10:05:00'),
      agent('A1', 'implement', 'wf_a', '12:10:00', '12:20:00'),
      agent('A1', 'review', 'wf_a', '12:20:00', '12:22:00'),
      agent('B1', 'implement', 'wf_a', '12:10:00', '12:15:00'),
      { label: 'pre-flight', task: null, role: 'pre-flight', launch: 'wf_a', start: T('12:00:00'), end: T('12:10:00') },
    ],
    phases: [
      phase('Pre-flight', 'wf_b', '10:00:00', '10:01:00'),
      phase('Pre-flight', 'wf_a', '12:00:00', '12:10:00'),
      phase('Lane a', 'wf_a', '12:10:00', '12:22:00'),
      phase('Integrate', 'wf_a', '12:22:00', '12:30:00'),
      phase('Final review', 'wf_a', '12:30:00', '12:50:00'),
      phase('Verify', 'wf_a', '12:40:00', '12:45:00'),
      phase('Pre-flight', 'wf_c', '14:00:00', '14:30:00'),
    ],
  },
};

test('run_figures uses the latest launch that ran tasks', () => {
  // wf_b's A1 ran earlier than wf_a; wf_c ran no task agent.
  const f = figures(ANALYSIS);
  assert.deepEqual(f, { launch: 'wf_a', tasks: 2, task_s: 510, fixed_s: 2280, final_review_s: 1200, wall_s: 3000 });
});

test('run_figures matches phase labels exactly', () => {
  const a = JSON.parse(JSON.stringify(ANALYSIS));
  a.time.phases.push(phase('Lane verify', 'wf_a', '12:50:00', '13:20:00'));
  const f = figures(a);
  assert.equal(f.fixed_s, 2280);
  assert.equal(f.wall_s, 4800);
});

test('run_figures is None without task agents', () => {
  const a = { time: { agents: [{ label: 'pre-flight', task: null, launch: 'wf_a', start: T('12:00:00'), end: T('12:10:00') }],
    phases: ANALYSIS.time.phases } };
  assert.equal(figures(a), null);
  assert.equal(figures({ time: {} }), null);
  assert.equal(figures({}), null);
  // An agent of a task the manifest does not name does not count.
  assert.equal(figures(ANALYSIS, { prelude: [], join: [], lanes: [{ id: 'a', tasks: [{ id: 'Z9' }] }] }), null);
});

test('matches_project still matches path forms', () => {
  const r = python([
    'e = {"project": "C:/x/proj"}',
    'print(json.dumps([_history.matches_project(e, n) for n in ["C:/x/proj", "c:/X/PROJ", "proj", "PROJ", "other"]]'
      + ' + [_history.matches_project({"project": "/home/u/proj"}, n) for n in ["/home/u/proj", "proj", "PROJ"]]'
      + ' + [_history.matches_project({"project": "unavailable"}, "unavailable")]))',
  ]);
  assert.deepEqual(r, [true, true, true, true, false, true, true, false, false]);
});

test('run_folder stays inside the history dir', () => {
  const r = python([
    'import os',
    'h = os.path.abspath("hist")',
    'print(json.dumps([_history.run_folder(h, {"folder": "2026-10-15-d1a"}) == os.path.join(h, "2026-10-15-d1a"),'
      + ' _history.run_folder(h, {"folder": "../x"}), _history.run_folder(h, {"folder": ""}),'
      + ' _history.run_folder(h, {})]))',
  ]);
  assert.deepEqual(r, [true, null, null, null]);
});
