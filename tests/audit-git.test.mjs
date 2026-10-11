// scripts/_audit_git.py: read-only git access for scripts/audit. Every git
// call (repo discovery included) runs with --no-optional-locks, a sanitized
// environment, and never fetches, writes config or moves a ref.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commit, makeRepo, pythonJSON } from './audit-helpers.mjs';

// The tests' own git calls: reads use --no-optional-locks, and nothing in
// the parent's environment points git at another repo.
const DROP = /^(GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_COMMON_DIR)$/i;
function gitEnv() {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) if (!DROP.test(k)) out[k] = v;
  return out;
}

function gitRead(dir, ...args) {
  const r = spawnSync('git', ['--no-optional-locks', ...args], { cwd: dir, env: gitEnv(), encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

// Every file under .git with its size and mtime, in name order.
function treeOf(dir) {
  const out = [];
  const walk = (rel) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const path = rel ? `${rel}/${name}` : name;
      const st = statSync(join(dir, path));
      if (st.isDirectory()) walk(path);
      else out.push(`${path} ${st.size} ${st.mtimeMs}`);
    }
  };
  walk('');
  return out;
}

function snapshot(dir) {
  const gitDir = join(dir, '.git');
  return {
    refs: gitRead(dir, 'for-each-ref', '--format=%(refname) %(objectname)'),
    config: readFileSync(join(gitDir, 'config')).toString('base64'),
    head: readFileSync(join(gitDir, 'HEAD')).toString('base64'),
    index: readFileSync(join(gitDir, 'index')).toString('base64'),
    status: gitRead(dir, 'status', '--porcelain'),
    tree: treeOf(gitDir),
  };
}

test('open_repo accepts a worktree and a git dir', () => {
  const repo = makeRepo(2);
  const out = pythonJSON([
    'import os',
    'import _audit_git as g',
    'work, gitdir, missing, start = sys.argv[1:5]',
    'a, ra = g.open_repo(work, start)',
    'b, rb = g.open_repo(gitdir, start)',
    'c, rc = g.open_repo(missing, start)',
    'd, rd = g.open_repo(work, None)',
    'print(json.dumps({"ra": ra, "rb": rb, "a_same": os.path.samefile(a.git_dir, gitdir),',
    '                  "b_same": os.path.samefile(b.git_dir, gitdir), "c": c is None, "rc": rc,',
    '                  "d": d is not None, "rd": rd}))',
  ], [repo.dir, join(repo.dir, '.git'), join(repo.dir, 'no-such-dir'), repo.shas[0]]);
  assert.equal(out.ra, null);
  assert.equal(out.rb, null);
  assert.equal(out.a_same, true);
  assert.equal(out.b_same, true);
  assert.equal(out.c, true);
  assert.match(out.rc, /not a git repo/);
  assert.equal(out.d, true);
  assert.equal(out.rd, null);
});

test('open_repo refuses a repo without the start commit', () => {
  const one = makeRepo(1);
  // Two one-commit repos made in the same second share their sha, so the
  // start commit is one the first repo cannot have.
  const other = makeRepo(1);
  const start = commit(other.dir, 'only-here.txt');
  const out = pythonJSON([
    'import _audit_git as g',
    'git, reason = g.open_repo(sys.argv[1], sys.argv[2])',
    'print(json.dumps({"none": git is None, "reason": reason}))',
  ], [one.dir, start]);
  assert.equal(out.none, true);
  assert.equal(out.reason, `the repo does not contain ${start.slice(0, 7)}`);
});

test('range and ancestry', () => {
  const { dir, shas } = makeRepo(5);
  const [s1, s2, s3, s4, s5] = shas;
  const out = pythonJSON([
    'import _audit_git as g',
    'git, _ = g.open_repo(sys.argv[1], sys.argv[2])',
    's1, s2, s3, s4, s5 = sys.argv[2:7]',
    'gone = "0" * 40',
    'print(json.dumps({',
    '  "range": git.range_commits(s1, s4),',
    '  "rev_list": git.rev_list(s5, [s2, s4]),',
    '  "everything": git.rev_list(s3, []),',
    '  "empty": git.range_commits(s4, s2),',
    '  "unknown_range": git.range_commits(gone, s4),',
    '  "option": git.rev_list("--all", []),',
    '  "has": [git.has_commit(s1), git.has_commit(gone), git.has_commit("--all")],',
    '  "anc": [git.is_ancestor(s1, s4), git.is_ancestor(s4, s1), git.is_ancestor(gone, s4)],',
    '}))',
  ], [dir, s1, s2, s3, s4, s5]);
  assert.deepEqual(out.range, [s2, s3, s4]);
  assert.deepEqual(out.rev_list, [s5]);
  assert.deepEqual(out.everything, [s1, s2, s3]);
  assert.deepEqual(out.empty, []);
  assert.equal(out.unknown_range, null);
  assert.equal(out.option, null);
  assert.deepEqual(out.has, [true, false, false]);
  assert.deepEqual(out.anc, [true, false, null]);
});

test('Unicode paths come back as written', () => {
  const { dir, shas } = makeRepo(1);
  // macOS git would otherwise store the decomposed name precomposed.
  const r = spawnSync('git', ['config', 'core.precomposeunicode', 'false'], { cwd: dir, env: gitEnv() });
  assert.equal(r.status, 0);
  // cafe plus a combining acute accent (U+0301), kept out of the ASCII source.
  const name = `cafe${String.fromCharCode(0x301)}.txt`;
  const head = commit(dir, name);
  const second = commit(dir, 'plain.txt');
  const out = pythonJSON([
    'import _audit_git as g',
    'git, _ = g.open_repo(sys.argv[1], sys.argv[2])',
    'print(json.dumps({"one": git.changed_files(sys.argv[2], sys.argv[3]),',
    '                  "both": git.changed_files(sys.argv[2], sys.argv[4]),',
    '                  "unknown": git.changed_files("0" * 40, sys.argv[3])}))',
  ], [dir, shas[0], head, second]);
  assert.deepEqual(out.one, [name]);
  assert.deepEqual(out.both, [name, 'plain.txt']);
  assert.equal(out.unknown, null);
});

test('git use changes nothing', () => {
  const { dir, shas } = makeRepo(3);
  // A dirty worktree and a stale index stat: a git call that took optional
  // locks would refresh and rewrite the index.
  writeFileSync(join(dir, 'f1.txt'), 'changed\n');
  writeFileSync(join(dir, 'untracked.txt'), 'new\n');
  utimesSync(join(dir, 'f2.txt'), 1000000000, 1000000000);
  const before = snapshot(dir);
  pythonJSON([
    'import _audit_git as g',
    'work, s1, s3 = sys.argv[1:4]',
    'git, _ = g.open_repo(work, s1)',
    'g.open_repo(work, "0" * 40)',
    'g.open_repo(work, None)',
    'out = [git.has_commit(s3), git.has_commit("1" * 40), git.is_ancestor(s1, s3),',
    '       git.rev_list(s3, [s1]), git.range_commits(s1, s3), git.changed_files(s1, s3),',
    '       git.range_commits("2" * 40, s3)]',
    'print(json.dumps(out))',
  ], [dir, shas[0], shas[2]]);
  const after = snapshot(dir);
  assert.deepEqual(after, before);
  assert.equal(existsSync(join(dir, '.git', 'FETCH_HEAD')), false);
});

test('GIT_DIR in the environment is ignored, discovery included', () => {
  const mine = makeRepo(3);
  const other = makeRepo(1);
  commit(other.dir, 'other.txt');
  const out = pythonJSON([
    'import os',
    'import _audit_git as g',
    'work, other, s1, s3 = sys.argv[1:5]',
    'os.environ["GIT_DIR"] = os.path.join(other, ".git")',
    'os.environ["GIT_WORK_TREE"] = other',
    'os.environ["GIT_INDEX_FILE"] = os.path.join(other, ".git", "index")',
    'os.environ["GIT_OBJECT_DIRECTORY"] = os.path.join(other, ".git", "objects")',
    'os.environ["GIT_COMMON_DIR"] = os.path.join(other, ".git")',
    'git, reason = g.open_repo(work, s1)',
    'print(json.dumps({"reason": reason, "same": os.path.samefile(git.git_dir, os.path.join(work, ".git")),',
    '                  "range": git.range_commits(s1, s3), "files": git.changed_files(s1, s3)}))',
  ], [mine.dir, other.dir, mine.shas[0], mine.shas[2]]);
  assert.equal(out.reason, null);
  assert.equal(out.same, true);
  assert.deepEqual(out.range, mine.shas.slice(1));
  assert.deepEqual(out.files, ['f2.txt', 'f3.txt']);
});
