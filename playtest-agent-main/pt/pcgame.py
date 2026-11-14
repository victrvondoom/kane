"""An isolated PC game run with input sent only to its window."""
import io
import json
import os
from pathlib import Path
import secrets
import shutil
import struct
import threading
import time
from datetime import datetime, timezone

from PIL import Image, ImageDraw

from pt.adapter import Adapter
from pt import guard
from pt.pcwin import Win32


KEYS = {'esc': 0x1B, 'escape': 0x1B, 'enter': 0x0D, 'space': 0x20, 'tab': 9,
        'backspace': 8, 'left': 0x25, 'up': 0x26, 'right': 0x27, 'down': 0x28,
        'shift': 0x10, 'ctrl': 0x11, 'alt': 0x12,
        **{str(i): ord(str(i)) for i in range(10)},
        **{chr(i).lower(): i for i in range(65, 91)},
        **{f'f{i}': 0x6F + i for i in range(1, 13)}}
BACKQUOTE = {'`', '~', 'backquote', 'backtick', 'grave', 'graveaccent', 'oem_3', 'oem3', '0xc0', '192'}
SETTINGS = dict(aspect_ratio='sixteen_by_nine', controller_mapping_type='default',
                fps_limit=60, fullscreen=False, language='eng', limit_fps_in_background=False,
                mod_settings={'mods_enabled': True}, msaa=0, resize_windows=False,
                schema_version=5, seen_ea_disclaimer=True, skip_intro_logo=True,
                target_display=2, volume_ambience=0.0, volume_bgm=0.0,
                volume_master=0.0, volume_sfx=0.0, vsync='off',
                window_position={'X': 60, 'Y': 90}, window_size={'X': 1920, 'Y': 1080})
PREFS = dict(fast_mode='normal', long_press=False, mute_in_background=True, schema_version=2,
             screenshake=0, show_card_indices=True, show_run_timer=False,
             text_effects_enabled=True, upload_data=False)


def _write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2), encoding='utf-8')


class PcGameAdapter(Adapter):
    paced_replay = True

    def __init__(self, cfg, win=None, hold=None, sleep=time.sleep, clock=time.time, sam_client=None):
        self.cfg = cfg
        self.name, self.controls, self.goal = cfg['name'], cfg.get('controls', ''), cfg.get('goal', '')
        if cfg.get('brief_file'):
            brief_path = Path(cfg['brief_file'])
            if not brief_path.is_absolute():
                brief_path = Path(__file__).resolve().parents[1] / brief_path
            brief = brief_path.read_text(encoding='utf-8')
            if '{' in brief or '}' in brief:
                raise ValueError('brief must not contain braces')
            self.controls += '\n\n' + brief
        self.sleep, self.clock = sleep, clock
        self.started_at = self.clock()
        self._hold = hold or guard.doom_hold
        self.allowed_keys = {str(k).lower() for k in cfg.get('allowed_keys', [])}
        args = cfg.get('args', ['--force-steam', 'off', '--windowed'])
        if cfg.get('use_mod', True) is False:
            args = [*args, '--nomods']
        if 'steamapps' in str(cfg['exe']).lower() or 'steamapps' in str(Path(cfg['exe']).resolve()).lower():
            raise ValueError('steamapps paths are forbidden: use an isolated game copy')
        if not any(args[i:i + 2] == ['--force-steam', 'off'] for i in range(len(args) - 1)):
            raise ValueError('args must contain --force-steam off')
        if args.count('--force-steam') != 1 or any(a.startswith('--force-steam=') for a in args):
            raise ValueError('args must contain only one --force-steam off setting')
        if self.allowed_keys & BACKQUOTE:
            raise ValueError('backquote is reserved for disclosed setup steps')
        reason = self._hold()
        if reason:
            raise SystemExit(reason)
        self.win = win if win is not None else Win32()
        monitors = self.win.monitors()
        if cfg['side_display'] not in monitors:
            raise ValueError(f"side display is missing: {cfg['side_display']}")
        self.side = monitors[cfg['side_display']]
        self.frame_size = tuple(cfg.get('frame_size', [1920, 1080]))
        self.real_per_frame = tuple(cfg.get('real_per_frame', [2, 3]))
        self.shot_width = cfg.get('shot_width', 1280)
        if min(*self.frame_size, *self.real_per_frame, self.shot_width) <= 0:
            raise ValueError('frame size, shot width and coordinate ratio must be positive')
        self.shot_size = (self.shot_width, round(self.frame_size[1] * self.shot_width / self.frame_size[0]))
        self.pid = self.handle = self.memory = None
        self.run = self.appdata = None
        self._override = None
        self._stop = threading.Event()
        self._guard_thread = self._record_thread = None
        self._guard_error = None
        self._closed = False
        self._picture_lock = threading.Lock()
        self._last_picture = None
        self._counts = dict.fromkeys(['looks', 'moved', 'off_side', 'foreground_looks',
                                     'pointer_moves_without_input'], 0)
        self._previous_pointer = None
        self._previous_input = None
        self._pointer_move_events = []
        self.setup_log, self.executed, self.last_spans = [], [], []
        from pt.sam_sensor import configure
        configure(self, sam_client)
        try:
            stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
            self.run = Path(cfg['run_root']).resolve() / f'{stamp}-{secrets.token_hex(2)}'
            self.run.mkdir(parents=True, exist_ok=False)
            self.appdata = self.run / 'appdata'
            self.appdata.mkdir()
            if cfg.get('seed_profile'):
                shutil.copytree(cfg['seed_profile'], self.appdata, dirs_exist_ok=True)
            self._profile()
            self._override = Path(cfg['exe']).resolve().parent / 'override.cfg'
            min_left = min(rect[0] for rect in monitors.values())
            x = int((self.side[0] + 40 - min_left) * 1.5)
            y = int((self.side[1] + 60) * 1.5)
            self._override.write_text('[display]\n\nwindow/size/no_focus=true\n'
                                      'window/size/initial_position_type=0\n'
                                      f'window/size/initial_position=Vector2i({x}, {y})\n'
                                      'window/size/mode=0\n', encoding='utf-8')
            env = {k: v for k, v in {**os.environ, **(cfg.get('env') or {})}.items()
                   if k.upper() != 'APPDATA'}
            env['APPDATA'] = str(self.appdata)
            exe = Path(cfg['exe']).resolve()
            self.pid = self.win.start([str(exe), *args], cwd=str(exe.parent), env=env)
            self._guard_thread = threading.Thread(target=self._guard_loop, name='pcgame-guard', daemon=True)
            self._guard_thread.start()
            deadline = time.monotonic() + 120
            while self.handle is None:
                if self._guard_error:
                    raise RuntimeError('window guard failed') from self._guard_error
                if self.win.poll(self.pid) is not None:
                    raise RuntimeError('game exited before opening its window')
                for handle in self.win.windows(self.pid):
                    rect = self.win.rect(handle)
                    if self.win.visible(handle) and rect[2] - rect[0] > 300:
                        self.handle = handle
                        break
                if self.handle is None:
                    if time.monotonic() >= deadline:
                        raise TimeoutError('game window did not appear within 120 seconds')
                    self.sleep(0.05)
            self.memory = self.win.mouse_memory(self.pid)
            self._position(self.frame_size[0] // 2, self.frame_size[1] // 2)
            self.sleep(cfg.get('launch_wait_s', 18))
            if self._guard_error:
                raise RuntimeError('window guard failed') from self._guard_error
            self._setup(cfg.get('setup', []))
        except BaseException:
            self.close()
            raise

    def _profile(self):
        base = self.appdata / 'SlayTheSpire2/default/1'
        settings = base / 'settings.save'
        value = json.loads(settings.read_text(encoding='utf-8')) if settings.exists() else dict(SETTINGS)
        value['mod_settings'] = {**value.get('mod_settings', {}), 'mods_enabled': True}
        if self.cfg.get('use_mod', True) is False:
            value['full_console'] = True
        else:
            value.pop('full_console', None)
        _write_json(settings, value)
        for sub in ('profile1/saves', 'modded/profile1/saves'):
            path = base / sub / 'prefs.save'
            value = json.loads(path.read_text(encoding='utf-8')) if path.exists() else dict(PREFS)
            value['upload_data'] = False
            _write_json(path, value)

    def _look(self):
        pointer, last_input = self.win.cursor(), self.win.last_input()
        self._counts['looks'] += 1
        if self._previous_pointer is not None and pointer != self._previous_pointer and last_input == self._previous_input:
            self._counts['pointer_moves_without_input'] += 1
            self._pointer_move_events.append(dict(
                at_s=round(self.clock() - self.started_at, 2),
                before=list(self._previous_pointer), after=list(pointer)))
            del self._pointer_move_events[:-50]
        self._previous_pointer, self._previous_input = pointer, last_input
        for handle in self.win.windows(self.pid):
            rect = self.win.rect(handle)
            if rect[2] - rect[0] <= 300:
                continue
            side = (rect[0] >= self.side[0] and rect[1] >= self.side[1]
                    and rect[2] <= self.side[2] and rect[3] <= self.side[3])
            foreground = self.win.foreground(handle)
            self._counts['foreground_looks'] += int(foreground)
            entry = dict(time=self.clock(), title=self.win.title(handle), rect=rect, side=side,
                         foreground=foreground, pointer=pointer, last_input=last_input)
            with (self.run / 'windows.log').open('a', encoding='utf-8') as log:
                log.write(json.dumps(entry) + '\n')
            if not self.win.visible(handle):
                self.win.show(handle)
            if not side:
                self._counts['off_side'] += 1
                width, height = rect[2] - rect[0], rect[3] - rect[1]
                x = self.side[0] + min(60, max(0, self.side[2] - self.side[0] - width))
                y = self.side[1] + min(90, max(0, self.side[3] - self.side[1] - height))
                self.win.move(handle, x, y)
                self._counts['moved'] += 1

    def _guard_loop(self):
        try:
            while not self._stop.is_set():
                self._look()
                self._stop.wait(0.05)
        except Exception as error:
            self._guard_error = error
            # A run without its guard must not continue beside the owner's work.
            self.win.stop(self.pid)

    def _position(self, x, y):
        self.memory.seek(0)
        self.memory.write(struct.pack('<ii', int(x), int(y)))

    def _move(self, x, y, held=0):
        self._position(x, y)
        numerator, denominator = self.real_per_frame
        rx, ry = int(x) * numerator // denominator, int(y) * numerator // denominator
        packed = (rx & 0xFFFF) | ((ry & 0xFFFF) << 16)
        self.win.post(self.handle, 0x200, held, packed)
        return packed

    def _click(self, x, y):
        packed = self._move(x, y)
        self.sleep(0.12)
        self.win.post(self.handle, 0x201, 1, packed)
        try:
            self.sleep(0.06)
        finally:
            self.win.post(self.handle, 0x202, 0, packed)

    def _drag(self, x, y, x2, y2, ms=400):
        packed = self._move(x, y)
        self.win.post(self.handle, 0x201, 1, packed)
        try:
            for i in range(1, 13):
                packed = self._move(round(x + (x2 - x) * i / 12), round(y + (y2 - y) * i / 12), 1)
                self.sleep(0.03 * ms / 400)
        finally:
            self.win.post(self.handle, 0x202, 0, packed)

    def _key(self, vk):
        self.win.post(self.handle, 6, 1, 0)
        scan = self.win.scan(vk)
        packed = 1 | (scan << 16)
        self.win.post(self.handle, 0x100, vk, packed)
        try:
            self.sleep(0.05)
        finally:
            self.win.post(self.handle, 0x101, vk, packed | (3 << 30))

    def _setup(self, steps):
        _write_json(self.run / 'setup.json', self.setup_log)
        for step in steps:
            self.setup_log.append(dict(step))
            _write_json(self.run / 'setup.json', self.setup_log)
            if 'click' in step:
                self._click(*step['click'])
            elif 'drag' in step:
                self._drag(*step['drag'])
            elif 'key' in step:
                self._key(KEYS[step['key'].lower()])
            elif 'wait' in step:
                self.sleep(step['wait'] / 1000)
            elif 'console' in step:
                self._key(0xC0)
                self.sleep(0.5)
                for character in step['console']:
                    self.win.post(self.handle, 0x102, ord(character), 1)
                    self.sleep(0.02)
                self._key(0x0D)
                self.sleep(0.5)
                self._key(0xC0)
                self.sleep(0.5)
            else:
                raise ValueError('unknown setup step')

    def _point(self, x, y):
        scale = self.frame_size[0] / self.shot_width
        return (int(max(0, min(self.shot_size[0] - 1, x)) * scale),
                int(max(0, min(self.shot_size[1] - 1, y)) * scale))

    def execute(self, actions):
        from pt.sam_sensor import advance
        self.action_note = ""
        if self._guard_error:
            raise RuntimeError('window guard failed') from self._guard_error
        self.last_spans = []
        refused = []
        for action in actions:
            self.executed.append(action)
            start = self.clock()
            kind = action.get('type')
            if kind == 'click':
                self._click(*self._point(action['x'], action['y']))
            elif kind == 'swipe':
                self._drag(*self._point(action['x'], action['y']),
                           *self._point(action['x2'], action['y2']), action.get('ms', 400))
            elif kind == 'keypress':
                for key in action.get('keys', []):
                    name = str(key).lower()
                    if name in self.allowed_keys and name in KEYS and name not in BACKQUOTE:
                        self._key(KEYS[name])
                    else:
                        refused.append(str(key))
                        with (self.run / 'refused_keys.log').open('a', encoding='utf-8') as log:
                            log.write(str(key).replace('\n', ' ').replace('\r', ' ') + '\n')
            elif kind == 'wait':
                self.sleep(action.get('ms', 800) / 1000)
            self.last_spans.append(dict(from_s=start, to_s=self.clock()))
        if refused:
            allowed = ", ".join(sorted(k for k in self.allowed_keys if k not in BACKQUOTE))
            self.action_note = "; ".join(f"key refused: {key}, allowed: {allowed}" for key in refused)
        advance(self)

    def _picture(self):
        with self._picture_lock:
            if self.win.poll(self.pid) is not None:
                picture = Image.new('RGB', self.frame_size, 'black')
                ImageDraw.Draw(picture).text((30, 30), 'The game window has closed', fill='white')
            elif not self.win.responding(self.handle):
                if self._last_picture is not None:
                    return self._last_picture
                picture = Image.new('RGB', self.frame_size, 'black')
            else:
                picture = self.win.capture(self.handle, self.frame_size)
            picture = picture.resize(self.shot_size, Image.Resampling.LANCZOS)
            output = io.BytesIO()
            picture.save(output, format='JPEG', quality=70)
            self._last_picture = output.getvalue()
            return self._last_picture

    def frame_input(self, kind, *coords):
        """Send frame pixel coordinates to the game window."""
        if kind == 'click': self._click(*coords)
        elif kind == 'move': self._move(*coords)
        elif kind == 'drag': self._drag(*coords)
        else: raise ValueError(f'unknown frame input: {kind}')

    def key_input(self, key):
        name = str(key).lower()
        if name not in KEYS or name in BACKQUOTE:
            raise ValueError('unknown or reserved key')
        self._key(KEYS[name])

    def console_input(self, text):
        self._setup([{'console': str(text)}])

    def full_frame(self):
        """Return the full size frame without resizing it for the agent."""
        with self._picture_lock:
            if self.win.poll(self.pid) is not None:
                return Image.new('RGB', self.frame_size, 'black')
            return self.win.capture(self.handle, self.frame_size)

    def save_profile(self, folder):
        if not self._closed:
            raise RuntimeError('save_profile requires a closed run')
        source = self.appdata / 'SlayTheSpire2/default'
        target = Path(folder) / 'SlayTheSpire2/default'
        excluded = {'logs', 'sentry', 'shader_cache', 'vulkan'}
        shutil.copytree(source, target, dirs_exist_ok=True,
                        ignore=lambda directory, names: [n for n in names if n.lower() in excluded])

    def screenshot(self):
        from pt.sam_sensor import observe
        return observe(self, self._picture())

    def start_recording(self, folder):
        if self._record_thread is not None:
            raise ValueError('recording already started')
        folder = Path(folder)
        (folder / 'frames').mkdir(parents=True, exist_ok=True)
        def record():
            frames = []
            try:
                while not self._stop.is_set():
                    start = time.monotonic()
                    name = f'{len(frames):08d}.jpg'
                    timestamp = self.clock()
                    (folder / 'frames' / name).write_bytes(self._picture())
                    frames.append(dict(file=name, time=timestamp))
                    _write_json(folder / 'frames.json', frames)
                    self._stop.wait(max(0, 0.1 - (time.monotonic() - start)))
            finally:
                _write_json(folder / 'frames.json', frames)
        self._record_thread = threading.Thread(target=record, name='pcgame-recording', daemon=True)
        self._record_thread.start()

    def fresh(self):
        copy = PcGameAdapter(self.cfg, win=self.win, hold=self._hold, sleep=self.sleep, clock=self.clock)
        if getattr(self, '_sam_sensor', None) is not None:
            copy._sam_sensor = self._sam_sensor
        return copy

    def health(self):
        code = self.win.poll(self.pid) if self.pid is not None else None
        alive = self.pid is not None and self.win.alive(self.pid)
        log = self.appdata / 'SlayTheSpire2/logs/godot.log' if self.appdata else None
        lines = log.read_text(encoding='utf-8', errors='replace').splitlines() if log and log.exists() else []
        report = dict(alive=alive, exit_code=code,
                      responding=bool(alive and self.handle and self.win.responding(self.handle)),
                      **self._counts, pointer_move_events=list(self._pointer_move_events),
                      error_lines=sum('ERROR:' in line or 'Exception' in line for line in lines))
        if self._guard_error:
            report['guard_error'] = str(self._guard_error)
        return report

    def close(self):
        if self._closed:
            return
        self._stop.set()
        for thread in (self._record_thread, self._guard_thread):
            if thread is not None:
                thread.join()
        try:
            if self.pid is not None:
                if self.win.alive(self.pid):
                    self.win.stop(self.pid)
                self.win.wait(self.pid, timeout=10)
                if self.win.alive(self.pid):
                    raise RuntimeError('game process is still alive after close')
        finally:
            if self.memory is not None:
                self.memory.close()
                self.memory = None
            if self._override is not None:
                self._override.unlink(missing_ok=True)
            if self.run is not None:
                _write_json(self.run / 'health.json', self.health())
                log = self.appdata / 'SlayTheSpire2/logs/godot.log'
                if log.exists():
                    shutil.copy2(log, self.run / 'godot.log')
        self._closed = True
