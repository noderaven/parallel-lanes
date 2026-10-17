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

// What the skill does, then when to use it (the Agent Skills best-practices guide asks for both).
const DESCRIPTION = 'Runs an approved implementation plan as parallel lanes of tasks in separate git ' +
  'worktrees, each task implemented and reviewed by its own agents, then integrated, checked and ' +
  'reviewed as a whole. Use when an approved implementation plan is about to be executed (at the ' +
  'execution-method handoff), or when resuming a stopped parallel-lanes run.';

const NOTICES = {
  invoked: 'parallel-lanes invoked: evaluating <plan> for parallel execution',
  stepAside: 'parallel-lanes: not a fit (<reason>); recommending <method>',
  launch: 'parallel-lanes: launching run <run_id>: <N> lanes, <M> agents',
  resume: 'parallel-lanes: resuming run <run_id>: <K> tasks already committed',
  worthIt: "parallel-lanes: running in parallel saves about <saved> task-times, less than a run's fixed phases; "
    + 'recommending <method>',
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
// returns null, so the run stops right after; the availability probe that
// dead pair starts answers, so no agents-unavailable line is logged).
async function loggedNotices(m) {
  const logs = [];
  const agent = async (prompt, opts) => (opts.label === 'availability probe' ? { ok: true } : null);
  await loadScript({ args: m, agent, log: (msg) => logs.push(msg) });
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
  assert.ok(cleanup.includes('git --git-dir="<git_dir>" -c status.showUntrackedFiles=all worktree remove'), cleanup);
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
test('SKILL.md stays under 4000 words', () => {
  const words = read(SKILL_MD).toString('utf8').split(/\s+/).filter(Boolean).length;
  assert.ok(words < 4000, `SKILL.md has ${words} words`);
});

test('reference.md opens with a contents list naming every section in order', () => {
  // The best-practices guide: a reference file over 100 lines needs a table of contents at the
  // top, so a partial read (head -100) still shows everything the file holds.
  const text = read(REFERENCE_MD).toString('utf8');
  const lines = text.split('\n');
  const headings = lines.filter((l) => l.startsWith('## ')).map((l) => l.slice(3));
  assert.equal(headings[0], 'Contents');
  const start = lines.indexOf('## Contents');
  assert.ok(start >= 0 && start < 20, 'the contents list is near the top');
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  const entries = lines.slice(start + 1, end).filter((l) => l.startsWith('- ')).map((l) => l.slice(2).split(':')[0]);
  assert.deepEqual(entries, headings.slice(1));
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

// 1.6.7: the run carries the commit rules' identity to its merges, a refused
// wave merge stops the run for good, and a missing merge result relaunches.
test("reference.md documents the run's git identity and refused merges", () => {
  const raw = read(REFERENCE_MD).toString('utf8');
  const text = raw.replace(/\s+/g, ' ');
  for (const word of ['git_identity', '--git-config', 'exit 4', 'chore: join wave <n>: merge <unit>', 'index.lock']) {
    assert.ok(text.includes(word), `reference.md lacks ${word}`);
  }
  const start = raw.indexOf('\n### Transient stops\n');
  assert.ok(start >= 0, 'reference.md lacks a Transient stops heading');
  const end = raw.indexOf('\n#', start + 1);
  const transient = raw.slice(start, end === -1 ? undefined : end).replace(/\s+/g, ' ');
  for (const word of ['a refused merge', 'no result from <name> merge']) {
    assert.ok(transient.includes(word), `Transient stops lacks ${word}`);
  }
  const skill = read(SKILL_MD).toString('utf8').replace(/\s+/g, ' ');
  const relaunch = skill.slice(skill.indexOf('Relaunch once with the relaunch notice'), skill.indexOf('Launch again.'));
  assert.ok(relaunch.includes('setup_result'), relaunch);
});

test('reference.md documents the Workflow concurrency cap', () => {
  const text = read(REFERENCE_MD).toString('utf8');
  assert.ok(text.includes('CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS'), 'reference.md lacks the concurrency cap');
});

test('README asks for Node 24 and no longer calls Windows preliminary', () => {
  const text = read(README_MD).toString('utf8');
  assert.ok(text.includes('Node 24'), 'README does not ask for Node 24');
  assert.ok(!text.includes('Node 22'), 'README still asks for Node 22');
  assert.ok(!/preliminary/i.test(text), 'README still calls Windows support preliminary');
});

test('CI tests Node 24, not Node 22 or 18', () => {
  const text = read(CI_YML).toString('utf8');
  assert.ok(text.includes('node: 24'), 'CI has no Node 24 job');
  assert.ok(!text.includes('node: 22'), 'CI still has a Node 22 job');
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

// These tests check instructions to the session in reference.md (what it must
// say about the 1.4.4 hardening), not behaviour the code enforces.
test('reference.md documents the 1.4.4 hardening', () => {
  const raw = read(REFERENCE_MD).toString('utf8');
  const text = raw.replace(/\s+/g, ' ');
  for (const word of ['untracked_before', 'untracked_after', 'spec_sha256', 'same_location', 'unreadable_lines']) {
    assert.ok(text.includes(word), `reference.md lacks ${word}`);
  }
  assert.ok(/ignored files[^.]*run-checks|run-checks[^.]*ignored files/i.test(text),
    'reference.md does not say run-checks does not cover ignored files');
  assert.ok(text.includes('the spec changed since its review'), 'reference.md lacks the stale reason for a changed spec');
  assert.ok(text.includes('ledger reviewed DIR LANE TASK ROUNDS PLAN CHECKOUT HEAD BLOCKING [SPEC]'),
    'reference.md lacks the ledger reviewed usage');
  assert.ok(!text.includes('and the other texts as `also_reported`'), 'reference.md still has the old merge rule');
});

// These tests check instructions to the session in SKILL.md, reference.md and
// README.md (what they must say about the 1.5.0 run tools), not behaviour the
// code enforces.
function docSection(text, heading) {
  const start = text.indexOf(heading);
  assert.ok(start >= 0, `lacks ${heading}`);
  const next = text.indexOf('\n## ', start + heading.length);
  return text.slice(start, next === -1 ? undefined : next);
}

test('SKILL.md runs doctor before every dry run and on resume', () => {
  const text = read(SKILL_MD).toString('utf8').replace(/\s+/g, ' ');
  const confirmation = text.slice(text.indexOf('## Confirmation'), text.indexOf('## Launch'));
  const doctor = confirmation.indexOf('scripts/doctor');
  assert.ok(doctor >= 0 && doctor < confirmation.indexOf('1. Dry run'), 'doctor runs before the dry run');
  assert.ok(/Exit 2 or 3 stops the flow/.test(confirmation), 'doctor exit 2 or 3 must stop the flow');
  assert.ok(/warnings[^.]*table header/.test(confirmation), 'doctor warnings go in the table header');
  const resume = text.slice(text.indexOf('## Resume'), text.indexOf('## Red flags'));
  assert.ok(resume.includes('doctor included'), resume);
});

test('the hand-back archives the run and appends the autopsy summary', () => {
  const text = read(SKILL_MD).toString('utf8').replace(/\s+/g, ' ');
  const handBack = text.slice(text.indexOf('## Hand-back'), text.indexOf('## Resume'));
  const report = handBack.indexOf('scripts/run-report');
  const archive = handBack.indexOf('scripts/archive-run');
  const autopsy = handBack.indexOf('scripts/autopsy');
  assert.ok(report >= 0 && archive > report && autopsy > archive, handBack);
  assert.ok(/every run that ends after a launch/.test(handBack), 'hand-back must name every run that ends after a launch');
  assert.ok(/appen\w+ its (summary|output)/.test(handBack.slice(autopsy)), 'autopsy summary is appended');
});

test('cleanup asks before it removes anything', () => {
  const text = read(SKILL_MD).toString('utf8').replace(/\s+/g, ' ');
  const at = text.indexOf('Cleanup, only after');
  assert.ok(at >= 0, 'SKILL.md lacks the Cleanup line');
  const line = text.slice(at, text.indexOf('## Resume'));
  assert.ok(line.includes('scripts/cleanup'), line);
  const plain = line.indexOf('scripts/cleanup <manifest');
  const yes = line.indexOf('--yes');
  assert.ok(plain >= 0 && yes > plain, 'cleanup runs without --yes first');
  assert.ok(/without `--yes`/.test(line) || line.slice(plain, yes).includes('plan'), line);
  assert.ok(/(only after|on) the user'?s yes/.test(line.slice(yes - 60)), '--yes only after the user says yes');
});

test('reference.md documents the tools', () => {
  const raw = read(REFERENCE_MD).toString('utf8');
  const text = raw.replace(/\s+/g, ' ');
  for (const heading of ['## Run history', '## Autopsy', '## Doctor']) {
    assert.ok(raw.includes('\n' + heading + '\n'), `reference.md lacks ${heading}`);
  }
  const cleanup = docSection(raw, '## Cleanup').replace(/\s+/g, ' ');
  for (const word of ['scripts/cleanup', 'run.bundle', 'restore.md', 'not owned by this run']) {
    assert.ok(cleanup.includes(word), `the Cleanup section lacks ${word}`);
  }
  const words = ['PL_HISTORY_DIR', 'index.lock', 'unclean_checks', 'inputs_fingerprint', 'duration_s',
    // doctor's checks
    'git_identity', 'base_not_current', 'python', 'dirty_checkout', 'shadow_repo', 'memory', 'disk',
    'python_alias', 'heavy_processes', 'active_runs', 'defender', 'concurrency',
    // autopsy's detectors
    'background_check', 'timeout', 'repeated_failure', 'heredoc_failure', 'edit_retry',
    'extra_review_round', 'escalation', 'retry', 'relaunch', 'long_tool_call', 'idle_gap', 'check_rerun',
    'not_available', 'unavailable', 'partial', '--reindex'];
  for (const word of words) {
    assert.ok(text.includes(word), `reference.md lacks ${word}`);
  }
  // Each tool's exit codes.
  const exits = {
    '## Run history': ['archive-run', 'exit 0', 'exit 2', 'exit 3'],
    '## Autopsy': ['autopsy', 'exit 0', 'exit 2', 'exit 3'],
    '## Doctor': ['doctor', 'exit 0', 'exit 2', 'exit 3'],
    '## Cleanup': ['cleanup', 'exit 0', 'exit 1', 'exit 2', 'exit 3', 'exit 4'],
  };
  for (const [heading, terms] of Object.entries(exits)) {
    const body = docSection(raw, heading).replace(/\s+/g, ' ').toLowerCase();
    for (const term of terms) assert.ok(body.includes(term), `${heading} lacks ${term}`);
  }
  assert.ok(/history[^.]*exit 0[^.]*exit 2|exit 0[^.]*exit 2[^.]*history/i.test(docSection(raw, '## Autopsy').replace(/\s+/g, ' ')),
    'the Autopsy section gives the history exit codes');
});

test('README lists the five run tools and points to reference.md', () => {
  const text = read(README_MD).toString('utf8').replace(/\s+/g, ' ');
  for (const tool of ['doctor', 'archive-run', 'autopsy', 'history', 'cleanup']) {
    assert.ok(text.includes('`' + tool + '`'), `README lacks ${tool}`);
  }
  assert.ok(text.includes('reference.md'), 'README points to reference.md');
});

// These tests check instructions to the session in the docs, not enforced
// behaviour: the scripts and the Workflow code are tested elsewhere.
test('reference.md Autopsy documents check ids, certainty, completion timing and partial data', () => {
  const autopsy = section(read(REFERENCE_MD).toString('utf8'), 'Autopsy');
  for (const word of ['test#1', 'no command text', 'inferred', 'tool_s_min', 'A partial agent',
    '`ok`, `partial` or `not_available`', 'agents_with_usage', 'upper bound', 'completion notice']) {
    assert.ok(autopsy.includes(word), `the Autopsy section lacks ${word}`);
  }
  assert.ok(/completion notice[^.]*unavailable|unavailable[^.]*completion notice/.test(autopsy),
    'the Autopsy section ties the completion notice to an unavailable end');
});

test('reference.md Cleanup documents untracked files, the locks and the rechecks', () => {
  const cleanup = section(read(REFERENCE_MD).toString('utf8'), 'Cleanup');
  for (const word of ['status.showUntrackedFiles', 'ignored files', 'checkout lock',
    'changed after the plan', 'status --porcelain --untracked-files=all']) {
    assert.ok(cleanup.includes(word), `the Cleanup section lacks ${word}`);
  }
  assert.ok(cleanup.includes('run lock') || cleanup.includes('active-run acquire'),
    'the Cleanup section names neither the run lock nor active-run acquire');
  const flat = cleanup.replace(/\s+/g, ' ');
  assert.ok(/ignored files do not keep a worktree, and `git worktree remove` deletes them/.test(flat),
    'the Cleanup section does not say that removal deletes ignored files');
  assert.ok(flat.includes('before `--yes`'), 'the Cleanup section does not say to copy ignored files first');
  // Every git worktree remove, scripted or manual, makes git's own check see untracked files.
  assert.deepEqual(flat.match(/git (?:-C |--git-dir=)"[^"]*" worktree remove/g), null,
    'a worktree remove in the Cleanup section lacks -c status.showUntrackedFiles=all');
});

test('reference.md Run history describes an OS lock released with its process', () => {
  const history = section(read(REFERENCE_MD).toString('utf8'), 'Run history');
  assert.ok(history.includes('OS lock'), history);
  assert.ok(/released when its process ends/.test(history), 'the lock release is not described');
  assert.ok(!/stale/i.test(history), 'the Run history section still mentions stale takeover');
});

test('reference.md Doctor says exit 2 stops the flow like exit 3', () => {
  const doctor = section(read(REFERENCE_MD).toString('utf8'), 'Doctor');
  assert.ok(/Exit 2:[^.]*could not run[^.]*stops the flow/.test(doctor), doctor);
});

test('SKILL.md stops on doctor exit 2 or 3 and starts Resume step 6 with Confirmation', () => {
  const raw = read(SKILL_MD).toString('utf8');
  assert.ok(section(raw, 'Confirmation').includes('Exit 2 or 3 stops the'),
    'Confirmation lacks "Exit 2 or 3 stops the"');
  assert.ok(raw.replace(/\s+/g, ' ').includes('6. Confirmation, doctor included'),
    'Resume step 6 does not start with Confirmation, doctor included');
});

// These tests check instructions to the session in SKILL.md and reference.md
// (what they must say about launch conditions and the hand-back's run-tools
// line), not behaviour the code enforces: scripts and the Workflow code are
// tested elsewhere.
const flat = (path) => read(path).toString('utf8').replace(/\s+/g, ' ');

test("doctor's result is saved and bound to each launch", () => {
  const raw = read(SKILL_MD).toString('utf8');
  const confirmation = section(raw, 'Confirmation');
  assert.match(confirmation, /scripts\/doctor <manifest file> --save /, confirmation);
  const launch = section(raw, 'Launch');
  const step4 = launch.slice(launch.indexOf('4. Call the Workflow tool'), launch.indexOf('5. Record'));
  assert.ok(step4.includes('scripts/ledger conditions <ledger_dir> <wf id>'), step4);
  assert.match(step4, /wf id is this launch's[^.]*never the dry run's/, step4);
  assert.ok(/refusal never stops the run/.test(step4), step4);
  const transient = section(raw, 'Transient stops');
  assert.match(transient, /before recording the stopped launch's end, run doctor again/i, transient);
  assert.ok(transient.includes('--save'), transient);
  assert.match(transient, /exit 2 or 3[^.]*real stop/i, transient);
  assert.ok(transient.includes('status `stopped`') && transient.includes('release the lock'), transient);
  assert.ok(transient.includes('--relaunch-blocked'), transient);
  assert.match(transient, /ledger conditions[^.]*new launch/, transient);
});

test('the hand-back keeps run tools apart from acceptance', () => {
  const skill = flat(SKILL_MD);
  const handBack = skill.slice(skill.indexOf('## Hand-back'), skill.indexOf('## Resume'));
  const autopsy = handBack.indexOf('scripts/autopsy');
  const tools = handBack.indexOf('scripts/tool-outcomes');
  assert.ok(autopsy >= 0 && tools > autopsy, handBack);
  const reference = flat(REFERENCE_MD);
  assert.match(reference, /tool failure never changes `acceptance`/);
  assert.match(reference, /`tool-outcomes` runs again after cleanup/);
});

test('reference.md documents launch conditions', () => {
  const ref = read(REFERENCE_MD).toString('utf8');
  const wants = [
    ['Run tools line', ['--run-folder', '--archive-exit', '--autopsy-exit', '--conditions-refused',
      '--relaunch-blocked', '--cleanup', '--json']],
    ['Doctor', ['--save', '`checks`', '`observed_at`', '`doctor_version`', 'not_recorded']],
    ['Autopsy', ['`launch_conditions`', 'orphan_snapshots']],
    ['Launch conditions', ['ledger conditions', 'wf_recorded', 'not_doctor', 'no_setup', 'setup_recorded',
      'observation_reused', '`recorded`', '`unavailable`', '`inconsistent`', 'orphan_snapshots',
      'could not be read', 'possible contributor', 'observed before launch',
      'status.showUntrackedFiles=no']],
  ];
  for (const [heading, words] of wants) {
    const text = section(ref, heading);
    for (const word of words) {
      assert.ok(text.includes(word), `reference.md "${heading}" lacks ${word}`);
    }
  }
  assert.match(flat(REFERENCE_MD), /Consumes and Produces labels may be plain or bold/);
});

test('README names tool-outcomes among the scripts', () => {
  const text = flat(README_MD);
  assert.match(text, /\| `scripts\/` \|[^|]*tool-outcomes/);
});

// These tests check instructions to the session in SKILL.md, reference.md and
// README.md (what they must say about the audit), not behaviour the code
// enforces.
test('the hand-back runs audit before tool-outcomes', () => {
  const skill = flat(SKILL_MD);
  const handBack = skill.slice(skill.indexOf('## Hand-back'), skill.indexOf('## Resume'));
  const autopsy = handBack.indexOf('scripts/autopsy');
  const audit = handBack.indexOf('scripts/audit');
  const tools = handBack.indexOf('scripts/tool-outcomes');
  assert.ok(autopsy >= 0 && audit > autopsy && tools > audit, handBack);
  const auditCommand = handBack.slice(audit, tools);
  assert.match(auditCommand, /--repo <repo\.git_dir in shadow mode, else repo\.root>/, auditCommand);
  assert.match(auditCommand, /--head <branch>/, auditCommand);
  assert.match(auditCommand, /appending its summary/, auditCommand);
  assert.ok(auditCommand.includes('reference.md "Audit"'), auditCommand);
  assert.match(handBack.slice(tools), /--audit-exit N/, handBack.slice(tools));
});

test('a user accept reruns the archive and audit', () => {
  const skill = flat(SKILL_MD);
  const handBack = skill.slice(skill.indexOf('## Hand-back'), skill.indexOf('## Resume'));
  const accept = handBack.indexOf('scripts/ledger accept');
  assert.ok(accept >= 0, handBack);
  const after = handBack.slice(accept, handBack.indexOf('Report: run', accept));
  const archive = after.indexOf('archive-run');
  const audit = after.indexOf('audit');
  const tools = after.indexOf('tool-outcomes');
  assert.ok(archive >= 0 && audit > archive && tools > audit, after);
  assert.match(after, /rerun/, after);
});

test('reference.md documents the audit', () => {
  const ref = read(REFERENCE_MD).toString('utf8');
  assert.ok(ref.includes('\n## Audit\n'), 'reference.md lacks ## Audit');
  const audit = section(ref, 'Audit');
  const wants = [
    // the six states and the gap list
    '`present`', '`missing`', '`stale`', '`conflicting`', '`unavailable`', '`inferred`', 'gaps',
    // the verdict and the evidence rules
    'accepted (gate unavailable)', 'evidence validity',
    // the range section and the final re-review
    'Code outside recorded task ranges', 'final re-review',
    // check-verify's archive mode
    '--ledger', 'verify_evidence_time_untrusted',
    // privacy
    'check ids', 'quoted as written', 'local-only',
    // output and exit codes
    'UTF-8', 'exit 0', 'exit 2', 'exit 3', '--audit-exit',
  ];
  for (const word of wants) {
    assert.ok(audit.includes(word), `the Audit section lacks ${word}`);
  }
  const verify = section(ref, 'Verify evidence');
  assert.ok(verify.includes('--ledger') && verify.includes('verify_evidence_time_untrusted'), verify);
  const tools = section(ref, 'Report');
  assert.ok(tools.includes('--audit-exit') && tools.includes('audit generated'), tools);
});

test('README names audit among the scripts', () => {
  assert.match(flat(README_MD), /\| `scripts\/` \|[^|]*\baudit\b/);
});

// ---- 1.6.0 check policy (spec 4.12) ----

test('the relaunch recomputes the ledger state before setup', () => {
  const relaunch = section(read(SKILL_MD).toString('utf8'), 'Transient stops');
  const recompute = relaunch.indexOf('recompute `done`');
  const setup = relaunch.indexOf('scripts/setup --owner');
  assert.ok(recompute >= 0 && setup >= 0 && recompute < setup, relaunch);
  assert.ok(relaunch.includes('repairs_spent'), relaunch);
  assert.ok(relaunch.includes('setup_skipped'), relaunch);
});

test('reference.md documents the check policy fields', () => {
  const ref = read(REFERENCE_MD).toString('utf8');
  const fields = section(ref, 'Manifest fields');
  for (const word of ['`task_checks`', '`widen_paths`', '`repairs_spent`', 'setup_skipped']) {
    assert.ok(fields.includes(word), `Manifest fields lacks ${word}`);
  }
  const ownership = section(ref, 'Check ownership');
  for (const word of ['task-checks', 'targeted', 'widened', '--force-full', 'repair', '--descends-from', 'repairReserve',
    'new_findings', 'setup_skipped', 'status.showUntrackedFiles']) {
    assert.ok(ownership.includes(word), `Check ownership lacks ${word}`);
  }
  assert.ok(flat(REFERENCE_MD).includes('changes to shared files will not widen task checks'), 'the widen warning');
  const budgets = section(ref, 'Budgets');
  assert.ok(budgets.includes('repairs_spent'), budgets);
  const autopsy = section(ref, 'Autopsy');
  for (const word of ['task_check_calls', 'project_test_runs', 'check calls with a test group']) {
    assert.ok(autopsy.includes(word), `Autopsy lacks ${word}`);
  }
});

test('SKILL.md lists checks among the dry-run fields and points to the check policy fields', () => {
  const skill = flat(SKILL_MD);
  assert.ok(skill.includes('`{dry_run, errors, agents, lanes_effective, notices, checks, join_waves}`'), 'dry-run fields');
  assert.ok(skill.includes('`task_checks`') && skill.includes('`widen_paths`'), 'manifest step');
});

test('README names task-checks among the scripts', () => {
  assert.match(flat(README_MD), /\| `scripts\/` \|[^|]*\btask-checks\b/);
});

test('reference.md documents await-checks, its exit codes, --exact busy, tree_changed and the procedure', () => {
  const ref = read(REFERENCE_MD).toString('utf8');
  const long = section(ref, 'Long checks');
  for (const word of ['await-checks', 'reserve', 'wait', '--exact', 'busy', 'tree_changed',
    'exit 4', 'exit 5', 'not_started', 'died', 'run_in_background', 'verify_stopped',
    'AWAIT_CHECKS_GRACE_S', '--evidence', '--lock-held', 'rerun']) {
    assert.ok(long.includes(word), `Long checks lacks ${word}`);
  }
  assert.ok(section(ref, 'Check ownership').includes('Long checks'), 'Check ownership does not point to Long checks');
});

test('README lists await-checks', () => {
  assert.match(flat(README_MD), /\| `scripts\/` \|[^|]*\bawait-checks\b/);
});

// ---- 1.6.2 clean stops (spec 4.0, 4.2, 4.3, 4.5) ----

test('SKILL.md: the transient rule covers agents_unavailable, stop-cause and the engine version', () => {
  const transient = section(read(SKILL_MD).toString('utf8'), 'Transient stops');
  for (const word of ['`agents_unavailable`', 'scripts/stop-cause', '`<skill_dir>/VERSION`', 'Resume']) {
    assert.ok(transient.includes(word), `Transient stops lacks ${word}: ${transient}`);
  }
  // The second-stop rule keeps the usage-limit exception wherever it appears.
  const second = [...transient.matchAll(/A second transient stop is a real stop([^.]*)\./g)];
  assert.ok(second.length > 0, transient);
  for (const m of second) assert.match(m[1], /^, unless it is a usage-limit stop/, m[0]);
  // The carry-over arithmetic moved whole to reference.md.
  assert.ok(!transient.includes('floor 0'), transient);
  assert.ok(transient.includes('reference.md "Transient stops"'), transient);
});

test('SKILL.md: the confirmation header shows the usage-limit pause', () => {
  const confirmation = section(read(SKILL_MD).toString('utf8'), 'Confirmation');
  assert.ok(confirmation.includes('`usage_limit_pause`'), confirmation);
  assert.ok(confirmation.includes('reference.md "Usage limit"'), confirmation);
});

test('reference.md has the Usage limit and Exit codes sections', () => {
  const ref = read(REFERENCE_MD).toString('utf8');
  assert.match(ref, /^## Usage limit$/m);
  assert.match(ref, /^## Exit codes$/m);
  const codes = section(ref, 'Exit codes');
  for (const row of [/\| `124` \|/, /\| `75` \|/, /\| `128` and above[^|]*\|/]) {
    assert.match(codes, row, codes);
  }
  assert.ok(codes.includes('steer repair, fix and retry, never acceptance'), codes);
  for (const word of ['run-checks', 'unity-batch.sh', '`--timeout`', 'wall time', 'busy_retry',
    'checks_unfinished', 'setup commands', 'hook commands']) {
    assert.ok(codes.includes(word), `Exit codes lacks ${word}`);
  }
  assert.ok(section(ref, 'Check ownership').includes('"Exit codes"'), 'Check ownership does not link Exit codes');
});

test('reference.md "Usage limit" quotes the platform pause and says when and how often to relaunch', () => {
  const usage = section(read(REFERENCE_MD).toString('utf8'), 'Usage limit');
  for (const word of ['"Dynamic workflows"', 'read 2026-10-13', 'v2.1.271', '`autoContinueAtUsageLimit`',
    'Remote Control', '24 hours', 'scripts/stop-cause <transcript dir>', 'next turn', 'once after each reset',
    '`results_before`', 'launch lock', 'Resume']) {
    assert.ok(usage.includes(word), `Usage limit lacks ${word}`);
  }
});

test('reference.md: the header pause line, the transient causes and the moved carry-over', () => {
  const ref = read(REFERENCE_MD).toString('utf8');
  const header = ref.slice(ref.indexOf('### Confirmation header'), ref.indexOf('### Transient stops')).replace(/\s+/g, ' ');
  assert.ok(header.includes('"Usage limit: the run pauses at the limit and continues by itself"'), header);
  assert.ok(header.includes('"Usage limit: the run will not pause (<reasons>); on a limit it stops cleanly and is relaunched after the reset"'), header);
  assert.ok(header.includes('`usage_limit_pause`'), header);
  const tail = ref.slice(ref.indexOf('### Transient stops'));
  const transient = tail.slice(0, tail.indexOf('\n## ')).replace(/\s+/g, ' ');
  for (const word of ['`agents_unavailable`', 'agents unavailable:', '`<skill_dir>/VERSION`',
    'lower `limits.max_agents` by the stopped run\'s `agents_spawned` and `limits.max_rulings` by its `rulings_spent`, floor 0',
    'If fewer than 1 agent would remain, treat it as a budget cap: stop and notify.']) {
    assert.ok(transient.includes(word), `Transient stops lacks ${word}`);
  }
});

test('reference.md documents the 1.6.2 report fields, doctor check and repair reserve', () => {
  const ref = read(REFERENCE_MD).toString('utf8');
  const report = section(ref, 'Report');
  for (const word of ['agents_unavailable', 'results_before', 'busy_retry', 'checks_unfinished', 'index_commit', 'index_saved']) {
    assert.ok(report.includes(word), `Report lacks ${word}`);
  }
  const doctor = section(ref, 'Doctor');
  assert.ok(doctor.includes('`usage_limit_pause`') && doctor.includes('fourteen checks'), doctor);
  // host_budget is expected at the skill's own lane cap on a small machine (1.6.4).
  assert.ok(doctor.replace(/\s+/g, ' ').includes('expected at the lane cap'), 'host_budget at the cap');
  assert.ok(section(ref, 'Launch conditions').includes('usage_limit_pause'), 'Launch conditions lacks usage_limit_pause');
  assert.ok(section(ref, 'Budgets').includes('(7, plus 4 with an e2e hook'), 'Budgets reserve');
  assert.ok(section(ref, 'Check ownership').includes('The reserve is 7'), 'Check ownership reserve');
});

test('README lists stop-cause', () => {
  assert.match(flat(README_MD), /\| `scripts\/` \|[^|]*\bstop-cause\b/);
});

// 1.6.4: the worth-it check at the Assessment and the Offer.
const OFFER_LINES = [
  "Worth it: these lanes run <N> tasks in about <S> task-slots, saving about <saved> task-times; a run's fixed "
    + 'phases cost about 1-2.',
  "For scale: this project's past runs took about <T> min per task (<min>-<max>).",
  "A direct build still ends with a whole-branch review; it gives up the run's worktree isolation, integration and "
    + 'delivery checks, E2E and the multi-lens final review with its verify gate.',
  'Worth it: unavailable (<reason>).',
];

test('SKILL.md runs worth-it after the layout and shows its lines at the Offer', () => {
  const text = flat(SKILL_MD);
  assert.ok(text.includes('<skill_dir>/scripts/worth-it'), 'SKILL.md names scripts/worth-it');
  for (const line of OFFER_LINES) assert.ok(text.includes(line), `SKILL.md lacks: ${line}`);
  assert.ok(!text.includes('a single lane included'), 'the single-lane rule changed in 1.6.4');
  assert.ok(text.includes('single-lane'), 'SKILL.md says what happens to a single-lane plan');
  assert.ok(text.includes('only when the Offer'), 'the check runs only when the Offer is shown');
  // Final review (1.6.4): a usage error exits 2 with no JSON; it must not stop the Offer either.
  assert.ok(text.includes('a non-zero exit or any `status` other than `ok` leaves the Offer as it was'), 'fail open');
});

test('reference.md documents worth-it, and bootstrap.md lets a direct build follow its recommendation', () => {
  const ref = read(REFERENCE_MD).toString('utf8');
  assert.ok(ref.split('\n').includes('## Worth it'), 'reference.md has a Worth it section');
  for (const word of ['THRESHOLD', 'task-slots', 'back-test', 'lite', 'checks.commands', '--runs', 'host_budget']) {
    assert.ok(ref.includes(word), `reference.md lacks ${word}`);
  }
  const boot = flat(join(SKILL_DIR, 'hooks', 'bootstrap.md'));
  assert.ok(boot.includes('Use a superpowers execution mode only when parallel-lanes steps aside, recommends a direct '
    + 'build and the user picks it, or the user explicitly asks for one.'), boot);
});

