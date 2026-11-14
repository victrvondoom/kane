"""Run a fixed sequence against an isolated PC game without a model."""
import argparse
import json
from pathlib import Path
import sys
import time

from pt.pcgame import PcGameAdapter
from pt.pcwin import Win32


def run(game, steps_path, out, *, no_mod=False, seed_profile=None, save_profile=None,
        win=None, clock=time.monotonic, adapter_factory=PcGameAdapter, owner_input=None):
    steps = json.loads(Path(steps_path).read_text(encoding='utf-8'))
    if not isinstance(steps, list):
        raise ValueError('steps must be a list')
    win = win or Win32()
    owner_input = owner_input or (lambda: win.last_input() / 1000)
    started_at = clock()
    if no_mod and started_at - owner_input() < 600:
        print('Refusing --no-mod: owner input was less than 600 seconds ago')
        return 3
    cfg = dict(game) if isinstance(game, dict) else None
    if cfg is None:
        from pt.adapter import config_path, load_config
        game_path = Path(game)
        cfg = load_config(game_path if game_path.is_file() else config_path(game))
    if no_mod: cfg['use_mod'] = False
    if seed_profile: cfg['seed_profile'] = str(seed_profile)
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    adapter = None
    history = []
    completed = []
    code = 0
    try:
        adapter = adapter_factory(cfg, win=win)
        for index, step in enumerate(steps):
            if no_mod and clock() - owner_input() < 600:
                print('Stopping --no-mod run: owner input detected')
                code = 4
                break
            if len(step) != 1:
                raise ValueError(f'step {index} must have one operation')
            at_s = round(adapter.clock() - adapter.started_at, 2)
            kind, value = next(iter(step.items()))
            if kind == 'shot':
                image = adapter.full_frame()
                image.save(out / f'{index:03d}-{value}.jpg', format='JPEG', quality=85)
            elif kind in ('click', 'move', 'drag'):
                adapter.frame_input(kind, *value)
            elif kind == 'key':
                key = str(value).lower()
                if (no_mod and key != 'esc') or (not no_mod and key == '`'):
                    raise ValueError('key step is not permitted')
                adapter.key_input(key)
            elif kind == 'wait': adapter.sleep(value / 1000)
            elif kind == 'console': adapter.console_input(value)
            elif kind == 'status': history.append({'status': value, 'health': adapter.health()})
            else: raise ValueError(f'unknown step: {kind}')
            completed.append({**step, 'at_s': at_s})
        run_folder = str(adapter.run)
    except BaseException:
        if adapter is not None: adapter.close()
        raise
    finally:
        if adapter is not None:
            adapter.close()
    if save_profile and adapter:
        adapter.save_profile(save_profile)
    log = adapter.run / 'godot.log'
    lines = [line for line in log.read_text(encoding='utf-8', errors='replace').splitlines()
             if 'ERROR:' in line or 'Exception' in line][:40] if log.exists() else []
    result = {'steps': completed, 'statuses': history,
              'final_health': adapter.health(), 'run_folder': run_folder, 'godot_errors': lines}
    (out / 'result.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    if adapter.win.alive(adapter.pid): raise RuntimeError('game process is still alive after close')
    print(adapter.health()['pointer_moves_without_input'])
    return code


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('game')
    parser.add_argument('steps')
    parser.add_argument('out')
    parser.add_argument('--no-mod', action='store_true')
    parser.add_argument('--seed-profile')
    parser.add_argument('--save-profile')
    args = parser.parse_args(argv)
    return run(args.game, args.steps, args.out, no_mod=args.no_mod,
               seed_profile=args.seed_profile, save_profile=args.save_profile)


if __name__ == '__main__':
    raise SystemExit(main())
