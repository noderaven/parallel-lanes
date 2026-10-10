import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { BASH, IS_WINDOWS, SYMLINKS, samePath, tempDir, mergeEnv, nativeWhich, pathList } from './platform.mjs';

const INSTALL = join(SKILL_DIR, 'install.sh');
const HAS_JQ = spawnSync(BASH, ['-c', 'command -v jq'], { encoding: 'utf8' }).status === 0;
// The shell Claude Code runs hook commands with: Git Bash on Windows (sh is
// not on PATH when the suite starts from PowerShell or cmd), sh elsewhere
// (dash on Ubuntu, so the stored commands are checked against a strict POSIX shell).
const HOOK_SHELL = IS_WINDOWS ? BASH : 'sh';
const SKIP = HAS_JQ ? false : 'jq is not on PATH';
// toolPath links the real tools into a fresh PATH directory.
const NO_SYMLINKS = !SYMLINKS && 'symlinks unavailable';

const TMP = tempDir('pl-install-');
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

function runInstall(configDir, args = [], env = {}) {
  return spawnSync(BASH, [INSTALL, ...args], {
    cwd: SKILL_DIR,
    encoding: 'utf8',
    env: mergeEnv(process.env, { CLAUDE_CONFIG_DIR: configDir }, env),
  });
}

function install(configDir, args = [], env = {}) {
  const res = runInstall(configDir, args, env);
  assert.equal(res.status, 0, `install.sh ${args.join(' ')} failed: ${res.stderr}`);
  return res;
}

// The tools install.sh and find-python start, found on the real PATH.
const TOOLS = ['bash', 'cat', 'chmod', 'cp', 'date', 'dirname', 'git', 'head', 'jq', 'ls', 'mkdir',
  'mktemp', 'mv', 'rm', 'sed', 'tar', 'tr', 'uname'];
const which = (name) => spawnSync(BASH, ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();

// A PATH of one fresh directory holding links to the real TOOLS except the
// omitted ones, plus the named executable scripts (name -> body).
function toolPath({ omit = [], scripts = {} } = {}) {
  counter += 1;
  const dir = join(TMP, `bin ${counter}`);
  mkdirSync(dir);
  for (const name of TOOLS) {
    // The link target in the host's form: Windows cannot follow /c/... links.
    const found = nativeWhich(name);
    if (!omit.includes(name) && found) symlinkSync(found, join(dir, name));
  }
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

function settings(configDir) {
  return JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'));
}

function commands(entries) {
  return (entries || []).flatMap((entry) => entry.hooks.map((hook) => hook.command));
}

// Asserts that a hook command is bash '<path>' for the script at path.
function assertHookCommand(command, path) {
  const m = /^bash '(.*)'$/.exec(command);
  assert.ok(m, command);
  assert.ok(samePath(m[1], path), `${command} does not run ${path}`);
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
  const installed = /^Installed agent type parallel-lanes-worker to (.*)$/m.exec(res.stdout);
  assert.ok(installed, res.stdout);
  assert.ok(samePath(installed[1], agentFile(dir)), `${installed[1]} is not ${agentFile(dir)}`);
  assert.ok(existsSync(join(skillDir(dir), 'SKILL.md')), 'the skill is installed');
  assert.ok(!existsSync(join(skillDir(dir), '.git')), 'the skill is installed without .git');

  const s = settings(dir);
  assert.equal(s.theme, 'dark');
  const start = commands(s.hooks.SessionStart);
  const notice = commands(s.hooks.PostToolUse);
  assert.equal(start.length, 1);
  assert.equal(notice.length, 1);
  assertHookCommand(start[0], join(skillDir(dir), 'hooks', 'session-start.sh'));
  assertHookCommand(notice[0], join(skillDir(dir), 'hooks', 'notice.sh'));
});

// Review finding 10: the stored commands must work when the host runs them
// through a shell, from a config dir with a space and a single quote.
test('install.sh registers hook commands that run from a config dir with spaces, quotes and shell characters', { skip: SKIP }, () => {
  counter += 1;
  // Review finding 10: every character a shell would act on, not just a space.
  // Windows file names cannot hold ", | or *.
  const shellChars = IS_WINDOWS ? "it's $HOME `x` ; &" : 'it\'s "a" $HOME `x` ; & | *';
  const dir = join(TMP, `${shellChars} config ${counter}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.json'), '{}\n');
  install(dir);
  const s = settings(dir);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: dir, PL_ACTIVE_DIR: join(dir, 'no markers') };
  const start = spawnSync(HOOK_SHELL, ['-c', commands(s.hooks.SessionStart)[0]], { input: '{}', encoding: 'utf8', env });
  assert.equal(start.status, 0, start.stderr);
  assert.equal(JSON.parse(start.stdout).hookSpecificOutput.hookEventName, 'SessionStart');
  const event = JSON.stringify({ tool_name: 'Skill', tool_input: { skill: 'parallel-lanes' } });
  const notice = spawnSync(HOOK_SHELL, ['-c', commands(s.hooks.PostToolUse)[0]], { input: event, encoding: 'utf8', env });
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
  const start = commands(settings(dir).hooks.SessionStart);
  assert.equal(start.length, 1, start.join('\n'));
  assertHookCommand(start[0], join(skillDir(dir), 'hooks', 'session-start.sh'));
});

test('install.sh replaces an older hook entry written with backslashes', { skip: SKIP }, () => {
  const dir = freshConfig();
  const old = 'bash C:\\Users\\me\\.claude\\skills\\parallel-lanes\\hooks\\session-start.sh';
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ hooks: { SessionStart: [
    { matcher: 'startup|clear|compact', hooks: [{ type: 'command', command: old }] },
  ] } }));
  install(dir);
  const start = commands(settings(dir).hooks.SessionStart);
  assert.equal(start.length, 1, start.join('\n'));
  assertHookCommand(start[0], join(skillDir(dir), 'hooks', 'session-start.sh'));
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

// A stock Windows Python install has python but no python3.
test('install.sh needs a working Python, not a python3 command', { skip: SKIP || NO_SYMLINKS }, (t) => {
  const python3 = which('python3');
  assert.ok(python3, 'python3 is on PATH');
  const python = { python: `exec '${python3}' "$@"` };
  let path;
  if (IS_WINDOWS) {
    // Linked tools do not run on Windows (the runner's jq is a Chocolatey
    // shim), so there the PATH is the real one without its python3 folders.
    const real = (process.env.Path || process.env.PATH || '').split(';')
      .filter((d) => d && !existsSync(join(d, 'python3.exe')) && !existsSync(join(d, 'python3')));
    path = pathList(toolPath({ omit: TOOLS, scripts: python }), ...real);
  } else {
    path = toolPath({ scripts: python });
  }
  const probe = spawnSync(BASH, ['-c', 'command -v python3'], { encoding: 'utf8', env: mergeEnv(process.env, { PATH: path }) });
  if (probe.status === 0) {
    // Seen on the macOS runner: bash still found a python3 with PATH set to
    // the test's directory alone, so the test cannot hide python3 there.
    t.skip(`bash finds python3 at ${probe.stdout.trim()} even with PATH=${path}`);
    return;
  }
  const dir = freshConfig();
  install(dir, [], { PATH: path });
  assert.ok(existsSync(join(skillDir(dir), 'SKILL.md')), 'the skill is installed');
});

test('install.sh suggests winget for jq on Windows', { skip: NO_SYMLINKS }, () => {
  const res = runInstall(freshConfig(), [], { PATH: toolPath({ omit: ['jq'] }), PL_UNAME: 'MINGW64_NT-10.0' });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /jq is required but not installed/);
  assert.ok(res.stderr.includes('winget install jqlang.jq'), res.stderr);
});

test('install.sh names jq without winget elsewhere', { skip: NO_SYMLINKS }, () => {
  const res = runInstall(freshConfig(), [], { PATH: toolPath({ omit: ['jq'] }), PL_UNAME: 'Linux' });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /jq is required but not installed/);
  assert.ok(!res.stderr.includes('winget'), res.stderr);
});
