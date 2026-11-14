"""Limit mod build and replay writes to the isolated test area."""
import os
from pathlib import Path

def isolated_root():
    from pt import env
    env.load_local_env()
    value = os.environ.get('PLAYTEST_STS2_ROOT', '').strip()
    if not value:
        raise ValueError('Set PLAYTEST_STS2_ROOT to the isolated test folder first. Nothing was written.')
    path = Path(value)
    resolved = path.resolve()
    refused = 'PLAYTEST_STS2_ROOT is refused: '
    if not path.is_absolute():
        raise ValueError(refused + 'path must be absolute')
    if resolved == Path(resolved.anchor):
        raise ValueError(refused + 'path must not be a file system root')
    home = Path.home().resolve()
    if home.is_relative_to(resolved):
        raise ValueError(refused + 'path must not contain the home folder')
    if {'steamapps', 'saves', 'save', 'profiles'}.intersection(part.lower() for part in resolved.parts):
        raise ValueError(refused + 'path contains a forbidden folder')
    appdata_value = os.environ.get('APPDATA', '').strip()
    if appdata_value:
        appdata = Path(appdata_value).resolve()
        if appdata.is_relative_to(resolved) or resolved.is_relative_to(appdata):
            raise ValueError(refused + 'path contains or is inside APPDATA')
    return resolved


def test_path(value):
    root = isolated_root()
    path = Path(value).resolve()
    forbidden = {'steamapps', 'appdata', 'saves', 'save', 'profiles'}
    if (path == root or not path.is_relative_to(root)
            or forbidden.intersection(part.lower() for part in path.relative_to(root).parts)):
        raise ValueError('Target must be inside the isolated test area, outside Steam and saves')
    # Resolve every existing parent too, so junctions cannot redirect writes.
    for parent in [Path(value).absolute(), *Path(value).absolute().parents]:
        if parent.is_symlink() or parent.is_junction():
            raise ValueError('Target must not contain links')
    return path
