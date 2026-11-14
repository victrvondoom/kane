"""Two replays of the same moves end in the same place on a locked game clock, even across a reload. Real headless Chromium."""
import pytest

pytest.importorskip("playwright")
from pt.adapter import make  # noqa: E402

R, L, J = ({"type": "keypress", "keys": [k]} for k in ("right", "left", "space"))
MOVES = [[R, R, R], [R, R], [{"type": "wait", "ms": 900}], [{"type": "reload"}],
         [R, {"type": "keypress", "keys": ["right", "space"]}], [R], [L, J], [{"type": "screenshot"}], [J], [R, R]]


def play():
    d = make("cave-courier", bugs="1,2,3,4,5")
    try:
        out = []
        for acts in MOVES:
            d.execute(acts)
            d.screenshot()
            s = d.state()
            out.append((s["x"], s["y"], s["coins"], d.tick()))
        return out
    finally:
        d.close()


def test_replays_match_exactly_across_a_reload():
    assert play() == play()
