// LF output, UTF-8 and native paths in the Python helpers other than _shell.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
  for (const name of [...HELPERS, '_brief.py']) {
    const source = readFileSync(join(SCRIPTS, name), 'utf8');
    // open(...) in a write, append or exclusive mode (os.open is a different call).
    const textWrite = /(^|[^.\w])open\([^)]*,\s*(mode\s*=\s*)?["'][wax+]/m;
    assert.doesNotMatch(source, textWrite, `${name} must not write text with open()`);
  }
  assert.match(readFileSync(join(SCRIPTS, 'task-brief'), 'utf8'), /write_text\(/);
  assert.match(readFileSync(join(SCRIPTS, 'run-report'), 'utf8'), /write_text\(/);
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
  const dir = join(TMP, 'x');
  mkdirSync(join(dir, 'ledger'), { recursive: true });
  const res = spawnSync('python3', [join(SCRIPTS, 'ledger'), 'status', join(dir, 'y', '..', 'ledger')], {
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(JSON.parse(res.stdout));
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
