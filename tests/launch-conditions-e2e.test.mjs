// Launch conditions end to end: ledger conditions binds a hand-written doctor
// result to a launch, autopsy reads the binding back per launch, and
// tool-outcomes prints the hand-back's doctor part from autopsy.json. All three
// are the real scripts, on a run folder built from tests/fixtures/autopsy/run2
// with its launches renamed to wf ids that ledger conditions accepts.
//
// run2's launches: wf_e2e000-001 (08:00:00-08:05:00, stopped) and
// wf_e2e000-002 (09:00:00-09:21:30), both on 2026-10-10. The doctor results
// are written by hand because their observed_at must sit before those
// launches, which a real doctor run cannot supply.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { lf, tempDir } from './platform.mjs';

const RUN2 = join(SKILL_DIR, 'tests', 'fixtures', 'autopsy', 'run2');
const SCRIPTS = join(SKILL_DIR, 'scripts');
const TMP = tempDir('pl-launch-conditions-e2e-');
after(() => rmSync(TMP, { recursive: true, force: true }));

const WF1 = 'wf_e2e000-001';
const WF2 = 'wf_e2e000-002';
const RENAMED = { wf_1: WF1, wf_2: WF2 };
const LEDGER_DIR = 'p.f2.ledger';
const MEMORY_LOW = { check: 'memory', detail: '3.2 GB of physical memory available (under 4 GB)' };

function script(name, ...args) {
  const res = spawnSync('python3', [join(SCRIPTS, name), ...args], { encoding: 'utf8' });
  return { code: res.status, stdout: lf(res.stdout), stderr: lf(res.stderr) };
}

// Copies src into dst, each entry straight to its final name (renaming after
// a copy can fail on Windows while a scanner holds the new files). wf_1 and
// wf_2 (folder and manifest) take their new wf ids, and the ledger's
// _run.jsonl is left out so each test adds its own setup events.
function copyEntries(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    const stem = name.endsWith('.json') ? name.slice(0, -5) : name;
    const wf = RENAMED[stem];
    if (wf && name.endsWith('.json')) {
      const manifest = JSON.parse(readFileSync(from, 'utf8'));
      manifest.runId = wf;
      writeFileSync(join(dst, `${wf}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
    } else if (wf) {
      cpSync(from, join(dst, wf), { recursive: true });
    } else if (name === LEDGER_DIR) {
      mkdirSync(join(dst, name));
      for (const inner of readdirSync(from)) {
        if (inner === '_run.jsonl') continue;
        cpSync(join(from, inner), join(dst, name, inner), { recursive: true });
      }
    } else if (statSync(from).isDirectory()) {
      cpSync(from, join(dst, name), { recursive: true });
    } else {
      copyFileSync(from, join(dst, name));
    }
  }
}

let counter = 0;
// A new run folder in its own temp root; returns the folder, its ledger dir
// and the root (for doctor files, which stay outside the run folder).
function runFolder() {
  counter += 1;
  const root = join(TMP, `case ${counter}`);
  const dir = join(root, 'run');
  copyEntries(RUN2, dir);
  return { root, dir, ledgerDir: join(dir, LEDGER_DIR) };
}

function setup(ledgerDir, head) {
  const entry = { task: '_run', event: 'run_started', phase: 'setup', head };
  const res = script('ledger', 'append', ledgerDir, '_run', JSON.stringify(entry));
  assert.equal(res.code, 0, res.stderr);
}

// A doctor --json result observed at hms on 2026-10-10, for run2's manifest.
function doctorResult(hms, warnings = []) {
  return {
    status: 'ok', failures: [], warnings, skipped: [],
    observed_at: `2026-10-10T${hms}Z`, doctor_version: '1.5.1', run_id: 'f2',
  };
}

// Writes the doctor result to a file in root and binds it to wf; returns the
// ledger conditions result.
function conditions(root, ledgerDir, wf, doctor) {
  counter += 1;
  const file = join(root, `doctor-result-${counter}.json`);
  writeFileSync(file, `${JSON.stringify(doctor, null, 2)}\n`);
  return script('ledger', 'conditions', ledgerDir, wf, file);
}

function bound(res, wf, setupEvent) {
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), { recorded: `doctor-${wf}.json`, setup_event: setupEvent });
}

function autopsy(dir) {
  const res = script('autopsy', dir);
  assert.equal(res.code, 0, res.stderr);
  const json = JSON.parse(readFileSync(join(dir, 'autopsy.json'), 'utf8'));
  assert.deepEqual(json.launches.map((l) => l.wf), [WF1, WF2]);
  assert.deepEqual(json.launch_conditions.map((x) => x.wf), [WF1, WF2]);
  return { json, byWf: Object.fromEntries(json.launch_conditions.map((x) => [x.wf, x])) };
}

function toolOutcomes(dir) {
  const res = script('tool-outcomes', '--run-folder', dir, '--archive-exit', '0', '--autopsy-exit', '0',
    '--cleanup', 'none');
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /^Run tools: [^\n]*\n$/);
  return res.stdout.slice(0, -1);
}

test('each launch keeps its own conditions', () => {
  const { root, dir, ledgerDir } = runFolder();
  setup(ledgerDir, 'h1');
  bound(conditions(root, ledgerDir, WF1, doctorResult('07:55:00', [MEMORY_LOW])), WF1, 1);
  setup(ledgerDir, 'h2');
  bound(conditions(root, ledgerDir, WF2, doctorResult('08:58:00')), WF2, 2);

  const { byWf } = autopsy(dir);
  assert.equal(byWf[WF1].state, 'recorded');
  assert.equal(byWf[WF2].state, 'recorded');
  assert.deepEqual(byWf[WF1].checks, [{ check: 'memory', outcome: 'warning', detail: MEMORY_LOW.detail, read: true }]);
  assert.deepEqual(byWf[WF2].checks, []);

  const line = toolOutcomes(dir);
  assert.ok(line.includes(`doctor before ${WF2}: ok`), line);
  assert.ok(line.includes('(earlier launches: see autopsy)'), line);
  assert.ok(!line.includes('memory'), line);
});

test('a late binding to the wrong launch is never shown', () => {
  const { root, dir, ledgerDir } = runFolder();
  setup(ledgerDir, 'h1');
  setup(ledgerDir, 'h2');
  // ledger conditions cannot tell that this result was observed for the
  // second launch: it binds it to the first.
  bound(conditions(root, ledgerDir, WF1, doctorResult('08:58:00', [MEMORY_LOW])), WF1, 2);

  const { byWf } = autopsy(dir);
  assert.equal(byWf[WF1].state, 'inconsistent');
  assert.equal(byWf[WF1].reason, 'observed after the launch started');
  assert.deepEqual(byWf[WF1].checks, []);
  assert.deepEqual(byWf[WF1].possible_contributors, []);
  assert.equal(byWf[WF2].state, 'unavailable');

  const line = toolOutcomes(dir);
  assert.ok(line.includes('launch conditions not recorded'), line);
  assert.ok(!line.includes('memory'), line);
});

test("a dry run's wf bound by mistake is an orphan", () => {
  const { root, dir, ledgerDir } = runFolder();
  setup(ledgerDir, 'h1');
  bound(conditions(root, ledgerDir, 'wf_dryrun-0001', doctorResult('07:55:00', [MEMORY_LOW])), 'wf_dryrun-0001', 1);

  const { json, byWf } = autopsy(dir);
  assert.deepEqual(json.orphan_snapshots, ['wf_dryrun-0001']);
  assert.equal(byWf[WF1].state, 'unavailable');
  assert.equal(byWf[WF2].state, 'unavailable');

  const line = toolOutcomes(dir);
  assert.ok(line.includes('launch conditions not recorded'), line);
  assert.ok(!line.includes('memory'), line);
});
