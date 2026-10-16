// Join waves end to end on real git (1.6.5 design section 6): the real setup,
// start-task, finish-task, ledger and merge-wave scripts, driven by scripted
// agents that run the commands their prompts hand out. A 2-lane plan whose
// join is one wave of two units; then a run whose second unit stops after a
// commit, and a relaunch through setup, the ledger, the recovery merge and the
// serial continuation.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadScript, SKILL_DIR } from './harness.mjs';
import { BASH, mergeEnv, tempDir } from './platform.mjs';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const TMP = realpathSync(tempDir('pl-join-waves-e2e-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid',
};
const fwd = (p) => p.replace(/\\/g, '/');

function sh(command, env = {}) {
  const r = spawnSync(BASH, ['-c', command], { encoding: 'utf8', env: mergeEnv(process.env, GIT_ENV, env) });
  return { code: r.status, stdout: r.stdout.replace(/\r\n/g, '\n'), stderr: r.stderr };
}
function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: mergeEnv(process.env, GIT_ENV) });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.replace(/\r\n/g, '\n').trim();
}
function py(script, args, env = {}) {
  const r = spawnSync('python3', ['-B', join(SCRIPTS, script), ...args],
    { encoding: 'utf8', env: mergeEnv(process.env, GIT_ENV, env) });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const PLAN = ['# Plan', '', ...['A1', 'B1', 'J1', 'J2'].flatMap((id) => [
  `### Task ${id}: write ${id}`, '', `**Files:** \`${id}.txt\``, '', `Write ${id}.txt.`, '']),
].join('\n');

let counter = 0;
function newCase() {
  counter += 1;
  const root = fwd(join(TMP, `case${counter}`));
  const repo = `${root}/repo`;
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), 'hello\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  writeFileSync(join(root, 'plan.md'), PLAN);
  const task = (id, extra = {}) => ({ id, title: `write ${id}`, files: [`${id}.txt`], tier: 'standard', security: false, ...extra });
  const m = {
    version: 1, run_id: 'w1', plan: `${root}/plan.md`, spec: null, commit_rules: 'plain ASCII',
    repo: { mode: 'git', root: repo, git_dir: null, base_ref: 'main', branch: 'feature/w', worktree_root: `${root}/wt`,
      ledger_dir: `${root}/ledger` },
    commands: { setup: [], test: [], lint: [], build: [] },
    prelude: [],
    lanes: [{ id: 'a', name: 'Lane a', tasks: [task('A1')] }, { id: 'b', name: 'Lane b', tasks: [task('B1')] }],
    join: [task('J1', { depends_on: [] }), task('J2', { depends_on: [] })],
    hooks: {}, limits: { review_rounds: 2, max_parallel_lanes: 2 }, dry_run: false, done: [], reviewed: [],
    sp_dir: null, skill_dir: fwd(SKILL_DIR), autonomy: 'supervised',
  };
  return { root, repo, m, active: `${root}/active` };
}

// scripts/setup as the holder of the run's launch lock; its output.
function setup(c, m) {
  const path = `${c.root}/manifest.json`;
  writeFileSync(path, JSON.stringify(m));
  if (!c.token) {
    const got = spawnSync(BASH, [join(SCRIPTS, 'active-run'), 'acquire', m.run_id, path],
      { encoding: 'utf8', env: mergeEnv(process.env, { PL_ACTIVE_DIR: c.active }) });
    assert.equal(got.status, 0, got.stderr);
    c.token = got.stdout.trim();
  }
  const r = py('setup', [path, '--owner', c.token], { PL_ACTIVE_DIR: c.active });
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
}

// The line after the first line of prompt that matches re, trimmed.
function lineAfter(prompt, re) {
  const lines = prompt.split('\n');
  const i = lines.findIndex((l) => re.test(l));
  assert.ok(i >= 0 && i + 1 < lines.length, `no line after ${re} in:\n${prompt}`);
  return lines[i + 1].trim();
}
const lineWith = (prompt, needle) => {
  const line = prompt.split('\n').find((l) => l.includes(needle));
  assert.ok(line, `no line with ${needle}`);
  return line.trim();
};
const dirOf = (command) => command.match(/^cd '([^']*)'/)[1];
function run1(command) {
  const r = sh(command);
  assert.equal(r.code, 0, `${command}\n${r.stderr}${r.stdout}`);
  return r.stdout;
}

// Scripted agents. stopAfterCommit: unit ids whose implementer commits,
// records it, and then reports blocked (with an uncommitted change left).
function agents(c, { stopAfterCommit = [] } = {}) {
  const calls = [];
  const featureHead = () => git(c.repo, 'rev-parse', 'HEAD');
  const agent = async (prompt, opts) => {
    calls.push({ label: opts.label, prompt });
    const label = opts.label;
    const [id, role] = label.split(' ');
    if (label === 'pre-flight') return { conflicts: [], rulings: [], undeclared: [], code_deps: [] };
    if (label === 'integrate') {
      for (const lane of ['a', 'b']) {
        const merged = sh(`git -C '${c.repo}' merge-base --is-ancestor 'pl-w1-${lane}' HEAD`).code === 0;
        if (!merged) git(c.repo, 'merge', '-q', '--no-ff', '-m', `merge lane ${lane}`, `pl-w1-${lane}`);
      }
      return { status: 'done', head: featureHead(), notes: 'merged' };
    }
    if (/^(wave \d+|recovery) merge$/.test(label)) {
      const r = sh(lineAfter(prompt, /^1\. Run, as one call:/));
      assert.ok(r.code === 0 || r.code === 1, r.stderr);
      const out = JSON.parse(r.stdout);
      return { ...out, status: out.status === 'merged' ? 'done' : 'conflict', conflict_unit: out.conflict_unit || '' };
    }
    if (label.startsWith('final review')) return { findings: [], cannot_verify: [], head: featureHead() };
    if (role === 'implement') {
      const start = lineAfter(prompt, /^Run this first, as one call/);
      run1(start);
      const dir = dirOf(start);
      writeFileSync(join(dir, `${id}.txt`), `${id}\n`);
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', `feat: write ${id}`);
      run1(lineWith(prompt, "/scripts/finish-task' "));
      const head = git(dir, 'rev-parse', 'HEAD');
      if (stopAfterCommit.includes(id)) {
        writeFileSync(join(dir, `${id}-wip.txt`), 'unfinished\n');
        return { status: 'blocked', head, tests: '', notes: `${id} could not finish` };
      }
      return { status: 'done', head, tests: '(none)', notes: '', changed_lines: 1 };
    }
    if (role === 'review') {
      const cmd = lineWith(prompt, "/scripts/ledger' reviewed").replace('<blocking>', '0');
      run1(cmd);
      return { verdict: 'approve', findings: [], cannot_verify: [] };
    }
    throw new Error(`unscripted agent: ${label}`);
  };
  return { agent, calls };
}

async function runAll(m, scripted) {
  const parallel = (thunks) => Promise.all(thunks.map((t) => t().catch(() => null)));
  return loadScript({ args: m, agent: scripted.agent, parallel, phase: () => {}, log: () => {} });
}
const subjects = (c, range) => git(c.repo, 'log', '--first-parent', '--format=%s', range).split('\n').filter(Boolean);
const ledgerStatus = (c) => {
  const r = py('ledger', ['status', c.m.repo.ledger_dir, '--plan', c.m.plan]);
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test('a join wave runs on unit branches in lane worktrees and is merged', async () => {
  const c = newCase();
  const setupResult = setup(c, c.m);
  const s = agents(c);
  const result = await runAll({ ...c.m, setup_result: setupResult }, s);
  assert.equal(result.status, 'complete', JSON.stringify(result.reason || result.errors));
  for (const id of ['J1', 'J2']) {
    const p = s.calls.find((x) => x.label === `${id} implement`).prompt;
    assert.ok(p.includes(`--unit-branch 'pl-w1-u-${id}'`), id);
    assert.ok(/cd '[^']*\/wt\/lane-[ab]'/.test(lineAfter(p, /^Run this first/)), `${id} runs in a lane worktree`);
  }
  const subs = subjects(c, 'main..feature/w');
  assert.ok(subs.includes('join wave 1: merge J1') && subs.includes('join wave 1: merge J2'), subs.join('\n'));
  assert.ok(existsSync(join(c.repo, 'J1.txt')) && existsSync(join(c.repo, 'J2.txt')));
  const events = readFileSync(`${c.m.repo.ledger_dir}/_run.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(events.some((e) => e.event === 'wave_merged' && e.wave === 1 && e.units.join() === 'J1,J2'));
  assert.deepEqual(result.join_waves.map((w) => w.units), [['J1', 'J2']]);
});

test('a stop mid-wave relaunches through setup, recovery and the serial continuation', async () => {
  const c = newCase();
  const first = await runAll({ ...c.m, setup_result: setup(c, c.m) }, agents(c, { stopAfterCommit: ['J2'] }));
  assert.equal(first.status, 'stopped');
  assert.equal(first.tasks.J1.status, 'done');
  assert.equal(first.tasks.J2.status, 'blocked');
  assert.ok(subjects(c, 'main..feature/w').includes('join wave 1: merge J1'), 'the finished unit was merged');
  assert.ok(!subjects(c, 'main..feature/w').includes('join wave 1: merge J2'), 'the stopped unit was not');
  const j2Head = git(c.repo, 'rev-parse', 'pl-w1-u-J2');

  // The relaunch, as SKILL.md's resume builds it: setup returns both lane
  // worktrees from their unit branches, saving J2's unfinished change.
  const again = setup(c, c.m);
  assert.deepEqual(again.returned.map((r) => r.from).sort(), ['pl-w1-u-J1', 'pl-w1-u-J2'], JSON.stringify(again.returned));
  const j2Tree = fwd(again.returned.find((r) => r.from === 'pl-w1-u-J2').worktree);
  const saved = again.preserved.find((p) => fwd(p.worktree) === j2Tree);
  assert.ok(saved, 'the unfinished change was saved');
  assert.equal(git(c.repo, 'show', `${saved.ref}:J2-wip.txt`), 'unfinished');
  const status = ledgerStatus(c);
  assert.equal(status.join_started, true);
  assert.deepEqual(Object.keys(status.unit_branches).sort(), ['J1', 'J2']);
  const manifestPath = `${c.root}/manifest.json`;
  writeFileSync(manifestPath, JSON.stringify(c.m));
  const bf = py('ledger', ['backfill', c.m.repo.ledger_dir, manifestPath]);
  assert.equal(bf.code, 0, bf.stdout + bf.stderr);
  const back = JSON.parse(bf.stdout);
  const m2 = {
    ...c.m, setup_result: again, done: status.done, reviewed: status.reviewed, deferred: status.deferred,
    backfill: back.backfill, join_started: status.join_started, unit_branches: status.unit_branches,
    wave_merges: status.wave_merges, ...(back.join_tip ? { join_tip: back.join_tip } : {}),
    start_points: status.start_points,
  };
  const s = agents(c);
  const second = await runAll(m2, s);
  assert.equal(second.status, 'complete', JSON.stringify(second.reason || second.errors));
  const labels = s.calls.map((x) => x.label);
  assert.ok(labels.includes('recovery merge'));
  assert.ok(!labels.some((l) => /^J1 /.test(l)), 'J1 is merged and reviewed: not run again');
  const j2 = s.calls.find((x) => x.label === 'J2 implement').prompt;
  assert.ok(j2.includes('--restart') && j2.includes('pl-w1-u-J2'), 'J2 restarts, told where its work was');
  assert.ok(!j2.includes('--unit-branch'), 'on the feature checkout');
  // Integration merged no unit work, and J2's earlier head never reached the feature branch.
  assert.equal(sh(`git -C '${c.repo}' merge-base --is-ancestor '${j2Head}' feature/w`).code, 1);
  assert.ok(existsSync(join(c.repo, 'J2.txt')), 'J2 was redone on the feature branch');
  const after2 = ledgerStatus(c);
  assert.ok(after2.done.includes('J2') && after2.reviewed.includes('J2'));
  assert.deepEqual(after2.inconsistent, []);
});
