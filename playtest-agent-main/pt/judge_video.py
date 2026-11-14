"""Encode the judge's sampled replay frames as a silent MP4."""
import io
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw


def encode(frames):
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("Video judging needs ffmpeg on PATH; use --judge-input strip or install ffmpeg")
    if not frames:
        raise ValueError("Video judging needs at least one replay frame")
    with tempfile.TemporaryDirectory(prefix="pt-judge-") as temp:
        folder = Path(temp)
        images = [Image.open(io.BytesIO(frame)).convert("RGB") for frame in frames]
        height = max(round(im.height * 480 / im.width) for im in images)
        height += height % 2
        for i, image in enumerate(images):
            tile = image.resize((480, round(image.height * 480 / image.width)))
            canvas = Image.new("RGB", (480, height), (20, 20, 20))
            canvas.paste(tile, (0, 0))
            ImageDraw.Draw(canvas).text((4, 4), str(i + 1), fill=(255, 255, 0))
            canvas.save(folder / f"f{i:04d}.png")
        output = folder / "replay.mp4"
        command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-framerate", "2",
                   "-i", str(folder / "f%04d.png"), "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                   "-movflags", "+faststart", str(output)]
        try:
            result = subprocess.run(command, capture_output=True, timeout=30,
                                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise RuntimeError("ffmpeg could not encode the judge video") from exc
        if result.returncode:
            raise RuntimeError("ffmpeg could not encode the judge video: " + result.stderr.decode("utf-8", "replace")[-600:])
        return output.read_bytes()


def prompt(text):
    return text.replace(
        "The filmstrip replays the same actions on a fresh copy. Read left to right, top to bottom. ",
        "The video replays the same actions on a fresh copy. Watch numbered frames in order. "
        "Each sampled frame lasts half a second; this is not the game's original timing. ")
