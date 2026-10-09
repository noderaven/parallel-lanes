# parallel-lanes for Claude Code

[![tests](https://github.com/noderaven/parallel-lanes/actions/workflows/tests.yml/badge.svg?branch=main)](https://github.com/noderaven/parallel-lanes/actions/workflows/tests.yml?query=branch%3Amain)

A Claude Code skill that runs an approved implementation plan as **parallel lanes** of
tasks. Each lane gets its own git worktree, and every task gets an implementer agent and a
reviewer agent. When the lanes finish, it merges them, runs the project's
test/lint/build commands, runs an optional end-to-end check, and finishes with a final
review. It's built to pair with the [Superpowers](https://github.com/obra/superpowers)
plugin: Superpowers handles brainstorming, specs, and plans, and parallel-lanes takes over
when it's time to execute the plan.

---

## 1. Prerequisites

| Requirement | Why | Check |
|---|---|---|
| **Claude Code** with the **Workflow** tool (multi-agent workflows) | Runs the orchestrator `run.workflow.js` | In a Claude Code session, ask: "Do you have the Workflow tool?" |
| **bash** (Git Bash on Windows) | Installer, hooks, helper scripts | `bash --version` |
| **git** 2.31 or later (2.38 or later recommended) | Worktrees, branches, merges | `git --version` |
| **jq** 1.6 or later | Installer and SessionStart hook | `jq --version` |
| **Python** 3.8 or later, as `python3`, `python`, or `py -3` | Lane planning, setup, ledger, reports | `bash scripts/find-python` in the clone prints the one it uses |
| *Optional:* **node** 18 or later | Only for running the test suite | `node --version` |
| *Recommended:* **Superpowers** plugin (tested with 6.4.2) | Supplies the per-task implementer and reviewer prompts | See step 3 |

Platforms: macOS and Linux. CI runs the test suite on both, with the stock bash 3.2 on
macOS, so no newer bash is needed. On Windows 11, Claude Code installed natively works with
Git for Windows (preliminary support; see [Windows](#windows-preliminary) below), and
Claude Code inside **WSL** works as on Linux.

Without the Workflow tool, the skill steps aside and recommends a normal Superpowers
execution mode instead. Without Superpowers, it still runs, but agents use simpler
built-in prompts.

### Installing missing tools

macOS (Homebrew):

```bash
brew install git jq python node
```

Debian or Ubuntu:

```bash
sudo apt update && sudo apt install -y git jq python3 nodejs
```

Fedora:

```bash
sudo dnf install -y git jq python3 nodejs
```

### Windows (preliminary)

Native Windows 11 support is new and **preliminary**: a Windows CI job runs the test suite,
but complete runs on a real Windows machine are still being verified. If you hit a problem, WSL is the
proven route: install Claude Code inside WSL and follow the Linux steps.

- **Git for Windows is required.** With it installed, Claude Code runs its Bash tool and
  hooks in Git Bash, and the skill's scripts run there too. Without it Claude Code falls back
  to PowerShell, and PowerShell-only setups are not supported.
- **Install the tools** from PowerShell or a Command Prompt, then open a new Git Bash
  window so PATH picks them up:

  ```
  winget install Git.Git
  winget install jqlang.jq
  winget install Python.Python.3.12
  winget install OpenJS.NodeJS.LTS
  ```

  Node is optional (tests only). Any Python 3.8 or later works: the skill looks for
  `python3`, then `python`, then `py -3`, and skips the Microsoft Store `python3` stub.
- **Git in another place:** the skill finds Git Bash on PATH or under `C:\Program Files\Git`.
  If Git is installed somewhere else, set the Windows environment variable
  `CLAUDE_CODE_GIT_BASH_PATH` to its `bash.exe` (for example `D:\Tools\Git\bin\bash.exe`);
  Claude Code reads the same variable. The skill never uses the WSL `bash.exe` in
  `C:\Windows\System32`.
- **Long paths:** worktree paths can pass Windows' 260-character limit. Turn on Git's long
  path support once:

  ```bash
  git config --global core.longpaths true
  ```

  The skill does not change your git config for you.
- **Run the installer from Git Bash** (`bash install.sh`, section 2). `~/.claude` is
  `%USERPROFILE%\.claude`. The repo's `.gitattributes` keeps every file's line endings LF
  whatever your `core.autocrlf` setting, so a fresh clone works as is.
- **Shadow mode and symlinks:** without Windows Developer Mode, Git cannot create symbolic
  links, so for a non-git folder that holds symlinks prefer a git repo over shadow mode.
- Run files under `~/.claude/parallel-lanes/` are private to your user through your profile
  folder's permissions; the POSIX modes the scripts set have no effect on Windows.

---

## 2. Install the skill

1. Clone the repo:

   ```bash
   git clone https://github.com/noderaven/parallel-lanes.git
   cd parallel-lanes
   ```

2. Run the installer:

   ```bash
   bash install.sh
   ```

   On Windows, run both steps in Git Bash. The installer checks for jq, git, and a working
   Python 3.8 or later first. Then it does four things:
   - Copies the skill (without `.git`) to `~/.claude/skills/parallel-lanes`. The clone
     can be deleted afterwards, or kept for updates.
   - Installs the `parallel-lanes-worker` agent type to
     `~/.claude/agents/parallel-lanes-worker.md`. Runs use it to give each agent a smaller
     context, and fall back to the default agent type without it.
   - Backs up `~/.claude/settings.json` (to `settings.json.bak.<timestamp>`), then adds two
     hooks without touching your other settings:
     - **SessionStart**: tells each new, cleared, or compacted session that parallel-lanes
       is the default plan executor, and lists any interrupted runs so you can resume them.
     - **PostToolUse (Skill)**: shows a notice with the installed version, such as
       "parallel-lanes v1.1.0 invoked", when the skill fires.
   - Checks for Superpowers and tells you if it's missing.

   If you use a custom config directory, run it with that directory instead:
   `CLAUDE_CONFIG_DIR=/path/to/config bash install.sh`.

3. **Restart Claude Code** so the hooks load. Running `/clear` in an open session also
   works.

---

## 3. Install Superpowers (recommended)

Skip this if the installer didn't warn you about it. Inside Claude Code, run:

```
/plugin marketplace add obra/superpowers
/plugin install superpowers@superpowers-dev
```

Then restart Claude Code. parallel-lanes finds Superpowers automatically at run time. No
configuration is needed.

---

## 4. Verify

1. The files are in place:

   ```bash
   ls ~/.claude/skills/parallel-lanes/SKILL.md
   ```

2. The hooks are registered (you should see `session-start.sh` and `notice.sh`):

   ```bash
   jq '.hooks.SessionStart, .hooks.PostToolUse' ~/.claude/settings.json
   ```

3. In a new Claude Code session, ask: "Is the parallel-lanes skill available?"

4. Optional: run the test suite:

   ```bash
   cd ~/.claude/skills/parallel-lanes && node --test tests/
   ```

5. Optional: to make parallel-lanes the default even more firmly, add this paragraph to
   `~/.claude/CLAUDE.md`. The SessionStart hook already covers this, so it isn't required.

   > In the main session, when executing approved implementation plans, parallel-lanes is
   > the default and takes precedence over superpowers' execution options. Use
   > superpowers' Subagent-driven or Native only when parallel-lanes steps aside or I
   > explicitly ask for them. Agents running a single task inside a parallel-lanes run must
   > not invoke it.

---

## 5. Using it

1. Get a plan. The normal way is to describe what you want built and let Superpowers
   handle it: its brainstorming skill turns the idea into a spec, and its writing-plans
   skill turns the spec into a plan. You don't write task IDs or headings yourself;
   writing-plans numbers the tasks and lists the files each one touches.

   You only need to follow a format if you write a plan yourself or bring one from
   another tool. parallel-lanes looks for two things in each task:

   ```markdown
   ### Task 3: Add the export endpoint

   **Files:**
   - Create: `src/api/export.py`
   - Modify: `src/api/app.py`
   - Test: `tests/test_export.py`
   ```

   - A heading of the form `Task <ID>: <title>`, at the same heading level for every
     task (a deeper task heading would count as part of the task above it). The ID is a single
     token with no spaces, colons, parentheses, or brackets, such as `3`, `T3`, or `T13a`.
   - A `**Files:**` block with `Create:`, `Modify:`, or `Test:` lines naming the files in
     backticks. This is how it works out which tasks can run in parallel: tasks that
     touch the same files go in the same lane.
2. Work inside a git repo with a clean working tree; commit or stash first. For a folder
   that isn't a git repo, the skill offers a "shadow repo" that leaves your folder
   untouched until you approve copying the results back.
3. When you approve the plan and Claude reaches the "how should I execute this?" step,
   parallel-lanes fires automatically. You can also ask directly: "execute this plan with
   parallel lanes."
4. Pick **Parallel lanes**, review the dry-run table (tasks, lanes, model tiers, agent
   count, budgets), and answer **yes**. Nothing runs before that yes.
5. Watch progress with `/workflows`. When the run finishes, you get a report, and Claude
   offers to open a PR. It never pushes, opens a PR, or merges without a separate yes.

If a run stops (a budget cap, a question it can't settle, or a closed session), the next
session lists it, and you can resume with one word. Finished tasks are skipped.

### How a run works

1. **Assess.** `scripts/derive-lanes` groups the tasks into lanes (at most
   `min(5, CPU cores + 2)`), a *prelude* (shared groundwork that runs first), and a *join*
   (tasks that need the merged result). Plans with only 1-2 tasks are handed back to
   Superpowers.
2. **Manifest.** Claude writes a JSON manifest covering lanes, model tier per task
   (`standard`, `sonnet`, or `light`; security-sensitive tasks are always `standard`),
   project commands, commit rules taken from your CLAUDE.md, and budgets.
3. **Dry run and consent.** The workflow validates the manifest without spawning anything,
   and Claude shows the table. "Just run it" and auto mode do not skip it.
4. **Execute.** The run takes a launch lock (a second session cannot reset it), then
   `scripts/setup` creates the feature branch and lane worktrees, saving any changes it has
   to discard under a git ref first. The phases run: pre-flight conflict check, prelude,
   lanes in parallel, integration, join, E2E, a final review with three lenses and one fix
   round, and a verify step that reruns the project checks (and any stale E2E or
   post-integration check) on the exact revision delivered.
5. **Hand-back.** The report leads with acceptance: `accepted` only when every check passed
   on the delivered revision, no blocking finding is open, and nothing was deferred;
   otherwise `rejected` or `unverified`, with every reason, and the run stays resumable. It
   also covers each task's commits, review rounds, model and token usage, rulings made on
   your behalf, and the E2E result.

Other things to know:

- **Autonomy.** In `autonomous` mode (the default), an adjudicator agent settles blocked
  tasks and review deadlocks, capped at 25 rulings per run. In `supervised` mode, those
  stop the run for you instead. You can switch modes when the table is shown. A task the
  adjudicator parks is deferred, never counted as delivered; security tasks are never
  parked, and `allow_deferral: false` forbids parking altogether.
- **Transient failures** (agent errors, missing results) relaunch once automatically.
  Anything substantive stops the run and asks you.
- **Where files go.** Manifests and ledgers are stored beside the plan, or under
  `~/.claude/parallel-lanes/runs/` (under `CLAUDE_CONFIG_DIR` when set) when the plan is
  inside the repo. Worktrees go in a
  sibling directory such as `<repo>-wt-<run_id>`. In git mode the run adds branches to
  your repo, but no run files are written inside the project folder.

---

## 6. Update or uninstall

- **Update:** in your clone, run `git pull && bash install.sh`. It replaces the
  installed skill and does not add the hooks twice.
- **Uninstall:** run `bash install.sh --uninstall`. It removes both hooks (after backing up
  settings), the agent file `~/.claude/agents/parallel-lanes-worker.md`, and
  `~/.claude/skills/parallel-lanes`. Run records in
  `~/.claude/parallel-lanes/` are kept; delete that folder by hand if you don't want them.

---

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| `install: jq is required but not installed` (or git) | Install the tool (section 1) and rerun. On Windows: `winget install jqlang.jq`, then open a new Git Bash window. |
| `find-python: no working Python 3.8 or later (tried: python3, python, py -3)` (the installer adds `install: Python 3.8 or later is required but none works`) | Install Python 3.8 or later (section 1; on Windows `winget install Python.Python.3.12`) and open a new shell. On Windows, the `python3` from the Microsoft Store is only a stub that opens the Store; install a real Python. |
| `... parallel-lanes needs Git Bash on Windows: install Git for Windows, or set CLAUDE_CODE_GIT_BASH_PATH ...` | Install Git for Windows (`winget install Git.Git`). If it is installed outside `C:\Program Files\Git`, set `CLAUDE_CODE_GIT_BASH_PATH` to its `bash.exe` and restart Claude Code. |
| `cannot convert ... to a Windows path: cygpath ...` | The Git for Windows installation is incomplete. Reinstall it, or point `CLAUDE_CODE_GIT_BASH_PATH` at the `bash.exe` of a complete one. |
| `Filename too long` from git on Windows | Run `git config --global core.longpaths true`, then ask Claude to resume the run. |
| Scripts fail with `$'\r': command not found` | The files have Windows line endings, from a copy made before 1.3.0. Clone the repo again and rerun `bash install.sh`. |
| Hook or tool errors that come from PowerShell on Windows | Claude Code did not find Git Bash. Install Git for Windows (or set `CLAUDE_CODE_GIT_BASH_PATH`) and restart Claude Code. |
| `settings.json is not valid JSON` | Fix the syntax error in `~/.claude/settings.json`, then rerun. |
| Claude says `not a fit (Workflow tool unavailable)` | Your Claude Code build lacks the Workflow tool. Update Claude Code, or use Superpowers' Subagent-driven mode. |
| `superpowers not found; agents use built-in prompts` | Install Superpowers (section 3) and restart Claude Code. |
| The skill never fires at plan execution | Restart Claude Code so the SessionStart hook loads, and check section 4, step 2. Invoking it by name also works. |
| `setup: the main checkout ... has uncommitted changes` | Commit or stash your changes, then ask Claude to run or resume the plan again. |
| `setup: run <id> has no launch lock` or `is locked by another launch` | Another session may be running that run. If it has ended, tell Claude so; it takes the lock over (`active-run acquire --takeover`) and resumes. |
| You want to undo the settings change | Restore the newest `~/.claude/settings.json.bak.*` file. |

---

## Layout

| Path | What it is |
|---|---|
| `install.sh` | Installer, updater, and uninstaller |
| `VERSION` | The skill's version, shown in the invocation notice. Bump it in each release. |
| `SKILL.md` | The skill: flow, hard rules, notices |
| `reference.md` | Manifest fields, lane building, tiers, budgets, recovery details |
| `adopt.md` | Adopting earlier work from a hand-run attempt, with a worked example |
| `run.workflow.js` | The orchestrator, built from `src/` by `scripts/build` |
| `scripts/` | derive-lanes, setup, ledger, shadow, run-report, active-run, and other helpers |
| `hooks/` | The SessionStart and notice hooks |
| `agents/` | The `parallel-lanes-worker` agent definition |
| `tests/` | `node --test tests/` |

## License

MIT. See [LICENSE](LICENSE).
