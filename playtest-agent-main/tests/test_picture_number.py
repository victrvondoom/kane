import io
import json
from types import SimpleNamespace

import pytest
from PIL import Image, ImageDraw


def _digit(path, shape, background=(20, 25, 30)):
    image = Image.new("RGB", (20, 30), background)
    draw = ImageDraw.Draw(image)
    for x, y, width, height in shape:
        draw.rectangle((x, y, x + width - 1, y + height - 1), fill="white")
    image.save(path)
    return image


ONE = [(8, 2, 4, 26), (4, 5, 4, 4)]
TWO = [(3, 3, 14, 4), (13, 5, 4, 8), (3, 13, 14, 4), (3, 15, 4, 8), (3, 23, 14, 4)]


def _setup(tmp_path):
    refs = tmp_path / "refs"
    refs.mkdir()
    _digit(refs / "9.png", ONE)
    _digit(refs / "8.png", TWO)
    frame = Image.new("RGB", (80, 60), (15, 20, 25))
    draw = ImageDraw.Draw(frame)
    for x, y, w, h in ONE:
        draw.rectangle((39 + x, 20 + y, 39 + x + w - 1, 20 + y + h - 1), fill="white")
    # Irregular dark noise must not become mask pixels.
    for x in range(80):
        for y in range(60):
            if (x * 13 + y * 7) % 17 == 0 and frame.getpixel((x, y)) != (255, 255, 255):
                frame.putpixel((x, y), (80, 90, 100))
    path = tmp_path / "frame.png"
    frame.save(path)
    return refs, path


def _match(tmp_path, frame, refs, expected="9", region="0,0,80,60", **options):
    from tools.picture_number import main
    options.setdefault("scale_from", 80)
    return main(["--frame", str(frame), "--refs", str(refs), "--region", region,
                 "--expected", expected, *sum(([f"--{key.replace('_', '-')}", str(value)]
                                                for key, value in options.items()), [])])


def test_match_expected_with_noisy_background_and_shift(tmp_path, capsys):
    refs, frame = _setup(tmp_path)
    assert _match(tmp_path, frame, refs) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["read"] == "9"
    assert result["expected"] == "9"


def test_match_wrong_known_number_returns_one(tmp_path):
    refs, frame = _setup(tmp_path)
    assert _match(tmp_path, frame, refs, expected="8") == 1


def _red_setup(tmp_path):
    refs = tmp_path / "red_refs"
    refs.mkdir()
    for label, shape in (("9", ONE), ("8", TWO)):
        image = Image.new("RGB", (20, 30), (20, 20, 20))
        draw = ImageDraw.Draw(image)
        for x, y, w, h in shape:
            draw.rectangle((x, y, x + w - 1, y + h - 1), fill=(230, 35, 25))
        image.save(refs / f"{label}.png")
    frame = Image.new("RGB", (80, 60), (15, 20, 25))
    draw = ImageDraw.Draw(frame)
    for x, y, w, h in ONE:
        draw.rectangle((39 + x, 20 + y, 39 + x + w - 1, 20 + y + h - 1), fill=(230, 35, 25))
    path = tmp_path / "red.png"
    frame.save(path)
    return refs, path


def test_match_red_number_and_wrong_expected(tmp_path, capsys):
    refs, frame = _red_setup(tmp_path)
    assert _match(tmp_path, frame, refs, color="red") == 0
    assert json.loads(capsys.readouterr().out)["read"] == "9"
    assert _match(tmp_path, frame, refs, expected="8", color="red") == 1


def test_red_number_with_default_white_is_unreadable(tmp_path):
    refs, frame = _red_setup(tmp_path)
    assert _match(tmp_path, frame, refs) == 2


def test_blank_region_is_unreadable(tmp_path):
    refs, frame = _setup(tmp_path)
    assert _match(tmp_path, frame, refs, region="0,0,30,30") == 2


def test_near_tied_reference_scores_are_unreadable(tmp_path):
    refs, frame = _setup(tmp_path)
    (refs / "9.png").write_bytes((refs / "8.png").read_bytes())
    assert _match(tmp_path, frame, refs) == 2


def test_scales_1280_frame_and_region_from_1920(tmp_path):
    from tools.make_number_ref import main as make_ref
    refs = tmp_path / "refs"
    refs.mkdir()
    base = Image.new("RGB", (1920, 300), (0, 0, 0))
    draw = ImageDraw.Draw(base)
    for x, y, w, h in ONE:
        draw.rectangle((100 + x, 100 + y, 100 + x + w - 1, 100 + y + h - 1), fill="white")
    frame = tmp_path / "large.png"
    base.save(frame)
    assert make_ref(["--frame", str(frame), "--box", "100,100,20,30", "--label", "9", "--out", str(refs)]) == 0
    small = base.resize((1280, 200))
    small_path = tmp_path / "small.png"
    small.save(small_path)
    assert _match(tmp_path, small_path, refs, region="100,100,20,30", scale_from=1920) == 0


def test_missing_expected_reference_is_error(tmp_path):
    refs, frame = _setup(tmp_path)
    assert _match(tmp_path, frame, refs, expected="7") == 2


def test_make_ref_trims_and_refuses_overwrite_or_blank(tmp_path):
    from tools.make_number_ref import main
    frame = tmp_path / "frame.png"
    canvas = Image.new("RGB", (1920, 1080), (1, 2, 3))
    ImageDraw.Draw(canvas).rectangle((12, 14, 15, 20), fill="white")
    canvas.save(frame)
    out = tmp_path / "refs"
    args = ["--frame", str(frame), "--box", "5,5,20,20", "--label", "17", "--out", str(out)]
    assert main(args) == 0
    with Image.open(out / "17.png") as saved:
        assert saved.size == (6, 9)
    assert main(args) == 2
    assert main(["--frame", str(frame), "--box", "0,0,5,5", "--label", "8", "--out", str(out)]) == 2


def test_make_ref_red_color(tmp_path):
    from tools.make_number_ref import main
    frame = tmp_path / "red.png"
    canvas = Image.new("RGB", (1920, 100), (5, 5, 5))
    ImageDraw.Draw(canvas).rectangle((12, 14, 15, 20), fill=(230, 35, 25))
    canvas.save(frame)
    out = tmp_path / "red_refs"
    args = ["--frame", str(frame), "--box", "5,5,20,20", "--label", "17", "--out", str(out)]
    assert main(args + ["--color", "red"]) == 0
    with Image.open(out / "17.png") as saved:
        assert saved.size == (6, 9)
    assert main(args) == 2


class FakeDriver:
    def __init__(self, frame, alive=True):
        self.frame, self.alive = frame, alive
        self.closed = False

    def screenshot(self):
        stream = io.BytesIO()
        self.frame.save(stream, format="JPEG")
        return stream.getvalue()

    def execute(self, actions):
        pass

    def health(self):
        return {"alive": self.alive}

    def close(self):
        self.closed = True


def _normal_args(tmp_path, label="9"):
    refs, _ = _setup(tmp_path)
    game = tmp_path / "game.json"
    game.write_text(json.dumps({"type": "pcgame", "name": "fake"}), encoding="utf-8")
    actions = tmp_path / "actions.json"
    actions.write_text(json.dumps([[{"type": "wait", "frames": 1}]]), encoding="utf-8")
    out = tmp_path / "out"
    out.mkdir()
    return SimpleNamespace(game=str(game), actions=str(actions), refs=str(refs), region=(0, 0, 80, 60),
                           expected=label, out_dir=str(out), scale_from=80)


@pytest.mark.parametrize(("shown", "alive", "exists", "expected_code"), [
    ("2", True, False, 1), ("1", True, False, 0), ("blank", True, False, 2),
    ("1", False, False, 2), ("1", True, True, 2),
])
def test_fix_normal_check_fake_driver(tmp_path, shown, alive, exists, expected_code, capsys):
    from tools.fix_normal_check import run
    args = _normal_args(tmp_path)
    frame = Image.new("RGB", (80, 60), (10, 10, 10))
    if shown != "blank":
        shape = ONE if shown == "1" else TWO
        draw = ImageDraw.Draw(frame)
        for x, y, w, h in shape:
            draw.rectangle((30 + x, 15 + y, 30 + x + w - 1, 15 + y + h - 1), fill="white")
    if exists:
        (tmp_path / "out" / "normal-actions.jpg").write_bytes(b"reserved")
    assert run(args, driver_factory=lambda cfg: FakeDriver(frame, alive)) == expected_code


def test_fix_normal_check_passes_color_to_match(tmp_path, monkeypatch):
    import tools.fix_normal_check as normal_check
    args = _normal_args(tmp_path)
    args.color = "red"
    seen = {}
    def fake_match(*values, **options):
        seen["color"] = options.get("color")
        return {"read": "9"}, 0
    monkeypatch.setattr(normal_check, "match", fake_match)
    frame = Image.new("RGB", (80, 60), (20, 20, 20))
    ImageDraw.Draw(frame).rectangle((10, 10, 15, 15), fill=(230, 35, 25))
    assert normal_check.run(args, driver_factory=lambda cfg: FakeDriver(frame)) == 0
    assert seen["color"] == "red"
