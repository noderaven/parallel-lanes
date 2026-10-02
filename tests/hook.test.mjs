import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';

const NOTICE = join(SKILL_DIR, 'hooks', 'notice.sh');
const SESSION_START = join(SKILL_DIR, 'hooks', 'session-start.sh');
const BOOTSTRAP = join(SKILL_DIR, 'hooks', 'bootstrap.md');

function runHook(script, stdin) {
  const res = spawnSync('bash', [script], { input: stdin, encoding: 'utf8' });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

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
});

test('bootstrap.md is plain ASCII and under 120 words', () => {
  const buf = readFileSync(BOOTSTRAP);
  const bad = buf.findIndex((b) => b > 0x7e || (b < 0x20 && b !== 0x0a));
  assert.equal(bad, -1, `bootstrap.md has a non-ASCII or control byte at offset ${bad}`);
  const words = buf.toString('utf8').split(/\s+/).filter(Boolean).length;
  assert.ok(words < 120, `bootstrap.md has ${words} words`);
});
