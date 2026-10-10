// scripts/_transcripts.py: the transcript parsing run-report is built on.
// build_report must give exactly what run-report prints.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const FIX = join(SKILL_DIR, 'tests', 'fixtures', 'transcripts');
const MANIFEST = join(FIX, 'manifest.json');

test("build_report on the fixture equals run-report's output", () => {
  const code = [
    'import json, sys',
    'sys.dont_write_bytecode = True',
    `sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`,
    'import _transcripts',
    `with open(${JSON.stringify(MANIFEST)}, encoding="utf-8") as f:`,
    '    manifest = json.load(f)',
    `print(json.dumps(_transcripts.build_report(${JSON.stringify(FIX)}, manifest)))`,
  ].join('\n');
  const direct = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
  assert.equal(direct.status, 0, direct.stderr);
  const cli = spawnSync('python3', [join(SCRIPTS, 'run-report'), FIX, MANIFEST], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  const expected = JSON.parse(cli.stdout);
  assert.deepEqual(JSON.parse(direct.stdout), expected);
  assert.ok(expected.agents.length > 0);
});
