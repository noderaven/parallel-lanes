import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_DIR, loadScript } from './harness.mjs';

const SKILL_MD = join(SKILL_DIR, 'SKILL.md');
const REFERENCE_MD = join(SKILL_DIR, 'reference.md');
const ADOPT_MD = join(SKILL_DIR, 'adopt.md');
const README_MD = join(SKILL_DIR, 'README.md');
const CI_YML = join(SKILL_DIR, '.github', 'workflows', 'tests.yml');

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
  // The fixed notices start with 'parallel-lanes:'; the version line
  // ('parallel-lanes v<version> loaded') is not one of them.
  return logs.filter((l) => l.startsWith('parallel-lanes:'));
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

// The review: verify the plan inventory when creating and when resuming a
// run; a resume reads stale dependents and the spend of earlier launches.
test('SKILL.md resume rechecks coverage, passes the manifest to ledger status, and carries the spend', () => {
  const text = read(SKILL_MD).toString('utf8').replace(/\s+/g, ' ');
  const resume = text.slice(text.indexOf('## Resume'), text.indexOf('## Red flags'));
  assert.ok(resume.includes('scripts/coverage <plan> <manifest file>` must exit 0'), resume);
  assert.ok(resume.includes('--plan <plan> --manifest <manifest file>'), resume);
  assert.ok(resume.includes('`spent` lowers `limits.max_rulings`'), resume);
  assert.ok(text.includes('ledger accept <ledger_dir>'), 'an explicit acceptance is recorded');
});

// The limit guards against bloat; it is not a target to compress toward.
// SKILL.md holds what every invocation needs (the flow, the hard rules, the
// notices, the consent gate, the hand-back). Material needed only sometimes
// moves whole to reference.md, with SKILL.md pointing to it. Never shorten
// sentences or drop the reasons behind rules to stay under the limit.
test('SKILL.md stays under 3000 words', () => {
  const words = read(SKILL_MD).toString('utf8').split(/\s+/).filter(Boolean).length;
  assert.ok(words < 3000, `SKILL.md has ${words} words`);
});

test('reference.md has sections for profiles, tiers, batching, adjudicator, budgets, and the report', () => {
  const text = read(REFERENCE_MD).toString('utf8');
  const headings = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1].toLowerCase());
  for (const word of ['profiles', 'tiers', 'batching', 'adjudicator', 'budgets', 'report']) {
    assert.ok(headings.some((h) => h.includes(word)), `reference.md lacks a ${word} section`);
  }
});

test('SKILL.md finds Python first and uses <python> in every helper command', () => {
  const skill = read(SKILL_MD).toString('utf8');
  assert.ok(skill.includes('scripts/find-python'), 'SKILL.md does not run find-python');
  assert.ok(skill.includes('<python> <skill_dir>/scripts/'), 'SKILL.md lacks <python> helper commands');
  for (const [name, path] of [['SKILL.md', SKILL_MD], ['reference.md', REFERENCE_MD], ['adopt.md', ADOPT_MD]]) {
    const text = read(path).toString('utf8');
    assert.ok(!text.includes('python3 <skill_dir>'), `${name} still runs a helper with python3`);
    assert.ok(!/(^|[`"(\s])python3 -c/m.test(text), `${name} still runs python3 -c`);
  }
});

test('README has a Windows section', () => {
  const text = read(README_MD).toString('utf8');
  for (const term of ['Git for Windows', 'winget install jqlang.jq', 'CLAUDE_CODE_GIT_BASH_PATH',
    'core.longpaths', 'PowerShell']) {
    assert.ok(text.includes(term), `README lacks ${term}`);
  }
  assert.match(text, /^#+ .*Windows/m, 'README has no Windows heading');
});

// The text of one '## <heading>' section of a markdown file, up to the next one.
function section(text, heading) {
  const start = text.indexOf(`## ${heading}`);
  assert.ok(start >= 0, `no section ${heading}`);
  const next = text.indexOf('\n## ', start + 1);
  return text.slice(start, next === -1 ? undefined : next).replace(/\s+/g, ' ');
}

// The launch message reaches every agent with priority over the plan, so
// the session asks for a plain yes and says why.
test('SKILL.md asks for a plain yes at the table and says why', () => {
  const confirmation = section(read(SKILL_MD).toString('utf8'), 'Confirmation');
  assert.ok(confirmation.includes('plain yes'), confirmation);
  assert.ok(confirmation.includes('every agent'), confirmation);
});

test('SKILL.md checks for a git identity before launch', () => {
  const building = section(read(SKILL_MD).toString('utf8'), 'Building the manifest');
  assert.ok(building.includes('git -C <project> var GIT_COMMITTER_IDENT'), building);
});

test('SKILL.md records the spend and releases the lock in one step, and prints the dry run notices', () => {
  const launch = section(read(SKILL_MD).toString('utf8'), 'Launch');
  assert.ok(launch.includes('scripts/ledger ended'), launch);
  assert.ok(launch.includes('notices'), launch);
});

test('reference.md documents the Workflow concurrency cap', () => {
  const text = read(REFERENCE_MD).toString('utf8');
  assert.ok(text.includes('CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS'), 'reference.md lacks the concurrency cap');
});

test('README asks for Node 22 and no longer calls Windows preliminary', () => {
  const text = read(README_MD).toString('utf8');
  assert.ok(text.includes('Node 22') || text.includes('**node** 22'), 'README does not ask for Node 22');
  assert.ok(!/preliminary/i.test(text), 'README still calls Windows support preliminary');
});

test('CI tests Node 22, not Node 18', () => {
  const text = read(CI_YML).toString('utf8');
  assert.ok(text.includes('node: 22'), 'CI has no Node 22 job');
  assert.ok(!text.includes('node: 18'), 'CI still has a Node 18 job');
});

test('the docs describe the 1.4.0 lock owner, checkout lock, acceptance gates and shadow bytes', () => {
  const skill = read(SKILL_MD).toString('utf8').replace(/\s+/g, ' ');
  const reference = read(REFERENCE_MD).toString('utf8').replace(/\s+/g, ' ');
  const readme = read(README_MD).toString('utf8').replace(/\s+/g, ' ');
  for (const m of skill.matchAll(/active-run release[^`]*/g)) {
    assert.ok(m[0].includes('--owner <token>'), `SKILL.md release lacks --owner: ${m[0]}`);
  }
  assert.ok(skill.includes('`preflight.schedule` is non-empty'), 'SKILL.md hand-back covers preflight.schedule');
  assert.ok(skill.includes('the checkout ... is in use by run ...'), 'SKILL.md setup exit 4 covers the checkout lock');
  assert.ok(!skill.includes('(plain ASCII)'), 'SKILL.md still says (plain ASCII)');
  for (const word of ['checks_unclean', 'review_unbound', 'tracked_before', 'tracked_after', 'lens_heads',
    'review_problem', 'code_deps', 'preflight.schedule', 'PL_MUTEX_WAIT', '--owner <token>', 'info/attributes',
    'checkout-<st_dev>-<st_ino>.lock', 'differ only in letter case', 'Windows device name']) {
    assert.ok(reference.includes(word), `reference.md lacks ${word}`);
  }
  assert.ok(readme.includes('is in use by run'), 'README lacks the checkout lock row');
  assert.ok(readme.includes('--owner <token>'), 'README lacks the release --owner row');
});

// These tests check instructions to the session, not enforced behaviour: the
// session is the only thing that runs check-verify and obeys its result.
test('SKILL.md gates accepted on check-verify and fails closed', () => {
  const skillRaw = read(SKILL_MD).toString('utf8');
  const skill = skillRaw.replace(/\s+/g, ' ');
  for (const word of ['scripts/check-verify', 'match', 'not_required']) {
    assert.ok(skill.includes(word), `SKILL.md lacks ${word}`);
  }
  const launch = section(skillRaw, 'Launch');
  const release = launch.slice(launch.indexOf('`<release>` is'));
  assert.ok(release.includes('`<release>` is') && release.includes('check-verify'),
    `Launch step 5 does not tie <release> to check-verify: ${release}`);
  const handBack = section(skillRaw, 'Hand-back');
  const complete = handBack.slice(handBack.indexOf('- `complete`'));
  assert.ok(complete.includes('check-verify'), complete);
  assert.ok(/exit 1, 2 or 3/.test(complete) && complete.includes('check-verify error'), complete);
  assert.ok(complete.includes('`unverified`') && complete.includes('keep the marker'), complete);
  assert.ok(complete.includes('reference.md "Verify evidence"'), complete);
});

test('reference.md documents check-verify within its trust boundary', () => {
  const raw = read(REFERENCE_MD).toString('utf8');
  assert.ok(/^## Verify evidence$/m.test(raw), 'reference.md lacks a Verify evidence heading');
  const text = raw.replace(/\s+/g, ' ');
  for (const word of ['match', 'not_required', 'missing', 'stale', 'mismatch', 'invalid',
    'verify_evidence_missing', 'verify_evidence_stale', 'verify_mismatch', 'verify_invalid',
    'it does not re-run the checks', 'session-verify-', 'ledger accept']) {
    assert.ok(text.includes(word), `reference.md lacks ${word}`);
  }
  assert.ok(!text.includes('is not caught by the run'), 'reference.md still says the run does not catch a misreport');
});
