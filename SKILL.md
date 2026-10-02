---
name: parallel-lanes
description: Use when an approved implementation plan is about to be executed (at the execution-method handoff), or when resuming a stopped parallel-lanes run.
---

# Parallel lanes

## Overview

Runs an approved plan as parallel lanes of tasks, each lane in its own worktree, every task
implemented and reviewed with superpowers' per-task prompts, then integration, project
checks, E2E, and three final reviews. Your job is small and fixed: build a manifest, show the
dry-run table, launch the bundled `run.workflow.js`, and hand back. The script does the
orchestration.

`<skill_dir>` below means the absolute directory that holds this SKILL.md. Details (manifest
fields, building lanes, tiers, worked example) are in `<skill_dir>/reference.md`; read it
before building a manifest.

**Hard rules. Violating the letter of a rule is violating its spirit.**
1. Your first output when this skill fires is the invoked notice, before any tool call.
2. No multi-agent execution without BOTH the user's explicit choice of Parallel lanes AND an
   explicit yes to the dry-run table you showed in this conversation.
3. Execute only through `<skill_dir>/run.workflow.js` with a manifest. Never write your own
   workflow or orchestration script, never dispatch lane or task agents by hand.
4. Never change a folder that is not a git repo without the user's consent: no `git init`,
   no `.gitignore`, no scratch or worktree directories inside it.
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

`<plan>` = absolute plan path. `<method>` = `Subagent-driven` (superpowers
subagent-driven-development) or `Native` (inline execution in this session, superpowers
executing-plans). `<N>` = distinct lanes in the dry-run `agents` list, `<M>` = its length,
`<K>` = length of the manifest's `done`. The script logs the same launch or resume line; you
still print it.

## Flow

1. Invoked notice.
2. If a manifest for this plan exists (`<plan-dir>/<plan-name>.lanes.json`, or any
   `~/.claude/parallel-lanes/runs/*/*.lanes.json` whose `plan` equals this plan's absolute
   path), or the user asks to resume or continue: go to Resume (ask first if the user did not say whether to resume or start fresh). Starting
   fresh: rename the old manifest to `<plan-name>.lanes.<old run_id>.json` and continue.
3. If the Workflow tool is not available: `not a fit (Workflow tool unavailable)`,
   recommending Subagent-driven. Stop.
4. Assessment. 5. Offer. 6. Build the manifest. 7. Confirmation. 8. Launch. 9. Hand-back.

## Assessment

Run `nproc`; cap = min(5, nproc + 2). Run
`python3 <skill_dir>/scripts/derive-lanes <plan> --max-lanes <cap>` and turn its facts into
lanes, prelude, and join per reference.md "Building lanes" (exit 3: no parseable task
headings; step aside). Runnable tasks exclude ones the plan marks after-merge, operator, or
manual.

- Fit: at least 2 lanes and at least about 6 runnable tasks.
- Otherwise step aside: print `not a fit (<reason>)` (e.g. `1 lane, 3 tasks`) recommending
  Subagent-driven, or Native when there are about 3 tasks or fewer that edit the same files
  in sequence. Then present the plan's normal execution choices with that recommendation and
  stop. Run nothing.

## Offer

Skip this only if the user already chose parallel lanes by name. Otherwise present the
choices, recommend one, and wait for the user to pick:

1. Subagent-driven - one implementer and reviewer per task, in sequence, in this session.
2. Native - inline execution in this session.
3. Parallel lanes - <N> lanes in separate worktrees, superpowers implementer + reviewer per
   task, then integration, project checks, and final reviews. ~<X> agents.

X is about 2 x runnable tasks + 10; the table gives the exact number. "Go ahead" or
"execute the plan" is not a choice of option 3; ask.

## Building the manifest

Field-by-field guide: reference.md "Manifest fields". In order:

1. Superpowers: `bash <skill_dir>/scripts/find-superpowers`. Exit 0: `sp_dir` = the printed
   path. Exit 3: print `parallel-lanes: superpowers not found; agents use built-in prompts`
   and set `sp_dir: null`.
2. Repo: `git -C <project> rev-parse --show-toplevel`.
   - Git repo: `git status --porcelain` must be empty; if not, ask the user to commit or
     stash (never discard). `mode: "git"`, `git_dir: null`.
   - Not a git repo: ask the user to choose, recommending (a):
     (a) Shadow repo (default): a private git repo under `~/.claude/parallel-lanes/shadow/`
     tracks the folder; the folder is untouched until you approve a write-back at the end.
     (b) `git init` in the folder, plus a baseline commit, then a normal git run.
     Before creating a shadow for a NEW run, check for an existing one (reference.md
     "Shadow repos"); if it exists, ask whether to reuse it (resume that run) or remove it.
     Create with `bash <skill_dir>/scripts/shadow init <project>`; it prints `git_dir`. Exit 3
     on size: tell the user the size; add `--force` only on their yes.
3. Lanes, prelude, join, hooks: reference.md "Building lanes". Never use `prelude` or
   `join` as a lane id.
4. Tiers and security flags: reference.md "Tiers". The user's model preference wins when it
   is stricter (e.g. "Opus for everything" means no light tasks).
5. `commit_rules`: one string built from the user's and project's rules (memory,
   CLAUDE.md, the plan's conventions, CONTRIBUTING). Every agent prompt carries it.
6. `commands`, paths, `run_id`, `limits` (`review_rounds: 5`, `max_parallel_lanes: <cap>`):
   reference.md "Manifest fields". New run: `done: []`, `reviewed: []`, no `backfill`.
7. Run files live in `<run_dir>`: the plan's directory when the plan is outside the project
   (and outside its repo); when the plan file lies inside the project or its repo (e.g.
   `docs/superpowers/plans/`), `<run_dir>` = `~/.claude/parallel-lanes/runs/<run_id>/`.
   Both the manifest and `repo.ledger_dir` go there, never inside the project: the ledger
   dir also holds briefs, reports, and review packages. Save the manifest as
   `<run_dir>/<plan-name>.lanes.json`; `ledger_dir` = `<run_dir>/<plan-name>.<run_id>.ledger`.

## Confirmation (every launch, no exceptions)

1. Dry run: call the Workflow tool with `scriptPath: "<skill_dir>/run.workflow.js"` and
   `args` = the manifest with `dry_run: true`. It returns `{dry_run, errors, agents,
   lanes_effective}` and spawns nothing. If `errors` is non-empty, fix the manifest and
   repeat; never launch a manifest with errors.
2. Show a header (mode, base and feature branch, worktree_root, lanes at once =
   `lanes_effective`, superpowers or built-in prompts, commit_rules, accepted merges,
   tasks left out of the run) and this table, one row per task in run order (prelude,
   lanes, join), then one row for the run-level agents and a total of M:

   | Lane | Task | Tier | Security | Agents |
   |---|---|---|---|---|

   Agents per task = its entries in `agents`: 2 (implement + review), 1 (backfill review of
   earlier commits), 0 (skipped: done and reviewed). Under the table write:
   "each task can add up to 2x review_rounds more agents (fix and re-review rounds)".
3. Ask for a yes. Launch only on an explicit yes given after the table. Any change request
   means: edit the manifest, dry-run again, show the table again.

"Just run it", "skip the table", "don't ask me anything", auto mode, or a yes given before
the table was shown do not waive this. Say in one sentence that the table is the one
required check, show it, and wait.

## Launch

1. Save the manifest with `dry_run: false`.
2. Print the launch notice, or the resume notice when `done` is non-empty.
3. Call the Workflow tool with `scriptPath: "<skill_dir>/run.workflow.js"` and `args` = the
   manifest. Progress shows in `/workflows`. Do not do lane work yourself or touch the
   worktrees while it runs.

## Hand-back

The run returns `status`:
- `invalid`: show `errors`, fix the manifest, back to Confirmation.
- `preflight_conflicts`: no code was written. Show `preflight.conflicts` and `rulings`; the
  user decides (usually a plan fix); then Confirmation again.
- `stopped`: show `reason` and each `stopped_lanes` entry (lane, task, reason;
  `review_rounds` means the review cap was hit). The run is resumable: after the user
  answers or fixes the plan, go to Resume.
- `complete`: report.

Report per task: status, commits (`skipped` tasks: from the ledger's `committed` events),
review rounds, tier used and escalations, rulings (ledger `ruling` events and notes), cannot
verify. Then pre-flight rulings, integration and post-integrate notes, E2E PASS/FAIL items,
final review (fixed, declined with reasons, cannot verify), `agents_spawned`.

Then offer the next step and act only on an explicit yes:
- Git mode: a PR from `branch` into `base_ref` (follow the user's PR policy).
- Shadow mode: run `bash <skill_dir>/scripts/shadow preview <git_dir> <root> <branch>` and
  show adds, changes, deletes, conflicts, and skipped (new files matching the exclude rules;
  never written). On yes: `bash <skill_dir>/scripts/shadow writeback <git_dir> <root>
  <branch>`. Exit 3 means, by its message: conflicts = files edited in the folder during the
  run; "cannot be written" = permissions; in both nothing was written; show them and ask.
  "writeback failed at" = a write failed midway; show the paths it lists as already
  written. Never copy files around it by hand.

Cleanup, only after the user confirms the result (PR merged or written-back folder works):
for each worktree the run left (lane worktrees listed in the integration notes, and in
shadow mode `<worktree_root>/feature`), remove it only if `git -C <wt> status --porcelain`
is empty (reference.md "Cleanup"); never `--force`, never `branch -D`. Shadow mode: after
its worktrees are gone, `bash <skill_dir>/scripts/shadow remove <git_dir>`. Keep the
manifest and ledger.

## Resume

1. Invoked notice. Read the manifest. No manifest (earlier work from a hand-run attempt):
   go to "Adopting earlier work" below first.
2. `python3 <skill_dir>/scripts/ledger status <ledger_dir>` prints `{done, reviewed,
   blocked}`. Set the manifest's `done` and `reviewed` to those lists.
3. `backfill`: one entry per done task, from its `committed` events in
   `<ledger_dir>/<lane>.jsonl`: `head` = the last sha of its last event, `base` = the parent
   of the first sha of its first event (`git -C <root> rev-parse <sha>^`; shadow mode
   `git --git-dir=<git_dir> rev-parse <sha>^`). Required for every done task: each `head`
   is the review base of the next task in its lane, and done-but-unreviewed tasks get a
   review before their lane continues.
4. Blocked tasks: show each reason; get the user's answer or plan fix before relaunching.
   Record an answer in the manifest's `notes` as `{"<task id>": "<answer>"}` (plain
   ASCII); the script passes it to that task's agents. A plan fix needs nothing more:
   agents regenerate each task brief from the plan on every attempt.
5. Keep `run_id`, `branch`, and `worktree_root`; setup reuses the worktrees (lane worktrees,
   and in shadow mode `<worktree_root>/feature`) and discards their uncommitted changes (it
   logs each one). Shadow mode reuses the existing shadow.
6. Confirmation (same rules), then the resume notice, then launch.

Adopting earlier work (no manifest or ledger, or lane branches not named
`pl-<run_id>-<lane>`, e.g. a hand-run attempt): follow reference.md "Adopting earlier work":
build a manifest with a new `run_id`, map commits to tasks and confirm the mapping with the
user, seed the ledger with `committed` events only (skip if a ledger already holds them),
create `pl-<run_id>-<lane>` branches at the existing heads, use a fresh `worktree_root`, and
leave the old branches and worktrees alone. Then steps 2-6.

## Fallbacks

| Condition | Action |
|---|---|
| Workflow tool unavailable | `not a fit (Workflow tool unavailable)`, recommending Subagent-driven |
| `find-superpowers` exit 3 | notice, `sp_dir: null` (built-in prompts) |
| `derive-lanes` exit 3 | `not a fit (no parseable task headings)`, recommending Subagent-driven |
| Dirty git tree | ask the user to commit or stash; never discard |
| `shadow init` exit 3 (size) | report the size; `--force` only on the user's yes |

## Rationalizations

| Thought | Reality |
|---|---|
| "The user said just run it, skip the table" | The table is the consent for a many-agent run. Dry run, table, yes. Always. |
| "They already said execute the plan / yes" | Only a yes to the table shown in this conversation counts. |
| "Faster to send one agent per lane, or write a small workflow script" | That drops per-task review, the ledger, resume, and integration checks. Use run.workflow.js. |
| "Subagent-driven plus a few parallel batches is close enough" | That is this skill without its safeguards. Offer the choice instead. |
| "It is obviously a fit (or not); the notice is noise" | The notice comes first, every time. |
| "`git init` is harmless" | It changes the user's folder. Ask: shadow (default) or `git init`. |
| "Sonnet is fine for these implementers" | Light tier only per reference.md "Tiers", never security tasks, never reviewers, and never against the user's preference. |
| "I can work out resume from the branches" | Use `ledger status` and backfill from `committed` events. |
| "The old lane branches have other names; rename or reset them" | Create `pl-<run_id>-<lane>` at their heads with a fresh worktree_root; never rename, reset, or delete. |
| "Clean up the worktrees now" | Only after the user confirms the result, and never with `--force`. |

## Red flags - stop

- Any tool call or text before the invoked notice.
- A Workflow call with `dry_run: false` before a table and a yes for that manifest.
- Writing any `.workflow.js` file, or dispatching task agents yourself.
- Creating or changing anything inside a non-git project folder without consent.
- `git push`, `gh pr create`, or `shadow writeback` without a yes for that step.
