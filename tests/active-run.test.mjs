import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';

const ACTIVE_RUN = join(SKILL_DIR, 'scripts', 'active-run');
const TMP = mkdtempSync(join(tmpdir(), 'pl-active-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

let counter = 0;
// A marker directory that does not exist yet, under a path with a space.
function markerDir() {
  counter += 1;
  return join(TMP, `case ${counter}`, 'active dir');
}

function activeRun(dir, ...args) {
  const res = spawnSync('bash', [ACTIVE_RUN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PL_ACTIVE_DIR: dir },
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

function list(dir) {
  const res = activeRun(dir, 'list');
  assert.equal(res.code, 0, res.stderr);
  return JSON.parse(res.stdout);
}

test('active-run: write, list, and remove round trip', () => {
  const dir = markerDir();
  const w1 = activeRun(dir, 'write', 'run-a', '/plans/a manifest.json');
  assert.equal(w1.code, 0, w1.stderr);
  const w2 = activeRun(dir, 'write', 'run-b', '/plans/b.json', 'stopped');
  assert.equal(w2.code, 0, w2.stderr);

  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const markers = list(dir);
  assert.deepEqual(
    markers.map(({ run_id, manifest, status }) => ({ run_id, manifest, status })),
    [
      { run_id: 'run-a', manifest: '/plans/a manifest.json', status: 'running' },
      { run_id: 'run-b', manifest: '/plans/b.json', status: 'stopped' },
    ],
  );
  for (const m of markers) {
    assert.deepEqual(Object.keys(m).sort(), ['manifest', 'run_id', 'started', 'status']);
    assert.match(m.started, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  }
  const file = JSON.parse(readFileSync(join(dir, 'run-a.json'), 'utf8'));
  assert.deepEqual(file, markers[0]);

  const rm = activeRun(dir, 'remove', 'run-a');
  assert.equal(rm.code, 0, rm.stderr);
  assert.deepEqual(list(dir).map((m) => m.run_id), ['run-b']);
  assert.equal(activeRun(dir, 'remove', 'run-b').code, 0);
  assert.deepEqual(list(dir), []);
});

test('active-run: a rewrite updates status and keeps started', () => {
  const dir = markerDir();
  mkdirSync(dir, { recursive: true });
  const old = { run_id: 'r1', manifest: '/m.json', started: '2026-01-01T00:00:00Z', status: 'running' };
  writeFileSync(join(dir, 'r1.json'), JSON.stringify(old));
  const res = activeRun(dir, 'write', 'r1', '/m.json', 'stopped');
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(list(dir), [{ ...old, status: 'stopped' }]);
});

test('active-run: list with no directory prints []', () => {
  const res = activeRun(markerDir(), 'list');
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), []);
});

test('active-run: list skips a malformed marker', () => {
  const dir = markerDir();
  assert.equal(activeRun(dir, 'write', 'good', '/g.json').code, 0);
  writeFileSync(join(dir, 'bad.json'), '{not json');
  writeFileSync(join(dir, 'odd.json'), '[1, 2]');
  assert.deepEqual(list(dir).map((m) => m.run_id), ['good']);
});

test('active-run: removing a missing marker succeeds', () => {
  const res = activeRun(markerDir(), 'remove', 'nothing-here');
  assert.equal(res.code, 0, res.stderr);
});

test('active-run: an unsafe run id is refused with exit 3', () => {
  const dir = markerDir();
  for (const id of ['../escape', 'a/b', '.hidden', '']) {
    assert.equal(activeRun(dir, 'write', id, '/m.json').code, 3, `write ${JSON.stringify(id)}`);
    assert.equal(activeRun(dir, 'remove', id).code, 3, `remove ${JSON.stringify(id)}`);
  }
});

test('active-run: usage errors exit 2', () => {
  const dir = markerDir();
  for (const args of [[], ['bogus'], ['write', 'r1'], ['write', 'r1', '/m.json', 'x', 'y'], ['write', 'r1', ''],
    ['write', 'r1', '/m.json', ''], ['remove'], ['list', 'extra']]) {
    assert.equal(activeRun(dir, ...args).code, 2, `args ${JSON.stringify(args)}`);
  }
});
