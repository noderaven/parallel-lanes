// Run budgets: caps on agents, adjudicator rulings, and final fix waves.
//
// makeIo wraps io.agent so every spawn of the run goes through one place:
// it retries a dead agent (null result) once, counts agents and rulings in
// state ({agents, rulings, refused, untyped?}), and refuses calls past the
// limits of effectiveLimits(m). A refused call spawns nothing and returns the
// sentinel {__budget: true}; callers read it as a blocked or invalid result,
// and runAll stops the run with reason budget. Once one call is refused every
// later call is refused too, so no new agent starts while the ones in flight
// finish. The other io members pass through unchanged.
//
// Agent type: when agentTypeFor(m, label) names one, the spawn carries
// agentType. A typed spawn that throws started no agent (the definition is
// missing or broken), so its count is undone and it is retried once as
// "<label> retry" without agentType through the normal checks. It also sets
// the latch state.untyped (created on first use; missing means false): from
// then on every spawn of the run, in any lane, goes out untyped, so a broken
// definition costs one uncounted failure instead of doubling every agent and
// ruling. A typed spawn that returns null is a dead agent like any other:
// counted, retried untyped, latch untouched. Untyped spawns retry on null
// only; their throw propagates.
function makeIo(m, baseIo, state) {
  const limits = effectiveLimits(m);
  const refuse = (label) => {
    state.refused.push(label);
    baseIo.log(`parallel-lanes: budget exhausted: ${label} was not run`);
    return { __budget: true };
  };
  const isRuling = (label) => / adjudicate( retry)?$/.test(label);
  const spawn = (prompt, opts) => {
    const label = opts.label;
    if (state.refused.length > 0 || state.agents >= limits.max_agents) return refuse(label);
    const ruling = isRuling(label);
    if (ruling && state.rulings >= limits.max_rulings) return refuse(label);
    // Only calls that run count: state.rulings is the adjudications spent.
    if (ruling) state.rulings += 1;
    state.agents += 1;
    return baseIo.agent(prompt, opts);
  };
  return {
    ...baseIo,
    agent: async (prompt, opts) => {
      const retry = () => spawn(prompt, { ...opts, label: `${opts.label} retry` });
      const agentType = state.untyped ? null : agentTypeFor(m, opts.label);
      let r;
      if (agentType === null) {
        r = await spawn(prompt, opts);
      } else {
        try {
          r = await spawn(prompt, { ...opts, agentType });
        } catch (e) {
          // Only a started spawn throws, so the count it took is undone.
          state.agents -= 1;
          if (isRuling(opts.label)) state.rulings -= 1;
          state.untyped = true;
          baseIo.log(`parallel-lanes: ${opts.label} failed as agent type ${agentType}`
            + ` (${e && e.message ? e.message : e}); it and every later agent run on the default type`);
          return retry();
        }
      }
      if (r !== null && r !== undefined) return r;
      return retry();
    },
  };
}

// The custom agent type for a spawn: m.agent_type, except for the hook agents
// (e2e and post-integrate), whose instructions may need any tool.
function agentTypeFor(m, label) {
  if (typeof m.agent_type !== 'string' || m.agent_type.length === 0) return null;
  if (/^(e2e|post-integrate)( retry)?$/.test(label)) return null;
  return m.agent_type;
}
