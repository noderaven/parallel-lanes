// tests/run-tests.mjs: runs every tests/*.test.mjs by name, a few files at a
// time, and passes their failures through. Each case copies the runner into a
// temporary tests/ directory beside fixture test files that record when they
// ran and in which process.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { tempDir } from './platform.mjs';

const RUNNER = join(SKILL_DIR, 'tests', 'run-tests.mjs');
const TMP = tempDir('pl-run-tests-');
after(() => rmSync(TMP, { recursive: true, force: true }));

let count = 0;

// A project with the runner in tests/ and one fixture file per entry of
// files: { name: { ms, fail } }. Each fixture test waits ms, then writes
// out/<name>.json with its pid and start and end times.
function project(files, extra = {}) {
  const root = join(TMP, `p${++count}`);
  const tests = join(root, 'tests');
  const out = join(root, 'out');
  mkdirSync(tests, { recursive: true });
  mkdirSync(out);
  copyFileSync(RUNNER, join(tests, 'run-tests.mjs'));
  for (const [name, { ms = 0, fail = false }] of Object.entries(files)) {
    writeFileSync(join(tests, `${name}.test.mjs`), [
      "import { test } from 'node:test';",
      "import { writeFileSync } from 'node:fs';",
      `test(${JSON.stringify(name)}, async () => {`,
      '  const start = Date.now();',
      `  await new Promise((resolve) => setTimeout(resolve, ${ms}));`,
      `  writeFileSync(${JSON.stringify(join(out, `${name}.json`))},`,
      '    JSON.stringify({ pid: process.pid, start, end: Date.now() }));',
      fail ? "  throw new Error('fixture failure');" : '',
      '});',
      '',
    ].join('\n'));
  }
  for (const [file, text] of Object.entries(extra)) writeFileSync(join(tests, file), text);
  return { root, tests, out };
}

function runner(p, args = [], env = {}) {
  const res = spawnSync(process.execPath, [join(p.tests, 'run-tests.mjs'), ...args], {
    cwd: p.root, encoding: 'utf8', env: { ...process.env, PL_TEST_CONCURRENCY: '', ...env },
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

const records = (p) => Object.fromEntries(readdirSync(p.out)
  .map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(join(p.out, f), 'utf8'))]));

// The most fixture tests that were running at the same moment.
function maxOverlap(recs) {
  const runs = Object.values(recs);
  return Math.max(...runs.map((r) => runs.filter((o) => o.start <= r.start && r.start < o.end).length));
}

test('run-tests runs every *.test.mjs beside it, each in its own process, and nothing else', () => {
  const p = project({ a: {}, b: {}, c: {} }, {
    'helper.mjs': "import { writeFileSync } from 'node:fs';\n"
      + `writeFileSync(${JSON.stringify(join(TMP, 'helper-ran'))}, 'x');\n`,
  });
  const res = runner(p);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const recs = records(p);
  assert.deepEqual(Object.keys(recs).sort(), ['a', 'b', 'c']);
  assert.equal(new Set(Object.values(recs).map((r) => r.pid)).size, 3, JSON.stringify(recs));
  assert.equal(existsSync(join(TMP, 'helper-ran')), false, 'a file not named *.test.mjs was run');
});

test('run-tests runs two test files at a time by default', () => {
  const p = project({ a: { ms: 1000 }, b: { ms: 1000 }, c: { ms: 1000 } });
  const res = runner(p);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.equal(maxOverlap(records(p)), 2, JSON.stringify(records(p)));
});

test('PL_TEST_CONCURRENCY sets how many files run at once, and --concurrency overrides it', () => {
  const files = { a: { ms: 1000 }, b: { ms: 1000 }, c: { ms: 1000 } };
  const serial = project(files);
  assert.equal(runner(serial, [], { PL_TEST_CONCURRENCY: '1' }).code, 0);
  assert.equal(maxOverlap(records(serial)), 1, JSON.stringify(records(serial)));

  const three = project(files);
  assert.equal(runner(three, ['--concurrency', '3'], { PL_TEST_CONCURRENCY: '1' }).code, 0);
  assert.equal(maxOverlap(records(three)), 3, JSON.stringify(records(three)));
});

test('a failing test file makes run-tests exit non-zero, and the other files still run', () => {
  const p = project({ a: {}, b: { fail: true }, c: {} });
  const res = runner(p);
  assert.notEqual(res.code, 0, res.stdout);
  assert.deepEqual(Object.keys(records(p)).sort(), ['a', 'b', 'c']);
});

// node --test sets NODE_TEST_CONTEXT in the processes it starts. A nested
// node --test that sees it runs nothing and exits 0, a false pass.
test('run-tests started from inside a test process still runs the files and reports failures', () => {
  const p = project({ a: {}, b: { fail: true } });
  const res = runner(p, [], { NODE_TEST_CONTEXT: 'child-v8' });
  assert.notEqual(res.code, 0, res.stdout + res.stderr);
  assert.deepEqual(Object.keys(records(p)).sort(), ['a', 'b']);
});

test('run-tests passes other options through to node --test', () => {
  const p = project({ a: {}, b: {} });
  const res = runner(p, ['--test-name-pattern=^a$']);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.deepEqual(Object.keys(records(p)), ['a']);
});

test('an invalid concurrency is a usage error (exit 2) and runs nothing', () => {
  const p = project({ a: {} });
  for (const [args, env] of [[['--concurrency', '0'], {}], [['--concurrency', 'x'], {}], [['--concurrency'], {}],
    [[], { PL_TEST_CONCURRENCY: '2.5' }]]) {
    const res = runner(p, args, env);
    assert.equal(res.code, 2, `${JSON.stringify([args, env])}: ${res.stdout}${res.stderr}`);
    assert.match(res.stderr, /concurrency/);
  }
  assert.deepEqual(readdirSync(p.out), []);
});
