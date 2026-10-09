// Staleness: the committed run.workflow.js (the file the Workflow tool runs)
// must be exactly what scripts/build makes from src/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCRIPT_PATH, SKILL_DIR } from './harness.mjs';
import { BASH, tempDir } from './platform.mjs';

test('the committed run.workflow.js matches a fresh build of src/', () => {
  const dir = tempDir('pl-build-');
  try {
    const out = join(dir, 'run.workflow.js');
    execFileSync(BASH, ['scripts/build', '--out', out], { cwd: SKILL_DIR });
    const fresh = readFileSync(out);
    const committed = readFileSync(SCRIPT_PATH);
    assert.ok(fresh.equals(committed),
      'run.workflow.js is stale: run bash scripts/build and commit the result');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
