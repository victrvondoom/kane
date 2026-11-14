"""Doom engine facts the agent depends on, read from the real engine (Freedoom map01, no window, no model call).
Found in t-doom (28 Oct): the model pressed use 78 to 143 units from the first door and it never opened. See docs/DOOM-DOOR-PLAN.md."""
import json
from pathlib import Path

import pytest

V = pytest.importorskip("vizdoom")            # optional: README "Install ViZDoom with pip install vizdoom"

from pt.doom import DoomAdapter

CFG = json.loads((Path(__file__).resolve().parents[1] / "games" / "freedoom.json").read_text(encoding="utf-8"))
DOOR = 27                     # the shut sector behind the AGM panel, east of the start corridor


def _start():
    game = V.DoomGame()
    game.set_window_visible(False)
    game.set_sectors_info_enabled(True)
    return game, DoomAdapter(CFG, game=game)


def _x(game):
    return game.get_game_variable(V.GameVariable.POSITION_X)


def _door_open(game):
    s = game.get_state().sectors[DOOR]
    return s.ceiling_height - s.floor_height


def _press(d, game, button, tics):
    game.make_action([b == button for b in d.buttons], tics)


def test_use_from_100_units_leaves_the_door_shut_and_touching_it_opens_it():
    game, d = _start()
    try:
        assert _door_open(game) == 0
        while _x(game) < 520:                                   # the start corridor runs east to the door's face at x 704; momentum carries on
            _press(d, game, V.Button.MOVE_FORWARD, 2)
        _press(d, game, None, 20)                               # let the walk stop
        assert 704 - _x(game) > 64
        _press(d, game, V.Button.USE, 1)
        _press(d, game, None, 70)
        assert _door_open(game) == 0                            # too far: nothing happens, and nothing says so
        assert d.state()["doors_opened"] == 0
        last = None
        while last is None or abs(_x(game) - last) > 0.5:      # walk on until the player stops moving
            last = _x(game)
            _press(d, game, V.Button.MOVE_FORWARD, 2)
        _press(d, game, V.Button.USE, 1)
        _press(d, game, None, 70)
        assert _door_open(game) > 0
        assert d.state()["doors_opened"] == 1                  # the count a run's final state carries
    finally:
        d.close()


def _walk_to_100_units(d, game):
    while _x(game) < 520:
        _press(d, game, V.Button.MOVE_FORWARD, 2)
    _press(d, game, None, 20)
    assert 704 - _x(game) > 64


def test_space_through_the_adapter_walks_to_the_door_and_opens_it():
    """t-doom2 pressed space 93 units short of door 27 (docs/DOOM-DOOR-PLAN.md step 4)."""
    game = V.DoomGame()
    game.set_window_visible(False)
    game.set_sectors_info_enabled(True)
    d = DoomAdapter({**CFG, "use_walks": True}, game=game)
    try:
        _walk_to_100_units(d, game)
        before = d.tick()
        d.execute([{"type": "keypress", "keys": ["space"]}, {"type": "wait", "ms": 2000}])
        assert _door_open(game) > 0
        assert d.state()["doors_opened"] == 1
        assert d.last_spans[0]["held_to"] - before <= 35 + CFG["hold_ticks"]   # the walk is at most 1 s, then the hold
    finally:
        d.close()


def test_space_without_use_walks_still_needs_touching():
    game = V.DoomGame()
    game.set_window_visible(False)
    game.set_sectors_info_enabled(True)
    d = DoomAdapter({**CFG, "use_walks": False}, game=game)
    try:
        _walk_to_100_units(d, game)
        d.execute([{"type": "keypress", "keys": ["space"]}, {"type": "wait", "ms": 2000}])
        assert _door_open(game) == 0
    finally:
        d.close()


def test_doors_opened_counts_a_door_that_closed_again():
    """t-doom3 opened door 27 at step 3 and walked through; the door shut behind it, and the final state said 0."""
    game = V.DoomGame()
    game.set_window_visible(False)
    game.set_sectors_info_enabled(True)
    d = DoomAdapter({**CFG, "use_walks": True}, game=game)
    try:
        _walk_to_100_units(d, game)
        d.execute([{"type": "keypress", "keys": ["space"]}, {"type": "wait", "ms": 1500}])
        assert d.state()["doors_opened"] == 1
        _press(d, game, V.Button.MOVE_BACKWARD, 30)              # step back out of the doorway so it can shut
        d.execute([{"type": "wait", "ms": 10000}])
        assert _door_open(game) == 0
        assert d.state()["doors_opened"] == 1
    finally:
        d.close()


def test_tab_shows_the_automap_in_the_screenshot_the_model_gets():
    """Option C (docs/DOOM-LOST.md): the map must be in the picture the model sees, not only in a side buffer."""
    import io
    import numpy as np
    from PIL import Image
    d = DoomAdapter({**CFG, "map_key": True})
    try:
        d.execute([{"type": "keypress", "keys": ["forward"]}] * 3)
        def shot():
            return np.asarray(Image.open(io.BytesIO(d.screenshot())).convert("RGB")).astype(int)
        view = shot()
        d.execute([{"type": "keypress", "keys": ["tab"]}])
        mapped = shot()
        dark = (mapped.sum(2) < 40).mean()
        red = ((mapped[:, :, 0] > 150) & (mapped[:, :, 1] < 80)).mean()
        assert dark > 0.8 and red > 0.001                  # black ground, red walls: Doom's classic map
        assert (view.sum(2) < 40).mean() < 0.5             # the normal view is not mostly black
        d.execute([{"type": "keypress", "keys": ["tab"]}])
        assert (shot().sum(2) < 40).mean() < 0.5
    finally:
        d.close()


def test_doors_opened_counts_a_door_that_shut_with_no_state_read_between():
    """t-doom4 opened doors 27 and 121, and its final state said 1: the count was read only when state() was called."""
    game = V.DoomGame()
    game.set_window_visible(False)
    game.set_sectors_info_enabled(True)
    d = DoomAdapter({**CFG, "use_walks": True}, game=game)
    try:
        _walk_to_100_units(d, game)
        d.execute([{"type": "keypress", "keys": ["space"]}, {"type": "wait", "ms": 1500},
                   {"type": "keypress", "keys": ["back"]}, {"type": "keypress", "keys": ["back"]}, {"type": "keypress", "keys": ["back"]},
                   {"type": "wait", "ms": 10000}])
        assert _door_open(game) == 0
        assert d.state()["doors_opened"] == 1
    finally:
        d.close()
