import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pt.python_version import require_supported
require_supported()

import pytest


def hold_doom_items(items, hold):
    """Skip every test_doom* file while a game window is open: those tests start the Doom engine. `hold` is read only when such
    a test was collected, because the window list takes a few seconds."""
    doom = [i for i in items if i.path.name.startswith("test_doom")]
    reason = hold() if doom else None
    if reason:
        sys.stderr.write(reason + "\n")
        for i in doom:
            i.add_marker(pytest.mark.skip(reason=reason))


def is_whole_run(args):
    """A run that names no test file runs the whole suite."""
    return not any(".py" in a and not a.startswith("-") for a in args)


def hold_whole_run(args, hold):
    """No whole suite while a game window is open, his rule: only the change's own few suites, named by file. On 28 Oct two
    whole suites ran beside his game."""
    reason = hold() if is_whole_run(args) else None
    if reason:
        pytest.exit(reason, returncode=1)


@pytest.fixture(autouse=True)
def fake_api_key(monkeypatch):
    """Paid commands stop with no key (pt.env.require_api_key). Tests run them with fake clients, so give every test a fake key:
    a fresh clone has no local.env, and 44 tests failed there on 29 Oct. A test of the no-key stop deletes it again."""
    monkeypatch.setenv("MODEL_API_KEY", "test-key-not-real")
    monkeypatch.delenv("PLAYTEST_KEY_FILE", raising=False)


def pytest_configure(config):
    from pt import guard
    hold_whole_run(config.args, guard.doom_hold)


def pytest_collection_modifyitems(config, items):
    from pt import guard
    hold_doom_items(items, guard.doom_hold)
    if __import__("os").environ.get("PT_DOOM_ENGINE") != "1":
        reason = "Set PT_DOOM_ENGINE=1 to run real Doom engine tests; the engine shows a start up window on the main display."
        real_engine_files = {"test_doom_engine.py", "test_doom_sound.py"}
        for item in items:
            if item.path.name in real_engine_files:
                item.add_marker(pytest.mark.skip(reason=reason))
