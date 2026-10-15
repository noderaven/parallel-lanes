// tools/worth-it-backtest.py (1.6.4): the back-test behind worth-it's threshold,
// run on a copy of a history dir. It prints tables, not a verdict; the test
// checks it runs on a small fixture archive and refuses the live history dir.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { mergeEnv, tempDir } from './platform.mjs';

const SCRIPT = join(SKILL_DIR, 'tools', 'worth-it-backtest.py');
const TMP = tempDir('pl-backtest-');
after(() => rmSync(TMP, { recursive: true, force: true }));

function env(extra = {}) {
  const e = mergeEnv(process.env);
  for (const key of Object.keys(e)) {
    if (['PL_HISTORY_DIR', 'CLAUDE_CONFIG_DIR'].includes(key.toUpperCase())) delete e[key];
  }
  return { ...e, ...extra };
}

const T = (day, s) => new Date(Date.UTC(2026, 9, day, 10) + s * 1000).toISOString();
// A run: tasks [{id, lane, s}] (lane null: prelude), its day, project.
function archive(runs) {
  const dir = join(TMP, `hist-${runs.length}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const entries = [];
  for (const r of runs) {
    const folder = join(dir, r.id);
    mkdirSync(folder);
    const lanes = {};
    const prelude = [];
    for (const t of r.tasks) {
      if (t.lane === null) prelude.push({ id: t.id });
      else (lanes[t.lane] = lanes[t.lane] || []).push({ id: t.id });
    }
    writeFileSync(join(folder, 'p.lanes.json'), JSON.stringify({ prelude, join: [],
      lanes: Object.entries(lanes).map(([id, tasks]) => ({ id, tasks })), limits: { max_parallel_lanes: 5 } }));
    const agents = r.tasks.map((t) => ({ task: t.id, launch: 'wf_1', start: T(r.day, 600), end: T(r.day, 600 + t.s) }));
    const end = 600 + Math.max(...r.tasks.map((t) => t.s));
    writeFileSync(join(folder, 'autopsy.json'), JSON.stringify({ time: { agents, phases: [
      { phase: 'Pre-flight', launch: 'wf_1', start: T(r.day, 0), end: T(r.day, 600) },
      { phase: 'Lane a', launch: 'wf_1', start: T(r.day, 600), end: T(r.day, end) },
      { phase: 'Final review', launch: 'wf_1', start: T(r.day, end), end: T(r.day, end + 900) },
    ] } }));
    entries.push({ run_id: r.id, folder: r.id, project: r.project, status: 'complete', first_launch: T(r.day, 0) });
  }
  writeFileSync(join(dir, 'index.json'), JSON.stringify({ version: 1, runs: entries }));
  return dir;
}

const RUNS = [
  { id: 'a1', day: 1, project: '/x/p', tasks: [{ id: 'T1', lane: 'a', s: 600 }, { id: 'T2', lane: 'b', s: 900 }] },
  { id: 'a2', day: 2, project: '/x/p', tasks: [{ id: 'T1', lane: null, s: 300 }, { id: 'T2', lane: 'a', s: 600 },
    { id: 'T3', lane: 'b', s: 600 }, { id: 'T4', lane: 'c', s: 600 }] },
  { id: 'b1', day: 3, project: '/y/q', tasks: [{ id: 'T1', lane: 'a', s: 1200 }, { id: 'T2', lane: 'a', s: 1200 }] },
];

test('the back-test prints its tables on a fixture archive', () => {
  const dir = archive(RUNS);
  const r = spawnSync('python3', ['-B', SCRIPT, dir], { encoding: 'utf8', env: env() });
  assert.equal(r.status, 0, r.stderr);
  for (const marker of ['in-sample:', 'out-of-sample:', '(F - R) / T quartiles', 'agrees']) {
    assert.ok(r.stdout.includes(marker), `${marker} missing:\n${r.stdout}`);
  }
  // a2: prelude T1, lanes [1, 1, 1] across 3 workers: 2 task-slots of 4 tasks, saved 2.
  assert.match(r.stdout, /^a2 .* N\s+4 .* slots\s+2 /m);
  // b1: one lane, saved 0.
  assert.match(r.stdout, /^b1 .* N\s+2 .* slots\s+2 /m);
  const median = spawnSync('python3', ['-B', SCRIPT, dir, 'median'], { encoding: 'utf8', env: env() });
  assert.equal(median.status, 0, median.stderr);
  assert.match(median.stdout, /aggregate: median/);
});

test('the back-test refuses the live history dir', () => {
  const dir = archive(RUNS);
  const r = spawnSync('python3', ['-B', SCRIPT, dir], { encoding: 'utf8', env: env({ PL_HISTORY_DIR: dir }) });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /copy the history first/);
  const usage = spawnSync('python3', ['-B', SCRIPT], { encoding: 'utf8', env: env() });
  assert.equal(usage.status, 2);
});
