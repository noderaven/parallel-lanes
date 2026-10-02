import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';

const NOTICE = join(SKILL_DIR, 'hooks', 'notice.sh');
const SESSION_START = join(SKILL_DIR, 'hooks', 'session-start.sh');
const BOOTSTRAP = join(SKILL_DIR, 'hooks', 'bootstrap.md');

function runHook(script, stdin, env = process.env) {
  const res = spawnSync(BASH, [script], { input: stdin, encoding: 'utf8', env });
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
