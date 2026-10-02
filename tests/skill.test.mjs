import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR, loadScript } from './harness.mjs';

const SKILL_MD = join(SKILL_DIR, 'SKILL.md');
const REFERENCE_MD = join(SKILL_DIR, 'reference.md');

const DESCRIPTION = 'Use when an approved implementation plan is about to be executed (at the ' +
  'execution-method handoff) - evaluates whether its tasks split into independent file-disjoint ' +
  'lanes and, if so, offers parallel execution with superpowers per-task review; also use to ' +
  'resume a stopped parallel-lanes run.';

const NOTICES = {
  invoked: 'parallel-lanes invoked: evaluating <plan> for parallel execution',
  stepAside: 'parallel-lanes: not a fit (<reason>); recommending <method>',
  launch: 'parallel-lanes: launching run <run_id>: <N> lanes, <M> agents',
  resume: 'parallel-lanes: resuming run <run_id>: <K> tasks already committed',
};

const TABLE_NOTE = 'each task can add up to 2x review_rounds more agents (fix and re-review rounds)';

function read(path) {
  assert.ok(existsSync(path), `${path} must exist`);
  return readFileSync(path);
}

// Frontmatter keys of a SKILL.md: one `key: value` per line between the
// leading --- lines (the only YAML shape the skill uses).
function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, 'SKILL.md must start with a --- frontmatter block');
  const fields = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([a-z]+): (.*)$/.exec(line);
    assert.ok(kv, `frontmatter line is not "key: value": ${line}`);
    fields[kv[1]] = kv[2];
  }
  return fields;
}

// A notice template as a whole-line regex: each <placeholder> matches text.
function templateRegex(template) {
  const escaped = template.split(/<[^>]+>/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${escaped.join('.+')}$`);
}

function task(id, files) {
  return { id, title: `Task ${id}`, files, tier: 'standard', security: false };
}

function manifest(extra = {}) {
  return {
    version: 1,
    run_id: 'run-1',
    plan: '/work/plan.md',
    spec: null,
    commit_rules: 'plain ASCII, no trailers',
    repo: {
      mode: 'git', root: '/work/repo', git_dir: null, base_ref: 'main', branch: 'feature',
      worktree_root: '/work/wt', ledger_dir: '/work/ledger',
    },
    commands: { setup: [], test: ['npm test'], lint: [], build: [] },
    prelude: [],
    lanes: [
      { id: 'a', name: 'Lane a', tasks: [task('T1', ['a.js'])] },
      { id: 'b', name: 'Lane b', tasks: [task('T2', ['b.js'])] },
    ],
    join: [],
    hooks: {},
    limits: { review_rounds: 5, max_parallel_lanes: 2 },
    dry_run: false,
    done: [],
    reviewed: [],
    sp_dir: null,
    skill_dir: SKILL_DIR,
    ...extra,
  };
}

// The notice lines the script logs before its first agent (setup returns
// null, so the run stops right after).
async function loggedNotices(m) {
  const logs = [];
  await loadScript({ args: m, agent: async () => null, log: (msg) => logs.push(msg) });
  return logs.filter((l) => l.startsWith('parallel-lanes'));
}

test('SKILL.md frontmatter has the exact name and description', () => {
  const fields = frontmatter(read(SKILL_MD).toString('utf8'));
  assert.deepEqual(Object.keys(fields).sort(), ['description', 'name']);
  assert.equal(fields.name, 'parallel-lanes');
  assert.equal(fields.description, DESCRIPTION);
  assert.ok(fields.description.length <= 1024);
  // Stays a valid YAML plain scalar.
  assert.ok(!fields.description.includes(': ') && !fields.description.includes(' #'));
});

test('SKILL.md and reference.md are plain ASCII', () => {
  for (const path of [SKILL_MD, REFERENCE_MD]) {
    const bytes = read(path);
    const bad = bytes.findIndex((b) => b > 0x7e || (b < 0x20 && b !== 0x0a));
    assert.equal(bad, -1, `${path} has a non-ASCII or control byte at offset ${bad}`);
  }
});

test('SKILL.md carries every notice template and the confirmation note verbatim', () => {
  const text = read(SKILL_MD).toString('utf8');
  for (const [name, notice] of Object.entries(NOTICES)) {
    assert.ok(text.includes(notice), `SKILL.md lacks the ${name} notice: ${notice}`);
  }
  assert.ok(text.includes(TABLE_NOTE), 'SKILL.md lacks the confirmation table note');
});

test('the launch notice the script logs matches the SKILL.md template', async () => {
  const notices = await loggedNotices(manifest());
  assert.equal(notices.length, 1, JSON.stringify(notices));
  assert.match(notices[0], templateRegex(NOTICES.launch));
});

test('the resume notice the script logs matches the SKILL.md template', async () => {
  const notices = await loggedNotices(manifest({
    done: ['T1'],
    reviewed: [],
    backfill: { T1: { base: 'aaa', head: 'bbb' } },
  }));
  assert.equal(notices.length, 1, JSON.stringify(notices));
  assert.match(notices[0], templateRegex(NOTICES.resume));
});

test('every helper script SKILL.md and reference.md name exists', () => {
  for (const path of [SKILL_MD, REFERENCE_MD]) {
    const text = read(path).toString('utf8');
    const named = new Set([...text.matchAll(/scripts\/([A-Za-z0-9_.-]+)/g)].map((m) => m[1]));
    assert.ok(named.size > 0, `${path} names no helper script`);
    for (const name of named) {
      assert.ok(existsSync(join(SKILL_DIR, 'scripts', name)), `${path} names missing scripts/${name}`);
    }
  }
});
