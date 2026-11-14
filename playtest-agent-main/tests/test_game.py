"""The game's own rules and its five planted bugs. Needs headless Chromium (Playwright). One browser at a time, no window.
Teleports come from the debug hook (?debug=1). The flags in window.__bugHit let me grade without the agent."""
import pytest

pw = pytest.importorskip("playwright")
from pw.driver import Driver  # noqa: E402


@pytest.fixture
def clean():
    d = Driver(bugs="", debug=True)
    yield d
    d.close()


@pytest.fixture
def buggy():
    d = Driver(bugs="1,2,3,4,5", debug=True)
    yield d
    d.close()


def tp(d, x, y=None, **kw):
    d.page.evaluate("(a) => window.__debug.set(a)", {"x": x, **({"y": y} if y is not None else {}), **kw})
    d.execute([{"type": "wait", "ms": 120}])


def hit(d):
    return d.page.evaluate("window.__bugHit")


def test_clean_build_can_be_won(clean):
    tp(clean, 395, 120)                       # on the second platform, touching the key
    clean.execute([{"type": "wait", "ms": 300}])
    assert clean.state()["key"] is True
    tp(clean, 548, 226)                       # next to the big door
    clean.execute([{"type": "wait", "ms": 200}])
    clean.execute([{"type": "keypress", "keys": ["e"]}])
    assert clean.state()["doorOpen"] is True
    tp(clean, 590, 226)
    clean.execute([{"type": "wait", "ms": 300}])
    clean.execute([{"type": "keypress", "keys": ["right"]}])
    assert clean.state()["won"] is True


def test_clean_build_flags_stay_empty(clean):
    tp(clean, 60)
    clean.execute([{"type": "keypress", "keys": ["e"]}])      # shed door
    tp(clean, 40)
    tp(clean, 160, coins=3)
    clean.execute([{"type": "keypress", "keys": ["e"]}])      # buy boots
    assert clean.state()["boots"] is True
    assert not any(hit(clean).values())


def test_bug1_shed_door_opens_but_blocks(buggy):
    tp(buggy, 80)
    buggy.execute([{"type": "keypress", "keys": ["e"]}])
    assert buggy.state()["shedOpen"] is True
    buggy.execute([{"type": "keypress", "keys": ["left"]}, {"type": "keypress", "keys": ["left"]}, {"type": "keypress", "keys": ["left"]}])
    assert buggy.state()["x"] > 64            # still outside
    assert hit(buggy)["1"]


def test_bug2_fall_through_ground(buggy):
    tp(buggy, 312)
    buggy.execute([{"type": "wait", "ms": 900}])
    assert buggy.state()["y"] > 380
    assert hit(buggy)["2"]


def test_bug3_shop_takes_coins_gives_nothing(buggy):
    tp(buggy, 160, coins=3)
    buggy.execute([{"type": "keypress", "keys": ["e"]}])
    s = buggy.state()
    assert s["coins"] == 0 and s["boots"] is False
    assert hit(buggy)["3"]


def test_bug4_pit_is_a_soft_lock(buggy):
    tp(buggy, 500, 285)                        # in the pit
    buggy.execute([{"type": "wait", "ms": 300}])
    for _ in range(4):
        buggy.execute([{"type": "keypress", "keys": ["right", "space"]}, {"type": "wait", "ms": 700}])
    buggy.execute([{"type": "keypress", "keys": ["r"]}])
    s = buggy.state()
    assert s["y"] > 300                        # still down there
    assert hit(buggy)["4"]


def test_clean_pit_can_be_left(clean):
    tp(clean, 500, 285)
    clean.execute([{"type": "wait", "ms": 300}])
    for _ in range(4):
        clean.execute([{"type": "keypress", "keys": ["right", "space"]}, {"type": "wait", "ms": 700}])
    assert clean.state()["y"] < 260


def test_bug5_third_coin_scores_one(buggy):
    tp(buggy, 270, 170)                        # coin 3 on the first platform
    buggy.execute([{"type": "wait", "ms": 300}])
    s = buggy.state()
    assert s["score"] == 1
    assert hit(buggy)["5"]


def test_clean_third_coin_scores_ten(clean):
    tp(clean, 270, 170)
    clean.execute([{"type": "wait", "ms": 300}])
    assert clean.state()["score"] == 10
