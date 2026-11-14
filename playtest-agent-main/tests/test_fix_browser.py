"""Owed trace comparison. Run only when the owner releases the browser slot."""
import os
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(os.environ.get("PT_BROWSER_TESTS") != "1", reason="Set PT_BROWSER_TESTS=1 for browser proof")


def _run_scripts(root, config, bugs, scripts):
    from pt.adapter import WebAdapter, load_config

    traces = []
    all_hits = set()
    for state, actions in scripts:
        driver = WebAdapter(load_config(root / "games" / (config + ".json")), bugs=bugs, debug=True)
        try:
            driver.page.evaluate("a => window.__debug.set(a)", state)
            action_trace = []
            for action in actions:
                driver.execute([action])
                action_trace.append((driver.state(), driver.screenshot()))
            hits = driver.bug_hits()
            all_hits.update(k for k, value in hits.items() if value)
            traces.append((action_trace, hits))
        finally:
            driver.close()
    return traces, all_hits


def test_baked_build_matches_all_five_flags():
    from pt import guard
    bad = guard.problems()
    if bad:
        pytest.skip("BLOCKED: " + "; ".join(bad))
    root = Path(__file__).resolve().parents[1]
    scripts = [
        ({"x": 80, "y": 226}, [{"type": "keypress", "keys": ["e"]}, {"type": "keypress", "keys": ["left"]}]),
        ({"x": 312, "y": 226}, [{"type": "wait", "ms": 900}]),
        ({"x": 160, "y": 226, "coins": 3}, [{"type": "keypress", "keys": ["e"]}]),
        ({"x": 500, "y": 285}, [{"type": "wait", "ms": 300}, {"type": "keypress", "keys": ["r"]}]),
        ({"x": 270, "y": 170}, [{"type": "wait", "ms": 300}]),
    ]
    guard.take_lock()
    try:
        clean, clean_hits = _run_scripts(root, "cave-courier", "1,2,3,4,5", scripts)
        baked, baked_hits = _run_scripts(root, "cave-courier-buggy", "", scripts)
        assert clean_hits == {str(n) for n in range(1, 6)}
        assert baked_hits == {str(n) for n in range(1, 6)}
        assert len(clean) == len(baked)
        for (clean_trace, clean_hooks), (baked_trace, baked_hooks) in zip(clean, baked):
            assert clean_trace == baked_trace
            assert clean_hooks == baked_hooks
    finally:
        guard.release_lock()


def test_boots_hook_fires_only_when_the_bug_leaves_boots_missing(tmp_path):
    from game.build_buggy import instrument
    from playwright.sync_api import sync_playwright
    root = Path(__file__).resolve().parents[1]
    view = (root / "game/index-buggy-view.html").read_text(encoding="utf-8")
    fixed = view.replace(
        "      st.coins -= 3;\n      say('Thanks! Enjoy the boots!');",
        "      st.coins -= 3;\n      st.boots = true;\n      say('Thanks! Enjoy the boots!');",
    )
    hand_edits = __import__("json").loads((root / "game/hand_fixes.json").read_text(encoding="utf-8"))["fixes"]["3"]
    hand = view
    for edit in hand_edits:
        assert hand.count(edit["search"]) == 1
        hand = hand.replace(edit["search"], edit["replace"])

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            for source, expected_hit, expected_boots in ((view, True, False), (fixed, False, True), (hand, None, True)):
                page_file = tmp_path / ("case-" + str(expected_hit) + ".html")
                page_file.write_text(instrument(source), encoding="utf-8", newline="\n")
                page = browser.new_page()
                page.goto(page_file.as_uri() + "?debug=1")
                page.evaluate("a => window.__debug.set(a)", {"x": 160, "y": 226, "coins": 3})
                page.keyboard.press("e")
                page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
                assert page.evaluate("window.__bugHit[3]") is expected_hit
                assert page.evaluate("window.__state().boots") is expected_boots
                page.close()
        finally:
            browser.close()
