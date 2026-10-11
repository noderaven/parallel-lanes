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
//
// run2 holds one slowdown of each kind, over two launches:
//   wf_1 08:00:00-08:05:00 (stopped, then relaunched)
//     A1 implement  08:00:10-08:04:50, with 100 s and 180 s model turns
//   wf_2 09:00:00-09:21:30
//     A1 implement    09:00:05-09:12:10
//       Bash in the background 09:00:10, its ID b1 completes 09:01:40
//       a heredoc Bash fails 09:01:50-09:01:52
//       an Edit fails (file not read) 09:02:00-09:02:01; Read; Edit ok 09:02:20-09:02:22
//       the same curl command fails twice 09:02:30-09:02:35, 09:02:40-09:02:50
//       the test command runs twice with no edit between 09:03:00-09:03:30, 09:03:40-09:04:20
//       a Bash times out 09:04:30-09:06:30; a 130 s Bash 09:06:40-09:08:50
//       a 200 s model turn 09:08:50-09:12:10 that no detector covers
//     B1 implement    09:00:20-09:02:00 (sonnet), then again 09:02:10-09:05:00 (opus)
//     B1 review       09:05:10-09:05:30, then B1 review retry 09:05:40-09:06:40
//     A1 review       09:12:20-09:13:20
//     A1 fix 1        09:13:30-09:15:00; A1 re-review 1 09:15:10-09:16:00
//     (no agent runs 09:16:00-09:20:00, a 240 s gap)
//     verify          09:20:00-09:21:00
//
// run3 holds the check executions, in launch wf_1 from 10:00:00 to 10:12:30:
//   A1 implement  Lane a        10:00:05-10:05:00
//     the test command in the background 10:00:10, its ID bg7 completes 10:02:40
//     an Edit, then the test command again 10:03:10-10:03:55
//     (both command lines carry a PATH=... prefix)
//   B1 implement  Lane b        10:00:20-10:06:00  two Bash calls that are not checks
//   verify        Verify        10:06:30-10:09:00  run-checks with the test group 10:06:40-10:08:10
//   final fix     Final review  10:10:00-10:12:00  the test command 10:10:10-10:11:00
// The critical path is B1 implement, verify, final fix.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { tempDir } from './platform.mjs';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const SCRIPT = join(SCRIPTS, 'autopsy');
const RUN1 = join(SKILL_DIR, 'tests', 'fixtures', 'autopsy', 'run1');
const RUN2 = join(SKILL_DIR, 'tests', 'fixtures', 'autopsy', 'run2');
const RUN3 = join(SKILL_DIR, 'tests', 'fixtures', 'autopsy', 'run3');
const TMP = tempDir('pl-autopsy-');
after(() => rmSync(TMP, { recursive: true, force: true }));

let copies = 0;
function copyRun(src = RUN1) {
  copies += 1;
  const dir = join(TMP, `copy${copies}`);
  cpSync(src, dir, { recursive: true });
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
  assert.equal(A.autopsy_version, 3);
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
  // A1 implement and verify each run the test command once.
  assert.deepEqual(A.checks.executions.map((x) => [x.agent, x.check, x.certainty, x.s]),
    [['A1 implement', 'test#1', 'ran', 30], ['verify', 'test#1', 'ran', 20]]);
  assert.deepEqual(A.checks.full_suite_runs, { total: 2, inferred: 0, by_role: { implement: 1, verify: 1 } });
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
  // autopsy's buckets are run-report's plus agents_with_usage.
  const { agents_with_usage: withUsage, ...totals } = A.tokens.totals;
  assert.deepEqual(totals, report.totals);
  assert.equal(withUsage, 4);
  assert.equal(A.tokens.totals.agents, 4);
  assert.equal(A.tokens.partial, false);
  assert.equal(A.tokens.unreadable_lines, 0);
  for (const [tier, bucket] of Object.entries(report.tiers)) {
    const { escalations, fix_rounds: fixRounds, ...fields } = bucket;
    const { agents_with_usage: tierWithUsage, ...mine } = A.tokens.by_tier[tier];
    assert.deepEqual(mine, fields);
    assert.equal(tierWithUsage, fields.agents);
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
  // verify's lines lose their usage.
  editLines(join(dir, 'wf_1', 'agent-v1.jsonl'), (lines) => lines.map((l) => {
    const o = JSON.parse(l);
    if (o.message) delete o.message.usage;
    return JSON.stringify(o);
  }));
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
  for (const key of ['start', 'end', 'wall_s', 'tool_s', 'tool_s_min', 'other_s', 'unmatched_calls']) {
    assert.equal(b1[key], 'unavailable', `B1 implement ${key}`);
  }
  // A1 review's unreadable line may have held a call: its tool time is a minimum.
  const a2 = agentOf(D, 'A1 review');
  assert.deepEqual([a2.tool_s, a2.other_s], ['unavailable', 'unavailable']);
  assert.equal(typeof a2.tool_s_min, 'number');
  assert.equal(a2.unmatched_calls, 0);
  const md = readFileSync(join(dir, 'autopsy.md'), 'utf8');
  assert.ok(md.includes(`A1 review: tool time >= ${a2.tool_s_min.toFixed(1)} s; unreadable transcript lines`), md);
  for (const kind of TOOL_KINDS) assert.equal(D.detectors[kind], 'partial', kind);
  // verify has no usage: the totals count the three agents that have it, as minimums.
  assert.deepEqual([D.tokens.totals.agents, D.tokens.totals.agents_with_usage], [4, 3]);
  assert.ok(D.tokens.totals.input_tokens > 0);
  assert.equal(typeof D.tokens.totals.cache_creation_input_tokens, 'number');
  assert.deepEqual(D.tokens.by_phase.Verify, {
    input_tokens: 'unavailable', output_tokens: 'unavailable', cache_read_input_tokens: 'unavailable',
    cache_creation_input_tokens: 'unavailable', output_tokens_min: 'unavailable', agents: 1, agents_with_usage: 0,
  });
  assert.equal(D.tokens.by_phase['Lane a'].agents_with_usage, 2);
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
  // B1 implement may have run in what looks like a gap (its 07:01:00 to
  // 07:04:00 holds no other agent), so no gap is listed and the detector
  // has no data.
  assert.deepEqual(D.time.idle_gaps, []);
  assert.equal(D.detectors.idle_gap, 'not_available');
  assert.ok(!D.slowdowns.some((s) => s.kind === 'idle_gap'));
});

const dropResults = (lines, keep) => lines.filter((l) => {
  const o = JSON.parse(l);
  const content = o.message && Array.isArray(o.message.content) ? o.message.content : [];
  return !content.some((c) => c.type === 'tool_result' && !keep(c.tool_use_id));
});

test('lost tool results make an agent partial, not idle', () => {
  const dir = copyRun(RUN3);
  // A1 implement keeps its tool calls but loses every result, and a line is damaged.
  const path = join(dir, 'wf_1', 'agent-a1.jsonl');
  editLines(path, (lines) => [...dropResults(lines, () => false), '{not json']);
  const res = runCli(dir);
  assert.equal(res.code, 0, res.stderr);
  const D = JSON.parse(readFileSync(join(dir, 'autopsy.json'), 'utf8'));
  const a1 = agentOf(D, 'A1 implement');
  assert.deepEqual([a1.tool_s, a1.other_s], ['unavailable', 'unavailable']);
  assert.equal(typeof a1.tool_s_min, 'number');
  assert.ok(a1.unmatched_calls > 0, `unmatched_calls ${a1.unmatched_calls}`);
  for (const kind of TOOL_KINDS) assert.equal(D.detectors[kind], 'partial', kind);
  // B1 implement has all its results: its tool time is measured.
  const b1 = agentOf(D, 'B1 implement');
  assert.equal(typeof b1.tool_s, 'number');
  assert.equal(b1.unmatched_calls, 0);
  const time = res.md.split('## Where time went')[1].split('\n## ')[0];
  assert.ok(time.includes(`A1 implement: tool time >= ${a1.tool_s_min.toFixed(1)} s`), time);
  const slow = res.md.split('## Slowdowns')[1].split('\n## ')[0];
  assert.ok(slow.includes(`Detectors with partial data (they may miss slowdowns): ${TOOL_KINDS.join(', ')}.`), slow);
  assert.ok(!/Detectors without data/.test(slow), slow);
});

test('an agent stopped mid-call is the only partial one', () => {
  const dir = copyRun(RUN3);
  // A1 implement's last call (the test command at 10:03:10) has no result.
  editLines(join(dir, 'wf_1', 'agent-a1.jsonl'), (lines) => dropResults(lines, (id) => id !== 'tu_a1_4'));
  const res = autopsy(dir);
  assert.equal(res.code, 0, res.stderr);
  const D = res.json;
  const a1 = agentOf(D, 'A1 implement');
  assert.deepEqual([a1.tool_s, a1.other_s, a1.unmatched_calls], ['unavailable', 'unavailable', 1]);
  assert.equal(typeof a1.tool_s_min, 'number');
  for (const a of D.time.agents.filter((x) => x.label !== 'A1 implement')) {
    assert.equal(a.unmatched_calls, 0, a.label);
    assert.equal(typeof a.tool_s, 'number', a.label);
    assert.equal(typeof a.other_s, 'number', a.label);
  }
  for (const kind of TOOL_KINDS) assert.equal(D.detectors[kind], 'partial', kind);
  // A complete run is ok, and a timed agent with no calls has a measured zero.
  for (const kind of TOOL_KINDS) assert.equal(C.detectors[kind], 'ok', kind);
  assert.equal(agentOf(C, 'A1 implement').unmatched_calls, 0);
});

test('a timed agent with no calls has a measured zero tool time', () => {
  const dir = copyRun();
  // A1 review loses its one call and its result.
  editLines(join(dir, 'wf_1', 'agent-a2.jsonl'), (lines) => lines.filter((l) => !l.includes('tu_a2_1')));
  const res = autopsy(dir);
  assert.equal(res.code, 0, res.stderr);
  const a2 = agentOf(res.json, 'A1 review');
  assert.deepEqual([a2.tool_s, a2.tool_s_min, a2.other_s, a2.unmatched_calls], [0, 0, 80, 0]);
  for (const kind of TOOL_KINDS) assert.equal(res.json.detectors[kind], 'ok', kind);
});

test('a run without any usage has unavailable token totals', () => {
  const dir = copyRun();
  for (const name of readdirSync(join(dir, 'wf_1')).filter((n) => n.endsWith('.jsonl'))) {
    editLines(join(dir, 'wf_1', name), (lines) => lines.map((l) => {
      const o = JSON.parse(l);
      if (o.message) delete o.message.usage;
      return JSON.stringify(o);
    }));
  }
  const res = runCli(dir);
  assert.equal(res.code, 0, res.stderr);
  const D = JSON.parse(readFileSync(join(dir, 'autopsy.json'), 'utf8'));
  const tot = D.tokens.totals;
  assert.deepEqual([tot.input_tokens, tot.output_tokens_min, tot.agents_with_usage], ['unavailable', 'unavailable', 0]);
  for (const field of ['output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    assert.equal(tot[field], 'unavailable', field);
  }
  assert.equal(tot.agents, 4);
  for (const group of ['by_phase', 'by_role', 'by_tier', 'per_task']) {
    for (const [k, b] of Object.entries(D.tokens[group])) {
      assert.deepEqual([b.input_tokens, b.output_tokens_min, b.agents_with_usage], ['unavailable', 'unavailable', 0],
        `${group} ${k}`);
    }
  }
  assert.deepEqual(D.tokens.top_agents, []);
  const line = res.stdout.split('\n').find((l) => l.startsWith('tokens'));
  assert.match(line, /^tokens: unavailable/);
  assert.ok(!/\d/.test(line), line);
  const tokens = res.md.split('## Tokens')[1].split('\n## ')[0];
  assert.match(tokens, /Totals: unavailable \(no agent has usage data\)\./);
  assert.ok(!res.md.includes('>= 0'), tokens);
});

test('a phase with an untimed agent has no wall time', () => {
  const dir = copyRun();
  // A1 review's lines lose their timestamps; A1 implement is still timed.
  editLines(join(dir, 'wf_1', 'agent-a2.jsonl'), (lines) => lines.map((l) => {
    const o = JSON.parse(l);
    delete o.timestamp;
    return JSON.stringify(o);
  }));
  const res = autopsy(dir);
  assert.equal(res.code, 0, res.stderr);
  const laneA = res.json.time.phases.find((p) => p.phase === 'Lane a');
  assert.deepEqual([laneA.start, laneA.end, laneA.wall_s, laneA.agents],
    [T('07:00:05'), T('07:03:00'), 'unavailable', 2]);
  const lane = res.json.time.lanes.find((l) => l.lane === 'a');
  assert.deepEqual([lane.busy_s, lane.idle_s], ['unavailable', 'unavailable']);
});

test('an agent starts at its prompt line', () => {
  const dir = copyRun();
  // A1 implement's prompt comes 5 s before its first model turn.
  editLines(join(dir, 'wf_1', 'agent-a1.jsonl'), (lines) => {
    lines[0] = lines[0].replace(T('07:00:05'), T('07:00:00'));
    return lines;
  });
  const res = autopsy(dir);
  assert.equal(res.code, 0, res.stderr);
  const a1 = agentOf(res.json, 'A1 implement');
  assert.deepEqual([a1.start, a1.wall_s], [T('07:00:00'), 180]);
  assert.equal(res.json.time.phases.find((p) => p.phase === 'Lane a').wall_s, 360);
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

const KINDS = [
  'background_check', 'timeout', 'repeated_failure', 'heredoc_failure', 'edit_retry',
  'extra_review_round', 'escalation', 'retry', 'relaunch', 'long_tool_call', 'idle_gap', 'check_rerun',
];
const TOOL_KINDS = [
  'background_check', 'timeout', 'repeated_failure', 'heredoc_failure', 'edit_retry', 'long_tool_call',
  'check_rerun',
];
const run2 = autopsy(copyRun(RUN2));
const S = run2.json;

test('each detector finds its slowdown with its cost', () => {
  assert.equal(run2.code, 0, run2.stderr);
  assert.deepEqual(S.detectors, Object.fromEntries(KINDS.map((k) => [k, 'ok'])));
  const expected = {
    background_check: ['A1 implement', T('09:00:10'), 90, 'bound'],
    heredoc_failure: ['A1 implement', T('09:01:50'), 32, 'bound'],
    edit_retry: ['A1 implement', T('09:02:00'), 22, 'measured'],
    repeated_failure: ['A1 implement', T('09:02:30'), 20, 'measured'],
    check_rerun: ['A1 implement', T('09:03:40'), 40, 'measured'],
    timeout: ['A1 implement', T('09:04:30'), 120, 'measured'],
    long_tool_call: ['A1 implement', T('09:06:40'), 130, 'measured'],
    escalation: ['B1 implement', T('09:02:10'), 170, 'measured'],
    retry: ['B1 review retry', T('09:05:40'), 60, 'measured'],
    extra_review_round: ['A1 fix 1', T('09:13:30'), 140, 'measured'],
    relaunch: [null, T('08:00:00'), 300, 'measured'],
    idle_gap: [null, T('09:16:00'), 240, 'measured'],
  };
  assert.equal(S.slowdowns.length, KINDS.length);
  const byKind = {};
  for (const kind of KINDS) {
    const found = S.slowdowns.filter((s) => s.kind === kind);
    assert.equal(found.length, 1, `${kind}: ${JSON.stringify(found)}`);
    [byKind[kind]] = found;
    const s = byKind[kind];
    assert.deepEqual([s.agent, s.at, s.cost_s, s.cost_kind], expected[kind], kind);
  }
  // The largest cost comes first.
  const costs = S.slowdowns.map((s) => s.cost_s);
  assert.deepEqual(costs, [...costs].sort((x, y) => y - x));
  assert.deepEqual(byKind.background_check.evidence,
    { tool: 'Bash', exit: null, marker: 'Command running in background with ID', program: 'node' });
  assert.deepEqual(byKind.timeout.evidence,
    { tool: 'Bash', exit: null, marker: 'Command timed out after', program: 'npm' });
  assert.deepEqual(byKind.repeated_failure.evidence, { tool: 'Bash', exit: 6, marker: null, program: 'curl' });
  assert.deepEqual(byKind.heredoc_failure.evidence, { tool: 'Bash', exit: 2, marker: '<<', program: 'cat' });
  assert.deepEqual(byKind.edit_retry.evidence,
    { tool: 'Edit', exit: null, marker: 'has not been read yet', program: null });
  assert.deepEqual(byKind.idle_gap.evidence, { tool: null, exit: null, marker: null, program: null });
});

test('suggestions rank by time at stake', () => {
  const sugg = S.suggestions;
  assert.equal(sugg.length, KINDS.length);
  assert.deepEqual(sugg.map((g) => g.kind).sort(), [...KINDS].sort());
  assert.equal(sugg[0].kind, 'relaunch');
  assert.equal(sugg[0].stake_s, Math.max(...sugg.map((g) => g.stake_s)));
  const stakes = sugg.map((g) => g.stake_s);
  assert.deepEqual(stakes, [...stakes].sort((x, y) => y - x));
  for (const g of sugg) {
    assert.ok(g.text.length > 0, g.kind);
    assert.ok(g.slowdowns.length > 0, g.kind);
    assert.equal(g.count, g.slowdowns.length);
    for (const i of g.slowdowns) assert.equal(S.slowdowns[i].kind, g.kind);
    const sum = g.slowdowns.reduce((t, i) => t + S.slowdowns[i].cost_s, 0);
    assert.equal(g.stake_s, Math.round(sum * 10) / 10);
  }
});

test('unexplained lists the largest uncovered spans', () => {
  // The 200 s model turn no detector covers; the timeout, the long call, the
  // idle gap and the relaunched launch's long turns are covered.
  assert.deepEqual(S.unexplained, [
    { start: T('09:08:50'), end: T('09:12:10'), s: 200, agent: 'A1 implement' },
  ]);
  // run1 has no detector over its agents' long model turns.
  assert.deepEqual(A.unexplained, [
    { start: T('07:01:40'), end: T('07:04:00'), s: 140, agent: 'B1 implement' },
    { start: T('07:01:02'), end: T('07:03:00'), s: 118, agent: 'A1 implement' },
    { start: T('07:08:00'), end: T('07:09:50'), s: 110, agent: 'verify' },
    { start: T('07:04:51'), end: T('07:06:00'), s: 69, agent: 'A1 review' },
  ]);
});

test('a detector without data is not_available, not zero', () => {
  const dir = copyRun(RUN2);
  for (const wf of ['wf_1', 'wf_2']) {
    for (const name of readdirSync(join(dir, wf)).filter((n) => n.endsWith('.jsonl'))) {
      editLines(join(dir, wf, name), (lines) => lines.map((l) => {
        const o = JSON.parse(l);
        delete o.timestamp;
        return JSON.stringify(o);
      }));
    }
  }
  const res = autopsy(dir);
  assert.equal(res.code, 0, res.stderr);
  const D = res.json;
  for (const kind of [...TOOL_KINDS, 'idle_gap']) {
    assert.equal(D.detectors[kind], 'not_available', kind);
    assert.ok(!D.slowdowns.some((s) => s.kind === kind), `a ${kind} slowdown without data`);
    assert.ok(!D.suggestions.some((g) => g.kind === kind), `a ${kind} suggestion without data`);
  }
  for (const kind of ['extra_review_round', 'escalation', 'retry', 'relaunch']) {
    assert.equal(D.detectors[kind], 'ok', kind);
  }
  // The launch times still come from wf_1.json.
  const relaunch = D.slowdowns.find((s) => s.kind === 'relaunch');
  assert.equal(relaunch.cost_s, 300);
  // Agents without timestamps have no wall time to cost.
  const retry = D.slowdowns.find((s) => s.kind === 'retry');
  assert.deepEqual([retry.agent, retry.at, retry.cost_s], ['B1 review retry', 'unavailable', 'unavailable']);
  assert.equal(D.suggestions.find((g) => g.kind === 'retry').stake_s, 'unavailable');
  assert.deepEqual(D.unexplained, []);
});

test('evidence holds structured fields only', () => {
  const secrets = ['sk-test-123', 'user:pw', 'abc123', 'PROMPT-MARKER-7'];
  const transcript = readFileSync(join(RUN2, 'wf_2', 'agent-a1.jsonl'), 'utf8');
  for (const secret of secrets) {
    assert.ok(transcript.includes(secret), `the fixture lacks ${secret}`);
    assert.ok(!run2.text.includes(secret), `autopsy.json holds ${secret}`);
  }
  for (const marker of ['Authorization', 'example.com', 'TOOL-OUTPUT-7', 'task-notification']) {
    assert.ok(!run2.text.includes(marker), `autopsy.json holds ${marker}`);
  }
  for (const s of S.slowdowns) {
    assert.deepEqual(Object.keys(s.evidence).sort(), ['exit', 'marker', 'program', 'tool']);
  }
  const program = (command) => python([
    'import _autopsy',
    `print(json.dumps(_autopsy.program_of(${JSON.stringify(command)})))`,
  ]);
  assert.equal(program('API_KEY=abc123 PATH=/x env node a.js'), 'node');
  assert.equal(program('"C:/Program Files/nodejs/node.exe" a.js'), 'node.exe');
  assert.equal(program('user:pw@host ls'), null);
  assert.equal(program('A=1 B=2'), null);
  // The program is the first one the line runs: not cd DIR, not a loop
  // header, and not a heredoc body line.
  assert.equal(program("cd '/w/lane-a' && API_KEY=x node a.js"), 'node');
  assert.equal(program('cd /w; for f in a b; do pytest $f; done'), 'pytest');
  assert.equal(program("cd /w && cat > f <<'EOF'\ncurl x\nEOF"), 'cat');
  assert.equal(program('cd /w'), null);
  assert.equal(program('export PATH=/x:$PATH; timeout 600 npm test'), 'npm');
});

// ---- detector cases on synthetic events (tool_slowdowns) ----

// Events of one agent, labelled X: use() is a tool call, res() its result;
// times are seconds.
const use = (ts, id, name, input) => ({ ts, kind: 'tool_use', name, id, is_error: false, text: '', input });
const res = (ts, id, name, text, isError = false) => (
  { ts, kind: 'tool_result', name, id, is_error: isError, text, input: null });
function detect(events, notes = [], notices = []) {
  return python([
    'import _autopsy',
    `agent = {"entry": {"label": "X"}, "events": json.loads(${JSON.stringify(JSON.stringify(events))}),`
      + ` "notes": json.loads(${JSON.stringify(JSON.stringify(notes))}),`
      + ` "notices": json.loads(${JSON.stringify(JSON.stringify(notices))})}`,
    '_autopsy.span_agent(agent)',
    'found = _autopsy.tool_slowdowns(agent, _autopsy.configured_checks({"commands": {"test": ["npm test"]}}))',
    'calls = _autopsy._calls(agent)',
    'print(json.dumps({"slowdowns": [_autopsy.public_slowdown(s) for s in found],',
    '                  "suggestions": _autopsy.suggestions_section(found, None),',
    '                  "ends": [list(_autopsy._execution_end(agent, c)) for c in calls],',
    '                  "completions": [_autopsy._completion_after(agent, c) for c in calls]}))',
  ]);
}
const at = (ts) => new Date(ts * 1000).toISOString();
const brief = (out) => out.slowdowns.map((s) => [s.kind, s.at, s.cost_s, s.cost_kind, s.evidence.marker]);

test('timeouts and background runs come only from Claude Code notices on Bash results', () => {
  const moved = 'Command did not complete within its 600s timeout and was moved to the background '
    + '(ID: b14yf1jq4). Output is being written to: /tmp/x/b14yf1jq4.output';
  const events = [
    // A file read and a passing test run that only mention the words.
    use(0, 'r1', 'Read', { file_path: 'src/api.js' }),
    res(1, 'r1', 'Read', '12  return [504, "Timed out"];\n13  // Command running in background with ID: zz'),
    use(10, 'g1', 'Grep', { pattern: 'timed out' }),
    res(11, 'g1', 'Grep', "src/a.js: throw new Error('timed out')"),
    use(20, 'b1', 'Bash', { command: 'npm test' }),
    res(25, 'b1', 'Bash', 'Error: Test timed out in 5000ms\n 1 failed, 9 passed'),
    // A real timeout: moved to the background, then read back with BashOutput.
    use(100, 'b2', 'Bash', { command: 'cd /w && npm run e2e' }),
    res(700, 'b2', 'Bash', moved),
    use(760, 'o1', 'BashOutput', { bash_id: 'b14yf1jq4' }),
    res(761, 'o1', 'BashOutput', 'done'),
  ];
  // A poll that shows no status says nothing about the end.
  let out = detect(events);
  assert.deepEqual(brief(out), [
    ['timeout', at(100), 600, 'measured', 'Command did not complete within its'],
    ['background_check', at(700), 'unavailable', 'unavailable', 'was moved to the background'],
  ]);
  assert.equal(out.slowdowns[0].evidence.program, 'npm');
  assert.deepEqual(out.ends[3], [true, null, 'unavailable']);
  assert.deepEqual(out.ends[2], [false, 25, 'measured']);
  // Claude Code's completion notice ends it, as an upper bound.
  out = detect(events, [], [{ ts: 900, task_id: 'b14yf1jq4', status: 'completed' }]);
  assert.deepEqual(out.ends[3], [true, 900, 'bound']);
  assert.deepEqual(brief(out), [
    ['timeout', at(100), 600, 'measured', 'Command did not complete within its'],
    ['background_check', at(700), 200, 'bound', 'was moved to the background'],
  ]);
});

// A test run sent to the background as bx1.
const bxRun = [
  use(0, 'b1', 'Bash', { command: 'npm test', run_in_background: true }),
  res(1, 'b1', 'Bash', 'Command running in background with ID: bx1'),
];
const bxNotice = '<task-notification>\n<task-id>bx1</task-id>\n<status>completed</status>\n'
  + '<summary>Background command "tests" completed (exit code 0)</summary>\n</task-notification>';

test('a poll that says running does not end a background run', () => {
  const polled = [...bxRun,
    use(10, 'o1', 'BashOutput', { bash_id: 'bx1' }),
    res(11, 'o1', 'BashOutput', '<status>running</status>\n<stdout>1 passed</stdout>')];
  const notices = [{ ts: 130, task_id: 'bx1', status: 'completed' }];
  let out = detect(polled, [], notices);
  assert.deepEqual(out.ends[0], [true, 130, 'bound']);
  assert.deepEqual(out.completions[0], [130, 'completed']);
  assert.deepEqual(brief(out), [['background_check', at(0), 130, 'bound', 'Command running in background with ID']]);
  // A poll whose result says completed ends it first.
  out = detect([...polled,
    use(60, 'o2', 'TaskOutput', { task_id: 'bx1' }),
    res(60, 'o2', 'TaskOutput', '<status>completed</status>\n<exit_code>0</exit_code>')], [], notices);
  assert.deepEqual(out.ends[0], [true, 60, 'bound']);
  assert.deepEqual(out.completions[0], [60, 'completed']);
  // A running poll whose output prints a status tag does not end it.
  out = detect([...polled,
    use(60, 'o2', 'BashOutput', { bash_id: 'bx1' }),
    res(60, 'o2', 'BashOutput', '<status>running</status>\n<stdout>fixture: <status>completed</status></stdout>')],
  [], notices);
  assert.deepEqual(out.ends[0], [true, 130, 'bound']);
  assert.deepEqual(out.completions[0], [130, 'completed']);
});

test('notification text read from a file is not a completion', () => {
  const out = detect([...bxRun,
    use(49, 'r1', 'Read', { file_path: 'notes.txt' }),
    res(50, 'r1', 'Read', bxNotice)], [{ ts: 55, text: bxNotice }]);
  assert.deepEqual(out.ends[0], [true, null, 'unavailable']);
  assert.equal(out.completions[0], null);
});

test('a TaskStop ends a background run as stopped', () => {
  const out = detect([...bxRun,
    use(40, 'k1', 'TaskStop', { task_id: 'bx1' }),
    res(41, 'k1', 'TaskStop', 'Successfully stopped task: bx1')]);
  assert.deepEqual(out.ends[0], [true, 41, 'bound']);
  assert.deepEqual(out.completions[0], [41, 'stopped']);
  // A stop that failed ends nothing.
  const failed = detect([...bxRun,
    use(40, 'k1', 'KillShell', { shell_id: 'bx1' }),
    res(41, 'k1', 'KillShell', '<tool_use_error>No shell found</tool_use_error>', true)]);
  assert.deepEqual(failed.ends[0], [true, null, 'unavailable']);
});

test('a call without a result has no end', () => {
  const out = detect([use(0, 'b1', 'Bash', { command: 'npm test' })]);
  assert.deepEqual(out.ends[0], [false, null, 'unavailable']);
});

test('a heredoc failure is a failing file write, ended by the next write that works', () => {
  const out = detect([
    // A failing inline script is not a quoting failure.
    use(0, 'p1', 'Bash', { command: "cd /w && python3 - <<'EOF'\nassert False\nEOF" }),
    res(2, 'p1', 'Bash', 'Exit code 1\nAssertionError', true),
    use(10, 'h1', 'Bash', { command: "cat > a.txt <<'EOF'\nit's\nEOF" }),
    res(12, 'h1', 'Bash', 'Exit code 2\nunexpected EOF', true),
    // A corrected Bash write ends the span, not the later Edit.
    use(20, 'h2', 'Bash', { command: "cat > a.txt <<'EOF'\nfixed\nEOF" }),
    res(21, 'h2', 'Bash', ''),
    use(300, 'e1', 'Edit', { file_path: 'a.txt' }),
    res(301, 'e1', 'Edit', 'The file a.txt has been updated.'),
    // Output that names an exit code is not a failure.
    use(400, 'm1', 'Bash', { command: 'make' }),
    res(401, 'm1', 'Bash', 'ok\nProcess finished with exit code 1'),
    use(402, 'm2', 'Bash', { command: 'make' }),
    res(403, 'm2', 'Bash', 'ok\nProcess finished with exit code 1'),
  ]);
  assert.deepEqual(brief(out), [['heredoc_failure', at(10), 11, 'bound', '<<']]);
  assert.equal(out.slowdowns[0].evidence.exit, 2);
});

test('a failure after a successful heredoc write is not a heredoc failure', () => {
  for (const [command, text] of [
    ["cat > /tmp/p.py <<'EOF'\nprint(\"x\")\nEOF\npython3 /tmp/p.py", "Exit code 1\nUnicodeEncodeError: 'charmap' codec"],
    ["cat > /tmp/a.txt <<'EOF'\nx\nEOF\nbash -c 'if'", 'Exit code 2\nbash: -c: line 1: syntax error: unexpected end of file'],
    // An inline script that redirects its output is not the write.
    ["python3 - <<'EOF' > out.json\nraise SystemExit(1)\nEOF", 'Exit code 1'],
    ["node - <<'EOF' >> log.txt\nprocess.exit(1)\nEOF", 'Exit code 1'],
    ["cat <<'EOF' | python3 > out.json\nraise SystemExit(1)\nEOF", 'Exit code 1'],
  ]) {
    const out = detect([use(0, 'h1', 'Bash', { command }), res(2, 'h1', 'Bash', text, true)]);
    assert.deepEqual(brief(out), [], command);
  }
  // A heredoc write after cd DIR and assignments is still only the write.
  const out = detect([use(0, 'h1', 'Bash', { command: "cd /w && A=1 && cat > a.txt <<'EOF'\nit's\nEOF" }),
    res(2, 'h1', 'Bash', 'Exit code 2\nunexpected EOF', true)]);
  assert.deepEqual(brief(out), [['heredoc_failure', at(0), 2, 'measured', '<<']]);
});

test('a rerun needs proof that nothing changed', () => {
  const bash = (ts, id, command, text = 'ok', isError = false) => [
    use(ts, id, 'Bash', { command }), res(ts + 5, id, 'Bash', text, isError)];
  const reruns = (events) => brief(detect(events)).filter((s) => s[0] === 'check_rerun');
  const around = (...middle) => [...bash(0, 't1', 'npm test'), ...middle, ...bash(100, 't2', 'npm test')];
  // Not reported: something may have changed in between, or a run may not
  // have happened.
  assert.deepEqual(reruns([...bash(0, 't1', 'npm test', 'Exit code 1\n1 failed', true),
    ...bash(20, 'w1', 'printf fixed > src.js'), ...bash(100, 't2', 'npm test')]), []);
  for (const command of ['python fix.py', 'find . -type f -delete', 'find . -type f -exec python fix.py {} +',
    'cat $(python fix.py)', 'git diff --output=p.txt', 'git diff', 'git status']) {
    assert.deepEqual(reruns(around(...bash(20, 'm1', command))), [], command);
  }
  assert.deepEqual(reruns([...bash(0, 't1', 'false && npm test', 'Exit code 1', true),
    ...bash(100, 't2', 'false && npm test', 'Exit code 1', true)]), []);
  // Reported: only reads in between.
  assert.deepEqual(reruns(around(use(20, 'r1', 'Read', { file_path: 'README.md' }), res(21, 'r1', 'Read', 'x'),
    ...bash(30, 'c1', 'cat README.md'))), [['check_rerun', at(100), 5, 'measured', null]]);
  assert.deepEqual(reruns(around(...bash(20, 'e1', 'echo "npm test"'))),
    [['check_rerun', at(100), 5, 'measured', null]]);
});

test('slowdowns that overlap in time are counted once in the stake', () => {
  // Three Edits sent together while a long Bash call runs; all three fail
  // as unread when the Bash call returns.
  const events = [use(0, 'b1', 'Bash', { command: 'npm run build' })];
  for (const f of ['a', 'b', 'c']) events.push(use(0, `e${f}`, 'Edit', { file_path: `${f}.js` }));
  for (const f of ['a', 'b', 'c']) {
    events.push(res(124, `e${f}`, 'Edit', '<tool_use_error>File has not been read yet.</tool_use_error>', true));
  }
  events.push(res(126, 'b1', 'Bash', 'built'));
  const out = detect(events);
  const retries = out.slowdowns.filter((s) => s.kind === 'edit_retry');
  assert.deepEqual(retries.map((s) => s.cost_s), [124, 124, 124]);
  const g = out.suggestions.find((s) => s.kind === 'edit_retry');
  assert.deepEqual([g.count, g.stake_s], [3, 124]);
  assert.equal(out.suggestions.find((s) => s.kind === 'long_tool_call').stake_s, 126);
});

test('unclean checks are explained without suggesting to ignore source', () => {
  assert.ok(!A.suggestions.some((g) => g.kind === 'unclean_checks'));
  const dir = copyRun();
  const wfPath = join(dir, 'wf_1.json');
  const wf = JSON.parse(readFileSync(wfPath, 'utf8'));
  wf.result.acceptance.reasons = [{ kind: 'checks_unclean', class: 'missing', detail: 'REASON-DETAIL-2' }];
  writeFileSync(wfPath, JSON.stringify(wf, null, 2));
  mkdirSync(join(dir, 'p.f1.ledger', 'checks'));
  writeFileSync(join(dir, 'p.f1.ledger', 'checks', `verify-${'3'.repeat(40)}.json`), JSON.stringify({
    head: '3'.repeat(40), results: [{ group: 'test', command: 'node tests/run-tests.mjs', exit: 0 }],
    ok: true, clean: false, tracked_before: [], tracked_after: [],
    untracked_before: ['?? coverage/out.json'], untracked_after: ['?? coverage/out.json'],
  }));
  const res = autopsy(dir);
  assert.equal(res.code, 0, res.stderr);
  const g = res.json.suggestions.find((s) => s.kind === 'unclean_checks');
  assert.ok(g, JSON.stringify(res.json.suggestions));
  assert.deepEqual([g.stake_s, g.count, g.slowdowns], [0, 0, []]);
  assert.match(g.text, /coverage\/out\.json/);
  assert.ok(!g.text.includes('??'));
  assert.match(g.text, /commit any file a check needs/i);
  assert.match(g.text, /only known generated output/i);
  assert.match(g.text, /never ignore a file a check reads/i);
  assert.doesNotMatch(g.text, /ignore (all|every|these|them|the listed|the files|coverage)/i);
  assert.ok(!res.text.includes('REASON-DETAIL-2'));
});

const run3 = autopsy(copyRun(RUN3));
const C = run3.json;
const TEST_CMD = 'node tests/run-tests.mjs';
const run3Manifest = JSON.parse(readFileSync(join(RUN3, 'p.lanes.json'), 'utf8'));
const chainedManifest = {
  commands: { test: ['npm test'], lint: ['npm run lint'] },
  lane_commands: { a: { test: ['npm test -- a'] } },
};
// match_check's dict for a command line under a manifest, given the call's
// exit code (0 by default).
const matcher = (manifest) => (command, exit = 0) => python([
  'import _autopsy',
  `checks = _autopsy.configured_checks(json.loads(${JSON.stringify(JSON.stringify(manifest))}))`,
  `print(json.dumps(_autopsy.match_check(${JSON.stringify(command)}, checks, ${JSON.stringify(exit)})))`,
]);
const match = matcher(run3Manifest);
const chained = matcher(chainedManifest);
const R = (check, full_suite = null, certainty = 'ran') => ({ check, certainty, full_suite });

test('every check execution is listed with its duration', () => {
  assert.equal(run3.code, 0, run3.stderr);
  const ex = C.checks.executions;
  assert.equal(ex.length, 4);
  for (const x of ex) {
    assert.deepEqual(Object.keys(x), ['agent', 'phase', 'role', 'check', 'certainty', 'full_suite', 'start', 'end',
      's', 'timing', 'background', 'on_critical_path']);
  }
  // The background run is timed to Claude Code's completion notice, an
  // upper bound on its end.
  assert.deepEqual(ex.map((x) => [x.agent, x.phase, x.role, x.check, x.certainty, x.full_suite, x.start, x.end, x.s,
    x.timing, x.background]), [
    ['A1 implement', 'Lane a', 'implement', 'test#1', 'ran', 'ran', T('10:00:10'), T('10:02:40'), 150, 'bound',
      true],
    ['A1 implement', 'Lane a', 'implement', 'test#1', 'ran', 'ran', T('10:03:10'), T('10:03:55'), 45, 'measured',
      false],
    ['verify', 'Verify', 'verify', 'run-checks', 'ran', 'ran', T('10:06:40'), T('10:08:10'), 90, 'measured', false],
    ['final fix', 'Final review', 'final fix', 'test#1', 'ran', 'ran', T('10:10:10'), T('10:11:00'), 50, 'measured',
      false],
  ]);
  assert.equal(C.checks.by_command, undefined);
  assert.deepEqual(C.checks.by_check, {
    'test#1': { runs: 3, inferred: 0, untimed: 0, total_s: 245 },
    'run-checks': { runs: 1, inferred: 0, untimed: 0, total_s: 90 },
  });
  // Without the completion notice the background run has no end.
  const dir = copyRun(RUN3);
  editLines(join(dir, 'wf_1', 'agent-a1.jsonl'), (lines) => lines.filter((l) => !l.includes('task-notification')));
  const res = autopsy(dir);
  assert.equal(res.code, 0, res.stderr);
  const bg = res.json.checks.executions[0];
  assert.deepEqual([bg.background, bg.start, bg.end, bg.s, bg.timing],
    [true, T('10:00:10'), 'unavailable', 'unavailable', 'unavailable']);
  assert.deepEqual(res.json.checks.by_check['test#1'], { runs: 3, inferred: 0, untimed: 1, total_s: 95 });
  assert.match(runCli(dir).md, /^\| test#1 \| 3 \| 0 \| 95\.0 s \(\+1 untimed\) \|$/m);
});

test('full-suite runs are counted per role', () => {
  assert.deepEqual(C.checks.full_suite_runs,
    { total: 4, inferred: 0, by_role: { implement: 2, verify: 1, 'final fix': 1 } });
  // run-checks without the test group is an execution but not a full-suite run.
  const dir = copyRun(RUN3);
  const path = join(dir, 'wf_1', 'agent-v1.jsonl');
  const text = readFileSync(path, 'utf8');
  assert.ok(text.includes(`--cmd 'test' '${TEST_CMD}' `));
  writeFileSync(path, text.replace(`--cmd 'test' '${TEST_CMD}' `, ''));
  const res = autopsy(dir);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.json.checks.executions.length, 4);
  assert.deepEqual(res.json.checks.full_suite_runs,
    { total: 3, inferred: 0, by_role: { implement: 2, 'final fix': 1 } });
  assert.equal(res.json.checks.executions[2].full_suite, null);
});

test('critical-path executions are marked', () => {
  assert.deepEqual(C.time.critical_path.labels, ['B1 implement', 'verify', 'final fix']);
  const verify = C.checks.executions.find((x) => x.agent === 'verify');
  assert.equal(verify.on_critical_path, true);
  assert.deepEqual(C.checks.executions.map((x) => x.on_critical_path), [false, false, true, true]);
});

test('a check command never appears in raw form', () => {
  const transcript = readFileSync(join(RUN3, 'wf_1', 'agent-a1.jsonl'), 'utf8');
  assert.ok(transcript.includes('PATH=\\"/opt/PATH-SECRET-9/bin:$PATH\\" node tests/run-tests.mjs'));
  for (const raw of ['PATH-SECRET-9', 'PATH=', '/w/lane-a', '/w/proj', '--cmd', '/skill/scripts', 'tail -5',
    'run-checks.test.mjs', 'git log']) {
    assert.ok(!run3.text.includes(raw), `autopsy.json holds ${raw}`);
  }
  for (const x of C.checks.executions) assert.ok(['test#1', 'run-checks'].includes(x.check), x.check);
  // Checks are named by id: <group>#<n> for commands.<group>[n - 1], and
  // <lane>.<group>#<n> for a lane_commands override.
  assert.deepEqual(python([
    'import _autopsy',
    `print(json.dumps(_autopsy.configured_checks(json.loads(${JSON.stringify(JSON.stringify(run3Manifest))}))))`,
  ]), [['test#1', TEST_CMD, true], ['lint#1', 'eslint .', false], ['b.test#1', `${TEST_CMD} --only b`, false]]);
  // The configured command with the most words names the execution; a file
  // named like run-checks is not a run-checks call.
  assert.deepEqual(match('cd /w && node tests/run-tests.mjs --only b'), R('b.test#1'));
  assert.deepEqual(match('npx  eslint  .'), R('lint#1'));
  assert.deepEqual(match('node tests/run-tests.mjs'), R('test#1', 'ran'));
  assert.deepEqual(match('python3 scripts/run-checks . --cmd lint "eslint ."'), R('run-checks'));
  assert.deepEqual(match("py C:\\skill\\scripts\\run-checks C:\\w --cmd 'test' 'npm test'"), R('run-checks', 'ran'));
  assert.equal(match('node --test tests/run-checks.test.mjs'), null);
  // run-checks counts only in command position: as the program, or as the
  // script an interpreter runs, in any simple command of the line.
  assert.equal(match('git diff scripts/run-checks'), null);
  assert.equal(match('cat scripts/run-checks && grep -n cmd scripts/run-checks'), null);
  assert.equal(match('echo "python3 scripts/run-checks --cmd test x"'), null);
  assert.deepEqual(match("cd /w && PATH=/x:$PATH 'C:/py/python.exe' -X utf8 -B 'C:/s/run-checks' /w --cmd test t"),
    R('run-checks', 'ran'));
  assert.deepEqual(match('git status; ./scripts/run-checks . --cmd lint l'), R('run-checks'));
  assert.deepEqual(match('bash C:\\s\\run-checks C:\\w --cmd test t | tail -1'), R('run-checks', 'ran'));
  // A '#' inside a word starts no comment; a word that starts with '#' does.
  assert.deepEqual(match('curl http://x/#a && python3 scripts/run-checks . --cmd test t'), R('run-checks', 'ran'));
  assert.equal(match('echo hi # python3 scripts/run-checks . --cmd test t'), null);
  // Any run-checks command of the line with the test group counts, and
  // timeout DURATION is a prefix.
  assert.deepEqual(match('python3 scripts/run-checks . --cmd lint l && python3 scripts/run-checks . --cmd test t'),
    R('run-checks', 'ran'));
  assert.deepEqual(match('timeout 600 python3 scripts/run-checks . --cmd test t'), R('run-checks', 'ran'));
  assert.deepEqual(match('timeout -k 5 600 scripts/run-checks . --cmd lint l'), R('run-checks'));
  // A full-suite run counts wherever the test command sits in the line, even
  // when a longer configured command names the execution; a lane override
  // that only starts with it does not.
  assert.deepEqual(chained('npm run lint && npm test'), R('lint#1', 'ran'));
  assert.deepEqual(chained('npm run lint'), R('lint#1'));
  assert.deepEqual(chained('npm test -- a'), R('a.test#1'));
  assert.deepEqual(chained('npm test -- a && npm test'), R('a.test#1', 'ran'));
  assert.deepEqual(chained('npm run lint && npm test -- a'), R('a.test#1'));
});

test('text that only mentions a check is not an execution', () => {
  for (const command of ['echo "npm test"', 'grep "npm test" README.md', "cat > f.sh <<'EOF'\nnpm test\nEOF",
    'bash -c "npm test"', 'python3 -c "import subprocess; subprocess.run(\'npm test\')"']) {
    assert.equal(chained(command), null, command);
  }
  assert.deepEqual(chained('npm test -- --grep one'), R('test#1'));
  assert.deepEqual(chained('npm test 2>&1 | tail -5'), R('test#1', 'ran'));
});

test('a check that may not have run is inferred', () => {
  assert.deepEqual(chained('false && npm test', 1), R('test#1', 'inferred', 'inferred'));
  assert.equal(chained('if [ -f x ]; then npm test; fi').certainty, 'inferred');
  assert.deepEqual(chained('npm run lint || npm test'), R('lint#1', 'inferred'));
  assert.equal(chained('npm run lint && npm test', 1).full_suite, 'inferred');
  assert.equal(chained('npm run lint && npm test', 0).full_suite, 'ran');
  assert.deepEqual(chained('cd /w && npm test', 0), R('test#1', 'ran'));
  assert.deepEqual(chained('cd /w && npm test', 1), R('test#1', 'inferred', 'inferred'));
  assert.equal(chained('cd /nonexistent-directory && npm test', 1).certainty, 'inferred');
  // The ; breaks the proven chain.
  assert.equal(chained('false && npm test; true', 0).certainty, 'inferred');
  // An unconditional check ran, whatever the line's exit code.
  assert.deepEqual(chained('npm run lint; npm test', 1), R('lint#1', 'ran'));
  // An & inside a redirection is no separator; a background & still breaks
  // the proven chain.
  assert.deepEqual(chained('cd /w && npm test 2>&1 | tail -5', 0), R('test#1', 'ran'));
  assert.deepEqual(chained('cd /w && npm test 2>&1 | tail -5', 1), R('test#1', 'inferred', 'inferred'));
  assert.deepEqual(chained('cd /w && npm test &> out.log', 0), R('test#1', 'ran'));
  assert.deepEqual(chained('cd /w && npm test & true', 0), R('test#1', 'inferred', 'inferred'));
  // As in the shell, a backslash-newline joins lines and a newline after &&
  // separates nothing.
  assert.deepEqual(chained('cd /w && \\\n  npm test', 0), R('test#1', 'ran'));
  assert.deepEqual(chained('cd /w &&\n  npm test', 0), R('test#1', 'ran'));
  assert.deepEqual(chained('npm test \\\n  -- --grep one', 0), R('test#1'));
  // Through a run: a full-suite run that may not have happened is inferred.
  const dir = copyRun(RUN3);
  editLines(join(dir, 'wf_1', 'agent-a1.jsonl'), (lines) => lines.map((l) => {
    const o = JSON.parse(l);
    const block = o.message && Array.isArray(o.message.content) ? o.message.content[0] : null;
    if (block && block.id === 'tu_a1_4') block.input.command = `false && ${TEST_CMD}`;
    if (block && block.tool_use_id === 'tu_a1_4') {
      block.content = 'Exit code 1\nTOOL-OUTPUT-9';
      block.is_error = true;
    }
    return JSON.stringify(o);
  }));
  const res = autopsy(dir);
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(res.json.checks.full_suite_runs,
    { total: 3, inferred: 1, by_role: { implement: 1, verify: 1, 'final fix': 1 } });
  const x = res.json.checks.executions[1];
  assert.deepEqual([x.start, x.check, x.certainty, x.full_suite], [T('10:03:10'), 'test#1', 'inferred', 'inferred']);
  assert.deepEqual(res.json.checks.by_check['test#1'], { runs: 2, inferred: 1, untimed: 0, total_s: 200 });
  const md = runCli(dir).md;
  assert.match(md, /^\| test#1 \| 2 \| 1 \| 200\.0 s \|$/m);
  assert.match(md, /^Full-suite runs: 3 \(\+1 inferred\)$/m);
});

test('the r150 parser probes are not check runs', () => {
  assert.equal(chained("cd '/w' && cat > \"/tmp/t5.py\" <<'EOF'\nfor cmd in ['python3 scripts/run-checks . --cmd lint l\\npython3 scripts/run-checks . --cmd test t']:\n    print(cmd)\nEOF\n'C:/py/python.exe' \"/tmp/t5.py\""), null);
  assert.equal(chained("cd '/w' && python -c \"\nimport _autopsy as A\nprint(A.match_check('curl http://x/#a && python3 scripts/run-checks . --cmd test t', []))\n\""), null);
});

test('configured commands with secrets never reach the outputs', () => {
  const dir = copyRun(RUN3);
  const path = join(dir, 'p.lanes.json');
  const m = JSON.parse(readFileSync(path, 'utf8'));
  m.commands.test = [`API_TOKEN=CANARY-PRIVATE-150 ${TEST_CMD}`];
  m.lane_commands.b.test = [`SECRET=CANARY-LANE-7 ${TEST_CMD} --only b`];
  writeFileSync(path, JSON.stringify(m, null, 2));
  const res = runCli(dir);
  assert.equal(res.code, 0, res.stderr);
  const json = readFileSync(join(dir, 'autopsy.json'), 'utf8');
  for (const text of [json, res.md, res.stdout]) {
    for (const secret of ['CANARY-PRIVATE-150', 'CANARY-LANE-7', 'API_TOKEN']) assert.ok(!text.includes(secret), secret);
  }
  const checks = JSON.parse(json).checks;
  assert.equal(checks.executions.length, 4);
  assert.equal(checks.full_suite_runs.total, 4);
});

test('checks without tool events are unavailable, not zero', () => {
  const dir = copyRun(RUN3);
  for (const name of readdirSync(join(dir, 'wf_1')).filter((n) => n.endsWith('.jsonl'))) {
    editLines(join(dir, 'wf_1', name), (lines) => lines.map((l) => {
      const o = JSON.parse(l);
      delete o.timestamp;
      return JSON.stringify(o);
    }));
  }
  const res = autopsy(dir);
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(res.json.checks, {
    executions: 'unavailable', by_check: 'unavailable',
    full_suite_runs: { total: 'unavailable', inferred: 'unavailable', by_role: 'unavailable' },
  });
});

// ---- autopsy.md and the chat summary ----

function runCli(dir, ...extra) {
  const r = spawnSync('python3', [SCRIPT, dir, ...extra], { encoding: 'utf8' });
  const mdPath = join(dir, 'autopsy.md');
  const md = r.status === 0 && existsSync(mdPath) ? readFileSync(mdPath, 'utf8') : null;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, md };
}

const HEADINGS = [
  'Summary', 'What got done', 'Where time went', 'Checks', 'Slowdowns', 'Tokens', 'Suggestions',
  'Open questions',
];

test('autopsy.md has every section in order', () => {
  for (const src of [RUN1, RUN2, RUN3]) {
    const res = runCli(copyRun(src));
    assert.equal(res.code, 0, res.stderr);
    const lines = res.md.split('\n');
    assert.match(lines[0], /^# Autopsy: \S/);
    assert.deepEqual(lines.filter((l) => l.startsWith('## ')), HEADINGS.map((h) => `## ${h}`));
  }
  const md = runCli(copyRun(RUN2)).md;
  // The phase table, a 40-column bar per lane and the estimate label.
  assert.match(md, /\| Lane beta \| wf_2 \|/);
  assert.match(md, /^lane a +wf_2 +\|[.#]{40}\|/m);
  assert.match(md, /estimate/i);
  // Checks: executions by check id, what the ids name, and full-suite runs by role.
  assert.match(md, /^\| Check \| Runs \| Inferred \| Total \|$/m);
  assert.match(md, /^\| test#1 \| 3 \| 0 \| 160\.0 s \|$/m);
  assert.ok(md.includes('Check ids name manifest commands: test#1 is commands.test[0], '
    + '<lane>.test#1 is lane_commands.<lane>.test[0].'));
  assert.match(md, /^Full-suite runs: 3$/m);
  assert.match(md, /implement: 3/);
  // One open-questions line per unexplained entry.
  const open = md.split('## Open questions')[1].split('\n').filter((l) => l.startsWith('- '));
  assert.equal(open.length, 1);
  // Slowdown rows are numbered from 1, and each suggestion names its rows.
  assert.match(md, /^\| 1 \| relaunch \|/m);
  assert.ok(!/^\| 0 \|/m.test(md));
  assert.match(md, /^1\. relaunch \(stake 300\.0 s, 1 time; slowdown row #1\):/m);
  // Paths are relative to the run folder.
  assert.ok(!md.includes(TMP));
});

test('a lane outside the launch axis keeps its own span in the timeline', () => {
  const dir = copyRun();
  // wf_1.json says the launch took 5 minutes; lane a runs to 07:06:00.
  const wfPath = join(dir, 'wf_1.json');
  const wf = JSON.parse(readFileSync(wfPath, 'utf8'));
  wf.durationMs = 300000;
  writeFileSync(wfPath, JSON.stringify(wf, null, 2));
  const res = runCli(dir);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.md, /^lane a +wf_1 +\|[.#]{40}\| {2}span 355\.0 s, busy 255\.0 s$/m);
});

test('the summary is at most 15 lines and names the essentials', () => {
  const dir = copyRun(RUN2);
  const res = runCli(dir);
  assert.equal(res.code, 0, res.stderr);
  const lines = res.stdout.split('\n').filter((l) => l !== '');
  assert.ok(lines.length <= 15, `${lines.length} lines`);
  const A2 = JSON.parse(readFileSync(join(dir, 'autopsy.json'), 'utf8'));
  const slowest = A2.time.phases.reduce((a, b) => (b.wall_s > a.wall_s ? b : a));
  assert.equal(slowest.phase, 'Lane a');
  assert.match(res.stdout, /Lane a/);
  assert.match(res.stdout, /1590\.0 s/);
  // The top three slowdowns, largest first, with their cost_s.
  const top = A2.slowdowns.slice(0, 3);
  assert.deepEqual(top.map((s) => s.kind), ['relaunch', 'idle_gap', 'escalation']);
  for (const s of top) assert.match(res.stdout, new RegExp(`${s.kind}.*${s.cost_s.toFixed(1)} s`));
  assert.ok(!res.stdout.includes('extra_review_round'));
  assert.match(res.stdout, /full-suite runs: 3/);
  assert.match(res.stdout, /suggestion: relaunch/);
  const mdPath = join(dir, 'autopsy.md').replaceAll('\\', '/');
  assert.ok(res.stdout.includes(mdPath), res.stdout);
  assert.ok(readFileSync(join(dir, 'autopsy.md'), 'utf8').length > 0);
  // --quiet writes the files and prints nothing.
  const quiet = runCli(copyRun(RUN2), '--quiet');
  assert.equal(quiet.code, 0, quiet.stderr);
  assert.equal(quiet.stdout, '');
  assert.ok(quiet.md.startsWith('# Autopsy: '));
});

test('a run with no slowdowns still gets a short summary', () => {
  const res = runCli(copyRun(RUN1));
  assert.equal(res.code, 0, res.stderr);
  assert.ok(res.stdout.split('\n').filter((l) => l !== '').length <= 15);
  assert.match(res.stdout, /full-suite runs: 2/);
  assert.match(res.stdout, /autopsy\.md/);
});

test('partial tokens are called minimums', () => {
  const dir = copyRun();
  editLines(join(dir, 'wf_1', 'agent-a2.jsonl'), (lines) => {
    lines[2] = lines[2].slice(0, 60);
    return lines;
  });
  const res = runCli(dir);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /minimum/);
  // The summary still gives every token figure, each as a minimum.
  const tot = JSON.parse(readFileSync(join(dir, 'autopsy.json'), 'utf8')).tokens.totals;
  const line = res.stdout.split('\n').find((l) => l.startsWith('tokens'));
  for (const [n, what] of [[tot.input_tokens, 'input'], [tot.output_tokens_min, 'output'],
    [tot.cache_read_input_tokens, 'cache read'], [tot.cache_creation_input_tokens, 'cache creation']]) {
    assert.ok(line.includes(`>= ${n} ${what}`), `${what}: ${line}`);
  }
  const tokens = res.md.split('## Tokens')[1].split('\n## ')[0];
  assert.match(tokens, /minimum/);
  assert.match(tokens, /unreadable lines: 1/);
  // A complete run says neither.
  const whole = runCli(copyRun());
  assert.ok(!/minimum/.test(whole.stdout));
  const wholeTokens = whole.md.split('## Tokens')[1].split('\n## ')[0];
  assert.ok(!/minimum|unreadable/.test(wholeTokens));
});

test('the outputs are plain ASCII', () => {
  const dir = copyRun(RUN2);
  const manifestPath = join(dir, 'p.lanes.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.run_id = 'f2-\u00e9\u4e2d';
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const res = runCli(dir);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.md, /^[\x00-\x7f]*$/);
  assert.match(res.stdout, /^[\x00-\x7f]*$/);
  assert.match(readFileSync(join(dir, 'autopsy.json'), 'utf8'), /^[\x00-\x7f]*$/);
  assert.match(res.md.split('\n')[0], /^# Autopsy: f2-\?+$/);
});

test('rerunning autopsy overwrites only its own files', () => {
  const dir = copyRun(RUN2);
  const hashes = () => {
    const out = {};
    const walk = (rel) => {
      for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(p);
        else if (p !== 'autopsy.json' && p !== 'autopsy.md') {
          out[p] = createHash('sha256').update(readFileSync(join(dir, p))).digest('hex');
        }
      }
    };
    walk('');
    return out;
  };
  const before = hashes();
  assert.ok(Object.keys(before).length > 5);
  const first = runCli(dir, '--quiet');
  const second = runCli(dir, '--quiet');
  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.md, first.md);
  assert.deepEqual(hashes(), before);
  assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith('autopsy')).sort(), ['autopsy.json', 'autopsy.md']);
});

test('render_markdown and render_summary work on an analysis alone', () => {
  const out = python([
    'import _autopsy',
    `a = _autopsy.analyze(${JSON.stringify(RUN1)})`,
    'md = _autopsy.render_markdown(a)',
    'print(json.dumps([md.splitlines()[0], _autopsy.render_summary(a, "/x/autopsy.md").splitlines()[-1]]))',
  ]);
  assert.match(out[0], /^# Autopsy: f1$/);
  assert.match(out[1], /\/x\/autopsy\.md$/);
});
