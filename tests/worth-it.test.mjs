// scripts/worth-it (1.6.4): from the session's lane layout, the task-slots a
// run needs (prelude, lanes queued whole in order across the lanes at once,
// join), the task-times it saves, and a recommendation (direct when it saves 1
// or fewer); plus a scale line from the project's archived runs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { mergeEnv, tempDir } from './platform.mjs';

const SCRIPT = join(SKILL_DIR, 'scripts', 'worth-it');
const TMP = tempDir('pl-worth-it-');
after(() => rmSync(TMP, { recursive: true, force: true }));

function env() {
  const e = mergeEnv(process.env);
  for (const key of Object.keys(e)) {
    if (['PL_HISTORY_DIR', 'CLAUDE_CONFIG_DIR'].includes(key.toUpperCase())) delete e[key];
  }
  return e;
}

// The script's module functions, loaded as task-checks loads ledger (no bytecode).
function module(lines) {
  const code = [
    'import json, sys, importlib.machinery, importlib.util',
    'sys.dont_write_bytecode = True',
    `loader = importlib.machinery.SourceFileLoader("_wi", ${JSON.stringify(SCRIPT)})`,
    'spec = importlib.util.spec_from_loader("_wi", loader)',
    'W = importlib.util.module_from_spec(spec)',
    'loader.exec_module(W)',
    ...lines,
  ].join('\n');
  const r = spawnSync('python3', ['-B', '-c', code], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

let plans = 0;
function plan(n) {
  plans += 1;
  const path = join(TMP, `plan${plans}.md`);
  const body = Array.from({ length: n }, (_, i) => `### Task T${i + 1}: Step ${i + 1}\n\nDo it.\n`).join('\n');
  writeFileSync(path, `# Plan\n\n${body}`);
  return path;
}

function run(args) {
  const r = spawnSync('python3', ['-B', SCRIPT, ...args], { encoding: 'utf8', env: env() });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* left null */ }
  return { status: r.status, json, stderr: r.stderr };
}

const NOWHERE = join(TMP, 'no-history');

test('slots queues whole lanes in order', () => {
  assert.deepEqual(module(['print(json.dumps([W.slots(0, [3, 3, 3, 3, 3, 3], 0, 5), W.slots(2, [4, 1, 1], 3, 2),'
    + ' W.slots(0, [], 5, 1), W.slots(1, [2, 2], 1, 2)]))']), [6, 9, 5, 4]);
});

test('the threshold is 1', () => {
  assert.deepEqual(module(['print(json.dumps([W.THRESHOLD, W.decide(1), W.decide(2), W.decide(0), W.decide(-1)]))']),
    [1, 'direct', 'parallel', 'direct', 'direct']);
});

test('a single lane is direct', () => {
  const r = run([plan(4), '--max-lanes', '3', '--lane', 'T1,T2,T3,T4', '--history-dir', NOWHERE]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.status, 'ok');
  assert.deepEqual([r.json.tasks, r.json.lanes, r.json.lanes_at_once, r.json.slots, r.json.saved, r.json.threshold,
    r.json.recommend], [4, 1, 1, 4, 0, 1, 'direct']);
});

test('a two-lane layout that saves 2 is parallel', () => {
  const r = run([plan(5), '--max-lanes', '2', '--lane', 'T1,T2,T3', '--lane', 'T4,T5', '--history-dir', NOWHERE]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([r.json.slots, r.json.saved, r.json.recommend], [3, 2, 'parallel']);
  // The prelude and join run in sequence around the lanes; empty values are allowed.
  const p = run([plan(6), '--max-lanes', '5', '--prelude', 'T1', '--lane', 'T2,T3', '--lane', 'T4', '--join', 'T5,T6',
    '--history-dir', NOWHERE]);
  assert.deepEqual([p.json.slots, p.json.saved, p.json.recommend], [5, 1, 'direct']);
  const e = run([plan(3), '--max-lanes', '2', '--prelude', '', '--lane', 'T1', '--lane', 'T2,T3', '--join', '',
    '--history-dir', NOWHERE]);
  assert.deepEqual([e.json.status, e.json.slots], ['ok', 2]);
});

test('bad layouts are unavailable with exit 0', () => {
  const p = plan(4);
  for (const [why, layout] of [
    ['twice in two lanes', ['--lane', 'T1,T2', '--lane', 'T2,T3']],
    ['in prelude and a lane', ['--prelude', 'T1', '--lane', 'T1,T2']],
    ['not in the plan', ['--lane', 'T1,T9']],
    ['no task at all', ['--lane', '']],
  ]) {
    const r = run([p, '--max-lanes', '3', ...layout, '--history-dir', NOWHERE]);
    assert.equal(r.status, 0, `${why}: ${r.stderr}`);
    assert.equal(r.json.status, 'unavailable', why);
    assert.ok(typeof r.json.reason === 'string' && r.json.reason.length > 0, why);
  }
  // An unreadable plan is unavailable too.
  const r = run([join(TMP, 'missing.md'), '--max-lanes', '3', '--lane', 'T1', '--history-dir', NOWHERE]);
  assert.deepEqual([r.status, r.json.status], [0, 'unavailable']);
});

test('usage errors exit 2', () => {
  const p = plan(3);
  for (const args of [
    [p, '--lane', 'T1,T2,T3'],
    [p, '--max-lanes', '0', '--lane', 'T1'],
    [p, '--max-lanes', 'x', '--lane', 'T1'],
    [p, '--max-lanes', '2', '--lane', 'T1', '--bogus', '1'],
    ['--max-lanes', '2', '--lane', 'T1'],
  ]) {
    const r = run(args);
    assert.equal(r.status, 2, JSON.stringify(args));
    assert.match(r.stderr, /usage/, JSON.stringify(args));
  }
});

// A history dir with index.json and run folders, each holding a manifest and an
// autopsy.json whose one launch ran tasks A1 and B1 for the given seconds each.
const T = (s) => new Date(Date.UTC(2026, 9, 15, 10) + s * 1000).toISOString();
function history(runs) {
  plans += 1;
  const dir = join(TMP, `hist${plans}`);
  mkdirSync(dir, { recursive: true });
  const entries = [];
  for (const r of runs) {
    entries.push({ run_id: r.id, folder: r.id, project: r.project, status: r.status || 'complete' });
    const folder = join(dir, r.id);
    mkdirSync(folder);
    writeFileSync(join(folder, 'p.lanes.json'), JSON.stringify({ prelude: [], join: [],
      lanes: [{ id: 'a', tasks: [{ id: 'A1' }, { id: 'B1' }] }] }));
    if (r.autopsy === 'missing') continue;
    if (r.autopsy === 'garbage') { writeFileSync(join(folder, 'autopsy.json'), '{not json'); continue; }
    const end = r.autopsy === 'no-agents' ? 60 : Math.max(r.a1, r.b1);
    const agents = r.autopsy === 'no-agents' ? undefined : [
      { task: 'A1', launch: 'wf_1', start: T(0), end: T(r.a1) },
      { task: 'B1', launch: 'wf_1', start: T(0), end: T(r.b1) },
    ];
    writeFileSync(join(folder, 'autopsy.json'), JSON.stringify({ time: { agents,
      phases: [{ phase: 'Lane a', launch: 'wf_1', start: T(0), end: T(end) }] } }));
  }
  writeFileSync(join(dir, 'index.json'), JSON.stringify({ version: 1, runs: entries }));
  return dir;
}

test('scale line from fixture history', () => {
  const h = history([
    { id: 'r1', project: '/x/proj', a1: 600, b1: 1200 },
    { id: 'r2', project: '/x/proj', a1: 300, b1: 300 },
    { id: 'r3', project: '/x/proj', a1: 9000, b1: 9000, status: 'stopped' },
    { id: 'r4', project: '/x/other', a1: 50, b1: 50 },
  ]);
  const r = run([plan(4), '--max-lanes', '2', '--lane', 'T1,T2', '--lane', 'T3,T4', '--project', '/x/proj',
    '--history-dir', h]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.json.scale, { runs: ['r1', 'r2'], task_s_mean: 600, task_s_min: 300, task_s_max: 900 });
  // Without --project there is no scale line.
  const n = run([plan(4), '--max-lanes', '2', '--lane', 'T1,T2', '--lane', 'T3,T4', '--history-dir', h]);
  assert.equal(n.json.scale, null);
});

test('scale line matches the project in any path form', () => {
  const h = history([{ id: 'w1', project: 'C:/Studio/Proj', a1: 100, b1: 100 }]);
  // The Git Bash form /c/x is a drive path only on Windows.
  const forms = ['C:/Studio/Proj', 'c:\\studio\\proj', 'C:/Studio/Proj/', 'Proj']
    .concat(process.platform === 'win32' ? ['/c/Studio/Proj', '/c/studio/proj/'] : []);
  for (const name of forms) {
    const r = run([plan(3), '--max-lanes', '2', '--lane', 'T1', '--lane', 'T2,T3', '--project', name, '--history-dir', h]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json.scale && r.json.scale.runs, ['w1'], name);
  }
});

test('scale line skips unreadable or incomplete autopsies', () => {
  const h = history([
    { id: 'm1', project: '/x/proj', autopsy: 'missing' },
    { id: 'g1', project: '/x/proj', autopsy: 'garbage' },
    { id: 'n1', project: '/x/proj', autopsy: 'no-agents' },
  ]);
  const r = run([plan(3), '--max-lanes', '2', '--lane', 'T1', '--lane', 'T2,T3', '--project', '/x/proj', '--history-dir', h]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.scale, null);
  assert.ok(r.json.notes.some((n) => /scale/.test(n)), JSON.stringify(r.json.notes));
  assert.deepEqual([r.json.saved, r.json.recommend], [1, 'direct']);
  const ok = history([{ id: 'k1', project: '/x/proj', a1: 60, b1: 60 }, { id: 'g2', project: '/x/proj', autopsy: 'garbage' }]);
  const s = run([plan(3), '--max-lanes', '2', '--lane', 'T1', '--lane', 'T2,T3', '--project', '/x/proj', '--history-dir', ok]);
  assert.deepEqual(s.json.scale.runs, ['k1']);
  // The note names every cause a run is skipped for, a run with no task agents included.
  assert.ok(s.json.notes.some((n) => n.includes('or no task agents')), JSON.stringify(s.json.notes));
});

test('a malformed archived run never changes the recommendation', () => {
  // Final review (1.6.4): an agent whose launch is a list, or a manifest whose lanes is a
  // number, raised TypeError through the scale line and made the whole result unavailable.
  const h = history([{ id: 'ok1', project: '/x/proj', a1: 60, b1: 60 },
    { id: 'bad1', project: '/x/proj', a1: 60, b1: 60 }, { id: 'bad2', project: '/x/proj', a1: 60, b1: 60 }]);
  const auto = join(h, 'bad1', 'autopsy.json');
  const a = JSON.parse(readFileSync(auto, 'utf8'));
  a.time.agents[0].launch = ['wf_1'];
  writeFileSync(auto, JSON.stringify(a));
  writeFileSync(join(h, 'bad2', 'p.lanes.json'), JSON.stringify({ prelude: [], join: [], lanes: 5 }));
  const r = run([plan(4), '--max-lanes', '2', '--lane', 'T1,T2', '--lane', 'T3,T4', '--project', '/x/proj', '--history-dir', h]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([r.json.status, r.json.saved, r.json.recommend], ['ok', 2, 'parallel']);
  assert.ok(r.json.scale.runs.includes('ok1'), JSON.stringify(r.json));
  assert.ok(!r.json.scale.runs.includes('bad2'), JSON.stringify(r.json));
});

test('no history dir is fine', () => {
  const r = run([plan(3), '--max-lanes', '2', '--lane', 'T1', '--lane', 'T2,T3', '--project', '/x/proj', '--history-dir', NOWHERE]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([r.json.status, r.json.scale], ['ok', null]);
  // An index that is not a run index leaves the scale line out, never the result.
  plans += 1;
  const bad = join(TMP, `hist${plans}`);
  mkdirSync(bad);
  writeFileSync(join(bad, 'index.json'), '[]');
  const b = run([plan(3), '--max-lanes', '2', '--lane', 'T1', '--lane', 'T2,T3', '--project', '/x/proj', '--history-dir', bad]);
  assert.deepEqual([b.status, b.json.status, b.json.scale], [0, 'ok', null]);
});

// ---- 1.6.5: the join counted in waves (--join-deps) ----

// T1-T3 one per lane, T4-T10 the join in d1a's shape: waves 1-2-4.
const D1A_DEPS = ['T4:', 'T5:T4', 'T6:T4+T5', 'T7:T4', 'T8:T4+T7', 'T9:T7', 'T10:T7'];
const d1aArgs = (p, deps = D1A_DEPS) => [p, '--max-lanes', '3', '--lane', 'T1', '--lane', 'T2', '--lane', 'T3',
  '--join', 'T4,T5,T6,T7,T8,T9,T10', ...deps.flatMap((d) => ['--join-deps', d]), '--history-dir', NOWHERE];

test('join waves count ceil(size / lanes)', () => {
  const r = run(d1aArgs(plan(10)));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.status, 'ok', JSON.stringify(r.json));
  // 1 (the lanes) + waves 1, 2, 4 at 3 at once: 1 + 1 + 2.
  assert.equal(r.json.slots, 5);
  assert.equal(r.json.saved, 5);
  assert.ok(r.json.notes.includes('join waves 1-2-4 (declared files not checked)'), JSON.stringify(r.json.notes));
});

test('no --join-deps keeps a serial join', () => {
  const r = run(d1aArgs(plan(10), []));
  assert.equal(r.json.slots, 8);
  assert.ok(!r.json.notes.some((n) => n.startsWith('join waves')));
});

test('--join-deps for an unknown id is unavailable', () => {
  const r = run(d1aArgs(plan(10), ['T4:', 'T99:T4']));
  assert.equal(r.status, 0);
  assert.equal(r.json.status, 'unavailable');
  assert.match(r.json.reason, /T99/);
});

test('slots takes join wave sizes', () => {
  assert.deepEqual(module(['print(json.dumps([W.slots(0, [1, 1, 1], 7, 3, [1, 2, 4]), W.slots(0, [1, 1, 1], 7, 3)]))']),
    [5, 8]);
});
