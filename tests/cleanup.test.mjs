// scripts/cleanup: the plan of what a cleanup would do, its preconditions
// (the run is archived, no active-run marker), and the restore point it
// writes before it removes anything. Each case is a temp repo set up like a
// finished git-mode run, with a run folder and an index.json written with
// _history.write_index.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { BASH, mergeEnv, samePath, tempDir } from './platform.mjs';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const CLEANUP = join(SCRIPTS, 'cleanup');
const TMP = realpathSync(tempDir('pl-cleanup-'));
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

function sh(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', env: mergeEnv(process.env, GIT_ENV, opts.env), cwd: opts.cwd });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

function git(dir, ...args) {
  const res = sh('git', ['-C', dir, ...args]);
  assert.equal(res.code, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.replace(/\r\n/g, '\n').trim();
}

function commitFile(dir, name, content) {
  writeFileSync(join(dir, name), content);
  git(dir, 'add', name);
  git(dir, 'commit', '-q', '-m', `add ${name}`);
}

let counter = 0;
// A finished git-mode run 'r1': a project with a local bare origin, the
// feature branch feature/x checked out in the main checkout with both lanes
// merged into it, lane worktrees for a and b under the worktree root, and an
// abandoned ref. The run folder exists, and index.json lists the run unless
// archived is false. Every case has its own active-run marker dir.
function newCase({ archived = true } = {}) {
  counter += 1;
  const root = join(TMP, `case ${counter}`);
  const project = join(root, 'my project');
  const origin = join(root, 'origin.git');
  const worktreeRoot = join(root, 'wt root');
  const ledgerDir = join(root, 'ledger dir');
  const history = join(root, 'history');
  const active = join(root, 'active');
  mkdirSync(project, { recursive: true });
  mkdirSync(ledgerDir, { recursive: true });
  git(project, 'init', '-q', '-b', 'main');
  commitFile(project, 'README.md', 'hello\n');
  git(root, 'init', '-q', '--bare', origin);
  git(project, 'remote', 'add', 'origin', origin);
  git(project, 'push', '-q', '-u', 'origin', 'main');
  git(project, 'switch', '-q', '-c', 'feature/x');
  const lanes = {};
  for (const id of ['a', 'b']) {
    const dir = join(worktreeRoot, `lane-${id}`);
    git(project, 'worktree', 'add', '-q', '-b', `pl-r1-${id}`, dir, 'feature/x');
    commitFile(dir, `${id}.txt`, `lane ${id}\n`);
    lanes[id] = dir;
  }
  for (const id of ['a', 'b']) git(project, 'merge', '-q', '--no-ff', '-m', `merge ${id}`, `pl-r1-${id}`);
  const abandoned = git(project, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'abandoned work');
  git(project, 'update-ref', 'refs/parallel-lanes/r1/abandoned/x', abandoned);

  const m = {
    version: 1,
    run_id: 'r1',
    repo: {
      mode: 'git',
      root: project,
      git_dir: null,
      base_ref: 'main',
      branch: 'feature/x',
      worktree_root: worktreeRoot,
      ledger_dir: ledgerDir,
    },
    commands: { setup: [], test: [], lint: [], build: [] },
    lanes: [
      { id: 'a', name: 'Lane A', tasks: [] },
      { id: 'b', name: 'Lane B', tasks: [] },
    ],
  };
  const manifest = join(root, 'manifest.json');
  writeFileSync(manifest, JSON.stringify(m, null, 2));
  const folder = '2026-10-10-r1';
  const runFolder = join(history, folder);
  mkdirSync(runFolder, { recursive: true });
  writeIndex(history, manifest, archived ? folder : null);
  return { root, project, origin, worktreeRoot, history, active, manifest, runFolder, lanes, abandoned };
}

// index.json in history: one entry for the manifest's run (keyed with
// _history.run_key) in folder, or no entry when folder is null.
function writeIndex(history, manifest, folder) {
  const code = [
    'import json, sys',
    'sys.dont_write_bytecode = True',
    `sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`,
    'import _history',
    'with open(sys.argv[1], encoding="utf-8") as f:',
    '    m = json.load(f)',
    'runs = []',
    'if sys.argv[3]:',
    '    run_id, ledger_dir = _history.run_key(m)',
    '    runs.append({"run_id": run_id, "folder": sys.argv[3], "ledger_dir": ledger_dir,',
    '                 "project": m["repo"]["root"], "plan": None, "engine_version": "1.5.0",',
    '                 "machine": "m", "platform": sys.platform,',
    '                 "first_launch": "2026-10-10T10:00:00Z", "last_launch": "2026-10-10T10:00:00Z",',
    '                 "launches": 1, "status": "done", "acceptance": None})',
    '_history.write_index(sys.argv[2], {"version": 1, "runs": runs})',
  ].join('\n');
  const res = spawnSync('python3', ['-c', code, manifest, history, folder || ''], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
}

function cleanup(c, extra = [], env = {}) {
  return sh('python3', [CLEANUP, c.manifest, '--json', '--history-dir', c.history, ...extra],
    { env: { PL_ACTIVE_DIR: c.active, ...env } });
}

function cleanupOk(c, extra = [], env = {}) {
  const res = cleanup(c, extra, env);
  assert.equal(res.code, 0, res.stderr);
  return JSON.parse(res.stdout);
}

// Every file and directory under dir, with each file's sha256.
function snapshot(dir) {
  const out = {};
  const walk = (d, rel) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(p).isDirectory()) {
        out[r] = 'dir';
        walk(p, r);
      } else {
        out[r] = createHash('sha256').update(readFileSync(p)).digest('hex');
      }
    }
  };
  walk(dir, '');
  return out;
}

function refs(c) {
  return git(c.project, 'for-each-ref', '--format=%(refname) %(objectname)');
}

function state(c) {
  return { refs: refs(c), worktrees: git(c.project, 'worktree', 'list', '--porcelain'), files: snapshot(c.root) };
}

const sha = (c, ref) => git(c.project, 'rev-parse', ref);

test('cleanup: without --yes nothing changes and the plan names each run-owned item', () => {
  const c = newCase();
  const before = state(c);
  const plan = cleanupOk(c);
  assert.deepEqual(state(c), before);

  assert.equal(plan.run_id, 'r1');
  assert.equal(plan.restore_point, null);
  assert.ok(samePath(plan.run_folder, c.runFolder), plan.run_folder);
  assert.equal(plan.worktrees.length, 2, JSON.stringify(plan.worktrees));
  for (const id of ['a', 'b']) {
    const wt = plan.worktrees.find((w) => samePath(w.path, c.lanes[id]));
    assert.ok(wt, `lane ${id} worktree is in the plan: ${JSON.stringify(plan.worktrees)}`);
    assert.equal(wt.branch, `pl-r1-${id}`);
    assert.equal(wt.action, 'remove');
    assert.ok(wt.reason);
  }
  const branches = Object.fromEntries(plan.branches.map((b) => [b.branch, b]));
  assert.deepEqual(Object.keys(branches).sort(), ['feature/x', 'pl-r1-a', 'pl-r1-b']);
  for (const b of Object.values(branches)) {
    assert.ok(['remove', 'keep'].includes(b.action), JSON.stringify(b));
    assert.ok(b.reason, JSON.stringify(b));
  }
  assert.equal(branches['pl-r1-a'].action, 'remove');
  assert.equal(branches['pl-r1-a'].sha, sha(c, 'pl-r1-a'));
  assert.ok(plan.feature_steps.some((s) => s.includes('git branch -d')), JSON.stringify(plan.feature_steps));
  assert.deepEqual(plan.refs.map((r) => r.ref), ['refs/parallel-lanes/r1/abandoned/x']);
  assert.equal(plan.refs[0].action, 'keep');
  assert.deepEqual(plan.foreign, []);

  // The text form names the same items, and also changes nothing.
  const text = sh('python3', [CLEANUP, c.manifest, '--history-dir', c.history], { env: { PL_ACTIVE_DIR: c.active } });
  assert.equal(text.code, 0, text.stderr);
  for (const name of ['lane-a', 'lane-b', 'pl-r1-a', 'pl-r1-b', 'feature/x']) assert.match(text.stdout, new RegExp(name));
  assert.deepEqual(state(c), before);
});

test('cleanup: the plan names what under the worktree root the run does not own', () => {
  const c = newCase();
  mkdirSync(join(c.worktreeRoot, 'notes'));
  const plan = cleanupOk(c);
  assert.equal(plan.foreign.length, 1, JSON.stringify(plan.foreign));
  assert.ok(samePath(plan.foreign[0].path, join(c.worktreeRoot, 'notes')));
  assert.equal(plan.foreign[0].reason, 'not owned by this run');
});

test('cleanup: refuses a run that is not archived', () => {
  const c = newCase({ archived: false });
  const before = state(c);
  const res = cleanup(c, ['--yes']);
  assert.equal(res.code, 3, res.stderr);
  assert.match(res.stderr, /not archived/);
  assert.deepEqual(state(c), before);
});

test('cleanup: refuses a run with an active marker', () => {
  const c = newCase();
  const marked = sh(BASH, [join(SCRIPTS, 'active-run'), 'write', 'r1', c.manifest, 'stopped'],
    { env: { PL_ACTIVE_DIR: c.active } });
  assert.equal(marked.code, 0, marked.stderr);
  const before = state(c);
  const res = cleanup(c, ['--yes']);
  assert.equal(res.code, 3, res.stderr);
  assert.match(res.stderr, /active-run marker/);
  assert.deepEqual(state(c), before);
});

test('cleanup: an unreadable manifest or index is exit 2', () => {
  const c = newCase();
  writeFileSync(join(c.history, 'index.json'), '{not json');
  assert.equal(cleanup(c).code, 2);
  const broken = join(c.root, 'broken.json');
  writeFileSync(broken, '[]');
  const res = sh('python3', [CLEANUP, broken, '--history-dir', c.history], { env: { PL_ACTIVE_DIR: c.active } });
  assert.equal(res.code, 2, res.stderr);
});

// The restore point's folder from the --yes output, checked to lie in the
// run folder's cleanup folder.
function restorePoint(c, out) {
  assert.ok(out.restore_point, JSON.stringify(out));
  assert.ok(samePath(join(out.restore_point, '..'), join(c.runFolder, 'cleanup')), out.restore_point);
  return out.restore_point;
}

test('cleanup: --yes writes a verified restore point first', () => {
  const c = newCase();
  const dir = restorePoint(c, cleanupOk(c, ['--yes']));
  const saved = JSON.parse(readFileSync(join(dir, 'refs.json'), 'utf8'));
  assert.deepEqual(saved, {
    'refs/heads/feature/x': sha(c, 'feature/x'),
    'refs/heads/pl-r1-a': sha(c, 'pl-r1-a'),
    'refs/heads/pl-r1-b': sha(c, 'pl-r1-b'),
    'refs/parallel-lanes/r1/abandoned/x': c.abandoned,
  });
  const verify = sh('git', ['-C', c.project, 'bundle', 'verify', join(dir, 'run.bundle')]);
  assert.equal(verify.code, 0, verify.stderr);
  const restore = readFileSync(join(dir, 'restore.md'), 'utf8');
  const fetches = restore.split('\n').filter((l) => /^git .* fetch /.test(l));
  assert.equal(fetches.length, 4, restore);
  for (const ref of Object.keys(saved)) {
    assert.ok(fetches.some((l) => l.includes(`${ref}:${ref}`)), `${ref} has a fetch line: ${restore}`);
  }
  for (const id of ['a', 'b']) {
    assert.ok(restore.split('\n').some((l) => /^git .* worktree add /.test(l) && l.includes(`lane-${id}`)), restore);
  }
});

test('cleanup: the bundle restores a deleted branch', () => {
  const c = newCase();
  const dir = restorePoint(c, cleanupOk(c, ['--yes']));
  const want = sha(c, 'pl-r1-a');
  // git will not delete a branch a worktree has checked out.
  git(c.project, 'worktree', 'remove', c.lanes.a);
  git(c.project, 'branch', '-D', 'pl-r1-a');
  assert.notEqual(sh('git', ['-C', c.project, 'rev-parse', '--verify', '--quiet', 'refs/heads/pl-r1-a']).code, 0);
  const line = readFileSync(join(dir, 'restore.md'), 'utf8').split('\n')
    .find((l) => /^git .* fetch /.test(l) && l.includes('refs/heads/pl-r1-a:refs/heads/pl-r1-a'));
  assert.ok(line);
  const res = sh(BASH, ['-c', line], { cwd: c.root });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(sha(c, 'refs/heads/pl-r1-a'), want);
});

test('cleanup: two cleanups in the same second keep both restore points', () => {
  const c = newCase();
  const env = { PL_CLEANUP_STAMP: '20261010T120000Z' };
  const first = restorePoint(c, cleanupOk(c, ['--yes'], env));
  assert.equal(first.split(/[\\/]/).pop(), '20261010T120000Z');
  const kept = snapshot(first);
  // A change between the two cleanups, so the second restore point differs.
  commitFile(c.project, 'later.txt', 'later\n');
  const second = restorePoint(c, cleanupOk(c, ['--yes'], env));
  assert.equal(second.split(/[\\/]/).pop(), '20261010T120000Z-2');
  assert.deepEqual(snapshot(first), kept);
  assert.deepEqual(readdirSync(join(c.runFolder, 'cleanup')).sort(), ['20261010T120000Z', '20261010T120000Z-2']);
  const saved = JSON.parse(readFileSync(join(second, 'refs.json'), 'utf8'));
  assert.equal(saved['refs/heads/feature/x'], sha(c, 'feature/x'));
  assert.ok(existsSync(join(second, 'run.bundle')));
});
