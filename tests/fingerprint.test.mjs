// The declared-list fingerprint (1.6.6 design 4.2): the engine's
// declaredFingerprint (src/prompts-task.js) and the helpers' _owners.fingerprint
// give the same N:HHHHHHHH on the shared cases in
// tests/fixtures/fingerprint/cases.json; owners_declared rebuilds a unit's
// Files list from owners.json and refuses one that does not match.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadHelpers, SKILL_DIR } from './harness.mjs';
import { tempDir } from './platform.mjs';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const CASES = JSON.parse(readFileSync(join(SKILL_DIR, 'tests', 'fixtures', 'fingerprint', 'cases.json'), 'utf8'));
const TMP = tempDir('pl-fingerprint-');
after(() => rmSync(TMP, { recursive: true, force: true }));

const { declaredFingerprint } = await loadHelpers(['declaredFingerprint']);

// Runs a Python snippet with scripts/ importable (no bytecode); stdin is JSON
// (read as UTF-8 bytes, whatever the console code page), stdout is JSON.
function python(lines, input) {
  const code = [
    'import json, sys',
    'sys.dont_write_bytecode = True',
    `sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`,
    'import _owners',
    'data = json.loads(sys.stdin.buffer.read().decode("utf-8"))',
    ...lines,
  ].join('\n');
  const r = spawnSync('python3', ['-B', '-c', code], { encoding: 'utf8', input: JSON.stringify(input) });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

// owners_declared(path, ids, expected) as {ok: list} or {error: text}.
function ownersDeclared(path, ids, expected) {
  return python([
    'try:',
    '    print(json.dumps({"ok": _owners.owners_declared(data["path"], data["ids"], data["expected"])}))',
    'except ValueError as e:',
    '    print(json.dumps({"error": str(e)}))',
  ], { path, ids, expected });
}

test('the engine\'s fingerprint reproduces every shared case', () => {
  assert.ok(CASES.length >= 10);
  for (const c of CASES) assert.equal(declaredFingerprint(c.paths), c.fingerprint, c.name);
});

test('the helpers\' fingerprint reproduces every shared case', () => {
  const got = python(['print(json.dumps([_owners.fingerprint(c["paths"]) for c in data]))'], CASES);
  assert.deepEqual(got, CASES.map((c) => c.fingerprint));
});

test('the fingerprint of no paths is 0 and the offset basis', () => {
  assert.equal(declaredFingerprint([]), '0:811c9dc5');
  assert.deepEqual(python(['print(json.dumps(_owners.fingerprint([])))'], null), '0:811c9dc5');
});

test('owners_declared rebuilds a unit\'s list and refuses a different one', () => {
  const path = join(TMP, 'owners.json');
  writeFileSync(path, JSON.stringify({
    repo: {},
    tasks: {
      T2: { where: 'a', pos: 0, declared: ['src/a.js', 'shared.css'] },
      T3: { where: 'a', pos: 1, declared: ['shared.css', 'src/b.js'] },
      T4: { where: 'a', pos: 2 },
    },
    files: {},
  }));
  const list = ['src/a.js', 'shared.css', 'src/b.js'];
  const fp = declaredFingerprint(list);
  assert.deepEqual(ownersDeclared(path, ['T2', 'T3'], fp), { ok: list });
  const wrong = ownersDeclared(path, ['T2', 'T3'], '3:00000000');
  assert.ok(wrong.error.includes('expected 3:00000000') && wrong.error.includes(`, found ${fp}`), wrong.error);
  assert.ok(wrong.error.includes('expected ') && wrong.error.includes(', found 3:'), wrong.error);
  assert.equal(ownersDeclared(path, ['T9'], fp).error, 'task T9 is not in it');
  assert.equal(ownersDeclared(path, ['T4'], fp).error, 'task T4 has no declared list');
  const missing = ownersDeclared(join(TMP, 'no-such', 'owners.json'), ['T2'], fp);
  assert.ok(missing.error.startsWith('owners.json cannot be read'), missing.error);
});

test('declared_for refuses a declared value that is not a list of strings', () => {
  const owners = { tasks: { A: { declared: 'src/a.js' }, B: { declared: ['ok', 3] }, C: { declared: [] } } };
  const got = python([
    'out = []',
    'for ids in (["A"], ["B"], ["C"]):',
    '    try:',
    '        out.append(_owners.declared_for(data, ids))',
    '    except ValueError as e:',
    '        out.append(str(e))',
    'print(json.dumps(out))',
  ], owners);
  assert.deepEqual(got, ['task A has no declared list', 'task B has no declared list', []]);
});

test('FINGERPRINT matches only the N:HHHHHHHH form with N of 1 or more', () => {
  const got = python([
    'print(json.dumps([bool(_owners.FINGERPRINT.fullmatch(s)) for s in data]))',
  ], ['3:0a1b2c3d', '0:811c9dc5', '03:0a1b2c3d', '3:0A1B2C3D', '3:0a1b2c3', '3:0a1b2c3d\n', '12:0a1b2c3d']);
  assert.deepEqual(got, [true, false, false, false, false, false, true]);
});
