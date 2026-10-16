import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  realpathSync,
  rmSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { BASH, samePath, tempDir, mergeEnv, IS_WINDOWS } from './platform.mjs';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const TMP = realpathSync(tempDir('pl-task-helpers-'));
// How start-task prints a path it was given: the C:/ form on Windows.
const shown = (p) => (IS_WINDOWS ? p.replace(/\\/g, '/') : p);
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

function sh(cmd, args, extraEnv = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    env: mergeEnv(process.env, GIT_ENV, extraEnv),
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

// git's own output, trimmed, with CRLF line ends (if any) read as LF.
function git(dir, ...args) {
  const res = sh('git', ['-C', dir, ...args]);
  assert.equal(res.code, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.replace(/\r\n/g, '\n').trim();
}

// Asserts that text is the expected lines, each ending in a newline, where
// the lines named in paths are compared as paths.
function assertLines(text, expected, paths) {
  assert.ok(text.endsWith('\n'), text);
  const lines = text.slice(0, -1).split('\n');
  assert.equal(lines.length, expected.length, text);
  expected.forEach((want, i) => {
    if (paths.includes(i)) assert.ok(samePath(lines[i], want), `${lines[i]} is not ${want}`);
    else assert.equal(lines[i], want);
  });
}

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function commit(dir, rel, content, message) {
  write(join(dir, rel), content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

const script = (name) => (...args) => sh('python3', [join(SCRIPTS, name), ...args]);
// The same scripts run with extra environment variables.
const scriptEnv = (name) => (env, ...args) => sh('python3', [join(SCRIPTS, name), ...args], env);
const startTask = script('start-task');
const finishTask = script('finish-task');
const taskBrief = script('task-brief');
const ledger = script('ledger');

const PLAN = [
  '# Plan',
  '',
  '### Task T1: First',
  '',
  'Body of task T1.',
  '',
  '### Task T2: Second',
  '',
  'Body of task T2.',
  '',
].join('\n');

let counter = 0;
// A fresh case whose paths contain spaces: a project on main with one commit,
// a feature branch from main, a lane worktree on branch lane-a from feature,
// a plan with T1 and T2, and a ledger directory path.
function newCase() {
  counter += 1;
  const root = join(TMP, `case ${counter}`);
  const project = join(root, 'my project');
  const lane = join(root, 'lane wt');
  mkdirSync(project, { recursive: true });
  git(project, 'init', '-q', '-b', 'main');
  const initial = commit(project, 'a.txt', 'hello\n', 'init');
  git(project, 'branch', 'feature');
  git(project, 'worktree', 'add', '-q', '-b', 'lane-a', lane, 'feature');
  const plan = join(root, 'plan dir', 'plan.md');
  write(plan, PLAN);
  return { root, project, lane, plan, initial, ledgerDir: join(root, 'ledger dir') };
}

// An unrelated repo on main with one commit, and the variables that would
// redirect git to it.
function otherRepoEnv(c) {
  const other = join(c.root, 'other repo');
  mkdirSync(other, { recursive: true });
  git(other, 'init', '-q', '-b', 'main');
  commit(other, 'o.txt', 'other\n', 'other init');
  return {
    other,
    env: {
      GIT_DIR: join(other, '.git'),
      GIT_WORK_TREE: other,
      GIT_INDEX_FILE: join(other, '.git', 'index'),
      GIT_OBJECT_DIRECTORY: join(other, '.git', 'objects'),
      GIT_COMMON_DIR: join(other, '.git'),
    },
  };
}

function done(c) {
  const res = ledger('status', c.ledgerDir);
  assert.equal(res.code, 0, res.stderr);
  return JSON.parse(res.stdout).done;
}

// --- start-task ----------------------------------------------------------------

test('start-task regenerates and prints each brief', () => {
  const c = newCase();
  const out1 = join(c.root, 'briefs dir', 'T1.md');
  const out2 = join(c.root, 'briefs dir', 'T2.md');
  write(out1, 'stale\n');
  const res = startTask(c.lane, c.plan, '--brief', 'T1', out1, '--brief', 'T2', out2);
  assert.equal(res.code, 0, res.stderr);
  const head = git(c.lane, 'rev-parse', 'HEAD');
  assert.ok(res.stdout.startsWith(`branch: lane-a\nhead: ${head}\n`), res.stdout);
  for (const [id, out] of [['T1', out1], ['T2', out2]]) {
    const ref = join(c.root, 'ref', `${id}.md`);
    assert.equal(taskBrief(c.plan, id, ref).code, 0);
    const expected = readFileSync(ref, 'utf8');
    assert.equal(readFileSync(out, 'utf8'), expected);
    assert.ok(expected.includes(`Body of task ${id}.`));
    assert.ok(res.stdout.includes(`===== brief ${id}: ${shown(out)} =====\n${expected}`), res.stdout);
  }
  assert.ok(res.stdout.indexOf('brief T1') < res.stdout.indexOf('brief T2'));
});

test("start-task passes --also to the named task's brief only", () => {
  const c = newCase();
  write(c.plan, [
    PLAN,
    '### Task P: Producer',
    '',
    'Body of task P.',
    '',
    '- Produces: `made()` returns 7.',
    '',
  ].join('\n'));
  const out1 = join(c.root, 'briefs', 'T1.md');
  const out2 = join(c.root, 'briefs', 'T2.md');
  const res = startTask(
    c.lane, c.plan, '--brief', 'T1', out1, '--brief', 'T2', out2, '--also', 'T2', 'P',
  );
  assert.equal(res.code, 0, res.stderr);
  const appended = [
    '## Produces of Task P: Producer (consumed by this task)',
    '',
    '- Produces: `made()` returns 7.',
    '',
  ].join('\n');
  const text2 = readFileSync(out2, 'utf8');
  assert.ok(text2.endsWith(`\n\n${appended}`), text2);
  assert.ok(!readFileSync(out1, 'utf8').includes('## Produces of Task P'));
  assert.ok(res.stdout.includes(`===== brief T2: ${shown(out2)} =====\n${text2}`), res.stdout);
});

test('start-task exits 2 for --also naming a task without --brief', () => {
  const c = newCase();
  const head = git(c.lane, 'rev-parse', 'HEAD');
  git(c.project, 'checkout', '-q', 'feature');
  commit(c.project, 'b.txt', 'prelude\n', 'prelude');
  const out = join(c.root, 'briefs', 'T1.md');
  const res = startTask(
    c.lane, c.plan, '--sync', 'feature', '--brief', 'T1', out, '--also', 'T2', 'T1',
  );
  assert.equal(res.code, 2);
  assert.match(res.stderr, /T2/);
  assert.equal(existsSync(out), false);
  assert.equal(git(c.lane, 'rev-parse', 'HEAD'), head);
});

test('start-task --sync fast-forwards the worktree first', () => {
  const c = newCase();
  git(c.project, 'checkout', '-q', 'feature');
  const tip = commit(c.project, 'b.txt', 'prelude\n', 'prelude');
  assert.notEqual(git(c.lane, 'rev-parse', 'HEAD'), tip);
  const out = join(c.root, 'briefs', 'T1.md');
  const res = startTask(c.lane, c.plan, '--sync', 'feature', '--brief', 'T1', out);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(git(c.lane, 'rev-parse', 'HEAD'), tip);
  assert.ok(res.stdout.includes(`\nhead: ${tip}\n`), res.stdout);
  assert.ok(!res.stdout.includes('Fast-forward'), res.stdout);
});

test('start-task --sync exits 3 when the fast-forward fails and writes no brief', () => {
  const c = newCase();
  commit(c.lane, 'lane.txt', 'lane\n', 'lane work');
  git(c.project, 'checkout', '-q', 'feature');
  commit(c.project, 'b.txt', 'prelude\n', 'prelude');
  const out = join(c.root, 'briefs', 'T1.md');
  const res = startTask(c.lane, c.plan, '--sync', 'feature', '--brief', 'T1', out);
  assert.equal(res.code, 3);
  assert.match(res.stderr, /fast-forward/);
  assert.equal(existsSync(out), false);
});

test('start-task --sync reads a value starting with a dash as a branch, not an option', () => {
  const c = newCase();
  const head = git(c.lane, 'rev-parse', 'HEAD');
  const out = join(c.root, 'briefs', 'T1.md');
  const res = startTask(c.lane, c.plan, '--sync=--no-ff', '--brief', 'T1', out);
  assert.equal(res.code, 3);
  assert.match(res.stderr, /--no-ff - not something we can merge/);
  assert.equal(git(c.lane, 'rev-parse', 'HEAD'), head);
  assert.equal(existsSync(out), false);
});

test('start-task exits 3 for a task with no heading', () => {
  const c = newCase();
  const out = join(c.root, 'briefs', 'T9.md');
  const res = startTask(c.lane, c.plan, '--brief', 'T9', out);
  assert.equal(res.code, 3);
  assert.match(res.stderr, /T9/);
  assert.equal(existsSync(out), false);
});

test('start-task --package runs the package script in DIR and prints its output', () => {
  const c = newCase();
  const pkg = join(c.root, 'tools dir', 'package.sh');
  write(pkg, '{ pwd; printf "%s\\n" "$@"; } > "$4"\necho "$4"\n');
  const out = join(c.root, 'review dir', 'nested', 'package.md');
  assert.equal(existsSync(dirname(out)), false);
  const brief = join(c.root, 'briefs', 'T1.md');
  const res = startTask(
    c.lane, c.plan, '--package', pkg, 'BASE', 'HEAD', out, '--brief', 'T1', brief,
  );
  assert.equal(res.code, 0, res.stderr);
  assertLines(readFileSync(out, 'utf8'), [c.lane, c.plan, 'BASE', 'HEAD', out], [0, 1, 4]);
  const marker = '===== review package =====\n';
  assert.ok(res.stdout.includes(marker), res.stdout);
  assertLines(res.stdout.slice(res.stdout.lastIndexOf(marker) + marker.length), [out], [0]);
  assert.ok(res.stdout.indexOf('===== brief T1') < res.stdout.indexOf('===== review package'));
});

test('start-task runs the package script with the resolved bash', { skip: IS_WINDOWS && 'a fake bash script cannot stand in for bash.exe on Windows (find_bash is unit-tested in tests/platform.test.mjs)' }, () => {
  const c = newCase();
  const realBash = sh(BASH, ['-c', 'command -v bash']).stdout.trim();
  const calls = join(c.root, 'calls');
  const fake = join(c.root, 'fake bin', 'bash');
  write(fake, `#!${realBash}\nprintf '%s\\n' "$*" >> '${calls}'\nexec '${realBash}' "$@"\n`);
  chmodSync(fake, 0o755);
  const pkg = join(c.root, 'tools dir', 'package.sh');
  write(pkg, 'echo packaged\n');
  const out = join(c.root, 'review dir', 'package.md');
  const brief = join(c.root, 'briefs', 'T1.md');
  const res = scriptEnv('start-task')(
    { PATH: `${dirname(fake)}${delimiter}${process.env.PATH}` },
    c.lane, c.plan, '--package', pkg, 'BASE', 'HEAD', out, '--brief', 'T1', brief,
  );
  assert.equal(res.code, 0, res.stderr);
  assert.ok(res.stdout.endsWith('===== review package =====\npackaged\n'), res.stdout);
  assert.deepEqual(readFileSync(calls, 'utf8').split('\n'), [`${pkg} ${c.plan} BASE HEAD ${out}`, '']);
});

test('start-task exits 1 when the package script fails', () => {
  const c = newCase();
  const pkg = join(c.root, 'tools dir', 'package.sh');
  write(pkg, 'echo broken >&2\nexit 5\n');
  const out = join(c.root, 'review dir', 'package.md');
  const brief = join(c.root, 'briefs', 'T1.md');
  const res = startTask(
    c.lane, c.plan, '--package', pkg, 'BASE', 'HEAD', out, '--brief', 'T1', brief,
  );
  assert.equal(res.code, 1);
  assert.match(res.stderr, /broken/);
});

test('start-task ignores GIT_DIR and friends pointing at another repo', () => {
  const c = newCase();
  git(c.project, 'checkout', '-q', 'feature');
  const tip = commit(c.project, 'b.txt', 'prelude\n', 'prelude');
  const { other, env } = otherRepoEnv(c);
  const otherHead = git(other, 'rev-parse', 'HEAD');
  const pkg = join(c.root, 'tools dir', 'package.sh');
  write(pkg, '{ git rev-parse --show-toplevel; printf "%s\\n" "${GIT_DIR-unset}"; } > "$4"\necho "$4"\n');
  const out = join(c.root, 'review dir', 'package.md');
  const brief = join(c.root, 'briefs', 'T1.md');
  const res = scriptEnv('start-task')(
    env, c.lane, c.plan, '--sync', 'feature',
    '--package', pkg, 'BASE', 'HEAD', out, '--brief', 'T1', brief,
  );
  assert.equal(res.code, 0, res.stderr);
  assert.ok(res.stdout.startsWith(`branch: lane-a\nhead: ${tip}\n`), res.stdout);
  assert.equal(git(c.lane, 'rev-parse', 'HEAD'), tip);
  assert.equal(git(other, 'rev-parse', 'HEAD'), otherHead);
  assertLines(readFileSync(out, 'utf8'), [c.lane, 'unset'], [0]);
});

test('start-task --record-start records the task base for every briefed task before any work', () => {
  const c = newCase();
  const out1 = join(c.root, 'briefs', 'T1.md');
  const out2 = join(c.root, 'briefs', 'T2.md');
  const res = startTask(c.lane, c.plan, '--record-start', c.ledgerDir, 'lane-a', 'HEAD',
    '--brief', 'T1', out1, '--brief', 'T2', out2);
  assert.equal(res.code, 0, res.stderr);
  const events = readFileSync(join(c.ledgerDir, 'lane-a.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(events, [
    { task: 'T1', event: 'started', base: c.initial },
    { task: 'T2', event: 'started', base: c.initial },
  ]);
  const bad = startTask(c.lane, c.plan, '--record-start', join(c.root, 'other ledger'), 'lane-a', '0'.repeat(40),
    '--brief', 'T1', out1);
  assert.equal(bad.code, 3);
  assert.ok(!existsSync(join(c.root, 'other ledger')), 'a refused start records nothing');
});

test('start-task --scope lists the files a range changes outside the declared ones', () => {
  const c = newCase();
  const base = git(c.lane, 'rev-parse', 'HEAD');
  write(join(c.lane, 'src', 'a.js'), 'a\n');
  write(join(c.lane, 'src', 'b.js'), 'b\n');
  git(c.lane, 'add', '-A');
  git(c.lane, 'commit', '-q', '-m', 'work');
  git(c.lane, 'mv', 'a.txt', 'moved.txt');
  git(c.lane, 'commit', '-q', '-m', 'rename');
  const head = git(c.lane, 'rev-parse', 'HEAD');
  const out = join(c.root, 'briefs', 'T1.md');
  const res = startTask(c.lane, c.plan, '--scope', base, head, '--declared', './SRC/a.js', '--declared', 'moved.txt',
    '--brief', 'T1', out);
  assert.equal(res.code, 0, res.stderr);
  // A rename changes both paths; the declared ones match normalized and
  // case-insensitively.
  assert.ok(res.stdout.endsWith('===== files changed outside the task\'s Files list =====\na.txt\nsrc/b.js\n'), res.stdout);
  const none = startTask(c.lane, c.plan, '--scope', base, head, '--declared', 'src/a.js', '--declared', 'src/b.js',
    '--declared', 'a.txt', '--declared', 'moved.txt', '--brief', 'T1', out);
  assert.ok(none.stdout.endsWith("===== files changed outside the task's Files list =====\n(none)\n"), none.stdout);
  assert.equal(startTask(c.lane, c.plan, '--scope', base, head, '--brief', 'T1', out).code, 2);
});

test('start-task --owners names the owner of each changed path, and shared declared files', () => {
  const c = newCase();
  const base = git(c.lane, 'rev-parse', 'HEAD');
  write(join(c.lane, 'src', 'a.js'), 'a\n');
  write(join(c.lane, 'src', 'b.js'), 'b\n');
  write(join(c.lane, 'shared.css'), 's\n');
  git(c.lane, 'add', '-A');
  git(c.lane, 'commit', '-q', '-m', 'work');
  const head = git(c.lane, 'rev-parse', 'HEAD');
  const owners = join(c.root, 'owners.json');
  write(owners, JSON.stringify({
    repo: {}, tasks: { T1: { where: 'alpha', pos: 0 }, T2: { where: 'beta', pos: 0 }, T5: { where: 'join', pos: 0 } },
    files: { 'src/a.js': ['T1'], 'src/b.js': ['T2'], 'shared.css': ['T1', 'T5'] },
  }));
  const out = join(c.root, 'briefs', 'T1.md');
  const res = startTask(c.lane, c.plan, '--scope', base, head, '--declared', 'src/a.js', '--declared', 'shared.css',
    '--owners', owners, '--brief', 'T1', out);
  assert.equal(res.code, 0, res.stderr);
  assert.ok(res.stdout.endsWith("===== files changed outside the task's Files list =====\n"
    + "src/b.js (owned by T2, another lane, running alongside)\n"
    + "shared.css (in your Files list; also in T5's Files)\n"), res.stdout);
});

// The engine's fingerprint of a declared list, as _owners.fingerprint computes
// it. Non-ASCII characters go to Python as JSON escapes.
function fp(paths) {
  const json = JSON.stringify(paths).replace(/[^\x00-\x7f]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const res = sh('python3', ['-B', '-c',
    'import json, sys; sys.dont_write_bytecode = True; sys.path.insert(0, sys.argv[1]); '
    + 'import _owners; print(_owners.fingerprint(json.loads(sys.argv[2])))', SCRIPTS, json]);
  assert.equal(res.code, 0, res.stderr);
  return res.stdout.trim();
}

// The --owners test's repo and owner map, with T1's declared list added.
function ownersCase(declared = ['src/a.js', 'shared.css']) {
  const c = newCase();
  const base = git(c.lane, 'rev-parse', 'HEAD');
  write(join(c.lane, 'src', 'a.js'), 'a\n');
  write(join(c.lane, 'src', 'b.js'), 'b\n');
  write(join(c.lane, 'shared.css'), 's\n');
  git(c.lane, 'add', '-A');
  git(c.lane, 'commit', '-q', '-m', 'work');
  const head = git(c.lane, 'rev-parse', 'HEAD');
  const owners = join(c.root, 'owners.json');
  write(owners, JSON.stringify({
    repo: {},
    tasks: {
      T1: { where: 'alpha', pos: 0, declared },
      T2: { where: 'beta', pos: 0, declared: ['src/b.js'] },
      T5: { where: 'join', pos: 0, declared: ['shared.css'] },
    },
    files: { 'src/a.js': ['T1'], 'src/b.js': ['T2'], 'shared.css': ['T1', 'T5'] },
  }));
  return { ...c, base, head, owners, out: join(c.root, 'briefs', 'T1.md') };
}

const COULD_NOT = "===== files changed outside the task's Files list =====\n"
  + "(could not build the list: the run's owner map does not match this unit's Files list; judge scope from the brief)\n";

test('start-task --declared-from-owners prints the scope block --declared prints', () => {
  const c = ownersCase();
  const listed = startTask(c.lane, c.plan, '--scope', c.base, c.head, '--declared', 'src/a.js', '--declared', 'shared.css',
    '--owners', c.owners, '--brief', 'T1', c.out);
  const fromOwners = startTask(c.lane, c.plan, '--scope', c.base, c.head, '--declared-from-owners', fp(['src/a.js', 'shared.css']),
    '--owners', c.owners, '--brief', 'T1', c.out);
  assert.equal(listed.code, 0, listed.stderr);
  assert.equal(fromOwners.code, 0, fromOwners.stderr);
  assert.equal(fromOwners.stdout, listed.stdout);
  assert.ok(fromOwners.stdout.endsWith("===== files changed outside the task's Files list =====\n"
    + "src/b.js (owned by T2, another lane, running alongside)\n"
    + "shared.css (in your Files list; also in T5's Files)\n"), fromOwners.stdout);
});

test('start-task --declared-from-owners keeps a path with a quote, a space and non-ASCII', () => {
  const quoted = "docs/it's here.md";
  const accented = 'caf\u{e9} menu.txt';
  const c = ownersCase([quoted]);
  write(join(c.lane, 'docs', "it's here.md"), 'q\n');
  write(join(c.lane, accented), 'c\n');
  git(c.lane, 'add', '-A');
  git(c.lane, 'commit', '-q', '-m', 'more work');
  const head = git(c.lane, 'rev-parse', 'HEAD');
  const res = startTask(c.lane, c.plan, '--scope', c.head, head, '--declared-from-owners', fp([quoted]),
    '--owners', c.owners, '--brief', 'T1', c.out);
  assert.equal(res.code, 0, res.stderr);
  assert.ok(res.stdout.endsWith("===== files changed outside the task's Files list =====\n"
    + `${accented} (no task owns it)\n`), res.stdout);
  assert.ok(!res.stdout.includes('here.md ('), res.stdout);
});

test('start-task goes on when the owner map does not match', () => {
  const c = ownersCase();
  const torn = join(c.root, 'torn owners.json');
  write(torn, '{"tasks":');
  const cases = [
    ['a wrong fingerprint', c.owners, fp(['src/a.js'])],
    ['a missing owners file', join(c.root, 'no-such-owners.json'), fp(['src/a.js', 'shared.css'])],
    ['an unreadable owners file', torn, fp(['src/a.js', 'shared.css'])],
  ];
  for (const [what, owners, value] of cases) {
    rmSync(c.out, { force: true });
    const res = startTask(c.lane, c.plan, '--scope', c.base, c.head, '--declared-from-owners', value,
      '--owners', owners, '--brief', 'T1', c.out);
    assert.equal(res.code, 0, `${what}: ${res.stderr}`);
    assert.ok(existsSync(c.out), `${what}: the brief is written`);
    assert.ok(res.stdout.includes(`===== brief T1: ${shown(c.out)} =====\n`), `${what}: ${res.stdout}`);
    assert.ok(res.stdout.endsWith(COULD_NOT), `${what}: ${res.stdout}`);
  }
});

test('start-task --declared-from-owners usage errors exit 2', () => {
  const c = ownersCase();
  const value = fp(['src/a.js', 'shared.css']);
  const calls = [
    ['without --owners', '--scope', c.base, c.head, '--declared-from-owners', value],
    ['with --declared', '--scope', c.base, c.head, '--declared-from-owners', value, '--declared', 'src/a.js',
      '--owners', c.owners],
    ['with a zero count', '--scope', c.base, c.head, '--declared-from-owners', '0:811c9dc5', '--owners', c.owners],
    ['with a trailing newline', '--scope', c.base, c.head, '--declared-from-owners', `${value}\n`, '--owners', c.owners],
    ['without --scope', '--declared-from-owners', value, '--owners', c.owners],
  ];
  for (const [what, ...args] of calls) {
    const res = startTask(c.lane, c.plan, ...args, '--brief', 'T1', c.out);
    assert.equal(res.code, 2, `${what}: ${res.stderr}`);
    assert.equal(res.stdout, '', what);
  }
});

test('start-task still starts without an owner map, or when the rulings print fails', () => {
  const c = newCase();
  const base = git(c.lane, 'rev-parse', 'HEAD');
  write(join(c.lane, 'src', 'b.js'), 'b\n');
  git(c.lane, 'add', '-A');
  git(c.lane, 'commit', '-q', '-m', 'work');
  const head = git(c.lane, 'rev-parse', 'HEAD');
  const out = join(c.root, 'briefs', 'T1.md');
  const res = startTask(c.lane, c.plan, '--scope', base, head, '--declared', 'src/a.js',
    '--owners', join(c.root, 'no-such-owners.json'), '--brief', 'T1', out);
  assert.equal(res.code, 0, res.stderr);
  assert.ok(res.stdout.endsWith("===== files changed outside the task's Files list =====\nsrc/b.js\n"), res.stdout);
  // A torn ledger line makes ledger rulings fail: the agent still starts and sees why.
  const ledgerDir = join(c.root, 'torn ledger');
  write(join(ledgerDir, 'alpha.jsonl'), '{"task":\n');
  const torn = startTask(c.lane, c.plan, '--rulings', ledgerDir, 'alpha', '--brief', 'T1', out);
  assert.equal(torn.code, 0, torn.stderr);
  assert.match(torn.stdout, /===== rulings in force =====\n\(could not read the rulings: [^\n]+\)\n/);
});

test('start-task --rulings prints the rulings in force for the lane', () => {
  const c = newCase();
  const ledgerDir = join(c.root, 'ledger');
  const append = (lane, entry) => assert.equal(script('ledger')('append', ledgerDir, lane, JSON.stringify(entry)).code, 0);
  append('alpha', { task: 'T1', event: 'ruling', by: 'implementer', text: 'MINE' });
  append('beta', { task: 'T2', event: 'ruling', by: 'implementer', text: 'THEIRS' });
  const out = join(c.root, 'briefs', 'T1.md');
  const res = startTask(c.lane, c.plan, '--rulings', ledgerDir, 'alpha', '--brief', 'T1', out);
  assert.equal(res.code, 0, res.stderr);
  assert.ok(res.stdout.includes('===== rulings in force =====\nalpha-R1 [implementer, T1, lane] MINE\n'), res.stdout);
  assert.ok(!res.stdout.includes('THEIRS'), res.stdout);
  const all = startTask(c.lane, c.plan, '--rulings', ledgerDir, '-', '--brief', 'T1', out);
  assert.ok(all.stdout.includes('THEIRS'), all.stdout);
});

test('start-task without --brief exits 2', () => {
  const c = newCase();
  const res = startTask(c.lane, c.plan);
  assert.equal(res.code, 2);
  assert.equal(res.stdout, '');
});

// --- finish-task ---------------------------------------------------------------

test('finish-task records every task\'s commits and prints head and changed_lines', () => {
  const c = newCase();
  const from = git(c.lane, 'rev-parse', 'HEAD');
  const first = commit(c.lane, 'b.txt', 'x\ny\n', 'add b');
  const second = commit(c.lane, 'a.txt', 'world\n', 'change a');
  const res = finishTask(
    c.lane, 'lane-a', from, c.ledgerDir, 'a',
    '--task', 'T1', '--task', 'T2',
    '--commit', first.slice(0, 10), '--commit', second,
  );
  assert.equal(res.code, 0, res.stderr);
  const lines = res.stdout.trim().split('\n');
  assert.equal(lines.length, 1, res.stdout);
  assert.deepEqual(JSON.parse(lines[0]), {
    base: from,
    head: second,
    changed_lines: 4,
    commits: [first, second],
    branch: 'lane-a',
  });
  assert.deepEqual(done(c), ['T1', 'T2']);
  const entries = readFileSync(join(c.ledgerDir, 'a.jsonl'), 'utf8').trim().split('\n');
  assert.deepEqual(entries.map((l) => JSON.parse(l)), [
    { task: 'T1', event: 'committed', base: from, head: second, commits: [first, second] },
    { task: 'T2', event: 'committed', base: from, head: second, commits: [first, second] },
  ]);
});

test('finish-task refuses the wrong branch and records nothing', () => {
  const c = newCase();
  const from = git(c.lane, 'rev-parse', 'HEAD');
  const sha = commit(c.lane, 'b.txt', 'x\n', 'add b');
  const res = finishTask(
    c.lane, 'lane-b', from, c.ledgerDir, 'a', '--task', 'T1', '--commit', sha,
  );
  assert.equal(res.code, 3);
  assert.match(res.stderr, /lane-b/);
  assert.equal(res.stdout, '');
  assert.deepEqual(done(c), []);
});

test('finish-task refuses a commit outside FROM..HEAD', () => {
  const c = newCase();
  commit(c.lane, 'b.txt', 'x\n', 'base work');
  const from = git(c.lane, 'rev-parse', 'HEAD');
  const sha = commit(c.lane, 'c.txt', 'y\n', 'task work');
  for (const outside of [from, c.initial]) {
    const res = finishTask(
      c.lane, 'lane-a', from, c.ledgerDir, 'a',
      '--task', 'T1', '--commit', sha, '--commit', outside,
    );
    assert.equal(res.code, 3, outside);
    assert.equal(res.stdout, '');
    assert.deepEqual(done(c), []);
  }
});

test('finish-task refuses an unknown sha', () => {
  const c = newCase();
  const from = git(c.lane, 'rev-parse', 'HEAD');
  const sha = commit(c.lane, 'b.txt', 'x\n', 'add b');
  for (const args of [
    [from, '--commit', sha, '--commit', 'deadbeefdeadbeef'],
    ['deadbeefdeadbeef', '--commit', sha],
  ]) {
    const [fromArg, ...rest] = args;
    const res = finishTask(c.lane, 'lane-a', fromArg, c.ledgerDir, 'a', '--task', 'T1', ...rest);
    assert.equal(res.code, 3, args.join(' '));
    assert.equal(res.stdout, '');
    assert.deepEqual(done(c), []);
  }
});

test('finish-task refuses an unsafe lane or a ledger path that is not a directory, recording nothing', () => {
  const c = newCase();
  const from = git(c.lane, 'rev-parse', 'HEAD');
  const sha = commit(c.lane, 'b.txt', 'x\n', 'add b');
  const bad = finishTask(c.lane, 'lane-a', from, c.ledgerDir, '../a', '--task', 'T1', '--task', 'T2', '--commit', sha);
  assert.equal(bad.code, 3);
  assert.match(bad.stderr, /unsafe lane name/);
  assert.equal(bad.stdout, '');
  assert.deepEqual(done(c), []);
  const file = join(c.root, 'ledger file');
  write(file, '');
  const res = finishTask(c.lane, 'lane-a', from, file, 'a', '--task', 'T1', '--commit', sha);
  assert.equal(res.code, 3);
  assert.match(res.stderr, /not a directory/);
  assert.equal(res.stdout, '');
  assert.equal(readFileSync(file, 'utf8'), '');
});

// Review finding 5: an interrupted implementer leaves commit A unrecorded; the
// retry makes B and lists only B. The ledger must still hold the task's real
// base and every commit since it, read from git.
test('finish-task records the whole FROM..HEAD range even when only the last commit is listed', () => {
  const c = newCase();
  const from = git(c.lane, 'rev-parse', 'HEAD');
  const a = commit(c.lane, 'b.txt', 'x\n', 'commit A (unrecorded attempt)');
  const b = commit(c.lane, 'c.txt', 'y\n', 'commit B (the retry)');
  const res = finishTask(c.lane, 'lane-a', from, c.ledgerDir, 'a', '--task', 'T1', '--commit', b);
  assert.equal(res.code, 0, res.stderr);
  const [entry] = readFileSync(join(c.ledgerDir, 'a.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(entry, { task: 'T1', event: 'committed', base: from, head: b, commits: [a, b] });
});

test('finish-task without --commit records the range git lists', () => {
  const c = newCase();
  const from = git(c.lane, 'rev-parse', 'HEAD');
  const a = commit(c.lane, 'b.txt', 'x\n', 'add b');
  const res = finishTask(c.lane, 'lane-a', from, c.ledgerDir, 'a', '--task', 'T1');
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout).commits, [a]);
  assert.deepEqual(done(c), ['T1']);
});

test('finish-task with no commit since FROM exits 3 and records nothing', () => {
  const c = newCase();
  const from = git(c.lane, 'rev-parse', 'HEAD');
  const res = finishTask(c.lane, 'lane-a', from, c.ledgerDir, 'a', '--task', 'T1');
  assert.equal(res.code, 3);
  assert.match(res.stderr, /no commits/);
  assert.deepEqual(done(c), []);
});

test('finish-task refuses a FROM that is not an ancestor of HEAD', () => {
  const c = newCase();
  git(c.project, 'switch', '-q', 'main');
  const elsewhere = commit(c.project, 'z.txt', 'z\n', 'on main only');
  commit(c.lane, 'b.txt', 'x\n', 'add b');
  const res = finishTask(c.lane, 'lane-a', elsewhere, c.ledgerDir, 'a', '--task', 'T1');
  assert.equal(res.code, 3);
  assert.match(res.stderr, /not an ancestor/);
  assert.deepEqual(done(c), []);
});

test('finish-task --settled records the range from git, even an empty one', () => {
  const c = newCase();
  const from = git(c.lane, 'rev-parse', 'HEAD');
  const empty = finishTask(c.lane, 'lane-a', from, c.ledgerDir, 'a', '--task', 'T1', '--settled', 'park');
  assert.equal(empty.code, 0, empty.stderr);
  const partial = commit(c.lane, 'b.txt', 'x\n', 'partial work before a block');
  const res = finishTask(c.lane, 'lane-a', from, c.ledgerDir, 'a', '--task', 'T2', '--settled', 'unblock');
  assert.equal(res.code, 0, res.stderr);
  const entries = readFileSync(join(c.ledgerDir, 'a.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(entries, [
    { task: 'T1', event: 'settled', outcome: 'park', base: from, head: from, commits: [] },
    { task: 'T2', event: 'settled', outcome: 'unblock', base: from, head: partial, commits: [partial] },
  ]);
});

test('finish-task ignores GIT_DIR and friends pointing at another repo', () => {
  const c = newCase();
  const from = git(c.lane, 'rev-parse', 'HEAD');
  const sha = commit(c.lane, 'b.txt', 'x\ny\n', 'add b');
  const { env } = otherRepoEnv(c);
  const res = scriptEnv('finish-task')(
    env, c.lane, 'lane-a', from, c.ledgerDir, 'a', '--task', 'T1', '--commit', sha,
  );
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), {
    base: from,
    head: sha,
    changed_lines: 2,
    commits: [sha],
    branch: 'lane-a',
  });
  assert.deepEqual(done(c), ['T1']);
});

// ---- 1.6.5: start-task --unit-branch (a join wave unit in a lane worktree) ----

const briefOut = (c, id = 'T1') => join(c.root, 'briefs', `${id}.md`);
const abandoned = (c) => git(c.project, 'for-each-ref', '--format=%(refname)', 'refs/parallel-lanes/r1/abandoned')
  .split('\n').filter(Boolean);
const unitStart = (c, ...extra) => startTask(c.lane, c.plan, '--unit-branch', 'pl-r1-u-T1', c.initial,
  '--run-id', 'r1', ...extra, '--brief', 'T1', briefOut(c));

test('a new unit branch is created at SHA', () => {
  const c = newCase();
  commit(c.lane, 'lane.txt', 'lane work\n', 'lane work');
  const res = unitStart(c);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(git(c.lane, 'rev-parse', '--abbrev-ref', 'HEAD'), 'pl-r1-u-T1');
  assert.equal(git(c.lane, 'rev-parse', 'HEAD'), c.initial);
  assert.match(res.stdout, /^branch: pl-r1-u-T1\n/);
  assert.match(res.stdout, /\nunit branch: pl-r1-u-T1 \(created\)\n/);
  assert.equal(git(c.lane, 'rev-parse', 'lane-a') === c.initial, false, 'the lane branch keeps its commit');
});

test('switching saves uncommitted work under abandoned refs', () => {
  const c = newCase();
  write(join(c.lane, 'a.txt'), 'edited\n');
  write(join(c.lane, 'new.txt'), 'untracked\n');
  const res = unitStart(c);
  assert.equal(res.code, 0, res.stderr);
  const refs = abandoned(c);
  assert.equal(refs.length, 1);
  assert.equal(git(c.project, 'show', `${refs[0]}:new.txt`), 'untracked');
  assert.equal(git(c.project, 'show', `${refs[0]}:a.txt`), 'edited');
  assert.equal(git(c.lane, 'status', '--porcelain'), '');
  assert.match(res.stdout, new RegExp(`\\nsaved: ${refs[0]} \\([0-9a-f]{40}\\)\\n`));
  assert.match(res.stdout, /\nunit branch: pl-r1-u-T1 \(created\)\n/);
});

test('a retry on the same unit branch keeps uncommitted work', () => {
  const c = newCase();
  assert.equal(unitStart(c).code, 0);
  const head = commit(c.lane, 'unit.txt', 'unit work\n', 'unit work');
  write(join(c.lane, 'wip.txt'), 'in progress\n');
  const res = unitStart(c);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /\nunit branch: pl-r1-u-T1 \(kept\)\n/);
  assert.equal(git(c.lane, 'rev-parse', 'HEAD'), head);
  assert.equal(readFileSync(join(c.lane, 'wip.txt'), 'utf8'), 'in progress\n');
  assert.deepEqual(abandoned(c), []);
});

test('switching back to an existing unit branch keeps its commits', () => {
  const c = newCase();
  assert.equal(unitStart(c).code, 0);
  const head = commit(c.lane, 'unit.txt', 'unit work\n', 'unit work');
  git(c.lane, 'checkout', '-q', 'lane-a');
  const res = unitStart(c);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /\nunit branch: pl-r1-u-T1 \(switched\)\n/);
  assert.equal(git(c.lane, 'rev-parse', 'HEAD'), head);
});

test('the setup commands run in the worktree after the checkout', () => {
  const c = newCase();
  const res = unitStart(c, '--setup', 'git rev-parse --abbrev-ref HEAD > setup.txt', '--setup', 'echo two >> setup.txt');
  assert.equal(res.code, 0, res.stderr);
  assert.equal(readFileSync(join(c.lane, 'setup.txt'), 'utf8').replace(/\r\n/g, '\n'), 'pl-r1-u-T1\ntwo\n');
});

test('a failing setup command exits 1', () => {
  const c = newCase();
  const res = unitStart(c, '--setup', 'exit 7', '--record-start', c.ledgerDir, 'join', c.initial);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /setup command 'exit 7' exited 7/);
  assert.ok(!existsSync(join(c.ledgerDir, 'join.jsonl')), 'no started event');
});

test('started records dir in forward-slash form and the unit branch', () => {
  const c = newCase();
  const res = unitStart(c, '--record-start', c.ledgerDir, 'join', c.initial);
  assert.equal(res.code, 0, res.stderr);
  const [ev] = readFileSync(join(c.ledgerDir, 'join.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(ev.unit_branch, 'pl-r1-u-T1');
  assert.equal(ev.base, c.initial);
  assert.ok(!ev.dir.includes('\\'), ev.dir);
  assert.ok(samePath(ev.dir, c.lane), `${ev.dir} is not ${c.lane}`);
  assert.equal('restart' in ev, false);
});

test('--restart adds restart to the started event', () => {
  const c = newCase();
  const res = unitStart(c, '--record-start', c.ledgerDir, 'join', c.initial, '--restart');
  assert.equal(res.code, 0, res.stderr);
  const [ev] = readFileSync(join(c.ledgerDir, 'join.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(ev.restart, true);
});

test('--restart without --unit-branch records a restart on the current branch', () => {
  const c = newCase();
  const res = startTask(c.lane, c.plan, '--record-start', c.ledgerDir, 'join', 'HEAD', '--restart',
    '--brief', 'T1', briefOut(c));
  assert.equal(res.code, 0, res.stderr);
  const [ev] = readFileSync(join(c.ledgerDir, 'join.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(ev, { task: 'T1', event: 'started', base: c.initial, restart: true });
});

test('unit-branch usage errors', () => {
  const c = newCase();
  const usage = (...args) => startTask(c.lane, c.plan, ...args, '--brief', 'T1', briefOut(c)).code;
  assert.equal(usage('--unit-branch', 'pl-r1-u-T1', c.initial), 2, 'no --run-id');
  assert.equal(usage('--unit-branch', 'pl-r1-u-T1', c.initial, '--run-id', 'r1', '--sync', 'main'), 2);
  assert.equal(usage('--setup', 'true'), 2, '--setup needs --unit-branch');
  assert.equal(usage('--restart'), 2, '--restart needs --record-start');
  assert.equal(usage('--unit-branch', 'lane-a', c.initial, '--run-id', 'r1'), 2, 'not a unit branch name');
  assert.equal(usage('--unit-branch', 'pl-r1-u-T1', c.initial, '--run-id', 'R!'), 2, 'unsafe run id');
});

test('an unknown SHA for a new unit branch exits 3 and changes nothing', () => {
  const c = newCase();
  write(join(c.lane, 'a.txt'), 'edited\n');
  const res = startTask(c.lane, c.plan, '--unit-branch', 'pl-r1-u-T1', '0'.repeat(40), '--run-id', 'r1',
    '--brief', 'T1', briefOut(c));
  assert.equal(res.code, 3);
  assert.equal(git(c.lane, 'rev-parse', '--abbrev-ref', 'HEAD'), 'lane-a');
  assert.equal(readFileSync(join(c.lane, 'a.txt'), 'utf8'), 'edited\n');
  assert.deepEqual(abandoned(c), []);
});

test('an existing unit branch not built on SHA is saved and made again at SHA', () => {
  const c = newCase();
  assert.equal(unitStart(c).code, 0);
  const old = commit(c.lane, 'unit.txt', 'built on the old base\n', 'unit work');
  git(c.lane, 'checkout', '-q', 'lane-a');
  const tip = commit(c.lane, 'lane2.txt', 'lane rework\n', 'lane rework');
  const res = startTask(c.lane, c.plan, '--unit-branch', 'pl-r1-u-T1', tip, '--run-id', 'r1', '--brief', 'T1', briefOut(c));
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /\nunit branch: pl-r1-u-T1 \(recreated\)\n/);
  assert.equal(git(c.lane, 'rev-parse', 'HEAD'), tip);
  const saved = git(c.project, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/parallel-lanes/r1/abandoned')
    .split('\n').filter((l) => l.includes('pl-r1-u-T1-'));
  assert.equal(saved.length, 1, 'the old branch head is kept under the abandoned refs');
  assert.ok(saved[0].endsWith(old));
  assert.match(res.stdout, new RegExp(`\\nsaved: refs/parallel-lanes/r1/abandoned/pl-r1-u-T1-\\S+ \\(${old}\\)\\n`));
});
