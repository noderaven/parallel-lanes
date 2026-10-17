# parallel-lanes reference

Details for SKILL.md. `<skill_dir>` is the absolute directory holding SKILL.md. The
validator in `run.workflow.js` (`validateManifest`) is authoritative;
`manifest.schema.json` documents it. A dry run reports every validation error. Adopting earlier work from a hand-run
attempt, with a worked example, is in adopt.md. `<config dir>` below is
`${CLAUDE_CONFIG_DIR:-~/.claude}`; every helper uses the same one.
`<python>` below is the manifest's `python` (see Paths and Python).

## Contents

- Paths and Python: finding Python, how every helper command starts, path forms
- Manifest fields: every manifest field, what it holds and its limits
- Flow details: notices, git identity, the confirmation header, transient stops
- Building lanes: turning derive-lanes facts into prelude, lanes and join
- Worth it: whether a layout saves enough to pay for a run's fixed phases
- Join waves: join tasks side by side on their own branches, merged after each wave
- Profiles: full and lite
- Tiers: standard, sonnet and light tasks, and escalation
- Batching: light tasks run as one unit
- Adjudicator: blocked tasks, rulings and their limits
- Carry-over: rulings, task minors and owners passed between agents
- Fix commits: the message of every commit after a task's first
- Budgets: agent and ruling limits, the repair reserve
- Check ownership: which agent runs which checks, task-checks selection
- Long checks: reserving, starting and waiting on a check
- Exit codes: the busy, timeout and signal codes a check may return
- Active-run markers and stops: launch locks, setup exit 4, stopping a run
- Usage limit: the platform pause and the agents_unavailable stop
- Report: run-report output, the report contents, the run tools line
- Verify evidence: check-verify and the acceptance gates
- Backfill: rebuilding commit ranges in an older ledger
- Shadow repos: runs on a folder that is not a git repo
- Run history: archive-run, the history folder and its index
- Autopsy: where a run's time went, slowdowns and suggestions
- Audit: what the archive proves about each task
- Doctor: the machine checks before a dry run
- Launch conditions: doctor's result bound to each launch
- Cleanup: removing a finished run's branches and worktrees
- Uninstall: removing the skill

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
| `lane_commands` | Optional `{<lane id>: {setup?, test?, lint?, build?}}` overrides for lanes that need only a subset (e.g. backend lanes skip the frontend suite). They are the lane's own checks: integration and verify run every distinct one, so a narrower run of a project check belongs in `task_checks`, not here. |
| `task_checks` | Optional `{<task id>: {test, lint?, build?}}`: the targeted checks a task runs once before committing (see Check ownership). `test` is required and names at least one command; an absent `lint` or `build` inherits the lane's. A batch uses its last task's entry. Every command must be a narrower run of a check the delivery inventory already runs, in the same checkout and environment; must run correctly at the task that uses it (list the lane's test files created or changed by that task and the lane's earlier tasks, cumulatively, so no entry names a file a later task creates); must fail when it selects no tests (name existing test files; a filter that passes on zero matches needs a wrapper that fails); and keeps an explicit worker limit like the project's test command (for example `node --test --test-concurrency=4 ...`). Derive the entries from the briefs' test files and commands; a task you cannot map gets no entry and runs its lane's checks. Never part of the delivery inventory. An entry for a task whose lane (or, for a prelude or join task, the project) has no test, lint or build command is a validation error from 1.6.10: the run builds no task-checks command there, so the entry would never run. |
| `widen_paths` | Optional list of project-relative paths (a trailing `/` marks a directory; an existing directory named without it counts as one too) of shared infrastructure: test harness and helpers, package and lock files, build and CI config, modules many lanes import. A task whose change touches one runs project-wide checks instead of its targeted ones. Name the files every check runs through (wrappers, shared fixtures, settings), not a folder that also holds tools and tests; name a folder only when everything under it is shared (`Packages/`, `ProjectSettings/`). For example, run f2a listed `Tools/Unity/` for the Unity batch wrappers in it: units RP2 and RB4 declared other files under it (`Tools/Unity/tests/__init__.py`) and widened to every Unity suite, 72 minutes on the critical path (32% of the run) that found nothing; the wrapper files themselves were the entries it needed. The dry run lists every unit that will widen (`checks.widening`, see Confirmation header). Take them from the plan's shared files; no absolute path or `..`. |
| `repairs_spent` | Optional integer, default 0: repairs after a failing verify that earlier launches of this run made (the sum of `final.repairs` lengths in their reports; a report without `final` made none). Set it on a transient relaunch or a resume, like the budget carry-over; a run allows 2 in all (see Check ownership). |
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
| `setup_result` | The output of `scripts/setup <manifest> --owner <token>`: `{feature_head, worktrees, discarded, preserved, setup_skipped, returned, git_identity}` (`git_identity`, from 1.6.7: the commit rules' name and email pairs, see "Git identity"; optional, absent means `[]`; `setup_skipped`: the lanes whose setup commands were skipped because every task is done and reviewed; validation rejects a listed lane with pending work, and then setup reruns). Added after the yes to the table; required for a launch (there is no setup agent; a dry run does without it). `preserved` lists the commits under `refs/parallel-lanes/<run_id>/abandoned/` that hold changes setup discarded (see Cleanup). |
| `carried_minors` | Optional (1.6.3), set on a resume: `{open, covered}` from `ledger status`'s `minors`, copied as printed: the ids of the task minors earlier launches left open, and the tasks the snapshot covers ("Carry-over"). |
| `inputs_changed` | Optional (1.6.3), set on a resume: `{plan, spec}` from `ledger status --plan --spec`'s `inputs` (`plan` is `plan_changed`, `spec` is `spec_changed`; each `true`, `false` or `null`), read before setup, so a relaunch's pre-flight knows what changed since the last launch. |
| `start_points` | The feature heads `ledger status` prints after setup, copied exactly as it prints them: `prelude` from setup, `join` only once a launch got past integration (a new run has no `join` key). |
| `dry_run` | `true` only in the confirmation call. |
| `done`, `reviewed` | `[]` for a new run; on resume, from `ledger status --plan`. Never by hand. |
| `backfill` | Resume only: `{<task id>: {base, head}}` for done tasks, from `ledger backfill` (see Backfill below). Required for every done task; each `head` is the next task's review base. |
| `join_started` | Resume and transient relaunch: `ledger status`'s `join_started` (a join task started in an earlier launch). Required once `start_points.join` is set. A started join never runs waves again (see Join waves). |
| `unit_branches` | Resume and relaunch: `ledger status`'s `unit_branches`, `{<join task id>: {branch, dir}}`: the join units that ran on their own branch. |
| `wave_merges` | Resume and relaunch: `ledger status`'s `wave_merges`, the earlier launches' wave merges (overlaps and conflicts for the final lenses). |
| `join_tip` | Resume and relaunch: `ledger backfill`'s `join_tip` when not null: the join's last commit, which integration's history audit allows final-fix commits after. |
| `start_bases` | Resume and relaunch: `ledger status`'s `start_bases`, `{<task id>: base}` for tasks not done, from their latest `started` event: a join task resumed on the feature checkout after waves starts there, so its earlier partial commits stay in its range. |
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

## Flow details

Details SKILL.md points to.

### Notices

`<plan>` = absolute plan path. `<method>` = `Subagent-driven` or `Native` (superpowers
executing-plans). `<N>` = distinct lanes in the dry-run `agents` list, `<M>` = its length,
`<K>` = length of `done`. `<saved>` = the worth-it result's `saved` (see "Worth it"), and in
that notice `<method>` is the direct method recommended. The dry run returns the launch and
resume lines filled in (`notices`); the script logs the same line; you still print it.

### Git identity

`git -C <project> var GIT_COMMITTER_IDENT` must print one, because every task agent commits and
a commit without an identity fails partway through the run. If it fails, ask the user to set
one (`git config --global user.name` and `user.email`) or to name one that `commit_rules`
passes with `-c` (`git -c user.name=... -c user.email=... commit`). `scripts/setup` does not
check this, since a `-c` identity is legitimate. Doctor's `git_identity` check runs both `git var
GIT_COMMITTER_IDENT` and `git var GIT_AUTHOR_IDENT` with the commit rules' pairs, and both must
pass (from 1.6.7).

From 1.6.7 `scripts/setup` records the commit rules' `-c user.name=...` and `-c user.email=...`
pairs as `setup_result.git_identity`: a list of at most two strings, `user.name=<value>` first,
then `user.email=<value>`, keys lower case, the last pair given for a key winning (as with git's
own `-c`), `[]` when the commit rules name none. It is recorded whether or not a global identity
exists, so the run's merges commit as the agents' own commits do. The run passes the pairs to
every merge and every commit it spells out itself: the integrate prompt's and the lane
resolver's lane merges, the resolved-merge commits (`git -C <dir> -c ... commit --no-edit`) of
the integrate prompt, the lane resolver and the wave resolver, the wave resolver's merge, the
supervised conflict stop's by-hand commands, and the wave merge (merge-wave's `--git-config`,
one per pair). Each pair is shell-quoted in a prompt and one argv item in merge-wave. With
none, these use the user's git config, as before 1.6.7. Agents' own commits keep following
`commit_rules`. Only name and email are carried: other `-c` options in the commit rules (a
signing key, an editor) do not reach the scripted merges. A manifest whose setup ran under
1.6.6 has no `git_identity` (read as `[]`); setup reruns on a resume or relaunch and adds it.

A repository with SHA-256 object names (`git rev-parse --show-object-format` prints `sha256`) is
not supported: the run names commits by 40-hex SHA-1 ids. `scripts/setup` refuses it (exit 3,
nothing changed); tell the user.

### Confirmation header

The header shown with the dry-run table lists: mode, base and feature branch, worktree_root,
`profile`, `autonomy`, `limits.max_agents`, `limits.max_rulings`, lanes at once =
`lanes_effective`, superpowers or built-in prompts, agent type, commit_rules, overlaps,
`excluded` with reasons, batches, and whether deferral is allowed. Doctor's warnings go in it
too. One line comes from the dry run's `checks` summary, for example "Checks: targeted entries
for 9 of 12 units; delivery runs 3 checks (1 added by lane_commands); repairs up to 2", and its
`warnings` follow it. There are two: "changes to shared files will not widen task checks", when
`task_checks` has entries and `widen_paths` is empty; and (1.6.6) "<what> is about <N>
characters; the Bash tool on Windows fails at about 7,000: shorten the project's check commands,
for example with a wrapper script", when the longest engine-built check command is over 6,000
characters, with <what> "<unit id>'s task-checks command" or "the integration checks command"
and <N> its length (see "Command length" in Check ownership). From 1.6.8 one more line comes
from the summary's `widening` (`[{unit, paths: [{file, widen_path}]}]`), when it is not empty:
"Widening: 2 units widen when they change: RP2 (Tools/Unity/tests/__init__.py under
Tools/Unity/), RB4 (Tools/Unity/a.py under Tools/Unity/, +1 more)": the number of units, then
each unit with its first file and the widen path that covers it, and `+k more` when k more of its
files are covered. A unit is listed when it has a `task_checks` entry (a unit without one checks
its lane commands whatever it changes) and a declared file a widen path covers, or a declared
directory that holds a widen path (then `file` is that directory). A widen path ending in `/`
covers the paths under it; one without `/` covers the equal path and the paths under it (the
dry run cannot tell whether it names a directory; task-checks treats an existing one as a
directory). Paths compare after `\` becomes `/`; units come in run order and files in declared
order (every task of a batch). The line is advice: such a unit runs its project-wide checks only
when it really changes that file. One line comes from the dry run's
`join_waves`: "Join: waves 1-2-4 (DJ1 | DJ2, DJ4 | DJ3, DJ5, DJ6, DJ7)", or "Join: serial
(<reason>)" (see Join waves).

One line says whether the run pauses at the usage limit (see "Usage limit"), from doctor's
`usage_limit_pause` (`pause`, `reasons`) and what the session knows of itself:
- "Usage limit: the run pauses at the limit and continues by itself" when `pause` is `yes` and
  the session is none of the kinds the platform does not pause;
- "Usage limit: the run will not pause (<reasons>); on a limit it stops cleanly and is
  relaunched after the reset" when `pause` is `no`, or when the session's own context says it
  runs with Remote Control connected, in the background, or headless (`claude -p`, the Agent
  SDK), which doctor, a plain script, cannot see;
- "Usage limit: unknown (<what is unknown>)" otherwise, for example no `claude` on PATH.
When the run will not pause, name the options under the line and leave them to the user:
disconnect Remote Control for the run, set `autoContinueAtUsageLimit` back on, or update Claude
Code. Change nothing yourself.

### Transient stops

SKILL.md gives the rule; this is how it reads the causes. Not transient, so never relaunched
(stop and notify): `review_rounds`, a supervised blocked or question task, `adjudication_cap`,
`adjudicator_stop`, `budget`, a failed integration or post-integrate on real failures,
`integration checks did not finish: ...` (see "Exit codes"), status `invalid` or
`preflight_conflicts`, and a refused merge in the join (from 1.6.7: `join <name>: the merge of
<unit> failed: <error>`, or `join <name>: the merge failed: <notes>` when the result names no
unit or error; `<name>` is `wave <n>` or `recovery`) or a merge that reported done but left a
unit out (`join <name>: the merge left out <ids>`). A refused merge needs the user (an identity,
a hook, a held lock), then Resume. A missing wave or recovery merge result reads exactly `no
result from <name> merge`, so it is transient like any other missing result. The causes are
every `stopped_lanes[].reason` when `reason` is `prelude stopped`, `lanes stopped`, `join
stopped`, or `agents_unavailable`, else `reason` itself. A cause is transient only if it
starts with `no result from`, `error:`, or `setup failed`, or reads `integration failed: no
result from ...` or `post-integrate failed: no result from ...`, and, under
`agents_unavailable` only, if it starts with `agents unavailable:` (a lane whose
agent the latch refused). So `agents_unavailable` is transient only when every other cause is
transient too: a lane already stopped at `review_rounds`, a supervised question and the like
keep their own cause, the stop is real, and Resume step 4 applies. A stop with
`agents_unavailable` and no `stopped_lanes` entry (the latch hit outside a lane: pre-flight, run
adjudicate, integration, post-integrate, E2E or the final phase) is transient. Then run stop-cause and follow "Usage limit". The doctor rerun before a
relaunch is described under "Launch conditions".

**Budget carry-over** (SKILL.md's relaunch step): lower `limits.max_agents` by the
stopped run's `agents_spawned` and `limits.max_rulings` by its `rulings_spent`, floor 0. If
fewer than 1 agent would remain, treat it as a budget cap: stop and notify.

**Engine version.** Before any relaunch, compare the stopped launch's workflow result `version`
(the skill version `run.workflow.js` was built from; results carry it since 1.4.3) with
`<skill_dir>/VERSION`. Different, or missing (no result, or an engine before 1.4.3): it is not a
relaunch but a Resume (SKILL.md "Resume"): `done` and `reviewed` recomputed from `ledger
status`, budgets as a resume carries them, answers for blocked tasks if any, doctor, setup, the
dry run, the table and a plain yes. The new engine may plan different agents, check
differently or need manifest changes, and the earlier yes covered the old behaviour. A resume
starts a fresh allowance of transient relaunches.

## Building lanes

`derive-lanes` reports facts; you decide. Its output:
- `tasks`: `[{id, title, files, deps}]`; deps come from bracketed id lists on the heading and
  `- Consumes:` lines. Consumes and Produces labels may be plain or bold, on a `-`, `*` or `+`
  bullet (`- Consumes:`, `* **Produces:**`); Produces needs its colon, Consumes does not.
  `derive-lanes` and `task-brief` read them the same way.
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

## Worth it

`<python> <skill_dir>/scripts/worth-it <plan> --max-lanes <cap> [--prelude <ids>] --lane <ids>
[--lane <ids> ...] [--join <ids>] [--join-deps <id>:<deps> ...] [--project <dir>]
[--history-dir <dir>]` runs at the
Assessment, after the layout and only when the Offer will be shown. It reads the plan only to
check the layout: every id must be a task heading of the plan and appear once.

**The rule.** N tasks; A lanes at once = min(lanes, `--max-lanes`). The task-slots S are the prelude
tasks + the lanes' task counts queued whole, in lane order, each to the worker free earliest,
across A workers (as the engine's `runLanes` runs them) + the join tasks. A direct build takes N
task-times, so the layout saves N - S. `recommend` is `direct` when that is at most `THRESHOLD`
(1), else `parallel`. A single-lane layout saves 0.

**Why 1.** A back-test of 31 archived runs (2026-10-15; `tools/worth-it-backtest.py`, the 1.6.4
design section 4.3): the fixed phases a run adds beyond the whole-branch review a direct build
also ends with (pre-flight, integrate, E2E, verify) cost a median 1.23 task-times (quartiles 0.92
to 1.67). With 1 the rule agreed with each run's own comparison on 28 of 31 runs; with 2 on 24.
Minutes were tried and dropped: estimated from a project's earlier runs they were off by -74% to
+1788%, since task time depends on the plan.

**Biases.** The comparison leans towards a run: no direct build is archived, so "direct" is
modelled; a run's task time includes a per-task review (Native has none) and the contention of
parallel lanes; the run side leaves out the session's own steps (dry run, setup, confirmation,
hand-back). A `direct` recommendation is the safer of the two to trust. The rule assumes the
full profile; a `lite` run's fixed phases are smaller.

**The scale line.** With `--project`, `scale` holds the mean, lowest and highest task time of
this project's complete archived runs (`--project` matched as `history --project` matches), each
run's from its autopsy.json and manifest (the latest launch that ran task agents; a task's time
is the summed wall time of its agents). Minutes for scale only; it never changes `recommend`.
Runs whose autopsy or manifest cannot be read are skipped, with a note.

**Output.** One JSON line: `{"status": "ok", "tasks", "lanes", "lanes_at_once", "slots",
"saved", "threshold", "recommend", "scale": {"runs", "task_s_mean", "task_s_min",
"task_s_max"} or null, "notes"}`, or `{"status": "unavailable", "reason", "notes"}` for an
unreadable plan or a layout that names a task twice, names a task the plan lacks, or names none.
Exit 0 in both cases (the Offer goes on as before); 2 on a usage error. Read-only.

## Join waves

From 1.6.5 the launch that starts the join runs it in waves (design: the 1.6.5 join waves
design). The rule (`src/waves.js`, repeated in `scripts/_waves.py`): the join's units in plan
order (a light batch is one unit); a unit depends on every earlier unit when it (or a task of its
batch) has no `depends_on` field, else on the earlier units its `depends_on` names, and on the
earlier producer of each pre-flight finding against it. Its wave is one more than the highest
wave it depends on; a unit declaring a file (case-insensitive) an earlier unit of the wave
declares moves to the next wave. A wave runs at most `min(limits.max_parallel_lanes, usable lane
worktrees)` units at once; a lane with a `lane_commands` setup of its own is not usable. The join
runs serially (as before 1.6.5) under `profile: "lite"`, with fewer than two usable lane
worktrees, when no wave has two units, and when the join started in an earlier launch.

- A single-unit wave runs on the feature checkout. A unit of a multi-unit wave runs on its own
  branch `pl-<run_id>-u-<unit id>` from the wave's base, in a lane worktree:
  `start-task --unit-branch NAME SHA --run-id RUN --setup CMD ...` saves the worktree's
  uncommitted changes under `refs/parallel-lanes/<run_id>/abandoned/` (unless it is already on
  NAME: a retry), checks NAME out and runs the project's setup there. Its ledger lane, checks and
  phase stay `join`. Once a unit of a wave stops, no further unit of it starts.
- Integration keeps the lane worktrees. After each multi-unit wave a wave merge agent (Sonnet)
  runs `scripts/merge-wave DIR LEDGER_DIR --git-config PAIR ... --wave N --unit ID BASE HEAD
  ...`: it merges each finished unit's recorded head with `chore: join wave <n>: merge <unit>`
  (skipping one already merged), aborts and reports a conflict, lists `overlaps` (paths two units
  changed), and records `wave_merged`. A conflict goes to a wave resolver (Opus, one per
  conflict; on failure it aborts the merge) in an autonomous run; a supervised run stops with the
  sha to merge by hand. A unit that stopped is not merged, and the join stops after the merge.
- merge-wave (from 1.6.7). `--git-config KEY=VALUE`, repeatable, in any position among the
  options, is one pair of `setup_result.git_identity` (see "Git identity"): KEY `user.name` or
  `user.email` in any case (passed lower case), VALUE non-empty; each goes to every `git merge`
  as one `-c KEY=VALUE` argv item. Any other key or an empty value is a usage error (exit 2:
  `--git-config takes user.name=VALUE or user.email=VALUE`). Its JSON `status` is `merged`,
  `conflict` (a merge with unmerged paths, aborted; `conflict_unit`, `conflict_files`) or
  `failed`: git refused a merge with no unmerged paths (no identity, a failing hook, a held
  `index.lock`). On a refusal merge-wave runs `git merge --abort` only when a merge is in
  progress (`MERGE_HEAD` exists), checks the checkout is clean, and stops the loop; units merged
  earlier in the same call stay merged (`merged`). When git's message names `index.lock` and the
  checkout is clean, it waits 2 s and tries that unit's merge once more (one retry only); a
  second refusal is the failure. Every output carries `failed_unit` and `error` (null when
  none): on a refusal the unit and git's message (stderr, else stdout, stripped, at most 2,000
  characters, or `git merge exited <code>` when both are empty). Exits: 0 every unit merged (or
  nothing to merge), 1 a conflict, 2 a usage error, 3 the checkout is not clean, a BASE or HEAD
  is not a commit, or a git step failed (a refusal whose abort fails or leaves the checkout not
  clean is recorded with `failed` first), 4 git refused a merge. The wave merge agent maps exit 4
  to status `failed` with `failed_unit`, `error`, `merged`, `in_history` and `head`, runs no
  checks, and does not change git config, set an identity or retry the merge.
- The engine stops on a refused merge in both autonomies, with no resolver: `join <name>: the
  merge of <unit> failed: <error>` (`<name>` is `wave <n>` or `recovery`; `join <name>: the merge
  failed: <notes>` when the result lacks the unit or error), with the report entry's `head` and
  `in_history` filled from the result. A `conflict` with no `conflict_files` counts as refused. A
  `done` result that has some unit it was asked for in neither `merged` nor `in_history` stops
  with `join <name>: the merge left out <ids>` (ids joined by `, `). A missing result stops with
  `no result from <name> merge`, which is transient ("Transient stops"); the other two are not.
- Merge messages. From 1.6.7 the join's merges are `chore: join wave <n>: merge <unit>` and
  `chore: join recovery: merge <unit>` (merge-wave, the wave resolver, the supervised stop's
  by-hand command); before 1.6.7 they were `join wave <n>: merge <unit>` and `join recovery:
  merge <unit>`, and the integrate prompt's history check accepts both forms, since a relaunch
  after an upgrade can meet merges an earlier launch made. Every reviewer and final lens is told
  these and the wave checks fix `fix: make the wave checks pass` are the engine's own commits,
  not commit-rule findings.
- `wave_merged` (from 1.6.7). merge-wave appends it on every call that merged a unit, ended in a
  conflict or was refused; a call that only skipped units already in the history and ended clean
  records nothing. Fields: `wave` (or `recovery: true`), `units` (the units in the history after
  the call, merged or skipped; empty only with non-empty `conflict_files` or a `failed`),
  `merged` (the units this event's merges added, possibly empty), `head`, `overlaps`,
  `conflict_files`, and when they apply `conflict_unit`, `failed` (`{unit, error}`, both
  non-empty) and `resolved: true`; absent fields are left out, not null. The wave resolver records
  its own merge: after committing it appends `wave_merged` with the wave (or `recovery`), `units`
  and `merged` both `[<unit>]`, `head` (its merge commit), `conflict_files` and `resolved: true`,
  through the ledger command its prompt gives. `join_tip` follows only events that merged: an
  event's head counts when its `merged` is non-empty, or when it has no `merged` field (an event
  from before 1.6.7), so a conflict or refusal event never moves the tip. `ledger status` copies
  `merged`, `conflict_unit`, `failed` and `resolved` into `wave_merges` when recorded. The final
  lenses read the conflict files of a `resolved` event (or one from before 1.6.7) as settled by
  the wave resolver, and those of a conflict no later `resolved` event of the same wave settled
  as settled outside the run's resolver (by hand or in a later launch).
- After the last multi-unit wave, its units' targeted checks (`task_checks`) run once on the
  merged tip, with `--phase join`, and `wave_checked` is recorded. A failure gets one Opus fix
  (`fix: make the wave checks pass`), its re-review and a recheck; still failing, an autonomous
  run goes on (the final review and verify take it; `final.cannot_verify` lists it), a
  supervised one stops. Checks that did not finish get no fix.
- A relaunch with `join_started` and `unit_branches`: setup puts each lane worktree left on one of
  the run's unit branches back on its lane branch (output `returned`), saving its changes; a
  recovery merge (`merge-wave --recovery`, `chore: join recovery: merge <unit>`) brings in
  every unit that ran on its own branch and is done and reviewed or deferred, and reports
  (`--known`, `in_history`) which of the other such units an earlier launch already merged; the
  rest of the join runs serially on the feature checkout from that tip. A merged unit whose
  approval went stale is reviewed again over its recorded range without moving the tip. A unit
  that ran on its own branch, is not done and reviewed, and is not in the history starts again
  from the tip (`start-task --restart`: the ledger drops its earlier attempt), told its branch
  and abandoned refs to reuse. Any other unit starts from its latest `started` base
  (`start_bases`), else the tip. A unit branch an earlier launch left that is not built on the
  wave's base is saved under the abandoned refs and made again (`start-task` prints
  `recreated`). Integration's history audit allows the merge, resolver and wave checks fix
  commits, and final-fix commits after `join_tip`.
- `run-checks --phase NAME` (and `task-checks --phase`) sets `PL_PHASE=NAME` (prelude, lane,
  join, integrate, post-integrate, final-fix, verify) for every check; without it `PL_PHASE` is
  removed. A project's check script may read it: a join unit runs in a lane worktree. Task prompts
  tell agents to set it for commands they run themselves. `--phase start` (1.6.8) is the start
  check's (see Check ownership): it runs in `<worktree_root>/start` with `PL_PHASE=verify`, so it
  reproduces verify's environment, and its evidence records `phase: start`. A wrapper that
  chooses tests by phase must key on `PL_PHASE` before the checkout path: one that leaves slow
  tests out in a worktree path would leave them out at the start point too, where the start
  check reports them `not_run` (so `unknown`, never a wrong `passes`).
- Ledger: appends hold each lane file's OS lock (up to 5 s); a reader skips a last line without a
  newline that is not JSON. New events `wave_merged` and `wave_checked` (task `_run`); `started`
  may carry `dir`, `unit_branch` and `restart`. `ledger status` adds `join_started`,
  `unit_branches`, `wave_merges`, `start_bases`; `ledger backfill` skips unfinished join tasks
  once the join started and adds `join_tip`.
- The dry run returns `join_waves` `{mode, reason, waves}` (before pre-flight's moves), counts the
  wave merges (and the wave checks fix, re-review and recheck as the upper bound) or a relaunch's
  recovery merge, and the launch notice ends with the wave sizes. Pre-flight is shown the waves;
  a finding whose producer is earlier moves the task to a later wave (`preflight.wave_moves`).
  The run result gains `join_waves` (per wave: units, head, conflict_files, resolved_files,
  overlaps, checks), and the final lenses are told each wave's overlaps and resolved conflicts.
- `owners.json` gives join tasks a `wave` (two lanes or more, not lite); two join tasks of one
  wave are `alongside`. Lane ids may not start with `u-`. `cleanup` claims lane worktrees on the
  run's unit branches and removes merged unit branches; an unmerged one stays. autopsy reads the
  wave labels (`wave N merge`, `wave N resolve ID`, `wave checks fix`, `wave checks re-review`,
  `wave checks`, `recovery merge`, `recovery resolve ID`) as Join phase agents. A supervised
  conflict stop gives the exact `git -C <dir> <identity>merge --no-ff -m 'chore: join wave N:
  merge ID' <sha>` and `git -C <dir> <identity>commit --no-edit` to run by hand (`<identity>` the
  `-c` options of `git_identity`, empty with none), so integration's history audit accepts it on
  the relaunch.
- `worth-it --join-deps ID:DEPS` (one per join task) counts the join as the sum over its waves of
  ceil(size / lanes at once), declared files not checked; without it, one slot per join task.
  `tools/worth-it-backtest.py --waves` counts the archived joins in waves.

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
| standard | Opus (current), effort high | Default. Every task with logic or tests of logic. Always Opus: pre-flight, adjudicator, resolver, and final review agents, and reviewers (medium for small non-security diffs, see below). Integrate, e2e and minor-only final fixes start on Sonnet high, docs-only final fixes on Haiku high; each escalates to Opus. The start check runs on Haiku high. |
| sonnet | Sonnet (current), effort high | Implementers of well-specified tasks with some logic. After the first `changes` verdict the task escalates to Opus. |
| light | Haiku (current), effort high | Implementers of mechanical tasks only: docs-only, example or config files without tests, version bumps, pure renames, fixture data. Escalates to Opus after the second `changes` verdict. |

- `security: true` for tasks touching authentication, authorization, tokens, crypto,
  untrusted input (uploads, parsing external files, request bodies), file paths from users,
  or permissions. A security task is always `standard`, never sonnet or light.
- A sonnet task escalates to standard after its first `changes` verdict, a light task after
  its second; either escalates on a block. The rerun is automatic (escalations are counted in the report).
- Reviews of diffs under 60 changed lines with no security flag run Opus at `medium`;
  everything else runs Opus at `high`. Mechanical run steps (clean merge plus commands, E2E
  execution) start on Sonnet and escalate to Opus on any conflict or failure.
- The user's preference wins when stricter: "Opus for everything" means every task is
  `standard`, and "no Haiku" means `sonnet` instead of `light` (a docs-only final fix and
  the start check still run on Haiku). Haiku runs only those three; reviewers are never
  lighter than Opus, and if the user asks for that, say so.

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
ledger `ruling` event `Ruling: decision - why - cost if wrong` whose `by` names its role:
`adjudicator`, `implementer` (implement and fix agents) or `reviewer` (review and re-review
agents); a ruling with no `by` was written by a task agent before 1.6.3 (in every archive
checked an implementer or fixer, but a reviewer had the same command) and is read as an
implementer's. Pre-flight rulings are in `preflight.rulings`, and from 1.6.3 also in the ledger
once `carry-launch` records them ("Carry-over"). A task's adjudicator rulings are also in the run result's
`tasks.<id>.rulings`, and its approving review's minor findings in `tasks.<id>.minor_findings`
(`[]` unless the task was done in that launch), so a later launch can read both.

Pre-flight also returns `code_deps` (`[{task, producer, what}]`, required, may be empty): code a
task needs from another task's work. An entry the run order already meets (the placement rule
`validateManifest` applies to `depends_on` kind `code`: the producer is before the task and in
the prelude, in the same lane, or the task is in join) only adds the producer to the task's
briefs, like `undeclared`. An unmet one is a schedule problem no ruling can fix: the run stops
with `preflight_conflicts` in both modes (the adjudicator is not called), and
`preflight.schedule` lists each as `{task, producer, what, fix}`, `fix` being the move that meets
it (`move T to join after P`, `move T after P in the prelude`, or `move T to join, or into P's
lane after it`). `preflight.schedule` is always present on a full-profile run (`[]` when there
is none) and is `[]` under lite, which has no pre-flight agent. A relaunch with every task done
and reviewed has none either: there is no task left to check, and a pre-flight there could only
re-rule work already built. Its `preflight` is empty with `skipped: "no task left to run"`, and
the dry run plans no pre-flight agent.

**Pre-flight permits** (1.6.8). When a pre-flight ruling has a task change a file outside its
Files list, pre-flight also returns it in `permits` (`[{task, files, ruling}]`, optional, read as
`[]` when absent): the task id, the files, and the ruling's 0-based index in `rulings`. The
engine judges each file after `wave_moves` and keeps it only when the task runs in this launch
(not done and reviewed), the ruling exists, the file is project-relative (no `..`, no trailing
`/`), no task that can run at the same time declares it (the file or a folder above it, compared
without case), and no permit kept before it in pre-flight's order gives it to such a task. Two
tasks can run at the same time when they are in different lanes (done ones too: their branches
still merge), or are join tasks of different units of one wave; a prelude task, and a join task
when the join runs one unit at a time, run beside no other task. A permit naming a file the task
already declares is kept and changes nothing. Kept permits are `preflight.permits`; the others
are `preflight.permits_dropped` (`[{task, file, why}]`, why one of `not a task of this launch`,
`no such ruling`, `not a project-relative file`, `declared by <id>, which can run at the same
time`, `also permitted to <id>, which can run at the same time`), and the run log names each
dropped one. Each kept file reaches its task's task-checks call as `--permit '<file>=PF-<n>'`
(n = ruling + 1, as the prompts number the rulings; every task of a batch) and its implementer
prompt as `PF-<n> permits <task> to change <files>: changing them does not widen your checks.`
Both keys are present only when the pre-flight agent ran: the lite and `no task left to run`
`preflight` have neither, and neither does a pre-flight that stops the run on a schedule
problem. A later launch gets the permits from the ledger ("Carry-over").

Run rulings: pre-flight's own rulings, then the adjudicator's ruling on pre-flight conflicts,
reach every task not yet done, every adjudicator and every final reviewer as "Rulings already
made for this run (binding)", in that order, each quoted as written, so no agent decides a settled point again.
The workflow builds that list (`run_rulings`) itself during the run and never reads it from
the manifest file. The user's answers (`notes`) keep their own label, and an adjudicator's
`answer` or `clarify_plan` for one task reaches only that task. Both appear in the hand-back under "Rulings made on your behalf". Under
`supervised` there is no adjudicator: a blocked task, a question, or the review cap
(`review_rounds`) stops the run.

## Carry-over

From 1.6.3 what earlier agents decided or found reaches the agents after them, once.

**The ledger holds every ruling.** A `ruling` event may carry `by` (`implementer`, `reviewer`,
`adjudicator`, `preflight`), `scope` (`lane` or `run`), `overrides` (the ids it departs from),
`files` (paths an adjudicator ruling permits outside a task's Files list; an implementer lists
the files its ruling explains, which permits nothing), `pf`, `wf` and (1.6.8) `permits` (`[{task,
files}]`, the files a pre-flight ruling permits to a task; anything else is refused with
`'permits' must be a list of {task, files}`). The
ledger checks the values, not whether an agent told the truth. A ruling's id is `<file
stem>-R<n>`, n counting that ledger file's rulings in append order (`rig-R4`, `_run-R2`); this
launch's pre-flight rulings are numbered `PF-1`... in the prompts until `carry-launch` records
them. Run-wide: pre-flight rulings, an adjudicator ruling about code, tests or checks outside the
task's lane, and an observed failure; everything else is lane-wide.
`<python> <skill_dir>/scripts/ledger rulings <ledger_dir> [--lane <lane>]` prints the rulings in
force (with `--lane`: `_run`, the prelude, that lane, and every run-scope one), then the
overridden ones.

**Who sees them.** Every task agent's start command prints its lane's rulings under `=====
rulings in force =====` (join tasks: all); the adjudicator, the final lenses, the final fix, the
final re-review, the verify repair and a relaunch's pre-flight get the `ledger rulings` command.
An implementer may override only an implementer ruling of its own lane; departing from any
other is a question the adjudicator settles. An adjudicator may override any ruling, naming it;
pre-flight never does. A final lens does not raise a matter a ruling in force settles unless it
is critical or important, and then cites the ruling.

**carry-launch.** After each launch (Launch step 5), `<python> <skill_dir>/scripts/ledger
carry-launch <ledger_dir> <transcript dir>` reads that launch's Workflow result file and records,
once per wf id: each pre-flight ruling (by `preflight`, scope `run`, its `PF-n`, and from 1.6.8
`permits`: the entries of `preflight.permits` whose `ruling` is its index, as `{task, files}`; a
malformed entry is left out, not the whole launch), skipping the
pre-flight adjudication the adjudicator recorded itself (`preflight.adjudicated`); one `minors`
snapshot, the task minors still open after that launch; and a `carried` event that binds any
`PF-n` a ruling of that launch overrode. Launches are carried in launch order (each
`doctor-<wf>.json` names its `setup_event`; carrying one while an earlier one is not carried
exits 3 naming it). An override takes effect only within the rules and only in a view that
shows the ruling that makes it; otherwise the print marks it `(against the rule)`. On a resume, `carry-launch <ledger_dir> <wf id>` finds a
launch whose session died by its wf id under the Claude config dir's
`projects/*/*/workflows/<wf>.json` (the ledger's `doctor-<wf>.json` files name the wf ids). Exit 3
means that launch is not carried (no readable result); say so and go on. `ledger minors
<ledger_dir>` prints the open minors; `ledger status` prints `minors` (`{open: [ids], covered:
[task ids]}`) and `overrides`.

**Task minors.** Only the security lens gets the task-minor checklist (it worked it in every
archived run); the superpowers and correctness lenses raise a task minor only when they judge it
critical or important. On a resume the session copies `ledger status`'s `minors` into
`carried_minors`; the security lens reads their text through `ledger minors`.

**A relaunch's pre-flight** is told which tasks are built, gets the `ledger rulings` command and
`inputs_changed`, and checks only the tasks still to run: a matter an earlier ruling settled is
not a conflict and gets no new ruling unless the plan or spec changed since. It is also told
that permits an earlier launch recorded are carried and need no new ruling. With no task left to
run there is no pre-flight (`preflight.skipped`).

**Carried permits** (1.6.8). Once carried, a pre-flight ruling in force permits what its
`permits` names for its task (files only: an entry naming a directory, an absolute path or one
that leaves the project permits nothing; a ruling another overrides permits nothing). In a later
launch task-checks counts such a path as declared and lists it in `policy.permitted` with the
ledger's ruling id (for example `_run-R2`, since `PF-n` numbers restart every launch); only a
`--permit` of this launch shows `PF-n`. Implementer and reviewer rulings permit nothing, and a
pre-flight ruling's `files` permit nothing. A known gap: the engine checks a new pre-flight
permit only against the Files lists and the other permits of its own launch, never against a
carried one (the relaunch's pre-flight is told only that carried permits exist, and `ledger
rulings` does not print them). So a carried permit for a task still to run and a new permit for
the same undeclared file to a task that can run at the same time (another lane, or another unit
of its join wave) both stand, and neither task widens for that file; the task reviews and the
final lenses still see both changes.

**Outside the Files list.** Setup writes `<ledger_dir>/owners.json`: which tasks list each path,
and where each task runs. A reviewer's scope list and `<python> <skill_dir>/scripts/ledger owners
<ledger_dir> --task <id> <path>...` say, for each path: owned by a task `earlier in the run`
(fine when the task needed the change, and flagged), `another lane, running alongside` or
`later` (needs a pre-flight or adjudicator ruling in force that covers it; an implementer asks
instead of changing it, and its own ruling never counts), `in your Files list; also in X's
Files` (the reviewer checks the plan's split of that shared file), or `no task owns it`.
`ledger undeclared <ledger_dir>` (and `ledger status --manifest`) report `{task: [{path, owner,
relation}]}`; from 1.6.8 a path permitted to the task (or to a task sharing its range, a batch)
by a ruling in force in that ledger, an adjudicator's `files` or a pre-flight ruling's `permits`
as task-checks reads them, counts as declared and is not reported.

From 1.6.6 owners.json also gives each task its `declared`: its exact Files list as the manifest
gives it (no case change or normalising, manifest order, each exact string once, `[]` for a task
without one). The reviewer's start-task call builds its scope list from it: `--scope BASE HEAD
--declared-from-owners N:HHHHHHHH --owners <ledger_dir>/owners.json` takes the `--brief` tasks'
`declared` lists, in `--brief` order, each exact string once, and checks them against the
engine's fingerprint (see "task-checks" in Check ownership); the owner annotations print as
with `--declared`. When the owner map is missing or unreadable, a `--brief` task is not in it or has no
declared list, or the fingerprint differs, the
scope section is the one line "(could not build the list: the run's owner map does not match
this unit's Files list; judge scope from the brief)", the briefs and package are written as
usual and start-task exits 0: the list is advice, and a failed start would spend a fix agent on
something no agent can repair. `--declared-from-owners` needs `--scope` and `--owners` and does
not go with `--declared`; `--declared PATH` still works by hand.

**Observed failures.** A check failure an implementer judges outside its task (it passed on a
rerun, or the failing test covers code the task did not touch) is a run-wide ruling
`Observed: <test or command> failed - <why outside this task> - <rerun result>`, so verify, a
repair agent and the hand-back know it. How the failure itself is handled does not change.

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
  worst case for its first attempt (`final_fix` is listed on Opus, though a fix of only docs
  findings starts on Haiku and one of only minor findings on Sonnet); escalations, retries, and fix rounds are extra
  agents the list does not show. A refused agent ends its task or phase without work;
  the run stops with reason `budget`, resumable, never accepted.
- `limits.max_rulings`: 25 adjudicator rulings per run.
- The final phase has one fix wave. On a cap the run stops cleanly, the session reports and
  notifies. Raise the limit in the manifest, then resume; that goes through Confirmation again
  (dry run, table, explicit yes). The only edits that
  need no second table are `setup_result`, `start_points`, and the relaunch carry-over (budgets
  and `repairs_spent`).
- Repairs (see Check ownership) count toward `max_agents`. Each is admitted only while
  `repairReserve` agents are free (7, plus 4 with an e2e hook and 2 with a post-integrate hook in the full profile;
  the 7 include one availability probe, see "Usage limit"),
  so neither the repair nor the checks it makes necessary are ever refused: with less room
  there is no repair, and the run ends as it would without one.
- The `verify` agent (the project checks through `scripts/run-checks`) runs even past
  `max_agents`: the checks are cheap and deterministic, so the evidence after the last change
  exists even when the budget is spent. When the budget stops the run after the join (in E2E or
  the final review), the stopped report carries `verify` at the feature head it reached; it
  counts in `agents_spawned`, which can then exceed the cap by one, or two when a verify that
  returned nothing is retried.
- The `start check` agent (1.6.8, see Check ownership) is an ordinary agent under `max_agents`,
  not exempt like `verify`: it judges logs and may run long. The dry run lists one `start check`
  row (Verify, Haiku high) beside `verify` whenever verify is planned, as an upper bound (it runs
  only after a failing verify, at most once per launch), so the table's agent count and the
  `max_agents` it suggests grow by one. With no agent free (after a final fix: fewer than two,
  since the final re-review must follow it), or the agents unavailable, the run makes no call
  and records `final.start_check` as `unavailable` with `why: 'budget'`, and nothing else
  changes; `repairReserve` is unchanged, since the start check runs before repair
  admission and its agent is already counted. From 1.6.10 it is an advisory call: it runs once,
  with no retry and no availability probe, and when no agent is free it is not run and sets no
  refusal latch. A start check that returns nothing is `unavailable` (`why: 'no result'`), and
  the run goes on to its acceptance; before 1.6.10 its refused retry could stop the run on
  `budget`.
- Agents unavailable (see "Usage limit") uses the same refusal path: once the availability
  probe found no agent answering, every later spawn is refused, `verify` included (a refused
  verify is never stored as evidence), and the run stops with reason `agents_unavailable`
  instead of `budget`, resumable, never accepted. The probe counts as one agent in
  `agents_spawned`, never as a ruling. A probe the budget itself refuses is a budget stop.
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

The end of a run records the spend, carries the launch and releases the lock in one command
line (SKILL.md Launch step 5), so the spend is never forgotten once the lock goes, and a refused
record (exit 2) keeps the lock until it is fixed; a carry-launch that fails never keeps it.

## Check ownership

Each kind of check has one owner (1.6.0). Review depth is unchanged. From 1.6.1 every owner
runs its checks through the procedure in "Long checks" below, so a check that outlasts one
tool call never ends the agent's turn.

| Who | Runs |
|---|---|
| Implementer (task, retry) | Focused tests while iterating, then `scripts/task-checks` once before committing (a batch: once, before its last commit). |
| Task fixer | The tests that cover the amended code; no task checks, no full suite. |
| Task reviewer, re-reviewer | Nothing: they read the task-check evidence and may report a wrong selection as a finding. |
| Integration | The delivery inventory once: `finalSetup`, then one `run-checks` call over `finalChecks` (the project's commands plus each distinct `lane_commands` one). From 1.6.8 a resumed integration whose merges made no commit may reuse a passing check of the same head instead (see "Reuse" below); setup still runs. |
| Post-integration fixer | After a test failure: focused tests (it may rerun the failing command to reproduce it); the integration rerun owns the full commands. After a hook failure: every project command, since only the hook reruns. |
| Final fixer | Autonomous: focused checks; verify owns the full inventory. Supervised: every project command, as before 1.6.0. |
| Verify | The full delivery inventory at the delivered head, fresh, every time. Acceptance reads only this. |
| Start check (1.6.8) | After a failing verify: the failing commands, narrowed to their failing tests when the project can select them, at the run's start point in `<worktree_root>/start` (see "The start check" below). |

**task-checks** (`scripts/task-checks`; the workflow builds the call) picks one list:
- `lane`: the unit has no `task_checks` entry: the lane's checks run, as before 1.6.0.
- `targeted`: it has one and no widening reason holds: the entry's commands run.
- `widened`: it has one but a reason holds: the project's commands plus the lane's own
  additions run (project-wide, not the lane's possibly narrower list). A lane whose
  `lane_commands` setup differs from the project's widens to its own checks instead: its
  worktree never ran the project's setup, and integration still runs every check.

Reasons, all recorded in order: `no_entry`, `no_files` (no Files list), `outside_files` (a
changed path the Files list does not cover, nor a ruling permits: a `--permit PATH=PF-<n>` of this
launch's pre-flight (1.6.8, repeatable, one per kept file of the unit's tasks, see
"Adjudicator"; PATH is normalised like `--declared`, so `\` becomes `/`, and a directory, an
absolute path, one that leaves the project or a value without `=PF-<n>` exits 2), an earlier
launch's pre-flight ruling in force whose `permits` names the file for one of the unit's tasks
("Carry-over"), or an adjudicator ruling in force: one filed
under the unit's task, or under `_run` for a path no task's Files list names (neither the path
nor a folder above it), in the folder of a file the unit declares or in a directory it declares
(folders compared by case); a permit names files, and an
entry naming a directory permits nothing; such a path is
listed in `policy.permitted` as `{path, ruling}`, the ruling being `PF-<n>` for a `--permit`
and the ledger's ruling id otherwise), `widen_path` (a changed path under
`widen_paths`), `forced` (the agent's `--force-full '<why>'`, for a shared contract,
configuration, generated or ignored inputs, a dependency that is not a direct import, or a
targeted list that turned out invalid), `git_failed`. Changed paths are the working tree
against the task base (staged, unstaged, both sides of a rename) plus untracked files that are
not ignored, read NUL-delimited; ignored files are not seen, so widening for them is the
agent's `--force-full`. Matching is case-sensitive; a `\` in a changed path is never covered.
Safety: ids must be safe file names and the base a sha (else exit 2, nothing written); the
evidence file `<ledger>/checks/task-<unit>.<n>.json` is created exclusively inside the ledger
(else exit 3); exit 1 always means a check failed, and any other failure exits 3 with an
error record. The printed line lists at most 50 changed paths and cuts long reasons, with a `printed_cut`
note; the evidence file keeps everything. The evidence is a record and a count: nothing reads it to accept, skip or reuse
checks.

**The engine's short forms** (1.6.6). The call the engine builds does not list the unit's Files:
- `--declared-from-owners N:HHHHHHHH` stands for the `--declared` list (passed when the unit
  declares files; with none, neither is passed and `no_files` holds). task-checks reads
  `<ledger_dir>/owners.json`, takes each `--task`'s `declared` in the order given, keeps the first
  occurrence of each exact string (as the engine's `declaredFiles` does for a batch or join
  unit), and compares the fingerprint: N the number of paths, H the 32-bit FNV-1a hash of their
  UTF-8 bytes joined with one NUL byte, as 8 lowercase hex digits (the engine and
  `scripts/_owners.py` compute it alike). A value that is not of that form (N of 0 included),
  or one given with `--declared`, is a usage error (exit 2). When owners.json is missing or
  unreadable, a `--task` is not in it, a task has no `declared`, a path in it is absolute or
  leaves the project, or the fingerprint differs, task-checks selects and runs nothing, writes
  its error record to the evidence file and exits 3 (without `--evidence` it exits 3 and writes
  nothing; `await-checks wait` then exits 3, not
  `stopped`), with the error "the run's owner map (owners.json) does not match this unit's
  Files list (<reason>): report blocked with this message; do not run setup and do not pass
  --declared yourself (the session reruns setup)". The implementer's prompt says the same: "If
  the call fails with an error that names owners.json, report blocked with its message; do not
  run setup or pass --declared yourself." The session reruns setup (Relaunch or Resume), which
  writes owners.json again from the manifest. Past the check nothing changes: the same
  `no_files`, `outside_files`, permits and policy as with the list.
- `--wide-as-lane` stands for the `--wide-cmd` pairs when the wide list equals the lane list
  (the same groups and commands in the same order, as with no `lane_commands`, or a lane whose
  `lane_commands` setup differs from the project's): the lane list is used as the wide list, so
  no recorded or printed value changes. It does not go with `--wide-cmd`; one of the two is
  required. A lane with extra commands and the project's setup still gets the `--wide-cmd` pairs.
- `--declared PATH` and `--wide-cmd` still work by hand; a call without the new options behaves
  as in 1.6.5. `--project-test` and `--targeted` stay as they are: they are bounded by the
  project's commands.

**Command length** (1.6.6). The Bash tool on Windows fails a command of about 7,000 characters
or more before bash runs it ("unexpected EOF while looking for matching"), however well it is
quoted. On one 2026-10-16 run, 7 of 40 task-checks calls (all of 6,907 characters or more), 1
reviewer start and 6 heredocs written by agents failed this way; each had to be redone another
way, and the empty evidence files showed as unavailable calls and stopped waits. 1.6.6 keeps the
engine-built commands short: the declared files travel as a fingerprint and the wide list as
`--wide-as-lane`, so what remains grows only with the project's check commands. Agents write
and extend long files with Edit and Write, not heredocs (the rule every agent gets). The dry run
warns when a unit's task-checks command, or the integration's run-checks command, would be over
6,000 characters (see Confirmation header); the fix is to shorten the project's check commands,
for example with a wrapper script. The warning is advice and never refuses.

**The start check** (1.6.8) finds out whether a failing verify's failures predate the run.
- **When:** right after the first verify of the delivered head in a launch that fails for a
  repair's reasons (verify at the head, the exact inventory, no `head_after`, a clean checkout,
  and not only exits 75, 124, 128 or above, negative or not a number), whatever the autonomy
  and before any repair admission, so a supervised run gets it too. Only when the manifest's
  `start_points.prelude` is a sha other than the head (a manifest without `start_points`, or a
  run that changed nothing, gets none), and at most once per launch (a later launch may run its
  own). Both verify sites call it: the verify after a final fix and the main verify after the
  final review. The verify of a budget stop never does. Its agent's budget is in "Budgets".
- **The agent:** `start check`, phase Verify, Haiku high, with its own checkout rule. It adds a
  detached worktree at `<worktree_root>/start` on the start sha (`git worktree add --detach`,
  from `repo.git_dir` in shadow mode); a worktree of this repo already there and detached at the
  start sha is the run's own, left by an earlier start check, and is removed first (`git
  worktree remove --force`, `git worktree prune`); anything else at that path makes it return
  `unavailable` and touch nothing. It runs the setup commands (`finalSetup`) there, reads each
  failing command's log for the failing tests, and runs, in one `run-checks --phase start` call
  reserved as `start` (`<ledger>/checks/start.<n>.json`, the "Long checks" procedure), the
  narrower command when the project's own filter can select just those tests, else the same
  command. It reads each start log for the tests that ran and failed (a test the log does not
  show running is `not_run`, never failing or passing), then removes the worktree with `git
  worktree remove --force` and `git worktree prune` (`--force` only on this path; a failed
  removal is left to cleanup or the next start check). It never changes, stages or commits
  anything in the feature checkout. It returns `{status: checked|unavailable, start_sha,
  evidence, results: [{verify_command, start_command, narrowed, exit_at_start, failed_at_head,
  failed_at_start, not_run}], notes}`: what the logs show, without judging it.
- **The engine classifies** each failing command (`at_start`): `fails` only when the status is
  `checked`, `start_sha` is `start_points.prelude`, `evidence` is a `checks/start.<n>.json` path
  under the ledger dir (`\` read as `/`, without case on a drive path), `exit_at_start` is a
  defect exit (non-zero, not 126 or 127, and not one of "Exit codes"' non-defect exits),
  `failed_at_head` names tests, `not_run` is empty and every head failure fails at the start;
  `passes` when it exited 0 with nothing `not_run`; `partly` when some but not all head failures
  fail at the start; `unknown` otherwise (a command whose log names no tests, like a lint, is
  `unknown` unless it passes at the start, and so is a command the result leaves out or lists
  twice). A wrong start sha or evidence path makes every command `unknown`. The result is
  `final.start_check` (see "Report").
- **Effect:** when every failing command `fails`, no repair runs (the failures are out of scope)
  and acceptance gives `checks_failed_at_start` instead of `checks_failed` (still rejected; the
  user may accept it with `ledger accept`). Otherwise repairs run as below, and each repair
  prompt, and the final re-review beside the failing verify, carry one line per command: `fails
  at the start point <sha> too`, `passes at the start point <sha>: this run broke it`, `partly`
  with the tests that predate the run, or `unknown: no conclusion from the start point`. The
  final re-review does not hold a finding open over a failure that predates the run alone.

**Repair after a failing verify** (autonomous runs only; supervised runs reject as before; the
start check above runs first in both):
- Due only when verify ran at the head, with exactly the configured inventory, no
  `head_after`, a clean checkout, and a failure that is not made only of exits 75, 124, 128 or
  above, or negative (a busy project, a timeout or a signal is not a defect to fix; see "Exit
  codes").
- Admitted only while `repairReserve` agents are free and fewer than 2 repairs were made in the
  run (`repairs_spent` carries earlier launches'). The reserve is 7 (the repair, its verify and
  the re-review that must follow, each with one retry, and the availability probe a dead pair
  among them may start; see "Usage limit"), plus 4 with an e2e hook and 2 with a
  post-integrate hook in the full profile (the rechecks a moved head needs), so nothing the repair makes necessary
  is ever refused.
- One Opus agent, `verify repair <n>`: the failing commands with log and tail, the smallest
  correct fix, focused checks only, `fix: make the delivery checks pass`. It never weakens,
  skips or deletes a check, test or criterion, never changes the commands or the scripts and
  config they run, and reports blocked for a flaky, timeout, crash, environment or
  out-of-scope failure. From 1.6.8 its prompt also carries the start check's line for each
  failing command, and says never to create a worktree or checkout outside the feature dir.
- No repair runs when the start check found that every failing command fails at the start
  point too.
- Its head is delivered only when verify, run with `run-checks --descends-from <start>`,
  confirms the branch head is that sha and descends from where the repair started; otherwise
  the observed head is recorded and the result is closed (`final_fix_unreviewed`).
- Every repair is re-reviewed at the delivered head: inside the final re-review after a final
  fix, or by a `final re-review` of the repair range when there were no findings. Repairs
  have no id: a problem in one goes in `new_findings`. A missing, refused, other-head or
  malformed re-review leaves the repair unreviewed.
- After 2 repairs, or without room, a still-failing verify is `checks_failed`, rejected
  (`checks_failed_at_start` when the start check made for that head found every failing
  command failing at the start point).
- The report's `final.repairs` lists each attempt `{attempt, from, observed_head, eligible,
  head, failed, status, notes}`; `check_policy` records the policy the run ran under.

**Setup skip:** `scripts/setup` runs a lane's setup commands only when the lane has pending
work (a task not in both `done` and `reviewed`); it still creates and checks every worktree.
Skipped lanes are in `setup_result.setup_skipped` and the `run_started` ledger entry. A
relaunch recomputes `done` and `reviewed` before setup (approvals can be reopened or go
stale).

**run-checks** reads `git status` twice per call on a clean checkout: one
`--untracked-files=all` snapshot before the commands and one after. When a snapshot has
tracked changes, the tracked list is read with `--untracked-files=no` (one more call), so a
submodule holding only untracked files is not a tracked change, as before. The tracked and
untracked lists are as before; `clean` is the after snapshot being empty, so it no longer
follows a `status.showUntrackedFiles=no` setting. From 1.6.8 `--record-setup COMMAND`
(repeatable) records the setup commands as `setup_commands` in the evidence, in order, and never
runs them; `--record-setup-none` records that there were none (`setup_commands: []`); without
either the key is absent.

**Reuse** (1.6.8). A resumed integration need not rerun a check an earlier launch passed at the
same head. The integrate agent always runs the setup commands first (later phases rely on them in
the feature checkout); then, only when its merges made no commit, it runs `<python>
<skill_dir>/scripts/reuse-checks <ledger_dir> --name integrate --head <HEAD> --checkout <feature
dir> [--setup COMMAND]... --cmd GROUP COMMAND [--cmd ...]`, with the same setup and check
commands as its run-checks call. It reads `<ledger>/checks/integrate.<n>.json`, highest `n` (as a
number) first, skipping a file that is unreadable, not a JSON object or an error record, and
reuses the first where `phase` is `integrate`, `head` is HEAD with no `head_after`, `checkout`
is the feature dir (compared after realpath and normcase), `ok` and `clean` are true and every
exit is 0, `tracked_before` and `untracked_before` are empty, `tree_changed` is false, the
results' `(group, command)` pairs equal the `--cmd` list in order, and `setup_commands` equals
the `--setup` list. It prints `{reuse: true, file}` (exit 0) or `{reuse: false, why}` (exit 1;
the why names the newest file and the first rule it fails); exit 2 is a usage error. On exit 0
the agent skips the run-checks call, returns `checks_reused` (the file) and says so in its notes;
otherwise it runs the checks as before. Its run-checks call passes `--record-setup` for each
setup command (`--record-setup-none` when there are none), so a later resume can reuse that
evidence. Evidence without
`setup_commands` (1.6.7 and earlier) is never reused. Verify, wave checks, task checks and
post-integrate checks are never reused.

## Long checks

A tool call that outlasts the Bash tool's 10 minute limit is cut off, and an agent that
waits on a background job it cannot see may end its turn and return no result. From 1.6.1
every check an agent runs (task checks, integration, verify, and any other command expected
to run longer than 9 minutes) goes through one procedure built on
`scripts/await-checks`, whatever its length. The prompts carry it with the commands filled in.

**Procedure** (the agent's side):
1. `await-checks reserve --ledger <ledger> --name <name>` (a short call) prints a result file,
   `<ledger>/checks/<name>.<n>.json`, created empty and exclusively with `n` the first free
   number. Every run, a rerun after a fix included, reserves its own file: a path that
   already holds a report would make the wait return the previous run's report.
2. Start the check with the Bash tool's `run_in_background` set to true, its result path set
   to the reserved file: `run-checks <dir> --out FILE --root <ledger> --cmd GROUP COMMAND`, or
   `task-checks ... --evidence FILE`.
3. `await-checks wait FILE` in the foreground with a 600000 ms timeout, again while it exits 4.
   It prints the report as the check wrote it.
4. Change nothing in that checkout while a check runs (no edits, commits or other checks),
   and never end the turn while one runs.
5. After a stop (exit 5), reserve and start once more; after a second stop do not start it
   again and report the checks as failed, never as passed, with both outcomes the wait
   printed.

Quitting Claude Code while a check runs stops it: from Claude Code 2.1.300, exit force-kills a
background command still running 1.5 seconds after being asked to stop. The wait then reports
`stopped` with reason `died` (exit 5), and anything the killed check left in the checkout shows
as `checks_unclean`.

A report with `tree_changed` true (below) means the checkout changed while the checks ran: run
them once more, with a new reserve. Rerun only once; if the checkout changed again, keep that
result and say in the notes that the checks themselves change the checkout.

**Verify** reserves with `--exact`, so its result file is the fixed `<ledger>/checks/verify-<sha>.json`
that `scripts/check-verify` reads: reserve empties an existing file. While an earlier writer
still holds that path's check-file lock, reserve writes nothing and prints
`{"status": "busy", "file": PATH}` with exit 4. The agent runs `await-checks wait` on that
path until it no longer exits 4, ignores that report, then reserves again. If the checks
stopped twice, the verify result carries no report and the run records `verify_stopped`
(the reason, with `verify` null), so there is no verify result to accept.

**await-checks reserve** exits 0 and prints the path alone; 4 busy (`--exact` only); 2 on a
usage error (an unsafe name, a missing ledger, a path outside the ledger or a symlink; nothing
is written); 3 on any other error.

**await-checks wait** polls every 2 s for `--max` seconds (default 540, 1-570):
- Exit 0 or 1: the file holds a complete report (a JSON object with a boolean `ok`); stdout is
  its line, exit 0 when `ok`, 1 when not. A report counts only once its writer is gone: wait
  reads the file only when no writer holds the check-file lock.
- Exit 3: an error record (an object with an `error` key, such as task-checks' own), or a file
  that holds anything else once the writer is gone and the grace has passed.
- Exit 4: still running at `--max`; stdout is `{"status": "running", "file": FILE,
  "waited_s": N}`. Run the wait again.
- Exit 5: stopped without a report. stdout is `{"status": "stopped", "file": FILE, "reason": R}`
  with R `died` (this wait saw the lock held earlier, or a sidecar `FILE.lock` is left that no
  one holds: the writer was killed) or `not_started` (the check never began). Every stopped
  outcome waits for the 60 s start grace first, counted from the later of the file's
  modification time and the start of the wait, so a slow interpreter start is not a stop.
  `AWAIT_CHECKS_GRACE_S` replaces the 60 s; it exists for the tests only.
- Exit 2: a usage error.

**Check-file lock.** A writer (`run-checks --out`, `task-checks`) holds an OS lock on the
sidecar `FILE.lock` (`scripts/_await.py`) from the moment the path is known until its last
write; the lock dies with the process, so a killed writer is never mistaken for a live one.
`task-checks` holds it for its whole run and tells `run-checks` `--lock-held`, so the two do
not contend for it. A leftover sidecar is harmless.

**tree_changed.** `run-checks` takes a content fingerprint (a sha256 over HEAD, `git diff HEAD
--binary` and each untracked, non-ignored path with its blob sha) before the first command and
after the last. The report's `tree_changed` is true when they differ, false when equal and
null when a fingerprint could not be taken. The `git status` lists cannot see an edit to a file
that is already modified or untracked; the fingerprint can. `await-checks wait` prints one
line on stderr when it is true: `await-checks: the checkout changed while the checks ran; rerun them`.

**Evidence files.** `task-checks --evidence FILE` writes its evidence to the reserved FILE
(which must be empty, directly in `<ledger>/checks` and named `task-<unit>.<n>.json`; else exit
2 and nothing is written). An empty file, such as one reserved and never written, is never valid
evidence: check-verify reports an empty `verify-<sha>.json` as `invalid`, audit never reads it as
present, and autopsy counts an empty `task-*.json` as malformed and unmatched.

**Autopsy** recognises a procedure by its commands: a background start of `run-checks --out F`
or `task-checks --evidence F` with a later `await-checks wait` on a file of the same name. It
times the execution from the archived report, not as a timeout or a background check, and
`checks.waits` counts the executions that reserved first, the waits, the stops and the waits an
agent improvised.

## Exit codes

The contract for the exit codes of commands run through `scripts/run-checks` (task checks,
integration, verify and the rechecks, the start check, fixers' and repairs' checks, long
commands). It does not
cover setup commands and hook commands: their exits are read as before.

| Exit | Means | What the run does |
|---|---|---|
| `0` | passed | nothing more |
| `124` | timed out | no repair or fix agent for it |
| `75` | busy or temporary (sysexits `EX_TEMPFAIL`), for example another program holds the project open | `run-checks` waits 60 s and runs the command once more; the second exit is its result. Still `75`: no repair or fix agent for it |
| `128` and above, or negative | killed by a signal | no repair or fix agent for it |
| any other non-zero | a real failure | repair and fix as before |

The engine decides with one predicate (`nonDefectFailure`): a failure made only of `75`,
`124`, `128` and above, negative exits, or exits that are not numbers marks no defect. A real
failure beside a timeout is still a real failure. The codes steer repair, fix and retry, never
acceptance: a check that exits `75` or `124` has still failed (`ok` false), and acceptance reads
it as `checks_failed` like any other failure. Per caller:
- **Verify:** returns `run-checks`' result as printed. A repair after a failing verify (see
  "Check ownership") is not due for a failure made only of these exits, and neither is the
  start check.
- **Start check** (1.6.8): the agent reports each exit as the wait printed it, and the engine
  reads it. At the start point `0` (with no test `not_run`) is `passes`; `75`, `124`, `128` and
  above, negative, and also `126` and `127` (the command could not be run or was not found at
  the start point, which says nothing about the tests) are `unknown` for that command, never
  `fails`.
- **Integration:** the integrate agent sets `checks_unfinished` true (beside `tests_failed`)
  when every failing command exited `75`, `124`, `128` and above or negative. The engine then
  starts no post-integration fix and stops with `integration checks did not finish: <notes>`,
  a real stop, not a transient one: a timeout needs a longer timeout or a faster suite, a busy
  machine needs the user, and a relaunch would hit the same. A mix of a real failure and a
  timeout is not `checks_unfinished`; the heal round runs as before.
- **Implementer task checks:** a task check that failed only with these exits is reported
  blocked, naming the exits and the result file; the agent changes no code, tests, timeouts
  or commands for it. The adjudicator, told that such a failure is no defect to fix, decides
  as before (it may defer or park the task).
- **Fixers** (task fix, final fix, post-integrate fix, repair) **and long commands:** such a
  failure is no defect; they change nothing for it and say so in their notes.

**The busy retry.** Only exit `75` is retried, and only once. The entry keeps `started` from
the first attempt and `ended` from the second, so `duration_s` spans both and the wait, and
carries `busy_retry: {first_exit: 75, waited_s: 60}`; the log keeps both outputs after a
separator line. `check-verify` compares only group, command and exit, so it is unaffected; the
check-file lock is held a little longer. `RUN_CHECKS_BUSY_WAIT_S` overrides the wait, for
tests only.

**Mapping a project's tools.** A tool rarely exits with these codes by itself: a project maps
its tools to the contract in a wrapper. Thistledown's `unity-batch.sh` is the example: it turns
the Unity CLI's timeout into `124` and its preflight that finds another Unity holding the
project open into `75`. A tool's own `--timeout` is not its wall time: it may bound only one
phase and exit with a code of its own (sc1's Unity CLI timeout exited `6`, read as a test
failure), so a wrapper that needs a wall-time limit times the whole command and exits `124`
itself.

## Active-run markers and stops

Setup's exit 4 naming another run (`the checkout ... is in use by run ...`) means that run holds
the checkout: setup changed nothing, so release this run's own launch lock first (`active-run
release <run_id> setup_failed --owner <token>`, or `active-run release <run_id> --remove --owner
<token>` for a new run that never started), then stop and report it.

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
(`no result from ...`, `error: ...`), setup-command retry exhaustion (`setup failed`), and
`agents_unavailable` under the conditions in "Transient stops" and "Usage limit" are
transient and relaunch once without asking. `review_rounds`, a supervised blocked or question
task, `adjudication_cap`, `adjudicator_stop: <condition>`, `budget`, failed integration or
post-integrate on real failures, `invalid`, and `preflight_conflicts` always stop for the
user. The session notifies (PushNotification, else a chat notice) on completion, any real
stop, a budget cap, and a failed relaunch. `agents_unavailable` is transient only as "Transient
stops" (under Flow details) and "Usage limit" say; `integration checks did not finish: ...` is
a real stop.

## Usage limit

**The platform's pause.** Claude Code pauses a workflow at the usage limit by itself, under
conditions. Its documentation (code.claude.com, "Dynamic workflows", section "When a run hits
your usage limit", read 2026-10-13): "When an agent hits your claude.ai usage limit, the run
pauses rather than failing that agent: the agents that hit the limit wait for the reset, and
no new agents start. Shortly after the limit resets, the waiting agents run again and the run
continues on its own. Requires Claude Code v2.1.271 or later." It pauses only when all of
these hold:
- the session is interactive and signed in with a claude.ai subscription: not `claude -p`, the
  Agent SDK, a background session, or a Remote Control or agent-team teammate session;
- `autoContinueAtUsageLimit` is on (on by default in interactive subscription sessions since
  v2.1.234: "Interactive mode", "Wait for a usage limit to reset"; its scope is user or
  managed settings);
- the limit resets within 24 hours (a weekly limit may not);
- the run has not already waited twice (the third hit fails the agent).
While it waits, the task panel and `/workflows` show the reset time. parallel-lanes does
nothing during a pause: the waiting agents are not dead, so no missing result reaches the
engine, a check already running in the background keeps running, and the long-check waits
(see "Long checks") go on.

**Before a launch.** Doctor's `usage_limit_pause` (see "Doctor") reads the Claude Code version
and the setting, and the session adds what doctor cannot see, its own session type. The
confirmation header's usage-limit line (see "Confirmation header" under Flow details) says
which of three it is: the run pauses; it will not pause, with the reasons and the user's
options; or unknown. The session only reports and recommends; it changes no setting and no
session setup.

**The fallback.** Where the platform does not pause (a Remote Control, background or headless
session, an older Claude Code, the setting off, a third hit, a limit beyond 24 hours), every
running agent dies at the limit and the Workflow tool's `agent()` returns null. The engine sees
a call whose spawn and automatic retry both returned nothing, starts one small `availability
probe` agent on that call's model (one agent, never a ruling), and when the probe returns
nothing too it starts no further agent (no adjudicator, retry, fix or verify): the launch stops
with reason `agents_unavailable`, every lane keeps its own cause, refused work reads `agents
unavailable: <label> was not run`, and the result carries `agents_unavailable: {trigger,
probe, results_before}` (see "Report"). A probe that answers means the agent died for its own
reasons, and the run goes on as before.

**Telling a usage limit from other deaths.** After an `agents_unavailable` stop, run
`<python> <skill_dir>/scripts/stop-cause <transcript dir>` (Launch step 4's transcript dir). It
reads the launch's workflow result file and its logs, read-only, and prints one line
`{"usage_limit": true|false, "resets": "<text>"|null, "lines": N}`: `usage_limit` is true
when the Workflow tool logged an agent call that failed on a usage limit, and `resets` is the
reset time as the message gave it (for example `11:20pm (America/Los_Angeles)`), never
turned into an absolute time. Wording it does not know reads `usage_limit: false`. Exit 3 (no
readable result file or logs) leaves the stop unlabelled: treat it as another transient stop.
Put `resets` in the stop notice when there is one.

**When to relaunch.** The session shares the account's limit, so a session that can run a turn
is past the reset. The relaunch happens at the session's next turn after the stop (the workflow
notification, or the user's return), whatever stop-cause says: stop-cause only labels the stop
and gives the user the reset text; its exit 3 is no reason to wait or to relaunch sooner.

**How often.** A usage-limit stop (stop-cause `usage_limit` true) may be relaunched without a
table once after each reset, while budgets allow, however many relaunches came before it. Not
when the stopped launch got no agent result before the latch (`results_before` 0 in the
result's `agents_unavailable`): that launch died at once, so it is a real stop (notify). Every other transient stop keeps
the rule "relaunch once; a second transient stop is a real stop".

**Which session.** The relaunch without a table belongs to the session that holds the launch
lock (Launch step 2's owner token). A new session finds the lock held and, after the user
confirms the old session ended, takes the Resume path with a table, as for any locked run.

Every relaunch also runs the doctor rerun, the engine version check and the budget carry-over
in "Transient stops" (under Flow details).

## Report

`<python> <skill_dir>/scripts/run-report <transcript_dir> <manifest> [--out FILE]` reads the
workflow transcript directory printed at launch (`agent-*.meta.json` and `agent-*.jsonl`).
Output: `engine_version` (the workflow result's `version`: the skill version `run.workflow.js`
was built from, which `scripts/build` stamps from `VERSION` into the workflow's description and
its first log line, `parallel-lanes v<version> loaded`), `agents` (per agent: label, phase, task, role, requested and resolved model,
`resolved_models` with message counts, effort, input, output, cache read, and cache creation
tokens), `tiers` (totals per tier), `totals`, `models` (agents per resolved model), and
`unavailable`, `output_incomplete`, `escalations`, `fix_rounds`, `retries` counts. A field
that cannot be read is the string `unavailable`, never a guess. With `--out` the full report
goes to FILE and the script prints a summary for the hand-back: the same object without
`agents`, plus `report` (FILE) and `agent_count`. Effort comes from the
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

`run-checks` stamps each result with `started` and `ended` (UTC ISO 8601 with milliseconds) and
`duration_s` (seconds, from a monotonic clock). They are additive: `check-verify` compares only
group, command and exit per result. `autopsy` reads them in its `checks` section. A result
that exited 75 and was run once more also carries `busy_retry: {first_exit, waited_s}` (see
"Exit codes"), kept in the verify result.

Fields added in 1.6.2, all optional and additive:
- `agents_unavailable: {trigger, probe, results_before}` on a run that stopped with reason
  `agents_unavailable` (see "Usage limit"): `trigger` is the label of the call whose spawn and
  retry both returned nothing, `probe` the probe's label (`availability probe`), and
  `results_before` the number of agent calls that had returned a result before the latch (the
  probe not counted). A refused task's notes, a lane's stop reason and the final phase's open
  reasons say `agents unavailable` where a budget stop says `budget exhausted`, and a refused
  repair has status `unavailable`.
- `checks_unfinished` in the integrate agent's result (see "Exit codes"); the run then stops
  with `integration checks did not finish: <notes>`.
- `index_commit` (a sha or null), `index_saved` and, when that is false, `index_error` in each
  `setup_result.preserved` entry (see "Cleanup").

Fields added in 1.6.8, all additive (a reader treats a missing key as null or `[]`):
- `final.start_check`, only when a start check was due (it ran, or was recorded unavailable for
  the budget; see "The start check" in Check ownership): `{status, why?, start_sha, evidence,
  verify_head, commands: [{verify_command, start_command, narrowed, exit_at_start,
  failed_at_head, failed_at_start, not_run, at_start}], all_fail, some_fail, notes}`, with
  `at_start` one of `fails`, `passes`, `partly`, `unknown`; `status` is `checked` or
  `unavailable` (`why` says which refusal or problem, `budget` when no agent was free); `why`
  also appears on a `checked` result whose start sha or evidence path is wrong (every command
  is then `unknown`).
- `integrate.checks_reused`: the integrate evidence file a resumed integration reused (see
  "Reuse" in Check ownership), else null.
- `preflight.permits` (`[{task, files, ruling}]`, the kept ones) and `preflight.permits_dropped`
  (`[{task, file, why}]`), when the pre-flight agent ran (see "Adjudicator").

`unreadable_lines` (per agent, and the total at the top level) counts the non-blank transcript
lines that are not valid JSON, such as a truncated write, or not valid UTF-8. A line with
invalid UTF-8 counts even when it still parses after the bad bytes are replaced (they may have
been a key or a count), and what it holds is still read as far as it goes. An agent with any
unreadable line is incomplete exactly as a mid-stream count makes it (`output_tokens` is
`unavailable`, `output_tokens_min` holds the lower bound, and it counts in `output_incomplete`),
since the lost line may have held a later count. Report a non-zero total, because the figures
are then minimums. An agent with unreadable lines and no usage line at all keeps both values
`unavailable`.

`<python> <skill_dir>/scripts/check-verify <transcript_dir> <manifest>` takes the same two
arguments and prints one status JSON line (see "Verify evidence").

Acceptance: `status: complete` only says the run executed to the end. `acceptance`
(`{status, delivered_sha, reasons, warnings}`) says whether the delivered revision
(`delivered_sha`: the feature head after the final fix) meets the gates, decided in code
from the evidence: `accepted` (no reason), `rejected` (a check failed at `delivered_sha`, a
blocking finding is open, or a task is deferred or not done), or `unverified` (nothing failed,
but evidence is missing or covers another revision). Reasons are `{kind, class, detail}`:
`checks_failed`, `checks_missing`, `checks_stale`, `checks_incomplete` (from `verify`, the
`scripts/run-checks` result at `delivered_sha`), `checks_failed_at_start` (1.6.8, class
`failed`, still `rejected`: in place of `checks_failed` when the start check made for
`delivered_sha` found every failing command failing at the start point too; detail `failing at
<sha> and at the start point <start>: <command> (exit N): <tests>; evidence <file>`; when only
some do, `checks_failed` stays and a warning says `fails at the start point <start> too:
<command>`), `e2e_failed`, `e2e_missing`, `e2e_stale`
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
`ok`, `clean` and the exit code are unchanged), and `untracked_before` and `untracked_after`:
the `?? ` lines of `git status --porcelain --untracked-files=all` at the same two moments, so
every untracked file that is not ignored (`[]` when none). Acceptance gives `checks_unclean`
(class `missing`) when the verify result at the delivered revision has a non-empty
`tracked_before`, `tracked_after` or `untracked_before`, or lacks one of those, because checks
that ran on uncommitted tracked changes, or with an untracked file present that the commands
could read, did not test the commit. Verify runs in the feature checkout, and earlier steps of
the run have already run the same project commands there: integrate (setup, then every
command), the E2E and post-integrate hooks, the final fix agent, and in the `lite` profile the
implementers. No agent may delete untracked files, so whatever those commands created that is
not ignored (`test-results/`, coverage output, a generated file) is still in the checkout when
verify starts, is listed in `untracked_before`, and makes the run `unverified` with
`checks_unclean`; the fix is to add those files to `.gitignore`. A non-empty `untracked_after`
alone (files the checks created) stays a warning that names the new files only when the checks
run for the first time in a clean checkout, which in a run is rare. A missing `untracked_after`
does not block either: it only affects that after-checks warning, which then falls back to the
general text.

The guarantee, in one paragraph: `accepted` means the configured checks passed at the delivered
commit, with no tracked change and no untracked file present before them. Ignored files are not
covered: `run-checks` does not list them, so a stale build output or cache that `.gitignore`
hides can still change what the checks test. Any file that is not ignored and that the project's
commands create is present when verify runs `run-checks`: one a setup command creates (the
verify prompt runs setup first; an uncommitted lockfile, for example), and one the test, lint or
build commands create when an earlier step of the run ran them (see above). Either makes every
run `unverified` with `checks_unclean`, where it once only warned. The fix is a `.gitignore`
entry for the file, or an explicit accept by the user that names it (see "Verify evidence"); a
session re-verify alone does not clear it, because the session runs the same setup commands
first in the same checkout. Running verify in an isolated worktree at the delivered sha, so
that files earlier steps left cannot be present, is later work.
Warnings (open minor findings, cannot-verify entries with a source, checks that left the
checkout dirty or did not say) never block. The checks evidence is the
`scripts/run-checks` JSON the verify agent returns (the workflow cannot read files; the same
JSON is saved under `<ledger_dir>/checks/` for the user to compare): the session
compares that report with the saved JSON at hand-back; it does not re-run the checks (see
"Verify evidence"). `run-checks` keeps the commands' output out of its own stdout and
stderr: each command's combined output goes to a log file beside that JSON (`<out stem>.<N>.log`;
every call the engine hands an agent passes `--out`, so the logs stay with the evidence). Only a
manual call without `--out` writes them to a new temporary directory, which its caller may remove.
Each result carries `log` (its path) and `tail` (its last 20 lines, kept to the last 4096 characters and starting with `[truncated] ` when cut, so one long line stays
out too). `--root` checks the JSON and its logs only with `--out`. Verify runs once at the delivered revision, after the final fix and
before the final re-review, which gets its result and does not rerun the checks; the E2E and
post-integrate rechecks are told the project checks already ran at that commit and run only
what their hook adds. Show the
status and every reason first; only `accepted` is delivered work. A reason or warning the
user explicitly accepts is recorded with `ledger accept <ledger_dir> <repo root>
<delivered_sha> "<what>"` (an `accepted` event; `ledger status` lists them under `accepted`)
and shown as accepted by the user, never folded into `accepted`. `checks_failed_at_start` is
shown like any rejection, with its detail and evidence file, and the hand-back suggests the
accept text, for example `ledger accept <ledger_dir> <repo root> <delivered_sha>
"checks_failed_at_start: <command> fails at the start point <start> too (evidence <file>)"`.
Once the accepts cover every reason (and the warnings the user named) and archive-run, audit
and tool-outcomes have run again, remove the marker with `bash <skill_dir>/scripts/active-run
remove <run_id>`: a marker left `unaccepted` sends a later session to Resume.
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
Findings are merged only when they are the same finding: reported at the same `file` and `line`
(when `line` > 0), or on the same `commit <sha>` file, with the same issue text (compared after
trimming and collapsing whitespace). The merged finding keeps every lens and the issue text,
severity, and fix of its most severe report (the first of those on a tie), so the text matches
the severity. Distinct issues at one location stay separate findings, each its own obligation: a
minor one cannot hide a critical one. Each finding carries `same_location`, the ids of the other
findings at its location (`[]` when none, and always for a finding with no usable line); the
agents that get the findings see it as "Same line as". `also_reported` is still present on every
finding, always `[]`, so the shape is unchanged. Every minor finding of an approved task review
gets an id `<task>-<n>`, with `T` put in front of a task id that starts with a digit (task 3
gives `T3-1`, task T2 gives `T2-1`), and goes to the final lenses as a checklist: a lens raises
one by putting its id in brackets in a finding's issue, or leaves it. `final.task_minors_open`
lists the ones no lens raised: show them in the report, so minors from task reviews are not
lost. From 1.6.3 only the security lens gets the checklist, and the minors an earlier launch
left open are carried ("Carry-over"): they reach it through `ledger minors`, and
`final.carried_minors_open` lists the carried ids no lens raised. A skipped task that no
snapshot covers (a launch `carry-launch` could not read, or a 1.6.2 launch) still reaches neither
the lenses nor `task_minors_open`; the run says so in a `cannot_verify` note (a plain string, so
not a warning) naming those tasks (check them in the earlier launch's report). The fixer gives each id a disposition with its evidence; the re-review names the
revision it judged (`head`). A finding the fix gave no disposition for, a disposition or
re-review result with blank evidence, a re-review of another revision than the fix head, or two
different dispositions or results for one id leave the finding open (the new findings such a
re-review reports are kept). `ledger status <ledger_dir> --manifest <manifest file>` lists under
`undeclared` the files each task's recorded range changed outside its `files` (from git; a
batch's files count for each of its tasks): list them in the report so the user can see work
that went beyond the plan.

The hand-back appends the report, saves it beside the manifest, and lists
"Rulings made on your behalf" from `<python> <skill_dir>/scripts/ledger rulings <ledger_dir>`
(each with its id and role, overridden ones apart), plus this launch's `preflight.rulings` when
the launch is not carried yet; then the rulings that override others (`ledger status`'s
`overrides`, flagging an implementer that overrode a pre-flight or adjudicator ruling) and the
observed failures (rulings whose text starts `Observed:`). When
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

### Report contents

The hand-back appends `run-report`'s output. Per task: status, commits (`skipped`: from the
ledger's `committed` events), review rounds, tier and escalations, notes, cannot verify.
"Rulings made on your behalf" and "Dependencies pre-flight added" (above). Then integration and
post-integrate notes, E2E PASS/FAIL and the revision it checked, final review (fixed, declined,
open, cannot verify, and the task minors no final lens raised, `final.task_minors_open`),
acceptance warnings, `agents_spawned`, `agent_type_fallback`, the carried minors left open
(`final.carried_minors_open`), and the `undeclared` files of `ledger status <ledger_dir>
--manifest <manifest file>` (changed outside their task's Files list), each with its owner and
relation; mark each `alongside` or `later` one no adjudicator ruling's `files` covers.

### Run tools line

After `archive-run`, `autopsy` and `audit`, and after any other tool the hand-back runs, the
session runs `<python> <skill_dir>/scripts/tool-outcomes`, last. It is read-only, needs no
manifest, and prints one line, `Run tools: <doctor>; <archive>; <autopsy>; <audit>; <cleanup>`;
show it under its own label after the acceptance lead.
- **Flags:** `--run-folder DIR` (the folder `archive-run` printed; it goes through the same
  Git Bash path conversion as other paths), `--archive-exit N`, `--autopsy-exit N`,
  `--audit-exit N` (integers),
  `--conditions-refused CODE` (the latest launch's `ledger conditions` refusal code, one of the
  five in "Launch conditions"), `--relaunch-blocked CHECKS` (comma-separated failed check
  names from a relaunch that doctor stopped), `--cleanup awaiting|done|declined|failed|none`
  (`awaiting` when cleanup will be offered, else `none`), and `--json`. Any other value is
  exit 2; it exits 0 whenever its arguments parse.
- **The line:**
  - doctor: from the last launch's entry in `autopsy.json`, read only with `--autopsy-exit 0`
    and `--run-folder`. A recorded launch reads `doctor before <wf>: <status>` with the warned,
    failed and not-read checks by name. Otherwise the line says launch conditions were not
    recorded (with the refusal code), are inconsistent (with the reason), or were not checked
    (autopsy not run, failed, unreadable or listing no launches). A run with several launches
    adds "(earlier launches: see autopsy)", and `--relaunch-blocked` adds ", relaunch blocked by doctor
    (<names>)".
  - archive: `archived to <DIR>`, `archived`, `archive failed (exit N)` or `archive not run`.
  - autopsy: `autopsy generated (<m> possible contributor(s))`, `autopsy generated
    (contributors unavailable)`, `autopsy failed (exit N)` or `autopsy not run`.
  - audit: `audit generated (<k> evidence gap(s))`, where k is the length of the `gaps` list in
    `<run folder>/audit/audit.json` (read with `--audit-exit 0` and `--run-folder`); `audit
    generated (gaps unavailable)` when that file is missing, unreadable or has no `gaps` list, or
    there is no `--run-folder`; `audit failed (exit N)`; or `audit not run`. See "Audit".
  - cleanup: `cleanup awaiting approval`, `cleanup done`, `cleanup declined`, `cleanup failed`
    or `cleanup not offered`.
- **`--json`** prints `{"doctor", "archive", "autopsy", "audit", "cleanup"}`, each `{"state",
  "detail"}`, where `detail` is that tool's text in the line. States: doctor `recorded`,
  `not_recorded`, `inconsistent` or `not_checked`; archive `archived`, `failed` or `not_run`;
  autopsy `generated`, `failed` or `not_run`; audit `generated`, `failed` or `not_run`; cleanup
  `awaiting`, `done`, `declined`, `failed` or `not_offered`.
- **Separate from acceptance.** `acceptance` is the only verdict on the delivered work. A tool
  failure never changes `acceptance`, and a clean tools line never stands in for it. Lead with
  `acceptance`, then show this line under its own label.
- **After cleanup.** `tool-outcomes` runs again after cleanup, with `--cleanup done`,
  `declined` or `failed`, and the session shows the new line.

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
| `unavailable` | `verify_evidence_time_untrusted` | 1 | `--ledger` mode only: the launch has no finite end time, or the evidence is dated after it |

Exit 2: usage error, or the result file or the manifest cannot be found or read (message on
stderr). Exit 3: a Windows path cannot be converted (no Git Bash or cygpath, as the other helpers).

**`--ledger DIR` (archive mode).** `check-verify <transcript_dir> <manifest> --ledger DIR` checks a
run folder made by `archive-run`, for `scripts/audit`. The result is read only from
`<transcript_dir>.json`, never through a session-level file, and the transcript dir itself need not
exist. The evidence is read from `DIR/checks/verify-<sha>.json`; the manifest must still be a
readable JSON object, but its `repo.ledger_dir` is neither required nor read nor converted, so a
POSIX `ledger_dir` needs no cygpath. After the `stale` rule and before `mismatch`, a time rule
applies: `startTime` must be numeric, `durationMs` a finite number of at least 0, and the evidence
file dated at or before `startTime + durationMs`; otherwise the status is `unavailable`, reason
`verify_evidence_time_untrusted`, exit 1. Copies made by hand carry their copy time, so they cannot
be trusted. Without `--ledger` every status, rule and exit code is unchanged.

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
   with string `group` and `command` and an integer `exit` (never a boolean); `tracked_before`,
   `tracked_after`, `untracked_before` and `untracked_after`, when present, lists of strings.
   Else `invalid`, with `detail` naming the field.
5. The sha is `result.delivered_sha` when not null, else `result.verify.head`. It must be 40 or 64
   lowercase hex digits; else `invalid`, and it is never put into a path.
6. No evidence file: `missing`. Not JSON or failing rule 4 (the tracked and untracked lists may be
   absent, as older run-checks wrote them): `invalid`.
7. Freshness: the evidence file must not be older than the result file's `startTime` (epoch
   milliseconds; absent or not a number: `invalid`); an older file is `stale`.
8. Compare `head`, `ok`, `clean`, `tracked_before`, `tracked_after`, `untracked_before`,
   `untracked_after`, then `results` position by
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
  <ledger_dir>`. Show the result. When every exit is 0, `ok` is true, both tracked lists and
  `untracked_before` are empty and `head` is the delivered sha, the user may accept the run
  explicitly; record that with
  `ledger accept <ledger_dir> <repo root> <sha> "session re-verified: <path>; replaces <reason>"`.
  When `untracked_before` is not empty (or missing), the re-verify does not show that the checks
  tested the commit: name those files to the user. Record an explicit accept only when the user
  confirms that none of them is an input to the checks, and name them in the note (`...; replaces
  <reason>; untracked before the checks, confirmed not inputs: <files>`); the lasting fix is a
  `.gitignore` entry for them.
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
`reopened` when the engine acted on such an approval as changes). Its usage is
`ledger reviewed DIR LANE TASK ROUNDS PLAN CHECKOUT HEAD BLOCKING [SPEC]`: give SPEC, the spec
file the review read (`-` when there is none), and the approval also records `spec_sha256`, the
file's hash (`null` for `-`). A changed section or head puts the task in `stale`, and so do
two spec reasons, checked when `--plan` is given: an approval that recorded `spec_sha256` is stale
when it differs from the current spec's hash (`the spec changed since its review`; with `--plan`
but no `--spec` the current spec counts as absent, so an approval that recorded a hash is
stale and one that recorded `null` is not), and an approval that recorded none (from before
1.4.4) is stale whenever the run has a spec: `--spec` is given, or any launch's setup recorded
one (`the review recorded no spec (it predates 1.4.4) and this run has one`). That holds after
later setup records too, so an interrupted resume cannot revive it; a fresh approval that
records the spec settles it. Pass `--spec` on a resume only when the run has a spec. A
review without a hash (older ledgers) is `unbound`, and both are left out of `reviewed` so the
resume reviews them again. `inputs`
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

## Run history

`<python> <skill_dir>/scripts/archive-run <manifest> [<transcript dir>...] [--ledger DIR]
[--notes FILE...] [--history-dir DIR]` copies a run that ended after a launch into the run
history (never a dry run). Run it after `run-report` has written its report beside the manifest.
A call needs at least one transcript dir, or `--notes` for a run already in the index.

- **History dir:** `--history-dir`, else `PL_HISTORY_DIR`, else
  `<config dir>/parallel-lanes/history/`. `_history.history_dir` resolves it for Python and
  `pl_history_dir` in `scripts/_paths.sh` the same way for bash. A history dir inside the
  project (the repo in git mode, the project folder in shadow mode) is refused with exit 3 and
  nothing is written.
- **Run identity:** `run_id` plus the manifest's `repo.ledger_dir` (`_history.run_key`), because
  run ids repeat across projects and machines. A resume in a new session passes only its own
  `wf_<id>` dirs; the run is found by that key and keeps its folder and first-launch date.
  `cleanup` finds the run by the same key.
- **Folder:** `<history dir>/<YYYY-MM-DD>-<run_id>/` (the UTC date of the first launch; `-2`,
  `-3` ... when another run owns the name). It holds the manifest, the ledger dir (`checks/`
  included), the run-report JSON, the plan and spec when they exist (pinned, below), each
  transcript dir `wf_<id>/` with its `wf_<id>.json` result file, `notes/` (1.6.8, below),
  `derive.json` and `setup.json` (1.6.8: copied when present and the manifest's directory is the
  run-owned `<config dir>/parallel-lanes/runs/<run_id>/`; a plans-folder run directory is shared
  between runs, so nothing generic is taken from there), and, written by other tools,
  `autopsy.json`, `autopsy.md` and `cleanup/`. Copying is idempotent: a missing file is added, a
  changed file is replaced, and a file already in the archive is never deleted. `launches`
  counts the `wf_<id>` dirs in the folder, so archiving again never raises it. Two different
  files that would get one name (compared without case) are refused with exit 2 before anything
  is written.
- **Pinning** (1.6.8): an archived plan or spec is only ever the version a launch recorded. Each
  setup `run_started` event in the ledger's `_run.jsonl` carries `head`, `plan_sha256` and
  `spec_sha256`; the latest one's sha is the one pinned. An archived copy with that sha is kept,
  even when the live file differs. Otherwise the first source with that sha is written: the live
  file, then, for a file inside the repo, its blob at each recorded setup head from the latest
  back, as git stores it (`git show <head>:<path>`) and with the checkout filters (`git cat-file
  --filters`, so a CRLF checkout matches), the path looked up in git without case (`git ls-tree`)
  only when git does not hold it as given, with `--git-dir` in shadow mode. When no source has the sha, an archived copy is kept and,
  without one, the live file is copied, with a `plan_unpinned` or `spec_unpinned` warning naming
  the recorded sha (the audit then reports the mismatch as a gap). A ledger with no recorded sha
  (before `plan_sha256`) never replaces an archived copy; without one the live file is copied. A
  spec of `null` is not pinned, and a plan outside the repo (the plans folder) can match only
  its live file.
- **Launch counts** (1.6.8): the launches the ledger records are the larger of its `run_ended`
  count (one per launch the session recorded, relaunches included) and the number of distinct wf
  ids its `carried` events and `doctor-<wf>.json` files name (a launch whose session died has no
  `run_ended`). When the folder holds fewer `wf_<id>` dirs, archive-run warns `launches_missing`
  with both counts and the named wf ids that have no dir ("unknown" when none are named): pass
  the missing transcript dirs to archive-run again.
- **`--ledger DIR`** (1.6.8) reads the ledger from DIR instead of `repo.ledger_dir`, for a run
  whose live folder is gone: `archive-run <archived manifest> <transcript dir>... --ledger
  <archived ledger>`. DIR must hold `_run.jsonl` (else exit 2). The run is found in the index by
  its key, so it keeps its folder; a ledger copied onto itself is left as it is. The ledger a call
  reads for pinning and counting is `--ledger`, else `repo.ledger_dir` when it exists, else the
  folder's archived ledger.
- **`--notes FILE...`** (1.6.8) copies each file to `<run folder>/notes/<basename>` with the same
  add-or-replace rule (hand-written observations, a review, recommendations). It takes every
  following argument up to the next `--` option. Two different notes with one basename exit 2
  with nothing written. Without transcript dirs the call is allowed only for a run already in
  the index (else exit 2): it adds the notes, pins, counts, and copies the ledger only when its
  source exists.
- **`index.json`:** `{"version": 1, "runs": [entry, ...]}`, one entry per run with `run_id`,
  `folder`, `ledger_dir`, `project`, `plan`, `engine_version`, `machine`, `platform`,
  `first_launch`, `last_launch`, `launches`, `launches_recorded` (1.6.8, from the folder's
  archived ledger as counted above; `unavailable` without one), `status` and `acceptance`. A value that cannot be
  read is `unavailable` (an older run has `engine_version: "unavailable"`; it is never inferred).
  Stored paths use `/`, and `C:/...` on Windows; a Linux path from another machine stays as
  written.
- **`index.lock`:** archive-run and `--reindex` change `index.json` only while they hold an OS
  lock on `<history dir>/index.lock`. They wait up to 30 s for it. The lock is released when its
  process ends, however it ends, so a crashed run leaves nothing to take over and the file's age
  means nothing. The file stays after the run; never delete it by hand. Before
  relying on this lock, ensure no unreleased old writers (an archive-run from an old checkout)
  are running: the old and the new lock do not guard each other.
- **`--reindex`:** `archive-run --reindex [--history-dir DIR]` rebuilds `index.json` from the
  folders already there (imported runs, hand-archived runs). Every folder holding a
  `*.lanes.json` is one run; the report is the first of `*.report.json`, `*.run-report.json`
  and `report.json`; `launches_recorded` comes from the folder's archived ledger
  (`<plan-name>.<run_id>.ledger`, else its one `*.ledger` dir). Folders keep their names; it
  prints `{"runs": N, "skipped": [...]}`.
- **Comparing two runs:** `history --runs A,B [--json]` (two run ids or folder names) prints,
  for each run, its plan's sha256, task ids, lanes, a hash of its `commands`, versions, launches,
  status, acceptance, wall time, fixed phases, task time, full-suite time and tokens, and whether
  the pair is comparable: only when the archived plans hash the same, the task ids, lanes and
  commands match and both autopsies are current. Otherwise `not comparable` with every reason.
  Partial token counts (the usual case: transcripts keep mid-stream output counts) are a note,
  not a reason. An out-of-date or missing autopsy (every archived run after an `AUTOPSY_VERSION`
  bump) gives a reason ending "(run history first)": a plain `history` run refreshes them. It writes nothing, never reruns autopsy and never prints a
  percentage. An id the index holds twice, or the same run twice, exits 2.
- **Imported folders are read-only:** do not run their manifests. `--reindex`, `autopsy` and
  `history` only add their own files (`index.json`, `autopsy.json`, `autopsy.md`, `history.json`,
  `history.md`) and never change or remove an imported file.

archive-run prints `{"folder": ..., "added": [...], "updated": [...], "pinned": [...], "kept":
[...], "replaced": [...], "warnings": [{"code", "detail"}]}`: `pinned` names a plan or spec newly
archived with its recorded sha, `kept` one whose archived copy already had it, `replaced` one
whose archived copy lacked it and was replaced (a file with no recorded sha, or none that
matched, is in none of the three); `warnings` holds `plan_unpinned`, `spec_unpinned` and
`launches_missing`. Show the warnings in the hand-back. Exit 0 on success; exit 2
on a usage error, an unreadable manifest, transcript dir, note, ledger dir (a `--ledger` DIR
without `_run.jsonl` included) or index, two notes with one basename, a notes-only call for a
run not in the index, a failed copy, or the lock not acquired; exit 3 when the history dir is
inside the project (nothing written).
`--reindex` exits 0, or 2 when the history dir is not a readable directory or the lock is not
acquired.

## Autopsy

`<python> <skill_dir>/scripts/autopsy <run folder> [--quiet]` reads one archived run folder
(never a live path from the manifest, so imported runs and runs from another OS work), writes
`autopsy.json` and `autopsy.md` into it, and prints a summary of at most 15 lines: the wall time
and slowest phase, the top three slowdowns with their cost, the full-suite runs, total tokens,
the top suggestion and the path of `autopsy.md`. The session appends that summary to the
hand-back report.

**Sections of `autopsy.json`:** `done` (per task status, commits, rounds, tier; acceptance;
final-review counts; E2E), `time` (wall time per launch, phases, lanes with busy and idle time,
agents with `tool_s` and `other_s`, the critical path, idle gaps), `tokens`, `checks`,
`slowdowns`, `detectors`, `suggestions`, `unexplained`, `launch_conditions` and
`orphan_snapshots`.
- `launch_conditions` has one entry per launch, from the doctor result saved for it, and
  `orphan_snapshots` lists the snapshot files that name no archived launch. `autopsy.md` gets a
  "Launch conditions" section after "Where time went", and the summary one line after the
  slowdowns when a recorded launch has a warned, failed or unread check. See "Launch conditions".
  `AUTOPSY_VERSION` is 7, so `history` runs autopsy again on an older `autopsy.json`.
- `tool_s` is the union of an agent's tool-call spans; the rest is `other_s` (model time,
  transport and scheduling), never called model time. The critical path is a timing-based
  estimate. A lane is matched by the manifest lane `name`, else `Lane <id>`.
- A partial agent (a tool call with no result, or unreadable lines) has `tool_s` and `other_s`
  `unavailable`: a call without a result may have run to the end. `tool_s_min` is then the
  least tool time that can be shown, a minimum and not the total.
- `checks` lists every execution of a configured project command or of `run-checks` (agent,
  phase, role, `start`, `end`, seconds, whether it ran in the background, whether it was on the
  critical path, and whether it `ran` or is `inferred`), the totals per check id (`by_check`), and the
  full-suite runs in total, inferred and per role. See "Checks" below.
  - `full_suite_runs` keeps its 1.5 meaning, check calls with a test group: a `run-checks`
    call passing `--cmd test`, whatever the command, a configured `commands.test` line, or a
    `task-checks` call whose evidence shows a test group ran.
  - `project_test_runs` (`total`, `by_role`, `unavailable`) counts executions that ran an
    exact `commands.test` entry: the accurate "the whole suite ran" counter, computed for older
    runs too, so compare across versions with it.
  - `task_check_calls` (`total`, `by_selected` with `targeted`, `lane`, `widened` and
    `unavailable`, `failed`, `reasons` by code): every `task-checks` call, matched to its
    evidence (`<ledger>/checks/task-<unit>.<n>.json`): a call with `--evidence` by its file's
    basename, any other call by unit and `policy.started`; a call with missing or malformed
    evidence is `unavailable`, never a default.
  - `waits` (`checks_via_procedure`, `wait_calls`, `stopped`, `improvised`) counts the long-check
    procedure ("Long checks"): executions that reserved, started and waited, the `await-checks wait`
    calls, those that exited 5, and the improvised waits (`monitor_errors`, `sleep_blocked`,
    `harness_output_reads`); `unavailable` for a run without tool events. `unwaited` lists the
    background check starts no `await-checks wait` on their file followed, and `left_running` those
    whose last wait said still running (exit 4), each `{agent, file}`: no await-checks wait on its
    file followed to the end (the agent may still have read the result another way, after a
    completion notice). Claude Code 2.1.300 discourages waiting on background commands, so a
    run on it is worth checking here.
  - `commands` (1.6.4, `checks.commands`): check time per configured command, from every file in the ledger's
    `checks/` with a results list (task checks, integrate, verify, final fix, accept): one entry
    `{check, group, runs, total_s, median_s, project_suite}` per configured command that ran, in
    check id order; `project_suite` is true for a `commands.<group>` entry (no lane or task
    prefix). `commands_unconfigured` (`runs`, `total_s`) counts results whose command the
    manifest does not name (a focused rerun), without their text; `commands_skipped` counts
    error records, unreadable files and results without a duration. These come from the
    ledger, so they are reported for a run without tool events too.
  - `widened` (1.6.4): `{targeted_median_s, calls: [{unit, codes, s}]}`: each task-checks
    evidence selected `widened` with its reason codes and duration, and the median duration of
    the targeted ones. `autopsy.md` shows them as the "Widened task checks" table, each against
    the run's median targeted call (measured, not a cost claim).
  - `repairs` (`attempts`, `eligible`, `by_status`, from `final.repairs`) and `setup`
    (`skipped`, `no_setup_commands`, from `setup_result.setup_skipped`) are `unavailable` for
    runs before 1.6.0.
- `tokens` has run-report's token fields per bucket, `unreadable_lines` and `partial`. Each
  bucket also has `agents_with_usage`, the number of its agents whose usage could be read; a
  bucket where it is 0 is `unavailable`, never 0 tokens.

**Checks:** a check is named by its id, never by its command line. `test#1` is
`commands.test[0]` of the manifest and `<lane>.test#1` is `lane_commands.<lane>.test[0]`; a
`run-checks` call is `run-checks`. The commands stay in the manifest: a check shows no command
text, because a command may carry a secret.
- **Matching:** a Bash call counts only when a command in command position runs the check.
  The line is read as shell words and split into simple commands; a redirection such as
  `2>&1` or `&>f` is no separator, and a line whose quoting does not parse counts as no check.
  Text that only mentions a check (`echo "npm test"`, a heredoc body, `bash -c "npm test"`) never
  counts. A full-suite run is a command that exactly matches a `commands.test` entry, or
  `run-checks` with `--cmd test`.
- **`ran` versus `inferred`:** a command is `ran` when it certainly ran: no `if`, `then`, loop
  or function around it, and either every operator before it is `;`, a newline, `|` or a
  background `&`, or the whole line is pipelines joined only by `&&` and the call exited 0.
  Otherwise it is `inferred`: it may not have run (`cd DIR && check` that failed may have failed
  at the `cd`). The full-suite total counts `ran` only, and `inferred` runs are counted apart.
- **Wrappers are not counted:** a run through `bash -c` or a script is not seen, so the totals
  are lower bounds.
- **Background timing:** a backgrounded command ends at the host's completion notice for it, or
  a terminal poll result (`BashOutput` or `TaskOutput` whose first `<status>`, the task's own,
  is completed, failed or killed) or
  a stop result. That is an upper bound at the observed time (`bound`), since the command may
  have finished earlier. Without a completion notice or such a result the end and the seconds
  are `unavailable`; the agent's last event is not a bound. Text an agent reads, in a file or
  another result, never counts.
- **Heredoc and rerun rules:** `heredoc_failure` needs a failing line that is nothing but a
  heredoc file write. `check_rerun` needs both runs `ran` with the same command, and only
  reading calls between them; an `inferred` run never proves a rerun.

**Detectors** (`slowdowns` entries have a `kind`, the `agent`, `at`, `cost_s`, `cost_kind` and
`evidence`):

| Kind | Detects |
|---|---|
| `background_check` | Claude Code's notice at the start of a Bash result says the command went to the background |
| `timeout` | Claude Code's notice at the start of a Bash result says the call hit its timeout |
| `repeated_failure` | the same Bash command failed twice or more in one agent |
| `heredoc_failure` | a failing Bash command that is nothing but a heredoc file write by `cat` or `tee` (`>`, `>>` or `tee`), plus `cd` or assignments; not an inline script such as `python3 - <<EOF > out.json` |
| `edit_retry` | an Edit or Write failed as unread, changed or text not found |
| `extra_review_round` | a task's fix and re-review rounds |
| `escalation` | an agent re-run at another model tier |
| `retry` | a retried agent |
| `relaunch` | every launch but the last |
| `long_tool_call` | a tool call over 120 s that no other kind counted |
| `idle_gap` | over 60 s with no agent of the launch running |
| `check_rerun` | the same check command ran twice (both `ran`) with only read-only calls between |

**Structured evidence only:** `evidence` is `{tool, exit, marker, program}`: the tool name, the
exit code when known, the matched marker string, and the program name (in the first simple
command that is not `cd DIR`, `export ...`, a loop header or a closing keyword, the first word
that is not a `NAME=value` assignment or a prefix such as `env` or `timeout DURATION`, as a
basename; null when it still holds `=`, `@` or `:`). Markers in command output, files read or
other tools' results never count. A suggestion's `stake_s` counts time that overlapping
slowdowns of its kind share once. No command text, tool output or prompt text reaches
`autopsy.json`, `autopsy.md`, history or the chat summary; `checks` names a check id (or
`run-checks`), never the command line or the configured command.

**Unavailable data:**
- A figure that cannot be read or derived is `unavailable`, never 0.
- `detectors` maps each kind to `ok`, `partial` or `not_available`. A detector whose inputs are
  missing (no timed tool events, no labels, no timed launch) is `not_available` and adds no
  slowdown; it never reports zero. A tool-call detector is `partial` when some agent is partial
  (see `tool_s_min`): it may miss slowdowns, and the summary says so.
- A call that moved to the background with no completion notice or terminal poll result is
  still a `background_check` slowdown, with cost `unavailable`, never 0.
- `partial: true` means some agent's output is incomplete, has unreadable lines or has no usage,
  so the token totals are lower bounds (`output_tokens_min`), never complete totals.

**`inputs_fingerprint`** is a sha256 over the path, size and sha256 of every file autopsy read.
`history` runs autopsy again when it differs, when `autopsy_version` is older, or when
`autopsy.md` is missing.

**`unclean_checks`:** when acceptance reports `checks_unclean`, `suggestions` holds an
`unclean_checks` entry. It names the untracked files from the saved verify evidence by path
only, and says to commit any file a check needs and gitignore only known generated output.
Never ignore source a check needs.

**`history`:** `<python> <skill_dir>/scripts/history [--history-dir DIR] [--since YYYY-MM-DD]
[--project NAME]` compares the archived runs. It reads `index.json` and each run's
`autopsy.json` (running autopsy first where one is missing or stale), writes `history.json` and
`history.md` into the history dir, and prints a summary of at most 15 lines: a per-run table,
recurring slowdowns ranked by total time lost with the engine versions they appeared in, token
trends per task and role by engine version, suggestions ranked by total stake, and the runs
whose data is too old for a section (left out of that section's totals). There is no automatic
"regressed after its fix" flag.

Exit codes: `autopsy` ends with exit 0 on success, exit 2 on a usage error or a folder without
a `*.lanes.json` or a `wf_*` dir, and exit 3 when a path needs converting on Windows and no Git
Bash is found. `scripts/history` ends with exit 0 on success, or
exit 2 on a usage error, an unreadable history dir or `index.json`, or outputs it cannot write.

## Audit

`<python> <skill_dir>/scripts/audit <run folder> [--repo DIR] [--head REF] [--out DIR] [--json]`
reads one archived run folder (never a live path from the manifest) and writes `audit.json` and
`audit.md`, as UTF-8, into `--out` (default `<run folder>/audit/`), replacing only those two
files. It prints a summary of at most 10 lines, the last being `full report: <path of audit.md>`;
the session appends it to the hand-back report. The hand-back passes `--repo` (the manifest's
`repo.git_dir` in shadow mode, else `repo.root`) and `--head <branch>`, and always uses the default
`--out`. It reads only the run folder, plus git objects in `--repo` (read-only: no fetch, no
config or ref change). Every input path must lie inside the run folder, symlinks included. It
needs no live checkout: a repo that lacks the run's start point is not used, and every git fact is
then `unavailable` with the reason.

**What it answers:** what the run recorded, what each recorded fact rests on, and where the record
has holes. It does not change `acceptance` and is not a second verdict engine.
- **States.** Every derived value is `{value, state, sources, note?}` with a state of `present`,
  `missing`, `stale`, `conflicting`, `unavailable` or `inferred`; no others. The `gaps` list in
  `audit.json` holds every value whose state is `missing`, `stale`, `conflicting` or
  `unavailable`, and its length is the number `tool-outcomes` prints. Sources are paths relative
  to the run folder, `git:<sha>` or `transcript:<wf>/<agent label>`, each with a ledger line, a
  JSON pointer or a sha.
- **Acceptance** is three facts and one derived verdict: `run_verdict` (the result's
  `acceptance`), `gate` (check-verify's archive-mode outcome: its status, or `checker_error`),
  and `override` (the ledger `accepted` event). The verdict is `accepted`, `accepted by user`,
  `accepted (gate unavailable)`, `unverified`, `unavailable`, or the run verdict with the gate's
  outcome. `accepted (gate unavailable)` is its own value: the run said `accepted`, but
  check-verify could not judge the evidence (for example `verify_evidence_time_untrusted`), so it
  is neither `accepted` nor `unverified`. An override counts only at the delivered sha; at
  another head it is listed `stale`.
- **Evidence validity.** The audit judges evidence validity from `result.verify` against the manifest's
  configured checks, with each failed rule named: `checks_missing`, `checks_stale`,
  `checks_incomplete`, `checks_failed`, `checks_unclean`, or `integrity_not_recorded` (older
  engines, shown as a gap).
- **Code outside recorded task ranges** needs `--repo`, a known latest launch and a 40 or 64 digit
  `delivered_sha`; else it is `unavailable` with the reason. It lists the commits reachable from
  the delivered sha but not from the run's start point that no task's recorded range holds
  (integration merges and the final fix). Each is `present` when a final lens head contains it,
  `inferred` when the final re-review's head contains it (or, for engines from 1.2.1 on when no
  re-review head was recorded, when `final.head` does, differs from every lens head, and
  `final.unreviewed_fix` is absent), and `missing` otherwise, with `final.unreviewed_fix` quoted
  when it is set. When `ledger status` fails on the archived ledger, the section names that
  failure.
- **After delivery** (with `--head`): the commits between the delivered sha and the head,
  `unavailable` (no run evidence); with none, it is `present` and adds no gap, so a clean run
  audited at the delivered sha has no gap from `--head`. **Open work** lists blocked and deferred
  tasks, open and declined findings, `cannot_verify` entries and stopped lanes; when `ledger
  status` fails, `ledger_state` is `unavailable` with its error, since the ledger's blocked and
  deferred tasks are then unknown.
- **Per task,** in run order, the audit shows the requirement (plan section and brief hashes),
  placement, changes (rulings, events, escalations), commits and review (reviews, each with its
  brief and spec hashes against the run's, packages, verdicts and approval), each with its state. A launch is the union of `wf_*` dirs and
  `wf_*.json` files; its result comes only from `<run folder>/<wf>.json`.
- **Launch counts** (1.6.8): the run section compares the launches the archived ledger records
  (counted as archive-run counts them, see "Run history") with the archived ones.
  `run.launches.recorded` is `{recorded, archived, named}`; each missing launch is one
  `missing` entry in `run.launches.missing` and one evidence gap ("the ledger records this
  launch; its transcripts are not archived"), named wf ids first, then one unnamed entry per
  launch left. A launch with a `wf_<id>` dir or a `wf_<id>.json` counts as archived. When more
  are recorded than archived the summary line reads `launches: 1 archived, 2 recorded, latest
  <wf>`; equal counts add no gap and leave the line as it was. Without an archived ledger the
  recorded count is `unavailable` (one gap) and nothing is listed missing.

**check-verify `--ledger`.** The audit calls `check-verify <wf dir> <manifest> --ledger
<run folder>/<plan-name>.<run_id>.ledger` for the gate and keeps only its status, a reason from
the fixed list and its exit code. Details in "Verify evidence".

**Privacy.** `audit.md` starts with a line saying it holds local paths and recorded text and is
not meant to be shared as-is; the report is local-only. It never copies prompts, raw tool output,
diffs or doctor snapshots. Configured commands become check ids (`test#1`, `<lane>.test#1`,
`setup#<n>`, `unmatched#<n>`), never command lines. Other recorded text (rulings, notes, reasons,
findings, dispositions, warnings) is quoted as written, marked as a quote with its source, and can
hold a command the manifest never configured.

**Exit codes.** exit 0 whenever a view is written, including a folder with no launch and a repo
that lacks the start point. exit 2: a usage error (`--head` without `--repo`), a folder that is no
directory or holds no `*.lanes.json`, a refused `--out` (the run folder, inside a `*.ledger` or
`wf_*` dir or one that would be made under the run folder, holding a `*.lanes.json`, or a
default `audit/` that resolves outside the run folder), or an input outside the run folder;
nothing is written. exit 2 also when `--out` cannot be made or written (`cannot write <out>:
<error>`). exit 3: a Windows path cannot be converted. The same inputs give the same bytes. A
non-zero exit goes to `tool-outcomes --audit-exit` and never changes `acceptance`.

After `ledger accept`, run archive-run, audit and `tool-outcomes` again so the override and any
session-verify evidence reach the archive and `audit.json`; once the accepts cover every reason,
remove the marker (see "Report").

## Doctor

`<python> <skill_dir>/scripts/doctor <manifest> [--json] [--save FILE]` checks the machine and the
project before a launch, for a new run, a resume and a transient relaunch. It is read-only apart
from the `--save` file: it never changes another file, ref, config value or setting, and it never
runs `git fetch` (the upstream tip comes from `git ls-remote`, with a 15 s timeout). A hard failure
blocks the launch: tell the user what failed and its fix, and wait. Warnings never block; show them
in the dry-run table header.

Hard failures:

| Check | Fails when |
|---|---|
| `git_identity` | `git var GIT_COMMITTER_IDENT` or (from 1.6.7) `git var GIT_AUTHOR_IDENT` fails, after any `-c user.name=... -c user.email=...` pair `commit_rules` passes |
| `base_not_current` | the local `base_ref` does not contain its upstream tip (details below) |
| `python` | the manifest's `python` does not run Python 3.8 or newer, run as one path the way the run uses it (a path with spaces is fine), or it is wrapped in quotes (from 1.6.10; doctor used to split it into shell words) |
| `dirty_checkout` | git mode: the checkout has uncommitted changes or untracked, non-ignored files; its fix says to commit any file a check needs and gitignore only known generated output, and never to ignore source a check needs |
| `shadow_repo` | shadow mode: the shadow repo is missing or broken |

`base_not_current` compares the local base with the upstream tip from `git ls-remote`. Its
detail is `behind` (the base is an ancestor of the tip), `diverged` (neither contains the other)
or `unknown` (the tip is not present locally, for example in a shallow clone). All three block a
new run; on a resume (`repo.branch` already exists) a stale base has no effect and all three
are warnings. An unreachable remote is a warning; a base with no upstream is skipped. This is
the r131 case.

Warnings: `memory` (under 4 GB available, or the commit charge near its limit), `disk` (under
5 GB free on the worktree root's drive), `python_alias` (Windows: python resolves through the
WindowsApps alias), `heavy_processes` (Windows: AppXSvc over 1500 MB; elsewhere a load average
above the CPU count), `active_runs` (another run holds a launch lock on this machine),
`defender` (Windows), `concurrency`
(`CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS` unset or lower than the lanes at once),
`host_budget` (the lanes at once, lowered to that variable when it is smaller, exceed the
logical CPU count: "4 lanes at once, 2 CPUs"; expected at the lane cap on a machine with 4 or
fewer CPUs, since the cap is min(5, CPUs + 2); a project whose checks run several workers should
keep lanes x workers within the CPUs) and
`usage_limit_pause` (Claude Code may not pause the run at the usage limit; below). A read that
fails is a warning with detail `unknown`.

- **Platforms:** the checks that exist only on Windows (`python_alias`, `defender`, AppXSvc)
  are skipped as `not_applicable` on Linux and macOS. Free memory is read per platform:
  `GlobalMemoryStatusEx` on Windows, `/proc/meminfo` on Linux, `vm_stat` and `sysctl
  hw.memsize` on macOS; elsewhere it is `unknown`.
- **Defender:** `defender` reports only `covered`, `not covered` or `unknown` for the worktree
  root. Reading the exclusion list needs elevation, so without it the answer is `unknown`. It
  never prints the exclusion list and never suggests excluding `AppData\Local\Temp`.
- **Usage limit pause:** `usage_limit_pause` says whether Claude Code will pause this run at the
  usage limit (see "Usage limit"), as far as a plain script can tell. It reads the version
  from `claude --version` (on Windows also `claude.exe` and `claude.cmd` on PATH): below
  2.1.271 means no pause, no executable or no version means unknown. It reads
  `autoContinueAtUsageLimit` from the managed settings file (macOS `/Library/Application
  Support/ClaudeCode/managed-settings.json`, Windows `C:\Program Files\ClaudeCode\managed-settings.json`,
  elsewhere `/etc/claude-code/managed-settings.json`) and the user settings
  (`${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json`); a managed value wins, an explicit `false`
  means no pause, and unset means on (the documented default). A file that cannot be read, or a
  value that is not true or false, counts as unset, with a reason. The session type (Remote
  Control, background, headless) is not visible to doctor, so the session supplies it in the
  confirmation header. It is a warning only, never a stop: it passes only when the pause is
  `yes` with no reason. Its finding is also in the result as `usage_limit_pause: {"pause":
  "yes"|"no"|"unknown", "reasons": [...], "version": "x.y.z"|null, "setting": true|false|null}`.

Exit 0: no hard failure. Exit 3: at least one hard failure. Exit 2: doctor itself could not run
(a usage error or an unreadable manifest); it stops the flow like exit 3, since no check ran.
`--json` prints `{"status": "ok" | "blocked", "failures": [...],
"warnings": [...], "skipped": [...], "checks": [...], "observed_at": ..., "doctor_version": ...,
"run_id": ..., "usage_limit_pause": {...}}`.
- **`checks`:** one entry `{"check", "outcome"}` for each of the fourteen checks, in run order,
  with outcome `passed`, `warning`, `failed` or `skipped`. A check that recorded nothing
  is `skipped` and also appears in `skipped` with reason `not_recorded`; a check recorded more
  than once keeps its worst outcome (failed, warning, skipped, passed).
- **`observed_at`** is the UTC time of the run, `YYYY-MM-DDTHH:MM:SSZ`. **`doctor_version`** is
  the skill's `VERSION` (`unavailable` when it cannot be read). **`run_id`** is the manifest's
  `run_id`, or null.
- **`--save FILE`** writes that JSON (indent 2, trailing newline) to FILE through a temp file
  and a rename, whatever the checks found. It never blocks: the exit code is the checks'. It does
  not write when FILE is inside the project (`repo.root`, symlinks resolved) or when the write
  fails; either way it prints `doctor: result not saved: <why>` to stderr. `--save` without a
  value is a usage error (exit 2). The `--save` file is the only file doctor writes. The session
  passes a path outside the project (the scratchpad, else `<run_dir>`), in the form its shell
  gives; doctor converts a Git Bash `/c/...` path on Windows like the manifest path.

## Launch conditions

Doctor's saved result, the conditions observed before launch, is bound to each launch and shown
by `autopsy`. Everything here is worded as observed before launch: a condition may not have
lasted through the run, and a warning beside a slowdown is a possible contributor, never a
cause.

**Saving.** Confirmation runs doctor with `--save` (see "Doctor"). Launch step 4 then runs
`<python> <skill_dir>/scripts/ledger conditions <ledger_dir> <wf id> <saved file>` once the real
launch's Workflow call has printed its transcript directory. The wf id is that launch's, never
the dry run's: a dry run prints a transcript directory with a wf id of its own, and binding it
would leave the real launch with no conditions (its snapshot would show as an orphan).
The snapshot holds every check, `usage_limit_pause` included (its outcome in `checks`, and the
result's `usage_limit_pause` object), so a later look at a usage-limit stop can see whether
the launch was set to pause. `autopsy` shows `usage_limit_pause` with its outcome only, and it
has no related slowdown kind (below).

**`ledger conditions`.** It writes `<ledger_dir>/doctor-<wf id>.json`:
`{"launch": {"wf", "setup_event", "setup_head"}, "recorded_at", "doctor": <the saved result>}`.
`setup_event` is the number of setup events in the ledger (events with task `_run`, event
`run_started`, phase `setup`) and `setup_head` the head of the last one, since every launch
follows exactly one setup. It appends no ledger event, so `ledger status`, backfill and resume
are untouched, and it never creates the ledger dir. Exit 2: a wrong argument count, a wf id
that does not match `^wf_[a-z0-9-]{6,64}$`, or a saved file that is not a readable JSON object.
Exit 3: a malformed ledger, or a refusal. A refusal writes nothing and prints
`{"refused": "<code>"}` on stdout and one line naming the code on stderr. Binding the same
launch again with the same content is a no-op (exit 0). The codes, in the order they are
checked:

| Code | Refused when |
|---|---|
| `wf_recorded` | a snapshot for this wf id exists and differs |
| `not_doctor` | the saved file has no `status`, or no valid `observed_at` |
| `no_setup` | the ledger has no setup event |
| `setup_recorded` | another snapshot already names the same `setup_event` |
| `observation_reused` | another snapshot has the same `observed_at`: run doctor again |

Success prints `{"recorded": "doctor-<wf id>.json", "setup_event": N}`. A refusal or an error
never stops or relaunches the run. The session keeps the latest launch's refusal code for
`tool-outcomes --conditions-refused`; a refusal for an earlier launch is dropped, and `autopsy`
reports it as unavailable.

**Transient relaunch.** Doctor runs again, with `--save`, before the stopped launch's end is
recorded, because the earlier snapshot belongs to the earlier launch. Exit 0 (warnings
included): record only the spend, then relaunch as before (setup, the Workflow call, `ledger
conditions` for the new launch). Exit 2 or 3: the stop is real. Record the spend and release
the lock with status `stopped` in one command line, show the failures and their fixes, notify,
and keep the failed check names for `tool-outcomes --relaunch-blocked`.
- What this adds: in git mode `repo.root` is the feature checkout, and setup already refuses it
  with uncommitted changes; on a resume `base_not_current` is only a warning. So in the default
  git configuration the new stops are `git_identity` and `python` (shadow mode: those and
  `shadow_repo`; `dirty_checkout` is skipped there). A relaunch would fail on each anyway.
- One exception, accepted: with `status.showUntrackedFiles=no`, setup's plain `git status
  --porcelain` ignores untracked files but doctor does not. A relaunch with untracked,
  non-ignored files left by the run's own checks now stops at doctor. That run would end
  `unverified` (`checks_unclean`) anyway, so stopping earlier is the better outcome.

**What `autopsy` shows.** A snapshot belongs to the launch named in its file name
`doctor-<wf>.json`; only names with `<wf>` matching `^wf_[A-Za-z0-9_-]{1,64}$` count, and other
files are ignored. Each launch in `launch_conditions` has a state:
- `unavailable`: no snapshot names it (an older run, or a refused or forgotten `ledger
  conditions`). Reason "launch conditions unavailable".
- `inconsistent`: a snapshot names it but cannot be trusted for it; nothing from it is shown as
  a condition. The reason is the first that applies: "snapshot unreadable"; "file name and
  content name different launches"; "another snapshot names the same setup" (both are
  inconsistent); "doctor result is for another run"; "launch time unavailable"; "observed after
  the launch started"; "observed before the previous launch ended" (every flow runs doctor after
  the previous launch returned).
- `recorded`: otherwise. `before_start_s` is the launch's start minus the observation time.

A snapshot whose wf is not one of the archived launches (a dry run's wf bound by mistake) goes
in `orphan_snapshots`, sorted, and is not shown as a condition.

**Entry fields.** `{wf, state, reason, observed_at, before_start_s, doctor_version, status,
checks, possible_contributors}`. When the state is not `recorded`, `checks` and
`possible_contributors` are `[]` and the other values null. Values copied from a snapshot are
validated: a check entry needs a `check` matching `^[a-z_]{1,32}$` and one of the four outcomes
or it is dropped; `status` must be `ok` or `blocked`; `doctor_version` must look like `1.5.1` or
be `unavailable`; otherwise null. Each check is `{check, outcome, detail, read}`, from the
snapshot's `checks` (else its failures, warnings and skipped entries, never a `passed` one); if
the two disagree, the worst outcome wins.
- **`read`** is false only for a `warning` with detail `unknown` from `memory`, `disk`,
  `heavy_processes`, `active_runs` or `defender`, where doctor uses `unknown` for "could not be
  read". Such a check is shown as "could not be read", is never a possible contributor, and is
  not counted as a warning. `base_not_current`'s `unknown` is a real condition and stays `read`.
- **Derived details.** `detail` is never copied as doctor wrote it; it is derived per check from
  a fixed pattern, and null when nothing matches. `unknown` is kept. A skipped check keeps its
  reason code (lowercase letters and `_`). `memory`, `heavy_processes` and `concurrency` keep
  their text when it holds only letters, digits, spaces and `. , ; ( ) % ' _ -`. `disk` keeps
  only `<N> GB free`. `defender` keeps only `covered` or `not covered`. Every other check,
  `base_not_current` included (its detail can name a remote), has outcome only.
- **Possible contributors.** A check with outcome `warning` or `failed` that was read is a
  possible contributor when a slowdown of a related kind starts inside the launch (between its
  start and end; a slowdown with no start is not counted). The related kinds are one constant,
  `RELATED_SLOWDOWNS`, a first guess for 1.6.0 to tune:

  | Check | Related slowdown kinds |
  |---|---|
  | `memory`, `heavy_processes`, `defender`, `active_runs` | `long_tool_call`, `timeout`, `background_check` |
  | `disk`, `python_alias` | `repeated_failure` |

  Every other check has none, `concurrency` included: no slowdown kind measures lanes waiting
  for an agent slot. Each entry is `{check, slowdowns: {<kind>: <count>}}`, zero counts left
  out; the number of possible contributors counts entries over all launches.

**`autopsy.md`.** The "Launch conditions" section follows "Where time went". Its first line is
"Observed before each launch. A condition may not have lasted through the run, and a warning
beside a slowdown is a possible contributor, not a cause." A recorded launch gets "Observed
before launch <wf> (<N> min before its start), doctor <version>: <status>", one line for each
warned or failed check that was read, "<check>: could not be read" for each that was not, a
"Skipped:" line, and "Possible contributors: ..." or "none". Other launches get "<wf>: <reason>"
and each orphan "Snapshot for a launch not in this archive: <wf>". The chat summary adds
`launch conditions: <n> check(s) warned or failed before launch[, <k> could not be read]; <m>
possible contributor(s)` only when a recorded launch has a warned, failed or unread check.

## Cleanup

`<python> <skill_dir>/scripts/cleanup <manifest> [--yes] [--json] [--history-dir DIR]` tidies a
finished, archived run after the user confirms the result. Without `--yes` it prints the plan
and changes nothing; show the plan, and run it with `--yes` only on the user's yes.

- **It refuses (exit 3, nothing changed)** unless the run is archived (its key is in
  `index.json` and its folder exists) and has no active-run marker, since a marker means the run
  can still resume.
- **Ownership rule:** it removes only `<worktree_root>/lane-<id>` for each manifest lane (and
  `<worktree_root>/feature` in shadow mode), each a worktree of the same repository on its
  expected branch (`pl-<run_id>-<id>`, or `repo.branch`), plus those branches, and (1.6.8) the
  start check's worktree `<worktree_root>/start` when `git worktree list --porcelain` shows it
  detached, of this repository, at the run's start sha (`start_points.prelude`, else the head of
  the first setup `run_started` in the ledger). Anything else
  under `worktree_root` (the start path on another sha or on a branch included) is left and listed as `not owned by this run`. A worktree with
  uncommitted files, or a locked one, is kept and named. Untracked files count as uncommitted
  even when the Git configuration hides them (`status.showUntrackedFiles`): cleanup reads the
  status with `--untracked-files=all`. But ignored files do not keep a worktree, and `git
  worktree remove` deletes them with it (build output, `node_modules`, an ignored `.env` or
  local config): copy any ignored file you still need out of the worktree before `--yes`. The
  start worktree is the exception: it holds no commits, and a failed start check can leave files
  behind, so it is removed with `git worktree remove --force` even when it has uncommitted or
  untracked files (it is still kept when locked, and checked again right before the removal).
  The plan lists it, and `restore.md` gets `git worktree add --detach <path> <sha>` for it.
- **Locks, during `--yes`:** cleanup takes the run lock the way a resume does (`active-run
  acquire`), so no resume or second cleanup works on the run meanwhile, and in git mode the
  checkout lock of the main checkout, so no other run's setup switches it. A run lock held by
  another session, or a checkout in use by another run, refuses with exit 3 and nothing
  changed. It releases both when it ends. Without `--yes` it takes no lock.
- **Rechecks:** right before each removal cleanup checks again, from a fresh `git worktree
  list`, that the worktree is still this run's on its branch, is not locked, is at the planned
  HEAD and is still clean. If not, the worktree is kept with "changed after the plan (what
  changed); run cleanup again", and so is its branch. A lane branch is deleted only while its
  tip is still the planned one, and the feature branch the same; otherwise "moved after the
  plan; run cleanup again", or "deleted after the plan; nothing left to delete" when the
  branch no longer exists. The reason for each is that a session may have used the worktree
  between the plan and the removal.
- **Restore point,** written before anything is removed, into a new folder
  `<run folder>/cleanup/<YYYYMMDDTHHMMSSZ>[-N]/` (never reused or overwritten): `refs.json` (every
  run branch and every `refs/parallel-lanes/<run_id>/` ref with its tip), `run.bundle` (a `git
  bundle` of them, checked with `git bundle verify`, so branches come back even after garbage
  collection) and `restore.md` (the commands to bring each branch back from the bundle). If the
  bundle cannot be written or verified, nothing is removed (exit 4).
- **Order:** worktrees, then lane branches (`git branch -d` only), then the feature branch (git
  mode), then the empty `worktree_root` (`rmdir`). The feature branch goes only when the main
  checkout is clean and on it, the PR is merged, and the base fast-forwards from its upstream
  (`git merge --ff-only`); otherwise the checkout and branch stay as they are, with the reason,
  and cleanup can be run again later. Shadow mode keeps every branch and the shadow repo
  (`shadow remove` stays a separate step).
- **It never** uses `--force` (except `git worktree remove --force` for the start worktree) or
  `branch -D`, deletes a remote branch, makes a merge commit,
  resets or rebases, deletes `refs/parallel-lanes/<run_id>/abandoned/` refs, or removes the
  manifest, the ledger or the history folder.

Exit 0 when done or planned (kept items included); exit 1 when a git command the plan needs
fails (nothing changed); exit 2 on a usage error or an unreadable manifest or index; exit 3 when
refused (nothing changed); exit 4 when the restore point could not be written or verified
(nothing removed).

The manual commands below are the fallback when `scripts/cleanup` cannot be used. Integration
already removes each clean lane worktree and deletes its merged branch; the ones it could not
remove are listed in its notes. After the user confirms the result:

```bash
# git mode
git -C "<wt>" status --porcelain --untracked-files=all   # must print nothing
git -C "<root>" -c status.showUntrackedFiles=all worktree remove "<wt>"
git -C "<root>" branch -d "<branch>"       # merged branches only; never -D

# shadow mode: <root> is not a repo, so never run git -C "<root>"
git -C "<wt>" status --porcelain --untracked-files=all  # must print nothing
git -C "<worktree_root>/feature" branch -d "<branch>"   # lane branches, while feature exists
git --git-dir="<git_dir>" -c status.showUntrackedFiles=all worktree remove "<wt>"
```

`shadow writeback` exit 3, by its message: conflicts = files edited in the folder during the
run; "cannot be written" = permissions (in both nothing was written; show them and ask);
"writeback failed at" = a write failed midway; show the paths it lists as already written.

A worktree with uncommitted files stays; list it for the user. Changes setup discarded are
saved under `refs/parallel-lanes/<run_id>/abandoned/` (`setup_result.preserved`). Each entry's
`commit` holds the working copy; when something was staged, its parent `index_commit` holds the
staged version (from `git write-tree` on the worktree's index), otherwise `index_commit` is null
and the parent is the worktree's HEAD. `write-tree` on the index can fail (an unmerged index, a
held `index.lock`): `index_saved` is then false with git's message in `index_error`, the staged
version is not saved, and setup goes on with the working-copy snapshot. A held `index.lock`
then also fails the `reset --hard` that follows, as before, so setup exits 1 and the changes
stay both in the worktree and in the saved ref. Restore one with `git -C <wt> checkout <commit>
-- .` (the files), then `git -C <wt> read-tree <index_commit>` (what was staged; `git -C <wt>
read-tree HEAD` when `index_commit` is null: nothing was staged, or, with `index_saved` false,
the staged version could not be saved); intent-to-add files come back untracked. Once the user no longer needs it, delete it
with `git -C <root> update-ref -d <ref>`. In shadow mode remove the lane
worktrees first, then `<worktree_root>/feature` with the same status check and
`git --git-dir="<git_dir>" -c status.showUntrackedFiles=all worktree remove`, then run `shadow remove` (it deletes the shadow
repo with its remaining branches). Remove `worktree_root` if it is empty (`rmdir`).

## Uninstall

`bash install.sh --uninstall` backs up `~/.claude/settings.json`, then removes the two hooks from
it, the agent file, and the skill directory. Both uninstall and the update path first check that
an existing `settings.json` holds exactly one JSON object (an empty file, two documents, or an
array is refused, as is invalid JSON): otherwise they stop with `<file> is not a single JSON
object (or not valid JSON); fix it and rerun` and change nothing. When the edit itself fails
anyway, uninstall stops with `could not edit <file>; nothing removed`, deletes its temporary
file, and removes neither the agent file nor the skill directory: fix the file and run it
again. On uninstall, the `.bak` backup written before the edit stays.
