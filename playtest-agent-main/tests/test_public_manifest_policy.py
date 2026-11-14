from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "tools" / "public_manifest.txt"
FORBIDDEN = (
    "game/*.html", "game/*.js", "game/*.py", "game/*.json", "game/*.png",
    "**/decompiled*", "docs/AST" + "RA-*", "docs/tasks/*", "games.local/*",
    "film/review.json", "**/*key*", "games/sts2-game*",
)


def test_manifest_excludes_private_and_game_patterns():
    entries = [line.strip() for line in MANIFEST.read_text(encoding="utf-8").splitlines()
               if line.strip() and not line.lstrip().startswith("#")]
    forbidden = [entry for entry in entries if entry in FORBIDDEN]
    assert not forbidden, f"forbidden manifest patterns: {forbidden}"
