import json
from pathlib import Path

import pytest


def fixture_run(tmp_path, step=2):
    run = tmp_path / "run"
    run.mkdir()
    (run / "result.json").write_text(json.dumps({
        "actions_by_step": [[{"type": "click", "x": 100, "y": 200}] for _ in range(4)],
        "reports": [{"title": "A capture", "step": step}],
    }))
    return run


class FakePage:
    def __init__(self, fail=False):
        self.actions = []
        self.closed = False
        self.fail = fail
        self.mouse = self
        self.keyboard = self
    def goto(self, url):
        if self.fail: raise RuntimeError("page failed")
    def wait_for_function(self, script): pass
    def mouse_click(self, x, y): self.actions.append((x, y))
    def click(self, x, y): self.mouse_click(x, y)
    def press(self, key): pass
    def wheel(self, x, y): pass
    def screenshot(self, path): Path(path).write_bytes(b"still")
    def evaluate(self, script): return {"moves": list(self.actions)}
    def wait_for_timeout(self, ms): pass
    def close(self): self.closed = True


def test_replays_only_actions_through_report_step(tmp_path):
    from tools.capture_chess import capture
    page = FakePage()
    capture(fixture_run(tmp_path), 0, tmp_path / "out", memory_reader=lambda: 9_000_000_000,
            browser_factory=lambda **kw: page, server_factory=lambda *a: "url")
    assert page.actions == [(100, 200), (100, 200)]
    assert (tmp_path / "out" / "step-0002.json").is_file()


def test_fixed_build_edits_copy_only(tmp_path, monkeypatch):
    from tools.capture_chess import prepare_build
    import tools.capture_chess as capture_module
    source = tmp_path / "source"
    (source / "src").mkdir(parents=True)
    (source / "src" / "game.js").write_text("old")
    fix = tmp_path / "fix.json"
    fix.write_text(json.dumps({"attempts": [{"edits": {"src/game.js": [{"search": "old", "replace": "new"}]}}]}))
    monkeypatch.setattr(capture_module, "SOURCE", source)
    made = prepare_build(fix, tmp_path / "buildtemp", build_runner=lambda src, out: out.mkdir(parents=True))
    assert (made.source / "src/game.js").read_text() == "new"
    assert (source / "src/game.js").read_text() == "old"


def test_low_memory_waits_then_returns_two(tmp_path, monkeypatch):
    from tools.capture_chess import capture
    import tools.capture_chess as capture_module
    monkeypatch.setattr(capture_module, "WAIT_LIMIT", 2)
    waits = []
    assert capture(fixture_run(tmp_path), 0, tmp_path / "out", memory_reader=lambda: 1,
                   sleep=waits.append) == 2
    assert waits == [2]


def test_browser_closes_on_error(tmp_path):
    from tools.capture_chess import capture
    page = FakePage(fail=True)
    with pytest.raises(RuntimeError):
        capture(fixture_run(tmp_path), 0, tmp_path / "out", memory_reader=lambda: 9_000_000_000,
                browser_factory=lambda **kw: page, server_factory=lambda *a: "url")
    assert page.closed


@pytest.mark.browser
def test_chess_capture_browser_smoke(tmp_path):
    import os
    if os.environ.get("PT_BROWSER_TESTS") != "1":
        pytest.skip("set PT_BROWSER_TESTS=1 to run the browser capture test")
    from tools.capture_chess import DIST
    if not DIST.is_dir():
        pytest.skip("build games.cache/react-chess/dist before the browser smoke")
    from tools.capture_chess import capture
    run = fixture_run(tmp_path)
    assert capture(run, 0, tmp_path / "browser-out") == 0
    assert (tmp_path / "browser-out" / "capture.json").is_file()


