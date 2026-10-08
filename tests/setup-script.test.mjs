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
  existsSync,
  realpathSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'pl-setup-')));
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
    env: { ...process.env, ...GIT_ENV, ...(opts.env || {}) },
    cwd: opts.cwd,
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

function git(dir, ...args) {
  const res = sh('git', ['-C', dir, ...args]);
  assert.equal(res.code, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
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
// a log every setup command appends its working directory to.
function newCase() {
  counter += 1;
  const root = join(TMP, `case ${counter}`);
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
    lanes: [
      { id: 'a', name: 'Lane A', tasks: [] },
      { id: 'b', name: 'Lane B', tasks: [] },
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
      const got = sh('bash', [join(SCRIPTS, 'active-run'), 'acquire', m.run_id, path], { env });
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
  const result = setupOk(c, manifest(c));

  assert.deepEqual(result, {
    feature_head: base,
    worktrees: { a: laneDir(c, 'a'), b: laneDir(c, 'b') },
    discarded: [],
    preserved: [],
  });
  assert.equal(git(c.project, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/x');
  assert.equal(git(laneDir(c, 'a'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'pl-r1-a');
  assert.equal(git(laneDir(c, 'b'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'pl-r1-b');
  assert.equal(git(laneDir(c, 'a'), 'rev-parse', 'HEAD'), base);
  // Setup commands ran in the feature checkout and in each lane worktree,
  // lane b with its override.
  assert.deepEqual(logLines(c), [
    c.project,
    laneDir(c, 'a'),
    laneDir(c, 'b'),
    'b-override',
  ]);
  assert.equal(git(c.project, 'status', '--porcelain'), '');
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
  assert.deepEqual(result.worktrees, { a: laneDir(c, 'a'), b: laneDir(c, 'b') });
  assert.deepEqual(result.discarded.sort(), [
    `${laneDir(c, 'a')}:  M README.md`,
    `${laneDir(c, 'a')}: ?? "new file.txt"`,
  ]);
  assert.equal(readFileSync(join(laneDir(c, 'a'), 'README.md'), 'utf8'), 'hello\n');
  assert.equal(existsSync(join(laneDir(c, 'a'), 'new file.txt')), false);
  assert.equal(readFileSync(join(laneDir(c, 'a'), 'scratch/keep.txt'), 'utf8'), 'ignored\n');
  assert.equal(git(laneDir(c, 'b'), 'rev-parse', 'HEAD'), laneHead);
  assert.equal(git(c.project, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/x');
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
  assert.deepEqual(result.worktrees, { b: c.project });
  assert.equal(existsSync(laneDir(c, 'b')), false);
  assert.equal(sh('git', ['-C', c.project, 'show-ref', '--verify', '--quiet', 'refs/heads/pl-r1-b']).code, 1);
  assert.equal(git(c.project, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/x');
  // The feature setup and the lane's own setup both run in the feature checkout.
  assert.deepEqual(logLines(c), [c.project, c.project, 'b-override']);
});

test('setup: lite runs an identical lane setup only once', () => {
  const c = newCase();
  const m = manifest(c, {
    profile: 'lite',
    lanes: [{ id: 'a', name: 'Lane A', tasks: [] }],
  });
  setupOk(c, m);
  assert.deepEqual(logLines(c), [c.project]);
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
  const init = sh('bash', [join(SCRIPTS, 'shadow'), 'init', project], {
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
  const result = setupOk(c, m);
  assert.deepEqual(result, {
    feature_head: baseline,
    worktrees: { a: laneDir(c, 'a'), b: laneDir(c, 'b') },
    discarded: [],
    preserved: [],
  });
  assert.equal(git(feature, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pl-r1');
  assert.equal(git(laneDir(c, 'a'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'pl-r1-a');
  assert.equal(readFileSync(join(feature, 'app.txt'), 'utf8'), 'app\n');
  assert.deepEqual(readdirSync(project), ['app.txt']);
  assert.deepEqual(logLines(c), [feature, laneDir(c, 'a'), laneDir(c, 'b'), 'b-override']);

  // A rerun discards and lists edits in the feature worktree.
  write(feature, 'app.txt', 'edited\n');
  const again = setupOk(c, m);
  assert.deepEqual(again.discarded, [`${feature}:  M app.txt`]);
  assert.equal(readFileSync(join(feature, 'app.txt'), 'utf8'), 'app\n');
  assert.deepEqual(readdirSync(project), ['app.txt']);
});

test('setup: shadow lite maps the lane to the feature worktree', () => {
  const c = newCase();
  const project = join(c.root, 'plain', 'my project');
  write(project, 'app.txt', 'app\n');
  const init = sh('bash', [join(SCRIPTS, 'shadow'), 'init', project], {
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
  assert.deepEqual(result.worktrees, { a: `${c.worktreeRoot}/feature` });
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

test('setup: a symlink at a lane path exits 3, even one to an empty directory', () => {
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
  assert.ok(list.includes(`worktree ${own}`), "the user's missing worktree keeps its record");
  assert.ok(existsSync(join(laneDir(c, 'a'), 'README.md')), 'the lane worktree is recreated');
});

// --- review finding 7: overlapping launches and abandoned work ----------------

const activeRun = (env, ...args) => sh('bash', [join(SCRIPTS, 'active-run'), ...args], { env });

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
  assert.equal(saved.worktree, laneDir(c, 'a'));
  assert.match(saved.ref, /^refs\/parallel-lanes\/r1\/abandoned\/lane-a-\d{8}T\d+Z$/);
  assert.equal(git(c.project, 'rev-parse', saved.ref), saved.commit);
  assert.equal(git(c.project, 'rev-parse', `${saved.commit}^`), laneHead);
  assert.equal(git(c.project, 'show', `${saved.commit}:README.md`), 'edited');
  assert.equal(git(c.project, 'show', `${saved.commit}:new file.txt`), 'untracked');
  assert.equal(sh('git', ['-C', c.project, 'cat-file', '-e', `${saved.commit}:scratch/keep.txt`]).code === 0, false);
  // The worktree itself was discarded, ignored scratch kept.
  assert.equal(git(laneDir(c, 'a'), 'status', '--porcelain'), '');
  assert.equal(readFileSync(join(laneDir(c, 'a'), 'scratch', 'keep.txt'), 'utf8'), 'ignored\n');
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
  assert.equal(activeRun(env, 'release', 'r1', 'stopped').code, 0);
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
