import hashlib
import json
from pathlib import Path

import pytest

from test_fix import Client, Driver, SOURCE, setup_run


def saved_attempt(tmp_path):
    run, goal, source = setup_run(tmp_path)
    fixes = run / "fixes"
    fixes.mkdir()
    (fixes / "source.html").write_text(SOURCE, encoding="utf-8")
    attempt = fixes / "0" / "attempts" / "2"
    attempt.mkdir(parents=True)
    patched = SOURCE.replace("broken", "fixed")
    (attempt / "index-buggy-view.html").write_text(patched, encoding="utf-8")
    return run, goal, attempt, patched


def test_fix_verify_judges_saved_patch_without_proposal_and_preserves_fixes(tmp_path, monkeypatch):
    from pt.fix_verify import verify_run
    run, goal, attempt, patched = saved_attempt(tmp_path)
    before = {str(p.relative_to(run / "fixes")): hashlib.sha256(p.read_bytes()).hexdigest()
              for p in (run / "fixes").rglob("*") if p.is_file()}
    client = Client([], ["GONE"])
    result = verify_run(run, goal, 0, 2, "again", note="recheck", client=client,
                        driver_factory=lambda path, bugs="": Driver(path, []))
    row = result["row"]
    assert not client.proposals and len(client.judges) == 1
    assert row["new_patch_written"] is False
    assert row["note"] == "recheck"
    assert row["source_patch"] == str(attempt)
    assert row["patch_sha256"] == hashlib.sha256(patched.encode()).hexdigest()
    after = {str(p.relative_to(run / "fixes")): hashlib.sha256(p.read_bytes()).hexdigest()
             for p in (run / "fixes").rglob("*") if p.is_file()}
    assert before == after


def test_fix_verify_rejects_existing_output_missing_attempt_and_unselected_report(tmp_path):
    from pt.fix_verify import verify_run
    run, goal, attempt, _ = saved_attempt(tmp_path)
    (run / "fix-verify" / "again").mkdir(parents=True)
    with pytest.raises(ValueError, match="already exists"):
        verify_run(run, goal, 0, 2, "again", dry=True,
                   driver_factory=lambda path, bugs="": Driver(path, []))
    import shutil
    shutil.rmtree(run / "fix-verify" / "again")
    (attempt / "index-buggy-view.html").unlink()
    with pytest.raises(ValueError, match="patched page"):
        verify_run(run, goal, 0, 2, "missing", dry=True,
                   driver_factory=lambda path, bugs="": Driver(path, []))
    (attempt / "index-buggy-view.html").write_text(SOURCE, encoding="utf-8")
    with pytest.raises(ValueError, match="selected"):
        verify_run(run, goal, 7, 2, "unselected", dry=True,
                   driver_factory=lambda path, bugs="": Driver(path, []))


def test_fix_verify_dry_records_replay_error_without_client(tmp_path):
    from pt.fix_verify import verify_run
    run, goal, _, _ = saved_attempt(tmp_path)
    class Broken(Driver):
        def execute(self, acts):
            if self.path.name == "index.html": raise RuntimeError("fake driver failed")
            self.n += 1
        def __init__(self, path, made):
            super().__init__(path, made)
            self.path = Path(path)
    result = verify_run(run, goal, 0, 2, "dry", dry=True,
                       driver_factory=lambda path, bugs="": Broken(path, []))
    assert result["exit_code"] == 1
    saved = json.loads((run / "fix-verify/dry/dry.json").read_text())
    assert saved["replay_ok"] is False and "fake driver failed" in saved["error"]


@pytest.mark.browser
@pytest.mark.skipif(__import__("os").environ.get("PT_BROWSER_TESTS") != "1",
                    reason="requires explicit browser opt in")
def test_fix_verify_bug_six_hook_tracks_option_only(tmp_path):
    from game.build_buggy import instrument
    from playwright.sync_api import sync_playwright
    view = (Path(__file__).resolve().parents[1] / "game/index-buggy-view.html").read_text(encoding="utf-8")
    page_path = tmp_path / "hook6.html"
    page_path.write_text(instrument(view), encoding="utf-8", newline="\n")
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        for query, expected in (("?bugs=6", True), ("", False)):
            page = browser.new_page()
            page.goto(page_path.as_uri() + query)
            page.keyboard.down("ArrowRight")
            for _ in range(400):
                if page.evaluate("window.__state().x > 120"):
                    break
                page.evaluate("() => new Promise(requestAnimationFrame)")
            page.keyboard.up("ArrowRight")
            assert page.evaluate("window.__bugHit[6]") is expected
            page.close()
        browser.close()
