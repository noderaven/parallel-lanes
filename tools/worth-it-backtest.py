#!/usr/bin/env python3
"""The back-test behind scripts/worth-it's THRESHOLD (1.6.4).

usage: python3 -B tools/worth-it-backtest.py HISTORY_COPY_DIR [mean|median] [--waves]

Reads a COPY of a history dir (index.json and the run folders, each with its
autopsy.json and *.lanes.json); it refuses the live history dir
(_history.history_dir(): PL_HISTORY_DIR, else the config dir's), exit 2. It
writes nothing and prints tables, not a verdict:

- per run, for the latest launch that ran task agents
  (_history.latest_task_launch): N tasks run, L lanes, the task-slots S of
  the manifest's layout limited to those tasks (worth-it's slots, with the
  manifest's max_parallel_lanes), the actual wall time, the in-sample error
  of F + S x T (T = the mean, or median, of the tasks' summed agent time; F
  and R = _history.run_figures' fixed_s and final_review_s), and the
  out-of-sample error from the means of earlier complete runs (the same
  project first, else all);
- the in-sample and out-of-sample error summaries;
- the quartiles of (F - R) / T, the fixed phases a run adds beyond the final
  review a direct build also ends with, in task-times;
- for thresholds 1 and 2, how often the rule (direct when N - S is at most
  the threshold) agrees with each run's own comparison (direct = N x T + R
  against the actual wall, a model, not a measured direct build).
With --waves (1.6.5) the join of a manifest with two lanes or more counts
its waves (_waves, from depends_on and the declared files) as worth-it
--join-deps does: what 1.6.5 would schedule. Archived runs ran their join
serially, so their actual walls and the in-sample errors still describe the
serial join; --waves shows how the rule's verdicts move.
Exit 0, or 2 on a usage error or the live history dir.
"""
import glob
import importlib.machinery
import importlib.util
import json
import os
import statistics
import sys

sys.dont_write_bytecode = True
SCRIPTS = os.path.join(os.path.dirname(os.path.dirname(os.path.realpath(__file__))), "scripts")
sys.path.insert(0, SCRIPTS)
import _history  # noqa: E402
import _waves  # noqa: E402

_loader = importlib.machinery.SourceFileLoader("_worth_it", os.path.join(SCRIPTS, "worth-it"))
_spec = importlib.util.spec_from_loader("_worth_it", _loader)
W = importlib.util.module_from_spec(_spec)
_loader.exec_module(W)

USAGE = "usage: worth-it-backtest.py HISTORY_COPY_DIR [mean|median] [--waves]"


def _read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def load_runs(hdir, aggregate, waves=False):
    runs = []
    for entry in _history.read_index(hdir)["runs"]:
        folder = _history.run_folder(hdir, entry)
        manifests = sorted(glob.glob(os.path.join(glob.escape(folder), "*.lanes.json"))) if folder else []
        if not manifests:
            continue
        try:
            analysis = _read_json(os.path.join(folder, "autopsy.json"))
            manifest = _read_json(manifests[0])
        except (OSError, ValueError):
            continue
        found = _history.latest_task_launch(analysis, manifest)
        figures = _history.run_figures(analysis, manifest)
        if found is None or figures is None:
            continue
        ran = found[1]
        ids = lambda tasks: [t.get("id") for t in tasks or [] if isinstance(t, dict) and t.get("id") in ran]  # noqa: E731
        lanes = [ids(lane.get("tasks")) for lane in manifest.get("lanes") or [] if isinstance(lane, dict)]
        lanes = [lane for lane in lanes if lane]
        cap = (manifest.get("limits") or {}).get("max_parallel_lanes") or len(lanes) or 1
        at_once = max(1, min(len(lanes), cap))
        prelude, join = ids(manifest.get("prelude")), ids(manifest.get("join"))
        sizes = None
        if waves and len(lanes) >= 2 and join:
            ran_join = [t for t in manifest.get("join") or [] if isinstance(t, dict) and t.get("id") in ran]
            sizes = [len(w) for w in _waves.waves(_waves.join_units(ran_join))]
        project = (entry.get("project") or "?").replace("\\", "/").rstrip("/").rsplit("/", 1)[-1]
        runs.append({
            "run": entry.get("run_id"), "project": project, "status": entry.get("status"),
            "date": entry.get("first_launch") or entry.get("folder") or "",
            "N": len(ran), "lanes": len(lanes),
            "slots": W.slots(len(prelude), [len(x) for x in lanes], len(join), at_once, sizes),
            "wall": figures["wall_s"], "F": figures["fixed_s"], "R": figures["final_review_s"],
            "T": aggregate(ran.values()),
        })
    runs.sort(key=lambda r: r["date"])
    return runs


def summary(errors):
    if not errors:
        return "n=0"
    return "n=%d median %+.0f%% range %+.0f%%..%+.0f%%" % (
        len(errors), 100 * statistics.median(errors), 100 * min(errors), 100 * max(errors))


def report(runs, label):
    print("aggregate: %s; runs with data: %d" % (label, len(runs)))
    print("%-10s %-20s %3s %2s %5s %8s | %9s %5s | %8s %5s %8s %s" % (
        "run", "project", "N", "ln", "slots", "actual", "in-sample", "err", "oos", "err", "direct", "source"))
    in_sample, out_sample = [], []
    for i, r in enumerate(runs):
        estimate = r["F"] + r["slots"] * r["T"]
        in_sample.append(estimate / r["wall"] - 1)
        line = "%-10s %-20s N %2d %2d slots %2d %8.1f | %9.1f %+4.0f%% |" % (
            r["run"], r["project"][:20], r["N"], r["lanes"], r["slots"], r["wall"] / 60, estimate / 60,
            100 * in_sample[-1])
        prior = [p for p in runs[:i] if p["status"] == "complete"]
        same = [p for p in prior if p["project"] == r["project"]]
        base, source = (same, "project") if same else (prior, "history")
        if base:
            t = statistics.mean(p["T"] for p in base)
            f = statistics.mean(p["F"] for p in base)
            fr = statistics.mean(p["R"] for p in base)
            oos = f + r["slots"] * t
            out_sample.append(oos / r["wall"] - 1)
            line += " %8.1f %+4.0f%% %8.1f %s(%d)" % (oos / 60, 100 * out_sample[-1], (r["N"] * t + fr) / 60, source,
                                                    len(base))
        else:
            line += "   (no earlier run)"
        print(line)
    print("in-sample:", summary(in_sample))
    print("out-of-sample:", summary(out_sample))
    ratios = sorted((r["F"] - r["R"]) / r["T"] for r in runs if r["T"] > 0)
    if ratios:
        q = (ratios[len(ratios) // 4], statistics.median(ratios), ratios[3 * len(ratios) // 4])
        print("(F - R) / T quartiles %.2f %.2f %.2f range %.2f %.2f" % (q + (ratios[0], ratios[-1])))
    for threshold in (1, 2):
        agree, direct = 0, []
        for r in runs:
            rule = "direct" if r["N"] - r["slots"] <= threshold else "parallel"
            own = "direct" if r["N"] * r["T"] + r["R"] <= r["wall"] else "parallel"
            agree += rule == own
            if rule == "direct":
                direct.append(r["run"])
        print("threshold %d: the rule agrees with each run's own comparison on %d of %d runs; direct for %s" % (
            threshold, agree, len(runs), ", ".join(direct) or "none"))


def main(argv):
    waves = "--waves" in argv
    argv = [a for a in argv if a != "--waves"]
    if not argv or len(argv) > 2 or (len(argv) == 2 and argv[1] not in ("mean", "median")):
        print(USAGE, file=sys.stderr)
        return 2
    hdir = os.path.abspath(argv[0])
    live = _history.history_dir()
    if os.path.normcase(os.path.realpath(hdir)) == os.path.normcase(os.path.realpath(live)):
        print("worth-it-backtest: %s is the live history dir; copy the history first" % live, file=sys.stderr)
        return 2
    label = argv[1] if len(argv) == 2 else "mean"
    try:
        runs = load_runs(hdir, statistics.mean if label == "mean" else statistics.median, waves)
    except _history.HistoryError as e:
        print("worth-it-backtest: " + str(e), file=sys.stderr)
        return 2
    report(runs, label)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
