"""Probabilistic delta debugging over an interaction sequence (Algorithm 3). ProbDD-STYLE, not the published algorithm.

Each removable step keeps a probability p_i that it is needed to reproduce the failure. A candidate removal set is
sampled with probability proportional to (1 - p_i), so steps that have been repeatedly unnecessary are tried
first. After each replay the probabilities are updated from the outcome:
  - the candidate still fails (the removed steps were unnecessary): p_i decays for the removed steps;
  - the candidate no longer fails (at least one removed step was needed): p_i grows for the removed steps.
When sampling stops producing removals, a deterministic pass tests every remaining step alone. The search ends at a
1-minimal sequence: removing any single remaining step makes the failure disappear. That guarantee is the only
minimality claim made.

What this module does NOT do: reproduce the update rules or the convergence analysis of the published ProbDD
paper. The probability scheme here is a documented heuristic and is evaluated against `pt.reduce.reduce`
(the halving reducer already in this repository) under the same oracle and replay accounting.

Contract:
  oracle(indices: tuple[int, ...]) -> bool   True when the failure signature still reproduces for these steps.
  pinned: indices that are never removed (setup and authentication preconditions).
"""

from __future__ import annotations

import random


class BudgetExhausted(Exception):
    pass


def probdd(n: int, oracle, *, pinned=(), max_replays: int = 200, seed: int = 1, learning: float = 0.35, decay: float = 0.5) -> dict:
    if n < 1:
        raise ValueError("the sequence must contain at least one step")
    if max_replays < 1:
        raise ValueError("the replay budget must be at least 1")
    if not (0 < learning < 1 and 0 < decay < 1):
        raise ValueError("learning and decay must be in (0, 1)")
    pinned = set(pinned)
    if any(not 0 <= i < n for i in pinned):
        raise ValueError("pinned indices are outside the sequence")
    rng = random.Random(seed)
    cache: dict[tuple, bool] = {}
    replays = 0
    sequence = list(range(n))
    p = {i: 0.5 for i in sequence}
    history: list[dict] = []

    def test(cand: list[int]) -> bool:
        nonlocal replays
        key = tuple(cand)
        if key in cache:
            return cache[key]
        if replays >= max_replays:
            raise BudgetExhausted()
        replays += 1
        cache[key] = bool(oracle(key))
        return cache[key]

    try:
        if not test(sequence):
            return {"kept": sequence, "replays": replays, "one_minimal": False, "budget_hit": False, "reproduces": False,
                    "history": history, "reason": "the original sequence does not reproduce the failure"}
        # Phase 1: probability-guided sampling.
        stall = 0
        removable_count = len([i for i in sequence if i not in pinned])
        while stall < max(4, 2 * removable_count):
            removable = [i for i in sequence if i not in pinned]
            if not removable:
                break
            removal = {i for i in removable if rng.random() < 0.5 * (1 - p[i])}
            if not removal:
                removal = {min(removable, key=lambda i: (p[i], i))}
            cand = [i for i in sequence if i not in removal]
            ok = test(cand)
            history.append({"removed": sorted(removal), "still_fails": ok, "kept": len(cand)})
            if ok:
                sequence = cand
                for i in removal:
                    p[i] *= decay
                stall = 0
            else:
                for i in removal:
                    p[i] += (1 - p[i]) * learning
                stall += 1
        # Phase 2: 1-minimality. Keep trying single removals until a full pass removes nothing.
        changed = True
        while changed:
            changed = False
            for i in [j for j in sequence if j not in pinned]:
                if i not in sequence:  # removed earlier in this pass
                    continue
                cand = [j for j in sequence if j != i]
                if test(cand):
                    sequence = cand
                    history.append({"removed": [i], "still_fails": True, "kept": len(cand), "phase": "1-minimal"})
                    changed = True
        return {"kept": sequence, "replays": replays, "one_minimal": True, "budget_hit": False, "reproduces": True,
                "history": history, "reason": None}
    except BudgetExhausted:
        return {"kept": sequence, "replays": replays, "one_minimal": False, "budget_hit": True, "reproduces": True,
                "history": history, "reason": "replay budget exhausted before 1-minimality was established"}
