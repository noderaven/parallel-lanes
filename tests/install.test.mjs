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
  assert.equal(start[0], `bash '${join(skillDir(dir), 'hooks', 'session-start.sh')}'`);
  assert.equal(notice[0], `bash '${join(skillDir(dir), 'hooks', 'notice.sh')}'`);
});

// Review finding 10: the stored commands must work when the host runs them
// through a shell, from a config dir with a space and a single quote.
test('install.sh registers hook commands that run from a config dir with a space and a quote', { skip: SKIP }, () => {
  counter += 1;
  const dir = join(TMP, `it's config ${counter}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.json'), '{}\n');
  install(dir);
  const s = settings(dir);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: dir, PL_ACTIVE_DIR: join(dir, 'no markers') };
  const start = spawnSync('sh', ['-c', commands(s.hooks.SessionStart)[0]], { input: '{}', encoding: 'utf8', env });
  assert.equal(start.status, 0, start.stderr);
  assert.equal(JSON.parse(start.stdout).hookSpecificOutput.hookEventName, 'SessionStart');
  const event = JSON.stringify({ tool_name: 'Skill', tool_input: { skill: 'parallel-lanes' } });
  const notice = spawnSync('sh', ['-c', commands(s.hooks.PostToolUse)[0]], { input: event, encoding: 'utf8', env });
  assert.equal(notice.status, 0, notice.stderr);
  assert.match(JSON.parse(notice.stdout).systemMessage, /^parallel-lanes (v[0-9.]+ )?invoked$/);
});

test('install.sh replaces hooks an older install registered without quotes', { skip: SKIP }, () => {
  const dir = freshConfig();
  const old = `bash ${join(skillDir(dir), 'hooks', 'session-start.sh')}`;
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ hooks: { SessionStart: [
    { matcher: 'startup|clear|compact', hooks: [{ type: 'command', command: old }] },
  ] } }));
  install(dir);
  assert.deepEqual(commands(settings(dir).hooks.SessionStart),
    [`bash '${join(skillDir(dir), 'hooks', 'session-start.sh')}'`]);
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
