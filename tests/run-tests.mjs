#!/usr/bin/env node
// Runs every *.test.mjs in this directory with node --test, naming each file,
// so each runs in its own process and a few run at once. The default is 2 at
// a time; PL_TEST_CONCURRENCY or --concurrency N changes it. Other arguments
// go to node --test unchanged (e.g. --test-name-pattern=...). Exits with
// node's exit code; 2 on a usage error.
//
//   node tests/run-tests.mjs [--concurrency N] [node --test options...]
//
// `node --test tests/` still works through tests/index.js, but it runs every
// file one after another in one process (about 2.8x slower than 4 at a time
// on Windows, 2026-10-09).
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(TESTS);
const DEFAULT_CONCURRENCY = '2';

function usage(message) {
  console.error(`run-tests: ${message}`);
  console.error('usage: node tests/run-tests.mjs [--concurrency N] [node --test options...]');
  process.exit(2);
}

let concurrency = process.env.PL_TEST_CONCURRENCY || DEFAULT_CONCURRENCY;
let source = process.env.PL_TEST_CONCURRENCY ? 'PL_TEST_CONCURRENCY' : 'the default';
const passThrough = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--concurrency') {
    if (i + 1 >= args.length) usage('--concurrency needs a number');
    concurrency = args[++i];
    source = '--concurrency';
  } else if (args[i].startsWith('--concurrency=')) {
    concurrency = args[i].slice('--concurrency='.length);
    source = '--concurrency';
  } else {
    passThrough.push(args[i]);
  }
}
if (!/^[1-9][0-9]*$/.test(concurrency)) {
  usage(`the concurrency from ${source} must be a whole number of at least 1, not '${concurrency}'`);
}

const files = readdirSync(TESTS).filter((name) => name.endsWith('.test.mjs')).sort()
  .map((name) => join('tests', name));
// node --test sets NODE_TEST_CONTEXT in the processes it starts; a node --test
// that inherits it acts as one of those, runs nothing and exits 0. This runner
// is always the top-level one.
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
const child = spawn(process.execPath,
  ['--test', `--test-concurrency=${concurrency}`, ...passThrough, ...files],
  { cwd: ROOT, stdio: 'inherit', env });
child.on('error', (err) => {
  console.error(`run-tests: cannot start node: ${err.message}`);
  process.exit(1);
});
child.on('close', (code) => {
  process.exitCode = code === null ? 1 : code;
});
