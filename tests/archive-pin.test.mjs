// scripts/archive-run pins the plan and spec (spec 4.1): an archived copy is
// only ever the version the latest setup run_started event recorded, found in
// the live file or in git at a recorded setup head. Each test builds its own
// git repo, run and history dir and passes --history-dir.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { mergeEnv, tempDir } from './platform.mjs';

const SCRIPT = join(SKILL_DIR, 'scripts', 'archive-run');
const TMP = tempDir('pl-archive-pin-');
after(() => rmSync(TMP, { recursive: true, force: true }));

const DAY1 = Date.UTC(2026, 9, 10, 7, 0, 0);
const IDENTITY = ['-c', 'user.name=noderaven', '-c', 'user.email=130021665+noderaven@users.noreply.github.com',
  '-c', 'commit.gpgsign=false'];

function cleanEnv() {
  const env = mergeEnv(process.env);
  for (const key of Object.keys(env)) {
    if (['PL_HISTORY_DIR', 'CLAUDE_CONFIG_DIR'].includes(key.toUpperCase())) delete env[key];
  }
  return env;
}

let counter = 0;
function freshDir(name) {
  counter += 1;
  const dir = join(TMP, `${name}-${counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function sha(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function git(dir, ...args) {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

// A launch dir <root>/s/wf_a with one transcript and its result file.
function addLaunch(root) {
  const dir = join(root, 's', 'wf_a');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'agent-a.jsonl'),
    JSON.stringify({ type: 'assistant', timestamp: new Date(DAY1).toISOString() }) + '\n');
  writeJson(`${dir}.json`, { runId: 'wf_a', startTime: DAY1, result: { status: 'complete' } });
  return dir;
}

// A git repo <root>/proj holding docs/plan.md and docs/spec.md (committed),
// a run <root>/run/p.lanes.json whose plan and spec point there, and a ledger
// whose setup run_started event records the head and the working-tree shas.
//   crlf      the repo checks text out with CRLF (autocrlf and .gitattributes);
//   planPath  the plan path the manifest names, relative to the repo;
//   spec      false for a manifest spec of null;
//   shas      false for setup events without plan_sha256 and spec_sha256.
function makeRun({ crlf = false, planPath = 'docs/plan.md', spec = true, shas = true } = {}) {
  const root = freshDir('case');
  const proj = join(root, 'proj');
  const run = join(root, 'run');
  const ledger = join(run, 'p.x1.ledger');
  mkdirSync(join(proj, 'docs'), { recursive: true });
  mkdirSync(ledger, { recursive: true });
  git(proj, 'init', '-q');
  git(proj, 'config', 'core.autocrlf', crlf ? 'true' : 'false');
  const eol = crlf ? '\r\n' : '\n';
  if (crlf) writeFileSync(join(proj, '.gitattributes'), '* text=auto eol=crlf\n');
  writeFileSync(join(proj, 'docs', 'plan.md'), `# Plan${eol}committed${eol}`);
  writeFileSync(join(proj, 'docs', 'spec.md'), `# Spec${eol}committed${eol}`);
  git(proj, 'add', '-A');
  git(proj, ...IDENTITY, 'commit', '-q', '-m', 'docs');
  const head = git(proj, 'rev-parse', 'HEAD');
  const plan = join(proj, ...planPath.split('/'));
  const specFile = join(proj, 'docs', 'spec.md');
  const planBytes = readFileSync(join(proj, 'docs', 'plan.md'));
  const specBytes = readFileSync(specFile);
  const manifest = join(run, 'p.lanes.json');
  writeJson(manifest, { version: 1, run_id: 'x1', plan, spec: spec ? specFile : null,
    repo: { mode: 'git', root: proj, ledger_dir: ledger } });
  const event = { task: '_run', event: 'run_started', phase: 'setup', head };
  if (shas) {
    event.plan_sha256 = sha(planBytes);
    event.spec_sha256 = spec ? sha(specBytes) : null;
  }
  writeFileSync(join(ledger, '_run.jsonl'), JSON.stringify(event) + '\n');
  const wf = addLaunch(root);
  return { root, proj, run, ledger, manifest, plan, spec: specFile, wf, head, planBytes, specBytes,
    hist: join(root, 'hist'), folder: join(root, 'hist', '2026-10-10-x1') };
}

// Replaces the recorded events of the ledger with one setup event.
function recordEvent(r, fields) {
  writeFileSync(join(r.ledger, '_run.jsonl'),
    JSON.stringify({ task: '_run', event: 'run_started', phase: 'setup', head: r.head, ...fields }) + '\n');
}

function archive(r) {
  const res = spawnSync('python3', [SCRIPT, r.manifest, r.wf, '--history-dir', r.hist], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

test('a rerun after the live plan changed keeps the pinned copy', () => {
  const r = makeRun();
  const first = archive(r);
  assert.deepEqual(first.pinned.sort(), ['plan.md', 'spec.md']);
  assert.deepEqual(first.warnings, []);
  writeFileSync(r.plan, '# Plan\nedited after the run\n');
  const out = archive(r);
  assert.ok(readFileSync(join(r.folder, 'plan.md')).equals(r.planBytes), 'the archived plan is the committed one');
  assert.ok(out.kept.includes('plan.md'), JSON.stringify(out));
  assert.ok(!out.updated.includes('plan.md'));
  assert.deepEqual(out.replaced, []);
  assert.deepEqual(out.warnings, []);
});

test('an archived spec that differs from the recorded sha is replaced from git at the setup head', () => {
  const r = makeRun();
  archive(r);
  writeFileSync(join(r.folder, 'spec.md'), '# a wrong archived spec\n');
  writeFileSync(r.spec, '# Spec\nedited after the run\n');
  const out = archive(r);
  assert.equal(sha(readFileSync(join(r.folder, 'spec.md'))), sha(r.specBytes));
  assert.deepEqual(out.replaced, ['spec.md']);
  assert.ok(out.updated.includes('spec.md'));
  assert.deepEqual(out.warnings, []);
});

test('a CRLF checkout still pins through --filters', () => {
  const r = makeRun({ crlf: true });
  assert.ok(r.planBytes.includes('\r\n'), 'the working tree holds CRLF');
  const stored = spawnSync('git', ['-C', r.proj, 'show', `${r.head}:docs/plan.md`], { env: cleanEnv() }).stdout;
  assert.ok(!stored.includes('\r\n'), 'git stores LF');
  writeFileSync(r.plan, '# Plan\r\nedited after the run\r\n');
  const out = archive(r);
  assert.equal(sha(readFileSync(join(r.folder, 'plan.md'))), sha(r.planBytes));
  assert.ok(out.pinned.includes('plan.md'), JSON.stringify(out));
  assert.deepEqual(out.warnings, []);
});

test('a path stored in another case still pins', { skip: process.platform === 'linux' && 'a case-sensitive filesystem' }, () => {
  const r = makeRun({ planPath: 'DOCS/Plan.md' });
  writeFileSync(r.plan, '# Plan\nedited after the run\n');
  const out = archive(r);
  assert.equal(sha(readFileSync(join(r.folder, 'Plan.md'))), sha(r.planBytes));
  assert.ok(out.pinned.includes('Plan.md'), JSON.stringify(out));
  assert.deepEqual(out.warnings, []);
});

test('no matching source keeps the copy and warns', () => {
  const r = makeRun();
  const nowhere = sha(Buffer.from('a spec no source holds\n'));
  recordEvent(r, { plan_sha256: sha(r.planBytes), spec_sha256: nowhere });
  // With no archived copy the live spec is copied, with the warning.
  const first = archive(r);
  assert.ok(first.added.includes('spec.md'));
  assert.deepEqual(first.warnings.map((w) => w.code), ['spec_unpinned']);
  assert.ok(readFileSync(join(r.folder, 'spec.md')).equals(r.specBytes));
  writeFileSync(r.spec, '# Spec\nedited after the run\n');
  const out = archive(r);
  assert.equal(out.warnings.length, 1, JSON.stringify(out.warnings));
  assert.equal(out.warnings[0].code, 'spec_unpinned');
  assert.ok(out.warnings[0].detail.includes(nowhere), out.warnings[0].detail);
  assert.ok(readFileSync(join(r.folder, 'spec.md')).equals(r.specBytes), 'the archived spec is unchanged');
  assert.ok(!out.updated.includes('spec.md'));
  for (const key of ['pinned', 'kept', 'replaced']) assert.ok(!out[key].includes('spec.md'), key);
});

test('a ledger without plan_sha256 never replaces an archived plan', () => {
  const r = makeRun({ shas: false });
  archive(r);
  writeFileSync(r.plan, '# Plan\nedited after the run\n');
  const out = archive(r);
  assert.ok(readFileSync(join(r.folder, 'plan.md')).equals(r.planBytes), 'the archived plan stays');
  assert.ok(!out.updated.includes('plan.md'));
  assert.deepEqual(out.warnings, []);
});

function gitAt(gitDir, ...args) {
  const res = spawnSync('git', ['--git-dir', gitDir, ...args], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

test('a shadow-mode run pins from its git dir, with paths relative to repo.root', () => {
  // The project has no .git: its history lives in a separate git dir whose
  // core.worktree is the project, as the shadow mode sets it up.
  const r = makeRun();
  const proj = join(r.root, 'shadowproj');
  const gitDir = join(r.root, 'shadow.git');
  mkdirSync(join(proj, 'docs'), { recursive: true });
  writeFileSync(join(proj, 'docs', 'plan.md'), '# Plan\nin the shadow\n');
  writeFileSync(join(proj, 'docs', 'spec.md'), '# Spec\nin the shadow\n');
  gitAt(gitDir, 'init', '-q');
  gitAt(gitDir, 'config', 'core.bare', 'false');
  gitAt(gitDir, 'config', 'core.worktree', proj);
  gitAt(gitDir, 'config', 'core.autocrlf', 'false');
  gitAt(gitDir, '--work-tree', proj, 'add', '-A');
  gitAt(gitDir, '--work-tree', proj, ...IDENTITY, 'commit', '-q', '-m', 'docs');
  const head = gitAt(gitDir, 'rev-parse', 'HEAD');
  assert.ok(!existsSync(join(proj, '.git')), 'the project holds no git dir');
  const plan = join(proj, 'docs', 'plan.md');
  const specFile = join(proj, 'docs', 'spec.md');
  const planBytes = readFileSync(plan);
  writeJson(r.manifest, { version: 1, run_id: 'x1', plan, spec: specFile,
    repo: { mode: 'shadow', root: proj, git_dir: gitDir, ledger_dir: r.ledger } });
  writeFileSync(join(r.ledger, '_run.jsonl'), JSON.stringify({ task: '_run', event: 'run_started', phase: 'setup',
    head, plan_sha256: sha(planBytes), spec_sha256: sha(readFileSync(specFile)) }) + '\n');
  // Edited after the recorded setup event: only the shadow git dir has the sha.
  writeFileSync(plan, '# Plan\nedited after the run\n');
  const out = archive(r);
  assert.ok(readFileSync(join(r.folder, 'plan.md')).equals(planBytes), 'the archived plan is the shadow commit');
  assert.ok(out.pinned.includes('plan.md'), JSON.stringify(out));
  assert.ok(out.pinned.includes('spec.md'), JSON.stringify(out));
  assert.deepEqual(out.warnings, []);
});

test('a spec of null pins nothing', () => {
  const r = makeRun({ spec: false });
  const out = archive(r);
  assert.ok(!existsSync(join(r.folder, 'spec.md')), 'no spec is archived');
  assert.deepEqual(out.pinned, ['plan.md']);
  assert.deepEqual(out.warnings, []);
});
