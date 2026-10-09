// scripts/_paths.sh and scripts/find-python. Fake interpreters and a fake
// cygpath go first on PATH, so the Windows rules run on every platform.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { BASH, SYMLINKS, tempDir, mergeEnv, IS_WINDOWS, lf, samePath } from './platform.mjs';

const PATHS = join(SKILL_DIR, 'scripts', '_paths.sh');
const FIND_PYTHON = join(SKILL_DIR, 'scripts', 'find-python');
const TMP = realpathSync(tempDir('pl-platform-bash-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

let counter = 0;
// A fresh directory holding the named executable scripts (name -> body).
function fakeBin(scripts) {
  counter += 1;
  const dir = join(TMP, `bin ${counter}`);
  mkdirSync(dir);
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

function run(args, { path, env = {} } = {}) {
  const res = spawnSync(BASH, args, {
    encoding: 'utf8',
    env: mergeEnv(process.env, path ? { PATH: path } : {}, env),
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

const real = (script) => spawnSync('python3', ['-c', script], { encoding: 'utf8' }).stdout.trim();
const REAL_EXE = real('import sys; print(sys.executable)');
const REAL_PATH = process.env.PATH;
const execReal = `exec '${REAL_EXE}' "$@"`;

test('.gitattributes makes every text file LF', () => {
  assert.equal(readFileSync(join(SKILL_DIR, '.gitattributes'), 'utf8'), '* text=auto eol=lf\n');
});

test('abs_dir and native leave Linux and macOS paths as they are', { skip: IS_WINDOWS && 'Git Bash is Windows: the C:/ form test below covers it' }, () => {
  mkdirSync(join(TMP, 'a'));
  const r = run(['-c', `. '${PATHS}'; abs_dir '${TMP}/a/../a'; native '/tmp/x'`], { env: { PL_UNAME: 'Linux' } });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, `${TMP}/a\n/tmp/x\n`);
  const missing = run(['-c', `. '${PATHS}'; abs_dir '${TMP}/nope'`]);
  assert.equal(missing.code, 1);
});

test('abs_dir and native give real C:/ paths on Windows', { skip: !IS_WINDOWS && 'Windows only' }, () => {
  mkdirSync(join(TMP, 'w'));
  const r = run(['-c', `. '${PATHS}'; abs_dir '${TMP}/w'; native /tmp/x`]);
  assert.equal(r.code, 0, r.stderr);
  const [dir, tmp] = lf(r.stdout).trim().split('\n');
  assert.match(dir, /^[A-Za-z]:\//, dir);
  assert.ok(samePath(dir, join(TMP, 'w')), `${dir} is not ${join(TMP, 'w')}`);
  assert.match(tmp, /^[A-Za-z]:\/.*\/x$/, tmp);
});

test('abs_dir and native give the C:/ form under Git Bash', { skip: IS_WINDOWS && 'simulates Git Bash with a fake cygpath; on Windows every test runs the real one' }, () => {
  const fake = fakeBin({ cygpath: 'echo "C:/fake${@: -1}"' });
  const r = run(['-c', `. '${PATHS}'; abs_dir '${TMP}'; native /tmp/x`], {
    path: `${fake}${delimiter}${REAL_PATH}`,
    env: { PL_UNAME: 'MINGW64_NT-10.0' },
  });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, `C:/fake${TMP}\nC:/fake/tmp/x\n`);
});

test('find-python prints the first interpreter that runs Python 3.8 or later', () => {
  const fake = fakeBin({ python3: 'exit 9009', python: execReal });
  const r = run([FIND_PYTHON], { path: `${fake}${delimiter}${REAL_PATH}`, env: { PL_UNAME: 'Linux' } });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, `${REAL_EXE}\n`);
});

test('find-python skips an interpreter older than 3.8', () => {
  const fake = fakeBin({
    python3: 'exit 1',
    python: 'exit 1',
    py: `if [ "$1" = "-3" ]; then shift; ${execReal}; fi\nexit 1`,
  });
  const r = run([FIND_PYTHON], { path: `${fake}${delimiter}${REAL_PATH}`, env: { PL_UNAME: 'Linux' } });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, `${REAL_EXE}\n`);
});

test('find-python skips a Python older than 3.8 even with PYTHONOPTIMIZE set', () => {
  // python3 is the real interpreter posing as /old/python3.6, version 3.6;
  // PYTHONOPTIMIZE strips an assert, so an assert-based check would take it.
  const old = `for a; do code=$a; done; exec '${REAL_EXE}' -c "import sys; sys.version_info = (3, 6, 0); sys.executable = '/old/python3.6'; exec(sys.argv[1])" "$code"`;
  const fake = fakeBin({ python3: old, python: execReal });
  const r = run([FIND_PYTHON], {
    path: `${fake}${delimiter}${REAL_PATH}`,
    env: { PL_UNAME: 'Linux', PYTHONOPTIMIZE: '1' },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, `${REAL_EXE}\n`);
  // The fake itself really reports 3.6.
  const probe = run(['-c', `python3 -c 'import sys; print(sys.version_info[:2])'`], { path: `${fake}${delimiter}${REAL_PATH}` });
  assert.equal(lf(probe.stdout), '(3, 6)\n');
});

test('find-python fails clearly when none works', { skip: !SYMLINKS && 'symlinks unavailable' }, () => {
  // Only the tools the script needs, so no real python is on PATH.
  const tools = fakeBin({ python3: 'exit 9009', python: 'exit 1', py: 'exit 1' });
  for (const name of ['bash', 'dirname', 'uname', 'head', 'tr']) {
    const found = spawnSync(BASH, ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
    symlinkSync(found, join(tools, name));
  }
  const r = run([FIND_PYTHON], { path: tools });
  assert.equal(r.code, 3);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /no working Python 3\.8 or later \(tried: python3, python, py -3\)/);
});
