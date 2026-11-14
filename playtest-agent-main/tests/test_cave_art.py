"""Cave Courier with its art (?art=1). The art changes only the picture: the same moves give the same game, bugs too.
Needs headless Chromium (Playwright). One browser at a time, no window."""
import io
import re
from pathlib import Path

import pytest

pytest.importorskip("playwright")
from PIL import Image  # noqa: E402

from pt.adapter import make  # noqa: E402

GAME = Path(__file__).resolve().parents[1] / "game"
MOVES = [[{"type": "keypress", "keys": ["right"]}] * 3, [{"type": "keypress", "keys": ["space", "right"]}],
         [{"type": "keypress", "keys": ["e"]}], [{"type": "keypress", "keys": ["left"]}] * 4, [{"type": "keypress", "keys": ["e"]}],
         [{"type": "keypress", "keys": ["right"]}] * 8, [{"type": "keypress", "keys": ["r"]}]]


def play(name, bugs):
    d = make(name, bugs=bugs, debug=False)
    try:
        states = []
        for actions in MOVES:
            d.execute(actions)
            states.append(d.state())
        return states, d.bug_hits(), d.screenshot()
    finally:
        d.close()


def test_every_picture_the_game_asks_for_is_there():
    names = set(re.findall(r"'([a-z_0-9]+)'", re.search(r"const ART_NAMES = \[(.*?)\]", (GAME / "index.html").read_text(encoding="utf-8"), re.S).group(1)))
    assert len(names) == 14
    assert all((GAME / "art" / f"{n}.png").is_file() for n in names)


@pytest.mark.parametrize("bugs", ["", "1,2,3,4,5"])
def test_art_changes_the_picture_and_not_the_game(bugs):
    plain, plain_hits, plain_shot = play("cave-courier", bugs)
    art, art_hits, art_shot = play("cave-courier-art", bugs)
    assert art == plain and art_hits == plain_hits
    a, b = Image.open(io.BytesIO(plain_shot)).convert("RGB"), Image.open(io.BytesIO(art_shot)).convert("RGB")
    assert a.getpixel((320, 120)) != b.getpixel((320, 120))          # the sky is the cave picture, not the flat colour
