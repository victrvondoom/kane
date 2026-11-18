"""NSGA-II multi-objective exploration for the Playtest agent (Algorithm 2).

Deb, Pratap, Agarwal & Meyarivan, "A fast and elitist multiobjective genetic algorithm: NSGA-II", IEEE TEC 2002.

Implemented here:
  - fast non-dominated sorting (O(M N^2)) and crowding-distance assignment;
  - binary tournament on (rank, then larger crowding distance);
  - one-point crossover on action sequences and typed mutation (replace / insert / delete);
  - duplicate elimination: an identical action sequence is never executed twice, and offspring that produce an
    identical BEHAVIOUR (same pages, edges and defects) as an existing member are removed during selection;
  - an execution budget counted in application runs, enforced before every run;
  - seeded randomness: the same seed and the same application give the same exploration.

Objectives are all MEASURED from the application trace, combined only through Pareto dominance, never through a
weighted sum:
  maximise  states      distinct pages visited by this sequence
  maximise  edges       distinct effective transitions by this sequence (route / interaction coverage)
  maximise  new_states  pages not seen earlier in this exploration session
  maximise  new_errors  defects not observed earlier in this session
  maximise  progress    best defect-reproduction progress (matched recipe steps)
  minimise  actions     effective actions (the action count needed to produce the behaviour)
  minimise  cost        summed action cost

Honest scope: "states" are application pages from the trace. In the browser this must be an abstract state
(URL plus a structural fingerprint). Element counts are not used as coverage.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field

from pt.search_model import ACTION_KINDS, NAVIGABLE, PAGES, TYPE_VALUES, Action, SimApp, Trace

OBJECTIVES = ("states", "edges", "new_states", "new_errors", "progress", "actions", "cost")
DIRECTION = (1, 1, 1, 1, 1, -1, -1)  # +1 maximise, -1 minimise


@dataclass(frozen=True)
class Spec:
    max_len: int = 24
    min_len: int = 1
    click_slots: int = 3
    scroll_max: int = 3
    wait_max: int = 3


def random_action(rng: random.Random, spec: Spec) -> Action:
    kind = rng.choice(ACTION_KINDS)
    if kind == "NAVIGATE":
        return Action("NAVIGATE", rng.choice(PAGES))
    if kind == "CLICK":
        return Action("CLICK", rng.randrange(spec.click_slots))
    if kind == "TYPE":
        f, v = rng.choice(TYPE_VALUES)
        return Action("TYPE", f, v)
    if kind == "SCROLL":
        return Action("SCROLL", rng.randrange(1, spec.scroll_max + 1))
    if kind == "WAIT":
        return Action("WAIT", rng.randrange(1, spec.wait_max + 1))
    return Action(kind)


def random_sequence(rng: random.Random, spec: Spec) -> tuple[Action, ...]:
    n = rng.randint(spec.min_len, spec.max_len)
    return tuple(random_action(rng, spec) for _ in range(n))


def mutate(rng: random.Random, seq: tuple[Action, ...], spec: Spec) -> tuple[Action, ...]:
    s = list(seq)
    ops = ["replace", "replace"] + (["insert"] if len(s) < spec.max_len else []) + (["delete"] if len(s) > spec.min_len else [])
    op = rng.choice(ops)
    if op == "replace":
        s[rng.randrange(len(s))] = random_action(rng, spec)
    elif op == "insert":
        s.insert(rng.randrange(len(s) + 1), random_action(rng, spec))
    else:
        del s[rng.randrange(len(s))]
    return tuple(s)


def crossover(rng: random.Random, a: tuple[Action, ...], b: tuple[Action, ...], spec: Spec) -> tuple[Action, ...]:
    i = rng.randint(1, len(a))
    j = rng.randint(0, len(b) - 1)
    child = (a[:i] + b[j:])[: spec.max_len]
    return child if child else (a[0],)


def key_of(seq) -> tuple:
    return tuple(a.key() for a in seq)


@dataclass
class Individual:
    seq: tuple
    trace: Trace
    objectives: tuple
    evaluation: int
    rank: int = 0
    crowding: float = 0.0

    @property
    def signature(self):
        return self.trace.signature()

    def as_record(self) -> dict:
        return {"evaluation": self.evaluation, "actions": [a.key() for a in self.seq], "objectives": dict(zip(OBJECTIVES, self.objectives)),
                "states": self.trace.states, "edges": [list(e) for e in self.trace.edges], "errors": self.trace.errors, "error_at": self.trace.error_at}


class Session:
    """One exploration: owns the application, the budget, the global novelty sets and the archive of every run."""

    def __init__(self, app: SimApp | None = None, budget: int = 500, mask: tuple | None = None):
        """`mask` (one bool per objective) switches objectives off for an ablation: a masked objective is held at 0,
        so it cannot affect dominance. None keeps all objectives."""
        if mask is not None and (len(mask) != len(OBJECTIVES) or not any(mask)):
            raise ValueError("mask needs one entry per objective, with at least one objective on")
        self.mask = tuple(mask) if mask is not None else (True,) * len(OBJECTIVES)
        self.app = app or SimApp()
        self.budget = budget
        self.runs = 0
        self.seen_states: set[str] = set()
        self.seen_errors: set[str] = set()
        self.keys: set[tuple] = set()
        self.first_hit: dict[str, dict] = {}   # defect -> {evaluation, actions_executed}
        self.actions_executed = 0
        self.archive: list[Individual] = []

    @property
    def exhausted(self) -> bool:
        return self.runs >= self.budget

    def evaluate(self, seq) -> Individual | None:
        """Runs the application once, unless the budget is spent or the sequence was already run."""
        k = key_of(seq)
        if self.exhausted or k in self.keys:
            return None
        self.keys.add(k)
        self.runs += 1
        t = self.app.run(list(seq))
        new_states = len(set(t.states) - self.seen_states)
        new_errors = len(set(t.errors) - self.seen_errors)
        self.seen_states |= set(t.states)
        self.seen_errors |= set(t.errors)
        self.actions_executed += len(seq)
        for bug in t.errors:
            if bug not in self.first_hit:
                self.first_hit[bug] = {"evaluation": self.runs, "actions_executed": self.actions_executed - len(seq) + t.error_at[bug]}
        obj = (len(t.states), len(t.edges), new_states, new_errors, t.progress, t.effective, round(t.cost, 6))
        obj = tuple(v if on else 0 for v, on in zip(obj, self.mask))
        ind = Individual(seq=tuple(seq), trace=t, objectives=obj, evaluation=self.runs)
        self.archive.append(ind)
        return ind


def dominates(a: tuple, b: tuple) -> bool:
    """Pareto dominance on the directed objective vector (strictly better in one, no worse in all)."""
    better = False
    for x, y, d in zip(a, b, DIRECTION):
        x, y = d * x, d * y
        if x < y:
            return False
        if x > y:
            better = True
    return better


def non_dominated_sort(pop: list[Individual]) -> list[list[Individual]]:
    dominated_by = {i: [] for i in range(len(pop))}
    count = [0] * len(pop)
    fronts = [[]]
    for i, p in enumerate(pop):
        for j, q in enumerate(pop):
            if i == j:
                continue
            if dominates(p.objectives, q.objectives):
                dominated_by[i].append(j)
            elif dominates(q.objectives, p.objectives):
                count[i] += 1
        if count[i] == 0:
            p.rank = 0
            fronts[0].append(i)
    r = 0
    while fronts[r]:
        nxt = []
        for i in fronts[r]:
            for j in dominated_by[i]:
                count[j] -= 1
                if count[j] == 0:
                    pop[j].rank = r + 1
                    nxt.append(j)
        r += 1
        fronts.append(nxt)
    return [[pop[i] for i in f] for f in fronts if f]


def assign_crowding(front: list[Individual]) -> None:
    for p in front:
        p.crowding = 0.0
    if len(front) <= 2:
        for p in front:
            p.crowding = float("inf")
        return
    m = len(OBJECTIVES)
    for k in range(m):
        ordered = sorted(front, key=lambda p: p.objectives[k])
        lo, hi = ordered[0].objectives[k], ordered[-1].objectives[k]
        ordered[0].crowding = ordered[-1].crowding = float("inf")
        if hi == lo:
            continue
        for i in range(1, len(ordered) - 1):
            ordered[i].crowding += (ordered[i + 1].objectives[k] - ordered[i - 1].objectives[k]) / (hi - lo)


def _dedupe_behaviour(pool: list[Individual]) -> list[Individual]:
    """Keep one member per identical behaviour: the cheapest (fewest actions, then lowest cost, then oldest)."""
    best: dict[tuple, Individual] = {}
    for p in pool:
        s = p.signature
        q = best.get(s)
        if q is None or (p.objectives[5], p.objectives[6], p.evaluation) < (q.objectives[5], q.objectives[6], q.evaluation):
            best[s] = p
    return list(best.values())


def environmental_selection(pool: list[Individual], size: int) -> list[Individual]:
    pool = _dedupe_behaviour(pool)
    chosen: list[Individual] = []
    for front in non_dominated_sort(pool):
        assign_crowding(front)
        if len(chosen) + len(front) <= size:
            chosen.extend(front)
        else:
            chosen.extend(sorted(front, key=lambda p: (-p.crowding, p.evaluation))[: size - len(chosen)])
            break
    return chosen


def _tournament(rng: random.Random, pop: list[Individual]) -> Individual:
    a, b = rng.choice(pop), rng.choice(pop)
    if a.rank != b.rank:
        return a if a.rank < b.rank else b
    return a if a.crowding >= b.crowding else b


def _fresh(session: Session, make, rng: random.Random, tries: int = 25):
    for _ in range(tries):
        ind = session.evaluate(make())
        if ind is not None or session.exhausted:
            return ind
    return None


def nsga2(app: SimApp | None, spec: Spec, budget: int, pop_size: int = 40, seed: int = 1,
          p_crossover: float = 0.9, p_mutation: float = 0.9, mask: tuple | None = None) -> Session:
    if pop_size < 4 or pop_size % 2:
        raise ValueError("pop_size must be an even number, at least 4")
    rng = random.Random(seed)
    session = Session(app, budget=budget, mask=mask)
    pop: list[Individual] = []
    while len(pop) < pop_size and not session.exhausted:
        ind = _fresh(session, lambda: random_sequence(rng, spec), rng)
        if ind is None:
            break
        pop.append(ind)
    if not pop:
        return session
    for front in non_dominated_sort(pop):
        assign_crowding(front)
    while not session.exhausted:
        offspring: list[Individual] = []
        while len(offspring) < pop_size and not session.exhausted:
            def make():
                p1, p2 = _tournament(rng, pop), _tournament(rng, pop)
                child = crossover(rng, p1.seq, p2.seq, spec) if rng.random() < p_crossover else p1.seq
                if rng.random() < p_mutation:
                    child = mutate(rng, child, spec)
                return child
            ind = _fresh(session, make, rng)
            if ind is None:
                break
            offspring.append(ind)
        if not offspring:
            break
        pop = environmental_selection(pop + offspring, pop_size)
        for front in non_dominated_sort(pop):
            assign_crowding(front)
    return session


def random_search(app: SimApp | None, spec: Spec, budget: int, seed: int = 1) -> Session:
    rng = random.Random(seed)
    session = Session(app, budget=budget)
    while not session.exhausted:
        if _fresh(session, lambda: random_sequence(rng, spec), rng) is None:
            break
    return session


def novelty_hill_climb(app: SimApp | None, spec: Spec, budget: int, seed: int = 1, start: int = 20) -> Session:
    """Baseline: always mutate the archive member with the best coverage per action (single-objective greedy)."""
    rng = random.Random(seed)
    session = Session(app, budget=budget)
    for _ in range(start):
        if _fresh(session, lambda: random_sequence(rng, spec), rng) is None:
            break
    while not session.exhausted and session.archive:
        best = max(session.archive, key=lambda p: ((p.objectives[0] + p.objectives[1] + p.objectives[4] + 2 * p.objectives[3]) / (1 + p.objectives[5]), -p.evaluation))
        if _fresh(session, lambda: mutate(rng, best.seq, spec), rng) is None:
            break
    return session


def pareto_front(individuals: list[Individual]) -> list[Individual]:
    return [p for p in individuals if not any(dominates(q.objectives, p.objectives) for q in individuals if q is not p)]


@dataclass
class Summary:
    runs: int
    states: int
    edges: int
    defects: list = field(default_factory=list)
    front_size: int = 0


def summarise(session: Session) -> dict:
    states = set().union(*(set(i.trace.states) for i in session.archive)) if session.archive else set()
    edges = set().union(*(set(i.trace.edges) for i in session.archive)) if session.archive else set()
    front = pareto_front(session.archive)
    return {"runs": session.runs, "actions_executed": session.actions_executed, "distinct_states": len(states), "distinct_edges": len(edges),
            "defects": sorted(session.first_hit), "first_hit": session.first_hit, "pareto_front_size": len(front)}
