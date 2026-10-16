// git invocation that administers branches and worktrees for the run.
function gitAdmin(m) {
  return m.repo.mode === 'shadow'
    ? `git --git-dir=${shellQuote(m.repo.git_dir)}`
    : `git -C ${shellQuote(m.repo.root)}`;
}

// Rules every phase agent gets, the general long-command rule included.
// checkout (optional) replaces the checkout rules for the feature checkout
// (setup works in several checkouts).
function phaseRules(m, checkout = null) {
  return [
    `Commit rules (follow exactly): ${m.commit_rules}`,
    'Never commit anything under .superpowers/.',
    `Never push, open pull requests, merge into ${m.repo.base_ref}, or copy work back to the project folder.`,
    agentRules(),
    ...longCheckRuleLines(m),
    checkout === null ? checkoutRules(featureDir(m), m.repo.branch) : checkout,
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

// Phase steps that merge and run commands (integrate, post-integrate) report
// status/head/notes; conflict_files (optional) lists files a merge left
// conflicting, and tests_failed (optional) says a project command still fails
// after the merges so a fix agent is needed instead of a hard stop.
// checks_unfinished (optional, 1.6.2 spec 4.3) says every failing command
// exited 75, 124, 128 or above, or a negative code: the checks did not finish, and no fix runs.
function statusSchema() {
  return {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['done', 'failed'] },
      head: { type: 'string' },
      notes: { type: 'string' },
      conflict_files: { type: 'array', items: { type: 'string' } },
      tests_failed: { type: 'boolean' },
      checks_unfinished: { type: 'boolean' },
    },
    required: ['status', 'head', 'notes'],
  };
}

function preflightSchema() {
  // undeclared and code_deps share the item shape {task, producer, what}.
  const dependencies = () => ({
    type: 'array',
    items: {
      type: 'object',
      properties: {
        task: { type: 'string' },
        producer: { type: 'string' },
        what: { type: 'string' },
      },
      required: ['task', 'producer', 'what'],
    },
  });
  return {
    type: 'object',
    properties: {
      conflicts: { type: 'array', items: { type: 'string' } },
      rulings: { type: 'array', items: { type: 'string' } },
      undeclared: dependencies(),
      code_deps: dependencies(),
    },
    required: ['conflicts', 'rulings', 'undeclared', 'code_deps'],
  };
}

function e2eSchema() {
  return {
    type: 'object',
    properties: {
      head: { type: 'string' },
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
    required: ['head', 'items'],
  };
}

// head: the feature checkout's HEAD when the lens ran (the real tip, which a
// resume can leave past the tip the script tracked).
function finalReviewSchema() {
  const review = reviewSchema();
  return {
    type: 'object',
    properties: {
      findings: review.properties.findings,
      cannot_verify: review.properties.cannot_verify,
      head: { type: 'string' },
    },
    required: ['findings', 'cannot_verify', 'head'],
  };
}

// dispositions: one {id, status 'fixed' or 'declined', reason} per finding
// id the fix prompt lists; an id without one counts as not addressed.
function finalFixSchema() {
  const impl = implementSchema();
  return {
    type: 'object',
    properties: {
      ...impl.properties,
      dispositions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            status: { type: 'string', enum: ['fixed', 'declined'] },
            reason: { type: 'string' },
            evidence: { type: 'string' },
          },
          required: ['id', 'status', 'reason', 'evidence'],
        },
      },
    },
    required: [...impl.required, 'dispositions'],
  };
}

// The post-integrate re-review: the findings of a fix range.
function postIntegrateReReviewSchema() {
  return {
    type: 'object',
    properties: { findings: reviewSchema().properties.findings },
    required: ['findings'],
  };
}

// The final re-review: one {id, status, evidence} per finding id under
// verification (resolved: the defect is gone, or the decline is right), and
// new_findings for problems the fix introduced.
function finalReReviewSchema() {
  return {
    type: 'object',
    properties: {
      head: { type: 'string' },
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            status: { type: 'string', enum: ['resolved', 'open'] },
            evidence: { type: 'string' },
          },
          required: ['id', 'status', 'evidence'],
        },
      },
      new_findings: reviewSchema().properties.findings,
    },
    required: ['head', 'results', 'new_findings'],
  };
}

// The verify step's result: the JSON scripts/run-checks printed.
function verifySchema() {
  return {
    type: 'object',
    properties: {
      checkout: { type: 'string' },
      branch: { type: 'string' },
      head: { type: 'string' },
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            group: { type: 'string' },
            command: { type: 'string' },
            exit: { type: 'integer' },
            // run-checks prints them; a repair agent reads the failures' logs.
            log: { type: 'string' },
            tail: { type: 'string' },
            // A command that exited 75 and was run once more (1.6.2 spec 4.3):
            // {first_exit, waited_s}; kept so it is not dropped.
            busy_retry: { type: 'object' },
          },
          required: ['group', 'command', 'exit'],
        },
      },
      ok: { type: 'boolean' },
      clean: { type: 'boolean' },
      tracked_before: { type: 'array', items: { type: 'string' } },
      tracked_after: { type: 'array', items: { type: 'string' } },
      untracked_before: { type: 'array', items: { type: 'string' } },
      untracked_after: { type: 'array', items: { type: 'string' } },
      // run-checks --descends-from (a repair head's verify, spec 4.5).
      descends_from: {
        type: 'object',
        properties: { sha: { type: 'string' }, ok: { type: 'boolean' } },
        required: ['sha', 'ok'],
      },
      // 1.6.1: whether the tree changed while the checks ran (run-checks;
      // left out when it printed null), and why the checks stopped twice
      // without a result (spec 4.1; verifyAt treats it as no result).
      tree_changed: { type: 'boolean' },
      stopped: { type: 'string' },
    },
    required: ['head', 'results', 'ok', 'clean', 'tracked_before', 'tracked_after', 'untracked_before', 'untracked_after'],
  };
}

// A relaunch's pre-flight (1.6.3): the tasks already built, the rulings that
// bind it, and whether the plan or spec changed since the last launch
// (inputs_changed, copied from ledger status). [] on a first launch.
function relaunchPreflightLines(m) {
  // A relaunch: tasks are done, or the session carried an earlier launch
  // (carried_minors, set on every resume) even when none got done.
  const done = Array.isArray(m.done) ? m.done : [];
  if (done.length === 0 && !m.carried_minors) return [];
  const ic = m.inputs_changed;
  const known = ic && typeof ic.plan === 'boolean' && typeof ic.spec === 'boolean';
  let changed = 'Whether the plan or the spec changed since the last launch is not known.';
  if (known && ic.plan && ic.spec) changed = 'The plan and the spec changed since the last launch.';
  else if (known && ic.plan) changed = 'The plan changed since the last launch; the spec did not.';
  else if (known && ic.spec) changed = 'The spec changed since the last launch; the plan did not.';
  else if (known) changed = 'Neither the plan nor the spec changed since the last launch.';
  return [
    `Built tasks (done in an earlier launch; never rule on their code): ${done.length > 0 ? done.join(', ') : '(none)'}`,
    'Earlier rulings bind; read them with (a read-only command):',
    `  ${ledgerReadCommand(m, featureDir(m), 'rulings')}`,
    'Check only the tasks still to run and their dependence on built work.',
    'A matter an earlier ruling settled is not a conflict and gets no new ruling, unless the plan or the spec changed',
    `since that ruling; then report it as a conflict. ${changed}`,
    '',
  ];
}

// waves (1.6.5): the join's waves ([[unit id, ...], ...]) when the join runs in
// waves; pre-flight then also looks for a unit needing another unit of its own
// wave (design 4.7).
function preflightPrompt(m, waves = null) {
  return [
    `You are the pre-flight reviewer for parallel-lanes run ${m.run_id}. You are read-only: do not modify any`,
    'file, branch, or worktree.',
    `Plan: ${m.plan}`,
    `Spec: ${m.spec === null ? '(none)' : m.spec}`,
    '',
    'Run layout:',
    layoutText(m),
    '',
    ...relaunchPreflightLines(m),
    'Check:',
    '1. Every task id above has a "Task <ID>:" heading in the plan.',
    '2. The plan against the spec: contradictions, and defects the plan mandates (instructions that are wrong',
    '   or cannot work as written).',
    '3. Code dependencies: a lane task that needs real code another task produces (beyond a contract the',
    '   plan defines). Report each in code_deps, not as a conflict: return it as {task, producer, what},',
    '   what in one sentence. The run checks the schedule against these.',
    '4. Undeclared dependencies: a task in a lane that relies on something a task in another',
    '   lane or in the prelude produces (a function, a file format, markup, an API answer)',
    '   without naming that task in its Consumes. Return each in undeclared as',
    '   {task, producer, what}, what in one sentence.',
    ...(waves === null ? [] : [
      '5. Join waves: the join runs in these waves. The units of a wave run side by side, each from the feature',
      '   tip after the previous wave, without the work of the other units of their own wave:',
      ...waves.map((w, i) => `   wave ${i + 1}: ${w.join(', ')}`),
      '   For every task that needs work of another unit in its own wave (code, a contract, a test helper, a',
      '   generated file), report it in code_deps (code) or undeclared (anything else) as {task, producer,',
      '   what}: the run moves the task to a later wave.',
    ]),
    'Report serious problems (implementers would build the wrong thing, or check 1 or 2 fails) as conflicts,',
    'one sentence each naming the tasks and plan or spec sections. Settle minor ambiguities yourself and report',
    'each as a ruling in the form "Ruling: decision - why - cost if wrong".',
    '',
    phaseRules(m),
  ].join('\n');
}

// The ledger command the finishing Integrate-phase agent runs to record the
// join start point (spec A4): the feature head when integration completes.
// heal: the agent may return done with tests_failed true, which is not a
// finished integration (a fix agent and a rerun follow), so it records the
// start point only when no project command fails.
function joinStartPointLine(m, heal = false) {
  const cmd = ledgerCommand(m, '_run',
    { task: '_run', event: 'run_started', phase: 'join', head: '<feature head>' }, featureDir(m));
  const when = heal ? [
    'After everything above succeeds, and only when you return tests_failed false (every project command',
    'passes), record the join start point by running this command, substituting the full sha you return as',
    'head for <feature head> (keep the surrounding quotes). When a project command still fails, do not run it:',
  ] : [
    'After everything above succeeds, record the join start point by running this command, substituting the',
    'full sha you return as head for <feature head> (keep the surrounding quotes):',
  ];
  return [...when, `  ${cmd}`].join('\n');
}

// opts:
// - conflictMode 'resolve' (Plan 1: resolve with confidence, else abort+fail)
//   or 'abort' (Sonnet first pass: never resolve, abort+fail listing files).
// - testFailure 'fail' (Plan 1: fail when a command stays broken) or 'heal'
//   (autonomous: return done + tests_failed so a fix agent takes over).
// - reviewConflicts: the conflicting files a prior resolver merged, when this
//   rerun must also review that resolution; null otherwise.
// - resolverNotes: that resolver's notes (how it resolved each file), shown
//   with the resolution review.
// - joinStartPoint: carry the A4 join start-point ledger command (only when no
//   post_integrate hook finishes the phase).
// - laneTips: {<lane id>: sha} each lane's last commit (laneTips in
//   phases.js). A lane branch an earlier cleanup deleted counts as merged when
//   that commit is already in HEAD (a heal rerun, or a resume after cleanup);
//   a lane missing here falls back to its ledger.
// Heal mode holds cleanup back while tests_failed is true, so the rerun after
// the fix still finds every lane branch.
function integratePrompt(m, preludeTip, opts = {}) {
  const conflictMode = opts.conflictMode || 'resolve';
  const testFailure = opts.testFailure || 'fail';
  const reviewConflicts = opts.reviewConflicts || null;
  const resolverNotes = opts.resolverNotes || null;
  const joinStartPoint = opts.joinStartPoint || false;
  const laneTipMap = opts.laneTips || {};
  const q = shellQuote;
  const dir = q(featureDir(m));
  const admin = gitAdmin(m);
  const merges = m.lanes.map((lane) =>
    `   git -C ${dir} merge --no-ff -m <message> ${q(laneWhere(m, lane).branch)}`);
  // Step 3 runs the delivery inventory once (spec 4.4): the project's setup
  // and the lanes' distinct ones, then every distinct check of the project
  // and the lane_commands overrides, with the long-check procedure (1.6.1)
  // under the reserve name integrate, its logs beside the result.
  const setup = finalSetup(m);
  const checks = runChecksCommand(m, featureDir(m), finalChecks(m), resultPath(), 'integrate');
  // Heal mode reports checks that did not finish (1.6.2 spec 4.3): the
  // engine then starts no fix and stops. The other modes keep the general
  // exit-code rule.
  const exits = testFailure === 'heal' ? [
    'When every failing command exited 75, 124, 128 or above (or a negative code), the checks did not finish,',
    `which is not a defect: ${changeNothing()} for it. Return status done with`,
    'tests_failed true and checks_unfinished true, naming the exits in notes. A failing command with any other exit',
    'is a real failure: checks_unfinished false.',
  ] : null;
  const step3 = [
    `   setup: ${setup.length > 0 ? setup.join(' && ') : '(none)'}`,
    checks === null ? '   checks: (no test, lint or build command)'
      : "   checks, as one run-checks call (each command's exit status is kept; it exits non-zero when any fails).",
    ...(checks === null ? [] : [
      ...procedureLines(m, { name: 'integrate', start: checks, exits }).map((l) => `   ${l}`),
      ...checksLogLines().map((l) => ` ${l}`),
    ]),
  ];
  const keepWorktrees = opts.keepWorktrees || false;
  const cleanup = m.lanes.map((lane) => {
    const w = laneWhere(m, lane);
    return `   - ${q(w.dir)}: if git -C ${q(w.dir)} status --porcelain --untracked-files=all prints nothing, ` +
      `${admin} -c status.showUntrackedFiles=all worktree remove ${q(w.dir)} then git -C ${dir} branch -d ${q(w.branch)}`;
  });
  const joinIds = m.join.length > 0 ? m.join.map((t) => t.id).join(', ') : '(none)';
  // Every join task committed in an earlier attempt: a final fix of that
  // attempt may have committed after the last join commit.
  const lastJoin = m.join.length > 0 ? (m.backfill || {})[m.join[m.join.length - 1].id] : null;
  // With join waves (1.6.5) the join's last commit is the tip ledger
  // backfill reports (join_tip), not the last plan-order task's head.
  const joinTip = present(m.join_tip) ? m.join_tip : (lastJoin ? lastJoin.head : null);
  const joinDone = present(joinTip) && m.join.every((t) => m.done.includes(t.id));
  const finalFixes = joinDone ? [
    '   Every join task was committed earlier in this run, so final-fix commits from an earlier attempt of',
    `   this run may follow the last join commit ${joinTip}: allow any commits after it. That includes`,
    `   repair commits after a failing verify (\`${repairFixMessage()}\`).`,
  ] : [];
  const tipLines = m.lanes.map((lane) => {
    const tip = laneTipMap[lane.id];
    return `   - ${laneWhere(m, lane).branch}: ${present(tip) ? tip
      : `the last sha of the last committed event in ${m.repo.ledger_dir}/${lane.id}.jsonl`}`;
  });
  const deletedBranch = [
    '   A lane branch that no longer exists (an earlier cleanup in this run merged and deleted it) counts as',
    `   already merged when its last commit is in HEAD (git -C ${dir} merge-base --is-ancestor <sha> HEAD exits`,
    '   0); skip its merge. If that commit is not in HEAD, fail naming the branch. Last commits:',
    ...tipLines,
  ];
  const conflictLine = conflictMode === 'abort' ? [
    '   A branch that is already merged reports already up to date; that is fine. Do not resolve conflicts:',
    '   on a conflicting merge run git merge --abort, stop, return status failed, and list every conflicting',
    '   file in conflict_files (a later agent resolves them).',
  ] : [
    '   A branch that is already merged reports already up to date; that is fine. On a conflict, resolve it',
    '   keeping the intent of both lanes (read the plan tasks that touched the file) and commit the merge; if',
    '   you cannot resolve it with confidence, run git merge --abort and fail naming the files.',
  ];
  const testFailureLine = testFailure === 'heal'
    ? '   Fix only small, obvious integration breakage (commit it per the commit rules). If a project command '
      + 'still fails after that, return status done with the merges committed and tests_failed true (a later fix '
      + 'agent handles it); do not fail for a command failure.'
    : '   Fix only small, obvious integration breakage (commit it per the commit rules); otherwise fail.';
  const returnTail = conflictMode === 'abort'
    ? ', and conflict_files (the conflicting files on an aborted merge, else []).'
    : testFailure === 'heal'
      ? ', and tests_failed (true when a project command still fails after the merges) and checks_unfinished (true'
        + ' when every failing command exited 75, 124, 128 or above, or a negative code, see step 3).'
      : '.';
  const overlaps = Array.isArray(m.overlaps) && m.overlaps.length > 0 ? [
    '   Deliberate overlaps (more than one lane changes these files by plan; a merge conflict in them is expected):',
    ...m.overlaps.map((o) => `   - ${o.file}: tasks ${o.tasks.join(', ')}; on a conflict keep both changes, and where they`
      + ` cannot both stand keep task ${o.merge_owner}'s. Why: ${o.reason}`
      + (present(o.validation) ? `; after the merge, check it: ${o.validation}` : '')),
  ] : [];
  const review = reviewConflicts ? [
    'Resolution review: the merge conflicts in this run were already resolved by a prior agent in merge',
    `commits after ${preludeTip}. Before cleanup, review those resolution merges against both lanes' intent`,
    `(read the plan tasks that touched the conflicting files: ${reviewConflicts.join(', ')}); if a resolution`,
    "drops or corrupts either lane's intent, fail naming the problem.",
    ...(resolverNotes ? ["The resolver's notes on how it resolved each file:", resolverNotes] : []),
    '',
  ] : [];
  return [
    `You are the integration agent for parallel-lanes run ${m.run_id}.`,
    `Work in ${featureDir(m)} on the feature branch ${m.repo.branch}; do not switch branches.`,
    'Return status failed with the reason in notes at the first of steps 1-5 that fails.',
    '',
    `1. git -C ${dir} status --porcelain --untracked-files=all must print nothing (this is what clean means`,
    '   below; never make it so by deleting, cleaning, or stashing files).',
    '2. Merge each lane branch, in this order, with a merge commit whose message follows the commit rules:',
    ...merges,
    ...conflictLine,
    ...overlaps,
    ...deletedBranch,
    '3. In the tree step 1 found clean, rerun setup and then every check:',
    ...step3,
    testFailureLine,
    `4. History: ${preludeTip} is the feature tip after the prelude. This command:`,
    `   git -C ${dir} log --first-parent --format='%H %P %s' ${q(`${preludeTip}..HEAD`)}`,
    '   may list only merges (two parents) of the lane branches above, integration or post-integration fix',
    '   commits (yours, or from an earlier attempt in this run), and commits an earlier attempt at a join task',
    `   made (join tasks: ${joinIds}; their recorded commits are in ${m.repo.ledger_dir}/join.jsonl).`,
    "   A join that ran in waves also merged its units' heads ('join wave <n>: merge <unit>' and",
    "   'join recovery: merge <unit>', a resolver's included) and may have a wave checks fix",
    '   (`fix: make the wave checks pass`).',
    ...finalFixes,
    "   Any other commit landed on the feature branch outside the run's steps: fail listing it (do not",
    '   rewrite history).',
    `5. Committed scratch: git -C ${dir} diff --name-only ${q(`${m.repo.base_ref}...${m.repo.branch}`)}`,
    '   must list no path under .superpowers/; if it does, fail listing them (do not rewrite history).',
    ...(keepWorktrees ? [
      '6. Remove no lane worktree and delete no lane branch: the join runs in waves in the lane worktrees,',
      "   and the run's hand-back cleanup removes them.",
    ] : [
      ...(testFailure === 'heal' ? [
        '6. Only when steps 1-5 passed and you return tests_failed false (every project command passes), clean',
        '   up each lane. When you return tests_failed true, skip this step entirely: a fix agent and a rerun of',
        '   these steps follow and the rerun cleans up (with checks_unfinished true the run stops instead and the',
        '   lanes stay for the user). Cleanup:',
      ] : ['6. Only when steps 1-5 passed, clean up each lane:']),
      ...cleanup,
      '   Leave a worktree with uncommitted files (and its branch) in place and list it in notes; never',
      '   force a removal or a branch deletion. Cleanup never fails the integration: list anything step 6',
      '   could not remove in notes and still return status done.',
    ]),
    '',
    ...review,
    `Plan: ${m.plan}`,
    keepFilesRule(),
    phaseRules(m),
    ...(joinStartPoint ? ['', joinStartPointLine(m, testFailure === 'heal')] : []),
    '',
    `Return status done or failed, head (the full sha printed by git -C ${dir} rev-parse HEAD when you finish),`,
    `notes (merges, conflicts resolved, command results, cleanup)${returnTail}`,
  ].join('\n');
}

// Opus resolver (autonomous, C2): merges the conflicting lane branches and
// resolves them, keeping both lanes' intent, then commits. The integrate
// rerun that follows runs the commands, history checks, and cleanup and
// reviews this resolution.
function resolveConflictsPrompt(m, preludeTip, conflictFiles) {
  const q = shellQuote;
  const dir = q(featureDir(m));
  const merges = m.lanes.map((lane) =>
    `   git -C ${dir} merge --no-ff -m <message> ${q(laneWhere(m, lane).branch)}`);
  const files = conflictFiles && conflictFiles.length > 0 ? conflictFiles.join(', ') : '(the files the merge reports)';
  return [
    `You are the conflict resolver for parallel-lanes run ${m.run_id}.`,
    `Work in ${featureDir(m)} on the feature branch ${m.repo.branch}; do not switch branches.`,
    `The first-pass merge aborted on conflicts in: ${files}.`,
    '',
    `1. git -C ${dir} status --porcelain --untracked-files=all must print nothing; otherwise return status`,
    '   failed (never make it so by deleting, cleaning, or stashing files).',
    '2. Merge each lane branch, in this order, with a merge commit whose message follows the commit rules:',
    ...merges,
    '   A branch already merged reports already up to date; that is fine. On a conflict, resolve it keeping',
    '   the intent of both lanes: read the plan tasks that touched the conflicting files and keep what each',
    '   lane meant to do, then commit the merge. Resolve the conflicts only; make no other change.',
    '   Do not run the project commands, rewrite history, or remove any worktree or branch.',
    '',
    `Plan: ${m.plan}`,
    keepFilesRule(),
    phaseRules(m),
    '',
    `Return status done when every conflicting merge is resolved and committed, else failed; head (the full`,
    `sha printed by git -C ${dir} rev-parse HEAD when you finish); and notes (how you resolved each file).`,
  ].join('\n');
}

// ---- Join waves (1.6.5 design 4.3, 4.4) ----

// The wave merge agent (Sonnet): scripts/merge-wave for the wave's finished
// units (units: [{id, base, head}], plan order) in the feature checkout;
// with checks (the last multi-unit wave's, waveChecksOf) and every unit
// merged, it runs them on the merged tip and records wave_checked.
// wave null: a relaunch's recovery merge (design 4.5), merge-wave --recovery.
// known ([{id, head}], recovery only): units that ran on their own branch and
// are not to be merged; merge-wave reports which are in the history already.
function waveMergePrompt(m, wave, units, checks = [], known = []) {
  const q = shellQuote;
  const dir = featureDir(m);
  const recovery = wave === null;
  const merge = [`cd ${q(dir)} && ${pythonCommand(m)} ${q(`${m.skill_dir}/scripts/merge-wave`)} ${q(dir)}`,
    q(m.repo.ledger_dir), ...(recovery ? ['--recovery'] : ['--wave', q(String(wave))]),
    ...units.flatMap((u) => ['--unit', q(u.id), q(u.base), q(u.head)]),
    ...known.flatMap((u) => ['--known', q(u.id), q(u.head)])].join(' ');
  const run = checks.length > 0 ? runChecksCommand(m, dir, checks, resultPath(), 'join') : null;
  const record = (extra) => ledgerCommand(m, '_run',
    { task: '_run', event: 'wave_checked', wave, head: '<head>', ...extra }, dir);
  return [
    recovery ? `You are the recovery merge agent for parallel-lanes run ${m.run_id}.`
      : `You are the wave merge agent for parallel-lanes run ${m.run_id}, join wave ${wave}.`,
    `Work in ${dir} on the feature branch ${m.repo.branch}; do not switch branches.`,
    recovery ? (units.length > 0
      ? 'An earlier launch ran join units in waves; these finished and were reviewed but not merged. Merge their recorded heads.'
      : 'An earlier launch ran join units in waves; none is left to merge. The command below only reports the head.')
      : `The units of wave ${wave} ran side by side, each on its own branch; merge their recorded heads.`,
    '',
    '1. Run, as one call:',
    `   ${merge}`,
    "   It merges each unit's head in this order (skipping one already merged), aborts a merge that",
    '   conflicts and stops there, records the wave in the ledger, and prints one JSON line. Do not merge',
    '   anything yourself, resolve a conflict, or change any file.',
    '2. If it printed status conflict, stop: return status conflict with its head, merged, conflict_unit,',
    '   conflict_files and overlaps. If it exited 2 or 3, stop: return status failed with its message.',
    ...(run === null ? [] : [
      `3. It merged every unit: run the wave's checks on the merged tip (the last wave with more than one unit,`,
      "   whose merge no later task's checks cover). One run-checks call:",
      ...procedureLines(m, { name: `wave-${wave}`, start: run }).map((l) => `   ${l}`),
      ...checksLogLines().map((l) => ` ${l}`),
      '   Never change code to make a check pass: a failure goes back to the run.',
      `4. Record the result, with <head> the full sha of git -C ${q(dir)} rev-parse HEAD:`,
      `   every check passed: ${record({ ok: true })}`,
      `   a check failed: ${record({ ok: false })}`,
      '   every failing check exited 75, 124, 128 or above, or the checks stopped twice without a result:',
      `   ${record({ ok: false, unfinished: true })}`,
    ]),
    '',
    `Plan: ${m.plan}`,
    keepFilesRule(),
    phaseRules(m),
    '',
    'Return status done (every unit merged), conflict or failed; head = the head merge-wave printed; merged,',
    'conflict_unit (empty when none), conflict_files, overlaps and in_history copied from its JSON;',
    ...(run === null ? [] : ['checks = {ok, unfinished, notes} for the checks of step 3 (notes: the failing commands);']),
    'notes.',
  ].join('\n');
}

function waveMergeSchema() {
  return {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['done', 'conflict', 'failed'] },
      head: { type: 'string' },
      merged: { type: 'array', items: { type: 'string' } },
      conflict_unit: { type: 'string' },
      conflict_files: { type: 'array', items: { type: 'string' } },
      in_history: { type: 'array', items: { type: 'string' } },
      overlaps: {
        type: 'array',
        items: {
          type: 'object',
          properties: { path: { type: 'string' }, units: { type: 'array', items: { type: 'string' } } },
          required: ['path', 'units'],
        },
      },
      checks: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, unfinished: { type: 'boolean' }, notes: { type: 'string' } },
        required: ['ok', 'unfinished', 'notes'],
      },
      notes: { type: 'string' },
    },
    required: ['status', 'head', 'notes'],
  };
}

// The wave resolver (Opus, autonomous): merges one unit's head that
// conflicted, keeping both sides' intent, and commits; on any failure it
// aborts the merge so the checkout is clean for a relaunch.
// wave null: a conflict of the recovery merge.
function waveResolvePrompt(m, wave, unit, conflictFiles) {
  const q = shellQuote;
  const dir = q(featureDir(m));
  const files = conflictFiles && conflictFiles.length > 0 ? conflictFiles.join(', ') : '(the files the merge reports)';
  const message = wave === null ? `join recovery: merge ${unit.id}` : `join wave ${wave}: merge ${unit.id}`;
  return [
    `You are the wave resolver for parallel-lanes run ${m.run_id}, ${wave === null ? 'the recovery merge' : `join wave ${wave}`}.`,
    `Work in ${featureDir(m)} on the feature branch ${m.repo.branch}; do not switch branches.`,
    `Merging unit ${unit.id} (its recorded head ${unit.head}) conflicted in: ${files}.`,
    '',
    `1. git -C ${dir} status --porcelain --untracked-files=all must print nothing; otherwise return status`,
    '   failed (never make it so by deleting, cleaning, or stashing files).',
    `2. git -C ${dir} merge --no-ff -m ${q(message)} ${q(unit.head)}`,
    "   Resolve each conflict keeping the intent of both sides: read the plan tasks of the units that touched the",
    '   file and keep what each meant to do, then commit the merge. Resolve the conflicts only; make no other',
    '   change, run no project command, rewrite no history, and remove no worktree or branch.',
    `3. If you cannot resolve it, run git -C ${dir} merge --abort so the checkout is clean, and return status`,
    '   failed saying why.',
    '',
    `Plan: ${m.plan}`,
    keepFilesRule(),
    phaseRules(m),
    '',
    `Return status done when the merge is committed, else failed; head (the full sha printed by git -C ${dir}`,
    'rev-parse HEAD when you finish); notes (how you resolved each file).',
  ].join('\n');
}

// The message the wave checks fix commits with.
function waveChecksFixMessage() {
  return 'fix: make the wave checks pass';
}

// The wave checks fix (Opus, autonomous): one fix for the last multi-unit
// wave's failing checks, in the feature checkout; a re-review and a check-only
// rerun (waveChecksPrompt) follow.
function waveChecksFixPrompt(m, failure) {
  const dir = shellQuote(featureDir(m));
  return [
    `You are fixing the failing wave checks of parallel-lanes run ${m.run_id}.`,
    `Work in ${featureDir(m)} on ${m.repo.branch}; do not switch branches.`,
    'The units of the last join wave with more than one unit were merged; their targeted checks then failed:',
    failure,
    '',
    'Find the cause, fix it with the smallest change that is correct, and commit per the commit rules.',
    commitWithLine(waveChecksFixMessage()),
    'You may rerun the failing commands named above to reproduce the failure and to confirm your fix; the run',
    'reruns the wave checks after you.',
    '',
    `Plan: ${m.plan}`,
    `Spec: ${m.spec === null ? '(none)' : m.spec}`,
    keepFilesRule(),
    phaseRules(m),
    '',
    'Return status done when your fix is committed and the failing checks pass, otherwise failed; head = the',
    `full sha printed by git -C ${dir} rev-parse HEAD when you finish; notes = what you changed and the results.`,
  ].join('\n');
}

// The re-review of a wave checks fix (Opus): the fix range only.
function waveChecksReReviewPrompt(m, base, head) {
  return postIntegrateReReviewPrompt(m, base, head).replace('re-reviewing a post-integration fix',
    're-reviewing a fix for the failing join wave checks');
}

// The check-only rerun of the wave's checks after a fix (Sonnet).
function waveChecksPrompt(m, wave, checks) {
  const q = shellQuote;
  const dir = featureDir(m);
  const run = runChecksCommand(m, dir, checks, resultPath(), 'join');
  const record = (extra) => ledgerCommand(m, '_run',
    { task: '_run', event: 'wave_checked', wave, head: '<head>', ...extra }, dir);
  return [
    `You are rechecking join wave ${wave} of parallel-lanes run ${m.run_id} after a fix. Verify only: change no file,`,
    `make no commit. Work in ${dir} on ${m.repo.branch}.`,
    'Run the wave checks, as one run-checks call:',
    ...procedureLines(m, { name: `wave-${wave}`, start: run }),
    ...checksLogLines(),
    `Then record the result, with <head> the full sha of git -C ${q(dir)} rev-parse HEAD:`,
    `  every check passed: ${record({ ok: true })}`,
    `  a check failed: ${record({ ok: false })}`,
    '  every failing check exited 75, 124, 128 or above, or the checks stopped twice without a result:',
    `  ${record({ ok: false, unfinished: true })}`,
    '',
    keepFilesRule(),
    phaseRules(m),
    '',
    'Return status done; head = that sha; ok, unfinished and notes (the failing commands) for the checks.',
  ].join('\n');
}

function waveChecksSchema() {
  return {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['done', 'failed'] },
      head: { type: 'string' },
      ok: { type: 'boolean' },
      unfinished: { type: 'boolean' },
      notes: { type: 'string' },
    },
    required: ['status', 'head', 'ok', 'unfinished', 'notes'],
  };
}

// What the final lenses are told about the join waves (design 4.9): each
// wave's paths two units changed, and the conflicts the resolver settled,
// from earlier launches (m.wave_merges, ledger status) and this one
// (m.join_waves_now, the run result's join_waves).
function waveLines(m) {
  const lines = [];
  const all = [...(Array.isArray(m.wave_merges) ? m.wave_merges : []),
    ...(Array.isArray(m.join_waves_now) ? m.join_waves_now : [])];
  for (const w of all) {
    const name = w.recovery ? 'the recovery merge' : `wave ${w.wave}`;
    for (const o of Array.isArray(w.overlaps) ? w.overlaps : []) lines.push(`- ${name}: ${o.path} (${o.units.join(', ')})`);
    const resolved = Array.isArray(w.resolved_files) && w.resolved_files.length > 0 ? w.resolved_files
      : (Array.isArray(w.conflict_files) ? w.conflict_files : []);
    if (resolved.length > 0) lines.push(`- ${name}: merge conflicts the wave resolver settled in ${resolved.join(', ')}`);
  }
  if (lines.length === 0) return [];
  return [
    'Join waves: units of a wave ran side by side on their own branches and were merged. Review these paths',
    'with every unit named in mind (both sides of a merge must still hold):',
    ...lines,
  ];
}

// The message the final fix commits with. A function, not a constant: the
// test harness's loadHelpers returns before top-level bindings initialize.
function finalFixMessage() {
  return 'fix: address the final review findings';
}

// The message a post-integration fix commits with.
function postIntegrateFixMessage() {
  return 'fix: make the post-integration check pass';
}

// Opus fix (autonomous, C2) for a project command (or the post-integration
// check) still failing on the feature branch after integration. failure is
// the notes the failing step returned. path (spec 4.4): 'tests' after an
// integration test failure, where an integration rerun follows and owns the
// full commands, so the fixer runs focused tests only; 'hook' after a
// post-integrate hook failure, where only the hook reruns, so the fixer
// reruns every project command (1.5.2's text).
function postIntegrateFixPrompt(m, failure, path = 'hook') {
  const dir = shellQuote(featureDir(m));
  const focused = path === 'tests';
  return [
    `You are fixing a post-integration failure for parallel-lanes run ${m.run_id}.`,
    `Work in ${featureDir(m)} on ${m.repo.branch}; do not switch branches.`,
    'What is failing:',
    failure,
    '',
    'Find the cause, fix it with the smallest change that is correct, and commit per the commit rules.',
    commitWithLine(postIntegrateFixMessage()),
    ...(focused ? [
      'You may rerun the failing command named above to reproduce the failure. Then run the focused tests that',
      'cover your change; do not run the full project commands: the integration rerun after you runs every',
      'command.',
    ] : [
      'Rerun every project command afterwards and confirm they pass:',
      commandsText(m, null, featureDir(m), 'post-integrate-fix', 'post-integrate'),
    ]),
    m.hooks.post_integrate ? `Post-integration check to keep passing:\n${m.hooks.post_integrate}` : '',
    '',
    `Plan: ${m.plan}`,
    `Spec: ${m.spec === null ? '(none)' : m.spec}`,
    keepFilesRule(),
    phaseRules(m),
    '',
    focused ? 'Return status done when your fix is committed and the focused tests pass, otherwise failed; head = the'
      : 'Return status done when the commands pass, otherwise failed; head = the full sha printed by',
    focused ? `full sha printed by git -C ${dir} rev-parse HEAD when you finish; notes = what you changed and the test results.`
      : `git -C ${dir} rev-parse HEAD when you finish; notes = what you changed and the command results.`,
  ].join('\n');
}

// Opus re-review (autonomous, C2) of a post-integration fix: the fix range
// only, same findings shape as a task re-review.
function postIntegrateReReviewPrompt(m, base, head) {
  const dir = shellQuote(featureDir(m));
  return [
    `You are re-reviewing a post-integration fix for parallel-lanes run ${m.run_id} (fix range ${base}..${head}).`,
    'You are read-only: never modify the checkout, the index, HEAD, or any branch.',
    'Read the fix with:',
    `  git -C ${dir} log ${shellQuote(`${base}..${head}`)}`,
    `  git -C ${dir} diff ${shellQuote(`${base}..${head}`)}`,
    '',
    'Check the fix for correctness and for new critical or important problems; do not re-review code the fix',
    'did not touch.',
    ...fixMessagesLines(),
    phaseRules(m),
    '',
    'Return findings = [{severity ("critical", "important", or "minor"), file, line, issue, fix}], every',
    'problem you found (empty when the fix is sound).',
  ].join('\n');
}

// checkOnly: a recheck at the delivered revision after later commits; the
// agent verifies only and changes nothing. checks: the project checks'
// result at the revision the agent starts from ({head, ok, results?}:
// verify's run-checks JSON, or integrate's run), so the agent runs only what
// the hook adds; null when none ran there.
function postIntegratePrompt(m, checkOnly = false, checks = null) {
  const change = checkOnly ? [
    'This is a recheck of the delivered revision: verify only. Change no file, make no commit, and do not',
    'record a start point; if the instructions would need a change, return status failed naming it.',
  ] : [
    'Change files only if the instructions call for it; commit any change per the commit rules and rerun',
    'the project commands afterwards:',
    commandsText(m, null, featureDir(m), 'post-integrate', 'post-integrate'),
  ];
  return [
    `You are the post-integration agent for parallel-lanes run ${m.run_id}.`,
    `The lanes are merged into ${m.repo.branch} in ${featureDir(m)}; work there and do not switch branches.`,
    'Follow these project instructions:',
    m.hooks.post_integrate,
    '',
    ...checksLines(checks, !checkOnly),
    ...change,
    '',
    `Plan: ${m.plan}`,
    `Spec: ${m.spec === null ? '(none)' : m.spec}`,
    keepFilesRule(),
    phaseRules(m),
    '',
    ...(checkOnly ? [] : [joinStartPointLine(m)]),
    '',
    'Return status done when the instructions pass, otherwise failed; head = the full sha printed by',
    `git -C ${shellQuote(featureDir(m))} rev-parse HEAD when you finish; notes = what you checked and found.`,
  ].join('\n');
}

// checks: verify's result at the revision a recheck covers (null when none
// ran there): the checker runs only what the hook adds.
function e2ePrompt(m, checks = null) {
  return [
    `You are the end-to-end checker for parallel-lanes run ${m.run_id}.`,
    `The integrated code is in ${featureDir(m)} on ${m.repo.branch}.`,
    'Follow these project instructions:',
    m.hooks.e2e,
    '',
    ...checksLines(checks),
    'Rules: use scratch directories only (mktemp -d, outside the checkout and the project; remove them',
    'when done); never change tracked files or commit; stop every server you start before returning and',
    'confirm its port is free.',
    keepFilesRule(),
    phaseRules(m),
    '',
    `Return head = the full sha printed by git -C ${shellQuote(featureDir(m))} rev-parse HEAD before you start (the`,
    'revision your checks cover), and items: one {item, result PASS or FAIL, evidence} per checklist item,',
    'evidence being the command and output or observation that decided it.',
  ].join('\n');
}

// What one final review lens looks for: 'sp' (the whole branch, through
// superpowers' code reviewer when found), 'security', or 'correctness'.
function finalLensFocus(m, lens, e2e) {
  if (lens === 'sp') {
    return m.sp_dir === null ? [
      'Built-in instructions (superpowers not found):',
      'Review the whole branch as a senior reviewer: plan and spec compliance across all tasks, integration',
      'between lanes, architecture, test quality, and maintainability.',
    ].join('\n') : [
      `Read and follow ${m.sp_dir}/requesting-code-review/code-reviewer.md as your review instructions for the`,
      "whole branch: what was implemented = the plan's tasks; requirements = the plan and spec; base =",
      `${m.repo.base_ref}; head = ${m.repo.branch}.`,
    ].join('\n');
  }
  if (lens === 'security') {
    const flagged = [...m.prelude, ...m.lanes.flatMap((l) => l.tasks), ...m.join].filter((t) => t.security);
    return [
      'Security lens: authentication, authorization, crypto, untrusted input, injection, path handling,',
      'secrets, permissions, and unsafe defaults.',
      `Tasks flagged security-sensitive: ${flagged.length > 0 ? flagged.map((t) => t.id).join(', ') : '(none)'}`,
    ].join('\n');
  }
  return [
    'Correctness lens: logic errors, edge cases, error handling, concurrency, contracts between lanes, and',
    'tests that do not verify real behavior. End-to-end results:',
    e2e === null ? '(no e2e hook)' : JSON.stringify(e2e),
  ].join('\n');
}

// The task minors checklist for the reviewer that owns it (taskMinorFindings
// of this launch, and the open ones an earlier launch left, read from the
// ledger): [] when there are none.
function taskMinorsLines(m, minors) {
  const here = Array.isArray(minors) ? minors : [];
  const carried = carriedMinorIds(m);
  if (here.length === 0 && carried.length === 0) return [];
  const ledger = ledgerReadCommand(m, featureDir(m), 'minors');
  return [
    ...(here.length > 0 ? [
      'Minor findings of approved task reviews, never acted on (each with its id in brackets):',
      findingsText(here),
    ] : []),
    ...(carried.length > 0 ? [
      'Minor findings an earlier launch\'s task reviews approved and no final review has raised yet. Read them with',
      '(a read-only command):',
      `  ${ledger}`,
      `Carried: ${carried.join(', ')}`,
    ] : []),
    'For each one that still holds and is worth fixing, raise it as a finding with its id in brackets in the',
    'issue (for example "[<id>] ..."); otherwise leave it.',
    '',
  ];
}

// For a lens that does not own the checklist, when there is one: [] otherwise.
function otherReviewerMinorsLines(m, minors) {
  const any = (Array.isArray(minors) && minors.length > 0) || carriedMinorIds(m).length > 0;
  return any ? ['Task minors are checked by another reviewer: raise one only if you judge it critical or'
    + ' important, citing its id.', ''] : [];
}

// A final reviewer's prompt around its focus text: read-only, the whole
// branch range, the commit-rules scan, the task minors checklist (or, with
// other true, the line for a lens that does not own it: minors is then the
// checklist another lens has), and the findings/head result.
function finalReviewFrame(m, intro, focus, minors = [], other = false) {
  const q = shellQuote;
  const dir = q(featureDir(m));
  const log = `git -C ${dir} log ${q(`${m.repo.base_ref}..${m.repo.branch}`)}`;
  const diff = `git -C ${dir} diff ${q(`${m.repo.base_ref}...${m.repo.branch}`)}`;
  return [
    `${intro} for parallel-lanes run ${m.run_id}. You are read-only: never modify the`,
    'checkout, the index, HEAD, or any branch.',
    `Plan: ${m.plan}`,
    `Spec: ${m.spec === null ? '(none)' : m.spec}`,
    `Range: ${m.repo.base_ref}..${m.repo.branch}. Read it with:`,
    `  ${log}`,
    `  ${diff}`,
    '',
    focus,
    '',
    ...(other ? otherReviewerMinorsLines(m, minors) : taskMinorsLines(m, minors)),
    ...runRulingsLines(m),
    ...rulingsReadLines(m, featureDir(m)),
    ...waveLines(m),
    "A finding that a ruling in force settles is not raised unless it is critical or important; then raise it and cite the ruling's id.",
    'Files each task changed outside its Files list, with their owners (a read-only command):',
    `  ${ledgerReadCommand(m, featureDir(m), 'undeclared')}`,
    'Check each change was needed. A file of a task earlier in the run needs no ruling. A file owned by a task in',
    'another lane running alongside, or a later task, needs a pre-flight or adjudicator ruling in force that covers it',
    "(cite its id); an implementer's own ruling never does.",
    'Also scan every commit message in the range and the whole diff for anything the commit rules forbid;',
    'report each as a finding (for a commit message use file "commit <sha>" and line 0).',
    ...fixMessagesLines(),
    'Run only the focused checks a finding needs; do not run the full project commands.'
      + (finalChecks(m).length > 0 ? ' Verify runs every check at the delivered revision after the review.' : ''),
    'Put any scratch copy or file in your own folder made with mktemp -d, outside the checkout,'
      + " the project and the session's scratchpad, and remove it when done.",
    phaseRules(m),
    '',
    'Return findings = [{severity ("critical", "important", or "minor"), file, line (0 when no single line',
    'applies), issue, fix}], head = the full sha printed by',
    `git -C ${dir} rev-parse HEAD (a read-only command you may run), and`,
    ...cannotVerifyLines(),
  ].join('\n');
}

// minors: the task minors checklist (taskMinorsLines); other: this lens does
// not own the checklist (it gets otherReviewerMinorsLines when one exists).
function finalReviewPrompt(m, lens, e2e, minors = [], other = false) {
  return finalReviewFrame(m, 'You are a final reviewer', finalLensFocus(m, lens, e2e), minors, other);
}

// Profile lite: one reviewer covers the three lenses of the full profile.
// ctx = {e2e, minors?}: the e2e result, or null without an e2e hook, and
// the task minors checklist (taskMinorsLines).
function combinedFinalReviewPrompt(m, ctx) {
  const focus = [
    'Review the whole branch through three lenses, in turn, and report every finding of each:',
    '',
    '1. Whole-branch lens.',
    finalLensFocus(m, 'sp', ctx.e2e),
    '',
    '2. Security lens.',
    finalLensFocus(m, 'security', ctx.e2e),
    '',
    '3. Correctness lens.',
    finalLensFocus(m, 'correctness', ctx.e2e),
  ].join('\n');
  return finalReviewFrame(m, 'You are the final reviewer', focus, ctx.minors || []);
}

function finalFixPrompt(m, findings, base) {
  return [
    `You are fixing the final review findings for parallel-lanes run ${m.run_id}.`,
    `Work in ${featureDir(m)} on ${m.repo.branch} (now at ${base}); do not switch branches.`,
    'Findings (each with its id in brackets):',
    findingsText(findings),
    '',
    'Fix each finding, or decline it with a reason (only for a false positive, an item outside this',
    "run's scope, or a commit-message finding: history is never rewritten). A reviewer checks every",
    // Spec 4.5 and 4.7: verify owns the full checks after an autonomous
    // final fix (a failure there goes to a repair agent); a supervised run
    // has no repair, so its fixer still reruns everything.
    ...(effectiveAutonomy(m) === 'autonomous' ? [
      'decline. Run the focused checks that cover each fix; do not run the full project commands: verify runs every',
      'check at the delivered revision right after you, and a failure there goes to a repair agent.',
    ] : [
      'decline. Rerun every project command afterwards:',
      commandsText(m, null, featureDir(m), 'final-fix', 'final-fix'),
    ]),
    'Commit your fixes per the commit rules.',
    commitWithLine(finalFixMessage()),
    '',
    `Plan: ${m.plan}`,
    `Spec: ${m.spec === null ? '(none)' : m.spec}`,
    ...runRulingsLines(m),
    ...rulingsReadLines(m, featureDir(m)),
    keepFilesRule(),
    phaseRules(m),
    '',
    implementResultText(featureDir(m), false, base),
    'Also return dispositions = one {id, status "fixed" or "declined", reason, evidence} for every finding id above',
    '(reason: what you changed, or why you declined it; evidence: the file:line and commit of the change, or what',
    'shows the decline is right). A finding without a disposition counts as not addressed; two different ones for',
    'one id leave it open.',
  ].join('\n');
}

// findings carry their id and the fixer's dispositions for it
// ([{status, reason, evidence}]; none when the fixer gave none). verify:
// the project checks' result at head (run before the re-review), or null.
// repairs: the repairs after a failing verify inside the range
// ([{attempt, from, head, failed}], spec 4.5); with no findings the
// re-review judges only those.
function finalReReviewPrompt(m, base, head, findings, verify = null, repairs = []) {
  const dir = shellQuote(featureDir(m));
  const said = (f) => ((f.dispositions || []).length > 0
    ? f.dispositions.map((d) => `   fixer: ${d.status} - ${d.reason}`
      + (present(d.evidence) ? ` (evidence: ${d.evidence})` : '')).join('\n')
    : '   fixer: no disposition (treat it as not addressed unless the defect is verifiably gone)');
  return [
    `You are re-reviewing the final fixes for parallel-lanes run ${m.run_id} (fix range ${base}..${head}`
      + `${base === head ? ', no fix commits' : ''}).`,
    'You are read-only: never modify the checkout, the index, HEAD, or any branch.',
    'Read the fix with:',
    `  git -C ${dir} log ${shellQuote(`${base}..${head}`)}`,
    `  git -C ${dir} diff ${shellQuote(`${base}..${head}`)}`,
    ...(findings.length > 0 ? [
      'Findings under verification, with what the fixer said about each:',
      findings.map((f) => `${findingsText([f])}\n${said(f)}`).join('\n'),
    ] : ['No findings are under verification: judge the repair commits in the range.']),
    ...(repairs.length > 0 ? [
      'Repairs after a failing verify, in the range (each addressed the failing checks it lists):',
      ...repairs.map((r) => `- repair ${r.attempt}: ${r.from}..${r.head}, status ${r.status || 'unknown'}; failing then: `
        + `${(r.failed || []).join(', ') || '(none listed)'} (evidence ${m.repo.ledger_dir}/checks/verify-${r.from}.json)`
        + `${present(r.notes) ? `; the repair said: ${r.notes}` : ''}`),
      'Judge the repair commits as fix code: correct, no new critical or important problem, no check, test or',
      'acceptance criterion weakened, skipped or deleted to get a pass, and nothing that worked around a flaky,',
      'environment or out-of-scope failure (a retry, a raised timeout, a mocked-out dependency) instead of fixing it.',
      'Repairs have no id: report any problem in a repair only in new_findings; a weakened, skipped or deleted check',
      'is at least important.',
    ] : []),
    '',
    ...(verify ? [
      checksResultText(verify),
      findings.length > 0 ? 'Still judge every finding yourself; a failing check is evidence, not a verdict.'
        : 'A failing check is evidence, not a verdict.',
      '',
    ] : []),
    ...(findings.length > 0 ? [
      'For every id above decide at the current head: resolved (the defect no longer exists, or the decline is',
      'right: a false positive, out of scope, or a commit message) or open; cite file:line evidence. Judge the',
      'defect, not its wording or line: a defect that moved or was reworded is still the same finding. Then',
      'check the fix for new critical or important problems; do not re-review code the fix did not touch.',
    ] : ['Check the repairs for new critical or important problems; do not re-review code they did not touch.']),
    ...runRulingsLines(m),
    ...rulingsReadLines(m, featureDir(m)),
    ...fixMessagesLines(),
    phaseRules(m),
    '',
    ...(findings.length > 0 ? [
      `Return head = git -C ${dir} rev-parse HEAD (the revision you judged; it must be ${head}), results = one`,
      '{id, status "resolved" or "open", evidence} per id above (an id you leave out counts as open; two different',
      'results for one id leave it open), and new_findings = the new problems, each {severity, file, line, issue,',
      'fix}.',
    ] : [
      `Return head = git -C ${dir} rev-parse HEAD (the revision you judged; it must be ${head}),`,
      'results = [] (no finding is under verification), and new_findings = the problems you found, each',
      '{severity, file, line, issue, fix} (empty when the repairs are sound).',
    ]),
  ].join('\n');
}

// The verify step: every check of the final inventory (project and lane
// commands, finalChecks) at the delivered revision, through one
// scripts/run-checks call with the long-check procedure, whose JSON the
// agent returns as the wait printed it. Its result file is reserved with
// --exact as verify-<sha>.json under the ledger, where check-verify reads
// it. from (spec 4.5): the head a repair started at; the checks then run
// only when sha descends from it (run-checks --descends-from). After a
// second stop the agent returns stopped (spec 4.1), which verifyAt treats
// as no result.
function verifyPrompt(m, sha, from = null) {
  const dir = featureDir(m);
  const q = shellQuote;
  const base = runChecksCommand(m, dir, finalChecks(m), resultPath(), 'verify');
  const cmd = from === null ? base : `${base} --descends-from ${q(from)}`;
  const setup = finalSetup(m);
  const stop = [
    `return results [], ok false, clean = whether git -C ${q(dir)} status --porcelain --untracked-files=all prints`,
    'nothing, empty tracked_before, tracked_after, untracked_before and untracked_after lists, head = the output',
    `of git -C ${q(dir)} rev-parse HEAD, and stopped naming both outcomes the wait printed.`,
  ].join('\n      ');
  return [
    `You are the verifier for parallel-lanes run ${m.run_id}: run the project checks at the delivered revision.`,
    `Work in ${dir} on ${m.repo.branch}; do not switch branches, change files, or commit.`,
    `1. git -C ${q(dir)} rev-parse HEAD must print ${sha}; if it does not, return its output as head`,
    '   with results [] and ok false.',
    `2. Run the setup commands first (the project's, then the lanes' own): ${setup.length > 0 ? setup.join(' && ') : '(none)'}`,
    '3. Run the checks, as one run-checks call:',
    ...procedureLines(m, {
      name: `verify-${sha}`, exact: true, start: cmd, stop,
      changed: 'return the JSON of that rerun as the wait printed it, with tree_changed true.',
      // The engine decides what the exits mean (nonDefectFailure, 1.6.2).
      exits: ['These are results like any other: report each exit as the wait printed it.'],
    }).map((l) => `   ${l}`),
    '',
    keepFilesRule(),
    phaseRules(m),
    '',
    "The wait prints run-checks' JSON: each command's output is in the file its result names as log, and its",
    'last 20 lines are in tail. Do not rerun a command to see its output; read the log instead.',
    'Return exactly the JSON fields run-checks printed: checkout, branch, head, results, ok, clean, tracked_before,',
    `tracked_after, untracked_before, untracked_after${from === null ? '' : ', descends_from'}, and tree_changed when`,
    'run-checks printed true or false.',
  ].join('\n');
}

// The repair agent after a failing verify (spec 4.5, 4.6). verify is the
// failing run-checks JSON at from, the head the repair starts at; attempt is
// its number.
function verifyRepairPrompt(m, verify, from, attempt) {
  const evidence = `${m.repo.ledger_dir}/checks/verify-${from}.json`;
  const failing = (Array.isArray(verify && verify.results) ? verify.results : []).filter((r) => r && r.exit !== 0);
  const lines = failing.map((r) => [
    `- ${r.command} (exit ${r.exit})`,
    present(r.log) ? `  log: ${r.log}` : `  log: beside ${evidence} (its results name each log)`,
    ...(present(r.tail) ? ['  last lines:', ...r.tail.split('\n').map((l) => `    ${l}`)] : []),
  ].join('\n'));
  return [
    `You are repair ${attempt} for parallel-lanes run ${m.run_id}: the delivery checks failed at ${from}.`,
    `Work in ${featureDir(m)} on ${m.repo.branch} (now at ${from}); do not switch branches.`,
    'Failing checks:',
    ...lines,
    `The full evidence is ${evidence}.`,
    '',
    'Find the cause and fix it with the smallest change that is correct, so the checks pass for the right reason.',
    'Never weaken, skip or delete a check, test or acceptance criterion to get a pass, and never change the',
    'commands, lane_commands or task_checks, or the test runner configuration, to make them pass. Fixing a wrong',
    'test is allowed when the test, not the code, is wrong: say why in notes. If the failure is a flaky, timeout,',
    'crash or environment failure rather than a failing check (exit 124 is a timeout, exit 75 a busy project), or',
    "lies outside this run's scope, change nothing: report blocked with the evidence.",
    'Run the focused checks that cover your fix; do not run the full project commands: verify runs them all at',
    'your head right after you.',
    commitWithLine(repairFixMessage()),
    '',
    `Plan: ${m.plan}`,
    `Spec: ${m.spec === null ? '(none)' : m.spec}`,
    ...runRulingsLines(m),
    ...rulingsReadLines(m, featureDir(m)),
    keepFilesRule(),
    phaseRules(m),
    '',
    implementResultText(featureDir(m), false, from),
  ].join('\n');
}

// What a repair agent returns (implementResultText's shape).
function repairSchema() {
  return {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['done', 'blocked'] },
      head: { type: 'string' },
      tests: { type: 'string' },
      notes: { type: 'string' },
      changed_lines: { type: 'integer' },
    },
    required: ['status', 'head', 'tests', 'notes'],
  };
}

// What the project checks found, for an agent that would otherwise rerun
// them at the same commit: one line, or '' for null (or a result naming no
// head). checks is verify's run-checks JSON, or {head, ok} for a run without
// per-command results (integrate's). Passed means ok and every exit 0, on a
// checkout with no tracked change before or after the commands and no
// untracked file before them (untracked_before, as acceptance's
// checks_unclean rule reads it); checks that passed on uncommitted tracked
// changes or with an untracked file present do not cover head, and a failure
// there may come from that file, so it is not reported as head's. A missing
// list changes nothing here (integrate's results have none).
function checksResultText(checks) {
  if (!checks || !present(checks.head)) return '';
  const results = Array.isArray(checks.results) ? checks.results : [];
  const failed = results.filter((r) => r && r.exit !== 0).map((r) => `${r.command} (exit ${r.exit})`);
  const paths = (lists) => new Set(lists
    .flatMap((l) => (Array.isArray(l) ? l : []))
    .map((line) => (typeof line === 'string' && line.length > 3 ? line.slice(3) : String(line))));
  const tracked = paths([checks.tracked_before, checks.tracked_after]);
  const untracked = paths([checks.untracked_before]);
  const count = (n) => `${n} file${n === 1 ? '' : 's'}`;
  const failedOn = [
    ...(tracked.size > 0 ? [`on uncommitted tracked changes, ${count(tracked.size)}`] : []),
    ...(untracked.size > 0 ? [`with untracked files present, ${count(untracked.size)}`] : []),
  ];
  const ranOn = [
    ...(tracked.size > 0 ? [`on uncommitted tracked changes (${count(tracked.size)})`] : []),
    ...(untracked.size > 0 ? [`with untracked files present (${count(untracked.size)})`] : []),
  ];
  const outcome = checks.ok !== true || failed.length > 0 ? `FAILED${failed.length > 0 ? `: ${failed.join(', ')}` : ''}`
      + (failedOn.length > 0 ? ` (${failedOn.join(', and ')}, so not at ${checks.head})` : '')
    : ranOn.length > 0 ? `ran ${ranOn.join(' and ')}, so they do not cover ${checks.head}`
      : 'passed';
  return `The project checks already ran at ${checks.head}: ${outcome}. Do not rerun them.`;
}

// The checks line for a hook agent (e2e, post-integrate), followed by the
// instruction to run only what the hook adds; [] when no checks ran there.
// mayCommit: the agent may commit a change, after which the commands run
// again.
function checksLines(checks, mayCommit = false) {
  const text = checksResultText(checks);
  if (text === '') return [];
  return [text, `Run only what the instructions above add to them${mayCommit
    ? '; after a change you commit, rerun the project commands as below' : ''}.`, ''];
}

// The key findings merge on, or null for one that stays apart: a
// 'commit <sha>' file merges on the file, any other on its exact file and
// line when the line is above 0.
function findingKey(f) {
  if (typeof f.file === 'string' && /^commit \S+$/.test(f.file)) return JSON.stringify([f.file]);
  if (Number.isInteger(f.line) && f.line > 0) return JSON.stringify([f.file, f.line]);
  return null;
}

// A finding's issue text as findings merge on it: trimmed, with every run
// of whitespace collapsed to one space.
function issueKey(f) {
  return String(f.issue == null ? '' : f.issue).replace(/\s+/g, ' ').trim();
}

// Merge the lenses' findings (spec 1.3.1): findings at the same location
// (findingKey) with the same issue text (issueKey) become one entry listing
// every lens that reported it, keeping the issue text, severity and fix of
// its most severe report (the first of those on a tie). Findings at one
// location with different issue texts stay separate entries, each its own
// obligation; linkSameLocation lists the others' ids once ids are assigned.
// also_reported stays on every entry, always [], so the shape is unchanged.
// reports: [{lens, findings|null}].
function dedupeFindings(reports) {
  const rank = { critical: 3, important: 2, minor: 1 };
  const merged = [];
  const byKey = new Map();
  for (const { lens, findings } of reports) {
    for (const f of findings || []) {
      const location = findingKey(f);
      const key = location === null ? null : JSON.stringify([location, issueKey(f)]);
      const seen = key === null ? undefined : byKey.get(key);
      if (seen === undefined) {
        const entry = { ...f, lenses: [lens], also_reported: [], same_location: [] };
        if (key !== null) byKey.set(key, entry);
        merged.push(entry);
        continue;
      }
      if (!seen.lenses.includes(lens)) seen.lenses.push(lens);
      if ((rank[f.severity] || 0) > (rank[seen.severity] || 0)) {
        seen.severity = f.severity;
        seen.fix = f.fix;
        seen.issue = f.issue;
      }
    }
  }
  return merged;
}

// Fill each finding's same_location with the ids of the other findings at
// its location (findingKey), in order; a finding with no location key gets
// []. findings: dedupeFindings output with ids (withFindingIds).
function linkSameLocation(findings) {
  const idsAt = new Map();
  for (const f of findings) {
    const key = findingKey(f);
    if (key !== null) idsAt.set(key, [...(idsAt.get(key) || []), f.id]);
  }
  return findings.map((f) => {
    const key = findingKey(f);
    return { ...f, same_location: key === null ? [] : idsAt.get(key).filter((id) => id !== f.id) };
  });
}
