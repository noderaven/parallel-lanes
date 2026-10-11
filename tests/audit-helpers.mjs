// Shared helpers for the audit tests (tests/audit-*.test.mjs): archived run
// folders and small git repos in temp dirs, and a runner for Python snippets
// that import the helper modules in scripts/. Every temp dir made here is
// removed after the test file's last test.
//
// makeRun(spec) writes a run folder (archive-run's layout) at <temp>/run and
// returns its path, so a test can put things beside it (outside the folder)
// in <temp>. spec is deep-merged over DEFAULT_RUN: objects merge
// recursively; arrays, strings, numbers, null and undefined replace. Fields:
//   manifest  written as p.lanes.json (null leaves it out). The default has
//             run_id "t1", plan /home/x/plans/p.md, spec
//             /home/x/plans/p-design.md, repo.root /home/x/proj and
//             repo.ledger_dir /home/x/plans/p.t1.ledger (live paths that
//             never exist), commands test ["npm test zqcmd"] and setup
//             ["pip install zqsetup"] with lint and build empty, no prelude
//             or join, and one lane "a" with tasks A1 and A2 (A2 depends on
//             A1). A key given as undefined is left out of the file.
//   plan      text written as p.md (DEFAULT_PLAN has a "### Task A1" and a
//             "### Task A2" section); null or undefined leaves it out.
//   spec      text written as p-design.md; null or undefined leaves it out.
//   ledger    {fileName: [event objects or raw strings]}, written into
//             p.t1.ledger/ (LEDGER), one line each, in order (a raw string
//             is written as is: '' gives a blank line). The default {} makes
//             an empty ledger dir; null makes none.
//   launches  [{wf, startTime, durationMs, result, args, journal, agents,
//             dirless}], default []. Each is written as <wf>.json holding
//             {runId: wf, startTime, durationMs, result, args}; a field not
//             given (or given as undefined) is left out, and nothing is
//             defaulted, so a launch without startTime has none. wf defaults
//             to wf_<n> (n from 1). Unless dirless is true, the <wf>/ dir is
//             made too:
//               journal  [{label, result}] -> <wf>/journal.jsonl: a
//                        {"type":"launched"} line, then per entry a
//                        {"type":"started", key, agentId, label} line and,
//                        when result is not undefined, a {"type":"result",
//                        key, agentId, result} line. No journal (undefined)
//                        writes no journal.jsonl.
//               agents   [{label, model, lines}] -> <wf>/agent-<n>.jsonl
//                        (each of lines as one JSON line) and
//                        <wf>/agent-<n>.meta.json ({"agentType":
//                        "parallel-lanes-worker", "description": label}, plus
//                        "model" when given), n from 1.
//   files     {relPath: text}, written after everything else (parent dirs
//             are made; null removes the file).
//   mtimes    {relPath: epochSeconds}, applied last (atime and mtime).
//
// makeRepo(n) returns {dir, shas}: a temp git repo with n linear commits on
// main (files f1.txt .. fn.txt), shas oldest first. git runs with the test
// identity of tests/doctor.test.mjs (Test <test@example.com>) from a
// private global config, no system config, and core.autocrlf=false (also
// set in the repo's own config).
// commit(dir, name, content?) writes name (default content "<name>\n"),
// adds and commits it ("add <name>") and returns the new sha.
//
// runPython(lines, args?) runs the Python lines (a string or a list of
// lines) after 'import json, sys', 'sys.dont_write_bytecode = True' and the
// scripts/ dir on sys.path, with args as sys.argv[1:] and UTF-8 output; it
// returns spawnSync's result. pythonJSON(lines, args?) does the same,
// asserts exit 0 and returns the parsed stdout.

import { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SKILL_DIR } from './harness.mjs';
import { tempDir } from './platform.mjs';

export const SCRIPTS = join(SKILL_DIR, 'scripts');
export const LEDGER = 'p.t1.ledger';

const made = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function fresh(prefix) {
  const dir = tempDir(prefix);
  made.push(dir);
  return dir;
}

export const DEFAULT_PLAN = [
  '# Plan',
  '',
  '### Task A1: First',
  '',
  '**Files:** Create `a1.txt`.',
  '',
  '- [ ] **Step 1: Write a1.txt**',
  '',
  '### Task A2: Second',
  '',
  '**Files:** Create `a2.txt`.',
  '',
  '- [ ] **Step 1: Write a2.txt**',
  '',
].join('\n');

export const DEFAULT_RUN = {
  manifest: {
    version: 1,
    run_id: 't1',
    plan: '/home/x/plans/p.md',
    spec: '/home/x/plans/p-design.md',
    repo: {
      mode: 'git',
      root: '/home/x/proj',
      branch: 'feat',
      base: 'main',
      worktree_root: '/home/x/proj-wt',
      ledger_dir: '/home/x/plans/p.t1.ledger',
    },
    commands: { setup: ['pip install zqsetup'], test: ['npm test zqcmd'], lint: [], build: [] },
    prelude: [],
    lanes: [{ id: 'a', name: 'Lane a', tasks: [{ id: 'A1', title: 'First' }, { id: 'A2', title: 'Second', depends_on: ['A1'] }] }],
    join: [],
  },
  plan: DEFAULT_PLAN,
  spec: '# Design\n\nThe spec.\n',
  ledger: {},
  launches: [],
  files: {},
  mtimes: {},
};

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, over) {
  if (!isObject(base) || !isObject(over)) return structuredClone(over);
  const out = structuredClone(base);
  for (const key of Object.keys(over)) {
    out[key] = isObject(out[key]) && isObject(over[key]) ? deepMerge(out[key], over[key]) : structuredClone(over[key]);
  }
  return out;
}

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function jsonl(items) {
  return items.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).map((line) => `${line}\n`).join('');
}

function writeLaunch(folder, launch, n) {
  const wf = launch.wf === undefined ? `wf_${n}` : launch.wf;
  const data = { runId: wf };
  for (const key of ['startTime', 'durationMs', 'result', 'args']) {
    if (launch[key] !== undefined) data[key] = launch[key];
  }
  write(join(folder, `${wf}.json`), `${JSON.stringify(data, null, 2)}\n`);
  if (launch.dirless) return;
  const dir = join(folder, wf);
  mkdirSync(dir, { recursive: true });
  if (launch.journal !== undefined) {
    const lines = [{ type: 'launched' }];
    launch.journal.forEach((entry, i) => {
      const key = `v2:${wf}-${i + 1}`;
      const agentId = `a${n}x${i + 1}`;
      lines.push({ type: 'started', key, agentId, label: entry.label });
      if (entry.result !== undefined) lines.push({ type: 'result', key, agentId, result: entry.result });
    });
    write(join(dir, 'journal.jsonl'), jsonl(lines));
  }
  (launch.agents || []).forEach((agent, i) => {
    const meta = { agentType: 'parallel-lanes-worker', description: agent.label };
    if (agent.model !== undefined) meta.model = agent.model;
    write(join(dir, `agent-${i + 1}.meta.json`), `${JSON.stringify(meta)}\n`);
    write(join(dir, `agent-${i + 1}.jsonl`), jsonl(agent.lines || []));
  });
}

export function makeRun(spec = {}) {
  const s = deepMerge(DEFAULT_RUN, spec);
  const folder = join(fresh('pl-audit-run-'), 'run');
  mkdirSync(folder);
  if (s.manifest !== null && s.manifest !== undefined) {
    write(join(folder, 'p.lanes.json'), `${JSON.stringify(s.manifest, null, 2)}\n`);
  }
  if (typeof s.plan === 'string') write(join(folder, 'p.md'), s.plan);
  if (typeof s.spec === 'string') write(join(folder, 'p-design.md'), s.spec);
  if (s.ledger !== null && s.ledger !== undefined) {
    mkdirSync(join(folder, LEDGER));
    for (const [name, items] of Object.entries(s.ledger)) write(join(folder, LEDGER, name), jsonl(items));
  }
  (s.launches || []).forEach((launch, i) => writeLaunch(folder, launch, i + 1));
  for (const [rel, text] of Object.entries(s.files || {})) {
    if (text === null || text === undefined) rmSync(join(folder, rel), { force: true });
    else write(join(folder, rel), text);
  }
  for (const [rel, seconds] of Object.entries(s.mtimes || {})) utimesSync(join(folder, rel), seconds, seconds);
  return folder;
}

// git's environment: the parent's, without anything that points git at
// another repo or identity, plus a private identity config.
const DROP = /^(GIT_AUTHOR_|GIT_COMMITTER_|GIT_CONFIG)|^(GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_COMMON_DIR|EMAIL)$/i;
let gitEnv = null;

function env() {
  if (gitEnv === null) {
    const dir = fresh('pl-audit-gitconfig-');
    const empty = join(dir, 'empty.gitconfig');
    const identity = join(dir, 'identity.gitconfig');
    writeFileSync(empty, '');
    writeFileSync(identity, [
      '[user]', '\tname = Test', '\temail = test@example.com',
      '[core]', '\tautocrlf = false',
      '[init]', '\tdefaultBranch = main',
      '',
    ].join('\n'));
    gitEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!DROP.test(k)) gitEnv[k] = v;
    Object.assign(gitEnv, { GIT_CONFIG_GLOBAL: identity, GIT_CONFIG_SYSTEM: empty, GIT_CONFIG_NOSYSTEM: '1' });
  }
  return gitEnv;
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env: env(), encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

export function commit(dir, name, content) {
  write(join(dir, name), content === undefined ? `${name}\n` : content);
  git(dir, 'add', '--', name);
  git(dir, 'commit', '-q', '-m', `add ${name}`);
  return git(dir, 'rev-parse', 'HEAD').trim();
}

export function makeRepo(n) {
  const dir = fresh('pl-audit-repo-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'core.autocrlf', 'false');
  const shas = [];
  for (let i = 1; i <= n; i++) shas.push(commit(dir, `f${i}.txt`));
  return { dir, shas };
}

export function runPython(lines, args = []) {
  const body = Array.isArray(lines) ? lines.join('\n') : lines;
  const code = ['import json, sys', 'sys.dont_write_bytecode = True', `sys.path.insert(0, ${JSON.stringify(SCRIPTS)})`, body].join('\n');
  return spawnSync('python3', ['-c', code, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
}

export function pythonJSON(lines, args = []) {
  const r = runPython(lines, args);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
