// scripts/reuse-checks (1.6.8 design 4.7): a resumed integration reuses a
// passing check of the same head, checkout, commands and setup commands. Each
// test writes its evidence files by hand into a fresh ledger directory and
// runs the real script.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { tempDir } from './platform.mjs';

const SCRIPT = join(SKILL_DIR, 'scripts', 'reuse-checks');
const TMP = realpathSync(tempDir('pl-reuse-checks-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const HEAD = 'a'.repeat(40);
const CHECKOUT = join(TMP, 'feature checkout').replace(/\\/g, '/');
const OTHER = join(TMP, 'other checkout').replace(/\\/g, '/');
mkdirSync(CHECKOUT, { recursive: true });
mkdirSync(OTHER, { recursive: true });
const SETUP = ['npm ci'];
const CMDS = [['test', 'npm test'], ['lint', 'npm run lint']];

// A passing integrate evidence object; a key in over set to undefined is
// removed.
function evidence(over = {}) {
  const results = CMDS.map(([group, command], i) => ({
    group, command, exit: 0, started: '2026-10-17T07:00:00.000Z', ended: '2026-10-17T07:00:01.000Z',
    duration_s: 1, log: `${CHECKOUT}/integrate.1.${i + 1}.log`, tail: '',
  }));
  const ev = {
    checkout: CHECKOUT, branch: 'feature', head: HEAD, results, ok: true, clean: true,
    tracked_before: [], tracked_after: [], untracked_before: [], untracked_after: [],
    tree_changed: false, phase: 'integrate', setup_commands: SETUP, ...over,
  };
  for (const key of Object.keys(over)) if (over[key] === undefined) delete ev[key];
  return ev;
}

let serial = 0;
// A ledger directory whose checks/ holds files: {name: object, raw string or
// Buffer}.
function ledger(files) {
  serial += 1;
  const dir = join(TMP, `ledger ${serial}`);
  mkdirSync(join(dir, 'checks'), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const raw = typeof body === 'string' || Buffer.isBuffer(body) ? body : `${JSON.stringify(body)}\n`;
    writeFileSync(join(dir, 'checks', name), raw);
  }
  return dir;
}

function reuse(dir, { name = 'integrate', head = HEAD, checkout = CHECKOUT, setup = SETUP, cmds = CMDS } = {}) {
  const argv = [SCRIPT, dir, '--name', name, '--head', head, '--checkout', checkout];
  for (const command of setup) argv.push('--setup', command);
  for (const [group, command] of cmds) argv.push('--cmd', group, command);
  return run(argv);
}

function run(argv) {
  const res = spawnSync('python3', ['-B', ...argv], { encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(res.stdout); } catch { /* left null */ }
  return { status: res.status, json, stdout: res.stdout, stderr: res.stderr };
}

function assertReused(r, file) {
  assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`);
  assert.equal(r.json.reuse, true, r.stdout);
  assert.deepEqual(Object.keys(r.json).sort(), ['file', 'reuse']);
  assert.equal(realpathSync(r.json.file), realpathSync(file));
}

function assertNotReused(r, pattern) {
  assert.equal(r.status, 1, `${r.stdout} ${r.stderr}`);
  assert.equal(r.json.reuse, false, r.stdout);
  assert.deepEqual(Object.keys(r.json).sort(), ['reuse', 'why']);
  assert.equal(typeof r.json.why, 'string');
  assert.match(r.json.why, pattern);
}

test('a matching file is reused', () => {
  const dir = ledger({ 'integrate.1.json': evidence() });
  assertReused(reuse(dir), join(dir, 'checks', 'integrate.1.json'));
});

test('the checkout matches in another spelling', () => {
  const dir = ledger({ 'integrate.1.json': evidence() });
  const spelling = process.platform === 'win32' ? CHECKOUT.replace(/\//g, '\\').toUpperCase() : `${CHECKOUT}/.`;
  assertReused(reuse(dir, { checkout: spelling }), join(dir, 'checks', 'integrate.1.json'));
});

test('no setup commands on either side is a match', () => {
  const dir = ledger({ 'integrate.1.json': evidence({ setup_commands: [] }) });
  assertReused(reuse(dir, { setup: [] }), join(dir, 'checks', 'integrate.1.json'));
});

test('other head', () => {
  assertNotReused(reuse(ledger({ 'integrate.1.json': evidence() }), { head: 'b'.repeat(40) }), /head/);
});

test('head_after present', () => {
  assertNotReused(reuse(ledger({ 'integrate.1.json': evidence({ head_after: 'c'.repeat(40) }) })), /head_after/);
});

test('other checkout', () => {
  assertNotReused(reuse(ledger({ 'integrate.1.json': evidence() }), { checkout: OTHER }), /checkout/);
});

test('a failed command', () => {
  const failed = evidence();
  failed.results[1].exit = 1;
  assertNotReused(reuse(ledger({ 'integrate.1.json': failed })), /exit/);
  assertNotReused(reuse(ledger({ 'integrate.1.json': evidence({ ok: false }) })), /ok/);
});

test('clean false', () => {
  assertNotReused(reuse(ledger({ 'integrate.1.json': evidence({ clean: false }) })), /clean/);
});

test('non-empty tracked_before', () => {
  assertNotReused(reuse(ledger({ 'integrate.1.json': evidence({ tracked_before: [' M a.txt'] }) })), /tracked_before/);
});

test('non-empty untracked_before', () => {
  assertNotReused(reuse(ledger({ 'integrate.1.json': evidence({ untracked_before: ['?? b.txt'] }) })),
    /untracked_before/);
});

test('tree_changed true', () => {
  assertNotReused(reuse(ledger({ 'integrate.1.json': evidence({ tree_changed: true }) })), /tree_changed/);
  assertNotReused(reuse(ledger({ 'integrate.1.json': evidence({ tree_changed: null }) })), /tree_changed/);
});

test('other commands', () => {
  const dir = ledger({ 'integrate.1.json': evidence() });
  assertNotReused(reuse(dir, { cmds: [['test', 'npm test -- --all'], ['lint', 'npm run lint']] }), /commands/);
  assertNotReused(reuse(dir, { cmds: [['test', 'npm test']] }), /commands/);
  assertNotReused(reuse(dir, { cmds: [['unit', 'npm test'], ['lint', 'npm run lint']] }), /commands/);
});

test('other order', () => {
  assertNotReused(reuse(ledger({ 'integrate.1.json': evidence() }), { cmds: [CMDS[1], CMDS[0]] }), /commands/);
});

test('other setup', () => {
  const dir = ledger({ 'integrate.1.json': evidence() });
  assertNotReused(reuse(dir, { setup: ['npm install'] }), /setup/);
  assertNotReused(reuse(dir, { setup: [] }), /setup/);
  assertNotReused(reuse(dir, { setup: ['npm ci', 'npm run build'] }), /setup/);
});

test('no setup_commands', () => {
  // Evidence from 1.6.7 has no setup_commands and is never reused.
  const dir = ledger({ 'integrate.1.json': evidence({ setup_commands: undefined }) });
  assertNotReused(reuse(dir), /setup_commands/);
  assertNotReused(reuse(dir, { setup: [] }), /setup_commands/);
});

test('phase not integrate', () => {
  assertNotReused(reuse(ledger({ 'integrate.1.json': evidence({ phase: 'verify' }) })), /phase/);
  assertNotReused(reuse(ledger({ 'integrate.1.json': evidence({ phase: null }) })), /phase/);
});

test('integrate.10.json beats integrate.9.json', () => {
  const dir = ledger({ 'integrate.9.json': evidence(), 'integrate.10.json': evidence() });
  assertReused(reuse(dir), join(dir, 'checks', 'integrate.10.json'));
});

test('the highest matching file wins over a newer one that does not match', () => {
  const dir = ledger({ 'integrate.2.json': evidence(), 'integrate.3.json': evidence({ head: 'b'.repeat(40) }) });
  assertReused(reuse(dir), join(dir, 'checks', 'integrate.2.json'));
});

test('only files of the given name count', () => {
  const dir = ledger({
    'start.1.json': evidence(), 'integrate.json': evidence(), 'integrate.x.json': evidence(),
    'integrate.1.1.log': 'log\n', 'integrate-1.json': evidence(),
  });
  assertNotReused(reuse(dir), /integrate/);
});

test('a malformed file and an error record are skipped', () => {
  const dir = ledger({
    'integrate.3.json': evidence(),
    'integrate.4.json': '{"results": [',
    'integrate.5.json': { results: [], ok: false, error: 'not a checkout' },
    'integrate.6.json': [evidence()],
    'integrate.7.json': '',
    'integrate.8.json': Buffer.from([0xff, 0xfe, 0x00]),
  });
  assertReused(reuse(dir), join(dir, 'checks', 'integrate.3.json'));
  const bad = ledger({
    'integrate.1.json': '{',
    'integrate.2.json': { results: [], ok: false, error: 'internal error' },
  });
  const r = reuse(bad);
  assertNotReused(r, /integrate\.2\.json/);
  assert.match(r.json.why, /error/);
});

test('no evidence at all', () => {
  assertNotReused(reuse(ledger({})), /integrate/);
  serial += 1;
  const bare = join(TMP, `ledger ${serial}`);
  mkdirSync(bare, { recursive: true });
  assertNotReused(reuse(bare), /integrate/);
});

test('usage errors exit 2', () => {
  const dir = ledger({ 'integrate.1.json': evidence() });
  const ok = ['--name', 'integrate', '--head', HEAD, '--checkout', CHECKOUT, '--cmd', 'test', 'npm test'];
  const cases = [
    [],
    ['--name', 'integrate'],
    [dir],
    [dir, '--head', HEAD, '--checkout', CHECKOUT, '--cmd', 'test', 'npm test'],
    [dir, '--name', 'integrate', '--checkout', CHECKOUT, '--cmd', 'test', 'npm test'],
    [dir, '--name', 'integrate', '--head', HEAD, '--cmd', 'test', 'npm test'],
    [dir, '--name', 'integrate', '--head', HEAD, '--checkout', CHECKOUT],
    [dir, ...ok, '--cmd', 'lint'],
    [dir, ...ok, '--cmd', '', 'npm test'],
    [dir, ...ok, '--setup'],
    [dir, ...ok, '--bogus'],
    [dir, ...ok, '--name', 'again'],
    [dir, '--name', '../integrate', '--head', HEAD, '--checkout', CHECKOUT, '--cmd', 'test', 'npm test'],
    [dir, '--name', 'integrate', '--head', 'not-a-sha', '--checkout', CHECKOUT, '--cmd', 'test', 'npm test'],
    [join(TMP, 'no such ledger'), ...ok],
  ];
  for (const args of cases) {
    const r = run([SCRIPT, ...args]);
    assert.equal(r.status, 2, `${args.map((a) => basename(a)).join(' ')}: ${r.stdout} ${r.stderr}`);
    assert.equal(r.stdout, '', `${args.join(' ')}: a usage error prints nothing on stdout`);
    assert.match(r.stderr, /usage|reuse-checks/);
  }
});
