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

// The note for a finding with file "start-task" (reviewStartFailure): the
// reviewer's start command failed, which no code change in the worktree can
// fix. Empty when no finding has that file.
function startFindingNote(findings) {
  if (!Array.isArray(findings) || !findings.some((f) => f && f.file === 'start-task')) return [];
  return ['A finding with file "start-task" is the reviewer\'s start command failing (a setup problem, not the',
    'code): change no code for it, and when it is the only finding, report blocked quoting it.'];
}

// Shared context every task agent gets. guidance (optional) is
// {notes, amendments}: notes are decided on the user's behalf in this run (an
// adjudicator answer, or a note an unblocked task carries to the next one);
// amendments are adjudicator rulings that amend the task's brief for this run.
function taskContext(m, task, where, guidance = null) {
  const files = taskFiles(m, task);
  const tasks = unitTasks(task);
  const userNote = (t) => m.notes && m.notes[t.id];
  // A batch records its rulings under its first task.
  const ruling = ledgerCommand(m, where.lane,
    { task: tasks[0].id, event: 'ruling', text: 'Ruling: <decision> - <why> - <cost if wrong>' }, where.dir);
  const runNotes = (guidance && guidance.notes) || [];
  const amendments = (guidance && guidance.amendments) || [];
  const briefs = isBatch(task) ? [
    'Task briefs, one per task. The start command in this prompt regenerates each from the current plan and prints it',
    '(it overwrites any older copy, so plan fixes made since an earlier attempt reach you):',
    ...tasks.map((t) => `- Task ${t.id}: ${taskFiles(m, t).brief}`),
    ...tasks.filter(userNote).map((t) =>
      `The user's answer for task ${t.id} (follow it where it settles a question): ${userNote(t)}`),
  ] : [
    `Task brief: ${files.brief}. The start command in this prompt regenerates it from the current plan and prints it`,
    '(it overwrites any older copy, so plan fixes made since an earlier attempt reach you).',
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

// How a reviewer gets the diff for base..head. With superpowers the start
// command builds the review package (startCommand's pkg).
function diffSteps(m, task, where, base, head) {
  const dir = shellQuote(where.dir);
  if (m.sp_dir === null) {
    return [
      'Get the change with:',
      `  git -C ${dir} log --oneline ${shellQuote(`${base}..${head}`)}`,
      `  git -C ${dir} diff ${shellQuote(`${base}..${head}`)}`,
    ].join('\n');
  }
  return '[DIFF_FILE] is the path the start command printed under its "===== review package =====" line.';
}

// The start-task command a task agent runs first: the optional fast-forward
// to the feature branch (opts.sync), every brief of the unit regenerated from
// the current plan and printed, and with opts.pkg = {base, head} and
// superpowers present the review package for base..head.
function startCommand(m, task, where, opts = {}) {
  const sync = opts.sync || null;
  const pkg = opts.pkg || null;
  const parts = [
    `cd ${shellQuote(where.dir)} && python3 ${shellQuote(`${m.skill_dir}/scripts/start-task`)}`,
    shellQuote(where.dir), shellQuote(m.plan),
  ];
  if (present(sync)) parts.push('--sync', shellQuote(sync));
  if (pkg && m.sp_dir !== null) {
    const script = `${m.sp_dir}/subagent-driven-development/scripts/review-package`;
    const out = `${taskFiles(m, task).reviews}/${task.id}-${pkg.base}..${pkg.head}.diff`;
    parts.push('--package', shellQuote(script), shellQuote(pkg.base), shellQuote(pkg.head), shellQuote(out));
  }
  for (const t of unitTasks(task)) parts.push('--brief', shellQuote(t.id), shellQuote(taskFiles(m, t).brief));
  return parts.join(' ');
}

// The "Run this first" block of a task prompt. failure says what a non-zero
// exit means for this agent.
function startBlock(m, task, where, opts, failure) {
  const what = [
    ...(present(opts.sync) ? ['fast-forwards this worktree to the feature branch (it holds the prelude commits)'] : []),
    isBatch(task)
      ? 'regenerates every task brief from the current plan and prints it'
      : 'regenerates the task brief from the current plan and prints it',
    ...(opts.pkg && m.sp_dir !== null ? ['builds the review package'] : []),
  ];
  const files = isBatch(task) ? 'brief files' : 'brief file';
  return [
    `Run this first, as one call: it ${what.join(', then ')}, so you need not read the ${files} separately.`,
    `  ${startCommand(m, task, where, opts)}`,
    `If it exits non-zero, ${failure}`,
  ].join('\n');
}

// The finish-task command an implement or fix agent runs after committing:
// branch check, commit validation against from..HEAD, the committed event for
// every task of the unit, then head and changed_lines. The <sha> placeholders
// are the agent's to fill.
function finishCommand(m, task, where, from) {
  return [
    `cd ${shellQuote(where.dir)} && python3 ${shellQuote(`${m.skill_dir}/scripts/finish-task`)}`,
    shellQuote(where.dir), shellQuote(where.branch), shellQuote(from), shellQuote(m.repo.ledger_dir),
    shellQuote(where.lane),
    ...unitTasks(task).map((t) => `--task ${shellQuote(t.id)}`),
    '--commit <sha> --commit <sha>',
  ].join(' ');
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

// The structured result an implement or fix agent returns: head and
// changed_lines come from finish-task's output. from is the commit the
// agent's work starts at (finish-task counts changed_lines from it).
function taskResultText(dir, from) {
  return [
    'Return a structured result: status "done" or "blocked"; head = the head value finish-task printed after',
    `your last commit (with no commit, head = git -C ${shellQuote(dir)} rev-parse HEAD); tests = the commands you`,
    'ran and their outcome; notes = rulings, concerns, or the reason you are blocked. That result replaces any',
    'status reply format named in the instructions above.',
    `When you committed, also return changed_lines = the changed_lines value finish-task printed (counted from ${from}).`,
    'When you need a question answered before you can continue correctly, return status "question" instead,',
    'with question = the question (and head as above): do not guess. It is answered and the task reruns.',
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

// How an implement or fix prompt introduces its finish-task command.
// shas says which commits it lists.
function finishText(batch, shas) {
  return `After committing, run finish-task once, with one --commit per sha (${shas}); it records the\n` +
    (batch ? 'committed event for every task of the batch' : 'committed event') + ' and prints head and changed_lines:';
}

function finishFailure() {
  return 'A refusal (exit 3) records nothing; only a failed ledger write can leave part of a batch recorded, and a\n' +
    'rerun just repeats those events. On a non-zero exit fix the cause (a wrong sha, the wrong branch) and rerun it,\n' +
    'or report blocked.';
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
    '',
    startBlock(m, task, where, { sync: where.sync || null },
      'stop and report blocked with its message (a failed fast-forward is reported, never forced).'),
  ];
  parts.push('', [
    `Task base: ${base}. Everything on this branch after it is this ${noun}'s work, and its review covers`,
    `${base}..HEAD. HEAD may already hold commits from an earlier attempt at this ${noun}: start from the current`,
    'HEAD, keep what is right, and fix what is not.',
  ].join('\n'));
  if (retry) {
    parts.push('', [
      `A previous attempt at this ${noun} did not succeed: ${retry.reason}`,
      ...(retry.findings
        ? ['Open review findings:', findingsText(retry.findings), ...startFindingNote(retry.findings)] : []),
    ].join('\n'));
  }
  parts.push('', [
    finishText(batch, `every sha you made for this ${noun}, oldest first`),
    `  ${finishCommand(m, task, where, base)}`,
    finishFailure(),
    batch ? 'If you are blocked, record it for every task of the batch with:' : 'If you are blocked, record it with:',
    ...ledgerLines(m, task, where, { event: 'blocked', reason: '<reason>' }),
  ].join('\n'), '', taskResultText(where.dir, base));
  return parts.join('\n');
}

// What a non-zero start-task exit means for a reviewer, who has no blocked
// status: a "changes" verdict, so a failed start never approves. The finding
// names file "start-task", which fixPrompt treats as a setup failure.
function reviewStartFailure() {
  return 'stop and return verdict "changes" with one critical finding (file "start-task", line 0) that quotes its\n' +
    'message, and record no ledger line.';
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
      '[DIFF_FILE]: the review package path the start command prints (below).',
    ].join('\n'),
    '',
    startBlock(m, task, where, { pkg: { base, head } }, reviewStartFailure()),
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
    ...startFindingNote(findings),
    '',
    'Latest implementer result:',
    JSON.stringify(report),
    '',
    taskContext(m, task, where, guidance),
    '',
    startBlock(m, task, where, {}, 'stop and report blocked with its message.'),
    '',
    finishText(batch, 'every fix sha, oldest first'),
    `  ${finishCommand(m, task, where, head)}`,
    finishFailure(),
    batch ? 'If you are blocked, record it for every task of the batch with:' : 'If you are blocked, record it with:',
    ...ledgerLines(m, task, where, { event: 'blocked', reason: '<reason>' }),
    '',
    taskResultText(where.dir, head),
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
      `[FIX_BASE_SHA]: ${base}; [HEAD_SHA]: ${head}; [DIFF_FILE]: the review package path the start command`,
      'prints (below).',
    ].join('\n'),
    '',
    'Findings under verification:',
    findingsText(findings),
    '',
    startBlock(m, task, where, { pkg: { base, head } }, reviewStartFailure()),
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
