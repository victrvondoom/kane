import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from test_fix_any import Client, case


@pytest.fixture
def mod_case(case, monkeypatch):
    root = case.tmp_path / 'isolated'
    root.mkdir()
    monkeypatch.setenv('PLAYTEST_STS2_ROOT', str(root))
    game = root / 'game'
    game.mkdir()
    case.config['game'] = {'type': 'pcgame', 'name': 'Test copy',
        'exe': str(game / 'game.exe'), 'run_root': str(root / 'runs'),
        'side_display': 2, 'seed_profile': str(root / 'saved-point')}
    case.config['mod'] = {'game_folder': str(game)}
    case.config['replay_check'] = ['picture-check', '{frame}', '--expected', '7']
    case.config['repair_instructions'] = 'Use one small C# Harmony patch.'
    case.game, case.root = game, root
    case.installed = game / 'mods' / 'pt_fix'
    case.events = []
    def runner(cmd, **kwargs):
        case.events.append(('command', cmd[0], case.installed.exists()))
        if cmd[0] == 'fake-build':
            out = Path(cmd[2])
            assert out.is_relative_to(root)
            (out / 'pt_fix.dll').write_bytes(b'fake assembly')
            (out / 'pt_fix.json').write_text('{}')
        if cmd[0] == 'picture-check':
            assert Path(cmd[1]).read_bytes()
            return SimpleNamespace(returncode=0 if case.installed.exists() else 1,
                                   stdout='', stderr='')
        return SimpleNamespace(returncode=0, stdout='', stderr='')
    class Driver(case.Driver):
        def __init__(self, cfg, bugs=''):
            case.events.append(('replay', case.installed.exists()))
            super().__init__(cfg, bugs)
    case.mod_runner, case.mod_driver = runner, Driver
    return case


def test_mod_template():
    root = Path(__file__).resolve().parents[1] / 'mods/pt_fix'
    manifest = json.loads((root / 'pt_fix.json').read_text())
    assert manifest['name'] == 'Test fix (unofficial)'
    assert 'unofficial' in manifest['description']
    assert manifest['affects_gameplay'] is True
    assert 'class TestPatch' in (root / 'Fix.cs').read_text()
    assert (root / 'pt_fix.csproj').is_file()


def test_builder_uses_fake_compiler_only(tmp_path, monkeypatch):
    from tools.build_sts2_fix import main
    root = tmp_path / 'isolated'
    monkeypatch.setenv('PLAYTEST_STS2_ROOT', str(root))
    game, out = root / 'game', root / 'built'
    game.mkdir(parents=True)
    src = Path(__file__).resolve().parents[1] / 'mods/pt_fix'
    commands = []
    def compiler(cmd, **kwargs):
        commands.append(cmd)
        assert kwargs['env']['DOTNET_CLI_TELEMETRY_OPTOUT'] == '1'
        build = Path(cmd[cmd.index('--output') + 1])
        build.mkdir(parents=True, exist_ok=True)
        (build / 'pt_fix.dll').write_bytes(b'compiled')
    assert main(['--src', str(src), '--out', str(out), '--game-folder', str(game)],
                runner=compiler) == 0
    assert (out / 'pt_fix.dll').read_bytes() == b'compiled'
    assert json.loads((out / 'pt_fix.json').read_text())['id'] == 'pt_fix'
    assert len(commands) == 1 and commands[0][:2] == ['dotnet', 'build']
    assert any(arg.startswith('-p:BaseIntermediateOutputPath=') for arg in commands[0])
    assert any(arg.startswith('-p:RestorePackagesPath=') for arg in commands[0])
    assert not any(arg.startswith('-p:RestoreSources=') for arg in commands[0])
    assert not (game / 'mods').exists()


@pytest.mark.parametrize('target', ['outside', 'steamapps/game', 'APPDATA/save', 'root'])
def test_builder_refuses_unsafe_targets(tmp_path, monkeypatch, target):
    from tools.build_sts2_fix import build
    root = tmp_path / 'isolated'
    root.mkdir()
    monkeypatch.setenv('PLAYTEST_STS2_ROOT', str(root))
    out = tmp_path / 'outside' if target == 'outside' else root / target
    if target == 'root':
        out = root
    with pytest.raises(ValueError):
        build(tmp_path / 'src', out, game_folder=root / 'game',
              runner=lambda *a, **kw: pytest.fail('compiler must not run'))
    assert not (root / 'game').exists()


def test_fix_off_then_on_and_cleanup(mod_case):
    c = mod_case
    client = Client(['NO'])
    result = c.execute(client, tries=1, build_runner=c.mod_runner, driver_factory=c.mod_driver)
    assert result['result'] == 'fixed'
    assert [e for e in c.events if e[0] == 'replay'] == [('replay', False), ('replay', True)]
    assert len(c.made) == 2 and all(d.closed for d in c.made)
    assert c.made[0].actions == c.made[1].actions
    assert all(d.cfg['seed_profile'] == str(c.root / 'saved-point') for d in c.made)
    assert result['attempts'][0]['control']['returncode'] == 1
    assert result['attempts'][0]['replay_check']['returncode'] == 0
    assert 'Use one small C# Harmony patch.' in client.prompts[0]
    assert not c.installed.exists()


@pytest.mark.parametrize('mode', ['control passes', 'control error', 'fixed fails', 'replay error', 'judge error'])
def test_failed_replay_or_check_removes_mod(mod_case, mode):
    c = mod_case
    def runner(cmd, **kwargs):
        result = c.mod_runner(cmd, **kwargs)
        if cmd[0] == 'picture-check':
            if mode == 'control passes': result.returncode = 0
            if mode == 'control error': result.returncode = 2
            if mode == 'fixed fails': result.returncode = 1
        return result
    class Driver(c.mod_driver):
        def execute(self, actions):
            if mode == 'replay error' and c.installed.exists():
                raise RuntimeError('replay failed')
            super().execute(actions)
    class Judge(Client):
        def responses(self, *args, **kwargs):
            if mode == 'judge error': raise RuntimeError('judge failed')
            return super().responses(*args, **kwargs)
    result = c.execute(Judge(['NO']), tries=1, build_runner=runner,
                       driver_factory=Driver)
    assert result['result'] == 'not fixed'
    assert result['attempts'][0]['control'] is not None
    if mode not in ('control passes', 'control error'):
        assert ('replay', True) in c.events
    assert not c.installed.exists()
    assert all(d.closed for d in c.made)


def test_existing_mod_is_never_overwritten(mod_case):
    c = mod_case
    c.installed.mkdir(parents=True)
    original = c.installed / 'pt_fix.dll'
    original.write_bytes(b'existing')
    with pytest.raises(ValueError, match='existing'):
        c.execute(Client([]), tries=1, build_runner=c.mod_runner, driver_factory=c.mod_driver)
    assert original.read_bytes() == b'existing'
    assert not c.events


def test_mod_requires_picture_check(mod_case):
    c = mod_case
    del c.config['replay_check']
    with pytest.raises(ValueError, match='replay_check'):
        c.execute(Client([]), tries=1)


def test_context_inside_source_is_rejected_before_copy(case):
    context = case.source / 'private.cs'
    context.write_text('PRIVATE_DECOMPILED_SOURCE_890')
    case.config['context'] = [str(context)]
    with pytest.raises(ValueError, match='context.*source'):
        case.execute(Client([]), tries=1)
    assert not case.commands


def test_local_context_never_enters_artifacts(mod_case, monkeypatch, capsys):
    from pt import fix_any
    c = mod_case
    monkeypatch.setattr(fix_any, 'ROOT', c.tmp_path)
    private = c.tmp_path / 'games.local/context.cs'
    private.parent.mkdir()
    marker = 'PRIVATE_DECOMPILED_METHOD_12903'
    private.write_text(marker)
    c.config['context'] = [str(private)]
    client = Client(['NO'])
    client.patch['why'] = marker
    def runner(cmd, **kwargs):
        response = c.mod_runner(cmd, **kwargs)
        response.stdout = marker
        return response
    result = c.execute(client, tries=1, build_runner=runner, driver_factory=c.mod_driver)
    assert result['result'] == 'fixed'
    assert marker in client.prompts[0]
    for path in c.tmp_path.rglob('*'):
        if path.is_file() and path != private:
            assert marker.encode() not in path.read_bytes()
    assert private.read_text() == marker
    captured = capsys.readouterr()
    assert marker not in captured.out + captured.err


def test_example_has_local_context_and_picture_check():
    root = Path(__file__).resolve().parents[1]
    cfg = json.loads((root / 'games/sts2.fix.example.json').read_text())
    assert cfg['context'][0].startswith('games.local/')
    assert '{frame}' in cfg['replay_check']
    assert cfg['game']['seed_profile']
    assert cfg['editable'] == ['Fix.cs']


def test_builder_rejects_link_inside_existing_output(tmp_path, monkeypatch):
    from pt import sts2_paths
    from tools.build_sts2_fix import build
    root = tmp_path / 'isolated'
    out, game = root / 'out', root / 'game'
    (out / 'build').mkdir(parents=True)
    game.mkdir()
    monkeypatch.setenv('PLAYTEST_STS2_ROOT', str(root))
    real = Path.is_junction
    monkeypatch.setattr(Path, 'is_junction', lambda p: p == out / 'build' or real(p))
    src = Path(__file__).resolve().parents[1] / 'mods/pt_fix'
    with pytest.raises(ValueError, match='links'):
        build(src, out, game_folder=game,
              runner=lambda *a, **kw: pytest.fail('compiler must not run'))


def test_build_source_cannot_contain_copied_context(case):
    marker = 'PRIVATE_DECOMPILED_LOGIC_290341'
    private = case.tmp_path / 'context.cs'
    private.write_text(marker)
    (case.source / 'accidental-copy.cs').write_text(marker)
    case.config['context'] = [str(private)]
    with pytest.raises(ValueError, match='source.*context'):
        case.execute(Client([]), tries=1)
    assert not case.commands
