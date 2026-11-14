"""HUD contrast measurements on synthetic saved frames, without a browser."""
import json

import pytest
from PIL import Image

from pt import cli


def test_wcag_ratios():
    from pt.contrast import contrast_ratio
    assert contrast_ratio((0, 0, 0), (255, 255, 255)) == pytest.approx(21.0)
    assert contrast_ratio((91, 63, 10), (91, 63, 10)) == pytest.approx(1.0)
    # ((128/255+.055)/1.055)^2.4=.2158605; for 32, .01444384.
    assert contrast_ratio((128, 128, 128), (32, 32, 32)) == pytest.approx(4.12546, abs=.00001)


def test_split_pixels_uses_mean_colours():
    from pt.contrast import box_contrast
    im = Image.new("RGB", (10, 10), (32, 32, 32))
    for x in range(3):
        for y in range(10):
            im.putpixel((x, y), (128, 128, 128))
    assert box_contrast(im, [0, 0, 10, 10]) == pytest.approx(4.12546, abs=.00001)
    assert box_contrast(Image.new("RGB", (10, 10), "white"), [0, 0, 10, 10]) == 1.0


def test_contrast_cli_writes_worst_frame_per_box(tmp_path, monkeypatch, capsys):
    from pt import adapter
    config = tmp_path / "fake.json"
    config.write_text(json.dumps({"type": "web", "name": "fake", "url": "unused", "hud_boxes": [[0, 0, 10, 10], [10, 0, 10, 10]]}))
    monkeypatch.setattr(adapter, "config_path", lambda game: config)
    (tmp_path / "result.json").write_text(json.dumps({"game_id": "fake"}))
    for index, colour in enumerate([255, 128]):
        im = Image.new("RGB", (20, 10), (32, 32, 32))
        for x in range(3):
            for y in range(10):
                im.putpixel((x, y), (colour,) * 3)
        im.save(tmp_path / f"s{index:03d}.jpg", format="PNG")
    assert cli.main(["contrast", str(tmp_path)]) == 0
    result = json.loads((tmp_path / "contrast.json").read_text())
    assert result["game_id"] == "fake"
    assert result["frames"] == 2
    assert result["boxes"][0] == {"box": [0, 0, 10, 10], "ratio": 4.12546, "frame": "s001.jpg", "aa_normal": "fail", "aa_large": "pass"}
    assert result["boxes"][1]["ratio"] == 1.0
    assert "2 frames" in capsys.readouterr().out
    assert cli.main(["contrast", str(tmp_path), "--game", "override"]) == 0
    assert json.loads((tmp_path / "contrast.json").read_text())["game_id"] == "override"


def test_no_frames_is_an_error(tmp_path):
    from pt.contrast import check_run
    with pytest.raises(ValueError, match="frames"):
        check_run(tmp_path)


def test_no_boxes_is_an_error_and_cli_avoids_client_and_guard(tmp_path, monkeypatch, capsys):
    from pt import adapter, guard
    from trials import common
    config = tmp_path / "fake.json"
    config.write_text(json.dumps({"type": "web", "name": "fake", "url": "unused"}))
    monkeypatch.setattr(adapter, "config_path", lambda game: config)
    def forbidden(*a, **kw):
        pytest.fail("contrast must not open a game, check the PC or load a client")
    monkeypatch.setattr(adapter, "make", forbidden)
    monkeypatch.setattr(common, "load_client", forbidden)
    monkeypatch.setattr(guard, "problems", forbidden)
    Image.new("RGB", (10, 10)).save(tmp_path / "s000.jpg")
    assert cli.main(["contrast", str(tmp_path)]) == 1
    assert "No hud_boxes" in capsys.readouterr().out


@pytest.mark.parametrize("box", [[-1, 0, 2, 2], [0, 0, 0, 2], [0, 0, 20, 20], [0.5, 0, 2, 2], [0, 0, 2]])
def test_bad_boxes_are_rejected(box):
    from pt.contrast import box_contrast
    with pytest.raises(ValueError, match="HUD box"):
        box_contrast(Image.new("RGB", (10, 10)), box)


def test_contrast_includes_intermediate_recorded_frames(tmp_path, monkeypatch):
    from pt import adapter
    from pt.contrast import check_run
    config = tmp_path / "fake.json"
    config.write_text(json.dumps({"type": "web", "name": "fake", "url": "unused",
                                  "hud_boxes": [[0, 0, 10, 10]]}))
    monkeypatch.setattr(adapter, "config_path", lambda game: config)
    image = Image.new("RGB", (10, 10), "white")
    for x in range(3):
        for y in range(10):
            image.putpixel((x, y), (0, 0, 0))
    image.save(tmp_path / "s000.jpg", format="PNG")
    (tmp_path / "frames").mkdir()
    Image.new("RGB", (10, 10), "white").save(tmp_path / "frames/f00000001.jpg")
    result = check_run(tmp_path)
    assert result["frames"] == 2
    assert result["boxes"][0]["frame"] == "frames/f00000001.jpg"
    assert result["boxes"][0]["ratio"] == 1.0
