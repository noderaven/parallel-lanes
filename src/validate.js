// Top-level manifest keys that must be present (manifest.schema.json lists
// the same keys as its top-level "required"). hooks is optional: a manifest
// without it runs as if it were {} (withDefaultHooks).
function manifestRequiredKeys() {
  return [
    'version', 'run_id', 'plan', 'spec', 'commit_rules', 'repo', 'commands',
    'prelude', 'lanes', 'join', 'limits', 'dry_run', 'done',
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

// Task ids name brief, report and review files in the ledger dir, so they
// must be safe file names (no '/', no leading '.' or '-'): the same pattern
// as lane ids. scripts/_brief.py, task-brief, start-task, finish-task and
// derive-lanes enforce it too; manifest.schema.json repeats it.
function taskIdPattern() {
  return laneIdPattern();
}

// True when id names a Windows device (CON, PRN, AUX, NUL, COM1-COM9,
// LPT1-LPT9, any case) before its first '.': such a file name opens the
// device instead of a file on Windows 10 (Windows 11 accepts it).
function reservedName(id) {
  return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(id.split('.')[0].toUpperCase());
}

// An absolute path: '/...' or a Windows drive path ('C:/...' or 'C:\...').
function isAbsolutePathText(path) {
  return typeof path === 'string' && (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path));
}

// A project-relative file path, normalized: '.' and empty segments dropped,
// '..' resolved. Returns null for an absolute path (either form), one with a
// backslash (a Windows separator or a '\\server' share), one with a ':'
// (a Windows drive-relative path such as 'D:foo', which names another
// drive, or an NTFS stream such as 'a.js:s'), or one that leaves the project.
function normalizePath(path) {
  if (typeof path !== 'string' || path.length === 0) return null;
  if (isAbsolutePathText(path) || path.includes('\\') || path.includes(':')) return null;
  const out = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(part);
    }
  }
  return out.length > 0 ? out.join('/') : null;
}

// agent_type names a custom agent definition (scripts/find-agent-type prints
// it); manifest.schema.json repeats the pattern.
function agentTypePattern() {
  return '^[a-z0-9-]+$';
}

// Where each task of m runs: position (its index in run order: prelude,
// lanes in manifest order, join) and groupOf ('prelude', 'lane <id>' or
// 'join'), keyed by task id. Entries that are not tasks with an id are
// skipped, so a manifest still under validation is safe to pass.
function taskPlacement(m) {
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const position = new Map();
  const groupOf = new Map();
  let index = 0;
  const place = (list, group) => {
    if (!Array.isArray(list)) return;
    for (const t of list) {
      if (!isObject(t) || typeof t.id !== 'string' || t.id.length === 0) continue;
      position.set(t.id, index);
      groupOf.set(t.id, group);
      index += 1;
    }
  };
  if (!isObject(m)) return { position, groupOf };
  place(m.prelude, 'prelude');
  if (Array.isArray(m.lanes)) for (const lane of m.lanes) if (isObject(lane)) place(lane.tasks, `lane ${lane.id}`);
  place(m.join, 'join');
  return { position, groupOf };
}

// Whether the run order meets a code dependency of taskId on producerId (the
// producer runs earlier and its commits are in the task's checkout): the
// producer is a prelude task, an earlier task of the same lane, or anything
// before a join task. validateManifest applies it to depends_on kind code,
// runAll to the code dependencies pre-flight reports.
function codeDepMet(m, taskId, producerId) {
  const { position, groupOf } = taskPlacement(m);
  const [mine, theirs] = [groupOf.get(taskId), groupOf.get(producerId)];
  return position.get(producerId) < position.get(taskId)
    && (theirs === 'prelude' || theirs === mine || mine === 'join');
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
  const isAbsolutePath = (v) => isText(v) && isAbsolutePathText(v);

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
  } else if (isText(m.run_id) && reservedName(m.run_id)) {
    err(`run_id: id ${m.run_id} is a reserved device name on Windows`);
  }
  for (const key of ['spec', 'sp_dir']) {
    if (key in m && !isTextOrNull(m[key])) err(`${key}: must be a non-empty string or null`);
  }
  // python: the interpreter every helper command starts with (optional;
  // python3 when absent).
  if ('python' in m && !isText(m.python)) err('python: must be a non-empty string');
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

  // Ids name files, so two that differ only in letter case would share them
  // on a case-insensitive file system (Windows, macOS). firstSpelling maps a
  // lower-cased id to the first spelling seen; it reports the later one.
  const caseClash = (kind, firstSpelling, id) => {
    const first = firstSpelling.get(id.toLowerCase());
    if (first === undefined) firstSpelling.set(id.toLowerCase(), id);
    else err(`${kind} ${id}: id differs from ${first} only in letter case (they would share files on Windows and macOS)`);
  };

  // Tasks: shape, tier/security and batch rules, and id uniqueness across
  // all groups. allTasks collects every task object for the profile rules.
  const taskIds = new Set();
  const taskSpelling = new Map();
  const allTasks = [];
  const checkTask = (where, t) => {
    if (!isObject(t)) {
      err(`${where}: must be an object`);
      return;
    }
    allTasks.push(t);
    const name = isText(t.id) ? `task ${t.id}` : where;
    if (!isText(t.id)) err(`${where}.id: must be a non-empty string`);
    else if (!new RegExp(taskIdPattern()).test(t.id)) {
      err(`${where}.id: task id ${JSON.stringify(t.id)} must match ${taskIdPattern()} (it names files)`);
    } else if (taskIds.has(t.id)) err(`task ${t.id}: id appears more than once`);
    else {
      taskIds.add(t.id);
      caseClash('task', taskSpelling, t.id);
      if (reservedName(t.id)) err(`${where}: id ${t.id} is a reserved device name on Windows`);
    }
    if (!isText(t.title)) err(`${name}: title must be a non-empty string`);
    if (!isTextList(t.files)) err(`${name}: files must be a list of non-empty strings`);
    else {
      for (const f of t.files) {
        if (normalizePath(f) === null) err(`${name}: file ${JSON.stringify(f)} is absolute or leaves the project`);
      }
    }
    if ('depends_on' in t) {
      const ok = Array.isArray(t.depends_on) && t.depends_on.every((d) => isObject(d) && isText(d.id)
        && (d.kind === 'code' || d.kind === 'contract'));
      if (!ok) err(`${name}: depends_on must be a list of {id, kind: 'code' or 'contract'}`);
    }
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

  // Deliberate overlaps: a file two lanes both change, with the tasks, why,
  // the task whose version wins at the merge, and optionally how the merged
  // file is checked (validation). Keyed by the normalized,
  // lower-cased path (a case-insensitive file system makes 'A.js' and 'a.js'
  // one file).
  const fileKey = (f) => (normalizePath(f) || f).toLowerCase();
  const overlapFor = new Map();
  if ('overlaps' in m) {
    if (!Array.isArray(m.overlaps)) {
      err('overlaps: must be a list');
    } else {
      m.overlaps.forEach((o, i) => {
        const where = `overlaps[${i}]`;
        if (!isObject(o) || !isText(o.file) || !isTextList(o.tasks) || o.tasks.length < 2
          || !isText(o.reason) || !isText(o.merge_owner)) {
          err(`${where}: must be {file, tasks (2 or more ids), reason, merge_owner}`);
          return;
        }
        if (normalizePath(o.file) === null) err(`${where}.file: ${JSON.stringify(o.file)} is absolute or leaves the project`);
        if (!o.tasks.includes(o.merge_owner)) err(`${where}.merge_owner: must be one of its tasks`);
        if ('validation' in o && !isText(o.validation)) {
          err(`${where}.validation: must be a non-empty string (how the merged file is checked)`);
        }
        overlapFor.set(fileKey(o.file), o);
      });
    }
  }

  // Lanes: shape, unique lane ids, and no file claimed by two lanes unless an
  // overlaps entry records it.
  const laneIds = new Set();
  const laneSpelling = new Map();
  const laneOfTask = new Map();
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
        else {
          laneIds.add(lane.id);
          caseClash('lane', laneSpelling, lane.id);
          if (reservedName(lane.id)) err(`${where}: id ${lane.id} is a reserved device name on Windows`);
        }
        if (!isText(lane.name)) err(`${where}.name: must be a non-empty string`);
        if ('setup_note' in lane && !isText(lane.setup_note)) err(`${where}.setup_note: must be a non-empty string`);
        checkTaskList(`${where}.tasks`, lane.tasks);
        if (!isText(lane.id) || !Array.isArray(lane.tasks)) return;
        const files = new Map();
        for (const t of lane.tasks) {
          if (!isObject(t)) continue;
          if (isText(t.id)) laneOfTask.set(t.id, lane.id);
          if (isTextList(t.files)) t.files.forEach((f) => files.set(fileKey(f), { f, task: t.id }));
        }
        for (const [key, { f, task }] of files) {
          const owner = fileOwner.get(key);
          if (owner === undefined) {
            fileOwner.set(key, { lane: lane.id, task, f });
            continue;
          }
          if (owner.lane === lane.id) continue;
          const o = overlapFor.get(key);
          if (!o || !o.tasks.includes(task) || !o.tasks.includes(owner.task)) {
            err(`file ${f}: claimed by lanes ${owner.lane} and ${lane.id}` +
              (owner.f !== f ? ` (as ${owner.f} and ${f})` : '') +
              '; record a deliberate overlap in overlaps or keep it in one lane');
          }
        }
      });
    }
  }

  if ('join' in m) checkTaskList('join', m.join);

  // Every overlaps entry names known tasks that list its file.
  if (Array.isArray(m.overlaps)) {
    const files = new Map();
    for (const t of allTasks) if (isObject(t) && isText(t.id) && isTextList(t.files)) files.set(t.id, t.files.map(fileKey));
    m.overlaps.forEach((o, i) => {
      if (!isObject(o) || !isTextList(o.tasks)) return;
      for (const id of o.tasks) {
        if (!files.has(id)) err(`overlaps[${i}]: unknown task id ${id}`);
        else if (isText(o.file) && !files.get(id).includes(fileKey(o.file))) {
          err(`overlaps[${i}]: task ${id} does not list ${o.file} in its files`);
        }
      }
    });
  }

  // Dependencies: known ids, no cycles, and a code dependency that can be
  // met by the run order (codeDepMet).
  const { groupOf } = taskPlacement(m);
  const deps = new Map();
  for (const t of allTasks) {
    if (!isObject(t) || !isText(t.id) || !Array.isArray(t.depends_on)) continue;
    deps.set(t.id, []);
    for (const d of t.depends_on) {
      if (!isObject(d) || !isText(d.id)) continue;
      if (!taskIds.has(d.id)) {
        err(`task ${t.id}: depends_on names unknown task ${d.id}`);
        continue;
      }
      if (d.id === t.id) {
        err(`task ${t.id}: depends on itself`);
        continue;
      }
      deps.get(t.id).push(d.id);
      if (d.kind !== 'code') continue;
      const [mine, theirs] = [groupOf.get(t.id), groupOf.get(d.id)];
      if (!codeDepMet(m, t.id, d.id)) {
        err(`task ${t.id}: code dependency on ${d.id} (${theirs}) cannot be met from ${mine}; ` +
          'move the task to join or the same lane, or make it a contract dependency');
      }
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const cycle = (id) => {
    if (visited.has(id)) return false;
    if (visiting.has(id)) return true;
    visiting.add(id);
    const found = (deps.get(id) || []).some(cycle);
    visiting.delete(id);
    visited.add(id);
    return found;
  };
  for (const id of deps.keys()) {
    if (cycle(id)) {
      err(`depends_on: a dependency cycle runs through task ${id}`);
      break;
    }
  }

  // excluded: plan tasks the run leaves out (after-merge, operator, manual,
  // handled by a hook), each with the reason; scripts/coverage checks them
  // against the plan.
  if ('excluded' in m) {
    if (!Array.isArray(m.excluded)) {
      err('excluded: must be a list');
    } else {
      const seen = new Set();
      m.excluded.forEach((e, i) => {
        if (!isObject(e) || !isText(e.id) || !isText(e.reason)) {
          err(`excluded[${i}]: must be {id, reason}`);
          return;
        }
        if (taskIds.has(e.id)) err(`excluded[${i}]: task ${e.id} is also in the run`);
        if (seen.has(e.id)) err(`excluded[${i}]: task ${e.id} appears more than once`);
        seen.add(e.id);
      });
    }
  }
  if ('allow_deferral' in m && typeof m.allow_deferral !== 'boolean') err('allow_deferral: must be a boolean');

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

  for (const key of ['done', 'reviewed', 'deferred']) {
    if (!(key in m)) continue;
    if (!isTextList(m[key])) {
      err(`${key}: must be a list of task ids`);
      continue;
    }
    for (const id of m[key]) {
      if (!taskIds.has(id)) err(`${key}: unknown task id ${id}`);
    }
  }
  // deferred: tasks the ledger lists as parked or unblocked (ledger status);
  // they are done for scheduling but keep the run from being accepted.
  if (isTextList(m.deferred) && isTextList(m.done)) {
    for (const id of m.deferred) if (!m.done.includes(id)) err(`deferred: task ${id} is not done`);
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
  // A launch (dry_run false) needs it: scripts/setup is the only setup.
  if (m.dry_run === false && !('setup_result' in m)) {
    err('setup_result: missing; run scripts/setup after the yes to the table and add its output');
  }
  if ('setup_result' in m) {
    const r = m.setup_result;
    if (!isObject(r)) {
      err('setup_result: must be an object');
    } else {
      if (!isText(r.feature_head)) err('setup_result.feature_head: must be a non-empty string');
      if (!isTextList(r.discarded)) err('setup_result.discarded: must be a list of non-empty strings');
      if ('preserved' in r && !(Array.isArray(r.preserved) && r.preserved.every((p) => isObject(p)
        && isText(p.worktree) && isText(p.ref) && isText(p.commit)))) {
        err('setup_result.preserved: must be a list of {worktree, ref, commit}');
      }
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
