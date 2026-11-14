import json
from pathlib import Path

from tools import pc_steps


class FakeAdapter:
    def __init__(self, cfg, win=None):
        self.cfg, self.win, self.run = cfg, win, Path('fake-run')
        self.started_at = 0
        self.events, self.closed, self.pid = [], False, 1
        self.sleep = lambda seconds: self.events.append(('wait', seconds))
        self.clock = lambda: self.started_at
    def full_frame(self):
        from PIL import Image
        self.events.append(('shot',))
        return Image.new('RGB', (1920, 1080))
    def frame_input(self, kind, *coords): self.events.append((kind, *coords))
    def key_input(self, key): self.events.append(('key', key))
    def console_input(self, text): self.events.append(('console', text))
    def health(self): return {'pointer_moves_without_input': 0}
    def close(self): self.closed = True
    def save_profile(self, folder): self.events.append(('save_profile', folder))


class FakeWin:
    def alive(self, pid): return False


def test_steps_order_and_outputs(tmp_path):
    steps = [{'shot': 'start'}, {'click': [1, 2]}, {'move': [3, 4]},
             {'drag': [1, 2, 3, 4]}, {'key': 'esc'}, {'wait': 50},
             {'console': 'hello'}, {'status': 'ready'}]
    source = tmp_path / 'steps.json'
    source.write_text(json.dumps(steps))
    instances = []
    def factory(cfg, win=None):
        item = FakeAdapter(cfg, win); instances.append(item); return item
    assert pc_steps.run({}, source, tmp_path / 'out', win=FakeWin(), adapter_factory=factory) == 0
    assert instances[0].events == [('shot',), ('click', 1, 2), ('move', 3, 4),
        ('drag', 1, 2, 3, 4), ('key', 'esc'), ('wait', .05), ('console', 'hello')]
    assert instances[0].closed
    assert (tmp_path / 'out/000-start.jpg').is_file()
    assert json.loads((tmp_path / 'out/result.json').read_text())['statuses'][0]['status'] == 'ready'


def test_no_mod_idle_boundary_and_input_stop(tmp_path):
    steps_file = tmp_path / 'steps.json'
    steps_file.write_text('[{"wait":1}]')
    current = [1000.0]
    def factory(cfg, win=None): return FakeAdapter(cfg, win)
    assert pc_steps.run({}, steps_file, tmp_path / 'refuse', no_mod=True, win=FakeWin(),
        clock=lambda: current[0], owner_input=lambda: current[0] - 599, adapter_factory=factory) == 3
    assert pc_steps.run({}, steps_file, tmp_path / 'start', no_mod=True, win=FakeWin(),
        clock=lambda: current[0], owner_input=lambda: current[0] - 600, adapter_factory=factory) == 0
    calls = [0]
    def recent_input():
        calls[0] += 1
        return current[0] - (600 if calls[0] == 1 else 0)
    obj = []
    def capture(cfg, win=None):
        x = FakeAdapter(cfg, win); obj.append(x); return x
    assert pc_steps.run({}, steps_file, tmp_path / 'stop', no_mod=True, win=FakeWin(),
        clock=lambda: current[0], owner_input=recent_input, adapter_factory=capture) == 4
    assert obj[0].closed and not any(e[0] == 'wait' for e in obj[0].events)


def test_close_on_step_error(tmp_path):
    source = tmp_path / 'steps.json'
    source.write_text('[{"key":"`"}]')
    obj = []
    def factory(cfg, win=None):
        x = FakeAdapter(cfg, win); obj.append(x); return x
    import pytest
    with pytest.raises(ValueError, match='not permitted'):
        pc_steps.run({}, source, tmp_path / 'out', win=FakeWin(), adapter_factory=factory)
    assert obj[0].closed


def test_mod_run_accepts_keys_except_backquote(tmp_path):
    source = tmp_path / 'steps.json'
    source.write_text('[{"key":"m"}]')
    obj = []
    def factory(cfg, win=None):
        x = FakeAdapter(cfg, win); obj.append(x); return x
    assert pc_steps.run({}, source, tmp_path / 'out', win=FakeWin(), adapter_factory=factory) == 0
    assert ('key', 'm') in obj[0].events


def test_game_name_resolves_through_config_path(tmp_path, monkeypatch):
    source = tmp_path / 'steps.json'
    source.write_text('[]')
    config = tmp_path / 'sts2.json'
    config.write_text('{}')
    import pt.adapter as adapter
    loaded = []
    monkeypatch.setattr(adapter, 'config_path', lambda game: config if game == 'sts2' else game)
    monkeypatch.setattr(adapter, 'load_config', lambda path: loaded.append(path) or {})
    pc_steps.run('sts2', source, tmp_path / 'out', win=FakeWin(), adapter_factory=FakeAdapter)
    assert loaded == [config]
