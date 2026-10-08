# parallel-lanes: adopting earlier work

Read this only when resuming a plan whose earlier work has no manifest (a hand-run attempt). <skill_dir> is the directory holding SKILL.md.

## Adopting earlier work

For a resume without a manifest or ledger, or with lane branches named differently from
`pl-<run_id>-<lane>` (e.g. a hand-run attempt with `ri-lane-a`):

1. Build a manifest (SKILL.md "Building the manifest") with a new `run_id`. Use the feature
   branch that already holds the prelude commits as `repo.branch`. If a ledger already
   exists for this work, point `ledger_dir` at it.
2. Map each existing commit to a plan task: compare commit subjects with the commit
   messages and titles the plan gives (`git log --oneline <feature branch>..<lane branch>`
   per lane). Show the mapping; the user confirms it.
3. Seed the ledger with `committed` events only (never `reviewed` for work no reviewer
   approved), each with the task's range: `base` = the commit the task started from (the
   previous task's last commit, or the branch point), `head` = its last commit, and `commits`
   = `git -C <root> rev-list --reverse <base>..<head>` exactly:
   `python3 <skill_dir>/scripts/ledger append <ledger_dir> <lane> '{"task":"T1","event":"committed","base":"<base>","head":"<head>","commits":[<those shas>]}'`
   where `<lane>` is `prelude`, the lane id, or `join`. `ledger backfill` (Resume step 3)
   checks every range against git and refuses one that does not match.
4. For each lane with earlier commits: `git -C <root> branch pl-<run_id>-<lane> <old branch>`.
   Lanes without earlier commits get their branch from setup.
5. Use a fresh `worktree_root`: the old worktrees hold the old branches. Leave the old
   branches and worktrees untouched; offer to remove them at cleanup.
6. Continue with SKILL.md Resume step 2.

## Worked example: acme remote ingest (resume of a hand-run attempt)

Plan `/home/noderaven/acme-planning/2026-10-02-acme-remote-ingest.md`, repo
`/home/noderaven/acme` (git, feature branch `remote-ingest`, base `main`). An earlier
hand-run attempt committed T0 on `remote-ingest` and T1, T13a, T14a on branches
`ri-lane-a`, `ri-lane-b`, `ri-lane-c` (worktrees `/home/noderaven/acme-wt/lane-a..e`).

Facts: `derive-lanes` finds 18 file groups, no `cross_group_deps` (the plan states deps in
prose and in its "Lanes and order" section), and bridges `acme/db/store.py`,
`acme/api/schemas.py`, `acme/api/app.py`, `tests/test_architecture.py` (splitting
[T13a, T13b] from [T14a, T14b, T14c]), and `frontend/src/App.tsx`.

Decisions:
- Prelude: T0 (shared upload caps; its group-mate T9 goes to lane A).
- Lane A backend: T1-T12, merged along deps (T2 needs T1's table, T6 needs T2 and T5, T11
  needs T6, T9, T10). The store/schemas/app bridges stay inside lane A.
- Lane B vault: T13a, T13b, T13c (T13c uses T13a/T13b's module).
- Lane C push: T14a, T14b, T14c, T15 (T15 uses T14a and T14c).
- `tests/test_architecture.py`: an accepted merge. T13a and T14a each add one entry to the
  `CORE_MODULES` list; `git merge-tree --write-tree 1991323 28a0aa0` exits 0. The file is
  listed under T13a only.
- Lane D frontend: T17-T20, building against the plan's HTTP and type contracts with msw
  mocks (contract deps on lane A, so separate lane plus a contract check).
- Lane E deploy: T21, T22 (T22 documents T21).
- Join: T16 (live push test needs lanes A and C), T23 (docs of finished behavior).
- `hooks.e2e`: plan Task T24 (commits nothing). `hooks.post_integrate`: check
  `frontend/src/api/types.ts` and `client.ts`, `acme push`'s request, and `.env.example`
  against the plan's Shared contracts and the merged backend, then run all suites.
- Left out: T25 (after merge), T26 (operator).
- Tiers: T22 and T23 light (docs only); T21 standard (adds a parsing test). Security: T2,
  T5, T6, T7, T10, T11, T12, T13a, T13b, T13c, T14a, T14c, T16.
- `nproc` is 2, so `max_parallel_lanes` = min(5, 4) = 4: lane E queues.

Adoption: run_id `ri1`; ledger seeded with `committed` events (T0 in `prelude`, T1 in `a`,
T13a in `b`, T14a in `c`); branches `pl-ri1-a`, `pl-ri1-b`, `pl-ri1-c` created at the
`ri-lane-*` heads; `worktree_root` `/home/noderaven/acme-wt-ri1`. `ledger status` gives
done [T0, T1, T13a, T14a], reviewed []. Backfill: T0 `1cc1528..3ac174e`, T1
`3ac174e..ddd07f9`, T13a `3ac174e..1991323`, T14a `3ac174e..28a0aa0`.

Manifest excerpt:

```json
{
  "version": 1,
  "run_id": "ri1",
  "plan": "/home/noderaven/acme-planning/2026-10-02-acme-remote-ingest.md",
  "spec": "/home/noderaven/acme-planning/2026-10-02-acme-remote-ingest-design.md",
  "commit_rules": "Plain ASCII only. One commit per task with the message the plan gives. No trailers of any kind. Never mention AI tools or assistants in commits, code, or comments.",
  "repo": {
    "mode": "git", "root": "/home/noderaven/acme", "git_dir": null,
    "base_ref": "main", "branch": "remote-ingest",
    "worktree_root": "/home/noderaven/acme-wt-ri1",
    "ledger_dir": "/home/noderaven/acme-planning/2026-10-02-acme-remote-ingest.ri1.ledger"
  },
  "commands": {
    "setup": ["uv sync", "npm --prefix frontend ci"],
    "test": ["uv run pytest -q", "npm --prefix frontend test"],
    "lint": ["npm --prefix frontend run lint"],
    "build": ["npm --prefix frontend run build"]
  },
  "lane_commands": {
    "a": {"setup": ["uv sync"], "test": ["uv run pytest -q"], "lint": [], "build": []},
    "d": {"setup": ["npm --prefix frontend ci"], "test": ["npm --prefix frontend test"],
          "lint": ["npm --prefix frontend run lint"], "build": ["npm --prefix frontend run build"]}
  },
  "prelude": [
    {"id": "T0", "title": "Shared upload caps and public expand_paths",
     "files": ["acme/ingest.py", "tests/test_ingest.py"], "tier": "standard", "security": false}
  ],
  "lanes": [
    {"id": "b", "name": "Lane B vault", "tasks": [
      {"id": "T13a", "title": "Untrusted SQLite open (Section 3 steps 1-5)",
       "files": ["acme/parsers/_sqlite_safe.py", "tests/test_sqlite_safe.py", "tests/test_architecture.py"],
       "tier": "standard", "security": true}
    ]},
    {"id": "c", "name": "Lane C push", "tasks": [
      {"id": "T14a", "title": "Push settings (Section 4 Settings)",
       "files": ["acme/push.py", "tests/test_push.py"], "tier": "standard", "security": true}
    ]}
  ],
  "join": [
    {"id": "T23", "title": "README and DESIGN", "files": ["README.md", "DESIGN.md"],
     "tier": "light", "security": false}
  ],
  "hooks": {"post_integrate": "Contract check: ...", "e2e": "Follow plan Task T24: ..."},
  "limits": {"review_rounds": 5, "max_parallel_lanes": 4},
  "dry_run": false,
  "done": ["T0", "T1", "T13a", "T14a"],
  "reviewed": [],
  "backfill": {
    "T0": {"base": "1cc1528", "head": "3ac174e"},
    "T1": {"base": "3ac174e", "head": "ddd07f9"},
    "T13a": {"base": "3ac174e", "head": "1991323"},
    "T14a": {"base": "3ac174e", "head": "28a0aa0"}
  },
  "sp_dir": "<find-superpowers output>",
  "skill_dir": "/home/noderaven/.claude/skills/parallel-lanes"
}
```

(The excerpt omits most tasks and the `b`, `c`, `e` entries of `lane_commands`, which match
`a`.) The full manifest's dry run returns no errors, 66 agents, 5 lanes, `lanes_effective`
4: pre-flight 1, backfill reviews 4 (T0, T1, T13a, T14a), implement + review 2 each for the
other 23 lane tasks (46) and the 2 join tasks (4), integrate 1, post-integrate 1, e2e 1,
final reviews 5 (three lenses, fix, re-review; the last two are an upper bound), verify 3
(the checks at the delivered revision, and the e2e and post-integrate rechecks, an upper
bound). Confirmation table rows, abridged:

| Lane | Task | Tier | Security | Agents |
|---|---|---|---|---|
| prelude | T0 | standard | no | 1 (backfill review) |
| a | T1 | standard | no | 1 (backfill review) |
| a | T2 | standard | yes | 2 |
| ... | ... | ... | ... | ... |
| e | T22 | light | no | 2 |
| join | T16 | standard | yes | 2 |
| join | T23 | light | no | 2 |
| run | pre-flight, integrate, post-integrate, e2e, final x5, verify x3 | standard | - | 12 |
| | | | Total | 66 |

each task can add up to 2x review_rounds more agents (fix and re-review rounds)

The resume notice for this launch: `parallel-lanes: resuming run ri1: 4 tasks already
committed`.
