// scripts/autopsy and scripts/_autopsy.py: one archived run's analysis (what
// got done, where the time went, and the tokens), from the run folder alone.
// The fixture run1 is a small synthetic run folder; the tests copy it to a
// temp dir first, since autopsy writes autopsy.json into the folder.
//
// run1's timeline (2026-10-10, UTC), launch wf_1 from 07:00:00 to 07:10:00:
//   A1 implement  Lane a     07:00:05-07:03:00  Bash 07:00:10-07:00:40, Edit 07:00:50-07:01:02
//   B1 implement  Lane beta  07:01:00-07:04:00  Read 07:01:10-07:01:30, Grep 07:01:20-07:01:40
//   (no agent runs 07:04:00-07:04:40, a 40 s pause)
//   A1 review     Lane a     07:04:40-07:06:00  Read 07:04:50-07:04:51
//   (no agent runs 07:06:00-07:07:30, a 90 s gap)
//   verify        Verify     07:07:30-07:09:50  Bash 07:07:40-07:08:00

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { tempDir } from './platform.mjs';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const SCRIPT = join(SCRIPTS, 'autopsy');
const RUN1 = join(SKILL_DIR, 'tests', 'fixtures', 'autopsy', 'run1');
const TMP = tempDir('pl-autopsy-');
after(() => rmSync(TMP, { recursive: true, force: true }));

let copies = 0;
function copyRun() {
  copies += 1;
  const dir = join(TMP, `copy${copies}`);
  cpSync(RUN1, dir, { recursive: true });
  return dir;
}

function autopsy(dir) {
  const r = spawnSync('python3', [SCRIPT, dir], { encoding: 'utf8' });
  const out = join(dir, 'autopsy.json');
  const text = r.status === 0 && existsSync(out) ? readFileSync(out, 'utf8') : null;
  return { code: r.status, stderr: r.stderr, text, json: text === null ? null : JSON.parse(text) };
}

// Runs a Python snippet with scripts/ importable; returns its stdout as JSON.
function python(lines) {
  const code = [
    'import json, sys',
    'sys.dont_write_bytecode = True',
    `sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`,
    ...lines,
  ].join('\n');
  const r = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

function editLines(path, edit) {
  const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l !== '');
  writeFileSync(path, `${edit(lines).join('\n')}\n`);
}

const base = autopsy(copyRun());
const A = base.json;
const agentOf = (analysis, label) => analysis.time.agents.find((a) => a.label === label);
const T = (hms) => `2026-10-10T${hms}.000Z`;

test('done lists each task and the acceptance', () => {
  assert.equal(base.code, 0, base.stderr);
  assert.deepEqual(Object.keys(A), [
    'autopsy_version', 'inputs_fingerprint', 'run_id', 'engine_version', 'launches', 'done', 'time',
    'tokens', 'checks', 'slowdowns', 'detectors', 'suggestions', 'unexplained',
  ]);
  assert.equal(A.autopsy_version, 1);
  assert.equal(A.run_id, 'f1');
  assert.equal(A.engine_version, '1.5.0');
  assert.deepEqual(A.done.tasks, {
    A1: { status: 'done', commits: ['1'.repeat(40)], rounds: 1, tier_used: 'standard' },
    B1: { status: 'done', commits: ['2'.repeat(40), '3'.repeat(40)], rounds: 0, tier_used: 'standard' },
  });
  assert.deepEqual(A.done.acceptance, {
    status: 'unverified', reasons: [{ kind: 'checks_stale', class: 'missing' }], warnings: 1,
  });
  assert.deepEqual(A.done.final, { fixed: 1, declined: 0, open: 0 });
  assert.equal(A.done.e2e, 'pass');
  // Later tasks fill these.
  assert.deepEqual(
    [A.checks, A.slowdowns, A.detectors, A.suggestions, A.unexplained], [{}, [], {}, [], []],
  );
  // Free text from the result, prompts and tool output is never copied.
  for (const marker of ['NOTES-TEXT-1', 'REASON-DETAIL-1', 'WARNING-TEXT-1', 'FINDING-TEXT-1',
    'E2E-EVIDENCE-1', 'PROMPT-MARKER-1', 'TOOL-OUTPUT-1', 'Reading the brief']) {
    assert.ok(!base.text.includes(marker), `autopsy.json holds ${marker}`);
  }
});

test('phase and lane times come from agent timestamps', () => {
  assert.deepEqual(A.launches, [
    { wf: 'wf_1', start: T('07:00:00'), end: T('07:10:00'), wall_s: 600, status: 'complete' },
  ]);
  assert.equal(A.time.wall_s, 600);
  const phases = Object.fromEntries(A.time.phases.map((p) => [p.phase, p]));
  assert.deepEqual(Object.keys(phases), ['Lane a', 'Lane beta', 'Verify']);
  assert.deepEqual([phases['Lane a'].start, phases['Lane a'].end], [T('07:00:05'), T('07:06:00')]);
  assert.equal(phases['Lane a'].wall_s, 355);
  assert.equal(phases['Lane a'].agents, 2);
  assert.deepEqual([phases['Lane beta'].start, phases['Lane beta'].end], [T('07:01:00'), T('07:04:00')]);
  assert.equal(phases['Lane beta'].wall_s, 180);
  assert.equal(phases.Verify.wall_s, 140);
  assert.equal(phases.Verify.agents, 1);
  // Verify is a phase but not a lane; 'Lane beta' is lane b by its manifest name.
  const lanes = Object.fromEntries(A.time.lanes.map((l) => [l.lane, l]));
  assert.deepEqual(Object.keys(lanes), ['a', 'b']);
  assert.deepEqual([lanes.a.start, lanes.a.end, lanes.a.busy_s, lanes.a.idle_s],
    [T('07:00:05'), T('07:06:00'), 255, 100]);
  assert.deepEqual([lanes.b.start, lanes.b.end, lanes.b.busy_s, lanes.b.idle_s],
    [T('07:01:00'), T('07:04:00'), 180, 0]);
  const a1 = agentOf(A, 'A1 implement');
  assert.deepEqual([a1.phase, a1.task, a1.role, a1.start, a1.end, a1.wall_s],
    ['Lane a', 'A1', 'implement', T('07:00:05'), T('07:03:00'), 175]);
});

test('tool time is the union of overlapping calls', () => {
  const b1 = agentOf(A, 'B1 implement');
  assert.equal(b1.wall_s, 180);
  assert.equal(b1.tool_s, 30);
  assert.equal(b1.other_s, 150);
  assert.equal(agentOf(A, 'A1 implement').tool_s, 42);
  assert.equal(A.time.agents.length, 4);
  for (const a of A.time.agents) {
    assert.ok(a.other_s >= 0, `${a.label} has other_s ${a.other_s}`);
    assert.equal(Math.round((a.tool_s + a.other_s) * 10), Math.round(a.wall_s * 10));
  }
});

test('an idle gap over 60 s is found', () => {
  // The 40 s pause from 07:04:00 to 07:04:40 is not a gap.
  assert.deepEqual(A.time.idle_gaps, [{ start: T('07:06:00'), end: T('07:07:30'), s: 90 }]);
});

test('the critical path is an estimate ending with the last agent', () => {
  assert.equal(A.time.critical_path.estimate, true);
  assert.deepEqual(A.time.critical_path.labels, ['B1 implement', 'A1 review', 'verify']);
  assert.equal(A.time.critical_path.labels.at(-1), 'verify');
});

test('tokens match run-report', () => {
  const report = python([
    'import _transcripts',
    `with open(${JSON.stringify(join(RUN1, 'p.lanes.json'))}, encoding="utf-8") as f:`,
    '    manifest = json.load(f)',
    `print(json.dumps(_transcripts.build_report(${JSON.stringify(join(RUN1, 'wf_1'))}, manifest)))`,
  ]);
  assert.deepEqual(A.tokens.totals, report.totals);
  assert.equal(A.tokens.totals.agents, 4);
  assert.equal(A.tokens.partial, false);
  assert.equal(A.tokens.unreadable_lines, 0);
  for (const [tier, bucket] of Object.entries(report.tiers)) {
    const { escalations, fix_rounds: fixRounds, ...fields } = bucket;
    assert.deepEqual(A.tokens.by_tier[tier], fields);
  }
  assert.deepEqual(Object.keys(A.tokens.by_phase).sort(), ['Lane a', 'Lane beta', 'Verify']);
  assert.deepEqual(Object.keys(A.tokens.by_role).sort(), ['implement', 'review', 'verify']);
  assert.deepEqual(Object.keys(A.tokens.per_task).sort(), ['A1', 'B1']);
  assert.equal(A.tokens.per_task.A1.agents, 2);
  assert.equal(A.tokens.per_task.A1.input_tokens, 10 + 12 + 14 + 16 + 20 + 22 + 24);
  assert.equal(A.tokens.top_agents.length, 4);
  assert.equal(A.tokens.top_agents[0].label, 'B1 implement');
  assert.equal(A.tokens.top_agents[0].tokens, 50 + 60 + 70 + 80 + 300 + 30 + 20 + 20 + 40);
});

test('damaged and old runs report unavailable or partial, never zero', () => {
  const dir = copyRun();
  // B1 implement's lines lose their timestamps.
  editLines(join(dir, 'wf_1', 'agent-b1.jsonl'), (lines) => lines.map((l) => {
    const o = JSON.parse(l);
    delete o.timestamp;
    return JSON.stringify(o);
  }));
  // One A1 review line is cut short (a truncated write).
  editLines(join(dir, 'wf_1', 'agent-a2.jsonl'), (lines) => {
    lines[2] = lines[2].slice(0, 60);
    return lines;
  });
  rmSync(join(dir, 'wf_1.json'));
  const manifestPath = join(dir, 'p.lanes.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.plan = '/home/u/plans/p.md';
  Object.assign(manifest.repo, {
    root: '/home/u/proj', worktree_root: '/home/u/proj-wt', ledger_dir: '/home/u/plans/p.f1.ledger',
  });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const res = autopsy(dir);
  assert.equal(res.code, 0, res.stderr);
  const D = res.json;
  const b1 = agentOf(D, 'B1 implement');
  for (const key of ['start', 'end', 'wall_s', 'tool_s', 'other_s']) {
    assert.equal(b1[key], 'unavailable', `B1 implement ${key}`);
  }
  const beta = D.time.phases.find((p) => p.phase === 'Lane beta');
  assert.deepEqual([beta.start, beta.end, beta.wall_s, beta.agents], ['unavailable', 'unavailable', 'unavailable', 1]);
  const laneB = D.time.lanes.find((l) => l.lane === 'b');
  assert.deepEqual([laneB.busy_s, laneB.idle_s], ['unavailable', 'unavailable']);
  assert.ok(!D.time.critical_path.labels.includes('B1 implement'));
  assert.equal(agentOf(D, 'A1 review').wall_s, 80);
  assert.equal(D.tokens.partial, true);
  assert.equal(D.tokens.unreadable_lines, 1);
  assert.equal(D.tokens.totals.output_tokens, 'unavailable');
  assert.ok(D.tokens.totals.output_tokens_min > 0);
  assert.equal(D.done.acceptance, 'unavailable');
  assert.equal(D.done.tasks, 'unavailable');
  assert.equal(D.done.final, 'unavailable');
  assert.equal(D.done.e2e, 'unavailable');
  assert.equal(D.engine_version, 'unavailable');
  assert.equal(D.run_id, 'f1');
  // Without wf_1.json the launch is timed from its agents' first and last events.
  assert.deepEqual(D.launches, [
    { wf: 'wf_1', start: T('07:00:05'), end: T('07:09:50'), wall_s: 585, status: 'unavailable' },
  ]);
});

test('the fingerprint changes when an input changes', () => {
  const dir = copyRun();
  const first = autopsy(dir).json.inputs_fingerprint;
  assert.match(first, /^[0-9a-f]{64}$/);
  // autopsy.json now exists in the folder; it is not an input.
  assert.equal(autopsy(dir).json.inputs_fingerprint, first);
  const path = join(dir, 'wf_1', 'agent-a1.jsonl');
  writeFileSync(path, readFileSync(path, 'utf8').replace('"Done."', '"Done!"'));
  assert.notEqual(autopsy(dir).json.inputs_fingerprint, first);
  const ledger = join(dir, 'p.f1.ledger', '_run.jsonl');
  const second = autopsy(dir).json.inputs_fingerprint;
  writeFileSync(ledger, `${readFileSync(ledger, 'utf8')}{"event":"more"}\n`);
  assert.notEqual(autopsy(dir).json.inputs_fingerprint, second);
});

test('read_events gives timed events in file order and skips damaged lines', () => {
  const events = python([
    'import _autopsy',
    `print(json.dumps(_autopsy.read_events(${JSON.stringify(join(RUN1, 'wf_1', 'agent-b1.jsonl'))})))`,
  ]);
  assert.deepEqual(events.map((e) => [e.kind, e.name, e.id]), [
    ['assistant', null, null],
    ['tool_use', 'Read', 'tu_b1_1'],
    ['tool_use', 'Grep', 'tu_b1_2'],
    ['tool_result', 'Read', 'tu_b1_1'],
    ['tool_result', 'Grep', 'tu_b1_2'],
    ['assistant', null, null],
  ]);
  assert.deepEqual(events[1].input, { file_path: 'src/b.js' });
  assert.equal(events[0].ts, Date.parse(T('07:01:00')) / 1000);
  for (const e of events) {
    assert.deepEqual(Object.keys(e).sort(), ['id', 'input', 'is_error', 'kind', 'name', 'text', 'ts']);
  }
  const dir = join(TMP, 'damaged-events');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'agent-x.jsonl');
  const good = '{"type":"assistant","timestamp":"2026-10-10T07:00:00Z","message":{"content":[{"type":"text","text":"ok"}]}}';
  writeFileSync(path, Buffer.concat([
    Buffer.from(`${good}\n`),
    Buffer.from('{"type":"assistant","timestamp":"2026-10-10T07:00:01Z","message":{"content":"\xff"}}\n', 'latin1'),
    Buffer.from('{"type":"assistant","timest\n'),
    Buffer.from(`${good.replace('07:00:00', '07:00:02')}\n`),
  ]));
  const counted = python([
    'import _autopsy',
    `events, skipped = _autopsy.read_events_counted(${JSON.stringify(path)})`,
    'print(json.dumps([len(events), skipped, len(_autopsy.read_events(' + JSON.stringify(path) + '))]))',
  ]);
  assert.deepEqual(counted, [2, 2, 2]);
});

test('exit 2 without a manifest or a wf_ dir, and nothing written', () => {
  const empty = join(TMP, 'empty');
  mkdirSync(empty, { recursive: true });
  let r = spawnSync('python3', [SCRIPT, empty], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.ok(!existsSync(join(empty, 'autopsy.json')));
  const noWf = copyRun();
  rmSync(join(noWf, 'wf_1'), { recursive: true });
  r = spawnSync('python3', [SCRIPT, noWf], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.ok(!existsSync(join(noWf, 'autopsy.json')));
  r = spawnSync('python3', [SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});
