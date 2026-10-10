# parallel-lanes reference

Details for SKILL.md. `<skill_dir>` is the absolute directory holding SKILL.md. The
validator in `run.workflow.js` (`validateManifest`) is authoritative;
`manifest.schema.json` documents it. A dry run reports every validation error. Adopting earlier work from a hand-run
attempt, with a worked example, is in adopt.md. `<config dir>` below is
`${CLAUDE_CONFIG_DIR:-~/.claude}`; every helper uses the same one.
`<python>` below is the manifest's `python` (see Paths and Python).

## Paths and Python

`python` is the output of `bash <skill_dir>/scripts/find-python`: the absolute path of the
first of `python3`, `python`, and `py -3` that runs Python 3.8 or later (the Microsoft Store
`python3` stub fails that check). Exit 3 means none works: tell the user and stop. Every
helper command the skill and its agents run starts with it, shell-quoted (`<python>
<skill_dir>/scripts/<name>`); bash scripts (`active-run`, `shadow`, `find-*`) still start with
`bash`. Set it whenever you build or resume a manifest; a manifest without it (1.2.x) runs
helpers with `python3`.

On Windows (Git Bash) every path in the manifest (`plan`, `spec`, `skill_dir`, `sp_dir`,
`python`, and the `repo` paths) takes the `C:/Users/...` form: drive letter, forward slashes,
what `cygpath -m` prints and what the helpers print. Never write the Git Bash form
(`/c/Users/...`): Python and Node read it as a path on the current drive. The workflow turns
`C:\...` and `c:/...` into `C:/...` before it uses a path (and `/c/...` too once any manifest
path has a drive letter), and the validator accepts `/...` and `C:/...` (or `C:\...`) as
absolute. Task `files` stay project-relative with forward slashes: an absolute path in either
form, a `\\server\share` path, any backslash, or any `:` (`D:foo` names another drive) is an
error. Helpers start Git Bash by its path (`CLAUDE_CODE_GIT_BASH_PATH` when set, else a
`bash.exe` in an absolute PATH folder or the `<git>/bin/bash.exe` of a `<git>/cmd` folder on
PATH, else `C:/Program Files/Git`), never the WSL `bash.exe` in System32.

## Manifest fields

| Field | How to fill it |
|---|---|
| `version` | `1` |
| `run_id` | Short, unique, `[a-z0-9-]` (it becomes part of branch names), e.g. `ri1`. Keep it when resuming. Id rule below. |
| `plan`, `spec` | Absolute paths. `spec` is the design doc the plan names, or `null`. |
| `commit_rules` | One string: the user's and project's commit and file rules (memory, CLAUDE.md, plan conventions, CONTRIBUTING). If none exist: `Follow the repository's existing commit message style; one commit per task.` |
| `repo.mode` | `git` or `shadow`. |
| `repo.root` | Git: the repo top level. Shadow: the project folder. |
| `repo.git_dir` | Git: `null`. Shadow: the path `shadow init` printed. |
| `repo.base_ref` | Git: the branch the work will merge into (usually the default branch). Shadow: `pl-base`. |
| `repo.branch` | Feature branch, never the same as `base_ref`. Git: the plan's or user's branch name if given (it may already exist), else `pl-<run_id>`. Shadow: `pl-<run_id>`. In git mode setup checks it out in the main checkout. |
| `repo.worktree_root` | A directory outside the project that does not exist yet (or this run's, when resuming). Git: `<parent of root>/<repo name>-wt-<run_id>`. Shadow: `<config dir>/parallel-lanes/worktrees/<run_id>`. Lane worktrees go to `<worktree_root>/lane-<lane id>` on branches `pl-<run_id>-<lane id>`; shadow mode also uses `<worktree_root>/feature`. |
| `repo.ledger_dir` | `<run_dir>/<plan-name>.<run_id>.ledger`, where `<run_dir>` is the plan's directory when the plan is outside the project and its repo, else `<config dir>/parallel-lanes/runs/<run_id>/`, by default `~/.claude/parallel-lanes/runs/<run_id>/` (plan inside the project, e.g. `docs/superpowers/plans/`). It holds briefs, reports, and review packages too, so it must never be inside the project; the manifest goes in the same `<run_dir>`. |
| `commands` | `setup`, `test`, `lint`, `build`: lists of shell commands run from a checkout. Take them from the plan's conventions, then the project (package.json scripts, pyproject, Makefile). Use `[]` for a group the project lacks. |
| `lane_commands` | Optional `{<lane id>: {setup?, test?, lint?, build?}}` overrides for lanes that need only a subset (e.g. backend lanes skip the frontend suite). |
| `prelude` | Tasks run first on the feature branch, before lanes. |
| `lanes` | `[{id, name, setup_note?, tasks}]`. `id` matches `^[A-Za-z0-9_][A-Za-z0-9._-]*$` (it names the ledger file); `name` is the progress phase label. Ids `prelude` and `join` are reserved. No file may appear in two lanes unless an `overlaps` entry records it; files are compared normalized (`./a`, `a//b`, `a/../b`) and case-insensitively. |
| `join` | Tasks run in order on the merged branch after integration. |
| task | `{id, title, files, tier, security, batch?, depends_on?}`. `id` exactly as in the plan heading (`T13a`, `7`) and a safe file name (`^[A-Za-z0-9_][A-Za-z0-9._-]*$`: it names brief, report, and review files); `title` and `files` from derive-lanes (project-relative: no absolute path, nothing that leaves the project; each review is shown the files its range changes outside `files`, from git, and judges each); `tier` `standard`, `sonnet`, or `light` (see Tiers); a sonnet or light task cannot have `security: true`; `batch` only on light tasks (see Batching); `depends_on` `[{id, kind: "code" or "contract"}]` (see Building lanes). |
| `overlaps` | Optional `[{file, tasks, reason, merge_owner, validation?}]`: a file tasks in different lanes both change on purpose. Every listed task lists the file; `merge_owner` is one of them (its version wins where both changes cannot stand); `validation` says how the merged file is checked (a command, or what to look at). The integration agent is told about each and runs the validation after the merge. |
| `excluded` | Optional `[{id, reason}]`: plan tasks the run leaves out (after-merge, operator, manual, or done by a hook), shown in the confirmation header. `scripts/coverage` checks that every plan task runs or is here. |
| `allow_deferral` | Optional boolean, default `true`: whether the adjudicator may park or unblock a task (security tasks never). `false` makes every park or unblock a stop. Show it in the table header. |
| `deferred` | Resume: the `deferred` list of `ledger status`. Those tasks are done for scheduling but keep the run from being accepted. |
| `hooks` | Optional: a manifest without it runs as if it were `{}` (1.3.0 required the key; its manifests still validate). It holds optional `post_integrate` (instructions for an agent after integration, e.g. a contract check) and `e2e` (instructions for an end-to-end check, e.g. "Follow plan Task T24"). |
| `limits` | `review_rounds: 5`, `max_parallel_lanes: min(5, CPU count + 2)` (the count from `os.cpu_count()`), `max_agents` (2 x the dry-run `agents` length), `max_rulings` (25); see Budgets. |
| `autonomy` | `autonomous` (default: the adjudicator settles blocked tasks, questions, review caps, pre-flight conflicts) or `supervised` (they stop the run and wait for the user). The user may override it in the table. |
| `profile` | `full` (default) or `lite` (see Profiles). |
| `setup_result` | The output of `scripts/setup <manifest> --owner <token>`: `{feature_head, worktrees, discarded, preserved}`. Added after the yes to the table; required for a launch (there is no setup agent; a dry run does without it). `preserved` lists the commits under `refs/parallel-lanes/<run_id>/abandoned/` that hold changes setup discarded (see Cleanup). |
| `start_points` | The feature heads `ledger status` prints after setup, copied exactly as it prints them: `prelude` from setup, `join` only once a launch got past integration (a new run has no `join` key). |
| `dry_run` | `true` only in the confirmation call. |
| `done`, `reviewed` | `[]` for a new run; on resume, from `ledger status --plan`. Never by hand. |
| `backfill` | Resume only: `{<task id>: {base, head}}` for done tasks, from `ledger backfill` (see Backfill below). Required for every done task; each `head` is the next task's review base. |
| `notes` | Optional, resume: `{<task id>: "<the user's answer>"}` for blocked questions; passed to that task's agents as "The user's answer for this task". |
| `sp_dir` | Output of `find-superpowers`, or `null`. |
| `agent_type` | Optional. The output of `bash <skill_dir>/scripts/find-agent-type` (exit 0), else `null`. Recompute it at every launch, relaunch, and resume. When set, every agent except `e2e`, `post-integrate`, and `post-integrate fix` runs as that custom agent type (a lean toolset; hook instructions may need any tool); a spawn that fails with it (throws or returns no result) is retried once on the default type, and both attempts count toward `max_agents`. After the first such throw, or the second typed agent that returns no result while its retry succeeds, every later agent of the run uses the default type: the run log says so and the run result carries `agent_type_fallback: true`. |
| `skill_dir` | `<skill_dir>`. |
| `python` | The output of `bash <skill_dir>/scripts/find-python` (see Paths and Python). Optional for the validator (default `python3`); the skill always sets it. |

Id rule (task ids, lane ids and `run_id`): ids name files, so two ids of one kind that differ only
in letter case (tasks `T1` and `t1`, lanes `A` and `a`) are an error, and so is an id whose part
before the first `.` is a Windows device name in any case (`CON`, `PRN`, `AUX`, `NUL`,
`COM1`-`COM9`, `LPT1`-`LPT9`; `nul` and `con.txt` too): either would share or open another file
on Windows or macOS. The dry run reports them.

Plan task ids must have `#+ Task <ID>:` headings and be safe file names (derive-lanes and
task-brief refuse others); agents extract briefs with `scripts/task-brief`, which fails on a
missing heading and, through `start-task --artifacts`, writes only inside the ledger dir. A brief ends with the Produces block
of each task its Consumes names and of each producer pre-flight added (`preflight.undeclared`:
the run passes them to `start-task` and `task-brief` as `--also`). Tasks the plan marks
after-merge, operator, or manual are left out of the manifest and listed in the confirmation
header.

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
   when `deps` is empty. Record every dependency you keep in the dependent's `depends_on`:
   `code` when it needs the producer's real code (the producer must be in the prelude,
   earlier in the same lane, or the dependent in join; the validator checks it), `contract`
   when it builds against the plan's contract. Unblock notes follow these edges.
4. Bridge files. A bridge only matters when you want its parts in different lanes:
   - A shared registry or list that every part extends (a module list, a route table): make
     a prelude task do the shared edit if the plan has one, or
   - accept a small merge: when each part adds its own separate line, keep the parts in
     separate lanes, keep the file in both tasks' files, and record it in `overlaps` (the
     tasks, why, and the merge owner); the validator allows a file in two lanes only with
     that record, the table header lists it, and the integration agent merges it. If commits
     already exist, check with `git merge-tree --write-tree <head1> <head2>` (exit 0 = clean).
   - Anything else (both parts change the same logic): keep them in one lane.
5. Small groups with nothing between them can share a lane (a lane is a sequence). Balance
   lanes so the longest lane, which sets the wall time, stays short.
6. More lanes than the cap is fine: extra lanes queue. A single lane is fine; a plan of 1-2
   runnable tasks is not a fit.
7. A task that commits nothing (end-to-end verification) becomes `hooks.e2e`, not a task, and
   goes in `excluded` with the reason `done by hooks.e2e`.
8. Every plan task the run does not run goes in `excluded` with its reason; `scripts/coverage
   <plan> <manifest>` must exit 0 (no plan task missing, no unknown or repeated id).

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
| standard | Opus (current), effort high | Default. Every task with logic or tests of logic. Always Opus: pre-flight, adjudicator, resolver, and final review agents, and reviewers (medium for small non-security diffs, see below). Integrate, e2e, and minor-only or docs-only final fixes start on Sonnet high and escalate to Opus. |
| sonnet | Sonnet (current), effort high | Implementers of well-specified tasks with some logic. After the first `changes` verdict the task escalates to Opus. |
| light | Sonnet (current), effort high | Implementers of mechanical tasks only: docs-only, example or config files without tests, version bumps, pure renames, fixture data. Escalates to Opus after the second `changes` verdict. |

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
| `park` | The task is deferred as it is, with its open findings: the run goes on, but the run is not accepted. |
| `unblock` | Deferred as for park; the text (the smallest change that unblocks dependents) goes to the tasks whose `depends_on` names it, else to the next task. |
| `stop` | Allowed only for `destructive` (irreversible operation), `security` (a security-sensitive decision), `outside_side_effect` (outside the run's worktrees), or `plan_broken` (every path is a guess). The run stops, resumable. |

A park or unblock runs `finish-task --settled`, which appends a `settled` ledger event with
the range git has (`outcome`, `base`, `head`, `commits`: commits a blocked agent made stay
with the task) and prints the head the adjudicator returns. The task result is `deferred`,
never `done`; a resume schedules it as done (`ledger status` lists it in `deferred`) and the
run is still not accepted. A security-flagged task is never parked or unblocked, whatever its
findings (`adjudicator_stop: security`), and `allow_deferral: false` refuses it for every task
(`adjudicator_stop: deferral_not_allowed`). A task adjudicated twice and still blocked ends with
`adjudication_cap`. Every ruling is a
ledger `ruling` event `Ruling: decision - why - cost if wrong`; pre-flight rulings are in
`preflight.rulings`.

Pre-flight also returns `code_deps` (`[{task, producer, what}]`, required, may be empty): code a
task needs from another task's work. An entry the run order already meets (the placement rule
`validateManifest` applies to `depends_on` kind `code`: the producer is before the task and in
the prelude, in the same lane, or the task is in join) only adds the producer to the task's
briefs, like `undeclared`. An unmet one is a schedule problem no ruling can fix: the run stops
with `preflight_conflicts` in both modes (the adjudicator is not called), and
`preflight.schedule` lists each as `{task, producer, what, fix}`, `fix` being the move that meets
it (`move T to join after P`, `move T after P in the prelude`, or `move T to join, or into P's
lane after it`). `preflight.schedule` is always present on a full-profile run (`[]` when there
is none) and is `[]` under lite, which has no pre-flight agent.

Run rulings: pre-flight's own rulings, then the adjudicator's ruling on pre-flight conflicts,
reach every task not yet done and every final reviewer as "Rulings already made for this run
(binding)", in that order, each quoted as written, so no agent decides a settled point again.
The workflow builds that list (`run_rulings`) itself during the run and never reads it from
the manifest file. The user's answers (`notes`) keep their own label, and an adjudicator's
`answer` or `clarify_plan` for one task reaches only that task. Both appear in the hand-back under "Rulings made on your behalf". Under
`supervised` there is no adjudicator: a blocked task, a question, or the review cap
(`review_rounds`) stops the run.

## Fix commits

The plan's commit message applies to a task's first commit. Since the commit rules forbid
amending, every later commit (a fix, or more work on a task) carries a message of its own, in
the form the commit rules use (for example their prefix style):

- a task fix round: `fix: address review findings for Task <id>` (a batch: `fix: address
  review findings for Batch <first>-<last>`);
- the final fix: `fix: address the final review findings`;
- the post-integration fix: `fix: make the post-integration check pass`;
- an implement attempt that adds to a task's first commit (a retry, an escalation, or a
  reopened task; a first attempt is not told this): the task fix round message when review
  findings are behind it, else `chore: continue Task <id>` (no review raised anything for it
  to fix).

Every reviewer, re-reviewer, and final lens is told the same, and that none of the plan's
message on a first commit, a fix message on a fix commit, and the continuation message is a
commit-rule finding (before 1.3.1 each fix round repeated the task's message, and reviewers
raised it).

## Budgets

- `limits.max_agents`: set to 2 x the dry-run estimate (which lists the Verify agents as an
  upper bound: `verify` runs whenever a check command exists, the rechecks only when later
  commits made earlier evidence stale). The `model` and `effort` of each dry-run agent are a
  worst case for its first attempt (`final_fix` is listed on Opus, though a fix of only minor
  or docs-only findings starts on Sonnet); escalations, retries, and fix rounds are extra
  agents the list does not show. A refused agent ends its task or phase without work;
  the run stops with reason `budget`, resumable, never accepted.
- `limits.max_rulings`: 25 adjudicator rulings per run.
- The final phase has one fix wave. On a cap the run stops cleanly, the session reports and
  notifies. Raise the limit in the manifest, then resume; that goes through Confirmation again
  (dry run, table, explicit yes). The only edits that
  need no second table are `setup_result`, `start_points`, and the relaunch budget carry-over.
- The `verify` agent (the project checks through `scripts/run-checks`) runs even past
  `max_agents`: the checks are cheap and deterministic, so the evidence after the last change
  exists even when the budget is spent. When the budget stops the run after the join (in E2E or
  the final review), the stopped report carries `verify` at the feature head it reached; it
  counts in `agents_spawned`, which can then exceed the cap by one, or two when a verify that
  returned nothing is retried.
- A relaunch after a transient stop lowers `max_agents` by the stopped run's
  `agents_spawned` and `max_rulings` by its `rulings_spent`, the adjudications that ran
  (floor 0). Use `rulings_spent` here, not a count of ledger `ruling` events (implementers
  record their own smaller rulings there too; only `spent` below counts the adjudicator's
  own, as a floor after a session that died). Fewer than 1 agent left is treated as a budget
  cap.
- Spend across launches: after every launch returns (a relaunch included, never a dry run),
  record what it spent:
  `<python> <skill_dir>/scripts/ledger ended <ledger_dir> <status> <agents_spawned> <rulings_spent>`
  (`status`: the run status, or `unaccepted` for a complete run that is not accepted or whose
  hand-back gate (check-verify) fails). It appends the
  `run_ended` event to `<ledger_dir>/_run.jsonl` and refuses (exit 2, nothing recorded) a
  count that is not an integer of 0 or more, or an empty status. At the end of a run it goes in
  one command line with the lock release (SKILL.md Launch step 5). `ledger status`
  sums them as `spent`; `spent.rulings` is at least the adjudicator's own `ruling` events (they
  survive a session that died), and `spent.unrecorded_launches` counts launches that recorded
  no end (their agents are not in `spent.agents`: say so). That count includes a launch still
  in progress, or one whose `ledger ended` has not run yet: a `ledger status` taken during a
  run shows at least 1. On a resume, set
  `limits.max_rulings` to the run's ruling cap (25, or what the user set at the first table)
  minus `spent.rulings` (floor 0; the user may raise it at the table), keep `max_agents` at 2 x
  the new dry-run estimate (the work left), and show `spent` in the table header.
- Every launch is a new Workflow call (never `resumeFromRunId`), so no agent result is
  replayed from a cache: `agents_spawned` counts spawns that ran (a retry is a spawn of its
  own). Agent count is the only budget the run enforces; tokens and time per agent are reported
  afterwards by `scripts/run-report`, not capped. This has not been checked in a live Workflow
  session.
- Concurrency: the Workflow tool itself caps how many agents run at once
  (`CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS`; by default it follows the machine's CPU
  count). Agents past the cap wait for a free slot, so the table's "lanes at once"
  (`lanes_effective`, from `limits.max_parallel_lanes`) can overstate how many lanes really
  progress together when the cap is lower. Raising the cap runs more agents at once, and each
  running agent takes memory, so raise it only on a machine with memory to spare; lowering
  `max_parallel_lanes` instead keeps the table accurate.

## Active-run markers and stops

Markers live in `<config dir>/parallel-lanes/active/` (`$PL_ACTIVE_DIR` overrides).
`scripts/active-run acquire <run_id> <manifest>` creates `<run_id>.lock` atomically (it fails
with exit 4 when it exists: another session may still be running the run), writes the marker
`{run_id, manifest, started, status: running}`, and prints the owner token; `scripts/setup`
refuses unless the lock exists and `--owner <token>` matches it, so a second launch or
resume cannot reset work in progress. Keep the lock through a transient relaunch; `remove`
refuses a locked run unless `--takeover`. `--takeover` replaces a stale lock: use it only when the user confirms
the session that held it has ended. `release <run_id> <status> --owner <token>` drops the lock and records
the status; `release <run_id> --remove --owner <token>` drops both (only for an accepted run).
`--owner` is required (exit 2 without it). A token that is not the lock's (a takeover replaced
it) exits 4 and changes nothing, so a session that lost the run cannot release it; a run whose
lock is already gone still gets its status recorded. `list` prints
every marker with `locked`; the next session's bootstrap offers an unlocked one for a
one-word resume and reports a locked one as possibly still running.

Checkout lock (git mode): `scripts/setup` also takes `checkout-<st_dev>-<st_ino>.lock` in the
same directory, holding `{"run_id", "checkout"}`. It is keyed by the main checkout's file
identity, so another spelling or a symlink of the same checkout is the same lock, while separate
worktrees of one repo are not; it stops two runs from switching one checkout to their feature
branches. Setup exits 4 with `the checkout ... is in use by run ...` when that run's launch lock
still exists; a checkout lock whose run has no launch lock is stale and is taken over, and a
run's own lock is kept across a relaunch or resume. `release` and `remove` delete the run's
checkout locks. Shadow mode has none (each run has its own feature worktree).

`acquire`, `release` and `remove` work under a per-run mutex, the directory
`<active dir>/.<run_id>.mutex`. A waiter retries for `PL_MUTEX_WAIT` seconds (default 10), then
exits 3 with `active-run: <path> is held; if no active-run is running, remove it`: delete that
directory only when no `active-run` is running.

Transient vs real stops (SKILL.md "Transient stops"): only agent errors, missing results
(`no result from ...`, `error: ...`), and setup-command retry exhaustion (`setup failed`) are
transient and relaunch once without asking. `review_rounds`, a supervised blocked or question
task, `adjudication_cap`, `adjudicator_stop: <condition>`, `budget`, failed integration or
post-integrate on real failures, `invalid`, and `preflight_conflicts` always stop for the
user. The session notifies (PushNotification, else a chat notice) on completion, any real
stop, a budget cap, and a failed relaunch.

## Report

`<python> <skill_dir>/scripts/run-report <transcript_dir> <manifest> [--out FILE]` reads the
workflow transcript directory printed at launch (`agent-*.meta.json` and `agent-*.jsonl`).
Output: `agents` (per agent: label, phase, task, role, requested and resolved model,
`resolved_models` with message counts, effort, input, output, cache read, and cache creation
tokens), `tiers` (totals per tier), `totals`, `models` (agents per resolved model), and
`unavailable`, `output_incomplete`, `escalations`, `fix_rounds`, `retries` counts. A field
that cannot be read is the string `unavailable`, never a guess. Effort comes from the
workflow result file, which the Workflow tool writes to `<session>/workflows/wf_<id>.json` for
a transcript directory `<session>/subagents/workflows/wf_<id>/` (`<transcript_dir>.json`
beside the directory is the fallback): its `agent_settings`
(`[{label, model, effort}]`, one per agent started, in start order) gives every agent's
effort, not only the implementers'; without that file an agent's effort is `unavailable`.
Transcripts often keep only
the mid-stream output count of a message (`stop_reason` null); such an agent's
`output_tokens` is `unavailable` and `output_tokens_min` holds the lower bound. When any
agent counted in a tier (or in the run) is incomplete, that tier's (or `totals`')
`output_tokens` is `unavailable` too, since the sum would be an undercount, and
`output_tokens_min` still sums every count there is: when `output_incomplete` > 0 report
`output_tokens_min` as the output figure (a minimum). Report both,
and call out any agent whose `resolved_models` names a model other than the one requested
(a fallback).

`<python> <skill_dir>/scripts/check-verify <transcript_dir> <manifest>` takes the same two
arguments and prints one status JSON line (see "Verify evidence").

Acceptance: `status: complete` only says the run executed to the end. `acceptance`
(`{status, delivered_sha, reasons, warnings}`) says whether the delivered revision
(`delivered_sha`: the feature head after the final fix) meets the gates, decided in code
from the evidence: `accepted` (no reason), `rejected` (a check failed at `delivered_sha`, a
blocking finding is open, or a task is deferred or not done), or `unverified` (nothing failed,
but evidence is missing or covers another revision). Reasons are `{kind, class, detail}`:
`checks_failed`, `checks_missing`, `checks_stale`, `checks_incomplete` (from `verify`, the
`scripts/run-checks` result at `delivered_sha`), `e2e_failed`, `e2e_missing`, `e2e_stale`
(`e2e.checked_sha`), `post_integrate_failed`, `post_integrate_missing`,
`post_integrate_stale`, `blocking_findings` (open critical or important final findings),
`review_missing` (a final lens with no result), `review_unbound` (the final lenses did not all
review one commit; `final.review_problem` is its detail), `checks_unclean` (see below), `fix_unreviewed`, `final_fix_unreviewed` (the
final fix committed, but no re-review judged its head), `deferred_task`, `task_not_done`. Four
more reasons are session-side: `verify_evidence_missing`, `verify_evidence_stale`,
`verify_mismatch` and `verify_invalid` are set by `scripts/check-verify` at hand-back (see
"Verify evidence"), not by the workflow, and are never in `result.acceptance`.
`run-checks` also reports `tracked_before` and `tracked_after`: the lines `git status --porcelain
--untracked-files=no` printed before the first command and after the last (`[]` when clean;
`ok`, `clean` and the exit code are unchanged). Acceptance gives `checks_unclean` (class
`missing`) when the verify result at the delivered revision has a non-empty list or lacks one,
because checks that ran on uncommitted tracked changes did not test the commit.
Warnings (open minor findings, cannot-verify entries with a source, checks that left the
checkout dirty or did not say) never block. The checks evidence is the
`scripts/run-checks` JSON the verify agent returns (the workflow cannot read files; the same
JSON is saved under `<ledger_dir>/checks/` for the user to compare): the session
compares that report with the saved JSON at hand-back; it does not re-run the checks (see
"Verify evidence"). `run-checks` keeps the commands' output out of its own stdout and
stderr: each command's combined output goes to a log file beside that JSON (`<out stem>.<N>.log`,
or a new temporary directory without `--out`, which the caller removes once it has read the logs:
agents are told to), and each result carries `log` (its path) and `tail` (its last 20 lines, kept
to the last 4096 characters and starting with `[truncated] ` when cut, so one long line stays
out too). `--root` checks the JSON and its logs only with `--out`. Verify runs once at the delivered revision, after the final fix and
before the final re-review, which gets its result and does not rerun the checks; the E2E and
post-integrate rechecks are told the project checks already ran at that commit and run only
what their hook adds. Show the
status and every reason first; only `accepted` is delivered work. A reason or warning the
user explicitly accepts is recorded with `ledger accept <ledger_dir> <repo root>
<delivered_sha> "<what>"` (an `accepted` event; `ledger status` lists them under `accepted`)
and shown as accepted by the user, never folded into `accepted`.
Each task result's `commits` is its range `[base, head]` (the base before its first commit and
its last head), not a list of commits; the ledger's `committed` events list every commit.

`cannot_verify`, in every task review and re-review and every final lens result, is
`[{requirement, source, why, check_by}]`: a requirement the agent needed to check and could
not, with `source` citing the plan task step or spec section it comes from. Things it
verified, verdicts or decisions, limits the plan already accepts, the instruction not to
re-run tests, and problems (those are findings) do not belong there. Acceptance warns only on
entries with a non-empty `source`; the run's own gap notes ("the e2e check returned no
result") are entries with `source: "run"`, so they warn too. A plain string (an agent from
before 1.3.1) is kept in the report as a note, not a warning.

The verify step runs one check inventory (`finalChecks`): the project `test`, `lint` and `build`
commands in that group order, then for each lane in manifest order the commands its
`lane_commands` override adds (test, lint, build order), skipping a `group` and `command`
already listed. Its setup is the project `setup` commands, then each lane's override `setup`
commands not already listed. Acceptance expects exactly that list in that order
(`checks_incomplete` otherwise).

`final.lens_heads` is `[{lens, head}]`, the revision each final lens reported (`head` is the
reported string, or `null` when the lens returned no result). When a lens that returned
findings (an array, even an empty one) reported no commit sha, or the lenses reported
different commits, `final.review_problem` says so and acceptance gives `review_unbound`
(class `missing`) with that text; the key is absent when the heads agree.

`final` lists findings with stable ids (`F1`...; `N1`... for problems the fix introduced) as
`fixed`, `declined` (a decline the re-review agreed with), and `open` (each with a reason).
Findings two lenses report at the same `file` and `line` (when `line` > 0), or on the same
`commit <sha>` file, are merged: the merged finding keeps every lens and the issue text,
severity, and fix of its most severe report (the first of those on a tie), so the text
matches the severity, and the other texts as `also_reported`; every other finding
stays separate. Every minor finding of an approved task review gets an id `<task>-<n>`, with
`T` put in front of a task id that starts with a digit (task 3 gives `T3-1`, task T2 gives
`T2-1`), and goes to the final lenses as a checklist: a lens raises one by putting its id in brackets in a
finding's issue, or leaves it. `final.task_minors_open` lists the ones no lens raised: show
them in the report, so minors from task reviews are not lost. Task minors are not stored in
the ledger: after a resume, the tasks an earlier launch committed and reviewed are not re-run,
so their minors reach neither the final lenses nor `task_minors_open`; the run says so in a
`cannot_verify` note (a plain string, so not a warning, since every resume has such tasks)
naming those tasks (check them in the earlier launch's report).
The fixer gives each id a disposition with its evidence; the re-review names the revision it
judged (`head`). A finding the fix gave no disposition for, a disposition or re-review result with blank
evidence, a re-review of another revision than the fix
head, or two different dispositions or results for one id leave the finding open (the new
findings such a re-review reports are kept).
`ledger status <ledger_dir> --manifest <manifest file>` lists under `undeclared` the files each
task's recorded range changed outside its `files` (from git; a batch's files count for each of
its tasks): list them in the report so the user can see work that went beyond the plan.

The hand-back appends the report, saves it beside the manifest, and lists
"Rulings made on your behalf" from the ledger `ruling` events plus `preflight.rulings`. When
a task result's `rulings` has an entry starting `refused (security-gated):` or
`refused (deferral_not_allowed):`, the policy refused the adjudicator's park or unblock: list
that ruling with the prefix, never as one that took effect. An adjudicator that itself chose stop (`adjudicator_stop: <condition>` with no
such entry) is listed as a stop ruling, as written. `preflight.undeclared` lists the
dependencies pre-flight found that a task relies on without naming the producer in its
Consumes (`{task, producer, what}`, after dropping entries with an unknown or done-and-reviewed task, an
unknown producer, or a task equal to its producer; a task done and reviewed is dropped, one done but still to review is kept); the hand-back lists them under
"Dependencies pre-flight added" so the user can name them in the plan. When the run result has
`agent_type_fallback: true`, say in the report that the run switched to the default agent type
partway through (see `agent_type` under Manifest fields). The run result's `agent_settings`
lists the model and effort of every agent started, in start order (what `run-report` reads
for effort).

## Verify evidence

`<python> <skill_dir>/scripts/check-verify <transcript_dir> <manifest>` compares the verify agent's
report (`result.verify` in the workflow result file, found from the transcript directory as
`run-report` finds it) with the `scripts/run-checks` JSON saved at
`<ledger_dir>/checks/verify-<sha>.json` during the same launch (`ledger_dir` is `repo.ledger_dir`
in the manifest). It catches an agent that reports something other than what run-checks wrote (for
example passing checks that failed), a verify step that left no evidence, and evidence left over
from an earlier launch.

Trust boundary: the session compares the agent's report with the saved check evidence; it does
not re-run the checks. It does not establish that verification happened correctly. It does not
catch an agent that writes or alters both copies consistently, execution details both copies agree
on but that are wrong (`checkout`, `branch`, `log` and `tail` are not compared), or a session that
skips the checker or misreports its result. It is not an independent execution guarantee.

Output: one JSON line on stdout, `{"status", "reason"?, "path"?, "differences"?, "detail"?}`.

| status | reason | exit | meaning |
|---|---|---|---|
| `match` | - | 0 | report and evidence agree; the evidence was written during this launch |
| `not_required` | - | 0 | no verify result, and the workflow accepted the run (rule 3) |
| `missing` | `verify_evidence_missing` | 1 | no evidence file, or no verify result although the run was not accepted |
| `stale` | `verify_evidence_stale` | 1 | the evidence file was last written before this launch started |
| `mismatch` | `verify_mismatch` | 1 | report and evidence differ |
| `invalid` | `verify_invalid` | 1 | the report, the evidence, the sha, the start time or the acceptance is malformed (`detail` says which) |

Exit 2: usage error, or the result file or the manifest cannot be found or read (message on
stderr). Exit 3: a Windows path cannot be converted (no Git Bash or cygpath, as the other helpers).

The gate: the hand-back may say `accepted`, and Launch step 5 may release with `--remove`, only
when `result.acceptance.status` is `accepted` AND check-verify exited 0 AND its stdout parsed as
one JSON object with status `match` or `not_required`. Every other outcome (exit 1, 2 or 3, a
crash, no output, unparseable output, an interrupted run) makes the hand-back `unverified` and
keeps the marker (released with `unaccepted`). Name the cause: the status and reason, or
"check-verify error" with its exit code and stderr.

Rules, in order:

1. Read the manifest (exit 2 if unreadable or `repo.ledger_dir` is not a string) and the result
   file (exit 2 if none is readable or it has no `result` object).
2. `result.acceptance` must be an object with a string `status`; else `invalid`.
3. `result.verify` null or absent: `not_required` when acceptance is `accepted`, else `missing`.
   The workflow never accepts a run that has final checks (a test, lint or build command) and no
   verify result, so an accepted run without one had no checks to run.
4. Validate the report: `head` a string; `ok` and `clean` booleans; `results` a list of objects
   with string `group` and `command` and an integer `exit` (never a boolean); `tracked_before` and
   `tracked_after`, when present, lists of strings. Else `invalid`, with `detail` naming the field.
5. The sha is `result.delivered_sha` when not null, else `result.verify.head`. It must be 40 or 64
   lowercase hex digits; else `invalid`, and it is never put into a path.
6. No evidence file: `missing`. Not JSON or failing rule 4 (the tracked lists may be absent, as
   older run-checks wrote them): `invalid`.
7. Freshness: the evidence file must not be older than the result file's `startTime` (epoch
   milliseconds; absent or not a number: `invalid`); an older file is `stale`.
8. Compare `head`, `ok`, `clean`, `tracked_before`, `tracked_after`, then `results` position by
   position as `{group, command, exit}`. A field present on one side only differs. Any
   difference is `mismatch` (each is `{"field", "reported", "evidence"}`); none is `match`.

Limitation: each attempt overwrites `verify-<sha>.json` through run-checks `--out`; unique
per-attempt records are later work. So evidence from an earlier verify at the same sha is told
apart only by its modification time.

Recovery. Resuming a complete run does not run verify again, so resuming alone cannot clear
`verify_evidence_missing`, `verify_evidence_stale`, `verify_mismatch` or `verify_invalid`.

- Checker error (exit 2 or 3, a crash, bad output): fix the cause (path, manifest, missing Git
  Bash) and run check-verify again.
- `missing`, `stale`, `mismatch`, `invalid`: the session runs the final checks itself at the
  delivered revision in the feature checkout: the setup commands, then the same run-checks command
  the verify prompt gives, with `--out <ledger_dir>/checks/session-verify-<sha>.json --root
  <ledger_dir>`. Show the result. When every exit is 0, `ok` is true, both tracked lists are
  empty and `head` is the delivered sha, the user may accept the run explicitly; record that with
  `ledger accept <ledger_dir> <repo root> <sha> "session re-verified: <path>; replaces <reason>"`.
  That is an explicit override recorded in the ledger (an `accepted` event), not a match:
  check-verify still reports its original status for that launch. Otherwise the run stays
  unverified; the user fixes the cause and resumes, as for any other reason.

## Backfill

`<python> <skill_dir>/scripts/ledger backfill <ledger_dir> <manifest file>` prints
`{backfill, derived, errors}`. Every `committed` event `finish-task` writes records the task's
`base` and `head` and every commit git lists between them, and a `settled` event the range git
had, so a task's range runs from the base of its first event to the head of its last. Each
range is checked against git (the base is an ancestor of the head, recorded commits equal
`git rev-list`), and events whose bases do not chain are refused: exit 3 with `errors` means a
resume must not guess; show them and stop. Older ledgers recorded no base: those tasks are
listed in `derived` and get the head of the previous done task in their list as base (the
first of the prelude and of each lane: the last prelude head or the setup start point; of the
join: the join start point), which is the widest range they can have; say so in the table
header.

`ledger status --plan <plan> [--spec <spec>]` also checks approvals: a review recorded with
`ledger reviewed` holds the hash of the task's section and the head of the range it approved
(it refuses an approval that reports a critical or important finding; a fix agent records
`reopened` when the engine acted on such an approval as changes); a changed
section or head puts the task in `stale`, a review without a hash (older ledgers) in
`unbound`, and both are left out of `reviewed` so the resume reviews them again. `inputs`
says whether the plan or spec changed since the last launch recorded their hashes. A stale
task that is not the last done task of its list is reviewed against the current plan, but a
fix for it lands after the later tasks' commits; tell the user, who may prefer rerunning it
and the tasks after it. With `--manifest`, a reviewed task whose `depends_on` names a stale
task is stale too, transitively (it was built on, or against, the approval that no longer
holds), so it is reviewed again as well.

The implementer's start-task call records the task base as a `started` event before any
write (`--record-start`). A task's first recorded range must start at the base of its latest
`started` event; otherwise the task is listed in `inconsistent` and backfill refuses, so a
range never silently starts somewhere the task did not.

To take a deferred task up again (the user wants it done after all) when it is the last
done task of its list, leave it out of `done`, `reviewed`, and `deferred` on the resume: it
runs again from the previous task's head, its earlier commits stay on the branch, and its
implementer starts from them. When later tasks of its list are done, or its lane is already
merged, its range would take in their commits: leave those later tasks out too, so they all
run again in order, or plan the follow-up as a new task.

`carry`: `{<task>: <text>}` for each task the adjudicator last unblocked, with its unblock
ruling. A skipped task passes no note at run time, so for each entry add
`from <task>, unblocked by the adjudicator: <text>` to `notes` for the tasks whose
`depends_on` names it (else the next task in the same list; after a batch, the task after
the batch), appended to any existing note for it. During a run the engine does the same:
within a list, and from the prelude to the lanes and join and from the lanes to the join
(lanes run at once, so not from one lane to another).

It is required because each `head` is the next task's review base, and done-but-unreviewed
tasks get a review first. A wrong base silently changes the review range of every done task.

## Shadow repos

The shadow for a project is
`<config dir>/parallel-lanes/shadow/<first 16 hex of sha256(physical project path)>`:

```bash
p="$(cd "<project>" && pwd -P)"
h="$(printf '%s' "$p" | { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-16)"
d="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/parallel-lanes/shadow/$h"
test -f "$d/pl-baseline" && echo "existing shadow: $d"
```

The shadow repo's config sets `core.autocrlf=false`, so lane worktrees hold the project's
exact bytes whatever the user's git settings. A shadow made before 1.3.1 lacked that setting:
on a machine with `core.autocrlf=true`, the first setup after the upgrade sees every text file
in its lane worktrees as modified (they were checked out with CRLF), lists them as discarded
edits, saves a preserved ref, and checks them out again. That happens once and loses nothing
a task committed.

A new shadow also holds `<gitdir>/info/attributes` with `* -text -eol -filter -ident
-working-tree-encoding`. It outranks the project's `.gitattributes` and the user's
`core.attributesFile`, so the baseline, the lane worktrees and every commit keep the project's
exact bytes (merge and diff attributes still apply). `preview` and `writeback` hash project
files with the shadow's attributes (`git hash-object`, no `--no-filters`), so a file is a
conflict only when its bytes differ. A shadow made before 1.4.0 keeps its old representation:
it is not given the file, because its baseline was made with the project's attributes and
adding it mid-run would make every normalised file look modified. Use it only to resume its
run; a new run gets a new shadow (remove the old one first, see below).

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

A worktree with uncommitted files stays; list it for the user. Changes setup discarded are
saved under `refs/parallel-lanes/<run_id>/abandoned/` (`setup_result.preserved`): restore one
with `git -C <wt> checkout <commit> -- .`, and once the user no longer needs it, delete it
with `git -C <root> update-ref -d <ref>`. In shadow mode remove the lane
worktrees first, then `<worktree_root>/feature` with the same status check and
`git --git-dir="<git_dir>" worktree remove`, then run `shadow remove` (it deletes the shadow
repo with its remaining branches). Remove `worktree_root` if it is empty (`rmdir`).
