"""No Doom engine (ViZDoom, Freedoom) while a game window of the owner's is open, his words 28 Oct: "can u tell the agent not to
run doom while I am gaming?". That night two whole test runs started the engine while Marvel Rivals was open.
This file's name must not start with test_doom: those files are the ones held."""
import types

import pytest

from conftest import hold_doom_items, hold_whole_run, is_whole_run
from pt import guard

MARVEL = "Marvel-Win64-Shipping"


def test_hold_names_the_open_game():
    assert guard.doom_hold(games=lambda: [MARVEL]) == f"HELD - {MARVEL} is open"


def test_no_hold_with_no_game_open():
    assert guard.doom_hold(games=lambda: []) is None


def test_a_window_list_that_cannot_be_read_holds():
    def broken():
        raise OSError("powershell missing")
    assert guard.doom_hold(games=broken).startswith("HELD - ")


def test_the_adapter_refuses_to_start_the_engine(monkeypatch):
    doom = pytest.importorskip("pt.doom")
    started = []
    monkeypatch.setattr(guard, "game_windows", lambda: [MARVEL])
    monkeypatch.setattr(doom.V, "DoomGame", lambda: started.append(1))
    with pytest.raises(SystemExit) as e:
        doom.DoomAdapter({"name": "d", "scenario": "basic.cfg"})
    assert str(e.value) == f"HELD - {MARVEL} is open"
    assert started == []


class Item:
    def __init__(self, name):
        self.path = types.SimpleNamespace(name=name)
        self.marks = []

    def add_marker(self, mark):
        self.marks.append(mark)


def test_doom_tests_are_skipped_while_a_game_is_open():
    items = [Item("test_doom.py"), Item("test_doom_engine.py"), Item("test_guard.py")]
    hold_doom_items(items, lambda: f"HELD - {MARVEL} is open")
    assert [len(i.marks) for i in items] == [1, 1, 0]
    assert items[0].marks[0].kwargs["reason"] == f"HELD - {MARVEL} is open"


def test_doom_tests_run_with_no_game_open():
    items = [Item("test_doom.py")]
    hold_doom_items(items, lambda: None)
    assert items[0].marks == []


def test_the_window_list_is_not_read_when_no_doom_test_runs():
    asked = []
    hold_doom_items([Item("test_guard.py")], lambda: asked.append(1))
    assert asked == []


# No whole suite while he games, his rule: only the change's own few suites. full3 and full4 on 28 Oct were whole suites.
def test_a_run_with_no_file_named_is_whole():
    assert is_whole_run([]) and is_whole_run(["tests"]) and is_whole_run(["tests", "--ignore=tests/test_game.py"])


def test_a_run_of_named_files_is_not_whole():
    assert not is_whole_run(["tests/test_guard.py", "tests/test_cli.py::test_x", "-k", "stop"])


def test_a_whole_run_is_held_while_a_game_is_open():
    with pytest.raises(pytest.exit.Exception) as e:
        hold_whole_run(["tests"], lambda: f"HELD - {MARVEL} is open")
    assert str(e.value.msg) == f"HELD - {MARVEL} is open"


def test_a_whole_run_goes_with_no_game_open():
    hold_whole_run([], lambda: None)


def test_named_files_go_while_a_game_is_open_and_the_list_is_not_read():
    asked = []
    hold_whole_run(["tests/test_guard.py"], lambda: asked.append(1))
    assert asked == []
