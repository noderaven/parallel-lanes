// ---- Execution engine: per-task loop and lanes ----
//
// Every function below is pure over its parameters (no top-level const/let),
// so tests can load them with loadHelpers. The run functions take a trailing
// io object {agent, log} that defaults to the Workflow globals.

// Model and effort for a task review or re-review (spec D4): always Opus, at
// medium effort when the task is not security-flagged and the diff under
// review has fewer than 60 changed lines, else high. changedLines is the
// changed_lines the agent whose work is under review returned; a missing or
// malformed count means high.
function reviewSettings(task, changedLines) {
  const small = Number.isInteger(changedLines) && changedLines >= 0 && changedLines < 60;
  return { model: 'opus', effort: !task.security && small ? 'medium' : 'high' };
}

// A review or re-review result checked across its fields, not just its
// shape: an approve that carries a critical or important finding is acted on
// as changes (the gate never takes a self-contradicting approval; contradicted
// says so), and changes with no findings gives the fixer nothing to fix, so it
// is unusable (invalid says why). A budget sentinel or a missing result passes
// through as it is.
function checkedReview(v) {
  if (!v || v.__budget) return v;
  if (v.verdict !== 'approve' && v.verdict !== 'changes') return { ...v, invalid: `unknown verdict ${v.verdict}` };
  const findings = Array.isArray(v.findings) ? v.findings : [];
  if (v.verdict === 'approve' && findings.some(isBlocking)) {
    return { ...v, verdict: 'changes', findings, contradicted: true };
  }
  if (v.verdict === 'changes' && findings.length === 0) return { ...v, findings, invalid: 'changes with no findings' };
  return { ...v, findings };
}

// Run one task through implement -> review -> fix/re-review rounds. task may
// be a batch unit (batchUnit): its agents use the unit id in their labels
// (`<first>-<last> implement`), its prompts cover every task of the batch, and
// it is adjudicated as its first task.
// Tiers (spec D5): a sonnet or light task implements and fixes on its tier's
// settings and escalates to standard when an implement or fix does not
// finish (not on a question), a sonnet task also after the first changes
// verdict, a light task after the second; escalation reruns implement at
// standard from the current head with the open findings, then reviews the
// whole task range. Reviews use reviewSettings with the changed_lines of the
// implement or fix result under review.
// Returns {task, status:'done'|'deferred'|'blocked', base, head, rounds,
// tier_used, notes, rulings, next_note?}; for a blocked task notes is the reason (exactly
// 'review_rounds' at the cap in supervised mode, 'adjudication_cap', or
// 'adjudicator_stop: <condition>').
// base is owned by the script (the previous task's head, or the feature tip):
// every review range starts there, so commits of an earlier failed attempt
// are reviewed too. resume ({base, head}, optional) is a task committed in an
// earlier run but not reviewed: implement is skipped and the loop starts with
// the review of base..resume.head. note (optional) is carried from the
// lane's previous task (an adjudicator unblock).
//
// Autonomous mode (spec C1): where supervised mode stops the task (an
// implement or fix that does not finish, an implementer question, a review
// with no result, the review round cap), the adjudicator decides instead,
// at most twice per task. answer and clarify_plan rerun implement with the
// ruling as a note or a brief amendment, then review the whole task range;
// park and unblock end the task as deferred, never done: the range is the
// one the adjudicator recorded from git (finish-task --settled, its head
// returned), which keeps commits a blocked agent made attributed to this task;
// a deferred task keeps the run from being accepted. stop blocks the task.
// rulings lists each ruling text. A security-flagged task is never parked or
// unblocked (deferring a security requirement is the user's call, whatever
// the findings say): it stops with 'adjudicator_stop: security'. With
// allow_deferral false no task is: 'adjudicator_stop: deferral_not_allowed'.
async function runTask(m, task, where, base, io = { agent, log }, resume = null, note = null) {
  const phaseName = lanePhase(m, where.lane);
  const autonomous = effectiveAutonomy(m) === 'autonomous';
  let tierUsed = task.tier;
  let head = null;
  // Where an agent that did not finish left the branch (its reported head):
  // separate from head, the accepted implementation.
  let observed = null;
  let rounds = 0;
  let changesSeen = 0;
  let latest = null;
  let verdict = null;
  let adjudications = 0;
  // The latest review approved with a blocking finding (checkedReview): the
  // next fix reopens any approval it recorded.
  let reopen = false;
  const extra = [];
  const rulings = [];
  const guidance = { notes: note ? [note] : [], amendments: [] };

  const result = (status, notes, more = {}) =>
    ({ task: task.id, status, base, head, rounds, tier_used: tierUsed, notes, rulings, ...more });
  const call = (role, prompt, settings, schema) =>
    io.agent(prompt, { label: `${task.id} ${role}`, phase: phaseName, schema, ...settings });
  const escalate = (reason) => {
    tierUsed = 'standard';
    extra.push(`escalated to standard: ${reason}`);
    io.log(`${task.id}: escalating to standard (${reason})`);
  };
  // Why an implement or fix result did not move the branch past from, as
  // {kind: 'budget'|'blocked'|'question', reason}; null when it did. A budget
  // refusal (the sentinel the run budget returns once the agent cap is hit)
  // ends the task without adjudication: no agent can be spawned to settle it.
  // In supervised mode a question is just a blocked result.
  const failure = (r, label, from) => {
    const blockedBy = (reason) => ({ kind: 'blocked', reason });
    if (r && r.__budget) return { kind: 'budget', reason: `${label} was not run` };
    if (r === null || r === undefined) return blockedBy(`no result from ${label}`);
    if (r.status === 'question') {
      const q = present(r.question) ? r.question : (present(r.notes) ? r.notes : '(no question text)');
      return { kind: autonomous ? 'question' : 'blocked', reason: `${label} asked a question: ${q}` };
    }
    if (r.status !== 'done') return blockedBy(`${label} blocked: ${r.notes}`);
    if (!present(r.head)) return blockedBy(`${label} reported no head`);
    if (r.head === from) return blockedBy(`${label} reported done with no new commits`);
    return null;
  };
  // A sonnet or light task escalates on a failure, except on a question it
  // can have answered by the adjudicator instead.
  const escalates = (fail) => tierUsed !== 'standard' && fail.kind !== 'question' && fail.kind !== 'budget';
  // Implement, escalating a sonnet or light task once if it does not finish. from
  // (optional) is the head the result must move past; it defaults to the
  // current head (or base before the first commit).
  const implement = async (retry, from = null) => {
    for (;;) {
      const past = from !== null ? from : (head === null ? base : head);
      const r = await call('implement', implementPrompt(m, task, where, base, retry, guidance),
        tierSettings(tierUsed), implementSchema());
      const fail = failure(r, `${task.id} implement`, past);
      if (fail === null) {
        head = r.head;
        observed = null;
        latest = r;
        return null;
      }
      if (r && !r.__budget && present(r.head) && r.head !== past) observed = r.head;
      if (!escalates(fail)) return fail;
      escalate(fail.reason);
      retry = { reason: fail.reason, findings: null };
    }
  };
  let reviewLabel = 'review';
  const review = async () => {
    reviewLabel = 'review';
    return checkedReview(await call('review', reviewPrompt(m, task, where, base, head, rounds, guidance),
      reviewSettings(task, latest.changed_lines), reviewSchema()));
  };

  // Escalate a sonnet or light task: rerun implement at standard from the
  // current head with the open findings, then review the whole task range
  // again.
  const rerunAtStandard = async (reason, findings) => {
    escalate(reason);
    const fail = await implement({ reason, findings });
    if (fail !== null) return fail;
    verdict = await review();
    return null;
  };

  // The notes of a completed task: escalations, the latest implementer
  // notes, then more.
  const doneNotes = (more) => {
    const notes = [...extra];
    if (latest && latest.notes) notes.push(latest.notes);
    return [...notes, ...more].join('\n');
  };

  // Parking or unblocking defers the task's requirements. A security task's
  // are never deferred by the adjudicator, and allow_deferral false means no
  // task's are: the reason, or null when deferral is open.
  const deferralRefused = () => {
    if (unitTasks(task).some((t) => t.security === true)) return 'security';
    if (m.allow_deferral === false) return 'deferral_not_allowed';
    return null;
  };

  // What the adjudicator is told about the task: the diff range (including
  // commits an agent that did not finish left), the report file, the reason
  // or question, and the finish-task --settled command a park or unblock
  // runs (it records the range git has and prints its head, which the
  // adjudicator returns). For a batch, the tasks it covers come first and the
  // command names every task. With deferral refused there is no command.
  const details = (need) => {
    const at = observed !== null ? observed : head;
    const lines = [
      ...(isBatch(task) ? [`Batch ${task.id}: tasks ${unitTasks(task).map((t) => t.id).join(', ')} run as one ` +
        'unit (one implementer, one review over the combined range); your outcome applies to all of them.'] : []),
      `Diff range: ${at === null ? `${base} (no commits reported yet; check the checkout)` : `${base}..${at}`}`,
      `Implementer report file: ${taskFiles(m, task).report}`,
      `${need.kind === 'question' ? 'Question' : 'Reason'}: ${need.reason}`,
    ];
    const refused = deferralRefused();
    if (refused === null) {
      for (const outcome of ['park', 'unblock']) {
        lines.push(`For outcome ${outcome}, run this command; it records the task as deferred (never accepted) with`,
          'the range git has, and prints JSON whose head you return as head:',
          `  ${finishCommand(m, task, where, base, outcome)}`);
      }
    } else {
      lines.push(refused === 'security'
        ? 'This task is security-flagged: park and unblock are not available; a deferral is the user\'s decision.'
        : 'Deferral is not allowed in this run (allow_deferral false): park and unblock are not available.');
    }
    return lines.join('\n');
  };

  // A point where the task cannot go on by itself: need = {kind, reason,
  // findings}. Returns the task result when the task ends here, or null
  // when the adjudicator's answer or amendment is in guidance and implement
  // should rerun. Only a valid ruling is listed in rulings (not an agent
  // error, an invalid result, or a budget refusal).
  const settle = async (need) => {
    if (!autonomous) return result('blocked', need.kind === 'round_cap' ? 'review_rounds' : need.reason);
    if (adjudications >= 2) return result('blocked', 'adjudication_cap');
    adjudications += 1;
    const findings = need.findings || [];
    // A batch is adjudicated as its first task.
    let out = await adjudicate(m,
      { kind: need.kind, task: unitTasks(task)[0], where, details: details(need), findings }, io);
    const deferring = out.outcome === 'park' || out.outcome === 'unblock';
    const refused = deferring ? deferralRefused() : null;
    // An open park or unblock must say where the settled range ends: the head
    // finish-task --settled printed. Without it the range is unknown, so the
    // result is invalid (a plan_broken stop that is not a ruling).
    if (deferring && refused === null && !present(out.head)) {
      out = { outcome: 'stop', stop_condition: 'plan_broken', invalid: true,
        text: 'adjudicator chose park or unblock without the settled head (if it ran the settled command, '
          + 'the ledger holds the task as deferred: check ledger status before resuming)' };
    }
    // A park or unblock the policy refuses never took effect, so it is listed
    // as refused, not as a ruling made on the user's behalf.
    if (!out.unavailable && !out.invalid) {
      rulings.push(refused === 'security' ? `refused (security-gated): ${out.text}`
        : refused !== null ? `refused (${refused}): ${out.text}` : out.text);
    }
    io.log(`${task.id}: adjudicated ${need.kind} -> ${out.outcome}`);
    if (out.outcome === 'stop') {
      return result('blocked', out.unavailable ? out.text : `adjudicator_stop: ${out.stop_condition}`);
    }
    if (refused !== null) {
      io.log(`${task.id}: ${out.outcome} refused (${refused})`);
      return result('blocked', `adjudicator_stop: ${refused}`);
    }
    if (deferring) {
      // The range finish-task --settled recorded: its head, read from git.
      head = out.head;
      const verb = out.outcome === 'park' ? 'parked' : 'unblocked';
      const notes = doneNotes([
        `deferred, not accepted: ${verb} (${need.kind}): ${need.reason}`,
        `adjudicator: ${out.text}`,
        ...findings.map((f) => `deferred finding [${f.severity}]: ${f.file}:${f.line} - ${f.issue}`),
      ]);
      return result('deferred', notes, out.outcome === 'unblock' ? { next_note: out.text } : {});
    }
    if (out.outcome === 'answer') guidance.notes.push(out.text);
    else guidance.amendments.push(out.text);
    if (need.kind === 'round_cap') rounds = 0;
    return null;
  };

  let need = null;
  if (resume) {
    head = resume.head;
    latest = { status: 'done', head, tests: '(committed in an earlier run)', notes: '' };
    verdict = await review();
  } else {
    const fail = await implement(null);
    if (fail !== null) need = { ...fail, findings: null };
    else verdict = await review();
  }
  // The findings the latest review or re-review was verifying.
  let open = null;
  for (;;) {
    if (need !== null) {
      if (need.kind === 'budget') return result('blocked', need.reason);
      const ended = await settle(need);
      if (ended !== null) return ended;
      // A rerun after an adjudication only has to leave a non-empty task
      // range: the work under review may already be right.
      const fail = await implement({ reason: need.reason, findings: need.findings }, base);
      if (fail !== null) {
        need = { ...fail, findings: need.findings };
        continue;
      }
      need = null;
      verdict = await review();
    }
    if (verdict && verdict.__budget) {
      need = { kind: 'budget', reason: `${task.id} ${reviewLabel} was not run` };
      continue;
    }
    if (!verdict || verdict.invalid) {
      const why = verdict ? `invalid result from ${task.id} ${reviewLabel}: ${verdict.invalid}`
        : `no result from ${task.id} ${reviewLabel}`;
      need = { kind: 'blocked', reason: why, findings: open };
      continue;
    }
    if (verdict.contradicted) {
      io.log(`${task.id}: ${reviewLabel} approved with a critical or important finding; acting on it as changes`);
      reopen = true;
    }
    if (verdict.verdict === 'approve') break;
    changesSeen += 1;
    const findings = verdict.findings;
    open = findings;
    const escalateAfter = { sonnet: 1, light: 2 }[tierUsed];
    if (changesSeen === escalateAfter) {
      const reason = escalateAfter === 1 ? 'review requested changes' : 'review requested changes twice';
      const fail = await rerunAtStandard(reason, findings);
      if (fail !== null) need = { ...fail, findings };
      continue;
    }
    if (rounds >= m.limits.review_rounds) {
      const reason = `the review round cap (${rounds} fix rounds) tripped with findings open`;
      need = { kind: 'round_cap', reason, findings };
      continue;
    }
    rounds += 1;
    const fixLabel = `fix ${rounds}`;
    const fix = await call(fixLabel, fixPrompt(m, task, where, findings, latest, head, guidance, reopen),
      tierSettings(tierUsed), implementSchema());
    reopen = false;
    let fail = failure(fix, `${task.id} ${fixLabel}`, head);
    if (fail !== null && fix && !fix.__budget && present(fix.head) && fix.head !== head) observed = fix.head;
    if (fail !== null && escalates(fail)) fail = await rerunAtStandard(fail.reason, findings);
    else if (fail === null) {
      const prevHead = head;
      head = fix.head;
      latest = fix;
      reviewLabel = `re-review ${rounds}`;
      verdict = checkedReview(await call(reviewLabel,
        reReviewPrompt(m, task, where, prevHead, head, findings, rounds, guidance),
        reviewSettings(task, fix.changed_lines), reviewSchema()));
    }
    if (fail !== null) need = { ...fail, findings };
  }

  const notes = [];
  for (const f of verdict.findings || []) notes.push(`${f.severity} finding: ${f.file}:${f.line} - ${f.issue}`);
  for (const item of verdict.cannot_verify || []) notes.push(`cannot verify: ${item}`);
  return result('done', doneNotes(notes));
}

// One batch unit (spec D3) for consecutive light tasks with the same batch
// key: id '<first>-<last>', run on the light tier.
function batchUnit(tasks) {
  const first = tasks[0];
  return {
    id: `${first.id}-${tasks[tasks.length - 1].id}`,
    title: `batch of ${tasks.map((t) => t.id).join(', ')}`,
    files: tasks.flatMap((t) => t.files),
    tier: 'light',
    security: false,
    batch: first.batch,
    tasks,
  };
}

// The tasks that run as one unit starting at tasks[i]: tasks[i] and the
// tasks right after it with the same batch key and state, when that state
// is run, or review with an identical backfill range (a batch committed in
// an earlier run). Otherwise (no key, skip state, review without a range,
// or no matching neighbour) tasks[i] alone.
function batchGroup(m, tasks, i) {
  const first = tasks[i];
  const state = taskState(m, first.id);
  const backfill = m.backfill || {};
  const range = backfill[first.id];
  if (!present(first.batch) || state === 'skip' || (state === 'review' && !range)) return [first];
  const joins = (t) => {
    if (t.batch !== first.batch || taskState(m, t.id) !== state) return false;
    if (state === 'run') return true;
    const r = backfill[t.id];
    return Boolean(r) && r.base === range.base && r.head === range.head;
  };
  let j = i + 1;
  while (j < tasks.length && joins(tasks[j])) j += 1;
  return tasks.slice(i, j);
}

// Run tasks in order at where, starting from base; skip done-and-reviewed
// tasks, review done-only tasks first; stop at the first task that is not
// done. Each task's base is the previous task's head (a skipped task's from
// its backfill entry); a note an unblocked task carries goes to the next task
// that runs. Returns {results, stopped:reason|null, head} where head
// is the last known head (base when no task moved it).
// Batches (batchGroup) run as one unit through runTask; a finished batch
// gives each of its tasks a result with the batch range and batch: unit id,
// and a batch that is not done stops the list at its first task.
// baseIsPhaseTip: base is a head a phase agent reported (setup's feature head,
// the integrate or post-integrate head). On a resume that tip can already sit
// at or past this list's commits, so a done but unreviewed task that no
// earlier task in the list precedes is reviewed on its backfill range instead.
async function runTaskList(m, tasks, where, base, io, name, baseIsPhaseTip = false) {
  const results = [];
  let prev = base;
  let prevIsPhaseTip = baseIsPhaseTip;
  // Notes unblocked tasks carry, by the task id they go to: the later tasks
  // of the list that declare a dependency on the unblocked task, else the
  // next task (a plan without depends_on).
  const carried = new Map();
  const carry = (unit, i, text) => {
    const ids = unitTasks(unit).map((t) => t.id);
    const later = tasks.slice(i);
    const dependents = later.filter((t) => (t.depends_on || []).some((d) => ids.includes(d.id)));
    for (const t of dependents.length > 0 ? dependents : later.slice(0, 1)) {
      carried.set(t.id, [...(carried.get(t.id) || []), `from ${unit.id}, unblocked by the adjudicator: ${text}`]);
    }
  };
  for (let i = 0; i < tasks.length;) {
    const group = batchGroup(m, tasks, i);
    i += group.length;
    const task = group[0];
    const state = taskState(m, task.id);
    const range = (m.backfill || {})[task.id];
    if (state === 'skip') {
      results.push({
        task: task.id, status: 'skipped', base: range ? range.base : null, head: range ? range.head : null,
        rounds: null, tier_used: null, notes: '', rulings: [],
      });
      if (range) {
        prev = range.head;
        prevIsPhaseTip = false;
      }
      continue;
    }
    const unit = group.length > 1 ? batchUnit(group) : task;
    const taskBase = state === 'review' && range && prevIsPhaseTip ? range.base : prev;
    const r = state === 'review' && !range
      ? {
        task: task.id, status: 'blocked', base: prev, head: null, rounds: 0, tier_used: task.tier,
        notes: 'done but not reviewed, and no backfill commits', rulings: [],
      }
      : await runTask(m, unit, where, taskBase, io, state === 'review' ? range : null,
        unitTasks(unit).flatMap((t) => carried.get(t.id) || []).join('\n') || null);
    if (r.next_note) carry(unit, i, r.next_note);
    const finished = r.status === 'done' || r.status === 'deferred';
    if (unit === task) results.push(r);
    else if (finished) for (const t of group) results.push({ ...r, task: t.id, batch: unit.id });
    else results.push({ ...r, task: task.id, batch: unit.id });
    if (!finished) {
      io.log(`${name}: stopped at ${task.id} (${r.notes})`);
      return { results, stopped: r.notes, head: prev };
    }
    prev = r.head;
    prevIsPhaseTip = false;
  }
  return { results, stopped: null, head: prev };
}

// Run a lane's tasks in order in its worktree, the first from base (the
// feature tip the lane fast-forwards to); stop at the first task that is not
// done. Returns {lane, results, stopped:reason|null, head}.
async function runLane(m, lane, base, io = { agent, log }) {
  const r = await runTaskList(m, lane.tasks, laneWhere(m, lane), base, io, lane.name);
  return { lane: lane.id, ...r };
}

// Run lanes with at most limits.max_parallel_lanes in flight (a promise
// pool); results come back in lane order. A lane that throws stops only
// itself. base is the feature tip every lane starts from.
async function runLanes(m, lanes, base, io = { agent, log }) {
  const results = new Array(lanes.length);
  let next = 0;
  const worker = async () => {
    while (next < lanes.length) {
      const i = next;
      next += 1;
      try {
        results[i] = await runLane(m, lanes[i], base, io);
      } catch (e) {
        results[i] = { lane: lanes[i].id, results: [], stopped: `error: ${e && e.message}`, head: base };
      }
    }
  };
  const width = Math.min(m.limits.max_parallel_lanes, lanes.length);
  const workers = [];
  for (let w = 0; w < width; w += 1) workers.push(worker());
  await Promise.all(workers);
  return results;
}
