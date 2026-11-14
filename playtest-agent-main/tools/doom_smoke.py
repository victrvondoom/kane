import argparse
import io
import sys
import time
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pt.python_version import require_supported
require_supported()
from pt.adapter import make


def main(argv=()):
    parser = argparse.ArgumentParser(description="Check Freedoom (Doom engine) without a window.")
    parser.add_argument("--record", type=Path)
    args = parser.parse_args(argv)
    start = time.perf_counter()
    game = make("doom-basic")
    try:
        shot = game.screenshot()
        with Image.open(io.BytesIO(shot)) as image:
            print(f"screenshot: {image.width} x {image.height}, {len(shot)} bytes")
        if args.record is not None:
            game.start_recording(args.record)
        game.execute([{"type": "keypress", "keys": ["left"]},
                      {"type": "keypress", "keys": ["right"]},
                      {"type": "keypress", "keys": ["f"]}])
        if args.record is not None:
            count = len(list((args.record / "frames").glob("*.jpg")))
            print(f"frames: {count}, ticks: {game.tick()}")
            if count != game.tick():
                raise RuntimeError("Frame count does not match ticks")
        print("state:", game.state())
        print(f"elapsed: {time.perf_counter() - start:.3f} seconds")
    finally:
        game.close()


if __name__ == "__main__":
    main(sys.argv[1:])
