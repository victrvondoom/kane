"""A game that fails to load must not leave its browser running: one leak broke every later browser test in the run.
Needs headless Chromium (Playwright). One browser at a time, no window."""
import pytest

pytest.importorskip("playwright")
from pt import adapter as A  # noqa: E402


def test_a_game_that_fails_to_load_closes_its_browser():
    cfg = {"type": "web", "name": "broken", "url": "game/index.html", "frame_lock": True,
           "ready_js": "() => { throw new Error('the game never starts') }"}
    with pytest.raises(Exception):
        A.WebAdapter(cfg)
    from playwright.sync_api import sync_playwright
    pw = sync_playwright().start()               # raises "Sync API inside the asyncio loop" when the first one leaked
    pw.stop()
