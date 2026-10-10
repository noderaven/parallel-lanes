// doctor: the checks that block a launch (hard failures), run against temp
// git repos with a local bare repo as origin (no network).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SKILL_DIR } from './harness.mjs';
import { BASH, tempDir } from './platform.mjs';

const SCRIPT = join(SKILL_DIR, 'scripts', 'doctor');
const TMP = tempDir('pl-doctor-');
after(() => rmSync(TMP, { recursive: true, force: true }));

// Variables that would give git an identity, a config or another repo than
// the one named: the tests set the config files themselves.
const DROP = /^(GIT_AUTHOR_|GIT_COMMITTER_|GIT_CONFIG)|^(GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_COMMON_DIR|EMAIL)$/i;

function cleanEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!DROP.test(k)) env[k] = v;
  return { ...env, ...extra };
}

const EMPTY = join(TMP, 'empty.gitconfig');
const IDENTITY = join(TMP, 'identity.gitconfig');
writeFileSync(EMPTY, '');
writeFileSync(IDENTITY, [
  '[user]', '\tname = Test', '\temail = test@example.com',
  '[core]', '\tautocrlf = false',
  '[init]', '\tdefaultBranch = main',
  '',
].join('\n'));
const ENV = cleanEnv({ GIT_CONFIG_GLOBAL: IDENTITY, GIT_CONFIG_SYSTEM: EMPTY, GIT_CONFIG_NOSYSTEM: '1' });
const NO_IDENTITY = cleanEnv({ GIT_CONFIG_GLOBAL: EMPTY, GIT_CONFIG_SYSTEM: EMPTY, GIT_CONFIG_NOSYSTEM: '1' });

// The manifest's python: this Python, shell-quoted, with '/' separators.
const PYTHON = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' })
  .stdout.trim().replace(/\\/g, '/');

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env: ENV, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function commit(dir, name) {
  writeFileSync(join(dir, name), `${name}\n`);
  git(dir, 'add', name);
  git(dir, 'commit', '-q', '-m', `add ${name}`);
}

let cases = 0;

// A bare origin with one commit on main, and a clone of it as the project
// (main tracks origin/main). other() makes a second clone to push from.
function fixture() {
  const dir = join(TMP, `case-${++cases}`);
  mkdirSync(dir);
  const origin = join(dir, 'origin.git');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  const seed = join(dir, 'seed');
  git(dir, 'clone', '-q', origin, seed);
  commit(seed, 'a.txt');
  git(seed, 'push', '-q', '-u', 'origin', 'main');
  const root = join(dir, 'project');
  git(dir, 'clone', '-q', origin, root);
  let manifests = 0;
  return {
    dir,
    origin,
    root,
    advanceOrigin(name) {
      git(seed, 'pull', '-q', '--ff-only');
      commit(seed, name);
      git(seed, 'push', '-q', 'origin', 'main');
    },
    manifest(repo = {}, extra = {}) {
      const m = {
        version: 1,
        run_id: 'd1',
        repo: {
          mode: 'git', root, git_dir: null, base_ref: 'main', branch: 'pl-feature',
          worktree_root: join(dir, 'wt'), ledger_dir: join(dir, 'ledger'), ...repo,
        },
        python: `'${PYTHON}'`,
        commit_rules: 'Follow the repository style.',
        commands: {},
        lanes: [{ id: 'a' }],
        limits: { max_parallel_lanes: 2 },
        ...extra,
      };
      const path = join(dir, `manifest-${++manifests}.json`);
      writeFileSync(path, JSON.stringify(m, null, 2));
      return path;
    },
  };
}

function doctor(manifest, { env = ENV, json = true } = {}) {
  const r = spawnSync('python3', [SCRIPT, manifest, ...(json ? ['--json'] : [])], { encoding: 'utf8', env });
  let out = null;
  if (json && (r.status === 0 || r.status === 3)) out = JSON.parse(r.stdout);
  return { code: r.status, out, stdout: r.stdout, stderr: r.stderr };
}

const named = (list, check) => list.find((x) => x.check === check);

test('a clean, current repo passes', () => {
  const f = fixture();
  const r = doctor(f.manifest());
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.out.status, 'ok');
  assert.deepEqual(r.out.failures, []);
  assert.equal(named(r.out.warnings, 'base_not_current'), undefined);
  assert.equal(named(r.out.skipped, 'base_not_current'), undefined);
  assert.deepEqual(named(r.out.skipped, 'shadow_repo'), { check: 'shadow_repo', reason: 'not_applicable' });
});

test('a missing git identity fails unless commit_rules passes one', () => {
  const f = fixture();
  const r = doctor(f.manifest(), { env: NO_IDENTITY });
  assert.equal(r.code, 3, r.stderr);
  assert.equal(r.out.status, 'blocked');
  const fail = named(r.out.failures, 'git_identity');
  assert.ok(fail, JSON.stringify(r.out));
  assert.match(fail.fix, /user\.name/);
  assert.match(fail.fix, /commit_rules/);

  const rules = 'Commit with git -c user.name=a -c user.email=b commit, one commit per task.';
  const ok = doctor(f.manifest({}, { commit_rules: rules }), { env: NO_IDENTITY });
  assert.equal(ok.code, 0, JSON.stringify(ok.out));
  assert.equal(named(ok.out.failures, 'git_identity'), undefined);
});

test('a base behind its upstream fails a new run', () => {
  const f = fixture();
  f.advanceOrigin('b.txt');
  git(f.root, 'fetch', '-q');
  const r = doctor(f.manifest());
  assert.equal(r.code, 3, r.stderr);
  const fail = named(r.out.failures, 'base_not_current');
  assert.equal(fail.detail, 'behind');
  assert.match(fail.fix, /fetch/);

  // A resume: the feature branch exists, so a stale base only warns.
  git(f.root, 'branch', 'pl-feature');
  const resume = doctor(f.manifest());
  assert.equal(resume.code, 0, JSON.stringify(resume.out));
  assert.deepEqual(resume.out.failures, []);
  assert.equal(named(resume.out.warnings, 'base_not_current').detail, 'behind');
});

test('a diverged base fails with detail diverged', () => {
  const f = fixture();
  f.advanceOrigin('b.txt');
  git(f.root, 'fetch', '-q');
  commit(f.root, 'local.txt');
  const r = doctor(f.manifest());
  assert.equal(r.code, 3, r.stderr);
  assert.equal(named(r.out.failures, 'base_not_current').detail, 'diverged');
});

test('a base ahead of its upstream passes', () => {
  const f = fixture();
  commit(f.root, 'local.txt');
  const r = doctor(f.manifest());
  assert.equal(r.code, 0, JSON.stringify(r.out));
  assert.equal(named(r.out.warnings, 'base_not_current'), undefined);
});

test('an unknown upstream tip fails a new run with detail unknown', () => {
  const f = fixture();
  f.advanceOrigin('b.txt');
  const r = doctor(f.manifest());
  assert.equal(r.code, 3, r.stderr);
  assert.equal(named(r.out.failures, 'base_not_current').detail, 'unknown');

  const shallow = join(f.dir, 'shallow');
  git(f.dir, 'clone', '-q', '--depth', '1', pathToFileURL(f.origin).href, shallow);
  f.advanceOrigin('c.txt');
  const s = doctor(f.manifest({ root: shallow }));
  assert.equal(s.code, 3, s.stderr);
  assert.equal(named(s.out.failures, 'base_not_current').detail, 'unknown');
});

test('an unreachable remote or no upstream does not block', () => {
  const f = fixture();
  git(f.root, 'remote', 'set-url', 'origin', join(f.dir, 'missing.git'));
  const r = doctor(f.manifest());
  assert.equal(r.code, 0, JSON.stringify(r.out));
  assert.deepEqual(r.out.failures, []);
  assert.ok(named(r.out.warnings, 'base_not_current'), JSON.stringify(r.out));

  const g = fixture();
  git(g.root, 'branch', '--unset-upstream', 'main');
  const none = doctor(g.manifest());
  assert.equal(none.code, 0, JSON.stringify(none.out));
  assert.ok(named(none.out.skipped, 'base_not_current'), JSON.stringify(none.out));
  assert.equal(named(none.out.warnings, 'base_not_current'), undefined);
});

test('a python that is not 3.8+ fails', () => {
  const f = fixture();
  const missing = join(f.dir, 'no-such-python').replace(/\\/g, '/');
  const r = doctor(f.manifest({}, { python: `'${missing}'` }));
  assert.equal(r.code, 3, r.stderr);
  assert.ok(named(r.out.failures, 'python'), JSON.stringify(r.out));

  // A Python that runs but reports an old version.
  const old = doctor(f.manifest({}, { python: `'${PYTHON}' -c "print('3.7.9')" --` }));
  assert.equal(old.code, 3, old.stderr);
  assert.match(named(old.out.failures, 'python').detail, /3\.7/);
});

test('a dirty checkout fails and the fix never says to ignore everything', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'untracked.txt'), 'new\n');
  const r = doctor(f.manifest());
  assert.equal(r.code, 3, r.stderr);
  const fail = named(r.out.failures, 'dirty_checkout');
  assert.match(fail.detail, /untracked\.txt/);
  assert.match(fail.fix, /commit/i);
  assert.match(fail.fix, /\.gitignore/);
  assert.match(fail.fix, /generated output/);
  assert.match(fail.fix, /never ignore a file a check reads/);
  assert.doesNotMatch(fail.fix, /ignore (all|everything)|\*/i);

  // An ignored file is not dirty.
  writeFileSync(join(f.root, '.git', 'info', 'exclude'), 'untracked.txt\n');
  const clean = doctor(f.manifest());
  assert.equal(named(clean.out.failures, 'dirty_checkout'), undefined, JSON.stringify(clean.out));
});

test('an untracked file is dirty even when status.showUntrackedFiles is no', () => {
  const f = fixture();
  git(f.root, 'config', 'status.showUntrackedFiles', 'no');
  writeFileSync(join(f.root, 'hidden.txt'), 'new\n');
  const r = doctor(f.manifest());
  assert.equal(r.code, 3, r.stderr);
  assert.match(named(r.out.failures, 'dirty_checkout').detail, /hidden\.txt/);
});

test('a work-tree rename is named once, by its new path', () => {
  // git add -N on a moved file shows R in the work-tree (Y) column,
  // followed by the source path.
  const f = fixture();
  writeFileSync(join(f.root, 'b.txt'), readFileSync(join(f.root, 'a.txt')));
  rmSync(join(f.root, 'a.txt'));
  git(f.root, 'add', '-N', 'b.txt');
  const status = git(f.root, 'status', '--porcelain', '-z', '--untracked-files=normal');
  assert.equal(status, ' R b.txt\0a.txt\0');
  const r = doctor(f.manifest());
  assert.equal(r.code, 3, r.stderr);
  assert.equal(named(r.out.failures, 'dirty_checkout').detail, '1 uncommitted or untracked path(s): b.txt');
});

test('a command timeout kills the processes it started and does not wait for them', () => {
  // A grandchild that inherits the pipes keeps them open after its parent
  // is killed, as git-remote-https or ssh does under git ls-remote.
  const code = [
    'import sys, time',
    'sys.dont_write_bytecode = True',
    'sys.path.insert(0, sys.argv[1])',
    'import _doctor',
    'p = _doctor.Probes()',
    'child = ("import subprocess, sys, time; "',
    '         "subprocess.Popen([sys.executable, \'-c\', \'import time; time.sleep(15)\']); "',
    '         "time.sleep(15)")',
    'start = time.monotonic()',
    'res = p._command([sys.executable, "-c", child], p.env, timeout=1)',
    'print(res is None, time.monotonic() - start)',
  ].join('\n');
  const r = spawnSync('python3', ['-c', code, join(SKILL_DIR, 'scripts')], { encoding: 'utf8', env: ENV });
  assert.equal(r.status, 0, r.stderr);
  const [timedOut, elapsed] = r.stdout.trim().split(' ');
  assert.equal(timedOut, 'True');
  assert.ok(Number(elapsed) < 8, `the timeout took ${elapsed} s`);
});

test('a missing shadow repo fails in shadow mode', () => {
  const f = fixture();
  const plain = join(f.dir, 'plain');
  mkdirSync(plain);
  writeFileSync(join(plain, 'notes.txt'), 'x\n');
  const r = doctor(f.manifest({ mode: 'shadow', root: plain, git_dir: join(f.dir, 'no-shadow') }));
  assert.equal(r.code, 3, r.stderr);
  assert.ok(named(r.out.failures, 'shadow_repo'), JSON.stringify(r.out));
  assert.deepEqual(named(r.out.skipped, 'dirty_checkout'), { check: 'dirty_checkout', reason: 'not_applicable' });

  // A directory that is not a complete shadow (no pl-baseline) fails too.
  const partial = join(f.dir, 'partial-shadow');
  git(f.dir, 'init', '-q', '--bare', partial);
  const p = doctor(f.manifest({ mode: 'shadow', root: plain, git_dir: partial }));
  assert.ok(named(p.out.failures, 'shadow_repo'), JSON.stringify(p.out));

  // A shadow made by shadow init passes.
  const init = spawnSync(BASH, [join(SKILL_DIR, 'scripts', 'shadow'), 'init', plain], {
    encoding: 'utf8', env: { ...ENV, PL_SHADOW_BASE: join(f.dir, 'shadows') },
  });
  assert.equal(init.status, 0, init.stderr);
  const ok = doctor(f.manifest({ mode: 'shadow', root: plain, git_dir: init.stdout.trim() }));
  assert.equal(ok.code, 0, JSON.stringify(ok.out));
  assert.deepEqual(named(ok.out.skipped, 'dirty_checkout'), { check: 'dirty_checkout', reason: 'not_applicable' });
});

test('the text output names each failure with its fix, then the warnings', () => {
  const f = fixture();
  f.advanceOrigin('b.txt');
  git(f.root, 'fetch', '-q');
  git(f.root, 'branch', 'pl-feature');
  writeFileSync(join(f.root, 'untracked.txt'), 'new\n');
  const r = doctor(f.manifest(), { json: false });
  assert.equal(r.code, 3, r.stderr);
  const text = r.stdout;
  const failAt = text.indexOf('dirty_checkout');
  const fixAt = text.indexOf('never ignore a file a check reads');
  const warnAt = text.indexOf('base_not_current');
  assert.ok(failAt >= 0 && fixAt > failAt && warnAt > fixAt, text);
});

test('usage errors and unreadable manifests exit 2', () => {
  assert.equal(spawnSync('python3', [SCRIPT], { encoding: 'utf8', env: ENV }).status, 2);
  const f = fixture();
  const bad = join(f.dir, 'bad.json');
  writeFileSync(bad, '{not json');
  assert.equal(doctor(bad).code, 2);
  assert.equal(doctor(join(f.dir, 'missing.json')).code, 2);
  const noRepo = join(f.dir, 'no-repo.json');
  writeFileSync(noRepo, JSON.stringify({ run_id: 'd1' }));
  assert.equal(doctor(noRepo).code, 2);
});

test('doctor changes nothing', () => {
  const f = fixture();
  f.advanceOrigin('b.txt');
  writeFileSync(join(f.root, 'untracked.txt'), 'new\n');
  // --no-optional-locks: the test's own status must not refresh the index.
  const snapshot = () => [
    git(f.root, '--no-optional-locks', 'status', '--porcelain'),
    git(f.root, 'for-each-ref'),
    git(f.root, 'config', '--list', '--local'),
    readFileSync(join(f.root, '.git', 'index')).toString('base64'),
  ];
  const before = snapshot();
  const manifest = f.manifest({}, { commit_rules: 'git -c user.name=a -c user.email=b commit' });
  assert.equal(doctor(manifest).code, 3);
  assert.equal(doctor(manifest, { json: false }).code, 3);
  assert.deepEqual(snapshot(), before);
  assert.ok(!existsSync(join(f.root, '.git', 'FETCH_HEAD')), 'doctor fetched');
});
