---
name: parallel-lanes
description: Use when an approved implementation plan is about to be executed (at the execution-method handoff), or when resuming a stopped parallel-lanes run.
---

# Parallel lanes

## Overview

Runs an approved plan as parallel lanes of tasks, each lane in its own worktree, every task
implemented and reviewed with superpowers' per-task prompts, then integration, checks, E2E,
and final reviews. Your job is fixed: build a manifest, show the dry-run table,
set up and launch the bundled `run.workflow.js`, and hand back.

`<skill_dir>` below means the absolute directory that holds this SKILL.md. Details (manifest
fields, building lanes, profiles, tiers, batching, adjudicator, budgets, markers, report) are in
`<skill_dir>/reference.md`; read it before building a manifest.

**Hard rules. Violating the letter of a rule is violating its spirit.**
1. Your first output when this skill fires is the invoked notice, before any tool call.
2. No multi-agent execution without BOTH the user's explicit choice of Parallel lanes AND an
   explicit yes to the dry-run table you showed in this conversation.
3. Execute only through `<skill_dir>/run.workflow.js` with a manifest. Never write your own
   workflow or orchestration script, never dispatch lane or task agents by hand.
4. Never change a folder that is not a git repo without the user's consent (no `git init`,
   `.gitignore`, scratch or worktree directories).
5. Never push, open a PR, merge into the base branch, or write back a shadow repo unless the
   user said yes to that specific step.

## Notices

Print these lines exactly. In chat, prefix each with a short visual marker of your choice;
the text after the marker is fixed.

| When | Line |
|---|---|
| The skill fires (first output) | `parallel-lanes invoked: evaluating <plan> for parallel execution` |
| Stepping aside | `parallel-lanes: not a fit (<reason>); recommending <method>` |
| Launching a new run | `parallel-lanes: launching run <run_id>: <N> lanes, <M> agents` |
| Launching with tasks already done | `parallel-lanes: resuming run <run_id>: <K> tasks already committed` |
| Relaunch after a transient stop | `parallel-lanes: relaunching run <run_id> after a transient stop` |

`<plan>` = absolute plan path. `<method>` = `Subagent-driven` or `Native` (superpowers
executing-plans). `<N>` = distinct lanes in the dry-run `agents` list, `<M>` = its length
minus the Setup agent, `<K>` = length of `done`. The script logs the same line; you still
print it.

## Flow

1. Invoked notice.
2. If a manifest for this plan exists (`<plan-dir>/<plan-name>.lanes.json`, or any
   `~/.claude/parallel-lanes/runs/*/*.lanes.json` whose `plan` equals this plan's absolute
   path), or `bash <skill_dir>/scripts/active-run list` shows a marker for this plan, or the
   user asks to resume or continue: go to Resume (ask first if the user did not say whether to
   resume or start fresh). Starting fresh: rename the old manifest to
   `<plan-name>.lanes.<old run_id>.json`, remove its marker, and continue.
3. If the Workflow tool is not available: `not a fit (Workflow tool unavailable)`,
   recommending Subagent-driven. Stop.
4. Assessment. 5. Offer. 6. Build the manifest. 7. Confirmation. 8. Setup and launch.
   9. Hand-back.

## Assessment

Run `nproc`; cap = min(5, nproc + 2). Run
`python3 <skill_dir>/scripts/derive-lanes <plan> --max-lanes <cap>` and turn its facts into
lanes, prelude, and join per reference.md "Building lanes" (exit 3: no parseable task
headings; step aside). Runnable tasks exclude ones the plan marks after-merge, operator, or
manual.

- Parallel lanes is the default executor: run as Parallel for any approved plan of 3+
  runnable tasks, a single lane included.
- Step aside only for a 1-2 task plan or an explicit request for Subagent-driven or Native:
  print `not a fit (<reason>)` (e.g. `2 tasks`), recommending Native when the tasks edit the
  same files in sequence, else Subagent-driven. Then present the plan's normal execution
  choices with that recommendation and stop. Run nothing.

## Offer

Skip this only if the user already chose parallel lanes by name. Otherwise present these
choices in order, recommend the first, and wait for the pick:

1. Parallel lanes (recommended) - <N> lanes in separate worktrees, superpowers implementer +
   reviewer per task, then integration, project checks, and final reviews. ~<X> agents.
2. Subagent-driven - one implementer and reviewer per task, in sequence, in this session.
3. Native - inline execution in this session.

X is about 2 x runnable tasks + 10; the table gives the exact number. "Go ahead" or
"execute the plan" is not a choice of option 1; ask.

## Building the manifest

Field-by-field guide: reference.md "Manifest fields". In order:

1. Superpowers: `bash <skill_dir>/scripts/find-superpowers`. Exit 0: `sp_dir` = the printed
   path. Exit 3: print `parallel-lanes: superpowers not found; agents use built-in prompts`
   and set `sp_dir: null`.
2. Repo: `git -C <project> rev-parse --show-toplevel`.
   - Git repo: `git status --porcelain` must be empty; if not, ask the user to commit or
     stash (never discard). `mode: "git"`, `git_dir: null`.
   - Not a git repo: ask the user to choose, recommending (a): (a) shadow repo (default;
     the folder is untouched until a write-back you get a yes for); (b) `git init` plus a
     baseline commit, then a normal git run. Shadow details, existing-shadow check, `shadow
     init` (prints `git_dir`; exit 3 on size: tell the user, `--force` only on their yes):
     reference.md "Shadow repos".
3. Lanes, prelude, join, hooks: reference.md "Building lanes". Never use `prelude` or
   `join` as a lane id.
4. `profile` and tiers: reference.md "Profiles", "Tiers", "Batching". `profile: "lite"` only
   for one lane, at most 8 tasks, no security task, and no `hooks.post_integrate`; else
   `full`. Tiers `standard`, `sonnet`, `light` (security tasks always `standard`); `batch`
   keys for consecutive tiny light tasks. The user's model preference wins when it is stricter
   (e.g. "Opus for everything" means all `standard`).
5. `commit_rules`: one string from the user's and project's rules (memory, CLAUDE.md,
   the plan's conventions, CONTRIBUTING). Every agent prompt carries it.
6. `commands`, paths, `run_id`, `autonomy` (`autonomous` default), `limits`
   (`review_rounds: 5`, `max_parallel_lanes: <cap>`): reference.md "Manifest fields". New
   run: `done: []`, `reviewed: []`, no `backfill`.
7. Run files live in `<run_dir>`: the plan's directory when the plan is outside the project
   (and outside its repo); when the plan file lies inside the project or its repo (e.g.
   `docs/superpowers/plans/`), `<run_dir>` = `~/.claude/parallel-lanes/runs/<run_id>/`.
   Both the manifest and `repo.ledger_dir` go there, never inside the project: the ledger
   dir also holds briefs, reports, and review packages. Save the manifest as
   `<run_dir>/<plan-name>.lanes.json`; `ledger_dir` = `<run_dir>/<plan-name>.<run_id>.ledger`.
8. The manifest has no `setup_result` or `start_points` yet. Nothing here or in Confirmation
   touches the project: no worktree, branch, or setup command before consent.

## Confirmation (every launch, no exceptions)

1. Dry run: call the Workflow tool as in Launch step 1, with `args` = the manifest with
   `dry_run: true`. It returns `{dry_run, errors, agents, lanes_effective}` and spawns
   nothing. If `errors` is non-empty, fix the manifest and repeat; never launch a manifest
   with errors. Then set `limits.max_agents` = 2 x `agents.length` and `limits.max_rulings` =
   25 (reference.md "Budgets") so the table shows them.
2. Show a header (mode, base and feature branch, worktree_root, `profile`, `autonomy`,
   `limits.max_agents`, `limits.max_rulings`, lanes at once = `lanes_effective`, superpowers
   or built-in prompts, commit_rules, accepted merges, tasks left out of the run, batches)
   and this table, one row per task in run order (prelude, lanes, join), then one row for
   the run-level agents and a total M:

   | Lane | Task | Tier | Security | Agents |
   |---|---|---|---|---|

   Tier is `standard`, `sonnet`, or `light`; a batch shows its key. Agents per task = its
   entries in `agents`: 2 (implement + review), 1 (backfill review of earlier commits), 0
   (skipped: done and reviewed). Under the table write:
   "each task can add up to 2x review_rounds more agents (fix and re-review rounds)", and
   that the total includes one Setup agent the launch will not spawn (`scripts/setup` runs
   instead). The user may override `autonomy` and the budgets there; apply the change.
3. Ask for a yes. Launch only on an explicit yes given after the table. Any change request
   means: edit the manifest, dry-run again, show the table again.

"Just run it", "skip the table", "don't ask me anything", auto mode, or a yes given before
the table was shown do not waive this. Say the table is the one required
check, show it, and wait.

## Launch

1. Script path: before the first Workflow call, copy `<skill_dir>/run.workflow.js` into the
   session scratchpad directory (never into the project) and use that copy as `scriptPath`
   for the dry run, the real launch, relaunches, and resumes (the Workflow tool rejects a
   `scriptPath` under ~/.claude/skills). With no scratchpad, pass the file contents as
   `script` and reuse the `scriptPath` the result prints.
2. Setup, only after the explicit yes to the table, immediately before the real launch: run
   `python3 <skill_dir>/scripts/setup <manifest file>`. It creates the feature branch and
   worktrees and discards edits in run-owned worktrees, so never before the yes. On failure
   wait 10 seconds and retry once; then report it and stop. Put its output in `setup_result`
   and copy the `start_points` of `python3 <skill_dir>/scripts/ledger status <ledger_dir>`
   verbatim into `start_points` (keys `prelude` and `join`). Adding these two fields needs no
   second table; any other manifest change after the yes does.
3. Save the manifest with `dry_run: false`. Print the launch notice, or the resume notice
   when `done` is non-empty.
4. Write the marker: `bash <skill_dir>/scripts/active-run write <run_id> <manifest file>`.
5. Call the Workflow tool with `args` = the manifest. Progress shows in `/workflows`; note
   the transcript directory it prints. Do not do lane work or touch the worktrees meanwhile.
6. On `complete` run `scripts/active-run remove <run_id>`. On any other end run
   `scripts/active-run write <run_id> <manifest file> <status>` and keep it, so a later
   session offers the resume.

## Transient stops (relaunch once, no prompt)

A stop is transient when status is `stopped`, `reason` is not `budget`, and every cause is
an agent error, a missing result, or setup-command retry exhaustion. The causes are every
`stopped_lanes[].reason` when `reason` is `prelude stopped`, `lanes stopped`, or `join
stopped`, else `reason` itself. A cause is transient only if it starts with `no result from`,
`error:`, or `setup failed`, or reads `integration failed: no result from ...` or
`post-integrate failed: no result from ...`. Every other cause (`review_rounds`, a supervised
blocked or question task, `adjudication_cap`, `adjudicator_stop`, budget, a failed
integration or post-integrate on real failures) and status `invalid` or `preflight_conflicts`
are NOT transient: never relaunch; stop and notify.

Relaunch once with the relaunch notice: carry budgets over (lower `limits.max_agents` by the
stopped run's `agents_spawned` and `limits.max_rulings` by its `rulings_spent`, floor 0). If
fewer than 1 agent would remain, treat it as a budget cap: stop and notify. Rerun
`scripts/setup`, recompute `done`, `reviewed`, `backfill`, and `start_points` from the ledger
as in Resume, and launch again. No second table. A second transient stop is a real stop.

## Notify

Send a push notification (PushNotification tool) with run id, status, and one line of next
step when a run completes, really stops, hits a budget cap, or fails its relaunch; if the
tool is unavailable, a chat notice only.

## Hand-back

The run returns `status`:
- `invalid`: notify, show `errors`, fix the manifest, back to Confirmation.
- `preflight_conflicts`: no code was written. Notify, show `preflight.conflicts` and `rulings`; the
  user decides; then Confirmation again.
- `stopped`: transient: relaunch as above. Otherwise show `reason` and each `stopped_lanes`
  entry (lane, task, reason), notify, keep the marker. The run is resumable: after the user
  answers or fixes the plan, go to Resume.
- `complete`: remove the marker, notify, report.

Report: run `python3 <skill_dir>/scripts/run-report <transcript dir> <manifest> --out
<run_dir>/<plan-name>.<run_id>.report.json` on the transcript dir printed at launch, append
its output, and keep that file beside the manifest. Per task: status, commits (`skipped`:
from the ledger's `committed` events), review rounds, tier and escalations, notes, cannot
verify. "Rulings made on your behalf" (reference.md "Report"). Then
integration and post-integrate notes, E2E PASS/FAIL, final review (fixed, declined with
reasons, cannot verify), `agents_spawned` (reference.md "Report").

Then offer the next step; act only on an explicit yes:
- Git mode: a PR from `branch` into `base_ref` (follow the user's PR policy).
- Shadow mode: run `bash <skill_dir>/scripts/shadow preview <git_dir> <root> <branch>`, show
  adds, changes, deletes, conflicts, and skipped. On yes: `bash <skill_dir>/scripts/shadow
  writeback <git_dir> <root> <branch>`. Exit 3: nothing or part was written; follow
  reference.md "Cleanup" and ask. Never copy files around it by hand.

Cleanup, only after the user confirms the result: reference.md "Cleanup"; never `--force`,
never `branch -D`. Keep the manifest and ledger.

## Resume

1. Invoked notice. Read the manifest (an `active-run list` marker names it). No manifest
   (earlier work from a hand-run attempt): reference.md "Adopting earlier work" first.
2. `python3 <skill_dir>/scripts/ledger status <ledger_dir>` prints `{done, reviewed,
   blocked, start_points, carry}`. Set the manifest's `done` and `reviewed` to those lists (a
   `settled` task is in both; never ask again). Put each `carry` entry into
   `notes` (reference.md "Backfill").
3. `backfill`: one `{base, head}` entry per done task, from its `committed` or `settled`
   events (reference.md "Backfill"). Required for every done task.
4. Blocked tasks: show each reason; get the user's answer or plan fix before relaunching.
   Record an answer in `notes` as `{"<task id>": "<answer>"}` (plain ASCII); a plan fix needs
   nothing more.
5. Keep `run_id`, `branch`, and `worktree_root`; `scripts/setup` reuses the worktrees; shadow mode reuses the existing shadow.
6. Confirmation (same rules), then, after the yes, Launch step 2 again (setup and
   `start_points`), the resume notice, and launch.

## Rationalizations

| Thought | Reality |
|---|---|
| "The user said just run it, skip the table" | The table is the consent for a many-agent run. Dry run, table, yes. Always. |
| "They already said execute the plan / yes" | Only a yes to the table shown in this conversation counts. |
| "Run `scripts/setup` now so the table is exact" | Setup creates branches and discards worktree edits. Only after the yes. |
| "A small workflow script of my own is faster" | It drops review, the ledger, resume, and checks. Use run.workflow.js. |
| "Relaunch this stop, it is probably transient" | Only the listed causes. `review_rounds`, `adjudication_cap`, budget: stop and notify. |
| "Sonnet is fine for this security task" | Security tasks are always standard. |

## Red flags - stop

- Any tool call or text before the invoked notice.
- A Workflow call with `dry_run: false`, or a `scripts/setup` run, before a table and a yes.
- Writing any `.workflow.js` file, or dispatching task agents yourself.
- Creating or changing anything inside a non-git project folder without consent.
- `git push`, `gh pr create`, or `shadow writeback` without a yes for that step.
