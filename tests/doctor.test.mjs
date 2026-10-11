// doctor: the checks that block a launch (hard failures), run against temp
// git repos with a local bare repo as origin (no network).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SKILL_DIR } from './harness.mjs';
import { BASH, IS_WINDOWS, tempDir } from './platform.mjs';

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

// Every check doctor runs, in run_checks order.
const CHECK_NAMES = [
  'git_identity', 'base_not_current', 'python', 'dirty_checkout', 'shadow_repo', 'memory',
  'disk', 'python_alias', 'heavy_processes', 'active_runs', 'defender', 'concurrency',
];

// No scenario may leave a check unrecorded: every result the helpers return
// is checked for completeness.
function assertComplete(result) {
  const unrecorded = (result.skipped || []).filter((s) => s.reason === 'not_recorded');
  assert.deepEqual(unrecorded, [], JSON.stringify(result));
}

function doctor(manifest, { env = ENV, json = true, save = null } = {}) {
  const args = [SCRIPT, manifest, ...(json ? ['--json'] : []), ...(save ? ['--save', save] : [])];
  const r = spawnSync('python3', args, { encoding: 'utf8', env });
  let out = null;
  if (json && (r.status === 0 || r.status === 3)) {
    out = JSON.parse(r.stdout);
    assertComplete(out);
  }
  return { code: r.status, out, stdout: r.stdout, stderr: r.stderr };
}

const named = (list, check) => list.find((x) => x.check === check);

// The outcome result's checks list gives check.
const outcome = (result, check) => named(result.checks, check)?.outcome;

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

  // --save needs a value.
  const manifest = f.manifest();
  for (const args of [['--save'], ['--json', '--save'], ['--save', '--json']]) {
    const r = spawnSync('python3', [SCRIPT, manifest, ...args], { encoding: 'utf8', env: ENV });
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
  }
});

test('--save writes the JSON result even when a check fails', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'untracked.txt'), 'new\n');
  const saved = join(f.dir, 'd.json');
  const r = doctor(f.manifest(), { save: saved });
  assert.equal(r.code, 3, r.stderr);
  assert.equal(r.stderr, '');
  const text = readFileSync(saved, 'utf8');
  const file = JSON.parse(text);
  assert.equal(file.status, 'blocked');
  assert.deepEqual(file, r.out);
  // The very JSON it printed: indent 2 and a trailing newline.
  assert.equal(text, r.stdout);

  // Without --json the file is still the JSON result, and stdout the text.
  const plain = join(f.dir, 'plain.json');
  const t = doctor(f.manifest(), { json: false, save: plain });
  assert.equal(t.code, 3, t.stderr);
  assert.match(t.stdout, /^doctor: blocked\n/);
  assert.match(t.stdout, /FAIL dirty_checkout: /);
  const result = JSON.parse(readFileSync(plain, 'utf8'));
  assert.equal(result.status, 'blocked');
  assert.equal(outcome(result, 'dirty_checkout'), 'failed');
  assertComplete(result);

  // On Windows a Git Bash path (/c/x), as a scratchpad path may be, is saved at C:/x.
  if (IS_WINDOWS) {
    const target = join(f.dir, 'msys.json');
    const msys = target.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`);
    const m = doctor(f.manifest(), { save: msys });
    assert.equal(m.code, 3, m.stderr);
    assert.equal(m.stderr, '');
    assert.equal(readFileSync(target, 'utf8'), m.stdout);
  }
});

test('--save never blocks', () => {
  const f = fixture();
  const manifest = f.manifest();
  const plain = doctor(manifest);
  assert.equal(plain.code, 0, plain.stderr + plain.stdout);
  writeFileSync(join(f.dir, 'afile'), 'a regular file\n');
  for (const target of [join(f.root, 'd.json'), join(f.dir, 'afile', 'd.json')]) {
    for (const json of [true, false]) {
      const r = doctor(manifest, { json, save: target });
      assert.equal(r.code, plain.code, `${target}: ${r.stderr}`);
      assert.match(r.stderr, /^doctor: result not saved: .+\n$/);
      assert.ok(!existsSync(target), `${target} was written`);
    }
  }
  // Nothing at all was left in the project: a later doctor still sees it clean.
  assert.equal(git(f.root, '--no-optional-locks', 'status', '--porcelain', '--untracked-files=all'), '');
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
  // The --save file, outside the repo, is the one file doctor writes.
  const saved = join(f.dir, 'saved.json');
  assert.equal(doctor(manifest, { save: saved }).code, 3);
  assert.equal(doctor(manifest, { json: false, save: saved }).code, 3);
  assert.ok(existsSync(saved), 'the --save file was not written');
  assert.deepEqual(snapshot(), before);
  assert.ok(!existsSync(join(f.root, '.git', 'FETCH_HEAD')), 'doctor fetched');
});

// Warnings: the platform reads are replaced by fakes through a Python snippet
// that calls run_checks. The hard checks still run, against the fixture repo.

const GB = 1024 ** 3;
const WARNING_CHECKS = ['memory', 'disk', 'python_alias', 'heavy_processes', 'active_runs', 'defender', 'concurrency'];
// A fake that raises stands for a read that fails.
const RAISE = 'raise';
const QUIET = {
  memory: { available: 16 * GB },
  disk_free: 100 * GB,
  load_average: [0.5, 8],
  appx_working_set: 0,
  defender_exclusions: [],
  active_runs: [],
};

const FAKE_SNIPPET = [
  'import json, os, sys',
  'sys.dont_write_bytecode = True',
  'sys.path.insert(0, sys.argv[1])',
  'import _doctor',
  'with open(sys.argv[2], encoding="utf-8") as f:',
  '    manifest = json.load(f)',
  'spec = json.loads(sys.argv[3])',
  'called = []',
  'def fake(name, value):',
  '    def probe(*args):',
  '        called.append(name)',
  '        if value == "raise":',
  '            raise OSError("the read failed")',
  '        return value',
  '    return probe',
  'env = dict(os.environ)',
  'for k, v in spec["env"].items():',
  '    if v is None:',
  '        env.pop(k, None)',
  '    else:',
  '        env[k] = v',
  'fakes = dict((n, fake(n, v)) for n, v in spec["fakes"].items())',
  'probes = _doctor.Probes(env=env, platform=spec["platform"], **fakes)',
  'result = _doctor.run_checks(manifest, probes)',
  'print(json.dumps({"result": result, "called": sorted(set(called))}))',
].join('\n');

function fakeDoctor(manifest, { fakes = {}, platform = process.platform, env = {} } = {}) {
  const spec = {
    platform,
    fakes: { ...QUIET, ...fakes },
    env: { CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS: '16', ...env },
  };
  const r = spawnSync('python3', ['-c', FAKE_SNIPPET, join(SKILL_DIR, 'scripts'), manifest, JSON.stringify(spec)],
    { encoding: 'utf8', env: ENV });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assertComplete(out.result);
  return { ...out.result, called: out.called, stdout: r.stdout };
}

// Runs a Python snippet with _doctor imported; it prints JSON, returned parsed.
function snippet(lines, ...args) {
  const code = ['import json, sys', 'sys.dont_write_bytecode = True', 'sys.path.insert(0, sys.argv[1])',
    'import _doctor', ...lines].join('\n');
  const r = spawnSync('python3', ['-c', code, join(SKILL_DIR, 'scripts'), ...args], { encoding: 'utf8', env: ENV });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('every check records exactly one outcome', () => {
  const f = fixture();
  const r = fakeDoctor(f.manifest());
  assert.equal(r.checks.length, 12, JSON.stringify(r.checks));
  assert.deepEqual(r.checks.map((c) => c.check), CHECK_NAMES);
  const expected = {};
  for (const x of r.failures) expected[x.check] = 'failed';
  for (const x of r.warnings) expected[x.check] = 'warning';
  for (const x of r.skipped) expected[x.check] = 'skipped';
  // One entry per check across failures, warnings and skipped.
  assert.equal(Object.keys(expected).length, r.failures.length + r.warnings.length + r.skipped.length,
    JSON.stringify(r));
  for (const { check, outcome: got } of r.checks) {
    assert.equal(got, expected[check] || 'passed', `${check}: ${JSON.stringify(r)}`);
  }
  assert.equal(outcome(r, 'git_identity'), 'passed');
  assert.equal(outcome(r, 'dirty_checkout'), 'passed');
});

test('outcomes follow each path', () => {
  const f = fixture();
  const low = fakeDoctor(f.manifest(), { fakes: { memory: { available: 3 * GB } } });
  assert.equal(outcome(low, 'memory'), 'warning');

  const linux = fakeDoctor(f.manifest(), { platform: 'linux' });
  assert.equal(outcome(linux, 'defender'), 'skipped');
  assert.equal(outcome(linux, 'python_alias'), 'skipped');

  const plain = join(f.dir, 'plain');
  mkdirSync(plain);
  const shadow = fakeDoctor(f.manifest({ mode: 'shadow', root: plain, git_dir: join(f.dir, 'no-shadow') }));
  assert.equal(outcome(shadow, 'shadow_repo'), 'failed');
  assert.equal(outcome(shadow, 'dirty_checkout'), 'skipped');

  writeFileSync(join(f.root, 'untracked.txt'), 'new\n');
  const dirty = fakeDoctor(f.manifest());
  assert.equal(outcome(dirty, 'dirty_checkout'), 'failed');
});

test('the result names its run, time and version', () => {
  const f = fixture();
  const r = fakeDoctor(f.manifest());
  assert.equal(r.run_id, 'd1');
  assert.match(r.observed_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.ok(Math.abs(Date.parse(r.observed_at) - Date.now()) < 60 * 1000, r.observed_at);
  assert.equal(r.doctor_version, readFileSync(join(SKILL_DIR, 'VERSION'), 'utf8').trim());

  const anonymous = fakeDoctor(f.manifest({}, { run_id: undefined }));
  assert.equal(anonymous.run_id, null);
  const blank = fakeDoctor(f.manifest({}, { run_id: '' }));
  assert.equal(blank.run_id, null);

  const noVersion = join(f.dir, 'no-version');
  mkdirSync(noVersion);
  assert.equal(snippet(['print(json.dumps(_doctor.read_version(sys.argv[2])))'], noVersion), 'unavailable');
});

test('a check recorded twice keeps its worst outcome', () => {
  const r = snippet([
    'report = _doctor._Report()',
    'report.warn("memory", "low")',
    'report.passed("memory")',
    'report.skip("disk", "no_worktree_root")',
    'report.fail("disk", "full", "free some space")',
    'print(json.dumps(report.result()))',
  ]);
  assert.equal(outcome(r, 'memory'), 'warning');
  assert.equal(outcome(r, 'disk'), 'failed');
  assert.equal(r.status, 'blocked');
});

test('an unrecorded check is never passed', () => {
  const r = snippet([
    'report = _doctor._Report()',
    'report.passed("memory")',
    'print(json.dumps(report.result()))',
  ]);
  assert.deepEqual(r.checks.map((c) => c.check), CHECK_NAMES);
  for (const { check, outcome: got } of r.checks) {
    if (check === 'memory') {
      assert.equal(got, 'passed');
      assert.equal(named(r.skipped, check), undefined);
    } else {
      assert.equal(got, 'skipped', check);
      assert.deepEqual(r.skipped.filter((s) => s.check === check), [{ check, reason: 'not_recorded' }]);
    }
  }
  assert.equal(r.skipped.length, 11);
  assert.equal(r.status, 'ok');
});

test('low memory and low disk warn', () => {
  const f = fixture();
  const r = fakeDoctor(f.manifest(), { fakes: { memory: { available: 3 * GB }, disk_free: 4 * GB } });
  assert.equal(r.status, 'ok', JSON.stringify(r));
  assert.match(named(r.warnings, 'memory').detail, /3\.0 GB/);
  assert.match(named(r.warnings, 'disk').detail, /4\.0 GB/);
  // The path it names uses '/', and on Windows a Git Bash worktree root
  // (/c/x) is read on its own drive.
  assert.ok(!named(r.warnings, 'disk').detail.includes('\\'), named(r.warnings, 'disk').detail);
  if (IS_WINDOWS) {
    const msysRoot = join(f.dir, 'wt').replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`);
    const msys = fakeDoctor(f.manifest({ worktree_root: msysRoot }), { fakes: { disk_free: 4 * GB } });
    const detail = named(msys.warnings, 'disk').detail;
    assert.ok(detail.toLowerCase().includes(`on the drive of ${f.dir.replace(/\\/g, '/').toLowerCase()} `), detail);
  }

  // Plenty of both: no warning.
  const quiet = fakeDoctor(f.manifest());
  assert.equal(named(quiet.warnings, 'memory'), undefined, JSON.stringify(quiet));
  assert.equal(named(quiet.warnings, 'disk'), undefined, JSON.stringify(quiet));

  // On Windows a commit charge near its limit warns too.
  const commit = fakeDoctor(f.manifest(), {
    platform: 'win32',
    fakes: { memory: { available: 16 * GB, commit_limit: 40 * GB, commit_available: 2 * GB } },
  });
  assert.match(named(commit.warnings, 'memory').detail, /commit/);

  // A read that fails is a warning with detail unknown, never a failure.
  const failed = fakeDoctor(f.manifest(), { fakes: { memory: RAISE, disk_free: null } });
  assert.equal(failed.status, 'ok', JSON.stringify(failed));
  assert.equal(named(failed.warnings, 'memory').detail, 'unknown');
  assert.equal(named(failed.warnings, 'disk').detail, 'unknown');
});

test('Windows-only checks are not_applicable elsewhere', () => {
  const f = fixture();
  const r = fakeDoctor(f.manifest(), { platform: 'linux', fakes: { load_average: [12.5, 4] } });
  assert.deepEqual(named(r.skipped, 'python_alias'), { check: 'python_alias', reason: 'not_applicable' });
  assert.deepEqual(named(r.skipped, 'defender'), { check: 'defender', reason: 'not_applicable' });
  assert.match(named(r.warnings, 'heavy_processes').detail, /load average 12\.5/);
  assert.ok(r.called.includes('load_average'), JSON.stringify(r.called));
  assert.ok(!r.called.includes('appx_working_set') && !r.called.includes('defender_exclusions'), JSON.stringify(r.called));

  // On Windows the heavy-process check reads AppXSvc instead.
  const w = fakeDoctor(f.manifest(), { platform: 'win32', fakes: { appx_working_set: 2000 * 1024 * 1024 } });
  assert.match(named(w.warnings, 'heavy_processes').detail, /AppXSvc/);
  assert.ok(!w.called.includes('load_average'), JSON.stringify(w.called));
  const calm = fakeDoctor(f.manifest(), { platform: 'win32', fakes: { appx_working_set: 400 * 1024 * 1024 } });
  assert.equal(named(calm.warnings, 'heavy_processes'), undefined, JSON.stringify(calm));
});

test('the WindowsApps python warns', () => {
  const f = fixture();
  const alias = 'C:/Users/u/AppData/Local/Microsoft/WindowsApps/python3.exe';
  const r = fakeDoctor(f.manifest({}, { python: `'${alias}'` }), { platform: 'win32' });
  assert.match(named(r.warnings, 'python_alias').detail, /WindowsApps/);

  const plain = fakeDoctor(f.manifest({}, { python: "'C:/Python312/python.exe'" }), { platform: 'win32' });
  assert.equal(named(plain.warnings, 'python_alias'), undefined, JSON.stringify(plain));
  assert.equal(named(plain.skipped, 'python_alias'), undefined, JSON.stringify(plain));
});

test('Defender never reveals the exclusion list', () => {
  const f = fixture();
  const manifest = f.manifest();
  const r = fakeDoctor(manifest, { platform: 'win32', fakes: { defender_exclusions: ['C:/Secret/Path'] } });
  assert.equal(named(r.warnings, 'defender').detail, 'not covered');
  assert.doesNotMatch(r.stdout, /Secret/);

  // An exclusion of a folder above the worktree root covers it.
  const covered = fakeDoctor(manifest, { platform: 'win32', fakes: { defender_exclusions: ['C:/Secret/Path', f.dir] } });
  assert.equal(named(covered.warnings, 'defender'), undefined, JSON.stringify(covered));
  assert.doesNotMatch(covered.stdout, /Secret/);

  for (const unreadable of [null, RAISE]) {
    const u = fakeDoctor(manifest, { platform: 'win32', fakes: { defender_exclusions: unreadable } });
    assert.equal(named(u.warnings, 'defender').detail, 'unknown');
  }
});

test('another locked run warns', () => {
  const f = fixture();
  const markers = [
    { run_id: 'm0a', manifest: '/x/m0a.json', started: '2026-10-10T00:00:00Z', status: 'running', locked: true },
    { run_id: 'm0b', manifest: '/x/m0b.json', started: '2026-10-10T00:00:00Z', status: 'stopped' },
    { run_id: 'd1', manifest: '/x/d1.json', started: '2026-10-10T00:00:00Z', status: 'running', locked: true },
  ];
  const r = fakeDoctor(f.manifest(), { fakes: { active_runs: markers } });
  const warning = named(r.warnings, 'active_runs');
  assert.match(warning.detail, /m0a/);
  assert.doesNotMatch(warning.detail, /m0b|d1/);

  // Only this run's own lock, or an unlocked marker: no warning.
  const own = fakeDoctor(f.manifest(), { fakes: { active_runs: markers.slice(1) } });
  assert.equal(named(own.warnings, 'active_runs'), undefined, JSON.stringify(own));
  const unknown = fakeDoctor(f.manifest(), { fakes: { active_runs: null } });
  assert.equal(named(unknown.warnings, 'active_runs').detail, 'unknown');
});

test('the concurrency cap warns when below lanes at once', () => {
  const f = fixture();
  const lanes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const manifest = f.manifest({}, { lanes, limits: { max_parallel_lanes: 5 } });
  const VAR = 'CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS';
  const unset = fakeDoctor(manifest, { env: { [VAR]: null } });
  assert.match(named(unset.warnings, 'concurrency').detail, /unset/);
  const enough = fakeDoctor(manifest, { env: { [VAR]: '8' } });
  assert.equal(named(enough.warnings, 'concurrency'), undefined, JSON.stringify(enough));
  const low = fakeDoctor(manifest, { env: { [VAR]: '2' } });
  assert.match(named(low.warnings, 'concurrency').detail, /2.*3/);
  // max_parallel_lanes caps the lanes at once.
  const capped = fakeDoctor(f.manifest({}, { lanes, limits: { max_parallel_lanes: 2 } }), { env: { [VAR]: '2' } });
  assert.equal(named(capped.warnings, 'concurrency'), undefined, JSON.stringify(capped));
});

test('real probes run on this platform without error', () => {
  const f = fixture();
  const active = join(f.dir, 'active');
  const env = { ...ENV, PL_ACTIVE_DIR: active };
  delete env.CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS;
  const r = doctor(f.manifest(), { env });
  assert.equal(r.code, 0, r.stderr + r.stdout);
  // The cap is unset here, so the warning checks did run.
  assert.match(named(r.out.warnings, 'concurrency').detail, /unset/);
  for (const check of WARNING_CHECKS) {
    assert.equal(named(r.out.failures, check), undefined, JSON.stringify(r.out));
    const entries = [...r.out.warnings, ...r.out.skipped].filter((x) => x.check === check);
    assert.ok(entries.length <= 1, JSON.stringify(r.out));
  }
  if (process.platform !== 'win32') {
    for (const check of ['python_alias', 'defender']) {
      assert.deepEqual(named(r.out.skipped, check), { check, reason: 'not_applicable' });
    }
  }
  // No other run is locked in the empty active dir.
  assert.equal(named(r.out.warnings, 'active_runs'), undefined, JSON.stringify(r.out));
});
