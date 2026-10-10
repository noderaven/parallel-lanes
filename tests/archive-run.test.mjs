// scripts/archive-run: copies a run (manifest, ledger, report, plan, spec,
// transcript dirs and their workflow result files) into a dated folder of the
// history dir and records it in index.json. Each test builds its own temp run
// and history dir and passes --history-dir, so no real history is touched.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { mergeEnv, tempDir } from './platform.mjs';

const SCRIPT = join(SKILL_DIR, 'scripts', 'archive-run');
const TMP = tempDir('pl-archive-run-');
after(() => rmSync(TMP, { recursive: true, force: true }));

// 2026-10-10T07:00:00Z, and the same time a day later.
const DAY1 = Date.UTC(2026, 9, 10, 7, 0, 0);
const DAY2 = DAY1 + 24 * 3600 * 1000;

// The environment without the history variables a developer may have set.
function cleanEnv() {
  const env = mergeEnv(process.env);
  for (const key of Object.keys(env)) {
    if (['PL_HISTORY_DIR', 'CLAUDE_CONFIG_DIR'].includes(key.toUpperCase())) delete env[key];
  }
  return env;
}

let counter = 0;
function freshDir(name) {
  counter += 1;
  const dir = join(TMP, `${name}-${counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

// A launch: <root>/<session>/<id>/ with two agents' transcripts, and
// <root>/<session>/<id>.json, the workflow result file.
function addLaunch(root, session, id, startMs, { status = 'complete', acceptance = 'accepted' } = {}) {
  const dir = join(root, session, id);
  mkdirSync(dir, { recursive: true });
  for (const agent of ['a', 'b']) {
    writeFileSync(join(dir, `agent-${agent}.jsonl`),
      JSON.stringify({ type: 'assistant', timestamp: new Date(startMs).toISOString() }) + '\n');
    writeJson(join(dir, `agent-${agent}.meta.json`), { description: `T1 implement ${agent}` });
  }
  writeJson(`${dir}.json`, { runId: id, startTime: startMs, result: { status, acceptance: { status: acceptance } } });
  return dir;
}

// A run as a session leaves it: <root>/run/p.lanes.json with its ledger,
// report, plan and spec beside it, the project at <root>/proj, and one launch
// <root>/s/wf_1 started on DAY1.
function makeRun({ runId = 'x1', report = true } = {}) {
  const root = freshDir('case');
  const run = join(root, 'run');
  const proj = join(root, 'proj');
  const ledger = join(run, `p.${runId}.ledger`);
  mkdirSync(join(ledger, 'checks'), { recursive: true });
  mkdirSync(proj, { recursive: true });
  const manifest = join(run, 'p.lanes.json');
  const plan = join(run, 'p.md');
  const spec = join(run, 'p-design.md');
  writeJson(manifest, { version: 1, run_id: runId, plan, spec, repo: { mode: 'git', root: proj, ledger_dir: ledger } });
  writeFileSync(join(ledger, '_run.jsonl'), JSON.stringify({ event: 'run_started' }) + '\n');
  writeJson(join(ledger, 'checks', 'verify-a.json'), { ok: true });
  if (report) writeJson(join(run, `p.${runId}.report.json`), { engine_version: '1.4.4', agents: [] });
  // One file with a CRLF line: the copy must keep the bytes as they are.
  writeFileSync(plan, '# Plan\r\nline two\n');
  writeFileSync(spec, '# Spec\n');
  const wf1 = addLaunch(root, 's', 'wf_1', DAY1);
  return { root, run, proj, ledger, manifest, plan, spec, wf1, hist: join(root, 'hist'), runId };
}

function archive(manifest, dirs, hist) {
  const res = spawnSync('python3', [SCRIPT, manifest, ...dirs, '--history-dir', hist], { encoding: 'utf8', env: cleanEnv() });
  return { code: res.status, out: res.status === 0 ? JSON.parse(res.stdout) : null, stderr: res.stderr };
}

function archiveOk(manifest, dirs, hist) {
  const res = archive(manifest, dirs, hist);
  assert.equal(res.code, 0, res.stderr);
  return res.out;
}

function readIndex(hist) {
  return JSON.parse(readFileSync(join(hist, 'index.json'), 'utf8'));
}

// Every file under dir, as '/'-separated paths relative to dir.
function filesUnder(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix + entry.name;
    if (entry.isDirectory()) out.push(...filesUnder(join(dir, entry.name), rel + '/'));
    else out.push(rel);
  }
  return out.sort();
}

function assertSameBytes(a, b) {
  assert.ok(readFileSync(a).equals(readFileSync(b)), `${b} differs from ${a}`);
}

test('archives every run file into a dated folder', () => {
  const r = makeRun();
  const out = archiveOk(r.manifest, [r.wf1], r.hist);
  const folder = join(r.hist, '2026-10-10-x1');
  assert.equal(out.folder.replace(/\\/g, '/').toLowerCase(), folder.replace(/\\/g, '/').toLowerCase());
  assert.ok(statSync(folder).isDirectory());
  const pairs = [
    [r.manifest, 'p.lanes.json'],
    [join(r.ledger, '_run.jsonl'), 'p.x1.ledger/_run.jsonl'],
    [join(r.ledger, 'checks', 'verify-a.json'), 'p.x1.ledger/checks/verify-a.json'],
    [join(r.run, 'p.x1.report.json'), 'p.x1.report.json'],
    [r.plan, 'p.md'],
    [r.spec, 'p-design.md'],
    [join(r.wf1, 'agent-a.jsonl'), 'wf_1/agent-a.jsonl'],
    [join(r.wf1, 'agent-b.jsonl'), 'wf_1/agent-b.jsonl'],
    [join(r.wf1, 'agent-a.meta.json'), 'wf_1/agent-a.meta.json'],
    [join(r.wf1, 'agent-b.meta.json'), 'wf_1/agent-b.meta.json'],
    [`${r.wf1}.json`, 'wf_1.json'],
  ];
  for (const [src, rel] of pairs) assertSameBytes(src, join(folder, rel));
  assert.ok(readFileSync(join(folder, 'p.md')).includes('\r\n'));
  // Exactly these files, every one listed as added.
  assert.deepEqual(filesUnder(folder), pairs.map(([, rel]) => rel).sort());
  assert.deepEqual([...out.added].sort(), pairs.map(([, rel]) => rel).sort());
  assert.deepEqual(out.updated, []);
  assert.ok(!existsSync(join(r.hist, 'index.lock')), 'the lock is released');
});

test('writes an index entry', () => {
  const r = makeRun();
  archiveOk(r.manifest, [r.wf1], r.hist);
  const index = readIndex(r.hist);
  assert.equal(index.version, 1);
  assert.equal(index.runs.length, 1);
  const entry = index.runs[0];
  assert.equal(entry.run_id, 'x1');
  assert.equal(entry.folder, '2026-10-10-x1');
  assert.equal(entry.engine_version, '1.4.4');
  assert.equal(entry.launches, 1);
  assert.equal(entry.status, 'complete');
  assert.equal(entry.acceptance, 'accepted');
  assert.ok(entry.first_launch.startsWith('2026-10-10T07:00:00'), entry.first_launch);
  assert.equal(entry.last_launch, entry.first_launch);
  assert.equal(entry.ledger_dir.toLowerCase(), r.ledger.replace(/\\/g, '/').toLowerCase());
  assert.equal(entry.project.toLowerCase(), r.proj.replace(/\\/g, '/').toLowerCase());
  assert.equal(entry.plan.toLowerCase(), r.plan.replace(/\\/g, '/').toLowerCase());
  assert.equal(typeof entry.machine, 'string');
  assert.ok(entry.machine.length > 0);
  // Python's sys.platform, which matches Node's on Windows, Linux and macOS.
  assert.equal(entry.platform, process.platform);
});

test('a second launch from a new session lands in the same folder', () => {
  const r = makeRun();
  archiveOk(r.manifest, [r.wf1], r.hist);
  const wf2 = addLaunch(r.root, 's2', 'wf_2', DAY2, { status: 'stopped', acceptance: 'rejected' });
  const out = archiveOk(r.manifest, [wf2], r.hist);
  assert.ok(out.folder.replace(/\\/g, '/').endsWith('/2026-10-10-x1'), out.folder);
  assert.ok(out.added.includes('wf_2/agent-a.jsonl'));
  assert.ok(out.added.includes('wf_2.json'));
  const index = readIndex(r.hist);
  assert.equal(index.runs.length, 1);
  const entry = index.runs[0];
  assert.equal(entry.folder, '2026-10-10-x1');
  assert.equal(entry.launches, 2);
  assert.ok(entry.first_launch.startsWith('2026-10-10T07:00:00'), entry.first_launch);
  assert.ok(entry.last_launch.startsWith('2026-10-11T07:00:00'), entry.last_launch);
  // status and acceptance come from the latest launch.
  assert.equal(entry.status, 'stopped');
  assert.equal(entry.acceptance, 'rejected');
  const folder = join(r.hist, '2026-10-10-x1');
  assert.ok(existsSync(join(folder, 'wf_1', 'agent-a.jsonl')));
  assert.ok(existsSync(join(folder, 'wf_1.json')));
  assert.ok(existsSync(join(folder, 'wf_2', 'agent-b.jsonl')));
  assert.deepEqual(readdirSync(r.hist).sort(), ['2026-10-10-x1', 'index.json']);
});

test('rerunning refreshes changed files and never deletes', () => {
  const r = makeRun();
  archiveOk(r.manifest, [r.wf1], r.hist);
  const wf2 = addLaunch(r.root, 's2', 'wf_2', DAY2);
  archiveOk(r.manifest, [wf2], r.hist);
  const report = join(r.run, 'p.x1.report.json');
  writeJson(report, { engine_version: '1.4.4', agents: [{ label: 'changed' }] });
  rmSync(r.wf1, { recursive: true, force: true });
  const out = archiveOk(r.manifest, [wf2], r.hist);
  const folder = join(r.hist, '2026-10-10-x1');
  assert.deepEqual(out.updated, ['p.x1.report.json']);
  assert.deepEqual(out.added, []);
  assertSameBytes(report, join(folder, 'p.x1.report.json'));
  assert.ok(existsSync(join(folder, 'wf_1', 'agent-a.jsonl')), 'the archived wf_1 is kept');
  assert.ok(existsSync(join(folder, 'wf_1.json')));
  // The same launches as before: a rerun never raises the count.
  const entry = readIndex(r.hist).runs[0];
  assert.equal(entry.launches, 2);
  assert.ok(entry.first_launch.startsWith('2026-10-10T07:00:00'), entry.first_launch);
});

test('same run id from another ledger is a different run', () => {
  const a = makeRun();
  const b = makeRun();
  archiveOk(a.manifest, [a.wf1], a.hist);
  const out = archiveOk(b.manifest, [b.wf1], a.hist);
  assert.ok(out.folder.replace(/\\/g, '/').endsWith('/2026-10-10-x1-2'), out.folder);
  const index = readIndex(a.hist);
  assert.equal(index.runs.length, 2);
  const byLedger = (r) => index.runs.find((e) => e.ledger_dir.toLowerCase() === r.ledger.replace(/\\/g, '/').toLowerCase());
  assert.equal(byLedger(a).folder, '2026-10-10-x1');
  assert.equal(byLedger(b).folder, '2026-10-10-x1-2');
  assertSameBytes(b.manifest, join(a.hist, '2026-10-10-x1-2', 'p.lanes.json'));
  // Archiving the first run again keeps it in its own folder.
  const again = archiveOk(a.manifest, [a.wf1], a.hist);
  assert.ok(again.folder.replace(/\\/g, '/').endsWith('/2026-10-10-x1'), again.folder);
  assert.equal(readIndex(a.hist).runs.length, 2);
});

test('two archive-runs at once lose no entry', async () => {
  const a = makeRun({ runId: 'x1' });
  const b = makeRun({ runId: 'y1' });
  const hist = a.hist;
  const start = (r) => new Promise((resolve, reject) => {
    const child = spawn('python3', [SCRIPT, r.manifest, r.wf1, '--history-dir', hist], { env: cleanEnv() });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });
  const results = await Promise.all([start(a), start(b)]);
  for (const res of results) assert.equal(res.code, 0, res.stderr);
  const index = readIndex(hist);
  assert.deepEqual(index.runs.map((e) => e.run_id).sort(), ['x1', 'y1']);
  assert.deepEqual(index.runs.map((e) => e.folder).sort(), ['2026-10-10-x1', '2026-10-10-y1']);
  assert.ok(!existsSync(join(hist, 'index.lock')));
});

test('refuses a history dir inside the project', () => {
  const r = makeRun();
  const inside = join(r.proj, 'h');
  const res = archive(r.manifest, [r.wf1], inside);
  assert.equal(res.code, 3, res.stderr);
  assert.match(res.stderr, /inside the project/);
  assert.ok(!existsSync(inside), 'nothing is written');
});

test('engine version unavailable without a report', () => {
  const r = makeRun({ report: false });
  const out = archiveOk(r.manifest, [r.wf1], r.hist);
  assert.ok(!out.added.some((rel) => rel.endsWith('.report.json')));
  assert.equal(readIndex(r.hist).runs[0].engine_version, 'unavailable');
});

test('usage errors and unreadable inputs exit 2', () => {
  const r = makeRun();
  assert.equal(archive(r.manifest, [], r.hist).code, 2);
  assert.equal(archive(join(r.run, 'missing.lanes.json'), [r.wf1], r.hist).code, 2);
  assert.equal(archive(r.manifest, [join(r.root, 's', 'wf_9')], r.hist).code, 2);
  // An unreadable index is reported, not replaced.
  mkdirSync(r.hist, { recursive: true });
  writeFileSync(join(r.hist, 'index.json'), '{not json');
  const res = archive(r.manifest, [r.wf1], r.hist);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /index\.json/);
  assert.equal(readFileSync(join(r.hist, 'index.json'), 'utf8'), '{not json');
  assert.ok(!existsSync(join(r.hist, '2026-10-10-x1')));
});
