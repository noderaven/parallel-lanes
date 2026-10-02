export const meta = {
  name: 'parallel-lanes',
  description: 'Execute an implementation plan as parallel lanes of tasks with per-task review, then integrate.',
  phases: [],
};

// Top-level manifest keys that must be present (manifest.schema.json lists
// the same keys as its top-level "required").
function manifestRequiredKeys() {
  return [
    'version', 'run_id', 'plan', 'spec', 'commit_rules', 'repo', 'commands',
    'prelude', 'lanes', 'join', 'hooks', 'limits', 'dry_run', 'done',
    'reviewed', 'sp_dir', 'skill_dir',
  ];
}

// Validate a run manifest. Returns a list of error messages; empty means
// valid. This function is authoritative; manifest.schema.json documents it.
function validateManifest(m) {
  const errors = [];
  const err = (msg) => errors.push(msg);
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isText = (v) => typeof v === 'string' && v.length > 0;
  const isTextOrNull = (v) => v === null || isText(v);
  const isTextList = (v) => Array.isArray(v) && v.every(isText);
  const isPositiveInt = (v) => Number.isInteger(v) && v >= 1;

  if (!isObject(m)) return ['manifest: must be an object'];

  for (const key of manifestRequiredKeys()) {
    if (!(key in m)) err(`${key}: missing`);
  }

  if ('version' in m && m.version !== 1) err('version: must be 1');
  for (const key of ['run_id', 'plan', 'commit_rules', 'skill_dir']) {
    if (key in m && !isText(m[key])) err(`${key}: must be a non-empty string`);
  }
  for (const key of ['spec', 'sp_dir']) {
    if (key in m && !isTextOrNull(m[key])) err(`${key}: must be a non-empty string or null`);
  }
  if ('dry_run' in m && typeof m.dry_run !== 'boolean') err('dry_run: must be a boolean');

  if ('repo' in m) {
    const repo = m.repo;
    if (!isObject(repo)) {
      err('repo: must be an object');
    } else {
      if (repo.mode !== 'git' && repo.mode !== 'shadow') err("repo.mode: must be 'git' or 'shadow'");
      for (const key of ['root', 'base_ref', 'branch', 'worktree_root', 'ledger_dir']) {
        if (!isText(repo[key])) err(`repo.${key}: must be a non-empty string`);
      }
      if (!isTextOrNull(repo.git_dir)) err('repo.git_dir: must be a non-empty string or null');
      if (repo.mode === 'shadow' && !isText(repo.git_dir)) err('repo.git_dir: required when repo.mode is shadow');
    }
  }

  const checkCommands = (where, cmds, allRequired) => {
    if (!isObject(cmds)) {
      err(`${where}: must be an object`);
      return;
    }
    const names = ['setup', 'test', 'lint', 'build'];
    for (const name of names) {
      if (name in cmds) {
        if (!isTextList(cmds[name])) err(`${where}.${name}: must be a list of non-empty strings`);
      } else if (allRequired) {
        err(`${where}.${name}: missing`);
      }
    }
    for (const name of Object.keys(cmds)) {
      if (!names.includes(name)) err(`${where}.${name}: unknown command group`);
    }
  };
  if ('commands' in m) checkCommands('commands', m.commands, true);

  // Tasks: shape, light/security rule, and id uniqueness across all groups.
  const taskIds = new Set();
  const checkTask = (where, t) => {
    if (!isObject(t)) {
      err(`${where}: must be an object`);
      return;
    }
    const name = isText(t.id) ? `task ${t.id}` : where;
    if (!isText(t.id)) err(`${where}.id: must be a non-empty string`);
    else if (taskIds.has(t.id)) err(`task ${t.id}: id appears more than once`);
    else taskIds.add(t.id);
    if (!isText(t.title)) err(`${name}: title must be a non-empty string`);
    if (!isTextList(t.files)) err(`${name}: files must be a list of non-empty strings`);
    if (t.tier !== 'standard' && t.tier !== 'light') err(`${name}: tier must be 'standard' or 'light'`);
    if (typeof t.security !== 'boolean') err(`${name}: security must be a boolean`);
    if (t.tier === 'light' && t.security === true) err(`${name}: a light tier task cannot have security set`);
  };
  const checkTaskList = (where, list) => {
    if (!Array.isArray(list)) {
      err(`${where}: must be a list`);
      return;
    }
    list.forEach((t, i) => checkTask(`${where}[${i}]`, t));
  };

  if ('prelude' in m) checkTaskList('prelude', m.prelude);

  // Lanes: shape, unique lane ids, and no file claimed by two lanes.
  const laneIds = new Set();
  if ('lanes' in m) {
    if (!Array.isArray(m.lanes)) {
      err('lanes: must be a list');
    } else {
      const fileOwner = new Map();
      m.lanes.forEach((lane, i) => {
        const where = `lanes[${i}]`;
        if (!isObject(lane)) {
          err(`${where}: must be an object`);
          return;
        }
        if (!isText(lane.id)) err(`${where}.id: must be a non-empty string`);
        else if (laneIds.has(lane.id)) err(`lane ${lane.id}: id appears more than once`);
        else laneIds.add(lane.id);
        if (!isText(lane.name)) err(`${where}.name: must be a non-empty string`);
        if ('setup_note' in lane && !isText(lane.setup_note)) err(`${where}.setup_note: must be a non-empty string`);
        checkTaskList(`${where}.tasks`, lane.tasks);
        if (!isText(lane.id) || !Array.isArray(lane.tasks)) return;
        const files = new Set();
        for (const t of lane.tasks) {
          if (isObject(t) && isTextList(t.files)) t.files.forEach((f) => files.add(f));
        }
        for (const f of files) {
          const owner = fileOwner.get(f);
          if (owner === undefined) fileOwner.set(f, lane.id);
          else if (owner !== lane.id) err(`file ${f}: claimed by lanes ${owner} and ${lane.id}`);
        }
      });
    }
  }

  if ('join' in m) checkTaskList('join', m.join);

  if ('lane_commands' in m) {
    if (!isObject(m.lane_commands)) {
      err('lane_commands: must be an object');
    } else {
      for (const [laneId, cmds] of Object.entries(m.lane_commands)) {
        if (!laneIds.has(laneId)) err(`lane_commands.${laneId}: unknown lane id`);
        checkCommands(`lane_commands.${laneId}`, cmds, false);
      }
    }
  }

  if ('hooks' in m) {
    if (!isObject(m.hooks)) {
      err('hooks: must be an object');
    } else {
      for (const key of Object.keys(m.hooks)) {
        if (key !== 'post_integrate' && key !== 'e2e') err(`hooks.${key}: unknown hook`);
        else if (!isText(m.hooks[key])) err(`hooks.${key}: must be a non-empty string`);
      }
    }
  }

  if ('limits' in m) {
    if (!isObject(m.limits)) {
      err('limits: must be an object');
    } else {
      for (const key of ['review_rounds', 'max_parallel_lanes']) {
        if (!isPositiveInt(m.limits[key])) err(`limits.${key}: must be an integer >= 1`);
      }
    }
  }

  for (const key of ['done', 'reviewed']) {
    if (!(key in m)) continue;
    if (!isTextList(m[key])) {
      err(`${key}: must be a list of task ids`);
      continue;
    }
    for (const id of m[key]) {
      if (!taskIds.has(id)) err(`${key}: unknown task id ${id}`);
    }
  }

  return errors;
}

// Model settings. Light applies to implementers of light tasks only; every
// other agent (reviewers included) runs standard.
function tierSettings(tier) {
  return tier === 'light'
    ? { model: 'sonnet', effort: 'medium' }
    : { model: 'opus', effort: 'high' };
}

// The agents a run would spawn, in run order:
// [{phase, lane|null, task|null, role, model, effort}].
// Per task: none if done and reviewed, a review if done only, else implement
// plus review. Fix rounds are not predictable, so each task review counts as
// one; a task can add up to 2x review_rounds more (fix plus re-review).
// final_fix and final_re_review are listed as the upper bound; they run only
// when the final reviews report findings. Expects a valid manifest.
function planAgents(m) {
  const agents = [];
  const standard = tierSettings('standard');
  const add = (phase, lane, task, role, settings) =>
    agents.push({ phase, lane, task, role, ...settings });
  const done = new Set(m.done);
  const reviewed = new Set(m.reviewed);
  const addTasks = (phase, lane, tasks) => {
    for (const t of tasks) {
      if (done.has(t.id) && reviewed.has(t.id)) continue;
      if (!done.has(t.id)) add(phase, lane, t.id, 'implement', tierSettings(t.tier));
      add(phase, lane, t.id, 'review', standard);
    }
  };

  add('Setup', null, null, 'setup', standard);
  add('Pre-flight', null, null, 'preflight', standard);
  addTasks('Prelude', null, m.prelude);
  for (const lane of m.lanes) addTasks(lane.name, lane.id, lane.tasks);
  add('Integrate', null, null, 'integrate', standard);
  if (m.hooks.post_integrate) add('Integrate', null, null, 'post_integrate', standard);
  addTasks('Join', null, m.join);
  if (m.hooks.e2e) add('E2E', null, null, 'e2e', standard);
  for (const role of ['final_review_sp', 'final_review_security', 'final_review_correctness', 'final_fix', 'final_re_review']) {
    add('Final review', null, null, role, standard);
  }
  return agents;
}

// Lanes that would run at once: lanes with at least one planned agent,
// capped by limits.max_parallel_lanes.
function lanesEffective(m, agents) {
  const active = new Set(agents.filter((a) => a.lane !== null).map((a) => a.lane));
  return Math.min(active.size, m.limits.max_parallel_lanes);
}

// ---- Execution engine: per-task loop and lanes ----
//
// Every function below is pure over its parameters (no top-level const/let),
// so tests can load them with loadHelpers. The run functions take a trailing
// io object {agent, log} that defaults to the Workflow globals.

// Quote a string for a POSIX shell (single quotes, embedded ones escaped).
function shellQuote(s) {
  return "'" + String(s).split("'").join("'\\''") + "'";
}

// Progress phase of a ledger lane: prelude and join tasks have their own
// phases; lane tasks use the lane's name.
function lanePhase(m, laneId) {
  if (laneId === 'prelude') return 'Prelude';
  if (laneId === 'join') return 'Join';
  const lane = m.lanes.find((l) => l.id === laneId);
  return lane ? lane.name : laneId;
}

// Where a lane's tasks run: its own worktree and run branch.
function laneWhere(m, lane) {
  return {
    dir: `${m.repo.worktree_root}/lane-${lane.id}`,
    branch: `pl-${m.run_id}-${lane.id}`,
    lane: lane.id,
  };
}

// Scratch files for a task, kept in the ledger dir (outside every repo).
function taskFiles(m, task) {
  const dir = m.repo.ledger_dir;
  return {
    brief: `${dir}/briefs/${task.id}.md`,
    report: `${dir}/reports/${task.id}.md`,
    reviews: `${dir}/reviews`,
  };
}

// The exact ledger append command for one event of a task.
function ledgerCommand(m, laneId, entry) {
  const ledger = `${m.skill_dir}/scripts/ledger`;
  return `python3 ${shellQuote(ledger)} append ${shellQuote(m.repo.ledger_dir)} ` +
    `${shellQuote(laneId)} ${shellQuote(JSON.stringify(entry))}`;
}

// Project commands for a ledger lane; lane_commands override per group.
function commandsText(m, laneId) {
  const own = (m.lane_commands && m.lane_commands[laneId]) || {};
  return ['setup', 'test', 'lint', 'build'].map((name) => {
    const list = own[name] || m.commands[name] || [];
    return `- ${name}: ${list.length > 0 ? list.join(' ; ') : '(none)'}`;
  }).join('\n');
}

function findingsText(findings) {
  if (!Array.isArray(findings) || findings.length === 0) return '(none listed)';
  return findings.map((f, i) =>
    `${i + 1}. [${f.severity}] ${f.file}:${f.line} - ${f.issue} (suggested fix: ${f.fix})`).join('\n');
}

// Shared context every task agent gets.
function taskContext(m, task, where) {
  const files = taskFiles(m, task);
  const brief = `python3 ${shellQuote(`${m.skill_dir}/scripts/task-brief`)} ` +
    `${shellQuote(m.plan)} ${shellQuote(task.id)} ${shellQuote(files.brief)}`;
  const ruling = ledgerCommand(m, where.lane,
    { task: task.id, event: 'ruling', text: 'Ruling: <decision> - <why> - <cost if wrong>' });
  return [
    `Task ${task.id}: ${task.title}`,
    `Plan: ${m.plan}`,
    `Spec: ${m.spec === null ? '(none)' : m.spec}`,
    `Worktree: ${where.dir} (branch ${where.branch}). Work only there; do not switch branches.`,
    `Task brief: ${files.brief}. If it does not exist, create it with:`,
    `  ${brief}`,
    `Implementer report file: ${files.report}`,
    '',
    'Project commands (run from the worktree):',
    commandsText(m, where.lane),
    '',
    `Commit rules (follow exactly): ${m.commit_rules}`,
    'All files you write are plain ASCII. Never commit anything under .superpowers/.',
    'Never push, open pull requests, merge into the base branch, or copy work back to the project.',
    '',
    'Contracts: report blocked for any change to a contract another lane consumes; ' +
      'record smaller decisions as `Ruling: decision - why - cost if wrong` with:',
    `  ${ruling}`,
    'Ledger entries are shell single-quoted JSON: fill the <...> placeholders and keep quote characters out of the text.',
  ].join('\n');
}

function fallbackImplementer() {
  return [
    'Built-in instructions (superpowers not found):',
    'Implement exactly what the task brief specifies, nothing more. Follow test-driven development: write the',
    'failing tests first, run them and see them fail, implement, then run the full project test suite and make',
    'it pass. Commit with the commit rules below. Write your report (what you built, tests and their output,',
    'files changed, concerns) to the implementer report file. If anything is unclear or you cannot finish,',
    'report blocked with the specifics instead of guessing.',
  ].join('\n');
}

function fallbackReviewer() {
  return [
    'Built-in instructions (superpowers not found):',
    'Review this one task. Spec compliance: anything missing, extra, or misunderstood versus the brief.',
    'Quality: correctness, edge cases, error handling, tests that verify real behavior. Treat the',
    'implementer report as unverified claims. Cite file:line for every finding. Do not re-run the full suite;',
    'run a focused test only to settle a specific doubt.',
  ].join('\n');
}

function fallbackReReviewer() {
  return [
    'Built-in instructions (superpowers not found):',
    'Verify each finding below was addressed (the specific defect no longer exists, with file:line evidence)',
    'and check the fix diff for new problems it introduced. Do not re-review code the fix did not touch.',
  ].join('\n');
}

// How a reviewer gets the diff for base..head.
function diffSteps(m, task, where, base, head) {
  const dir = shellQuote(where.dir);
  if (m.sp_dir === null) {
    return [
      'Get the change with:',
      `  git -C ${dir} log --oneline ${shellQuote(`${base}..${head}`)}`,
      `  git -C ${dir} diff ${shellQuote(`${base}..${head}`)}`,
    ].join('\n');
  }
  const reviews = taskFiles(m, task).reviews;
  const out = `${reviews}/${task.id}-${base}..${head}.diff`;
  const script = `${m.sp_dir}/subagent-driven-development/scripts/review-package`;
  return [
    'Build the review package yourself with review-package (it writes the diff file and prints its path):',
    `  mkdir -p ${shellQuote(reviews)} && cd ${dir} && bash ${shellQuote(script)} ` +
      `${shellQuote(m.plan)} ${shellQuote(base)} ${shellQuote(head)} ${shellQuote(out)}`,
  ].join('\n');
}

function implementResultText() {
  return [
    'Return a structured result: status "done" or "blocked"; base = the commit HEAD pointed to before your',
    'first commit in this session; head = HEAD after your last commit; tests = the commands you ran and their',
    'outcome; notes = rulings, concerns, or the reason you are blocked. That result replaces any status reply',
    'format named in the instructions above.',
  ].join('\n');
}

function reviewResultText(m, task, where, rounds) {
  const reviewed = ledgerCommand(m, where.lane, { task: task.id, event: 'reviewed', rounds });
  return [
    'You are read-only: never modify the worktree, the index, HEAD, or any branch. Writing the review package',
    'and the ledger line (both outside the repo) is allowed.',
    'Also check every commit message in the range against the commit rules.',
    'Return a structured result: verdict "changes" when the spec is not met or any critical or important',
    'finding exists, otherwise "approve" (minor findings may accompany approve); findings = [{severity',
    '("critical", "important", or "minor"), file, line (0 when no single line applies), issue, fix}];',
    'cannot_verify = requirements you could not verify from the diff. That result replaces the output format',
    'named in the instructions above.',
    'Only when your verdict is approve, record it with:',
    `  ${reviewed}`,
  ].join('\n');
}

// Prompt for an implementer. retry (optional) is {reason, findings} when a
// previous attempt at the task blocked or failed review.
function implementPrompt(m, task, where, retry = null) {
  const files = taskFiles(m, task);
  const sdd = m.sp_dir === null ? null : `${m.sp_dir}/subagent-driven-development`;
  const committed = ledgerCommand(m, where.lane,
    { task: task.id, event: 'committed', commits: ['<sha>', '<sha>'] });
  const blockedCmd = ledgerCommand(m, where.lane, { task: task.id, event: 'blocked', reason: '<reason>' });
  const parts = [
    `You are implementing Task ${task.id}: ${task.title}`,
    '',
    sdd === null ? fallbackImplementer() : [
      `Read and follow ${sdd}/implementer-prompt.md: the prompt block inside its fence is your instructions,`,
      `with Task: Task ${task.id}: ${task.title}; [BRIEF_FILE]: ${files.brief}; [directory]: ${where.dir};`,
      `[REPORT_FILE]: ${files.report}. You cannot ask questions mid-task: report blocked with the question instead.`,
    ].join('\n'),
    '',
    taskContext(m, task, where),
  ];
  if (retry) {
    parts.push('', [
      `A previous attempt at this task did not succeed: ${retry.reason}`,
      'The worktree HEAD may already hold commits from it. Start from the current HEAD, keep what is right,',
      'and fix what is not.',
      ...(retry.findings ? ['Open review findings:', findingsText(retry.findings)] : []),
    ].join('\n'));
  }
  parts.push('', [
    'After committing, record your commits (every sha you made for this task, oldest first) with:',
    `  ${committed}`,
    'If you are blocked, record it with:',
    `  ${blockedCmd}`,
  ].join('\n'), '', implementResultText());
  return parts.join('\n');
}

// Prompt for the first (full) review of a task's base..head range.
function reviewPrompt(m, task, where, base, head, rounds = 0) {
  const files = taskFiles(m, task);
  const sdd = m.sp_dir === null ? null : `${m.sp_dir}/subagent-driven-development`;
  return [
    `You are reviewing Task ${task.id}: ${task.title} (range ${base}..${head}).`,
    '',
    sdd === null ? fallbackReviewer() : [
      `Read and follow ${sdd}/task-reviewer-prompt.md: the prompt block inside its fence is your instructions,`,
      `with [BRIEF_FILE]: ${files.brief}; [GLOBAL_CONSTRAINTS]: the Global Constraints section of the plan and`,
      `the commit rules below; [REPORT_FILE]: ${files.report}; [BASE_SHA]: ${base}; [HEAD_SHA]: ${head};`,
      '[DIFF_FILE]: the path review-package prints (below).',
    ].join('\n'),
    '',
    diffSteps(m, task, where, base, head),
    '',
    taskContext(m, task, where),
    '',
    reviewResultText(m, task, where, rounds),
  ].join('\n');
}

// Prompt for a fix agent. report is the latest implement or fix result.
function fixPrompt(m, task, where, findings, report) {
  const files = taskFiles(m, task);
  const sdd = m.sp_dir === null ? null : `${m.sp_dir}/subagent-driven-development`;
  const committed = ledgerCommand(m, where.lane,
    { task: task.id, event: 'committed', commits: ['<sha>', '<sha>'] });
  const blockedCmd = ledgerCommand(m, where.lane, { task: task.id, event: 'blocked', reason: '<reason>' });
  return [
    `You are fixing review findings for Task ${task.id}: ${task.title}`,
    '',
    sdd === null ? fallbackImplementer() : [
      `Read and follow ${sdd}/implementer-prompt.md: the prompt block inside its fence is your instructions,`,
      `with Task: Task ${task.id}: ${task.title}; [BRIEF_FILE]: ${files.brief}; [directory]: ${where.dir};`,
      `[REPORT_FILE]: ${files.report}. You are at its After Review Findings step.`,
    ].join('\n'),
    '',
    'Fix these findings, rerun the tests that cover the amended code, commit, and append a fix report',
    `(what changed, covering tests, command, output) to ${files.report}.`,
    'Findings:',
    findingsText(findings),
    '',
    'Latest implementer result:',
    JSON.stringify(report),
    '',
    taskContext(m, task, where),
    '',
    'After committing, record your fix commits (oldest first) with:',
    `  ${committed}`,
    'If you are blocked, record it with:',
    `  ${blockedCmd}`,
    '',
    implementResultText(),
  ].join('\n');
}

// Prompt for a scoped re-review of a fix range. round is the fix round.
function reReviewPrompt(m, task, where, base, head, findings, round = 1) {
  const files = taskFiles(m, task);
  const sdd = m.sp_dir === null ? null : `${m.sp_dir}/subagent-driven-development`;
  return [
    `You are re-reviewing fix round ${round} of Task ${task.id}: ${task.title} (fix range ${base}..${head}).`,
    '',
    sdd === null ? fallbackReReviewer() : [
      `Read and follow ${sdd}/re-review-prompt.md: the prompt block inside its fence is your instructions,`,
      `with [BRIEF_FILE]: ${files.brief}; [FINDINGS]: the findings below; [REPORT_FILE]: ${files.report};`,
      `[FIX_BASE_SHA]: ${base}; [HEAD_SHA]: ${head}; [DIFF_FILE]: the path review-package prints (below).`,
    ].join('\n'),
    '',
    'Findings under verification:',
    findingsText(findings),
    '',
    diffSteps(m, task, where, base, head),
    '',
    taskContext(m, task, where),
    '',
    'List every finding still open, and any new critical or important problem the fix introduced, as findings.',
    reviewResultText(m, task, where, round),
  ].join('\n');
}

function implementSchema() {
  return {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['done', 'blocked'] },
      base: { type: 'string' },
      head: { type: 'string' },
      tests: { type: 'string' },
      notes: { type: 'string' },
    },
    required: ['status', 'base', 'head', 'tests', 'notes'],
  };
}

function reviewSchema() {
  return {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['approve', 'changes'] },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            severity: { type: 'string', enum: ['critical', 'important', 'minor'] },
            file: { type: 'string' },
            line: { type: 'integer' },
            issue: { type: 'string' },
            fix: { type: 'string' },
          },
          required: ['severity', 'file', 'line', 'issue', 'fix'],
        },
      },
      cannot_verify: { type: 'array', items: { type: 'string' } },
    },
    required: ['verdict', 'findings', 'cannot_verify'],
  };
}

// Run one task through implement -> review -> fix/re-review rounds.
// Returns {task, status:'done'|'blocked', base, head, rounds, tier_used, notes};
// for a blocked task notes is the reason (exactly 'review_rounds' at the cap).
async function runTask(m, task, where, io = { agent, log }) {
  const phaseName = lanePhase(m, where.lane);
  const standard = tierSettings('standard');
  let tierUsed = task.tier;
  let base = null;
  let head = null;
  let rounds = 0;
  let changesSeen = 0;
  let latest = null;
  const extra = [];

  const result = (status, notes) =>
    ({ task: task.id, status, base, head, rounds, tier_used: tierUsed, notes });
  const call = (role, prompt, settings, schema) =>
    io.agent(prompt, { label: `${task.id} ${role}`, phase: phaseName, schema, ...settings });
  const escalate = (reason) => {
    tierUsed = 'standard';
    extra.push(`escalated to standard: ${reason}`);
    io.log(`${task.id}: escalating to standard (${reason})`);
  };
  // An implement or fix result that moved the branch; else why it did not.
  const failure = (r, label) => {
    if (r === null || r === undefined) return `no result from ${label}`;
    if (r.status !== 'done') return `${label} blocked: ${r.notes}`;
    if (r.head === r.base) return `${label} reported done with no commits`;
    return null;
  };
  // Implement, escalating a light task once if it does not finish.
  const implement = async (retry) => {
    for (;;) {
      const r = await call('implement', implementPrompt(m, task, where, retry),
        tierSettings(tierUsed), implementSchema());
      if (base === null && r && typeof r.base === 'string') base = r.base;
      const why = failure(r, `${task.id} implement`);
      if (why === null) {
        head = r.head;
        latest = r;
        return null;
      }
      if (tierUsed !== 'light') return why;
      escalate(why);
      retry = { reason: why, findings: null };
    }
  };
  let reviewLabel = 'review';
  const review = () => {
    reviewLabel = 'review';
    return call('review', reviewPrompt(m, task, where, base, head, rounds), standard, reviewSchema());
  };

  let why = await implement(null);
  if (why !== null) return result('blocked', why);

  let verdict = await review();
  for (;;) {
    if (!verdict || (verdict.verdict !== 'approve' && verdict.verdict !== 'changes')) {
      return result('blocked', `no result from ${task.id} ${reviewLabel}`);
    }
    if (verdict.verdict === 'approve') break;
    changesSeen += 1;
    const findings = verdict.findings;
    if (changesSeen === 2 && tierUsed === 'light') {
      escalate('second changes verdict');
      why = await implement({ reason: 'review requested changes twice', findings });
      if (why !== null) return result('blocked', why);
      verdict = await review();
      continue;
    }
    if (rounds >= m.limits.review_rounds) return result('blocked', 'review_rounds');
    rounds += 1;
    const fixLabel = `fix ${rounds}`;
    const fix = await call(fixLabel, fixPrompt(m, task, where, findings, latest),
      tierSettings(tierUsed), implementSchema());
    why = failure(fix, `${task.id} ${fixLabel}`);
    if (why !== null) return result('blocked', why);
    const prevHead = head;
    head = fix.head;
    latest = fix;
    reviewLabel = `re-review ${rounds}`;
    verdict = await call(reviewLabel,
      reReviewPrompt(m, task, where, prevHead, head, findings, rounds), standard, reviewSchema());
  }

  const notes = [...extra];
  if (latest.notes) notes.push(latest.notes);
  for (const item of verdict.cannot_verify || []) notes.push(`cannot verify: ${item}`);
  return result('done', notes.join('\n'));
}

// Run a lane's tasks in order in its worktree; stop at the first task that
// is not done. Returns {lane, results, stopped:reason|null}.
async function runLane(m, lane, io = { agent, log }) {
  const where = laneWhere(m, lane);
  const results = [];
  for (const task of lane.tasks) {
    const r = await runTask(m, task, where, io);
    results.push(r);
    if (r.status !== 'done') {
      io.log(`${lane.name}: stopped at ${task.id} (${r.notes})`);
      return { lane: lane.id, results, stopped: r.notes };
    }
  }
  return { lane: lane.id, results, stopped: null };
}

// Run lanes with at most limits.max_parallel_lanes in flight (a promise
// pool); results come back in lane order. A lane that throws stops only
// itself.
async function runLanes(m, lanes, io = { agent, log }) {
  const results = new Array(lanes.length);
  let next = 0;
  const worker = async () => {
    while (next < lanes.length) {
      const i = next;
      next += 1;
      try {
        results[i] = await runLane(m, lanes[i], io);
      } catch (e) {
        results[i] = { lane: lanes[i].id, results: [], stopped: `error: ${e && e.message}` };
      }
    }
  };
  const width = Math.min(m.limits.max_parallel_lanes, lanes.length);
  const workers = [];
  for (let w = 0; w < width; w += 1) workers.push(worker());
  await Promise.all(workers);
  return results;
}

// ---- Script body ----

if (args !== null && typeof args === 'object' && args.dry_run === true) {
  const errors = validateManifest(args);
  const agents = errors.length === 0 ? planAgents(args) : [];
  return {
    dry_run: true,
    errors,
    agents,
    lanes_effective: errors.length === 0 ? lanesEffective(args, agents) : 0,
  };
}
