// ledger conditions: a saved doctor result is bound to the launch it was
// observed for, as DIR/doctor-<WF_ID>.json. The real ledger script, temp
// ledgers built with ledger append, and hand-written doctor files.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { IS_WINDOWS, lf, tempDir } from './platform.mjs';

const LEDGER = join(SKILL_DIR, 'scripts', 'ledger');
const TMP = tempDir('pl-ledger-conditions-');
after(() => rmSync(TMP, { recursive: true, force: true }));

const WF = 'wf_abc123-4f5';
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function ledger(...args) {
  const res = spawnSync('python3', [LEDGER, ...args], { encoding: 'utf8' });
  return { code: res.status, stdout: lf(res.stdout), stderr: lf(res.stderr) };
}

let counter = 0;
// A new case folder holding a ledger dir path (not created) and doctor files.
function newCase() {
  counter += 1;
  const root = join(TMP, `case ${counter}`);
  mkdirSync(root, { recursive: true });
  return { root, dir: join(root, 'ledger') };
}

function append(dir, entry) {
  const res = ledger('append', dir, '_run', JSON.stringify(entry));
  assert.equal(res.code, 0, res.stderr);
}
const setup = (dir, head) => append(dir, { task: '_run', event: 'run_started', phase: 'setup', head });
const ended = (dir) => append(dir, { task: '_run', event: 'run_ended', status: 'completed', agents: 1, rulings: 0 });

function doctorResult(observedAt, extra = {}) {
  return {
    status: 'ok', failures: [], warnings: [], skipped: [],
    checks: [{ check: 'git', outcome: 'passed' }],
    observed_at: observedAt, doctor_version: '1.5.1', run_id: null, ...extra,
  };
}
// Write a doctor file holding value (an object, or raw text) and return its path.
function doctorFile(root, name, value) {
  const path = join(root, name);
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
  return path;
}

const listing = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : null);
const snapshot = (dir, wf) => JSON.parse(readFileSync(join(dir, `doctor-${wf}.json`), 'utf8'));

function recorded(res, wf, setupEvent) {
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), { recorded: `doctor-${wf}.json`, setup_event: setupEvent });
}

function refused(res, code) {
  assert.equal(res.code, 3, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), { refused: code });
  const lines = res.stderr.trim().split('\n');
  assert.equal(lines.length, 1, res.stderr);
  assert.ok(lines[0].includes(code), res.stderr);
}

test('the snapshot names the latest setup', () => {
  const { root, dir } = newCase();
  setup(dir, 'a1');
  ended(dir);
  setup(dir, 'b2');
  const doctor = doctorResult('2026-10-11T10:00:00Z');
  const file = doctorFile(root, 'doctor.json', doctor);
  recorded(ledger('conditions', dir, WF, file), WF, 2);

  const text = readFileSync(join(dir, `doctor-${WF}.json`), 'utf8');
  const out = JSON.parse(text);
  assert.deepEqual(out.launch, { wf: WF, setup_event: 2, setup_head: 'b2' });
  assert.deepEqual(out.doctor, doctor);
  assert.match(out.recorded_at, STAMP);
  assert.deepEqual(Object.keys(out), ['launch', 'recorded_at', 'doctor']);
  // Indent 2 with a trailing newline, and no temp file left behind.
  assert.equal(text, JSON.stringify(out, null, 2) + '\n');
  assert.deepEqual(listing(dir), ['_run.jsonl', `doctor-${WF}.json`]);
});

test('a repeated call is a no-op', () => {
  const { root, dir } = newCase();
  setup(dir, 'a1');
  const file = doctorFile(root, 'doctor.json', doctorResult('2026-10-11T10:00:00Z'));
  recorded(ledger('conditions', dir, WF, file), WF, 1);
  // Pin recorded_at to a past time: a rewrite would change it.
  const path = join(dir, `doctor-${WF}.json`);
  const pinned = { ...snapshot(dir, WF), recorded_at: '2000-01-01T00:00:00Z' };
  writeFileSync(path, JSON.stringify(pinned, null, 2) + '\n');
  const before = readFileSync(path);
  recorded(ledger('conditions', dir, WF, file), WF, 1);
  assert.deepEqual(readFileSync(path), before);
  assert.deepEqual(listing(dir), ['_run.jsonl', `doctor-${WF}.json`]);
});

test('each refusal prints its code', () => {
  const check = (dir, args, code) => {
    const before = listing(dir);
    refused(ledger('conditions', dir, ...args), code);
    assert.deepEqual(listing(dir), before, code);
  };

  // no_setup: the ledger has events, but no setup.
  {
    const { root, dir } = newCase();
    ended(dir);
    check(dir, ['wf_aaaaaa', doctorFile(root, 'd.json', doctorResult('2026-10-11T10:00:00Z'))], 'no_setup');
  }

  // setup_recorded, then observation_reused, then wf_recorded on one ledger.
  {
    const { root, dir } = newCase();
    setup(dir, 'a1');
    const first = doctorFile(root, 'd1.json', doctorResult('2026-10-11T10:00:00Z'));
    const second = doctorFile(root, 'd2.json', doctorResult('2026-10-11T11:00:00Z'));
    recorded(ledger('conditions', dir, 'wf_aaaaaa', first), 'wf_aaaaaa', 1);
    // A second wf after the same setup: that launch already has its snapshot.
    check(dir, ['wf_bbbbbb', second], 'setup_recorded');
    // A new setup with the old doctor result: the observation is reused.
    setup(dir, 'b2');
    check(dir, ['wf_cccccc', first], 'observation_reused');
    // The same wf with a different doctor result.
    check(dir, ['wf_aaaaaa', second], 'wf_recorded');
    // A fresh observation binds to the new setup.
    recorded(ledger('conditions', dir, 'wf_cccccc', second), 'wf_cccccc', 2);
  }

  // not_doctor: no status, or an observed_at not in the form.
  {
    const { root, dir } = newCase();
    setup(dir, 'a1');
    check(dir, ['wf_aaaaaa', doctorFile(root, 'empty.json', {})], 'not_doctor');
    check(dir, ['wf_aaaaaa', doctorFile(root, 'when.json', doctorResult('2026-10-11 10:00'))], 'not_doctor');
    const noStatus = doctorResult('2026-10-11T10:00:00Z');
    delete noStatus.status;
    check(dir, ['wf_aaaaaa', doctorFile(root, 'nostatus.json', noStatus)], 'not_doctor');
    check(dir, ['wf_aaaaaa', doctorFile(root, 'noat.json', { status: 'ok' })], 'not_doctor');
  }
});

test('unreadable snapshots are ignored', () => {
  const { root, dir } = newCase();
  setup(dir, 'a1');
  writeFileSync(join(dir, 'doctor-wf_zzzzzz.json'), 'not json {');
  writeFileSync(join(dir, 'doctor-wf_yyyyyy.json'), '[1]\n');
  writeFileSync(join(dir, 'doctor-wf_xxxxxx.json'), JSON.stringify({ launch: 1, doctor: 'x' }));
  const file = doctorFile(root, 'doctor.json', doctorResult('2026-10-11T10:00:00Z'));
  recorded(ledger('conditions', dir, WF, file), WF, 1);
  assert.equal(snapshot(dir, WF).launch.setup_event, 1);
});

test('usage errors exit 2', () => {
  const { root, dir } = newCase();
  setup(dir, 'a1');
  const good = doctorFile(root, 'doctor.json', doctorResult('2026-10-11T10:00:00Z'));
  const before = listing(dir);
  const cases = [
    ['abc', good],
    ['wf_ABC123', good],
    ['wf_../x', good],
    ['wf_abc12', good],
    [WF, join(root, 'missing.json')],
    [WF, doctorFile(root, 'list.json', '[]\n')],
    [WF, doctorFile(root, 'garbage.json', 'not json')],
  ];
  for (const [wf, file] of cases) {
    const res = ledger('conditions', dir, wf, file);
    assert.equal(res.code, 2, `${wf} ${file}: ${res.stderr}`);
    assert.equal(res.stdout, '', `${wf} ${file}`);
  }
  assert.equal(ledger('conditions', dir, WF).code, 2);
  assert.equal(ledger('conditions', dir, WF, good, 'extra').code, 2);
  assert.deepEqual(listing(dir), before);
});

test('a malformed ledger is exit 3', () => {
  const { root, dir } = newCase();
  setup(dir, 'a1');
  writeFileSync(join(dir, 'bad.jsonl'), 'not json\n');
  const file = doctorFile(root, 'doctor.json', doctorResult('2026-10-11T10:00:00Z'));
  const res = ledger('conditions', dir, WF, file);
  assert.equal(res.code, 3, res.stderr);
  assert.equal(existsSync(join(dir, `doctor-${WF}.json`)), false);
});

test('a missing ledger dir is refused and not created', () => {
  const { root, dir } = newCase();
  const file = doctorFile(root, 'doctor.json', doctorResult('2026-10-11T10:00:00Z'));
  refused(ledger('conditions', dir, WF, file), 'no_setup');
  assert.equal(existsSync(dir), false);
});

test('status ignores snapshots', () => {
  const { root, dir } = newCase();
  setup(dir, 'a1');
  append(dir, { task: '_run', event: 'run_ended', status: 'completed', agents: 3, rulings: 1 });
  const before = ledger('status', dir);
  assert.equal(before.code, 0, before.stderr);
  const file = doctorFile(root, 'doctor.json', doctorResult('2026-10-11T10:00:00Z'));
  recorded(ledger('conditions', dir, WF, file), WF, 1);
  const afterward = ledger('status', dir);
  assert.equal(afterward.code, 0, afterward.stderr);
  assert.equal(afterward.stdout, before.stdout);
});

test('Git Bash paths work on Windows', { skip: !IS_WINDOWS }, () => {
  const msys = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`);
  const { root, dir } = newCase();
  setup(dir, 'a1');
  const doctor = doctorResult('2026-10-11T10:00:00Z');
  const file = doctorFile(root, 'doctor.json', doctor);
  recorded(ledger('conditions', msys(dir), WF, msys(file)), WF, 1);
  const out = snapshot(dir, WF);
  assert.deepEqual(out.launch, { wf: WF, setup_event: 1, setup_head: 'a1' });
  assert.deepEqual(out.doctor, doctor);
  assert.deepEqual(listing(dir), ['_run.jsonl', `doctor-${WF}.json`]);
  // A repeated call in the native form is the same binding.
  recorded(ledger('conditions', dir, WF, file), WF, 1);
});
