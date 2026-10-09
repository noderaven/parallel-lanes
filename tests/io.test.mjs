// LF output, UTF-8 and native paths in the Python helpers other than _shell.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'pl-io-')));
after(() => rmSync(TMP, { recursive: true, force: true }));

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
  const scripts = readdirSync(SCRIPTS)
    .map((name) => join(SCRIPTS, name))
    .filter((path) => path.endsWith('.py') || /^#!.*python/.test(readFileSync(path, 'utf8').split('\n')[0]));
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
    'import sys',
    `sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`,
    'import _brief',
    'for p in sys.argv[1:]:',
    '    with open(p, encoding="utf-8") as f:',
    '        print(_brief.section_sha256(f.read(), "1"))',
  ].join('\n');
  const res = spawnSync('python3', ['-c', code, lf, crlf], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const [a, b] = res.stdout.trim().split('\n');
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
    `sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`,
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
