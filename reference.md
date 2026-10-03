# parallel-lanes reference

Details for SKILL.md. `<skill_dir>` is the absolute directory holding SKILL.md. The
validator in `run.workflow.js` (`validateManifest`) is authoritative;
`manifest.schema.json` documents it. A dry run reports every validation error. Adopting earlier work from a hand-run
attempt, with a worked example, is in adopt.md.

## Manifest fields

| Field | How to fill it |
|---|---|
| `version` | `1` |
| `run_id` | Short, unique, `[a-z0-9-]` (it becomes part of branch names), e.g. `ri1`. Keep it when resuming. |
| `plan`, `spec` | Absolute paths. `spec` is the design doc the plan names, or `null`. |
| `commit_rules` | One string: the user's and project's commit and file rules (memory, CLAUDE.md, plan conventions, CONTRIBUTING). If none exist: `Follow the repository's existing commit message style; one commit per task.` |
| `repo.mode` | `git` or `shadow`. |
| `repo.root` | Git: the repo top level. Shadow: the project folder. |
| `repo.git_dir` | Git: `null`. Shadow: the path `shadow init` printed. |
| `repo.base_ref` | Git: the branch the work will merge into (usually the default branch). Shadow: `pl-base`. |
| `repo.branch` | Feature branch, never the same as `base_ref`. Git: the plan's or user's branch name if given (it may already exist), else `pl-<run_id>`. Shadow: `pl-<run_id>`. In git mode setup checks it out in the main checkout. |
| `repo.worktree_root` | A directory outside the project that does not exist yet (or this run's, when resuming). Git: `<parent of root>/<repo name>-wt-<run_id>`. Shadow: `~/.claude/parallel-lanes/worktrees/<run_id>`. Lane worktrees go to `<worktree_root>/lane-<lane id>` on branches `pl-<run_id>-<lane id>`; shadow mode also uses `<worktree_root>/feature`. |
| `repo.ledger_dir` | `<run_dir>/<plan-name>.<run_id>.ledger`, where `<run_dir>` is the plan's directory when the plan is outside the project and its repo, else `~/.claude/parallel-lanes/runs/<run_id>/` (plan inside the project, e.g. `docs/superpowers/plans/`). It holds briefs, reports, and review packages too, so it must never be inside the project; the manifest goes in the same `<run_dir>`. |
| `commands` | `setup`, `test`, `lint`, `build`: lists of shell commands run from a checkout. Take them from the plan's conventions, then the project (package.json scripts, pyproject, Makefile). Use `[]` for a group the project lacks. |
| `lane_commands` | Optional `{<lane id>: {setup?, test?, lint?, build?}}` overrides for lanes that need only a subset (e.g. backend lanes skip the frontend suite). |
| `prelude` | Tasks run first on the feature branch, before lanes. |
| `lanes` | `[{id, name, setup_note?, tasks}]`. `id` matches `^[A-Za-z0-9_][A-Za-z0-9._-]*$` (it names the ledger file); `name` is the progress phase label. Ids `prelude` and `join` are reserved. No file may appear in two lanes. |
| `join` | Tasks run in order on the merged branch after integration. |
| task | `{id, title, files, tier, security, batch?}`. `id` exactly as in the plan heading (`T13a`, `7`); `title` and `files` from derive-lanes; `tier` `standard`, `sonnet`, or `light` (see Tiers); a sonnet or light task cannot have `security: true`; `batch` only on light tasks (see Batching). |
| `hooks` | Optional `post_integrate` (instructions for an agent after integration, e.g. a contract check) and `e2e` (instructions for an end-to-end check, e.g. "Follow plan Task T24"). |
| `limits` | `review_rounds: 5`, `max_parallel_lanes: min(5, nproc + 2)`, `max_agents` (2 x the dry-run `agents` length), `max_rulings` (25); see Budgets. |
| `autonomy` | `autonomous` (default: the adjudicator settles blocked tasks, questions, review caps, pre-flight conflicts) or `supervised` (they stop the run and wait for the user). The user may override it in the table. |
| `profile` | `full` (default) or `lite` (see Profiles). |
| `setup_result` | The output of `scripts/setup <manifest>`: `{feature_head, worktrees, discarded}`. Added after the yes to the table; when present no Setup agent runs. Absent only in hand-written manifests (the Setup agent is then the fallback). |
| `start_points` | `{prelude, join}` feature heads, copied verbatim from `ledger status` after setup. |
| `dry_run` | `true` only in the confirmation call. |
| `done`, `reviewed` | `[]` for a new run; on resume, from `ledger status`. Never by hand. |
| `backfill` | Resume only: `{<task id>: {base, head}}` for done tasks (see Backfill below). Required for every done task; each `head` is the next task's review base. |
| `notes` | Optional, resume: `{<task id>: "<the user's answer>"}` for blocked questions; passed to that task's agents. |
| `sp_dir` | Output of `find-superpowers`, or `null`. |
| `agent_type` | Optional. The output of `bash <skill_dir>/scripts/find-agent-type` (exit 0), else `null`. Recompute it at every launch, relaunch, and resume. When set, every agent except `e2e`, `post-integrate`, and `post-integrate fix` runs as that custom agent type (a lean toolset; hook instructions may need any tool); a spawn that fails with it (throws or returns no result) is retried once on the default type, and both attempts count toward `max_agents`. After the first such throw, or the second typed agent that returns no result while its retry succeeds, every later agent of the run uses the default type: the run log says so and the run result carries `agent_type_fallback: true`. |
| `skill_dir` | `<skill_dir>`. |

Plan task ids must have `#+ Task <ID>:` headings; agents extract briefs with
`scripts/task-brief`, which fails on a missing heading. Tasks the plan marks after-merge,
operator, or manual are left out of the manifest and listed in the confirmation header.

## Building lanes

`derive-lanes` reports facts; you decide. Its output:
- `tasks`: `[{id, title, files, deps}]`; deps come from bracketed id lists on the heading and
  `- Consumes:` lines.
- `groups`: tasks connected by shared files (each group in plan order).
- `bridge_files`: files whose edits alone hold a group together, with the parts the group
  would split into without them.
- `cross_group_deps`: `[{task, depends_on, task_group, dep_group}]`.

If the plan states its own lanes, start from them and check them against the facts.
Otherwise:

1. Start from `groups`. Each group is a lane candidate.
2. Prelude: a plan task that most lanes depend on (shared constants, shared types, a
   registry every lane extends) goes in `prelude`. Deps on prelude tasks need nothing more.
   Prelude tasks may share files with lane tasks (prelude runs first; lanes fast-forward to
   it).
3. For each cross-group dependency, choose one:
   - The dependent only needs an interface the plan fully specifies (a function signature,
     an HTTP contract, a type, a setting name): keep the groups separate. The dependent
     builds against the plan's contract with mocks or stubs, and `hooks.post_integrate`
     checks the real code against the contract after the merge.
   - The dependent needs the other group's real code to build or test (an end-to-end test,
     docs describing finished behavior): move the dependent to `join`.
   - Otherwise merge the two groups into one lane, keeping plan order.
   Plans often state deps only in prose ("per contract", "if T20 has not"); read each task
   when `deps` is empty.
4. Bridge files. A bridge only matters when you want its parts in different lanes:
   - A shared registry or list that every part extends (a module list, a route table): make
     a prelude task do the shared edit if the plan has one, or
   - accept a small merge: when each part adds its own separate line, keep the parts in
     separate lanes, list the file under one lane's task only (the validator rejects a file
     in two lanes), and name it under "accepted merges" in the confirmation header. The
     integration agent merges it. If commits already exist, check with
     `git merge-tree --write-tree <head1> <head2>` (exit 0 = clean).
   - Anything else (both parts change the same logic): keep them in one lane.
5. Small groups with nothing between them can share a lane (a lane is a sequence). Balance
   lanes so the longest lane, which sets the wall time, stays short.
6. More lanes than the cap is fine: extra lanes queue. A single lane is fine; a plan of 1-2
   runnable tasks is not a fit.
7. A task that commits nothing (end-to-end verification) becomes `hooks.e2e`, not a task.

## Profiles

- `full` (default): prelude, lane worktrees, an integrate agent, a pre-flight agent, and three
  final reviews (superpowers, security, correctness).
- `lite`: one lane, worked directly on the feature branch; no lane worktree, no integrate
  agent, a deterministic-only pre-flight, and one combined final reviewer. Allowed only for
  exactly one lane, at most 8 tasks across prelude, lane, and join, no security task, and
  no `hooks.post_integrate` (lite does not run it). Otherwise use `full`. The dry run
  rejects a lite manifest that breaks these rules.
- The table header shows the profile; the user may switch it there (re-dry-run).

## Tiers

| Tier | Model | Use for |
|---|---|---|
| standard | Opus 5.5, effort high | Default. Every task with logic or tests of logic. Always Opus: pre-flight, adjudicator, resolver, and final review agents, and reviewers (medium for small non-security diffs, see below). Integrate, e2e, and minor-only or docs-only final fixes start on Sonnet high and escalate to Opus. |
| sonnet | Sonnet 5.5, effort high | Implementers of well-specified tasks with some logic. After the first `changes` verdict the task escalates to Opus. |
| light | Sonnet 5.5, effort high | Implementers of mechanical tasks only: docs-only, example or config files without tests, version bumps, pure renames, fixture data. Escalates to Opus after the second `changes` verdict. |

- `security: true` for tasks touching authentication, authorization, tokens, crypto,
  untrusted input (uploads, parsing external files, request bodies), file paths from users,
  or permissions. A security task is always `standard`, never sonnet or light.
- A sonnet task escalates to standard after its first `changes` verdict, a light task after
  its second; either escalates on a block. The rerun is automatic (escalations are counted in the report).
- Reviews of diffs under 60 changed lines with no security flag run Opus at `medium`;
  everything else runs Opus at `high`. Mechanical run steps (clean merge plus commands, E2E
  execution) start on Sonnet and escalate to Opus on any conflict or failure.
- The user's preference wins when stricter: "Opus for everything" means every task is
  `standard`. There is no Haiku tier and reviewers are never lighter than Opus; if the user
  asks for that, say so.

## Batching

Consecutive tasks in one lane with `batch: "<key>"` (same key, tier `light`) run as one
implementer and one Opus review over the combined range. Use it for runs of tiny mechanical
tasks (several doc edits, a few config files) that do not need separate reviews. Ledger
events (`committed`, `reviewed`) stay per task, so resume works per task. The dry run shows
one implement and one review agent for the batch; if its review asks for changes or the task
blocks, the whole batch is the unit. Never batch a standard, sonnet, or security task.

## Adjudicator

Under `autonomy: autonomous` an Opus agent (effort high) is called instead of stopping a lane
when a task is blocked, an implementer asks a question, the review round cap trips, or
pre-flight reports conflicts. It sees the spec, plan, task brief, the report or findings,
and the diff range, and returns one outcome:

| Outcome | Effect |
|---|---|
| `answer` | The text becomes the task's note; the task retries. |
| `clarify_plan` | A ruling that amends the task's brief for this run only; the task retries. |
| `park` | The findings are recorded as deferred; the task completes. |
| `unblock` | The smallest change that unblocks dependents, carried to the next task. |
| `stop` | Allowed only for `destructive` (irreversible operation), `security` (a security-sensitive decision), `outside_side_effect` (outside the run's worktrees), or `plan_broken` (every path is a guess). The run stops, resumable. |

A park or unblock appends a `settled` ledger event (`outcome`, `base`, `head`), so a resume
treats the task as done and reviewed even when it made no commits. A security-flagged task
with a critical or important finding open cannot be parked or unblocked: that stops with
`adjudicator_stop: security`. A task adjudicated twice and still blocked ends with
`adjudication_cap`. Every ruling is a
ledger `ruling` event `Ruling: decision - why - cost if wrong`; pre-flight rulings are in
`preflight.rulings`. Both appear in the hand-back under "Rulings made on your behalf". Under
`supervised` there is no adjudicator: a blocked task, a question, or the review cap
(`review_rounds`) stops the run.

## Budgets

- `limits.max_agents`: set to 2 x the dry-run estimate (which includes one Setup agent the
  launch will not spawn). A refused agent ends its task or phase without work; the run stops
  with reason `budget`, resumable.
- `limits.max_rulings`: 25 adjudicator rulings per run.
- The final phase has one fix wave. On a cap the run stops cleanly, the session reports and
  notifies. Raise the limit in the manifest, then resume; that goes through Confirmation again
  (dry run, table, explicit yes). The only edits that
  need no second table are `setup_result`, `start_points`, and the relaunch budget carry-over.
- A relaunch after a transient stop lowers `max_agents` by the stopped run's
  `agents_spawned` and `max_rulings` by its `rulings_spent`, the adjudications that ran
  (floor 0). Never count ledger `ruling` events for this: implementers record their own
  smaller rulings there too. Fewer than 1 agent left is treated as a budget cap.

## Active-run markers and stops

`scripts/active-run write <run_id> <manifest> [status]` writes
`~/.claude/parallel-lanes/active/<run_id>.json` (`{run_id, manifest, started, status}`) at
launch; `remove` deletes it at `complete`; `list` prints every marker as JSON. A run that
ends any other way keeps the marker with its status, and the next session's bootstrap lists
it so the user can resume with one word.

Transient vs real stops (SKILL.md "Transient stops"): only agent errors, missing results
(`no result from ...`, `error: ...`), and setup-command retry exhaustion (`setup failed`) are
transient and relaunch once without asking. `review_rounds`, a supervised blocked or question
task, `adjudication_cap`, `adjudicator_stop: <condition>`, `budget`, failed integration or
post-integrate on real failures, `invalid`, and `preflight_conflicts` always stop for the
user. The session notifies (PushNotification, else a chat notice) on completion, any real
stop, a budget cap, and a failed relaunch.

## Report

`python3 <skill_dir>/scripts/run-report <transcript_dir> <manifest> [--out FILE]` reads the
workflow transcript directory printed at launch (`agent-*.meta.json` and `agent-*.jsonl`).
Output: `agents` (per agent: label, phase, task, role, requested and resolved model,
`resolved_models` with message counts, effort, input, output, cache read, and cache creation
tokens), `tiers` (totals per tier), `totals`, `models` (agents per resolved model), and
`unavailable`, `output_incomplete`, `escalations`, `fix_rounds`, `retries` counts. A field
that cannot be read is the string `unavailable`, never a guess. Transcripts often keep only
the mid-stream output count of a message (`stop_reason` null); such an agent's
`output_tokens` is `unavailable` and `output_tokens_min` holds the lower bound; totals and
tiers sum only complete agents, so when `output_incomplete` > 0 report `output_tokens_min`
as the output figure (a minimum). Report both,
and call out any agent whose `resolved_models` names a model other than the one requested
(a fallback). The hand-back appends the report, saves it beside the manifest, and lists
"Rulings made on your behalf" from the ledger `ruling` events plus `preflight.rulings`. When
a task result's `rulings` has an entry starting `refused (security-gated):`, the security gate
refused the adjudicator's park or unblock: list that ruling with the prefix, never as one that
took effect. An adjudicator that itself chose stop (`adjudicator_stop: <condition>` with no
such entry) is listed as a stop ruling, as written. When the run result has
`agent_type_fallback: true`, say in the report that the run switched to the default agent type
partway through (see `agent_type` under Manifest fields).

## Backfill

Resume builds `backfill` for every done task from its `committed` events in
`<ledger_dir>/<lane>.jsonl`:

- `head` = the last sha of the task's last committed event.
- `base` = the parent of the first sha of its first committed event, via
  `git -C <root> rev-parse <sha>^`, or `git --git-dir=<git_dir> rev-parse <sha>^` in shadow
  mode.
- A task with a `settled` event (parked or unblocked by the adjudicator) after its last
  committed event, or with no committed event at all, uses the last settled event's `base`
  and `head` instead (equal when it made no commits). `ledger status` lists it as done and
  reviewed, so it is skipped, never asked about again.

`ledger status` also prints `carry`: `{<task>: <text>}` for each task the adjudicator last
unblocked, with its unblock ruling. A skipped task passes no note at run time, so for each
entry add `from <task>, unblocked by the adjudicator: <text>` to `notes` for the next task in
the same list (prelude, the lane, or join; after a batch, the task after the batch),
appended to any existing note for it.

It is required because each `head` is the next task's review base, and done-but-unreviewed
tasks get a review first. A wrong base silently changes the review range of every done task.

## Shadow repos

The shadow for a project is
`~/.claude/parallel-lanes/shadow/<first 16 hex of sha256(physical project path)>`:

```bash
p="$(cd "<project>" && pwd -P)"
d="$HOME/.claude/parallel-lanes/shadow/$(printf '%s' "$p" | sha256sum | cut -c1-16)"
test -f "$d/pl-baseline" && echo "existing shadow: $d"
```

(`PL_SHADOW_BASE` replaces the base directory when set.) `shadow init` on an existing shadow
prints it and keeps its old baseline, which is right only for resuming that run. For a new
run, ask: reuse (resume the old run) or remove. To remove: Cleanup below for its worktrees
(`git --git-dir=<d> worktree list`), then `bash <skill_dir>/scripts/shadow remove <d>`.

## Cleanup

Integration already removes each clean lane worktree and deletes its merged branch; the
ones it could not remove are listed in its notes. After the user confirms the result:

```bash
# git mode
git -C "<wt>" status --porcelain          # must print nothing
git -C "<root>" worktree remove "<wt>"
git -C "<root>" branch -d "<branch>"       # merged branches only; never -D

# shadow mode: <root> is not a repo, so never run git -C "<root>"
git -C "<wt>" status --porcelain                        # must print nothing
git -C "<worktree_root>/feature" branch -d "<branch>"   # lane branches, while feature exists
git --git-dir="<git_dir>" worktree remove "<wt>"
```

`shadow writeback` exit 3, by its message: conflicts = files edited in the folder during the
run; "cannot be written" = permissions (in both nothing was written; show them and ask);
"writeback failed at" = a write failed midway; show the paths it lists as already written.

A worktree with uncommitted files stays; list it for the user. In shadow mode remove the lane
worktrees first, then `<worktree_root>/feature` with the same status check and
`git --git-dir="<git_dir>" worktree remove`, then run `shadow remove` (it deletes the shadow
repo with its remaining branches). Remove `worktree_root` if it is empty (`rmdir`).
