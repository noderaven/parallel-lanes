// scripts/history: compares the runs in the history dir. Each test builds its
// own temp history dir holding two copies of the autopsy fixture run1, indexed
// by archive-run --reindex:
//   fa  engine 1.4.4 (in its report and its workflow result), project C:/src/proj
//   fb  no report and no version, project /home/u/other
// Both runs have run1's 90 s idle gap.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { mergeEnv, tempDir } from './platform.mjs';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const HISTORY = join(SCRIPTS, 'history');
const ARCHIVE = join(SCRIPTS, 'archive-run');
const RUN1 = join(SKILL_DIR, 'tests', 'fixtures', 'autopsy', 'run1');
const TMP = tempDir('pl-history-');
after(() => rmSync(TMP, { recursive: true, force: true }));

// The environment without the history variables a developer may have set.
function cleanEnv() {
  const env = mergeEnv(process.env);
  for (const key of Object.keys(env)) {
    if (['PL_HISTORY_DIR', 'CLAUDE_CONFIG_DIR'].includes(key.toUpperCase())) delete env[key];
  }
  return env;
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

const { version: AUTOPSY_VERSION, toolKinds: TOOL_KINDS } = python([
  'import _autopsy',
  'print(json.dumps({"version": _autopsy.AUTOPSY_VERSION, "toolKinds": list(_autopsy.TOOL_KINDS)}))',
]);

const fingerprint = (dir) => python([
  'import _autopsy',
  `print(json.dumps(_autopsy.fingerprint(${JSON.stringify(dir)})))`,
]);

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
function editJson(path, edit) {
  const value = readJson(path);
  edit(value);
  writeJson(path, value);
}
function editLines(path, edit) {
  const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l !== '');
  writeFileSync(path, `${edit(lines).join('\n')}\n`);
}

let counter = 0;
function makeHistory() {
  counter += 1;
  const hist = join(TMP, `hist${counter}`);
  const a = join(hist, '2026-10-10-fa');
  const b = join(hist, '2026-10-10-fb');
  cpSync(RUN1, a, { recursive: true });
  cpSync(RUN1, b, { recursive: true });
  editJson(join(a, 'p.lanes.json'), (m) => {
    m.run_id = 'fa';
    m.repo.ledger_dir = 'C:/src/plans/p.fa.ledger';
  });
  editJson(join(a, 'wf_1.json'), (w) => { w.result.version = '1.4.4'; });
  writeJson(join(a, 'p.fa.report.json'), { engine_version: '1.4.4' });
  editJson(join(b, 'p.lanes.json'), (m) => {
    m.run_id = 'fb';
    Object.assign(m.repo, { root: '/home/u/other', ledger_dir: '/home/u/plans/p.fb.ledger' });
  });
  editJson(join(b, 'wf_1.json'), (w) => { delete w.result.version; });
  const r = spawnSync('python3', [ARCHIVE, '--reindex', '--history-dir', hist], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).runs, 2);
  return { hist, a, b };
}

function history(hist, ...extra) {
  const r = spawnSync('python3', [HISTORY, '--history-dir', hist, ...extra], { encoding: 'utf8', env: cleanEnv() });
  const ok = r.status === 0;
  return {
    code: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    json: ok ? readJson(join(hist, 'history.json')) : null,
    md: ok ? readFileSync(join(hist, 'history.md'), 'utf8') : null,
  };
}

function historyOk(hist, ...extra) {
  const res = history(hist, ...extra);
  assert.equal(res.code, 0, res.stderr);
  return res;
}

const rowOf = (res, runId) => res.json.runs.find((r) => r.run_id === runId);
const mdRow = (md, runId) => md.split('\n').find((l) => l.startsWith(`| ${runId} |`));
const autopsyOf = (dir) => readJson(join(dir, 'autopsy.json'));
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.051, `${actual} != ${expected}`);

test('history runs autopsy where it is missing', () => {
  const { hist, a, b } = makeHistory();
  for (const dir of [a, b]) assert.ok(!existsSync(join(dir, 'autopsy.json')));
  const res = historyOk(hist);
  for (const dir of [a, b]) {
    assert.ok(existsSync(join(dir, 'autopsy.json')), `${dir} has no autopsy.json`);
    assert.ok(existsSync(join(dir, 'autopsy.md')), `${dir} has no autopsy.md`);
  }
  assert.deepEqual(Object.keys(res.json), ['runs', 'recurring', 'token_trends', 'suggestions', 'insufficient_data']);
  assert.deepEqual(res.json.runs.map((r) => r.run_id), ['fa', 'fb']);
  const fa = rowOf(res, 'fa');
  assert.deepEqual(Object.keys(fa), [
    'run_id', 'folder', 'date', 'engine_version', 'tasks', 'agents', 'wall_s', 'slowest_phase', 'tokens_total',
    'tokens_per_task', 'tokens_partial', 'full_suite_runs', 'acceptance', 'top_slowdown',
  ]);
  const A = autopsyOf(a);
  const tot = A.tokens.totals;
  const total = tot.input_tokens + tot.cache_creation_input_tokens + tot.output_tokens;
  assert.deepEqual(fa, {
    run_id: 'fa', folder: '2026-10-10-fa', date: '2026-10-10', engine_version: '1.4.4', tasks: 2, agents: 4,
    wall_s: 600, slowest_phase: 'Lane a', tokens_total: total, tokens_per_task: Math.round(total / 2),
    tokens_partial: false, full_suite_runs: 2, acceptance: 'unverified',
    top_slowdown: { kind: A.slowdowns[0].kind, cost_s: A.slowdowns[0].cost_s },
  });
  assert.equal(rowOf(res, 'fb').engine_version, 'unavailable');
  assert.deepEqual(res.json.insufficient_data, {});
  for (const heading of ['# Run history', '## Runs', '## Recurring slowdowns', '## Token trends', '## Suggestions',
    '## Insufficient data']) {
    assert.ok(res.md.includes(heading), `history.md lacks ${heading}`);
  }
  assert.match(res.md, /^[\x00-\x7f]*$/);
  assert.match(res.stdout, /^[\x00-\x7f]*$/);
  const lines = res.stdout.trimEnd().split('\n');
  assert.ok(lines.length <= 15, res.stdout);
  assert.match(res.stdout, /2 runs/);
  assert.match(res.stdout, /history\.md/);
});

test('a stale autopsy is redone', () => {
  const { hist, a, b } = makeHistory();
  historyOk(hist);
  // fa's autopsy is from an older autopsy version; fb gets a second launch
  // with no reindex.
  editJson(join(a, 'autopsy.json'), (x) => { x.autopsy_version = 0; });
  cpSync(join(b, 'wf_1'), join(b, 'wf_2'), { recursive: true });
  const wf2 = readJson(join(b, 'wf_1.json'));
  wf2.runId = 'wf_2';
  wf2.startTime += 3600 * 1000;
  writeJson(join(b, 'wf_2.json'), wf2);
  historyOk(hist);
  for (const dir of [a, b]) {
    const x = autopsyOf(dir);
    assert.equal(x.autopsy_version, AUTOPSY_VERSION);
    assert.equal(x.inputs_fingerprint, fingerprint(dir));
  }
  assert.deepEqual(autopsyOf(b).launches.map((l) => l.wf), ['wf_1', 'wf_2']);

  // fa loses its autopsy.md; fb's autopsy is current and stays as it is.
  for (const dir of [a, b]) editJson(join(dir, 'autopsy.json'), (x) => { x.kept = true; });
  rmSync(join(a, 'autopsy.md'));
  historyOk(hist);
  assert.ok(existsSync(join(a, 'autopsy.md')));
  assert.equal(autopsyOf(a).kept, undefined, 'the autopsy of fa was not redone');
  assert.equal(autopsyOf(a).inputs_fingerprint, fingerprint(a));
  assert.equal(autopsyOf(b).kept, true, 'a current autopsy was redone');
});

test('recurring slowdowns total across runs with each run\'s version', () => {
  const { hist, a, b } = makeHistory();
  const res = historyOk(hist);
  const cost = (dir) => autopsyOf(dir).slowdowns.filter((s) => s.kind === 'idle_gap')
    .reduce((sum, s) => sum + s.cost_s, 0);
  const [ca, cb] = [cost(a), cost(b)];
  assert.ok(ca > 0 && cb > 0);
  const idle = res.json.recurring.find((r) => r.kind === 'idle_gap');
  assert.ok(idle, 'no idle_gap entry');
  near(idle.total_s, ca + cb);
  assert.deepEqual(idle.runs.map((r) => [r.run_id, r.engine_version]), [['fa', '1.4.4'], ['fb', 'unavailable']]);
  near(idle.runs[0].cost_s, ca);
  near(idle.runs[1].cost_s, cb);
  assert.deepEqual(Object.keys(res.json.token_trends).sort(), ['1.4.4', 'unavailable']);
  assert.deepEqual(res.json.token_trends['1.4.4'].runs, ['fa']);
  assert.deepEqual(res.json.token_trends.unavailable.runs, ['fb']);
  const sug = res.json.suggestions.find((s) => s.kind === 'idle_gap');
  assert.deepEqual(sug.runs, ['fa', 'fb']);
  near(sug.total_s, ca + cb);
  const recurring = res.md.split('## Recurring slowdowns')[1].split('\n## ')[0];
  assert.match(recurring, /idle_gap/);
  assert.match(recurring, /1\.4\.4/);
  assert.match(recurring, /unavailable/);
});

test('runs lacking a detector are excluded from its totals and listed', () => {
  const { hist, b } = makeHistory();
  // fb loses every tool call and tool result.
  for (const name of readdirSync(join(b, 'wf_1')).filter((n) => n.endsWith('.jsonl'))) {
    editLines(join(b, 'wf_1', name), (lines) => lines.flatMap((l) => {
      const o = JSON.parse(l);
      const content = o.message && Array.isArray(o.message.content) ? o.message.content : null;
      if (!content) return [l];
      if (content.some((c) => c.type === 'tool_result')) return [];
      o.message.content = content.map((c) => (c.type === 'tool_use' ? { type: 'text', text: 'x' } : c));
      return [JSON.stringify(o)];
    }));
  }
  const res = historyOk(hist);
  const B = autopsyOf(b);
  for (const kind of TOOL_KINDS) {
    assert.equal(B.detectors[kind], 'not_available', kind);
    assert.deepEqual(res.json.insufficient_data[kind], ['fb'], kind);
    const entry = res.json.recurring.find((r) => r.kind === kind);
    assert.ok(!entry || !entry.runs.some((r) => r.run_id === 'fb'), `${kind} counts fb`);
    const sug = res.json.suggestions.find((s) => s.kind === kind);
    assert.ok(!sug || !sug.runs.includes('fb'), `${kind} suggestion counts fb`);
  }
  // The idle gap detector still has its data in fb.
  assert.equal(res.json.insufficient_data.idle_gap, undefined);
  assert.ok(res.json.recurring.find((r) => r.kind === 'idle_gap').runs.some((r) => r.run_id === 'fb'));
  const insufficient = res.md.split('## Insufficient data')[1];
  for (const kind of TOOL_KINDS) assert.match(insufficient, new RegExp(`${kind}: fb`));
});

test('partial token totals are marked', () => {
  const { hist, b } = makeHistory();
  // One fb line is cut short (a truncated write).
  editLines(join(b, 'wf_1', 'agent-a2.jsonl'), (lines) => {
    lines[2] = lines[2].slice(0, 60);
    return lines;
  });
  const res = historyOk(hist);
  assert.equal(rowOf(res, 'fb').tokens_partial, true);
  assert.equal(rowOf(res, 'fa').tokens_partial, false);
  assert.deepEqual(res.json.token_trends.unavailable.partial_runs, ['fb']);
  assert.deepEqual(res.json.token_trends['1.4.4'].partial_runs, []);
  assert.match(mdRow(res.md, 'fb'), />= \d+/);
  assert.ok(!mdRow(res.md, 'fa').includes('>='), mdRow(res.md, 'fa'));
});

test('a run without usage is left out of token trends', () => {
  const { hist, a, b } = makeHistory();
  // fb runs the same engine as fa, has no usage at all, and one of its
  // calls lost its result (so its tool detectors are partial).
  editJson(join(b, 'wf_1.json'), (w) => { w.result.version = '1.4.4'; });
  for (const name of readdirSync(join(b, 'wf_1')).filter((n) => n.endsWith('.jsonl'))) {
    editLines(join(b, 'wf_1', name), (lines) => lines.flatMap((l) => {
      const o = JSON.parse(l);
      if (!o.message) return [l];
      delete o.message.usage;
      const content = Array.isArray(o.message.content) ? o.message.content : [];
      if (content.some((c) => c.type === 'tool_result' && c.tool_use_id === 'tu_a2_1')) return [];
      return [JSON.stringify(o)];
    }));
  }
  const res = historyOk(hist);
  const fb = rowOf(res, 'fb');
  assert.deepEqual([fb.engine_version, fb.tokens_total, fb.tokens_per_task], ['1.4.4', 'unavailable', 'unavailable']);
  assert.match(mdRow(res.md, 'fb'), /\| unavailable \| unavailable \|/);
  // The 1.4.4 trend holds both runs, but only fa's tokens.
  const fa = rowOf(res, 'fa');
  const trend = res.json.token_trends['1.4.4'];
  assert.deepEqual(trend.runs, ['fa', 'fb']);
  assert.equal(trend.tokens_per_task, fa.tokens_per_task);
  const roles = autopsyOf(a).tokens.by_role;
  for (const [role, bucket] of Object.entries(trend.by_role)) {
    assert.equal(bucket.agents, roles[role].agents, role);
    assert.equal(bucket.tokens, roles[role].input_tokens + roles[role].cache_creation_input_tokens
      + roles[role].output_tokens, role);
  }
  // fb's partial tool detectors still count: they are not insufficient data.
  const B = autopsyOf(b);
  for (const kind of TOOL_KINDS) {
    assert.equal(B.detectors[kind], 'partial', kind);
    assert.equal(res.json.insufficient_data[kind], undefined, kind);
  }
  assert.deepEqual(res.json.insufficient_data, {});
});

test('--since and --project filter runs', () => {
  const { hist } = makeHistory();
  editJson(join(hist, 'index.json'), (index) => {
    index.runs.find((r) => r.run_id === 'fb').first_launch = '2026-10-12T07:00:00Z';
  });
  const ids = (...args) => historyOk(hist, ...args).json.runs.map((r) => r.run_id);
  assert.deepEqual(ids(), ['fa', 'fb']);
  assert.deepEqual(ids('--since', '2026-10-11'), ['fb']);
  assert.deepEqual(ids('--since', '2026-10-10'), ['fa', 'fb']);
  assert.deepEqual(ids('--project', 'other'), ['fb']);
  assert.deepEqual(ids('--project', '/home/u/other'), ['fb']);
  assert.deepEqual(ids('--project', 'proj'), ['fa']);
  assert.deepEqual(ids('--project', 'C:\\src\\proj'), ['fa']);
  assert.deepEqual(ids('--project', 'proj', '--since', '2026-10-11'), []);
  for (const args of [['--since', '2026-13-01'], ['--since'], ['--project'], ['--bogus'], ['extra']]) {
    const res = history(hist, ...args);
    assert.equal(res.code, 2, `${args.join(' ')}: ${res.stdout}`);
  }
  // An option is never taken as another option's value.
  const swallowed = history(hist, '--project', '--since', '2026-10-11');
  assert.equal(swallowed.code, 2);
  assert.match(swallowed.stderr, /--project needs a value/);
  writeFileSync(join(hist, 'index.json'), '{not json');
  const res = history(hist);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /index\.json/);
});

// ---- history --runs A,B (1.6.4) ----

// A history of fa and fb with the same archived plan and current autopsies
// (made by a plain history run first).
function comparablePair() {
  const h = makeHistory();
  for (const dir of [h.a, h.b]) writeFileSync(join(dir, 'p.md'), '# Plan\n\n### Task A1: x\n');
  historyOk(h.hist);
  return h;
}
function runsOf(hist, ...extra) {
  const r = spawnSync('python3', [HISTORY, '--history-dir', hist, '--runs', 'fa,fb', ...extra],
    { encoding: 'utf8', env: cleanEnv() });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* text output */ }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

test('--runs compares two runs of the same plan as comparable', () => {
  const { hist } = comparablePair();
  const r = runsOf(hist, '--json');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.comparable, true, JSON.stringify(r.json.reasons));
  assert.deepEqual(r.json.reasons, []);
  const [fa, fb] = r.json.runs;
  assert.deepEqual([fa.run_id, fb.run_id], ['fa', 'fb']);
  assert.equal(fa.plan_sha256, fb.plan_sha256);
  assert.match(fa.plan_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(fa.lanes, ['a', 'b']);
  assert.deepEqual(fa.task_ids, fb.task_ids);
  assert.equal(fa.commands_sha256, fb.commands_sha256);
  assert.deepEqual([fa.autopsy, fb.autopsy], ['current', 'current']);
  for (const key of ['wall_s', 'fixed_s', 'task_s', 'full_suite_s', 'tokens_total', 'tokens_partial', 'engine_version',
    'claude_code_version', 'launches', 'status', 'acceptance', 'folder', 'plan']) {
    assert.ok(key in fa, key);
  }
  const text = runsOf(hist);
  assert.equal(text.code, 0, text.stderr);
  assert.equal(text.stdout.split('\n')[0], 'comparable');
});

test('--runs lists every reason two runs are not comparable', () => {
  const { hist, a, b } = comparablePair();
  writeFileSync(join(b, 'p.md'), '# Plan\n\n### Task A1: changed\n');
  editJson(join(b, 'p.lanes.json'), (m) => {
    m.lanes[1].id = 'c';
    m.lanes[1].tasks.push({ id: 'Z9', title: 'Z9', tier: 'standard' });
    m.commands.test = ['npm test'];
  });
  rmSync(join(a, 'autopsy.json'));
  editLines(join(b, 'wf_1', 'agent-a2.jsonl'), (lines) => {
    lines[2] = lines[2].slice(0, 60);
    return lines;
  });
  historyOk(hist);
  rmSync(join(a, 'autopsy.json'));
  const r = runsOf(hist, '--json');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.comparable, false);
  assert.deepEqual(r.json.reasons, ['plan differs', 'tasks differ', 'lanes differ', 'commands differ',
    'autopsy missing for fa', 'tokens partial for fb']);
  const text = runsOf(hist);
  assert.equal(text.stdout.split('\n')[0], `not comparable: ${r.json.reasons.join('; ')}`);
});

test('--runs marks a stale autopsy and a missing plan', () => {
  const { hist, a, b } = comparablePair();
  editJson(join(a, 'autopsy.json'), (x) => { x.autopsy_version = 1; });
  rmSync(join(b, 'p.md'));
  const r = runsOf(hist, '--json');
  assert.deepEqual([r.json.runs[0].autopsy, r.json.runs[1].plan_sha256], ['stale', 'unavailable']);
  assert.deepEqual(r.json.reasons, ['plan unavailable for fb', 'autopsy stale for fa']);
});

test('--runs prints no percentage and writes nothing', () => {
  const { hist, a } = comparablePair();
  const before = ['history.json', 'history.md'].map((n) => readFileSync(join(hist, n), 'utf8'));
  const autopsyBefore = readFileSync(join(a, 'autopsy.json'), 'utf8');
  rmSync(join(a, 'autopsy.md'));
  const r = runsOf(hist);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.stdout.includes('%'), r.stdout);
  assert.deepEqual(['history.json', 'history.md'].map((n) => readFileSync(join(hist, n), 'utf8')), before);
  // It never reruns autopsy: the stale run stays as it was.
  assert.equal(readFileSync(join(a, 'autopsy.json'), 'utf8'), autopsyBefore);
  assert.ok(!existsSync(join(a, 'autopsy.md')));
});

test('--runs refuses ambiguous ids', () => {
  const { hist } = comparablePair();
  const same = spawnSync('python3', [HISTORY, '--history-dir', hist, '--runs', 'fa,fa'], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(same.status, 2);
  assert.match(same.stderr, /twice|same run/);
  // An id the index holds twice: both folders are named.
  editJson(join(hist, 'index.json'), (idx) => { idx.runs.push({ ...idx.runs[0], folder: '2026-10-11-fa' }); });
  const dup = spawnSync('python3', [HISTORY, '--history-dir', hist, '--runs', 'fa,fb'], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(dup.status, 2);
  assert.match(dup.stderr, /2026-10-10-fa/);
  assert.match(dup.stderr, /2026-10-11-fa/);
  const missing = spawnSync('python3', [HISTORY, '--history-dir', hist, '--runs', 'fb,nope'], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /nope/);
});

test('--runs with --since or --project is a usage error', () => {
  const { hist } = comparablePair();
  for (const extra of [['--since', '2026-10-01'], ['--project', 'proj'], []]) {
    const args = extra.length ? ['--runs', 'fa,fb', ...extra] : ['--runs', 'fa'];
    const r = spawnSync('python3', [HISTORY, '--history-dir', hist, ...args], { encoding: 'utf8', env: cleanEnv() });
    assert.equal(r.status, 2, JSON.stringify(args));
    assert.match(r.stderr, /usage/);
  }
});
