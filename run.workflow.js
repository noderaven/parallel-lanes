export const meta = {
  name: 'parallel-lanes',
  description: 'Execute an implementation plan as parallel lanes of tasks with per-task review, then integrate.',
  phases: [
    { title: 'Setup', detail: 'feature branch and lane worktrees' },
    { title: 'Pre-flight', detail: 'plan and spec conflicts' },
    { title: 'Prelude', detail: 'shared tasks on the feature branch' },
    { title: 'Integrate', detail: 'merge lanes, rerun all commands' },
    { title: 'Join', detail: 'tasks on the merged branch' },
    { title: 'E2E', detail: 'end-to-end hook' },
    { title: 'Final review', detail: 'three lenses, one fix round' },
  ],
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
        else if (lane.id === 'prelude' || lane.id === 'join') err(`lane ${lane.id}: id is reserved`);
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

  // backfill: commits of done-but-unreviewed tasks, from ledger committed
  // events; such a task is reviewed on base..head before its lane continues.
  const backfill = 'backfill' in m ? m.backfill : {};
  if (!isObject(backfill)) {
    err('backfill: must be an object');
  } else {
    for (const [id, range] of Object.entries(backfill)) {
      if (!taskIds.has(id)) err(`backfill: unknown task id ${id}`);
      if (!isObject(range) || !isText(range.base) || !isText(range.head)) {
        err(`backfill.${id}: must be {base, head} with non-empty strings`);
      }
    }
    if (isTextList(m.done) && isTextList(m.reviewed)) {
      for (const id of m.done) {
        if (!m.reviewed.includes(id) && !(id in backfill)) {
          err(`backfill: missing an entry for task ${id} (done but not reviewed)`);
        }
      }
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

// Where a lane's tasks run: its own worktree and run branch. sync is the
// feature branch the lane fast-forwards to before implementing (it holds the
// prelude commits made after setup created the lane branch).
function laneWhere(m, lane) {
  return {
    dir: `${m.repo.worktree_root}/lane-${lane.id}`,
    branch: `pl-${m.run_id}-${lane.id}`,
    lane: lane.id,
    sync: m.repo.branch,
  };
}

// The checkout of the feature branch: the main checkout in git mode; in
// shadow mode a worktree of the shadow repo (the project folder itself is
// never written during a run).
function featureDir(m) {
  return m.repo.mode === 'shadow' ? `${m.repo.worktree_root}/feature` : m.repo.root;
}

// Where prelude and join tasks run, with their ledger lane.
function featureWhere(m, ledgerLane) {
  return { dir: featureDir(m), branch: m.repo.branch, lane: ledgerLane };
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

// One command group for a ledger lane (null: project commands only);
// lane_commands override per group.
function commandList(m, laneId, name) {
  const own = (laneId !== null && m.lane_commands && m.lane_commands[laneId]) || {};
  const list = own[name] || m.commands[name] || [];
  return list.length > 0 ? list.join(' ; ') : '(none)';
}

// Project commands for a ledger lane.
function commandsText(m, laneId) {
  return ['setup', 'test', 'lint', 'build'].map((name) => `- ${name}: ${commandList(m, laneId, name)}`).join('\n');
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
  if (where.sync) {
    parts.push('', [
      'Before anything else, bring this worktree up to date with the feature branch (it holds the prelude',
      `commits): git -C ${shellQuote(where.dir)} merge --ff-only ${shellQuote(where.sync)}`,
      'An already up to date result is fine; if the fast-forward fails, report blocked. Your base is HEAD',
      'after this step.',
    ].join('\n'));
  }
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
// resume ({base, head}, optional) is a task committed in an earlier run but
// not reviewed: implement is skipped and the loop starts with its review.
async function runTask(m, task, where, io = { agent, log }, resume = null) {
  const phaseName = lanePhase(m, where.lane);
  const standard = tierSettings('standard');
  let tierUsed = task.tier;
  let base = null;
  let head = null;
  let rounds = 0;
  let changesSeen = 0;
  let latest = null;
  let verdict = null;
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

  // Escalate a light task: rerun implement at standard from the current
  // head with the open findings, then review the whole task range again.
  const rerunAtStandard = async (reason, findings) => {
    escalate(reason);
    const blockedWhy = await implement({ reason, findings });
    if (blockedWhy !== null) return blockedWhy;
    verdict = await review();
    return null;
  };

  let why = null;
  if (resume) {
    base = resume.base;
    head = resume.head;
    latest = { status: 'done', base, head, tests: '(committed in an earlier run)', notes: '' };
  } else {
    why = await implement(null);
    if (why !== null) return result('blocked', why);
  }

  verdict = await review();
  for (;;) {
    if (!verdict || (verdict.verdict !== 'approve' && verdict.verdict !== 'changes')) {
      return result('blocked', `no result from ${task.id} ${reviewLabel}`);
    }
    if (verdict.verdict === 'approve') break;
    changesSeen += 1;
    const findings = verdict.findings;
    if (changesSeen === 2 && tierUsed === 'light') {
      why = await rerunAtStandard('review requested changes twice', findings);
      if (why !== null) return result('blocked', why);
      continue;
    }
    if (rounds >= m.limits.review_rounds) return result('blocked', 'review_rounds');
    rounds += 1;
    const fixLabel = `fix ${rounds}`;
    const fix = await call(fixLabel, fixPrompt(m, task, where, findings, latest),
      tierSettings(tierUsed), implementSchema());
    why = failure(fix, `${task.id} ${fixLabel}`);
    if (why !== null && tierUsed === 'light') {
      why = await rerunAtStandard(why, findings);
      if (why !== null) return result('blocked', why);
      continue;
    }
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

// What a run does with a task: 'skip' (done and reviewed), 'review'
// (done, not reviewed: backfill review first), or 'run'.
function taskState(m, id) {
  if (!m.done.includes(id)) return 'run';
  return m.reviewed.includes(id) ? 'skip' : 'review';
}

// Tasks of a group (prelude, a lane, join) that still need an agent.
function hasWork(m, tasks) {
  return tasks.some((t) => taskState(m, t.id) !== 'skip');
}

// Run tasks in order at where; skip done-and-reviewed tasks, review
// done-only tasks on their backfill range first; stop at the first task
// that is not done. Returns {results, stopped:reason|null}.
async function runTaskList(m, tasks, where, io, name) {
  const results = [];
  for (const task of tasks) {
    const state = taskState(m, task.id);
    const range = (m.backfill || {})[task.id];
    if (state === 'skip') {
      results.push({
        task: task.id, status: 'skipped', base: range ? range.base : null, head: range ? range.head : null,
        rounds: null, tier_used: null, notes: '',
      });
      continue;
    }
    const r = state === 'review' && !range
      ? { task: task.id, status: 'blocked', base: null, head: null, rounds: 0, tier_used: task.tier, notes: 'done but not reviewed, and no backfill commits' }
      : await runTask(m, task, where, io, state === 'review' ? range : null);
    results.push(r);
    if (r.status !== 'done') {
      io.log(`${name}: stopped at ${task.id} (${r.notes})`);
      return { results, stopped: r.notes };
    }
  }
  return { results, stopped: null };
}

// Run a lane's tasks in order in its worktree; stop at the first task that
// is not done. Returns {lane, results, stopped:reason|null}.
async function runLane(m, lane, io = { agent, log }) {
  const r = await runTaskList(m, lane.tasks, laneWhere(m, lane), io, lane.name);
  return { lane: lane.id, ...r };
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

// ---- Run phases: setup, pre-flight, integration, E2E, final review ----
//
// Phase agents act on the repo only through git commands named in their
// prompts; the script itself never touches files or runs commands.

// git invocation that administers branches and worktrees for the run.
function gitAdmin(m) {
  return m.repo.mode === 'shadow'
    ? `git --git-dir=${shellQuote(m.repo.git_dir)}`
    : `git -C ${shellQuote(m.repo.root)}`;
}

// Rules every phase agent gets.
function phaseRules(m) {
  return [
    `Commit rules (follow exactly): ${m.commit_rules}`,
    'All files you write are plain ASCII. Never commit anything under .superpowers/.',
    `Never push, open pull requests, merge into ${m.repo.base_ref}, or copy work back to the project folder.`,
  ].join('\n');
}

function taskLines(tasks) {
  if (tasks.length === 0) return '  (none)';
  return tasks.map((t) => `  - ${t.id}: ${t.title} [files: ${t.files.join(', ')}]`).join('\n');
}

function layoutText(m) {
  return [
    'Prelude (feature branch, before lanes):',
    taskLines(m.prelude),
    ...m.lanes.map((l) => `Lane ${l.id} (${l.name}):\n${taskLines(l.tasks)}`),
    'Join (merged branch, after integration):',
    taskLines(m.join),
  ].join('\n');
}

function statusSchema() {
  return {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['done', 'failed'] },
      notes: { type: 'string' },
    },
    required: ['status', 'notes'],
  };
}

function setupSchema() {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      discarded: { type: 'array', items: { type: 'string' } },
      worktrees: { type: 'array', items: { type: 'string' } },
      notes: { type: 'string' },
    },
    required: ['ok', 'discarded', 'worktrees', 'notes'],
  };
}

function preflightSchema() {
  return {
    type: 'object',
    properties: {
      conflicts: { type: 'array', items: { type: 'string' } },
      rulings: { type: 'array', items: { type: 'string' } },
    },
    required: ['conflicts', 'rulings'],
  };
}

function e2eSchema() {
  return {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            item: { type: 'string' },
            result: { type: 'string', enum: ['PASS', 'FAIL'] },
            evidence: { type: 'string' },
          },
          required: ['item', 'result', 'evidence'],
        },
      },
    },
    required: ['items'],
  };
}

function finalReviewSchema() {
  const review = reviewSchema();
  return {
    type: 'object',
    properties: { findings: review.properties.findings, cannot_verify: review.properties.cannot_verify },
    required: ['findings', 'cannot_verify'],
  };
}

function finalFixSchema() {
  const impl = implementSchema();
  return {
    type: 'object',
    properties: {
      ...impl.properties,
      declined: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            file: { type: 'string' },
            line: { type: 'integer' },
            issue: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['file', 'line', 'issue', 'reason'],
        },
      },
    },
    required: [...impl.required, 'declined'],
  };
}

function finalReReviewSchema() {
  return {
    type: 'object',
    properties: { findings: reviewSchema().properties.findings },
    required: ['findings'],
  };
}

function setupPrompt(m) {
  const admin = gitAdmin(m);
  const q = shellQuote;
  const branch = q(m.repo.branch);
  const feature = m.repo.mode === 'shadow' ? [
    `Shadow mode: the project folder ${m.repo.root} is not a git repo; the shadow repo ${m.repo.git_dir}`,
    'and its baseline already exist. Never modify the project folder.',
    `1. Create the feature branch if it does not exist: ${admin} branch ${branch} ${q(m.repo.base_ref)}`,
    `   Feature worktree ${q(featureDir(m))}: if it does not exist, ${admin} worktree add ${q(featureDir(m))} ${branch};`,
    '   if it exists it must be on that branch.',
  ] : [
    `Git mode: the main checkout is ${m.repo.root}.`,
    `1. git -C ${q(m.repo.root)} status --porcelain must print nothing; otherwise return ok false listing`,
    '   the changes (never discard work in the main checkout).',
    `   Create the feature branch if it does not exist: ${admin} branch ${branch} ${q(m.repo.base_ref)}`,
    `   Then check it out: git -C ${q(m.repo.root)} switch ${branch}`,
  ];
  const lanes = m.lanes.map((lane) => {
    const w = laneWhere(m, lane);
    const note = lane.setup_note ? `\n     Note: ${lane.setup_note}` : '';
    return `   - lane ${lane.id}: worktree ${q(w.dir)} on branch ${q(w.branch)}${note}`;
  });
  const setupCmds = [`   - ${featureDir(m)}: ${commandList(m, null, 'setup')}`];
  for (const lane of m.lanes) {
    setupCmds.push(`   - ${laneWhere(m, lane).dir}: ${commandList(m, lane.id, 'setup')}`);
  }
  return [
    `You are the setup agent for parallel-lanes run ${m.run_id}.`,
    'Stop at the first step that fails and return ok false with the reason in notes.',
    '',
    ...feature,
    `2. ${admin} worktree prune (it only drops records of worktrees whose directory is gone).`,
    '3. Lane worktrees (create or reuse):',
    ...lanes,
    '   For each: if the directory exists as a worktree on its branch, reuse it: list its uncommitted changes',
    '   with git -C <worktree> status --porcelain, add each line to discarded as "<worktree>: <line>", then',
    '   discard them with git -C <worktree> reset --hard and git -C <worktree> clean -fd (ignored scratch',
    `   stays). Else if the branch exists: ${admin} worktree add <worktree> <branch>.`,
    `   Else: ${admin} worktree add -b <branch> <worktree> ${branch}`,
    '   Do not remove any worktree or delete any branch.',
    '4. Run the setup commands in each checkout (from that directory):',
    ...setupCmds,
    '',
    phaseRules(m),
    '',
    'Return ok (true only when every step succeeded), discarded (the listed changes), worktrees (the paths',
    'ready for work), and notes.',
  ].join('\n');
}

function preflightPrompt(m) {
  return [
    `You are the pre-flight reviewer for parallel-lanes run ${m.run_id}. You are read-only: do not modify any`,
    'file, branch, or worktree.',
    `Plan: ${m.plan}`,
    `Spec: ${m.spec === null ? '(none)' : m.spec}`,
    '',
    'Run layout:',
    layoutText(m),
    '',
    'Check:',
    '1. Every task id above has a "Task <ID>:" heading in the plan.',
    '2. The plan against the spec: contradictions, and defects the plan mandates (instructions that are wrong',
    '   or cannot work as written).',
    '3. Cross-lane code dependencies: a lane task that needs code another lane writes (beyond a contract the',
    '   plan defines) must be in join.',
    'Report serious problems (implementers would build the wrong thing, or a check above fails) as conflicts,',
    'one sentence each naming the tasks and plan or spec sections. Settle minor ambiguities yourself and report',
    'each as a ruling in the form "Ruling: decision - why - cost if wrong".',
    '',
    phaseRules(m),
  ].join('\n');
}

function integratePrompt(m) {
  const q = shellQuote;
  const dir = q(featureDir(m));
  const admin = gitAdmin(m);
  const merges = m.lanes.map((lane) =>
    `   git -C ${dir} merge --no-ff -m <message> ${q(laneWhere(m, lane).branch)}`);
  const overrides = m.lanes
    .filter((lane) => m.lane_commands && m.lane_commands[lane.id])
    .map((lane) => `Lane ${lane.id} commands (with its overrides; run these too):\n${commandsText(m, lane.id)}`);
  const cleanup = m.lanes.map((lane) => {
    const w = laneWhere(m, lane);
    return `   - ${q(w.dir)}: if git -C ${q(w.dir)} status --porcelain prints nothing, ` +
      `${admin} worktree remove ${q(w.dir)} then ${admin} branch -d ${q(w.branch)}`;
  });
  return [
    `You are the integration agent for parallel-lanes run ${m.run_id}.`,
    `Work in ${featureDir(m)} on the feature branch ${m.repo.branch}; do not switch branches.`,
    'Return status failed with the reason in notes at the first step that fails.',
    '',
    `1. git -C ${dir} status --porcelain must print nothing.`,
    '2. Merge each lane branch, in this order, with a merge commit whose message follows the commit rules:',
    ...merges,
    '   A branch that is already merged reports already up to date; that is fine. On a conflict, resolve it',
    '   keeping the intent of both lanes (read the plan tasks that touched the file) and commit the merge; if',
    '   you cannot resolve it with confidence, run git merge --abort and fail naming the files.',
    '3. From a clean tree, rerun setup and then every command:',
    commandsText(m, null),
    ...overrides,
    '   Fix only small, obvious integration breakage (commit it per the commit rules); otherwise fail.',
    `4. Committed scratch: git -C ${dir} diff --name-only ${q(`${m.repo.base_ref}...${m.repo.branch}`)}`,
    '   must list no path under .superpowers/; if it does, fail listing them (do not rewrite history).',
    '5. Only when steps 1-4 passed, clean up each lane:',
    ...cleanup,
    '   Leave a worktree with uncommitted files (and its branch) in place and list it in notes; never',
    '   force a removal or a branch deletion.',
    '',
    `Plan: ${m.plan}`,
    phaseRules(m),
    '',
    'Return status done or failed, and notes (merges, conflicts resolved, command results, cleanup).',
  ].join('\n');
}

function postIntegratePrompt(m) {
  return [
    `You are the post-integration agent for parallel-lanes run ${m.run_id}.`,
    `The lanes are merged into ${m.repo.branch} in ${featureDir(m)}; work there and do not switch branches.`,
    'Follow these project instructions:',
    m.hooks.post_integrate,
    '',
    'Change files only if the instructions call for it; commit any change per the commit rules and rerun',
    'the project commands afterwards:',
    commandsText(m, null),
    '',
    `Plan: ${m.plan}`,
    `Spec: ${m.spec === null ? '(none)' : m.spec}`,
    phaseRules(m),
    '',
    'Return status done when the instructions pass, otherwise failed; notes = what you checked and found.',
  ].join('\n');
}

function e2ePrompt(m) {
  return [
    `You are the end-to-end checker for parallel-lanes run ${m.run_id}.`,
    `The integrated code is in ${featureDir(m)} on ${m.repo.branch}.`,
    'Follow these project instructions:',
    m.hooks.e2e,
    '',
    'Rules: use scratch directories only (mktemp -d, outside the checkout and the project; remove them',
    'when done); never change tracked files or commit; stop every server you start before returning and',
    'confirm its port is free.',
    phaseRules(m),
    '',
    'Return items: one {item, result PASS or FAIL, evidence} per checklist item, evidence being the command',
    'and output or observation that decided it.',
  ].join('\n');
}

function finalReviewPrompt(m, lens, e2e) {
  const q = shellQuote;
  const dir = q(featureDir(m));
  const log = `git -C ${dir} log ${q(`${m.repo.base_ref}..${m.repo.branch}`)}`;
  const diff = `git -C ${dir} diff ${q(`${m.repo.base_ref}...${m.repo.branch}`)}`;
  let focus;
  if (lens === 'sp') {
    focus = m.sp_dir === null ? [
      'Built-in instructions (superpowers not found):',
      'Review the whole branch as a senior reviewer: plan and spec compliance across all tasks, integration',
      'between lanes, architecture, test quality, and maintainability.',
    ].join('\n') : [
      `Read and follow ${m.sp_dir}/requesting-code-review/code-reviewer.md as your review instructions for the`,
      "whole branch: what was implemented = the plan's tasks; requirements = the plan and spec; base =",
      `${m.repo.base_ref}; head = ${m.repo.branch}.`,
    ].join('\n');
  } else if (lens === 'security') {
    const flagged = [...m.prelude, ...m.lanes.flatMap((l) => l.tasks), ...m.join].filter((t) => t.security);
    focus = [
      'Security lens: authentication, authorization, crypto, untrusted input, injection, path handling,',
      'secrets, permissions, and unsafe defaults.',
      `Tasks flagged security-sensitive: ${flagged.length > 0 ? flagged.map((t) => t.id).join(', ') : '(none)'}`,
    ].join('\n');
  } else {
    focus = [
      'Correctness lens: logic errors, edge cases, error handling, concurrency, contracts between lanes, and',
      'tests that do not verify real behavior. End-to-end results:',
      e2e === null ? '(no e2e hook)' : JSON.stringify(e2e),
    ].join('\n');
  }
  return [
    `You are a final reviewer for parallel-lanes run ${m.run_id}. You are read-only: never modify the`,
    'checkout, the index, HEAD, or any branch.',
    `Plan: ${m.plan}`,
    `Spec: ${m.spec === null ? '(none)' : m.spec}`,
    `Range: ${m.repo.base_ref}..${m.repo.branch}. Read it with:`,
    `  ${log}`,
    `  ${diff}`,
    '',
    focus,
    '',
    'Also scan every commit message in the range and the whole diff for anything the commit rules forbid,',
    'including AI tool or assistant names, co-author trailers, and comments that reveal AI involvement; report',
    'each as a finding (for a commit message use file "commit <sha>" and line 0).',
    phaseRules(m),
    '',
    'Return findings = [{severity ("critical", "important", or "minor"), file, line (0 when no single line',
    'applies), issue, fix}] and cannot_verify = what you could not verify.',
  ].join('\n');
}

function finalFixPrompt(m, findings) {
  return [
    `You are fixing the final review findings for parallel-lanes run ${m.run_id}.`,
    `Work in ${featureDir(m)} on ${m.repo.branch}; do not switch branches.`,
    'Findings:',
    findingsText(findings),
    '',
    'Fix each finding, or decline it with a reason (only for a false positive or an item outside this',
    "run's scope). Rerun every project command afterwards:",
    commandsText(m, null),
    'Commit your fixes per the commit rules.',
    '',
    `Plan: ${m.plan}`,
    `Spec: ${m.spec === null ? '(none)' : m.spec}`,
    phaseRules(m),
    '',
    implementResultText(),
    'Also return declined = [{file, line, issue, reason}] for each finding you did not fix.',
  ].join('\n');
}

function finalReReviewPrompt(m, base, head, findings) {
  const dir = shellQuote(featureDir(m));
  return [
    `You are re-reviewing the final fixes for parallel-lanes run ${m.run_id} (fix range ${base}..${head}).`,
    'You are read-only: never modify the checkout, the index, HEAD, or any branch.',
    'Read the fix with:',
    `  git -C ${dir} log ${shellQuote(`${base}..${head}`)}`,
    `  git -C ${dir} diff ${shellQuote(`${base}..${head}`)}`,
    'Findings the fix addressed:',
    findingsText(findings),
    '',
    'Verify each one no longer exists (file:line evidence) and check the fix for new critical or important',
    'problems. Do not re-review code the fix did not touch.',
    phaseRules(m),
    '',
    'Return findings = every finding still open plus every new problem, same shape as the list above.',
  ].join('\n');
}

function findingKey(f) {
  return JSON.stringify([f.file, f.line, f.issue]);
}

// Merge the lenses' findings: identical file+line+issue becomes one entry
// listing every lens that reported it, keeping the most severe severity.
// reports: [{lens, findings|null}].
function dedupeFindings(reports) {
  const rank = { critical: 3, important: 2, minor: 1 };
  const merged = [];
  const byKey = new Map();
  for (const { lens, findings } of reports) {
    for (const f of findings || []) {
      const key = findingKey(f);
      const seen = byKey.get(key);
      if (seen === undefined) {
        const entry = { ...f, lenses: [lens] };
        byKey.set(key, entry);
        merged.push(entry);
        continue;
      }
      if (!seen.lenses.includes(lens)) seen.lenses.push(lens);
      if ((rank[f.severity] || 0) > (rank[seen.severity] || 0)) {
        seen.severity = f.severity;
        seen.fix = f.fix;
      }
    }
  }
  return merged;
}

// Final review: three lenses in parallel, one fix agent, one scoped
// re-review. Returns {findings, fixed, declined, cannot_verify}; declined
// entries carry a reason (declined by the fix agent, not fixed, or still
// open after the re-review).
async function runFinalReview(m, e2e, io) {
  const standard = tierSettings('standard');
  const call = (label, prompt, schema) =>
    io.agent(prompt, { label, phase: 'Final review', schema, ...standard });
  const lenses = [['sp', 'superpowers'], ['security', 'security'], ['correctness', 'correctness']];
  const results = await io.parallel(lenses.map(([key]) => () =>
    call(`final review ${key}`, finalReviewPrompt(m, key, e2e), finalReviewSchema())));
  const cannotVerify = [];
  lenses.forEach(([, name], i) => {
    const r = results[i];
    if (!r) cannotVerify.push(`the ${name} review returned no result`);
    else for (const item of r.cannot_verify || []) cannotVerify.push(`${name}: ${item}`);
  });
  const findings = dedupeFindings(lenses.map(([, name], i) =>
    ({ lens: name, findings: results[i] ? results[i].findings : null })));
  const final = { findings, fixed: [], declined: [], cannot_verify: cannotVerify };
  if (findings.length === 0) return final;

  const declineAll = (reason) => {
    final.declined = findings.map((f) => ({ ...f, reason }));
    return final;
  };
  const fix = await call('final fix', finalFixPrompt(m, findings), finalFixSchema());
  if (!fix) return declineAll('no result from final fix');
  if (fix.status !== 'done') return declineAll(`final fix blocked: ${fix.notes}`);
  const declinedKeys = new Set((fix.declined || []).map(findingKey));
  final.declined = (fix.declined || []).map((d) => {
    const f = findings.find((x) => findingKey(x) === findingKey(d));
    return { ...(f || d), reason: d.reason };
  });
  const attempted = findings.filter((f) => !declinedKeys.has(findingKey(f)));
  if (attempted.length === 0) return final;
  if (fix.head === fix.base) {
    for (const f of attempted) final.declined.push({ ...f, reason: 'final fix made no commits' });
    return final;
  }
  const rr = await call('final re-review', finalReReviewPrompt(m, fix.base, fix.head, attempted),
    finalReReviewSchema());
  if (!rr) {
    for (const f of attempted) final.declined.push({ ...f, reason: 'no result from final re-review' });
    return final;
  }
  const openKeys = new Set(rr.findings.map(findingKey));
  final.fixed = attempted.filter((f) => !openKeys.has(findingKey(f)));
  for (const f of rr.findings) final.declined.push({ ...f, reason: 'still open after the final re-review' });
  return final;
}

// The whole run. io = {agent, log, phase, parallel}. Returns the report:
// {status:'complete'|'stopped'|'preflight_conflicts'|'invalid', run_id,
//  tasks:{<id>:{status, rounds, tier_used, commits:[base,head]|null, notes}},
//  stopped_lanes:[{lane, task, reason}], preflight:{conflicts, rulings},
//  integrate:{status, notes, post_integrate}, e2e:{items}|null,
//  final:{findings, fixed, declined, cannot_verify}, agents_spawned,
//  reason (stopped runs only), errors (invalid only)}.
// Task status is done, blocked, skipped (done and reviewed earlier), or
// not_run.
async function runAll(m, io) {
  const errors = validateManifest(m);
  if (errors.length > 0) {
    const runId = m !== null && typeof m === 'object' && typeof m.run_id === 'string' ? m.run_id : null;
    return {
      status: 'invalid', run_id: runId, errors, tasks: {}, stopped_lanes: [], preflight: null,
      integrate: null, e2e: null, final: null, agents_spawned: 0,
    };
  }

  let spawned = 0;
  const counted = {
    ...io,
    agent: (prompt, opts) => {
      spawned += 1;
      return io.agent(prompt, opts);
    },
  };
  const standard = tierSettings('standard');
  const call = (label, phaseName, prompt, schema) =>
    counted.agent(prompt, { label, phase: phaseName, schema, ...standard });

  const tasks = {};
  for (const t of [...m.prelude, ...m.lanes.flatMap((l) => l.tasks), ...m.join]) {
    const range = taskState(m, t.id) === 'skip' ? (m.backfill || {})[t.id] : null;
    tasks[t.id] = {
      status: taskState(m, t.id) === 'skip' ? 'skipped' : 'not_run',
      rounds: null,
      tier_used: null,
      commits: range ? [range.base, range.head] : null,
      notes: '',
    };
  }
  const record = (results) => {
    for (const r of results) {
      tasks[r.task] = {
        status: r.status,
        rounds: r.rounds,
        tier_used: r.tier_used,
        commits: r.base === null || r.base === undefined ? null : [r.base, r.head],
        notes: r.notes,
      };
    }
  };
  const stoppedLanes = [];
  const stopAt = (lane, list) => {
    const last = list.results[list.results.length - 1];
    stoppedLanes.push({ lane, task: last && last.status !== 'done' ? last.task : null, reason: list.stopped });
  };
  let preflight = null;
  let integrate = null;
  let e2e = null;
  let final = null;
  const report = (status, reason = null) => ({
    status,
    run_id: m.run_id,
    tasks,
    stopped_lanes: stoppedLanes,
    preflight,
    integrate,
    e2e,
    final,
    agents_spawned: spawned,
    ...(reason === null ? {} : { reason }),
  });

  const planned = planAgents(m);
  if (m.done.length > 0) {
    io.log(`parallel-lanes: resuming run ${m.run_id}: ${m.done.length} tasks already committed`);
  } else {
    const lanesWithWork = new Set(planned.filter((a) => a.lane !== null).map((a) => a.lane)).size;
    io.log(`parallel-lanes: launching run ${m.run_id}: ${lanesWithWork} lanes, ${planned.length} agents`);
  }

  io.phase('Setup');
  const setup = await call('setup', 'Setup', setupPrompt(m), setupSchema());
  if (!setup || setup.ok !== true) {
    return report('stopped', `setup failed: ${setup ? setup.notes : 'no result from setup'}`);
  }
  for (const item of setup.discarded || []) io.log(`parallel-lanes: discarded uncommitted change ${item}`);

  io.phase('Pre-flight');
  const pre = await call('pre-flight', 'Pre-flight', preflightPrompt(m), preflightSchema());
  if (!pre) return report('stopped', 'no result from pre-flight');
  preflight = { conflicts: pre.conflicts, rulings: pre.rulings };
  if (pre.conflicts.length > 0) return report('preflight_conflicts');

  io.phase('Prelude');
  const prelude = await runTaskList(m, m.prelude, featureWhere(m, 'prelude'), counted, 'Prelude');
  record(prelude.results);
  if (prelude.stopped !== null) {
    stopAt('prelude', prelude);
    return report('stopped', 'prelude stopped');
  }

  // Lane agents carry their lane's phase; lanes with nothing left are skipped.
  const laneResults = await runLanes(m, m.lanes.filter((l) => hasWork(m, l.tasks)), counted);
  for (const lr of laneResults) {
    record(lr.results);
    if (lr.stopped !== null) stopAt(lr.lane, lr);
  }
  if (stoppedLanes.length > 0) return report('stopped', 'lanes stopped');

  io.phase('Integrate');
  const integ = await call('integrate', 'Integrate', integratePrompt(m), statusSchema());
  integrate = integ
    ? { status: integ.status, notes: integ.notes, post_integrate: null }
    : { status: 'failed', notes: 'no result from integrate', post_integrate: null };
  if (integrate.status !== 'done') return report('stopped', `integration failed: ${integrate.notes}`);
  if (m.hooks.post_integrate) {
    const post = await call('post-integrate', 'Integrate', postIntegratePrompt(m), statusSchema());
    integrate.post_integrate = post
      ? { status: post.status, notes: post.notes }
      : { status: 'failed', notes: 'no result from post-integrate' };
    if (integrate.post_integrate.status !== 'done') {
      return report('stopped', `post-integrate failed: ${integrate.post_integrate.notes}`);
    }
  }

  io.phase('Join');
  const join = await runTaskList(m, m.join, featureWhere(m, 'join'), counted, 'Join');
  record(join.results);
  if (join.stopped !== null) {
    stopAt('join', join);
    return report('stopped', 'join stopped');
  }

  if (m.hooks.e2e) {
    io.phase('E2E');
    const r = await call('e2e', 'E2E', e2ePrompt(m), e2eSchema());
    e2e = r ? { items: r.items } : { items: [], notes: 'no result from e2e' };
  }

  io.phase('Final review');
  final = await runFinalReview(m, e2e, counted);
  return report('complete');
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

return await runAll(args, { agent, log, phase, parallel });
