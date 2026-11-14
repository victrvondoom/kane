import json
import os
import re
from datetime import datetime
from pathlib import Path

from PIL import Image

from tools import make_sample
from tools import public_check


def _jpg(path, color):
    Image.new("RGB", (24, 16), color).save(path, format="JPEG")


def test_make_sample_copies_only_public_run_material(tmp_path):
    run = tmp_path / "run"
    run.mkdir()
    _jpg(run / "s000.jpg", "red")
    _jpg(run / "strip_0.jpg", "blue")
    local = "A:" + chr(92) + "Projects" + chr(92) + "x"
    (run / "result.json").write_text(json.dumps({"game": "Tiny", "path": local, "steps": 1, "log": []}))
    (run / "confirm.json").write_text("[]")
    (run / "ledger.jsonl").write_text("private\n")

    output = make_sample.make_sample(run, tmp_path / "sample")

    assert (output / "report.html").is_file()
    assert (output / "console.html").is_file()
    assert not (output / "ledger.jsonl").exists()
    assert not re.search(r"[A-Za-z]:\\(?:Projects|Users)\\", "".join(p.read_text(errors="ignore") for p in output.rglob("*.*") if p.suffix != ".jpg"))


def test_make_sample_report_uses_source_result_date(tmp_path):
    run = tmp_path / "run"
    run.mkdir()
    result = run / "result.json"
    result.write_text(json.dumps({"game": "Tiny", "steps": 1}), encoding="utf-8")
    old_time = datetime(2001, 2, 3).timestamp()
    os.utime(result, (old_time, old_time))

    output = make_sample.make_sample(run, tmp_path / "sample")

    assert "2001-02-03" in (output / "report.html").read_text(encoding="utf-8")


def test_committed_sample_is_small_local_and_public():
    root = Path(__file__).resolve().parents[1]
    sample = root / "samples" / "h12"
    assert sample.is_dir()
    assert sum(p.stat().st_size for p in sample.rglob("*") if p.is_file()) <= 8 * 1024 * 1024
    for page in (sample / "report.html", sample / "console.html"):
        html = page.read_text(encoding="utf-8")
        for target in re.findall(r"(?:src|href)=['\"]([^'\"]+)", html):
            if target.startswith(("http:", "https:", "#", "data:")):
                continue
            assert (sample / target.split("#", 1)[0]).is_file(), target
    for path in sample.rglob("*"):
        if path.is_file():
            assert not public_check.SECRET_FILES.search(path.as_posix().removeprefix(root.as_posix() + "/"))
            if path.suffix.lower() in public_check.TEXT_EXT:
                text = path.read_text(encoding="utf-8")
                assert not any(pattern.search(text) for pattern in public_check.SECRET_RES)
                assert not public_check.OTHER_PATH.search(text)
