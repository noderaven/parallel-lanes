// scripts/task-checks (spec 4.2): it picks the checks a task runs before
// committing (targeted, lane or widened), runs them through run-checks, and
// records the selection in <ledger>/checks/task-<unit>.<n>.json. Every test
// runs the real script against a real git repo whose committed t.mjs is the
// check; the three offered lists differ only in t.mjs's argument, so the
// recorded results show which list ran.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { IS_WINDOWS, SYMLINKS, tempDir } from './platform.mjs';

const SCRIPTS = join(SKILL_DIR, 'scripts');
const SCRIPT = join(SCRIPTS, 'task-checks');
const AWAIT = join(SCRIPTS, 'await-checks');
const TMP = realpathSync(tempDir('pl-task-checks-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid',
};

function git(dir, ...args) {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim();
}

let counter = 0;
// A repo with t.mjs (exits with the code in FAIL.txt when that file exists)
// and the given committed files; returns {dir, ledger, base}.
function repo(committed = {}) {
  counter += 1;
  const dir = join(TMP, `case ${counter}`, 'repo');
  const ledger = join(TMP, `case ${counter}`, 'ledger');
  mkdirSync(dir, { recursive: true });
  mkdirSync(ledger, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 't.mjs'),
    "import { existsSync, readFileSync } from 'node:fs';\n"
    + "process.exit(existsSync('FAIL.txt') ? Number(readFileSync('FAIL.txt', 'utf8')) : 0);\n");
  for (const [name, text] of Object.entries(committed)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return { dir, ledger, base: git(dir, 'rev-parse', 'HEAD') };
}

const T = 'node t.mjs T';
const L = 'node t.mjs L';
const W = 'node t.mjs W';

// Runs task-checks with unit U1 (task U1), the given extra arguments, and the
// lane and wide lists; entry: true adds --entry U1 --targeted test T; wide:
// false drops the --wide-cmd pair.
function run(r, { entry = true, args = [], unit = 'U1', tasks = [unit], lane = 'alpha', entryId = null, wide = true } = {}) {
  const argv = [SCRIPT, r.dir, '--base', r.base, '--ledger', r.ledger, '--unit', unit, '--lane', lane,
    ...tasks.flatMap((t) => ['--task', t]),
    ...(entry ? ['--entry', entryId || tasks[tasks.length - 1], '--targeted', 'test', T] : []),
    '--lane-cmd', 'test', L, ...(wide ? ['--wide-cmd', 'test', W] : []), '--project-test', W, ...args];
  const res = spawnSync('python3', argv, { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  let json = null;
  try { json = JSON.parse(res.stdout); } catch { /* left null */ }
  return { status: res.status, json, stderr: res.stderr };
}

const ran = (json) => json.results.map((x) => x.command);
const codes = (json) => json.policy.reasons.map((x) => x.code);

test('no entry selects lane and runs the lane list', () => {
  const r = repo({ 'src/a.js': '1\n' });
  writeFileSync(join(r.dir, 'src/a.js'), '2\n');
  const { status, json } = run(r, { entry: false, args: ['--declared', 'src/a.js'] });
  assert.equal(status, 0);
  assert.equal(json.policy.selected, 'lane');
  assert.deepEqual(codes(json), ['no_entry']);
  assert.deepEqual(ran(json), [L]);
  assert.equal(json.policy.entry, null);
  assert.equal(json.policy.offered.targeted, null);
});

test('an entry with every change covered selects targeted', () => {
  const r = repo({ 'src/a.js': '1\n' });
  writeFileSync(join(r.dir, 'src/a.js'), '2\n');
  const { status, json } = run(r, { args: ['--declared', 'src/a.js', '--widen', 'package.json'] });
  assert.equal(status, 0);
  assert.equal(json.policy.selected, 'targeted');
  assert.deepEqual(json.policy.reasons, []);
  assert.deepEqual(ran(json), [T]);
  assert.deepEqual(json.policy.changed, ['src/a.js']);
  assert.equal(json.policy.entry, 'U1');
  assert.deepEqual(json.policy.offered, {
    targeted: [{ group: 'test', command: T }], lane: [{ group: 'test', command: L }], wide: [{ group: 'test', command: W }],
  });
  assert.equal(json.policy.unit, 'U1');
  assert.deepEqual(json.policy.tasks, ['U1']);
  assert.equal(json.policy.lane, 'alpha');
  assert.equal(json.policy.base, r.base);
  assert.match(json.policy.started, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
});

test('a change outside the Files list widens', () => {
  const r = repo({ 'src/a.js': '1\n', 'src/b.js': '1\n' });
  writeFileSync(join(r.dir, 'src/b.js'), '2\n');
  const { json } = run(r, { args: ['--declared', 'src/a.js'] });
  assert.equal(json.policy.selected, 'widened');
  assert.equal(json.policy.reasons[0].code, 'outside_files');
  assert.match(json.policy.reasons[0].detail, /src\/b\.js/);
  assert.deepEqual(ran(json), [W]);
});

test('a widen path widens even inside the Files list', () => {
  const r = repo({ 'package.json': '{}\n' });
  writeFileSync(join(r.dir, 'package.json'), '{"x":1}\n');
  const { json } = run(r, { args: ['--declared', 'package.json', '--widen', 'package.json'] });
  assert.equal(json.policy.selected, 'widened');
  assert.deepEqual(codes(json), ['widen_path']);
});

test('a widen entry naming an existing directory without a trailing / covers files under it', () => {
  // 1.6.0 deferred minor: 'test/helpers' (no '/') matched only the equal
  // path, so a change under the directory never widened.
  const r = repo({ 'test/helpers/h.js': '1\n', 'src/a.js': '1\n' });
  writeFileSync(join(r.dir, 'test/helpers/h.js'), '2\n');
  const { json } = run(r, { args: ['--declared', 'test/helpers/h.js', '--widen', 'test/helpers'] });
  assert.equal(json.policy.selected, 'widened');
  assert.deepEqual(codes(json), ['widen_path']);
  // A --declared entry keeps the strict rule: without '/' it covers the equal path only.
  const declared = run(r, { args: ['--declared', 'test/helpers'] });
  assert.deepEqual(codes(declared.json), ['outside_files']);
  // A widen entry that is a file, or names nothing, still covers the equal path only.
  const file = run(r, { args: ['--declared', 'test/helpers/h.js', '--widen', 'src/a.js', '--widen', 'gone'] });
  assert.equal(file.json.policy.selected, 'targeted');
});

// The ledger's ruling events and owner map, as the run writes them.
function ledgerFile(r, stem, events) {
  writeFileSync(join(r.ledger, `${stem}.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
// declared: {task id: its Files list}, recorded as that task's `declared` (1.6.6).
function ownerMap(r, files, declared = {}) {
  const tasks = { U1: { where: 'alpha', pos: 0 }, U2: { where: 'alpha', pos: 1 }, U9: { where: 'beta', pos: 0 } };
  for (const [id, entry] of Object.entries(tasks)) if (id in declared) entry.declared = declared[id];
  writeFileSync(join(r.ledger, 'owners.json'), JSON.stringify({ tasks, files }));
}
const permit = (task, files, extra = {}) => ({ event: 'ruling', task, by: 'adjudicator', text: 'Ruling: x - y - z', files, ...extra });

test('a file an adjudicator ruling in force permits counts as declared, and the policy names the ruling', () => {
  // d1a DI3: the pre-flight adjudicator permitted ToolRackSlot.cs (no task listed it), filed under _run;
  // task-checks widened anyway (outside_files), 1089 s instead of about 600 s.
  const r = repo({ 'src/a.js': '1\n' });
  writeFileSync(join(r.dir, 'src/a.js'), '2\n');
  writeFileSync(join(r.dir, 'src/slot.js'), 'new\n');
  ledgerFile(r, '_run', [permit('_run', ['src/slot.js'])]);
  ownerMap(r, { 'src/a.js': ['U1'] });
  const { status, json } = run(r, { args: ['--declared', 'src/a.js'] });
  assert.equal(status, 0);
  assert.equal(json.policy.selected, 'targeted');
  assert.deepEqual(json.policy.permitted, [{ path: 'src/slot.js', ruling: '_run-R1' }]);
  // Filed under the unit's own task (in its lane file), the files count whatever the owner map says.
  ownerMap(r, { 'src/a.js': ['U1'], 'src/slot.js': ['U9'] });
  rmSync(join(r.ledger, '_run.jsonl'));
  ledgerFile(r, 'alpha', [permit('U1', ['src/slot.js'])]);
  assert.deepEqual(run(r, { args: ['--declared', 'src/a.js'] }).json.policy.permitted,
    [{ path: 'src/slot.js', ruling: 'alpha-R1' }]);
});

test('only an adjudicator ruling in force, for this unit or an unowned path, permits a file', () => {
  const r = repo({ 'src/a.js': '1\n' });
  writeFileSync(join(r.dir, 'src/a.js'), '2\n');
  writeFileSync(join(r.dir, 'src/slot.js'), 'new\n');
  const widens = (why) => {
    const { status, json } = run(r, { args: ['--declared', 'src/a.js'] });
    assert.equal(status, 0, why);
    assert.deepEqual(codes(json), ['outside_files'], why);
    assert.deepEqual(json.policy.permitted, [], why);
  };
  const reset = () => { for (const n of readdirSync(r.ledger)) if (n.endsWith('.jsonl') || n === 'owners.json') rmSync(join(r.ledger, n)); };
  ownerMap(r, { 'src/a.js': ['U1'] });
  // An implementer's own ruling never permits (it could switch off its own widening).
  ledgerFile(r, 'alpha', [permit('U1', ['src/slot.js'], { by: 'implementer' })]);
  widens('implementer ruling');
  ledgerFile(r, 'alpha', [permit('U1', ['src/slot.js'], { by: 'reviewer' })]);
  widens('reviewer ruling');
  // Another task's ruling.
  ledgerFile(r, 'alpha', [permit('U2', ['src/slot.js'])]);
  widens('another task');
  reset();
  // A _run ruling for a path another task owns, or with no owner map to tell.
  ledgerFile(r, '_run', [permit('_run', ['src/slot.js'])]);
  ownerMap(r, { 'src/a.js': ['U1'], 'src/slot.js': ['U9'] });
  widens('owned elsewhere');
  rmSync(join(r.ledger, 'owners.json'));
  widens('no owner map');
  // A _run ruling's unowned path counts only for a unit declaring a file in the same folder
  // (d1a: ToolRackSlot.cs beside DI3's ToolRack.cs), so it does not exempt every other task.
  ownerMap(r, { 'src/a.js': ['U1'] });
  mkdirSync(join(r.dir, 'other'));
  writeFileSync(join(r.dir, 'other/far.js'), 'new\n');
  rmSync(join(r.dir, 'src/slot.js'));
  ledgerFile(r, '_run', [permit('_run', ['other/far.js'])]);
  widens('another folder');
  rmSync(join(r.dir, 'other'), { recursive: true });
  writeFileSync(join(r.dir, 'src/slot.js'), 'new\n');
  // An overridden ruling is no longer in force.
  ownerMap(r, { 'src/a.js': ['U1'] });
  ledgerFile(r, '_run', [permit('_run', ['src/slot.js']), permit('_run', [], { overrides: ['_run-R1'] })]);
  widens('overridden');
  // An unreadable ledger keeps the strict rule.
  writeFileSync(join(r.ledger, '_run.jsonl'), '{not json\n');
  widens('unreadable ledger');
});

test('a permit names files only: a directory, or an owned folder, never covers another lane\'s file', () => {
  // Final review (1.6.4): a _run adjudicator ruling naming "src/sub/" was not in the owner map
  // (it lists files) and became a directory entry covering U9's src/sub/owned.js.
  const r = repo({ 'src/a.js': '1\n', 'src/sub/owned.js': '1\n', 'b.js': '1\n' });
  writeFileSync(join(r.dir, 'src/a.js'), '2\n');
  writeFileSync(join(r.dir, 'src/sub/owned.js'), '2\n');
  const widens = (why, declared = 'src/a.js') => {
    const { status, json } = run(r, { args: ['--declared', declared] });
    assert.equal(status, 0, why);
    assert.deepEqual(codes(json), ['outside_files'], why);
    assert.deepEqual(json.policy.permitted, [], why);
  };
  ownerMap(r, { 'src/a.js': ['U1'], 'src/sub/owned.js': ['U9'] });
  for (const dir of ['src/sub/', 'src/sub\\', 'src', './', '.']) {
    ledgerFile(r, '_run', [permit('_run', [dir])]);
    widens(`_run permit ${dir}`);
    // A ruling filed under the unit's own task names files only, too.
    rmSync(join(r.ledger, '_run.jsonl'));
    ledgerFile(r, 'alpha', [permit('U1', [dir])]);
    widens(`task permit ${dir}`);
    rmSync(join(r.ledger, 'alpha.jsonl'));
  }
  // A folder another task's Files list names owns every path under it.
  ownerMap(r, { 'src/a.js': ['U1'], 'src/sub': ['U9'] });
  ledgerFile(r, '_run', [permit('_run', ['src/sub/owned.js'])]);
  widens('owned folder');
});

test('the permit folder guard: a declared directory is its own folder, and folders compare by case', () => {
  // Deferred minors of the 1.6.4 final review, included in 1.6.4.
  const r = repo({ 'src/a.js': '1\n', 'Src2/a.js': '1\n' });
  writeFileSync(join(r.dir, 'src/a.js'), '2\n');
  writeFileSync(join(r.dir, 'build.cfg'), 'new\n');
  ownerMap(r, { 'src/a.js': ['U1'] });
  ledgerFile(r, '_run', [permit('_run', ['build.cfg'])]);
  // A unit declaring only the directory src/ is not in build.cfg's (root) folder.
  const dir = run(r, { args: ['--declared', 'src/'] });
  assert.deepEqual(codes(dir.json), ['outside_files']);
  assert.deepEqual(dir.json.policy.permitted, []);
  // A declared root file is.
  writeFileSync(join(r.dir, 'root.txt'), 'x\n');
  rmSync(join(r.dir, 'src/a.js'));
  git(r.dir, 'checkout', '--', 'src/a.js');
  const root = run(r, { args: ['--declared', 'root.txt'] });
  assert.deepEqual(root.json.policy.permitted, [{ path: 'build.cfg', ruling: '_run-R1' }]);
  rmSync(join(r.dir, 'root.txt'));
  rmSync(join(r.dir, 'build.cfg'));
  // Src2/new.js is not in the folder of a declared src2/a.js on a case-sensitive comparison.
  writeFileSync(join(r.dir, 'Src2/new.js'), 'x\n');
  ledgerFile(r, '_run', [permit('_run', ['Src2/new.js'])]);
  const cased = run(r, { args: ['--declared', 'src2/a.js'] });
  assert.deepEqual(cased.json.policy.permitted, []);
});

test('a malformed owner map, and a backslash or mixed-case permit of an owned file, permit nothing', () => {
  const r = repo({ 'src/a.js': '1\n', 'src/sub/owned.js': '1\n' });
  writeFileSync(join(r.dir, 'src/a.js'), '2\n');
  writeFileSync(join(r.dir, 'src/sub/owned.js'), '2\n');
  ledgerFile(r, '_run', [permit('_run', ['src/sub/owned.js'])]);
  writeFileSync(join(r.ledger, 'owners.json'), '{"tasks": [], "files": 3}');
  assert.deepEqual(run(r, { args: ['--declared', 'src/sub/x.js', '--declared', 'src/a.js'] }).json.policy.permitted, []);
  ownerMap(r, { 'src/a.js': ['U1'], 'src/sub/owned.js': ['U9'] });
  for (const path of ['src\\sub\\owned.js', 'SRC/Sub/owned.js']) {
    ledgerFile(r, '_run', [permit('_run', [path])]);
    const res = run(r, { args: ['--declared', 'src/sub/x.js', '--declared', 'src/a.js'] });
    assert.deepEqual(res.json.policy.permitted, [], path);
    assert.deepEqual(codes(res.json), ['outside_files'], path);
  }
});

// 1.6.8 (spec 4.6): a pre-flight permit, passed by the engine as --permit or carried in the ledger.
test('a --permit path counts as declared', () => {
  const r = repo({ 'src/a.js': '1\n' });
  writeFileSync(join(r.dir, 'src/a.js'), '2\n');
  mkdirSync(join(r.dir, 'tools'));
  writeFileSync(join(r.dir, 'tools/x.py'), 'new\n');
  const { status, json } = run(r, { args: ['--declared', 'src/a.js', '--permit', 'tools/x.py=PF-2'] });
  assert.equal(status, 0);
  assert.equal(json.policy.selected, 'targeted');
  assert.deepEqual(json.policy.reasons, []);
  assert.deepEqual(json.policy.permitted, [{ path: 'tools/x.py', ruling: 'PF-2' }]);
  // A permit for another file leaves this one outside the Files list.
  const other = run(r, { args: ['--declared', 'src/a.js', '--permit', 'tools/y.py=PF-2'] });
  assert.deepEqual(codes(other.json), ['outside_files']);
  assert.deepEqual(other.json.policy.permitted, []);
});

test('a --permit with backslashes is normalised', () => {
  const r = repo({ 'src/a.js': '1\n' });
  writeFileSync(join(r.dir, 'src/a.js'), '2\n');
  mkdirSync(join(r.dir, 'tools'));
  writeFileSync(join(r.dir, 'tools/x.py'), 'new\n');
  const { json } = run(r, { args: ['--declared', 'src/a.js', '--permit', 'tools\\x.py=PF-1'] });
  assert.equal(json.policy.selected, 'targeted');
  assert.deepEqual(json.policy.permitted, [{ path: 'tools/x.py', ruling: 'PF-1' }]);
});

test('--permit naming a directory, an absolute path or .. exits 2', () => {
  const r = repo({ 'src/a.js': '1\n' });
  for (const bad of ['tools/=PF-1', 'tools\\=PF-1', '.=PF-1', './=PF-1', '/abs/x.py=PF-1', 'C:/x.py=PF-1',
    '../x.py=PF-1', 'a/../../x.py=PF-1', '..=PF-1']) {
    const res = run(r, { args: ['--declared', 'src/a.js', '--permit', bad] });
    assert.equal(res.status, 2, `${bad}: ${res.stderr}`);
    assert.equal(res.json, null, bad);
  }
});

test('--permit without =PF-n exits 2', () => {
  const r = repo({ 'src/a.js': '1\n' });
  for (const bad of ['tools/x.py', 'tools/x.py=', 'tools/x.py=PF-0', 'tools/x.py=PF-01', 'tools/x.py=pf-1',
    'tools/x.py=_run-R1', '=PF-1', 'tools/x.py=PF-1 ']) {
    const res = run(r, { args: ['--declared', 'src/a.js', '--permit', bad] });
    assert.equal(res.status, 2, `${bad}: ${res.stderr}`);
    assert.equal(res.json, null, bad);
  }
});

test('a carried pre-flight permit counts as declared', () => {
  const r = repo({ 'src/a.js': '1\n' });
  writeFileSync(join(r.dir, 'src/a.js'), '2\n');
  mkdirSync(join(r.dir, 'tools'));
  writeFileSync(join(r.dir, 'tools/x.py'), 'new\n');
  const pre = (permits, extra = {}) => ({ event: 'ruling', task: '_run', by: 'preflight', pf: 'PF-1', scope: 'run',
    text: 'Ruling: T1 may change tools/x.py - w - c', permits, ...extra });
  const opts = { tasks: ['T1'], args: ['--declared', 'src/a.js'] };
  ledgerFile(r, '_run', [pre([{ task: 'T1', files: ['tools/x.py'] }])]);
  const { status, json } = run(r, opts);
  assert.equal(status, 0);
  assert.equal(json.policy.selected, 'targeted');
  assert.deepEqual(json.policy.permitted, [{ path: 'tools/x.py', ruling: '_run-R1' }]);
  const widens = (why) => {
    const res = run(r, opts);
    assert.deepEqual(codes(res.json), ['outside_files'], why);
    assert.deepEqual(res.json.policy.permitted, [], why);
  };
  // A permit for another task, a directory, a ruling an adjudicator overrode, or one not by pre-flight: none.
  ledgerFile(r, '_run', [pre([{ task: 'T2', files: ['tools/x.py'] }])]);
  widens('another task');
  ledgerFile(r, '_run', [pre([{ task: 'T1', files: ['tools/'] }])]);
  widens('a directory');
  ledgerFile(r, '_run', [pre([{ task: 'T1', files: ['tools/x.py'] }]),
    { event: 'ruling', task: '_run', by: 'adjudicator', text: 'Ruling: no - w - c', overrides: ['_run-R1'] }]);
  widens('overridden');
  ledgerFile(r, '_run', [pre([{ task: 'T1', files: ['tools/x.py'] }], { by: 'implementer' })]);
  widens('an implementer ruling');
});

test('an untracked file outside the Files list widens', () => {
  const r = repo({ 'src/a.js': '1\n' });
  writeFileSync(join(r.dir, 'new.js'), 'x\n');
  const { json } = run(r, { args: ['--declared', 'src/a.js'] });
  assert.deepEqual(codes(json), ['outside_files']);
  assert.deepEqual(json.policy.changed, ['new.js']);
});

test('the printed report caps long path lists; the evidence file keeps them whole', () => {
  // 1.6.0 deferred minor: the printed line carried every changed and outside path.
  const r = repo({ 'src/a.js': '1\n' });
  const names = Array.from({ length: 60 }, (_, i) => `gen/${'x'.repeat(40)}${String(i).padStart(2, '0')}.js`);
  mkdirSync(join(r.dir, 'gen'));
  for (const n of names) writeFileSync(join(r.dir, n), 'x\n');
  const { status, json } = run(r, { args: ['--declared', 'src/a.js'] });
  assert.equal(status, 0);
  const saved = JSON.parse(readFileSync(join(r.ledger, 'checks', 'task-U1.1.json'), 'utf8'));
  assert.deepEqual(saved.policy.changed, names);
  assert.ok(saved.policy.reasons[0].detail.includes(names[59]));
  assert.equal(saved.printed_cut, undefined);
  assert.deepEqual(json.policy.changed, names.slice(0, 50));
  assert.ok(json.policy.reasons[0].detail.length <= 2100);
  assert.ok(!json.policy.reasons[0].detail.includes(names[59]));
  assert.match(json.printed_cut, /50 of 60 changed paths/);
  assert.ok(json.printed_cut.includes('task-U1.1.json'));
  // Everything else is the file's report.
  assert.deepEqual({ ...json, policy: null, printed_cut: undefined }, { ...saved, policy: null, printed_cut: undefined });
});

test('a rename counts both paths', () => {
  const r = repo({ 'src/a.js': '1\n' });
  git(r.dir, 'mv', 'src/a.js', 'src/z.js');
  const kept = run(r, { args: ['--declared', 'src/a.js'] });
  assert.deepEqual(kept.json.policy.changed, ['src/a.js', 'src/z.js']);
  assert.deepEqual(codes(kept.json), ['outside_files']);
  const both = run(r, { args: ['--declared', 'src/a.js', '--declared', 'src/z.js'] });
  assert.equal(both.json.policy.selected, 'targeted');
});

test('a directory entry covers files under it, and backslash entries match', () => {
  const r = repo({ 'src/sub/a.js': '1\n' });
  writeFileSync(join(r.dir, 'src/sub/a.js'), '2\n');
  writeFileSync(join(r.dir, 'src/sub/b.js'), 'new\n');
  assert.equal(run(r, { args: ['--declared', 'src/'] }).json.policy.selected, 'targeted');
  assert.equal(run(r, { args: ['--declared', 'src\\sub\\'] }).json.policy.selected, 'targeted');
  assert.equal(run(r, { args: ['--declared', 'src\\sub\\a.js', '--declared', 'src/sub/b.js'] }).json.policy.selected, 'targeted');
  // A file entry does not cover a sibling that shares its prefix.
  assert.equal(run(r, { args: ['--declared', 'src/sub/a'] }).json.policy.selected, 'widened');
});

test('matching is case-sensitive', () => {
  // Only src/a.js is created; src/A.js is declared and never created (on
  // Windows both names are one file).
  const r = repo();
  mkdirSync(join(r.dir, 'src'));
  writeFileSync(join(r.dir, 'src/a.js'), 'new\n');
  const { json } = run(r, { args: ['--declared', 'src/A.js'] });
  assert.deepEqual(codes(json), ['outside_files']);
});

test('names with spaces and non-ASCII characters are matched exactly', () => {
  const r = repo({ 'a b.js': '1\n', 'caf\u00e9.js': '1\n' });
  writeFileSync(join(r.dir, 'a b.js'), '2\n');
  writeFileSync(join(r.dir, 'caf\u00e9.js'), '2\n');
  const { json } = run(r, { args: ['--declared', 'a b.js', '--declared', 'caf\u00e9.js'] });
  assert.deepEqual(json.policy.changed, ['a b.js', 'caf\u00e9.js']);
  assert.equal(json.policy.selected, 'targeted');
});

test('a name with a double quote is matched exactly', { skip: IS_WINDOWS && 'NTFS forbids " in file names' }, () => {
  const r = repo({ 'q"x.js': '1\n' });
  writeFileSync(join(r.dir, 'q"x.js'), '2\n');
  const { json } = run(r, { args: ['--declared', 'q"x.js'] });
  assert.deepEqual(json.policy.changed, ['q"x.js']);
  assert.equal(json.policy.selected, 'targeted');
});

test('force-full widens with its reason', () => {
  const r = repo({ 'src/a.js': '1\n' });
  writeFileSync(join(r.dir, 'src/a.js'), '2\n');
  const { json } = run(r, { args: ['--declared', 'src/a.js', '--force-full', 'touches the shared config loader'] });
  assert.equal(json.policy.selected, 'widened');
  assert.deepEqual(json.policy.reasons, [{ code: 'forced', detail: 'touches the shared config loader' }]);
});

test('several widening reasons are all recorded, in order', () => {
  const r = repo({ 'src/a.js': '1\n', 'package.json': '{}\n' });
  writeFileSync(join(r.dir, 'package.json'), '{"x":1}\n');
  const { json } = run(r, { args: ['--declared', 'src/a.js', '--widen', 'package.json', '--force-full', 'why'] });
  assert.deepEqual(codes(json), ['outside_files', 'widen_path', 'forced']);
});

test('a bad base widens with git_failed', () => {
  const r = repo({ 'src/a.js': '1\n' });
  const { status, json } = run({ ...r, base: '0123456789abcdef0123456789abcdef01234567' }, { args: ['--declared', 'src/a.js'] });
  assert.equal(status, 0);
  assert.deepEqual(codes(json), ['git_failed']);
  assert.deepEqual(json.policy.changed, []);
  assert.deepEqual(ran(json), [W]);
});

test('no Files list widens with no_files', () => {
  const r = repo();
  const { json } = run(r);
  assert.deepEqual(codes(json), ['no_files']);
  assert.equal(json.policy.selected, 'widened');
});

test('two calls write two evidence files and never overwrite', () => {
  const r = repo({ 'src/a.js': '1\n' });
  run(r, { args: ['--declared', 'src/a.js'] });
  writeFileSync(join(r.ledger, 'checks', 'marker.txt'), 'x');
  const first = readFileSync(join(r.ledger, 'checks', 'task-U1.1.json'), 'utf8');
  run(r, { entry: false, args: ['--declared', 'src/a.js'] });
  assert.equal(readFileSync(join(r.ledger, 'checks', 'task-U1.1.json'), 'utf8'), first);
  const second = JSON.parse(readFileSync(join(r.ledger, 'checks', 'task-U1.2.json'), 'utf8'));
  assert.equal(second.policy.selected, 'lane');
  assert.equal(JSON.parse(first).policy.selected, 'targeted');
});

test('a batch unit id is its own name', () => {
  const r = repo({ 'src/a.js': '1\n' });
  run(r, { unit: 'A1-A3', tasks: ['A1', 'A2', 'A3'], args: ['--declared', 'src/a.js'] });
  run(r, { unit: 'A1', args: ['--declared', 'src/a.js'] });
  const files = readdirSync(join(r.ledger, 'checks')).filter((f) => f.endsWith('.json')).sort();
  assert.deepEqual(files, ['task-A1-A3.1.json', 'task-A1.1.json']);
  const batch = JSON.parse(readFileSync(join(r.ledger, 'checks', 'task-A1-A3.1.json'), 'utf8'));
  assert.deepEqual(batch.policy.tasks, ['A1', 'A2', 'A3']);
  assert.equal(batch.policy.entry, 'A3');
});

test('unsafe ids and paths are refused with exit 2', () => {
  const r = repo();
  for (const [opts, what] of [
    [{ unit: '../x' }, 'unit'],
    [{ tasks: ['a/b'], unit: 'U1' }, 'task'],
    [{ args: ['--declared', '/etc/x'] }, 'absolute declared'],
    [{ args: ['--declared', 'C:/x'] }, 'drive declared'],
    [{ args: ['--widen', 'a/../../b'] }, 'widen leaving the project'],
  ]) {
    const res = run(r, opts);
    assert.equal(res.status, 2, `${what}: ${res.stderr}`);
  }
  assert.ok(!existsSync(join(r.ledger, 'checks')), 'nothing was written');
});

test('a Files entry src/../x.js normalizes and is accepted; ../x is refused', () => {
  const r = repo({ 'x.js': '1\n' });
  writeFileSync(join(r.dir, 'x.js'), '2\n');
  const ok = run(r, { args: ['--declared', 'src/../x.js'] });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.json.policy.selected, 'targeted');
  assert.equal(run(r, { args: ['--declared', '../x'] }).status, 2);
});

test('usage errors exit 2', () => {
  const r = repo();
  const base = ['--base', r.base, '--ledger', r.ledger, '--unit', 'U1', '--lane', 'alpha', '--task', 'U1'];
  const call = (...argv) => spawnSync('python3', [SCRIPT, r.dir, ...argv], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).status;
  assert.equal(call(...base, '--wide-cmd', 'test', W), 2, 'no --lane-cmd');
  assert.equal(call(...base, '--lane-cmd', 'test', L), 2, 'no --wide-cmd');
  assert.equal(call(...base, '--lane-cmd', 'test', L, '--wide-cmd', 'test', W, '--targeted', 'test', T), 2, '--targeted without --entry');
  assert.equal(call(...base, '--lane-cmd', 'test', L, '--wide-cmd', 'test', W, '--entry', 'U1'), 2, '--entry without --targeted');
  assert.equal(call(...base, '--lane-cmd', 'test', L, '--wide-cmd', 'test', W, '--bogus'), 2, 'unknown option');
});

test('project_test_executed is true only when an executed command equals a project test', () => {
  const r = repo({ 'src/a.js': '1\n' });
  assert.equal(run(r, { args: ['--declared', 'src/a.js'] }).json.policy.project_test_executed, false);
  assert.equal(run(r, { args: ['--force-full', 'x'] }).json.policy.project_test_executed, true);
});

test('a failing check exits 1 with ok false and the policy', () => {
  const r = repo({ 'src/a.js': '1\n' });
  writeFileSync(join(r.dir, 'FAIL.txt'), '3');
  const { status, json } = run(r, { args: ['--declared', 'src/a.js', '--declared', 'FAIL.txt'] });
  assert.equal(status, 1);
  assert.equal(json.ok, false);
  assert.equal(json.results[0].exit, 3);
  assert.equal(json.policy.selected, 'targeted');
});

test('run-checks giving no JSON yields an error record and exit 3', () => {
  const r = repo();
  const notRepo = join(TMP, 'not-a-repo');
  mkdirSync(notRepo, { recursive: true });
  const { status, json } = run({ ...r, dir: notRepo }, { args: ['--declared', 'x.js'] });
  assert.equal(status, 3);
  assert.deepEqual(json.results, []);
  assert.equal(json.ok, false);
  assert.ok(typeof json.error === 'string' && json.error.length > 0);
  assert.deepEqual(codes(json), ['git_failed']);
  const saved = JSON.parse(readFileSync(join(r.ledger, 'checks', 'task-U1.1.json'), 'utf8'));
  assert.equal(saved.error, json.error);
});

// ---- review fixes (T1 review, 2026-10-11) ----

test('no entry plus a widening reason stays lane, with both reasons', () => {
  const r = repo({ 'src/a.js': '1\n' });
  writeFileSync(join(r.dir, 'new.js'), 'x\n');
  const { json } = run(r, { entry: false, args: ['--declared', 'src/a.js'] });
  assert.equal(json.policy.selected, 'lane');
  assert.deepEqual(codes(json), ['no_entry', 'outside_files']);
  assert.deepEqual(ran(json), [L]);
});

test('an unsafe lane or entry alone is refused with exit 2', () => {
  const r = repo();
  assert.equal(run(r, { lane: '../x' }).status, 2);
  assert.equal(run(r, { entryId: 'a/b' }).status, 2);
  assert.ok(!existsSync(join(r.ledger, 'checks')));
});

test('a base that is not a sha is a usage error and runs no git', () => {
  const r = repo();
  const injected = join(TMP, `injected ${counter}.txt`);
  const res = run({ ...r, base: `--output=${injected}` });
  assert.equal(res.status, 2, res.stderr);
  assert.ok(!existsSync(injected));
  assert.ok(!existsSync(join(r.ledger, 'checks')));
});

test('an unexpected error exits 3, never 1', () => {
  const r = repo();
  const file = join(TMP, `ledger-file ${counter}`);
  writeFileSync(file, 'not a directory');
  const res = run({ ...r, ledger: file }, { args: ['--declared', 't.mjs'] });
  assert.equal(res.status, 3, `${res.status}: ${res.stderr}`);
});

test('a git path with a backslash is never covered', { skip: IS_WINDOWS && 'Windows file names cannot hold a backslash' }, () => {
  const r = repo();
  writeFileSync(join(r.dir, 'src\\x.js'), 'x\n');
  const { json } = run(r, { args: ['--declared', 'src/', '--declared', 'src/x.js'] });
  assert.deepEqual(codes(json), ['outside_files']);
  assert.equal(json.policy.selected, 'widened');
});

test('an error record carries policy.started', () => {
  const r = repo();
  const notRepo = join(TMP, `not-a-repo ${counter}`);
  mkdirSync(notRepo, { recursive: true });
  const { status, json } = run({ ...r, dir: notRepo }, { args: ['--declared', 'x.js'] });
  assert.equal(status, 3);
  assert.match(json.policy.started, /Z$/);
});

test('an evidence path outside the ledger exits 3 and writes nothing outside', { skip: !SYMLINKS && 'symlinks unavailable' }, () => {
  const r = repo();
  const outside = join(TMP, `outside ${counter}`);
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, join(r.ledger, 'checks'), 'junction');
  const res = run(r, { args: ['--declared', 'x.js'] });
  assert.equal(res.status, 3, res.stderr);
  assert.deepEqual(readdirSync(outside), []);
});

// ---- --evidence (1.6.1, spec 4.3) ----

const ENV = { ...process.env, ...GIT_ENV };
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

// await-checks reserve --ledger LEDGER --name task-<unit>: the reserved path.
function reserve(r, unit = 'U1') {
  const res = spawnSync('python3', [AWAIT, 'reserve', '--ledger', r.ledger, '--name', `task-${unit}`], { encoding: 'utf8', env: ENV });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim();
}

// task-checks argv for unit U1 (no entry) with --evidence file; lane is the
// lane list's one command.
function evidenceArgv(r, file, { lane = L, extra = [] } = {}) {
  return [SCRIPT, r.dir, '--base', r.base, '--ledger', r.ledger, '--unit', 'U1', '--lane', 'alpha', '--task', 'U1',
    '--lane-cmd', 'test', lane, '--wide-cmd', 'test', W, '--evidence', file, ...extra];
}

function runSync(argv) {
  return spawnSync('python3', argv, { encoding: 'utf8', env: ENV });
}

// Starts python3 argv in the background; closed resolves to { status, stdout, stderr }.
function start(argv) {
  const child = spawn('python3', argv, { env: ENV });
  let stdout = '';
  let stderr = '';
  const state = { exited: false };
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const closed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (status) => { state.exited = true; resolve({ status, stdout, stderr }); });
  });
  return { closed, state };
}

// Whether a writer holds the check-file lock of file now (_await.writer_alive).
function writerAlive(file) {
  const code = [
    'import json, sys',
    'sys.dont_write_bytecode = True',
    `sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`,
    'import _await',
    'print(json.dumps(_await.writer_alive(sys.argv[1])))',
  ].join('\n');
  const res = spawnSync('python3', ['-B', '-c', code, file], { encoding: 'utf8', env: ENV });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

const sidecars = (dir) => readdirSync(dir).filter((f) => f.endsWith('.lock'));

test('--evidence writes the report there and holds one lock', async () => {
  const r = repo();
  const file = reserve(r);
  assert.match(file, /task-U1\.1\.json$/);
  const checks = join(r.ledger, 'checks');
  const run = start(evidenceArgv(r, file, { lane: 'sleep 2' }));
  let alive = false;
  const deadline = Date.now() + 30000;
  while (!alive && !run.state.exited && Date.now() < deadline) {
    if (existsSync(file + '.lock')) alive = writerAlive(file);
    await tick();
  }
  const res = await run.closed;
  assert.equal(alive, true, 'writer_alive was true during the run');
  // One lock: run-checks inside took none, so it did not fail on the sidecar.
  assert.equal(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.deepEqual(ran(report), ['sleep 2']);
  assert.equal(report.policy.selected, 'lane');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), report);
  assert.deepEqual(sidecars(checks), [], 'the sidecar is gone');
  assert.deepEqual(readdirSync(checks).filter((f) => f.endsWith('.json')), ['task-U1.1.json'], 'nothing else reserved');
});

test('--evidence refuses a wrong name, a non-empty file, a symlink and a path outside checks/', () => {
  const r = repo();
  const checks = join(r.ledger, 'checks');
  mkdirSync(checks, { recursive: true });
  const elsewhere = join(TMP, `elsewhere ${counter}`, 'checks');
  mkdirSync(elsewhere, { recursive: true });
  const files = {
    'another unit': [join(checks, 'task-U2.1.json'), ''],
    'n zero': [join(checks, 'task-U1.0.json'), ''],
    'no n': [join(checks, 'task-U1.json'), ''],
    'a suffix': [join(checks, 'task-U1.1.json.txt'), ''],
    'a non-empty file': [join(checks, 'task-U1.5.json'), '{"ok": true}\n'],
    'in the ledger, not checks/': [join(r.ledger, 'task-U1.1.json'), ''],
    'in another ledger': [join(elsewhere, 'task-U1.1.json'), ''],
  };
  for (const [path, text] of Object.values(files)) writeFileSync(path, text);
  const cases = Object.entries(files).map(([what, [path]]) => [what, path]);
  cases.push(['a missing file', join(checks, 'task-U1.9.json')]);
  mkdirSync(join(checks, 'task-U1.7.json'));
  cases.push(['a directory', join(checks, 'task-U1.7.json')]);
  if (SYMLINKS) {
    writeFileSync(join(checks, 'target.txt'), '');
    symlinkSync(join(checks, 'target.txt'), join(checks, 'task-U1.3.json'));
    cases.push(['a symlink', join(checks, 'task-U1.3.json')]);
  }
  const listing = () => [readdirSync(checks).sort(), readdirSync(r.ledger).sort(), readdirSync(elsewhere).sort()];
  const before = listing();
  for (const [what, path] of cases) {
    const res = runSync(evidenceArgv(r, path));
    assert.equal(res.status, 2, `${what}: ${res.stderr}`);
    assert.equal(res.stdout, '', what);
  }
  assert.deepEqual(listing(), before, 'nothing was written');
  for (const [path, text] of Object.values(files)) assert.equal(readFileSync(path, 'utf8'), text);
  // --evidence needs --ledger and a safe --unit; without them nothing is written either.
  const good = join(checks, 'task-U1.2.json');
  writeFileSync(good, '');
  const noLedger = evidenceArgv(r, good);
  noLedger.splice(noLedger.indexOf('--ledger'), 2);
  assert.equal(runSync(noLedger).status, 2);
  const unsafe = evidenceArgv(r, join(checks, 'task-..1.json'));
  unsafe[unsafe.indexOf('--unit') + 1] = '.';
  assert.equal(runSync(unsafe).status, 2);
  assert.equal(readFileSync(good, 'utf8'), '');
  assert.deepEqual(sidecars(checks), []);
});

test('a waiter never sees run-checks\' intermediate report', async () => {
  const r = repo();
  const file = reserve(r);
  const run = start(evidenceArgv(r, file, { lane: 'sleep 2' }));
  const waiter = start([AWAIT, 'wait', file, '--max', '120']);
  const [res, waited] = await Promise.all([run.closed, waiter.closed]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(waited.status, 0, waited.stderr);
  const report = JSON.parse(waited.stdout);
  assert.ok(report.policy, 'the report has policy');
  assert.deepEqual(report, JSON.parse(res.stdout));
});

test('a usage error after --evidence leaves an error record', () => {
  const r = repo();
  const checks = join(r.ledger, 'checks');
  for (const [what, edit] of [
    ['a base that is not a sha', (argv) => { argv[argv.indexOf('--base') + 1] = 'nothex'; }],
    ['an unknown option', (argv) => { argv.push('--bogus'); }],
    ['no --task', (argv) => { argv.splice(argv.indexOf('--task'), 2); }],
  ]) {
    const file = reserve(r);
    const argv = evidenceArgv(r, file);
    edit(argv);
    const res = runSync(argv);
    assert.equal(res.status, 2, `${what}: ${res.stderr}`);
    const text = readFileSync(file, 'utf8');
    assert.ok(text.endsWith('\n'), what);
    const record = JSON.parse(text);
    assert.deepEqual(Object.keys(record).sort(), ['error', 'ok', 'policy', 'results'], what);
    assert.deepEqual(record.results, []);
    assert.equal(record.ok, false);
    assert.equal(record.policy, null, what);
    assert.ok(record.error.length > 0, what);
  }
  assert.match(JSON.parse(readFileSync(join(checks, 'task-U1.1.json'), 'utf8')).error, /not a commit sha/);
  assert.deepEqual(sidecars(checks), []);
});

test('run-checks giving no JSON with --evidence leaves the error record there', () => {
  const r = repo();
  const notRepo = join(TMP, `not-a-repo ${counter}`);
  mkdirSync(notRepo, { recursive: true });
  const file = reserve(r);
  const res = runSync(evidenceArgv({ ...r, dir: notRepo }, file));
  assert.equal(res.status, 3, res.stderr);
  const record = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(record, JSON.parse(res.stdout));
  assert.ok(record.error.length > 0);
  assert.equal(record.policy.unit, 'U1');
  assert.deepEqual(readdirSync(join(r.ledger, 'checks')).filter((f) => f.endsWith('.json')), ['task-U1.1.json']);
});

test('without --evidence the 1.6.0 reservation still works', () => {
  const r = repo({ 'src/a.js': '1\n' });
  const first = run(r, { args: ['--declared', 'src/a.js'] });
  const second = run(r, { entry: false, args: ['--declared', 'src/a.js'] });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const checks = join(r.ledger, 'checks');
  assert.deepEqual(readdirSync(checks).filter((f) => f.endsWith('.json')).sort(), ['task-U1.1.json', 'task-U1.2.json']);
  assert.deepEqual(JSON.parse(readFileSync(join(checks, 'task-U1.1.json'), 'utf8')), first.json);
  assert.deepEqual(JSON.parse(readFileSync(join(checks, 'task-U1.2.json'), 'utf8')), second.json);
  assert.equal(second.json.policy.selected, 'lane');
  assert.deepEqual(sidecars(checks), [], 'no sidecar is left');
});

// ---- --declared-from-owners and --wide-as-lane (1.6.6, spec 4.3, 4.5) ----

const fwd = (p) => p.replace(/\\/g, '/');
// The fingerprint of a declared list, from Python _owners.fingerprint.
function fp(paths) {
  const code = [
    'import json, sys',
    'sys.dont_write_bytecode = True',
    `sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`,
    'import _owners',
    'print(_owners.fingerprint(json.loads(sys.argv[1])))',
  ].join('\n');
  const res = spawnSync('python3', ['-B', '-c', code, JSON.stringify(paths)], { encoding: 'utf8', env: ENV });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim();
}
// The policy without started, which differs between two calls.
const policyOf = (json) => { const { started, ...rest } = json.policy; return rest; };

test('--declared-from-owners gives the policy --declared gives', () => {
  const r = repo({ 'src/a.js': '1\n', 'src/b.js': '1\n', 'shared.css': '1\n' });
  writeFileSync(join(r.dir, 'src/a.js'), '2\n');
  writeFileSync(join(r.dir, 'src/b.js'), '2\n');
  // One task: src/b.js is outside its Files list.
  ownerMap(r, { 'src/a.js': ['U1'] }, { U1: ['src/a.js'] });
  const owners = run(r, { args: ['--declared-from-owners', fp(['src/a.js'])] });
  const explicit = run(r, { args: ['--declared', 'src/a.js'] });
  assert.equal(owners.status, 0, owners.stderr);
  assert.deepEqual(codes(owners.json), ['outside_files']);
  assert.match(owners.json.policy.reasons[0].detail, /src\/b\.js/);
  assert.deepEqual(policyOf(owners.json), policyOf(explicit.json));
  // A batch whose tasks share a path: each exact string once, first occurrence kept.
  ownerMap(r, { 'src/a.js': ['U1'], 'shared.css': ['U1', 'U2'], 'src/b.js': ['U2'] },
    { U1: ['src/a.js', 'shared.css'], U2: ['shared.css', 'src/b.js'] });
  writeFileSync(join(r.dir, 'shared.css'), '2\n');
  writeFileSync(join(r.dir, 'src/c.js'), 'new\n');
  const list = ['src/a.js', 'shared.css', 'src/b.js'];
  const batch = { unit: 'U1-U2', tasks: ['U1', 'U2'] };
  const batchOwners = run(r, { ...batch, args: ['--declared-from-owners', fp(list)] });
  const batchExplicit = run(r, { ...batch, args: list.flatMap((p) => ['--declared', p]) });
  assert.equal(batchOwners.status, 0, batchOwners.stderr);
  assert.deepEqual(codes(batchOwners.json), ['outside_files']);
  assert.match(batchOwners.json.policy.reasons[0].detail, /^outside the Files list: src\/c\.js$/);
  assert.deepEqual(policyOf(batchOwners.json), policyOf(batchExplicit.json));
});

test('a path from owners.json with a space, a quote and non-ASCII reaches outside_files and permitted', () => {
  const r = repo({ "docs/it's here.md": '1\n', 'src/a.js': '1\n' });
  writeFileSync(join(r.dir, "docs/it's here.md"), '2\n');
  writeFileSync(join(r.dir, 'src/a.js'), '2\n');
  writeFileSync(join(r.dir, 'caf\u00e9 menu.txt'), 'new\n');
  writeFileSync(join(r.dir, 'src/slot.js'), 'new\n');
  // A _run permit covers only a path in the folder of a declared file: src/a.js puts src/ there,
  // so the permit shows the declared list from owners.json reaches the permits.
  ledgerFile(r, '_run', [permit('_run', ['src/slot.js'])]);
  const declared = ["docs/it's here.md", 'src/a.js'];
  ownerMap(r, { "docs/it's here.md": ['U1'], 'src/a.js': ['U1'] }, { U1: declared });
  const { status, json, stderr } = run(r, { args: ['--declared-from-owners', fp(declared)] });
  assert.equal(status, 0, stderr);
  assert.deepEqual(json.policy.changed, ['caf\u00e9 menu.txt', "docs/it's here.md", 'src/a.js', 'src/slot.js']);
  assert.deepEqual(codes(json), ['outside_files']);
  assert.equal(json.policy.reasons[0].detail, 'outside the Files list: caf\u00e9 menu.txt');
  assert.deepEqual(json.policy.permitted, [{ path: 'src/slot.js', ruling: '_run-R1' }]);
});

test('an owner-map mismatch writes the error record and exits 3', () => {
  const r = repo({ 'src/a.js': '1\n' });
  writeFileSync(join(r.dir, 'src/a.js'), '2\n');
  const good = fp(['src/a.js']);
  for (const [what, setUp, value, opts] of [
    ['a wrong fingerprint', () => ownerMap(r, {}, { U1: ['src/a.js'] }), fp(['src/b.js']), {}],
    ['no owners.json', () => rmSync(join(r.ledger, 'owners.json'), { force: true }), good, {}],
    ['an unknown --task', () => ownerMap(r, {}, { U1: ['src/a.js'] }), good, { tasks: ['U1', 'U7'] }],
    ['a task without declared', () => ownerMap(r, {}, {}), good, {}],
    ['a declared absolute path', () => ownerMap(r, {}, { U1: ['/abs/x.js'] }), fp(['/abs/x.js']), {}],
    ['a declared path leaving the project', () => ownerMap(r, {}, { U1: ['../x.js'] }), fp(['../x.js']), {}],
  ]) {
    setUp();
    const file = reserve(r);
    const res = run(r, { ...opts, args: ['--declared-from-owners', value, '--evidence', file] });
    assert.equal(res.status, 3, `${what}: ${res.stderr}`);
    const record = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(record.results, [], what);
    assert.equal(record.ok, false, what);
    assert.ok(record.error.includes('owners.json'), `${what}: ${record.error}`);
    assert.ok(record.error.includes('report blocked'), `${what}: ${record.error}`);
    assert.ok(record.error.startsWith("the run's owner map (owners.json) does not match this unit's Files list ("),
      `${what}: ${record.error}`);
    assert.ok(record.error.endsWith('do not run setup and do not pass --declared yourself (the session reruns setup)'),
      `${what}: ${record.error}`);
    assert.equal(record.policy, null, what);
    const waited = spawnSync('python3', [AWAIT, 'wait', file, '--max', '30'], { encoding: 'utf8', env: ENV });
    assert.equal(waited.status, 3, `${what}: ${waited.stderr}`);
  }
});

test('the ledger in forward-slash form still finds owners.json', () => {
  const r = repo({ 'src/a.js': '1\n' });
  writeFileSync(join(r.dir, 'src/a.js'), '2\n');
  ownerMap(r, { 'src/a.js': ['U1'] }, { U1: ['src/a.js'] });
  const res = run({ ...r, ledger: fwd(r.ledger) }, { args: ['--declared-from-owners', fp(['src/a.js'])] });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.json.policy.selected, 'targeted');
});

test('owner-map usage errors exit 2 with nothing written', () => {
  const r = repo({ 'src/a.js': '1\n' });
  ownerMap(r, { 'src/a.js': ['U1'] }, { U1: ['src/a.js'] });
  for (const args of [
    ['--declared-from-owners', '0:811c9dc5'],
    ['--declared-from-owners', '3:XYZ'],
    ['--declared-from-owners', `${fp(['src/a.js'])}\n`],
    ['--declared-from-owners', fp(['src/a.js']), '--declared', 'src/a.js'],
  ]) {
    const res = run(r, { args });
    assert.equal(res.status, 2, `${JSON.stringify(args)}: ${res.stderr}`);
    assert.match(res.stderr, /^task-checks: --declared-from-owners /, JSON.stringify(args));
  }
  const checks = join(r.ledger, 'checks');
  assert.deepEqual(existsSync(checks) ? readdirSync(checks) : [], []);
});

test('--wide-as-lane gives the policy the lane pairs as --wide-cmd give', () => {
  const r = repo({ 'src/a.js': '1\n' });
  const asLane = run(r, { wide: false, args: ['--wide-as-lane', '--force-full', 'x'] });
  const pairs = run(r, { wide: false, args: ['--wide-cmd', 'test', L, '--force-full', 'x'] });
  assert.equal(asLane.status, 0, asLane.stderr);
  assert.equal(asLane.json.policy.selected, 'widened');
  assert.deepEqual(ran(asLane.json), [L]);
  assert.deepEqual(asLane.json.policy.offered.wide, [{ group: 'test', command: L }]);
  assert.deepEqual(policyOf(asLane.json), policyOf(pairs.json));
});

test('--wide-as-lane with --wide-cmd, or neither, exits 2', () => {
  const r = repo();
  const both = run(r, { args: ['--wide-as-lane'] });
  assert.equal(both.status, 2, 'with --wide-cmd');
  assert.match(both.stderr, /--wide-as-lane and --wide-cmd do not go together/);
  const neither = run(r, { wide: false });
  assert.equal(neither.status, 2, 'neither');
  assert.match(neither.stderr, /--lane-cmd and --wide-cmd \(or --wide-as-lane\) are required/);
  assert.ok(!existsSync(join(r.ledger, 'checks')), 'nothing was written');
});
