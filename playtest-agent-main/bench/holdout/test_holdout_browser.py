"""The holdout game in the real browser through the harness: it loads, the frame lock holds, the clean path wins, each flag fires.
Opens Chromium, so it runs only with PT_BROWSER_TESTS=1 and never while a game window is open."""
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_holdout import WIN, go, U, R, D, E  # noqa: E402

pytestmark = pytest.mark.skipif(os.environ.get("PT_BROWSER_TESTS") != "1", reason="browser test: set PT_BROWSER_TESTS=1")


def play(actions, bugs=""):
    from pt.adapter import make
    d = make("holdout", bugs=bugs)
    try:
        d.execute([{"type": "keypress", "keys": a["keys"]} for a in actions])
        return d.state(), d.bug_hits(), d.won()
    finally:
        d.close()


def test_the_frame_lock_holds_the_game_still():
    from pt.adapter import make
    d = make("holdout")
    try:
        t = d.tick()
        d.page.wait_for_timeout(300)
        assert d.tick() == t
    finally:
        d.close()


def test_the_clean_path_wins():
    state, hits, won = play(WIN)
    assert won and state["won"] and not any(hits.values())


def test_every_flag_fires_on_its_path():
    paths = {1: go(U, 3) + go(R, 4) + go(D, 3) + go(R) + go(E) + go(R, 2) + go(U, 3) + go(R, 2), 2: go(D, 2) + go(R, 3),
             3: go(U, 3) + go(R, 4) + go(D, 3) + go(R) + go(E), 4: WIN,
             5: go(U, 3) + go(R, 4) + go(D, 3) + go(R) + go(E) + go(R, 2) + go(D, 3) + go(R) + go(D, 4)}
    for n, actions in paths.items():
        _, hits, _ = play(actions, bugs=str(n))
        assert hits[str(n)] if str(n) in hits else hits[n]
