"""The film proof pictures are safe public assets."""
import fnmatch
from pathlib import Path

from tools.make_public import read_manifest
from tools.public_check import png_metadata

ROOT = Path(__file__).resolve().parents[1]
SAMPLE = ROOT / "samples" / "film-proof"

def test_exact_proof_pictures():
    assert {p.name for p in SAMPLE.iterdir()} == {"github-report-8.png", "steam-patch-note.png"}

def test_manifest_allows_each_picture():
    entries = read_manifest(ROOT / "tools" / "public_manifest.txt")
    for name in ("github-report-8.png", "steam-patch-note.png"):
        proof = f"samples/film-proof/{name}"
        assert any(fnmatch.fnmatch(proof, pattern) for pattern in entries if not pattern.startswith("!"))
        assert not any(fnmatch.fnmatch(proof, pattern[1:]) for pattern in entries if pattern.startswith("!"))

def test_pictures_have_no_png_metadata():
    for path in SAMPLE.glob("*.png"):
        assert png_metadata(path) == [], path.name

def test_each_picture_is_under_200_kb():
    for path in SAMPLE.glob("*.png"):
        assert path.stat().st_size < 200 * 1024, path.name
