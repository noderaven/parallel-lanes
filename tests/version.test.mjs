// The version the workflow runs as: scripts/build stamps VERSION into the meta
// description and the script body, the script logs it first and returns it
// in its result (dry run included).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR, loadScript } from './harness.mjs';
import { BASH, tempDir } from './platform.mjs';

const VERSION = readFileSync(join(SKILL_DIR, 'VERSION'), 'utf8').trim();
const TMP = tempDir('pl-version-');
after(() => rmSync(TMP, { recursive: true, force: true }));

test('the build stamps VERSION into the workflow description and the script', () => {
  const out = join(TMP, 'built.js');
  execFileSync(BASH, ['scripts/build', '--out', out], { cwd: SKILL_DIR });
  const built = readFileSync(out, 'utf8');
  assert.ok(built.includes(`description: 'parallel-lanes v${VERSION}: `), 'meta description names the version');
  assert.ok(built.includes(`const VERSION = '${VERSION}';`), 'the script body has the version');
  assert.ok(!built.includes('@VERSION@'), 'no placeholder is left');
});

test('the build refuses a VERSION that is not x.y.z and writes nothing', () => {
  const root = join(TMP, 'copy');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  cpSync(join(SKILL_DIR, 'scripts', 'build'), join(root, 'scripts', 'build'));
  cpSync(join(SKILL_DIR, 'src'), join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'VERSION'), "1.4' + x\n");
  const out = join(root, 'out.js');
  const res = spawnSync(BASH, ['scripts/build', '--out', out], { cwd: root, encoding: 'utf8' });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /VERSION/);
  assert.equal(existsSync(out), false);
});

test('the script logs the loaded version first and returns it, dry run included', async () => {
  const logs = [];
  const dry = await loadScript({ args: { dry_run: true }, log: (line) => logs.push(line) });
  assert.equal(logs[0], `parallel-lanes v${VERSION} loaded`);
  assert.equal(dry.version, VERSION);
  assert.equal(dry.dry_run, true);
  const invalid = await loadScript({ args: {}, log: () => {} });
  assert.equal(invalid.status, 'invalid');
  assert.equal(invalid.version, VERSION);
});
