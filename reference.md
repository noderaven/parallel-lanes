# parallel-lanes reference

Details for SKILL.md. `<skill_dir>` is the absolute directory holding SKILL.md. The
validator in `run.workflow.js` (`validateManifest`) is authoritative;
`manifest.schema.json` documents it. A dry run reports every validation error. Adopting earlier work from a hand-run
attempt, with a worked example, is in adopt.md. `<config dir>` below is
`${CLAUDE_CONFIG_DIR:-~/.claude}`; every helper uses the same one.

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
| `hooks` | Optional `post_integrate` (instructions for an agent after integration, e.g. a contract check) and `e2e` (instructions for an end-to-end check, e.g. "Follow plan Task T24"). |
| `limits` | `review_rounds: 5`, `max_parallel_lanes: min(5, CPU count + 2)` (the count from `os.cpu_count()`), `max_agents` (2 x the dry-run `agents` length), `max_rulings` (25); see Budgets. |
| `autonomy` | `autonomous` (default: the adjudicator settles blocked tasks, questions, review caps, pre-flight conflicts) or `supervised` (they stop the run and wait for the user). The user may override it in the table. |
| `profile` | `full` (default) or `lite` (see Profiles). |
| `setup_result` | The output of `scripts/setup <manifest> --owner <token>`: `{feature_head, worktrees, discarded, preserved}`. Added after the yes to the table; required for a launch (there is no setup agent; a dry run does without it). `preserved` lists the commits under `refs/parallel-lanes/<run_id>/abandoned/` that hold changes setup discarded (see Cleanup). |
| `start_points` | `{prelude, join}` feature heads, copied verbatim from `ledger status` after setup. |
| `dry_run` | `true` only in the confirmation call. |
| `done`, `reviewed` | `[]` for a new run; on resume, from `ledger status --plan`. Never by hand. |
| `backfill` | Resume only: `{<task id>: {base, head}}` for done tasks, from `ledger backfill` (see Backfill below). Required for every done task; each `head` is the next task's review base. |
| `notes` | Optional, resume: `{<task id>: "<the user's answer>"}` for blocked questions; passed to that task's agents. |
| `sp_dir` | Output of `find-superpowers`, or `null`. |
| `agent_type` | Optional. The output of `bash <skill_dir>/scripts/find-agent-type` (exit 0), else `null`. Recompute it at every launch, relaunch, and resume. When set, every agent except `e2e`, `post-integrate`, and `post-integrate fix` runs as that custom agent type (a lean toolset; hook instructions may need any tool); a spawn that fails with it (throws or returns no result) is retried once on the default type, and both attempts count toward `max_agents`. After the first such throw, or the second typed agent that returns no result while its retry succeeds, every later agent of the run uses the default type: the run log says so and the run result carries `agent_type_fallback: true`. |
| `skill_dir` | `<skill_dir>`. |

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
`preflight.rulings`. Both appear in the hand-back under "Rulings made on your behalf". Under
`supervised` there is no adjudicator: a blocked task, a question, or the review cap
(`review_rounds`) stops the run.

## Budgets

- `limits.max_agents`: set to 2 x the dry-run estimate (which lists the Verify agents as an
  upper bound: `verify` runs whenever a check command exists, the rechecks only when later
  commits made earlier evidence stale). A refused agent ends its task or phase without work;
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
  `python3 <skill_dir>/scripts/ledger append <ledger_dir> _run '{"task":"_run","event":"run_ended","status":"<status>","agents":<agents_spawned>,"rulings":<rulings_spent>}'`
  (`status`: the run status, or `unaccepted` for complete but not accepted). `ledger status`
  sums them as `spent`; `spent.rulings` is at least the adjudicator's own `ruling` events (they
  survive a session that died), and `spent.unrecorded_launches` counts launches that recorded
  no end (their agents are not in `spent.agents`: say so). On a resume, set
  `limits.max_rulings` to the run's ruling cap (25, or what the user set at the first table)
  minus `spent.rulings` (floor 0; the user may raise it at the table), keep `max_agents` at 2 x
  the new dry-run estimate (the work left), and show `spent` in the table header.
- Every launch is a new Workflow call (never `resumeFromRunId`), so no agent result is
  replayed from a cache: `agents_spawned` counts spawns that ran (a retry is a spawn of its
  own). Agent count is the only budget the run enforces; tokens and time per agent are reported
  afterwards by `scripts/run-report`, not capped. This has not been checked in a live Workflow
  session.

## Active-run markers and stops

Markers live in `<config dir>/parallel-lanes/active/` (`$PL_ACTIVE_DIR` overrides).
`scripts/active-run acquire <run_id> <manifest>` creates `<run_id>.lock` atomically (it fails
with exit 4 when it exists: another session may still be running the run), writes the marker
`{run_id, manifest, started, status: running}`, and prints the owner token; `scripts/setup`
refuses unless the lock exists and `--owner <token>` matches it, so a second launch or
resume cannot reset work in progress. Keep the lock through a transient relaunch; `remove`
refuses a locked run unless `--takeover`. `--takeover` replaces a stale lock: use it only when the user confirms
the session that held it has ended. `release <run_id> <status>` drops the lock and records
the status; `release <run_id> --remove` drops both (only for an accepted run). `list` prints
every marker with `locked`; the next session's bootstrap offers an unlocked one for a
one-word resume and reports a locked one as possibly still running.

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
(a fallback).

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
`review_missing` (a final lens with no result), `fix_unreviewed`, `final_fix_unreviewed` (the
final fix committed, but no re-review judged its head), `deferred_task`, `task_not_done`.
Warnings (open minor findings, cannot-verify items, checks that left the checkout dirty or did
not say) never block. The checks evidence is the
`scripts/run-checks` JSON the verify agent returns (the workflow cannot read files; the same
JSON is saved under `<ledger_dir>/checks/` for the user to compare): an agent that misreports
it is not caught by the run. Show the
status and every reason first; only `accepted` is delivered work. A reason or warning the
user explicitly accepts is recorded with `ledger accept <ledger_dir> <repo root>
<delivered_sha> "<what>"` (an `accepted` event; `ledger status` lists them under `accepted`)
and shown as accepted by the user, never folded into `accepted`.
`final` lists findings with stable ids (`F1`...; `N1`... for problems the fix introduced) as
`fixed`, `declined` (a decline the re-review agreed with), and `open` (each with a reason).
The fixer gives each id a disposition with its evidence; the re-review names the revision it
judged (`head`). A disposition without evidence, a re-review of another revision than the fix
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
partway through (see `agent_type` under Manifest fields).

## Backfill

`python3 <skill_dir>/scripts/ledger backfill <ledger_dir> <manifest file>` prints
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
h="$(python3 -c 'import hashlib, sys; print(hashlib.sha256(sys.argv[1].encode()).hexdigest()[:16])' "$p")"
d="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/parallel-lanes/shadow/$h"
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

A worktree with uncommitted files stays; list it for the user. Changes setup discarded are
saved under `refs/parallel-lanes/<run_id>/abandoned/` (`setup_result.preserved`): restore one
with `git -C <wt> checkout <commit> -- .`, and once the user no longer needs it, delete it
with `git -C <root> update-ref -d <ref>`. In shadow mode remove the lane
worktrees first, then `<worktree_root>/feature` with the same status check and
`git --git-dir="<git_dir>" worktree remove`, then run `shadow remove` (it deletes the shadow
repo with its remaining branches). Remove `worktree_root` if it is empty (`rmdir`).
