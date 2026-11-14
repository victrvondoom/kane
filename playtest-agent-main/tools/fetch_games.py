"""Fetch pinned web games as static files: python -m tools.fetch_games."""
import hashlib
import io
import json
import re
import stat
import sys
import zipfile
from pathlib import Path, PurePosixPath
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from pt.python_version import require_supported
require_supported()
MANIFEST = Path(__file__).with_name('games-manifest.json')
MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_EXPANDED_BYTES = 128 * 1024 * 1024


def load_manifest(path=MANIFEST):
    specs = json.loads(Path(path).read_text(encoding='utf-8'))
    names = set()
    for spec in specs:
        name, commit, digest = spec['name'], spec['commit'], spec['sha256']
        if not re.fullmatch(r'[a-z0-9][a-z0-9-]*', name) or name in names:
            raise ValueError('invalid or duplicate game name')
        names.add(name)
        if not re.fullmatch(r'[0-9a-f]{40}', commit):
            raise ValueError(f'{name}: expected a full commit')
        if not re.fullmatch(r'[0-9a-f]{64}', digest):
            raise ValueError(f'{name}: expected a SHA-256')
        expected = f"https://codeload.github.com/{spec['repo']}/zip/{commit}"
        if spec['url'] != expected:
            raise ValueError(f'{name}: archive URL must name the pinned commit')
    return specs


def download(url):
    with urlopen(url, timeout=60) as response:
        data = response.read(MAX_ARCHIVE_BYTES + 1)
    if len(data) > MAX_ARCHIVE_BYTES:
        raise ValueError('archive is too large')
    return data


def fetch_game(spec, cache, downloader=download):
    """Verify before writing. Never build, import or run downloaded files."""
    name = spec['name']
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]*', name):
        raise ValueError('invalid game path')
    data = downloader(spec['url'])
    digest = hashlib.sha256(data).hexdigest()
    if digest != spec['sha256']:
        raise ValueError(f"{name}: SHA-256 mismatch: expected {spec['sha256']}, got {digest}")
    cache = Path(cache).resolve()
    target = cache / name
    if target.is_symlink() or target.resolve().parent != cache:
        raise ValueError('unsafe cache path')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        files, roots, total = [], set(), 0
        for entry in archive.infolist():
            parts = PurePosixPath(entry.filename).parts
            if (not parts or entry.filename.startswith('/') or '\\' in entry.filename
                    or any(p in ('.', '..') or ':' in p for p in parts)
                    or stat.S_ISLNK(entry.external_attr >> 16)):
                raise ValueError('unsafe archive path')
            roots.add(parts[0])
            if entry.is_dir():
                continue
            if len(parts) < 2:
                raise ValueError('archive path has no root folder')
            relative = Path(*parts[1:])
            dest = target / relative
            if not dest.resolve().is_relative_to(target.resolve()):
                raise ValueError('unsafe cache path')
            total += entry.file_size
            if total > MAX_EXPANDED_BYTES:
                raise ValueError('expanded archive is too large')
            files.append((entry, dest))
        entry_points = (target / 'index.html', target / 'public' / 'index.html')
        if len(roots) != 1 or not any(dest in entry_points for _, dest in files):
            raise ValueError('archive must contain one game folder with index.html')
        # Read and check ZIP CRCs before changing an existing cache.
        contents = [(dest, archive.read(entry)) for entry, dest in files]
    for dest, content in contents:
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(content)
    return target


def main():
    try:
        for spec in load_manifest():
            folder = fetch_game(spec, ROOT / 'games.cache')
            print(f"{spec['name']}: SHA-256 verified, saved to {folder}")
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
