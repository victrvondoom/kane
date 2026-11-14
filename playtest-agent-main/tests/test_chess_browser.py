"""Browser proof owed to the owner when the browser slot is free."""
import os
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(os.environ.get('PT_BROWSER_TESTS') != '1',
                                reason='Set PT_BROWSER_TESTS=1 for browser proof')
ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def browser_slot():
    from pt import guard
    problems = guard.problems()
    if problems:
        pytest.skip('; '.join(problems))
    guard.take_lock()
    try:
        yield
    finally:
        guard.release_lock()


@pytest.mark.parametrize('name', ['react-chess', 'chess-control'])
def test_chess_page_state_and_clicks(browser_slot, name):
    from pt.adapter import WebAdapter, load_config
    driver = WebAdapter(load_config(ROOT / 'games' / f'{name}.json'))
    try:
        state = driver.state()
        assert len(state['board']) == 64
        assert state['board'][0] == 'rdt45'
        assert state['board'][63] == 'rlt45'
        assert state['board'].count(None) == 32
        squares = driver.page.locator('button.square')
        squares.nth(52).click()  # e2
        squares.nth(36).click()  # e4
        state = driver.state()
        assert state['board'][52] is None
        assert state['board'][36] == 'plt45'
        assert 'black' in state['turn']
    finally:
        driver.close()


def test_chess_page_illegal_moves_mate_and_restart(browser_slot):
    from pt.adapter import WebAdapter, load_config
    driver = WebAdapter(load_config(ROOT / 'games' / 'chess-control.json'))
    try:
        squares = driver.page.locator('button.square')
        before = driver.state()['board']
        squares.nth(52).click(); squares.nth(28).click()  # e2 to e5
        assert driver.state()['board'] == before
        for start, end in [(53, 45), (12, 28), (54, 38), (3, 39)]:
            squares.nth(start).click(); squares.nth(end).click()
        state = driver.state()
        assert state['status'] == 'Checkmate. Black wins.'
        squares.nth(48).click(); squares.nth(40).click()
        assert driver.state() == state
        driver.page.locator('#new-game').click()
        assert driver.state()['board'] == before
    finally:
        driver.close()
