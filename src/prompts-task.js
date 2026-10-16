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
  return `cd ${shellQuote(dir)} && ${pythonCommand(m)} ${shellQuote(ledger)} append ${shellQuote(m.repo.ledger_dir)} ` +
    `${shellQuote(laneId)} ${shellQuote(JSON.stringify(entry))}`;
}

// A read-only ledger command (1.6.3: rulings, minors, owners, undeclared),
// started in the agent's checkout dir like every helper command it is given.
function ledgerReadCommand(m, dir, sub, ...args) {
  return `cd ${shellQuote(dir)} && ${pythonCommand(m)} ${shellQuote(`${m.skill_dir}/scripts/ledger`)} ${sub} `
    + `${shellQuote(m.repo.ledger_dir)}${args.map((a) => ` ${a}`).join('')}`;
}

// The lines every agent after the task loop gets: the full rulings print,
// run from dir (the agent's checkout).
function rulingsReadLines(m, dir) {
  return ['Every ruling in force, with its id (a read-only command):', `  ${ledgerReadCommand(m, dir, 'rulings')}`];
}

// The commands of one group for a ledger lane (null: project commands only);
// lane_commands override per group.
function commandGroup(m, laneId, name) {
  const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  const own = (laneId !== null && m.lane_commands && has(m.lane_commands, laneId) && m.lane_commands[laneId]) || {};
  return (has(own, name) && own[name]) || m.commands[name] || [];
}

// One command group as a shell line: joined with &&, so a failing command
// fails the line instead of hiding behind the next one's success.
function commandList(m, laneId, name) {
  const list = commandGroup(m, laneId, name);
  return list.length > 0 ? list.join(' && ') : '(none)';
}

// The final check inventory (spec F3): the project test, lint and build
// commands in group order, then for each lane in manifest order the ones its
// lane_commands overrides add, in group order, as [{group, command}]. A
// {group, command} already listed is not repeated: the same command in the
// same feature checkout is the same check.
function finalChecks(m) {
  const out = [];
  for (const group of ['test', 'lint', 'build']) for (const command of commandGroup(m, null, group)) out.push({ group, command });
  for (const lane of m.lanes || []) {
    for (const group of ['test', 'lint', 'build']) {
      for (const command of commandGroup(m, lane.id, group)) {
        if (!out.some((c) => c.group === group && c.command === command)) out.push({ group, command });
      }
    }
  }
  return out;
}

// The setup commands the final checks need: the project's, then each lane's
// setup override commands not already listed, in manifest order.
function finalSetup(m) {
  const out = [...commandGroup(m, null, 'setup')];
  for (const lane of m.lanes || []) {
    for (const command of commandGroup(m, lane.id, 'setup')) if (!out.includes(command)) out.push(command);
  }
  return out;
}

// The phase a ledger lane's checks run in (run-checks --phase, PL_PHASE):
// prelude and join tasks have their own; a lane's tasks run in lane.
function checksPhase(laneId) {
  return laneId === 'prelude' || laneId === 'join' ? laneId : 'lane';
}

// The scripts/run-checks call that runs each check of a [{group, command}]
// list in dir, separately, and exits non-zero when any one fails. out
// (optional) is the evidence file it writes under the ledger dir:
// resultPath() goes in as given (already quoted), for the path the agent's
// reserve prints. phase (1.6.5) is run-checks' --phase: the commands run
// with PL_PHASE set to it. null for an empty list.
function runChecksCommand(m, dir, checks, out = null, phase = null) {
  if (checks.length === 0) return null;
  const parts = checks.flatMap((c) => ['--cmd', shellQuote(c.group), shellQuote(c.command)]);
  const target = out === resultPath() ? out : shellQuote(out);
  const evidence = out === null ? [] : ['--out', target, '--root', shellQuote(m.repo.ledger_dir)];
  return [`cd ${shellQuote(dir)} && ${pythonCommand(m)} ${shellQuote(`${m.skill_dir}/scripts/run-checks`)}`, shellQuote(dir),
    ...evidence, ...(phase === null ? [] : ['--phase', shellQuote(phase)]), ...parts].join(' ');
}

// Every test, lint and build command of a ledger lane, as [{group, command}]
// (the setup group is not a check).
function laneChecks(m, laneId) {
  return ['test', 'lint', 'build']
    .flatMap((group) => commandGroup(m, laneId, group).map((command) => ({ group, command })));
}

// The checks a widened task runs (spec 4.2): the project's test, lint and
// build commands in group order, then, for a real lane only, that lane's
// lane_commands commands not already listed: finalChecks restricted to the
// project and one lane. A lane whose lane_commands setup differs from the
// project's ran only its own setup in its worktree, so the project's commands
// may not work there: it widens to its own checks (laneChecks), as before
// 1.6.0, and integration still runs every check.
function wideChecks(m, laneId) {
  const own = m.lane_commands && Object.prototype.hasOwnProperty.call(m.lane_commands, laneId)
    ? m.lane_commands[laneId] : null;
  if (own && Object.prototype.hasOwnProperty.call(own, 'setup')
    && JSON.stringify(commandGroup(m, laneId, 'setup')) !== JSON.stringify(commandGroup(m, null, 'setup'))) {
    return laneChecks(m, laneId);
  }
  const out = [];
  for (const group of ['test', 'lint', 'build']) for (const command of commandGroup(m, null, group)) out.push({ group, command });
  if ((m.lanes || []).some((l) => l.id === laneId)) {
    for (const group of ['test', 'lint', 'build']) {
      for (const command of commandGroup(m, laneId, group)) {
        if (!out.some((c) => c.group === group && c.command === command)) out.push({ group, command });
      }
    }
  }
  return out;
}

// The scripts/run-checks call for every test, lint and build command of a
// ledger lane in dir, in phase. null when there is no check command.
function checksCommand(m, laneId, dir, out = null, phase = null) {
  return runChecksCommand(m, dir, laneChecks(m, laneId), out, phase);
}

// What an agent handed a run-checks call is told about its output and logs:
// the call writes beside its reserved ledger file, and the logs stay there
// with the evidence (spec 4.4).
function checksLogLines() {
  return [
    "  Its result is one JSON line: each command's full output is in the file its result names as log, kept with",
    "  the run's evidence. Read the log instead of rerunning a command, and leave the file in place.",
  ];
}

// The placeholder for a check's result file in a start command (spec 4.1):
// the agent replaces <P> with the path await-checks reserve printed, inside
// the quotes, so a path with a space still works. A function, not a
// constant: loadHelpers returns before top-level bindings initialize.
function resultPath() {
  return "'<P>'";
}

// The await-checks reserve call: it creates a fresh, empty result file
// <ledger>/checks/<name>.<n>.json and prints its path. exact (verify): the
// path is <ledger>/checks/<name>.json, emptied again, or busy (exit 4) while
// an earlier writer still holds it.
function reserveCommand(m, name, exact = false) {
  return `${pythonCommand(m)} ${shellQuote(`${m.skill_dir}/scripts/await-checks`)} reserve --ledger `
    + `${shellQuote(m.repo.ledger_dir)} --name ${shellQuote(name)}${exact ? ' --exact' : ''}`;
}

// The await-checks wait call on the reserved result file.
function waitCommand(m) {
  return `${pythonCommand(m)} ${shellQuote(`${m.skill_dir}/scripts/await-checks`)} wait ${resultPath()}`;
}

// The procedure for every check an agent runs, whatever its length (spec
// 4.1): reserve a result file under name (exact: verify's fixed path, with
// the busy case), start start (a check command carrying resultPath()) in the
// background, wait for it, change nothing while it runs, and start once more
// after a stop. stop (optional) says what the agent does after a second
// stop; by default it reports the checks failed. A run that changed the
// checkout is rerun once only, so checks that write files into the checkout
// cannot loop: changed (optional) says what the agent does with the rerun's
// result when it changed the checkout again; by default it keeps that result
// and says so in its notes. Every caller gets the exit-code contract (1.6.2
// spec 4.3): what 75, 124 and a signal mean, then exits (optional lines),
// what this caller does with a failure made only of them; by default
// (fixers, hook agents, long commands) it changes nothing for it and says so.
function procedureLines(m, { name, exact = false, start, stop = null, changed = null, exits = null }) {
  const second = stop === null ? 'report the checks as failed (never as passed), with both outcomes the wait printed'
    + ' in your notes.' : stop;
  const again = changed === null ? 'keep that result (it carries tree_changed true) and say in your notes that'
    + ' the checks themselves change the checkout.' : changed;
  const action = exits === null ? [
    `A check that failed only with such exits is not a defect: ${changeNothing()}`,
    'for it, and say so in your notes.',
  ] : exits;
  return [
    'Run it with this procedure. Every run, a rerun after a fix included, starts with its own reserve and uses',
    'the new path.',
    `1. Reserve a result file (a short call): ${reserveCommand(m, name, exact)}`,
    '   It prints a path. In the start and wait commands below, replace <P> with the path it printed, keeping the',
    "   single quotes around it (write any single quote inside the path as '\\'': close the quotes, an escaped",
    '   quote, reopen them).',
    ...(exact ? [
      '   If reserve exits 4 with status busy, an earlier run still writes that file: run the wait on the file it',
      '   names until the wait no longer exits 4, ignore that report, then reserve again.',
    ] : []),
    "2. Right after reserving, start the check with the Bash tool's run_in_background set to true:",
    `   ${start}`,
    '3. Wait for it in the foreground, with a 600000 ms timeout on the call:',
    `   ${waitCommand(m)}`,
    '   Exit 4 means the check is still running: run the wait again, as often as it takes. Exit 0 (passed), 1',
    "   (failed) or 3 (an error record) prints the check's result, its one JSON line. If the wait also says the",
    '   checkout changed while the checks ran, run them once more, starting with a new reserve. Rerun only once:',
    '   if the checkout changed again on that rerun, do not run the checks a third time;',
    `   ${again}`,
    '4. While a check runs, change nothing in that checkout (no edits, commits or other checks), and never finish',
    '   your turn or return your result.',
    '5. Exit 5 means the check stopped without a result: reserve and start it once more, as above. After a',
    `   second stop, do not start it again: ${second}`,
    'Exit codes in the result: a command that exits 124 timed out, one that exits 75 found the project busy, and',
    'one that exits 128 or above (or a negative code) was killed by a signal.',
    ...action,
  ];
}

// What a fixer or any agent changes for a check that failed only with a
// non-defect exit (1.6.2 spec 4.3): nothing. (A function, not a const: the
// test harness loads helpers without running top-level bindings.)
function changeNothing() {
  return 'do not change code, tests, timeouts or commands';
}

// The general rule for any other long command (spec 4.4): it runs through
// run-checks with the same procedure, under the reserve name long. Task
// prompts (taskContext, with the task's phase) and phase prompts
// (phaseRules) carry it.
function longCheckRuleLines(m, phase = null) {
  const start = `cd 'DIR' && ${pythonCommand(m)} ${shellQuote(`${m.skill_dir}/scripts/run-checks`)} 'DIR' `
    + `--out ${resultPath()} --root ${shellQuote(m.repo.ledger_dir)} `
    + `${phase === null ? '' : `--phase ${shellQuote(phase)} `}--cmd 'GROUP' 'COMMAND'`;
  return [
    'Long commands: any command you expect to run longer than 9 minutes that this prompt does not already hand you',
    'as a check (a wide test filter, a long hook step) runs through run-checks, with DIR the checkout it runs in,',
    'GROUP a label such as test, and COMMAND the command, each single-quoted, writing any single quote inside',
    "COMMAND as '\\'' (close the quotes, an escaped quote, reopen them).",
    ...procedureLines(m, { name: 'long', start }),
  ];
}

// Project commands for a ledger lane; with dir, also the run-checks call that
// runs every check there at once, in phase, with the procedure under the
// reserve name name.
function commandsText(m, laneId, dir = null, name = 'checks', phase = null) {
  const lines = ['setup', 'test', 'lint', 'build'].map((group) => `- ${group}: ${commandList(m, laneId, group)}`);
  const all = dir === null ? null : checksCommand(m, laneId, dir, resultPath(), phase);
  if (all !== null) {
    lines.push("- every check at once (each command's exit status is kept; it exits non-zero when any fails).",
      ...procedureLines(m, { name, start: all }).map((l) => `  ${l}`), ...checksLogLines());
  }
  return lines.join('\n');
}

// The scripts/task-checks call a task's implementer runs once before
// committing (spec 4.2, 4.3), in where.dir for the unit's range from base,
// writing to the result file the agent reserved (--evidence resultPath());
// null when the ledger lane has no test, lint or build command. 1.6.6 (spec
// 4.5): the Files list goes as its fingerprint (task-checks reads the list
// from owners.json), and a wide list equal to the lane list as --wide-as-lane,
// so the command does not grow with the Files list.
function taskChecksCommand(m, task, where, base) {
  const lane = laneChecks(m, where.lane);
  if (lane.length === 0) return null;
  const q = shellQuote;
  const pairs = (flag, checks) => checks.flatMap((c) => [flag, q(c.group), q(c.command)]);
  const entry = taskChecksEntry(m, task, where.lane);
  const declared = declaredFiles(task);
  const wide = wideChecks(m, where.lane);
  return [
    `cd ${q(where.dir)} && ${pythonCommand(m)} ${q(`${m.skill_dir}/scripts/task-checks`)}`, q(where.dir),
    '--base', q(base), '--ledger', q(m.repo.ledger_dir), '--unit', q(task.id), '--evidence', resultPath(),
    '--lane', q(where.lane), '--phase', q(checksPhase(where.lane)),
    ...unitTasks(task).flatMap((t) => ['--task', q(t.id)]),
    ...(declared.length === 0 ? [] : ['--declared-from-owners', q(declaredFingerprint(declared))]),
    ...(Array.isArray(m.widen_paths) ? m.widen_paths : []).flatMap((p) => ['--widen', q(p)]),
    ...commandGroup(m, null, 'test').flatMap((c) => ['--project-test', q(c)]),
    ...(entry === null ? [] : ['--entry', q(entry.id), ...pairs('--targeted', entry.checks)]),
    ...pairs('--lane-cmd', lane),
    ...(JSON.stringify(wide) === JSON.stringify(lane) ? ['--wide-as-lane'] : pairs('--wide-cmd', wide)),
  ].join(' ');
}

// The implementer's task-checks instructions (spec 4.3), with the procedure
// under the reserve name task-<unit id> (spec 4.4); [] when there is no
// task-checks call.
function taskChecksLines(m, task, where, base) {
  const cmd = taskChecksCommand(m, task, where, base);
  if (cmd === null) return [];
  return [
    'Task checks. Before you commit, run the task checks once, with the procedure below. This replaces the',
    "full-suite run the instructions above ask for, and the test-driven-development skill's rule that your",
    'verification is the whole project suite. The full project checks run at integration and at delivery.',
    ...procedureLines(m, {
      name: `task-${task.id}`, start: cmd,
      stop: 'report blocked, with both outcomes the wait printed in your notes.',
      exits: [
        'When the task checks failed only with such exits, that is not a defect:',
        `${changeNothing()} for it, and do not rerun the call to get a pass: report blocked, naming the exits`,
        'and the result file the wait read.',
      ],
    }),
    'If the call fails with an error that names owners.json, report blocked with its message; do not run setup or',
    'pass --declared yourself.',
    'It picks the targeted checks, or the wider ones when your change reaches beyond them, runs them, and records',
    'its choice. While iterating, run only the focused tests for what you change. When the call fails, fix and',
    'rerun it; do not commit with failing checks (report blocked instead). If you know your change reaches code the',
    'targeted checks do not cover (a shared contract, configuration, generated or ignored inputs, or a dependency',
    "that is not a direct import), add --force-full '<why>' to the call. If the targeted checks fail because of the",
    "list itself (a missing file, a selection that matches no test), rerun with --force-full 'targeted list invalid:",
    "<what>'.",
    ...(isBatch(task) ? ['This is a batch: run the call once, before the last commit of the batch; earlier commits use',
      'focused tests.'] : []),
    "Its result is one JSON line; each command's full output is in the file its result names as log, kept with the",
    "run's evidence: read the log instead of rerunning a command, and leave the file in place.",
  ];
}

// The line that points a reviewer at the unit's task-check evidence (spec
// 4.3). Files are task-<unit id>.<n>.json: the '.' after the id keeps a
// batch id (T2-T3) apart from its first task's (T2). A dotted id still
// collides (unit 1's pattern matches unit 1.2's files), so the line names
// policy.unit as the filter.
function taskEvidenceLine(m, task) {
  return [
    `Task-check evidence for this unit: ${m.repo.ledger_dir}/checks/task-${task.id}.<n>.json (n = 1, 2, ...);`,
    `another unit's files can match that pattern, so read only the files whose policy.unit is ${task.id};`,
    'each records its selection (policy.selected) and reasons. Do not rerun the checks. Report a wrong selection',
    'as a finding (for example targeted checks on a change that clearly reaches another lane).',
  ].join('\n');
}

// One line per finding; a finding that shares its location with other
// findings (dedupeFindings, linkSameLocation) also names their ids.
function findingsText(findings) {
  if (!Array.isArray(findings) || findings.length === 0) return '(none listed)';
  return findings.map((f, i) => `${present(f.id) ? `[${f.id}]` : `${i + 1}.`} [${f.severity}] ${f.file}:${f.line}`
    + ` - ${f.issue} (suggested fix: ${f.fix})`
    + (Array.isArray(f.same_location) && f.same_location.length > 0
      ? ` Same line as: ${f.same_location.join(', ')}` : '')).join('\n');
}

// One cannot_verify entry (spec 1.3.1): a requirement from the plan or spec
// the reviewer needed to check and could not, with source citing the task
// step or spec section, why it could not be checked, and how to check it.
function cannotVerifyItemSchema() {
  return {
    type: 'object',
    properties: {
      requirement: { type: 'string' },
      source: { type: 'string' },
      why: { type: 'string' },
      check_by: { type: 'string' },
    },
    required: ['requirement', 'source', 'why', 'check_by'],
  };
}

// A cannot_verify entry as text: '<requirement> (<source>): <why>; check:
// <check_by>' for an object, the string itself for a plain string (an agent
// from before 1.3.1).
function cannotVerifyText(item) {
  if (item === null || typeof item !== 'object') return String(item);
  return `${item.requirement} (${item.source}): ${item.why}; check: ${item.check_by}`;
}

// A cannot_verify entry that names where its requirement comes from: only
// these warn at acceptance; a plain string is kept as a note.
function isSourced(item) {
  return item !== null && typeof item === 'object' && present(item.source);
}

// What a reviewer returns as cannot_verify, and what it must leave out.
function cannotVerifyLines() {
  return [
    'cannot_verify = [{requirement, source, why, check_by}], one per requirement from the plan or spec that you',
    'needed to check and could not: source = the task step or spec section it comes from, why = why you could',
    'not check it, check_by = how it can be checked. Leave out things you verified, verdicts or decisions,',
    'limits the plan already accepts, the instruction not to re-run tests, and problems (those are findings);',
    'empty when there is nothing.',
  ];
}

// The note for a finding with file "start-task" (reviewStartFailure): the
// reviewer's start command failed, which no code change in the worktree can
// fix. Empty when no finding has that file.
function startFindingNote(findings) {
  if (!Array.isArray(findings) || !findings.some((f) => f && f.file === 'start-task')) return [];
  return ['A finding with file "start-task" is the reviewer\'s start command failing (a setup problem, not the',
    'code): change no code for it, and when it is the only finding, report blocked quoting it.'];
}

// The rulings already made for this run (m.run_rulings, set only by the
// workflow: pre-flight's rulings in order, then the adjudicator's pre-flight
// ruling), as prompt lines: a heading and one '- PF-<n>: <ruling>' line each,
// every ruling quoted as written. PF-<n> is the id agents cite and override it
// by during this launch; carry-launch records it with the ruling afterwards
// (1.6.3). Empty when there are none.
function runRulingsLines(m) {
  const rulings = Array.isArray(m.run_rulings) ? m.run_rulings : [];
  if (rulings.length === 0) return [];
  return ['Rulings already made for this run (binding):', ...rulings.map((r, i) => `- PF-${i + 1}: ${r}`)];
}

// The message a task fix round commits with: 'fix: address review findings
// for Task <id>', or for a batch 'for Batch <first>-<last>'.
function fixCommitMessage(task) {
  return `fix: address review findings for ${isBatch(task) ? 'Batch' : 'Task'} ${task.id}`;
}

// The message an implement attempt commits further work with once HEAD holds
// the task's first commit and no review findings are behind the attempt (a
// retry after a blocked or escalated attempt, a reopened task): 'chore:
// continue Task <id>', so history shows no fix of findings no review raised.
function continueCommitMessage(task) {
  return `chore: continue Task ${task.id}`;
}

// What every reviewer, re-reviewer and final lens is told about fix commits:
// each fix message, and that neither the plan's message on a task's first
// commit nor a fix message on a fix commit is a commit-rule finding.
function fixMessagesLines() {
  return [
    'Fix commits carry their own messages (in the form the commit rules use): a task fix round',
    '`fix: address review findings for Task <id>` (a batch: `fix: address review findings for Batch <first>-<last>`),',
    `the final fix \`${finalFixMessage()}\`, the post-integration fix \`${postIntegrateFixMessage()}\`, and a`,
    `repair after a failing verify \`${repairFixMessage()}\`.`,
    'An implement attempt that adds to a task\'s first commit with no review findings behind it commits',
    'with `chore: continue Task <id>`.',
    "The plan's message applies to a task's first commit; a fix commit carries its fix message, and a",
    'continuation commit its continuation message; none of them is a commit-rule finding.',
  ];
}

// The line that tells a fix agent which message to commit with.
function commitWithLine(message) {
  return `Commit with the message \`${message}\`, in the form the commit rules use (for example their prefix style).`;
}

// Shared context every task agent gets. guidance (optional) is
// {notes, amendments}: notes are decided on the user's behalf in this run (an
// adjudicator answer, or a note an unblocked task carries to the next one);
// amendments are adjudicator rulings that amend the task's brief for this run.
// by is the role a ruling the agent records carries: 'implementer' (implement
// and fix) or 'reviewer' (review and re-review).
function taskContext(m, task, where, guidance = null, by = 'implementer') {
  const files = taskFiles(m, task);
  const tasks = unitTasks(task);
  const userNote = (t) => m.notes && m.notes[t.id];
  // A batch records its rulings under its first task.
  const ruling = ledgerCommand(m, where.lane,
    { task: tasks[0].id, event: 'ruling', by, text: 'Ruling: <decision> - <why> - <cost if wrong>' }, where.dir);
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
    ...runRulingsLines(m),
    ...runNotes.map((n) =>
      `A note decided on the user's behalf for this ${unitNoun(task)} (follow it where it settles a question): ${n}`),
    ...amendments.map((a) => (isBatch(task)
      ? `Amendment to the batch's task briefs for this run (it overrides the briefs where they differ): ${a}`
      : `Amendment to the task brief for this run (it overrides the brief where they differ): ${a}`)),
    `Implementer report file: ${files.report}`,
    '',
    'Project commands (run from the worktree; the full set runs at integration and delivery):',
    commandsText(m, where.lane),
    `Run project commands you start yourself with PL_PHASE=${checksPhase(where.lane)} set (for example`,
    `\`PL_PHASE=${checksPhase(where.lane)} <command>\`): the project's scripts may read it; the check calls`,
    'this prompt hands you set it themselves.',
    '',
    `Commit rules (follow exactly): ${m.commit_rules}`,
    'Never commit anything under .superpowers/.',
    'Never push, open pull requests, merge into the base branch, or copy work back to the project.',
    agentRules(),
    ...longCheckRuleLines(m, checksPhase(where.lane)),
    '',
    'Contracts: report blocked for any change to a contract another lane consumes; ' +
      'record smaller decisions as `Ruling: decision - why - cost if wrong` with:',
    `  ${ruling}`,
    'Ledger entries are shell single-quoted JSON: fill the <...> placeholders and keep quote characters out of the text.',
    ...carryOverLines(m, task, where, by),
  ].join('\n');
}

// What every task agent is told about the rulings in force, and what an
// implementer is told about owners and observed failures (1.6.3).
function carryOverLines(m, task, where, by) {
  const ids = unitTasks(task).map((t) => `--task ${shellQuote(t.id)}`).join(' ');
  const lines = [
    'The start command prints the rulings in force under "===== rulings in force =====": they bind you. Cite one by',
    'its id (for example alpha-R3 or PF-2).',
  ];
  if (by !== 'implementer') return lines;
  return [
    ...lines,
    'To depart from a ruling in force, add "overrides": ["<id>"] to your ruling\'s JSON.',
    'An implementer may override only an implementer ruling of its own lane; to depart from any other, report status',
    'question naming its id.',
    'Before changing a file outside your Files list, run (a read-only command):',
    `  ${ledgerReadCommand(m, where.dir, 'owners', ids, "'<path relative to the worktree>'")}`,
    'A file owned by a task in another lane running alongside, or by a later task (or a later task\'s planned part of',
    'a file you share), needs a pre-flight or adjudicator ruling in force that lists it; without one, report status',
    'question instead of changing it. A file of a task earlier in the run is fine when your task needs the change.',
    'When you change a file outside your Files list, record a ruling saying why with "files": ["<path>"] added to its',
    'JSON, listing those files: it permits nothing, it shows reviewers and later tasks what changed outside the list.',
    'A check failure you judge outside your task (it passed on a rerun, or the failing test covers code your task did',
    'not touch): record it as a ruling whose JSON adds "scope": "run", with the text',
    'Observed: <test or command> failed - <why outside this task> - <rerun result>.',
  ];
}

function fallbackImplementer() {
  return [
    'Built-in instructions (superpowers not found):',
    'Implement exactly what the task brief specifies, nothing more. Follow test-driven development: write the',
    'failing tests first, run them and see them fail, implement, then run the task checks command once before',
    'committing and make it pass. Commit with the commit rules below. Write your report (what you built, tests and',
    'their output, files changed, concerns) to the implementer report file. If anything is unclear or you cannot',
    'finish, report blocked with the specifics instead of guessing.',
  ].join('\n');
}

function fallbackFixer() {
  return [
    'Built-in instructions (superpowers not found):',
    'Fix exactly the findings listed below, nothing more. Rerun the tests that cover the amended code, commit with',
    'the commit rules below, and add a fix report (what changed, covering tests, command, output) to the',
    'implementer report file with your file-editing tools. If you cannot fix a finding, report blocked with the',
    'specifics instead of guessing.',
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

// The Files list of a unit, each path once, in task order: what a review's
// scope check compares the range against.
function declaredFiles(task) {
  const out = [];
  for (const t of unitTasks(task)) for (const f of t.files || []) if (!out.includes(f)) out.push(f);
  return out;
}

// The fingerprint of a declared list, N:HHHHHHHH: N the number of paths, H the
// 32-bit FNV-1a hash of the paths' UTF-8 bytes joined with one NUL byte, as
// _owners.fingerprint computes it (tests/fixtures/fingerprint/cases.json).
// The UTF-8 encoder is written out (the Workflow runtime need not have
// TextEncoder); a lone surrogate gets its 3-byte form, as Python's
// surrogatepass gives it.
function declaredFingerprint(paths) {
  let h = 0x811c9dc5;
  const add = (byte) => { h = Math.imul(h ^ byte, 0x01000193) >>> 0; };
  paths.forEach((p, i) => {
    if (i > 0) add(0);
    for (let j = 0; j < p.length; j += 1) {
      const cp = p.codePointAt(j);
      if (cp > 0xffff) j += 1;
      if (cp < 0x80) {
        add(cp);
      } else if (cp < 0x800) {
        add(0xc0 | (cp >> 6)); add(0x80 | (cp & 0x3f));
      } else if (cp < 0x10000) {
        add(0xe0 | (cp >> 12)); add(0x80 | ((cp >> 6) & 0x3f)); add(0x80 | (cp & 0x3f));
      } else {
        add(0xf0 | (cp >> 18)); add(0x80 | ((cp >> 12) & 0x3f)); add(0x80 | ((cp >> 6) & 0x3f)); add(0x80 | (cp & 0x3f));
      }
    }
  });
  return `${paths.length}:${h.toString(16).padStart(8, '0')}`;
}

// The start-task command a task agent runs first: the optional fast-forward
// to the feature branch (opts.sync), every brief of the unit regenerated from
// the current plan and printed, and with opts.pkg = {base, head} and
// superpowers present the review package for base..head. With opts.pkg and a
// Files list it also lists the files base..head changes outside that list
// (--scope; 1.6.6: the list goes as its fingerprint, and start-task reads it
// from owners.json); with opts.start (the task base, implement only) it records that
// base in the ledger once the briefs are written (--record-start). For a
// join wave unit (where.unit_branch, 1.6.5) the implement start (opts.start)
// also puts the worktree on the unit's branch from where.from and runs the
// feature checkout's setup there (--unit-branch, --setup).
function startCommand(m, task, where, opts = {}) {
  const sync = opts.sync || null;
  const pkg = opts.pkg || null;
  const parts = [
    `cd ${shellQuote(where.dir)} && ${pythonCommand(m)} ${shellQuote(`${m.skill_dir}/scripts/start-task`)}`,
    shellQuote(where.dir), shellQuote(m.plan), '--artifacts', shellQuote(m.repo.ledger_dir),
  ];
  if (present(sync)) parts.push('--sync', shellQuote(sync));
  if (present(where.unit_branch) && present(opts.start)) {
    parts.push('--unit-branch', shellQuote(where.unit_branch), shellQuote(where.from), '--run-id', shellQuote(m.run_id),
      ...finalSetup(m).flatMap((c) => ['--setup', shellQuote(c)]));
  }
  if (pkg && m.sp_dir !== null) {
    const script = `${m.sp_dir}/subagent-driven-development/scripts/review-package`;
    const out = `${taskFiles(m, task).reviews}/${task.id}-${pkg.base}..${pkg.head}.diff`;
    parts.push('--package', shellQuote(script), shellQuote(pkg.base), shellQuote(pkg.head), shellQuote(out));
  }
  // Producers pre-flight found undeclared (consumes_extra, phases.js) reach
  // each task's brief through start-task --also.
  const extra = m.consumes_extra || {};
  for (const t of unitTasks(task)) {
    parts.push('--brief', shellQuote(t.id), shellQuote(taskFiles(m, t).brief));
    const own = Object.prototype.hasOwnProperty.call(extra, t.id) ? extra[t.id] : [];
    for (const p of own) parts.push('--also', shellQuote(t.id), shellQuote(p));
  }
  const declared = declaredFiles(task);
  if (pkg && declared.length > 0) {
    parts.push('--scope', shellQuote(pkg.base), shellQuote(pkg.head),
      '--declared-from-owners', shellQuote(declaredFingerprint(declared)),
      '--owners', shellQuote(`${m.repo.ledger_dir}/owners.json`));
  }
  // The rulings in force (1.6.3): a join task sees every lane's.
  parts.push('--rulings', shellQuote(m.repo.ledger_dir), shellQuote(where.lane === 'join' ? '-' : where.lane));
  if (present(opts.start)) {
    parts.push('--record-start', shellQuote(m.repo.ledger_dir), shellQuote(where.lane), shellQuote(opts.start));
    // A join unit begun again from the tip (1.6.5): the ledger drops its
    // earlier attempt.
    if (where.restart) parts.push('--restart');
  }
  return parts.join(' ');
}

// The "Run this first" block of a task prompt. failure says what a non-zero
// exit means for this agent.
function startBlock(m, task, where, opts, failure) {
  const what = [
    ...(present(opts.sync) ? ['fast-forwards this worktree to the feature branch (it holds the prelude commits)'] : []),
    ...(present(where.unit_branch) && present(opts.start)
      ? [`puts this worktree on the unit's own branch ${where.unit_branch} (saving any uncommitted changes it finds `
        + 'under the run\'s abandoned refs) and runs the project\'s setup commands there'] : []),
    isBatch(task)
      ? 'regenerates every task brief from the current plan and prints it'
      : 'regenerates the task brief from the current plan and prints it',
    ...(opts.pkg && m.sp_dir !== null ? ['builds the review package'] : []),
    ...(opts.pkg && declaredFiles(task).length > 0 ? ["lists the files the range changes outside the Files list"] : []),
    ...(present(opts.start) ? [where.restart ? 'records the task base in the ledger as a restart'
      : 'records the task base in the ledger'] : []),
  ];
  const files = isBatch(task) ? 'brief files' : 'brief file';
  return [
    `Run this first, as one call: it ${what.join(', then ')}, so you need not read the ${files} separately.`,
    `  ${startCommand(m, task, where, opts)}`,
    `If it exits non-zero, ${failure}`,
  ].join('\n');
}

// The finish-task command an implement or fix agent runs after committing:
// branch check, then the committed event for every task of the unit with the
// range from..HEAD read from git (base, head, every commit), then head and
// changed_lines. settled ('park' or 'unblock') instead records the settled
// event an adjudicator's outcome needs, with the range as git has it.
function finishCommand(m, task, where, from, settled = null) {
  return [
    `cd ${shellQuote(where.dir)} && ${pythonCommand(m)} ${shellQuote(`${m.skill_dir}/scripts/finish-task`)}`,
    shellQuote(where.dir), shellQuote(where.branch), shellQuote(from), shellQuote(m.repo.ledger_dir),
    shellQuote(where.lane),
    ...unitTasks(task).map((t) => `--task ${shellQuote(t.id)}`),
    ...(settled === null ? [] : ['--settled', settled]),
  ].join(' ');
}

// The ledger command that records a review approval of one task at head (the
// head of the range under review): the hash of the task's section of the plan
// comes from the file, not from the reviewer (scripts/ledger reviewed). The
// reviewer fills <blocking> with its count of critical and important
// findings; the command records nothing unless it is 0. The last argument is
// the spec path, which the ledger hashes so a changed spec makes the approval
// stale; "-" when the run has no spec.
function reviewedCommand(m, laneId, taskId, rounds, dir, head) {
  const spec = typeof m.spec === 'string' && m.spec !== '' ? shellQuote(m.spec) : '-';
  return `cd ${shellQuote(dir)} && ${pythonCommand(m)} ${shellQuote(`${m.skill_dir}/scripts/ledger`)} reviewed ` +
    `${shellQuote(m.repo.ledger_dir)} ${shellQuote(laneId)} ${shellQuote(taskId)} ${rounds} ` +
    `${shellQuote(m.plan)} ${shellQuote(dir)} ${shellQuote(head)} <blocking> ${spec}`;
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

function reviewResultText(m, task, where, rounds, head) {
  return [
    'You are read-only: never modify the worktree, the index, HEAD, or any branch. Writing the task brief, the',
    'review package, and the ledger line (all outside the repo) is allowed.',
    'Also check every commit message in the range against the commit rules.',
    ...fixMessagesLines(),
    'Report a commit message that breaks the commit rules as a minor finding (file "commit <sha>", line 0):',
    'history is never rewritten, so it cannot hold up the task; it is reported to the user.',
    'Return a structured result: verdict "changes" when the spec is not met or any critical or important',
    'finding exists, otherwise "approve" (minor findings may accompany approve); findings = [{severity',
    '("critical", "important", or "minor"), file, line (0 when no single line applies), issue, fix}];',
    ...cannotVerifyLines(),
    'That result replaces the output format named in the instructions above.',
    isBatch(task)
      ? 'Only when your verdict is approve, record it for every task of the batch with:'
      : 'Only when your verdict is approve, record it with:',
    ...unitTasks(task).map((t) => `  ${reviewedCommand(m, where.lane, t.id, rounds, where.dir, head)}`),
    'replacing <blocking> with the number of critical and important findings you report. An approve with any',
    'of them is not an approval: the command refuses it, and your verdict must then be changes.',
  ].join('\n');
}

// How an implement or fix prompt introduces its finish-task command. range
// says which commits it records.
function finishText(batch, range) {
  return `After committing, run finish-task once; it records ${range} as git has it in the\n` +
    (batch ? 'committed event for every task of the batch' : 'committed event') + ' and prints head and changed_lines:';
}

function finishFailure() {
  return 'A refusal (exit 3) records nothing; only a failed ledger write can leave part of a batch recorded, and a\n' +
    'rerun just repeats those events. On a non-zero exit fix the cause (no commit yet, the wrong branch) and rerun it,\n' +
    'or report blocked.';
}

// The lines that open an implement or fix prompt after a review approved
// while reporting a critical or important finding (not an approval): record
// that any approval it wrote no longer holds. Empty unless reopen.
function reopenLines(m, task, where, reopen) {
  if (!reopen) return [];
  return [
    'Run this first: the review approved while reporting a critical or important finding, which is not an',
    'approval, so record that any approval it wrote no longer holds:',
    ...ledgerLines(m, task, where, { event: 'reopened', reason: 'approved with a blocking finding' }),
    '',
  ];
}

// What a join unit begun again on the feature checkout is told (1.6.5 design
// 4.5): restart = {branch, dir, complete}, where its earlier attempt ran in a
// join wave of an earlier launch. That work never reached the feature branch.
function restartLines(m, task, restart, base) {
  const q = shellQuote;
  const dir = q(featureDir(m));
  const noun = unitNoun(task);
  const folder = String(restart.dir).replace(/[\\/]+$/, '').split(/[\\/]/).pop().replace(/[^A-Za-z0-9._-]/g, '-');
  return [
    `This ${noun} ran before, in a join wave of an earlier launch, on its own branch ${restart.branch} in`,
    `${restart.dir}, and that work never reached the feature branch. It was ${restart.complete
      ? 'complete: committed, but its review did not finish' : 'partial: it stopped before it was done'}.`,
    `Start again from the task base ${base} on the feature branch, and reuse what is right of the earlier work:`,
    `  its commits: git -C ${dir} log HEAD..${q(restart.branch)} (and git -C ${dir} diff HEAD...${q(restart.branch)})`,
    `  uncommitted changes saved from that worktree: git -C ${dir} for-each-ref ${q(`refs/parallel-lanes/${m.run_id}/abandoned/${folder}-`)}`,
    '  (each such ref is a commit; read it with git show).',
    'Never merge, rebase or reset onto that branch as it is: bring over what is right as your own commits here.',
  ];
}

// Prompt for an implementer. base is the task base the script owns (the
// previous task's head, or the feature tip); retry (optional) is {reason,
// findings} when a previous attempt in this run blocked or failed review;
// guidance (optional) is taskContext's.
function implementPrompt(m, task, where, base, retry = null, guidance = null, reopen = false) {
  const files = taskFiles(m, task);
  const sdd = m.sp_dir === null ? null : `${m.sp_dir}/subagent-driven-development`;
  const noun = unitNoun(task);
  const batch = isBatch(task);
  const parts = [
    `You are implementing ${unitName(task)}`,
    ...batchLines(task),
    '',
    ...reopenLines(m, task, where, reopen),
    sdd === null ? fallbackImplementer() : [
      `Read and follow ${sdd}/implementer-prompt.md: the prompt block inside its fence is your instructions,`,
      `with Task: ${unitName(task)}; [BRIEF_FILE]: ${briefRef(m, task)}; [directory]: ${where.dir};`,
      `[REPORT_FILE]: ${files.report}. You cannot ask questions mid-task: return status "question" with the`,
      'question instead (see the structured result below).',
    ].join('\n'),
    '',
    taskContext(m, task, where, guidance),
    '',
    startBlock(m, task, where, { sync: where.sync || null, start: base },
      'stop and report blocked with its message (a failed fast-forward is reported, never forced).'),
  ];
  parts.push('', [
    `Task base: ${base}. Everything on this branch after it is this ${noun}'s work, and its review covers`,
    `${base}..HEAD. HEAD may already hold commits from an earlier attempt at this ${noun}: start from the current`,
    'HEAD, keep what is right, and fix what is not.',
    // A batch's commits are one per task, each with its brief's message. A
    // first attempt has no first commit to add to, so only a retry or a
    // reopened task gets the line; the fix message only when review findings
    // are behind this attempt.
    ...(batch || (!retry && !reopen) ? [] : [
      'When HEAD already holds the task\'s first commit, commit further changes with the message',
      `\`${retry && Array.isArray(retry.findings) && retry.findings.length > 0
        ? fixCommitMessage(task) : continueCommitMessage(task)}\`, in the form the commit rules use (for example`,
      'their prefix style).',
    ]),
  ].join('\n'));
  if (retry) {
    parts.push('', [
      `A previous attempt at this ${noun} did not succeed: ${retry.reason}`,
      ...(retry.findings
        ? ['Open review findings:', findingsText(retry.findings), ...startFindingNote(retry.findings)] : []),
    ].join('\n'));
  }
  if (where.restart) parts.push('', restartLines(m, task, where.restart, base).join('\n'));
  const checks = taskChecksLines(m, task, where, base);
  if (checks.length > 0) parts.push('', checks.join('\n'));
  parts.push('', [
    finishText(batch, `every commit since the ${noun} base`),
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

// What a reviewer does with the start command's scope list, or nothing when
// the unit has no Files list to compare against.
function scopeLines(task) {
  if (declaredFiles(task).length === 0) return [];
  return [
    "The start command lists, under its \"===== files changed outside the task's Files list =====\" line, every",
    `file the range changes that the ${unitNoun(task)}'s Files list does not name, with its owner, and any changed`,
    'file of the Files list that another task also lists. Judge each:',
    '- owned by a task earlier in the run: fine when the task needed the change;',
    '- owned by a task in another lane running alongside, or a later task: an important finding unless a pre-flight or'
      + ' adjudicator ruling in force covers it (cite its id); an implementer\'s own ruling never does;',
    "- also in another task's Files: check the plan's split of that file; doing another task's planned part is a",
    '  finding (important if it breaks that task, else minor);',
    '- no task owns it: a change the task did not need is an important finding on that file; a needed one is fine.',
  ];
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
    ...scopeLines(task),
    taskEvidenceLine(m, task),
    '',
    taskContext(m, task, where, guidance, 'reviewer'),
    '',
    reviewResultText(m, task, where, rounds, head),
  ].join('\n');
}

// Prompt for a fix agent. report is the latest implement or fix result;
// head is the branch head the fix builds on. reopen: the review approved
// while reporting a blocking finding, and may have recorded that approval;
// the fix first records that it no longer holds.
function fixPrompt(m, task, where, findings, report, head, guidance = null, reopen = false) {
  const files = taskFiles(m, task);
  const sdd = m.sp_dir === null ? null : `${m.sp_dir}/subagent-driven-development`;
  const batch = isBatch(task);
  return [
    `You are fixing review findings for ${unitName(task)}`,
    ...batchLines(task),
    '',
    sdd === null ? fallbackFixer() : [
      `Read and follow ${sdd}/implementer-prompt.md: the prompt block inside its fence is your instructions,`,
      `with Task: ${unitName(task)}; [BRIEF_FILE]: ${briefRef(m, task)}; [directory]: ${where.dir};`,
      `[REPORT_FILE]: ${files.report}. You are at its After Review Findings step.`,
    ].join('\n'),
    '',
    ...reopenLines(m, task, where, reopen),
    `The branch is at ${head}. Fix these findings, commit on top of it, and add a fix report (what changed,`,
    `covering tests, command, output) to ${files.report} with your file-editing tools.`,
    'Rerun the tests that cover the amended code; do not run the task checks or the full suite: the re-review',
    'judges the fix, and integration and verify run the full checks.',
    commitWithLine(fixCommitMessage(task)),
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
    finishText(batch, 'every commit since the branch head named above'),
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
    ...scopeLines(task),
    taskEvidenceLine(m, task),
    '',
    taskContext(m, task, where, guidance, 'reviewer'),
    '',
    'List every finding still open, and any new critical or important problem the fix introduced, as findings.',
    reviewResultText(m, task, where, round, head),
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
      // Plain strings: agents from before 1.3.1 (kept as notes).
      cannot_verify: { type: 'array', items: { anyOf: [cannotVerifyItemSchema(), { type: 'string' }] } },
    },
    required: ['verdict', 'findings', 'cannot_verify'],
  };
}
