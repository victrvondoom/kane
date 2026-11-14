"""Create a tightly trimmed number reference from a saved frame."""
import argparse
from pathlib import Path

from PIL import Image

from tools.picture_number import _box, _mask


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--frame", required=True)
    parser.add_argument("--box", required=True, type=_box)
    parser.add_argument("--label", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--color", choices=("white", "red"), default="white")
    args = parser.parse_args(argv)
    try:
        output = Path(args.out)
        target = output / (args.label + ".png")
        if target.exists():
            return 2
        with Image.open(args.frame) as source:
            factor = 1920 / source.width
            frame = source.convert("RGB").resize((1920, round(source.height * factor))) if source.width != 1920 else source.convert("RGB")
        x, y, width, height = args.box
        if x + width > frame.width or y + height > frame.height:
            return 2
        crop = frame.crop((x, y, x + width, y + height))
        mask = _mask(crop, args.color)
        points = [(x, y) for y, row in enumerate(mask) for x, on in enumerate(row) if on]
        if not points:
            return 2
        left, top = max(0, min(x for x, _ in points) - 1), max(0, min(y for _, y in points) - 1)
        right, bottom = min(crop.width, max(x for x, _ in points) + 2), min(crop.height, max(y for _, y in points) + 2)
        output.mkdir(parents=True, exist_ok=True)
        if target.exists():
            return 2
        crop.crop((left, top, right, bottom)).save(target)
        return 0
    except Exception:
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
