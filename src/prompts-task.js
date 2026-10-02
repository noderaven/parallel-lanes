// The tasks a unit of work covers. A batch unit (spec D3) is consecutive
// light tasks with the same batch key run by one implementer and one review:
// {id: '<first>-<last>', title, files, tier, security, batch, tasks}. A
// plain task covers itself.
function unitTasks(task) {
  return Array.isArray(task.tasks) ? task.tasks : [task];
}

function isBatch(task) {
  return Array.isArray(task.tasks);
}

// 'batch' for a batch unit, 'task' otherwise.
function unitNoun(task) {
  return isBatch(task) ? 'batch' : 'task';
}

// How prompts name a unit: 'Task <id>: <title>', or for a batch
// 'Batch <first>-<last>: Task <id>: <title>; ...'.
function unitName(task) {
  if (!isBatch(task)) return `Task ${task.id}: ${task.title}`;
  return `Batch ${task.id}: ${task.tasks.map((t) => `Task ${t.id}: ${t.title}`).join('; ')}`;
}

// The ledger command for one event, for every task of a unit, as indented
// prompt lines. A batch's events are per task (its commits are attributed to
// the batch range).
function ledgerLines(m, task, where, entry) {
  return unitTasks(task).map((t) => `  ${ledgerCommand(m, where.lane, { task: t.id, ...entry }, where.dir)}`);
}

// The [BRIEF_FILE] a superpowers prompt is given: the task's brief, or for a
// batch the briefs taskContext lists.
function briefRef(m, task) {
  return isBatch(task) ? 'the task briefs listed below (one per task, in order)' : taskFiles(m, task).brief;
}

// What a batch agent is told about the batch, or nothing for a plain task.
function batchLines(task) {
  if (!isBatch(task)) return [];
  const ids = task.tasks.map((t) => t.id).join(', ');
  return [
    `This is a batch of ${task.tasks.length} tasks (${ids}) run as one unit: one implementer, one review over the`,
    'combined range, one report file. Its briefs are listed below, one per task. The tasks are implemented in',
    'that order, one commit per task with the message its brief gives; every ledger event is recorded for each',
    'task.',
  ];
}

// The exact ledger append command for one event. dir is the checkout of
// the agent that runs it (where.dir for task agents, featureDir(m) for phase
// agents and lane _run events): like every provided command, it starts there.
function ledgerCommand(m, laneId, entry, dir) {
  if (!present(dir)) throw new Error('ledgerCommand: dir (the agent checkout) is required');
  const ledger = `${m.skill_dir}/scripts/ledger`;
  return `cd ${shellQuote(dir)} && python3 ${shellQuote(ledger)} append ${shellQuote(m.repo.ledger_dir)} ` +
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

// Shared context every task agent gets. guidance (optional) is
// {notes, amendments}: notes are decided on the user's behalf in this run (an
// adjudicator answer, or a note an unblocked task carries to the next one);
// amendments are adjudicator rulings that amend the task's brief for this run.
function taskContext(m, task, where, guidance = null) {
  const files = taskFiles(m, task);
  const tasks = unitTasks(task);
  const briefCommand = (t) => `cd ${shellQuote(where.dir)} && python3 ` +
    `${shellQuote(`${m.skill_dir}/scripts/task-brief`)} ${shellQuote(m.plan)} ${shellQuote(t.id)} ` +
    `${shellQuote(taskFiles(m, t).brief)}`;
  const userNote = (t) => m.notes && m.notes[t.id];
  // A batch records its rulings under its first task.
  const ruling = ledgerCommand(m, where.lane,
    { task: tasks[0].id, event: 'ruling', text: 'Ruling: <decision> - <why> - <cost if wrong>' }, where.dir);
  const runNotes = (guidance && guidance.notes) || [];
  const amendments = (guidance && guidance.amendments) || [];
  const briefs = isBatch(task) ? [
    'Task briefs, one per task. Before reading each, generate it from the current plan with its command (it',
    'overwrites any older copy, so plan fixes made since an earlier attempt reach you):',
    ...tasks.flatMap((t) => [`- Task ${t.id}: ${taskFiles(m, t).brief}`, `  ${briefCommand(t)}`]),
    ...tasks.filter(userNote).map((t) =>
      `The user's answer for task ${t.id} (follow it where it settles a question): ${userNote(t)}`),
  ] : [
    `Task brief: ${files.brief}. Before reading it, generate it from the current plan with this command (it`,
    'overwrites any older copy, so plan fixes made since an earlier attempt reach you):',
    `  ${briefCommand(task)}`,
    ...(userNote(task)
      ? [`The user's answer for this task (follow it where it settles a question): ${userNote(task)}`] : []),
  ];
  return [
    unitName(task),
    `Plan: ${m.plan}`,
    `Spec: ${m.spec === null ? '(none)' : m.spec}`,
    `Worktree: ${where.dir} (branch ${where.branch}). Work only there; do not switch branches.`,
    checkoutRules(where.dir, where.branch),
    ...briefs,
    ...runNotes.map((n) =>
      `A note decided on the user's behalf for this ${unitNoun(task)} (follow it where it settles a question): ${n}`),
    ...amendments.map((a) => (isBatch(task)
      ? `Amendment to the batch's task briefs for this run (it overrides the briefs where they differ): ${a}`
      : `Amendment to the task brief for this run (it overrides the brief where they differ): ${a}`)),
    `Implementer report file: ${files.report}`,
    '',
    'Project commands (run from the worktree):',
    commandsText(m, where.lane),
    '',
    `Commit rules (follow exactly): ${m.commit_rules}`,
    'All files you write are plain ASCII. Never commit anything under .superpowers/.',
    'Never push, open pull requests, merge into the base branch, or copy work back to the project.',
    agentRules(),
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
    `  cd ${dir} && mkdir -p ${shellQuote(reviews)} && bash ${shellQuote(script)} ` +
      `${shellQuote(m.plan)} ${shellQuote(base)} ${shellQuote(head)} ${shellQuote(out)}`,
  ].join('\n');
}

// The structured result an implement, fix, or final-fix agent returns.
// question (task agents only) offers the "question" status. from (optional)
// is the commit the agent's work starts at, which changed_lines counts from;
// without it the wording points at the starting commit the prompt names.
function implementResultText(dir, question = false, from = null) {
  const start = present(from) ? shellQuote(from) : '<start>';
  return [
    `Return a structured result: status "done" or "blocked"; head = git -C ${shellQuote(dir)} rev-parse HEAD`,
    'after your last commit; tests = the commands you ran and their outcome; notes = rulings, concerns, or the',
    'reason you are blocked. That result replaces any status reply format named in the instructions above.',
    'When you committed, also return changed_lines = the lines added plus the lines removed (insertions plus',
    `deletions) that git -C ${shellQuote(dir)} diff --shortstat ${start} HEAD prints` +
      (present(from) ? '.' : ', where <start> is the commit this prompt says the branch was at when you started.'),
    ...(question ? [
      'When you need a question answered before you can continue correctly, return status "question" instead,',
      'with question = the question (and head as above): do not guess. It is answered and the task reruns.',
    ] : []),
  ].join('\n');
}

function reviewResultText(m, task, where, rounds) {
  return [
    'You are read-only: never modify the worktree, the index, HEAD, or any branch. Writing the task brief, the',
    'review package, and the ledger line (all outside the repo) is allowed.',
    'Also check every commit message in the range against the commit rules.',
    'Report a commit message that breaks the commit rules as a minor finding (file "commit <sha>", line 0):',
    'history is never rewritten, so it cannot hold up the task; it is reported to the user.',
    'Return a structured result: verdict "changes" when the spec is not met or any critical or important',
    'finding exists, otherwise "approve" (minor findings may accompany approve); findings = [{severity',
    '("critical", "important", or "minor"), file, line (0 when no single line applies), issue, fix}];',
    'cannot_verify = requirements you could not verify from the diff. That result replaces the output format',
    'named in the instructions above.',
    isBatch(task)
      ? 'Only when your verdict is approve, record it for every task of the batch with:'
      : 'Only when your verdict is approve, record it with:',
    ...ledgerLines(m, task, where, { event: 'reviewed', rounds }),
  ].join('\n');
}

// Prompt for an implementer. base is the task base the script owns (the
// previous task's head, or the feature tip); retry (optional) is {reason,
// findings} when a previous attempt in this run blocked or failed review;
// guidance (optional) is taskContext's.
function implementPrompt(m, task, where, base, retry = null, guidance = null) {
  const files = taskFiles(m, task);
  const sdd = m.sp_dir === null ? null : `${m.sp_dir}/subagent-driven-development`;
  const noun = unitNoun(task);
  const batch = isBatch(task);
  const parts = [
    `You are implementing ${unitName(task)}`,
    ...batchLines(task),
    '',
    sdd === null ? fallbackImplementer() : [
      `Read and follow ${sdd}/implementer-prompt.md: the prompt block inside its fence is your instructions,`,
      `with Task: ${unitName(task)}; [BRIEF_FILE]: ${briefRef(m, task)}; [directory]: ${where.dir};`,
      `[REPORT_FILE]: ${files.report}. You cannot ask questions mid-task: return status "question" with the`,
      'question instead (see the structured result below).',
    ].join('\n'),
    '',
    taskContext(m, task, where, guidance),
  ];
  if (where.sync) {
    parts.push('', [
      'Before anything else, bring this worktree up to date with the feature branch (it holds the prelude',
      `commits): git -C ${shellQuote(where.dir)} merge --ff-only ${shellQuote(where.sync)}`,
      'An already up to date result is fine; if the fast-forward fails, report blocked.',
    ].join('\n'));
  }
  parts.push('', [
    `Task base: ${base}. Everything on this branch after it is this ${noun}'s work, and its review covers`,
    `${base}..HEAD. HEAD may already hold commits from an earlier attempt at this ${noun}: start from the current`,
    'HEAD, keep what is right, and fix what is not.',
  ].join('\n'));
  if (retry) {
    parts.push('', [
      `A previous attempt at this ${noun} did not succeed: ${retry.reason}`,
      ...(retry.findings ? ['Open review findings:', findingsText(retry.findings)] : []),
    ].join('\n'));
  }
  parts.push('', [
    batch
      ? 'After committing, record your commits for every task of the batch (each command lists every sha you\n' +
        'made for this batch, oldest first) with:'
      : 'After committing, record your commits (every sha you made for this task, oldest first) with:',
    ...ledgerLines(m, task, where, { event: 'committed', commits: ['<sha>', '<sha>'] }),
    batch ? 'If you are blocked, record it for every task of the batch with:' : 'If you are blocked, record it with:',
    ...ledgerLines(m, task, where, { event: 'blocked', reason: '<reason>' }),
  ].join('\n'), '', implementResultText(where.dir, true, base));
  return parts.join('\n');
}

// Prompt for the first (full) review of a task's base..head range.
function reviewPrompt(m, task, where, base, head, rounds = 0, guidance = null) {
  const files = taskFiles(m, task);
  const sdd = m.sp_dir === null ? null : `${m.sp_dir}/subagent-driven-development`;
  return [
    `You are reviewing ${unitName(task)} (range ${base}..${head}).`,
    ...batchLines(task),
    '',
    sdd === null ? fallbackReviewer() : [
      `Read and follow ${sdd}/task-reviewer-prompt.md: the prompt block inside its fence is your instructions,`,
      `with [BRIEF_FILE]: ${briefRef(m, task)}; [GLOBAL_CONSTRAINTS]: the Global Constraints section of the plan and`,
      `the commit rules below; [REPORT_FILE]: ${files.report}; [BASE_SHA]: ${base}; [HEAD_SHA]: ${head};`,
      '[DIFF_FILE]: the path review-package prints (below).',
    ].join('\n'),
    '',
    diffSteps(m, task, where, base, head),
    '',
    taskContext(m, task, where, guidance),
    '',
    reviewResultText(m, task, where, rounds),
  ].join('\n');
}

// Prompt for a fix agent. report is the latest implement or fix result;
// head is the branch head the fix builds on.
function fixPrompt(m, task, where, findings, report, head, guidance = null) {
  const files = taskFiles(m, task);
  const sdd = m.sp_dir === null ? null : `${m.sp_dir}/subagent-driven-development`;
  const batch = isBatch(task);
  return [
    `You are fixing review findings for ${unitName(task)}`,
    ...batchLines(task),
    '',
    sdd === null ? fallbackImplementer() : [
      `Read and follow ${sdd}/implementer-prompt.md: the prompt block inside its fence is your instructions,`,
      `with Task: ${unitName(task)}; [BRIEF_FILE]: ${briefRef(m, task)}; [directory]: ${where.dir};`,
      `[REPORT_FILE]: ${files.report}. You are at its After Review Findings step.`,
    ].join('\n'),
    '',
    `The branch is at ${head}. Fix these findings, rerun the tests that cover the amended code, commit on top of`,
    `it, and append a fix report (what changed, covering tests, command, output) to ${files.report}.`,
    'Findings:',
    findingsText(findings),
    '',
    'Latest implementer result:',
    JSON.stringify(report),
    '',
    taskContext(m, task, where, guidance),
    '',
    batch
      ? 'After committing, record your fix commits (oldest first) for every task of the batch with:'
      : 'After committing, record your fix commits (oldest first) with:',
    ...ledgerLines(m, task, where, { event: 'committed', commits: ['<sha>', '<sha>'] }),
    batch ? 'If you are blocked, record it for every task of the batch with:' : 'If you are blocked, record it with:',
    ...ledgerLines(m, task, where, { event: 'blocked', reason: '<reason>' }),
    '',
    implementResultText(where.dir, true, head),
  ].join('\n');
}

// Prompt for a scoped re-review of a fix range. round is the fix round.
function reReviewPrompt(m, task, where, base, head, findings, round = 1, guidance = null) {
  const files = taskFiles(m, task);
  const sdd = m.sp_dir === null ? null : `${m.sp_dir}/subagent-driven-development`;
  return [
    `You are re-reviewing fix round ${round} of ${unitName(task)} (fix range ${base}..${head}).`,
    ...batchLines(task),
    '',
    sdd === null ? fallbackReReviewer() : [
      `Read and follow ${sdd}/re-review-prompt.md: the prompt block inside its fence is your instructions,`,
      `with [BRIEF_FILE]: ${briefRef(m, task)}; [FINDINGS]: the findings below; [REPORT_FILE]: ${files.report};`,
      `[FIX_BASE_SHA]: ${base}; [HEAD_SHA]: ${head}; [DIFF_FILE]: the path review-package prints (below).`,
    ].join('\n'),
    '',
    'Findings under verification:',
    findingsText(findings),
    '',
    diffSteps(m, task, where, base, head),
    '',
    taskContext(m, task, where, guidance),
    '',
    'List every finding still open, and any new critical or important problem the fix introduced, as findings.',
    reviewResultText(m, task, where, round),
  ].join('\n');
}

function implementSchema() {
  return {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['done', 'blocked', 'question'] },
      head: { type: 'string' },
      tests: { type: 'string' },
      notes: { type: 'string' },
      question: { type: 'string' },
      changed_lines: { type: 'integer' },
    },
    required: ['status', 'head', 'tests', 'notes'],
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
