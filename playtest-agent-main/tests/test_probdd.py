"""Algorithm 3 — probabilistic delta debugging (ProbDD-style). Deterministic oracles; no browser."""

import pytest

from pt.probdd import probdd


def subsequence(seq, pattern):
    it = iter(seq)
    return all(any(x == p for x in it) for p in pattern)


def scenario(n, pattern, seed):
    import random
    rng = random.Random(seed)
    noise = [c for c in "abcdefgh" if c not in pattern]
    seq = ["L"] + [rng.choice(noise + list(pattern)) for _ in range(n - 1)]
    # place the pattern in order at random positions, so the witness is unique in the decoy-rich sequence
    slots = sorted(rng.sample(range(1, n), len(pattern)))
    for slot, sym in zip(slots, pattern):
        seq[slot] = sym
    return seq


def run(seq, pattern, **kw):
    """Oracle: the failure reproduces when the sequence starts with the pinned step L and contains the pattern in order."""
    log = []

    def oracle(indices):
        log.append(tuple(indices))
        return bool(indices) and seq[indices[0]] == "L" and subsequence([seq[i] for i in indices], pattern)

    return probdd(len(seq), oracle, **kw), log


def test_reduces_to_a_one_minimal_witness_and_keeps_the_pinned_setup():
    seq = scenario(60, ["O", "X", "Y"], seed=3)
    res, _ = run(seq, ["O", "X", "Y"], max_replays=400, seed=5)
    kept = [seq[i] for i in res["kept"]]
    assert res["reproduces"] and res["one_minimal"] and not res["budget_hit"]
    assert kept[0] == "L", "the pinned/setup step is never removed"
    assert len(kept) == 4, f"L + the three pattern steps is the only 1-minimal witness here, got {kept}"


def test_result_is_one_minimal_by_direct_check():
    seq = scenario(50, ["O", "a", "X"], seed=9)
    res, _ = run(seq, ["O", "a", "X"], max_replays=500, seed=2)
    kept = res["kept"]
    for i in kept[1:]:
        without = [j for j in kept if j != i]
        assert not (seq[without[0]] == "L" and subsequence([seq[j] for j in without], ["O", "a", "X"])), f"removing {i} still fails"


def test_pinned_steps_are_never_removed_even_when_the_oracle_does_not_need_them():
    seq = ["L", "z", "O", "z", "X", "z"]
    res, _ = run(seq, ["O", "X"], pinned=[3], max_replays=200)
    assert 3 in res["kept"]


def test_non_reproducing_original_is_reported_without_reduction():
    res = probdd(3, lambda idx: False, max_replays=10)
    assert res["reproduces"] is False and res["kept"] == [0, 1, 2] and res["replays"] == 1
    assert "does not reproduce" in res["reason"]


def test_budget_is_enforced_and_the_partial_result_still_reproduces():
    seq = scenario(120, ["O", "b", "Y"], seed=4)
    res, log = run(seq, ["O", "b", "Y"], max_replays=15, seed=1)
    assert res["budget_hit"] and not res["one_minimal"]
    assert res["replays"] <= 15 and len(log) <= 15
    kept = [seq[i] for i in res["kept"]]
    assert kept[0] == "L" and subsequence(kept, ["O", "b", "Y"]), "every accepted intermediate sequence reproduces"


def test_identical_seed_gives_identical_result():
    seq = scenario(70, ["O", "c", "X"], seed=8)
    a, _ = run(seq, ["O", "c", "X"], max_replays=300, seed=11)
    b, _ = run(seq, ["O", "c", "X"], max_replays=300, seed=11)
    assert a == b


def test_no_candidate_is_tested_twice():
    seq = scenario(40, ["O", "X", "Y"], seed=6)
    _, log = run(seq, ["O", "X", "Y"], max_replays=400, seed=7)
    assert len(log) == len(set(log))


@pytest.mark.parametrize("kwargs", [{"n": 0}, {"max_replays": 0}, {"learning": 1.0}, {"pinned": [99]}])
def test_invalid_arguments_are_rejected(kwargs):
    base = {"n": 5, "oracle": lambda idx: True}
    base.update(kwargs)
    n, oracle = base.pop("n"), base.pop("oracle")
    with pytest.raises(ValueError):
        probdd(n, oracle, **base)
