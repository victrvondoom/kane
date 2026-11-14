"""Read a high contrast number from a replay frame using reference masks."""
import argparse
import json
from pathlib import Path

from PIL import Image


def _box(value):
    try:
        parts = [int(part) for part in value.split(",")]
    except (AttributeError, ValueError):
        raise argparse.ArgumentTypeError("expected x,y,width,height") from None
    if len(parts) != 4 or parts[2] <= 0 or parts[3] <= 0 or parts[0] < 0 or parts[1] < 0:
        raise argparse.ArgumentTypeError("expected nonnegative x,y and positive width,height")
    return tuple(parts)


def _mask(image, color="white"):
    if color not in ("white", "red"):
        raise ValueError("color must be white or red")
    image = image.convert("RGB")
    if color == "red":
        return [[(pixel := image.getpixel((x, y)))[0] >= 170 and pixel[0] - max(pixel[1], pixel[2]) >= 60
                 for x in range(image.width)] for y in range(image.height)]
    return [[min(image.getpixel((x, y))) >= 190 for x in range(image.width)]
            for y in range(image.height)]


def _score(region, reference):
    rh, rw = len(region), len(region[0])
    th, tw = len(reference), len(reference[0])
    if tw > rw or th > rh:
        raise ValueError("reference is larger than region")
    ref_on = sum(map(sum, reference))
    if not ref_on:
        return 0.0
    best = 0.0
    for y in range(rh - th + 1):
        for x in range(rw - tw + 1):
            intersection = sum(reference[dy][dx] and region[y + dy][x + dx]
                               for dy in range(th) for dx in range(tw))
            union = ref_on + sum(sum(row[x:x + tw]) for row in region[y:y + th]) - intersection
            best = max(best, intersection / union if union else 0.0)
    return best


def match(frame_path, refs_path, region, expected, scale_from=1920, min_score=0.5, margin=0.1, color="white"):
    if color not in ("white", "red"):
        raise ValueError("color must be white or red")
    frame_path, refs_path = Path(frame_path), Path(refs_path)
    if scale_from <= 0 or min_score < 0 or margin < 0:
        raise ValueError("invalid scale or score threshold")
    if not frame_path.is_file() or not refs_path.is_dir():
        raise ValueError("frame or reference folder is missing")
    refs = sorted(refs_path.glob("*.png"))
    if not refs or not any(path.stem == str(expected) for path in refs):
        raise ValueError("expected reference is missing")
    with Image.open(frame_path) as source:
        factor = scale_from / source.width
        frame = source.convert("RGB").resize((scale_from, round(source.height * factor))) if source.width != scale_from else source.convert("RGB")
    x, y, width, height = (round(value * frame.width / scale_from) for value in region)
    if x + width > frame.width or y + height > frame.height:
        raise ValueError("region is outside frame")
    region_mask = _mask(frame.crop((x, y, x + width, y + height)), color)
    scores = {}
    for path in refs:
        with Image.open(path) as image:
            scores[path.stem] = round(_score(region_mask, _mask(image, color)), 6)
    ranked = sorted(scores.items(), key=lambda row: (-row[1], row[0]))
    read = ranked[0][0] if ranked and ranked[0][1] >= min_score and (len(ranked) == 1 or ranked[0][1] - ranked[1][1] >= margin) else None
    code = 2 if read is None else (0 if read == str(expected) else 1)
    return {"read": read, "scores": scores, "expected": str(expected)}, code


def add_arguments(parser):
    parser.add_argument("--frame", required=True)
    parser.add_argument("--refs", required=True)
    parser.add_argument("--region", required=True, type=_box)
    parser.add_argument("--scale-from", type=int, default=1920)
    parser.add_argument("--expected", required=True)
    parser.add_argument("--min-score", type=float, default=0.5)
    parser.add_argument("--margin", type=float, default=0.1)
    parser.add_argument("--color", choices=("white", "red"), default="white")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    add_arguments(parser)
    args = parser.parse_args(argv)
    try:
        result, code = match(args.frame, args.refs, args.region, args.expected,
                             args.scale_from, args.min_score, args.margin, args.color)
    except Exception:
        return 2
    print(json.dumps(result, ensure_ascii=False))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
