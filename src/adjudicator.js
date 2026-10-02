// Adjudicator: rulings that let a blocked task continue instead of stopping its lane.
//
// adjudicate(m, ctx, io) asks one Opus agent to settle a blocked task, an
// implementer question, a tripped review round cap, or pre-flight conflicts.
// ctx = {kind: 'blocked'|'question'|'round_cap'|'preflight', task|null,
// where: {dir, branch, lane}|null, details, findings}. The result is always a
// usable outcome object: a missing result is a stop marked unavailable (an
// agent error), and an invalid one (a budget refusal included) is a
// plan_broken stop marked invalid, never approval. Neither is a ruling.

function adjudicatorOutcomes() {
  return ['answer', 'clarify_plan', 'park', 'unblock', 'stop'];
}

function adjudicatorStopConditions() {
  return ['destructive', 'security', 'outside_side_effect', 'plan_broken'];
}

function adjudicatorSchema() {
  return {
    type: 'object',
    properties: {
      outcome: { type: 'string', enum: adjudicatorOutcomes() },
      text: { type: 'string' },
      stop_condition: { type: 'string', enum: adjudicatorStopConditions() },
    },
    required: ['outcome', 'text'],
  };
}

// What brought the work to adjudication, by ctx.kind.
function adjudicatorKindText(kind) {
  if (kind === 'blocked') return 'blocked: an implementer or fix agent could not finish the task';
  if (kind === 'question') return 'question: the implementer asked a question it needs answered to continue';
  if (kind === 'round_cap') return 'round_cap: the review round cap tripped with findings still open';
  if (kind === 'preflight') return 'preflight: the pre-flight check reported conflicts between tasks or lanes';
  return String(kind);
}

function adjudicatorPrompt(m, ctx) {
  const task = ctx.task || null;
  const where = ctx.where || null;
  const dir = where ? where.dir : featureDir(m);
  const branch = where ? where.branch : m.repo.branch;
  const lane = where ? where.lane : '_run';
  const ruling = ledgerCommand(m, lane,
    { task: task ? task.id : '_run', event: 'ruling', by: 'adjudicator', text: 'Ruling: <decision> - <why> - <cost if wrong>' },
    dir);
  const subject = task ? `Task ${task.id}: ${task.title}` : 'the run (pre-flight)';
  const parts = [
    `You are the adjudicator for ${subject}. The run is autonomous: the user is not available, and you decide`,
    'on their behalf so the work can continue instead of stopping. Choose the outcome that keeps the run moving',
    'safely; stop only for one of the four stop conditions below.',
    '',
    `Why you were called: ${adjudicatorKindText(ctx.kind)}`,
    ...(task && task.security === true ? [
      'This task is security-flagged. Parking or unblocking it while a critical or important finding is open is',
      'a security-sensitive decision: choose stop with stop_condition security for that (answer or clarify_plan',
      'remain open to you); a park or unblock in that case is treated as that stop.',
    ] : []),
    '',
    `Plan: ${m.plan}`,
    `Spec: ${m.spec === null ? '(none)' : m.spec}`,
    `Checkout: ${dir} (branch ${branch}).`,
    checkoutRules(dir, branch),
  ];
  if (task) {
    const files = taskFiles(m, task);
    const brief = `cd ${shellQuote(dir)} && python3 ${shellQuote(`${m.skill_dir}/scripts/task-brief`)} ` +
      `${shellQuote(m.plan)} ${shellQuote(task.id)} ${shellQuote(files.brief)}`;
    parts.push(
      `Task brief: ${files.brief}. Generate it from the current plan before reading it with:`,
      `  ${brief}`,
    );
  }
  parts.push(
    '',
    'Details (the diff range, the implementer report file, and the blocked reason or question, or the',
    'pre-flight conflicts):',
    ctx.details,
    '',
    'Open findings:',
    findingsText(ctx.findings),
    '',
    'Read the spec, the plan, the brief, the report, and the diff as you need them. You are read-only: never',
    'modify a worktree, the index, HEAD, or any branch. Writing the task brief and ledger lines (outside the',
    'repo) is allowed.',
    `Commit rules the task works under: ${m.commit_rules}`,
    agentRules(),
    '',
    'Outcomes (pick exactly one):',
    '- answer: your text answers the question or settles the blocker; it is given to the task as its note and',
    '  the task retries.',
    "- clarify_plan: your text is a ruling that amends the task's brief for this run only; the task retries.",
    '- park: the open findings are recorded as deferred and the task completes as it is.',
    '- unblock: your text is the smallest change that unblocks the dependent tasks; the task completes and the',
    '  text is carried to the next task.',
    '- stop: the lane stops and the user decides. Allowed only for these four stop conditions, named in',
    '  stop_condition:',
    '  - destructive: irreversible/destructive operation',
    '  - security: security-sensitive decision',
    "  - outside_side_effect: side effect outside the run's worktrees",
    '  - plan_broken: a plan so broken every path is a guess',
    'Anything else is not a reason to stop: answer, clarify, park, or unblock instead.',
    '',
    'Record your ruling, in the format `Ruling: decision - why - cost if wrong`, as a ledger ruling event with:',
    `  ${ruling}`,
    'Ledger entries are shell single-quoted JSON: fill the <...> placeholders and keep quote characters out of the text.',
    'If the details above name a ledger command for your outcome, run it too.',
    '',
    'Return a structured result: outcome (answer, clarify_plan, park, unblock, or stop); text = your ruling',
    'text for the task (the answer, the brief amendment, what is parked, the unblocking change, or why you',
    'stop); stop_condition (destructive, security, outside_side_effect, or plan_broken) only when outcome is',
    'stop. That result replaces any other output format.',
  );
  return parts.join('\n');
}

// A schema-valid adjudicator result reduced to its known fields, or null
// when it is not valid (a stop without a valid stop condition included).
function adjudicatorResult(r) {
  if (r === null || typeof r !== 'object' || Array.isArray(r)) return null;
  if (!adjudicatorOutcomes().includes(r.outcome) || typeof r.text !== 'string') return null;
  const hasCondition = r.stop_condition !== undefined;
  if (hasCondition && !adjudicatorStopConditions().includes(r.stop_condition)) return null;
  if (r.outcome !== 'stop') return { outcome: r.outcome, text: r.text };
  if (!hasCondition) return null;
  return { outcome: 'stop', text: r.text, stop_condition: r.stop_condition };
}

// One adjudication. Returns the outcome object; never null.
async function adjudicate(m, ctx, io = { agent, log }) {
  const label = ctx.task ? `${ctx.task.id} adjudicate` : 'run adjudicate';
  const phaseName = ctx.kind === 'preflight' || !ctx.where ? 'Pre-flight' : lanePhase(m, ctx.where.lane);
  const r = await io.agent(adjudicatorPrompt(m, ctx),
    { label, phase: phaseName, schema: adjudicatorSchema(), model: 'opus', effort: 'high' });
  if (r === null || r === undefined) {
    return { outcome: 'stop', text: `no result from ${label}`, stop_condition: 'plan_broken', unavailable: true };
  }
  const valid = adjudicatorResult(r);
  if (valid === null) {
    return {
      outcome: 'stop', text: 'adjudicator returned an invalid result', stop_condition: 'plan_broken', invalid: true,
    };
  }
  return valid;
}
