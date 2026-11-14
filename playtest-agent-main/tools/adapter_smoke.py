"""Prove an adapter end to end with NO model call: open the game headless, take a screenshot, send a key and a click, read the state.
Run: python -m tools.adapter_smoke GAME_NAME   (only when `python -m pt.guard` says OK)"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pt.python_version import require_supported
require_supported()
from pt import guard
from pt.adapter import make

name = sys.argv[1]
bad = guard.problems()
if bad:
    sys.exit("BLOCKED, no browser started: " + "; ".join(bad))
guard.take_lock()
try:
    g = make(name)
    try:
        first = g.screenshot()
        g.execute([{"type": "wait", "ms": 500}, {"type": "click", "x": 100, "y": 100}, {"type": "keypress", "keys": ["space"]}])
        second = g.screenshot()
        out = Path(__file__).resolve().parents[1] / "data" / f"smoke-{name}"
        out.mkdir(parents=True, exist_ok=True)
        (out / "first.jpg").write_bytes(first)
        (out / "second.jpg").write_bytes(second)
        print("OK", name, "screenshots", len(first), len(second), "bytes; state:", g.state(), "; saved in", out)
    finally:
        g.close()
finally:
    guard.release_lock()
