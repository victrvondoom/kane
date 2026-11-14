"""Vision filters with fake games and model clients only."""
import base64
import io
import json

import numpy as np
import pytest
from PIL import Image

from pt import cli, loop
from test_loop import FakeClient, FakeDriver, act


def picture(colours):
    im = Image.new("RGB", (len(colours), 1))
    im.putdata(colours)
    out = io.BytesIO()
    im.save(out, format="PNG")
    return out.getvalue()


@pytest.mark.parametrize("mode,expected", [
    ("deuteranopia", [(163, 144, 0), (239, 214, 58), (0, 61, 251)]),
    ("protanopia", [(109, 95, 0), (255, 229, 0), (0, 89, 255)]),
    ("tritanopia", [(255, 0, 15), (0, 247, 217), (0, 107, 150)]),
])
def test_published_matrices(mode, expected):
    from pt.vision import filter_screenshot
    source = picture([(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 255), (0, 0, 0)])
    pixels = np.asarray(Image.open(io.BytesIO(filter_screenshot(source, mode))), dtype=float).reshape(-1, 3)
    # Allow two 8 bit levels for rounding and JPEG encoding.
    for actual, target in zip(pixels, expected + [(255, 255, 255), (0, 0, 0)]):
        assert actual == pytest.approx(target, abs=2)


def test_low_contrast_blends_sixty_percent_toward_mid_grey():
    from pt.vision import filter_screenshot
    pixels = np.asarray(Image.open(io.BytesIO(filter_screenshot(picture([(0, 0, 0), (255, 255, 255)]), "low-contrast"))), dtype=float).reshape(-1, 3)
    assert pixels[0] == pytest.approx((77, 77, 77), abs=1)
    assert pixels[1] == pytest.approx((179, 179, 179), abs=1)


@pytest.mark.parametrize("mode", ["normal", "deuteranopia", "protanopia", "tritanopia", "low-contrast"])
def test_every_model_image_matches_saved_frame_and_normal_prompt_is_unchanged(mode, tmp_path):
    from pt.vision import filter_screenshot
    class Driver(FakeDriver):
        controls = "arrows"

        def screenshot(self):
            return picture([(255, self.n * 70, 0)] * 8)

    driver = Driver()
    client = FakeClient([act([{"type": "wait"}]), []])
    loop.run_episode(client, driver, "Try", vision=mode,
                     on_step=lambda step, data: (tmp_path / f"s{step:03d}.jpg").write_bytes(data))
    for step, (body, _) in enumerate(client.bodies):
        img = body["input"][-1]["content"][-1]["image_url"]
        saved = (tmp_path / f"s{step:03d}.jpg").read_bytes()
        assert base64.b64decode(img.split(",")[1]) == saved
        original = picture([(255, step * 70, 0)] * 8)
        assert saved == filter_screenshot(original, mode)
        if mode == "normal":
            assert saved == original
            assert body["instructions"] == loop.SYSTEM.format(controls="arrows")
        else:
            assert saved != original
            assert 'Hard to see:' in body["instructions"]
            assert body["instructions"].startswith(loop.SYSTEM.format(controls="arrows") + "\n")


@pytest.mark.parametrize("kind", ["goal", "hunt"])
def test_cli_records_and_passes_vision(kind, tmp_path, monkeypatch, capsys):
    from pt import adapter, guard
    from trials import common
    driver = FakeDriver()
    driver.name, driver.goal = "Fake", "Try"
    driver.close, driver.won, driver.bug_hits = lambda: None, lambda: False, lambda: []
    monkeypatch.setattr(cli, "ROOT", tmp_path)
    monkeypatch.setattr(adapter, "make", lambda *a, **kw: driver)
    monkeypatch.setattr(common, "load_client", lambda *a: object())
    monkeypatch.setattr(guard, "problems", lambda *a: [])
    monkeypatch.setattr(guard, "take_lock", lambda: None)
    monkeypatch.setattr(guard, "release_lock", lambda: None)
    seen = {}
    def episode(*a, **kw):
        seen.update(kw)
        return {"stop": "steps"}
    monkeypatch.setattr(loop, "run_episode", episode)
    assert cli.parse([kind, "r"]).vision == "normal"
    assert cli.main([kind, "r", "--vision", "tritanopia"]) == 0
    result = json.loads((tmp_path / "data/runs/r/result.json").read_text())
    assert result["settings"]["vision"] == seen["vision"] == "tritanopia"
    assert "vision: tritanopia" in capsys.readouterr().out
    from pt import console, report
    assert "vision tritanopia" in report.build(tmp_path / "data/runs/r")
    assert "Vision: tritanopia" in console.build(tmp_path / "data/runs/r")


def test_invalid_mode_is_rejected_before_taking_a_screenshot():
    with pytest.raises(ValueError, match="Unknown vision"):
        loop.run_episode(FakeClient([[]]), FakeDriver(), "Try", vision="unknown")
    with pytest.raises(SystemExit):
        cli.parse(["goal", "r", "--vision", "unknown"])


@pytest.mark.parametrize("mode", ["normal", "deuteranopia", "low-contrast"])
def test_recorded_frames_are_filtered_once_without_a_browser(mode, tmp_path):
    from pt.adapter import WebAdapter
    from pt.vision import filter_screenshot

    original = picture([(255, 0, 0)] * 8)
    class Page:
        def screenshot(self, **kwargs):
            return original

    # Build only the recording path with a fake page; no browser is opened.
    driver = WebAdapter.__new__(WebAdapter)
    driver.page, driver.cfg = Page(), {}
    driver.controls, driver._recording = "arrows", tmp_path
    driver.tick = lambda: 0
    driver.state = lambda: {}
    driver.won = lambda: False
    def execute(actions):
        driver._save_frame()  # An intermediate frame, between model observations.
        driver.tick = lambda: 1
    driver.execute = execute
    client = FakeClient([act([{"type": "wait"}]), []])
    loop.run_episode(client, driver, "Try", vision=mode,
                     on_step=lambda step, data: (tmp_path / f"s{step:03d}.jpg").write_bytes(data))
    expected = filter_screenshot(original, mode)
    assert (tmp_path / "f00000000.jpg").read_bytes() == expected
    assert (tmp_path / "f00000001.jpg").read_bytes() == expected
    for step, (body, _) in enumerate(client.bodies):
        seen = base64.b64decode(body["input"][-1]["content"][-1]["image_url"].split(",")[1])
        assert seen == (tmp_path / f"s{step:03d}.jpg").read_bytes() == expected


@pytest.mark.parametrize("settings,expected", [({}, "normal"), ({"vision": "tritanopia"}, "tritanopia")])
def test_resume_keeps_saved_vision_and_defaults_old_runs_to_normal(settings, expected, tmp_path, monkeypatch):
    from pt import adapter, guard, replay
    from trials import common
    folder = tmp_path / "data/runs/resumed"
    folder.mkdir(parents=True)
    (folder / "result.json").write_text(json.dumps({"settings": settings, "game_id": "fake"}))
    driver = FakeDriver()
    driver.name, driver.goal = "Fake", "Try"
    driver.close, driver.won, driver.bug_hits = lambda: None, lambda: False, lambda: []
    monkeypatch.setattr(cli, "ROOT", tmp_path)
    monkeypatch.setattr(adapter, "make", lambda *a, **kw: driver)
    monkeypatch.setattr(common, "load_client", lambda *a: object())
    monkeypatch.setattr(guard, "problems", lambda *a: [])
    monkeypatch.setattr(guard, "take_lock", lambda: None)
    monkeypatch.setattr(guard, "release_lock", lambda: None)
    monkeypatch.setattr(replay, "restore", lambda *a: None)
    seen = {}
    def episode(*a, **kw):
        seen.update(kw)
        return {"stop": "steps"}
    monkeypatch.setattr(loop, "run_episode", episode)
    assert cli.main(["resume", "resumed", "--note", "Continue"]) == 0
    assert seen["vision"] == expected
    assert json.loads((folder / "result.json").read_text())["settings"]["vision"] == expected
