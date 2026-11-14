"""The death map: replay saved runs at $0, track the player, mark where a life ended. A fake driver stands in for the browser."""
import io
import json

from PIL import Image

from pt import deathmap


class FakeDriver:
    """Each action group moves the player to the next scripted state."""
    def __init__(self, states, size=(640, 360)):
        self.states, self.i, self.size, self.closed = list(states), -1, size, False

    def screenshot(self):
        buf = io.BytesIO()
        Image.new("RGB", self.size, (40, 40, 40)).save(buf, "JPEG")
        return buf.getvalue()

    def execute(self, acts):
        self.i += 1

    def state(self):
        return self.states[self.i] if 0 <= self.i < len(self.states) else self.states[0]

    def close(self):
        self.closed = True


def test_track_reads_the_position_after_every_step():
    d = FakeDriver([{"x": 90, "y": 226}, {"x": 100, "y": 226}, {"x": 110, "y": 220}])
    pts = deathmap.track([[{"type": "keypress"}]] * 3, d)
    assert [(p["step"], p["x"], p["y"]) for p in pts] == [(1, 90, 226), (2, 100, 226), (3, 110, 220)]


def test_passing_the_ground_line_is_a_death_at_that_step():
    pts = [{"step": 1, "x": 470, "y": 226}, {"step": 2, "x": 490, "y": 240}, {"step": 3, "x": 495, "y": 300}, {"step": 4, "x": 495, "y": 320}]
    deaths = deathmap.deaths(pts, ground_y=250)
    assert deaths == [{"step": 3, "x": 495, "y": 300, "why": "fell"}]


def test_a_missing_position_is_a_disappearance():
    pts = [{"step": 1, "x": 90, "y": 226}, {"step": 2, "x": None, "y": None}]
    assert deathmap.deaths(pts, ground_y=250)[0]["why"] == "disappeared"


def test_stuck_after_n_equal_positions():
    n = deathmap.STUCK_STEPS
    pts = [{"step": i + 1, "x": 300, "y": 226} for i in range(n)]
    assert deathmap.deaths(pts, ground_y=250) == [{"step": n, "x": 300, "y": 226, "why": "stuck"}]
    assert deathmap.deaths(pts[:-1], ground_y=250) == []


def test_positions_land_on_the_right_pixels():
    assert deathmap.to_pixel(320, 180, view=(640, 360), frame=(1280, 720)) == (640, 360)
    assert deathmap.to_pixel(0, 0, view=(640, 360), frame=(640, 360)) == (0, 0)


def test_draw_marks_deaths_red_on_the_first_frame():
    base = FakeDriver([{"x": 0, "y": 0}]).screenshot()
    png = deathmap.draw(base, [{"x": 100, "y": 100}] * 5, [{"x": 300, "y": 200}], view=(640, 360))
    img = Image.open(io.BytesIO(png)).convert("RGB")
    r, g, b = img.getpixel((300, 200))
    assert r > 180 and g < 90 and b < 90
    assert img.getpixel((100, 100)) != img.getpixel((600, 50))       # the heat shows where the player was


def test_build_replays_each_run_and_writes_png_and_json(tmp_path):
    for name, ys in (("a", [226, 226, 300]), ("b", [226, 226, 226])):
        run = tmp_path / name
        run.mkdir()
        (run / "result.json").write_text(json.dumps({"actions_by_step": [[{"type": "keypress"}]] * 3, "bugs_on": "1,2"}), encoding="utf-8")
    made = []

    def driver_cls(bugs=""):
        ys = [226, 226, 300] if not made else [226, 226, 226]
        made.append(bugs)
        return FakeDriver([{"x": 90 + 10 * i, "y": y} for i, y in enumerate(ys)])
    out = tmp_path / "map"
    data = deathmap.build([tmp_path / "a", tmp_path / "b"], driver_cls, out, ground_y=250, view=(640, 360))
    assert made == ["1,2", "1,2"]
    assert (out / "deathmap.png").is_file()
    saved = json.loads((out / "deathmap.json").read_text(encoding="utf-8"))
    assert saved == data
    assert [r["run"] for r in data["runs"]] == ["a", "b"]
    assert data["runs"][0]["deaths"] == [{"step": 3, "x": 110, "y": 300, "why": "fell"}] and data["runs"][1]["deaths"] == []
    assert data["death_count"] == 1 and data["stuck_steps"] == deathmap.STUCK_STEPS and data["ground_y"] == 250


def test_cli_deathmap_is_held_by_the_guard_and_starts_no_browser(monkeypatch, capsys):
    from pt import cli, guard
    monkeypatch.setattr(guard, "problems", lambda probes=None: ["a game window is open: Marvel-Win64-Shipping"])
    monkeypatch.setattr(deathmap, "build", lambda *a, **k: (_ for _ in ()).throw(AssertionError("a browser started")))
    assert cli.main(["deathmap", "data/runs/h12", "--ground-y", "250"]) == 1
    assert "BLOCKED" in capsys.readouterr().out


def test_cli_deathmap_options():
    from pt import cli
    a = cli.parse(["deathmap", "r1", "r2", "--game", "cave-courier", "--bugs", "1,2", "--ground-y", "250", "--out", "x"])
    assert (a.runs, a.game, a.bugs, a.ground_y, a.out) == (["r1", "r2"], "cave-courier", "1,2", 250, "x")


def test_draw_keeps_below_screen_death_inside_bottom_margin():
    base = FakeDriver([{"x": 0, "y": 0}]).screenshot()
    png = deathmap.draw(base, [], [{"x": 323, "y": 616}], view=(640, 360))
    img = Image.open(io.BytesIO(png)).convert("RGB")
    red = [(x, y) for y in range(img.height) for x in range(img.width)
           if (lambda pixel: pixel[0] > 180 and pixel[1] < 90 and pixel[2] < 90)(img.getpixel((x, y)))]
    assert red
    assert min(y for _, y in red) >= img.height - 12
    assert max(y for _, y in red) <= img.height - 1


def test_repeated_deaths_share_one_mark_and_count_label(monkeypatch):
    calls = []
    original_draw_mark = deathmap._draw_death_mark
    def record_mark(g, px, py, count, clamped=False):
        calls.append((px, py, count, clamped))
        original_draw_mark(g, px, py, count, clamped)
    monkeypatch.setattr(deathmap, "_draw_death_mark", record_mark)
    base = FakeDriver([{"x": 0, "y": 0}]).screenshot()
    png = deathmap.draw(base, [], [{"x": 307, "y": 388}, {"x": 307, "y": 388}], view=(640, 360))
    img = Image.open(io.BytesIO(png)).convert("RGB")
    red = [(x, y) for y in range(img.height) for x in range(img.width)
           if (lambda pixel: pixel[0] > 180 and pixel[1] < 90 and pixel[2] < 90)(img.getpixel((x, y)))]
    assert len(red) < 200
    assert len(calls) == 1 and calls[0][2] == 2

    class Recorder:
        def __init__(self):
            self.texts = []
        def ellipse(self, *args, **kwargs):
            pass
        def text(self, xy, value, **kwargs):
            self.texts.append(value)

    recorder = Recorder()
    deathmap._draw_death_mark(recorder, 20, 20, 2, clamped=False)
    assert "x2" in recorder.texts

