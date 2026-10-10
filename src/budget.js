// Run budgets: caps on agents, adjudicator rulings, and final fix waves.
//
// makeIo wraps io.agent so every spawn of the run goes through one place:
// it retries a dead agent (null result) once, counts agents and rulings in
// state ({agents, rulings, refused, spawned?, untyped?, typedNulls?}),
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
function makeIo(m, baseIo, state) {
  const limits = effectiveLimits(m);
  const refuse = (label) => {
    state.refused.push(label);
    baseIo.log(`parallel-lanes: budget exhausted: ${label} was not run`);
    return { __budget: true };
  };
  const isRuling = (label) => / adjudicate( retry)?$/.test(label);
  const spawn = (prompt, given) => {
    const { overBudget, ...opts } = given;
    const label = opts.label;
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
    return baseIo.agent(prompt, opts);
  };
  return {
    ...baseIo,
    agent: async (prompt, opts) => {
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
