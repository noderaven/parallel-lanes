// Top-level manifest keys that must be present (manifest.schema.json lists
// the same keys as its top-level "required").
function manifestRequiredKeys() {
  return [
    'version', 'run_id', 'plan', 'spec', 'commit_rules', 'repo', 'commands',
    'prelude', 'lanes', 'join', 'hooks', 'limits', 'dry_run', 'done',
    'reviewed', 'sp_dir', 'skill_dir',
  ];
}

// run_id becomes part of branch names; lane ids become ledger file names
// (scripts/ledger enforces the same lane rule). manifest.schema.json repeats
// both patterns.
function runIdPattern() {
  return '^[a-z0-9-]+$';
}

function laneIdPattern() {
  return '^[A-Za-z0-9_][A-Za-z0-9._-]*$';
}

// agent_type names a custom agent definition (scripts/find-agent-type prints
// it); manifest.schema.json repeats the pattern.
function agentTypePattern() {
  return '^[a-z0-9-]+$';
}

// Validate a run manifest. Returns a list of error messages; empty means
// valid. This function is authoritative; manifest.schema.json documents it.
function validateManifest(m) {
  const errors = [];
  const err = (msg) => errors.push(msg);
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isText = (v) => typeof v === 'string' && v.length > 0;
  const isTextOrNull = (v) => v === null || isText(v);
  const isTextList = (v) => Array.isArray(v) && v.every(isText);
  const isPositiveInt = (v) => Number.isInteger(v) && v >= 1;
  const isAbsolutePath = (v) => isText(v) && v.startsWith('/');

  if (!isObject(m)) return ['manifest: must be an object'];

  for (const key of manifestRequiredKeys()) {
    if (!(key in m)) err(`${key}: missing`);
  }

  if ('version' in m && m.version !== 1) err('version: must be 1');
  for (const key of ['run_id', 'plan', 'commit_rules', 'skill_dir']) {
    if (key in m && !isText(m[key])) err(`${key}: must be a non-empty string`);
  }
  if (isText(m.run_id) && !new RegExp(runIdPattern()).test(m.run_id)) {
    err('run_id: must use only a-z, 0-9 and - (it becomes part of branch names)');
  }
  for (const key of ['spec', 'sp_dir']) {
    if (key in m && !isTextOrNull(m[key])) err(`${key}: must be a non-empty string or null`);
  }
  if ('agent_type' in m && m.agent_type !== null
    && !(typeof m.agent_type === 'string' && new RegExp(agentTypePattern()).test(m.agent_type))) {
    err(`agent_type: must be null or a name matching ${agentTypePattern()}`);
  }
  if ('dry_run' in m && typeof m.dry_run !== 'boolean') err('dry_run: must be a boolean');
  if ('autonomy' in m && m.autonomy !== 'autonomous' && m.autonomy !== 'supervised') {
    err("autonomy: must be 'autonomous' or 'supervised'");
  }
  if ('profile' in m && m.profile !== 'lite' && m.profile !== 'full') err("profile: must be 'lite' or 'full'");

  if ('repo' in m) {
    const repo = m.repo;
    if (!isObject(repo)) {
      err('repo: must be an object');
    } else {
      if (repo.mode !== 'git' && repo.mode !== 'shadow') err("repo.mode: must be 'git' or 'shadow'");
      for (const key of ['root', 'base_ref', 'branch', 'worktree_root', 'ledger_dir']) {
        if (!isText(repo[key])) err(`repo.${key}: must be a non-empty string`);
      }
      if (!isTextOrNull(repo.git_dir)) err('repo.git_dir: must be a non-empty string or null');
      if (repo.mode === 'shadow' && !isText(repo.git_dir)) err('repo.git_dir: required when repo.mode is shadow');
      if (isText(repo.branch) && repo.branch === repo.base_ref) err('repo.branch: must differ from repo.base_ref');
    }
  }

  const checkCommands = (where, cmds, allRequired) => {
    if (!isObject(cmds)) {
      err(`${where}: must be an object`);
      return;
    }
    const names = ['setup', 'test', 'lint', 'build'];
    for (const name of names) {
      if (name in cmds) {
        if (!isTextList(cmds[name])) err(`${where}.${name}: must be a list of non-empty strings`);
      } else if (allRequired) {
        err(`${where}.${name}: missing`);
      }
    }
    for (const name of Object.keys(cmds)) {
      if (!names.includes(name)) err(`${where}.${name}: unknown command group`);
    }
  };
  if ('commands' in m) checkCommands('commands', m.commands, true);

  // Tasks: shape, tier/security and batch rules, and id uniqueness across
  // all groups. allTasks collects every task object for the profile rules.
  const taskIds = new Set();
  const allTasks = [];
  const checkTask = (where, t) => {
    if (!isObject(t)) {
      err(`${where}: must be an object`);
      return;
    }
    allTasks.push(t);
    const name = isText(t.id) ? `task ${t.id}` : where;
    if (!isText(t.id)) err(`${where}.id: must be a non-empty string`);
    else if (taskIds.has(t.id)) err(`task ${t.id}: id appears more than once`);
    else taskIds.add(t.id);
    if (!isText(t.title)) err(`${name}: title must be a non-empty string`);
    if (!isTextList(t.files)) err(`${name}: files must be a list of non-empty strings`);
    if (t.tier !== 'standard' && t.tier !== 'sonnet' && t.tier !== 'light') {
      err(`${name}: tier must be 'standard', 'sonnet' or 'light'`);
    }
    if (typeof t.security !== 'boolean') err(`${name}: security must be a boolean`);
    if ((t.tier === 'sonnet' || t.tier === 'light') && t.security === true) {
      err(`${name}: a ${t.tier} tier task cannot have security set (security tasks are always standard)`);
    }
    if ('batch' in t) {
      if (!isText(t.batch)) err(`${name}: batch must be a non-empty string`);
      else if (t.tier !== 'light') err(`${name}: batch is allowed only on a light tier task`);
    }
  };
  const checkTaskList = (where, list) => {
    if (!Array.isArray(list)) {
      err(`${where}: must be a list`);
      return;
    }
    list.forEach((t, i) => checkTask(`${where}[${i}]`, t));
  };

  if ('prelude' in m) checkTaskList('prelude', m.prelude);

  // Lanes: shape, unique lane ids, and no file claimed by two lanes.
  const laneIds = new Set();
  if ('lanes' in m) {
    if (!Array.isArray(m.lanes)) {
      err('lanes: must be a list');
    } else {
      const fileOwner = new Map();
      m.lanes.forEach((lane, i) => {
        const where = `lanes[${i}]`;
        if (!isObject(lane)) {
          err(`${where}: must be an object`);
          return;
        }
        if (!isText(lane.id)) err(`${where}.id: must be a non-empty string`);
        else if (!new RegExp(laneIdPattern()).test(lane.id)) {
          err(`${where}.id: lane id ${JSON.stringify(lane.id)} must match ${laneIdPattern()}`);
        } else if (lane.id === 'prelude' || lane.id === 'join') err(`lane ${lane.id}: id is reserved`);
        else if (laneIds.has(lane.id)) err(`lane ${lane.id}: id appears more than once`);
        else laneIds.add(lane.id);
        if (!isText(lane.name)) err(`${where}.name: must be a non-empty string`);
        if ('setup_note' in lane && !isText(lane.setup_note)) err(`${where}.setup_note: must be a non-empty string`);
        checkTaskList(`${where}.tasks`, lane.tasks);
        if (!isText(lane.id) || !Array.isArray(lane.tasks)) return;
        const files = new Set();
        for (const t of lane.tasks) {
          if (isObject(t) && isTextList(t.files)) t.files.forEach((f) => files.add(f));
        }
        for (const f of files) {
          const owner = fileOwner.get(f);
          if (owner === undefined) fileOwner.set(f, lane.id);
          else if (owner !== lane.id) err(`file ${f}: claimed by lanes ${owner} and ${lane.id}`);
        }
      });
    }
  }

  if ('join' in m) checkTaskList('join', m.join);

  if ('lane_commands' in m) {
    if (!isObject(m.lane_commands)) {
      err('lane_commands: must be an object');
    } else {
      for (const [laneId, cmds] of Object.entries(m.lane_commands)) {
        if (!laneIds.has(laneId)) err(`lane_commands.${laneId}: unknown lane id`);
        checkCommands(`lane_commands.${laneId}`, cmds, false);
      }
    }
  }

  if ('hooks' in m) {
    if (!isObject(m.hooks)) {
      err('hooks: must be an object');
    } else {
      for (const key of Object.keys(m.hooks)) {
        if (key !== 'post_integrate' && key !== 'e2e') err(`hooks.${key}: unknown hook`);
        else if (!isText(m.hooks[key])) err(`hooks.${key}: must be a non-empty string`);
      }
    }
  }

  if ('limits' in m) {
    if (!isObject(m.limits)) {
      err('limits: must be an object');
    } else {
      for (const key of ['review_rounds', 'max_parallel_lanes']) {
        if (!isPositiveInt(m.limits[key])) err(`limits.${key}: must be an integer >= 1`);
      }
      if ('max_agents' in m.limits && !isPositiveInt(m.limits.max_agents)) {
        err('limits.max_agents: must be an integer >= 1');
      }
      if ('max_rulings' in m.limits && !(Number.isInteger(m.limits.max_rulings) && m.limits.max_rulings >= 0)) {
        err('limits.max_rulings: must be an integer >= 0');
      }
    }
  }

  for (const key of ['done', 'reviewed']) {
    if (!(key in m)) continue;
    if (!isTextList(m[key])) {
      err(`${key}: must be a list of task ids`);
      continue;
    }
    for (const id of m[key]) {
      if (!taskIds.has(id)) err(`${key}: unknown task id ${id}`);
    }
  }

  // notes: the user's answers to blocked questions, one text per task id;
  // each is passed to that task's agents.
  if ('notes' in m) {
    if (!isObject(m.notes)) {
      err('notes: must be an object');
    } else {
      for (const [id, text] of Object.entries(m.notes)) {
        if (!taskIds.has(id)) err(`notes: unknown task id ${id}`);
        if (!isText(text)) err(`notes.${id}: must be a non-empty string`);
      }
    }
  }

  // backfill: commits of done tasks, from ledger committed events. A done
  // but unreviewed task is reviewed before its lane continues; every head is
  // the next task's base.
  const backfill = 'backfill' in m ? m.backfill : {};
  if (!isObject(backfill)) {
    err('backfill: must be an object');
  } else {
    for (const [id, range] of Object.entries(backfill)) {
      if (!taskIds.has(id)) err(`backfill: unknown task id ${id}`);
      if (!isObject(range) || !isText(range.base) || !isText(range.head)) {
        err(`backfill.${id}: must be {base, head} with non-empty strings`);
      }
    }
    if (isTextList(m.done) && isTextList(m.reviewed)) {
      for (const id of m.done) {
        if (!(id in backfill)) err(`backfill: missing an entry for task ${id} (done)`);
      }
    }
  }

  // Lite profile (spec D2): one lane on the feature branch, a small plan, no
  // security task (it gets no separate security review lens), and no
  // post_integrate hook.
  if (m.profile === 'lite') {
    if (Array.isArray(m.lanes) && m.lanes.length !== 1) {
      err(`profile lite: requires exactly one lane (found ${m.lanes.length})`);
    }
    if (allTasks.length > 8) {
      err(`profile lite: allows at most 8 tasks across prelude, lanes and join (found ${allTasks.length})`);
    }
    for (const t of allTasks) {
      if (isObject(t) && t.security === true) {
        const name = isText(t.id) ? `task ${t.id}` : 'a task';
        err(`profile lite: allows no security task (${name} has security set)`);
      }
    }
    // Lite has no integration phase, so the hook would never run.
    if (isObject(m.hooks) && 'post_integrate' in m.hooks) {
      err('profile lite: not allowed with hooks.post_integrate (lite does not run it)');
    }
  }

  // setup_result: the output of scripts/setup. Every lane needs a worktree
  // entry so a run never starts a lane without its checkout (the run itself
  // checks each path against the one it uses).
  if ('setup_result' in m) {
    const r = m.setup_result;
    if (!isObject(r)) {
      err('setup_result: must be an object');
    } else {
      if (!isText(r.feature_head)) err('setup_result.feature_head: must be a non-empty string');
      if (!isTextList(r.discarded)) err('setup_result.discarded: must be a list of non-empty strings');
      if (!isObject(r.worktrees)) {
        err('setup_result.worktrees: must be an object mapping lane ids to absolute paths');
      } else {
        for (const [laneId, path] of Object.entries(r.worktrees)) {
          if (!laneIds.has(laneId)) err(`setup_result.worktrees.${laneId}: unknown lane id`);
          if (!isAbsolutePath(path)) err(`setup_result.worktrees.${laneId}: must be an absolute path`);
        }
        for (const laneId of laneIds) {
          if (!(laneId in r.worktrees)) err(`setup_result.worktrees: missing a worktree for lane ${laneId}`);
        }
      }
    }
  }

  // start_points: feature heads from the ledger run_started events.
  if ('start_points' in m) {
    if (!isObject(m.start_points)) {
      err('start_points: must be an object');
    } else {
      for (const [key, sha] of Object.entries(m.start_points)) {
        if (key !== 'prelude' && key !== 'join') err(`start_points.${key}: unknown start point`);
        else if (!isText(sha)) err(`start_points.${key}: must be a non-empty string`);
      }
    }
  }

  return errors;
}

// The run's autonomy mode (spec C1): autonomous unless the manifest says
// supervised.
function effectiveAutonomy(m) {
  return m.autonomy === 'supervised' ? 'supervised' : 'autonomous';
}

// The run's budgets (spec C3) for a valid manifest: max_agents defaults to
// twice the dry-run estimate, max_rulings to 25.
function effectiveLimits(m) {
  const limits = m.limits;
  return {
    max_agents: 'max_agents' in limits ? limits.max_agents : 2 * planAgents(m).length,
    max_rulings: 'max_rulings' in limits ? limits.max_rulings : 25,
  };
}
