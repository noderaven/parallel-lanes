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
    'All files you write are plain ASCII. Never commit anything under .superpowers/.',
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

function statusSchema() {
  return {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['done', 'failed'] },
      head: { type: 'string' },
      notes: { type: 'string' },
    },
    required: ['status', 'head', 'notes'],
  };
}

function setupSchema() {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      discarded: { type: 'array', items: { type: 'string' } },
      worktrees: { type: 'array', items: { type: 'string' } },
      feature_head: { type: 'string' },
      notes: { type: 'string' },
    },
    required: ['ok', 'discarded', 'worktrees', 'feature_head', 'notes'],
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
    `   Feature worktree ${q(featureDir(m))}: if it does not exist, ${admin} worktree add ${q(featureDir(m))} ${branch}.`,
    '   If it exists (a resumed run) it must be on that branch; reuse it: list its uncommitted changes with',
    `   git -C ${q(featureDir(m))} status --porcelain, add each line to discarded as "${featureDir(m)}: <line>",`,
    `   then discard them with git -C ${q(featureDir(m))} reset --hard HEAD and git -C ${q(featureDir(m))} clean -fd`,
    '   (ignored scratch stays). This worktree is the run\'s own, never the project folder.',
  ] : [
    `Git mode: the main checkout is ${m.repo.root}.`,
    `1. git -C ${q(m.repo.root)} status --porcelain must print nothing; otherwise return ok false listing`,
    '   the changes (never discard work in the main checkout).',
    `   Create the feature branch if it does not exist: ${admin} branch ${branch} ${q(m.repo.base_ref)}`,
    `   Then check it out: git -C ${q(m.repo.root)} switch ${branch}`,
  ];
  // Profile lite: the lane works in the feature checkout, so there is no
  // lane worktree or branch; a lane setup override runs there too.
  const lite = m.profile === 'lite';
  const lanes = lite ? [
    '3. Profile lite: create no lane worktree and no lane branch;',
    ...m.lanes.map((lane) => `   lane ${lane.id} works in the feature checkout ${featureDir(m)} on ${m.repo.branch}.`),
  ] : [
    '3. Lane worktrees (create or reuse):',
    ...m.lanes.map((lane) => {
      const w = laneWhere(m, lane);
      const note = lane.setup_note ? `\n     Note: ${lane.setup_note}` : '';
      return `   - lane ${lane.id}: worktree ${q(w.dir)} on branch ${q(w.branch)}${note}`;
    }),
    '   For each: if the directory exists as a worktree on its branch, reuse it: list its uncommitted changes',
    '   with git -C <worktree> status --porcelain, add each line to discarded as "<worktree>: <line>", then',
    '   discard them with git -C <worktree> reset --hard HEAD (the branch stays on its commit; this is the',
    '   only reset allowed) and git -C <worktree> clean -fd (ignored scratch stays).',
    `   Else if the branch exists: ${admin} worktree add <worktree> <branch>.`,
    `   Else: ${admin} worktree add -b <branch> <worktree> ${branch}`,
    '   Do not remove any worktree or delete any branch.',
  ];
  const setupCmds = [`   - ${featureDir(m)}: ${commandList(m, null, 'setup')}`];
  for (const lane of m.lanes) {
    const cmds = commandList(m, lane.id, 'setup');
    if (!lite) setupCmds.push(`   - ${laneWhere(m, lane).dir}: ${cmds}`);
    else if (cmds !== commandList(m, null, 'setup')) setupCmds.push(`   - ${featureDir(m)} (lane ${lane.id}): ${cmds}`);
  }
  const branchCheck = lite ? ';' : ' and that each lane worktree prints its lane branch;';
  return [
    `You are the setup agent for parallel-lanes run ${m.run_id}.`,
    'Stop at the first step that fails and return ok false with the reason in notes.',
    '',
    ...feature,
    `2. ${admin} worktree prune (it only drops records of worktrees whose directory is gone).`,
    ...lanes,
    '4. Run the setup commands in each checkout (from that directory):',
    ...setupCmds,
    '',
    phaseRules(m, [
      'Your shell may start in another checkout of this repo, so never rely on the current directory:',
      `- every shell command starts with cd '<checkout>' && or uses git -C '<checkout>' (or ${admin});`,
      '- every project file path you read or write is absolute under the checkout it belongs to;',
      `- setup makes no commits; before step 4, check that git -C ${q(featureDir(m))} rev-parse --abbrev-ref HEAD`,
      `  prints ${m.repo.branch}${branchCheck} otherwise return ok false.`,
    ].join('\n')),
    '',
    'Return ok (true only when every step succeeded), discarded (the listed changes), worktrees (the paths',
    `ready for work), feature_head (the full sha printed by ${admin} rev-parse ${branch} after the steps), and`,
    'notes.',
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

function integratePrompt(m, preludeTip) {
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
  return [
    `You are the integration agent for parallel-lanes run ${m.run_id}.`,
    `Work in ${featureDir(m)} on the feature branch ${m.repo.branch}; do not switch branches.`,
    'Return status failed with the reason in notes at the first of steps 1-5 that fails.',
    '',
    `1. git -C ${dir} status --porcelain must print nothing (this is what clean means below; never make it`,
    '   so by deleting, cleaning, or stashing files).',
    '2. Merge each lane branch, in this order, with a merge commit whose message follows the commit rules:',
    ...merges,
    '   A branch that is already merged reports already up to date; that is fine. On a conflict, resolve it',
    '   keeping the intent of both lanes (read the plan tasks that touched the file) and commit the merge; if',
    '   you cannot resolve it with confidence, run git merge --abort and fail naming the files.',
    '3. In the tree step 1 found clean, rerun setup and then every command:',
    commandsText(m, null),
    ...overrides,
    '   Fix only small, obvious integration breakage (commit it per the commit rules); otherwise fail.',
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
    '6. Only when steps 1-5 passed, clean up each lane:',
    ...cleanup,
    '   Leave a worktree with uncommitted files (and its branch) in place and list it in notes; never',
    '   force a removal or a branch deletion. Cleanup never fails the integration: list anything step 6',
    '   could not remove in notes and still return status done.',
    '',
    `Plan: ${m.plan}`,
    keepFilesRule(),
    phaseRules(m),
    '',
    `Return status done or failed, head (the full sha printed by git -C ${dir} rev-parse HEAD when you finish),`,
    'and notes (merges, conflicts resolved, command results, cleanup).',
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
    keepFilesRule(),
    phaseRules(m),
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
    'Return items: one {item, result PASS or FAIL, evidence} per checklist item, evidence being the command',
    'and output or observation that decided it.',
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
    'Also scan every commit message in the range and the whole diff for anything the commit rules forbid,',
    'including AI tool or assistant names, co-author trailers, and comments that reveal AI involvement; report',
    'each as a finding (for a commit message use file "commit <sha>" and line 0).',
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
    'Findings:',
    findingsText(findings),
    '',
    'Fix each finding, or decline it with a reason (only for a false positive, an item outside this',
    "run's scope, or a commit-message finding: history is never rewritten). Rerun every project command",
    'afterwards:',
    commandsText(m, null),
    'Commit your fixes per the commit rules.',
    '',
    `Plan: ${m.plan}`,
    `Spec: ${m.spec === null ? '(none)' : m.spec}`,
    keepFilesRule(),
    phaseRules(m),
    '',
    implementResultText(featureDir(m)),
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
