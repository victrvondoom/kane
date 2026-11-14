"""The game hook: a config file for a web game, a small class for anything else. No browser here (a fake page stands in)."""
import json
import pytest
from pt import adapter as A


class FakePage:
    def __init__(self):
        self.log, self.frame = [], 0
        self.keyboard = self
        self.mouse = self

    def goto(self, url): self.log.append(("goto", url))
    def wait_for_function(self, js, **kw): self.log.append(("wait_for_function", js))
    def down(self, k): self.log.append(("down", k))
    def up(self, k): self.log.append(("up", k))
    def click(self, x, y): self.log.append(("click", x, y))
    def type(self, t): self.log.append(("type", t))
    def wait_for_timeout(self, ms): self.log.append(("wait_ms", ms))
    def screenshot(self, **kw): return b"jpeg"

    def evaluate(self, js, arg=None):
        self.log.append(("eval", js, arg))
        if "STATE" in js:
            return {"coins": 1}
        return None


CFG = {"type": "web", "name": "demo", "url": "file:///x/index.html", "url_query": {"bugs": "{bugs}"}, "viewport": {"width": 640, "height": 360},
       "ready_js": "window.__ready === true", "state_js": "window.STATE()", "frame_js": "window.__frame", "hold_frames": 15, "settle_frames": 4,
       "keys": {"left": "ArrowLeft", "right": "ArrowRight", "space": "Space"}, "controls": "Arrows move.", "goal": "Reach the flag.", "won_js": "window.__won"}


def test_config_validation():
    assert A.validate(CFG) == []
    assert "url" in " ".join(A.validate({"type": "web", "name": "x"}))
    assert "type" in " ".join(A.validate({"name": "x"}))


def test_url_with_query():
    assert A.build_url(CFG, bugs="1,2") == "file:///x/index.html?bugs=1%2C2"
    assert A.build_url({**CFG, "url_query": {}}, bugs="") == "file:///x/index.html"


def test_keys_are_mapped_and_held_by_frames():
    pg = FakePage()
    w = A.WebAdapter(CFG, page=pg, bugs="")
    w.execute([{"type": "keypress", "keys": ["right", "space", "e"]}])
    downs = [x[1] for x in pg.log if x[0] == "down"]
    assert downs == ["ArrowRight", "Space", "e"]
    assert any(x[0] == "eval" and "window.__frame" in x[1] for x in pg.log)      # held for a number of game frames


def test_unsupported_action_note_and_supported_actions_clear_it():
    w = A.WebAdapter(CFG, page=FakePage(), bugs="")
    w.execute([{"type": "swipe", "x": 1, "y": 2, "x2": 3, "y2": 4}])
    assert w.action_note == "action refused: swipe"
    w.execute([{"type": "screenshot"}, {"type": "click", "x": 1, "y": 2}])
    assert w.action_note == ""


def test_each_action_logs_its_frames_for_the_run_video():
    # the run video draws a key on the frames where it was really held, so the frames come from the run, not from a guess
    class Counting(FakePage):
        def evaluate(self, js, arg=None):
            if js == "window.__frame":
                return self.frame
            if arg is not None and "window.__frame" in js:
                self.frame += arg
            return super().evaluate(js, arg)

    pg = Counting()
    w = A.WebAdapter(CFG, page=pg, bugs="")
    w.execute([{"type": "keypress", "keys": ["right"]}, {"type": "wait", "ms": 100}, {"type": "keypress", "keys": ["space"]}])
    assert w.last_spans == [{"from": 0, "held_to": 15, "to": 19}, {"from": 19, "held_to": 25, "to": 25}, {"from": 25, "held_to": 40, "to": 44}]


def test_without_a_frame_counter_it_holds_by_time():
    cfg = {k: v for k, v in CFG.items() if k != "frame_js"}
    pg = FakePage()
    A.WebAdapter(cfg, page=pg, bugs="").execute([{"type": "keypress", "keys": ["left"]}])
    assert ("wait_ms", 250) in pg.log


def test_state_and_won_are_optional():
    pg = FakePage()
    w = A.WebAdapter(CFG, page=pg, bugs="")
    assert w.state() == {"coins": 1}
    w2 = A.WebAdapter({k: v for k, v in CFG.items() if k != "state_js"}, page=FakePage(), bugs="")
    assert w2.state() is None


def test_executed_actions_are_recorded_for_replay():
    w = A.WebAdapter(CFG, page=FakePage(), bugs="")
    w.execute([{"type": "wait", "ms": 500}])
    assert w.executed == [{"type": "wait", "ms": 500}]


def test_load_config_from_file(tmp_path):
    p = tmp_path / "g.json"; p.write_text(json.dumps(CFG))
    assert A.load_config(p)["name"] == "demo"
    p.write_text(json.dumps({"type": "web"}))
    with pytest.raises(ValueError):
        A.load_config(p)


def test_custom_adapter_needs_only_the_small_interface():
    class Mine(A.Adapter):
        name = "mine"; controls = "c"; goal = "g"
        def __init__(self): self.n = 0
        def screenshot(self): return b"x"
        def execute(self, actions): self.n += 1
        def close(self): pass
    m = Mine()
    assert m.state() is None and m.won() is None and m.bug_hits() is None


def test_serve_dir_serves_a_folder_on_localhost_only(tmp_path):
    import urllib.request
    (tmp_path / "index.html").write_text("<p>hi</p>")
    s = A.serve_dir(tmp_path)
    try:
        assert s.url.startswith("http://127.0.0.1:")
        assert urllib.request.urlopen(s.url + "index.html", timeout=5).read() == b"<p>hi</p>"
    finally:
        s.stop()


def test_config_with_serve_gets_its_url_from_the_server(tmp_path):
    (tmp_path / "index.html").write_text("x")
    cfg = {**CFG, "url": "", "serve": {"dir": str(tmp_path), "path": "index.html"}}
    pg = FakePage()
    w = A.WebAdapter(cfg, page=pg, bugs="")
    try:
        assert pg.log[0][0] == "goto" and pg.log[0][1].startswith("http://127.0.0.1:") and pg.log[0][1].endswith("/index.html")
    finally:
        w.close()


def test_validate_accepts_serve_instead_of_url():
    cfg = {"type": "web", "name": "m", "serve": {"dir": "x"}}
    assert A.validate(cfg) == []


def test_make_finds_a_private_config_in_games_local(tmp_path, monkeypatch):
    (tmp_path / "games.local").mkdir()
    (tmp_path / "games.local" / "mine.json").write_text(json.dumps({"type": "web", "name": "Mine", "url": "http://127.0.0.1:1/"}))
    monkeypatch.setattr(A, "ROOT", tmp_path)
    assert A.config_path("mine") == tmp_path / "games.local" / "mine.json"
    (tmp_path / "games").mkdir()
    (tmp_path / "games" / "pub.json").write_text("{}")
    assert A.config_path("pub") == tmp_path / "games" / "pub.json"


class ReloadPage(FakePage):
    """A page whose frame counter and bug flags start again when it reloads, like a real game page."""
    def __init__(self):
        super().__init__()
        self.frame, self.hits = 0, {"1": False, "2": False}

    def reload(self):
        self.log.append(("reload",))
        self.frame, self.hits = 0, {"1": False, "2": False}

    def evaluate(self, js, arg=None):
        self.log.append(("eval", js, arg))
        if js == "window.__frame":
            return self.frame
        if js == "window.__bugHit":
            return dict(self.hits)
        if arg is not None:
            self.frame += arg
        return None


def test_reload_starts_the_game_again_and_keeps_the_counts():
    pg = ReloadPage()
    w = A.WebAdapter({**CFG, "bug_js": "window.__bugHit"}, page=pg, bugs="")
    w.execute([{"type": "wait", "ms": 500}])
    pg.hits["2"] = True
    before = w.tick()
    w.execute([{"type": "reload"}])
    assert ("reload",) in pg.log
    assert [x for x in pg.log if x[0] == "wait_for_function"][-1] == ("wait_for_function", CFG["ready_js"])
    assert w.tick() > before                       # recorded frames never reuse a number
    assert w.bug_hits() == {"1": False, "2": True}   # what ran before the reload still counts
    assert w.executed[-1] == {"type": "reload"}      # kept for replay


class LockPage(FakePage):
    """A page that only moves when the harness steps it."""
    def __init__(self):
        super().__init__()
        self.frame, self.scripts = 0, []

    def add_init_script(self, js):
        self.scripts.append(js)

    def reload(self):
        self.frame = 0

    def wait_for_function(self, js, **kw):
        raise AssertionError("a locked page never waits on the clock")

    def evaluate(self, js, arg=None):
        self.log.append(("eval", js, arg))
        if "__ptStep" in js:
            self.frame += arg
            return True
        if js == CFG["ready_js"]:
            return self.frame >= 2
        if js == "window.__frame":
            return self.frame
        return None


def test_frame_lock_steps_the_game_only_on_the_harness_clock():
    pg = LockPage()
    w = A.WebAdapter({**CFG, "frame_lock": True}, page=pg, bugs="")
    assert pg.scripts and "requestAnimationFrame" in pg.scripts[0]
    assert pg.frame == 2                                  # stepped until the game said it was ready
    w.execute([{"type": "keypress", "keys": ["right"]}])
    assert pg.frame == 2 + 15 + 4                         # hold frames, then settle frames, nothing in between
    w.execute([{"type": "wait", "ms": 500}])
    assert pg.frame == 21 + 30
    w.execute([{"type": "reload"}])
    assert pg.frame >= 2


def test_no_frame_lock_unless_the_config_asks():
    pg = FakePage()
    pg.add_init_script = lambda js: pg.log.append(("init", js))
    A.WebAdapter(CFG, page=pg, bugs="")
    assert not [x for x in pg.log if x[0] == "init"]
