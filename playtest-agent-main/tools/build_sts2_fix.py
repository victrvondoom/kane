"""Build an unofficial test patch without installing it or changing saves."""
import argparse
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from pt.sts2_paths import test_path
from tools.build_sts2_mod import compile_mod


def build(src, out, *, game_folder, runner=subprocess.run):
    out, game = test_path(out), test_path(game_folder)
    src = Path(src).resolve(strict=True)
    if (src == out or out.is_relative_to(src) or src.is_relative_to(out)
            or out == game or out.is_relative_to(game) or game.is_relative_to(out)):
        raise ValueError('Build output must be separate from source and game folders')
    for path in [src, *src.rglob('*'), *out.rglob('*')]:
        if path.is_symlink() or path.is_junction():
            raise ValueError('Source must not contain links')
    for name in ('pt_fix.csproj', 'pt_fix.json', 'Fix.cs'):
        if not (src / name).is_file():
            raise ValueError(f'Missing mod file: {name}')
    if not game.is_dir():
        raise ValueError('Game copy must already exist')
    out.mkdir(parents=True, exist_ok=True)
    compile_mod(src, out / 'build', game, 'pt_fix', runner=runner, isolated=True)
    shutil.copy2(out / 'build/pt_fix.dll', out / 'pt_fix.dll')
    shutil.copy2(src / 'pt_fix.json', out / 'pt_fix.json')
    return out


def main(argv=None, *, runner=subprocess.run):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--src', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--game-folder', type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        out = build(args.src, args.out, game_folder=args.game_folder, runner=runner)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        return 1
    print(f'Test patch built in {out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
