// Run budgets: caps on agents, adjudicator rulings, and final fix waves.
//
// makeIo wraps io.agent so every spawn of the run goes through one place:
// it retries a dead agent (null result) once, counts agents and rulings in
// state ({agents, rulings, refused, spawned?, untyped?, typedNulls?,
// results?, unavailable?, unavailableInfo?}),
// records each agent it starts as {label, model, effort} in state.spawned
// (created on first use; in start order; refused calls add nothing), and
// refuses calls past the limits of effectiveLimits(m). A refused call spawns nothing and returns the
// sentinel {__budget: true}; callers read it as a blocked or invalid result,
// and runAll stops the run with reason budget. Once one call is refused every
// later call is refused too, so no new agent starts while the ones in flight
// finish. The one exception is a call with opts.overBudget (the verify agent:
// cheap, deterministic project checks after the last change): it runs and is
// counted even past the cap or after a refusal; the flag is not passed on.
// The other io members pass through unchanged.
//
// Agent type: when agentTypeFor(m, label) names one, the spawn carries
// agentType. A typed spawn that throws or returns null is retried once as
// "<label> retry" without agentType through the normal checks. Counting is
// the same as for any spawn: the failed typed spawn stays counted (it may
// have run before it failed), and the retry counts again. The latch
// state.untyped (created on first use; missing means false) then sends every
// later spawn of the run, in any lane, out untyped, so a missing or broken
// definition cannot double every agent: it is set by the first typed spawn
// that throws, and by the second typed spawn that returns null while its
// untyped retry returns a result (state.typedNulls counts those; one dead
// agent alone is not a sign of a broken type). runAll reports the latch as
// agent_type_fallback. Untyped spawns retry on null only; their throw
// propagates.
//
// Agents unavailable (spec 4.1): a dead pair is one call whose spawn and its
// automatic retry both returned null (a typed spawn that throws and whose
// untyped retry returns null is one too). While neither latched nor refused,
// a dead pair starts one availability probe: a direct spawn (no retry, no
// agent type) on the dead call's model and in its phase, at low effort,
// labelled 'availability probe', counted as an agent and
// never as a ruling; the probe of an overBudget call is overBudget too (it
// runs past the agent cap; a refusal still skips it). Concurrent dead pairs
// share the probe in flight. A probe
// that answers means the deaths were the task's own: the call returns null
// and a later dead pair probes again. A probe the budget refuses returns its
// budget sentinel, with no latch. A probe that returns null sets the latch:
// state.unavailable = true, state.unavailableInfo = {trigger, probe,
// results_before} (results_before is state.results at the latch), the
// trigger's label goes onto state.refused at once and the label of every call
// that shared the probe after it; those calls and every later spawn,
// overBudget included, return {__budget: true, __unavailable: true}. A dead
// pair seen once the latch is set (a retry that was in flight) returns null
// as before and probes nothing. A probe that throws is an untyped
// throw: it propagates. state.results (created on first use) counts the
// spawns that returned a result, the probe aside.
function makeIo(m, baseIo, state) {
  const limits = effectiveLimits(m);
  const PROBE_LABEL = 'availability probe';
  const refuse = (label) => {
    state.refused.push(label);
    baseIo.log(`parallel-lanes: budget exhausted: ${label} was not run`);
    return state.unavailable ? { __budget: true, __unavailable: true } : { __budget: true };
  };
  const isRuling = (label) => / adjudicate( retry)?$/.test(label);
  const spawn = async (prompt, given) => {
    const { overBudget, ...opts } = given;
    const label = opts.label;
    if (state.unavailable) return refuse(label);
    if (!overBudget && (state.refused.length > 0 || state.agents >= limits.max_agents)) return refuse(label);
    const ruling = isRuling(label);
    if (ruling && state.rulings >= limits.max_rulings) return refuse(label);
    // Only calls that run count: state.rulings is the adjudications spent.
    if (ruling) state.rulings += 1;
    state.agents += 1;
    if (!state.spawned) state.spawned = [];
    state.spawned.push({
      label,
      model: opts.model === undefined ? null : opts.model,
      effort: opts.effort === undefined ? null : opts.effort,
    });
    const r = await baseIo.agent(prompt, opts);
    if (r !== null && r !== undefined && label !== PROBE_LABEL) state.results = (state.results || 0) + 1;
    return r;
  };
  // The probe in flight, shared by concurrent dead pairs; cleared when the
  // probe answers or throws, kept once it returned null (the latch is set).
  let probing = null;
  const probeOnce = (dead) => {
    if (probing) return probing;
    const trigger = dead.label;
    const prompt = 'Availability check for a parallel-lanes run. Read no files and run no commands:'
      + ' reply only with {"ok": true}.';
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
    // In the dead call's phase, on its model; an overBudget call's probe is
    // overBudget too, so a verify past the agent cap still gets its answer.
    probing = spawn(prompt, {
      label: PROBE_LABEL,
      ...(dead.overBudget ? { overBudget: true } : {}),
      ...(dead.phase === undefined ? {} : { phase: dead.phase }),
      ...(dead.model === undefined ? {} : { model: dead.model }),
      effort: 'low',
      schema,
    }).then((p) => {
      if (p !== null && p !== undefined) {
        probing = null;
        return p;
      }
      state.unavailable = true;
      state.unavailableInfo = { trigger, probe: PROBE_LABEL, results_before: state.results || 0 };
      state.refused.push(trigger);
      baseIo.log(`parallel-lanes: agents unavailable: ${trigger} and its retry returned no result,`
        + ` and the ${PROBE_LABEL} did not answer; no further agents start`);
      return p;
    }, (e) => {
      probing = null;
      throw e;
    });
    return probing;
  };
  const afterDeadPair = async (opts, r) => {
    if (state.unavailable || state.refused.length > 0) return r;
    const shared = probing !== null;
    const p = await probeOnce(opts);
    if (p !== null && p !== undefined) return p.__budget ? p : r;
    // The latch pushed the trigger; a call that shared the probe adds its own.
    if (shared) state.refused.push(opts.label);
    return { __budget: true, __unavailable: true };
  };
  const call = async (prompt, opts) => {
    const retry = () => spawn(prompt, { ...opts, label: `${opts.label} retry` });
    const agentType = state.untyped ? null : agentTypeFor(m, opts.label);
    if (agentType === null) {
      const r = await spawn(prompt, opts);
      if (r !== null && r !== undefined) return r;
      return retry();
    }
    const fallBack = (why) => {
      if (!state.untyped) {
        baseIo.log(`parallel-lanes: ${opts.label} failed as agent type ${agentType} (${why});`
          + ' it and every later agent run on the default type');
      }
      state.untyped = true;
    };
    let r;
    try {
      r = await spawn(prompt, { ...opts, agentType });
    } catch (e) {
      fallBack(e && e.message ? e.message : String(e));
      return retry();
    }
    if (r !== null && r !== undefined) return r;
    const again = await retry();
    if (again !== null && again !== undefined && !(again && again.__budget)) {
      state.typedNulls = (state.typedNulls || 0) + 1;
      if (state.typedNulls >= 2) fallBack('a second typed agent returned no result and its untyped retry did');
    }
    return again;
  };
  return {
    ...baseIo,
    agent: async (prompt, opts) => {
      // Every null result has been retried once: a null here is a dead pair.
      const r = await call(prompt, opts);
      if (r !== null && r !== undefined) return r;
      return afterDeadPair(opts, r);
    },
  };
}

// The custom agent type for a spawn: m.agent_type, except for the hook agents
// (e2e and post-integrate, and their rechecks) and the post-integrate fix,
// which must keep the post-integrate hook passing: hook instructions may need
// any tool.
function agentTypeFor(m, label) {
  if (typeof m.agent_type !== 'string' || m.agent_type.length === 0) return null;
  if (/^(e2e|e2e recheck|post-integrate|post-integrate recheck|post-integrate fix)( retry)?$/.test(label)) return null;
  return m.agent_type;
}
