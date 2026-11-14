"""Bundle the pinned chess snapshot without changing its source files."""
import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGES = ('esbuild@0.25.0', 'react@16.13.1', 'react-dom@16.13.1')
HTML = '''<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chess</title><link rel="stylesheet" href="bundle.css"></head>
<body><div id="root"></div><script src="bundle.js"></script></body>
</html>
'''


def build(src, out, *, runner=subprocess.run, cache=None):
    src, out = Path(src).resolve(), Path(out).resolve()
    cache = Path(cache or ROOT / 'games.cache' / 'chess-build').resolve()
    entry = src / 'src' / 'index.js'
    if not entry.is_file():
        raise ValueError(f'Missing entry point: {entry}')
    if (out == src or src.is_relative_to(out)
            or any(out.is_relative_to(src / folder) for folder in ('src', 'public', '.git'))):
        raise ValueError('Output must be separate from the source files')
    if cache == src or cache.is_relative_to(src):
        raise ValueError('Build packages must be separate from the source')
    cache.mkdir(parents=True, exist_ok=True)
    npm = shutil.which('npm.cmd' if sys.platform == 'win32' else 'npm')
    node = shutil.which('node')
    if not npm or not node:
        raise ValueError('Install node and npm before building chess')
    # Install only these packages, never the upstream package.json or its scripts.
    runner([npm, 'install', '--prefix', str(cache), '--no-audit', '--no-fund',
            '--save-exact', *PACKAGES], check=True, cwd=cache)
    modules = cache / 'node_modules'
    options = {
        'entryPoints': [str(entry)], 'bundle': True, 'outfile': str(out / 'bundle.js'),
        'loader': {'.js': 'jsx'}, 'platform': 'browser', 'format': 'iife',
        'define': {'process.env.NODE_ENV': '"production"'},
        'alias': {'react': str(modules / 'react'), 'react-dom': str(modules / 'react-dom')},
        'nodePaths': [str(modules)], 'legalComments': 'inline',
    }
    # JSX is in .js files. Resolution aliases also support patched copies outside the cache.
    driver = (f'const esbuild = require({json.dumps(str(modules / "esbuild"))});\n'
              f'esbuild.buildSync({json.dumps(options)});\n')
    out.mkdir(parents=True, exist_ok=True)
    runner([node, '-'], input=driver, text=True, check=True, cwd=cache)
    (out / 'index.html').write_text(HTML, encoding='utf-8')
    shutil.copyfile(src / 'LICENSE', out / 'LICENSE')
    return out


def main(argv=None, *, runner=subprocess.run, cache=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--src', type=Path, default=ROOT / 'games.cache' / 'react-chess')
    parser.add_argument('--out', type=Path, default=ROOT / 'games.cache' / 'react-chess' / 'dist')
    args = parser.parse_args(argv)
    try:
        out = build(args.src, args.out, runner=runner, cache=cache)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        return 1
    print(f'Chess built in {out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
