"""Structured demo data and presentation, using only fake runs and clients."""
import io
import json
import os
import re
import threading
from html.parser import HTMLParser

import pytest

from pt import demo as D
from test_demo import CODE, FakeHttp, act, finish, make


def saved(tmp_path):
    folder = tmp_path / 'runs' / 'h12'
    folder.mkdir(parents=True)
    from PIL import Image
    image = io.BytesIO()
    Image.new('RGB', (640, 240), '#10141a').save(image, 'JPEG')
    for name in ('s000.jpg', 's001.jpg', 's002.jpg', 'strip_0.jpg'):
        (folder / name).write_bytes(image.getvalue())
    reports = [{'title': 'Door stays closed', 'expected': 'Open', 'actual': 'Closed', 'step': 1},
               {'title': 'No quote', 'expected': 'Move', 'actual': 'Still', 'step': 2}]
    result = {'game': 'Fake Cave', 'steps': 2, 'cost_usd': .3, 'seconds': 12, 'reports': reports,
              'log': [{'step': 0, 'cost': .1, 'text': 'My words', 'calls': [
                  {'name': 'act', 'args': {'actions': [{'type': 'keypress', 'keys': ['right']},
                    {'type': 'keypress', 'keys': ['right']}, {'type': 'keypress', 'keys': ['space']}]}}]},
                      {'step': 1, 'cost': .2, 'text': '', 'calls': [
                          {'name': 'act', 'args': {'look': 'A door', 'actions': [{'type': 'click', 'x': 12, 'y': 30}]}}]}]}
    checks = [{'reproducible': True, 'confirmed': True, 'judge': json.dumps({'verdict': 'YES', 'evidence': 'Door stays closed in every frame'})},
              {'reproducible': False, 'confirmed': False, 'judge': json.dumps({'verdict': 'YES', 'evidence': ''})}]
    (folder / 'result.json').write_text(json.dumps(result), encoding='utf-8')
    (folder / 'confirm.json').write_text(json.dumps(checks), encoding='utf-8')
    return folder


def test_saved_shape(tmp_path, monkeypatch):
    folder = saved(tmp_path)
    monkeypatch.delenv('DEMO_REPO_URL', raising=False)
    d, _, _ = make(tmp_path, replays=('h12',))
    r = d.replay('h12')
    assert r['title'] == 'Fake Cave'
    assert [s['cost_total'] for s in r['steps']] == pytest.approx([.1, .3, .3])
    assert r['steps'][0]['actions'] == 'Right, Right, Space'
    assert r['steps'][1]['actions'] == 'Click at 12, 30'
    assert r['steps'][0]['look'] == '' and r['steps'][0]['words'] == 'My words'
    assert r['steps'][1]['look'] == 'A door'
    assert r['steps'][0]['shot'] == '/replay-file/h12/s000.jpg'
    assert r['cards'][0] == {'title': 'Door stays closed', 'expected': 'Open', 'seen': 'Closed', 'step': 1,
                           'strip': '/replay-file/h12/strip_0.jpg', 'replays': 'Replayed twice: same end both times',
                           'judge_yes': True, 'judge_quote': 'Door stays closed in every frame'}
    assert r['cards'][1]['judge_yes'] is False
    assert r['cards'][1]['replays'] == 'Replayed twice: the ends differed, set aside'
    assert r['summary'] == {'filed': 2, 'confirmed': 1, 'set_aside': 1, 'steps': 2, 'cost_usd': .3, 'seconds': 12}
    assert r['links'] == {'report': '/replay-file/h12/report.html'}
    (folder / 'console.html').write_text('console', encoding='utf-8')
    monkeypatch.setenv('DEMO_REPO_URL', 'https://example.test/repo')
    r = d.replay('h12')
    assert r['links']['console'] == '/replay-file/h12/console.html'
    assert r['links']['repo'] == 'https://example.test/repo'


def test_multiple_log_rows_at_one_step_keep_all_spend_and_words(tmp_path):
    folder = saved(tmp_path)
    result = json.loads((folder / 'result.json').read_text(encoding='utf-8'))
    result['log'].insert(1, {'step': 0, 'cost': .05, 'text': 'One more thought', 'calls': []})
    (folder / 'result.json').write_text(json.dumps(result), encoding='utf-8')
    d, _, _ = make(tmp_path, replays=('h12',))
    steps = d.replay('h12')['steps']
    assert [s['cost_total'] for s in steps] == pytest.approx([.15, .35, .35])
    assert steps[0]['words'] == 'My words\nOne more thought'


def test_truncated_judge_uses_saved_verdict_and_quote(tmp_path):
    folder = saved(tmp_path)
    checks = [
        {'confirmed': True, 'reproducible': True, 'judge': '{"expected_change": "cut off',
         'evidence': 'Door stays closed in every frame'},
        {'confirmed': True, 'reproducible': True, 'judge': '{"verdict":"YES","evidence":""}',
         'evidence': 'This must not replace an explicit empty quote'},
    ]
    (folder / 'confirm.json').write_text(json.dumps(checks), encoding='utf-8')
    d, _, _ = make(tmp_path, replays=('h12',))
    cards = d.replay('h12')['cards']
    assert cards[0]['judge_yes'] is True
    assert cards[0]['judge_quote'] == 'Door stays closed in every frame'
    assert cards[1]['judge_yes'] is False


def test_live_shape_while_running_and_checking(tmp_path, monkeypatch):
    entered, release = threading.Event(), threading.Event()
    check_entered, check_release = threading.Event(), threading.Event()

    class ReportingHttp(FakeHttp):
        def send(self, *args, **kwargs):
            response = super().send(*args, **kwargs)
            if self.calls == 1:
                body = json.loads(response.body)
                body['output'] = act() + [{'type': 'function_call', 'name': 'report_bug', 'call_id': 'bug',
                    'arguments': json.dumps({'title': 'Door', 'expected': 'Open', 'actual': 'Closed'})}]
                return type(response)(200, {}, json.dumps(body).encode())
            return response

    def block(n):
        if n == 2:
            entered.set()
            assert release.wait(10)

    def check(folder, client, **kwargs):
        row = {'title': 'Door', 'confirmed': True, 'reproducible': True,
               'evidence': 'Door stayed closed', 'judge': json.dumps({'verdict': 'YES', 'evidence': 'Door stayed closed'})}
        kwargs['on_check'](row)
        check_entered.set()
        assert check_release.wait(10)
        return [row]

    import pt.confirm
    monkeypatch.setattr(pt.confirm, 'confirm_run', check)
    d, _, _ = make(tmp_path, http=ReportingHttp(on_call=block), won_after=None, steps=2)
    try:
        assert d.admit(CODE, '1.1.1.1')[0]
        assert entered.wait(10)
        s = d.status()
        assert s['steps'][0]['look'] == 'a cave'
        assert s['steps'][0]['actions'] == 'Wait'
        assert s['cards'][0]['seen'] == 'Closed'
        assert s['cards'][0]['replays'] == ''
        release.set()
        assert check_entered.wait(10)
        s = d.status()
        assert s['state'] == 'checking'
        assert s['cards'][0]['judge_yes'] is True
        assert s['summary']['confirmed'] == 1
    finally:
        release.set()
        check_release.set()
        finish(d)


def test_confirmation_notifies_after_each_check(tmp_path, monkeypatch):
    import pt.confirm as confirm
    folder = saved(tmp_path)
    (folder / 'confirm.json').unlink()
    result = json.loads((folder / 'result.json').read_text(encoding='utf-8'))
    result['actions_by_step'] = []
    (folder / 'result.json').write_text(json.dumps(result), encoding='utf-8')
    monkeypatch.setattr(confirm.R, 'reproducible', lambda *a, **kw: {
        'reproducible': True, 'comparison': {'compared': True, 'method': 'state', 'same': True},
        'trace': {'states': [{}, {}], 'frames': []}, 'trace_b': {'states': [{}, {}], 'frames': []}})
    monkeypatch.setattr(confirm.J, 'judge', lambda *a, **kw: {
        'confirmed': True, 'evidence': 'Door stayed closed', 'raw': '{}', 'cost_usd': 0,
        'strip': b'fake', 'strip_b': b'second'})
    seen = []

    def notify(row):
        assert not (folder / 'confirm.json').exists()
        assert (folder / f'strip_{len(seen)}.jpg').exists()
        assert (folder / f'strip_{len(seen)}_b.jpg').read_bytes() == b'second'
        seen.append(row)

    rows = confirm.confirm_run(folder, object(), on_check=notify)
    assert len(seen) == 2
    assert seen == rows
    assert seen[0] is not rows[0]


def test_no_key_build_never_makes_client(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr('metaclient.client.MetaClient', lambda *a: calls.append(a))
    d = D.build({'DEMO_PASSCODE': CODE, 'PLAYTEST_LEDGER': str(tmp_path / 'missing')}, key='')
    for code in (CODE, '', 'wrong'):
        assert d.admit(code, '1.1.1.1') == (False, 'This demo has no API key, so only recorded runs are shown.')
    assert calls == [] and d.thread is None


def test_no_key_main_starts_without_ledger_or_secrets(monkeypatch, capsys):
    import pt.env
    monkeypatch.delenv('MODEL_API_KEY', raising=False)
    loaded = []
    monkeypatch.setattr(pt.env, 'load_local_env', lambda: loaded.append(True))
    monkeypatch.setattr(pt.env, 'api_key', lambda: '')
    class Server:
        def serve_forever(self):
            pass
        def server_close(self):
            pass
    monkeypatch.setattr(D, 'serve', lambda d, port: Server())
    monkeypatch.setattr(D, 'room', lambda path: (_ for _ in ()).throw(OSError('missing')))
    D.main([])
    assert 'replay only' in capsys.readouterr().out
    assert loaded == [True]


def test_main_loads_key_from_key_file(monkeypatch, tmp_path, capsys):
    import pt.env
    key_file = tmp_path / 'fake-key'
    key_file.write_text('fake-key-value\n', encoding='utf-8')
    monkeypatch.delenv('MODEL_API_KEY', raising=False)
    monkeypatch.setenv('PLAYTEST_KEY_FILE', str(key_file))
    monkeypatch.setattr(pt.env, 'load_local_env', lambda: None)
    captured = {}
    class Server:
        def serve_forever(self):
            pass
        def server_close(self):
            pass
    def build(env, key):
        captured['key'] = key
        return type('DemoStub', (), {'ledger_path': tmp_path / 'ledger', 'passcode': 'x'})()
    monkeypatch.setattr(D, 'build', build)
    monkeypatch.setattr(D, 'serve', lambda d, port: Server())
    monkeypatch.setattr(D, 'room', lambda path: 0)
    D.main([])
    assert captured['key'] == 'fake-key-value'
    assert 'live enabled' in capsys.readouterr().out


def test_page_structure_and_plain_text():
    class Text(HTMLParser):
        def __init__(self):
            super().__init__()
            self.parts = []
        def handle_data(self, data):
            self.parts.append(data)
    parser = Text()
    # Script literals are included so text written by the page is checked too.
    parser.feed(D.PAGE)
    text = ' '.join(parser.parts)
    assert all(s not in text for s in ('\u2014', '\u2013', ' - '))
    assert 'id="picker"' in D.PAGE
    assert D.PAGE.index('id="f"') < D.PAGE.index('aria-label="Step view"')
    assert "Agent's words" in D.PAGE


def test_page_intro_has_title_subtitle_and_four_steps_before_passcode():
    header = re.search(r'<header>(.*?)</header>', D.PAGE, re.S).group(1)
    assert re.search(r'<h1>\s*Playtest Agent\s*</h1>', header)
    assert re.search(r'<p>\s*Watch a recorded run or start a live bug hunt with the passcode\.\s*</p>', header)
    expected = [
        'Play: it sees a screenshot and presses keys.',
        'Report: it writes what it expected and what it saw.',
        'Replay: each report runs twice on a fresh game.',
        'Judge: a second model must quote what it saw.',
    ]
    assert [re.sub(r'<[^>]+>', '', line).strip() for line in re.findall(r'<li>(.*?)</li>', header, re.S)] == expected
    assert D.PAGE.index('<ol') < D.PAGE.index('id="f"')


def pause_at_start(page):
    """The replay plays by itself on load: stop it if it still plays, then go back to step 0."""
    page.evaluate("() => { const b = document.getElementById('play'); if (b.textContent === 'Pause') b.click() }")
    while page.get_by_role('button', name='Previous', exact=True).is_enabled():
        page.get_by_role('button', name='Previous', exact=True).click()
    assert page.locator('#head').inner_text().endswith('Step 0')


@pytest.mark.skipif(os.environ.get('PT_BROWSER_TESTS') != '1', reason='set PT_BROWSER_TESTS=1 for the owed browser check')
@pytest.mark.parametrize('width', [360, 1280])
def test_page_browser(tmp_path, width):
    from playwright.sync_api import sync_playwright
    saved(tmp_path)
    d, _, _ = make(tmp_path, replays=('h12',))
    server = D.serve(d, 0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            try:
                page = browser.new_page(viewport={'width': width, 'height': 900})
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.goto(f'http://127.0.0.1:{server.server_address[1]}')
                page.wait_for_function("document.querySelector('#title').textContent === 'Fake Cave'")
                pause_at_start(page)
                page.get_by_role('button', name='Show all reports').click()
                page.wait_for_selector('#cards article')
                page.wait_for_function('Array.from(document.images).every(i => i.complete && i.naturalWidth > 0)')
                assert page.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth')
                steps = page.locator('#intro-steps li')
                assert steps.count() == 4
                boxes = [steps.nth(i).bounding_box() for i in range(4)]
                if width < 600:
                    assert len({round(box['x']) for box in boxes}) == 1
                else:
                    assert len({round(box['y']) for box in boxes}) == 1
                assert page.locator('#summary').is_visible()
                assert 'Bugs filed: 2' in page.locator('#summary').inner_text()
                page.get_by_role('button', name='Next', exact=True).click()
                assert page.locator('#head').inner_text().endswith('Step 1')
                page.get_by_role('button', name='Previous', exact=True).click()
                assert page.locator('#head').inner_text().endswith('Step 0')
                assert not errors
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(10)


@pytest.mark.skipif(os.environ.get('PT_BROWSER_TESTS') != '1', reason='set PT_BROWSER_TESTS=1 for the owed browser check')
def test_replay_cards_reveal_by_step_and_evidence_links(tmp_path):
    from playwright.sync_api import sync_playwright
    saved(tmp_path)
    d, _, _ = make(tmp_path, replays=('h12',))
    server = D.serve(d, 0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            try:
                page = browser.new_page()
                page.goto(f'http://127.0.0.1:{server.server_address[1]}')
                page.wait_for_function("document.querySelector('#title').textContent === 'Fake Cave'")
                pause_at_start(page)
                assert page.locator('#cards article').count() == 0
                page.get_by_role('button', name='Next', exact=True).click()
                assert page.locator('#cards article').count() == 1
                strip = page.locator('#cards article img')
                link = strip.locator('xpath=..')
                assert link.get_attribute('href') == strip.get_attribute('src')
                assert link.get_attribute('target') == '_blank'
                assert strip.get_attribute('alt') == 'Evidence frames'
                page.get_by_role('button', name='Show all reports').click()
                assert page.locator('#cards article').count() == 2
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(10)
