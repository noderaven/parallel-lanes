// scripts/_audit_core.py: evidence references, gaps, quoting, run loading
// and launch order for scripts/audit, and the shared test helpers in
// tests/audit-helpers.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { SYMLINKS } from './platform.mjs';
import { LEDGER, commit, makeRepo, makeRun, pythonJSON } from './audit-helpers.mjs';

test('ref rejects an unknown state, and collect_gaps finds nested gaps', () => {
  const out = pythonJSON([
    'import _audit_core as c',
    'try:',
    '    c.ref(1, "bogus", [])',
    '    rejected = False',
    'except ValueError:',
    '    rejected = True',
    'doc = {"tasks": [{"review": c.ref(None, "stale", [c.src("p.t1.ledger/a.jsonl", "L3")], "older")}],',
    '       "run": {"checks": c.ref(1, "present", [c.src("wf_1.json", "#/result/verify")])}}',
    'print(json.dumps({"rejected": rejected, "gaps": c.collect_gaps(doc), "checks": doc["run"]["checks"],',
    '                  "states": list(c.STATES), "gap_states": list(c.GAP_STATES)}))',
  ]);
  assert.equal(out.rejected, true);
  assert.deepEqual(out.gaps, [{ where: '#/tasks/0/review', state: 'stale', value: null, note: 'older' }]);
  assert.deepEqual(out.checks, { value: 1, state: 'present', sources: [{ path: 'wf_1.json', at: '#/result/verify' }] });
  assert.deepEqual(out.states, ['present', 'missing', 'stale', 'conflicting', 'unavailable', 'inferred']);
  assert.deepEqual(out.gap_states, ['missing', 'stale', 'conflicting', 'unavailable']);
});

test('collect_gaps walks into a ref value and escapes pointer keys', () => {
  const out = pythonJSON([
    'import _audit_core as c',
    'inner = c.ref("x", "missing", [])',
    'doc = {"a/b~c": c.ref([inner], "unavailable", [], "outer"), "ok": c.ref(2, "inferred", [])}',
    'print(json.dumps(c.collect_gaps(doc)))',
  ]);
  assert.deepEqual(out.map((g) => [g.where, g.state]), [
    ['#/a~1b~0c', 'unavailable'],
    ['#/a~1b~0c/value/0', 'missing'],
  ]);
});

test('gap_causes lists each cause once, with its tasks or its run-level values', () => {
  const out = pythonJSON([
    'import _audit_core as c',
    'MN = "the ledger records this launch; its transcripts are not archived"',
    'def task(tid, n_esc, sha=None, lacks=False):',
    '    t = {"id": tid, "status": {"committed": c.ref(None, "unavailable", [], "no ledger")},',
    '         "esc": [c.ref(None, "unavailable", [], "no transcripts archived") for _ in range(n_esc)]}',
    '    if sha:',
    '        t["files"] = c.ref(None, "unavailable", [], "the repo does not contain %s" % sha)',
    '        t["head"] = c.ref(None, "stale", [], "behind fedcba9")',
    '    if lacks:',
    '        t["brief"] = c.ref(None, "missing", [], "no brief")',
    '    return t',
    'doc = {"repo": c.ref(None, "unavailable", [], "no --repo"),',
    '       "run": {"launches": {"missing": [c.ref("wf_bbbbbb", "missing", [], MN), c.ref(None, "missing", [], MN),',
    '                                        c.ref(None, "missing", [], MN)]},',
    '               "keyed": {"7": c.ref(1, "stale", [], "a dict key, not an index")}},',
    '       "tasks": [task("A1", 2, "abcdef1", True), task("A2", 1, "1234567"), task("A3", 0, None, True)]}',
    'print(json.dumps({"gaps": c.collect_gaps(doc), "causes": c.gap_causes(doc)}))',
  ]);
  assert.equal(out.gaps.length, 17);
  assert.deepEqual(out.causes, [
    { pointer: '#/repo', state: 'unavailable', note: 'no --repo', tasks: null, values: [null] },
    // Every value of a run-level cause, in order, repeats included.
    { pointer: '#/run/launches/missing/N', state: 'missing', note: 'the ledger records this launch; its transcripts are not archived',
      tasks: null, values: ['wf_bbbbbb', null, null] },
    // Only array indices read as N.
    { pointer: '#/run/keyed/7', state: 'stale', note: 'a dict key, not an index', tasks: null, values: [1] },
    // A cause in every task lists every task once, however often a task holds it.
    { pointer: '#/tasks/N/status/committed', state: 'unavailable', note: 'no ledger', tasks: ['A1', 'A2', 'A3'], values: null },
    { pointer: '#/tasks/N/esc/N', state: 'unavailable', note: 'no transcripts archived', tasks: ['A1', 'A2'], values: null },
    // Masked shas merge the notes; notes that differ print masked, since
    // either raw note would be false for the other task.
    { pointer: '#/tasks/N/files', state: 'unavailable', note: 'the repo does not contain <sha>', tasks: ['A1', 'A2'], values: null },
    // The same raw note in every gap of the cause is kept as written.
    { pointer: '#/tasks/N/head', state: 'stale', note: 'behind fedcba9', tasks: ['A1', 'A2'], values: null },
    // A per-task cause in some tasks lists exactly those.
    { pointer: '#/tasks/N/brief', state: 'missing', note: 'no brief', tasks: ['A1', 'A3'], values: null },
  ]);
  // No gap, no cause.
  assert.deepEqual(pythonJSON(['import _audit_core as c', 'print(json.dumps(c.gap_causes({"tasks": []})))']), []);
});

const COMMANDS_MANIFEST = {
  commands: { setup: ['pip install zqsetup', ''], test: ['npm test zqcmd', 'npm test'], lint: ['ls'], build: [] },
  lane_commands: { a: { setup: ['make zqlane', 'ls'], test: ['npm test'] } },
};

test('one-pass replacement', () => {
  const out = pythonJSON([
    'import _audit_core as c',
    'manifest = json.loads(sys.argv[1])',
    'pairs = c.command_pairs(manifest)',
    'src = [c.src("p.t1.ledger/a.jsonl", "L1")]',
    'q = c.quote("failing: npm test zqcmd (exit 1); ran ls; pip install zqsetup", src, pairs)',
    'plain = c.quote("nothing here", src, pairs)',
    'loose = c.replace_commands("check ls, npm test and npm test zqcmd", pairs + [("build#9", "check")])',
    'print(json.dumps({"pairs": pairs, "q": q, "plain": plain, "loose": loose}))',
  ], [JSON.stringify(COMMANDS_MANIFEST)]);
  assert.deepEqual(out.pairs, [
    ['setup#1', 'pip install zqsetup'],
    ['test#1', 'npm test zqcmd'],
    ['a.setup#1', 'make zqlane'],
    ['test#2', 'npm test'],
    ['lint#1', 'ls'],
  ]);
  assert.equal(out.q.quote, 'failing: <check:test#1> (exit 1); ran <check:lint#1>; <check:setup#1>');
  assert.equal(out.q.commands_replaced, true);
  assert.deepEqual(out.q.sources, [{ path: 'p.t1.ledger/a.jsonl', at: 'L1' }]);
  for (const text of [out.q.quote, out.loose[0]]) {
    assert.doesNotMatch(text, /zqcmd|zqsetup/);
    assert.ok(!text.includes('<check:<check:'), text);
  }
  // A command found inside an inserted token ("check") is not rewritten.
  assert.equal(out.loose[0], '<check:build#9> <check:lint#1>, <check:test#2> and <check:test#1>');
  assert.deepEqual(out.plain, { quote: 'nothing here', sources: [{ path: 'p.t1.ledger/a.jsonl', at: 'L1' }], commands_replaced: false });
});

// Every path the loader opens or lists, recorded through Python's audit
// hooks, with '/' separators.
const TRACE = [
  'import _audit_core as c',
  'seen = []',
  'def hook(event, args):',
  '    if event in ("open", "os.listdir", "os.scandir") and args and isinstance(args[0], str):',
  '        seen.append(args[0].replace("\\\\", "/"))',
  'sys.addaudithook(hook)',
];

test('load_run reads only the folder', () => {
  const run = makeRun({
    ledger: {
      'prelude.jsonl': [
        { task: 'A1', event: 'started', base: 'b0' },
        '',
        { task: 'A1', event: 'committed', commits: ['c1'], base: 'b0', head: 'c1' },
      ],
    },
    launches: [
      { wf: 'wf_bbb', startTime: 2000000, durationMs: 1000, result: { status: 'accepted' }, dirless: true },
      {
        wf: 'wf_aaa', startTime: 1000000, durationMs: 60000, result: { status: 'stopped' }, journal: [],
        agents: [{ label: 'A1 implement', model: 'opus', lines: [{ type: 'user', message: { content: 'x' } }] }],
      },
      { wf: 'wf_ccc', startTime: 3000000, durationMs: -5 },
    ],
  });
  const out = pythonJSON([
    ...TRACE,
    'run = c.load_run(sys.argv[1])',
    'print(json.dumps({"run": run, "seen": seen}))',
  ], [run]);
  const r = out.run;
  assert.equal(r.manifest.run_id, 't1');
  assert.equal(r.manifest_path, 'p.lanes.json');
  assert.equal(r.plan_path, 'p.md');
  assert.equal(r.spec_path, 'p-design.md');
  assert.equal(r.ledger, LEDGER);
  assert.deepEqual(r.ledger_lines.map((l) => [l.file, l.line, l.event && l.event.event]), [
    [`${LEDGER}/prelude.jsonl`, 1, 'started'],
    [`${LEDGER}/prelude.jsonl`, 3, 'committed'],
  ]);
  assert.ok(r.ledger_status, r.ledger_status_error);
  assert.deepEqual(r.ledger_status.done, ['A1']);
  assert.deepEqual(r.launches.map((l) => [l.wf, l.dir === null, l.has_transcripts, l.start, l.end]), [
    ['wf_aaa', false, true, 1000, 1060],
    ['wf_bbb', true, false, 2000, 2001],
    ['wf_ccc', false, false, 3000, null],
  ]);
  assert.equal(r.launches[0].data.runId, 'wf_aaa');
  assert.deepEqual(r.launches[1].result, { status: 'accepted' });
  // The manifest's live paths (/home/x/...) do not exist and are never opened or listed.
  assert.ok(out.seen.length > 0);
  for (const p of out.seen) assert.ok(!p.includes('/home/x'), p);
});

test('load_run takes plan and spec copies by basename, either separator', () => {
  const run = makeRun({ manifest: { plan: 'C:\\Users\\x\\plans\\p.md' }, spec: null });
  const out = pythonJSON(['import _audit_core as c', 'print(json.dumps(c.load_run(sys.argv[1])))'], [run]);
  assert.equal(out.plan_path, 'p.md');
  assert.equal(out.spec_path, null);
  assert.deepEqual(out.launches, []);
});

test('load_run without a ledger gives a reason', () => {
  const run = makeRun({ ledger: null });
  const out = pythonJSON(['import _audit_core as c', 'print(json.dumps(c.load_run(sys.argv[1])))'], [run]);
  assert.equal(out.ledger, null);
  assert.deepEqual(out.ledger_lines, []);
  assert.equal(out.ledger_status, null);
  assert.equal(out.ledger_status_error, 'no ledger');
});

test('an unparseable ledger line has no event, and ledger status says why it gave nothing', () => {
  const run = makeRun({ ledger: { 'a.jsonl': [{ task: 'A1', event: 'ruling', text: 'x' }], 'b.jsonl': ['', 'not json'] } });
  const out = pythonJSON(['import _audit_core as c', 'print(json.dumps(c.load_run(sys.argv[1])))'], [run]);
  assert.deepEqual(out.ledger_lines.map((l) => [l.file, l.line, l.event && l.event.event]), [
    [`${LEDGER}/a.jsonl`, 1, 'ruling'],
    [`${LEDGER}/b.jsonl`, 2, null],
  ]);
  assert.equal(out.ledger_status, null);
  assert.match(out.ledger_status_error, /^ledger status exited [1-9]/);
});

test('a symlinked input outside the folder is refused', { skip: !SYMLINKS && 'symlinks are unavailable here' }, () => {
  const run = makeRun({ ledger: { 'prelude.jsonl': [{ task: 'A1', event: 'started', base: 'b0' }] } });
  const outside = join(dirname(run), 'outside.jsonl');
  writeFileSync(outside, `${JSON.stringify({ task: 'A1', event: 'ruling', text: 'x' })}\n`);
  symlinkSync(outside, join(run, LEDGER, 'zz.jsonl'));
  const out = pythonJSON([
    'import _audit_core as c',
    'try:',
    '    c.load_run(sys.argv[1])',
    '    print(json.dumps({"refused": None}))',
    'except c.OutsideRunFolder as e:',
    '    print(json.dumps({"refused": str(e), "path": e.path,',
    '                      "inside": [c.inside(sys.argv[1], e.path), c.inside(sys.argv[1], sys.argv[1] + "x")]}))',
  ], [run]);
  assert.ok(out.refused, 'load_run must refuse the link');
  assert.match(out.refused, /zz\.jsonl/);
  assert.deepEqual(out.inside, [false, false]);
});

test('inside resolves both paths', () => {
  const run = makeRun({});
  const out = pythonJSON([
    'import os, _audit_core as c',
    'root = sys.argv[1]',
    'print(json.dumps([c.inside(root, root), c.inside(root, os.path.join(root, "a", "..", "p.md")),',
    '                  c.inside(root, os.path.join(root, "..", "p.md")), c.inside(os.path.join(root, "p.md"), root)]))',
  ], [run]);
  assert.deepEqual(out, [true, true, false, false]);
});

function launchesOf(launches, code) {
  const run = makeRun({ launches });
  return pythonJSON(['import _audit_core as c', 'run = c.load_run(sys.argv[1])', ...code], [run]);
}

test('latest launch needs every start', () => {
  const unknown = launchesOf([{ wf: 'wf_a', startTime: 1000 }, { wf: 'wf_b' }],
    ['l, why = c.latest_launch(run)', 'print(json.dumps([l, why]))']);
  assert.deepEqual(unknown, [null, 'launch order unknown']);
  const known = launchesOf([{ wf: 'wf_b', startTime: 2000 }, { wf: 'wf_a', startTime: 1000 }],
    ['l, why = c.latest_launch(run)', 'print(json.dumps([l["wf"], why]))']);
  assert.deepEqual(known, ['wf_b', null]);
  const none = launchesOf([], ['print(json.dumps(list(c.latest_launch(run))))']);
  assert.deepEqual(none, [null, 'no launch']);
});

test('task_launch skips skipped and not_run', () => {
  const tasks = (status) => ({ status: 'stopped', tasks: { A1: { status } } });
  const out = launchesOf([
    { wf: 'wf_1', startTime: 1000, result: tasks('not_run') },
    { wf: 'wf_2', startTime: 2000, result: tasks('done') },
    { wf: 'wf_3', startTime: 3000, result: tasks('skipped') },
  ], [
    'hit = c.task_launch(run, "A1")',
    'print(json.dumps([hit and hit["wf"], c.task_launch(run, "A2")]))',
  ]);
  assert.deepEqual(out, ['wf_2', null]);
});

test('structured_results joins labels to results', () => {
  const out = launchesOf([
    {
      wf: 'wf_1', startTime: 1000, journal: [
        { label: 'A1 implement', result: { status: 'done' } },
        { label: 'A1 review', result: { verdict: 'approve', findings: [] } },
        { label: 'A2 implement' },
      ],
    },
    { wf: 'wf_2', startTime: 2000, dirless: true },
    { wf: 'wf_3', startTime: 3000 },
  ], ['print(json.dumps([c.structured_results(l) for l in run["launches"]]))']);
  // line: the result's journal line, or the started line when it has none
  // (L1 is the launched line).
  assert.deepEqual(out[0].map((s) => [s.label, s.result, s.line]), [
    ['A1 implement', { status: 'done' }, 3],
    ['A1 review', { verdict: 'approve', findings: [] }, 5],
    ['A2 implement', null, 6],
  ]);
  assert.equal(new Set(out[0].map((s) => s.agent_id)).size, 3);
  assert.deepEqual(out.slice(1), [[], []]);
});

test('journal lines are physical, blank lines counted, and cited as <wf>/journal.jsonl L<n>', () => {
  const lines = [
    { type: 'launched' },
    { type: 'started', agentId: 'a1', label: 'final review' },
    '',
    { type: 'started', agentId: 'a2', label: 'final re-review' },
    'not json',
    { type: 'result', agentId: 'a1', result: { head: 'x' } },
    { type: 'result', agentId: 'a2', result: null },
    { type: 'started', agentId: 'a3', label: 'final re-review retry' },
  ];
  // wf_u's journal.jsonl exists but cannot be read (a directory: an
  // OSError on every platform).
  const run = makeRun({
    launches: [{ wf: 'wf_j', startTime: 1000 }, { wf: 'wf_n', startTime: 2000 }, { wf: 'wf_d', startTime: 3000, dirless: true },
      { wf: 'wf_u', startTime: 4000 }],
    files: {
      'wf_j/journal.jsonl': lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\r\n') + '\r\n',
      'wf_u/journal.jsonl/keep': '',
    },
  });
  const out = pythonJSON([
    'import _audit_core as c',
    'run = c.load_run(sys.argv[1])',
    'print(json.dumps([[c.structured_results(l), c.read_journal(l)[1], c.journal_src(l, 7), c.journal_src(l)]',
    '                  for l in run["launches"]]))',
  ], [run]);
  // A null result cites its result line; a started entry with no result
  // cites its started line.
  assert.deepEqual(out[0][0].map((s) => [s.label, s.result, s.line]), [
    ['final review', { head: 'x' }, 6],
    ['final re-review', null, 7],
    ['final re-review retry', null, 8],
  ]);
  // Read, absent (a dir without one, a dirless launch), or unreadable.
  assert.deepEqual(out.map((x) => x[1]), [null, 'absent', 'absent', 'unreadable']);
  assert.deepEqual(out[0][2], { path: 'wf_j/journal.jsonl', at: 'L7' });
  assert.deepEqual(out[0][3], { path: 'wf_j/journal.jsonl', at: null });
  assert.deepEqual(out.slice(1).map((x) => x[0]), [[], [], []]);
  // read_journal gives structured_results' entries for a readable journal.
  const read = pythonJSON(['import _audit_core as c', 'run = c.load_run(sys.argv[1])',
    'l = run["launches"][0]', 'print(json.dumps(c.read_journal(l)[0] == c.structured_results(l)))'], [run]);
  assert.equal(read, true);
});

test('manifest_tasks is in run order', () => {
  const out = pythonJSON([
    'import _audit_core as c',
    'm = {"join": [{"id": "J1"}], "lanes": [{"id": "a", "tasks": [{"id": "A1"}, {"id": "A2"}]}, {"id": "b", "tasks": [{"id": "B1"}]}],',
    '     "prelude": [{"id": "P1"}]}',
    'print(json.dumps([[t["id"], lane] for t, lane in c.manifest_tasks(m)]))',
  ]);
  assert.deepEqual(out, [['P1', 'prelude'], ['A1', 'a'], ['A2', 'a'], ['B1', 'b'], ['J1', 'join']]);
});

test('makeRun deep-merges', () => {
  const run = makeRun({ manifest: { commands: { lint: ['x'] }, lanes: [{ id: 'b', tasks: [{ id: 'B1' }] }] } });
  const m = JSON.parse(readFileSync(join(run, 'p.lanes.json'), 'utf8'));
  assert.deepEqual(m.commands, { setup: ['pip install zqsetup'], test: ['npm test zqcmd'], lint: ['x'], build: [] });
  assert.deepEqual(m.lanes, [{ id: 'b', tasks: [{ id: 'B1' }] }]);
  assert.equal(m.repo.root, '/home/x/proj');
  assert.equal(m.spec, '/home/x/plans/p-design.md');
});

test('makeRepo and commit', () => {
  const { dir, shas } = makeRepo(2);
  assert.equal(shas.length, 2);
  const sha = commit(dir, 'b.txt', 'b\n');
  const git = (...args) => spawnSync('git', ['--no-optional-locks', '-C', dir, ...args], { encoding: 'utf8' }).stdout.trim();
  assert.equal(git('rev-parse', 'HEAD'), sha);
  assert.equal(git('rev-parse', 'HEAD~2'), shas[0]);
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(git('config', 'core.autocrlf'), 'false');
});
