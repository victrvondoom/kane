import io
import subprocess

import pytest
from PIL import Image

from pt import adapter as A


CFG = {"type": "android", "name": "demo", "package": "com.example.game", "serial": "emulator-5620",
       "controls": "Click and swipe.", "goal": "Reach the flag."}


class FakeAdb:
    def __init__(self):
        self.calls = []
        self.png = io.BytesIO()
        Image.new("RGB", (1080, 2400), "red").save(self.png, format="PNG")

    def run(self, *args, timeout=30):
        self.calls.append(args)
        return self.png.getvalue() if args == ("exec-out", "screencap", "-p") else b""


@pytest.fixture
def phone(monkeypatch):
    from pt import android as D
    sleeps = []
    monkeypatch.setattr(D.time, "sleep", sleeps.append)
    adb = FakeAdb()
    return D.AndroidAdapter(CFG, adb=adb), adb, sleeps


@pytest.mark.parametrize("clear", [False, True])
def test_launch_order(monkeypatch, clear):
    from pt import android as D
    sleeps = []
    monkeypatch.setattr(D.time, "sleep", sleeps.append)
    adb = FakeAdb()
    d = D.AndroidAdapter({**CFG, "clear_data": clear, "launch_wait_s": 2}, adb=adb)
    expected = [("shell", "am", "force-stop", CFG["package"])]
    if clear:
        expected.append(("shell", "pm", "clear", CFG["package"]))
    expected.append(("shell", "monkey", "-p", CFG["package"], "-c", "android.intent.category.LAUNCHER", "1"))
    assert adb.calls == expected
    assert sleeps == [2]
    assert (d.name, d.controls, d.goal) == (CFG["name"], CFG["controls"], CFG["goal"])


def test_screenshot_and_scaled_tap(phone):
    d, adb, sleeps = phone
    shot = d.screenshot()
    with Image.open(io.BytesIO(shot)) as im:
        assert im.format == "JPEG" and im.size == (540, 1200)
    assert adb.calls[-1] == ("exec-out", "screencap", "-p")
    d.execute([{"type": "click", "x": 270, "y": 600}])
    assert adb.calls[-1] == ("shell", "input", "tap", "540", "1200")
    assert sleeps == [6]


def test_swipes_and_clamping(phone):
    d, adb, _ = phone
    d.screenshot()
    d.execute([{"type": "click", "x": -5, "y": 9000},
               {"type": "swipe", "x": 10, "y": 20, "x2": 30, "y2": 40},
               {"type": "swipe", "x": -1, "y": -1, "x2": 9999, "y2": 9999, "ms": 450}])
    assert adb.calls[-3:] == [("shell", "input", "tap", "0", "2398"),
                             ("shell", "input", "swipe", "20", "40", "60", "80", "300"),
                             ("shell", "input", "swipe", "0", "0", "1078", "2398", "450")]


def test_custom_shot_width(phone):
    d, adb, _ = phone
    d.shot_width = 270
    assert Image.open(io.BytesIO(d.screenshot())).size == (270, 600)
    d.execute([{"type": "click", "x": 135, "y": 300}])
    assert adb.calls[-1] == ("shell", "input", "tap", "540", "1200")


def test_keys_wait_and_recording(phone):
    d, adb, sleeps = phone
    actions = [{"type": "keypress", "keys": ["back", "home", "enter"]}, {"type": "wait", "ms": 250},
               {"type": "screenshot"}, {"type": "unknown"}]
    n = len(adb.calls)
    d.execute(actions)
    assert d.action_note == "; ".join(["action refused: screenshot", "action refused: unknown"])
    assert adb.calls[n:] == [("shell", "input", "keyevent", "KEYCODE_" + key) for key in ("BACK", "HOME", "ENTER")]
    assert sleeps == [6, 0.25]
    assert d.executed == actions
    assert d.state() is None and d.won() is None and d.bug_hits() is None
    with pytest.raises(NotImplementedError, match="a phone game cannot be replayed from here"):
        d.fresh()
    d.close()
    assert len(adb.calls) == n + 3


def test_adb_runner_and_timeouts(monkeypatch):
    from pt.android import Adb
    monkeypatch.delenv("ANDROID_HOME", raising=False)
    monkeypatch.delenv("LOCALAPPDATA", raising=False)
    calls = []

    def runner(args, timeout):
        calls.append((args, timeout))
        return b"ok"

    adb = Adb("emulator-5620", 25037, runner=runner)
    assert adb.run("shell", "echo", "hello") == b"ok"
    adb.run("shell", "true", timeout=4)
    assert calls == [(["adb", "-s", "emulator-5620", "shell", "echo", "hello"], 30),
                     (["adb", "-s", "emulator-5620", "shell", "true"], 4)]


@pytest.mark.parametrize("source", ["ANDROID_HOME", "LOCALAPPDATA", "PATH"])
def test_adb_path_and_environment(monkeypatch, tmp_path, source):
    from pt import android as D
    monkeypatch.delenv("ANDROID_HOME", raising=False)
    monkeypatch.delenv("LOCALAPPDATA", raising=False)
    exe = tmp_path / "platform-tools" / "adb.exe"
    if source == "LOCALAPPDATA":
        exe = tmp_path / "Android" / "Sdk" / "platform-tools" / "adb.exe"
    if source != "PATH":
        exe.parent.mkdir(parents=True)
        exe.touch()
        monkeypatch.setenv(source, str(tmp_path))
    monkeypatch.setenv("ANDROID_ADB_SERVER_PORT", "5037")
    calls = []

    def run(args, **kw):
        calls.append((args, kw))
        return subprocess.CompletedProcess(args, 0, stdout=b"ok", stderr=b"")

    monkeypatch.setattr(D.subprocess, "run", run)
    assert D.Adb("emulator-5620", 25037).run("devices", timeout=5) == b"ok"
    args, kw = calls[0]
    assert args == [str(exe) if source != "PATH" else "adb", "-s", "emulator-5620", "devices"]
    assert kw["env"]["ANDROID_ADB_SERVER_PORT"] == "25037"
    assert kw["timeout"] == 5


@pytest.mark.parametrize("error", [subprocess.CalledProcessError(1, "adb", stderr=b"x" * 250),
                                  subprocess.TimeoutExpired("adb", 30, stderr=b"x" * 250)])
def test_adb_failures(error):
    from pt.android import Adb

    def runner(args, timeout):
        raise error

    with pytest.raises(RuntimeError) as caught:
        Adb("emulator-5620", 25037, runner=runner).run("shell", "true")
    assert str(caught.value) == "x" * 200


def test_android_config_validation():
    assert A.validate(CFG) == []
    assert A.validate({"type": "android"}) == ["name is missing", "package is missing"]
    assert "type" in " ".join(A.validate({**CFG, "type": "other"}))


@pytest.mark.parametrize("kind", ["android", "web"])
def test_make_dispatch(tmp_path, monkeypatch, kind):
    import json
    from pt import android as D
    cfg = CFG if kind == "android" else {"type": "web", "name": "demo", "url": "http://example.test"}
    path = tmp_path / "game.json"
    path.write_text(json.dumps(cfg))
    monkeypatch.setattr(A, "config_path", lambda name: path)
    calls = []

    def factory(config, **kw):
        calls.append((config, kw))
        return "opened"

    monkeypatch.setattr(D if kind == "android" else A, "AndroidAdapter" if kind == "android" else "WebAdapter", factory)
    assert A.make("demo", bugs="1", debug=True) == "opened"
    assert calls == [(cfg, {} if kind == "android" else {"bugs": "1", "debug": True})]


def test_setup_order_device_pixels_and_sleep(monkeypatch):
    from pt import android as D
    adb, order = FakeAdb(), []
    original = adb.run
    def run(*args):
        order.append(args)
        return original(*args)
    adb.run = run
    steps = [{"tap": [800, 1800]}, {"swipe": [10, 20, 900, 2100, 450]},
             {"key": "back"}, {"wait": 250}]
    d = D.AndroidAdapter({**CFG, "clear_data": True, "launch_wait_s": 2, "setup": steps},
                         adb=adb, sleep=lambda seconds: order.append(seconds))
    assert order[1] == ("shell", "pm", "clear", CFG["package"])
    assert order[3:] == [2, ("shell", "input", "tap", "800", "1800"),
                         ("shell", "input", "swipe", "10", "20", "900", "2100", "450"),
                         ("shell", "input", "keyevent", "KEYCODE_BACK"), .25]
    assert d.setup_log == steps
    assert d.executed == []


def test_each_action_logs_its_wall_clock_span_for_the_run_video():
    from pt import android as D
    ticks = iter([10.0, 10.2, 11.0, 11.5])
    d = D.AndroidAdapter(CFG, adb=FakeAdb(), sleep=lambda s: None, clock=lambda: next(ticks))
    d.execute([{"type": "click", "x": 5, "y": 5}, {"type": "wait", "ms": 500}])
    assert d.last_spans == [{"from_s": 10.0, "to_s": 10.2}, {"from_s": 11.0, "to_s": 11.5}]
