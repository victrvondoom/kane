"""One command line for the tool: python -m pt goal|hunt|confirm|report|guard."""
import pytest
from pt import cli as C


@pytest.fixture(autouse=True)
def fake_model_key(monkeypatch):
    monkeypatch.setenv("MODEL_API_KEY", "test-key")


def test_goal_defaults():
    a = C.parse(["goal", "run1"])
    assert (a.cmd, a.name, a.game, a.state, a.effort) == ("goal", "run1", "cave-courier", False, "low")
    assert a.max_steps == 60 and a.max_seconds == 900 and a.max_usd == 2.5


@pytest.mark.parametrize("status", ["not compared", "input refused in replay"])
def test_signoff_accepts_completed_non_unverified_statuses(tmp_path, capsys, status):
    import json
    from pt.cli import signoff
    (tmp_path / "result.json").write_text(json.dumps({"reports": [{"title": "x"}]}))
    (tmp_path / "confirm.json").write_text(json.dumps([{"status": status, "confirmed": False}]))
    assert signoff(tmp_path, "Ada", "reviewed") == 0


def test_options():
    a = C.parse(["hunt", "h1", "--game", "other-game", "--state", "--effort", "minimal", "--max-steps", "30", "--bugs", "1,2"])
    assert a.game == "other-game" and a.state is True and a.effort == "minimal" and a.max_steps == 30 and a.bugs == "1,2"


def test_confirm_and_report_take_a_run_folder():
    assert C.parse(["confirm", "data/runs/x"]).folder == "data/runs/x"
    assert C.parse(["report", "data/runs/x"]).folder == "data/runs/x"
    assert C.parse(["guard"]).cmd == "guard"


@pytest.mark.parametrize("judge_input,expected", [("strip", {}), ("video", {"judge_input": "video"})])
def test_confirm_passes_judge_input_only_when_nondefault(monkeypatch, tmp_path, judge_input, expected):
    from pt import guard
    from trials import common

    monkeypatch.setattr(C, "ROOT", tmp_path)
    monkeypatch.setattr(common, "load_client", lambda *args: object())
    monkeypatch.setattr(guard, "problems", lambda *args: [])
    monkeypatch.setattr(guard, "take_lock", lambda: None)
    monkeypatch.setattr(guard, "release_lock", lambda: None)
    calls = []

    def confirm_run(folder, client, driver_cls, **kwargs):
        calls.append(kwargs)
        return []

    from pt import confirm
    monkeypatch.setattr(confirm, "confirm_run", confirm_run)
    args = ["confirm", str(tmp_path)]
    if judge_input != "strip":
        args += ["--judge-input", judge_input]
    assert C.main(args) == 0
    assert calls == [expected]


def test_bad_effort_is_rejected():
    with pytest.raises(SystemExit):
        C.parse(["goal", "r", "--effort", "wild"])


def test_run_settings_pick_the_goal_or_the_hunt_text():
    g = C.run_settings(C.parse(["goal", "r"]), game_goal="Reach the flag.")
    h = C.run_settings(C.parse(["hunt", "r"]), game_goal="Reach the flag.")
    assert g["goal"] == "Reach the flag." and "tester" in h["goal"]


def test_test_game_hunt_turns_the_planted_bugs_on_and_goal_does_not():
    assert C.run_settings(C.parse(["hunt", "r"]), game_goal="x")["bugs"] == "1,2,3,4,5"
    assert C.run_settings(C.parse(["goal", "r"]), game_goal="x")["bugs"] == ""
    assert C.run_settings(C.parse(["hunt", "r", "--game", "other-game"]), game_goal="x")["bugs"] == ""


def test_max_out_flag_defaults_and_overrides():
    assert C.parse(["goal", "r"]).max_out == 3000
    assert C.parse(["goal", "r", "--max-out", "700"]).max_out == 700


def test_hunt_text_asks_for_one_report_per_problem_and_risky_things_last():
    assert "one report per problem" in C.HUNT and "for last" in C.HUNT


def test_hunt_text_has_a_method_and_names_no_part_of_the_test_game():
    text = C.hunt_text(steps=60, reload=True).lower()
    for step in ("near the start", "every number", "costs something", "blocks your way", "reload"):
        assert step in text
    assert "60 steps" in text
    for word in ("shed", "boots", "shop", "coin", "door", "key", "flag", "cave"):
        assert word not in text


def test_hunt_text_mentions_reload_only_when_the_game_has_it():
    assert "reload" not in C.hunt_text(steps=40, reload=False).lower()
    assert "40 steps" in C.run_settings(C.parse(["hunt", "r", "--max-steps", "40"]), game_goal="x")["goal"]


def test_cli_passes_sam_client_only_for_sam_player_config(monkeypatch, tmp_path):
    from pt import adapter, guard, loop
    from trials import common

    class Driver:
        name, goal = "Demo", "Try"
        def won(self): return False
        def bug_hits(self): return None
        def state(self): return None
        def close(self): pass

    client = object()
    calls = []
    configs = {
        "cave-courier-sam": {"sam_player": "player"},
        "cave-courier": {"state_js": "state"},
    }
    monkeypatch.setattr(C, "ROOT", tmp_path)
    monkeypatch.setattr(adapter, "config_path", lambda game: game)
    monkeypatch.setattr(adapter, "load_config", lambda path: configs[path])
    monkeypatch.setattr(adapter, "make", lambda game, **kwargs: calls.append((game, kwargs)) or Driver())
    monkeypatch.setattr(common, "load_client", lambda *args: client)
    monkeypatch.setattr(guard, "problems", lambda *args: [])
    monkeypatch.setattr(guard, "take_lock", lambda: None)
    monkeypatch.setattr(guard, "release_lock", lambda: None)
    monkeypatch.setattr(loop, "run_episode", lambda *args, **kwargs: {"stop": "steps"})

    assert C.main(["goal", "sam", "--game", "cave-courier-sam"]) == 0
    assert C.main(["goal", "ordinary", "--game", "cave-courier"]) == 0
    assert calls[0][0] == "cave-courier-sam" and calls[0][1]["sam_client"] is client
    assert calls[1] == ("cave-courier", {"bugs": ""})


@pytest.mark.parametrize("kind,reloadable,expect", [("hunt", True, (True, 2)), ("hunt", False, (False, 2)), ("goal", True, (False, 0))])
def test_hunt_offers_reload_and_nudges(kind, reloadable, expect, monkeypatch, tmp_path):
    from pt import adapter, guard, loop
    from trials import common
    from test_loop import FakeDriver
    d = FakeDriver()
    d.goal, d.name = "Try", "Demo"
    d.won, d.bug_hits, d.close = lambda: False, lambda: None, lambda: None
    if reloadable:
        d.reload = lambda: None
    monkeypatch.setattr(C, "ROOT", tmp_path)
    monkeypatch.setattr(adapter, "make", lambda *a, **kw: d)
    monkeypatch.setattr(common, "load_client", lambda *a: object())
    monkeypatch.setattr(guard, "problems", lambda *a: [])
    monkeypatch.setattr(guard, "take_lock", lambda: None)
    monkeypatch.setattr(guard, "release_lock", lambda: None)
    seen = {}
    def episode(client, driver, goal, **kw):
        seen.update(kw, goal=goal)
        return {"stop": "steps"}
    monkeypatch.setattr(loop, "run_episode", episode)
    assert C.main([kind, "r", "--game", "demo"]) == 0
    assert (seen["reload"], seen["nudges"]) == expect
    if kind == "hunt":
        assert ("reload" in seen["goal"].lower()) == reloadable


@pytest.mark.parametrize("kind", ["goal", "hunt"])
def test_narrate_flag(kind):
    assert C.parse([kind, "r"]).narrate is False
    assert C.parse([kind, "r", "--narrate"]).narrate is True


@pytest.mark.parametrize("kind", ["goal", "hunt"])
@pytest.mark.parametrize("recordable", [False, True])
def test_record_starts_before_episode(kind, recordable, monkeypatch, tmp_path):
    from pt import adapter, guard, loop
    from trials import common
    from test_loop import FakeDriver
    d = FakeDriver()
    d.goal, d.name = "Try", "Freedoom (Doom engine)"
    d.won, d.bug_hits, d.close = lambda: False, lambda: None, lambda: None
    calls = []
    if recordable:
        d.start_recording = lambda folder: calls.append(folder)
    monkeypatch.setattr(C, "ROOT", tmp_path)
    monkeypatch.setattr(adapter, "make", lambda *a, **kw: d)
    monkeypatch.setattr(common, "load_client", lambda *a: object())
    monkeypatch.setattr(guard, "problems", lambda *a: [])
    monkeypatch.setattr(guard, "take_lock", lambda: None)
    monkeypatch.setattr(guard, "release_lock", lambda: None)
    def episode(*a, **kw):
        assert calls == ([tmp_path / "data/runs/r"] if recordable else [])
        assert kw["narrate"]
        return {"stop": "steps"}
    monkeypatch.setattr(loop, "run_episode", episode)
    assert C.main([kind, "r", "--record", "--narrate"]) == 0


def test_version_is_below_one_until_the_owner_approves():
    import pt
    major = int(pt.__version__.split(".")[0])
    assert major < 1


def test_version_flag_prints_the_version(capsys):
    import pt
    try:
        C.parse(["--version"])
    except SystemExit:
        pass
    assert pt.__version__ in capsys.readouterr().out


def test_hunt_text_says_stuck_is_a_bug_only_after_every_way_out_failed():
    for reload in (True, False):
        text = C.hunt_text(steps=60, reload=reload).lower()
        assert "only after every way out failed" in text
        assert "hold each direction" in text and "restart" in text


def test_confirm_replays_on_the_runs_own_game_unless_told(tmp_path):
    (tmp_path / "result.json").write_text('{"game_id": "cave-courier-art"}', encoding="utf-8")
    assert C.confirm_game(C.parse(["confirm", str(tmp_path)])) == "cave-courier-art"
    assert C.confirm_game(C.parse(["confirm", str(tmp_path), "--game", "x"])) == "x"
    (tmp_path / "result.json").write_text('{}', encoding="utf-8")
    assert C.confirm_game(C.parse(["confirm", str(tmp_path)])) == "cave-courier"


@pytest.mark.parametrize("argv", [["hunt", "cl21"], ["hunt", "c12"], ["hunt", "clean-final"], ["goal", "clean-x", "--bugs", "1"],
                                  ["hunt", "x", "--clean", "--bugs", "1"], ["hunt", "cl21", "--bugs", "2,3"]])
def test_a_clean_run_with_bugs_on_is_refused(argv):
    """cl20 (28 Oct) was meant to be clean and ran with bugs 1 to 5 on: a cave-courier hunt turns them on by default."""
    assert C.clean_problem(C.parse(argv))


@pytest.mark.parametrize("argv", [["hunt", "cl21", "--bugs", ""], ["hunt", "x", "--clean"], ["hunt", "h13"], ["goal", "t-doom4"]])
def test_clean_runs_with_no_bugs_and_other_runs_start(argv):
    assert C.clean_problem(C.parse(argv)) is None


def test_clean_flag_turns_every_bug_off():
    assert C.run_settings(C.parse(["hunt", "x", "--clean"]), game_goal="x")["bugs"] == ""


def test_main_refuses_a_clean_run_with_bugs_before_anything_starts(monkeypatch, tmp_path, capsys):
    from pt import adapter, guard
    monkeypatch.setattr(C, "ROOT", tmp_path)
    monkeypatch.setattr(guard, "problems", lambda *a: pytest.fail("the guard must not even run"))
    monkeypatch.setattr(adapter, "make", lambda *a, **kw: pytest.fail("no game may start"))
    assert C.main(["hunt", "cl21"]) == 2
    assert "clean" in capsys.readouterr().out
    assert not (tmp_path / "data" / "runs" / "cl21").exists()


def test_bugs_setting_is_the_first_line_of_the_run_file(monkeypatch, tmp_path, capsys):
    from pt import adapter, guard, loop
    from trials import common
    from test_loop import FakeDriver
    d = FakeDriver()
    d.goal, d.name = "Try", "demo"
    d.won, d.bug_hits, d.close = lambda: False, lambda: None, lambda: None
    monkeypatch.setattr(C, "ROOT", tmp_path)
    monkeypatch.setattr(adapter, "make", lambda *a, **kw: d)
    monkeypatch.setattr(common, "load_client", lambda *a: object())
    monkeypatch.setattr(guard, "problems", lambda *a: [])
    monkeypatch.setattr(guard, "take_lock", lambda: None)
    monkeypatch.setattr(guard, "release_lock", lambda: None)
    monkeypatch.setattr(loop, "run_episode", lambda *a, **kw: {"stop": "steps"})
    assert C.main(["hunt", "cl21", "--bugs", ""]) == 0
    text = (tmp_path / "data" / "runs" / "cl21" / "result.json").read_text(encoding="utf-8")
    assert text.splitlines()[1].strip() == '"bugs_on": "",'
    assert 'bugs on: none' in capsys.readouterr().out
