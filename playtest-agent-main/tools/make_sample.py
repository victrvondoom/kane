"""Make a small, key free copy of a finished run for public review."""

from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path

from PIL import Image

from pt.console import write as write_console
from pt.report import write as write_report

PATH = re.compile(r"[A-Za-z]:\\+(?:Projects|Users)\\+[^\s\"'<>]*", re.IGNORECASE)
KEEP_JSON = ("result.json", "confirm.json", "diary.json")
IMAGE = re.compile(r"(?:s\d+|strip_\d+)\.jpg", re.IGNORECASE)


def _clean(value):
    if isinstance(value, str):
        return PATH.sub("[local path removed]", value)
    if isinstance(value, list):
        return [_clean(item) for item in value]
    if isinstance(value, dict):
        return {key: _clean(item) for key, item in value.items()}
    return value


def _copy_image(source: Path, target: Path) -> None:
    with Image.open(source) as image:
        image.thumbnail((480, 360))
        image.convert("RGB").save(target, "JPEG", quality=45, optimize=True)


def make_sample(run_dir: str | Path, out_dir: str | Path) -> Path:
    """Copy report inputs, shrink images, and build both local pages."""
    source, output = Path(run_dir), Path(out_dir)
    if not (source / "result.json").is_file():
        raise FileNotFoundError(source / "result.json")
    output.mkdir(parents=True, exist_ok=True)
    for name in KEEP_JSON:
        path = source / name
        if path.is_file():
            data = _clean(json.loads(path.read_text(encoding="utf-8")))
            target = output / name
            target.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
            os.utime(target, (path.stat().st_atime, path.stat().st_mtime))
    for path in source.iterdir():
        if path.is_file() and IMAGE.fullmatch(path.name):
            _copy_image(path, output / path.name)
    write_report(output)
    write_console(output)
    total = sum(path.stat().st_size for path in output.rglob("*") if path.is_file())
    print(f"Sample size: {total} bytes ({total / (1024 * 1024):.2f} MB)")
    return output


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Make a small public copy of a finished run")
    parser.add_argument("run_dir", type=Path)
    parser.add_argument("out_dir", type=Path)
    args = parser.parse_args(argv)
    make_sample(args.run_dir, args.out_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
