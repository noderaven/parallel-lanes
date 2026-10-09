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

const SCRIPTS = join(SKILL_DIR, 'scripts');
const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'pl-task-helpers-')));
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
    env: { ...process.env, ...GIT_ENV, ...extraEnv },
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

function git(dir, ...args) {
  const res = sh('git', ['-C', dir, ...args]);
  assert.equal(res.code, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
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
    assert.ok(res.stdout.includes(`===== brief ${id}: ${out} =====\n${expected}`), res.stdout);
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
  assert.ok(res.stdout.includes(`===== brief T2: ${out2} =====\n${text2}`), res.stdout);
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
  assert.equal(readFileSync(out, 'utf8'), [c.lane, c.plan, 'BASE', 'HEAD', out, ''].join('\n'));
  assert.ok(res.stdout.endsWith(`===== review package =====\n${out}\n`), res.stdout);
  assert.ok(res.stdout.indexOf('===== brief T1') < res.stdout.indexOf('===== review package'));
});

test('start-task runs the package script with the resolved bash', () => {
  const c = newCase();
  const realBash = sh('bash', ['-c', 'command -v bash']).stdout.trim();
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
  assert.equal(readFileSync(out, 'utf8'), `${c.lane}\nunset\n`);
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
