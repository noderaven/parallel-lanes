// ---- Join waves (1.6.5 design 4.1) ----
//
// In the launch that starts the join, join units whose dependencies allow it
// run side by side, each on its own branch in a lane worktree, and each wave
// is merged back before the next starts. scripts/_waves.py repeats the rule
// for setup's owner map and worth-it; tests/waves.test.mjs holds both to the
// fixtures in tests/fixtures/waves/cases.json.

// The branch a unit of a multi-unit wave runs on: pl-<run_id>-u-<unit id>.
// Lane ids may not start with u-, so no lane branch has this form.
function unitBranch(m, unit) {
  return `pl-${m.run_id}-u-${unit.id}`;
}

// The ids a unit depends on: null when the unit (or any task of a batch) has
// no depends_on field (it then waits for every earlier unit); else the ids of
// every task's depends_on entries (objects with an id, or plain ids), less the
// unit's own task ids, without duplicates. A batch whose tasks are given as
// plain ids carries depends_on on the unit itself.
function waveDeps(unit) {
  const tasks = Array.isArray(unit.tasks) ? unit.tasks : [unit];
  const objects = tasks.filter((t) => t !== null && typeof t === 'object');
  const holders = objects.length > 0 ? objects : [unit];
  if (holders.some((t) => !Array.isArray(t.depends_on))) return null;
  const own = new Set(tasks.map((t) => (typeof t === 'string' ? t : t.id)));
  const out = [];
  for (const t of holders) {
    for (const d of t.depends_on) {
      const id = d !== null && typeof d === 'object' ? d.id : d;
      if (!own.has(id) && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

// A declared file as the wave rule compares it: '\' as '/', leading './'
// and repeated '/' dropped, lower-cased.
function waveFileKey(path) {
  return String(path).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^(\.\/)+/, '').toLowerCase();
}

// The waves of the join's units, in plan order: [[unit id, ...], ...].
// units: [{id, tasks?, depends_on?, files}] (a batch unit lists its tasks;
// its tasks' ids, plain or as objects, are what other units name). edges:
// [{unit, producer}] unit ids, pre-flight's findings. A unit depends on every
// earlier unit when waveDeps is null, else on the earlier units holding an id
// it names, and on each edge's producer that is earlier (later producers and
// later ids are ignored: validation refuses a code dependency on a later join
// task). Its wave is 1 + the highest wave it depends on; then, while an
// earlier unit of that wave declares one of its files (waveFileKey), the next.
function joinWaves(units, edges = []) {
  const ids = (u) => (Array.isArray(u.tasks) ? u.tasks.map((t) => (typeof t === 'string' ? t : t.id)) : [u.id]);
  const wave = [];
  units.forEach((u, i) => {
    const earlier = units.slice(0, i);
    const deps = waveDeps(u);
    const on = new Set();
    earlier.forEach((e, j) => {
      if (deps === null || ids(e).some((id) => deps.includes(id))) on.add(j);
    });
    for (const edge of edges) {
      if (edge.unit !== u.id) continue;
      const j = earlier.findIndex((e) => e.id === edge.producer);
      if (j >= 0) on.add(j);
    }
    let w = 1 + Math.max(0, ...[...on].map((j) => wave[j]));
    const mine = new Set((u.files || []).map(waveFileKey));
    const clash = (n) => earlier.some((e, j) => wave[j] === n && (e.files || []).some((f) => mine.has(waveFileKey(f))));
    while (clash(w)) w += 1;
    wave.push(w);
  });
  const out = [];
  units.forEach((u, i) => {
    while (out.length < wave[i]) out.push([]);
    out[wave[i] - 1].push(u.id);
  });
  return out.filter((w) => w.length > 0);
}

// The join's units as the run forms them (batchGroup, batchUnit).
function joinUnits(m) {
  const units = [];
  for (let i = 0; i < m.join.length;) {
    const group = batchGroup(m, m.join, i);
    i += group.length;
    units.push(group.length > 1 ? batchUnit(group) : group[0]);
  }
  return units;
}

// Units of a wave that run at once: limits.max_parallel_lanes, capped by the
// lane worktrees a unit can use (a lane with a setup of its own in
// lane_commands is not one: its environment is not the project's).
function waveWidth(m) {
  const own = m.lane_commands || {};
  const usable = m.lanes.filter((l) => !(Object.prototype.hasOwnProperty.call(own, l.id)
    && own[l.id] && Object.prototype.hasOwnProperty.call(own[l.id], 'setup'))).length;
  return Math.min(m.limits.max_parallel_lanes, usable);
}

// The join started in an earlier launch: the ledger's join_started (copied
// into the manifest), or any join task done or deferred (fail-safe).
function joinStarted(m) {
  if (m.join_started === true) return true;
  const done = new Set([...(m.done || []), ...(m.deferred || [])]);
  return m.join.some((t) => done.has(t.id));
}

// How the join runs: {mode: 'waves'|'serial', reason, waves}. waves is the
// rule's result either way; reason says why a join runs serially.
function wavePlan(m, edges = []) {
  const waves = joinWaves(joinUnits(m), edges);
  const serial = (reason) => ({ mode: 'serial', reason, waves });
  if (m.profile === 'lite') return serial('lite');
  if (joinStarted(m)) return serial('join started');
  if (waveWidth(m) < 2) return serial('fewer than two usable lane worktrees');
  if (!waves.some((w) => w.length > 1)) return serial('no wave has two units');
  return { mode: 'waves', reason: null, waves };
}
