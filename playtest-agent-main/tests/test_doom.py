import json
import io
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

V = pytest.importorskip("vizdoom")            # optional: README "Install ViZDoom with pip install vizdoom"
from PIL import Image

from pt import adapter as A


CFG = {"type": "doom", "name": "demo", "scenario": "basic.cfg",
       "controls": "Forward walks. F shoots.", "goal": "Reach the exit."}


@pytest.fixture(autouse=True)
def no_engine(monkeypatch):
    def fail():
        pytest.fail("unit tests must use a fake game")
    monkeypatch.setattr(V, "DoomGame", fail)


class FakeGame:
    def __init__(self):
        self.calls = []
        self.buttons = [V.Button.ATTACK, V.Button.SPEED]
        self.variables = [V.GameVariable.AMMO2]
        self.values = {V.GameVariable.AMMO2: 20, V.GameVariable.HEALTH: 100,
                       V.GameVariable.KILLCOUNT: 0, V.GameVariable.POSITION_X: 12,
                       V.GameVariable.POSITION_Y: 34}
        self.finished = self.dead = False
        self.ticks = 0
        self.buffer = np.zeros((480, 640, 3), dtype=np.uint8)
        self.buffer[:, :, 0] = 255

    def __getattr__(self, name):
        if name.startswith("set_") or name in ("load_config", "init", "new_episode", "close", "add_game_args"):
            return lambda *args: self.calls.append((name, *args))
        raise AttributeError(name)

    def get_available_buttons(self): return list(self.buttons)
    def add_available_button(self, button): self.buttons.append(button)
    def get_available_game_variables(self): return list(self.variables)
    def add_available_game_variable(self, variable): self.variables.append(variable)
    def get_game_variable(self, variable): return self.values[variable]
    def is_episode_finished(self): return self.finished
    def is_player_dead(self): return self.dead
    def get_state(self): return None if self.finished else SimpleNamespace(screen_buffer=self.buffer)
    def make_action(self, buttons, ticks):
        self.calls.append(("make_action", buttons, ticks))
        self.ticks += ticks
        self.buffer[:] = (self.ticks % 256, 30, 80)


@pytest.fixture
def game():
    from pt.doom import DoomAdapter
    fake = FakeGame()
    return DoomAdapter(CFG, game=fake), fake


def test_settings_and_paths():
    from pt.doom import DoomAdapter
    fake = FakeGame()
    d = DoomAdapter({**CFG, "seed": 7, "doom_map": "map01"}, game=fake)
    root = Path(V.__file__).parent
    assert fake.calls[0] == ("load_config", str(root / "scenarios" / "basic.cfg"))
    for call in [("set_doom_game_path", str(root / "freedoom2.wad")),
                 ("set_doom_map", "map01"), ("set_window_visible", False),
                 ("set_sound_enabled", False), ("set_mode", V.Mode.PLAYER),
                 ("set_screen_format", V.ScreenFormat.RGB24), ("set_seed", 7),
                 ("set_screen_resolution", V.ScreenResolution.RES_640X480)]:
        assert call in fake.calls
    assert fake.calls[-2:] == [("init",), ("new_episode",)]
    assert fake.buttons[:2] == [V.Button.ATTACK, V.Button.SPEED]
    assert len(fake.buttons) == len(set(fake.buttons)) == 9
    assert set(fake.buttons) >= {getattr(V.Button, name) for name in
                               ("MOVE_FORWARD", "MOVE_BACKWARD", "TURN_LEFT", "TURN_RIGHT",
                                "MOVE_LEFT", "MOVE_RIGHT", "ATTACK", "USE")}
    assert (d.name, d.controls, d.goal) == (CFG["name"], CFG["controls"], CFG["goal"])


@pytest.mark.parametrize("key,button", [("forward", "MOVE_FORWARD"), ("up", "MOVE_FORWARD"),
    ("back", "MOVE_BACKWARD"), ("down", "MOVE_BACKWARD"), ("left", "TURN_LEFT"),
    ("right", "TURN_RIGHT"), ("strafe_left", "MOVE_LEFT"), ("strafe_right", "MOVE_RIGHT"),
    ("space", "USE"), ("e", "USE"), ("f", "ATTACK"), ("ctrl", "ATTACK"), ("attack", "ATTACK")])
def test_keys(game, key, button):
    d, fake = game
    d.execute([{"type": "keypress", "keys": [key]}])
    assert fake.calls[-1] == ("make_action", [b == getattr(V.Button, button) for b in fake.buttons], 9)


def test_chords_wait_and_recording(game):
    d, fake = game
    d.hold_ticks = 14
    actions = [{"type": "keypress", "keys": ["UP", "f", "unknown"]},
               {"type": "wait", "ms": 200}, {"type": "keypress", "keys": ["unknown"]},
               {"type": "click", "x": 1, "y": 2}, {"type": "screenshot"}]
    n = len(fake.calls)
    d.execute(actions)
    assert fake.calls[n:] == [("make_action", [b in (V.Button.MOVE_FORWARD, V.Button.ATTACK)
                                               for b in fake.buttons], 14),
                             ("make_action", [False] * len(fake.buttons), 7)]
    assert d.executed == actions


def test_each_action_logs_its_engine_frames_for_the_run_video(game):
    d, fake = game
    d.execute([{"type": "keypress", "keys": ["f"]}, {"type": "wait", "ms": 200}, {"type": "keypress", "keys": ["unknown"]}])
    assert d.last_spans == [{"from": 0, "held_to": 9, "to": 9}, {"from": 9, "held_to": 9, "to": 16}, {"from": 16, "held_to": 16, "to": 16}]
    assert d.fps == 35


def test_finished_actions_are_recorded_without_advancing(game):
    d, fake = game
    original = fake.make_action

    def finish(buttons, ticks):
        original(buttons, ticks)
        fake.finished = True

    fake.make_action = finish
    actions = [{"type": "wait", "ms": 100}] * 3
    n = len(fake.calls)
    d.execute(actions)
    assert len(fake.calls) == n + 1
    assert d.executed == actions


@pytest.mark.parametrize("channels_first", [False, True])
def test_screenshot(game, channels_first):
    d, fake = game
    if channels_first:
        fake.buffer = fake.buffer.transpose(2, 0, 1)
    d.shot_width = 320
    with Image.open(io.BytesIO(d.screenshot())) as im:
        assert im.format == "JPEG" and im.size == (320, 240)
        r, g, b = im.getpixel((100, 100))
        assert r > 240 and g < 10 and b < 10


def test_state_and_finish_rules(game):
    d, fake = game
    assert d.state() == {"ammo2": 20, "finished": False, "dead": False}
    assert d.won() is False and d.bug_hits() is None
    fake.finished = True
    assert d.won() is True
    fake.dead = True
    assert d.state() == {"ammo2": 20, "finished": True, "dead": True}
    assert d.won() is False


def test_finished_episode_keeps_last_screen_for_replay(game):
    d, fake = game
    before = d.screenshot()
    fake.finished = True
    assert d.screenshot() == before


def test_configured_variables_and_kill_win():
    from pt.doom import DoomAdapter
    fake = FakeGame()
    d = DoomAdapter({**CFG, "win": "kill", "vars": ["HEALTH", "AMMO2", "KILLCOUNT", "POSITION_X", "POSITION_Y"]}, game=fake)
    assert d.state() == {"health": 100, "ammo2": 20, "killcount": 0, "position_x": 12,
                         "position_y": 34, "finished": False, "dead": False}
    fake.finished = True
    assert d.won() is False
    fake.values[V.GameVariable.KILLCOUNT] = 1
    assert d.won() is True
    fake.finished = False
    assert d.won() is False
    fake.finished = fake.dead = True
    assert d.won() is False


def test_fresh_and_close(monkeypatch, game):
    d, fake = game
    other = FakeGame()
    monkeypatch.setattr(V, "DoomGame", lambda: other)
    fresh = d.fresh()
    assert fresh is not d and fresh.cfg == d.cfg
    assert ("set_seed", 1) in fake.calls and ("set_seed", 1) in other.calls
    assert fresh.executed == []
    d.close()
    assert fake.calls[-1] == ("close",)


def test_validation_and_dispatch(monkeypatch, tmp_path):
    import json
    from pt import doom as D
    assert A.validate(CFG) == []
    assert A.validate({"type": "doom"}) == ["name is missing", "scenario is missing"]
    path = tmp_path / "demo.json"
    path.write_text(json.dumps(CFG))
    monkeypatch.setattr(A, "config_path", lambda name: path)
    calls = []
    monkeypatch.setattr(D, "DoomAdapter", lambda cfg: calls.append(cfg) or "opened")
    assert A.make("demo", bugs="1", debug=True) == "opened"
    assert calls == [CFG]


@pytest.mark.parametrize("changes", [{"scenario": "../basic.cfg"}, {"scenario": "basic.wad"},
    {"game_wad": "doom2.wad"}, {"game_wad": "../freedoom2.wad"}])
def test_only_packaged_scenarios_and_freedoom_data(changes):
    from pt.doom import DoomAdapter
    fake = FakeGame()
    with pytest.raises(ValueError):
        DoomAdapter({**CFG, **changes}, game=fake)
    assert fake.calls == []


@pytest.mark.parametrize("name,scenario,win", [("freedoom", "freedoom2.cfg", "finished"),
                                             ("doom-basic", "basic.cfg", "kill")])
def test_game_configs(name, scenario, win):
    cfg = A.load_config(A.config_path(name))
    assert cfg["type"] == "doom" and cfg["scenario"] == scenario and cfg["win"] == win
    assert cfg["game_wad"] == "freedoom2.wad"
    assert cfg["controls"] and cfg["goal"]
    if name == "freedoom":
        assert cfg["name"] == "Freedoom (Doom engine)" and cfg["doom_map"] == "map01"
        assert "report_bug" in cfg["goal"]
        for key in ("forward", "back", "left", "right", "strafe_left", "strafe_right", "space", "f"):
            assert key in cfg["controls"]
    else:
        assert cfg["goal"] == "Turn to face the monster and shoot it."


def test_smoke_script(monkeypatch, capsys):
    from tools import doom_smoke
    from pt.doom import DoomAdapter
    fake = FakeGame()
    d = DoomAdapter(CFG, game=fake)
    names = []
    monkeypatch.setattr(doom_smoke, "make", lambda name: names.append(name) or d)
    doom_smoke.main()
    output = capsys.readouterr().out
    assert names == ["doom-basic"]
    assert "640" in output and "480" in output and "bytes" in output
    assert "state:" in output and "elapsed:" in output
    assert sum(a["type"] == "keypress" for a in d.executed) >= 3
    assert fake.calls[-1] == ("close",)


def test_smoke_closes_on_error(monkeypatch):
    from tools import doom_smoke
    from pt.doom import DoomAdapter
    fake = FakeGame()
    d = DoomAdapter(CFG, game=fake)
    monkeypatch.setattr(doom_smoke, "make", lambda name: d)

    def fail():
        raise RuntimeError("no screenshot")

    monkeypatch.setattr(d, "screenshot", fail)
    with pytest.raises(RuntimeError, match="no screenshot"):
        doom_smoke.main()
    assert fake.calls[-1] == ("close",)


def test_recording_preserves_actions_state_and_screenshot(tmp_path):
    from pt.doom import DoomAdapter
    plain, recorded = [DoomAdapter(CFG, game=FakeGame()) for _ in range(2)]
    recorded.start_recording(tmp_path)
    assert recorded.tick() == 0
    recorded.screenshot()
    actions = [{"type": "keypress", "keys": ["forward", "left"]},
               {"type": "wait", "ms": 200}]
    for d in (plain, recorded):
        d.execute(actions)
    def expanded(d):
        return [call[1] for call in d.game.calls if call[0] == "make_action"
                for _ in range(call[2])]
    assert expanded(plain) == expanded(recorded)
    assert recorded.tick() == recorded.game.ticks == plain.tick() == 16
    assert recorded.state() == plain.state()
    assert recorded.screenshot() == plain.screenshot()
    assert [p.name for p in sorted((tmp_path / "frames").glob("*.jpg"))] == [
        f"f{i:08d}.jpg" for i in range(17)]
    assert all(c[2] == 1 for c in recorded.game.calls if c[0] == "make_action")
    with Image.open(tmp_path / "frames/f00000016.jpg") as image:
        assert image.size == (640, 480)


def test_clip_config():
    cfg = A.load_config(A.config_path("freedoom-clip"))
    base = A.load_config(A.config_path("freedoom"))
    assert {k: v for k, v in cfg.items() if k != "goal"} == {k: v for k, v in base.items() if k != "goal"}
    assert cfg["goal"] == "Clear the first room, open a door and find a key. Say in one short sentence what you see before each move."


def test_smoke_recording(monkeypatch, capsys, tmp_path, game):
    from tools import doom_smoke
    d, fake = game
    monkeypatch.setattr(doom_smoke, "make", lambda name: d)
    doom_smoke.main(["--record", str(tmp_path)])
    output = capsys.readouterr().out
    assert "frames: 27, ticks: 27" in output
    assert len(list((tmp_path / "frames").glob("*.jpg"))) == d.tick() == 27


@pytest.mark.parametrize("name", ["freedoom", "freedoom-clip", "freedoom-door"])
def test_doom_controls_say_use_needs_touching_and_e_is_space(name):
    """t-doom pressed use 78 to 143 units from a door 7 times and tried e as a different key 3 times (docs/DOOM-DOOR-PLAN.md)."""
    controls = json.loads((Path(__file__).resolve().parents[1] / "games" / f"{name}.json").read_text(encoding="utf-8"))["controls"]
    assert "space walks you forward until you touch something" in controls
    assert "e is the same key as space" in controls


@pytest.mark.parametrize("name", ["freedoom", "freedoom-clip", "freedoom-door"])
def test_doom_configs_turn_on_use_walks(name):
    """t-doom2 read the touch rule and still pressed 93 units short of the door (docs/DOOM-DOOR-PLAN.md step 3)."""
    cfg = json.loads((Path(__file__).resolve().parents[1] / "games" / f"{name}.json").read_text(encoding="utf-8"))
    assert cfg.get("use_walks") is True


class WalkingGame(FakeGame):
    """Moves 8 units a frame while forward is held, until it reaches a wall at x 60."""
    def make_action(self, buttons, ticks):
        super().make_action(buttons, ticks)
        if buttons[self.buttons.index(V.Button.MOVE_FORWARD)]:
            x = self.values[V.GameVariable.POSITION_X]
            self.values[V.GameVariable.POSITION_X] = min(60, x + 8 * ticks)


def _walker(wall=60):
    from pt.doom import DoomAdapter
    fake = WalkingGame()
    return DoomAdapter({**CFG, "use_walks": True}, game=fake), fake


def _actions(fake):
    return [(call[1], call[2]) for call in fake.calls if call[0] == "make_action"]


def test_use_walks_forward_until_blocked_then_presses_use():
    d, fake = _walker()
    d.execute([{"type": "keypress", "keys": ["space"]}])
    acts = _actions(fake)
    fwd, use = fake.buttons.index(V.Button.MOVE_FORWARD), fake.buttons.index(V.Button.USE)
    walk = [a for a in acts if a[0][fwd] and not a[0][use]]
    assert all(n == 1 for _, n in walk)                       # one frame at a time, so it can stop at the wall
    assert 6 <= len(walk) <= 8                               # 12 to 60 in 8 unit frames, then one frame that does not move
    assert acts[-1] == ([b == V.Button.USE for b in fake.buttons], 9)
    assert d.last_spans[0] == {"from": 0, "held_to": d.tick(), "to": d.tick()}


def test_use_walk_stops_after_35_frames_in_the_open():
    d, fake = _walker()
    fake.values[V.GameVariable.POSITION_X] = -1000
    d.execute([{"type": "keypress", "keys": ["e"]}])
    walk = [a for a in _actions(fake) if a[1] == 1]
    assert len(walk) == 35
    assert d.tick() == 35 + 9


def test_use_walks_is_off_by_default_and_for_other_keys(game):
    d, fake = game
    d.execute([{"type": "keypress", "keys": ["space"]}])
    assert len(_actions(fake)) == 1
    d2, fake2 = _walker()
    d2.execute([{"type": "keypress", "keys": ["f"]}])
    assert len(_actions(fake2)) == 1



class MapGame(FakeGame):
    """A fake game whose automap buffer is solid green."""
    def get_state(self):
        if self.finished:
            return None
        return SimpleNamespace(screen_buffer=self.buffer, automap_buffer=np.full((480, 640, 3), (0, 200, 0), dtype=np.uint8))


def _shot_colour(d):
    return Image.open(io.BytesIO(d.screenshot())).convert("RGB").getpixel((320, 240))


def test_map_key_turns_on_the_classic_automap():
    from pt.doom import DoomAdapter
    fake = MapGame()
    DoomAdapter({**CFG, "map_key": True}, game=fake)
    assert ("set_automap_buffer_enabled", True) in fake.calls
    assert ("set_automap_mode", V.AutomapMode.NORMAL) in fake.calls
    assert ("set_automap_rotate", False) in fake.calls
    assert any(c[0] == "add_game_args" and "+am_colorset 1" in c[1] for c in fake.calls)


def test_tab_shows_the_map_in_the_screenshot_and_tab_again_hides_it():
    from pt.doom import DoomAdapter
    fake = MapGame()
    d = DoomAdapter({**CFG, "map_key": True}, game=fake)
    view = _shot_colour(d)
    d.execute([{"type": "keypress", "keys": ["tab"]}])
    r, g, b = _shot_colour(d)
    assert g > 150 and r < 60 and b < 60
    d.execute([{"type": "keypress", "keys": ["tab"]}])
    assert _shot_colour(d) != (r, g, b)
    assert abs(_shot_colour(d)[1] - view[1]) < 40


def test_tab_does_nothing_without_map_key(game):
    d, fake = game
    calls = len(fake.calls)
    d.execute([{"type": "keypress", "keys": ["tab"]}])
    assert not any(c[0] == "make_action" for c in fake.calls[calls:])


def test_execute_notes_unknown_key_and_accepts_forward(game):
    d, _ = game
    d.execute([{"type": "keypress", "keys": ["unknown"]}])
    assert d.action_note == "key refused: unknown, allowed: " + ", ".join(sorted(__import__("pt.doom", fromlist=["KEYS"]).KEYS))
    d.execute([{"type": "keypress", "keys": ["forward"]}])
    assert d.action_note == ""


@pytest.mark.parametrize("name", ["freedoom", "freedoom-clip", "freedoom-door"])
def test_doom_configs_offer_the_map(name):
    cfg = json.loads((Path(__file__).resolve().parents[1] / "games" / f"{name}.json").read_text(encoding="utf-8"))
    assert cfg.get("map_key") is True
    assert "tab opens or closes the map" in cfg["controls"]
    assert "when you are lost or a room is cleared, open the map" in cfg["controls"]
