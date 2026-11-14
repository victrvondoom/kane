"""Install a test patch only for a replay, then remove the files we installed."""
from contextlib import contextmanager
from pathlib import Path
import shutil

from pt.sts2_paths import test_path


def destination(cfg):
    game = test_path(cfg['mod']['game_folder'])
    if Path(cfg['game']['exe']).resolve().parent != game:
        raise ValueError('Mod game_folder must contain the replay executable')
    return test_path(game / 'mods/pt_fix')


def validate(cfg):
    if cfg['game']['type'] != 'pcgame':
        raise ValueError('A mod replay requires a pcgame config')
    if cfg['game'].get('use_mod', True) is False or '--nomods' in cfg['game'].get('args', []):
        raise ValueError('A mod replay must enable mods')
    target = destination(cfg)
    if target.exists():
        raise ValueError('Refusing an existing pt_fix mod; remove it before the control replay')
    test_path(cfg['game']['run_root'])
    command = cfg.get('replay_check')
    if (not isinstance(command, list) or not command
            or not all(isinstance(v, str) for v in command)
            or not any('{frame}' in v for v in command)):
        raise ValueError('replay_check must be a command with a {frame} argument')


def work_folder(cfg):
    from pt import sts2_paths
    validate(cfg)
    folder = test_path(sts2_paths.isolated_root() / 'fix-work')
    folder.mkdir(parents=True, exist_ok=True)
    return folder


@contextmanager
def installed(cfg, out):
    target = destination(cfg)
    files = ('pt_fix.dll', 'pt_fix.json')
    for name in files:
        path = test_path(Path(out) / name)
        if not path.is_file():
            raise ValueError(f'Missing built mod file: {name}')
    target.parent.mkdir(parents=True, exist_ok=True)
    target.mkdir(exist_ok=False)
    try:
        for name in files:
            shutil.copy2(Path(out) / name, target / name)
        yield
    finally:
        # Never recursively remove a game folder or an unrelated mod.
        for name in files:
            test_path(target / name).unlink(missing_ok=True)
        target.rmdir()


def picture_check(command, trace, folder, execute):
    frame = Path(folder) / 'check.jpg'
    frame.write_bytes(trace['frames'][-1])
    try:
        return execute([v.replace('{frame}', str(frame)) for v in command])
    finally:
        frame.unlink(missing_ok=True)
