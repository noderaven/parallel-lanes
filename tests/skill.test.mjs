import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR, loadScript } from './harness.mjs';

const SKILL_MD = join(SKILL_DIR, 'SKILL.md');
const REFERENCE_MD = join(SKILL_DIR, 'reference.md');
const ADOPT_MD = join(SKILL_DIR, 'adopt.md');

const DESCRIPTION = 'Use when an approved implementation plan is about to be executed (at the ' +
  'execution-method handoff), or when resuming a stopped parallel-lanes run.';

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
    setup_result: { feature_head: 'F0', discarded: [], worktrees: { a: '/work/wt/lane-a', b: '/work/wt/lane-b' } },
    ...extra,
  };
}

// The notice lines the script logs before its first agent (pre-flight
// returns null, so the run stops right after).
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

test('SKILL.md, reference.md, and adopt.md are plain ASCII', () => {
  for (const path of [SKILL_MD, REFERENCE_MD, ADOPT_MD]) {
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

test('the launch notice count is the dry-run agents length (there is no setup agent)', async () => {
  const dry = await loadScript({ args: manifest({ dry_run: true }), agent: async () => null });
  assert.equal(dry.agents.filter((a) => a.role === 'setup').length, 0);
  const notices = await loggedNotices(manifest());
  assert.equal(notices.length, 1, JSON.stringify(notices));
  assert.equal(notices[0], `parallel-lanes: launching run run-1: 2 lanes, ${dry.agents.length} agents`);
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

test('every helper script SKILL.md, reference.md, and adopt.md name exists', () => {
  for (const path of [SKILL_MD, REFERENCE_MD, ADOPT_MD]) {
    const text = read(path).toString('utf8');
    const named = new Set([...text.matchAll(/scripts\/([A-Za-z0-9_.-]+)/g)].map((m) => m[1]));
    assert.ok(named.size > 0, `${path} names no helper script`);
    for (const name of named) {
      assert.ok(existsSync(join(SKILL_DIR, 'scripts', name)), `${path} names missing scripts/${name}`);
    }
  }
});

test('run files of a plan inside the project go under <config dir>/parallel-lanes/runs/<run_id>/', () => {
  const skill = read(SKILL_MD).toString('utf8');
  const reference = read(REFERENCE_MD).toString('utf8');
  // The config dir is ${CLAUDE_CONFIG_DIR:-~/.claude}; reference.md also names the default.
  assert.ok(reference.includes('~/.claude/parallel-lanes/runs/<run_id>/'), 'reference.md lacks the default runs/ location');
  for (const [name, text] of [['SKILL.md', skill], ['reference.md', reference]]) {
    assert.ok(text.includes('<config dir>/parallel-lanes/runs/<run_id>/'), `${name} lacks the runs/ location`);
    assert.ok(text.includes('<run_dir>/<plan-name>.<run_id>.ledger'), `${name} lacks the run_dir ledger path`);
    assert.ok(!text.includes('<plan-dir>/<plan-name>.<run_id>.ledger'), `${name} still pins the ledger beside the plan`);
  }
  assert.ok(skill.includes('<run_dir>/<plan-name>.lanes.json'), 'SKILL.md lacks the run_dir manifest path');
  // Resume must find a manifest saved under runs/.
  assert.ok(skill.includes('<config dir>/parallel-lanes/runs/*/*.lanes.json'), 'SKILL.md resume lookup misses runs/');
  assert.ok(skill.includes('${CLAUDE_CONFIG_DIR:-~/.claude}'), 'SKILL.md defines the config dir');
});

test('adopt.md holds the adoption steps and the worked example', () => {
  const adopt = read(ADOPT_MD).toString('utf8');
  const reference = read(REFERENCE_MD).toString('utf8');
  const skill = read(SKILL_MD).toString('utf8');
  assert.ok(adopt.includes('## Adopting earlier work'), 'adopt.md lacks the adoption section');
  assert.ok(adopt.includes('## Worked example'), 'adopt.md lacks the worked example');
  assert.ok(!reference.includes('## Adopting earlier work'), 'reference.md still has the adoption section');
  assert.ok(!reference.includes('## Worked example'), 'reference.md still has the worked example');
  assert.ok(skill.includes('<skill_dir>/adopt.md'), 'SKILL.md does not point at adopt.md');
  assert.ok(!skill.includes('reference.md "Adopting earlier work"'), 'SKILL.md still points at reference.md for adoption');
});

test('reference.md cleanup never runs git in a shadow project folder', () => {
  const reference = read(REFERENCE_MD).toString('utf8');
  const start = reference.indexOf('## Cleanup');
  assert.ok(start >= 0, 'reference.md lacks a Cleanup section');
  const next = reference.indexOf('\n## ', start + 1);
  const cleanup = reference.slice(start, next === -1 ? undefined : next);
  assert.ok(cleanup.includes('git --git-dir="<git_dir>" worktree remove'), cleanup);
  assert.ok(cleanup.includes('git -C "<worktree_root>/feature" branch -d'), cleanup);
  assert.match(cleanup, /not a repo/);
});

test('SKILL.md names the addendum scripts, fields, tools, and flow rules', () => {
  const text = read(SKILL_MD).toString('utf8').replace(/\s+/g, ' ');
  for (const term of ['scripts/setup', 'scripts/run-report', 'scripts/active-run', 'setup_result',
    'start_points', 'profile', 'autonomy', 'max_agents', 'PushNotification']) {
    assert.ok(text.includes(term), `SKILL.md lacks ${term}`);
  }
  assert.ok(text.includes('1-2 task'), 'SKILL.md lacks the 1-2 task step-aside rule');
  assert.match(text, /copy `<skill_dir>\/run\.workflow\.js` into the session scratchpad directory/);
  assert.match(text, /use that copy as `scriptPath`/);
});

test('SKILL.md stays under 2400 words', () => {
  const words = read(SKILL_MD).toString('utf8').split(/\s+/).filter(Boolean).length;
  assert.ok(words < 2400, `SKILL.md has ${words} words`);
});

test('reference.md has sections for profiles, tiers, batching, adjudicator, budgets, and the report', () => {
  const text = read(REFERENCE_MD).toString('utf8');
  const headings = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1].toLowerCase());
  for (const word of ['profiles', 'tiers', 'batching', 'adjudicator', 'budgets', 'report']) {
    assert.ok(headings.some((h) => h.includes(word)), `reference.md lacks a ${word} section`);
  }
});
