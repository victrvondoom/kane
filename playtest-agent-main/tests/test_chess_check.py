import importlib.util
from pathlib import Path


spec = importlib.util.spec_from_file_location(
    'chess_check', Path(__file__).resolve().parents[1] / 'tools' / 'chess_check.py')
chess_check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(chess_check)
square_index = chess_check.square_index


def test_square_index_uses_row_major_chess_board_order():
    assert square_index('a8') == 0
    assert square_index('e2') == 52
    assert square_index('h1') == 63


def test_square_index_rejects_invalid_square():
    import pytest

    with pytest.raises(ValueError):
        square_index('i9')


def test_board_piece_name_from_background_image():
    assert chess_check.piece_from_style('background-image: url("https://example.test/Chess_plt45.svg")') == 'plt45'
    assert chess_check.piece_from_style('') is None


def test_captured_piece_selector_checks_the_two_fallen_soldier_rows():
    class FakeRow:
        def __init__(self, count):
            self._count = count

        def locator(self, selector):
            assert selector == 'button.square'
            return self

        def count(self):
            return self._count

    class FakeRows:
        def __init__(self):
            self.rows = [FakeRow(0), FakeRow(1)]

        def count(self):
            return len(self.rows)

        def nth(self, index):
            return self.rows[index]

    class FakePage:
        def locator(self, selector):
            assert selector == '.fallen-soldier-block .board-row'
            return FakeRows()

    assert chess_check.has_captured_piece(FakePage())


import os
import subprocess
import sys
from pathlib import Path

import pytest


@pytest.mark.browser
@pytest.mark.skipif(os.environ.get('PT_BROWSER_TESTS') != '1', reason='Set PT_BROWSER_TESTS=1 for browser proof')
def test_normal_play_browser_check():
    root = Path(__file__).resolve().parents[1]
    subprocess.run([sys.executable, str(root / 'tools' / 'chess_check.py'),
                    str(root / 'games.cache' / 'react-chess' / 'dist')],
                   cwd=root, check=True)
