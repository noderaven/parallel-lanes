// git invocation that administers branches and worktrees for the run.
function gitAdmin(m) {
  return m.repo.mode === 'shadow'
    ? `git --git-dir=${shellQuote(m.repo.git_dir)}`
    : `git -C ${shellQuote(m.repo.root)}`;
}

// Rules every phase agent gets. checkout (optional) replaces the checkout
// rules for the feature checkout (setup works in several checkouts).
function phaseRules(m, checkout = null) {
  return [
    `Commit rules (follow exactly): ${m.commit_rules}`,
    'Never commit anything under .superpowers/.',
    `Never push, open pull requests, merge into ${m.repo.base_ref}, or copy work back to the project folder.`,
    agentRules(),
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
function statusSchema() {
  return {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['done', 'failed'] },
      head: { type: 'string' },
      notes: { type: 'string' },
      conflict_files: { type: 'array', items: { type: 'string' } },
      tests_failed: { type: 'boolean' },
    },
    required: ['status', 'head', 'notes'],
  };
}

function preflightSchema() {
  return {
    type: 'object',
    properties: {
      conflicts: { type: 'array', items: { type: 'string' } },
      rulings: { type: 'array', items: { type: 'string' } },
      undeclared: {
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
      },
    },
    required: ['conflicts', 'rulings', 'undeclared'],
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
          },
          required: ['id', 'status', 'reason'],
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
    required: ['results', 'new_findings'],
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
          },
          required: ['group', 'command', 'exit'],
        },
      },
      ok: { type: 'boolean' },
      clean: { type: 'boolean' },
    },
    required: ['head', 'results', 'ok'],
  };
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
    '4. Undeclared dependencies: a task in a lane that relies on something a task in another',
    '   lane or in the prelude produces (a function, a file format, markup, an API answer)',
    '   without naming that task in its Consumes. Return each in undeclared as',
    '   {task, producer, what}, what in one sentence.',
    'Report serious problems (implementers would build the wrong thing, or a check above fails) as conflicts,',
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
  const overrides = m.lanes
    .filter((lane) => m.lane_commands && m.lane_commands[lane.id])
    .map((lane) => `Lane ${lane.id} commands (with its overrides; run these too):\n${commandsText(m, lane.id, featureDir(m))}`);
  const cleanup = m.lanes.map((lane) => {
    const w = laneWhere(m, lane);
    return `   - ${q(w.dir)}: if git -C ${q(w.dir)} status --porcelain prints nothing, ` +
      `${admin} worktree remove ${q(w.dir)} then git -C ${dir} branch -d ${q(w.branch)}`;
  });
  const joinIds = m.join.length > 0 ? m.join.map((t) => t.id).join(', ') : '(none)';
  // Every join task committed in an earlier attempt: a final fix of that
  // attempt may have committed after the last join commit.
  const lastJoin = m.join.length > 0 ? (m.backfill || {})[m.join[m.join.length - 1].id] : null;
  const joinDone = Boolean(lastJoin) && m.join.every((t) => m.done.includes(t.id));
  const finalFixes = joinDone ? [
    '   Every join task was committed earlier in this run, so final-fix commits from an earlier attempt of',
    `   this run may follow the last join commit ${lastJoin.head}: allow any commits after it.`,
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
      ? ', and tests_failed (true when a project command still fails after the merges).'
      : '.';
  const overlaps = Array.isArray(m.overlaps) && m.overlaps.length > 0 ? [
    '   Deliberate overlaps (more than one lane changes these files by plan; a merge conflict in them is expected):',
    ...m.overlaps.map((o) => `   - ${o.file}: tasks ${o.tasks.join(', ')}; on a conflict keep both changes, and where they`
      + ` cannot both stand keep task ${o.merge_owner}'s. Why: ${o.reason}`),
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
    `1. git -C ${dir} status --porcelain must print nothing (this is what clean means below; never make it`,
    '   so by deleting, cleaning, or stashing files).',
    '2. Merge each lane branch, in this order, with a merge commit whose message follows the commit rules:',
    ...merges,
    ...conflictLine,
    ...overlaps,
    ...deletedBranch,
    '3. In the tree step 1 found clean, rerun setup and then every command:',
    commandsText(m, null, featureDir(m)),
    ...overrides,
    testFailureLine,
    `4. History: ${preludeTip} is the feature tip after the prelude. This command:`,
    `   git -C ${dir} log --first-parent --format='%H %P %s' ${q(`${preludeTip}..HEAD`)}`,
    '   may list only merges (two parents) of the lane branches above, integration or post-integration fix',
    '   commits (yours, or from an earlier attempt in this run), and commits an earlier attempt at a join task',
    `   made (join tasks: ${joinIds}; their recorded commits are in ${m.repo.ledger_dir}/join.jsonl).`,
    ...finalFixes,
    "   Any other commit landed on the feature branch outside the run's steps: fail listing it (do not",
    '   rewrite history).',
    `5. Committed scratch: git -C ${dir} diff --name-only ${q(`${m.repo.base_ref}...${m.repo.branch}`)}`,
    '   must list no path under .superpowers/; if it does, fail listing them (do not rewrite history).',
    ...(testFailure === 'heal' ? [
      '6. Only when steps 1-5 passed and you return tests_failed false (every project command passes), clean',
      '   up each lane. When you return tests_failed true, skip this step entirely: a fix agent and a rerun of',
      '   these steps follow, and the rerun cleans up. Cleanup:',
    ] : ['6. Only when steps 1-5 passed, clean up each lane:']),
    ...cleanup,
    '   Leave a worktree with uncommitted files (and its branch) in place and list it in notes; never',
    '   force a removal or a branch deletion. Cleanup never fails the integration: list anything step 6',
    '   could not remove in notes and still return status done.',
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
    `1. git -C ${dir} status --porcelain must print nothing; otherwise return status failed (never make it so`,
    '   by deleting, cleaning, or stashing files).',
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

// Opus fix (autonomous, C2) for a project command (or the post-integration
// check) still failing on the feature branch after integration. failure is
// the notes the failing step returned.
function postIntegrateFixPrompt(m, failure) {
  const dir = shellQuote(featureDir(m));
  return [
    `You are fixing a post-integration failure for parallel-lanes run ${m.run_id}.`,
    `Work in ${featureDir(m)} on ${m.repo.branch}; do not switch branches.`,
    'What is failing:',
    failure,
    '',
    'Find the cause, fix it with the smallest change that is correct, and commit per the commit rules.',
    'Rerun every project command afterwards and confirm they pass:',
    commandsText(m, null, featureDir(m)),
    m.hooks.post_integrate ? `Post-integration check to keep passing:\n${m.hooks.post_integrate}` : '',
    '',
    `Plan: ${m.plan}`,
    `Spec: ${m.spec === null ? '(none)' : m.spec}`,
    keepFilesRule(),
    phaseRules(m),
    '',
    `Return status done when the commands pass, otherwise failed; head = the full sha printed by`,
    `git -C ${dir} rev-parse HEAD when you finish; notes = what you changed and the command results.`,
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
    phaseRules(m),
    '',
    'Return findings = [{severity ("critical", "important", or "minor"), file, line, issue, fix}], every',
    'problem you found (empty when the fix is sound).',
  ].join('\n');
}

// checkOnly: a recheck at the delivered revision after later commits; the
// agent verifies only and changes nothing.
function postIntegratePrompt(m, checkOnly = false) {
  const change = checkOnly ? [
    'This is a recheck of the delivered revision: verify only. Change no file, make no commit, and do not',
    'record a start point; if the instructions would need a change, return status failed naming it.',
  ] : [
    'Change files only if the instructions call for it; commit any change per the commit rules and rerun',
    'the project commands afterwards:',
    commandsText(m, null, featureDir(m)),
  ];
  return [
    `You are the post-integration agent for parallel-lanes run ${m.run_id}.`,
    `The lanes are merged into ${m.repo.branch} in ${featureDir(m)}; work there and do not switch branches.`,
    'Follow these project instructions:',
    m.hooks.post_integrate,
    '',
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

// A final reviewer's prompt around its focus text: read-only, the whole
// branch range, the commit-rules scan, and the findings/head result.
function finalReviewFrame(m, intro, focus) {
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
    'Also scan every commit message in the range and the whole diff for anything the commit rules forbid;',
    'report each as a finding (for a commit message use file "commit <sha>" and line 0).',
    phaseRules(m),
    '',
    'Return findings = [{severity ("critical", "important", or "minor"), file, line (0 when no single line',
    'applies), issue, fix}], cannot_verify = what you could not verify, and head = the full sha printed by',
    `git -C ${dir} rev-parse HEAD (a read-only command you may run).`,
  ].join('\n');
}

function finalReviewPrompt(m, lens, e2e) {
  return finalReviewFrame(m, 'You are a final reviewer', finalLensFocus(m, lens, e2e));
}

// Profile lite: one reviewer covers the three lenses of the full profile.
// ctx = {e2e}: the e2e result, or null without an e2e hook.
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
  return finalReviewFrame(m, 'You are the final reviewer', focus);
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
    'decline. Rerun every project command afterwards:',
    commandsText(m, null, featureDir(m)),
    'Commit your fixes per the commit rules.',
    '',
    `Plan: ${m.plan}`,
    `Spec: ${m.spec === null ? '(none)' : m.spec}`,
    keepFilesRule(),
    phaseRules(m),
    '',
    implementResultText(featureDir(m), false, base),
    'Also return dispositions = one {id, status "fixed" or "declined", reason} for every finding id above (reason:',
    'what you changed, or why you declined it). A finding without a disposition counts as not addressed.',
  ].join('\n');
}

// findings carry their id and the fixer's disposition ({status, reason}, or
// none when the fixer gave none).
function finalReReviewPrompt(m, base, head, findings) {
  const dir = shellQuote(featureDir(m));
  const said = (f) => (f.disposition
    ? `   fixer: ${f.disposition.status} - ${f.disposition.reason}`
    : '   fixer: no disposition (treat it as not addressed unless the defect is verifiably gone)');
  return [
    `You are re-reviewing the final fixes for parallel-lanes run ${m.run_id} (fix range ${base}..${head}`
      + `${base === head ? ', no fix commits' : ''}).`,
    'You are read-only: never modify the checkout, the index, HEAD, or any branch.',
    'Read the fix with:',
    `  git -C ${dir} log ${shellQuote(`${base}..${head}`)}`,
    `  git -C ${dir} diff ${shellQuote(`${base}..${head}`)}`,
    'Findings under verification, with what the fixer said about each:',
    findings.map((f) => `${findingsText([f])}\n${said(f)}`).join('\n'),
    '',
    'For every id above decide at the current head: resolved (the defect no longer exists, or the decline is',
    'right: a false positive, out of scope, or a commit message) or open; cite file:line evidence. Judge the',
    'defect, not its wording or line: a defect that moved or was reworded is still the same finding. Then',
    'check the fix for new critical or important problems; do not re-review code the fix did not touch.',
    phaseRules(m),
    '',
    'Return results = one {id, status "resolved" or "open", evidence} per id above (an id you leave out counts',
    'as open), and new_findings = the new problems, each {severity, file, line, issue, fix}.',
  ].join('\n');
}

// The verify step: every project check at the delivered revision, through
// scripts/run-checks, whose JSON the agent returns as it printed it.
function verifyPrompt(m, sha) {
  const dir = featureDir(m);
  const cmd = checksCommand(m, null, dir, `${m.repo.ledger_dir}/checks/verify-${sha}.json`);
  return [
    `You are the verifier for parallel-lanes run ${m.run_id}: run the project checks at the delivered revision.`,
    `Work in ${dir} on ${m.repo.branch}; do not switch branches, change files, or commit.`,
    `1. git -C ${shellQuote(dir)} rev-parse HEAD must print ${sha}; if it does not, return its output as head`,
    '   with results [] and ok false.',
    `2. Run the project's setup commands first: ${commandList(m, null, 'setup')}`,
    `3. Run, as one call: ${cmd}`,
    '',
    keepFilesRule(),
    phaseRules(m),
    '',
    'Return exactly the JSON fields run-checks printed: checkout, branch, head, results, ok, clean.',
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
