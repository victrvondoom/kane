"""Replay one normal play stretch and check its final picture."""
import argparse
import io
import json
from pathlib import Path

from PIL import Image

from pt import fix_any, replay
from tools.picture_number import _box, match


def run(args, driver_factory=None):
    try:
        config = json.loads(Path(args.game).read_text(encoding="utf-8"))
        actions = json.loads(Path(args.actions).read_text(encoding="utf-8"))
        if not isinstance(actions, list) or any(not isinstance(row, list) for row in actions):
            return 2
        out_dir = Path(args.out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        target = out_dir / ("normal-" + Path(args.actions).stem + ".jpg")
        if target.exists():
            return 2
        factory = driver_factory or fix_any._driver
        health_seen = []

        def driver_cls(bugs=""):
            driver = (factory(config, bugs=bugs) if driver_factory is None else factory(config))
            if hasattr(driver, "health"):
                health_seen.append(driver.health())
            class Tracker:
                def __getattr__(self, name):
                    return getattr(driver, name)

                def execute(self, row):
                    driver.execute(row)
                    if hasattr(driver, "health"):
                        health_seen.append(driver.health())
            return Tracker()

        trace = replay.replay_trace(actions, len(actions), "", driver_cls=driver_cls)
        if not trace.get("frames"):
            return 2
        driver_health = health_seen[-1] if health_seen else None
        if driver_health is False or (isinstance(driver_health, dict) and driver_health.get("alive") is False):
            return 2
        frame_bytes = trace["frames"][-1]
        with Image.open(io.BytesIO(frame_bytes)) as opened:
            frame = opened.convert("RGB")
        if len(set(frame.get_flattened_data())) <= 1:
            return 2
        frame.save(target, format="JPEG")
        result, code = match(target, args.refs, args.region, args.expected,
                             getattr(args, "scale_from", 1920), getattr(args, "min_score", 0.5),
                             getattr(args, "margin", 0.1), color=getattr(args, "color", "white"))
        print(json.dumps(result, ensure_ascii=False))
        return code
    except Exception:
        return 2


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--game", required=True)
    parser.add_argument("--actions", required=True)
    parser.add_argument("--refs", required=True)
    parser.add_argument("--region", required=True, type=_box)
    parser.add_argument("--expected", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--scale-from", type=int, default=1920)
    parser.add_argument("--min-score", type=float, default=0.5)
    parser.add_argument("--margin", type=float, default=0.1)
    parser.add_argument("--color", choices=("white", "red"), default="white")
    return run(parser.parse_args(argv))


if __name__ == "__main__":
    raise SystemExit(main())
