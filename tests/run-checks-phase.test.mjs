// scripts/run-checks --phase (1.6.5 design 4.6): every command, first attempt
// and busy retry alike, runs with PL_PHASE set to the phase; without --phase
// an inherited PL_PHASE is removed. task-checks passes its --phase through.
// The start phase (1.6.8 design 4.4) runs with PL_PHASE=verify, and
// --record-setup (4.7) records setup commands without running them.
// Real scripts, real git repos.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { tempDir } from './platform.mjs';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const TMP = realpathSync(tempDir('pl-run-checks-phase-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid',
};

function git(dir, ...args) {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim();
}

let serial = 0;
function fresh() {
  serial += 1;
  const dir = join(TMP, `repo${serial}`);
  const record = join(TMP, `phase${serial}.txt`).replace(/\\/g, '/');
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return { dir, record };
}

// A command that appends "<PL_PHASE or -unset->" to record and exits
// codes[n - 1] on its nth run.
function recorder(record, codes = [0]) {
  const js = `const fs = require("fs"); const p = ${JSON.stringify(record)};`
    + ' const prev = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";'
    + ' const n = prev.split("\\n").filter(Boolean).length + 1;'
    + ' fs.appendFileSync(p, (process.env.PL_PHASE === undefined ? "-unset-" : process.env.PL_PHASE) + "\\n");'
    + ` const codes = ${JSON.stringify(codes)}; process.exit(codes[Math.min(n, codes.length) - 1]);`;
  return `node -e '${js}'`;
}
const recorded = (record) => readFileSync(record, 'utf8').split('\n').filter(Boolean);

function runChecks(dir, extra, cmds, env = {}) {
  const argv = [join(SCRIPTS, 'run-checks'), dir, ...extra];
  for (const [group, command] of cmds) argv.push('--cmd', group, command);
  const res = spawnSync('python3', ['-B', ...argv], {
    encoding: 'utf8', env: { ...process.env, ...GIT_ENV, TMPDIR: TMP, RUN_CHECKS_BUSY_WAIT_S: '0', ...env },
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

test('PL_PHASE reaches every command', () => {
  const { dir, record } = fresh();
  const r = runChecks(dir, ['--phase', 'join'], [['test', recorder(record)], ['lint', recorder(record)]]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(recorded(record), ['join', 'join']);
  assert.equal(JSON.parse(r.stdout).phase, 'join');
});

test('PL_PHASE survives the busy retry', () => {
  const { dir, record } = fresh();
  const r = runChecks(dir, ['--phase', 'prelude'], [['test', recorder(record, [75, 0])]]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(recorded(record), ['prelude', 'prelude']);
});

test('an inherited PL_PHASE is removed without --phase', () => {
  const { dir, record } = fresh();
  const r = runChecks(dir, [], [['test', recorder(record)]], { PL_PHASE: 'lane' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(recorded(record), ['-unset-']);
  assert.equal(JSON.parse(r.stdout).phase, null);
});

test('an unknown phase is a usage error', () => {
  const { dir, record } = fresh();
  for (const extra of [['--phase', 'wave'], ['--phase'], ['--phase', '']]) {
    const r = runChecks(dir, extra, [['test', recorder(record)]]);
    assert.equal(r.status, 2, `${extra.join(' ')}: ${r.stderr}`);
  }
  assert.equal(existsSync(record), false);
});

test('every phase name is accepted', () => {
  for (const phase of ['prelude', 'lane', 'join', 'integrate', 'post-integrate', 'final-fix', 'verify', 'start']) {
    const { dir, record } = fresh();
    const r = runChecks(dir, ['--phase', phase], [['test', recorder(record)]]);
    assert.equal(r.status, 0, `${phase}: ${r.stderr}`);
    // The start check reproduces verify's environment.
    assert.deepEqual(recorded(record), [phase === 'start' ? 'verify' : phase]);
    assert.equal(JSON.parse(r.stdout).phase, phase);
  }
});

test('--phase start runs with PL_PHASE=verify and records start', () => {
  const { dir, record } = fresh();
  const r = runChecks(dir, ['--phase', 'start'], [['test', recorder(record, [75, 0])], ['lint', recorder(record)]],
    { PL_PHASE: 'lane' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(recorded(record), ['verify', 'verify', 'verify']);
  assert.equal(JSON.parse(r.stdout).phase, 'start');
});

test('--record-setup is recorded and not run', () => {
  const { dir, record } = fresh();
  const made = join(TMP, `setup${serial}.txt`).replace(/\\/g, '/');
  const setup = [`node -e 'require("fs").writeFileSync(${JSON.stringify(made)}, "x")'`, 'npm ci'];
  const out = join(TMP, `evidence${serial}.json`);
  const r = runChecks(dir, ['--out', out, '--record-setup', setup[0], '--phase', 'integrate', '--record-setup', setup[1]],
    [['test', recorder(record)]]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(made), false, 'a recorded setup command must not run');
  assert.deepEqual(JSON.parse(r.stdout).setup_commands, setup);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')).setup_commands, setup);
  assert.deepEqual(recorded(record), ['integrate']);
});

test('--record-setup is recorded in the early report of a failed --descends-from, not run', () => {
  const { dir, record } = fresh();
  // A commit on a side branch is not an ancestor of main's HEAD.
  git(dir, 'checkout', '-q', '-b', 'side');
  writeFileSync(join(dir, 'b.txt'), 'b\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'side');
  const side = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', 'main');
  const made = join(TMP, `setup${serial}.txt`).replace(/\\/g, '/');
  const setup = `node -e 'require("fs").writeFileSync(${JSON.stringify(made)}, "x")'`;
  const out = join(TMP, `evidence${serial}.json`);
  const r = runChecks(dir, ['--out', out, '--descends-from', side, '--record-setup', setup],
    [['test', recorder(record)]]);
  const report = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(report.descends_from, { sha: side, ok: false }, r.stdout);
  assert.deepEqual(report.results, []);
  assert.deepEqual(report.setup_commands, [setup]);
  assert.deepEqual(JSON.parse(r.stdout).setup_commands, [setup]);
  assert.equal(existsSync(made), false, 'a recorded setup command must not run');
  assert.equal(existsSync(record), false, 'no check runs');
});

test('--record-setup-none records no setup commands, and reuse-checks with no --setup reuses it', () => {
  const { dir, record } = fresh();
  const ledger = join(TMP, `ledger${serial}`);
  mkdirSync(join(ledger, 'checks'), { recursive: true });
  const out = join(ledger, 'checks', 'integrate.1.json');
  const cmd = recorder(record);
  const r = runChecks(dir, ['--out', out, '--root', ledger, '--phase', 'integrate', '--record-setup-none'],
    [['test', cmd]]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')).setup_commands, []);
  const res = spawnSync('python3', ['-B', join(SCRIPTS, 'reuse-checks'), ledger, '--name', 'integrate',
    '--head', git(dir, 'rev-parse', 'HEAD'), '--checkout', dir, '--cmd', 'test', cmd], { encoding: 'utf8' });
  assert.equal(res.status, 0, `${res.stdout} ${res.stderr}`);
  assert.equal(JSON.parse(res.stdout).reuse, true, res.stdout);
});

test('--record-setup-none beside --record-setup is a usage error', () => {
  const { dir, record } = fresh();
  for (const extra of [['--record-setup-none', '--record-setup', 'npm ci'], ['--record-setup', 'npm ci', '--record-setup-none']]) {
    const r = runChecks(dir, extra, [['test', recorder(record)]]);
    assert.equal(r.status, 2, `${extra.join(' ')}: ${r.stderr}`);
  }
  assert.equal(existsSync(record), false);
});

test('without --record-setup there is no setup_commands key', () => {
  const { dir, record } = fresh();
  const r = runChecks(dir, [], [['test', recorder(record)]]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal('setup_commands' in JSON.parse(r.stdout), false);
});

test('--record-setup without a command is a usage error', () => {
  const { dir, record } = fresh();
  for (const extra of [['--record-setup'], ['--record-setup', '']]) {
    const r = runChecks(dir, extra, [['test', recorder(record)]]);
    assert.equal(r.status, 2, `${extra.join(' ')}: ${r.stderr}`);
  }
  assert.equal(existsSync(record), false);
});

test('task-checks passes --phase through', () => {
  const { dir, record } = fresh();
  const ledger = join(TMP, `ledger${serial}`);
  mkdirSync(ledger, { recursive: true });
  const base = git(dir, 'rev-parse', 'HEAD');
  const cmd = recorder(record);
  const res = spawnSync('python3', ['-B', join(SCRIPTS, 'task-checks'), dir, '--base', base, '--ledger', ledger,
    '--unit', 'J2', '--lane', 'join', '--task', 'J2', '--phase', 'join',
    '--lane-cmd', 'test', cmd, '--wide-cmd', 'test', cmd], {
    encoding: 'utf8', env: { ...process.env, ...GIT_ENV, TMPDIR: TMP, PL_PHASE: 'lane' },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(recorded(record), ['join']);
});

test('task-checks without --phase removes PL_PHASE too', () => {
  const { dir, record } = fresh();
  const ledger = join(TMP, `ledger${serial}`);
  mkdirSync(ledger, { recursive: true });
  const base = git(dir, 'rev-parse', 'HEAD');
  const cmd = recorder(record);
  const res = spawnSync('python3', ['-B', join(SCRIPTS, 'task-checks'), dir, '--base', base, '--ledger', ledger,
    '--unit', 'A1', '--lane', 'a', '--task', 'A1', '--lane-cmd', 'test', cmd, '--wide-cmd', 'test', cmd], {
    encoding: 'utf8', env: { ...process.env, ...GIT_ENV, TMPDIR: TMP, PL_PHASE: 'join' },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(recorded(record), ['-unset-']);
});
