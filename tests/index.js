// Entry point for `node --test tests/`. Node 24 does not expand a directory
// argument into test files; it loads the directory as a module, which
// resolves to this file. Load every *.test.mjs file beside it, one after
// another in this one process. tests/run-tests.mjs is the faster command: it
// runs each file in its own process, four at a time.
'use strict';

const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const files = readdirSync(__dirname)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort();

(async () => {
  for (const name of files) {
    await import(pathToFileURL(join(__dirname, name)).href);
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
