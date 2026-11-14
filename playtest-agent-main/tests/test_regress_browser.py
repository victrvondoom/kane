"""Floor gap proof, run only when the owner enables browser tests."""
import os
import pytest

pytestmark = pytest.mark.skipif(os.environ.get("PT_BROWSER_TESTS") != "1", reason="Owner must enable browser tests")


@pytest.mark.parametrize("game", ["cave-courier", "cave-courier-art"])
@pytest.mark.parametrize("bugs", ["", "6"])
def test_floor_gap(game, bugs):
    from pt.adapter import make
    driver = make(game, bugs=bugs)
    try:
        driver.execute([{"type": "wait", "ms": 1500}])
        if bugs:
            assert driver.state()["y"] > 360
            assert driver.bug_hits()["6"] is True
            assert driver.won() is False
        else:
            assert driver.state()["y"] == 226
            assert driver.bug_hits()["6"] is False
    finally:
        driver.close()
