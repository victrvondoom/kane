"""Algorithm 2 — NSGA-II exploration engine and the synthetic application model it is evaluated on. Seeded, no browser."""

import random

import pytest

from pt.search_model import Action, RECIPES, SimApp
from pt.search_nsga2 import (
    DIRECTION, OBJECTIVES, Individual, Session, Spec, assign_crowding, crossover, dominates, environmental_selection,
    key_of, mutate, nsga2, non_dominated_sort, pareto_front, random_search, random_sequence, summarise,
)

A = Action
WITNESS = {
    "BUG_QTY": [A("NAVIGATE", "catalog"), A("CLICK", 0), A("TYPE", "qty", "-1")],
    "BUG_ORDERS": [A("NAVIGATE", "account"), A("CLICK", 1), A("SCROLL", 1), A("SCROLL", 1)],
    "BUG_ZIP": [A("NAVIGATE", "cart"), A("CLICK", 0), A("TYPE", "zip", "00000"), A("SUBMIT")],
    "BUG_COUPON": [A("NAVIGATE", "cart"), A("TYPE", "coupon", "SAVE10"), A("CLICK", 0), A("TYPE", "zip", "12345"), A("SUBMIT")],
    "BUG_RACE": [A("NAVIGATE", "cart"), A("CLICK", 0), A("TYPE", "zip", "12345"), A("SUBMIT"), A("TYPE", "card", "4242"),
                 A("WAIT", 1), A("WAIT", 1), A("WAIT", 1), A("SUBMIT")],
}


@pytest.mark.parametrize("bug", sorted(WITNESS))
def test_each_seeded_defect_is_reproduced_by_its_witness(bug):
    t = SimApp().run(WITNESS[bug])
    assert bug in t.errors, f"{bug} did not fire: {t.errors}"
    assert t.progress_by_bug[bug] == len(RECIPES[bug]), "the recipe is complete when the defect fires"


def test_a_witness_without_its_key_step_does_not_fire_the_defect():
    seq = WITNESS["BUG_RACE"][:4] + [A("WAIT", 1), A("SUBMIT")]  # only one wait before submit
    t = SimApp().run(seq)
    assert "BUG_RACE" not in t.errors
    assert 0 < t.progress_by_bug["BUG_RACE"] < len(RECIPES["BUG_RACE"])


def test_progress_is_monotone_in_prefix_length():
    seq = WITNESS["BUG_COUPON"]
    prog = [SimApp().run(seq[:i]).progress for i in range(len(seq) + 1)]
    assert prog == sorted(prog)


def test_dominance_respects_objective_directions():
    base = (5, 5, 1, 0, 2, 4, 9.0)
    better = (6, 5, 1, 0, 2, 3, 9.0)   # more states, fewer actions
    worse = (5, 5, 1, 0, 2, 5, 9.0)
    assert dominates(better, base) and not dominates(base, better)
    assert dominates(base, worse) and not dominates(worse, base), "base uses fewer actions than worse"
    assert not dominates(base, base), "equal vectors do not dominate each other"
    assert DIRECTION[OBJECTIVES.index("actions")] == -1


def _ind(obj, ev):
    return Individual(seq=(), trace=None, objectives=tuple(obj), evaluation=ev)


def test_non_dominated_sort_produces_ordered_fronts():
    a = _ind((3, 3, 0, 0, 0, 5, 1.0), 1)
    b = _ind((2, 2, 0, 0, 0, 5, 1.0), 2)   # dominated by a
    c = _ind((2, 4, 0, 0, 0, 5, 1.0), 3)   # incomparable with a
    fronts = non_dominated_sort([a, b, c])
    assert [sorted(x.evaluation for x in f) for f in fronts] == [[1, 3], [2]]
    assert a.rank == 0 and c.rank == 0 and b.rank == 1


def test_crowding_gives_boundaries_infinite_and_interior_finite():
    front = [_ind((i, 10 - i, 0, 0, 0, 1, 1.0), i) for i in range(5)]
    assign_crowding(front)
    ordered = sorted(front, key=lambda p: p.objectives[0])
    assert ordered[0].crowding == float("inf") and ordered[-1].crowding == float("inf")
    assert all(0 < p.crowding < float("inf") for p in ordered[1:-1])


def test_behaviourally_identical_candidates_are_deduplicated_during_selection():
    class T:  # minimal trace stand-in with a signature
        def __init__(self):
            self.states, self.edges, self.errors = ["home"], [], []
        def signature(self):
            return (tuple(self.states), tuple(self.edges), tuple(self.errors))
    cheap = Individual(seq=(1,), trace=T(), objectives=(1, 0, 0, 0, 0, 1, 1.0), evaluation=1)
    dear = Individual(seq=(2, 2), trace=T(), objectives=(1, 0, 0, 0, 0, 2, 3.0), evaluation=2)
    chosen = environmental_selection([dear, cheap], 2)
    assert chosen == [cheap]


def test_mutation_and_crossover_stay_inside_the_specification():
    spec = Spec(max_len=10)
    rng = random.Random(4)
    for _ in range(300):
        a, b = random_sequence(rng, spec), random_sequence(rng, spec)
        for child in (mutate(rng, a, spec), crossover(rng, a, b, spec)):
            assert 1 <= len(child) <= spec.max_len
            assert all(x.kind in {"NAVIGATE", "CLICK", "TYPE", "SUBMIT", "SCROLL", "WAIT", "ASSERT", "RECORD"} for x in child)


def test_budget_is_exact_and_no_sequence_is_executed_twice():
    session = nsga2(None, Spec(), budget=120, pop_size=20, seed=3)
    assert session.runs == 120
    keys = [key_of(i.seq) for i in session.archive]
    assert len(keys) == len(set(keys))


def test_exploration_is_reproducible_for_a_seed():
    a = summarise(nsga2(None, Spec(), budget=150, pop_size=20, seed=7))
    b = summarise(nsga2(None, Spec(), budget=150, pop_size=20, seed=7))
    assert a == b


def test_random_baseline_uses_the_same_budget_and_session_accounting():
    s = random_search(None, Spec(), budget=60, seed=2)
    assert s.runs == 60 and s.actions_executed == sum(len(i.seq) for i in s.archive)


def test_pareto_front_contains_only_non_dominated_members():
    session = nsga2(None, Spec(), budget=100, pop_size=20, seed=5)
    front = pareto_front(session.archive)
    assert front and all(not any(dominates(q.objectives, p.objectives) for q in session.archive) for p in front)


def test_first_hit_records_the_action_at_which_each_defect_fired():
    s = Session(budget=10)
    ind = s.evaluate(WITNESS["BUG_QTY"])
    assert ind is not None
    assert s.first_hit["BUG_QTY"] == {"evaluation": 1, "actions_executed": 3}


def test_population_size_must_be_even():
    with pytest.raises(ValueError):
        nsga2(None, Spec(), budget=10, pop_size=5)
