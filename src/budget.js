// Run budgets: caps on agents, adjudicator rulings, and final fix waves.
//
// makeIo wraps io.agent so every spawn of the run goes through one place:
// it retries a dead agent (null result) once, counts agents and rulings in
// state ({agents, rulings, refused}), and refuses calls past the limits of
// effectiveLimits(m). A refused call spawns nothing and returns the sentinel
// {__budget: true}; callers read it as a blocked or invalid result, and
// runAll stops the run with reason budget. Once one call is refused every
// later call is refused too, so no new agent starts while the ones in flight
// finish. The other io members pass through unchanged.
function makeIo(m, baseIo, state) {
  const limits = effectiveLimits(m);
  const refuse = (label) => {
    state.refused.push(label);
    baseIo.log(`parallel-lanes: budget exhausted: ${label} was not run`);
    return { __budget: true };
  };
  const spawn = (prompt, opts) => {
    const label = opts.label;
    if (state.refused.length > 0 || state.agents >= limits.max_agents) return refuse(label);
    const ruling = / adjudicate( retry)?$/.test(label);
    if (ruling && state.rulings >= limits.max_rulings) return refuse(label);
    // Only calls that run count: state.rulings is the adjudications spent.
    if (ruling) state.rulings += 1;
    state.agents += 1;
    return baseIo.agent(prompt, opts);
  };
  return {
    ...baseIo,
    agent: async (prompt, opts) => {
      const r = await spawn(prompt, opts);
      if (r !== null && r !== undefined) return r;
      return spawn(prompt, { ...opts, label: `${opts.label} retry` });
    },
  };
}
