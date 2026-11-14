import io
import json
import struct
from pathlib import Path

import pytest
from PIL import Image

from pt.adapter import validate
from pt.pcgame import PcGameAdapter
from tools import build_sts2_mod


class FakeMemory:
    def __init__(self, events):
        self.events = events
        self.value = None

    def seek(self, offset):
        pass

    def write(self, data):
        self.value = struct.unpack('<ii', data)
        self.events.append(('memory', *self.value))

    def close(self):
        self.events.append(('memory_closed',))


class FakeWin:
    def __init__(self):
        self.events = []
        self.pid = 123
        self.code = None
        self.shown = True
        self.bounds = (60, 1710, 1340, 2430)
        self.pointer = (10, 20)
        self.input = 100
        self.front = False
        self.hung = False
        self.displays = {r'\\.\DISPLAY5': (0, 1620, 1920, 2700)}
        self.memory = FakeMemory(self.events)

    def monitors(self): return self.displays
    def start(self, args, cwd, env):
        self.launch = (args, cwd, env)
        return self.pid
    def poll(self, pid): return self.code
    def alive(self, pid): return self.code is None
    def stop(self, pid):
        self.events.append(('stop', pid))
        self.code = 0
    def wait(self, pid, timeout): return self.code
    def windows(self, pid): return [77]
    def rect(self, h): return self.bounds
    def visible(self, h): return self.shown
    def title(self, h): return 'test window'
    def foreground(self, h): return self.front
    def cursor(self): return self.pointer
    def last_input(self): return self.input
    def show(self, h): self.shown = True; self.events.append(('show', h))
    def move(self, h, x, y):
        self.events.append(('move_window', h, x, y))
        self.bounds = (x, y, x + 1280, y + 720)
    def responding(self, h): return not self.hung
    def capture(self, h, size): return Image.new('RGB', size, 'red')
    def mouse_memory(self, pid):
        self.events.append(('mapping', f'pt_input_mouse_{pid}'))
        return self.memory
    def post(self, h, msg, wp, lp): self.events.append(('post', msg, wp, lp))
    def scan(self, vk): return vk


@pytest.fixture
def cfg(tmp_path):
    exe = tmp_path / 'game' / 'SlayTheSpire2.exe'
    exe.parent.mkdir()
    exe.touch()
    return dict(type='pcgame', name='test', exe=str(exe), run_root=str(tmp_path / 'runs'),
                side_display=r'\\.\DISPLAY5', allowed_keys=['esc', 'enter'], launch_wait_s=0)


@pytest.fixture
def game(cfg):
    win = FakeWin()
    obj = PcGameAdapter(cfg, win=win, hold=lambda: None, sleep=lambda _: None)
    obj._stop.set()
    obj._guard_thread.join(2)
    win.events.clear()
    yield obj, win
    obj.close()


def test_click_coordinates(game):
    obj, win = game
    obj.execute([dict(type='click', x=640, y=360)])
    assert win.memory.value == (960, 540)
    assert win.events == [('memory', 960, 540), ('post', 0x200, 0, 360 << 16 | 640),
                          ('post', 0x201, 1, 360 << 16 | 640), ('post', 0x202, 0, 360 << 16 | 640)]
    assert len(obj.executed) == len(obj.last_spans) == 1
    assert obj.last_spans[0]['to_s'] >= obj.last_spans[0]['from_s']


def test_drag_memory_precedes_every_move(game):
    obj, win = game
    obj.execute([dict(type='swipe', x=0, y=0, x2=640, y2=360)])
    posts = [e for e in win.events if e[0] == 'post']
    assert [e[1] for e in posts] == [0x200, 0x201] + [0x200] * 12 + [0x202]
    for i, event in enumerate(win.events):
        if event[:2] == ('post', 0x200):
            assert win.events[i - 1][0] == 'memory'
    assert all(e[2] == 1 for e in posts[2:14])
    assert win.memory.value == (960, 540)


def test_keys_and_refusal(game):
    obj, win = game
    obj.execute([dict(type='keypress', keys=['esc', 'enter', 'a', '`'])])
    assert [e[1] for e in win.events] == [6, 0x100, 0x101] * 2
    assert win.events[2][3] == 1 | (0x1B << 16) | (3 << 30)
    assert (obj.run / 'refused_keys.log').read_text().splitlines() == ['a', '`']
    assert obj.action_note == 'key refused: a, allowed: enter, esc; key refused: `, allowed: enter, esc'


def test_refused_key_note_clears_and_allowed_key_has_no_note(game):
    obj, win = game
    obj.execute([dict(type='keypress', keys=['escape'])])
    assert obj.action_note == 'key refused: escape, allowed: enter, esc'
    assert not [e for e in win.events if e[0] == 'post']
    obj.execute([dict(type='keypress', keys=['esc'])])
    assert obj.action_note == ''


@pytest.mark.parametrize('key', ['`', 'backquote', 'grave', '0xc0', '192', '~', 'oem_3'])
def test_backquote_config_refused(cfg, key):
    cfg['allowed_keys'] = [key]
    with pytest.raises(ValueError, match='backquote'):
        PcGameAdapter(cfg, win=FakeWin(), hold=lambda: None)


@pytest.mark.parametrize('case,reason', [('steam', 'steamapps'), ('args', 'force-steam'),
                                         ('display', 'side display'), ('hold', 'HELD')])
def test_start_refusals(cfg, case, reason):
    win = FakeWin()
    if case == 'steam': cfg['exe'] = r'Z:\steamapps\game.exe'
    if case == 'args': cfg['args'] = ['--windowed']
    if case == 'display': win.displays = {}
    with pytest.raises((ValueError, SystemExit), match=reason):
        PcGameAdapter(cfg, win=win, hold=lambda: 'HELD - owner game is open' if case == 'hold' else None)
    assert not hasattr(win, 'launch')


def test_guard_counts(game):
    obj, win = game
    obj._counts = dict.fromkeys(obj._counts, 0)
    obj._previous_pointer = None
    win.shown = False
    win.bounds = (0, 0, 1280, 720)
    win.front = True
    obj._look()
    assert ('show', 77) in win.events
    assert any(e[0] == 'move_window' for e in win.events)
    win.pointer = (11, 20)
    obj._look()
    win.pointer = (12, 20)
    win.input += 1
    obj._look()
    win.input += 1
    obj._look()
    report = obj.health()
    assert report['looks'] == report['foreground_looks'] == 4
    assert report['moved'] == report['off_side'] == 1
    assert report['pointer_moves_without_input'] == 1
    assert len((obj.run / 'windows.log').read_text().splitlines()) >= 4


@pytest.mark.parametrize('seed', [False, True])
def test_profile_and_private_appdata(cfg, tmp_path, monkeypatch, seed):
    real = tmp_path / 'owner_appdata'
    real.mkdir()
    monkeypatch.setenv('APPDATA', str(real))
    if seed:
        root = tmp_path / 'seed'
        base = root / 'SlayTheSpire2/default/1'
        base.mkdir(parents=True)
        (base / 'settings.save').write_text(json.dumps({'keep': 7, 'mod_settings': {'mods_enabled': False, 'other': 8}}))
        for sub in ['profile1/saves', 'modded/profile1/saves']:
            (base / sub).mkdir(parents=True)
            (base / sub / 'prefs.save').write_text(json.dumps({'keep': 9, 'upload_data': True}))
        cfg['seed_profile'] = str(root)
    cfg['env'] = {'APPDATA': 'unsafe', 'EXTRA': 'yes'}
    win = FakeWin()
    obj = PcGameAdapter(cfg, win=win, hold=lambda: None, sleep=lambda _: None)
    try:
        base = obj.appdata / 'SlayTheSpire2/default/1'
        settings = json.loads((base / 'settings.save').read_text())
        assert settings['mod_settings']['mods_enabled'] is True
        for sub in ['profile1/saves', 'modded/profile1/saves']:
            prefs = json.loads((base / sub / 'prefs.save').read_text())
            assert prefs['upload_data'] is False
            if seed: assert prefs['keep'] == 9
        if seed:
            assert settings['keep'] == 7
            assert settings['mod_settings']['other'] == 8
        assert Path(win.launch[2]['APPDATA']).is_relative_to(obj.run)
        assert win.launch[2]['EXTRA'] == 'yes'
        assert list(real.iterdir()) == []
    finally:
        obj.close()


def test_dead_hung_and_close(game):
    obj, win = game
    first = obj.screenshot()
    win.hung = True
    assert obj.screenshot() == first
    win.code = 9
    with Image.open(io.BytesIO(obj.screenshot())) as image:
        assert image.size == (1280, 720)
        assert max(image.getpixel((0, 0))) <= 2  # JPEG quantizes black at quality 70.
        assert image.getbbox() is not None
    obj.close()
    obj.close()
    assert not (Path(obj.cfg['exe']).parent / 'override.cfg').exists()
    assert json.loads((obj.run / 'health.json').read_text())['exit_code'] == 9


def test_setup_order_and_console(cfg):
    steps = [{'click': [960, 540]}, {'drag': [0, 0, 60, 60]}, {'key': 'esc'},
             {'wait': 10}, {'console': 'test text'}]
    cfg['setup'] = steps
    win = FakeWin()
    obj = PcGameAdapter(cfg, win=win, hold=lambda: None, sleep=lambda _: None)
    try:
        assert obj.setup_log == steps
        assert json.loads((obj.run / 'setup.json').read_text()) == steps
        assert ''.join(chr(e[2]) for e in win.events if e[:2] == ('post', 0x102)) == 'test text'
    finally: obj.close()


def test_console_has_open_type_close_delays(cfg):
    delays = []
    cfg['setup'] = [{'console': 'x'}]
    obj = PcGameAdapter(cfg, win=FakeWin(), hold=lambda: None, sleep=delays.append)
    try:
        assert delays[-6:] == [.5, .02, .05, .5, .05, .5]
    finally: obj.close()


def test_guard_ignores_small_windows_and_uses_exact_display_position(cfg):
    win = FakeWin()
    win.displays[r'\\.\DISPLAY5'] = (-1921, 1080, -1, 2160)
    obj = PcGameAdapter(cfg, win=win, hold=lambda: None, sleep=lambda _: None)
    try:
        assert 'Vector2i(60, 1710)' in obj._override.read_text()
        win.events.clear()
        win.bounds = (0, 0, 300, 0)
        obj._counts['moved'] = 0
        obj._counts['off_side'] = 0
        obj._look()
        assert not any(event[0] == 'move_window' for event in win.events)
        assert obj.health()['moved'] == 0
    finally: obj.close()


def test_no_mod_and_brief(cfg, tmp_path):
    brief = tmp_path / 'brief.txt'
    brief.write_text('Explore safely')
    cfg.update(use_mod=False, brief_file=str(brief), controls='Move with arrows')
    obj = PcGameAdapter(cfg, win=FakeWin(), hold=lambda: None, sleep=lambda _: None)
    try:
        assert '--nomods' in obj.win.launch[0]
        value = json.loads((obj.appdata / 'SlayTheSpire2/default/1/settings.save').read_text())
        assert value['full_console'] is True
        assert obj.controls.endswith('Move with arrows\n\nExplore safely')
        saved = obj.appdata / 'SlayTheSpire2/default/1'
        (saved / 'profile1/saves').mkdir(parents=True, exist_ok=True)
        (saved / 'profile1/saves/test').write_text('save')
        (obj.appdata / 'SlayTheSpire2/logs').mkdir(parents=True)
        (obj.appdata / 'SlayTheSpire2/logs/log').write_text('omit')
    finally:
        run, appdata = obj.run, obj.appdata
        obj.close()
    assert appdata.is_dir()
    export = tmp_path / 'export'
    obj.save_profile(export)
    assert (export / 'SlayTheSpire2/default/1/profile1/saves/test').read_text() == 'save'
    assert not (export / 'SlayTheSpire2/logs').exists()


def test_brief_braces_refused(cfg, tmp_path):
    brief = tmp_path / 'brief.txt'
    brief.write_text('{unsafe}')
    cfg['brief_file'] = str(brief)
    with pytest.raises(ValueError, match='brace'):
        PcGameAdapter(cfg, win=FakeWin(), hold=lambda: None)


def test_failed_start_cleans_up(cfg):
    win = FakeWin()
    def fail(*args): raise RuntimeError('mapping failed')
    win.mouse_memory = fail
    with pytest.raises(RuntimeError, match='mapping failed'):
        PcGameAdapter(cfg, win=win, hold=lambda: None, sleep=lambda _: None)
    assert win.code == 0
    assert not (Path(cfg['exe']).parent / 'override.cfg').exists()


def test_validate_example():
    cfg = json.loads(Path('games/sts2-example.json').read_text())
    assert validate(cfg) == []
    del cfg['exe']
    assert 'exe is missing' in validate(cfg)


def test_build_refuses_steamapps(monkeypatch, capsys):
    def forbidden(*args, **kwargs): pytest.fail('dotnet must not run')
    monkeypatch.setattr(build_sts2_mod.subprocess, 'run', forbidden)
    assert build_sts2_mod.main([r'Z:\steamapps\game']) == 2
    assert 'steamapps' in capsys.readouterr().err


def test_case_insensitive_appdata_override(cfg):
    cfg['env'] = {'appdata': 'unsafe', 'AppData': 'also-unsafe'}
    win = FakeWin()
    obj = PcGameAdapter(cfg, win=win, hold=lambda: None, sleep=lambda _: None)
    try:
        overrides = {k: v for k, v in win.launch[2].items() if k.upper() == 'APPDATA'}
        assert overrides == {'APPDATA': str(obj.appdata)}
    finally: obj.close()


def test_health_copies_log_and_preserves_exit(game):
    obj, win = game
    log = obj.appdata / 'SlayTheSpire2/logs/godot.log'
    log.parent.mkdir(parents=True)
    log.write_text('normal\nERROR: failure\nException: failure\nERROR: Exception\n')
    assert obj.health()['error_lines'] == 3
    obj.close()
    assert (obj.run / 'godot.log').read_text() == log.read_text()
    assert not json.loads((obj.run / 'health.json').read_text())['alive']
    assert len([e for e in win.events if e[0] == 'stop']) == 1


def test_recording_is_opt_in_and_stops(cfg, tmp_path):
    import threading
    win = FakeWin()
    obj = PcGameAdapter(cfg, win=win, hold=lambda: None, sleep=lambda _: None)
    assert obj._record_thread is None
    saved = threading.Event()
    original = obj._picture
    def picture():
        data = original()
        saved.set()
        return data
    obj._picture = picture
    folder = tmp_path / 'video'
    obj.start_recording(folder)
    assert saved.wait(2)
    obj.close()
    assert not obj._record_thread.is_alive()
    assert not obj._guard_thread.is_alive()
    frames = json.loads((folder / 'frames.json').read_text())
    assert frames[0]['file'] == '00000000.jpg'
    assert frames[0]['time'] > 0
    assert (folder / 'frames' / frames[0]['file']).is_file()


def test_fresh_uses_a_new_run_folder(game):
    obj, win = game
    fresh = obj.fresh()
    try:
        assert fresh.cfg == obj.cfg
        assert fresh.run != obj.run
        assert fresh.appdata != obj.appdata
    finally: fresh.close()


def test_make_dispatches_pcgame(cfg, monkeypatch):
    from pt import adapter, pcgame
    monkeypatch.setattr(adapter, 'load_config', lambda path: cfg)
    calls = []
    monkeypatch.setattr(pcgame, 'PcGameAdapter', lambda *args, **kw: calls.append((args, kw)))
    adapter.make('sts2', sam_client='fake-client')
    assert calls == [((cfg,), {'sam_client': 'fake-client'})]


def test_public_check_scans_mod_sources(tmp_path, monkeypatch):
    from tools import public_check as check
    files = {'LICENSE': 'MIT', 'README.md': '# Test', '.gitignore': 'data/\n',
             'input.cs': 'Q:' + chr(92) + 'Projects' + chr(92) + 'private',
             'input.csproj': 'Q:' + chr(92) + 'Projects' + chr(92) + 'private'}
    for name, text in files.items():
        (tmp_path / name).write_text(text)
    monkeypatch.setattr(check, 'tracked', lambda repo: list(files))
    monkeypatch.setattr(check, 'git', lambda *args, **kw: '')
    monkeypatch.setattr(check, '_api_key', lambda: '')
    problems = check.check(tmp_path)
    assert any('input.cs' in problem and 'path into' in problem for problem in problems)
    assert any('input.csproj' in problem and 'path into' in problem for problem in problems)


def test_guard_failure_stops_only_owned_process(game):
    obj, win = game
    obj._stop.clear()
    def broken(): raise OSError('pointer probe failed')
    win.cursor = broken
    obj._guard_loop()
    assert win.code == 0
    assert obj.health()['guard_error'] == 'pointer probe failed'


def test_pointer_move_event_records_unchanged_input(game):
    obj, win = game
    obj.clock = lambda: 10.0
    obj.started_at = 10.0
    win.pointer = (31, 42)
    win.input = 100
    obj._previous_pointer = (10, 20)
    obj._previous_input = 100
    obj._look()
    report = obj.health()
    assert report['pointer_move_events'] == [
        {'at_s': 0.0, 'before': [10, 20], 'after': [31, 42]}
    ]
    assert report['pointer_moves_without_input'] == len(report['pointer_move_events'])


def test_pointer_move_event_ignores_new_input(game):
    obj, win = game
    win.pointer = (31, 42)
    win.input = 101
    obj._previous_pointer = (10, 20)
    obj._previous_input = 100
    obj._look()
    assert obj.health()['pointer_move_events'] == []


def test_pointer_move_event_log_is_capped(game):
    obj, win = game
    obj._previous_pointer = win.pointer
    obj._previous_input = win.input
    for index in range(60):
        win.pointer = (index + 20, index + 30)
        win.input += 1
        obj._look()
        win.pointer = (index + 21, index + 31)
        obj._look()
    report = obj.health()
    assert report['pointer_moves_without_input'] == 60
    assert len(report['pointer_move_events']) == 50


def test_pc_steps_writes_at_s_for_each_step(tmp_path):
    from tools import pc_steps

    class Clock:
        value = 100.0
        def __call__(self):
            self.value += 1.0
            return self.value

    class Adapter:
        run = tmp_path / 'run'
        win = type('Window', (), {'alive': lambda self, pid: False})()
        pid = 1
        def __init__(self, cfg, win=None):
            self.started_at = 9.0
            self.clock = Clock()
        def frame_input(self, *args): pass
        def sleep(self, seconds): pass
        def health(self): return {'pointer_moves_without_input': 0}
        def close(self): pass

    clock = lambda: 10000.0
    steps = tmp_path / 'steps.json'
    steps.write_text('[{"move":[1,2]},{"wait":1}]')
    out = tmp_path / 'out'
    pc_steps.run({'name': 'fake'}, steps, out, win=FakeWin(), clock=clock,
                 adapter_factory=Adapter, owner_input=lambda: 0)
    result = json.loads((out / 'result.json').read_text())
    assert [step['at_s'] for step in result['steps']] == [92.0, 93.0]
