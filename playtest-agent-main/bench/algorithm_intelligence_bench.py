"""Benchmarks for Algorithm 2 (NSGA-II exploration) and Algorithm 3 (ProbDD versus the existing reducer).

Dataset (synthetic, say so in every report): pt/search_model.py, a deterministic state-machine application with five
seeded defects, and synthetic failing interaction sequences with a known minimal witness size.

  python bench/algorithm_intelligence_bench.py --out ../benchmarks/algorithm-intelligence/explore-and-reduce.json
"""

from __future__ import annotations

import argparse
import json
import random
import statistics
import time
from pathlib import Path

from pt import reduce as existing_reduce
from pt.probdd import probdd
from pt.search_model import BUG_IDS, SimApp
from pt.search_nsga2 import Spec, nsga2, novelty_hill_climb, pareto_front, random_search, summarise

EXPLORE_SEEDS = range(1, 11)
EXPLORE_BUDGET = 600
REDUCE_SCENARIOS = [(n, k, seed) for n in (40, 80, 160) for k in (3, 4) for seed in range(1, 11)]
REDUCE_BUDGET = 400


def explore_bench() -> dict:
    spec = Spec()
    strategies = {
        "nsga2": lambda s: nsga2(SimApp(), spec, budget=EXPLORE_BUDGET, pop_size=40, seed=s),
        "random": lambda s: random_search(SimApp(), spec, budget=EXPLORE_BUDGET, seed=s),
        "novelty_hill_climb": lambda s: novelty_hill_climb(SimApp(), spec, budget=EXPLORE_BUDGET, seed=s),
    }
    out = {}
    for name, run in strategies.items():
        rows = []
        t0 = time.perf_counter()
        for seed in EXPLORE_SEEDS:
            session = run(seed)
            summ = summarise(session)
            summ["pareto_front_size"] = len(pareto_front(session.archive))
            rows.append(summ)
        elapsed = time.perf_counter() - t0
        hits_per_bug = {b: sum(1 for r in rows if b in r["defects"]) for b in BUG_IDS}
        actions_to_hit = {b: [r["first_hit"][b]["actions_executed"] for r in rows if b in r["first_hit"]] for b in BUG_IDS}
        out[name] = {
            "seeds": len(rows), "budget_runs_per_seed": EXPLORE_BUDGET,
            "distinct_states_mean": round(statistics.mean(r["distinct_states"] for r in rows), 3),
            "distinct_edges_mean": round(statistics.mean(r["distinct_edges"] for r in rows), 3),
            "defects_per_seed_mean": round(statistics.mean(len(r["defects"]) for r in rows), 3),
            "defect_seed_hits": hits_per_bug,
            "actions_to_first_hit_median": {b: (statistics.median(v) if v else None) for b, v in actions_to_hit.items()},
            "actions_executed_mean": round(statistics.mean(r["actions_executed"] for r in rows), 1),
            "pareto_front_size_mean": round(statistics.mean(r["pareto_front_size"] for r in rows), 2),
            "wall_seconds_total": round(elapsed, 3),
        }
    return out


CALIBRATION_SEEDS = range(101, 111)  # used only to look at the ablation; reported results use EXPLORE_SEEDS


def _run_variant(seeds, mask):
    spec = Spec()
    rows = []
    for seed in seeds:
        s = nsga2(SimApp(), spec, budget=EXPLORE_BUDGET, pop_size=40, seed=seed, mask=mask)
        summ = summarise(s)
        rows.append(summ)
    return {"distinct_states_mean": round(statistics.mean(r["distinct_states"] for r in rows), 3),
            "distinct_edges_mean": round(statistics.mean(r["distinct_edges"] for r in rows), 3),
            "defects_per_seed_mean": round(statistics.mean(len(r["defects"]) for r in rows), 3),
            "defect_seed_hits": {b: sum(1 for r in rows if b in r["defects"]) for b in BUG_IDS}}


def ablation() -> dict:
    """Does minimising action count and cost hurt defect discovery? Calibrated on one seed set, reported on another."""
    variants = {"default_all_objectives": None,
                "without_action_and_cost_objectives": (True, True, True, True, True, False, False)}
    calibration = {k: _run_variant(CALIBRATION_SEEDS, m) for k, m in variants.items()}
    heldout = {k: _run_variant(EXPLORE_SEEDS, m) for k, m in variants.items()}
    return {"calibration_seeds": [CALIBRATION_SEEDS.start, CALIBRATION_SEEDS.stop - 1], "heldout_seeds": [EXPLORE_SEEDS.start, EXPLORE_SEEDS.stop - 1],
            "calibration": calibration, "heldout": heldout,
            "note": "Calibration seeds were used only to inspect the variant; the held-out results are reported whichever variant wins."}


def _oracle_for(seq: list[str], pattern: list[str]):
    """Failure reproduces when the sequence starts with the pinned setup step 'L' and contains the pattern in order."""
    def sub(xs):
        it = iter(xs)
        return all(any(x == p for x in it) for p in pattern)
    return lambda indices: bool(indices) and seq[indices[0]] == "L" and sub([seq[i] for i in indices])


class _FakeDriver:
    """The driver contract pt.reduce uses: execute(step) records it; bug_hits() reports hook 0."""

    def __init__(self, bugs="", oracle=None):
        self.log: list[str] = []
        self.oracle_fn = oracle
    def execute(self, acts):
        self.log.extend(acts)
    def bug_hits(self):
        return {0: bool(self.log) and self.log[0] == "L" and self.oracle_fn(self.log)}
    def close(self):
        pass


def _scenario(n: int, k: int, seed: int):
    rng = random.Random(seed * 1000 + n + k)
    pattern = ["O"] + rng.sample(list("abcdefgh"), k - 1)
    noise = [c for c in "abcdefgh" if c not in pattern]
    seq = ["L"] + [rng.choice(noise + pattern) for _ in range(n - 1)]
    slots = sorted(rng.sample(range(1, n), len(pattern)))
    for slot, sym in zip(slots, pattern):
        seq[slot] = sym
    return seq, pattern


def reduce_bench() -> dict:
    rows = []
    for n, k, seed in REDUCE_SCENARIOS:
        seq, pattern = _scenario(n, k, seed)
        oracle_seq = _oracle_for(seq, pattern)
        # ProbDD on indices
        calls = []
        def probdd_oracle(indices):
            calls.append(indices)
            return oracle_seq(indices)
        t0 = time.perf_counter()
        pd = probdd(len(seq), probdd_oracle, max_replays=REDUCE_BUDGET, seed=seed)
        pd_ms = (time.perf_counter() - t0) * 1000

        # Existing halving reducer on the same oracle, through the real pt.reduce.reduce path
        # The reducer passes per-step action lists; the fake driver replays them and evaluates the same oracle on the log.
        steps = [[s] for s in seq]
        def make_driver(bugs="", oracle=None):
            return _FakeDriver(bugs, oracle=lambda log: _sub_ok(log, pattern))
        t1 = time.perf_counter()
        rd = existing_reduce.reduce(steps, len(seq), bugs="", driver_cls=lambda bugs="": make_driver(bugs), target=[0], max_replays=REDUCE_BUDGET)
        rd_ms = (time.perf_counter() - t1) * 1000
        kept_rd = [seq[i] for i in rd["kept"]]
        # 1-minimality of the reducer's output, checked separately (not part of its replay count)
        rd_one_min = True
        for j in range(1, len(rd["kept"])):
            cand = [kept_rd[i] for i in range(len(kept_rd)) if i != j]
            if cand and cand[0] == "L" and _sub_ok(cand, pattern):
                rd_one_min = False
                break
        rows.append({
            "n": n, "pattern_len": k, "seed": seed, "minimal_witness_len": k + 1,
            "probdd": {"kept": len(pd["kept"]), "replays": pd["replays"], "one_minimal": pd["one_minimal"], "budget_hit": pd["budget_hit"],
                       "reproduces": pd["reproduces"], "wall_ms": round(pd_ms, 2)},
            "existing_reduce": {"kept": len(rd["kept"]), "replays": rd["replays"], "one_minimal": rd_one_min, "budget_hit": rd["budget_hit"],
                                "wall_ms": round(rd_ms, 2)},
        })
    def agg(key, field):
        return round(statistics.mean(r[key][field] for r in rows), 3)
    summary = {
        "probdd": {"mean_kept": agg("probdd", "kept"), "mean_replays": agg("probdd", "replays"),
                   "one_minimal_rate": round(sum(r["probdd"]["one_minimal"] for r in rows) / len(rows), 3),
                   "budget_hit_rate": round(sum(r["probdd"]["budget_hit"] for r in rows) / len(rows), 3),
                   "reproduction_rate": round(sum(r["probdd"]["reproduces"] for r in rows) / len(rows), 3)},
        "existing_reduce": {"mean_kept": agg("existing_reduce", "kept"), "mean_replays": agg("existing_reduce", "replays"),
                            "one_minimal_rate": round(sum(r["existing_reduce"]["one_minimal"] for r in rows) / len(rows), 3),
                            "budget_hit_rate": round(sum(r["existing_reduce"]["budget_hit"] for r in rows) / len(rows), 3)},
        "mean_minimal_witness_len": round(statistics.mean(r["minimal_witness_len"] for r in rows), 3),
    }
    return {"scenarios": len(rows), "replay_budget": REDUCE_BUDGET, "summary": summary, "rows": rows}


def _sub_ok(log, pattern) -> bool:
    it = iter(log)
    return all(any(x == p for x in it) for p in pattern) and log[0] == "L"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args()
    result = {
        "schema": "shipproof.bench.explore-reduce/v1",
        "dataset": "SYNTHETIC: pt/search_model.py state-machine application with five seeded defects; synthetic failing sequences with known witness size",
        "explore": explore_bench(), "ablation": ablation(), "reduce": reduce_bench(),
        "not_measured": ["real browser coverage and defect discovery (the browser adapter is not executed here)"],
    }
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(result, indent=1), encoding="utf-8")
    print(json.dumps({"explore": result["explore"], "reduce_summary": result["reduce"]["summary"]}, indent=1))


if __name__ == "__main__":
    main()
