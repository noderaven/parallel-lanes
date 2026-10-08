// Path, id, command and coverage boundaries of the helper scripts (review
// findings 4, 9 and 11, plan coverage, and the task-brief list and fence
// defects the cc1 final review left open). Every test runs the real scripts
// against real files and, where it matters, real git repos.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'pl-boundaries-')));
after(() => rmSync(TMP, { recursive: true, force: true }));
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid',
};

let counter = 0;
function workDir() {
  counter += 1;
  const dir = join(TMP, `case ${counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
function py(script, args, opts = {}) {
  const res = spawnSync('python3', [join(SCRIPTS, script), ...args], {
    encoding: 'utf8', env: { ...process.env, ...GIT_ENV }, cwd: opts.cwd,
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}
function git(dir, ...args) {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim();
}
function repo() {
  const dir = join(workDir(), 'repo');
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}

// --- finding 4: task ids and artifact paths ----------------------------------

test('task-brief refuses an unsafe task id before reading the plan or writing anything', () => {
  const dir = workDir();
  write(join(dir, 'victim.md'), 'ORIGINAL\n');
  write(join(dir, 'plan.md'), '# P\n\n### Task ../victim: evil\n\nbody\n');
  const res = py('task-brief', [join(dir, 'plan.md'), '../victim', join(dir, 'ledger', 'briefs', '..', '..', 'victim.md')]);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /unsafe task id/);
  assert.equal(readFileSync(join(dir, 'victim.md'), 'utf8'), 'ORIGINAL\n');
});

test('task-brief --root refuses a brief path outside the root, through .. or a symlink', () => {
  const dir = workDir();
  write(join(dir, 'plan.md'), '# P\n\n### Task T1: one\n\nbody\n');
  write(join(dir, 'outside', 'keep.md'), 'ORIGINAL\n');
  const root = join(dir, 'ledger');
  mkdirSync(join(root, 'briefs'), { recursive: true });
  symlinkSync(join(dir, 'outside'), join(root, 'briefs', 'link'));
  for (const out of [join(root, 'briefs', '..', '..', 'outside', 'keep.md'), join(root, 'briefs', 'link', 'keep.md')]) {
    const res = py('task-brief', [join(dir, 'plan.md'), 'T1', out, '--root', root]);
    assert.equal(res.code, 3, `${out}: ${res.stderr}`);
    assert.match(res.stderr, /outside/);
  }
  assert.equal(readFileSync(join(dir, 'outside', 'keep.md'), 'utf8'), 'ORIGINAL\n');
  const ok = py('task-brief', [join(dir, 'plan.md'), 'T1', join(root, 'briefs', 'T1.md'), '--root', root]);
  assert.equal(ok.code, 0, ok.stderr);
});

test('start-task --artifacts refuses brief and package paths outside the ledger dir', () => {
  const r = repo();
  const dir = dirname(r);
  write(join(dir, 'plan.md'), '# P\n\n### Task T1: one\n\nbody\n');
  const root = join(dir, 'ledger');
  const res = spawnSync('python3', [join(SCRIPTS, 'start-task'), r, join(dir, 'plan.md'), '--artifacts', root,
    '--brief', 'T1', join(dir, 'elsewhere', 'T1.md')], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  assert.equal(res.status, 3, res.stderr);
  assert.equal(existsSync(join(dir, 'elsewhere')), false);
  const ok = spawnSync('python3', [join(SCRIPTS, 'start-task'), r, join(dir, 'plan.md'), '--artifacts', root,
    '--brief', 'T1', join(root, 'briefs', 'T1.md')], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  assert.equal(ok.status, 0, ok.stderr);
});

test('derive-lanes refuses a plan whose task id is not a safe file name', () => {
  const dir = workDir();
  write(join(dir, 'plan.md'), '# P\n\n### Task ../../victim: evil\n\nbody\n');
  const res = py('derive-lanes', [join(dir, 'plan.md')]);
  assert.equal(res.code, 3);
  assert.match(res.stderr, /not a safe file name/);
});

// --- finding 9: file paths ----------------------------------------------------

test('derive-lanes keeps root files, normalizes paths, and warns about escapes, globs and empty blocks', () => {
  const dir = workDir();
  write(join(dir, 'plan.md'), [
    '# P', '',
    '### Task 1: one', '', '**Files:**',
    '- Modify: `Makefile` (add `build_target`)',
    '- Modify: `./src//util.py:10-20` (`helper()`)',
    '- Create: `../escape.txt`; Create: `src/*.js`',
    '- Test: `tests/a/../test_a.py`', '',
    '### Task 2: two', '', '**Files:**', '- Modify: `Makefile`', '',
    '### Task 3: three', '', '**Files:**', '- Modify: (nothing named)', '',
  ].join('\n'));
  const res = py('derive-lanes', [join(dir, 'plan.md')]);
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.tasks.map((t) => t.files), [['Makefile', 'src/util.py', 'tests/test_a.py'], ['Makefile'], []]);
  assert.deepEqual(out.groups, [['1', '2'], ['3']]);
  assert.match(res.stderr, /'\.\.\/escape\.txt' leaves the project/);
  assert.match(res.stderr, /glob 'src\/\*\.js'/);
  assert.match(res.stderr, /task 3: its Files block names no path/);
});

// --- finding 11: command results ---------------------------------------------

test('run-checks keeps every exit status: a failure before a success fails the run', () => {
  const r = repo();
  const out = join(dirname(r), 'ledger', 'checks.json');
  const res = py('run-checks', [r, '--out', out, '--root', join(dirname(r), 'ledger'),
    '--cmd', 'test', 'false', '--cmd', 'lint', 'true']);
  assert.equal(res.code, 1, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.head, git(r, 'rev-parse', 'HEAD'));
  assert.deepEqual(report.results, [
    { group: 'test', command: 'false', exit: 1 },
    { group: 'lint', command: 'true', exit: 0 },
  ]);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), report);
  const pass = py('run-checks', [r, '--cmd', 'test', 'true']);
  assert.equal(pass.code, 0, pass.stderr);
  assert.equal(JSON.parse(pass.stdout).ok, true);
});

test('run-checks fails a command that moves HEAD: a check must not change what it checks', () => {
  const r = repo();
  const res = py('run-checks', [r, '--cmd', 'test', 'git commit -q --allow-empty -m sneaky']);
  assert.equal(res.code, 1, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.equal(report.ok, false);
  assert.notEqual(report.head_after, report.head);
});

// --- plan coverage ----------------------------------------------------------

test('coverage reports plan tasks the manifest leaves out, unknown ids, and duplicates', () => {
  const dir = workDir();
  write(join(dir, 'plan.md'), '# P\n\n### Task 1: a\n\nx\n\n### Task 2: b\n\nx\n\n### Task 3: c\n\nx\n\n### Task 4: d\n\nx\n');
  const t = (id) => ({ id });
  const write_m = (m) => { write(join(dir, 'm.json'), JSON.stringify(m)); return join(dir, 'm.json'); };
  const ok = py('coverage', [join(dir, 'plan.md'), write_m({ prelude: [t('1')], lanes: [{ tasks: [t('2')] }], join: [t('3')],
    excluded: [{ id: '4', reason: 'operator step' }] })]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).ok, true);
  const bad = py('coverage', [join(dir, 'plan.md'), write_m({ prelude: [t('1'), t('9')], lanes: [{ tasks: [t('2')] }], join: [t('1')] })]);
  assert.equal(bad.code, 3);
  const out = JSON.parse(bad.stdout);
  assert.deepEqual(out.missing, ['3', '4']);
  assert.deepEqual(out.unknown, ['9']);
  assert.deepEqual(out.duplicates, ['1']);
});

// --- task-brief lists and fences (cc1 final review) --------------------------

function brief(planLines, id) {
  const dir = workDir();
  write(join(dir, 'plan.md'), planLines.join('\n'));
  const res = py('task-brief', [join(dir, 'plan.md'), id, join(dir, 'b.md')]);
  assert.equal(res.code, 0, res.stderr);
  return readFileSync(join(dir, 'b.md'), 'utf8');
}
const produced = (text) => [...text.matchAll(/^## Produces of Task (\S+):/gm)].map((m) => m[1]);

test('task-brief keeps the last task of common Consumes lists, and leaves out quantities', () => {
  const ids = ['1.5', '2', '3', '4', '5', '9'];
  const producers = ids.flatMap((id) => [`### Task ${id}: n${id}`, '', `- Produces: out${id}`, '']);
  const cases = [
    ['Tasks 2 and 3 outputs', ['2', '3']],
    ['Task 1.5 and 9 (api)', ['1.5', '9']],
    ['Tasks 3 and 4 `foo()`', ['3', '4']],
    ['Tasks 3, 4 - the api', ['3', '4']],
    ['Tasks 3 and\n  5 helpers', ['3', '5']],
    ['Task 4 and 3 mi a week', ['4']],
    ['Task 2 at 30%, Task 9 and 3%', ['2', '9']],
  ];
  for (const [consumes, want] of cases) {
    const text = brief(['# P', '', ...producers, '### Task C: consumer', '', `- Consumes: ${consumes}`, ''], 'C');
    assert.deepEqual(produced(text), want, consumes);
  }
});

test('task-brief keeps a fence indented under a nested Produces bullet whole', () => {
  const plan = [
    '# P', '',
    '### Task P1: producer', '',
    '- Files:',
    '  - Produces:',
    '    ```js',
    'export function f() {}',
    '    ```',
    '- Next: not part of it', '',
    '### Task C1: consumer', '', '- Consumes: P1', '',
  ];
  const text = brief(plan, 'C1');
  const block = text.split('## Produces of Task P1: producer (consumed by this task)\n\n')[1];
  assert.equal(block, '  - Produces:\n    ```js\nexport function f() {}\n    ```\n');
});

test('derive-lanes does not read backticked identifiers as files', () => {
  const dir = workDir();
  write(join(dir, 'plan.md'), [
    '# P', '',
    '### Task 1: a', '', '**Files:**', '- Modify: `src/app.py` to call `init_db`', '- Test: `tests/test_app.py`', '',
    '### Task 2: b', '', '**Files:**', '- Modify: `src/db.py`: rename `init_db` to `setup`', '- Create: `Makefile`', '',
    '### Task 3: c', '', '**Files:**', '- Modify: `src/x.py` add `ENV_VAR` handling, and `Dockerfile`', '',
  ].join('\n'));
  const out = JSON.parse(py('derive-lanes', [join(dir, 'plan.md')]).stdout);
  assert.deepEqual(out.tasks.map((t) => t.files),
    [['src/app.py', 'tests/test_app.py'], ['src/db.py', 'Makefile'], ['src/x.py', 'Dockerfile']]);
  assert.deepEqual(out.groups, [['1'], ['2'], ['3']]);
  assert.deepEqual(out.bridge_files, []);
});

test('derive-lanes does not read a leading identifier as a file when the clause names a path', () => {
  const dir = workDir();
  write(join(dir, 'plan.md'), [
    '# P', '',
    '### Task 1: a', '', '**Files:**', '- Modify: `parse_args` in `src/cli.py`', '',
    '### Task 2: b', '', '**Files:**', '- Modify: `parse_args` handling in `src/other.py`', '- Create: `Makefile`', '',
  ].join('\n'));
  const out = JSON.parse(py('derive-lanes', [join(dir, 'plan.md')]).stdout);
  assert.deepEqual(out.tasks.map((t) => t.files), [['src/cli.py'], ['src/other.py', 'Makefile']]);
  assert.deepEqual(out.bridge_files, []);
});
