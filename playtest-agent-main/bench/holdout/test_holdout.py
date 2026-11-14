"""The holdout game: config, hooks, the sealed key kept out of every other file, and the game logic played with no browser
(Node runs the page's script against a stub canvas: sim.mjs). Run by name: python -m pytest bench/holdout/test_holdout.py
Kept out of tests/ on purpose: workers that run the main suite must never see the sealed key."""
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT))
PAGE = HERE / "game" / "index.html"
SEALED = HERE / "SEALED-bugs.json"

R, L, U, D, E = "ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "KeyE"


def go(key, n=1):
    return [{"keys": [key]}] * n


# The clean way out: blue key, blue door, round the spikes to the red key, red door, the exit.
WIN = go(U, 3) + go(R, 4) + go(D, 3) + go(R) + go(E) + go(R, 8) + go(D, 4) + go(L, 3) + go(R, 3) + go(U, 4) + go(E) + go(R, 5)


def sim(actions, bugs=""):
    if shutil.which("node") is None:
        pytest.skip("node is not installed")
    plan = HERE / ".plan.json"
    plan.write_text(json.dumps({"bugs": bugs, "actions": actions}), encoding="utf-8")
    try:
        out = subprocess.run(["node", str(HERE / "sim.mjs"), str(PAGE), str(plan)], capture_output=True, text=True, timeout=60, check=True).stdout
    finally:
        plan.unlink(missing_ok=True)
    return json.loads(out)


def test_config_passes_the_validator():
    from pt.adapter import load_config
    cfg = load_config(ROOT / "games" / "holdout.json")
    assert cfg["url"] == "bench/holdout/game/index.html" and cfg["frame_lock"] and cfg["state_js"] == "window.__state()"


def test_page_has_five_flags_all_off_by_default():
    src = PAGE.read_text(encoding="utf-8")
    assert all(f"BUGS.has({n})" in src for n in range(1, 6))
    assert "window.__bugHit = {1: false, 2: false, 3: false, 4: false, 5: false};" in src
    assert "(q.get('bugs') || '')" in src
    for hook in ("window.__ready = true", "window.__frame", "window.__state = ", "window.__won"):
        assert hook in src


def test_the_page_names_no_bug():
    """People read the repo: the page has no comment and no word that describes a planted bug."""
    src = PAGE.read_text(encoding="utf-8")
    script = src[src.index("<script>"):]
    assert not re.search(r"(?<!:)//|/\*", script)
    assert "bug" not in re.sub(r"BUGS|__bugHit|'bugs'", "", script).lower()


def test_no_other_file_holds_a_sealed_title():
    titles = [b["title"].lower() for b in json.loads(SEALED.read_text(encoding="utf-8"))["bugs"]]
    assert len(titles) == 5
    files = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.split()
    found = []
    for f in files:
        p = ROOT / f
        if p == SEALED or not p.is_file():
            continue
        try:
            text = p.read_text(encoding="utf-8").lower()
        except (UnicodeDecodeError, OSError):
            continue
        found += [f"{f}: {t}" for t in titles if t in text]
    assert not found, f"{len(found)} file(s) name a sealed bug"


def test_the_clean_game_can_be_won_in_about_40_actions():
    r = sim(WIN)
    assert r["won"] and len(WIN) <= 45
    assert not any(r["bugHit"].values())


def test_the_clean_game_ends_after_two_spike_hits():
    r = sim(go(U, 3) + go(R, 4) + go(D, 3) + go(R) + go(E) + go(R, 2) + go(D, 3) + go(R) + go(D, 4))
    hearts = [s["hearts"] for s in r["states"]]
    assert min(hearts) == 0 and r["states"][-1]["over"]


@pytest.mark.parametrize("bug,actions", [
    (1, go(U, 3) + go(R, 4) + go(D, 3) + go(R) + go(E) + go(R, 2) + go(U, 3) + go(R, 2)),
    (2, go(D, 2) + go(R, 3)),
    (3, go(U, 3) + go(R, 4) + go(D, 3) + go(R) + go(E)),
    (4, WIN),
    (5, go(U, 3) + go(R, 4) + go(D, 3) + go(R) + go(E) + go(R, 2) + go(D, 3) + go(R) + go(D, 4)),
])
def test_each_planted_bug_triggers_only_with_its_flag(bug, actions):
    on = sim(actions, bugs=str(bug))
    off = sim(actions)
    assert on["bugHit"][str(bug)] is True
    assert not any(off["bugHit"].values())


def test_with_every_flag_on_the_red_door_never_lets_the_player_through():
    r = sim(WIN, bugs="1,2,3,4,5")
    assert not r["won"] and r["bugHit"]["4"]


def test_the_gem_counter_counts_wrong_only_with_its_flag():
    path = go(U, 3) + go(R, 4) + go(D, 3) + go(R) + go(E) + go(R, 2) + go(U, 3) + go(R, 2)
    assert sim(path, bugs="1")["states"][-1]["gems"] == 2
    assert sim(path)["states"][-1]["gems"] == 1
