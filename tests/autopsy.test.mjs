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
    'tokens', 'checks', 'slowdowns', 'detectors', 'suggestions', 'unexplained', 'launch_conditions',
    'orphan_snapshots',
  ]);
  assert.equal(A.autopsy_version, 11);
  assert.equal(A.run_id, 'f1');
  assert.equal(A.engine_version, '1.5.0');
  // commits counts the ledger's commits (A1 one, B1 two in one round); range
  // is the result's [base, head], as the engine writes it.
  assert.deepEqual(A.done.tasks, {
    A1: { status: 'done', commits: 1, range: ['0'.repeat(40), '1'.repeat(40)], rounds: 1, tier_used: 'standard' },
    B1: { status: 'done', commits: 2, range: ['0'.repeat(40), '3'.repeat(40)], rounds: 0, tier_used: 'standard' },
  });
  // run1's ledger has no accepted event at its delivered head.
  assert.deepEqual(A.done.acceptance, {
    status: 'unverified', reasons: [{ kind: 'checks_stale', class: 'missing' }], warnings: 1,
    accepted_by_user: false,
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
    { wf: 'wf_1', start: T('07:00:00'), end: T('07:10:00'), wall_s: 600, status: 'complete', kept_agents: 4,
      redone_agents: 0, kept_s: 455, redone_s: 0, redone_agent_s: 0 },
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
  // Without wf_1.json the launch is timed from its agents' first and last events;
  // B1 implement is untimed, so the time its kept agents covered is unavailable.
  assert.deepEqual(D.launches, [
    { wf: 'wf_1', start: T('07:00:05'), end: T('07:09:50'), wall_s: 585, status: 'unavailable', kept_agents: 4,
      redone_agents: 0, kept_s: 'unavailable', redone_s: 0, redone_agent_s: 0 },
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
    assert.deepEqual(Object.keys(e).sort(), ['id', 'input', 'is_error', 'kind', 'msg', 'name', 'text', 'ts']);
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

test('a tool_use event carries its line\'s message id', () => {
  const events = python([
    'import _autopsy',
    `print(json.dumps(_autopsy.read_events(${JSON.stringify(join(RUN1, 'wf_1', 'agent-b1.jsonl'))})))`,
  ]);
  assert.deepEqual(events.filter((e) => e.kind === 'tool_use').map((e) => e.msg), ['m_b1_2', 'm_b1_3']);
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
    // The agent sat idle from the call's result (09:00:12) to the notice
    // (09:01:40): 88 s of waiting inside the 90 s background window.
    background_check: ['A1 implement', T('09:00:10'), 88, 'bound'],
    // Its window to the next write (32 s) holds the edit_retry, charged first.
    heredoc_failure: ['A1 implement', T('09:01:50'), 10, 'bound'],
    edit_retry: ['A1 implement', T('09:02:00'), 22, 'measured'],
    repeated_failure: ['A1 implement', T('09:02:30'), 20, 'measured'],
    check_rerun: ['A1 implement', T('09:03:40'), 40, 'measured'],
    timeout: ['A1 implement', T('09:04:30'), 120, 'measured'],
    long_tool_call: ['A1 implement', T('09:06:40'), 130, 'measured'],
    escalation: ['B1 implement', T('09:02:10'), 170, 'measured'],
    retry: ['B1 review retry', T('09:05:40'), 60, 'measured'],
    extra_review_round: ['A1 fix 1', T('09:13:30'), 140, 'measured'],
    // wf_1's A1 implement (08:00:10-08:04:50), which wf_2 ran again.
    relaunch: [null, T('08:00:00'), 280, 'measured'],
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
    assert.deepEqual([s.span_s, s.merged, s.contains], [kind === 'heredoc_failure' ? 32 : s.cost_s, 1, []], kind);
    assert.equal('background_s' in s, kind === 'background_check', kind);
  }
  assert.equal(byKind.background_check.background_s, 90);
  // The largest cost comes first.
  const costs = S.slowdowns.map((s) => s.cost_s);
  assert.deepEqual(costs, [...costs].sort((x, y) => y - x));
  // The background call and the rerun run the manifest's test command
  // (node tests/run-tests.mjs): check test#1. No other row runs a check.
  assert.deepEqual(byKind.background_check.evidence,
    { tool: 'Bash', exit: null, marker: 'Command running in background with ID', program: 'node', check: 'test#1' });
  assert.deepEqual(byKind.check_rerun.evidence,
    { tool: 'Bash', exit: null, marker: null, program: 'node', check: 'test#1' });
  assert.deepEqual(byKind.timeout.evidence,
    { tool: 'Bash', exit: null, marker: 'Command timed out after', program: 'npm', check: null });
  assert.deepEqual(byKind.repeated_failure.evidence,
    { tool: 'Bash', exit: 6, marker: null, program: 'curl', check: null });
  assert.deepEqual(byKind.heredoc_failure.evidence,
    { tool: 'Bash', exit: 2, marker: '<<', program: 'cat', check: null });
  assert.deepEqual(byKind.edit_retry.evidence,
    { tool: 'Edit', exit: null, marker: 'has not been read yet', program: null, check: null });
  assert.deepEqual(byKind.idle_gap.evidence, { tool: null, exit: null, marker: null, program: null, check: null });
  for (const s of S.slowdowns) {
    assert.equal(s.evidence.check, ['background_check', 'check_rerun'].includes(s.kind) ? 'test#1' : null, s.kind);
  }
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
  // The launch times still come from wf_1.json, but wf_1's A1 implement,
  // which wf_2 ran again, is untimed: the relaunch cost is unknown, never 0.
  const relaunch = D.slowdowns.find((s) => s.kind === 'relaunch');
  assert.deepEqual([relaunch.at, relaunch.cost_s, relaunch.cost_kind], [T('08:00:00'), 'unavailable', 'unavailable']);
  assert.deepEqual([D.launches[0].redone_s, D.launches[0].redone_agent_s], ['unavailable', 'unavailable']);
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
    assert.deepEqual(Object.keys(s.evidence).sort(), ['check', 'exit', 'marker', 'program', 'tool']);
  }
  const program = (command) => python([
    'import _autopsy',
    `print(json.dumps(_autopsy.program_of(${JSON.stringify(command)})))`,
  ]);
  const programWith = (command) => python([
    'import _autopsy',
    'checks = _autopsy.configured_checks({"commands": {"test": ["node tests/run-tests.mjs"]}})',
    `print(json.dumps(_autopsy.program_of(${JSON.stringify(command)}, checks)))`,
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
  // 1. A simple command that runs a check names the program: an
  // interpreter's script, as a basename.
  assert.equal(programWith('git status && node tests/run-tests.mjs'), 'node');
  assert.equal(programWith('grep -c x f; C:/u/py/python.exe C:/u/skill/scripts/run-checks --cmd test x'), 'run-checks');
  assert.equal(programWith('python3 C:/u/skill/scripts/task-checks a b'), 'task-checks');
  // 2. A loop that runs sleep is a wait loop.
  assert.equal(program('for i in $(seq 1 60); do grep -q done f && break; sleep 5; done'), 'sleep');
  assert.equal(program('until grep -q x f; do sleep 5; done'), 'sleep');
  // 3. Else the first program that is not plumbing, else the first one.
  assert.equal(program('sleep 30; python3 long.py'), 'long.py');
  assert.equal(program('sed -i s/a/b/ f && node a.js'), 'node');
  assert.equal(program('rm -rf x; mkdir x'), 'rm');
  assert.equal(program('git commit -m x'), 'git');
  // A case pattern (a word with * or ?) is never a program, and [[ ... ]]
  // is plumbing like [.
  assert.equal(program('case "$f" in\n*.meta) rm "$f";;\nesac'), 'rm');
  assert.equal(program('[[ -f a ]] && node a.js'), 'node');
  // A line whose quoting does not parse is read as plain words, which may
  // split quoted text: only the first simple command's program counts.
  assert.equal(program("sleep 5; node a.js 'open"), 'sleep');
  assert.equal(program('cd /w && grep -c "TODO|someuser" f; echo it\'s done'), 'grep');
  // An interpreter runs a script word (a path, or a script suffix), or
  // inline code (-c, -m, -), which names the interpreter itself; a bare
  // variable names only the script it runs.
  assert.equal(program('bash /tmp/task-checks-x.sh'), 'task-checks-x.sh');
  assert.equal(program('python3 -c "print(1)"'), 'python3');
  assert.equal(program(`python='C:/u/py/python.exe'; "$python" C:/u/skill/scripts/run-checks --out f`), 'run-checks');
  assert.equal(program('"$python" -m pytest'), null);
  assert.equal(program('"$GIT" status'), null);
  // A word that starts with a variable and holds a path is a path.
  assert.equal(program('"$ROOT/node_modules/.bin/playwright" test'), 'playwright');
  assert.equal(program('$VENV/bin/skein serve'), 'skein');
  assert.equal(program('$X/counts.sh'), 'counts.sh');
  assert.equal(programWith('"$SKILL/scripts/run-checks" C:/u/project-wt/lane-a --cmd test x'), 'run-checks');
});

// ---- detector cases on synthetic events (tool_slowdowns) ----

// Events of one agent, labelled X: use() is a tool call, res() its result;
// times are seconds. As find_slowdowns does, detect() leaves the internal
// check_time rows out of slowdowns and suggestions; check_time lists the
// [start, end] parts of the agent's time they took, and found the kinds
// tool_slowdowns made before settling.
const use = (ts, id, name, input, msg = null) => (
  { ts, kind: 'tool_use', name, id, is_error: false, text: '', input, msg });
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
    'every = _autopsy.settle_slowdowns(found)',
    'settled = [s for s in every if s["kind"] != "check_time"]',
    'calls = _autopsy._calls(agent)',
    'run = {"folder": None, "manifest": {}, "launches": [{"wf": "wf_1", "result": {"version": "1.6.10"},',
    '                                                    "agents": [agent]}]}',
    'print(json.dumps({"slowdowns": [_autopsy.public_slowdown(s) for s in settled],',
    '                  "check_time": [[a, b] for s in every if s["kind"] == "check_time" for _o, a, b in s["_covers"]],',
    '                  "found": sorted(set(s["kind"] for s in found)),',
    '                  "suggestions": _autopsy.suggestions_section(settled, None),',
    '                  "waits": _autopsy.waits_section(run),',
    '                  "ends": [list(_autopsy._execution_end(agent, c)) for c in calls],',
    '                  "times": [list(_autopsy._execution_times(agent, c)) for c in calls],',
    '                  "own_starts": [c["own_start"] for c in calls],',
    '                  "completions": [_autopsy._completion_after(agent, c) for c in calls]}))',
  ]);
}
const at = (ts) => new Date(ts * 1000).toISOString();
const brief = (out) => out.slowdowns.map((s) => [s.kind, s.at, s.cost_s, s.cost_kind, s.evidence.marker]);

test('a call queued behind an earlier call of its turn starts at that call\'s result', () => {
  const NOT_READ = '<tool_use_error>File has not been read yet.</tool_use_error>';
  const serial = (m) => [
    use(0, 'b1', 'Bash', { command: 'npm run build' }, m),
    use(1, 'e1', 'Edit', { file_path: 'a.js' }, m),
    use(2, 'e2', 'Edit', { file_path: 'b.js' }, m),
    res(130, 'b1', 'Bash', 'built'),
    res(130.1, 'e1', 'Edit', NOT_READ, true),
    res(130.2, 'e2', 'Edit', NOT_READ, true),
  ];
  let out = detect(serial('m1'));
  assert.deepEqual(out.own_starts, [0, 130, 130.1]);
  // Only the build is a long call; the queued Edits are charged their own time.
  assert.deepEqual(brief(out).filter((s) => s[0] === 'long_tool_call'), [['long_tool_call', at(0), 130, 'measured', null]]);
  // Without message ids, consecutive tool_use events are one turn.
  assert.deepEqual(detect(serial(null)).own_starts, [0, 130, 130.1]);
  // A result line between the uses ends the turn when there are no ids ...
  const twoTurns = (m1, m2) => [
    use(0, 'b1', 'Bash', { command: 'npm run build' }, m1),
    use(1, 'e1', 'Edit', { file_path: 'a.js' }, m1),
    res(1.5, 'b1', 'Bash', 'built'),
    use(2, 'e2', 'Edit', { file_path: 'b.js' }, m2),
    res(3, 'e1', 'Edit', 'ok'),
    res(4, 'e2', 'Edit', 'ok'),
  ];
  assert.deepEqual(detect(twoTurns(null, null)).own_starts, [0, 1.5, 2]);
  // ... and so does a different message id.
  assert.deepEqual(detect(twoTurns('m1', 'm2')).own_starts, [0, 1.5, 2]);
  // Review focus 1: one turn by message id although a result lies between the
  // uses; e1 started at 3, after b1 ended at 2.
  out = detect([
    use(0, 'b1', 'Bash', { command: 'sleep 2' }, 'm1'),
    res(2, 'b1', 'Bash', 'ok'),
    use(3, 'e1', 'Edit', { file_path: 'a.js' }, 'm1'),
    res(5, 'e1', 'Edit', 'ok'),
  ]);
  assert.deepEqual(out.own_starts, [0, 3]);
  // A tool_use without a message id right after one with an id joins its turn.
  out = detect([
    use(0, 'b1', 'Bash', { command: 'sleep 9' }, 'm1'),
    use(1, 'e1', 'Edit', { file_path: 'a.js' }, null),
    res(9, 'b1', 'Bash', 'ok'),
    res(9.1, 'e1', 'Edit', 'ok'),
  ]);
  assert.deepEqual(out.own_starts, [0, 9]);
  // A tool_use with another id right after an id-less one starts its own turn.
  out = detect([
    use(0, 'b1', 'Bash', { command: 'sleep 9' }, null),
    use(1, 'e1', 'Edit', { file_path: 'a.js' }, 'm2'),
    res(9, 'b1', 'Bash', 'ok'),
    res(9.1, 'e1', 'Edit', 'ok'),
  ]);
  assert.deepEqual(out.own_starts, [0, 1]);
  // Review focus 2: an earlier call without a result is ignored.
  out = detect([
    use(0, 'b1', 'Bash', { command: 'sleep 99' }, 'm1'),
    use(1, 'e1', 'Edit', { file_path: 'a.js' }, 'm1'),
    res(10, 'e1', 'Edit', 'ok'),
  ]);
  assert.deepEqual(out.own_starts, [0, 1]);
});

test('a message id seen again gives no later turn its number', () => {
  // m1, m2, m1 again, then m3: m3 is a turn of its own, not m2's, so d starts
  // at its own use (8), not at b's result (9).
  const out = detect([
    use(0, 'a', 'Bash', { command: 'x' }, 'm1'),
    res(5, 'a', 'Bash', 'ok'),
    use(6, 'b', 'Bash', { command: 'y' }, 'm2'),
    use(7, 'c', 'Bash', { command: 'z' }, 'm1'),
    use(8, 'd', 'Bash', { command: 'w' }, 'm3'),
    res(9, 'b', 'Bash', 'ok'),
    res(10, 'c', 'Bash', 'ok'),
    res(11, 'd', 'Bash', 'ok'),
  ]);
  assert.deepEqual(out.own_starts, [0, 6, 7, 8]);
});

test('a check call queued behind a call of its turn starts at that call\'s result', () => {
  // A Read and the test command sent in one turn: the test runs after the
  // Read's result (60), so its execution starts there.
  const out = detect([
    use(0, 'r1', 'Read', { file_path: 'a.js' }, 'm1'),
    use(0.5, 't1', 'Bash', { command: 'npm test' }, 'm1'),
    res(60, 'r1', 'Read', 'x'),
    res(90, 't1', 'Bash', '9 passed'),
  ]);
  assert.deepEqual(out.times[1], [false, 60, 90, 'measured']);
});

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
  // The waiting: the turn up to the poll, the poll, and the idle stretch to
  // the notice (1-130); the call's own second is not waiting.
  assert.deepEqual(brief(out), [['background_check', at(0), 129, 'bound', 'Command running in background with ID']]);
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

// A call of one second at ts, and its result.
const call1 = (ts, id, name, input, text = 'ok') => [use(ts, id, name, input), res(ts + 1, id, name, text)];
const RUNNING_POLL = '<status>running</status>';

test('a background check costs only the time the agent waited', () => {
  const notices = [{ ts: 300, task_id: 'bx1', status: 'completed' }];
  const rows = (out) => out.slowdowns.filter((s) => s.kind === 'background_check')
    .map((s) => [s.at, s.cost_s, s.span_s, s.cost_kind, s.background_s]);
  // Waits: (b) 1-10, (a) 10-11, (b) 11-40, (a) 40-41, (c) 41-300.
  let out = detect([...bxRun, ...call1(10, 'o1', 'BashOutput', { bash_id: 'bx1' }, RUNNING_POLL),
    ...call1(40, 'o2', 'BashOutput', { bash_id: 'bx1' }, RUNNING_POLL)], [], notices);
  assert.deepEqual(rows(out), [[at(0), 299, 299, 'bound', 300]]);
  assert.equal(out.waits.background_not_waited, 0);
  assert.equal(out.suggestions.find((g) => g.kind === 'background_check').text,
    'A command likely went to the background and the agent waited for it. For a check, try the long-check '
    + 'procedure (run-checks --out with await-checks wait); otherwise a foreground run with a timeout long '
    + 'enough for it.');
  // Working: only the poll at 290 is waiting; 291 to the notice is 9 s, no
  // idle stretch.
  out = detect([...bxRun, ...call1(10, 'r1', 'Read', { file_path: 'a.js' }),
    ...call1(20, 'e1', 'Edit', { file_path: 'a.js' }, 'The file a.js has been updated.'),
    ...call1(30, 'g1', 'Bash', { command: 'git status' }),
    ...call1(290, 'o1', 'BashOutput', { bash_id: 'bx1' }, RUNNING_POLL)], [], notices);
  assert.deepEqual(rows(out), [[at(0), 1, 1, 'bound', 300]]);
  // Idle: nothing until the notice, (c) 1-300.
  out = detect(bxRun, [], notices);
  assert.deepEqual(rows(out), [[at(0), 299, 299, 'bound', 300]]);
  // Not waited: a Read every 20 s until the notice is no slowdown, and is
  // counted.
  const reads = [];
  for (let ts = 10; ts <= 290; ts += 20) reads.push(...call1(ts, `r${ts}`, 'Read', { file_path: 'a.js' }));
  out = detect([...bxRun, ...reads], [], notices);
  assert.deepEqual(out.slowdowns, []);
  assert.equal(out.waits.background_not_waited, 1);
  const mdWaits = (waits) => python(['import _autopsy',
    `print(json.dumps(_autopsy._md_waits(json.loads(${JSON.stringify(JSON.stringify(waits))}))))`]);
  assert.ok(mdWaits(out.waits).includes('Background commands not waited for: 1.'));
  // Without an observed completion the row stays unavailable, not counted.
  out = detect([...bxRun, ...reads]);
  assert.deepEqual(rows(out), [[at(0), 'unavailable', 'unavailable', 'unavailable', 'unavailable']]);
  assert.equal(out.waits.background_not_waited, 0);
  assert.ok(!mdWaits(out.waits).some((l) => l.startsWith('Background commands not waited for')));
  // The wait calls.
  const calls = [
    { name: 'Bash', input: { command: 'until grep -q done x; do sleep 5; done' } },
    { name: 'Bash', input: { command: "tail -5 'C:/u/tmp/tasks/bx1.output'" } },
    { name: 'Read', input: { file_path: 'C:\\u\\tmp\\tasks\\bx1.output' } },
    { name: 'Monitor', input: { command: 'until grep -q done x; do sleep 5; done' } },
    { name: 'BashOutput', input: { bash_id: 'bx1' } },
    { name: 'TaskOutput', input: { task_id: 'bx1' } },
    { name: 'Bash', input: { command: "'python3' '/skill/scripts/await-checks' wait '/l/checks/a.json'" } },
    { name: 'Bash', input: { command: 'npm test' } },
    { name: 'Bash', input: { command: 'echo sleep 5 > notes.txt' } },
    { name: 'Read', input: { file_path: 'src/tasks.js' } },
  ];
  assert.deepEqual(python([
    'import _autopsy',
    `print(json.dumps([_autopsy._is_wait_call(c) for c in json.loads(${JSON.stringify(JSON.stringify(calls))})]))`,
  ]), [true, true, true, true, true, true, true, false, false, false]);
});

test('the scan stops at the first call past the window but keeps that call\'s gap', () => {
  // bx1 runs from 0; a running poll 10-11; a poll at 150, after the notice.
  // The poll at 150 starts past the window's end, so the scan stops there,
  // but its gap (b) from the poll before (11-150) still counts, clipped.
  const polls = [...bxRun, ...call1(10, 'o1', 'BashOutput', { bash_id: 'bx1' }, RUNNING_POLL),
    ...call1(150, 'o2', 'BashOutput', { bash_id: 'bx1' }, '<status>completed</status>')];
  const rows = (out) => out.slowdowns.filter((s) => s.kind === 'background_check')
    .map((s) => [s.at, s.cost_s, s.span_s, s.cost_kind, s.background_s]);
  // Notice at 100: gap 1-10, poll 10-11, gap 11-150 clipped to 11-100 (the
  // idle stretch (c) from 11 covers 11-100 too): 99 s.
  assert.deepEqual(rows(detect(polls, [], [{ ts: 100, task_id: 'bx1', status: 'completed' }])),
    [[at(0), 99, 99, 'bound', 100]]);
  // Notice at 50: 11-50 is 39 s, no idle stretch, so only the gap before the
  // poll at 150 covers it: 49 s, not 10.
  assert.deepEqual(rows(detect(polls, [], [{ ts: 50, task_id: 'bx1', status: 'completed' }])),
    [[at(0), 49, 49, 'bound', 50]]);
});

test('a background window without waiting is no slowdown, and its call no long call', () => {
  // Review focus 4: a call moved to the background at its timeout whose
  // completion notice comes at that same result (a window of length 0).
  const moved = 'Command did not complete within its 120s timeout and was moved to the background (ID: bx1).';
  let out = detect([use(0, 'b1', 'Bash', { command: 'npm test' }), res(120, 'b1', 'Bash', moved)], [],
    [{ ts: 120, task_id: 'bx1', status: 'completed' }]);
  assert.deepEqual(out.slowdowns.map((s) => [s.kind, s.at, s.cost_s, s.contains]),
    [['timeout', at(0), 120, []]]);
  assert.equal(out.waits.background_not_waited, 1);
  // A backgrounded call that took 130 s to return, then only short calls
  // that do not wait.
  out = detect([
    use(0, 'b1', 'Bash', { command: 'npm test', run_in_background: true }),
    res(130, 'b1', 'Bash', 'Command running in background with ID: bx1'),
    ...call1(140, 'r1', 'Read', { file_path: 'a.js' }),
    ...call1(150, 'g1', 'Bash', { command: 'git status' }),
  ], [], [{ ts: 160, task_id: 'bx1', status: 'completed' }]);
  assert.deepEqual(out.slowdowns, []);
  assert.equal(out.waits.background_not_waited, 1);
});

test('a call open across the stretch before the notice is no idle waiting', () => {
  // bx1 runs from 0; a build runs 10-400 and no wait call follows. The agent
  // is not idle from 10 to the notice at 300: the build is open across it.
  const out = detect([...bxRun,
    use(10, 'b2', 'Bash', { command: 'npm run build' }),
    res(400, 'b2', 'Bash', 'built'),
  ], [], [{ ts: 300, task_id: 'bx1', status: 'completed' }]);
  assert.deepEqual(out.slowdowns.filter((s) => s.kind === 'background_check'), []);
  assert.equal(out.waits.background_not_waited, 1);
});

test('two background checks waited on together are one row over both windows', () => {
  // bx1 runs 0-50 and bx2 2-80; the polls wait for both: 10-21 for bx1,
  // 3-21 for bx2 (from its own result). One row of 18 s; its window is the
  // union of the two, 0-80.
  const out = detect([...bxRun,
    use(2, 'b2', 'Bash', { command: 'npm run e2e', run_in_background: true }),
    res(3, 'b2', 'Bash', 'Command running in background with ID: bx2'),
    ...call1(10, 'o1', 'BashOutput', { bash_id: 'bx1' }, RUNNING_POLL),
    ...call1(20, 'o2', 'BashOutput', { bash_id: 'bx2' }, RUNNING_POLL),
  ], [], [{ ts: 50, task_id: 'bx1', status: 'completed' }, { ts: 80, task_id: 'bx2', status: 'completed' }]);
  assert.deepEqual(out.slowdowns.map((s) => [s.kind, s.at, s.cost_s, s.span_s, s.merged, s.background_s]),
    [['background_check', at(0), 18, 18, 2, 80]]);
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

// A heredoc write of `size` characters in all, then a test command on the
// line after it (the r150 D2 shape), and `tail` after that.
const longWrite = (size, tail = 'node --test tests/a.test.mjs 2>&1 | tail -5') => {
  const head = "cd '/w' && cat >> tests/a.test.mjs <<'EOF'\n";
  const end = `\nEOF\n${tail}`;
  const fill = size - head.length - end.length;
  const body = Array.from({ length: Math.ceil(fill / 40) }, () => `// ${'x'.repeat(36)}`).join('\n').slice(0, fill);
  const command = head + body + end;
  assert.equal(command.length, size);
  return command;
};
const OUTER_EOF = "/usr/bin/bash: -c: line 147: unexpected EOF while looking for matching `''";
const heredocRows = (command, text) => brief(detect([use(0, 'h1', 'Bash', { command }), res(2, 'h1', 'Bash', text, true),
  ...call1(10, 'e1', 'Edit', { file_path: 'tests/a.test.mjs' }, 'The file tests/a.test.mjs has been updated.')]));
const HEREDOC_ROW = [['heredoc_failure', at(0), 11, 'bound', '<<']];

test('a heredoc line too long for the Bash tool is a heredoc failure', () => {
  // W1: a line of 6,000 characters or more holding a heredoc write, whose
  // result after 'Exit code 2' is only the outer shell's unexpected EOF
  // (bash 5.1 and older add a syntax error line). The tool cut the line, so
  // the shell ran none of it: the write failed.
  const command = longWrite(9023);
  const syntax = '/usr/bin/bash: -c: line 188: syntax error: unexpected end of file';
  for (const text of [`Exit code 2\n${OUTER_EOF}`, `Exit code 2\n${OUTER_EOF}\n${syntax}`, `Exit code 2\n${OUTER_EOF}\n`]) {
    assert.deepEqual(heredocRows(command, text), HEREDOC_ROW, text);
  }
  const out = detect([use(0, 'h1', 'Bash', { command }), res(2, 'h1', 'Bash', `Exit code 2\n${OUTER_EOF}`, true)]);
  assert.deepEqual(out.slowdowns[0].evidence, { tool: 'Bash', exit: 2, marker: '<<', program: 'node', check: null });
  // 6,000 characters is the least; a Windows shell path counts too.
  assert.deepEqual(heredocRows(longWrite(6000), `Exit code 2\n${OUTER_EOF}`), HEREDOC_ROW);
  assert.deepEqual(heredocRows(command,
    "Exit code 2\nC:\\Program Files\\Git\\usr\\bin\\bash.exe: -c: line 9: unexpected EOF while looking for matching `\"'"),
  HEREDOC_ROW);
  // Review focus 3: none of these says the write failed.
  for (const [line, text] of [
    // One character short.
    [longWrite(5999), `Exit code 2\n${OUTER_EOF}`],
    // A short line with the same message (its write ran first).
    ["cd /w && cat > a.txt <<'EOF'\nx\nEOF\nnode a.js", "Exit code 2\n/usr/bin/bash: -c: line 4: unexpected EOF while looking for matching `''"],
    // An inner shell's EOF after the write: it names itself bash, not by path.
    [longWrite(9023, "bash -c \"echo 'x\""), "Exit code 2\nbash: -c: line 1: unexpected EOF while looking for matching `''"],
    // The EOF line and the syntax error line of two shells: the outer one,
    // named by its path, and an inner bash.
    [command, `Exit code 2\n${OUTER_EOF}\nbash: -c: line 1: syntax error: unexpected end of file`],
    // More output than the shell's message, another exit code, or a line
    // without a heredoc write.
    [command, `Exit code 2\n${OUTER_EOF}\nnot ok 1 - a`],
    [command, `Exit code 1\n${OUTER_EOF}`],
    [command, `${OUTER_EOF}`],
    [command.replace("cat >> tests/a.test.mjs <<'EOF'", "python3 - <<'EOF'"), `Exit code 2\n${OUTER_EOF}`],
  ]) {
    assert.deepEqual(heredocRows(line, text), [], `${line.slice(-40)}: ${text}`);
  }
});

test('a heredoc write to a missing folder is a heredoc failure', () => {
  // W2: the shell's redirect error names the heredoc write's own target.
  assert.deepEqual(heredocRows("cd /w && cat > src/x/a.ts <<'EOF'\nexport const a = 1;\nEOF\ngit add src/x/a.ts",
    "Exit code 128\n/usr/bin/bash: line 1: src/x/a.ts: No such file or directory\nfatal: pathspec 'src/x/a.ts' did not match any files"),
  HEREDOC_ROW);
  // A target holding $ or ~ matches on its basename: the shell prints the
  // expanded path.
  assert.deepEqual(heredocRows("S=/c/u/tmp/gone && cat > \"$S/probe.py\" <<'EOF'\nprint(1)\nEOF\npython3 \"$S/probe.py\"",
    "Exit code 2\n/usr/bin/bash: line 1: /c/u/tmp/gone/probe.py: No such file or directory\n"
    + "python3: can't open file '/c/u/tmp/gone/probe.py': [Errno 2] No such file or directory"), HEREDOC_ROW);
  assert.deepEqual(heredocRows("cat > ~/notes/a.md <<'EOF'\nx\nEOF\nwc -l ~/notes/a.md",
    "Exit code 1\n/usr/bin/bash: line 1: /home/u/notes/a.md: No such file or directory\nwc: /home/u/notes/a.md: No such file or directory"),
  HEREDOC_ROW);
  // Review focus 3: another file's error, or a message that is not the
  // shell's redirect error, is no heredoc failure.
  for (const [line, text] of [
    // The write ran; source fails on a path that is not the target.
    ["cat > /tmp/a.sh <<'EOF'\necho hi\nEOF\nsource ./a.sh", 'Exit code 1\n/usr/bin/bash: line 4: ./a.sh: No such file or directory'],
    // cat names its own file, not the shell.
    ["cd /w && cat > src/a.ts <<'EOF'\nx\nEOF\ncat src/a.ts", 'Exit code 1\ncat: src/a.ts: No such file or directory'],
    ["cat > \"$D/a.ts\" <<'EOF'\nx\nEOF\ncat src/a.ts", 'Exit code 1\ncat: src/a.ts: No such file or directory'],
    // An exact target needs the whole path.
    ["cat > src/x/a.ts <<'EOF'\nx\nEOF\nnode b.js", 'Exit code 1\n/usr/bin/bash: line 1: lib/src/x/a.ts: No such file or directory'],
    // An inline script's output file is not a heredoc write.
    ["python3 - <<'EOF' > out/r.json\nprint(1)\nEOF", 'Exit code 1\n/usr/bin/bash: line 1: out/r.json: No such file or directory'],
  ]) {
    assert.deepEqual(heredocRows(line, text), [], `${line}: ${text}`);
  }
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

// ---- check time (1.6.13) ----

const RUN_CHECKS_LINE = 'python3 C:/u/skill/scripts/run-checks --cmd test npm test';
const TASK_CHECKS_LINE = 'python3 C:/u/skill/scripts/task-checks C:/u/wt --unit A1';

test('a foreground helper check call is check time, not a long tool call', () => {
  const call = (command) => detect([use(0, 'b1', 'Bash', { command }), res(300, 'b1', 'Bash', 'ok')]);
  for (const command of [RUN_CHECKS_LINE, TASK_CHECKS_LINE]) {
    const out = call(command);
    assert.deepEqual(out.slowdowns, [], command);
    assert.deepEqual(out.suggestions, [], command);
    assert.deepEqual(out.check_time, [[0, 300]], command);
  }
  // A direct test command stays a long tool call: its suggestion is about it.
  const direct = call('npm test');
  assert.deepEqual(brief(direct), [['long_tool_call', at(0), 300, 'measured', null]]);
  assert.equal(direct.slowdowns[0].evidence.check, 'test#1');
  assert.deepEqual(direct.check_time, []);
});

test('a procedure\'s start and wait calls are check time, each over its own time', () => {
  // A backgrounded run-checks --out F start and two await-checks wait F
  // calls; the model turns between them (1-2, 200-210) are no check time.
  const F = 'C:/u/plans/p.ledger/checks/final-fix.1.json';
  const out = detect([
    use(0, 'b1', 'Bash', { command: `python3 C:/u/skill/scripts/run-checks C:/u/wt --out ${F} --cmd test npm test`,
      run_in_background: true }), res(1, 'b1', 'Bash', 'Command running in background with ID: bx1.'),
    use(2, 'w1', 'Bash', { command: `python3 C:/u/skill/scripts/await-checks wait ${F}` }),
    res(200, 'w1', 'Bash', 'Exit code 4\n{"status": "running"}', true),
    use(210, 'w2', 'Bash', { command: `python3 C:/u/skill/scripts/await-checks wait ${F}` }),
    res(330, 'w2', 'Bash', '{"ok": true}'),
  ]);
  assert.deepEqual(out.slowdowns, []);
  assert.deepEqual(out.check_time, [[0, 1], [2, 200], [210, 330]]);
});

test('a helper call that hits its timeout keeps the timeout row, with no check time in it', () => {
  // Review focus 1: the check_time row of the call folds into the timeout row
  // silently; the timeout row already names the call.
  const out = detect([use(0, 'b1', 'Bash', { command: RUN_CHECKS_LINE }),
    res(120, 'b1', 'Bash', 'Command timed out after 2m 0s')]);
  assert.ok(out.found.includes('check_time'), out.found.join(' '));
  assert.deepEqual(out.slowdowns.map((s) => [s.kind, s.at, s.cost_s, s.span_s, s.contains, s.evidence.check]),
    [['timeout', at(0), 120, 120, [], 'run-checks']]);
  assert.deepEqual(out.check_time, []);
});

test('an edit retry around a helper call keeps only its own time', () => {
  // Review focus 2 (the m1a and r151 shape): the check time is not handed to
  // the edit_retry window that holds it.
  const NOT_READ = '<tool_use_error>File has not been read yet.</tool_use_error>';
  const out = detect([
    use(0, 'e1', 'Edit', { file_path: 'a.js' }, 'm1'), res(1, 'e1', 'Edit', NOT_READ, true),
    use(10, 'b1', 'Bash', { command: RUN_CHECKS_LINE }, 'm2'), res(310, 'b1', 'Bash', 'ok'),
    use(320, 'e2', 'Edit', { file_path: 'a.js' }, 'm3'), res(321, 'e2', 'Edit', 'ok'),
  ]);
  assert.deepEqual(out.slowdowns.map((s) => [s.kind, s.at, s.cost_s, s.span_s, s.contains]),
    [['edit_retry', at(0), 21, 321, []]]);
  assert.deepEqual(out.check_time, [[10, 310]]);
});

test('a rerun of a helper call stays a check rerun', () => {
  // check_rerun still applies to a helper call: the rerun row keeps the
  // second call's time, and only the first call is check time.
  const out = detect([
    use(0, 'b1', 'Bash', { command: RUN_CHECKS_LINE }), res(5, 'b1', 'Bash', 'ok'),
    use(10, 'r1', 'Read', { file_path: 'README.md' }), res(11, 'r1', 'Read', 'x'),
    use(20, 'b2', 'Bash', { command: RUN_CHECKS_LINE }), res(25, 'b2', 'Bash', 'ok'),
  ]);
  assert.deepEqual(brief(out), [['check_rerun', at(20), 5, 'measured', 'run-checks']]);
  assert.deepEqual(out.check_time, [[0, 5]]);
});

test('slowdowns that overlap in time are counted once in the stake', () => {
  // Three Edits sent together while a long Bash call runs; each fails as
  // unread when its result comes back, queued behind the Bash call (so they
  // start at 123, 124 and 125). The retries, sent together, succeed at 130,
  // 131 and 132: the spans overlap, so they are one row from 123 to 132.
  const unread = '<tool_use_error>File has not been read yet.</tool_use_error>';
  const events = [use(0, 'b1', 'Bash', { command: 'npm run build' })];
  for (const f of ['a', 'b', 'c']) events.push(use(0, `e${f}`, 'Edit', { file_path: `${f}.js` }));
  events.push(res(123, 'b1', 'Bash', 'built'));
  ['a', 'b', 'c'].forEach((f, i) => events.push(res(124 + i, `e${f}`, 'Edit', unread, true)));
  for (const f of ['a', 'b', 'c']) events.push(use(126, `f${f}`, 'Edit', { file_path: `${f}.js` }));
  ['a', 'b', 'c'].forEach((f, i) => events.push(res(130 + i, `f${f}`, 'Edit', 'ok')));
  const out = detect(events);
  const retries = out.slowdowns.filter((s) => s.kind === 'edit_retry');
  assert.deepEqual(retries.map((s) => [s.at, s.cost_s, s.span_s, s.merged]), [[at(123), 9, 9, 3]]);
  const g = out.suggestions.find((s) => s.kind === 'edit_retry');
  assert.deepEqual([g.count, g.stake_s], [1, 9]);
  // The long call's span ends at 123, where the retries start: they touch and
  // share no time.
  assert.equal(out.suggestions.find((s) => s.kind === 'long_tool_call').stake_s, 123);
});

// The public rows settle_slowdowns leaves of internal rows built with
// _slowdown, each {kind, start, end}: of agent X unless runWide, and with an
// unknown cost (its covers kept) when unknown; costKind and marker, when
// given, are the row's cost_kind and evidence marker. Each row comes back as
// [kind, at, cost_s, span_s, merged, contains], and whole in public; inputs is
// whether the input rows are unchanged.
function settle(rows) {
  return python([
    'import _autopsy',
    'X = {"entry": {"label": "X"}}',
    'rows = []',
    `for r in json.loads(${JSON.stringify(JSON.stringify(rows))}):`,
    '    sd = _autopsy._slowdown(r["kind"], None if r.get("runWide") else X, r["start"], r["end"],',
    '                            r.get("costKind") or ("unavailable" if r.get("unknown") else "measured"),',
    '                            marker=r.get("marker"))',
    '    if r.get("unknown"):',
    '        sd["_cost"] = None',
    '    rows.append(sd)',
    'before = repr(rows)',
    'out = [_autopsy.public_slowdown(s) for s in _autopsy.settle_slowdowns(rows)]',
    'print(json.dumps({"rows": [[s["kind"], s["at"], s["cost_s"], s["span_s"], s["merged"], s["contains"]]',
    '                           for s in out], "public": out, "inputs": repr(rows) == before}))',
  ]);
}

test('overlapping rows of one kind and one agent are one row', () => {
  const unread = '<tool_use_error>File has not been read yet.</tool_use_error>';
  const events = [];
  for (const f of ['a', 'b', 'c']) events.push(use(0, `e${f}`, 'Edit', { file_path: `${f}.js` }, 'm1'));
  ['a', 'b', 'c'].forEach((f, i) => events.push(res(1 + i / 10, `e${f}`, 'Edit', unread, true)));
  events.push(use(2, 'fa', 'Edit', { file_path: 'a.js' }, 'm2'), res(20, 'fa', 'Edit', 'ok'));
  events.push(use(20.5, 'fb', 'Edit', { file_path: 'b.js' }, 'm3'), res(21, 'fb', 'Edit', 'ok'));
  events.push(use(22, 'fc', 'Edit', { file_path: 'c.js' }, 'm4'), res(25, 'fc', 'Edit', 'ok'));
  const out = detect(events);
  // 0-20, 1-21 and 1.1-25 merge: the earliest start, the union's length.
  assert.deepEqual(out.slowdowns.map((s) => [s.kind, s.at, s.cost_s, s.span_s, s.merged, s.contains]),
    [['edit_retry', at(0), 25, 25, 3, []]]);
  assert.equal(out.slowdowns[0].evidence.marker, 'has not been read yet');
  const g = out.suggestions.find((s) => s.kind === 'edit_retry');
  assert.deepEqual([g.count, g.stake_s, g.slowdowns], [1, 25, [0]]);
});

test('each second of an agent is charged to one row, by tier', () => {
  const unread = '<tool_use_error>File has not been read yet.</tool_use_error>';
  const out = detect([
    use(0, 'b1', 'Bash', { command: 'npm run e2e' }, 'm1'),
    use(100, 'e1', 'Edit', { file_path: 'a.js' }, 'm2'),
    res(101, 'e1', 'Edit', unread, true),
    res(120, 'b1', 'Bash', 'Command timed out after 2m 0s'),
    use(150, 'e2', 'Edit', { file_path: 'a.js' }, 'm3'),
    res(160, 'e2', 'Edit', 'ok'),
  ]);
  // The timeout (tier 1) keeps 0-120; the edit_retry's window 100-160 keeps
  // only 120-160.
  const rows = out.slowdowns.map((s) => [s.kind, s.at, s.cost_s, s.span_s]);
  assert.deepEqual(rows, [['timeout', at(0), 120, 120], ['edit_retry', at(100), 40, 60]]);
  // The agent's row costs add up to the union of their spans, 0-160.
  assert.equal(rows.reduce((n, r) => n + r[2], 0), 160);
  assert.deepEqual(out.suggestions.map((g) => [g.kind, g.stake_s]), [['timeout', 120], ['edit_retry', 40]]);
});

test('a tier 3 window inside a whole-agent row keeps its own time', () => {
  // The r150 H3 implement shape (r162's extra_review_round with an
  // edit_retry is the same pair of tiers).
  assert.deepEqual(settle([
    { kind: 'escalation', start: 0, end: 300 },
    { kind: 'edit_retry', start: 40, end: 80 },
  ]).rows, [
    ['escalation', at(0), 260, 300, 1, []],
    ['edit_retry', at(40), 40, 40, 1, []],
  ]);
});

test('a zero-length row folds into the row that holds its instant', () => {
  const out = settle([
    { kind: 'timeout', start: 0, end: 120 },
    { kind: 'edit_retry', start: 50, end: 50 },
    { kind: 'check_rerun', start: 120, end: 120 },
    { kind: 'edit_retry', start: 200, end: 200 },
  ]);
  // The instant may sit on the edge of the row's time (120).
  assert.deepEqual(out.rows, [
    ['timeout', at(0), 120, 120, 1, ['check_rerun', 'edit_retry']],
    ['edit_retry', at(200), 0, 0, 1, []],
  ]);
  assert.equal(out.inputs, true);
});

test('within a tier the shorter row is charged first', () => {
  // The run2 shape: an edit_retry inside a heredoc failure's window to its
  // recovery.
  assert.deepEqual(settle([
    { kind: 'heredoc_failure', start: 0, end: 32 },
    { kind: 'edit_retry', start: 10, end: 32 },
  ]).rows, [
    ['heredoc_failure', at(0), 10, 32, 1, []],
    ['edit_retry', at(10), 22, 22, 1, []],
  ]);
});

test('a row inside a higher row is folded into it', () => {
  assert.deepEqual(settle([
    { kind: 'timeout', start: 0, end: 120 },
    { kind: 'long_tool_call', start: 10, end: 100 },
  ]).rows, [['timeout', at(0), 120, 120, 1, ['long_tool_call']]]);
  // A whole-agent row (tier 4) yields to the long call (tier 2).
  assert.deepEqual(settle([
    { kind: 'retry', start: 0, end: 300 },
    { kind: 'long_tool_call', start: 50, end: 180 },
  ]).rows, [
    ['retry', at(0), 170, 300, 1, []],
    ['long_tool_call', at(50), 130, 130, 1, []],
  ]);
});

test('check time is charged in the second tier and never folds into a public row by name', () => {
  // Review focus 2: a fix agent's extra_review_round (a whole-agent row,
  // 0-400) keeps only its own time around a helper call (50-350).
  assert.deepEqual(settle([
    { kind: 'extra_review_round', start: 0, end: 400 },
    { kind: 'check_time', start: 50, end: 350 },
  ]).rows, [
    ['extra_review_round', at(0), 100, 400, 1, []],
    ['check_time', at(50), 300, 300, 1, []],
  ]);
  // Review focus 1: a check_time row inside a timeout row is dropped without
  // a trace, at any length, a zero-length one included.
  assert.deepEqual(settle([
    { kind: 'timeout', start: 0, end: 120 },
    { kind: 'check_time', start: 0, end: 120 },
    { kind: 'check_time', start: 60, end: 60 },
  ]).rows, [['timeout', at(0), 120, 120, 1, []]]);
  // Before a long tool call of the same span, in the order of the tier.
  assert.deepEqual(settle([
    { kind: 'long_tool_call', start: 0, end: 200 },
    { kind: 'check_time', start: 0, end: 200 },
  ]).rows, [['check_time', at(0), 200, 200, 1, ['long_tool_call']]]);
});

test('a row that took nothing folds into the row that took most of its span', () => {
  // The 20 s holder is the earlier one; the 40 s holder takes the fold.
  assert.deepEqual(settle([
    { kind: 'long_tool_call', start: 0, end: 20 },
    { kind: 'check_rerun', start: 20, end: 60 },
    { kind: 'repeated_failure', start: 0, end: 60 },
  ]).rows, [
    ['long_tool_call', at(0), 20, 20, 1, []],
    ['check_rerun', at(20), 40, 40, 1, ['repeated_failure']],
  ]);
});

test('two equal shares at epoch times fold into the earlier holder', () => {
  // Real timestamps are epoch seconds with milliseconds: the two 0.1 s shares
  // differ as floats, but are equal to the millisecond.
  const T0 = 1791613911.832;
  const out = settle([
    { kind: 'timeout', start: T0 + 0.1, end: T0 + 0.3 },
    { kind: 'background_check', start: T0 + 0.3, end: T0 + 1.0 },
    { kind: 'long_tool_call', start: T0 + 0.2, end: T0 + 0.4 },
  ]);
  assert.deepEqual(out.rows.map(([kind, _at, cost, span, _merged, contains]) => [kind, cost, span, contains]), [
    ['timeout', 0.2, 0.2, ['long_tool_call']],
    ['background_check', 0.7, 0.7, []],
  ]);
});

test('a merge keeps the weakest cost_kind and the earliest row\'s evidence', () => {
  // The later row is bound and listed first; the earlier is measured.
  const out = settle([
    { kind: 'edit_retry', start: 10, end: 30, costKind: 'bound', marker: 'has been modified since' },
    { kind: 'edit_retry', start: 0, end: 20, costKind: 'measured', marker: 'has not been read yet' },
  ]);
  assert.deepEqual(out.rows, [['edit_retry', at(0), 30, 30, 2, []]]);
  assert.deepEqual([out.public[0].cost_kind, out.public[0].evidence.marker], ['bound', 'has not been read yet']);
});

test('a row of unknown cost is never merged, charged or folded', () => {
  // Review focus 3: a background run without an observed completion, beside
  // a known one of the same kind over the same time.
  assert.deepEqual(settle([
    { kind: 'background_check', start: 10, end: 60, unknown: true },
    { kind: 'background_check', start: 0, end: 50 },
  ]).rows, [
    ['background_check', at(10), 'unavailable', 'unavailable', 1, []],
    ['background_check', at(0), 50, 50, 1, []],
  ]);
});

test('idle gaps, the only run-wide rows, are never merged, charged or folded', () => {
  // A run-wide row over an agent's edit_retry, and two idle gaps that touch.
  // Relaunch rows are not run-wide: they cover the redone agents' own time.
  assert.deepEqual(settle([
    { kind: 'idle_gap', start: 0, end: 300, runWide: true },
    { kind: 'edit_retry', start: 40, end: 80 },
    { kind: 'idle_gap', start: 300, end: 400, runWide: true },
    { kind: 'idle_gap', start: 400, end: 500, runWide: true },
  ]).rows, [
    ['idle_gap', at(0), 300, 300, 1, []],
    ['edit_retry', at(40), 40, 40, 1, []],
    ['idle_gap', at(300), 100, 100, 1, []],
    ['idle_gap', at(400), 100, 100, 1, []],
  ]);
});

// ---- relaunches: the work a later launch ran again ----

// A run folder of several launches, laid out as buildRun in
// tests/autopsy-check-policy.test.mjs lays one out: launches [{start, s,
// agents: [{label, phase, start, end}]}], s the launch's wall time, and a
// manifest listing the task ids. An agent's transcript is its prompt at start
// and a last assistant line at end; an agent given neither has lines without
// a timestamp (untimed). An agent's model tier (sonnet unless given as model)
// is requested in its meta and resolved in its assistant line.
function buildLaunches(launches, tasks = ['A1', 'B1', 'C1']) {
  copies += 1;
  const dir = join(TMP, `launches${copies}`);
  mkdirSync(join(dir, 'p.f9.ledger'), { recursive: true });
  writeFileSync(join(dir, 'p.f9.ledger', '_run.jsonl'), `${JSON.stringify({ event: 'run_started', run_id: 'f9' })}\n`);
  writeFileSync(join(dir, 'p.lanes.json'), JSON.stringify({
    version: 1, run_id: 'f9', plan: 'C:/src/plans/p.md', spec: null,
    repo: { mode: 'git', root: 'C:/src/proj', branch: 'feat', base: 'main', worktree_root: 'C:/src/proj-wt',
      ledger_dir: 'C:/src/plans/p.f9.ledger' },
    commands: { setup: [], test: ['npm test'], lint: [], build: [] },
    prelude: [],
    lanes: [{ id: 'a', name: 'Lane a', tasks: tasks.map((id) => ({ id, title: id, tier: 'standard' })) }],
    join: [],
  }, null, 2));
  const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  launches.forEach((launch, i) => {
    const wf = `wf_${i + 1}`;
    const last = i === launches.length - 1;
    writeFileSync(join(dir, `${wf}.json`), JSON.stringify({
      runId: wf, workflowName: 'parallel-lanes', status: last ? 'completed' : 'stopped',
      startTime: Date.parse(T(launch.start)), durationMs: launch.s * 1000,
      result: { status: last ? 'complete' : 'stopped', run_id: 'f9', version: '1.6.11' },
    }));
    mkdirSync(join(dir, wf));
    launch.agents.forEach((a, k) => {
      const id = `${i + 1}x${k + 1}`;
      const model = a.model || 'sonnet';
      writeFileSync(join(dir, wf, `agent-${id}.meta.json`), JSON.stringify({
        agentType: 'workflow-subagent', description: a.label, workflowPhase: a.phase || 'Lane a', model }));
      // Claude Code's API error message: model <synthetic>, zero usage.
      const synthetic = { type: 'assistant', timestamp: a.end && T(a.end), isApiErrorMessage: true, message: {
        id: `s_${id}`, role: 'assistant', model: '<synthetic>', stop_reason: 'stop_sequence',
        content: [{ type: 'text', text: 'API Error' }],
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } };
      const lines = [
        { type: 'user', timestamp: a.start && T(a.start), message: { role: 'user', content: 'Do the task.' } },
        a.synthetic === 'only' ? synthetic : { type: 'assistant', timestamp: a.end && T(a.end), message: {
          id: `m_${id}`, role: 'assistant', model: `claude-${model}-4-6`, stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Done.' }], usage } },
        ...(a.synthetic === 'end' ? [synthetic] : []),
      ];
      writeFileSync(join(dir, wf, `agent-${id}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    });
  });
  return dir;
}

// Launch 1 (10:00:00-10:12:15): pre-flight 120 s, A1 implement 600 s and
// B1 implement 480 s side by side, then B1 review 100 s. Launch 2
// (11:00:00-11:02:45): pre-flight 60 s and B1 review 90 s.
const PRE_FLIGHT = { label: 'pre-flight', phase: 'Pre-flight', start: '10:00:05', end: '10:02:05' };
const A1_IMPLEMENT = { label: 'A1 implement', start: '10:02:10', end: '10:12:10' };
const B1_IMPLEMENT = { label: 'B1 implement', start: '10:02:10', end: '10:10:10' };
const B1_REVIEW = { label: 'B1 review', start: '10:10:20', end: '10:12:00' };
const firstLaunch = (agents = [PRE_FLIGHT, A1_IMPLEMENT, B1_IMPLEMENT, B1_REVIEW]) => (
  { start: '10:00:00', s: 735, agents });
const secondLaunch = (agents = [
  { label: 'pre-flight', phase: 'Pre-flight', start: '11:00:05', end: '11:01:05' },
  { label: 'B1 review', start: '11:01:10', end: '11:02:40' },
]) => ({ start: '11:00:00', s: 165, agents });
const LAUNCH_KEYS = ['kept_agents', 'redone_agents', 'kept_s', 'redone_s', 'redone_agent_s'];
const counts = (launch) => LAUNCH_KEYS.map((k) => launch[k]);
const rowOf = (s) => [s.agent, s.at, s.cost_s, s.cost_kind, s.span_s, s.merged, s.contains];
const ofKind = (analysis, kind) => analysis.slowdowns.filter((s) => s.kind === kind);

test('a relaunch costs only the agent time a later launch ran again', () => {
  // run2: wf_2 runs A1 implement again, so wf_1's only agent was redone.
  assert.deepEqual(ofKind(S, 'relaunch').map(rowOf), [[null, T('08:00:00'), 280, 'measured', 280, 1, []]]);
  assert.deepEqual(counts(S.launches[0]), [0, 1, 0, 280, 280]);
  assert.deepEqual(counts(S.launches[1]), [9, 0, 985, 0, 0]);
  // It still has the largest stake (idle_gap's is 240 s).
  assert.deepEqual(S.suggestions.slice(0, 2).map((g) => [g.kind, g.stake_s]), [['relaunch', 280], ['idle_gap', 240]]);
});

test('an agent is redone when a later launch ran its task and role, or its role without a task', () => {
  const D = autopsy(buildLaunches([firstLaunch(), secondLaunch()])).json;
  // pre-flight and B1 review ran again; A1 implement did not, and B1
  // implement did not either (launch 2 ran only B1's review).
  assert.deepEqual(ofKind(D, 'relaunch').map(rowOf), [[null, T('10:00:00'), 220, 'measured', 220, 1, []]]);
  assert.deepEqual(counts(D.launches[0]), [2, 2, 600, 220, 220]);
  assert.deepEqual(counts(D.launches[1]), [2, 0, 150, 0, 0]);
  // A task done earlier and run again later is redone; redone_s is the wall
  // time the redone agents covered, redone_agent_s and the cost their sum.
  const again = autopsy(buildLaunches([firstLaunch(), secondLaunch([
    { label: 'pre-flight', phase: 'Pre-flight', start: '11:00:05', end: '11:01:05' },
    { label: 'A1 implement', start: '11:01:10', end: '11:05:00' },
    { label: 'B1 implement', start: '11:01:10', end: '11:04:00' },
  ])])).json;
  assert.deepEqual(counts(again.launches[0]), [1, 3, 100, 720, 1200]);
  assert.deepEqual(ofKind(again, 'relaunch').map(rowOf), [[null, T('10:00:00'), 1200, 'measured', 1200, 1, []]]);
});

test('a redone agent without timestamps makes the relaunch cost unavailable, never 0', () => {
  // Review focus 1.
  const dir = buildLaunches([firstLaunch([PRE_FLIGHT, A1_IMPLEMENT, B1_IMPLEMENT, { label: 'B1 review' }]),
    secondLaunch()]);
  const res = runCli(dir);
  assert.equal(res.code, 0, res.stderr);
  const D = JSON.parse(readFileSync(join(dir, 'autopsy.json'), 'utf8'));
  assert.deepEqual(ofKind(D, 'relaunch').map(rowOf),
    [[null, T('10:00:00'), 'unavailable', 'unavailable', 'unavailable', 1, []]]);
  assert.deepEqual(counts(D.launches[0]), [2, 2, 600, 'unavailable', 'unavailable']);
  assert.equal(D.suggestions.find((g) => g.kind === 'relaunch').stake_s, 'unavailable');
  assert.match(res.md, /^- Earlier launches: kept 2 agents, redid 2 \(agent time unavailable\)$/m);
  assert.match(res.stdout, /^earlier launches: kept 2 agents, redid 2 \(agent time unavailable\)$/m);
});

test('an earlier launch with nothing redone keeps its relaunch row at 0', () => {
  // Review focus 2: launch 2 runs only a new task, C1.
  const dir = buildLaunches([firstLaunch(), { start: '11:00:00', s: 100,
    agents: [{ label: 'C1 implement', start: '11:00:05', end: '11:01:35' }] }]);
  const res = runCli(dir);
  assert.equal(res.code, 0, res.stderr);
  const D = JSON.parse(readFileSync(join(dir, 'autopsy.json'), 'utf8'));
  assert.deepEqual(ofKind(D, 'relaunch').map(rowOf), [[null, T('10:00:00'), 0, 'measured', 0, 1, []]]);
  assert.deepEqual(counts(D.launches[0]), [4, 0, 720, 0, 0]);
  assert.deepEqual(D.suggestions.filter((g) => g.kind === 'relaunch').map((g) => [g.stake_s, g.count]), [[0, 1]]);
  assert.match(res.md, /^- Earlier launches: kept 4 agents, redid 0 \(0\.0 s of agent time\)$/m);
});

test('an agent both retried and redone is charged to the retry first', () => {
  // Review focus 3: launch 1's B1 review is a retry, and launch 2 runs B1
  // review again. The retry keeps the agent's 100 s; the relaunch the rest.
  const retried = { ...B1_REVIEW, label: 'B1 review retry' };
  const D = autopsy(buildLaunches([firstLaunch([PRE_FLIGHT, A1_IMPLEMENT, B1_IMPLEMENT, retried]),
    secondLaunch()])).json;
  assert.deepEqual(ofKind(D, 'retry').map(rowOf), [['B1 review retry', T('10:10:20'), 100, 'measured', 100, 1, []]]);
  assert.deepEqual(ofKind(D, 'relaunch').map(rowOf), [[null, T('10:00:00'), 120, 'measured', 220, 1, []]]);
  assert.deepEqual(counts(D.launches[0]), [2, 2, 600, 220, 220]);
  // With nothing else redone the relaunch takes nothing: it folds into the
  // retry row (as its own tier, after the whole-agent rows, though its at,
  // the launch start, is earlier and its span the same).
  const folded = autopsy(buildLaunches([firstLaunch([{ ...A1_IMPLEMENT, start: '10:00:05' }, retried]),
    secondLaunch([{ label: 'B1 review', start: '11:00:05', end: '11:02:40' }])])).json;
  assert.deepEqual(ofKind(folded, 'retry').map(rowOf),
    [['B1 review retry', T('10:10:20'), 100, 'measured', 100, 1, ['relaunch']]]);
  assert.deepEqual(ofKind(folded, 'relaunch'), []);
  assert.deepEqual(counts(folded.launches[0]), [1, 1, 725, 100, 100]);
});

test('relaunch is the fifth charging tier, after the whole-agent rows', () => {
  const tiers = python(['import _autopsy', 'print(json.dumps(_autopsy.CHARGE_TIERS))']);
  assert.equal(tiers.length, 5);
  assert.deepEqual(tiers[1], ['check_time', 'long_tool_call', 'check_rerun']);
  assert.deepEqual(tiers[3], ['retry', 'escalation', 'extra_review_round']);
  assert.deepEqual(tiers[4], ['relaunch']);
});

test('the charging tiers hold every kind but idle_gap, and the internal check_time', () => {
  assert.deepEqual(python(['import _autopsy',
    'tiered = set(k for tier in _autopsy.CHARGE_TIERS for k in tier)',
    'print(json.dumps([(tiered - {"check_time"}) | {"idle_gap"} == set(_autopsy.KINDS),',
    '                  "check_time" in _autopsy.KINDS, "check_time" in _autopsy.TOOL_KINDS]))']),
  [true, false, false]);
});

test('an extra review round with an untimed fix or re-review costs unavailable', () => {
  // One launch: A1 implement and review, then a fix and a re-review, one of
  // them without timestamps.
  const round = (fix, reReview) => autopsy(buildLaunches([{ start: '10:00:00', s: 735, agents: [
    { label: 'A1 implement', start: '10:00:05', end: '10:05:00' },
    { label: 'A1 review', start: '10:05:10', end: '10:06:00' },
    { label: 'A1 fix 1', ...fix },
    { label: 'A1 re-review 1', ...reReview },
  ] }])).json;
  const FIX = { start: '10:06:10', end: '10:08:00' };
  const RE_REVIEW = { start: '10:08:10', end: '10:09:00' };
  const roundRow = (D) => ofKind(D, 'extra_review_round').map((s) => [s.cost_s, s.cost_kind, s.span_s]);
  assert.deepEqual(roundRow(round(FIX, RE_REVIEW)), [[160, 'measured', 160]]);
  assert.deepEqual(roundRow(round({}, RE_REVIEW)), [['unavailable', 'unavailable', 'unavailable']]);
  assert.deepEqual(roundRow(round(FIX, {})), [['unavailable', 'unavailable', 'unavailable']]);
});

test('a retry or escalation of an untimed agent costs unavailable', () => {
  // One launch: B1 implement at sonnet, then again at opus (an escalation),
  // and a B1 review retry. Untimed, every agent lacks timestamps, so they
  // keep their file order.
  const at = (timed, start, end) => (timed ? { start, end } : {});
  const launch = (timed) => autopsy(buildLaunches([{ start: '10:00:00', s: 735, agents: [
    { label: 'B1 implement', ...at(timed, '10:00:05', '10:05:00') },
    { label: 'B1 implement', model: 'opus', ...at(timed, '10:05:10', '10:08:00') },
    { label: 'B1 review retry', ...at(timed, '10:08:10', '10:09:00') },
  ] }])).json;
  const rows = (D) => ['escalation', 'retry'].map((kind) => ofKind(D, kind).map(rowOf));
  assert.deepEqual(rows(launch(true)), [
    [['B1 implement', T('10:05:10'), 170, 'measured', 170, 1, []]],
    [['B1 review retry', T('10:08:10'), 50, 'measured', 50, 1, []]],
  ]);
  const NONE = ['unavailable', 'unavailable', 'unavailable', 'unavailable', 1, []];
  assert.deepEqual(rows(launch(false)), [[['B1 implement', ...NONE]], [['B1 review retry', ...NONE]]]);
});

test('an agent ended by an API error and retried at its own tier is no escalation', () => {
  // Review focus 4. B1 implement (opus) ends on a <synthetic> line and its
  // retry runs at opus; A1 implement has only a <synthetic> line, and its
  // retry runs at opus too. Neither is an escalation, so the retry rows
  // contain nothing.
  const res = autopsy(buildLaunches([{ start: '10:00:00', s: 735, agents: [
    { label: 'B1 implement', model: 'opus', synthetic: 'end', start: '10:00:05', end: '10:05:00' },
    { label: 'B1 implement retry', model: 'opus', start: '10:05:10', end: '10:08:00' },
    { label: 'A1 implement', model: 'opus', synthetic: 'only', start: '10:08:10', end: '10:08:20' },
    { label: 'A1 implement retry', model: 'opus', start: '10:08:30', end: '10:09:00' },
  ] }]));
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(ofKind(res.json, 'escalation'), []);
  assert.deepEqual(ofKind(res.json, 'retry').map(rowOf), [
    ['B1 implement retry', T('10:05:10'), 170, 'measured', 170, 1, []],
    ['A1 implement retry', T('10:08:30'), 30, 'measured', 30, 1, []],
  ]);
  assert.equal(res.json.detectors.escalation, 'ok');
  assert.ok(!res.text.includes('<synthetic>'), res.text);
});

test('an escalation row covers the review the engine runs again after it', () => {
  // After a review's changes the engine reruns implement at standard and
  // reviews the task again (rerunAtStandard): B1 review, B1 implement at
  // opus (the escalation), then B1 review once more, which joins the row.
  const B1 = { label: 'B1 implement', start: '10:00:05', end: '10:05:00' };
  const REVIEW = { label: 'B1 review', start: '10:05:10', end: '10:06:00' };
  const ESCALATED = { label: 'B1 implement', model: 'opus', start: '10:06:10', end: '10:09:00' };
  const SECOND = { label: 'B1 review', start: '10:09:10', end: '10:10:00' };
  const rows = (agents) => ofKind(autopsy(buildLaunches([{ start: '10:00:00', s: 735, agents }])).json, 'escalation')
    .map(rowOf);
  // 170 s of the escalated implement and 50 s of the second review.
  assert.deepEqual(rows([B1, REVIEW, ESCALATED, SECOND]), [['B1 implement', T('10:06:10'), 220, 'measured', 220, 1, []]]);
  // An untimed second review makes the cost unknown, never a part.
  assert.deepEqual(rows([B1, REVIEW, ESCALATED, { label: 'B1 review' }]),
    [['B1 implement', T('10:06:10'), 'unavailable', 'unavailable', 'unavailable', 1, []]]);
  // The task's next agent is an adjudicate: the review after it is not the
  // escalation's.
  assert.deepEqual(rows([B1, REVIEW, ESCALATED, { label: 'B1 adjudicate', start: '10:09:10', end: '10:09:40' },
    { ...SECOND, start: '10:09:50', end: '10:10:30' }]), [['B1 implement', T('10:06:10'), 170, 'measured', 170, 1, []]]);
  // Another task's agent between them changes nothing.
  assert.deepEqual(rows([B1, REVIEW, ESCALATED, { label: 'A1 implement', start: '10:09:05', end: '10:09:08' }, SECOND]),
    [['B1 implement', T('10:06:10'), 220, 'measured', 220, 1, []]]);
  // An implement escalated before any review of the task (run2's B1: it
  // failed at sonnet and ran again at opus) is followed by the task's first
  // review, which the escalation did not add.
  assert.deepEqual(rows([B1, { ...ESCALATED, start: '10:05:10', end: '10:08:00' }, SECOND]),
    [['B1 implement', T('10:05:10'), 170, 'measured', 170, 1, []]]);
  // Only an escalated implement gains the review after it: an escalated
  // review (B1 review at opus, then once more at opus) keeps its own time.
  assert.deepEqual(rows([B1, REVIEW, { ...ESCALATED, label: 'B1 review' }, { ...SECOND, model: 'opus' }]),
    [['B1 review', T('10:06:10'), 170, 'measured', 170, 1, []]]);
  assert.deepEqual(ofKind(S, 'escalation').map(rowOf), [['B1 implement', T('09:02:10'), 170, 'measured', 170, 1, []]]);
});

test('a run with one launch keeps all its agents and shows no launches table', () => {
  // Review focus 5: run1.
  assert.deepEqual(ofKind(A, 'relaunch'), []);
  assert.deepEqual([A.launches[0].kept_agents, A.launches[0].redone_agents], [A.time.agents.length, 0]);
  const res = runCli(copyRun(RUN1));
  assert.equal(res.code, 0, res.stderr);
  assert.ok(!res.md.includes('| Launch | Status |'), res.md);
  assert.ok(!/earlier launches/i.test(res.md), res.md);
  assert.ok(!/earlier launches/i.test(res.stdout), res.stdout);
});

test('autopsy.md opens Where time went with the launches table, and the summaries say what was redone', () => {
  const res = runCli(copyRun(RUN2));
  assert.equal(res.code, 0, res.stderr);
  const time = res.md.split('## Where time went\n\n')[1].split('\n## ')[0];
  assert.deepEqual(time.split('\n').slice(0, 4), [
    '| Launch | Status | Wall | Kept agents | Kept | Redone agents | Redone |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    '| wf_1 | stopped | 300.0 s | 0 | 0.0 s | 1 | 280.0 s |',
    '| wf_2 | complete | 1290.0 s | 9 | 985.0 s | 0 | 0.0 s |',
  ]);
  const summary = res.md.split('## Summary\n\n')[1].split('\n## ')[0];
  assert.match(summary, /^- Earlier launches: kept 0 agents, redid 1 \(280\.0 s of agent time\)$/m);
  assert.match(res.stdout, /^earlier launches: kept 0 agents, redid 1 \(280\.0 s of agent time\)$/m);
  assert.ok(res.stdout.split('\n').filter((l) => l !== '').length <= 15);
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

// ---- acceptance by the user ----
// ledger accept appends {"task": "_run", "event": "accepted", "head": <full
// sha>, "text": TEXT} to the ledger's _run.jsonl. run1 delivers 3333...3333
// and its _run.jsonl holds only a run_started event.

const DELIVERED = '3'.repeat(40);
const BY_USER = 'accepted by the user at the delivered head';

// A copy of run1 whose last result has acceptance status `status` (its one
// reason, checks_stale, kept) and delivers `delivered` (no delivered_sha when
// null), with `lines` appended to the ledger's _run.jsonl.
function acceptanceRun({ status = 'rejected', delivered = DELIVERED, lines = [] } = {}) {
  const dir = copyRun();
  const wfPath = join(dir, 'wf_1.json');
  const wf = JSON.parse(readFileSync(wfPath, 'utf8'));
  wf.result.acceptance.status = status;
  if (delivered === null) delete wf.result.delivered_sha;
  else wf.result.delivered_sha = delivered;
  writeFileSync(wfPath, JSON.stringify(wf, null, 2));
  editLines(join(dir, 'p.f1.ledger', '_run.jsonl'), (ls) => [...ls, ...lines]);
  return dir;
}

const acceptedAt = (head) => JSON.stringify({ task: '_run', event: 'accepted', head, text: 'ACCEPT-TEXT-9 by Someone' });

function byUser(dir) {
  const res = autopsy(dir);
  assert.equal(res.code, 0, res.stderr);
  return res.json.done.acceptance.accepted_by_user;
}

test('a user acceptance in the ledger is reported, its text never', () => {
  const dir = acceptanceRun({ lines: [acceptedAt(DELIVERED)] });
  const res = runCli(dir);
  assert.equal(res.code, 0, res.stderr);
  const json = readFileSync(join(dir, 'autopsy.json'), 'utf8');
  // status stays the run's own verdict; only the boolean is added.
  assert.deepEqual(JSON.parse(json).done.acceptance, {
    status: 'rejected', reasons: [{ kind: 'checks_stale', class: 'missing' }], warnings: 1, accepted_by_user: true,
  });
  const done = res.md.split('## What got done\n\n')[1].split('\n## ')[0];
  assert.ok(done.split('\n').includes(`- Acceptance: rejected (checks_stale: missing); warnings 1; ${BY_USER}`), done);
  const summary = res.md.split('## Summary\n\n')[1].split('\n## ')[0];
  assert.ok(summary.split('\n').includes(`- Acceptance: rejected; ${BY_USER}`), summary);
  assert.ok(res.stdout.split('\n').includes(`acceptance: rejected; ${BY_USER}`), res.stdout);
  assert.ok(res.stdout.split('\n').filter((l) => l !== '').length <= 15);
  // The event's text names a person: it never reaches any output.
  for (const [name, text] of [['autopsy.json', json], ['autopsy.md', res.md], ['summary', res.stdout]]) {
    for (const marker of ['ACCEPT-TEXT-9', 'Someone']) assert.ok(!text.includes(marker), `${name} holds ${marker}`);
  }
});

test('accepted_by_user needs an accepted event at the delivered head exactly', () => {
  // Review focus 4. An event at another head changes nothing, nor one whose
  // head is a prefix or another case of the delivered sha.
  for (const [delivered, head] of [[DELIVERED, '4'.repeat(40)], [DELIVERED, DELIVERED.slice(0, 7)],
    ['a'.repeat(40), 'A'.repeat(40)], [DELIVERED, null]]) {
    assert.equal(byUser(acceptanceRun({ delivered, lines: [acceptedAt(head)] })), false, String(head));
  }
  // Several events: true when any is at the delivered head, in either order.
  assert.equal(byUser(acceptanceRun({ lines: [acceptedAt(DELIVERED), acceptedAt('4'.repeat(40))] })), true);
  assert.equal(byUser(acceptanceRun({ lines: [acceptedAt('4'.repeat(40)), acceptedAt(DELIVERED)] })), true);
  // Lines that are not JSON objects are skipped; other events never count.
  assert.equal(byUser(acceptanceRun({ lines: ['not json {', '[1]', '"accepted"', 'null',
    JSON.stringify({ task: '_run', event: 'run_ended', head: DELIVERED }), acceptedAt(DELIVERED)] })), true);
  assert.equal(byUser(acceptanceRun({ lines: ['not json {',
    JSON.stringify({ task: '_run', event: 'run_ended', head: DELIVERED })] })), false);
  // No accepted event (run1 as archived): false, and nothing is added.
  const none = acceptanceRun();
  const res = runCli(none);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(JSON.parse(readFileSync(join(none, 'autopsy.json'), 'utf8')).done.acceptance.accepted_by_user, false);
  assert.ok(!res.md.includes(BY_USER), res.md);
  assert.ok(res.md.split('\n').includes('- Acceptance: rejected'), res.md);
  assert.ok(!res.stdout.split('\n').some((l) => l.startsWith('acceptance:')), res.stdout);
});

test('accepted_by_user is unavailable without a ledger, its _run.jsonl or a delivered sha', () => {
  const noLedger = acceptanceRun();
  rmSync(join(noLedger, 'p.f1.ledger'), { recursive: true });
  assert.equal(byUser(noLedger), 'unavailable');
  const noRunFile = acceptanceRun();
  rmSync(join(noRunFile, 'p.f1.ledger', '_run.jsonl'));
  assert.equal(byUser(noRunFile), 'unavailable');
  // A delivered sha must be 7-64 hex digits (l131's is see-below).
  for (const delivered of [null, 'see-below', '', 'abc123', 42]) {
    const dir = acceptanceRun({ delivered, lines: [acceptedAt(delivered)] });
    const res = runCli(dir);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(JSON.parse(readFileSync(join(dir, 'autopsy.json'), 'utf8')).done.acceptance.accepted_by_user,
      'unavailable', String(delivered));
    assert.ok(!res.md.includes(BY_USER), res.md);
    assert.ok(!res.stdout.split('\n').some((l) => l.startsWith('acceptance:')), res.stdout);
  }
  // Without an acceptance object there is no field to add.
  const noAcceptance = copyRun();
  const wfPath = join(noAcceptance, 'wf_1.json');
  const wf = JSON.parse(readFileSync(wfPath, 'utf8'));
  delete wf.result.acceptance;
  writeFileSync(wfPath, JSON.stringify(wf, null, 2));
  editLines(join(noAcceptance, 'p.f1.ledger', '_run.jsonl'), (ls) => [...ls, acceptedAt(DELIVERED)]);
  const D = autopsy(noAcceptance);
  assert.equal(D.code, 0, D.stderr);
  assert.equal(D.json.done.acceptance, 'unavailable');
});

test('a run the engine accepted adds nothing for a user acceptance', () => {
  const dir = acceptanceRun({ status: 'accepted', lines: [acceptedAt(DELIVERED)] });
  const res = runCli(dir);
  assert.equal(res.code, 0, res.stderr);
  const acc = JSON.parse(readFileSync(join(dir, 'autopsy.json'), 'utf8')).done.acceptance;
  assert.deepEqual([acc.status, acc.accepted_by_user], ['accepted', true]);
  assert.ok(!res.md.includes(BY_USER), res.md);
  assert.ok(res.md.split('\n').includes('- Acceptance: accepted (checks_stale: missing); warnings 1'), res.md);
  assert.ok(res.md.split('\n').includes('- Acceptance: accepted'), res.md);
  assert.ok(!res.stdout.split('\n').some((l) => l.startsWith('acceptance:')), res.stdout);
});

// ---- commit counts ----
// A task's commits come from the ledger's committed and settled events
// (finish-task writes one per commit round), after its last started event
// with restart true. run1's b.jsonl holds B1's events; each case below
// replaces it with `lines` (null: no b.jsonl).

const sha = (c) => c.repeat(40);
const B1_START = { task: 'B1', event: 'started', base: sha('0') };
const committed = (commits, task = 'B1') => ({ task, event: 'committed', base: sha('0'), head: sha('9'), commits });
const settled = (extra = {}) => ({ task: 'B1', event: 'settled', outcome: 'park', base: sha('0'), head: sha('9'),
  ...extra });

function ledgerRun(lines) {
  const dir = copyRun();
  const path = join(dir, 'p.f1.ledger', 'b.jsonl');
  if (lines === null) rmSync(path);
  else writeFileSync(path, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return dir;
}

// done.tasks of each run folder, from done_section in one process.
const doneTasks = (dirs) => python([
  'import _autopsy',
  'out = []',
  `for d in json.loads(${JSON.stringify(JSON.stringify(dirs))}):`,
  '    with open(d + "/wf_1.json", encoding="utf-8") as f:',
  '        out.append(_autopsy.done_section(json.load(f)["result"], d)["tasks"])',
  'print(json.dumps(out))',
]);

test('a task\'s commits are the distinct commits of its ledger events', () => {
  const cases = [
    // One round, one commit.
    [[B1_START, committed([sha('2')])], 1],
    // A fix round writes its own event.
    [[B1_START, committed([sha('2')]), committed([sha('4')])], 2],
    // A commit listed twice (a finish-task rerun repeats its events) counts once.
    [[B1_START, committed([sha('2'), sha('4')]), committed([sha('5')]), committed([sha('5')])], 3],
    // A settled event's commits count too; an empty list adds none.
    [[B1_START, committed([sha('2')]), settled({ commits: [sha('4')] })], 2],
    [[B1_START, committed([sha('2')]), settled({ commits: [] })], 1],
    // Review focus 1: a plain started (a retry or a rerun) does not reset...
    [[B1_START, committed([sha('2')]), { ...B1_START, base: sha('2') }, committed([sha('4')])], 2],
    // ...a started with restart true does.
    [[B1_START, committed([sha('2')]), { ...B1_START, restart: true }, committed([sha('4')])], 1],
    [[B1_START, committed([sha('2')]), { ...B1_START, restart: true }], 'unavailable'],
    // Review focus 2: lines that are not JSON objects are skipped...
    [['not json {', '[1]', 'null', '"committed"', B1_START, committed([sha('2')])], 1],
    // ...and a committed or settled event without a commits list (an older
    // ledger) makes the count unavailable.
    [[B1_START, committed([sha('2')]), settled()], 'unavailable'],
    [[B1_START, committed([sha('2')]), { task: 'B1', event: 'committed', base: sha('0'), head: sha('9') }],
      'unavailable'],
    [[B1_START, committed([sha('2')]), settled({ commits: 'x' })], 'unavailable'],
    [[B1_START, committed([sha('2'), 'HEAD'])], 'unavailable'],
    // No committed or settled event, or no b.jsonl at all.
    [[B1_START], 'unavailable'],
    [null, 'unavailable'],
  ];
  const out = doneTasks(cases.map(([lines]) => ledgerRun(lines)));
  cases.forEach(([lines, want], i) => {
    assert.equal(out[i].B1.commits, want, JSON.stringify(lines));
    // A1's own events (a.jsonl) are untouched by B1's.
    assert.equal(out[i].A1.commits, 1, JSON.stringify(lines));
  });
});

test('every ledger file counts, and without a ledger every count is unavailable', () => {
  // B1's events may sit in any *.jsonl of the ledger (a.jsonl here).
  const elsewhere = ledgerRun(null);
  editLines(join(elsewhere, 'p.f1.ledger', 'a.jsonl'), (ls) => [...ls, JSON.stringify(committed([sha('2')]))]);
  const noLedger = copyRun();
  rmSync(join(noLedger, 'p.f1.ledger'), { recursive: true });
  const [moved, none] = doneTasks([elsewhere, noLedger]);
  assert.deepEqual([moved.A1.commits, moved.B1.commits], [1, 1]);
  assert.deepEqual([none.A1.commits, none.B1.commits], ['unavailable', 'unavailable']);
  // The range still comes from the result.
  assert.deepEqual(none.B1.range, [sha('0'), sha('3')]);
});

test('range is the result\'s [base, head] when both are SHAs, else null', () => {
  const cases = [
    [[sha('0'), sha('3')], [sha('0'), sha('3')]],
    [['abc1234', 'ABCDEF0'], ['abc1234', 'ABCDEF0']],
    [[sha('0')], null],
    [[sha('0'), 'HEAD'], null],
    [['', sha('3')], null],
    [[sha('0'), sha('3'), sha('4')], null],
    [[sha('0'), 3], null],
    [null, null],
    [undefined, null],
    ['0..3', null],
  ];
  const dirs = cases.map(([commits]) => {
    const dir = copyRun();
    const wfPath = join(dir, 'wf_1.json');
    const wf = JSON.parse(readFileSync(wfPath, 'utf8'));
    if (commits === undefined) delete wf.result.tasks.B1.commits;
    else wf.result.tasks.B1.commits = commits;
    writeFileSync(wfPath, JSON.stringify(wf, null, 2));
    return dir;
  });
  const out = doneTasks(dirs);
  cases.forEach(([commits, want], i) => {
    assert.deepEqual(out[i].B1.range, want, JSON.stringify(commits));
    // The count is the ledger's whatever the range.
    assert.equal(out[i].B1.commits, 2, JSON.stringify(commits));
  });
});

test('What got done prints each task\'s commit count', () => {
  const res = runCli(copyRun());
  assert.equal(res.code, 0, res.stderr);
  const done = res.md.split('## What got done\n\n')[1].split('\n## ')[0].split('\n');
  assert.ok(done.includes('- A1: done; 1 commit; rounds 1; tier standard'), done.join('\n'));
  assert.ok(done.includes('- B1: done; 2 commits; rounds 0; tier standard'), done.join('\n'));
  const none = runCli(ledgerRun(null));
  assert.equal(none.code, 0, none.stderr);
  assert.ok(none.md.split('\n').includes('- B1: done; commits unavailable; rounds 0; tier standard'), none.md);
  // No sha reaches autopsy.md.
  assert.ok(!res.md.includes(sha('2')) && !res.md.includes(sha('0')), res.md);
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

test('a long foreground run-checks call is check time: no row, no unexplained span', () => {
  // Review focus 3: verify's run-checks call runs 300 s (10:06:40-10:11:40).
  const dir = copyRun(RUN3);
  editLines(join(dir, 'wf_1', 'agent-v1.jsonl'), (lines) => lines.map((l) => l
    .replace('"timestamp":"2026-10-10T10:08:10.000Z"', '"timestamp":"2026-10-10T10:11:40.000Z"')
    .replace('"timestamp":"2026-10-10T10:09:00.000Z"', '"timestamp":"2026-10-10T10:12:00.000Z"')));
  const res = runCli(dir);
  assert.equal(res.code, 0, res.stderr);
  const text = readFileSync(join(dir, 'autopsy.json'), 'utf8');
  const D = JSON.parse(text);
  const verify = D.checks.executions.find((x) => x.agent === 'verify');
  assert.deepEqual([verify.check, verify.start, verify.s, verify.timing], ['run-checks', T('10:06:40'), 300, 'measured']);
  assert.deepEqual(D.slowdowns.filter((s) => s.agent === 'verify'), []);
  assert.ok(!D.slowdowns.some((s) => s.contains.includes('check_time')));
  assert.ok(!Object.keys(D.detectors).includes('check_time'));
  for (const out of [text, res.md, res.stdout]) assert.ok(!out.includes('check_time'));
  const inside = (u) => u.agent === 'verify' && u.start < T('10:11:40') && u.end > T('10:06:40');
  assert.deepEqual(D.unexplained.filter(inside), []);
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
  assert.match(md, /^Check calls with a test group: 3 \(\+1 inferred\)$/m);
});

test('the r150 parser probes are not check runs', () => {
  assert.equal(chained("cd '/w' && cat > \"/tmp/t5.py\" <<'EOF'\nfor cmd in ['python3 scripts/run-checks . --cmd lint l\\npython3 scripts/run-checks . --cmd test t']:\n    print(cmd)\nEOF\n'C:/py/python.exe' \"/tmp/t5.py\""), null);
  assert.equal(chained("cd '/w' && python -c \"\nimport _autopsy as A\nprint(A.match_check('curl http://x/#a && python3 scripts/run-checks . --cmd test t', []))\n\""), null);
});

test('a bare variable before a helper script runs it, as an interpreter does', () => {
  // The r140 and r162 shape: a shell variable holds the interpreter.
  assert.deepEqual(match('python=C:/u/py/python.exe; "$python" C:/u/skill/scripts/run-checks --cmd test npm-test'),
    R('run-checks', 'ran'));
  assert.deepEqual(match('"${PY}" C:/u/skill/scripts/task-checks a b'), R('task-checks'));
  // Options between them follow the interpreter rule.
  assert.deepEqual(match('"$PY" -B -X utf8 C:/u/skill/scripts/run-checks --cmd lint x'), R('run-checks'));
  assert.deepEqual(match('"$PY" -m run-checks --cmd test x'), null);
  // The await-checks helper is read the same way (the d1a reserve).
  assert.deepEqual(python(['import _autopsy',
    'print(json.dumps(_autopsy._await_call({"name": "Bash", "input": {"command":',
    '    "\\"$PY\\" C:/u/skill/scripts/await-checks reserve --root C:/u/l --name x"}})))']),
  ['reserve', ['--root', 'C:/u/l', '--name', 'x']]);
  // Review focus 4: a bare variable not followed by a helper script changes
  // nothing (these are the values on main).
  assert.equal(match('"$GIT" status'), null);
  assert.equal(match('"$PY" -c x'), null);
  assert.equal(match('$PY -c x'), null);
  assert.deepEqual(match('$X/run-checks --cmd test x'), R('run-checks', 'ran'));
});

test('match_check parses a configured command once', () => {
  const res = python([
    'import _autopsy',
    '_autopsy._check_words.cache_clear()',
    `checks = _autopsy.configured_checks(json.loads(${JSON.stringify(JSON.stringify(chainedManifest))}))`,
    'lines = ["npm test", "npm run lint && npm test -- a", "echo hi"]',
    'found = [_autopsy.match_check(line, checks, 0) for line in lines]',
    'print(json.dumps({"found": found, "misses": _autopsy._check_words.cache_info().misses}))',
  ]);
  assert.deepEqual(res, {
    found: [
      { check: 'test#1', certainty: 'ran', full_suite: 'ran' },
      { check: 'a.test#1', certainty: 'ran', full_suite: null },
      null,
    ],
    misses: 3,
  });
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
    task_check_calls: 'unavailable', project_test_runs: 'unavailable', repairs: 'unavailable', setup: 'unavailable',
    waits: 'unavailable',
    // 1.6.4: check time per command comes from the ledger's evidence files, not
    // the transcripts, so it is reported without tool events (run3 has none).
    commands: [], commands_unconfigured: { runs: 0, total_s: 0 }, commands_skipped: 0,
    widened: { targeted_median_s: 'unavailable', calls: [] },
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
  'Summary', 'What got done', 'Where time went', 'Launch conditions', 'Checks', 'Slowdowns', 'Tokens',
  'Suggestions', 'Open questions',
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
  assert.match(md, /^Check calls with a test group: 3$/m);
  assert.match(md, /implement: 3/);
  // One open-questions line per unexplained entry.
  const open = md.split('## Open questions')[1].split('\n').filter((l) => l.startsWith('- '));
  assert.equal(open.length, 1);
  // Slowdown rows are numbered from 1, and each suggestion names its rows.
  assert.match(md, /^\| 1 \| relaunch \|/m);
  assert.ok(!/^\| 0 \|/m.test(md));
  assert.match(md, /^1\. relaunch \(stake 280\.0 s, 1 time; slowdown row #1\):/m);
  // A row charged less than its span shows both.
  assert.match(md, /^\| \d+ \| heredoc_failure \| A1 implement \| 2026-10-10 09:01:50Z \| 10\.0 s \(upper bound\) \(of 32\.0 s\) \| tool Bash, exit 2, marker '<<', program cat \|$/m);
  assert.match(md, /^\| \d+ \| edit_retry \| A1 implement \| 2026-10-10 09:02:00Z \| 22\.0 s \| /m);
  // A row whose call ran a check names the check id.
  assert.match(md, /^\| \d+ \| check_rerun \| A1 implement \| 2026-10-10 09:03:40Z \| 40\.0 s \| tool Bash, program node, check test#1 \|$/m);
  // Paths are relative to the run folder.
  assert.ok(!md.includes(TMP));
});

test('autopsy.md shows how many detections a row holds and the kinds folded into it', () => {
  const row = (kind, cost, span, merged, contains) => ({
    kind, agent: 'X', at: at(0), cost_s: cost, cost_kind: 'measured', span_s: span, merged, contains,
    evidence: { tool: 'Bash', exit: null, marker: null, program: 'npm' },
  });
  const lines = python([
    'import _autopsy',
    `a = {"slowdowns": json.loads(${JSON.stringify(JSON.stringify([
      row('timeout', 120, 120, 1, ['edit_retry', 'long_tool_call']),
      row('edit_retry', 25, 25, 3, []),
      row('background_check', 'unavailable', 'unavailable', 1, []),
    ]))}), "detectors": {}}`,
    'print(json.dumps(_autopsy._md_slowdowns(a)))',
  ]);
  assert.deepEqual(lines.slice(2), [
    '| 1 | timeout | X | 1970-01-01 00:00:00Z | 120.0 s | tool Bash, program npm, contains edit_retry, long_tool_call |',
    '| 2 | edit_retry x3 | X | 1970-01-01 00:00:00Z | 25.0 s | tool Bash, program npm |',
    '| 3 | background_check | X | 1970-01-01 00:00:00Z | unavailable | tool Bash, program npm |',
  ]);
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
  assert.match(res.stdout, /^project test runs: 3; check calls with a test group: 3 \(implement 3\)$/m);
  assert.ok(!res.stdout.includes('full-suite runs'), res.stdout);
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
  assert.match(res.stdout, /^project test runs: 2; check calls with a test group: 2 \(implement 1, verify 1\)$/m);
  assert.match(res.stdout, /autopsy\.md/);
});

test('the summaries name the longest agent on the critical path', () => {
  // run2's path runs from wf_1's A1 implement (280 s) through wf_2's A1
  // implement (725 s) to verify: the label repeats, the agent is wf_2's.
  assert.deepEqual(S.time.critical_path.labels,
    ['A1 implement', 'A1 implement', 'A1 review', 'A1 fix 1', 'A1 re-review 1', 'verify']);
  assert.deepEqual(S.time.critical_path.longest, { label: 'A1 implement', launch: 'wf_2', wall_s: 725 });
  assert.deepEqual(A.time.critical_path.longest, { label: 'B1 implement', launch: 'wf_1', wall_s: 180 });
  const res = runCli(copyRun(RUN2));
  assert.equal(res.code, 0, res.stderr);
  const summary = res.md.split('## Summary\n\n')[1].split('\n## ')[0].split('\n');
  assert.ok(summary.includes('- Longest on the critical path: A1 implement (725.0 s)'), summary.join('\n'));
  assert.equal(summary.indexOf('- Longest on the critical path: A1 implement (725.0 s)'),
    summary.findIndex((l) => l.startsWith('- Slowest phase:')) + 1);
  const chat = res.stdout.split('\n');
  assert.equal(chat[chat.findIndex((l) => l.startsWith('slowest phase:')) + 1],
    'longest on the critical path: A1 implement (725.0 s)');
  // On a tie the first on the path is named; an agent off the path (B1
  // implement, 85 s, still running when A1 review starts) never is.
  const tied = autopsy(buildLaunches([{ start: '10:00:00', s: 135, agents: [
    { label: 'A1 implement', start: '10:00:05', end: '10:01:05' },
    { label: 'B1 implement', start: '10:00:05', end: '10:01:30' },
    { label: 'A1 review', start: '10:01:10', end: '10:02:10' },
  ] }])).json;
  assert.deepEqual(tied.time.critical_path.labels, ['A1 implement', 'A1 review']);
  assert.deepEqual(tied.time.critical_path.longest, { label: 'A1 implement', launch: 'wf_1', wall_s: 60 });
  // Review focus 5: no timed agent on the path, no line.
  const dir = copyRun();
  for (const name of readdirSync(join(dir, 'wf_1')).filter((n) => n.endsWith('.jsonl'))) {
    editLines(join(dir, 'wf_1', name), (lines) => lines.map((l) => {
      const o = JSON.parse(l);
      delete o.timestamp;
      return JSON.stringify(o);
    }));
  }
  const none = runCli(dir);
  assert.equal(none.code, 0, none.stderr);
  const D = JSON.parse(readFileSync(join(dir, 'autopsy.json'), 'utf8'));
  assert.deepEqual([D.time.critical_path.labels, D.time.critical_path.longest], [[], null]);
  assert.ok(!/longest on the critical path/i.test(none.md), none.md);
  assert.ok(!/longest on the critical path/i.test(none.stdout), none.stdout);
});

test('the chat summary keeps its 15-line cap with every optional line', () => {
  // run2 (earlier launches, three slowdowns, the longest agent) with the
  // acceptance line and a launch conditions line as well.
  const lines = python([
    'import _autopsy',
    `a = json.loads(${JSON.stringify(JSON.stringify(S))})`,
    'a["done"]["acceptance"] = {"status": "rejected", "reasons": [], "warnings": 0, "accepted_by_user": True}',
    '_autopsy._conditions_line = lambda a: "launch conditions: 1 check warned or failed before launch; 0 possible contributors"',
    'print(json.dumps(_autopsy.render_summary(a, "C:/u/run/autopsy.md").split("\\n")))',
  ]).filter((l) => l !== '');
  assert.ok(lines.length <= 15, lines.join('\n'));
  assert.ok(lines.includes('longest on the critical path: A1 implement (725.0 s)'), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith('launch conditions: ')), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith('top suggestion: ')), lines.join('\n'));
  assert.equal(lines.at(-1), 'full report: C:/u/run/autopsy.md');
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

// ---- launch conditions ----
// A doctor-<wf>.json snapshot in the ledger (what ledger conditions writes)
// binds a doctor result to one launch. run2's launches are wf_1
// (08:00:00-08:05:00, stopped) and wf_2 (09:00:00-09:21:30).

const OBS = (hms) => `2026-10-10T${hms}Z`;
const FIRST_LINE = 'Observed before each launch. A condition may not have lasted through the run, and a warning '
  + 'beside a slowdown is a possible contributor, not a cause.';
const MEMORY_LOW = { check: 'memory', detail: '3.2 GB of physical memory available (under 4 GB)' };

// Copies run2 to a temp dir and writes each {name: object or raw text} into
// its ledger.
function withSnapshots(files) {
  const dir = copyRun(RUN2);
  writeSnapshots(dir, files);
  return dir;
}

function writeSnapshots(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    const text = typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`;
    writeFileSync(join(dir, 'p.f2.ledger', name), text);
  }
}

function doctorResult({
  observed_at, warnings = [], failures = [], skipped = [], checks, run_id = 'f2',
  status = failures.length ? 'blocked' : 'ok', doctor_version = '1.5.1',
} = {}) {
  const doctor = { status, failures, warnings, skipped, observed_at, doctor_version, run_id };
  if (checks !== undefined) doctor.checks = checks;
  return doctor;
}

function snapshot(wf, setupEvent, doctor) {
  return {
    launch: { wf, setup_event: setupEvent, setup_head: 'a'.repeat(40) },
    recorded_at: '2026-10-10T10:00:00Z',
    doctor,
  };
}

// wf_2's snapshot alone, observed two minutes before it started.
function wf2Only(doctor = {}) {
  return withSnapshots({ 'doctor-wf_2.json': snapshot('wf_2', 2, doctorResult({ observed_at: OBS('08:58:00'), ...doctor })) });
}

function analyse(dir) {
  const res = runCli(dir);
  assert.equal(res.code, 0, res.stderr);
  const json = JSON.parse(readFileSync(join(dir, 'autopsy.json'), 'utf8'));
  const byWf = Object.fromEntries(json.launch_conditions.map((x) => [x.wf, x]));
  return { ...res, json, byWf };
}

const section = (md) => md.split('## Launch conditions\n')[1].split('\n## ')[0];
const withoutSection = (md) => md.replace(/## Launch conditions\n[\s\S]*?(?=\n## )/, '');
const summaryLine = (stdout) => stdout.split('\n').find((l) => l.startsWith('launch conditions:'));

function assertNotShown(entry, reason) {
  assert.deepEqual(entry, {
    wf: entry.wf, state: entry.state, reason, observed_at: null, before_start_s: null, doctor_version: null,
    status: null, checks: [], possible_contributors: [],
  });
}

test('older runs say launch conditions unavailable', () => {
  for (const src of [RUN1, RUN2, RUN3]) {
    const res = analyse(copyRun(src));
    assert.deepEqual(res.json.launch_conditions.map((x) => x.wf), res.json.launches.map((l) => l.wf));
    for (const entry of res.json.launch_conditions) {
      assert.equal(entry.state, 'unavailable');
      assertNotShown(entry, 'launch conditions unavailable');
      assert.ok(section(res.md).includes(`${entry.wf}: launch conditions unavailable`), res.md);
    }
    assert.deepEqual(res.json.orphan_snapshots, []);
    assert.equal(summaryLine(res.stdout), undefined);
    assert.equal(section(res.md).split('\n').filter((l) => l !== '')[0], FIRST_LINE);
  }
});

test('a snapshot changes only its own outputs', () => {
  const dir = copyRun(RUN2);
  const before = analyse(dir);
  writeSnapshots(dir, {
    'doctor-wf_2.json': snapshot('wf_2', 2, doctorResult({ observed_at: OBS('08:58:00'), warnings: [MEMORY_LOW] })),
  });
  const after = analyse(dir);
  assert.equal(after.byWf.wf_2.state, 'recorded');
  assert.notEqual(summaryLine(after.stdout), undefined);
  const strip = (json) => {
    const out = { ...json };
    delete out.launch_conditions;
    delete out.inputs_fingerprint;
    return out;
  };
  assert.deepEqual(strip(after.json), strip(before.json));
  assert.notEqual(after.md, before.md);
  assert.equal(withoutSection(after.md), withoutSection(before.md));
  const noLine = (stdout) => stdout.split('\n').filter((l) => !l.startsWith('launch conditions:')).join('\n');
  assert.equal(noLine(after.stdout), noLine(before.stdout));
});

test('each launch shows its own snapshot', () => {
  const res = analyse(withSnapshots({
    'doctor-wf_1.json': snapshot('wf_1', 1, doctorResult({ observed_at: OBS('07:55:00'), warnings: [MEMORY_LOW] })),
    'doctor-wf_2.json': snapshot('wf_2', 2, doctorResult({ observed_at: OBS('08:58:00') })),
  }));
  assert.deepEqual(res.byWf.wf_1, {
    wf: 'wf_1', state: 'recorded', reason: null, observed_at: '2026-10-10T07:55:00.000Z', before_start_s: 300,
    doctor_version: '1.5.1', status: 'ok',
    checks: [{ check: 'memory', outcome: 'warning', detail: MEMORY_LOW.detail, read: true }],
    possible_contributors: [],
  });
  assert.deepEqual(res.byWf.wf_2, {
    wf: 'wf_2', state: 'recorded', reason: null, observed_at: '2026-10-10T08:58:00.000Z', before_start_s: 120,
    doctor_version: '1.5.1', status: 'ok', checks: [], possible_contributors: [],
  });
  const text = section(res.md);
  assert.ok(text.includes('Observed before launch wf_1 (5 min before its start), doctor 1.5.1: ok\n'
    + `- memory: warning (${MEMORY_LOW.detail})\nPossible contributors: none`), text);
  assert.ok(text.includes('Observed before launch wf_2 (2 min before its start), doctor 1.5.1: ok\n'
    + 'Possible contributors: none'), text);
  assert.equal(summaryLine(res.stdout), 'launch conditions: 1 check(s) warned or failed before launch; '
    + '0 possible contributor(s)');
});

test('a warning beside a related slowdown is a possible contributor', () => {
  const res = analyse(wf2Only({ warnings: [MEMORY_LOW] }));
  const start = Date.parse('2026-10-10T09:00:00Z');
  const end = Date.parse('2026-10-10T09:21:30Z');
  const counts = {};
  for (const kind of ['long_tool_call', 'timeout', 'background_check']) {
    const n = res.json.slowdowns.filter((s) => s.kind === kind
      && Date.parse(s.at) >= start && Date.parse(s.at) <= end).length;
    if (n > 0) counts[kind] = n;
  }
  assert.deepEqual(Object.keys(counts).sort(), ['background_check', 'long_tool_call', 'timeout']);
  assert.deepEqual(res.byWf.wf_2.possible_contributors, [{ check: 'memory', slowdowns: counts }]);
  const lines = section(res.md).split('\n');
  assert.ok(lines.includes(FIRST_LINE));
  const contributors = lines.find((l) => l.startsWith('Possible contributors: memory ('));
  for (const [kind, n] of Object.entries(counts)) assert.ok(contributors.includes(`${kind} x${n}`), contributors);
  assert.ok(!res.md.includes('caused'));
  assert.ok(!res.md.includes('because of'));
  assert.equal(summaryLine(res.stdout), 'launch conditions: 1 check(s) warned or failed before launch; '
    + '1 possible contributor(s)');
});

test('a reading that failed is not a condition', () => {
  const res = analyse(wf2Only({
    warnings: [{ check: 'defender', detail: 'unknown' }, { check: 'heavy_processes', detail: 'unknown' }],
  }));
  assert.deepEqual(res.byWf.wf_2.checks, [
    { check: 'defender', outcome: 'warning', detail: 'unknown', read: false },
    { check: 'heavy_processes', outcome: 'warning', detail: 'unknown', read: false },
  ]);
  assert.deepEqual(res.byWf.wf_2.possible_contributors, []);
  const text = section(res.md);
  assert.ok(text.includes('- defender: could not be read\n- heavy_processes: could not be read\n'), text);
  assert.ok(!text.includes('defender: warning'));
  assert.equal(summaryLine(res.stdout), 'launch conditions: 0 check(s) warned or failed before launch, '
    + '2 could not be read; 0 possible contributor(s)');
});

test('an unknown base comparison is a real condition', () => {
  const res = analyse(wf2Only({ warnings: [{ check: 'base_not_current', detail: 'unknown' }] }));
  assert.deepEqual(res.byWf.wf_2.checks, [
    { check: 'base_not_current', outcome: 'warning', detail: 'unknown', read: true },
  ]);
  assert.ok(section(res.md).includes('- base_not_current: warning (unknown)'));
  assert.equal(summaryLine(res.stdout), 'launch conditions: 1 check(s) warned or failed before launch; '
    + '0 possible contributor(s)');
});

test('a concurrency warning has no contributor', () => {
  const detail = "CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS is unset, so the Workflow tool's own cap applies; "
    + 'the run has 4 lane(s) at once';
  const res = analyse(wf2Only({ warnings: [{ check: 'concurrency', detail }] }));
  assert.deepEqual(res.byWf.wf_2.checks, [{ check: 'concurrency', outcome: 'warning', detail, read: true }]);
  assert.deepEqual(res.byWf.wf_2.possible_contributors, []);
  assert.ok(section(res.md).includes('Possible contributors: none'));
});

test('a launch without a snapshot does not inherit one', () => {
  const res = analyse(withSnapshots({
    'doctor-wf_1.json': snapshot('wf_1', 1, doctorResult({ observed_at: OBS('07:55:00'), warnings: [MEMORY_LOW] })),
  }));
  assert.equal(res.byWf.wf_1.state, 'recorded');
  assert.equal(res.byWf.wf_2.state, 'unavailable');
  assertNotShown(res.byWf.wf_2, 'launch conditions unavailable');
  assert.ok(section(res.md).includes('wf_2: launch conditions unavailable'));
});

test('inconsistent snapshots are not shown', () => {
  const at = (hms, more = {}) => doctorResult({ observed_at: OBS(hms), warnings: [MEMORY_LOW], ...more });
  const cases = [
    [{ 'doctor-wf_2.json': '{not json' }, ['wf_2'], 'snapshot unreadable'],
    [{ 'doctor-wf_2.json': '[]' }, ['wf_2'], 'snapshot unreadable'],
    [{ 'doctor-wf_2.json': { launch: { wf: 'wf_2', setup_event: 2 } } }, ['wf_2'], 'snapshot unreadable'],
    [{ 'doctor-wf_2.json': snapshot('wf_2', 2, at('08:58:00', { observed_at: '2026-10-10 9am' })) }, ['wf_2'],
      'snapshot unreadable'],
    [{ 'doctor-wf_2.json': snapshot('wf_1', 2, at('08:58:00')) }, ['wf_2'],
      'file name and content name different launches'],
    [{ 'doctor-wf_1.json': snapshot('wf_1', 1, at('07:55:00')), 'doctor-wf_2.json': snapshot('wf_2', 1, at('08:58:00')) },
      ['wf_1', 'wf_2'], 'another snapshot names the same setup'],
    [{ 'doctor-wf_2.json': snapshot('wf_2', 2, at('08:58:00', { run_id: 'other' })) }, ['wf_2'],
      'doctor result is for another run'],
    [{ 'doctor-wf_2.json': snapshot('wf_2', 2, at('09:05:00')) }, ['wf_2'], 'observed after the launch started'],
    [{ 'doctor-wf_2.json': snapshot('wf_2', 2, at('08:04:00')) }, ['wf_2'],
      'observed before the previous launch ended'],
  ];
  for (const [files, wfs, reason] of cases) {
    const res = analyse(withSnapshots(files));
    for (const wf of wfs) {
      assert.equal(res.byWf[wf].state, 'inconsistent', `${wf}: ${reason}`);
      assertNotShown(res.byWf[wf], reason);
      assert.ok(section(res.md).includes(`${wf}: ${reason}`), res.md);
    }
    assert.ok(!section(res.md).includes('memory'), reason);
    assert.equal(summaryLine(res.stdout), undefined, reason);
  }
  // A launch without timing cannot be checked.
  const dir = withSnapshots({ 'doctor-wf_3.json': snapshot('wf_3', 3, at('09:30:00')) });
  mkdirSync(join(dir, 'wf_3'));
  writeFileSync(join(dir, 'wf_3.json'), JSON.stringify({ runId: 'wf_3', status: 'running' }));
  const late = analyse(dir);
  assert.deepEqual(late.json.launch_conditions.map((x) => x.wf), ['wf_1', 'wf_2', 'wf_3']);
  assert.equal(late.byWf.wf_3.state, 'inconsistent');
  assertNotShown(late.byWf.wf_3, 'launch time unavailable');
  // A run_id of null is recorded normally.
  const unnamed = analyse(wf2Only({ run_id: null }));
  assert.equal(unnamed.byWf.wf_2.state, 'recorded');
});

test('an orphan snapshot is listed', () => {
  const res = analyse(withSnapshots({
    'doctor-wf_9.json': snapshot('wf_9', 3, doctorResult({ observed_at: OBS('09:30:00'), warnings: [MEMORY_LOW] })),
  }));
  assert.deepEqual(res.json.orphan_snapshots, ['wf_9']);
  assert.deepEqual(res.json.launch_conditions.map((x) => x.state), ['unavailable', 'unavailable']);
  assert.ok(section(res.md).includes('Snapshot for a launch not in this archive: wf_9'), res.md);
  assert.ok(!section(res.md).includes('memory'));
});

test('no doctor detail leaks', () => {
  const variants = [
    ['0.8 GB free on the drive of C:\\zqpath\\wt (under 5 GB)',
      'unreachable: the upstream https://zqhost.example/r.git did not answer, so the base was not compared'],
    ['0.8 GB free on the drive of C:/zqpath/wt (under 5 GB)', 'the upstream branch refs/heads/zqref is not on zqremote'],
  ];
  for (const [disk, base] of variants) {
    const res = analyse(wf2Only({
      warnings: [
        { check: 'disk', detail: disk },
        { check: 'base_not_current', detail: base },
        { check: 'python_alias', detail: "the manifest's python is the WindowsApps alias, which is slow to start: "
          + 'C:/zqalias/python3.exe' },
      ],
      failures: [{ check: 'dirty_checkout', detail: '1 uncommitted or untracked path(s): src/zqsecret.py',
        fix: 'commit it' }],
    }));
    const entry = res.byWf.wf_2;
    assert.equal(entry.status, 'blocked');
    assert.deepEqual(entry.checks.map((c) => [c.check, c.outcome, c.detail]), [
      ['dirty_checkout', 'failed', null], ['disk', 'warning', '0.8 GB free'],
      ['base_not_current', 'warning', null], ['python_alias', 'warning', null],
    ]);
    const json = JSON.stringify(res.json.launch_conditions);
    for (const text of [res.md, json, res.stdout]) {
      for (const token of ['zqpath', 'zqhost', 'zqsecret', 'zqalias', 'zqref', 'zqremote']) {
        assert.ok(!text.includes(token), token);
      }
    }
    assert.ok(res.md.includes('0.8 GB free'));
  }
});

test('a snapshot without outcomes never claims passed', () => {
  const res = analyse(wf2Only({
    warnings: [MEMORY_LOW],
    failures: [{ check: 'git_identity', detail: 'no identity', fix: 'set one' }],
    skipped: [{ check: 'defender', reason: 'not_applicable' }],
  }));
  assert.deepEqual(res.byWf.wf_2.checks, [
    { check: 'git_identity', outcome: 'failed', detail: null, read: true },
    { check: 'memory', outcome: 'warning', detail: MEMORY_LOW.detail, read: true },
    { check: 'defender', outcome: 'skipped', detail: 'not_applicable', read: true },
  ]);
  assert.ok(!section(res.md).includes('passed'));
});

test('copied values are validated', () => {
  const res = analyse(wf2Only({
    checks: [
      { check: 'memory', outcome: 'passed' },
      { check: '../x', outcome: 'warning' },
      { check: 'disk', outcome: 'great' },
      { check: 'defender', outcome: 'passed' },
    ],
    warnings: [MEMORY_LOW, { check: '../x', detail: 'unknown' }],
    doctor_version: 'v1 <b>',
    status: 'fine',
  }));
  const entry = res.byWf.wf_2;
  assert.equal(entry.state, 'recorded');
  assert.equal(entry.doctor_version, null);
  assert.equal(entry.status, null);
  assert.deepEqual(entry.checks, [
    { check: 'memory', outcome: 'warning', detail: MEMORY_LOW.detail, read: true },
    { check: 'defender', outcome: 'passed', detail: null, read: true },
  ]);
  assert.ok(!res.md.includes('../x'));
  assert.ok(!res.md.includes('<b>'));
  assert.ok(section(res.md).includes('doctor unavailable: unavailable'), res.md);
  // A doctor that could not read its own version says so.
  const unversioned = analyse(wf2Only({ doctor_version: 'unavailable' }));
  assert.equal(unversioned.byWf.wf_2.doctor_version, 'unavailable');
});

test('derive_detail keeps unknown and reason codes', () => {
  const cases = [
    ['memory', 'warning', 'unknown', 'unknown'],
    ['defender', 'skipped', 'not_applicable', 'not_applicable'],
    ['defender', 'skipped', 'Not Applicable', null],
    ['base_not_current', 'warning', 'unknown', 'unknown'],
    ['base_not_current', 'warning', 'the upstream branch refs/heads/x is not on origin', null],
    ['memory', 'warning', MEMORY_LOW.detail, MEMORY_LOW.detail],
    ['memory', 'warning', 'see C:/x', null],
    ['heavy_processes', 'warning', 'line one\n', null],
    ['disk', 'warning', '12.5 GB free on the drive of /x (under 5 GB)', '12.5 GB free'],
    ['disk', 'warning', 'low', null],
    ['defender', 'warning', 'not covered', 'not covered'],
    ['defender', 'warning', 'not covered: C:/x', null],
    ['git_identity', 'failed', 'no identity', null],
    ['memory', 'passed', null, null],
  ];
  const got = python([
    'import _autopsy',
    `cases = json.loads(${JSON.stringify(JSON.stringify(cases.map((c) => c.slice(0, 3))))})`,
    'print(json.dumps([_autopsy.derive_detail(c, o, t) for c, o, t in cases]))',
  ]);
  assert.deepEqual(got, cases.map((c) => c[3]));
  const res = analyse(wf2Only({ skipped: [{ check: 'defender', reason: 'not_applicable' }] }));
  assert.ok(section(res.md).includes('Skipped: defender (not_applicable)'), res.md);
  // A skipped check alone puts no line in the summary.
  assert.equal(summaryLine(res.stdout), undefined);
});

test('a file that is not a snapshot is ignored', () => {
  const res = analyse(withSnapshots({
    'doctor-notes.json': snapshot('wf_2', 2, doctorResult({ observed_at: OBS('08:58:00'), warnings: [MEMORY_LOW] })),
  }));
  assert.deepEqual(res.json.orphan_snapshots, []);
  assert.deepEqual(res.json.launch_conditions.map((x) => x.state), ['unavailable', 'unavailable']);
  assert.ok(!section(res.md).includes('notes'));
  assert.ok(!section(res.md).includes('memory'));
});

test('a new snapshot changes the fingerprint', () => {
  const dir = copyRun(RUN2);
  const before = analyse(dir).json.inputs_fingerprint;
  writeSnapshots(dir, { 'doctor-wf_2.json': snapshot('wf_2', 2, doctorResult({ observed_at: OBS('08:58:00') })) });
  assert.notEqual(analyse(dir).json.inputs_fingerprint, before);
});
