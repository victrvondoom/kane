import os
import re
from pathlib import Path
from types import SimpleNamespace

import pytest

from pt import sts2_paths


@pytest.fixture(autouse=True)
def no_local_environment(monkeypatch):
    monkeypatch.setattr('pt.env.load_local_env', lambda: None)


@pytest.mark.parametrize('value', [None, ''])
def test_path_requires_a_setting(tmp_path, monkeypatch, value):
    if value is None:
        monkeypatch.delenv('PLAYTEST_STS2_ROOT', raising=False)
    else:
        monkeypatch.setenv('PLAYTEST_STS2_ROOT', value)
    target = tmp_path / 'x'
    with pytest.raises(ValueError, match='Nothing was written'):
        sts2_paths.test_path(target)
    assert not target.exists()


def test_refused_roots(tmp_path, monkeypatch):
    cases = [
        ('relative', None),
        (tmp_path.anchor, None),
        (str(Path(tmp_path.anchor) / 'x' / '..'), None),
        (str(Path.home()), None),
        (str(Path.home().parent), None),
        (str(tmp_path / 'Steamapps' / 'x'), None),
        (str(tmp_path / 'saves' / 'x'), None),
        (str(tmp_path / 'roam' / 'x'), tmp_path / 'roam'),
        (str(tmp_path / 'roam'), tmp_path / 'roam'),
        (str(tmp_path), tmp_path / 'roam'),
    ]
    for root, appdata in cases:
        if appdata is None:
            monkeypatch.delenv('APPDATA', raising=False)
        else:
            monkeypatch.setenv('APPDATA', str(appdata))
        monkeypatch.setenv('PLAYTEST_STS2_ROOT', root)
        with pytest.raises(ValueError, match='PLAYTEST_STS2_ROOT is refused'):
            sts2_paths.isolated_root()


def test_drive_root_refused_when_home_is_on_another_drive(tmp_path, monkeypatch):
    other_drive = SimpleNamespace(is_relative_to=lambda _: False)
    monkeypatch.setattr(Path, 'home', lambda: SimpleNamespace(resolve=lambda: other_drive))
    monkeypatch.delenv('APPDATA', raising=False)
    monkeypatch.setenv('PLAYTEST_STS2_ROOT', tmp_path.anchor)
    with pytest.raises(ValueError, match='file system root'):
        sts2_paths.isolated_root()


def test_appdata_sibling_root_is_allowed(tmp_path, monkeypatch):
    appdata = tmp_path / 'roam'
    root = tmp_path / 'isolated'
    monkeypatch.setenv('APPDATA', str(appdata))
    monkeypatch.setenv('PLAYTEST_STS2_ROOT', str(root))
    assert sts2_paths.isolated_root() == root.resolve()


def test_good_root_rules(tmp_path, monkeypatch):
    root = tmp_path / 'isolated'
    monkeypatch.setenv('PLAYTEST_STS2_ROOT', str(root))
    assert sts2_paths.test_path(root / 'child') == (root / 'child').resolve()
    for value in (root, tmp_path / 'outside', root / 'saves' / 'child', root / 'AppData' / 'child'):
        with pytest.raises(ValueError, match='inside the isolated test area'):
            sts2_paths.test_path(value)


def test_load_local_env_is_called(tmp_path, monkeypatch):
    root = tmp_path / 'isolated'
    monkeypatch.setenv('PLAYTEST_STS2_ROOT', 'placeholder')
    monkeypatch.setattr('pt.env.load_local_env', lambda: os.environ.__setitem__('PLAYTEST_STS2_ROOT', str(root)))
    assert sts2_paths.test_path(root / 'child') == (root / 'child').resolve()


def test_sts2_paths_holds_no_drive_path():
    source = Path(__file__).resolve().parents[1] / 'pt/sts2_paths.py'
    assert not re.search(r'\b[A-Za-z]:[/\\]', source.read_text())


def test_example_holds_no_drive_path():
    source = Path(__file__).resolve().parents[1] / 'games/sts2.fix.example.json'
    text = source.read_text()
    assert not re.search(r'\b[A-Za-z]:[/\\]', text)
    assert 'REPLACE-test-folder' in text
