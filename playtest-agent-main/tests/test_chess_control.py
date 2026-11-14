"""Chess rules and build checks without opening a browser."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -'


def engine(script):
    node = shutil.which('node')
    if not node:
        pytest.skip('node is required to run the chess engine')
    result = subprocess.run(
        [node, '-e', "const {Chess} = require('./game/chess_control_engine.js');\n" + script],
        cwd=ROOT, capture_output=True, text=True, timeout=60,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


@pytest.mark.parametrize(('fen', 'counts'), [
    (START, [20, 400, 8902, 197281]),
    ('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq -', [48, 2039, 97862]),
    ('8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - -', [14, 191, 2812]),
])
def test_perft(fen, counts):
    assert engine(f'const g = new Chess({json.dumps(fen)}); console.log(JSON.stringify('
                  f'{json.dumps(counts)}.map((_, i) => g.perft(i + 1))));') == counts


def test_fools_mate_and_terminal_lock():
    assert engine("""
        const g = new Chess();
        const moves = ['f2f3','e7e5','g2g4','d8h4'].map(m => g.move(m));
        const before = JSON.stringify(g.board);
        console.log(JSON.stringify([moves, g.status(), g.move('a2a3'), before === JSON.stringify(g.board)]));
    """) == [[True] * 4, {'type': 'checkmate', 'winner': 'b'}, False, True]


def test_stalemate_and_check():
    assert engine("""
        console.log(JSON.stringify([
            new Chess('7k/5Q2/6K1/8/8/8/8/8 b - -').status(),
            new Chess('7k/8/8/8/8/8/8/K6R b - -').status()
        ]));
    """) == [{'type': 'stalemate', 'winner': None}, {'type': 'check', 'winner': None}]


@pytest.mark.parametrize('fen', [
    '4kr2/8/8/8/8/8/8/4K2R w K -',  # Transit square attacked.
    '4k1r1/8/8/8/8/8/8/4K2R w K -',  # Destination attacked.
    'k3r3/8/8/8/8/8/8/4K2R w K -',  # King in check.
    '4k3/8/8/8/8/8/8/4KB1R w K -',  # Occupied path.
    '4k3/8/8/8/8/8/8/4K3 w K -',  # No rook.
    '4k3/8/8/8/8/8/8/4K2R w - -',  # No rights.
])
def test_castling_refused(fen):
    assert engine(f'console.log(JSON.stringify(new Chess({json.dumps(fen)}).move("e1g1")));') is False


def test_castling_rook_and_rights():
    assert engine("""
        const g = new Chess('r3k2r/8/8/8/8/8/8/R3K2R w KQkq -');
        const ok = [g.move('e1g1'), g.move('e8c8')];
        console.log(JSON.stringify([ok, [g.board[62], g.board[61], g.board[2], g.board[3]], g.castling]));
    """) == [[True, True], ['K', 'R', 'k', 'r'], '']
    assert engine("""
        const g = new Chess('4k3/8/8/8/8/8/8/4K2R w K -');
        ['h1h2','e8e7','h2h1','e7e8'].forEach(m => g.move(m));
        console.log(JSON.stringify(g.move('e1g1')));
    """) is False


def test_en_passant_expires_and_removes_pawn():
    assert engine("""
        const fen = '4k3/3p4/8/4P3/8/8/8/4K3 b - -';
        const g = new Chess(fen); g.move('d7d5');
        const ok = g.move('e5d6');
        const h = new Chess(fen); ['d7d5','e1e2','e8e7'].forEach(m => h.move(m));
        console.log(JSON.stringify([ok, g.board[19], g.board[27], h.move('e5d6')]));
    """) == [True, 'P', None, False]


def test_en_passant_cannot_expose_king_and_pinned_piece_cannot_move():
    assert engine("""
        console.log(JSON.stringify([
            new Chess('8/8/8/r4pPK/8/8/8/4k3 w - f6').move('g5f6'),
            new Chess('k3r3/8/8/8/8/8/4R3/4K3 w - -').move('e2f2'),
            new Chess('8/8/8/8/8/4k3/8/4K3 w - -').move('e1e2')
        ]));
    """) == [False, False, False]


def test_promotion():
    assert engine("""
        const g = new Chess('7k/P7/8/8/8/8/8/7K w - -');
        const promotions = g.legalMoves().filter(m => m.from === 8).map(m => m.promotion).sort();
        console.log(JSON.stringify([promotions, g.move('a7a8'), g.board[0]]));
    """) == [['b', 'n', 'q', 'r'], True, 'Q']


def test_configs():
    from pt.adapter import validate
    configs = [json.loads((ROOT / 'games' / f'{name}.json').read_text())
               for name in ('react-chess', 'chess-control')]
    for cfg in configs:
        assert validate(cfg) == []
        assert 'click' in cfg['controls']
        words = json.dumps(cfg).lower()
        for forbidden in ('issue', 'bug', 'broken', 'jump over a piece'):
            assert forbidden not in words
        assert cfg['frame_lock'] is False
        assert cfg['viewport'] == {'width': 900, 'height': 620}
    assert configs[0]['controls'] == configs[1]['controls']
    assert configs[0]['goal'] == configs[1]['goal']
    assert configs[1]['name'] == 'Chess'


def test_build_arguments_and_source_preserved(tmp_path, monkeypatch):
    monkeypatch.setattr(shutil, 'which', lambda name: name)
    from tools.build_chess import main
    src, out, cache = (tmp_path / p for p in ('source copy', 'output copy', 'npm cache'))
    (src / 'src').mkdir(parents=True)
    (src / 'src' / 'index.js').write_text('const view = <div/>;')
    (src / 'LICENSE').write_text('MIT License')
    before = {p.relative_to(src): p.read_bytes() for p in src.rglob('*') if p.is_file()}
    calls = []

    def runner(args, **kwargs):
        calls.append((args, kwargs))
        return subprocess.CompletedProcess(args, 0)

    assert main(['--src', str(src), '--out', str(out)], runner=runner, cache=cache) == 0
    assert len(calls) == 2
    assert all(c[1]['check'] for c in calls)
    assert '--prefix' in calls[0][0]
    for package in ('esbuild@0.25.0', 'react@16.13.1', 'react-dom@16.13.1'):
        assert package in calls[0][0]
    driver = calls[1][1]['input']
    assert str(src / 'src' / 'index.js').replace('\\', '\\\\') in driver
    assert str(out).replace('\\', '\\\\') in driver
    assert 'jsx' in driver
    assert (out / 'index.html').is_file()
    assert (out / 'LICENSE').read_text() == 'MIT License'
    assert before == {p.relative_to(src): p.read_bytes() for p in src.rglob('*') if p.is_file()}
    with pytest.raises(SystemExit):
        main(['--unknown'], runner=runner, cache=cache)


def test_build_defaults(tmp_path, monkeypatch):
    from tools import build_chess
    calls = []
    monkeypatch.setattr(build_chess, 'build', lambda src, out, **kw: calls.append((src, out)) or out)
    assert build_chess.main([]) == 0
    assert calls == [(ROOT / 'games.cache' / 'react-chess', ROOT / 'games.cache' / 'react-chess' / 'dist')]


def test_build_rejects_source_output_collision(tmp_path):
    from tools.build_chess import build
    (tmp_path / 'src').mkdir()
    (tmp_path / 'public').mkdir()
    (tmp_path / 'src' / 'index.js').write_text('source')
    (tmp_path / 'public' / 'index.html').write_text('template')
    with pytest.raises(ValueError, match='source'):
        build(tmp_path, tmp_path / 'public', runner=lambda *a, **kw: None)
    assert (tmp_path / 'public' / 'index.html').read_text() == 'template'


def test_fetch_react_entry_template(tmp_path):
    from tools.fetch_games import fetch_game
    import hashlib
    import io
    import zipfile
    data = io.BytesIO()
    with zipfile.ZipFile(data, 'w') as z:
        z.writestr('upstream/public/index.html', '<div id="root"></div>')
    content = data.getvalue()
    spec = {'name': 'react-chess', 'url': 'unused', 'sha256': hashlib.sha256(content).hexdigest()}
    folder = fetch_game(spec, tmp_path, downloader=lambda _: content)
    assert (folder / 'public' / 'index.html').is_file()
