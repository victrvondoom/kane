"""Headless normal-play check for the public React chess build."""
import argparse
import re
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from functools import partial
from pathlib import Path


MOVES = [
    ('e2', 'e4'), ('e7', 'e5'), ('g1', 'f3'), ('b8', 'c6'),
    ('f1', 'c4'), ('g8', 'f6'), ('d2', 'd3'), ('d7', 'd6'),
    ('c1', 'g5'), ('c8', 'g4'), ('a2', 'a4'), ('a7', 'a5'),
    ('a1', 'a3'), ('a8', 'a6'), ('d1', 'd2'), ('d8', 'd7'),
    ('e1', 'e2'), ('e8', 'e7'), ('c4', 'f7'),
]
ILLEGAL_MOVES = [('e4', 'd4'), ('f3', 'f5'), ('a3', 'b4')]


def square_index(square):
    if not isinstance(square, str) or not re.fullmatch(r'[a-h][1-8]', square):
        raise ValueError(f'Invalid chess square: {square!r}')
    file_index = ord(square[0]) - ord('a')
    rank_index = 8 - int(square[1])
    return rank_index * 8 + file_index


def piece_from_style(style):
    match = re.search(r'Chess_([A-Za-z0-9]+)\.svg', style or '')
    return match.group(1) if match else None


def read_board(page):
    return [piece_from_style(square.get_attribute('style') or '')
            for square in page.locator('button.square').all()]


def state(page):
    return read_board(page), page.locator('#player-turn-box').get_attribute('style')


def has_captured_piece(page):
    rows = page.locator('.fallen-soldier-block .board-row')
    return any(rows.nth(index).locator('button.square').count() > 0
               for index in range(rows.count()))


def diagnostic(page, start, end, reason):
    print(f'FAIL {start} {end}: {reason}', file=sys.stderr)
    print(f'BOARD {read_board(page)}', file=sys.stderr)


def run_check(dist):
    from playwright.sync_api import sync_playwright

    class QuietHandler(SimpleHTTPRequestHandler):
        def log_message(self, format, *args):
            pass

    handler = partial(QuietHandler, directory=str(dist))
    server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    try:
        thread.start()
        with sync_playwright() as playwright:
            browser = None
            try:
                browser = playwright.chromium.launch(headless=True)
                page = browser.new_page(viewport={'width': 900, 'height': 620})
                page.goto(f'http://127.0.0.1:{server.server_port}/index.html', wait_until='domcontentloaded')
                page.wait_for_function("document.querySelectorAll('button.square').length === 64")
                squares = page.locator('button.square')
                for start, end in MOVES:
                    before_board, before_turn = state(page)
                    moving = before_board[square_index(start)]
                    if moving is None:
                        diagnostic(page, start, end, 'start square is empty')
                        return 1
                    squares.nth(square_index(start)).click()
                    squares.nth(square_index(end)).click()
                    after_board, after_turn = state(page)
                    if (after_board[square_index(end)] != moving or
                            after_board[square_index(start)] is not None or
                            after_turn == before_turn):
                        diagnostic(page, start, end, 'legal move was not applied or turn did not change')
                        return 1
                    if (start, end) == ('c4', 'f7') and not has_captured_piece(page):
                        diagnostic(page, start, end, 'captured pawn was not shown in captured list')
                        return 1
                    print(f'PASS {start} {end}')
                for start, end in ILLEGAL_MOVES:
                    before_board, before_turn = state(page)
                    squares.nth(square_index(start)).click()
                    squares.nth(square_index(end)).click()
                    after_board, after_turn = state(page)
                    if after_board != before_board or after_turn != before_turn:
                        diagnostic(page, start, end, 'illegal move changed board or turn')
                        return 1
                    print(f'PASS {start} {end} refused')
                print('NORMAL PLAY OK')
                return 0
            finally:
                if browser is not None:
                    browser.close()
    finally:
        server.shutdown()
        server.server_close()
        if thread.is_alive():
            thread.join()


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('dist', type=Path)
    args = parser.parse_args(argv)
    if not args.dist.is_dir():
        parser.error(f'Not a distribution folder: {args.dist}')
    return run_check(args.dist.resolve())


if __name__ == '__main__':
    raise SystemExit(main())
