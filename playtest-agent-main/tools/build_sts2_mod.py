"""Build and install an input mod into an isolated, non Steam game copy."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]


def compile_mod(src, out, game, mod, *, runner=subprocess.run, isolated=False):
    """Compile with local references and keep compiler output outside the source."""
    command = ['dotnet', 'build', str(src / f'{mod}.csproj'), '-c', 'Release',
               f'-p:Sts2Dir={game}', '--output', str(out)]
    if isolated:
        command += [f'-p:BaseIntermediateOutputPath={out / "obj"}{os.sep}',
                    '-p:NuGetAudit=false',
                    f'-p:RestorePackagesPath={out / "packages"}']
    env = {**os.environ, 'DOTNET_CLI_TELEMETRY_OPTOUT': '1', 'DOTNET_SKIP_FIRST_TIME_EXPERIENCE': '1'}
    runner(command, check=True, env=env, cwd=src)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('game_folder')
    parser.add_argument('--mod', default='pt_input', choices=['pt_input'])
    args = parser.parse_args(argv)
    game = Path(args.game_folder).resolve()
    if 'steamapps' in str(game).lower():
        print('Refusing a steamapps path: build only into an isolated game copy.', file=sys.stderr)
        return 2
    mod = ROOT / 'mods' / args.mod
    compile_mod(mod, mod / 'bin/Release/net9.0', game, args.mod)
    destination = game / 'mods' / args.mod
    destination.mkdir(parents=True, exist_ok=True)
    shutil.copy2(mod / 'bin/Release/net9.0' / f'{args.mod}.dll', destination)
    shutil.copy2(mod / f'{args.mod}.json', destination)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
