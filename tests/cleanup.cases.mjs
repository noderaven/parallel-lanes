// scripts/cleanup: the plan of what a cleanup would do, its preconditions
// (the run is archived, no active-run marker), and the restore point it
// writes before it removes anything. Each case is a temp repo set up like a
// finished git-mode run, with a run folder and an index.json written with
// _history.write_index.

import { after } from 'node:test';
import { test } from './shard.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { BASH, IS_WINDOWS, mergeEnv, samePath, tempDir } from './platform.mjs';

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
  return { root, project, origin, worktreeRoot, ledgerDir, history, active, manifest, runFolder, lanes, abandoned };
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
  // The lane branches are deleted by the cleanup, so take their shas first.
  const want = {
    'refs/heads/feature/x': sha(c, 'feature/x'),
    'refs/heads/pl-r1-a': sha(c, 'pl-r1-a'),
    'refs/heads/pl-r1-b': sha(c, 'pl-r1-b'),
    'refs/parallel-lanes/r1/abandoned/x': c.abandoned,
  };
  const dir = restorePoint(c, cleanupOk(c, ['--yes']));
  const saved = JSON.parse(readFileSync(join(dir, 'refs.json'), 'utf8'));
  assert.deepEqual(saved, want);
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
  const want = sha(c, 'pl-r1-a');
  // The cleanup itself removes the lane's worktree and deletes its branch.
  const dir = restorePoint(c, cleanupOk(c, ['--yes']));
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

// The removal steps of cleanup --yes.

const hasRef = (dir, ref) => sh('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', ref]).code === 0;
const worktreePaths = (dir) => git(dir, 'worktree', 'list', '--porcelain').split('\n')
  .filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length));
const hasWorktree = (dir, path) => worktreePaths(dir).some((p) => samePath(p, path));
const findItem = (list, kind, pred) => list.find((i) => i.kind === kind && pred(i));
const currentBranch = (c) => git(c.project, 'symbolic-ref', '--short', 'HEAD');

// Merge the feature branch into origin's main from another clone, the way a
// merged pull request does; return origin's new main.
function mergeIntoOrigin(c) {
  const clone = join(c.root, 'other clone');
  git(c.root, 'clone', '-q', '-b', 'main', c.origin, clone);
  commitFile(clone, 'upstream.txt', 'someone else\n');
  git(clone, 'fetch', '-q', c.project, 'feature/x');
  git(clone, 'merge', '-q', '--no-ff', '-m', 'merge pull request', 'FETCH_HEAD');
  git(clone, 'push', '-q', 'origin', 'main');
  return git(clone, 'rev-parse', 'HEAD');
}

test('cleanup: removes clean run-owned worktrees and merged lane branches', () => {
  const c = newCase();
  const want = { a: sha(c, 'pl-r1-a'), b: sha(c, 'pl-r1-b') };
  const out = cleanupOk(c, ['--yes']);
  const dir = restorePoint(c, out);
  const saved = JSON.parse(readFileSync(join(dir, 'refs.json'), 'utf8'));
  assert.ok(existsSync(join(dir, 'run.bundle')));
  assert.ok(existsSync(join(dir, 'restore.md')));
  for (const id of ['a', 'b']) {
    assert.equal(saved[`refs/heads/pl-r1-${id}`], want[id]);
    assert.ok(!existsSync(c.lanes[id]), `lane-${id} is gone`);
    assert.ok(!hasWorktree(c.project, c.lanes[id]), `lane-${id} is not a worktree any more`);
    assert.ok(!hasRef(c.project, `refs/heads/pl-r1-${id}`), `pl-r1-${id} is deleted`);
    assert.ok(findItem(out.removed, 'worktree', (i) => samePath(i.path, c.lanes[id])), JSON.stringify(out.removed));
    assert.ok(findItem(out.removed, 'branch', (i) => i.branch === `pl-r1-${id}`), JSON.stringify(out.removed));
  }
  // The worktree root held only the run's worktrees, so it is removed too.
  assert.ok(!existsSync(c.worktreeRoot));
  assert.ok(findItem(out.removed, 'worktree_root', (i) => samePath(i.path, c.worktreeRoot)), JSON.stringify(out.removed));
  for (const item of [...out.removed, ...out.kept]) assert.ok(item.reason, JSON.stringify(item));
});

test('cleanup: never removes what the run does not own', () => {
  const c = newCase();
  git(c.project, 'branch', 'topic', 'main');
  const other = join(c.worktreeRoot, 'other');
  git(c.project, 'worktree', 'add', '-q', other, 'topic');
  git(c.lanes.b, 'switch', '-q', '-c', 'swapped');
  const out = cleanupOk(c, ['--yes']);
  restorePoint(c, out);
  for (const path of [other, c.lanes.b]) {
    assert.ok(existsSync(path), `${path} is still there`);
    assert.ok(hasWorktree(c.project, path), `${path} is still a worktree`);
    const kept = out.kept.find((i) => i.path && samePath(i.path, path));
    assert.ok(kept, `${path} is listed as kept: ${JSON.stringify(out.kept)}`);
    assert.equal(kept.reason, 'not owned by this run');
    assert.ok(!out.removed.some((i) => i.path && samePath(i.path, path)), JSON.stringify(out.removed));
  }
  assert.ok(hasRef(c.project, 'refs/heads/topic'));
  assert.ok(hasRef(c.project, 'refs/heads/swapped'));
  assert.equal(git(other, 'symbolic-ref', '--short', 'HEAD'), 'topic');
  assert.equal(git(c.lanes.b, 'symbolic-ref', '--short', 'HEAD'), 'swapped');
  // The run-owned lane-a still goes, and the root stays because it is not empty.
  assert.ok(!existsSync(c.lanes.a));
  assert.ok(existsSync(c.worktreeRoot));
  assert.ok(findItem(out.kept, 'worktree_root', (i) => samePath(i.path, c.worktreeRoot)), JSON.stringify(out.kept));
});

test('cleanup: keeps a dirty worktree and names it', () => {
  const c = newCase();
  writeFileSync(join(c.lanes.a, 'scratch.txt'), 'not committed\n');
  const res = sh('python3', [CLEANUP, c.manifest, '--yes', '--history-dir', c.history], { env: { PL_ACTIVE_DIR: c.active } });
  assert.equal(res.code, 0, res.stderr);
  assert.ok(existsSync(join(c.lanes.a, 'scratch.txt')));
  assert.ok(hasWorktree(c.project, c.lanes.a));
  assert.ok(hasRef(c.project, 'refs/heads/pl-r1-a'));
  assert.ok(!existsSync(c.lanes.b));
  assert.ok(!hasRef(c.project, 'refs/heads/pl-r1-b'));
  const line = res.stdout.split('\n').find((l) => l.includes('lane-a') && l.includes('uncommitted or untracked'));
  assert.ok(line, res.stdout);
  assert.match(res.stdout, /pl-r1-a.*kept worktree/, res.stdout);
  assert.match(res.stdout, /restore point: /);
});

// A case whose project hides untracked files from a plain git status.
function hidingCase() {
  const c = newCase();
  git(c.project, 'config', 'status.showUntrackedFiles', 'no');
  return c;
}

const planned = (plan, path) => {
  const wt = plan.worktrees.find((w) => samePath(w.path, path));
  assert.ok(wt, JSON.stringify(plan.worktrees));
  return wt;
};

test('cleanup: an untracked file hidden by status.showUntrackedFiles=no keeps its worktree', () => {
  const c = hidingCase();
  const draft = join(c.lanes.a, 'private-draft.txt');
  writeFileSync(draft, 'not committed\n');
  const wt = planned(cleanupOk(c), c.lanes.a);
  assert.equal(wt.action, 'keep');
  assert.equal(wt.reason, 'it has uncommitted or untracked changes');
  const out = cleanupOk(c, ['--yes']);
  assert.ok(existsSync(draft));
  assert.ok(hasWorktree(c.project, c.lanes.a));
  assert.ok(hasRef(c.project, 'refs/heads/pl-r1-a'));
  assert.ok(findItem(out.kept, 'worktree', (i) => samePath(i.path, c.lanes.a)), JSON.stringify(out.kept));
});

test('cleanup: a hidden untracked file in the main checkout keeps the feature branch', () => {
  const c = hidingCase();
  mergeIntoOrigin(c);
  const notes = join(c.project, 'private-notes.txt');
  writeFileSync(notes, 'not committed\n');
  assert.match(featureKept(c), /uncommitted or untracked/);
  assert.ok(existsSync(notes));
});

test('cleanup: a failed git status keeps the worktree', () => {
  const c = hidingCase();
  writeFileSync(join(c.project, '.git', 'worktrees', 'lane-a', 'index'), 'garbage');
  const wt = planned(cleanupOk(c), c.lanes.a);
  assert.equal(wt.action, 'keep');
  assert.match(wt.reason, /^git status failed/);
  const out = cleanupOk(c, ['--yes']);
  assert.ok(existsSync(c.lanes.a));
  assert.ok(hasWorktree(c.project, c.lanes.a));
  const kept = findItem(out.kept, 'worktree', (i) => samePath(i.path, c.lanes.a));
  assert.ok(kept, JSON.stringify(out.kept));
  assert.match(kept.reason, /^git status failed/);
});

test('cleanup: a failed git status on the main checkout keeps the feature branch', () => {
  const c = hidingCase();
  mergeIntoOrigin(c);
  writeFileSync(join(c.project, '.git', 'index'), 'garbage');
  assert.match(featureKept(c), /^git status failed on the main checkout/);
});

test('cleanup: an ignored file does not block removal', () => {
  const c = hidingCase();
  commitFile(c.lanes.a, '.gitignore', '*.log\n');
  writeFileSync(join(c.lanes.a, 'a.log'), 'ignored\n');
  assert.equal(planned(cleanupOk(c), c.lanes.a).action, 'remove');
  const out = cleanupOk(c, ['--yes']);
  assert.ok(!existsSync(c.lanes.a));
  assert.ok(!hasWorktree(c.project, c.lanes.a));
  assert.ok(findItem(out.removed, 'worktree', (i) => samePath(i.path, c.lanes.a)), JSON.stringify(out.removed));
});

test('cleanup: before the PR merges the checkout stays on the feature branch', () => {
  const c = newCase();
  const tip = sha(c, 'feature/x');
  const out = cleanupOk(c, ['--yes']);
  assert.equal(currentBranch(c), 'feature/x');
  assert.equal(sha(c, 'feature/x'), tip);
  assert.equal(sha(c, 'main'), git(c.origin, 'rev-parse', 'main'));
  const kept = findItem(out.kept, 'branch', (i) => i.branch === 'feature/x');
  assert.ok(kept, JSON.stringify(out.kept));
  assert.match(kept.reason, /not merged/);
});

test('cleanup: after the merge it switches to the base, fast-forwards and deletes the feature branch', () => {
  const c = newCase();
  const tip = mergeIntoOrigin(c);
  const out = cleanupOk(c, ['--yes']);
  assert.equal(currentBranch(c), 'main');
  assert.equal(sha(c, 'main'), tip);
  assert.equal(sha(c, 'HEAD'), tip);
  assert.ok(!hasRef(c.project, 'refs/heads/feature/x'));
  assert.ok(findItem(out.removed, 'branch', (i) => i.branch === 'feature/x'), JSON.stringify(out.removed));
  assert.equal(git(c.project, 'status', '--porcelain'), '');
  // A fast-forward: no new commit was made on main.
  assert.equal(git(c.project, 'rev-list', '--count', `${tip}..main`), '0');
});

test('cleanup: a dirty main checkout is never switched', () => {
  const c = newCase();
  const tip = mergeIntoOrigin(c);
  const mainBefore = sha(c, 'main');
  writeFileSync(join(c.project, 'README.md'), 'changed\n');
  const out = cleanupOk(c, ['--yes']);
  assert.equal(currentBranch(c), 'feature/x');
  assert.ok(hasRef(c.project, 'refs/heads/feature/x'));
  assert.equal(sha(c, 'main'), mainBefore);
  assert.notEqual(mainBefore, tip);
  assert.equal(readFileSync(join(c.project, 'README.md'), 'utf8'), 'changed\n');
  const kept = findItem(out.kept, 'branch', (i) => i.branch === 'feature/x');
  assert.ok(kept, JSON.stringify(out.kept));
  assert.match(kept.reason, /uncommitted/);
});

// Runs cleanup --yes and checks that the main checkout stayed on feature/x
// with main and feature/x unchanged; returns the reason feature/x was kept.
function featureKept(c) {
  const before = { main: sha(c, 'main'), feature: sha(c, 'feature/x') };
  const out = cleanupOk(c, ['--yes']);
  assert.equal(currentBranch(c), 'feature/x');
  assert.deepEqual({ main: sha(c, 'main'), feature: sha(c, 'feature/x') }, before);
  const kept = findItem(out.kept, 'branch', (i) => i.branch === 'feature/x');
  assert.ok(kept, JSON.stringify(out.kept));
  return kept.reason;
}

test('cleanup: a local base that cannot fast-forward is never switched to', () => {
  const c = newCase();
  mergeIntoOrigin(c);
  // A commit on the local main that the upstream does not have.
  const local = git(c.project, 'commit-tree', 'main^{tree}', '-p', 'main', '-m', 'local only');
  git(c.project, 'update-ref', 'refs/heads/main', local);
  assert.match(featureKept(c), /cannot fast-forward/);
  assert.equal(sha(c, 'main'), local);
});

test('cleanup: a failed fetch or a base without upstream keeps the feature branch', () => {
  const c = newCase();
  mergeIntoOrigin(c);
  git(c.project, 'remote', 'set-url', 'origin', join(c.root, 'missing.git'));
  assert.match(featureKept(c), /git fetch origin refs\/heads\/main failed/);
  const d = newCase();
  mergeIntoOrigin(d);
  git(d.project, 'branch', '--unset-upstream', 'main');
  assert.match(featureKept(d), /has no upstream/);
});

test('cleanup: a locked lane worktree and its branch are kept', () => {
  const c = newCase();
  git(c.project, 'worktree', 'lock', c.lanes.a);
  const out = cleanupOk(c, ['--yes']);
  assert.ok(existsSync(c.lanes.a));
  assert.ok(hasWorktree(c.project, c.lanes.a));
  assert.ok(hasRef(c.project, 'refs/heads/pl-r1-a'));
  const kept = findItem(out.kept, 'worktree', (i) => samePath(i.path, c.lanes.a));
  assert.ok(kept, JSON.stringify(out.kept));
  assert.match(kept.reason, /locked/);
  assert.ok(findItem(out.kept, 'branch', (i) => i.branch === 'pl-r1-a'), JSON.stringify(out.kept));
  // The other lane is still cleaned up.
  assert.ok(!existsSync(c.lanes.b));
});

test('cleanup: an index folder outside the history dir is refused', () => {
  for (const bad of ['../x', '/x', 'C:/x', 'a/../../x']) {
    const c = newCase();
    writeIndex(c.history, c.manifest, bad);
    const res = cleanup(c, ['--yes']);
    assert.equal(res.code, 2, `${bad}: ${res.stderr}`);
    assert.match(res.stderr, /bad folder/);
    assert.ok(hasRef(c.project, 'refs/heads/pl-r1-a'), 'nothing was removed');
    assert.ok(!existsSync(join(c.root, 'x')), 'no restore point outside the history dir');
  }
});

test('cleanup: a Git Bash path to the manifest works on Windows', { skip: !IS_WINDOWS }, () => {
  const c = newCase();
  const msys = c.manifest.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`);
  const res = sh('python3', [CLEANUP, msys, '--json', '--history-dir', c.history], { env: { PL_ACTIVE_DIR: c.active } });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).run_id, 'r1');
});

test('cleanup: abandoned refs survive', () => {
  const c = newCase();
  mergeIntoOrigin(c);
  const out = cleanupOk(c, ['--yes']);
  assert.ok(!hasRef(c.project, 'refs/heads/feature/x'), 'the full cleanup ran');
  assert.equal(sha(c, 'refs/parallel-lanes/r1/abandoned/x'), c.abandoned);
  const kept = findItem(out.kept, 'ref', (i) => i.ref === 'refs/parallel-lanes/r1/abandoned/x');
  assert.ok(kept && kept.reason, JSON.stringify(out.kept));
});

// A finished shadow-mode run 'r1': a bare git dir (the shadow repo) for a
// project folder that is not a git repo, with the feature worktree and two
// lane worktrees, both lanes merged into the feature branch.
function newShadowCase() {
  counter += 1;
  const root = join(TMP, `case ${counter}`);
  const project = join(root, 'my project');
  const gitDir = join(root, 'shadow git');
  const worktreeRoot = join(root, 'wt root');
  const ledgerDir = join(root, 'ledger dir');
  const history = join(root, 'history');
  const active = join(root, 'active');
  mkdirSync(project, { recursive: true });
  mkdirSync(ledgerDir, { recursive: true });
  writeFileSync(join(project, 'README.md'), 'hello\n');
  git(root, 'init', '-q', '--bare', '-b', 'pl-base', gitDir);
  const gd = `--git-dir=${gitDir}`;
  git(root, gd, `--work-tree=${project}`, 'add', '-A');
  git(root, gd, `--work-tree=${project}`, 'commit', '-q', '-m', 'baseline');
  const feature = join(worktreeRoot, 'feature');
  git(root, gd, 'worktree', 'add', '-q', '-b', 'feature/x', feature, 'pl-base');
  const lanes = {};
  for (const id of ['a', 'b']) {
    const dir = join(worktreeRoot, `lane-${id}`);
    git(root, gd, 'worktree', 'add', '-q', '-b', `pl-r1-${id}`, dir, 'feature/x');
    commitFile(dir, `${id}.txt`, `lane ${id}\n`);
    lanes[id] = dir;
    git(feature, 'merge', '-q', '--no-ff', '-m', `merge ${id}`, `pl-r1-${id}`);
  }
  const m = {
    version: 1,
    run_id: 'r1',
    repo: {
      mode: 'shadow',
      root: project,
      git_dir: gitDir,
      base_ref: 'pl-base',
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
  writeIndex(history, manifest, folder);
  return { root, project, gitDir, worktreeRoot, history, active, manifest, runFolder, lanes, feature };
}

test('cleanup: shadow mode removes worktrees and keeps branches', () => {
  const c = newShadowCase();
  const gd = `--git-dir=${c.gitDir}`;
  const branches = () => git(c.root, gd, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads');
  const before = branches();
  for (const b of ['feature/x', 'pl-r1-a', 'pl-r1-b', 'pl-base']) assert.ok(before.includes(`refs/heads/${b} `), before);
  const out = cleanupOk(c, ['--yes']);
  restorePoint(c, out);
  for (const path of [c.lanes.a, c.lanes.b, c.feature]) {
    assert.ok(!existsSync(path), `${path} is gone`);
    assert.ok(findItem(out.removed, 'worktree', (i) => samePath(i.path, path)), JSON.stringify(out.removed));
  }
  const left = git(c.root, gd, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '));
  assert.equal(left.length, 1, left.join('\n'));
  assert.equal(branches(), before);
  assert.ok(!out.removed.some((i) => i.kind === 'branch'), JSON.stringify(out.removed));
  assert.ok(existsSync(c.gitDir));
  assert.ok(!existsSync(c.worktreeRoot));
  assert.deepEqual(readdirSync(c.project), ['README.md']);
});

// --- F8: cleanup holds the run and checkout locks and rechecks each item ---

// cleanup loaded as a module (its main does not run), for the seam tests.
const LOAD_CLEANUP = [
  'import importlib.machinery, importlib.util, json, os, sys',
  'sys.dont_write_bytecode = True',
  "loader = importlib.machinery.SourceFileLoader('cleanup', sys.argv[1])",
  'mod = importlib.util.module_from_spec(importlib.util.spec_from_loader(loader.name, loader))',
  'loader.exec_module(mod)',
  'm = mod.load_manifest(sys.argv[2])',
  'repo = mod.Repo(m)',
];

function python(c, lines, args) {
  const res = sh('python3', ['-c', lines.join('\n'), CLEANUP, c.manifest, ...args], { env: { PL_ACTIVE_DIR: c.active } });
  assert.equal(res.code, 0, res.stderr);
  return res.stdout;
}

// make_plan, written to a file, so the repo can change before removeOwned.
function makePlan(c) {
  const file = join(c.root, 'plan.json');
  python(c, [
    ...LOAD_CLEANUP,
    "plan = mod.make_plan(repo, m, 'unused')",
    "with open(sys.argv[3], 'w', encoding='utf-8') as f:",
    '    json.dump(plan, f)',
  ], [file]);
  return file;
}

// remove_owned on the plan makePlan wrote: {removed, kept}.
function removeOwned(c, file) {
  return JSON.parse(python(c, [
    ...LOAD_CLEANUP,
    "with open(sys.argv[3], encoding='utf-8') as f:",
    '    plan = json.load(f)',
    'removed, kept = mod.remove_owned(repo, m, plan)',
    "print(json.dumps({'removed': removed, 'kept': kept}))",
  ], [file]));
}

test('cleanup: worktree items name the HEAD they were planned at', () => {
  const c = newCase();
  const plan = cleanupOk(c);
  for (const id of ['a', 'b']) assert.equal(planned(plan, c.lanes[id]).head, sha(c, `pl-r1-${id}`));
});

test('cleanup: a worktree switched to another branch after the plan is kept', () => {
  const c = newCase();
  const file = makePlan(c);
  git(c.lanes.a, 'switch', '-q', '-c', 'foreign-work');
  commitFile(c.lanes.a, 'foreign.txt', 'foreign work\n');
  const commit = sha(c, 'foreign-work');
  const out = removeOwned(c, file);
  const kept = findItem(out.kept, 'worktree', (i) => samePath(i.path, c.lanes.a));
  assert.ok(kept, JSON.stringify(out.kept));
  assert.match(kept.reason, /changed after the plan/);
  assert.ok(existsSync(join(c.lanes.a, 'foreign.txt')));
  assert.ok(hasWorktree(c.project, c.lanes.a));
  assert.equal(sha(c, 'refs/heads/foreign-work'), commit);
  assert.ok(hasRef(c.project, 'refs/heads/pl-r1-a'), 'the planned branch of a kept worktree is kept');
  // The other lane is still cleaned up.
  assert.ok(!existsSync(c.lanes.b));
});

test('cleanup: a worktree with a new commit after the plan is kept', () => {
  const c = newCase();
  const file = makePlan(c);
  commitFile(c.lanes.a, 'late.txt', 'late work\n');
  const tip = sha(c, 'pl-r1-a');
  const out = removeOwned(c, file);
  const kept = findItem(out.kept, 'worktree', (i) => samePath(i.path, c.lanes.a));
  assert.ok(kept, JSON.stringify(out.kept));
  assert.match(kept.reason, /changed after the plan/);
  assert.ok(existsSync(join(c.lanes.a, 'late.txt')));
  assert.ok(findItem(out.kept, 'branch', (i) => i.branch === 'pl-r1-a'), JSON.stringify(out.kept));
  assert.equal(sha(c, 'refs/heads/pl-r1-a'), tip);
});

test('cleanup: a branch moved after the plan is kept', () => {
  const c = newCase();
  git(c.project, 'worktree', 'remove', c.lanes.b);
  const file = makePlan(c);
  const moved = git(c.project, 'commit-tree', 'pl-r1-b^{tree}', '-p', 'pl-r1-b', '-m', 'moved');
  git(c.project, 'update-ref', 'refs/heads/pl-r1-b', moved);
  const out = removeOwned(c, file);
  const kept = findItem(out.kept, 'branch', (i) => i.branch === 'pl-r1-b');
  assert.ok(kept, JSON.stringify(out.kept));
  assert.match(kept.reason, /moved after the plan/);
  assert.equal(sha(c, 'refs/heads/pl-r1-b'), moved);
});

test('cleanup: a branch deleted after the plan is named as gone, not moved', () => {
  const c = newCase();
  git(c.project, 'worktree', 'remove', c.lanes.b);
  const file = makePlan(c);
  git(c.project, 'branch', '-D', 'pl-r1-b');
  const out = removeOwned(c, file);
  const kept = findItem(out.kept, 'branch', (i) => i.branch === 'pl-r1-b');
  assert.ok(kept, JSON.stringify(out.kept));
  assert.match(kept.reason, /^deleted after the plan/);
  assert.ok(!/moved/.test(kept.reason), kept.reason);
});

// The recheck catches a file added after the plan, so it is bypassed here:
// git worktree remove itself must still see an untracked file that
// status.showUntrackedFiles=no hides, and refuse.
test('cleanup: git worktree remove refuses a hidden untracked file by itself', () => {
  const c = hidingCase();
  const file = makePlan(c);
  const draft = join(c.lanes.a, 'private-draft.txt');
  writeFileSync(draft, 'not committed\n');
  const out = JSON.parse(python(c, [
    ...LOAD_CLEANUP,
    "with open(sys.argv[3], encoding='utf-8') as f:",
    '    plan = json.load(f)',
    'mod.recheck_worktree = lambda *args, **kwargs: None',
    'removed, kept = mod.remove_owned(repo, m, plan)',
    "print(json.dumps({'removed': removed, 'kept': kept}))",
  ], [file]));
  const kept = findItem(out.kept, 'worktree', (i) => samePath(i.path, c.lanes.a));
  assert.ok(kept, JSON.stringify(out));
  assert.match(kept.reason, /^git worktree remove refused/);
  assert.ok(existsSync(draft));
  assert.ok(hasWorktree(c.project, c.lanes.a));
  assert.ok(hasRef(c.project, 'refs/heads/pl-r1-a'));
});

test('cleanup: --yes refuses while another session holds the run lock', () => {
  const c = newCase();
  mkdirSync(c.active, { recursive: true });
  writeFileSync(join(c.active, 'r1.lock'), 'othertoken\n');
  const before = state(c);
  const res = cleanup(c, ['--yes']);
  assert.equal(res.code, 3, res.stderr);
  assert.match(res.stderr, /another session/);
  assert.deepEqual(state(c), before);
  assert.ok(!existsSync(join(c.runFolder, 'cleanup')));
});

const checkoutLockFiles = (c) => readdirSync(c.active).filter((f) => /^checkout-.*\.lock$/.test(f));

test('cleanup: --yes leaves no marker or lock behind', () => {
  const c = newCase();
  cleanupOk(c, ['--yes']);
  const list = sh(BASH, [join(SCRIPTS, 'active-run'), 'list'], { env: { PL_ACTIVE_DIR: c.active } });
  assert.equal(list.code, 0, list.stderr);
  assert.equal(list.stdout.trim(), '[]');
  assert.ok(!existsSync(join(c.active, 'r1.lock')));
  assert.deepEqual(checkoutLockFiles(c), []);
});

// Run r2 holds the case's checkout, as its setup leaves it.
function holdCheckoutForR2(c) {
  mkdirSync(c.active, { recursive: true });
  writeFileSync(join(c.active, 'r2.lock'), 'r2token\n');
  const res = sh('python3', ['-c', [
    'import sys',
    'sys.dont_write_bytecode = True',
    `sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`,
    'import _locks',
    "_locks.checkout_lock(sys.argv[1], 'r2')",
  ].join('\n'), c.project], { env: { PL_ACTIVE_DIR: c.active } });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(checkoutLockFiles(c).length, 1);
}

test('cleanup: --yes refuses while another run holds the checkout', () => {
  const c = newCase();
  holdCheckoutForR2(c);
  const before = state(c);
  const res = cleanup(c, ['--yes']);
  assert.equal(res.code, 3, res.stderr);
  assert.match(res.stderr, /\br2\b/);
  assert.deepEqual(state(c), before);
});

test('cleanup: another run cannot take the checkout while cleanup holds it', () => {
  const c = newCase();
  const out = JSON.parse(python(c, [
    ...LOAD_CLEANUP,
    'token = mod.acquire_run_lock(m, sys.argv[2])',
    'try:',
    "    mod.take_checkout_lock(repo, m['run_id'])",
    "    with open(os.path.join(os.environ['PL_ACTIVE_DIR'], 'r2.lock'), 'w', encoding='utf-8') as f:",
    "        f.write('r2token\\n')",
    '    try:',
    "        mod._locks.checkout_lock(m['repo']['root'], 'r2')",
    "        result = {'code': None}",
    '    except mod._locks.LockError as e:',
    "        result = {'code': e.code, 'message': str(e)}",
    'finally:',
    "    mod.release_run_lock(m['run_id'], token)",
    'print(json.dumps(result))',
  ], []));
  assert.equal(out.code, 4, JSON.stringify(out));
  assert.match(out.message, /\br1\b/);
});

test('cleanup: the plan alone takes no lock', () => {
  const c = newCase();
  cleanupOk(c);
  assert.ok(!existsSync(c.active) || readdirSync(c.active).length === 0, 'the active dir holds no file');
});

// ---- 1.6.5: join unit branches (pl-<run>-u-<unit>) ----

test('merged unit branches and their worktrees are removed', () => {
  const c = newCase();
  git(c.lanes.a, 'checkout', '-q', '-b', 'pl-r1-u-J1', 'feature/x');
  commitFile(c.lanes.a, 'j1.txt', 'unit J1\n');
  git(c.project, 'merge', '-q', '--no-ff', '-m', 'join wave 1: merge J1', 'pl-r1-u-J1');
  const plan = cleanupOk(c);
  const wt = plan.worktrees.find((w) => samePath(w.path, c.lanes.a));
  assert.ok(wt, JSON.stringify(plan.worktrees));
  assert.equal(wt.branch, 'pl-r1-u-J1');
  assert.equal(wt.action, 'remove', JSON.stringify(wt));
  const unit = plan.branches.find((b) => b.branch === 'pl-r1-u-J1');
  assert.ok(unit, JSON.stringify(plan.branches));
  assert.equal(unit.action, 'remove', JSON.stringify(unit));
  assert.equal(plan.foreign.length, 0, JSON.stringify(plan.foreign));
  cleanupOk(c, ['--yes']);
  assert.equal(sh('git', ['-C', c.project, 'rev-parse', '--verify', '--quiet', 'refs/heads/pl-r1-u-J1']).code, 1);
  assert.ok(!existsSync(c.lanes.a));
});

test('an unmerged unit branch is kept', () => {
  const c = newCase();
  git(c.lanes.b, 'checkout', '-q', '-b', 'pl-r1-u-J2', 'feature/x');
  commitFile(c.lanes.b, 'j2.txt', 'unit J2, blocked\n');
  git(c.lanes.b, 'checkout', '-q', 'pl-r1-b');
  const plan = cleanupOk(c);
  const unit = plan.branches.find((b) => b.branch === 'pl-r1-u-J2');
  assert.ok(unit, JSON.stringify(plan.branches));
  assert.equal(unit.action, 'keep');
  assert.match(unit.reason, /not merged/);
  cleanupOk(c, ['--yes']);
  assert.equal(sh('git', ['-C', c.project, 'rev-parse', '--verify', '--quiet', 'refs/heads/pl-r1-u-J2']).code, 0);
});

test('another run\'s unit branch is not claimed', () => {
  const c = newCase();
  git(c.project, 'branch', 'pl-r2-u-J1', 'feature/x');
  const plan = cleanupOk(c);
  assert.ok(!plan.branches.some((b) => b.branch === 'pl-r2-u-J1'), JSON.stringify(plan.branches));
});

// ---- 1.6.8: the start check's worktree (<worktree_root>/start) ----

// Record the run's start sha as setup does: a setup run_started event in
// the ledger's _run.jsonl. Returns the sha (main, where the run started).
function recordStart(c) {
  const start = sha(c, 'main');
  const event = { task: '_run', event: 'run_started', phase: 'setup', head: start, ts: '2026-10-10T10:00:00Z' };
  writeFileSync(join(c.ledgerDir, '_run.jsonl'), JSON.stringify(event) + '\n');
  return start;
}

// A detached worktree at <worktree_root>/start on ref, as the start check adds it.
function addStart(c, ref) {
  const dir = join(c.worktreeRoot, 'start');
  git(c.project, 'worktree', 'add', '-q', '--detach', dir, ref);
  return dir;
}

test('cleanup: a detached start worktree at the start sha is removed even with untracked files', () => {
  const c = newCase();
  const start = recordStart(c);
  const dir = addStart(c, start);
  writeFileSync(join(dir, 'left-behind.log'), 'a start check left this\n');
  writeFileSync(join(dir, 'README.md'), 'changed by a setup command\n');
  const plan = cleanupOk(c);
  const wt = plan.worktrees.find((w) => samePath(w.path, dir));
  assert.ok(wt, JSON.stringify(plan.worktrees));
  assert.equal(wt.branch, null);
  assert.equal(wt.head, start);
  assert.equal(wt.action, 'remove', JSON.stringify(wt));
  assert.match(wt.reason, /--force/);
  assert.equal(plan.foreign.length, 0, JSON.stringify(plan.foreign));
  const text = sh('python3', [CLEANUP, c.manifest, '--history-dir', c.history], { env: { PL_ACTIVE_DIR: c.active } });
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /remove {2}.*start \(detached\)/, text.stdout);

  const out = cleanupOk(c, ['--yes']);
  assert.ok(!existsSync(dir), 'the start worktree is gone');
  assert.ok(!hasWorktree(c.project, dir), 'the start path is not a worktree any more');
  assert.ok(findItem(out.removed, 'worktree', (i) => samePath(i.path, dir)), JSON.stringify(out.removed));
  // Nothing else was left, so the worktree root goes too.
  assert.ok(!existsSync(c.worktreeRoot));
});

test('cleanup: a start worktree on another sha stays foreign', () => {
  const c = newCase();
  recordStart(c);
  const dir = addStart(c, 'feature/x');
  const plan = cleanupOk(c);
  assert.ok(!plan.worktrees.some((w) => samePath(w.path, dir)), JSON.stringify(plan.worktrees));
  const foreign = plan.foreign.find((f) => samePath(f.path, dir));
  assert.ok(foreign, JSON.stringify(plan.foreign));
  assert.equal(foreign.reason, 'not owned by this run');
  const out = cleanupOk(c, ['--yes']);
  assert.ok(existsSync(dir));
  assert.ok(hasWorktree(c.project, dir));
  assert.ok(findItem(out.kept, 'path', (i) => samePath(i.path, dir)), JSON.stringify(out.kept));
});

test('cleanup: a start worktree on a branch at the start sha stays foreign', () => {
  const c = newCase();
  const start = recordStart(c);
  const dir = join(c.worktreeRoot, 'start');
  git(c.project, 'worktree', 'add', '-q', '-b', 'mine', dir, start);
  const plan = cleanupOk(c);
  assert.ok(!plan.worktrees.some((w) => samePath(w.path, dir)), JSON.stringify(plan.worktrees));
  assert.ok(plan.foreign.some((f) => samePath(f.path, dir)), JSON.stringify(plan.foreign));
});

test('cleanup: restore.md names the start worktree', () => {
  const c = newCase();
  // The manifest's start_points.prelude wins over the ledger.
  const start = sha(c, 'main');
  const m = JSON.parse(readFileSync(c.manifest, 'utf8'));
  m.start_points = { prelude: start };
  writeFileSync(c.manifest, JSON.stringify(m, null, 2));
  const dir = addStart(c, start);
  const out = cleanupOk(c, ['--yes']);
  assert.ok(!existsSync(dir));
  const restore = readFileSync(join(restorePoint(c, out), 'restore.md'), 'utf8');
  const line = restore.split('\n').find((l) => /^git .* worktree add --detach /.test(l));
  assert.ok(line, restore);
  assert.ok(line.endsWith(` ${start}`), line);
  assert.ok(line.includes('start'), line);
  // The line brings the worktree back, detached at the start sha.
  const res = sh(BASH, ['-c', line], { cwd: c.root });
  assert.equal(res.code, 0, res.stderr);
  assert.ok(hasWorktree(c.project, dir));
  assert.equal(git(dir, 'rev-parse', 'HEAD'), start);
});
