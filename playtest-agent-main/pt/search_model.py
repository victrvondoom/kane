"""Deterministic state-machine application used to evaluate the NSGA-II explorer. SYNTHETIC by design.

It stands in for a web application so that exploration can be compared under identical conditions and with known
seeded defects. It is NOT a browser: the real Playtest driver implements the same `run(actions)` contract and is
not exercised by the benchmark in this repository.

Pages form a shop: home -> catalog -> product -> cart -> checkout (address -> payment) -> confirm, plus account and
orders. Five defects are seeded. Each has a RECIPE: an ordered list of observable steps over the effective event
log. A defect is emitted when its trigger fires; a partial recipe match is the "defect-reproduction progress"
objective the explorer optimises.
"""

from __future__ import annotations

from dataclasses import dataclass, field

ACTION_KINDS = ("NAVIGATE", "CLICK", "TYPE", "SUBMIT", "SCROLL", "WAIT", "ASSERT", "RECORD")
COST = {"NAVIGATE": 3.0, "CLICK": 2.0, "TYPE": 1.5, "SUBMIT": 2.0, "SCROLL": 0.5, "WAIT": 1.0, "ASSERT": 0.5, "RECORD": 0.2}
PAGES = ("home", "catalog", "product_a", "product_b", "cart", "checkout_address", "checkout_payment", "confirm", "account", "orders")
NAVIGABLE = ("home", "catalog", "cart", "account")  # NAVIGATE is effective only to these
LINKS = {
    "home": ("catalog", "account"),
    "catalog": ("product_a", "product_b", "cart"),
    "product_a": ("cart", "catalog"),
    "product_b": ("cart", "catalog"),
    "cart": ("checkout_address", "catalog"),
    "checkout_address": (),
    "checkout_payment": (),
    "confirm": ("home",),
    "account": ("home", "orders"),
    "orders": ("account",),
}
FIELDS = {"product_a": ("qty",), "product_b": ("qty",), "cart": ("coupon",), "checkout_address": ("zip",), "checkout_payment": ("card",)}
VALUES = {"qty": ("-1", "1", "2"), "coupon": ("SAVE10", "NOPE"), "zip": ("12345", "00000", "99999"), "card": ("4242", "0000")}
TYPE_VALUES = tuple((f, v) for f in VALUES for v in VALUES[f])


@dataclass(frozen=True)
class Action:
    """kind + argument. NAVIGATE: page · CLICK: link index · TYPE: field and value · SCROLL: amount · WAIT: ticks."""
    kind: str
    arg: object = None
    value: str | None = None

    def key(self) -> tuple:
        return (self.kind, self.arg, self.value)


# Ordered steps over the effective event log. Event = (before, kind, arg, value, after).
#   ("at", X)            the page after the action is X
#   ("type", f, v)       a TYPE of value v into field f
#   ("submit_on", X)     a SUBMIT performed while on X
#   ("scroll_total", n)  cumulative SCROLL amount on the orders page reaches n
#   ("wait_run", n)      n consecutive WAIT actions immediately before this step
RECIPES = {
    "BUG_QTY": [("at", "product_a"), ("type", "qty", "-1")],
    "BUG_ORDERS": [("at", "orders"), ("scroll_total", 2)],
    "BUG_COUPON": [("at", "cart"), ("type", "coupon", "SAVE10"), ("at", "checkout_payment")],
    "BUG_ZIP": [("at", "checkout_address"), ("type", "zip", "00000"), ("submit_on", "checkout_address")],
    "BUG_RACE": [("at", "checkout_payment"), ("type", "card", "4242"), ("wait_run", 3), ("submit_on", "checkout_payment")],
}
BUG_IDS = tuple(RECIPES)


@dataclass
class Trace:
    states: list = field(default_factory=list)       # distinct pages visited, in order
    edges: list = field(default_factory=list)         # distinct (from, kind, to) effective transitions
    errors: list = field(default_factory=list)        # defect ids emitted, in order
    error_at: dict = field(default_factory=dict)      # defect id -> 1-based action index that emitted it
    effective: int = 0                                # actions that changed the application
    cost: float = 0.0
    progress: int = 0                                 # best recipe progress over all defects
    progress_by_bug: dict = field(default_factory=dict)

    def signature(self) -> tuple:
        return (tuple(self.states), tuple(self.edges), tuple(self.errors))


class SimApp:
    """Stateless between runs: every `run` starts at home."""

    def run(self, actions) -> Trace:
        t = Trace()
        state = "home"
        fields: dict[str, str] = {}
        scroll_total = 0
        wait_run = 0
        events: list[tuple] = []
        emitted: set[str] = set()
        seen = {state}
        t.states.append(state)

        step = 0  # 1-based index of the action being executed, reported as the step a defect fired at

        def emit(bug: str) -> None:
            if bug not in emitted:
                emitted.add(bug)
                t.errors.append(bug)
                t.error_at[bug] = step

        def go(dest: str) -> None:
            nonlocal state
            if dest not in seen:
                seen.add(dest)
                t.states.append(dest)
            state = dest

        for step, a in enumerate(actions, start=1):
            t.cost += COST[a.kind]
            before = state
            run_before = wait_run
            wait_run = wait_run + 1 if a.kind == "WAIT" else 0
            changed = False
            if a.kind == "WAIT":
                changed = True
            elif a.kind == "NAVIGATE" and a.arg in NAVIGABLE:
                go(a.arg); t.edges.append((before, "NAVIGATE", state)); changed = True
            elif a.kind == "CLICK" and isinstance(a.arg, int) and 0 <= a.arg < len(LINKS[state]):
                dest = LINKS[state][a.arg]
                go(dest); t.edges.append((before, "CLICK", state)); changed = True
            elif a.kind == "CLICK" and state == "confirm" and a.arg == 0:
                go("home"); t.edges.append(("confirm", "CLICK", "home")); changed = True
            elif a.kind == "TYPE" and a.arg in FIELDS.get(state, ()) and a.value in VALUES.get(a.arg, ()):
                fields[a.arg] = a.value
                if a.arg == "qty" and a.value == "-1" and state == "product_a":
                    emit("BUG_QTY")
                t.edges.append((state, "TYPE", state)); changed = True
            elif a.kind == "SUBMIT" and state == "checkout_address" and fields.get("zip") in ("12345", "00000"):
                if fields["zip"] == "00000":
                    emit("BUG_ZIP")
                go("checkout_payment"); t.edges.append(("checkout_address", "SUBMIT", "checkout_payment")); changed = True
            elif a.kind == "SUBMIT" and state == "checkout_payment" and fields.get("card") in ("4242", "0000"):
                if fields["card"] == "4242" and run_before >= 3:
                    emit("BUG_RACE")
                go("confirm"); t.edges.append(("checkout_payment", "SUBMIT", "confirm")); changed = True
            elif a.kind == "SCROLL" and state == "orders":
                scroll_total += int(a.arg or 0)
                if scroll_total >= 2:
                    emit("BUG_ORDERS")
                t.edges.append(("orders", "SCROLL", "orders")); changed = True
            if changed:
                t.effective += 1
            # Every action is logged, so the progress matcher counts WAIT runs exactly as the defect trigger does.
            events.append((before, a.kind, a.arg, a.value, state))
            # Coupon defect: a discounted cart reaches payment with the coupon still applied.
            if a.kind == "SUBMIT" and before == "checkout_address" and state == "checkout_payment" and fields.get("coupon") == "SAVE10":
                emit("BUG_COUPON")
        t.edges = sorted(set(t.edges), key=lambda e: (str(e[0]), e[1], str(e[2])))
        for bug, recipe in RECIPES.items():
            p = _progress(events, recipe)
            t.progress_by_bug[bug] = p
            t.progress = max(t.progress, p)
        return t


def _progress(events, recipe) -> int:
    """Length of the longest prefix of `recipe` matched in order by the effective event log."""
    i = 0
    waits = 0
    scrolled = 0
    for ev in events:
        before, kind, arg, value, after = ev
        waits = waits + 1 if kind == "WAIT" else 0
        if kind == "SCROLL" and before == "orders":
            scrolled += int(arg or 0)
        if i < len(recipe) and _matches(ev, waits, scrolled, recipe[i]):
            i += 1
    return i


def _matches(ev, waits: int, scrolled: int, step) -> bool:
    before, kind, arg, value, after = ev
    op = step[0]
    if op == "at":
        return after == step[1]
    if op == "type":
        return kind == "TYPE" and arg == step[1] and value == step[2]
    if op == "submit_on":
        return kind == "SUBMIT" and before == step[1]
    if op == "wait_run":
        return kind == "WAIT" and waits >= step[1]
    if op == "scroll_total":
        return kind == "SCROLL" and before == "orders" and scrolled >= step[1]
    return False
