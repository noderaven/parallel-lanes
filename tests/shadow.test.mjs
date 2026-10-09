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
import { delimiter, dirname, join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { BASH, IS_WINDOWS, SYMLINKS, samePath } from './platform.mjs';

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
  const res = spawnSync(BASH, [SHADOW, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV, PL_SHADOW_BASE: base, ...env },
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

// git's own output, with CRLF line ends (if any) read as LF.
function git(args, cwd = TMP) {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
  });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.replace(/\r\n/g, '\n');
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
  assert.ok(samePath(gitdir, join(c.base, hash)), gitdir);
  // Windows has no POSIX modes: init succeeding is the check there.
  if (!IS_WINDOWS) assert.equal(statSync(gitdir).mode & 0o777, 0o700);
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

test('init runs no global hooks in the project and copies no template hooks', () => {
  const c = newCase({ 'a.txt': 'a\n' });
  const hook = '#!/bin/sh\necho ran > hook-output.txt\n';
  const hooksDir = join(c.root, 'global hooks');
  const templateDir = join(c.root, 'template');
  for (const dir of [hooksDir, join(templateDir, 'hooks')]) {
    for (const name of ['pre-commit', 'post-commit', 'post-checkout']) {
      write(dir, name, hook);
      chmodSync(join(dir, name), 0o755);
    }
  }
  write(templateDir, 'info/exclude', '# template\n');
  const config = join(c.root, 'gitconfig');
  writeFileSync(config, `[core]\n\thooksPath = ${hooksDir}\n[init]\n\ttemplateDir = ${templateDir}\n`);
  const before = snapshot(c.project);

  const res = shadow(c.base, ['init', c.project], { GIT_CONFIG_GLOBAL: config });
  assert.equal(res.code, 0, res.stderr);
  const gitdir = res.stdout.trim();
  assert.deepEqual(snapshot(c.project), before);
  const hooks = join(gitdir, 'hooks');
  assert.deepEqual(existsSync(hooks) ? readdirSync(hooks) : [], []);
});

test('init again reuses the shadow and keeps its baseline', () => {
  const c = newCase({ 'a.txt': 'a\n' });
  const gitdir = init(c);
  const baseline = readFileSync(join(gitdir, 'pl-baseline'), 'utf8');
  write(c.project, 'a.txt', 'changed\n');
  assert.equal(init(c), gitdir);
  assert.equal(readFileSync(join(gitdir, 'pl-baseline'), 'utf8'), baseline);
});

// A directory holding a fake cygpath that prints C:/fake before its last
// argument, so the Git Bash rules of _paths.sh run on every platform.
function fakeCygpath(root) {
  const bin = join(root, 'fake bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'cygpath'), '#!/bin/bash\necho "C:/fake${@: -1}"\n');
  chmodSync(join(bin, 'cygpath'), 0o755);
  return { PL_UNAME: 'MINGW64_NT-10.0', PATH: `${bin}${delimiter}${process.env.PATH}` };
}

test('shadow prints C:/ paths under Git Bash', () => {
  const c = newCase({ 'a.txt': 'a\n' });
  const env = fakeCygpath(c.root);
  const hash = createHash('sha256').update(c.project).digest('hex').slice(0, 16);
  const first = shadow(c.base, ['init', c.project], env);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.stdout, `C:/fake${join(c.base, hash)}\n`);
  // The shadow itself lives at the bash path, and a resumed init prints the same C:/ path.
  assert.ok(existsSync(join(c.base, hash, 'pl-baseline')));
  const again = shadow(c.base, ['init', c.project], env);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.stdout, first.stdout);
  // Paths in refusals take the C:/ form too.
  const other = newCase();
  write(join(c.base, hash), 'pl-project', `${other.project}\n`);
  const refused = shadow(c.base, ['init', c.project], env);
  assert.equal(refused.code, 3);
  assert.equal(refused.stderr, `shadow: C:/fake${join(c.base, hash)} belongs to another project\n`);
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
    skipped: [],
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
  // run.sh gains the user execute bit and keeps its other bits (Windows
  // has no execute bit: writeback succeeding is the check there).
  if (!IS_WINDOWS) {
    const runMode = statSync(join(c.project, 'run.sh')).mode & 0o777;
    assert.equal(runMode & 0o100, 0o100);
    assert.equal(runMode & 0o666, parseInt(before['run.sh'].split(':')[1], 8) & 0o666);
  }
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

test('paths under a directory the user replaced with a symlink are conflicts, never written through', { skip: !SYMLINKS && 'symlinks unavailable' }, () => {
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
  assert.deepEqual(JSON.parse(preview.stdout).skipped, ['node_modules/forced.js'], 'excluded adds are listed, not dropped');
  const wb = shadow(c.base, ['writeback', gitdir, c.project, 'lane']);
  assert.equal(wb.code, 0, wb.stderr);
  assert.deepEqual(JSON.parse(wb.stdout).skipped, ['node_modules/forced.js']);
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

const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

const permissionsSkip = (asRoot && 'root ignores permissions') || (IS_WINDOWS && 'Windows ignores POSIX directory modes');

test('writeback preflight: an unwritable target or directory writes nothing', { skip: permissionsSkip }, () => {
  const c = newCase({ 'a.txt': 'a\n', 'locked/f.txt': 'f\n', 'ro.txt': 'ro\n' });
  const gitdir = init(c);
  const wt = laneWorktree(c, gitdir);
  write(wt, 'a.txt', 'a from lane\n');
  write(wt, 'locked/new.txt', 'new\n');
  write(wt, 'ro.txt', 'ro from lane\n');
  commitAll(wt);
  chmodSync(join(c.project, 'locked'), 0o555);
  chmodSync(join(c.project, 'ro.txt'), 0o444);
  try {
    const before = snapshot(c.project);
    const res = shadow(c.base, ['writeback', gitdir, c.project, 'lane']);
    assert.equal(res.code, 3, res.stderr);
    assert.match(res.stderr, /nothing was written/);
    assert.match(res.stderr, /locked\/new\.txt/);
    assert.match(res.stderr, /ro\.txt/);
    assert.doesNotMatch(res.stderr, /^  a\.txt$/m);
    assert.equal(res.stdout, '');
    assert.deepEqual(snapshot(c.project), before);
  } finally {
    chmodSync(join(c.project, 'locked'), 0o755);
    chmodSync(join(c.project, 'ro.txt'), 0o644);
  }
});

test('a write that fails midway names the paths already written', () => {
  const c = newCase({ 'a.txt': 'a\n', 'm.txt': 'm\n' });
  const gitdir = init(c);
  const wt = laneWorktree(c, gitdir);
  write(wt, 'a.txt', 'a from lane\n');
  unlinkSync(join(wt, 'm.txt'));
  write(wt, 'z.bin', 'z'.repeat(64 * 1024));
  commitAll(wt);
  // A file size limit lets the small writes through and fails the large one.
  const res = spawnSync(BASH, ['-c', 'ulimit -c 0; ulimit -f 16; exec bash "$@"', 'limit', SHADOW, 'writeback', gitdir, c.project, 'lane'], {
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV, PL_SHADOW_BASE: c.base },
  });
  assert.equal(res.status, 3, res.stderr);
  assert.match(res.stderr, /writeback failed at z\.bin/);
  assert.match(res.stderr, /^  m\.txt$/m);
  assert.match(res.stderr, /^  a\.txt$/m);
  assert.equal(readFileSync(join(c.project, 'a.txt'), 'utf8'), 'a from lane\n');
  assert.ok(!existsSync(join(c.project, 'm.txt')));
});

test('core.autocrlf in the user config does not turn CRLF files into conflicts', () => {
  const c = newCase({ 'w.txt': 'one\r\ntwo\r\n', 'keep.txt': 'k\r\n' });
  const config = join(c.root, 'gitconfig');
  writeFileSync(config, '[core]\n\tautocrlf = true\n\tsafecrlf = true\n');
  const env = { GIT_CONFIG_GLOBAL: config };
  const res = shadow(c.base, ['init', c.project], env);
  assert.equal(res.code, 0, res.stderr);
  const gitdir = res.stdout.trim();
  const wt = laneWorktree(c, gitdir);
  assert.equal(readFileSync(join(wt, 'w.txt'), 'utf8'), 'one\r\ntwo\r\n', 'the baseline keeps CRLF bytes');
  write(wt, 'w.txt', 'one\r\ntwo\r\nthree\r\n');
  commitAll(wt);
  const preview = shadow(c.base, ['preview', gitdir, c.project, 'lane'], env);
  assert.equal(preview.code, 0, preview.stderr);
  assert.deepEqual(JSON.parse(preview.stdout).conflicts, []);
  const wb = shadow(c.base, ['writeback', gitdir, c.project, 'lane'], env);
  assert.equal(wb.code, 0, wb.stderr);
  assert.equal(readFileSync(join(c.project, 'w.txt'), 'utf8'), 'one\r\ntwo\r\nthree\r\n');
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

test('remove refuses any path outside the shadow base', { skip: !SYMLINKS && 'symlinks unavailable' }, () => {
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
