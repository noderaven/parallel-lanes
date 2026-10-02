import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  lstatSync,
  existsSync,
  statSync,
  chmodSync,
  realpathSync,
  symlinkSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';

const SHADOW = join(SKILL_DIR, 'scripts', 'shadow');
const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'pl-shadow-')));
after(() => rmSync(TMP, { recursive: true, force: true }));

// Hermetic git: no global or system config, fixed identity.
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test Author',
  GIT_AUTHOR_EMAIL: 'author@example.invalid',
  GIT_COMMITTER_NAME: 'Test Author',
  GIT_COMMITTER_EMAIL: 'author@example.invalid',
};

let counter = 0;
// A fresh case directory holding a shadow base and a project named
// 'my project'. Tests never touch the real ~/.claude/parallel-lanes/shadow.
function newCase(files = {}) {
  counter += 1;
  const root = join(TMP, `case ${counter}`);
  const base = join(root, 'shadow base');
  const project = join(root, 'my project');
  mkdirSync(project, { recursive: true });
  for (const [rel, content] of Object.entries(files)) write(project, rel, content);
  return { root, base, project };
}

function write(dir, rel, content) {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function shadow(base, args, env = {}) {
  const res = spawnSync('bash', [SHADOW, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV, PL_SHADOW_BASE: base, ...env },
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

function git(args, cwd = TMP) {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
  });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout;
}

// Every entry under dir (lstat, symlinks not followed) with its content.
function snapshot(dir) {
  const out = {};
  for (const rel of readdirSync(dir, { recursive: true }).sort()) {
    const path = join(dir, rel);
    const st = lstatSync(path);
    if (st.isSymbolicLink()) out[rel] = `link:${readlinkSync(path)}`;
    else if (st.isDirectory()) out[rel] = 'dir';
    else out[rel] = `file:${(st.mode & 0o777).toString(8)}:${readFileSync(path, 'utf8')}`;
  }
  return out;
}

function init(c, extra = []) {
  const res = shadow(c.base, ['init', c.project, ...extra]);
  assert.equal(res.code, 0, res.stderr);
  return res.stdout.trim();
}

// A lane worktree created from the shadow repo, as the skill does.
function laneWorktree(c, gitdir, name = 'lane') {
  const wt = join(c.root, `wt ${name}`);
  git(['--git-dir', gitdir, 'worktree', 'add', '-q', '-b', name, wt, 'pl-base']);
  return wt;
}

function commitAll(wt, message = 'lane work') {
  git(['add', '-A'], wt);
  git(['commit', '-q', '-m', message], wt);
}

function trackedFiles(gitdir, ref = 'pl-base') {
  return git(['--git-dir', gitdir, 'ls-tree', '-r', '-z', '--name-only', ref])
    .split('\0')
    .filter(Boolean)
    .sort();
}

// --- init -------------------------------------------------------------------

test('init without .gitignore: built-in excludes, private dir, baseline on pl-base', () => {
  const c = newCase({
    'a.txt': 'a\n',
    'src/main.py': 'print(1)\n',
    'node_modules/pkg/index.js': 'x\n',
    'dist/out.js': 'x\n',
    'src/__pycache__/main.cpython-312.pyc': 'x\n',
  });
  const before = snapshot(c.project);
  const gitdir = init(c);

  const hash = createHash('sha256').update(c.project).digest('hex').slice(0, 16);
  assert.equal(gitdir, join(c.base, hash));
  assert.equal(statSync(gitdir).mode & 0o777, 0o700);
  assert.match(readFileSync(join(gitdir, 'info', 'exclude'), 'utf8'), /^node_modules\/$/m);
  assert.deepEqual(trackedFiles(gitdir), ['a.txt', 'src/main.py']);
  const baseline = readFileSync(join(gitdir, 'pl-baseline'), 'utf8').trim();
  assert.equal(baseline, git(['--git-dir', gitdir, 'rev-parse', 'pl-base']).trim());
  // The project gains nothing: no .git, no other file.
  assert.deepEqual(snapshot(c.project), before);
});

test('init with a .gitignore: project rules apply instead of the built-ins', () => {
  const c = newCase({
    '.gitignore': 'node_modules/\nsecret.txt\n',
    'a.txt': 'a\n',
    'secret.txt': 'loot\n',
    'node_modules/pkg/index.js': 'x\n',
    'dist/out.js': 'x\n',
  });
  const gitdir = init(c);
  assert.doesNotMatch(readFileSync(join(gitdir, 'info', 'exclude'), 'utf8'), /node_modules/);
  assert.deepEqual(trackedFiles(gitdir), ['.gitignore', 'a.txt', 'dist/out.js']);
  assert.ok(!existsSync(join(c.project, '.git')));
});

test('init again reuses the shadow and keeps its baseline', () => {
  const c = newCase({ 'a.txt': 'a\n' });
  const gitdir = init(c);
  const baseline = readFileSync(join(gitdir, 'pl-baseline'), 'utf8');
  write(c.project, 'a.txt', 'changed\n');
  assert.equal(init(c), gitdir);
  assert.equal(readFileSync(join(gitdir, 'pl-baseline'), 'utf8'), baseline);
});

test('init refuses a project over the file limit unless --force', () => {
  const c = newCase({
    'a.txt': 'a\n',
    'b.txt': 'b\n',
    'c.txt': 'c\n',
    'node_modules/1.js': 'x\n',
    'node_modules/2.js': 'x\n',
  });
  const refused = shadow(c.base, ['init', c.project], { PL_SHADOW_MAX_FILES: '2' });
  assert.equal(refused.code, 3);
  assert.match(refused.stderr, /3 files/);
  assert.match(refused.stderr, /--force/);
  assert.equal(refused.stdout, '');
  assert.deepEqual(existsSync(c.base) ? readdirSync(c.base) : [], []);

  // Excluded files do not count toward the limit.
  const fits = shadow(c.base, ['init', c.project], { PL_SHADOW_MAX_FILES: '3' });
  assert.equal(fits.code, 0, fits.stderr);
  shadow(c.base, ['remove', fits.stdout.trim()]);

  const forced = shadow(c.base, ['init', '--force', c.project], { PL_SHADOW_MAX_FILES: '2' });
  assert.equal(forced.code, 0, forced.stderr);
  assert.deepEqual(trackedFiles(forced.stdout.trim()), ['a.txt', 'b.txt', 'c.txt']);
});

test('init refuses a project over the size limit unless --force', () => {
  const c = newCase({ 'big.bin': 'x'.repeat(2000) });
  const refused = shadow(c.base, ['init', c.project], { PL_SHADOW_MAX_BYTES: '1000' });
  assert.equal(refused.code, 3);
  assert.match(refused.stderr, /--force/);
  const forced = shadow(c.base, ['init', c.project, '--force'], { PL_SHADOW_MAX_BYTES: '1000' });
  assert.equal(forced.code, 0, forced.stderr);
});

// --- preview and writeback --------------------------------------------------

function laneScenario() {
  const c = newCase({
    'a.txt': 'a\n',
    'b.txt': 'b\n',
    'keep.txt': 'keep\n',
    'run.sh': 'echo hi\n',
    'gone/only.txt': 'only\n',
    'node_modules/pkg/index.js': 'dep\n',
  });
  const gitdir = init(c);
  const wt = laneWorktree(c, gitdir);
  write(wt, 'a.txt', 'a from lane\n');
  unlinkSync(join(wt, 'b.txt'));
  unlinkSync(join(wt, 'gone/only.txt'));
  write(wt, 'new dir/file name.txt', 'new\n');
  write(wt, 'we"ird.txt', 'quoted\n');
  chmodSync(join(wt, 'run.sh'), 0o755);
  commitAll(wt);
  return { c, gitdir, wt };
}

test('preview lists the lane commit as add, modify and delete', () => {
  const { c, gitdir } = laneScenario();
  const res = shadow(c.base, ['preview', gitdir, c.project, 'lane']);
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), {
    conflicts: [],
    add: ['new dir/file name.txt', 'we"ird.txt'],
    modify: ['a.txt', 'run.sh'],
    delete: ['b.txt', 'gone/only.txt'],
  });
});

test('writeback applies exactly the previewed changes and keeps user files', () => {
  const { c, gitdir } = laneScenario();
  // User activity during the run that the lane did not touch.
  write(c.project, 'notes.txt', 'user notes\n');
  write(c.project, 'keep.txt', 'user edit\n');
  const before = snapshot(c.project);

  const res = shadow(c.base, ['writeback', gitdir, c.project, 'lane']);
  assert.equal(res.code, 0, res.stderr);

  const expected = { ...before };
  expected['a.txt'] = before['a.txt'].replace(/a\n$/, 'a from lane\n');
  delete expected['b.txt'];
  delete expected['gone/only.txt'];
  delete expected.gone;
  expected['new dir'] = 'dir';
  expected['new dir/file name.txt'] = 'file:new\n';
  expected['we"ird.txt'] = 'file:quoted\n';
  const after = snapshot(c.project);
  // New files take the user's umask; compare their content only.
  for (const rel of ['new dir/file name.txt', 'we"ird.txt']) {
    after[rel] = after[rel].replace(/^file:\d+:/, 'file:');
  }
  // run.sh gains the user execute bit and keeps its other bits.
  const runMode = statSync(join(c.project, 'run.sh')).mode & 0o777;
  assert.equal(runMode & 0o100, 0o100);
  assert.equal(runMode & 0o666, parseInt(before['run.sh'].split(':')[1], 8) & 0o666);
  delete expected['run.sh'];
  delete after['run.sh'];
  assert.equal(readFileSync(join(c.project, 'run.sh'), 'utf8'), 'echo hi\n');
  assert.deepEqual(after, expected);
  assert.equal(readFileSync(join(c.project, 'notes.txt'), 'utf8'), 'user notes\n');
  assert.equal(readFileSync(join(c.project, 'keep.txt'), 'utf8'), 'user edit\n');
  assert.ok(!existsSync(join(c.project, '.git')));
});

test('a user edit to a file the run also changed is a conflict; writeback writes nothing', () => {
  const { c, gitdir } = laneScenario();
  write(c.project, 'a.txt', 'user edit during run\n');
  const before = snapshot(c.project);

  const preview = shadow(c.base, ['preview', gitdir, c.project, 'lane']);
  assert.equal(preview.code, 0, preview.stderr);
  assert.deepEqual(JSON.parse(preview.stdout).conflicts, ['a.txt']);

  const res = shadow(c.base, ['writeback', gitdir, c.project, 'lane']);
  assert.equal(res.code, 3);
  assert.match(res.stderr, /a\.txt/);
  assert.deepEqual(snapshot(c.project), before);
});

test('user-created or user-deleted paths the run also changed are conflicts', () => {
  const { c, gitdir } = laneScenario();
  write(c.project, 'new dir/file name.txt', 'user made this\n');
  unlinkSync(join(c.project, 'b.txt'));
  unlinkSync(join(c.project, 'run.sh'));
  const before = snapshot(c.project);

  const preview = shadow(c.base, ['preview', gitdir, c.project, 'lane']);
  assert.deepEqual(JSON.parse(preview.stdout).conflicts, [
    'b.txt',
    'new dir/file name.txt',
    'run.sh',
  ]);
  const res = shadow(c.base, ['writeback', gitdir, c.project, 'lane']);
  assert.equal(res.code, 3);
  assert.deepEqual(snapshot(c.project), before);
});

test('paths under a directory the user replaced with a symlink are conflicts, never written through', () => {
  const c = newCase({ 'a.txt': 'a\n', 'd/f.txt': 'f\n' });
  const gitdir = init(c);
  const wt = laneWorktree(c, gitdir);
  write(wt, 'out/x.txt', 'x\n');
  write(wt, 'd/f.txt', 'f from lane\n');
  commitAll(wt);
  // The user adds a symlink 'out' and swaps 'd' for a symlink to a directory
  // holding an identical f.txt.
  const outside = join(c.root, 'outside');
  write(outside, 'f.txt', 'f\n');
  symlinkSync(outside, join(c.project, 'out'));
  rmSync(join(c.project, 'd'), { recursive: true });
  symlinkSync(outside, join(c.project, 'd'));

  const preview = shadow(c.base, ['preview', gitdir, c.project, 'lane']);
  assert.equal(preview.code, 0, preview.stderr);
  assert.deepEqual(JSON.parse(preview.stdout).conflicts, ['d/f.txt', 'out/x.txt']);
  assert.equal(shadow(c.base, ['writeback', gitdir, c.project, 'lane']).code, 3);
  assert.deepEqual(readdirSync(outside), ['f.txt']);
  assert.equal(readFileSync(join(outside, 'f.txt'), 'utf8'), 'f\n');
});

test('writeback never creates files at excluded paths', () => {
  const c = newCase({ 'a.txt': 'a\n' });
  const gitdir = init(c);
  const wt = laneWorktree(c, gitdir);
  write(wt, 'node_modules/forced.js', 'x\n');
  write(wt, 'b.txt', 'b\n');
  git(['add', '-f', 'node_modules/forced.js', 'b.txt'], wt);
  git(['commit', '-q', '-m', 'forced'], wt);

  const preview = shadow(c.base, ['preview', gitdir, c.project, 'lane']);
  assert.deepEqual(JSON.parse(preview.stdout).add, ['b.txt']);
  assert.equal(shadow(c.base, ['writeback', gitdir, c.project, 'lane']).code, 0);
  assert.ok(existsSync(join(c.project, 'b.txt')));
  assert.ok(!existsSync(join(c.project, 'node_modules')));
});

test('preview and writeback refuse a shadow that belongs to another project', () => {
  const { c, gitdir } = laneScenario();
  const other = newCase({ 'a.txt': 'a\n' });
  for (const cmd of ['preview', 'writeback']) {
    const res = shadow(c.base, [cmd, gitdir, other.project, 'lane']);
    assert.equal(res.code, 3, `${cmd}: ${res.stderr}`);
  }
  assert.equal(readFileSync(join(other.project, 'a.txt'), 'utf8'), 'a\n');
});

test('preview rejects an unknown ref', () => {
  const c = newCase({ 'a.txt': 'a\n' });
  const gitdir = init(c);
  const res = shadow(c.base, ['preview', gitdir, c.project, 'no-such-branch']);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /no-such-branch/);
});

// --- remove -----------------------------------------------------------------

test('remove deletes a shadow under the base', () => {
  const c = newCase({ 'a.txt': 'a\n' });
  const gitdir = init(c);
  const res = shadow(c.base, ['remove', gitdir]);
  assert.equal(res.code, 0, res.stderr);
  assert.ok(!existsSync(gitdir));
  assert.equal(readFileSync(join(c.project, 'a.txt'), 'utf8'), 'a\n');
});

test('remove refuses any path outside the shadow base', () => {
  const c = newCase({ 'a.txt': 'a\n' });
  const gitdir = init(c);
  const outside = join(c.root, 'precious');
  mkdirSync(outside);
  write(outside, 'pl-baseline', 'x\n');
  const link = join(c.base, '0123456789abcdef');
  symlinkSync(outside, link);

  for (const target of [outside, link, c.base, c.project, join(gitdir, 'info')]) {
    const res = shadow(c.base, ['remove', target]);
    assert.equal(res.code, 3, `${target}: ${res.stderr}`);
  }
  assert.ok(existsSync(join(outside, 'pl-baseline')));
  assert.ok(existsSync(join(gitdir, 'pl-baseline')));
  assert.ok(existsSync(join(c.project, 'a.txt')));
});

// --- usage ------------------------------------------------------------------

test('shadow exits 2 on usage errors', () => {
  const c = newCase({ 'a.txt': 'a\n' });
  for (const args of [
    [],
    ['bogus'],
    ['init'],
    ['init', c.project, 'extra'],
    ['init', c.project, '--frobnicate'],
    ['init', join(c.root, 'missing')],
    ['preview', 'x', 'y'],
    ['writeback', 'x', 'y'],
    ['remove'],
  ]) {
    const res = shadow(c.base, args);
    assert.equal(res.code, 2, `${JSON.stringify(args)}: ${res.stderr}`);
  }
});
