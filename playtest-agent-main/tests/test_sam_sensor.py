"""SAM uses fake clients and pages only."""
import json

import pytest

from metaclient.client import Record
from pt.adapter import WebAdapter, validate
from pt.judge import states_equal
from pt.sam_sensor import SamSensor, add_usage


class FakeClient:
    def __init__(self, records=None):
        self.calls = []
        self.records = records if records is not None else [Record(1, (10, 20, 30, 60), (640, 360), .9)]

    def sam_image(self, image, phrase, **kwargs):
        self.calls.append((image, phrase))
        return {"_records": {0: self.records}, "_cost_usd": .0025}


class FakePage:
    def __init__(self): self.frame = 0
    def goto(self, url): pass
    def screenshot(self, **kwargs): return f"frame{self.frame}".encode()
    def wait_for_timeout(self, ms): self.frame += 1
    def evaluate(self, js): return {"x": 7, "y": 9}


CFG = {"type": "web", "name": "fake", "url": "file:///fake", "sam_player": "the player character", "sam_every": 3}


def test_best_mask_and_no_mask():
    client = FakeClient([Record(2, (0, 0, 2, 2), (640, 360), .1), *FakeClient().records])
    assert SamSensor(client, "player").sense(b"frame") == {"x": 20, "y": 40, "w": 20, "h": 40, "found": True, "score": .9, "boxes": [[0, 0, 2, 2, .1], [10, 20, 30, 60, .9]]}
    assert SamSensor(FakeClient([]), "player").sense(b"empty") == {"x": None, "y": None, "w": 0, "h": 0, "found": False, "score": 0, "boxes": []}


def test_hash_cache(tmp_path):
    client = FakeClient()
    sensor = SamSensor(client, "player", cache_dir=tmp_path)
    sensor.sense(b"same")["x"] = -1
    assert sensor.sense(b"same")["x"] == 20
    assert SamSensor(client, "player", cache_dir=tmp_path).sense(b"same")["x"] == 20
    assert len(client.calls) == 1
    SamSensor(client, "enemy", cache_dir=tmp_path).sense(b"same")
    assert len(client.calls) == 2


def test_every_three_steps():
    client, page = FakeClient(), FakePage()
    driver = WebAdapter(CFG, page=page, sam_client=client)
    stale = []
    for step in range(7):
        state = driver.state()
        assert driver.state() == state
        stale.append(state["stale"])
        driver.execute([{"type": "wait", "ms": 1}])
    assert [image for image, _ in client.calls] == [b"frame0", b"frame3", b"frame6"]
    assert stale == [False, True, True, False, True, True, False]


def test_state_hook_wins():
    client = FakeClient()
    driver = WebAdapter({**CFG, "state_js": "state"}, page=FakePage(), sam_client=client)
    assert driver.state() == {"x": 7, "y": 9}
    assert client.calls == []


@pytest.mark.parametrize("every", [0, -1, 1.5, True, "3"])
def test_invalid_frequency(every):
    assert any("sam_every" in err for err in validate({**CFG, "sam_every": every}))


def test_valid_config():
    assert validate(CFG) == []


def test_replay_tolerance():
    first = SamSensor(FakeClient(), "player").sense(b"one")
    second = {**first, "x": first["x"] + 2, "y": first["y"] - 2}
    assert states_equal(first, second)
    assert not states_equal(first, {**second, "x": first["x"] + 3})


def test_usage_and_report(tmp_path):
    from pt.report import build
    driver = WebAdapter(CFG, page=FakePage(), sam_client=FakeClient())
    driver.state()
    result = {"cost_usd": .1}
    add_usage(result, driver)
    assert result["sam"]["calls"] == 1
    assert result["sam"]["cost_usd"] == .0025
    assert result["cost_usd"] == .1025
    (tmp_path / "result.json").write_text(json.dumps(result), encoding="utf-8")
    assert "position from SAM" in build(tmp_path)


def test_screenshots_sample_even_without_state_text():
    client = FakeClient()
    driver = WebAdapter(CFG, page=FakePage(), sam_client=client)
    for step in range(7):
        driver.screenshot()
        driver.execute([{"type": "wait", "ms": 1}])
    assert [image for image, _ in client.calls] == [b"frame0", b"frame3", b"frame6"]


def test_replay_copies_share_cache(monkeypatch):
    from pt import adapter
    client = FakeClient()
    driver = WebAdapter(CFG, page=FakePage(), sam_client=client)
    first = driver.state()
    real = adapter.WebAdapter
    monkeypatch.setattr(adapter, "WebAdapter", lambda cfg, **kwargs: real(cfg, page=FakePage(), **kwargs))
    replay = driver.fresh()
    assert replay.state() == first
    assert len(client.calls) == 1


def test_invalid_box_is_missing():
    records = [Record(1, (30, 20, 10, 60), (640, 360), .9)]
    assert SamSensor(FakeClient(records), "player").sense(b"frame")["found"] is False


def test_phone_uses_same_sensor_without_device():
    from pt.android import AndroidAdapter
    from pt.sam_sensor import configure
    phone = AndroidAdapter.__new__(AndroidAdapter)
    phone.cfg = CFG
    phone.screenshot = lambda: b"phone"
    client = FakeClient()
    configure(phone, client)
    assert phone.state()["x"] == 20
    assert len(client.calls) == 1


def test_check_without_apply_never_creates_client(capsys):
    from tools.sam_check import main
    def forbidden():
        raise AssertionError("dry run created a client")
    assert main([], client_factory=forbidden) == 0
    assert "No call made" in capsys.readouterr().out


def test_check_makes_one_fake_call(tmp_path, capsys):
    from tools.sam_check import main
    frame, truth = tmp_path / "frame.jpg", tmp_path / "state.json"
    frame.write_bytes(b"saved")
    truth.write_text('{"x": 20, "y": 40}', encoding="utf-8")
    client = FakeClient()
    assert main(["--apply", "--frame", str(frame), "--state", str(truth)], client_factory=lambda: client) == 0
    assert len(client.calls) == 1
    assert json.loads(capsys.readouterr().out)["true_state"] == {"x": 20, "y": 40}


def test_make_passes_client_and_config_only_enables_sam_without_state(monkeypatch):
    from pt import adapter
    real = adapter.WebAdapter
    monkeypatch.setattr(real, "_load", lambda self: None)
    monkeypatch.setattr(adapter, "WebAdapter", lambda cfg, **kw: real(cfg, page=FakePage(), **kw))
    client = FakeClient()
    driver = adapter.make("cave-courier-sam", sam_client=client)
    assert driver._sam_sensor.client is client
    assert driver.cfg["sam_player"] == "the small white player block"
    assert driver.cfg["sam_every"] == 3
    assert driver._sam_sensor.size == (14, 24)
    original = adapter.load_config(adapter.config_path("cave-courier"))
    assert {k: v for k, v in driver.cfg.items() if k not in ("sam_player", "sam_every", "sam_player_size")} == {
        k: v for k, v in original.items() if k != "state_js"}
    assert not hasattr(adapter.make("cave-courier", sam_client=client), "_sam_sensor")


def test_make_passes_sam_client_to_android(monkeypatch):
    from pt import adapter, android
    from pt.sam_sensor import configure
    cfg = {**CFG, "type": "android", "package": "fake"}
    monkeypatch.setattr(adapter, "load_config", lambda path: cfg)
    class Phone:
        def __init__(self, cfg, sam_client=None):
            self.cfg = cfg
            configure(self, sam_client)
    monkeypatch.setattr(android, "AndroidAdapter", Phone)
    client = FakeClient()
    assert adapter.make("phone", sam_client=client)._sam_sensor.client is client


@pytest.mark.parametrize("kind", ["goal", "hunt"])
def test_cli_sam_usage_saved_once_with_same_client(kind, monkeypatch, tmp_path):
    from pt import adapter, cli, guard, loop
    from trials import common
    client = FakeClient()
    clients = []
    made = []
    def load(*args):
        clients.append(client)
        return client
    def make(*args, sam_client=None, **kwargs):
        driver = WebAdapter(CFG, page=FakePage(), sam_client=sam_client)
        made.append(driver)
        driver.won, driver.bug_hits = lambda: False, lambda: None
        return driver
    def episode(run_client, driver, goal, **kwargs):
        assert run_client is client
        assert driver._sam_sensor.client is run_client
        driver.screenshot()
        driver.state()
        return {"stop": "steps", "cost_usd": .1}
    monkeypatch.setattr(cli, "ROOT", tmp_path)
    monkeypatch.setattr(adapter, "make", make)
    monkeypatch.setattr(common, "load_client", load)
    monkeypatch.setattr(guard, "problems", lambda *args: [])
    monkeypatch.setattr(guard, "take_lock", lambda: None)
    monkeypatch.setattr(guard, "release_lock", lambda: None)
    monkeypatch.setattr(loop, "run_episode", episode)
    assert cli.main([kind, "sam-run", "--game", "cave-courier-sam"]) == 0
    result = json.loads((tmp_path / "data/runs/sam-run/result.json").read_text(encoding="utf-8"))
    assert clients == [client]
    assert made[0]._sam_sensor.cache_dir == tmp_path / "data/runs/sam-run/sam_cache"
    assert result["sam"]["calls"] == len(client.calls) == 1
    assert result["position_source"] == "sam"
    assert result["cost_usd"] == .1025


def test_check_dry_run_reports_aligned_h12_files(monkeypatch, tmp_path, capsys):
    from tools import sam_check
    folder = tmp_path / "data/runs/h12"
    folder.mkdir(parents=True)
    frame = folder / "s002.jpg"
    frame.write_bytes(b"saved")
    result = folder / "result.json"
    result.write_text(json.dumps({"game_id": "cave-courier", "final_state": {"x": 20, "y": 40},
                                  "final_tick": 42, "log": [{"step": 2, "shot_tick": 42}]}), encoding="utf-8")
    monkeypatch.setattr(sam_check, "ROOT", tmp_path)
    assert sam_check.main([], client_factory=lambda: pytest.fail("no client in dry run")) == 0
    output = capsys.readouterr().out
    assert str(frame) in output and str(result) in output
    assert "No call made" in output


def test_check_missing_h12_asks_for_files(monkeypatch, tmp_path, capsys):
    from tools import sam_check
    monkeypatch.setattr(sam_check, "ROOT", tmp_path)
    assert sam_check.main([], client_factory=lambda: pytest.fail("no client in dry run")) == 0
    assert "--frame" in capsys.readouterr().out


def test_cli_confirm_replays_share_sensor(monkeypatch, tmp_path):
    from pt import adapter, cli, confirm, guard
    from trials import common
    (tmp_path / "result.json").write_text('{"game_id": "cave-courier-sam"}', encoding="utf-8")
    client = FakeClient()
    def make(*args, sam_client=None, **kwargs):
        return WebAdapter(CFG, page=FakePage(), sam_client=sam_client)
    def confirm_run(folder, run_client, driver_cls, **kwargs):
        first, second = driver_cls(), driver_cls()
        assert first._sam_sensor is second._sam_sensor
        assert first.state() == second.state()
        assert len(client.calls) == 1
        return []
    monkeypatch.setattr(adapter, "make", make)
    monkeypatch.setattr(common, "load_client", lambda *args: client)
    monkeypatch.setattr(guard, "problems", lambda *args: [])
    monkeypatch.setattr(guard, "take_lock", lambda: None)
    monkeypatch.setattr(guard, "release_lock", lambda: None)
    monkeypatch.setattr(confirm, "confirm_run", confirm_run)
    assert cli.main(["confirm", str(tmp_path)]) == 0


def test_reads_track_cache_and_usage(tmp_path):
    client = FakeClient()
    sensor = SamSensor(client, "player", cache_dir=tmp_path)
    sensor.sense(b"same")
    sensor.sense(b"same")
    assert len(sensor.reads) == 2
    assert sensor.reads[1]["cached"] is True
    driver = WebAdapter(CFG, page=FakePage(), sam_client=client)
    driver._sam_sensor = sensor
    result = {}
    add_usage(result, driver)
    assert result["sam"]["reads"] == sensor.reads
    assert result["sam"]["found"] == 2


def test_check_phrase_option(tmp_path, capsys):
    from tools.sam_check import main
    frame, truth = tmp_path / "frame.jpg", tmp_path / "state.json"
    frame.write_bytes(b"saved")
    truth.write_text('{"x": 20, "y": 40}', encoding="utf-8")
    client = FakeClient()
    assert main(["--apply", "--phrase", "the courier", "--frame", str(frame), "--state", str(truth)],
                client_factory=lambda: client) == 0
    assert client.calls[0][1] == "the courier"
    assert json.loads(capsys.readouterr().out)["phrase"] == "the courier"


def test_cli_sam_cache_folder_with_none_name(monkeypatch, tmp_path):
    from types import SimpleNamespace
    from pt import cli
    driver = WebAdapter(CFG, page=FakePage(), sam_client=FakeClient())
    monkeypatch.setattr(cli, "ROOT", tmp_path)
    cli._set_sam_cache_dir(driver, SimpleNamespace(name=None, folder="data/runs/x"))
    assert driver._sam_sensor.cache_dir == tmp_path / "data/runs/x/sam_cache"


def test_cli_sam_cache_without_name_or_folder(monkeypatch, tmp_path):
    from types import SimpleNamespace
    from pt import cli
    driver = WebAdapter(CFG, page=FakePage(), sam_client=FakeClient())
    monkeypatch.setattr(cli, "ROOT", tmp_path)
    cli._set_sam_cache_dir(driver, SimpleNamespace(name=None))
    assert driver._sam_sensor.cache_dir is None


def test_size_filter_rejects_s000_ledge():
    client = FakeClient([Record(1, (0, 0, 80, 9), (640, 360), .99)])
    state = SamSensor(client, "player", size=[14, 24]).sense(b"s000")
    assert state["found"] is False and state["rejected"] == 1


def test_size_filter_picks_fitting_block_and_keeps_all_boxes():
    records = [Record(1, (0, 0, 80, 9), (640, 360), .9),
               Record(2, (10, 10, 25, 33), (640, 360), .4)]
    state = SamSensor(FakeClient(records), "player", size=[14, 24]).sense(b"frame")
    assert (state["x"], state["y"], state["w"], state["h"]) == (17.5, 21.5, 15, 23)
    assert state["boxes"] == [[0, 0, 80, 9, .9], [10, 10, 25, 33, .4]]


def test_size_cache_key_changes_but_default_key_stays_legacy(tmp_path):
    client = FakeClient()
    SamSensor(client, "player", cache_dir=tmp_path).sense(b"same")
    assert len(list(tmp_path.glob("*.json"))) == 1
    SamSensor(client, "player", cache_dir=tmp_path, size=[14, 24]).sense(b"same")
    assert len(list(tmp_path.glob("*.json"))) == 2


def test_usage_reports_size_filter_and_rejections():
    cfg = {**CFG, "sam_player_size": [14, 24]}
    driver = WebAdapter(cfg, page=FakePage(), sam_client=FakeClient([
        Record(1, (0, 0, 80, 9), (640, 360), .99)]))
    driver.state()
    result = {}
    add_usage(result, driver)
    assert result["sam"]["size_filter"] == {
        "size": [14, 24], "tolerance": 2.0, "tuned_on": "frame s000 of i8b-sam-proof"}
    assert result["sam"]["rejected"] == 1
