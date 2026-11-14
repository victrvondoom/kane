"""Estimate HUD contrast from saved frames with two luminance clusters."""
import json
import re
from pathlib import Path

import numpy as np
from PIL import Image

from pt.vision import srgb_to_linear


def _luminance(colours):
    # WCAG 2.1 relative luminance for sRGB colours, each channel from 0 to 255.
    return srgb_to_linear(np.asarray(colours, dtype=float) / 255) @ np.array([0.2126, 0.7152, 0.0722])


def contrast_ratio(first, second):
    """WCAG 2.1 ratio between two sRGB colours, from 1 to 21."""
    a, b = float(_luminance(first)), float(_luminance(second))
    return (max(a, b) + 0.05) / (min(a, b) + 0.05)


def box_contrast(image, box):
    """Split pixels by linear luminance with two means, then compare mean RGB.

    Start centres at the darkest and lightest pixel; stop at stable membership
    or after 100 iterations. A uniform box has contrast 1. This is a pixel
    estimate, not text recognition or a full accessibility audit.
    """
    if (not isinstance(box, (list, tuple)) or len(box) != 4
            or any(type(value) is not int for value in box)):
        raise ValueError("HUD boxes must contain four integer pixel coordinates")
    x, y, w, h = box
    if min(x, y) < 0 or min(w, h) <= 0 or x + w > image.width or y + h > image.height:
        raise ValueError("HUD box is outside the frame: " + str(box))
    pixels = np.asarray(image.convert("RGB").crop((x, y, x + w, y + h)), dtype=float).reshape(-1, 3)
    luminance = _luminance(pixels)
    low, high = float(luminance.min()), float(luminance.max())
    if low == high:
        return 1.0
    previous = None
    for _ in range(100):
        group = luminance > (low + high) / 2
        if previous is not None and np.array_equal(group, previous):
            break
        if not group.any() or group.all():
            return 1.0
        low, high = float(luminance[~group].mean()), float(luminance[group].mean())
        previous = group
    return contrast_ratio(pixels[~group].mean(axis=0), pixels[group].mean(axis=0))


def check_run(folder, game=None):
    """Write contrast.json with the lowest measured ratio for each HUD box."""
    from pt.adapter import config_path, load_config

    folder = Path(folder)
    frames = sorted(path for path in folder.iterdir()
                    if path.is_file() and re.fullmatch(r"s\d+\.(?:jpg|jpeg|png)", path.name, re.IGNORECASE))
    recording = folder / "frames"
    if recording.is_dir():
        frames += sorted(path for path in recording.iterdir()
                         if path.is_file() and re.fullmatch(r"f\d+\.(?:jpg|jpeg|png)", path.name, re.IGNORECASE))
    if not frames:
        raise ValueError("No saved frames in " + str(folder))
    result_path = folder / "result.json"
    result = json.loads(result_path.read_text(encoding="utf-8")) if result_path.is_file() else {}
    game = game or result.get("game_id") or "cave-courier"
    boxes = load_config(config_path(game)).get("hud_boxes", [])
    if not boxes:
        raise ValueError("No hud_boxes configured for " + game)
    worst = [None] * len(boxes)
    for frame in frames:
        with Image.open(frame) as image:
            for index, box in enumerate(boxes):
                ratio = box_contrast(image, box)
                if worst[index] is None or ratio < worst[index][0]:
                    worst[index] = (ratio, frame.relative_to(folder).as_posix())
    rows = [{"box": box, "ratio": round(ratio, 5), "frame": frame,
             "aa_normal": "pass" if ratio >= 4.5 else "fail",
             "aa_large": "pass" if ratio >= 3 else "fail"}
            for box, (ratio, frame) in zip(boxes, worst)]
    output = {"game_id": game, "frames": len(frames), "method": "two means by linear luminance; mean sRGB colours",
              "thresholds": {"aa_normal": 4.5, "aa_large": 3.0}, "boxes": rows}
    (folder / "contrast.json").write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    return output


def main(folder, game=None):
    try:
        result = check_run(folder, game)
    except (OSError, ValueError) as error:
        print("Contrast: " + str(error))
        return 1
    normal = sum(box["aa_normal"] == "pass" for box in result["boxes"])
    large = sum(box["aa_large"] == "pass" for box in result["boxes"])
    lowest = min(box["ratio"] for box in result["boxes"])
    print(f"Contrast: {result['frames']} frames, {len(result['boxes'])} boxes, lowest {lowest:g}:1, "
          f"AA normal {normal}/{len(result['boxes'])} pass, AA large {large}/{len(result['boxes'])} pass.")
    return 0
