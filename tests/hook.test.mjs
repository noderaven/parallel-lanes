import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';

const NOTICE = join(SKILL_DIR, 'hooks', 'notice.sh');
const SESSION_START = join(SKILL_DIR, 'hooks', 'session-start.sh');
const BOOTSTRAP = join(SKILL_DIR, 'hooks', 'bootstrap.md');
const ACTIVE_RUN = join(SKILL_DIR, 'scripts', 'active-run');

// Every hook run gets its own empty marker directory, so active-run markers
// on this machine never affect a test.
const TMP = mkdtempSync(join(tmpdir(), 'pl-hook-active-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
let counter = 0;
function freshActiveDir() {
  counter += 1;
  return join(TMP, `case ${counter}`);
}

function runHook(script, stdin, env = process.env) {
  const full = { PL_ACTIVE_DIR: freshActiveDir(), ...env };
  const res = spawnSync(BASH, [script], { input: stdin, encoding: 'utf8', env: full });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

// Absolute paths of tools, so a test can run a hook with a PATH that lacks one.
function which(name) {
  const res = spawnSync('bash', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  assert.equal(res.status, 0, `${name} not found`);
  return res.stdout.trim();
}
const BASH = which('bash');

function skillEvent(skill, toolName = 'Skill') {
  return JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name: toolName,
    tool_input: { skill },
    tool_response: {},
  });
}

for (const name of ['parallel-lanes', 'something:parallel-lanes']) {
  test(`notice: ${name} prints the invocation system message`, () => {
    const res = runHook(NOTICE, skillEvent(name));
    assert.equal(res.code, 0);
    assert.deepEqual(JSON.parse(res.stdout), { systemMessage: 'parallel-lanes invoked' });
  });
}

for (const [label, stdin] of [
  ['another skill', skillEvent('superpowers:writing-plans')],
  ['a name merely ending in the skill name', skillEvent('not-parallel-lanes')],
  ['another tool', skillEvent('parallel-lanes', 'Bash')],
  ['missing tool_input', JSON.stringify({ tool_name: 'Skill' })],
  ['malformed stdin', '{not json'],
  ['empty stdin', ''],
]) {
  test(`notice: ${label} prints nothing and exits 0`, () => {
    const res = runHook(NOTICE, stdin);
    assert.equal(res.code, 0);
    assert.equal(res.stdout, '');
  });
}

test('session-start: emits SessionStart additionalContext equal to bootstrap.md', () => {
  const res = runHook(SESSION_START, '{"hook_event_name":"SessionStart","source":"startup"}');
  assert.equal(res.code, 0);
  const out = JSON.parse(res.stdout);
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(ctx, readFileSync(BOOTSTRAP, 'utf8'));
  assert.match(ctx, /parallel-lanes/);
  assert.match(ctx, /precedence/);
  assert.ok(
    ctx.includes('the main session at the execution-method handoff, never an agent executing a single task'),
    'bootstrap.md is scoped to the main session',
  );
});

test('session-start: each active-run marker adds a resume line', () => {
  const dir = freshActiveDir();
  const env = { ...process.env, PL_ACTIVE_DIR: dir };
  for (const [id, manifest] of [['run-1', '/plans/run 1.json'], ['run-2', '/plans/"q".json']]) {
    const w = spawnSync(BASH, [ACTIVE_RUN, 'write', id, manifest], { encoding: 'utf8', env });
    assert.equal(w.status, 0, w.stderr);
  }
  const res = runHook(SESSION_START, '{"hook_event_name":"SessionStart","source":"resume"}', env);
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(
    out.hookSpecificOutput.additionalContext,
    readFileSync(BOOTSTRAP, 'utf8') +
      'Interrupted parallel-lanes run run-1 (manifest /plans/run 1.json): offer the user a one-word resume.\n' +
      'Interrupted parallel-lanes run run-2 (manifest /plans/"q".json): offer the user a one-word resume.\n',
  );
});

test('session-start: control characters in a manifest path stay on one line', () => {
  const dir = freshActiveDir();
  const env = { ...process.env, PL_ACTIVE_DIR: dir };
  const w = spawnSync(BASH, [ACTIVE_RUN, 'write', 'r9', '/a\nb\tc.json'], { encoding: 'utf8', env });
  assert.equal(w.status, 0, w.stderr);
  const res = runHook(SESSION_START, '{}', env);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(
    JSON.parse(res.stdout).hookSpecificOutput.additionalContext,
    readFileSync(BOOTSTRAP, 'utf8') +
      'Interrupted parallel-lanes run r9 (manifest /a b c.json): offer the user a one-word resume.\n',
  );
});

test('session-start: marker lines start on a new line after a bootstrap.md without one', () => {
  const root = mkdtempSync(join(tmpdir(), 'pl-hook-root-'));
  try {
    mkdirSync(join(root, 'hooks'));
    mkdirSync(join(root, 'scripts'));
    copyFileSync(SESSION_START, join(root, 'hooks', 'session-start.sh'));
    copyFileSync(ACTIVE_RUN, join(root, 'scripts', 'active-run'));
    writeFileSync(join(root, 'hooks', 'bootstrap.md'), 'Bootstrap text.');
    const env = { ...process.env, PL_ACTIVE_DIR: freshActiveDir() };
    const w = spawnSync(BASH, [ACTIVE_RUN, 'write', 'r1', '/m.json'], { encoding: 'utf8', env });
    assert.equal(w.status, 0, w.stderr);
    const res = runHook(join(root, 'hooks', 'session-start.sh'), '{}', env);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(
      JSON.parse(res.stdout).hookSpecificOutput.additionalContext,
      'Bootstrap text.\nInterrupted parallel-lanes run r1 (manifest /m.json): offer the user a one-word resume.\n',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('session-start: an unreadable marker directory leaves the output unchanged', () => {
  const dir = freshActiveDir();
  mkdirSync(dir, { recursive: true });
  const notDir = join(dir, 'file');
  copyFileSync(BOOTSTRAP, notDir);
  const res = runHook(SESSION_START, '{}', { ...process.env, PL_ACTIVE_DIR: notDir });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).hookSpecificOutput.additionalContext, readFileSync(BOOTSTRAP, 'utf8'));
});

test('bootstrap.md is plain ASCII and under 120 words', () => {
  const buf = readFileSync(BOOTSTRAP);
  const bad = buf.findIndex((b) => b > 0x7e || (b < 0x20 && b !== 0x0a));
  assert.equal(bad, -1, `bootstrap.md has a non-ASCII or control byte at offset ${bad}`);
  const words = buf.toString('utf8').split(/\s+/).filter(Boolean).length;
  assert.ok(words < 120, `bootstrap.md has ${words} words`);
});

test('session-start: a missing bootstrap.md prints nothing and exits 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pl-hook-'));
  try {
    copyFileSync(SESSION_START, join(dir, 'session-start.sh'));
    const res = runHook(join(dir, 'session-start.sh'), '{}');
    assert.equal(res.code, 0);
    assert.equal(res.stdout, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('session-start: without jq prints nothing and exits 0', () => {
  const bin = mkdtempSync(join(tmpdir(), 'pl-hook-bin-'));
  try {
    symlinkSync(which('dirname'), join(bin, 'dirname'));
    const res = runHook(SESSION_START, '{}', { PATH: bin });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.stdout, '');
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});
