import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';

const INSTALL = join(SKILL_DIR, 'install.sh');
const HAS_JQ = spawnSync('bash', ['-c', 'command -v jq'], { encoding: 'utf8' }).status === 0;
const SKIP = HAS_JQ ? false : 'jq is not on PATH';

const TMP = mkdtempSync(join(tmpdir(), 'pl-install-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
let counter = 0;

// A fresh config dir whose settings.json holds one unrelated setting.
function freshConfig() {
  counter += 1;
  const dir = join(TMP, `config ${counter}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.json'), '{"theme":"dark"}\n');
  return dir;
}

function install(configDir, args = []) {
  const res = spawnSync('bash', [INSTALL, ...args], {
    cwd: SKILL_DIR,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
  });
  assert.equal(res.status, 0, `install.sh ${args.join(' ')} failed: ${res.stderr}`);
  return res;
}

function settings(configDir) {
  return JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'));
}

function commands(entries) {
  return (entries || []).flatMap((entry) => entry.hooks.map((hook) => hook.command));
}

function agentFile(configDir) {
  return join(configDir, 'agents', 'parallel-lanes-worker.md');
}

function skillDir(configDir) {
  return join(configDir, 'skills', 'parallel-lanes');
}

test('install.sh installs the skill, the worker agent, and both hooks, keeping other settings', { skip: SKIP }, () => {
  const dir = freshConfig();
  const res = install(dir);

  assert.ok(existsSync(agentFile(dir)), 'the worker agent file is installed');
  assert.match(readFileSync(agentFile(dir), 'utf8'), /^name: parallel-lanes-worker$/m);
  assert.match(res.stdout, new RegExp(`Installed agent type parallel-lanes-worker to ${agentFile(dir)}`));
  assert.ok(existsSync(join(skillDir(dir), 'SKILL.md')), 'the skill is installed');
  assert.ok(!existsSync(join(skillDir(dir), '.git')), 'the skill is installed without .git');

  const s = settings(dir);
  assert.equal(s.theme, 'dark');
  const start = commands(s.hooks.SessionStart);
  const notice = commands(s.hooks.PostToolUse);
  assert.equal(start.length, 1);
  assert.equal(notice.length, 1);
  assert.ok(start[0].endsWith('hooks/session-start.sh'), start[0]);
  assert.ok(notice[0].endsWith('hooks/notice.sh'), notice[0]);
  assert.ok(start[0].includes(dir), start[0]);
  assert.ok(notice[0].includes(dir), notice[0]);
});

test('install.sh run twice registers each hook once and keeps one agent file', { skip: SKIP }, () => {
  const dir = freshConfig();
  install(dir);
  install(dir);

  const s = settings(dir);
  assert.equal(s.theme, 'dark');
  assert.equal(commands(s.hooks.SessionStart).length, 1);
  assert.equal(commands(s.hooks.PostToolUse).length, 1);
  const agents = readdirSync(join(dir, 'agents'));
  assert.deepEqual(agents, ['parallel-lanes-worker.md']);
  assert.match(readFileSync(agentFile(dir), 'utf8'), /^name: parallel-lanes-worker$/m);
});

test('install.sh --uninstall removes the hooks, the skill, and the worker agent, keeping other settings', { skip: SKIP }, () => {
  const dir = freshConfig();
  install(dir);
  install(dir, ['--uninstall']);

  assert.deepEqual(settings(dir), { theme: 'dark', hooks: {} });
  assert.ok(!existsSync(agentFile(dir)), 'the worker agent file is removed');
  assert.ok(!existsSync(skillDir(dir)), 'the skill directory is removed');
});
