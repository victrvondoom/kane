import io
import json
import hashlib
import zipfile
from pathlib import Path

import pytest

from pt.adapter import load_config

ROOT = Path(__file__).resolve().parents[1]
NAMES = ('2048', 'hextris', 'tetris', 'breakout')
FETCHED_NAMES = (*NAMES, 'react-chess')


def archive(files=None):
    data = io.BytesIO()
    with zipfile.ZipFile(data, 'w') as out:
        for name, content in (files or {'upstream-commit/index.html': '<html>game</html>'}).items():
            out.writestr(name, content)
    return data.getvalue()


def test_every_game_config_validates():
    for path in sorted((ROOT / 'games').glob('*.json')):
        if path.name.endswith('.fix.example.json'):
            continue
        load_config(path)
    for name in NAMES:
        cfg = load_config(ROOT / 'games' / f'{name}.json')
        assert cfg['serve']['dir'] == f'games.cache/{name}'
        assert cfg['controls'] and cfg['goal'] and cfg['notes']
        assert cfg['frame_lock'] is False
        assert 'frame_js' not in cfg


def test_fetch_writes_static_files_and_checks_hash(tmp_path):
    from tools.fetch_games import fetch_game
    data = archive()
    calls = []
    spec = {'name': 'sample', 'url': 'https://example.test/game.zip',
            'sha256': hashlib.sha256(data).hexdigest()}
    def download(url):
        calls.append(url)
        return data
    result = fetch_game(spec, tmp_path, downloader=download)
    assert result == tmp_path / 'sample'
    assert (result / 'index.html').read_text() == '<html>game</html>'
    assert calls == [spec['url']]
    spec['sha256'] = '0' * 64
    with pytest.raises(ValueError, match='SHA-256'):
        fetch_game(spec, tmp_path, downloader=download)
    assert (result / 'index.html').read_text() == '<html>game</html>'


@pytest.mark.parametrize('member', [
    'upstream/../../escape', 'upstream/C:/escape', 'upstream/../escape',
    r'upstream/..\..\escape', '/upstream/index.html',
])
def test_fetch_refuses_unsafe_paths(tmp_path, member):
    from tools.fetch_games import fetch_game
    data = archive({member: 'unsafe'})
    spec = {'name': 'sample', 'url': 'https://example.test/game.zip',
            'sha256': hashlib.sha256(data).hexdigest()}
    with pytest.raises(ValueError, match='path'):
        fetch_game(spec, tmp_path, downloader=lambda url: data)
    assert not (tmp_path / 'sample').exists()


def test_licences_and_pins_cover_each_config():
    from tools.fetch_games import load_manifest
    rows = (ROOT / 'docs' / 'GAMES-LICENCES.md').read_text(encoding='utf-8')
    specs = load_manifest()
    assert {spec['name'] for spec in specs} == set(FETCHED_NAMES)
    for spec in specs:
        assert len(spec['commit']) == 40 and int(spec['commit'], 16)
        assert len(spec['sha256']) == 64 and int(spec['sha256'], 16)
        assert spec['commit'] in spec['url']
        assert f"| {spec['name']} |" in rows
        assert spec['commit'] in rows
        assert f"/{spec['commit']}/" in rows

@pytest.mark.parametrize('files', [
    {'index.html': 'no wrapper'},
    {'one/index.html': 'game', 'two/extra.txt': 'other root'},
    {'one/readme.txt': 'no entry point'},
])
def test_fetch_refuses_incomplete_or_mixed_archives(tmp_path, files):
    from tools.fetch_games import fetch_game
    data = archive(files)
    spec = {'name': 'sample', 'url': 'https://example.test/game.zip',
            'sha256': hashlib.sha256(data).hexdigest()}
    with pytest.raises(ValueError):
        fetch_game(spec, tmp_path, downloader=lambda url: data)
    assert not (tmp_path / 'sample').exists()


def test_fetch_refuses_archive_symlinks(tmp_path):
    from tools.fetch_games import fetch_game
    data = io.BytesIO()
    with zipfile.ZipFile(data, 'w') as out:
        entry = zipfile.ZipInfo('upstream/index.html')
        entry.create_system = 3
        entry.external_attr = 0o120777 << 16
        out.writestr(entry, '../../escape')
    content = data.getvalue()
    spec = {'name': 'sample', 'url': 'https://example.test/game.zip',
            'sha256': hashlib.sha256(content).hexdigest()}
    with pytest.raises(ValueError, match='path'):
        fetch_game(spec, tmp_path, downloader=lambda url: content)
    assert not (tmp_path / 'sample').exists()


@pytest.mark.parametrize(('field', 'value'), [
    ('commit', 'main'), ('sha256', 'unknown'),
    ('url', 'https://example.test/unpinned.zip'), ('name', '../escape'),
])
def test_manifest_refuses_unpinned_or_unsafe_sources(tmp_path, field, value):
    from tools.fetch_games import load_manifest
    spec = dict(load_manifest()[0])
    spec[field] = value
    path = tmp_path / 'manifest.json'
    path.write_text(json.dumps([spec]))
    with pytest.raises(ValueError):
        load_manifest(path)
