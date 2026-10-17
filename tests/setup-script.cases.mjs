import { after } from 'node:test';
import { test } from './shard.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  realpathSync,
  symlinkSync,
  rmSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { SKILL_DIR, loadHelpers } from './harness.mjs';
import { BASH, SYMLINKS, samePath, tempDir, mergeEnv, IS_WINDOWS } from './platform.mjs';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const TMP = realpathSync(tempDir('pl-setup-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

// Hermetic git: no global or system config, fixed identity.
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test Author',
  GIT_AUTHOR_EMAIL: 'author@example.invalid',
  GIT_COMMITTER_NAME: 'Test Author',
  GIT_COMMITTER_EMAIL: 'author@example.invalid',
  // Launch locks of these tests never meet the user's real ones.
  PL_ACTIVE_DIR: join(TMP, 'active markers'),
};

function sh(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    env: mergeEnv(process.env, GIT_ENV, opts.env),
    cwd: opts.cwd,
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

// git's own output, trimmed, with CRLF line ends (if any) read as LF.
function git(dir, ...args) {
  const res = sh('git', ['-C', dir, ...args]);
  assert.equal(res.code, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.replace(/\r\n/g, '\n').trim();
}

// Asserts that a list, or a map of names to paths, holds the expected paths.
function assertSamePaths(actual, expected) {
  if (Array.isArray(expected)) {
    assert.equal(actual.length, expected.length, JSON.stringify(actual));
    expected.forEach((p, i) => assert.ok(samePath(actual[i], p), `${actual[i]} is not ${p}`));
    return;
  }
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
  for (const [k, p] of Object.entries(expected)) assert.ok(samePath(actual[k], p), `${k}: ${actual[k]} is not ${p}`);
}

// Asserts that discarded entries ('<path>: <porcelain status>') match the
// expected [path, status] pairs in order: the path through samePath, the
// status exactly. The split skips a drive letter's colon (C:/...).
function assertDiscarded(actual, expected) {
  assert.equal(actual.length, expected.length, JSON.stringify(actual));
  expected.forEach(([path, status], i) => {
    const at = actual[i].indexOf(': ', /^[a-zA-Z]:/.test(actual[i]) ? 2 : 0);
    assert.ok(at > 0, `${actual[i]} has no path`);
    assert.ok(samePath(actual[i].slice(0, at), path), `${actual[i]} is not under ${path}`);
    assert.equal(actual[i].slice(at + 2), status, actual[i]);
  });
}

function write(dir, rel, content) {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const q = (s) => `'${s.replaceAll("'", "'\\''")}'`;

let counter = 0;
// A fresh case: a git project named 'my project' on main with one commit and
// a .gitignore for scratch/, plus paths for the worktree root, the ledger and
// a log every setup command appends its working directory to. name, if
// given, replaces 'case' at the start of the case folder's name.
function newCase(name = 'case') {
  counter += 1;
  const root = join(TMP, `${name} ${counter}`);
  const project = join(root, 'my project');
  mkdirSync(project, { recursive: true });
  write(project, 'README.md', 'hello\n');
  write(project, '.gitignore', 'scratch/\n');
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'init');
  return {
    root,
    project,
    worktreeRoot: join(root, 'wt root'),
    ledgerDir: join(root, 'ledger dir'),
    log: join(root, 'setup log'),
  };
}

function manifest(c, overrides = {}) {
  const logCmd = `pwd >> ${q(c.log)}`;
  return {
    version: 1,
    run_id: 'r1',
    repo: {
      mode: 'git',
      root: c.project,
      git_dir: null,
      base_ref: 'main',
      branch: 'feature/x',
      worktree_root: c.worktreeRoot,
      ledger_dir: c.ledgerDir,
    },
    commands: { setup: [logCmd], test: [], lint: [], build: [] },
    lane_commands: { b: { setup: [logCmd, `echo b-override >> ${q(c.log)}`] } },
    // Each lane has a task, so each has pending work and runs its setup.
    lanes: [
      { id: 'a', name: 'Lane A', tasks: [{ id: 'a1' }] },
      { id: 'b', name: 'Lane B', tasks: [{ id: 'b1' }] },
    ],
    ...overrides,
  };
}

// Runs setup as the holder of the run's launch lock: unless the caller passes
// its own PL_ACTIVE_DIR, the case gets its own marker dir, the lock is taken
// once per run id, and its token is passed as --owner.
function setup(c, m, extra = [], env = {}) {
  counter += 1;
  const path = join(c.root, `manifest ${counter}.json`);
  writeFileSync(path, JSON.stringify(m));
  if (!('PL_ACTIVE_DIR' in env) && typeof m.run_id === 'string' && /^[a-z0-9-]+$/.test(m.run_id)) {
    env = { ...env, PL_ACTIVE_DIR: join(c.root, 'own active dir') };
    c.tokens = c.tokens || {};
    if (!c.tokens[m.run_id]) {
      const got = sh(BASH, [join(SCRIPTS, 'active-run'), 'acquire', m.run_id, path], { env });
      assert.equal(got.code, 0, got.stderr);
      c.tokens[m.run_id] = got.stdout.trim();
    }
    if (!extra.includes('--owner')) extra = [...extra, '--owner', c.tokens[m.run_id]];
  }
  return sh('python3', [join(SCRIPTS, 'setup'), path, ...extra], { env });
}


function logLines(c) {
  return existsSync(c.log) ? readFileSync(c.log, 'utf8').trim().split('\n') : [];
}

function ledgerStatus(dir) {
  const res = sh('python3', [join(SCRIPTS, 'ledger'), 'status', dir]);
  assert.equal(res.code, 0, res.stderr);
  return JSON.parse(res.stdout);
}

const laneDir = (c, id) => `${c.worktreeRoot}/lane-${id}`;

test('setup: a fresh git run creates the branch and lane worktrees and prints setup_result', () => {
  const c = newCase();
  const base = git(c.project, 'rev-parse', 'main');
  const { worktrees, ...result } = setupOk(c, manifest(c));

  assert.deepEqual(result, {
    feature_head: base, discarded: [], preserved: [], setup_skipped: [], returned: [], git_identity: [],
  });
  assertSamePaths(worktrees, { a: laneDir(c, 'a'), b: laneDir(c, 'b') });
  assert.equal(git(c.project, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/x');
  assert.equal(git(laneDir(c, 'a'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'pl-r1-a');
  assert.equal(git(laneDir(c, 'b'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'pl-r1-b');
  assert.equal(git(laneDir(c, 'a'), 'rev-parse', 'HEAD'), base);
  // Setup commands ran in the feature checkout and in each lane worktree,
  // lane b with its override.
  assertSamePaths(logLines(c), [
    c.project,
    laneDir(c, 'a'),
    laneDir(c, 'b'),
    'b-override',
  ]);
  assert.equal(git(c.project, 'status', '--porcelain'), '');
});

test("setup: git_identity holds the commit rules' pairs", () => {
  const c = newCase();
  const rules = 'Commit with git -c user.name=n -c user.email=e@x.invalid commit.';
  const result = setupOk(c, manifest(c, { commit_rules: rules }));
  assert.deepEqual(result.git_identity, ['user.name=n', 'user.email=e@x.invalid']);
});

test('setup: a rerun reuses branches and worktrees and lists the discarded edits', () => {
  const c = newCase();
  const m = manifest(c);
  setupOk(c, m);
  // A lane commit stays; uncommitted edits are discarded; ignored scratch stays.
  write(laneDir(c, 'b'), 'lane.txt', 'lane work\n');
  git(laneDir(c, 'b'), 'add', 'lane.txt');
  git(laneDir(c, 'b'), 'commit', '-q', '-m', 'lane work');
  const laneHead = git(laneDir(c, 'b'), 'rev-parse', 'HEAD');
  write(laneDir(c, 'a'), 'README.md', 'edited\n');
  write(laneDir(c, 'a'), 'new file.txt', 'untracked\n');
  write(laneDir(c, 'a'), 'scratch/keep.txt', 'ignored\n');
  // The feature branch moved on since the first setup.
  write(c.project, 'more.txt', 'more\n');
  git(c.project, 'add', 'more.txt');
  git(c.project, 'commit', '-q', '-m', 'more');
  const featureHead = git(c.project, 'rev-parse', 'HEAD');

  const result = setupOk(c, m);
  assert.equal(result.feature_head, featureHead);
  assertSamePaths(result.worktrees, { a: laneDir(c, 'a'), b: laneDir(c, 'b') });
  assertDiscarded(result.discarded.sort(), [
    [laneDir(c, 'a'), ' M README.md'],
    [laneDir(c, 'a'), '?? "new file.txt"'],
  ]);
  assert.equal(readFileSync(join(laneDir(c, 'a'), 'README.md'), 'utf8'), 'hello\n');
  assert.equal(existsSync(join(laneDir(c, 'a'), 'new file.txt')), false);
  assert.equal(readFileSync(join(laneDir(c, 'a'), 'scratch/keep.txt'), 'utf8'), 'ignored\n');
  assert.equal(git(laneDir(c, 'b'), 'rev-parse', 'HEAD'), laneHead);
  assert.equal(git(c.project, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/x');
});

test('setup: a rerun under a non-ASCII path reuses the worktrees it made', () => {
  // git prints paths as UTF-8. Read with a Windows code page such as cp1252,
  // U+00E9 (bytes C3 A9) becomes two other characters, so the path no longer
  // matches and the rerun refuses its own worktrees; U+00DD (C3 9D) holds a
  // byte cp1252 leaves undefined, so decoding raises.
  const c = newCase('Jos\u00e9 \u00dd');
  const m = manifest(c);
  const first = setupOk(c, m);
  assertSamePaths(first.worktrees, { a: laneDir(c, 'a'), b: laneDir(c, 'b') });
  write(laneDir(c, 'a'), 'README.md', 'edited\n');
  const again = setupOk(c, m);
  assertSamePaths(again.worktrees, { a: laneDir(c, 'a'), b: laneDir(c, 'b') });
  assertDiscarded(again.discarded, [[laneDir(c, 'a'), ' M README.md']]);
  assert.equal(readFileSync(join(laneDir(c, 'a'), 'README.md'), 'utf8'), 'hello\n');
});

test('setup: a dirty main checkout exits 3 and creates nothing', () => {
  const c = newCase();
  write(c.project, 'README.md', 'uncommitted\n');
  const res = setup(c, manifest(c));
  assert.equal(res.code, 3, res.stderr);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /README\.md/);
  assert.equal(git(c.project, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(sh('git', ['-C', c.project, 'show-ref', '--verify', '--quiet', 'refs/heads/feature/x']).code, 1);
  assert.equal(existsSync(c.worktreeRoot), false);
  assert.equal(existsSync(c.ledgerDir), false);
  assert.deepEqual(logLines(c), []);
  assert.equal(readFileSync(join(c.project, 'README.md'), 'utf8'), 'uncommitted\n');
});

test('setup: a SHA-256 repository exits 3 with a clear message and creates nothing', () => {
  const c = newCase();
  rmSync(join(c.project, '.git'), { recursive: true, force: true });
  git(c.project, 'init', '-q', '-b', 'main', '--object-format=sha256');
  git(c.project, 'add', '-A');
  git(c.project, 'commit', '-q', '-m', 'init');
  const res = setup(c, manifest(c));
  assert.equal(res.code, 3, res.stderr);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /SHA-256/);
  assert.equal(sh('git', ['-C', c.project, 'show-ref', '--verify', '--quiet', 'refs/heads/feature/x']).code, 1);
  assert.equal(existsSync(c.worktreeRoot), false);
  assert.equal(existsSync(c.ledgerDir), false);
});

test('setup: ignored files in the main checkout survive', () => {
  const c = newCase();
  write(c.project, 'scratch/notes.txt', 'mine\n');
  setupOk(c, manifest(c));
  setupOk(c, manifest(c));
  assert.equal(readFileSync(join(c.project, 'scratch/notes.txt'), 'utf8'), 'mine\n');
});

test('setup: lite creates no lane worktree and maps the lane to the feature checkout', () => {
  const c = newCase();
  const m = manifest(c, {
    profile: 'lite',
    lanes: [{ id: 'b', name: 'Lane B', tasks: [] }],
  });
  const result = setupOk(c, m);
  assertSamePaths(result.worktrees, { b: c.project });
  assert.equal(existsSync(laneDir(c, 'b')), false);
  assert.equal(sh('git', ['-C', c.project, 'show-ref', '--verify', '--quiet', 'refs/heads/pl-r1-b']).code, 1);
  assert.equal(git(c.project, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/x');
  // The feature setup and the lane's own setup both run in the feature checkout.
  assertSamePaths(logLines(c), [c.project, c.project, 'b-override']);
});

test('setup: lite runs an identical lane setup only once', () => {
  const c = newCase();
  const m = manifest(c, {
    profile: 'lite',
    lanes: [{ id: 'a', name: 'Lane A', tasks: [] }],
  });
  setupOk(c, m);
  assertSamePaths(logLines(c), [c.project]);
});

test('setup writes the owner map from the manifest', () => {
  const c = newCase();
  const m = manifest(c, { lanes: [
    { id: 'a', name: 'Lane A', tasks: [{ id: 'a1', files: ['src/a.js', 'shared.css'] }] },
    { id: 'b', name: 'Lane B', tasks: [{ id: 'b1', files: ['shared.css'] }] },
  ] });
  setupOk(c, m);
  const owners = JSON.parse(readFileSync(join(c.ledgerDir, 'owners.json'), 'utf8'));
  assert.deepEqual(owners.files, { 'src/a.js': ['a1'], 'shared.css': ['a1', 'b1'] });
  assert.deepEqual(owners.tasks, {
    a1: { where: 'a', pos: 0, declared: ['src/a.js', 'shared.css'] },
    b1: { where: 'b', pos: 0, declared: ['shared.css'] },
  });
});

test('setup records each task\'s Files list as given, each exact string once', () => {
  const c = newCase();
  const m = manifest(c, { lanes: [
    { id: 'a', name: 'Lane A', tasks: [{ id: 'a1', files: ['src/A.js', './src/a.js', 'src/A.js'] }] },
    { id: 'b', name: 'Lane B', tasks: [{ id: 'b1' }] },
  ] });
  setupOk(c, m);
  const owners = JSON.parse(readFileSync(join(c.ledgerDir, 'owners.json'), 'utf8'));
  assert.deepEqual(owners.tasks.a1.declared, ['src/A.js', './src/a.js']);
  assert.deepEqual(owners.tasks.b1.declared, []);
  assert.deepEqual(owners.files, { 'src/a.js': ['a1'] });
});

test('setup: ledger records run_started and status reports the earliest start point', () => {
  const c = newCase();
  const m = manifest(c);
  const first = setupOk(c, m);
  const lines = readFileSync(join(c.ledgerDir, '_run.jsonl'), 'utf8').trim().split('\n');
  assert.deepEqual(JSON.parse(lines[0]), {
    task: '_run',
    event: 'run_started',
    phase: 'setup',
    head: first.feature_head,
    plan_sha256: null,
    spec_sha256: null,
    setup_skipped: [],
  });
  write(c.project, 'more.txt', 'more\n');
  git(c.project, 'add', 'more.txt');
  git(c.project, 'commit', '-q', '-m', 'more');
  const second = setupOk(c, m);
  assert.notEqual(second.feature_head, first.feature_head);
  const { done, reviewed, blocked, start_points, carry } = ledgerStatus(c.ledgerDir);
  assert.deepEqual({ done, reviewed, blocked, start_points, carry }, {
    done: [],
    reviewed: [],
    blocked: [],
    start_points: { prelude: first.feature_head },
    carry: {},
  });
});

test('setup: a foreign directory at a lane path exits 3 and is left alone', () => {
  const c = newCase();
  write(laneDir(c, 'a'), 'user.txt', 'not a worktree\n');
  const res = setup(c, manifest(c));
  assert.equal(res.code, 3, res.stderr);
  assert.match(res.stderr, /lane-a/);
  assert.equal(readFileSync(join(laneDir(c, 'a'), 'user.txt'), 'utf8'), 'not a worktree\n');
  assert.equal(git(c.project, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
});

test('setup runs setup commands with the resolved bash', { skip: IS_WINDOWS && 'a fake bash script cannot stand in for bash.exe on Windows (find_bash is unit-tested in tests/platform.test.mjs)' }, () => {
  const c = newCase();
  const realBash = sh(BASH, ['-c', 'command -v bash']).stdout.trim();
  const calls = join(c.root, 'calls');
  write(c.root, 'fake bin/bash', `#!${realBash}\nprintf '%s\\n' "$*" >> ${q(calls)}\nexec ${q(realBash)} "$@"\n`);
  chmodSync(join(c.root, 'fake bin', 'bash'), 0o755);
  const m = manifest(c, { lanes: [{ id: 'a', name: 'Lane A', tasks: [{ id: 'a1' }] }] });
  const res = setup(c, m, [], { PATH: `${join(c.root, 'fake bin')}${delimiter}${process.env.PATH}` });
  assert.equal(res.code, 0, res.stderr);
  assertSamePaths(logLines(c), [c.project, laneDir(c, 'a')]);
  const logCmd = m.commands.setup[0];
  // The test's own active-run acquire also goes through the fake bash.
  const commandCalls = readFileSync(calls, 'utf8').split('\n').filter((l) => l.startsWith('-c '));
  assert.deepEqual(commandCalls, [`-c ${logCmd}`, `-c ${logCmd}`]);
});

test('setup: a failing setup command exits 1 and records no start point', () => {
  const c = newCase();
  const m = manifest(c);
  m.commands.setup = ['echo noise; exit 4'];
  const res = setup(c, m);
  assert.equal(res.code, 1);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /exit 4/);
  assert.equal(existsSync(join(c.ledgerDir, '_run.jsonl')), false);
});

test('setup: shadow mode creates the feature worktree and never touches the project', () => {
  const c = newCase();
  // A non-git project folder shadowed by scripts/shadow.
  const project = join(c.root, 'plain', 'my project');
  write(project, 'app.txt', 'app\n');
  const shadowBase = join(c.root, 'shadow base');
  const init = sh(BASH, [join(SCRIPTS, 'shadow'), 'init', project], {
    env: { PL_SHADOW_BASE: shadowBase },
  });
  assert.equal(init.code, 0, init.stderr);
  const gitDir = init.stdout.trim();
  const baseline = readFileSync(join(gitDir, 'pl-baseline'), 'utf8').trim();
  const m = manifest(c, {
    repo: {
      mode: 'shadow',
      root: project,
      git_dir: gitDir,
      base_ref: 'pl-base',
      branch: 'pl-r1',
      worktree_root: c.worktreeRoot,
      ledger_dir: c.ledgerDir,
    },
  });
  const feature = `${c.worktreeRoot}/feature`;
  const { worktrees, ...result } = setupOk(c, m);
  assert.deepEqual(result, {
    feature_head: baseline, discarded: [], preserved: [], setup_skipped: [], returned: [], git_identity: [],
  });
  assertSamePaths(worktrees, { a: laneDir(c, 'a'), b: laneDir(c, 'b') });
  assert.equal(git(feature, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pl-r1');
  assert.equal(git(laneDir(c, 'a'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'pl-r1-a');
  assert.equal(readFileSync(join(feature, 'app.txt'), 'utf8'), 'app\n');
  assert.deepEqual(readdirSync(project), ['app.txt']);
  assertSamePaths(logLines(c), [feature, laneDir(c, 'a'), laneDir(c, 'b'), 'b-override']);

  // A rerun discards and lists edits in the feature worktree.
  write(feature, 'app.txt', 'edited\n');
  const again = setupOk(c, m);
  assertDiscarded(again.discarded, [[feature, ' M app.txt']]);
  assert.equal(readFileSync(join(feature, 'app.txt'), 'utf8'), 'app\n');
  assert.deepEqual(readdirSync(project), ['app.txt']);
});

test('setup: shadow lite maps the lane to the feature worktree', () => {
  const c = newCase();
  const project = join(c.root, 'plain', 'my project');
  write(project, 'app.txt', 'app\n');
  const init = sh(BASH, [join(SCRIPTS, 'shadow'), 'init', project], {
    env: { PL_SHADOW_BASE: join(c.root, 'shadow base') },
  });
  assert.equal(init.code, 0, init.stderr);
  const m = manifest(c, {
    profile: 'lite',
    lanes: [{ id: 'a', name: 'Lane A', tasks: [] }],
    repo: {
      mode: 'shadow',
      root: project,
      git_dir: init.stdout.trim(),
      base_ref: 'pl-base',
      branch: 'pl-r1',
      worktree_root: c.worktreeRoot,
      ledger_dir: c.ledgerDir,
    },
  });
  const result = setupOk(c, m);
  assertSamePaths(result.worktrees, { a: `${c.worktreeRoot}/feature` });
  assert.equal(existsSync(laneDir(c, 'a')), false);
});

test('setup: usage errors and unreadable manifests exit 2', () => {
  assert.equal(sh('python3', [join(SCRIPTS, 'setup')]).code, 2);
  assert.equal(sh('python3', [join(SCRIPTS, 'setup'), join(TMP, 'missing.json')]).code, 2);
  const c = newCase();
  const bad = join(c.root, 'bad.json');
  writeFileSync(bad, JSON.stringify({ version: 1 }));
  assert.equal(sh('python3', [join(SCRIPTS, 'setup'), bad]).code, 2);
});

test('setup: unsafe manifests exit 2 before any change', () => {
  const c = newCase();
  const repo = manifest(c).repo;
  const cases = [
    manifest(c, { run_id: 'R1/..' }),
    manifest(c, { lanes: [{ id: '../x', name: 'Lane X', tasks: [] }] }),
    manifest(c, { lanes: [{ id: 'join', name: 'Lane J', tasks: [] }] }),
    manifest(c, { repo: { ...repo, worktree_root: 'relative/wt' } }),
    manifest(c, { repo: { ...repo, ledger_dir: 'ledger' } }),
    manifest(c, { repo: { ...repo, root: 'my project' } }),
    manifest(c, { repo: { ...repo, base_ref: '--no-track' } }),
  ];
  for (const m of cases) {
    const res = setup(c, m);
    assert.equal(res.code, 2, `${JSON.stringify(m.repo)} ${m.run_id}: ${res.stderr}`);
  }
  assert.equal(git(c.project, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(sh('git', ['-C', c.project, 'rev-parse', '--verify', '--quiet', 'refs/heads/feature/x']).code, 1);
  assert.equal(existsSync(c.worktreeRoot), false);
});

test('setup: a base_ref that names no commit exits 1 and creates no branch', () => {
  const c = newCase();
  const m = manifest(c);
  m.repo.base_ref = 'no-such-ref';
  const res = setup(c, m);
  assert.equal(res.code, 1, res.stderr);
  assert.match(res.stderr, /no-such-ref/);
  assert.equal(sh('git', ['-C', c.project, 'rev-parse', '--verify', '--quiet', 'refs/heads/feature/x']).code, 1);
});

test('setup: the feature branch starts at the resolved base_ref commit', () => {
  const c = newCase();
  const base = git(c.project, 'rev-parse', 'main');
  git(c.project, 'switch', '-q', '-c', 'other');
  write(c.project, 'other.txt', 'x\n');
  git(c.project, 'add', '-A');
  git(c.project, 'commit', '-q', '-m', 'other');
  const result = setupOk(c, manifest(c));
  assert.equal(result.feature_head, base);
});

test('setup: a symlink at a lane path exits 3, even one to an empty directory', { skip: !SYMLINKS && 'symlinks unavailable' }, () => {
  const c = newCase();
  const target = join(c.root, 'elsewhere');
  mkdirSync(target, { recursive: true });
  mkdirSync(c.worktreeRoot, { recursive: true });
  symlinkSync(target, laneDir(c, 'a'));
  const res = setup(c, manifest(c));
  assert.equal(res.code, 3, res.stderr);
  assert.match(res.stderr, /lane-a/);
  assert.deepEqual(readdirSync(target), [], 'nothing is created at the link target');
  assert.equal(git(c.project, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
});

test('setup: prunes only missing worktree records under worktree_root', () => {
  const c = newCase();
  const own = join(c.root, 'user wt');
  git(c.project, 'worktree', 'add', '-q', '-b', 'user-branch', own);
  setupOk(c, manifest(c));
  // Both directories go missing: the run's lane worktree and the user's own.
  rmSync(laneDir(c, 'a'), { recursive: true, force: true });
  rmSync(own, { recursive: true, force: true });
  setupOk(c, manifest(c));
  const list = git(c.project, 'worktree', 'list', '--porcelain');
  const records = list.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length));
  assert.ok(records.some((p) => samePath(p, own)), "the user's missing worktree keeps its record");
  assert.ok(existsSync(join(laneDir(c, 'a'), 'README.md')), 'the lane worktree is recreated');
});

// --- review finding 7: overlapping launches and abandoned work ----------------

const activeRun = (env, ...args) => sh(BASH, [join(SCRIPTS, 'active-run'), ...args], { env });

test('setup: a run locked by another launch is refused, and its in-progress work survives', () => {
  const c = newCase();
  const env = { PL_ACTIVE_DIR: join(c.root, 'active') };
  const m = manifest(c);
  const token = activeRun(env, 'acquire', 'r1', '/m.json').stdout.trim();
  assert.match(token, /^[0-9a-f]{32}$/);
  setupOk(c, m, ['--owner', token], env);
  write(laneDir(c, 'a'), 'wip.txt', 'in progress\n');
  for (const extra of [[], ['--owner', 'not-the-token']]) {
    const res = setup(c, m, extra, env);
    assert.equal(res.code, 3, res.stderr);
    assert.match(res.stderr, /locked by another launch/);
    assert.equal(readFileSync(join(laneDir(c, 'a'), 'wip.txt'), 'utf8'), 'in progress\n');
  }
});

function setupOk(c, m, extra = [], env = {}) {
  const res = setup(c, m, extra, env);
  assert.equal(res.code, 0, res.stderr);
  return JSON.parse(res.stdout);
}

test('setup: changes it discards are saved first in a commit under a run ref', () => {
  const c = newCase();
  const m = manifest(c);
  setupOk(c, m);
  write(laneDir(c, 'a'), 'README.md', 'edited\n');
  write(laneDir(c, 'a'), 'new file.txt', 'untracked\n');
  write(laneDir(c, 'a'), 'scratch/keep.txt', 'ignored\n');
  const laneHead = git(laneDir(c, 'a'), 'rev-parse', 'HEAD');
  const result = setupOk(c, m);
  assert.equal(result.preserved.length, 1);
  const [saved] = result.preserved;
  assert.ok(samePath(saved.worktree, laneDir(c, 'a')), saved.worktree);
  assert.match(saved.ref, /^refs\/parallel-lanes\/r1\/abandoned\/lane-a-\d{8}T\d+Z$/);
  assert.equal(git(c.project, 'rev-parse', saved.ref), saved.commit);
  assert.equal(git(c.project, 'rev-parse', `${saved.commit}^`), laneHead);
  // Nothing staged (index equal to HEAD, untracked files aside): one commit.
  assert.equal(saved.index_commit, null);
  assert.equal(saved.index_saved, true);
  assert.equal(git(c.project, 'show', `${saved.commit}:README.md`), 'edited');
  assert.equal(git(c.project, 'show', `${saved.commit}:new file.txt`), 'untracked');
  assert.equal(sh('git', ['-C', c.project, 'cat-file', '-e', `${saved.commit}:scratch/keep.txt`]).code === 0, false);
  // The worktree itself was discarded, ignored scratch kept.
  assert.equal(git(laneDir(c, 'a'), 'status', '--porcelain'), '');
  assert.equal(readFileSync(join(laneDir(c, 'a'), 'scratch', 'keep.txt'), 'utf8'), 'ignored\n');
});

// --- C3: the recovery snapshot keeps the staged version ------------------------

// A case whose lane a was set up once, so the next setup reuses it and
// discards its changes. Every case path has a space in it ('wt root').
function reusedLane() {
  const c = newCase();
  const m = manifest(c);
  setupOk(c, m);
  const wt = laneDir(c, 'a');
  return { c, m, wt, head: git(wt, 'rev-parse', 'HEAD') };
}

// git status --porcelain, untrimmed (a leading space is part of a status).
const porcelain = (wt) => sh('git', ['-C', wt, 'status', '--porcelain']).stdout.replace(/\r\n/g, '\n');

// The documented restore: the files from commit, then the index from
// index_commit (HEAD when it is null: nothing was staged).
function restore(wt, saved) {
  git(wt, 'checkout', saved.commit, '--', '.');
  git(wt, 'read-tree', saved.index_commit || 'HEAD');
}

// Asserts that saved holds an index commit on head with the staged content
// and a working commit on top of it with the working content, for file rel.
function assertTwoCommits(c, saved, head, rel, staged, working) {
  assert.equal(saved.index_saved, true);
  assert.equal('index_error' in saved, false);
  assert.match(saved.index_commit, /^[0-9a-f]{40,64}$/);
  assert.notEqual(saved.index_commit, saved.commit);
  assert.equal(git(c.project, 'rev-parse', `${saved.index_commit}^`), head);
  assert.equal(git(c.project, 'show', `${saved.index_commit}:${rel}`), staged);
  assert.equal(git(c.project, 'rev-parse', saved.ref), saved.commit);
  assert.equal(git(c.project, 'rev-parse', `${saved.commit}^`), saved.index_commit);
  assert.equal(git(c.project, 'show', `${saved.commit}:${rel}`), working);
}

for (const [label, rel, status] of [['a staged then edited file (MM)', 'README.md', 'MM'],
  ['a new staged then edited file (AM)', 'added file.txt', 'AM']]) {
  test(`setup: ${label} is saved as an index commit under the working snapshot, and both restore`, () => {
    const { c, m, wt, head } = reusedLane();
    assert.match(wt, / /);
    write(wt, rel, 'staged\n');
    git(wt, 'add', '--', rel);
    write(wt, rel, 'working\n');
    const before = porcelain(wt);
    assert.match(before, new RegExp(`^${status} `));
    const result = setupOk(c, m);
    assert.equal(result.preserved.length, 1);
    const [saved] = result.preserved;
    assert.ok(samePath(saved.worktree, wt), saved.worktree);
    assertTwoCommits(c, saved, head, rel, 'staged', 'working');
    assert.equal(porcelain(wt), '');
    restore(wt, saved);
    assert.equal(porcelain(wt), before);
    assert.match(git(wt, 'diff', '--cached'), /^\+staged$/m);
    assert.equal(readFileSync(join(wt, rel), 'utf8'), 'working\n');
  });
}

test('setup: a staged file with no further edit (A ) still gives an index commit', () => {
  const { c, m, wt, head } = reusedLane();
  write(wt, 'only staged.txt', 'staged\n');
  git(wt, 'add', '--', 'only staged.txt');
  assert.equal(porcelain(wt), 'A  "only staged.txt"\n');
  const [saved] = setupOk(c, m).preserved;
  assertTwoCommits(c, saved, head, 'only staged.txt', 'staged', 'staged');
  restore(wt, saved);
  assert.equal(porcelain(wt), 'A  "only staged.txt"\n');
});

test('setup: an unstaged edit only gives one commit on the lane HEAD and restores unstaged', () => {
  const { c, m, wt, head } = reusedLane();
  write(wt, 'README.md', 'edited\n');
  assert.equal(porcelain(wt), ' M README.md\n');
  const [saved] = setupOk(c, m).preserved;
  assert.equal(saved.index_commit, null);
  assert.equal(saved.index_saved, true);
  assert.equal('index_error' in saved, false);
  assert.equal(git(c.project, 'rev-parse', `${saved.commit}^`), head);
  restore(wt, saved);
  assert.equal(porcelain(wt), ' M README.md\n');
});

test('setup: an intent-to-add file (git add -N) comes back untracked after the restore', () => {
  const { c, m, wt, head } = reusedLane();
  write(wt, 'intent.txt', 'not staged yet\n');
  git(wt, 'add', '-N', '--', 'intent.txt');
  assert.equal(porcelain(wt), ' A intent.txt\n');
  const [saved] = setupOk(c, m).preserved;
  assert.equal(saved.index_saved, true);
  assert.equal(saved.index_commit, null, 'an intent-to-add entry is not in the index tree');
  assert.equal(git(c.project, 'rev-parse', `${saved.commit}^`), head);
  assert.equal(git(c.project, 'show', `${saved.commit}:intent.txt`), 'not staged yet');
  assert.equal(existsSync(join(wt, 'intent.txt')), false);
  restore(wt, saved);
  assert.equal(porcelain(wt), '?? intent.txt\n');
  assert.equal(readFileSync(join(wt, 'intent.txt'), 'utf8'), 'not staged yet\n');
});

test('setup: an unmerged index is not saved (git says why), the working copy is, and setup succeeds', () => {
  const { c, m, wt } = reusedLane();
  git(wt, 'branch', 'side');
  write(wt, 'README.md', 'ours\n');
  git(wt, 'commit', '-qam', 'ours');
  git(wt, 'switch', '-q', 'side');
  write(wt, 'README.md', 'theirs\n');
  git(wt, 'commit', '-qam', 'theirs');
  git(wt, 'switch', '-q', 'pl-r1-a');
  const head = git(wt, 'rev-parse', 'HEAD');
  assert.equal(sh('git', ['-C', wt, 'merge', '-q', 'side']).code, 1);
  assert.equal(porcelain(wt), 'UU README.md\n');
  const result = setupOk(c, m);
  assert.equal(result.preserved.length, 1);
  const [saved] = result.preserved;
  assert.equal(saved.index_saved, false);
  assert.equal(saved.index_commit, null);
  assert.match(saved.index_error, /unmerged/);
  assert.equal(git(c.project, 'rev-parse', saved.ref), saved.commit);
  assert.equal(git(c.project, 'rev-parse', `${saved.commit}^`), head);
  assert.match(git(c.project, 'show', `${saved.commit}:README.md`), /^<<<<<<< .*\nours\n=======\ntheirs\n>>>>>>> side$/s);
  assert.equal(porcelain(wt), '');
});

// snapshot(path, run_id) of scripts/setup, called directly (its main does not
// run); prints the preserved entry it returns.
const CALL_SNAPSHOT = [
  'import importlib.machinery, importlib.util, json, sys',
  'sys.dont_write_bytecode = True',
  "loader = importlib.machinery.SourceFileLoader('setup_script', sys.argv[1])",
  'mod = importlib.util.module_from_spec(importlib.util.spec_from_loader(loader.name, loader))',
  'loader.exec_module(mod)',
  'print(json.dumps(mod.snapshot(sys.argv[2], sys.argv[3])))',
];

test('setup: a held index.lock fails the staged save and then the reset; the changes stay saved and on disk', () => {
  const { c, m, wt, head } = reusedLane();
  write(wt, 'README.md', 'edited\n');
  const lock = git(wt, 'rev-parse', '--path-format=absolute', '--git-path', 'index.lock');
  writeFileSync(lock, '');
  try {
    // The snapshot itself: no index commit, git's message, the working snapshot made.
    const out = sh('python3', ['-c', CALL_SNAPSHOT.join('\n'), join(SCRIPTS, 'setup'), wt, 'r1']);
    assert.equal(out.code, 0, out.stderr);
    const saved = JSON.parse(out.stdout);
    assert.equal(saved.index_saved, false);
    assert.equal(typeof saved.index_error, 'string');
    assert.ok(saved.index_error.length > 0, 'git says why');
    assert.equal(saved.index_commit, null);
    assert.equal(git(c.project, 'rev-parse', saved.ref), saved.commit);
    assert.equal(git(c.project, 'rev-parse', `${saved.commit}^`), head);
    // setup on the same state: the reset --hard fails on the lock after the save.
    const res = setup(c, m);
    assert.equal(res.code, 1, res.stderr);
    assert.equal(res.stdout, '');
    assert.match(res.stderr, /git .*reset -q --hard HEAD failed/);
    const refs = git(c.project, 'for-each-ref', '--format=%(refname)', 'refs/parallel-lanes/r1/abandoned/')
      .split('\n').filter((r) => /\/lane-a-\d{8}T\d+Z$/.test(r) && r !== saved.ref);
    assert.equal(refs.length, 1, 'setup saved the changes before the reset failed');
    assert.equal(git(c.project, 'show', `${refs[0]}:README.md`), 'edited');
    assert.equal(readFileSync(join(wt, 'README.md'), 'utf8'), 'edited\n');
  } finally {
    rmSync(lock, { force: true });
  }
});

test('setup: run_started records the plan and spec hashes', () => {
  const c = newCase();
  write(c.root, 'plan.md', '# Plan\n');
  write(c.root, 'spec.md', '# Spec\n');
  setupOk(c, manifest(c, { plan: join(c.root, 'plan.md'), spec: join(c.root, 'spec.md') }));
  const [entry] = readFileSync(join(c.ledgerDir, '_run.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(entry.plan_sha256, createHash('sha256').update('# Plan\n').digest('hex'));
  assert.equal(entry.spec_sha256, createHash('sha256').update('# Spec\n').digest('hex'));
});

test('setup: a run with no launch lock is refused, even with a token from a released lock', () => {
  const c = newCase();
  const env = { PL_ACTIVE_DIR: join(c.root, 'active') };
  const m = manifest(c);
  let res = setup(c, m, [], env);
  assert.equal(res.code, 3, res.stderr);
  assert.match(res.stderr, /no launch lock/);
  const token = activeRun(env, 'acquire', 'r1', '/m.json').stdout.trim();
  setupOk(c, m, ['--owner', token], env);
  assert.equal(activeRun(env, 'release', 'r1', 'stopped', '--owner', token).code, 0);
  write(laneDir(c, 'a'), 'wip.txt', 'work of a session still running\n');
  res = setup(c, m, ['--owner', token], env);
  assert.equal(res.code, 3, res.stderr);
  assert.equal(readFileSync(join(laneDir(c, 'a'), 'wip.txt'), 'utf8'), 'work of a session still running\n');
});

test('active-run: remove refuses a locked run unless --takeover', () => {
  const c = newCase();
  const env = { PL_ACTIVE_DIR: join(c.root, 'active') };
  activeRun(env, 'acquire', 'r1', '/m.json');
  const res = activeRun(env, 'remove', 'r1');
  assert.equal(res.code, 4);
  assert.match(res.stderr, /--takeover/);
  assert.equal(activeRun(env, 'remove', 'r1', '--takeover').code, 0);
  assert.equal(JSON.parse(activeRun(env, 'list').stdout).length, 0);
});

// --- F4: one run per feature checkout ------------------------------------------

// A git-mode manifest for run runId on root (default the case's project), with
// its own feature branch pl-<runId> and worktree root, so two runs on one
// checkout collide only on the checkout itself.
function runManifest(c, runId, root = c.project) {
  const m = manifest(c, { run_id: runId, lanes: [{ id: 'a', name: 'Lane A', tasks: [] }], lane_commands: {} });
  m.repo = { ...m.repo, root, branch: `pl-${runId}`, worktree_root: join(c.root, `wt ${runId}`) };
  return m;
}

// The active dir setup() gives a case, and the checkout locks in it. Lock
// names are found by globbing, never recomputed from a stat here.
const ownActiveDir = (c) => join(c.root, 'own active dir');
const checkoutLocks = (c) => readdirSync(ownActiveDir(c)).filter((f) => /^checkout-.*\.lock$/.test(f));
const hasBranch = (dir, branch) => sh('git', ['-C', dir, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).code === 0;

test('setup: a second run on the same checkout is refused before any branch switch', () => {
  const c = newCase();
  setupOk(c, runManifest(c, 'first'));
  assert.equal(git(c.project, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pl-first');
  const res = setup(c, runManifest(c, 'second'));
  assert.equal(res.code, 4, res.stderr);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /\bfirst\b/);
  assert.equal(git(c.project, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pl-first');
  assert.equal(hasBranch(c.project, 'pl-second'), false);
  assert.equal(existsSync(join(c.root, 'wt second')), false);
});

test('setup: the same run keeps its checkout lock on a relaunch', () => {
  const c = newCase();
  const m = runManifest(c, 'first');
  setupOk(c, m);
  setupOk(c, m);
  const locks = checkoutLocks(c);
  assert.equal(locks.length, 1, JSON.stringify(locks));
  const held = JSON.parse(readFileSync(join(ownActiveDir(c), locks[0]), 'utf8'));
  assert.equal(held.run_id, 'first');
  assert.ok(samePath(held.checkout, c.project), held.checkout);
});

test('setup: a stale checkout lock is taken over', () => {
  const c = newCase();
  setupOk(c, runManifest(c, 'first'));
  // As after a crashed session whose launch lock was then removed by hand.
  rmSync(join(ownActiveDir(c), 'first.lock'));
  setupOk(c, runManifest(c, 'second'));
  assert.equal(git(c.project, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pl-second');
  const locks = checkoutLocks(c);
  assert.equal(locks.length, 1, JSON.stringify(locks));
  assert.equal(JSON.parse(readFileSync(join(ownActiveDir(c), locks[0]), 'utf8')).run_id, 'second');
  assert.deepEqual(readdirSync(ownActiveDir(c)).filter((f) => f.endsWith('.stale')), []);
});

test('setup: an unreadable checkout lock is refused', () => {
  const c = newCase();
  setupOk(c, runManifest(c, 'first'));
  const [lock] = checkoutLocks(c);
  writeFileSync(join(ownActiveDir(c), lock), 'not json');
  const res = setup(c, runManifest(c, 'second'));
  assert.equal(res.code, 4, res.stderr);
  assert.ok(res.stderr.includes(lock), res.stderr);
  assert.equal(git(c.project, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pl-first');
  assert.equal(hasBranch(c.project, 'pl-second'), false);
  assert.equal(readFileSync(join(ownActiveDir(c), lock), 'utf8'), 'not json');
});

test('setup: a checkout lock without a valid run_id is refused', () => {
  const c = newCase();
  setupOk(c, runManifest(c, 'first'));
  const [lock] = checkoutLocks(c);
  writeFileSync(join(ownActiveDir(c), lock), JSON.stringify({ run_id: '../x', checkout: c.project }));
  const res = setup(c, runManifest(c, 'second'));
  assert.equal(res.code, 4, res.stderr);
  assert.match(res.stderr, /malformed/);
  assert.ok(res.stderr.includes(lock), res.stderr);
  assert.equal(git(c.project, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pl-first');
  assert.equal(hasBranch(c.project, 'pl-second'), false);
});

test('setup: runs in separate worktrees of one repo do not block each other', () => {
  const c = newCase();
  const side = join(c.root, 'side checkout');
  git(c.project, 'worktree', 'add', '-q', '-b', 'side', side);
  setupOk(c, runManifest(c, 'first'));
  setupOk(c, runManifest(c, 'second', side));
  assert.equal(git(c.project, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pl-first');
  assert.equal(git(side, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pl-second');
  assert.equal(checkoutLocks(c).length, 2);
});

test('setup: a symlink to a locked checkout is the same checkout', { skip: (IS_WINDOWS || !SYMLINKS) && 'POSIX symlinks only' }, () => {
  const c = newCase();
  setupOk(c, runManifest(c, 'first'));
  const link = join(c.root, 'link to project');
  symlinkSync(c.project, link);
  const res = setup(c, runManifest(c, 'second', link));
  assert.equal(res.code, 4, res.stderr);
  assert.match(res.stderr, /\bfirst\b/);
  assert.equal(git(c.project, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pl-first');
  assert.equal(hasBranch(c.project, 'pl-second'), false);
});

test('setup: a differently cased path to a locked checkout is the same checkout', (t) => {
  const c = newCase();
  const upper = c.project.toUpperCase();
  if (upper === c.project || !existsSync(upper)) {
    t.skip('case-sensitive file system');
    return;
  }
  setupOk(c, runManifest(c, 'first'));
  const res = setup(c, runManifest(c, 'second', upper));
  assert.equal(res.code, 4, res.stderr);
  assert.match(res.stderr, /\bfirst\b/);
  assert.equal(git(c.project, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pl-first');
  assert.equal(hasBranch(c.project, 'pl-second'), false);
});

test('setup: a subdirectory of a locked checkout is the same checkout', () => {
  const c = newCase();
  const sub = join(c.project, 'nested dir');
  mkdirSync(sub);
  setupOk(c, runManifest(c, 'first'));
  const res = setup(c, runManifest(c, 'second', sub));
  assert.equal(res.code, 4, res.stderr);
  assert.match(res.stderr, /\bfirst\b/);
  assert.equal(git(c.project, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pl-first');
  assert.equal(hasBranch(c.project, 'pl-second'), false);
  assert.equal(checkoutLocks(c).length, 1);
});

test('setup: shadow mode takes no checkout lock', () => {
  const c = newCase();
  const project = join(c.root, 'plain', 'my project');
  write(project, 'app.txt', 'app\n');
  const init = sh(BASH, [join(SCRIPTS, 'shadow'), 'init', project], {
    env: { PL_SHADOW_BASE: join(c.root, 'shadow base') },
  });
  assert.equal(init.code, 0, init.stderr);
  const m = manifest(c, {
    repo: {
      mode: 'shadow',
      root: project,
      git_dir: init.stdout.trim(),
      base_ref: 'pl-base',
      branch: 'pl-r1',
      worktree_root: c.worktreeRoot,
      ledger_dir: c.ledgerDir,
    },
  });
  setupOk(c, m);
  assert.deepEqual(checkoutLocks(c), []);
});

// --- spec 4.8: skip the setup commands of lanes with no pending work ----------

// The run_started entries setup appended to the case's ledger.
function runStarted(c) {
  return readFileSync(join(c.ledgerDir, '_run.jsonl'), 'utf8').trim().split('\n')
    .map((l) => JSON.parse(l)).filter((e) => e.event === 'run_started');
}

test('setup: a lane with every task done and reviewed skips its setup and is listed', () => {
  const c = newCase();
  const m = manifest(c, {
    lanes: [
      { id: 'a', name: 'Lane A', tasks: [{ id: 'a1' }, { id: 'a2' }] },
      { id: 'b', name: 'Lane B', tasks: [{ id: 'b1' }] },
      { id: 'c', name: 'Lane C', tasks: [{ id: 'c1' }] },
    ],
    done: ['c1', 'a2', 'a1'],
    reviewed: ['a1', 'c1', 'a2'],
  });
  const result = setupOk(c, m);
  // Listed in manifest order; only lane b's setup ran, after the feature's.
  assert.deepEqual(result.setup_skipped, ['a', 'c']);
  assertSamePaths(logLines(c), [c.project, laneDir(c, 'b'), 'b-override']);
  // The skipped lanes' worktrees still exist on their branches.
  assertSamePaths(result.worktrees, { a: laneDir(c, 'a'), b: laneDir(c, 'b'), c: laneDir(c, 'c') });
  assert.equal(git(laneDir(c, 'a'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'pl-r1-a');
  assert.equal(git(laneDir(c, 'c'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'pl-r1-c');
  const [entry] = runStarted(c);
  assert.deepEqual(entry.setup_skipped, ['a', 'c']);
});

test('setup: a lane without setup commands is never listed', () => {
  const c = newCase();
  const m = manifest(c, {
    lane_commands: { b: { setup: [] } },
    done: ['a1', 'b1'],
    reviewed: ['a1', 'b1'],
  });
  const result = setupOk(c, m);
  assert.deepEqual(result.setup_skipped, ['a']);
  assertSamePaths(logLines(c), [c.project]);
  assert.deepEqual(runStarted(c)[0].setup_skipped, ['a']);
});

test("setup: a done but unreviewed task keeps the lane's setup", () => {
  const c = newCase();
  const m = manifest(c, {
    lanes: [
      { id: 'a', name: 'Lane A', tasks: [{ id: 'a1' }, { id: 'a2' }] },
      { id: 'b', name: 'Lane B', tasks: [{ id: 'b1' }] },
    ],
    // a2 is done but unreviewed; b1 is reviewed but not done (a reopened task).
    done: ['a1', 'a2'],
    reviewed: ['a1', 'b1'],
  });
  const result = setupOk(c, m);
  assert.deepEqual(result.setup_skipped, []);
  assertSamePaths(logLines(c), [c.project, laneDir(c, 'a'), laneDir(c, 'b'), 'b-override']);
  assert.deepEqual(runStarted(c)[0].setup_skipped, []);
});

test('setup: the feature setup always runs', () => {
  const c = newCase();
  const m = manifest(c, { done: ['a1', 'b1'], reviewed: ['a1', 'b1'] });
  const result = setupOk(c, m);
  assert.deepEqual(result.setup_skipped, ['a', 'b']);
  assertSamePaths(logLines(c), [c.project]);
  assertSamePaths(result.worktrees, { a: laneDir(c, 'a'), b: laneDir(c, 'b') });
});

test('setup: a lite run is unchanged', () => {
  const c = newCase();
  const m = manifest(c, {
    profile: 'lite',
    lanes: [{ id: 'b', name: 'Lane B', tasks: [{ id: 'b1' }] }],
    done: ['b1'],
    reviewed: ['b1'],
  });
  const result = setupOk(c, m);
  assert.deepEqual(result.setup_skipped, []);
  assertSamePaths(result.worktrees, { b: c.project });
  // As without done and reviewed: the feature setup and the lane's own list.
  assertSamePaths(logLines(c), [c.project, c.project, 'b-override']);
  assert.deepEqual(runStarted(c)[0].setup_skipped, []);
});

test('setup: setup and the engine agree on pending', async () => {
  const { hasWork } = await loadHelpers(['hasWork']);
  const c = newCase();
  const lane = (id, tasks) => ({ id, name: `Lane ${id}`, tasks: tasks.map((t) => ({ id: t })) });
  const m = manifest(c, {
    lanes: [
      lane('all', ['t1', 't2']), // every task done and reviewed
      lane('unreviewed', ['t3', 't4']), // t4 done, not reviewed
      lane('reopened', ['t5']), // reviewed, not done
      lane('fresh', ['t6']), // neither
      lane('empty', []), // no tasks at all
      lane('nosetup', ['t7']), // done and reviewed, no setup commands
      lane('override', ['t8']), // done and reviewed, its own setup
    ],
    lane_commands: {
      nosetup: { setup: [] },
      override: { setup: [`echo override >> ${q(c.log)}`] },
    },
    done: ['t1', 't2', 't3', 't4', 't7', 't8'],
    reviewed: ['t1', 't2', 't3', 't5', 't7', 't8'],
  });
  const setupList = (id) => {
    const own = (m.lane_commands || {})[id];
    return own && 'setup' in own ? own.setup : m.commands.setup;
  };
  const expected = m.lanes.filter((l) => !hasWork(m, l.tasks) && setupList(l.id).length > 0).map((l) => l.id);
  assert.deepEqual(expected, ['all', 'empty', 'override'], 'the fixture covers both outcomes');
  const result = setupOk(c, m);
  assert.deepEqual(result.setup_skipped, expected);
});

// ---- 1.6.5: a lane worktree left on a join unit branch ----

// Leaves lane a's worktree on unit branch pl-r1-u-J1 with one commit and an
// uncommitted change; returns the unit commit.
function leaveOnUnitBranch(c) {
  const wt = laneDir(c, 'a');
  git(wt, 'checkout', '-q', '-b', 'pl-r1-u-J1');
  write(wt, 'unit.txt', 'unit work\n');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', 'unit work');
  const head = git(wt, 'rev-parse', 'HEAD');
  write(wt, 'wip.txt', 'in progress\n');
  return head;
}

test('a worktree on a unit branch is returned to its lane branch', () => {
  const c = newCase();
  const m = manifest(c);
  setupOk(c, m);
  const unitHead = leaveOnUnitBranch(c);
  const res = setup(c, m);
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  const wt = laneDir(c, 'a');
  assert.equal(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pl-r1-a');
  assert.equal(git(c.project, 'rev-parse', 'pl-r1-u-J1'), unitHead, 'the unit branch keeps its commit');
  assert.equal(out.returned.length, 1);
  assert.ok(samePath(out.returned[0].worktree, wt), out.returned[0].worktree);
  assert.equal(out.returned[0].from, 'pl-r1-u-J1');
  const saved = out.preserved.find((p) => samePath(p.worktree, wt));
  assert.ok(saved, JSON.stringify(out.preserved));
  assert.equal(git(c.project, 'show', `${saved.ref}:wip.txt`), 'in progress');
  assert.equal(git(wt, 'status', '--porcelain'), '');
});

test('unit-branch worktree found in any path form', () => {
  const c = newCase();
  const m = manifest(c);
  setupOk(c, m);
  leaveOnUnitBranch(c);
  const other = manifest(c, { repo: { ...m.repo, worktree_root: c.worktreeRoot.replace(/\\/g, '/') } });
  const res = setup(c, other);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).returned.length, 1);
  assert.equal(git(laneDir(c, 'a'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'pl-r1-a');
});

test('a lane worktree with nothing on a unit branch reports no return', () => {
  const c = newCase();
  const m = manifest(c);
  setupOk(c, m);
  const res = setup(c, m);
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout).returned, []);
});

test('a detached or foreign-branch lane worktree is still refused', () => {
  for (const move of [(wt) => git(wt, 'checkout', '-q', '--detach'), (wt) => git(wt, 'checkout', '-q', '-b', 'other')]) {
    const c = newCase();
    const m = manifest(c);
    setupOk(c, m);
    move(laneDir(c, 'a'));
    const res = setup(c, m);
    assert.equal(res.code, 3, res.stderr);
    assert.match(res.stderr, /is not a worktree of this repo on pl-r1-a/);
  }
});

test('another run\'s unit branch is refused', () => {
  const c = newCase();
  const m = manifest(c);
  setupOk(c, m);
  git(laneDir(c, 'a'), 'checkout', '-q', '-b', 'pl-r2-u-J1');
  assert.equal(setup(c, m).code, 3);
});
