import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { BASH, tempDir } from './platform.mjs';

const SCRIPT = join(SKILL_DIR, 'scripts', 'find-agent-type');
const TMP = tempDir('pl-agent-type-');
after(() => rmSync(TMP, { recursive: true, force: true }));

let counter = 0;
// A fresh config dir; with content, agents/parallel-lanes-worker.md holds it.
function configDir(content) {
  counter += 1;
  const dir = join(TMP, `config ${counter}`);
  mkdirSync(join(dir, 'agents'), { recursive: true });
  if (content !== undefined) writeFileSync(join(dir, 'agents', 'parallel-lanes-worker.md'), content);
  return dir;
}

function findAgentType(dir, args = []) {
  const res = spawnSync(BASH, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

const worker = (name) =>
  `---\nname: ${name}\ndescription: lean worker\ntools: Bash, Read\n---\n\nname: parallel-lanes-worker\n`;

test('prints the name when the worker agent is installed', () => {
  const r = findAgentType(configDir(worker('parallel-lanes-worker')));
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'parallel-lanes-worker\n');
});

test('exits 3 when the file is missing', () => {
  const r = findAgentType(configDir());
  assert.equal(r.code, 3);
  assert.equal(r.stdout, '');
});

test('exits 3 when the frontmatter names another agent', () => {
  // The body repeats the right name; only the frontmatter counts.
  const r = findAgentType(configDir(worker('other-agent')));
  assert.equal(r.code, 3);
  assert.equal(r.stdout, '');
});

test('exits 2 with an argument', () => {
  const r = findAgentType(configDir(worker('parallel-lanes-worker')), ['extra']);
  assert.equal(r.code, 2);
  assert.equal(r.stdout, '');
});
