// LF output, UTF-8 and native paths in the Python helpers other than _shell.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { tempDir } from './platform.mjs';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const TMP = realpathSync(tempDir('pl-io-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

// The Python lines that make the helper modules in dir importable (the
// snippets below import _brief, _plan and _shell directly). Like every
// helper script, they turn off bytecode writing first, so no __pycache__ is
// left in scripts/.
function helperImports(dir) {
  return ['import sys', 'sys.dont_write_bytecode = True', `sys.path.insert(0, ${JSON.stringify(dir)})`];
}

// The Python scripts in dir: files named *.py or starting with a python
// shebang (directories, such as a stray __pycache__, are skipped).
function pythonScripts(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(dir, entry.name))
    .filter((path) => path.endsWith('.py') || /^#!.*python/.test(readFileSync(path, 'utf8').split('\n')[0]));
}

const HELPERS = ['ledger', 'task-brief', 'finish-task', 'coverage', 'derive-lanes', 'run-report'];

test('every Python helper calls setup_io and writes files through write_text', () => {
  for (const name of HELPERS) {
    const source = readFileSync(join(SCRIPTS, name), 'utf8');
    assert.match(source, /setup_io\(\)/, `${name} must call setup_io()`);
    assert.match(source, /import _shell/, `${name} must import _shell`);
  }
  // Parse each file and check every open() call (os.open takes flags, not a
  // mode): a write, append, exclusive or update mode must be binary, and a
  // mode that is not a string literal cannot be checked, so it fails too.
  const code = [
    'import ast, sys',
    'bad = []',
    'for path in sys.argv[1:]:',
    '    with open(path, encoding="utf-8") as f:',
    '        tree = ast.parse(f.read(), path)',
    '    for node in ast.walk(tree):',
    '        if not isinstance(node, ast.Call):',
    '            continue',
    '        fn = node.func',
    '        if isinstance(fn, ast.Name):',
    '            if fn.id != "open":',
    '                continue',
    '        elif isinstance(fn, ast.Attribute):',
    '            if fn.attr != "open" or (isinstance(fn.value, ast.Name) and fn.value.id == "os"):',
    '                continue',
    '        else:',
    '            continue',
    '        mode = node.args[1] if len(node.args) > 1 else None',
    '        for kw in node.keywords:',
    '            if kw.arg == "mode":',
    '                mode = kw.value',
    '        if mode is None:',
    '            continue',
    '        if not (isinstance(mode, ast.Constant) and isinstance(mode.value, str)):',
    '            bad.append(f"{path}:{node.lineno}: mode is not a string literal")',
    '        elif set(mode.value) & set("wax+") and "b" not in mode.value:',
    '            bad.append(f"{path}:{node.lineno}: text-mode write {mode.value!r}")',
    'print("\\n".join(bad))',
  ].join('\n');
  const files = [...HELPERS, '_brief.py'].map((name) => join(SCRIPTS, name));
  const res = spawnSync('python3', ['-c', code, ...files], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), '', 'no helper may write text with open()');
  assert.match(readFileSync(join(SCRIPTS, 'task-brief'), 'utf8'), /write_text\(/);
  assert.match(readFileSync(join(SCRIPTS, 'run-report'), 'utf8'), /write_text\(/);
});

test('every subprocess the Python scripts read as text is decoded as UTF-8', () => {
  // git prints paths as UTF-8; decoding with the Windows code page (the
  // text=True default there) garbles a non-ASCII path or raises.
  const scripts = pythonScripts(SCRIPTS);
  assert.ok(scripts.length >= 10, `found only ${scripts.length} Python scripts`);
  const code = [
    'import ast, sys',
    'bad = []',
    'for path in sys.argv[1:]:',
    '    with open(path, encoding="utf-8") as f:',
    '        tree = ast.parse(f.read(), path)',
    '    for node in ast.walk(tree):',
    '        if not isinstance(node, ast.Call):',
    '            continue',
    '        kw = {k.arg: k.value for k in node.keywords}',
    '        texty = any(isinstance(kw.get(k), ast.Constant) and kw[k].value is True',
    '                    for k in ("text", "universal_newlines"))',
    '        enc = kw.get("encoding")',
    '        if texty and not (isinstance(enc, ast.Constant) and enc.value == "utf-8"):',
    '            bad.append(f"{path}:{node.lineno}: text=True without encoding=\'utf-8\'")',
    'print("\\n".join(bad))',
  ].join('\n');
  const res = spawnSync('python3', ['-c', code, ...scripts], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), '');
});

const PLAN = [
  '# Plan',
  '',
  '### Task 1: First',
  '',
  '**Files:**',
  '- Create: `a.txt`',
  '',
  '- [ ] **Step 1: Do it**',
  '',
  '### Task 2: Second',
  '',
  '- [ ] **Step 1: Later**',
  '',
].join('\n');

test('a CRLF plan gives the same brief and section hash as LF', () => {
  const lf = join(TMP, 'plan.md');
  const crlf = join(TMP, 'plan-crlf.md');
  writeFileSync(lf, PLAN);
  writeFileSync(crlf, PLAN.replace(/\n/g, '\r\n'));
  const briefs = [lf, crlf].map((plan, i) => {
    const out = join(TMP, `brief-${i}.md`);
    const res = spawnSync('python3', [join(SCRIPTS, 'task-brief'), plan, '1', out], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    return readFileSync(out);
  });
  assert.ok(!briefs[1].includes(13), 'the brief must hold no CR');
  assert.deepEqual(briefs[0], briefs[1]);

  const code = [
    ...helperImports(SCRIPTS),
    'import _brief',
    'for p in sys.argv[1:]:',
    '    with open(p, encoding="utf-8") as f:',
    '        print(_brief.section_sha256(f.read(), "1"))',
  ].join('\n');
  const res = spawnSync('python3', ['-c', code, lf, crlf], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  // print() on Windows ends lines with CRLF; only the hashes matter here.
  const [a, b] = res.stdout.replace(/\r\n/g, '\n').trim().split('\n');
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, b);
});

test('helpers accept a Git Bash path for their files', () => {
  const ledger = join(TMP, 'ledger');
  mkdirSync(ledger, { recursive: true });
  mkdirSync(join(TMP, 'x'), { recursive: true });
  writeFileSync(join(ledger, 'alpha.jsonl'), JSON.stringify({ task: 'T7', event: 'blocked', reason: 'r' }) + '\n');
  const res = spawnSync('python3', [join(SCRIPTS, 'ledger'), 'status', join(TMP, 'x', '..', 'ledger')], {
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout).blocked, ['T7']);
});

test('a path that cannot be converted fails with the helper message, not a traceback', () => {
  // Pretend to be Windows with a Git Bash that has no cygpath.exe beside it,
  // so converting a '/'-rooted path (not an MSYS drive path such as /c/x)
  // raises CygpathNotFound.
  const bash = join(TMP, 'git', 'bin', 'bash.exe');
  mkdirSync(join(TMP, 'git', 'bin'), { recursive: true });
  writeFileSync(bash, '');
  const env = { ...process.env, CLAUDE_CODE_GIT_BASH_PATH: bash };
  // Standard modules load before the platform changes (some pick their
  // implementation by platform at import); _shell reads it at call time.
  const code = [
    'import argparse, glob, hashlib, json, os, posixpath, re, runpy, shutil, subprocess, sys',
    ...helperImports(SCRIPTS),
    'import _shell',
    'sys.platform = "win32"',
    'sys.argv = sys.argv[1:]',
    'runpy.run_path(sys.argv[0], run_name="__main__")',
  ].join('\n');
  const cases = [
    ['ledger', ['status', '/nowhere/ledger'], 3],
    ['task-brief', ['/nowhere/plan.md', '1', '/nowhere/brief.md'], 3],
    ['coverage', ['/nowhere/plan.md', '/nowhere/manifest.json'], 3],
    ['derive-lanes', ['/nowhere/plan.md'], 3],
    ['finish-task', ['/nowhere/wt', 'b', 'HEAD', '/nowhere/ledger', 'alpha', '--task', '1'], 3],
    ['run-report', ['/nowhere/transcripts', '/nowhere/manifest.json'], 3],
  ];
  for (const [name, args, status] of cases) {
    const res = spawnSync('python3', ['-c', code, join(SCRIPTS, name), ...args], { encoding: 'utf8', env });
    assert.equal(res.status, status, `${name}: ${res.stderr}`);
    assert.ok(res.stderr.startsWith(`${name}: cannot convert /nowhere/`), `${name}: ${res.stderr}`);
    assert.doesNotMatch(res.stderr, /Traceback/, name);
  }
});

test('run-report --out writes LF only', () => {
  const transcripts = join(TMP, 'transcripts');
  mkdirSync(transcripts, { recursive: true });
  const manifest = join(TMP, 'manifest.json');
  writeFileSync(manifest, '{}');
  const out = join(TMP, 'report.json');
  const res = spawnSync('python3', [join(SCRIPTS, 'run-report'), transcripts, manifest, '--out', out], {
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  const bytes = readFileSync(out);
  assert.ok(bytes.length > 0 && !bytes.includes(13));
});

// The snippets above import the helper modules straight from scripts/. A
// bytecode cache they leave there is untracked output in the checkout, and
// the next run's pythonScripts(SCRIPTS) would read the cache directory.
test('importing the helpers the way these tests do leaves no bytecode cache', () => {
  const dir = join(TMP, 'no-pycache');
  mkdirSync(dir);
  for (const name of ['_brief.py', '_plan.py', '_shell.py']) copyFileSync(join(SCRIPTS, name), join(dir, name));
  // An inherited PYTHONDONTWRITEBYTECODE would hide a missing setting.
  const env = { ...process.env };
  delete env.PYTHONDONTWRITEBYTECODE;
  const res = spawnSync('python3', ['-c', [...helperImports(dir), 'import _brief, _shell'].join('\n')],
    { encoding: 'utf8', env });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(!existsSync(join(dir, '__pycache__')), 'the import wrote a __pycache__ directory');
});

test('pythonScripts lists only files, whatever directories sit beside them', () => {
  const dir = join(TMP, 'listing');
  mkdirSync(join(dir, '__pycache__'), { recursive: true });
  writeFileSync(join(dir, 'a.py'), 'x = 1\n');
  writeFileSync(join(dir, 'tool'), '#!/usr/bin/env python3\n');
  writeFileSync(join(dir, 'notes.txt'), 'not python\n');
  assert.deepEqual(pythonScripts(dir).sort(), [join(dir, 'a.py'), join(dir, 'tool')]);
});

// Every Python snippet in the tests that imports the helpers from scripts/
// must turn off bytecode writing first, or it leaves scripts/__pycache__.
test('every test that puts scripts/ on the Python path turns off bytecode writing', () => {
  const insert = 'sys.path' + '.insert(0, ';
  const guard = 'sys.dont_write_bytecode' + ' = True';
  const testsDir = join(SKILL_DIR, 'tests');
  for (const name of readdirSync(testsDir).filter((n) => n.endsWith('.mjs'))) {
    const source = readFileSync(join(testsDir, name), 'utf8');
    const inserts = source.split(insert).length - 1;
    const guards = source.split(guard).length - 1;
    assert.ok(guards >= inserts, `${name}: ${inserts} snippet(s) put scripts/ on sys.path, ${guards} turn off bytecode`);
  }
});
