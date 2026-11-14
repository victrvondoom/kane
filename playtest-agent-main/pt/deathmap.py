"""python -m pt deathmap RUN [RUN ...]: replay saved runs at $0 (no model, the same replay as confirm), record the player's position
from the game state after every action, and draw where players went and where a life ended badly.

A bad end is one of:
- fell: the position passed below the ground line (y > ground_y), counted once each time it goes below;
- disappeared: the state has no position;
- stuck: the position did not change for STUCK_STEPS actions in a row (marked once, at the step the count is reached)."""
import io
import json
from pathlib import Path

from PIL import Image, ImageDraw

STUCK_STEPS = 10
CELL = 8                      # heat map cell, in frame pixels


def _pos(state):
    if not isinstance(state, dict):
        return None, None
    x, y = state.get("x"), state.get("y")
    return (x, y) if isinstance(x, (int, float)) and isinstance(y, (int, float)) else (None, None)


def track(actions_by_step, driver):
    """The position after each step's actions, steps counted from 1."""
    out = []
    for i, acts in enumerate(actions_by_step):
        driver.execute(acts)
        x, y = _pos(driver.state())
        out.append({"step": i + 1, "x": x, "y": y})
    return out


def deaths(points, ground_y, stuck=STUCK_STEPS):
    out, below, missing, same, last = [], False, False, 0, None
    for p in points:
        x, y = p["x"], p["y"]
        if x is None or y is None:
            if not missing:
                out.append({"step": p["step"], "x": x, "y": y, "why": "disappeared"})
            missing, same, last = True, 0, None
            continue
        missing = False
        if y > ground_y:
            if not below:
                out.append({"step": p["step"], "x": x, "y": y, "why": "fell"})
            below, same, last = True, 0, None
            continue
        below = False
        same = same + 1 if (x, y) == last else 1
        last = (x, y)
        if same == stuck:
            out.append({"step": p["step"], "x": x, "y": y, "why": "stuck"})
    return out


def to_pixel(x, y, view, frame):
    return round(x * frame[0] / view[0]), round(y * frame[1] / view[1])


def _draw_death_mark(g, px, py, count, clamped=False):
    g.ellipse([px - 6, py - 6, px + 6, py + 6], fill=(230, 30, 30, 255), outline=(255, 255, 255, 255))
    if clamped:
        g.polygon([(px - 3, py - 8), (px + 3, py - 8), (px, py - 4)], fill=(255, 255, 255, 255))
    if count > 1:
        g.text((px + 7, py - 6), f"x{count}", fill=(255, 255, 255, 255), stroke_width=1, stroke_fill=(120, 0, 0, 255))


def draw(base_frame, positions, bad_ends, view):
    """A heat map of positions over the first frame, and red marks where a life ended badly. Returns PNG bytes."""
    img = Image.open(io.BytesIO(base_frame)).convert("RGBA")
    counts = {}
    for p in positions:
        if p.get("x") is not None and p.get("y") is not None:
            px, py = to_pixel(p["x"], p["y"], view, img.size)
            px = min(max(px, 0), img.width - 1)
            py = min(max(py, 0), img.height - 1)
            counts[(px // CELL, py // CELL)] = counts.get((px // CELL, py // CELL), 0) + 1
    heat = Image.new("RGBA", img.size, (0, 0, 0, 0))
    g = ImageDraw.Draw(heat)
    top = max(counts.values(), default=1)
    for (cx, cy), n in counts.items():
        g.rectangle([cx * CELL, cy * CELL, cx * CELL + CELL - 1, cy * CELL + CELL - 1], fill=(255, 200, 0, 70 + int(110 * n / top)))
    img = Image.alpha_composite(img, heat)
    g = ImageDraw.Draw(img)
    marks = {}
    for d in bad_ends:
        if d.get("x") is None or d.get("y") is None:
            continue
        px, py = to_pixel(d["x"], d["y"], view, img.size)
        original = (px, py)
        px = min(max(px, 6), max(6, img.width - 7))
        py = min(max(py, 6), max(6, img.height - 7))
        key = (px, py)
        if key not in marks:
            marks[key] = [0, original != key]
        marks[key][0] += 1
        marks[key][1] = marks[key][1] or original != key
    for (px, py), (count, clamped) in marks.items():
        _draw_death_mark(g, px, py, count, clamped)
    buf = io.BytesIO()
    img.convert("RGB").save(buf, "PNG")
    return buf.getvalue()


def build(run_folders, driver_cls, out, ground_y, view, bugs=None):
    """Replay every run on a fresh game (its own planted bugs unless `bugs` is given) and write deathmap.png and deathmap.json."""
    out = Path(out)
    runs, everywhere, bad, base = [], [], [], None
    for folder in map(Path, run_folders):
        result = json.loads((folder / "result.json").read_text(encoding="utf-8"))
        d = driver_cls(bugs=result.get("bugs_on", "") if bugs is None else bugs)
        try:
            if base is None:
                base = d.screenshot()         # a clean first frame of the level
            points = track(result.get("actions_by_step") or [], d)
        finally:
            d.close()
        ends = deaths(points, ground_y)
        runs.append({"run": folder.name, "steps": len(points), "deaths": ends, "positions": points})
        everywhere += points
        bad += ends
    out.mkdir(parents=True, exist_ok=True)
    if base is not None:
        (out / "deathmap.png").write_bytes(draw(base, everywhere, bad, view))
    data = {"runs": runs, "death_count": len(bad), "stuck_steps": STUCK_STEPS, "ground_y": ground_y, "view": list(view)}
    (out / "deathmap.json").write_text(json.dumps(data, indent=1), encoding="utf-8")
    return json.loads(json.dumps(data))
