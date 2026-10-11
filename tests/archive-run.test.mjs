// scripts/archive-run: copies a run (manifest, ledger, report, plan, spec,
// transcript dirs and their workflow result files) into a dated folder of the
// history dir and records it in index.json. Each test builds its own temp run
// and history dir and passes --history-dir, so no real history is touched.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
  assert.ok(lockFree(r.hist), 'the lock is released');
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
  assert.deepEqual(readdirSync(r.hist).sort(), ['2026-10-10-x1', 'index.json', 'index.lock']);
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
  assert.ok(lockFree(hist));
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

test('a plan and spec that would share a name are refused', () => {
  const r = makeRun();
  // The spec in another directory, with the plan's file name.
  const other = join(r.root, 'other');
  mkdirSync(other);
  const spec = join(other, 'p.md');
  writeFileSync(spec, '# Another spec\n');
  editManifest(r.manifest, (m) => { m.spec = spec; });
  const res = archive(r.manifest, [r.wf1], r.hist);
  assert.equal(res.code, 2, res.stderr);
  assert.match(res.stderr, /two files would be archived as p\.md/);
  assert.ok(!existsSync(join(r.hist, '2026-10-10-x1')), 'nothing is written');
  // A spec named like the manifest is refused too.
  const named = join(other, 'P.lanes.json');
  writeFileSync(named, '{}');
  editManifest(r.manifest, (m) => { m.spec = named; });
  assert.equal(archive(r.manifest, [r.wf1], r.hist).code, 2);
  // The same file as plan and spec is archived once.
  editManifest(r.manifest, (m) => { m.spec = m.plan; });
  const out = archiveOk(r.manifest, [r.wf1], r.hist);
  assert.equal(out.added.filter((rel) => rel === 'p.md').length, 1);
});

function editManifest(path, edit) {
  const m = JSON.parse(readFileSync(path, 'utf8'));
  edit(m);
  writeJson(path, m);
}

// --- --reindex ---------------------------------------------------------------

function reindex(hist) {
  const res = spawnSync('python3', [SCRIPT, '--reindex', '--history-dir', hist], { encoding: 'utf8', env: cleanEnv() });
  return { code: res.status, out: res.status === 0 ? JSON.parse(res.stdout) : null, stderr: res.stderr };
}

function reindexOk(hist) {
  const res = reindex(hist);
  assert.equal(res.code, 0, res.stderr);
  return res.out;
}

// A history folder as an earlier release or an import left it.
function importedFolder(hist, name, { runId, report, reportBody, manifest }) {
  const folder = join(hist, name);
  mkdirSync(folder, { recursive: true });
  writeJson(join(folder, 'p.lanes.json'), manifest);
  if (report) writeJson(join(folder, report), reportBody);
  return folder;
}

function hashes(dir) {
  const out = {};
  for (const rel of filesUnder(dir)) out[rel] = createHash('sha256').update(readFileSync(join(dir, rel))).digest('hex');
  return out;
}

function importedHistory() {
  const hist = join(freshDir('hist'), 'history');
  mkdirSync(hist, { recursive: true });
  const p140 = importedFolder(hist, 'r140', {
    report: 'p.r140.report.json',
    reportBody: { engine_version: '1.4.0', agents: [] },
    manifest: { version: 1, run_id: 'r140', plan: 'C:\\work\\p.md', repo: { mode: 'git', root: 'C:\\work\\proj', ledger_dir: 'C:\\work\\run\\p.r140.ledger' } },
  });
  addLaunch(p140, '', 'wf_a', DAY1);
  const add1 = importedFolder(hist, 'addendum-1', {
    report: 'p.addendum-1.run-report.json',
    reportBody: { engine_version: '1.4.2', agents: [] },
    manifest: { version: 1, run_id: 'add1', plan: 'C:/work/p.md', repo: { mode: 'git', root: 'C:/work/proj', ledger_dir: 'C:/work/run/p.add1.ledger' } },
  });
  addLaunch(add1, '', 'wf_b', DAY1, { status: 'stopped', acceptance: 'rejected' });
  addLaunch(add1, '', 'wf_c', DAY2);
  const l131 = importedFolder(hist, 'l131', {
    report: 'report.json',
    reportBody: { agents: [] },
    manifest: { version: 1, run_id: 'l131', plan: '/home/u/proj/docs/plan.md', repo: { mode: 'git', root: '/home/u/proj', ledger_dir: '/home/u/proj/.ledger/l131' } },
  });
  mkdirSync(join(l131, 'wf_old'), { recursive: true });
  return hist;
}

test('reindex reads the imported layouts', () => {
  const hist = importedHistory();
  const out = reindexOk(hist);
  assert.equal(out.runs, 3);
  assert.deepEqual(out.skipped, []);
  const index = readIndex(hist);
  assert.equal(index.version, 1);
  assert.deepEqual(index.runs.map((e) => e.folder).sort(), ['addendum-1', 'l131', 'r140']);
  const by = Object.fromEntries(index.runs.map((e) => [e.folder, e]));
  assert.equal(by.r140.run_id, 'r140');
  assert.equal(by.r140.engine_version, '1.4.0');
  assert.equal(by.r140.launches, 1);
  assert.equal(by.r140.ledger_dir, 'C:/work/run/p.r140.ledger');
  assert.equal(by.r140.plan, 'C:/work/p.md');
  assert.ok(by.r140.first_launch.startsWith('2026-10-10T07:00:00'), by.r140.first_launch);
  assert.equal(by['addendum-1'].engine_version, '1.4.2');
  assert.equal(by['addendum-1'].launches, 2);
  assert.ok(by['addendum-1'].first_launch.startsWith('2026-10-10T07:00:00'));
  assert.ok(by['addendum-1'].last_launch.startsWith('2026-10-11T07:00:00'));
  assert.equal(by['addendum-1'].status, 'complete');
  assert.equal(by['addendum-1'].acceptance, 'accepted');
  assert.equal(by.l131.engine_version, 'unavailable');
  assert.equal(by.l131.plan, '/home/u/proj/docs/plan.md');
  assert.equal(by.l131.project, '/home/u/proj');
  assert.equal(by.l131.ledger_dir, '/home/u/proj/.ledger/l131');
  assert.equal(by.l131.launches, 1);
  assert.equal(by.l131.first_launch, 'unavailable');
  assert.equal(by.l131.status, 'unavailable');
  // No old index entry: the machine running reindex is not the run's.
  for (const e of index.runs) {
    assert.equal(e.machine, 'unavailable', e.folder);
    assert.equal(e.platform, 'unavailable', e.folder);
  }
  assert.ok(lockFree(hist));
});

test('reindex keeps the machine and platform of an old entry', () => {
  const hist = importedHistory();
  writeJson(join(hist, 'index.json'), {
    version: 1,
    runs: [{ run_id: 'r140', folder: 'r140', ledger_dir: 'C:/work/run/p.r140.ledger', machine: 'box1', platform: 'linux' }],
  });
  reindexOk(hist);
  const by = Object.fromEntries(readIndex(hist).runs.map((e) => [e.folder, e]));
  assert.equal(by.r140.machine, 'box1');
  assert.equal(by.r140.platform, 'linux');
  assert.equal(by.l131.machine, 'unavailable');
  assert.equal(by.l131.platform, 'unavailable');
});

test('reindex keeps the launch dates of an old entry when no launch has a time', () => {
  const hist = importedHistory();
  writeJson(join(hist, 'index.json'), {
    version: 1,
    runs: [{
      run_id: 'l131', folder: 'l131', ledger_dir: '/home/u/proj/.ledger/l131',
      first_launch: '2026-10-01T07:00:00Z', last_launch: '2026-10-02T07:00:00Z',
    }],
  });
  reindexOk(hist);
  const l131 = readIndex(hist).runs.find((e) => e.folder === 'l131');
  assert.deepEqual([l131.first_launch, l131.last_launch], ['2026-10-01T07:00:00Z', '2026-10-02T07:00:00Z']);
});

test('reindex skips folders without a manifest and says why', () => {
  const hist = importedHistory();
  mkdirSync(join(hist, 'misc'));
  writeFileSync(join(hist, 'misc', 'notes.txt'), 'hello\n');
  const out = reindexOk(hist);
  assert.equal(out.runs, 3);
  assert.equal(out.skipped.length, 1);
  assert.equal(out.skipped[0].folder, 'misc');
  assert.match(out.skipped[0].reason, /lanes\.json/);
  assert.ok(!readIndex(hist).runs.some((e) => e.folder === 'misc'));
});

test('reindex changes no file but index.json', () => {
  const hist = importedHistory();
  mkdirSync(join(hist, 'misc'));
  writeFileSync(join(hist, 'misc', 'notes.txt'), 'hello\n');
  const before = hashes(hist);
  reindexOk(hist);
  // index.lock, the lock file, stays and holds its last holder's details.
  const mid = hashes(hist);
  assert.ok('index.json' in mid);
  assert.ok('index.lock' in mid);
  delete mid['index.json'];
  delete mid['index.lock'];
  assert.deepEqual(mid, before);
  // A second run over an existing index changes only index.json again.
  reindexOk(hist);
  const after = hashes(hist);
  delete after['index.json'];
  delete after['index.lock'];
  assert.deepEqual(after, before);
  assert.deepEqual(readdirSync(hist).sort(), ['addendum-1', 'index.json', 'index.lock', 'l131', 'misc', 'r140']);
});

test('reindex rebuilds from the folders and exits 2 on a missing dir', () => {
  const hist = importedHistory();
  writeFileSync(join(hist, 'index.json'), '{not json');
  assert.equal(reindexOk(hist).runs, 3);
  assert.equal(readIndex(hist).runs.length, 3);
  const res = reindex(join(hist, 'nope'));
  assert.equal(res.code, 2);
  assert.ok(!existsSync(join(hist, 'nope')));
});

const HISTORY_PRELUDE = [
  'import json, os, sys',
  'sys.dont_write_bytecode = True',
  `sys.path.insert(0, ${JSON.stringify(join(SKILL_DIR, 'scripts'))})`,
  'import _history',
  '',
].join('\n');

// Whether the index lock of hist is free: index_lock(hist, wait_s=0) succeeds.
function lockFree(hist) {
  const code = HISTORY_PRELUDE + [
    'try:',
    '    with _history.index_lock(sys.argv[1], wait_s=0):',
    '        pass',
    'except _history.HistoryError:',
    '    sys.exit(1)',
  ].join('\n');
  const res = spawnSync('python3', ['-c', code, hist], { encoding: 'utf8', env: cleanEnv() });
  assert.ok(res.status === 0 || res.status === 1, `python failed: ${res.stderr}`);
  return res.status === 0;
}

// A Python child that holds the index lock of hist until release() closes
// its stdin, as another archive-run would. Resolves once the child prints held.
async function holdLock(hist) {
  const code = HISTORY_PRELUDE + [
    'with _history.index_lock(sys.argv[1]):',
    "    print('held', flush=True)",
    '    sys.stdin.read()',
  ].join('\n');
  const child = spawn('python3', ['-c', code, hist], { env: cleanEnv() });
  let stdout = '';
  let stderr = '';
  let exited = false;
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const closed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (status) => { exited = true; resolve(status); });
  });
  const deadline = Date.now() + 60000;
  while (!stdout.includes('held') && !exited && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!stdout.includes('held')) {
    child.kill();
    assert.fail(`the holder did not take the lock: ${stderr}`);
  }
  return {
    child,
    closed,
    release() {
      child.stdin.end();
      return closed;
    },
  };
}

test('reindex exits 2 when the lock is not acquired', async () => {
  const hist = importedHistory();
  const holder = await holdLock(hist);
  // archive-run's main with index_lock waiting 0.5 s instead of 30 s.
  const code = [
    'import importlib.machinery, importlib.util, sys',
    'sys.dont_write_bytecode = True',
    "loader = importlib.machinery.SourceFileLoader('archive_run', sys.argv[1])",
    'mod = importlib.util.module_from_spec(importlib.util.spec_from_loader(loader.name, loader))',
    'loader.exec_module(mod)',
    'held = mod._history.index_lock',
    'mod._history.index_lock = lambda hdir: held(hdir, wait_s=0.5)',
    "sys.exit(mod.main(['archive-run', '--reindex', '--history-dir', sys.argv[2]]))",
  ].join('\n');
  try {
    const res = spawnSync('python3', ['-c', code, SCRIPT, hist], { encoding: 'utf8', env: cleanEnv() });
    assert.equal(res.status, 2, res.stderr);
    assert.match(res.stderr, /index\.lock is held/);
    assert.equal(res.stdout, '');
    assert.ok(!existsSync(join(hist, 'index.json')), 'no index is written');
    assert.ok(!lockFree(hist), 'the other holder still holds the lock');
  } finally {
    await holder.release();
  }
  assert.ok(lockFree(hist), 'the lock is free once its holder releases it');
});

test('reindex keeps a run archived while it waited for the lock', async () => {
  const hist = importedHistory();
  const holder = await holdLock(hist);
  const child = spawn('python3', [SCRIPT, '--reindex', '--history-dir', hist], { env: cleanEnv() });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  // Wait until reindex says it waits on the lock (index_lock's notice), then
  // do what an archive-run holding the lock does: add a run folder and its
  // entry. A reindex that listed the folders before taking the lock would
  // miss it, however slowly Python starts.
  try {
    const deadline = Date.now() + 60000;
    while (!stderr.includes('waiting for') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.match(stderr, /waiting for .*index\.lock/);
    const late = importedFolder(hist, 'late', {
      report: 'p.late.report.json',
      reportBody: { engine_version: '1.5.0', agents: [] },
      manifest: { version: 1, run_id: 'late', plan: 'C:/work/p.md', repo: { mode: 'git', root: 'C:/work/proj', ledger_dir: 'C:/work/run/p.late.ledger' } },
    });
    addLaunch(late, '', 'wf_l', DAY2);
    writeJson(join(hist, 'index.json'), {
      version: 1,
      runs: [{ run_id: 'late', folder: 'late', ledger_dir: 'C:/work/run/p.late.ledger', machine: 'box2', platform: 'linux' }],
    });
  } finally {
    await holder.release();
  }
  const code = await done;
  assert.equal(code, 0, stderr);
  assert.equal(JSON.parse(stdout).runs, 4);
  const late1 = readIndex(hist).runs.find((e) => e.folder === 'late');
  assert.ok(late1, 'the late run is indexed');
  assert.equal(late1.machine, 'box2');
  assert.ok(lockFree(hist));
});
