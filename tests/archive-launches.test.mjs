// scripts/archive-run counts the launches the ledger recorded and warns when
// fewer are archived (spec 4.2), takes --ledger and --notes, and archives
// derive.json and setup.json from a run-owned folder (spec 4.3). Each test
// builds its own temp run and history dir and passes --history-dir.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { mergeEnv, tempDir } from './platform.mjs';

const SCRIPT = join(SKILL_DIR, 'scripts', 'archive-run');
const TMP = tempDir('pl-archive-launches-');
after(() => rmSync(TMP, { recursive: true, force: true }));

const DAY1 = Date.UTC(2026, 9, 10, 7, 0, 0);
const DAY2 = DAY1 + 24 * 3600 * 1000;

// The environment without the history variables a developer may have set,
// plus extra.
function cleanEnv(extra = {}) {
  const env = mergeEnv(process.env);
  for (const key of Object.keys(env)) {
    if (['PL_HISTORY_DIR', 'CLAUDE_CONFIG_DIR'].includes(key.toUpperCase())) delete env[key];
  }
  return { ...env, ...extra };
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

function jsonl(events) {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

// A launch dir <root>/<session>/<id> with one transcript and its result file.
function addLaunch(root, session, id, startMs) {
  const dir = join(root, session, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'agent-a.jsonl'),
    JSON.stringify({ type: 'assistant', timestamp: new Date(startMs).toISOString() }) + '\n');
  writeJson(`${dir}.json`, { runId: id, startTime: startMs, result: { status: 'complete' } });
  return dir;
}

// A run: <runDir>/p.lanes.json with its ledger, plan and spec beside it, the
// project at <root>/proj and one launch <root>/s/wf_a. events is the ledger's
// _run.jsonl.
function makeRun({ events = [{ task: '_run', event: 'run_ended', status: 'complete', agents: 1, rulings: 0 }],
  runDir = null, runId = 'x1' } = {}) {
  const root = freshDir('case');
  const run = runDir || join(root, 'run');
  const proj = join(root, 'proj');
  const ledger = join(run, `p.${runId}.ledger`);
  mkdirSync(ledger, { recursive: true });
  mkdirSync(proj, { recursive: true });
  const manifest = join(run, 'p.lanes.json');
  const plan = join(run, 'p.md');
  writeJson(manifest, { version: 1, run_id: runId, plan, spec: null, repo: { mode: 'git', root: proj, ledger_dir: ledger } });
  writeFileSync(join(ledger, '_run.jsonl'), jsonl(events));
  writeFileSync(plan, '# Plan\n');
  const wfA = addLaunch(root, 's', 'wf_a', DAY1);
  return { root, run, proj, ledger, manifest, plan, wfA, hist: join(root, 'hist'), runId };
}

function archive(args, hist, env = {}) {
  const res = spawnSync('python3', ['-B', SCRIPT, ...args, '--history-dir', hist], { encoding: 'utf8', env: cleanEnv(env) });
  return { code: res.status, out: res.status === 0 ? JSON.parse(res.stdout) : null, stderr: res.stderr, stdout: res.stdout };
}

function archiveOk(args, hist, env = {}) {
  const res = archive(args, hist, env);
  assert.equal(res.code, 0, res.stderr);
  return res.out;
}

function readIndex(hist) {
  return JSON.parse(readFileSync(join(hist, 'index.json'), 'utf8'));
}

const ENDED = { task: '_run', event: 'run_ended', status: 'stopped', agents: 3, rulings: 0 };

test('two run_ended and one wf dir warn launches_missing', () => {
  const r = makeRun({ events: [ENDED, ENDED] });
  const out = archiveOk([r.manifest, r.wfA], r.hist);
  const warn = out.warnings.filter((w) => w.code === 'launches_missing');
  assert.equal(warn.length, 1, JSON.stringify(out.warnings));
  assert.match(warn[0].detail, /1 archived/);
  assert.match(warn[0].detail, /2 recorded/);
  const entry = readIndex(r.hist).runs[0];
  assert.equal(entry.launches, 1);
  assert.equal(entry.launches_recorded, 2);
});

test('no warning when every recorded launch is archived', () => {
  const r = makeRun({ events: [ENDED] });
  const out = archiveOk([r.manifest, r.wfA], r.hist);
  assert.deepEqual(out.warnings.filter((w) => w.code === 'launches_missing'), []);
  assert.equal(readIndex(r.hist).runs[0].launches_recorded, 1);
});

test('named wf ids appear in the warning and raise the count', () => {
  const r = makeRun({
    events: [
      ENDED,
      { task: '_run', event: 'carried', wf: 'wf_a', pf: {}, bound: [] },
      { task: '_run', event: 'carried', wf: 'wf_b', pf: {}, bound: [] },
    ],
  });
  const out = archiveOk([r.manifest, r.wfA], r.hist);
  const warn = out.warnings.find((w) => w.code === 'launches_missing');
  assert.ok(warn, JSON.stringify(out.warnings));
  assert.match(warn.detail, /2 recorded/);
  assert.match(warn.detail, /wf_b/);
  assert.doesNotMatch(warn.detail, /wf_a/);
  assert.equal(readIndex(r.hist).runs[0].launches_recorded, 2);
});

test('a doctor file names a launch', () => {
  const r = makeRun({ events: [ENDED] });
  writeJson(join(r.ledger, 'doctor-wf_a.json'), { launch: { wf: 'wf_a' } });
  writeJson(join(r.ledger, 'doctor-wf_c.json'), { launch: { wf: 'wf_c' } });
  const out = archiveOk([r.manifest, r.wfA], r.hist);
  const warn = out.warnings.find((w) => w.code === 'launches_missing');
  assert.ok(warn, JSON.stringify(out.warnings));
  assert.match(warn.detail, /wf_c/);
  assert.doesNotMatch(warn.detail, /wf_a/);
  assert.equal(readIndex(r.hist).runs[0].launches_recorded, 2);
});

test('reindex writes launches_recorded', () => {
  const r = makeRun({ events: [ENDED, ENDED, ENDED] });
  archiveOk([r.manifest, r.wfA], r.hist);
  // An index entry without the key, as an older release wrote it.
  const index = readIndex(r.hist);
  delete index.runs[0].launches_recorded;
  writeJson(join(r.hist, 'index.json'), index);
  const res = spawnSync('python3', ['-B', SCRIPT, '--reindex', '--history-dir', r.hist], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(readIndex(r.hist).runs[0].launches_recorded, 3);
  // A folder with no ledger says unavailable.
  rmSync(join(r.hist, '2026-10-10-x1', 'p.x1.ledger'), { recursive: true, force: true });
  const again = spawnSync('python3', ['-B', SCRIPT, '--reindex', '--history-dir', r.hist], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(readIndex(r.hist).runs[0].launches_recorded, 'unavailable');
});

test('--ledger archives a run whose live ledger is gone into its existing folder', () => {
  const r = makeRun({ events: [ENDED, ENDED] });
  const first = archiveOk([r.manifest, r.wfA], r.hist);
  rmSync(r.ledger, { recursive: true, force: true });
  const folder = join(r.hist, '2026-10-10-x1');
  const archivedLedger = join(folder, 'p.x1.ledger');
  const archivedManifest = join(folder, 'p.lanes.json');
  // Without --ledger the live ledger is needed.
  const wfB = addLaunch(r.root, 's2', 'wf_b', DAY2);
  assert.equal(archive([archivedManifest, wfB], r.hist).code, 2);
  const out = archiveOk([archivedManifest, wfB, '--ledger', archivedLedger], r.hist);
  assert.equal(out.folder, first.folder);
  assert.ok(out.added.includes('wf_b/agent-a.jsonl'), JSON.stringify(out.added));
  assert.ok(out.added.includes('wf_b.json'));
  // Copying the ledger onto itself changes nothing.
  assert.ok(!out.added.some((rel) => rel.startsWith('p.x1.ledger/')));
  assert.ok(!out.updated.some((rel) => rel.startsWith('p.x1.ledger/')));
  assert.deepEqual(out.warnings.filter((w) => w.code === 'launches_missing'), []);
  const index = readIndex(r.hist);
  assert.equal(index.runs.length, 1);
  assert.equal(index.runs[0].launches, 2);
  assert.equal(index.runs[0].launches_recorded, 2);
});

test('--ledger at a folder without _run.jsonl exits 2', () => {
  const r = makeRun();
  const notLedger = freshDir('not-ledger');
  const res = archive([r.manifest, r.wfA, '--ledger', notLedger], r.hist);
  assert.equal(res.code, 2, res.stderr);
  assert.match(res.stderr, /_run\.jsonl/);
  assert.ok(!existsSync(r.hist), 'nothing is written');
  assert.equal(archive([r.manifest, r.wfA, '--ledger'], r.hist).code, 2);
});

test('--notes copies into notes/', () => {
  const r = makeRun();
  const dir = join(r.root, 'my notes');
  mkdirSync(dir);
  const note = join(dir, 'review one.md');
  writeFileSync(note, 'first\n');
  const out = archiveOk([r.manifest, r.wfA, '--notes', note], r.hist);
  assert.ok(out.added.includes('notes/review one.md'), JSON.stringify(out.added));
  const archived = join(r.hist, '2026-10-10-x1', 'notes', 'review one.md');
  assert.equal(readFileSync(archived, 'utf8'), 'first\n');
  writeFileSync(note, 'second\n');
  const again = archiveOk([r.manifest, r.wfA, '--notes', note], r.hist);
  assert.deepEqual(again.updated, ['notes/review one.md']);
  assert.equal(readFileSync(archived, 'utf8'), 'second\n');
});

test('--notes takes the arguments up to the next option', () => {
  const r = makeRun();
  const a = join(r.root, 'a.md');
  const b = join(r.root, 'b.txt');
  writeFileSync(a, 'a\n');
  writeFileSync(b, 'b\n');
  const out = archiveOk([r.manifest, r.wfA, '--notes', a, b], r.hist);
  assert.ok(out.added.includes('notes/a.md'));
  assert.ok(out.added.includes('notes/b.txt'));
  assert.equal(archive([r.manifest, r.wfA, '--notes'], r.hist).code, 2);
  assert.equal(archive([r.manifest, r.wfA, '--notes', join(r.root, 'missing.md')], r.hist).code, 2);
});

test('two notes with one basename exit 2 and write nothing', () => {
  const r = makeRun();
  for (const sub of ['one', 'two']) {
    mkdirSync(join(r.root, sub));
    writeFileSync(join(r.root, sub, 'n.md'), sub + '\n');
  }
  const res = archive([r.manifest, r.wfA, '--notes', join(r.root, 'one', 'n.md'), join(r.root, 'two', 'n.md')], r.hist);
  assert.equal(res.code, 2, res.stderr);
  assert.match(res.stderr, /n\.md/);
  assert.ok(!existsSync(r.hist), 'nothing is written');
});

test('notes alone for an indexed run', () => {
  const r = makeRun();
  const note = join(r.root, 'x.md');
  writeFileSync(note, 'note\n');
  // Not in the index yet: exit 2, nothing written.
  const refused = archive([r.manifest, '--notes', note], r.hist);
  assert.equal(refused.code, 2, refused.stderr);
  assert.ok(!existsSync(join(r.hist, '2026-10-10-x1')));
  // A manifest alone, without --notes, is a usage error.
  assert.equal(archive([r.manifest], r.hist).code, 2);
  archiveOk([r.manifest, r.wfA], r.hist);
  const out = archiveOk([r.manifest, '--notes', note], r.hist);
  assert.deepEqual(out.added, ['notes/x.md']);
  assert.ok(!out.added.some((rel) => rel.startsWith('wf_')));
  const entry = readIndex(r.hist).runs[0];
  assert.equal(entry.launches, 1);
  assert.equal(entry.launches_recorded, 1);
});

test('notes alone with the live ledger gone uses the archived ledger', () => {
  const r = makeRun({ events: [ENDED, ENDED] });
  archiveOk([r.manifest, r.wfA], r.hist);
  rmSync(r.ledger, { recursive: true, force: true });
  const note = join(r.root, 'x.md');
  writeFileSync(note, 'note\n');
  const out = archiveOk([r.manifest, '--notes', note], r.hist);
  assert.deepEqual(out.added, ['notes/x.md']);
  const warn = out.warnings.find((w) => w.code === 'launches_missing');
  assert.ok(warn, JSON.stringify(out.warnings));
  assert.equal(readIndex(r.hist).runs[0].launches_recorded, 2);
  assert.ok(existsSync(join(r.hist, '2026-10-10-x1', 'p.x1.ledger', '_run.jsonl')), 'the archived ledger is kept');
});

test('derive.json and setup.json come from a run-owned folder only', () => {
  const config = join(freshDir('config'), 'claude config');
  const owned = join(config, 'parallel-lanes', 'runs', 'x1');
  mkdirSync(owned, { recursive: true });
  const r = makeRun({ runDir: owned });
  writeJson(join(owned, 'derive.json'), { lanes: [] });
  writeJson(join(owned, 'setup.json'), { ok: true });
  const out = archiveOk([r.manifest, r.wfA], r.hist, { CLAUDE_CONFIG_DIR: config });
  assert.ok(out.added.includes('derive.json'), JSON.stringify(out.added));
  assert.ok(out.added.includes('setup.json'));
  const folder = join(r.hist, '2026-10-10-x1');
  assert.ok(readFileSync(join(folder, 'derive.json')).equals(readFileSync(join(owned, 'derive.json'))));
  // The same files beside a manifest in another folder are not archived.
  const other = makeRun();
  writeJson(join(other.run, 'derive.json'), { lanes: [] });
  writeJson(join(other.run, 'setup.json'), { ok: true });
  const out2 = archiveOk([other.manifest, other.wfA], other.hist, { CLAUDE_CONFIG_DIR: config });
  assert.ok(!out2.added.includes('derive.json'), JSON.stringify(out2.added));
  assert.ok(!out2.added.includes('setup.json'));
  assert.ok(!readdirSync(join(other.hist, '2026-10-10-x1')).includes('derive.json'));
});
