// tests/shard.mjs: a slow test file's cases live in <name>.cases.mjs and
// import test from shard.mjs; each <name>.shard<k>.test.mjs sets its shard and
// imports the cases, so run-tests runs the shards in separate processes. Run
// directly, or through tests/index.js, the cases file registers every test.
// Each case copies shard.mjs (and index.js) into a temporary tests/ directory
// beside fixture files whose tests record which process ran them.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { tempDir } from './platform.mjs';

const TMP = tempDir('pl-shard-');
after(() => rmSync(TMP, { recursive: true, force: true }));

let count = 0;

// A tests/ directory with shard.mjs and index.js, a demo.cases.mjs of five
// tests t0..t4 (each writes out/<name>.<pid>), and `shards` wrapper files.
function project(shards) {
  const root = join(TMP, `p${++count}`);
  const tests = join(root, 'tests');
  const out = join(root, 'out');
  mkdirSync(tests, { recursive: true });
  mkdirSync(out);
  copyFileSync(join(SKILL_DIR, 'tests', 'shard.mjs'), join(tests, 'shard.mjs'));
  copyFileSync(join(SKILL_DIR, 'tests', 'index.js'), join(tests, 'index.js'));
  const record = (name) => `  writeFileSync(${JSON.stringify(out)} + '/${name}.' + process.pid, '');`;
  writeFileSync(join(tests, 'demo.cases.mjs'), [
    "import { writeFileSync } from 'node:fs';",
    "import { test } from './shard.mjs';",
    ...[0, 1, 2, 3, 4].map((i) => `test('t${i}', () => {\n${record(`t${i}`)}\n});`),
    '',
  ].join('\n'));
  writeFileSync(join(tests, 'plain.test.mjs'), [
    "import { writeFileSync } from 'node:fs';",
    "import { test } from 'node:test';",
    `test('plain', () => {\n${record('plain')}\n});`,
    '',
  ].join('\n'));
  for (let k = 1; k <= shards; k++) {
    writeFileSync(join(tests, `demo.shard${k}.test.mjs`),
      `globalThis.PL_TEST_SHARD = { index: ${k - 1}, count: ${shards} };\nawait import('./demo.cases.mjs');\n`);
  }
  return { root, tests, out };
}

function nodeTest(cwd, args) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', ...args], { cwd, encoding: 'utf8', env });
  return { code: r.status, out: r.stdout + r.stderr };
}

// name -> [pid, ...] of the processes that ran it.
function ran(p) {
  const runs = {};
  for (const f of readdirSync(p.out)) {
    const [name, pid] = f.split('.');
    (runs[name] ||= []).push(pid);
  }
  return runs;
}

test('each shard runs every count-th test, from its index, in its own process', () => {
  const p = project(2);
  const r = nodeTest(p.root, ['tests/demo.shard1.test.mjs', 'tests/demo.shard2.test.mjs']);
  assert.equal(r.code, 0, r.out);
  const runs = ran(p);
  assert.deepEqual(Object.keys(runs).sort(), ['t0', 't1', 't2', 't3', 't4']);
  for (const pids of Object.values(runs)) assert.equal(pids.length, 1, JSON.stringify(runs));
  assert.equal(new Set([runs.t0[0], runs.t2[0], runs.t4[0]]).size, 1, JSON.stringify(runs));
  assert.equal(runs.t1[0], runs.t3[0], JSON.stringify(runs));
  assert.notEqual(runs.t0[0], runs.t1[0], JSON.stringify(runs));
});

test('the cases file run directly registers every test', () => {
  const p = project(3);
  const r = nodeTest(p.root, ['tests/demo.cases.mjs']);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(Object.keys(ran(p)).sort(), ['t0', 't1', 't2', 't3', 't4']);
});

test('node --test tests/ (index.js) runs each sharded test once and the plain files too', () => {
  const p = project(3);
  const r = nodeTest(p.root, ['tests/']);
  assert.equal(r.code, 0, r.out);
  const runs = ran(p);
  assert.deepEqual(Object.keys(runs).sort(), ['plain', 't0', 't1', 't2', 't3', 't4']);
  for (const pids of Object.values(runs)) assert.equal(pids.length, 1, JSON.stringify(runs));
});

test('a malformed shard setting fails the file instead of running every test', () => {
  const p = project(0);
  writeFileSync(join(p.tests, 'demo.shard1.test.mjs'),
    "globalThis.PL_TEST_SHARD = { index: 2, count: 2 };\nawait import('./demo.cases.mjs');\n");
  const r = nodeTest(p.root, ['tests/demo.shard1.test.mjs']);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /PL_TEST_SHARD/);
  assert.deepEqual(readdirSync(p.out), []);
});

test('every shard wrapper in this repo names an existing cases file and the shards cover it', () => {
  const dir = join(SKILL_DIR, 'tests');
  const wrappers = readdirSync(dir).filter((f) => /\.shard\d+\.test\.mjs$/.test(f));
  const byBase = {};
  for (const f of wrappers) {
    const text = readFileSync(join(dir, f), 'utf8');
    const m = text.match(/PL_TEST_SHARD = \{ index: (\d+), count: (\d+) \};\nawait import\('\.\/([a-z0-9-]+)\.cases\.mjs'\);/);
    assert.ok(m, `${f}: unexpected wrapper text`);
    const base = f.replace(/\.shard\d+\.test\.mjs$/, '');
    assert.equal(m[3], base, f);
    assert.equal(Number(f.match(/\.shard(\d+)\./)[1]), Number(m[1]) + 1, f);
    (byBase[base] ||= { count: Number(m[2]), seen: [] }).seen.push(Number(m[1]));
  }
  for (const [base, { count: n, seen }] of Object.entries(byBase)) {
    assert.deepEqual(seen.sort((a, b) => a - b), [...Array(n).keys()], base);
    assert.ok(readdirSync(dir).includes(`${base}.cases.mjs`), base);
  }
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.cases.mjs'))) {
    assert.ok(byBase[f.replace(/\.cases\.mjs$/, '')], `${f} has no shard wrappers`);
  }
});
