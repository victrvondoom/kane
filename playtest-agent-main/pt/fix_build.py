"""Open a patched Cave Courier copy with the game's normal replay settings."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CAVE_GAMES = {"cave-courier", "cave-courier-buggy"}


def same_game(a, b):
    return a == b or {a, b} <= CAVE_GAMES


def copy_driver(path, bugs=""):
    from pt.adapter import WebAdapter, load_config
    path = Path(path).resolve(strict=True)
    cfg = load_config(ROOT / "games" / "cave-courier.json")
    cfg["url"] = path.as_uri()
    return WebAdapter(cfg, bugs=bugs)


def regression_driver(game, build):
    if game not in CAVE_GAMES:
        raise ValueError("A build copy is supported only for Cave Courier")
    path = Path(build).resolve(strict=True)
    return lambda bugs="": copy_driver(path, bugs=bugs)
