// 1.6.3 review carry-over: ruling roles, ids, scope and overrides; the
// rulings print; carry-launch and open-minor snapshots; the owner map.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { tempDir, mergeEnv } from './platform.mjs';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const TMP = tempDir('pl-carry-');
after(() => rmSync(TMP, { recursive: true, force: true }));

let counter = 0;
function freshDir(name = 'ledger') {
  counter += 1;
  const dir = join(TMP, `case ${counter}`, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function run(script, args, env = {}) {
  const res = spawnSync('python3', [join(SCRIPTS, script), ...args], {
    encoding: 'utf8', env: mergeEnv(process.env, env),
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}
const ledger = (...args) => run('ledger', args);

function appendOk(dir, lane, entry) {
  const res = ledger('append', dir, lane, JSON.stringify(entry));
  assert.equal(res.code, 0, res.stderr);
}

function rulingsOut(dir, ...extra) {
  const res = ledger('rulings', dir, ...extra);
  assert.equal(res.code, 0, res.stderr);
  return res.stdout;
}

// ---- Task 1: fields, ids, rulings ----

test('append refuses a ruling role, scope or overrides of the wrong kind', () => {
  const dir = freshDir();
  for (const bad of [{ by: 'boss' }, { scope: 'all' }, { overrides: 'x' }, { files: 'a.js' }, { pf: 'P1' }]) {
    const res = ledger('append', dir, 'alpha', JSON.stringify({ task: 'T2', event: 'ruling', text: 'R', ...bad }));
    assert.equal(res.code, 2, `${JSON.stringify(bad)}: ${res.stderr}`);
  }
  appendOk(dir, 'alpha', {
    task: 'T2', event: 'ruling', text: 'R', by: 'implementer', scope: 'run', overrides: ['alpha-R1'],
    files: ['src/a.js'],
  });
  appendOk(dir, '_run', { task: '_run', event: 'ruling', text: 'P', by: 'preflight', pf: 'PF-1', wf: 'wf_abcdef-123' });
});

test('minors and carried events belong to _run only', () => {
  const dir = freshDir();
  assert.equal(ledger('append', dir, 'alpha', JSON.stringify({ task: 'T2', event: 'minors', open: [] })).code, 2);
  assert.equal(ledger('append', dir, '_run', JSON.stringify({ task: '_run', event: 'minors', open: 'x' })).code, 2);
  appendOk(dir, '_run', { task: '_run', event: 'minors', wf: 'wf_abcdef-123', open: [], covered: [] });
  appendOk(dir, '_run', { task: '_run', event: 'carried', wf: 'wf_abcdef-123', pf: {}, bound: [] });
});

test('rulings numbers each file in append order and prints role, task and scope', () => {
  const dir = freshDir();
  appendOk(dir, 'alpha', { task: 'T2', event: 'ruling', text: 'Ruling: a - b - c', by: 'implementer' });
  appendOk(dir, 'alpha', { task: 'T3', event: 'ruling', text: 'Ruling: d - e - f', by: 'adjudicator', scope: 'run' });
  appendOk(dir, 'beta', { task: 'T4', event: 'ruling', text: 'Ruling: g - h - i' });
  const out = rulingsOut(dir);
  assert.ok(out.includes('alpha-R1 [implementer, T2, lane] Ruling: a - b - c'), out);
  assert.ok(out.includes('alpha-R2 [adjudicator, T3, run] Ruling: d - e - f'), out);
  // A ruling with no by is an implementer's (written before 1.6.3).
  assert.ok(out.includes('beta-R1 [implementer, T4, lane] Ruling: g - h - i'), out);
});

test('rulings --lane shows _run, the prelude, the lane and run-scope rulings only', () => {
  const dir = freshDir();
  appendOk(dir, '_run', { task: '_run', event: 'ruling', text: 'RUN', by: 'adjudicator' });
  appendOk(dir, 'prelude', { task: 'T1', event: 'ruling', text: 'PRE', by: 'implementer' });
  appendOk(dir, 'alpha', { task: 'T2', event: 'ruling', text: 'ALPHA', by: 'implementer' });
  appendOk(dir, 'beta', { task: 'T4', event: 'ruling', text: 'BETA', by: 'implementer' });
  appendOk(dir, 'beta', { task: 'T4', event: 'ruling', text: 'BETA-RUN', by: 'implementer', scope: 'run' });
  const out = rulingsOut(dir, '--lane', 'alpha');
  for (const want of ['RUN', 'PRE', 'ALPHA', 'BETA-RUN']) assert.ok(out.includes(`] ${want}`), `${want}: ${out}`);
  assert.ok(!out.includes('] BETA\n'), out);
  assert.ok(out.includes('beta-R2 ['), 'ids count the whole file, not the filtered view');
});

test('an overridden ruling is listed apart with the ruling that overrode it', () => {
  const dir = freshDir();
  appendOk(dir, 'alpha', { task: 'T2', event: 'ruling', text: 'OLD', by: 'implementer' });
  appendOk(dir, 'alpha', { task: 'T3', event: 'ruling', text: 'NEW', by: 'adjudicator', overrides: ['alpha-R1'] });
  appendOk(dir, 'alpha', { task: 'T3', event: 'ruling', text: 'GHOST', by: 'adjudicator', overrides: ['zeta-R9'] });
  const out = rulingsOut(dir);
  const [inForce, overridden] = out.split('Overridden:');
  assert.ok(inForce.includes('alpha-R2 [adjudicator, T3, lane] NEW (overrides alpha-R1)'), out);
  assert.ok(inForce.includes('(overrides zeta-R9 (unknown))'), out);
  assert.ok(!inForce.includes('] OLD'), out);
  assert.ok(overridden.includes('alpha-R1 by alpha-R2'), out);
});

test('rulings lists the files a ruling permits, and prints (none) for an empty ledger', () => {
  const dir = freshDir();
  assert.equal(rulingsOut(dir).trim(), '(none)');
  appendOk(dir, 'alpha', { task: 'T2', event: 'ruling', text: 'MAY', by: 'adjudicator', files: ['src/b.js', 'src/c.js'] });
  assert.ok(rulingsOut(dir).includes('MAY (files src/b.js, src/c.js)'));
});

// ---- Task 2: carry-launch, open-minor snapshots, status ----

const minor = (id, task, issue = `issue ${id}`) => ({ id, severity: 'minor', file: `src/${task}.js`, line: 3, issue, fix: 'fix it' });

// A Claude config dir holding one session's workflow result file, as the
// Workflow tool writes it; returns {config, transcripts} (the transcript dir).
function launchFile(config, wf, { rulings = [], adjudicated = null, tasks = {}, final = null, args = {} } = {}) {
  const session = join(config, 'projects', 'C--work', 'sess-1');
  mkdirSync(join(session, 'workflows'), { recursive: true });
  const transcripts = join(session, 'subagents', 'workflows', wf);
  mkdirSync(transcripts, { recursive: true });
  const result = {
    status: 'complete', run_id: 'run-1', tasks,
    preflight: { conflicts: [], rulings, undeclared: [], schedule: [], adjudicated },
    final,
  };
  writeFileSync(join(session, 'workflows', `${wf}.json`), JSON.stringify({ runId: wf, args, result }));
  return transcripts;
}
const done = (minors) => ({ status: 'done', rounds: 0, tier_used: 'standard', commits: null, notes: '',
  ...(minors === undefined ? {} : { minor_findings: minors, rulings: [] }) });
const finalOf = (taskOpen, carriedOpen = []) => ({ findings: [], task_minors_open: taskOpen.map((id) => ({ id })),
  carried_minors_open: carriedOpen });

function carry(dir, source, env = {}) {
  const res = run('ledger', ['carry-launch', dir, source], env);
  return { ...res, json: res.code === 0 ? JSON.parse(res.stdout) : null };
}
function statusOf(dir) {
  const res = ledger('status', dir);
  assert.equal(res.code, 0, res.stderr);
  return JSON.parse(res.stdout);
}

test('carry-launch records pre-flight rulings, skipping the adjudication the adjudicator already recorded', () => {
  const dir = freshDir();
  const config = freshDir('config');
  appendOk(dir, '_run', { task: '_run', event: 'ruling', by: 'adjudicator', text: 'Ruling: ADJ - w - c' });
  const t = launchFile(config, 'wf_aaaaaa-111', { rulings: ['Ruling: A - w - c', 'ADJ', 'Ruling: B - w - c'], adjudicated: 1 });
  const out = carry(dir, t);
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(out.json, { carried: 'wf_aaaaaa-111', rulings: 2, open_minors: 0 });
  const printed = rulingsOut(dir);
  assert.ok(printed.includes('_run-R2 [preflight, _run, run] Ruling: A - w - c'), printed);
  assert.ok(printed.includes('_run-R3 [preflight, _run, run] Ruling: B - w - c'), printed);
  assert.equal(printed.split('ADJ').length, 2, 'the adjudication appears once');
});

test('carry-launch finds a launch by its wf id under the Claude config dir, and runs once per launch', () => {
  const dir = freshDir();
  const config = freshDir('config');
  launchFile(config, 'wf_bbbbbb-222', { rulings: ['R1'], tasks: { T1: done([minor('T1-1', 'T1')]) } });
  const first = carry(dir, 'wf_bbbbbb-222', { CLAUDE_CONFIG_DIR: config });
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(first.json, { carried: 'wf_bbbbbb-222', rulings: 1, open_minors: 1 });
  const before = readFileSync(join(dir, '_run.jsonl'), 'utf8');
  const again = carry(dir, 'wf_bbbbbb-222', { CLAUDE_CONFIG_DIR: config });
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual(again.json, { carried: 'wf_bbbbbb-222', already: true });
  assert.equal(readFileSync(join(dir, '_run.jsonl'), 'utf8'), before);
});

test('carry-launch with no readable result writes nothing and exits 3', () => {
  const dir = freshDir();
  const config = freshDir('config');
  const res = carry(dir, 'wf_cccccc-333', { CLAUDE_CONFIG_DIR: config });
  assert.equal(res.code, 3, res.stdout);
  assert.equal(statusOf(dir).minors.open.length, 0);
});

test('open minors carry across three launches: raised ones drop, a re-reviewed task replaces its own', () => {
  const dir = freshDir();
  const config = freshDir('config');
  // Launch 1 stopped before the final review: every minor stays open.
  carry(dir, launchFile(config, 'wf_l1aaaa-001', {
    tasks: { T1: done([minor('T1-1', 'T1'), minor('T1-2', 'T1')]), T2: done([minor('T2-1', 'T2')]) },
  }));
  assert.deepEqual(statusOf(dir).minors, { open: ['T1-1', 'T1-2', 'T2-1'], covered: ['T1', 'T2'] });
  // Launch 2: its final raised T1-1 (carried) and T3-1 (its own).
  carry(dir, launchFile(config, 'wf_l2aaaa-002', {
    tasks: { T1: { status: 'skipped' }, T2: { status: 'skipped' }, T3: done([minor('T3-1', 'T3'), minor('T3-2', 'T3')]) },
    final: finalOf(['T3-2'], ['T1-2', 'T2-1']),
    args: { carried_minors: { open: ['T1-1', 'T1-2', 'T2-1'], covered: ['T1', 'T2'] } },
  }));
  assert.deepEqual(statusOf(dir).minors, { open: ['T1-2', 'T2-1', 'T3-2'], covered: ['T1', 'T2', 'T3'] });
  // Launch 3 reviews T2 again: its old entry is replaced by the new review's.
  carry(dir, launchFile(config, 'wf_l3aaaa-003', {
    tasks: { T2: done([minor('T2-1', 'T2', 'the new wording')]) },
    final: finalOf(['T2-1'], ['T1-2', 'T3-2']),
    args: { carried_minors: { open: ['T1-2', 'T3-2'], covered: ['T1', 'T2', 'T3'] } },
  }));
  const printed = ledger('minors', dir).stdout;
  assert.ok(printed.includes('[T2-1] T2 src/T2.js:3 - the new wording (fix: fix it)'), printed);
  assert.ok(!printed.includes('issue T2-1'), printed);
  assert.deepEqual(statusOf(dir).minors.open, ['T1-2', 'T3-2', 'T2-1']);
});

test('a 1.6.2 result carries no minors and covers none of its tasks', () => {
  const dir = freshDir();
  const config = freshDir('config');
  carry(dir, launchFile(config, 'wf_old162-001', { tasks: { T1: done(undefined) } }));
  assert.deepEqual(statusOf(dir).minors, { open: [], covered: [] });
  assert.equal(ledger('minors', dir).stdout.trim(), '(none)');
});

test("a ruling that overrides a launch's PF-n resolves to that launch's carried pre-flight ruling", () => {
  const dir = freshDir();
  const config = freshDir('config');
  appendOk(dir, 'alpha', { task: 'T2', event: 'ruling', by: 'adjudicator', text: 'NEW', overrides: ['PF-2'] });
  carry(dir, launchFile(config, 'wf_pfaaaa-001', { rulings: ['ONE', 'TWO'] }));
  const out = rulingsOut(dir);
  assert.ok(out.includes('alpha-R1 [adjudicator, T2, lane] NEW (overrides _run-R2)'), out);
  assert.ok(out.split('Overridden:')[1].includes('_run-R2 by alpha-R1'), out);
  assert.deepEqual(statusOf(dir).overrides,
    [{ id: 'alpha-R1', by: 'adjudicator', task: 'T2', overrides: ['_run-R2'], unknown: [],
      targets: [{ id: '_run-R2', role: 'preflight', lane: '_run' }] }]);
});

test('a 1.6.2 result with pre-flight conflicts: the last pre-flight ruling is the adjudication, carried once', () => {
  const dir = freshDir();
  const config = freshDir('config');
  appendOk(dir, '_run', { task: '_run', event: 'ruling', by: 'adjudicator', text: 'Ruling: clarify_plan - x - y' });
  const session = join(config, 'projects', 'C--work', 'sess-1');
  mkdirSync(join(session, 'workflows'), { recursive: true });
  // 1.6.2 had no preflight.adjudicated: it pushed the adjudication last.
  const result = { status: 'complete', tasks: {}, final: null,
    preflight: { conflicts: ['FP3 vs check-metas'], rulings: ['Ruling: A - w - c', 'Change to FP3 for this run'], undeclared: [], schedule: [] } };
  writeFileSync(join(session, 'workflows', 'wf_old162-adj.json'), JSON.stringify({ runId: 'wf_old162-adj', args: {}, result }));
  const out = carry(dir, 'wf_old162-adj', { CLAUDE_CONFIG_DIR: config });
  assert.deepEqual(out.json, { carried: 'wf_old162-adj', rulings: 1, open_minors: 0 }, out.stderr);
  assert.ok(!rulingsOut(dir).includes('Change to FP3'));
});

// ---- Task 3: the owner map ----

const otask = (id, files) => ({ id, title: id, files, tier: 'standard', security: false });
function ownersManifest(dir) {
  const m = {
    version: 1, run_id: 'run-1',
    repo: { mode: 'git', root: dir, git_dir: null, ledger_dir: join(dir, 'ledger') },
    prelude: [otask('P1', ['a.txt'])],
    lanes: [
      { id: 'alpha', name: 'Lane alpha', tasks: [otask('T2', ['src/x.js', 'shared.css']), otask('T3', ['.\\SRC\\x2.js'])] },
      { id: 'beta', name: 'Lane beta', tasks: [otask('T4', ['src/y.js', 'shared.css'])] },
    ],
    join: [otask('J1', ['src/z.js'])],
  };
  const path = join(dir, 'm.lanes.json');
  writeFileSync(path, JSON.stringify(m));
  return path;
}
function ownersOf(dir, ...args) {
  const res = ledger('owners', dir, ...args);
  assert.equal(res.code, 0, res.stderr);
  return res.stdout;
}

test('write-owners maps every path to the tasks that list it, and owners annotates by run order', () => {
  const root = freshDir('proj');
  const dir = join(root, 'ledger');
  const res = ledger('write-owners', dir, ownersManifest(root));
  assert.equal(res.code, 0, res.stderr);
  const map = JSON.parse(readFileSync(join(dir, 'owners.json'), 'utf8'));
  assert.deepEqual(map.files['shared.css'], ['T2', 'T4']);
  assert.deepEqual(map.tasks.T3, { where: 'alpha', pos: 1 });
  const out = ownersOf(dir, '--task', 'T2', 'src/y.js', 'a.txt', 'src/z.js', 'shared.css', 'new.js', 'src/x2.js', 'SRC/X.js');
  assert.ok(out.includes('src/y.js (owned by T4, another lane, running alongside)'), out);
  assert.ok(out.includes('a.txt (owned by P1, earlier in the run)'), out);
  assert.ok(out.includes('src/z.js (owned by J1, later)'), out);
  assert.ok(out.includes('shared.css (in your Files list; also in T4\'s Files)'), out);
  assert.ok(out.includes('new.js (no task owns it)'), out);
  assert.ok(out.includes('src/x2.js (owned by T3, later)'), out);
  assert.ok(out.includes('SRC/X.js (in your Files list)'), out);
  // Files entries match normalized: a Windows-form .\SRC\x2.js is src/x2.js.
  assert.deepEqual(map.files['src/x2.js'], ['T3']);
  assert.ok(ownersOf(dir, '--task', 'J1', 'src/x.js').includes('owned by T2, earlier in the run'));
  assert.ok(ownersOf(dir, '--task', 'P1', 'src/x.js').includes('owned by T2, later'));
  assert.ok(ownersOf(dir, '--task', 'T3', 'src/x.js').includes('owned by T2, earlier in the run'));
  // A batch unit names all its tasks.
  assert.ok(ownersOf(dir, '--task', 'T2', '--task', 'T3', 'src/x2.js').includes('(in your Files list)'));
});

test('owners without an owner map exits 3', () => {
  const dir = freshDir();
  assert.equal(ledger('owners', dir, '--task', 'T2', 'a.txt').code, 3);
});

// ---- Review fixes ----

test('an override takes effect only in views that show the overriding ruling, and only within the rules', () => {
  const dir = freshDir();
  appendOk(dir, 'beta', { task: 'T4', event: 'ruling', by: 'implementer', text: 'BETA-KEEPS' });
  appendOk(dir, '_run', { task: '_run', event: 'ruling', by: 'adjudicator', text: 'RUN-WIDE' });
  appendOk(dir, 'alpha', { task: 'T2', event: 'ruling', by: 'implementer', text: 'MINE', overrides: ['beta-R1', '_run-R1'] });
  // beta's view does not show alpha-R1: both targets stay in force there.
  const beta = rulingsOut(dir, '--lane', 'beta');
  assert.ok(beta.includes('beta-R1 [implementer, T4, lane] BETA-KEEPS') && beta.includes('] RUN-WIDE'), beta);
  // Even where alpha-R1 shows, an implementer cannot override another lane's or an adjudicator's ruling.
  const all = rulingsOut(dir);
  assert.ok(all.includes('] RUN-WIDE') && all.includes('] BETA-KEEPS'), all);
  assert.ok(all.includes('(overrides beta-R1 (against the rule), _run-R1 (against the rule))'), all);
  // Within the rules it takes effect.
  appendOk(dir, 'alpha', { task: 'T3', event: 'ruling', by: 'implementer', text: 'NEWER', overrides: ['alpha-R1'] });
  assert.ok(rulingsOut(dir, '--lane', 'alpha').split('Overridden:')[1].includes('alpha-R1 by alpha-R2'));
});

test("a PF-n not yet bound is this launch's pre-flight ruling, not unknown", () => {
  const dir = freshDir();
  appendOk(dir, 'alpha', { task: 'T2', event: 'ruling', by: 'adjudicator', text: 'X', overrides: ['PF-2'] });
  const out = rulingsOut(dir);
  assert.ok(out.includes("(overrides PF-2 (this launch's pre-flight))"), out);
  assert.deepEqual(statusOf(dir).overrides[0].unknown, []);
});

// A ledger with two launches: setup run_started events and doctor files that
// name each launch's setup_event, as the session's ledger conditions writes.
function twoLaunchLedger(dir) {
  const started = (head) => ({ task: '_run', event: 'run_started', phase: 'setup', head, plan_sha256: null, spec_sha256: null });
  appendOk(dir, '_run', started('h1'));
  appendOk(dir, '_run', { task: '_run', event: 'ruling', by: 'adjudicator', text: 'ADJ-ONE' });
  appendOk(dir, '_run', started('h2'));
  appendOk(dir, '_run', { task: '_run', event: 'ruling', by: 'adjudicator', text: 'ADJ-TWO' });
  writeFileSync(join(dir, 'doctor-wf_one111-001.json'), JSON.stringify({ launch: { wf: 'wf_one111-001', setup_event: 1 } }));
  writeFileSync(join(dir, 'doctor-wf_two222-002.json'), JSON.stringify({ launch: { wf: 'wf_two222-002', setup_event: 2 } }));
}

test("carry-launch maps a launch's adjudication to the adjudicator ruling of that launch's window", () => {
  const dir = freshDir();
  const config = freshDir('config');
  twoLaunchLedger(dir);
  const conflicts = { rulings: ['P', 'ADJ'], adjudicated: 1 };
  assert.equal(carry(dir, launchFile(config, 'wf_one111-001', conflicts)).code, 0);
  assert.equal(carry(dir, launchFile(config, 'wf_two222-002', conflicts)).code, 0);
  const carried = readFileSync(join(dir, '_run.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    .filter((e) => e.event === 'carried');
  assert.deepEqual(carried.map((c) => c.pf['PF-2']), ['_run-R1', '_run-R2']);
});

test('carry-launch refuses a launch while an earlier launch is not carried', () => {
  const dir = freshDir();
  const config = freshDir('config');
  twoLaunchLedger(dir);
  launchFile(config, 'wf_one111-001');
  const later = carry(dir, launchFile(config, 'wf_two222-002'));
  assert.equal(later.code, 3, later.stdout);
  assert.match(later.stderr, /wf_one111-001/);
  assert.equal(carry(dir, 'wf_one111-001', { CLAUDE_CONFIG_DIR: config }).code, 0);
  assert.equal(carry(dir, 'wf_two222-002', { CLAUDE_CONFIG_DIR: config }).code, 0);
});

test('status says the spec did not change when no launch recorded one and none is given', () => {
  const dir = freshDir();
  const plan = join(dir, '..', 'plan.md');
  writeFileSync(plan, '# Plan\n');
  appendOk(dir, '_run', { task: '_run', event: 'run_started', phase: 'setup', head: 'h1', plan_sha256: null, spec_sha256: null });
  assert.equal(statusOf2(dir, '--plan', plan).inputs.spec_changed, false);
});
function statusOf2(dir, ...extra) {
  const res = ledger('status', dir, ...extra);
  assert.equal(res.code, 0, res.stderr);
  return JSON.parse(res.stdout);
}

test('owners takes an absolute path inside the checkout as relative, refuses one outside, and checks task ids', () => {
  const root = freshDir('proj');
  const dir = join(root, 'ledger');
  assert.equal(ledger('write-owners', dir, ownersManifest(root)).code, 0);
  const inside = spawnSync('python3', [join(SCRIPTS, 'ledger'), 'owners', dir, '--task', 'T2', join(root, 'src', 'y.js')],
    { encoding: 'utf8', cwd: root });
  assert.equal(inside.status, 0, inside.stderr);
  assert.ok(inside.stdout.includes('(owned by T4, another lane, running alongside)'), inside.stdout);
  const outside = spawnSync('python3', [join(SCRIPTS, 'ledger'), 'owners', dir, '--task', 'T2', join(TMP, 'elsewhere.js')],
    { encoding: 'utf8', cwd: root });
  assert.equal(outside.status, 2, outside.stdout);
  assert.equal(ledger('owners', dir, '--task', 'NOPE', 'a.txt').code, 2);
  assert.equal(ledger('owners', dir, '--task', 'T2', '--task', 'bad/id', 'a.txt').code, 2);
});

test('a final review result without carried_minors_open raised none of the carried minors', () => {
  const dir = freshDir();
  const config = freshDir('config');
  carry(dir, launchFile(config, 'wf_m1aaaa-001', { tasks: { T1: done([minor('T1-1', 'T1')]) } }));
  carry(dir, launchFile(config, 'wf_m2aaaa-002', {
    tasks: {}, final: { findings: [], task_minors_open: [] },
    args: { carried_minors: { open: ['T1-1'], covered: ['T1'] } },
  }));
  assert.deepEqual(statusOf(dir).minors.open, ['T1-1']);
});

// ---- 1.6.4: the 1.6.3 deferred minors ----

// Loads scripts/ledger as a module in a python3 subprocess and runs code with
// it as L; returns the process result.
function withLedgerModule(code, args = []) {
  const loader = `import importlib.machinery, sys; L = importlib.machinery.SourceFileLoader('ledger', sys.argv[1]).load_module()\n${code}`;
  // -B: no __pycache__ beside the scripts (the suite leaves the checkout unchanged).
  return spawnSync('python3', ['-B', '-c', loader, join(SCRIPTS, 'ledger'), ...args], { encoding: 'utf8' });
}

test('append_entries writes every entry or none: an invalid one stops all of them', () => {
  const dir = freshDir();
  const good = { task: '_run', event: 'ruling', by: 'preflight', text: 'R' };
  const bad = { task: '_run', event: 'minors', wf: 'wf_x', open: 'not a list' };
  const res = withLedgerModule(
    'import json\ntry:\n    L.append_entries(sys.argv[2], "_run", json.loads(sys.argv[3]))\nexcept SystemExit as e:\n    print("exit", e.code)\n',
    [dir, JSON.stringify([good, bad])]);
  assert.match(res.stdout, /exit 2/, res.stderr);
  assert.equal(rulingsOut(dir).trim(), '(none)');
  const ok = withLedgerModule('import json\nL.append_entries(sys.argv[2], "_run", json.loads(sys.argv[3]))\n',
    [dir, JSON.stringify([good, { ...good, text: 'S' }])]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(readFileSync(join(dir, '_run.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).text), ['R', 'S']);
});

test('carry-launch refuses a ledger dir that does not exist and creates nothing', () => {
  const missing = join(freshDir(), 'no such ledger');
  const config = freshDir('config');
  const res = carry(missing, launchFile(config, 'wf_nodira-001', { rulings: ['R'] }));
  assert.equal(res.code, 3, res.stdout);
  assert.equal(spawnSync('python3', ['-c', 'import os,sys; print(os.path.exists(sys.argv[1]))', missing],
    { encoding: 'utf8' }).stdout.trim(), 'False');
});

test("status overrides names each overridden ruling's role and lane", () => {
  const dir = freshDir();
  appendOk(dir, '_run', { task: '_run', event: 'ruling', by: 'adjudicator', text: 'RUN' });
  appendOk(dir, 'alpha', { task: 'T2', event: 'ruling', by: 'implementer', text: 'X', overrides: ['_run-R1', 'zeta-R9'] });
  assert.deepEqual(statusOf(dir).overrides, [{
    id: 'alpha-R1', by: 'implementer', task: 'T2', overrides: ['_run-R1', 'zeta-R9'], unknown: ['zeta-R9'],
    targets: [{ id: '_run-R1', role: 'adjudicator', lane: '_run' }],
  }]);
});

test('write-owners prints the owner map path with forward slashes', () => {
  const root = freshDir('proj');
  const res = ledger('write-owners', join(root, 'ledger'), ownersManifest(root));
  assert.equal(res.code, 0, res.stderr);
  assert.ok(!JSON.parse(res.stdout).owners.includes('\\'), res.stdout);
});

test("a batch's minors are carried once, under the batch's first task", () => {
  const dir = freshDir();
  const config = freshDir('config');
  // A batch result repeats the unit's minors for each of its tasks.
  const unit = [minor('T2-T3-1', 'T2'), minor('T2-T3-2', 'T2')];
  carry(dir, launchFile(config, 'wf_batch1-001', { tasks: { T2: { ...done(unit), batch: 'T2-T3' }, T3: { ...done(unit), batch: 'T2-T3' } } }));
  assert.deepEqual(statusOf(dir).minors, { open: ['T2-T3-1', 'T2-T3-2'], covered: ['T2', 'T3'] });
  assert.ok(ledger('minors', dir).stdout.includes('[T2-T3-1] T2 '), 'listed under the first task');
});
