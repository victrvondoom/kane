"""Offline regression and gate checks with fake drivers and model clients."""
import io
import json
from pathlib import Path

import pytest
from PIL import Image
from pt import cli, report
from pt import regress as R


class Driver:
    made = []
    def __init__(self, bugs=""):
        self.n, self.bugs = 0, bugs
        Driver.made.append(self)
    def execute(self, actions): self.n += 1
    def state(self): return {"x": self.n * 10, "won": self.won(), "coins": 0 if "6" in self.bugs and self.n >= 2 else self.n}
    def won(self): return self.n >= 4 and "6" not in self.bugs
    def screenshot(self):
        b = io.BytesIO(); Image.new("RGB", (64, 36), "blue").save(b, "JPEG"); return b.getvalue()
    def bug_hits(self): return None
    def close(self): self.closed = True


class Client:
    def __init__(self, answers): self.answers, self.inputs = iter(answers), []
    def responses(self, inp, **kw):
        self.inputs.append(inp)
        return {"output_text": next(self.answers), "_cost_usd": .01}


def setup_run(tmp_path, count=5):
    old = tmp_path / "old"; old.mkdir()
    rows = [{"title": f"bug {i}", "step": 4, "expected": "works", "actual": "broken", "confirmed": True} for i in range(count)]
    (old / "confirm.json").write_text(json.dumps(rows))
    (old / "result.json").write_text(json.dumps({"game_id": "cave-courier", "bugs_on": "1,2,3,4,5", "won": True, "actions_by_step": [[{"type": "wait"}]] * 4}))
    return old


def answer(verdict, evidence="coins: 0 -> 4"):
    return json.dumps({"verdict": verdict, "evidence": evidence})


@pytest.mark.parametrize("baseline,won", [(False, False), (True, False), (True, True)])
def test_goal_uses_unpatched_replay_win(tmp_path, baseline, won):
    old = setup_run(tmp_path, 0)
    class Goal(Driver):
        def won(self): return baseline if self.bugs else won
    result = R.regress_run(old, Client([]), "", tmp_path / "new", goal_run=old, driver_cls=Goal)
    goal = result["goal_replay"]
    assert goal["old_won"] is True
    assert goal["baseline_replay_won"] is baseline
    assert goal["comparable"] is baseline
    assert goal["new_breakage"] is (baseline and not won)
    assert result["counts"]["new breakage"] == int(baseline and not won)
    if not baseline:
        assert goal["note"] == "not comparable: the saved goal does not win on the unpatched page"


@pytest.mark.parametrize("change,first", [("last", None), ("early", 2), ("unknown", None),
                                         ("short", 4), ("tolerance", None)])
def test_report_path_comparison(tmp_path, monkeypatch, capsys, change, first):
    old = setup_run(tmp_path, 1)
    before = [{"x": i * 10, "coins": 0} for i in range(6)]
    after = [dict(state) for state in before]
    after[-1]["coins"] = 1
    if change == "early":
        after[2]["x"] += 3
    elif change == "unknown":
        before[1] = None
        after[2] = None
    elif change == "short":
        after.pop()
    elif change == "tolerance":
        after[2]["x"] += 2
    frame = Driver().screenshot()
    traces = iter([{"frames": [frame] * len(states), "states": states, "bug_hits": None}
                   for states in (before, after)])
    monkeypatch.setattr(R.R, "replay_trace", lambda *a, **kw: next(traces))
    client = Client([answer("GONE")])
    result = R.regress_run(old, client, "", tmp_path / "new", driver_cls=Driver)
    row = result["reports"][0]
    assert len(client.inputs) == 1 and row["judge_verdict"] == "fixed"
    assert result["counts"]["not comparable"] == int(first is not None)
    assert result["counts"]["fixed"] == int(first is None)
    if first is not None:
        assert row["verdict"] == "path changed, not comparable"
        assert row["first_different"] == first
    else:
        assert row["verdict"] == "fixed"
    assert R.gate(tmp_path / "new") == int(first is not None)
    assert f"{int(first is not None)} not comparable" in capsys.readouterr().out


@pytest.mark.parametrize("hits,expected,judge_verdict", [
    ({"2": True}, "still there", "fixed"),
    (None, "fixed", "fixed"),
])
def test_regression_fixed_requires_clear_bug_hooks(tmp_path, monkeypatch, hits, expected, judge_verdict):
    old = setup_run(tmp_path, 1)
    class HookDriver(Driver):
        def bug_hits(self): return hits
    result = R.regress_run(old, Client([answer("GONE")]), "", tmp_path / "new", driver_cls=HookDriver)
    row = result["reports"][0]
    assert row["verdict"] == expected
    assert row["judge_verdict"] == judge_verdict
    assert row["hooks_fired"] == ([2] if hits == {"2": True} else [])
    assert row["hook_rule"] == ("none" if hits is None else "before_after")
    assert result["counts"]["fixed"] == (1 if expected == "fixed" else 0)


def test_five_confirmed_and_only_new_evidence(tmp_path):
    old = setup_run(tmp_path)
    client = Client([answer("GONE")] + [answer("STILL THERE")] * 4)
    result = R.regress_run(old, client, "1,2,4,5", tmp_path / "new", driver_cls=Driver)
    assert result["counts"] == {"fixed": 1, "still there": 4, "new breakage": 0,
                                "not comparable": 0, "page broken": 0}
    assert result["cost_usd"] == pytest.approx(.05)
    assert len(client.inputs) == 5
    text = client.inputs[0][0]["content"][0]["text"]
    assert "NEW" in text and "coins: 0 -> 4" in text
    assert json.loads((tmp_path / "new/regress.json").read_text()) == result
    assert all(d.closed for d in Driver.made[-10:])
    assert [d.bugs for d in Driver.made[-10:]] == ["1,2,3,4,5", "1,2,4,5"] * 5


@pytest.mark.parametrize("reply", [answer("GONE", ""), answer("GONE", "short"), "GONE", '{"verdict":"GONE","evidence":null}'])
def test_no_quote_is_still_there(tmp_path, reply):
    old = setup_run(tmp_path, 1)
    result = R.regress_run(old, Client([reply]), "", tmp_path / "new", driver_cls=Driver)
    assert result["counts"]["still there"] == 1


def test_unconfirmed_and_rejected_are_not_replayed(tmp_path):
    old = setup_run(tmp_path, 0)
    (old / "confirm.json").write_text(json.dumps([{"confirmed": False}, {"status": "rejected"}, {"confirmed": True, "status": "rejected"}]))
    before = len(Driver.made)
    result = R.regress_run(old, Client([]), "", tmp_path / "new", driver_cls=Driver)
    assert result["reports"] == [] and len(Driver.made) == before


def test_goal_breakage_and_first_difference(tmp_path):
    old = setup_run(tmp_path, 0)
    result = R.regress_run(old, Client([]), "6", tmp_path / "new", goal_run=old, driver_cls=Driver)
    assert result["counts"]["new breakage"] == 1
    assert result["goal_replay"]["first_different_step"] == 2
    assert result["goal_replay"]["old_won"] and not result["goal_replay"]["won"]
    assert result["cost_usd"] == 0


@pytest.mark.parametrize("still,new,code", [(1, 0, 1), (0, 1, 1), (0, 0, 0)])
def test_gate(tmp_path, capsys, still, new, code):
    (tmp_path / "regress.json").write_text(json.dumps({"counts": {"fixed": 5, "still there": still, "new breakage": new}}))
    assert cli.main(["gate", str(tmp_path)]) == code
    assert "still there" in capsys.readouterr().out


def test_regress_cli_and_report(tmp_path):
    a = cli.parse(["regress", "old", "--bugs", "6", "--goal-run", "clean", "--name", "r1"])
    assert (a.folder, a.bugs, a.goal_run, a.name) == ("old", "6", "clean", "r1")
    old = setup_run(tmp_path, 1)
    R.regress_run(old, Client([answer("GONE")]), "", tmp_path / "new", driver_cls=Driver)
    page = report.build(tmp_path / "new")
    assert "Regression" in page and "bug 0" in page and "fixed" in page and "coins: 0 -&gt; 4" in page


def test_floor_flag_is_isolated_and_shared_by_art():
    source = Path("game/index.html").read_text(encoding="utf-8")
    assert "6: false" in source and "window.__bugHit[6] = true" in source
    assert "if (BUGS.has(6))" in source
    assert "{x: 0, y: GROUND, w: 300, h: 110}" in source
    assert json.loads(Path("games/cave-courier-art.json").read_text())["url"] == "game/index.html"


def test_goal_without_breakage(tmp_path):
    old = setup_run(tmp_path, 0)
    result = R.regress_run(old, Client([]), "", tmp_path / "new", goal_run=old, driver_cls=Driver)
    assert result["counts"]["new breakage"] == 0
    assert result["goal_replay"]["first_different_step"] is None


def test_incomplete_answer_is_safe_and_cost_includes_retry(tmp_path):
    class Incomplete(Client):
        def responses(self, inp, **kw):
            return {**super().responses(inp, **kw), "status": "incomplete"}
    old = setup_run(tmp_path, 1)
    client = Incomplete([answer("GONE"), answer("GONE")])
    result = R.regress_run(old, client, "", tmp_path / "new", driver_cls=Driver)
    assert result["counts"]["still there"] == 1
    assert result["cost_usd"] == .02 and len(client.inputs) == 2


def test_regress_command_uses_saved_game_and_new_bugs(tmp_path, monkeypatch, capsys):
    from pt import adapter, guard
    from trials import common
    old = setup_run(tmp_path, 1)
    made = []
    def make(game, bugs=""):
        made.append((game, bugs))
        return Driver(bugs)
    monkeypatch.setattr(cli, "ROOT", tmp_path)
    monkeypatch.setattr(adapter, "make", make)
    monkeypatch.setattr(common, "load_client", lambda *a: Client([answer("GONE")]))
    monkeypatch.setattr(guard, "problems", lambda: [])
    monkeypatch.setattr(guard, "take_lock", lambda: None)
    monkeypatch.setattr(guard, "release_lock", lambda: None)
    assert cli.main(["regress", str(old), "--bugs", "1,2,4,5", "--name", "r1"]) == 0
    assert made == [("cave-courier", "1,2,3,4,5"), ("cave-courier", "1,2,4,5")]
    assert capsys.readouterr().out.strip() == "1 fixed, 0 still there, 0 new breakage, 0 not comparable, 0 page broken"


def test_gate_missing_file_fails_closed(tmp_path):
    assert cli.main(["gate", str(tmp_path)]) == 1


def test_patched_report_replay_error_is_saved_and_fails_gate(tmp_path):
    old = setup_run(tmp_path, 1)
    class BrokenPatched(Driver):
        def execute(self, actions):
            if not self.bugs:
                raise RuntimeError("ReferenceError: OPTIONS is not defined")
            super().execute(actions)
    client = Client([])
    result = R.regress_run(old, client, "", tmp_path / "new", driver_cls=BrokenPatched)
    row = result["reports"][0]
    assert row == {"title": "bug 0", "step": 4, "verdict": "page broken",
                   "error": "ReferenceError: OPTIONS is not defined", "cost_usd": 0,
                   "hooks_fired": None}
    assert client.inputs == []
    assert result["counts"]["page broken"] == 1
    assert json.loads((tmp_path / "new/regress.json").read_text()) == result
    assert R.gate(tmp_path / "new") == 1


@pytest.mark.parametrize("baseline_won,patched_broken", [(True, True), (False, False)])
def test_patched_goal_replay_error_is_recorded(tmp_path, baseline_won, patched_broken):
    old = setup_run(tmp_path, 0)
    class BrokenGoal(Driver):
        def execute(self, actions):
            if not self.bugs:
                raise RuntimeError("page throws")
            super().execute(actions)
        def won(self):
            return baseline_won if self.bugs else False
    result = R.regress_run(old, Client([]), "", tmp_path / "new", goal_run=old,
                           driver_cls=BrokenGoal)
    goal = result["goal_replay"]
    assert goal["won"] is False and goal["page_broken"] is True
    assert goal["error"] == "page throws"
    assert goal["new_breakage"] is baseline_won
    assert goal["comparable"] is baseline_won
    assert goal["new_states"] == []
    assert result["counts"]["page broken"] == 1
    assert result["counts"]["new breakage"] == int(baseline_won)


def test_baseline_report_replay_error_still_raises(tmp_path):
    old = setup_run(tmp_path, 1)
    class BrokenBaseline(Driver):
        def execute(self, actions): raise RuntimeError("baseline broken")
    with pytest.raises(RuntimeError, match="baseline broken"):
        R.regress_run(old, Client([]), "", tmp_path / "new", driver_cls=Driver,
                      baseline_driver_cls=BrokenBaseline)


def test_gate_old_counts_without_page_broken_key(tmp_path, capsys):
    (tmp_path / "regress.json").write_text(json.dumps({"counts": {
        "fixed": 2, "still there": 0, "new breakage": 0}}))
    assert R.gate(tmp_path) == 0
    assert "0 page broken" in capsys.readouterr().out

@pytest.mark.parametrize("counts", [
    {"fixed": 1, "still there": -1, "new breakage": 0},
    {"fixed": 1, "still there": 0, "new breakage": float("nan")},
    {"fixed": True, "still there": 0, "new breakage": 0},
    {"fixed": 1, "still there": "0", "new breakage": 0},
])
def test_gate_invalid_counts_fail_closed(tmp_path, counts):
    (tmp_path / "regress.json").write_text(json.dumps({"counts": counts}))
    assert R.gate(tmp_path) == 1


def test_output_cannot_be_an_existing_run(tmp_path):
    old = setup_run(tmp_path, 0)
    output = tmp_path / "existing"
    output.mkdir()
    (output / "result.json").write_text('{"won": true}')
    with pytest.raises(ValueError, match="fresh"):
        R.regress_run(old, Client([]), "", output, driver_cls=Driver)
    assert not (output / "regress.json").exists()


def test_invalid_report_step_is_rejected_before_replay(tmp_path):
    old = setup_run(tmp_path, 1)
    rows = json.loads((old / "confirm.json").read_text())
    rows[0]["step"] = 50
    (old / "confirm.json").write_text(json.dumps(rows))
    before = len(Driver.made)
    with pytest.raises(ValueError, match="step"):
        R.regress_run(old, Client([]), "", tmp_path / "new", driver_cls=Driver)
    assert len(Driver.made) == before


def test_cli_refuses_a_different_game_before_loading_client(tmp_path, monkeypatch):
    from pt import guard
    from trials import common
    old = setup_run(tmp_path, 0)
    def no_client(*args):
        pytest.fail("A mismatched game must be rejected before loading a model client")
    monkeypatch.setattr(common, "load_client", no_client)
    monkeypatch.setattr(guard, "problems", lambda: [])
    monkeypatch.setattr(guard, "take_lock", lambda: None)
    monkeypatch.setattr(guard, "release_lock", lambda: None)
    args = cli.parse(["regress", str(old), "--game", "other-game", "--bugs", ""])
    with pytest.raises(ValueError, match="same game"):
        R.run_cli(args, tmp_path)


@pytest.mark.parametrize("before,after,verdict,expected", [
    ({1, 2}, {2}, "GONE", "fixed"),
    ({1, 2}, {1, 2}, "GONE", "still there"),
    ({1}, {1, 3}, "GONE", "new breakage"),
    ({1, 2}, {2}, "STILL THERE", "still there"),
], ids=["a", "b", "c", "d"])
def test_hooks_before_after(tmp_path, before, after, verdict, expected):
    old = setup_run(tmp_path, 1)
    class Before(Driver):
        def bug_hits(self): return {str(n): n in before for n in range(1, 6)}
    class After(Driver):
        def bug_hits(self): return {str(n): n in after for n in range(1, 6)}
    client = Client([answer(verdict)])
    result = R.regress_run(old, client, "", tmp_path / "new", driver_cls=After,
                           baseline_driver_cls=Before)
    row = result["reports"][0]
    assert row["verdict"] == expected
    assert row["hooks_before"] == sorted(before) and row["hooks_after"] == sorted(after)
    assert row["hook_rule"] == "before_after"
    assert row["judge_verdict"] == ("fixed" if verdict == "GONE" else "still there")
    assert result["counts"]["new breakage"] == int(expected == "new breakage")
    assert len(client.inputs) == 1
    assert (tmp_path / "new/trace_0_before/meta.json").exists()


@pytest.mark.parametrize("hits,gone,not_measured", [
    ({"1": False}, [1], [2]),
    (None, [], [1, 2]),
    ({"1": False, "2": None}, [1], [2]),
    ({"1": False, "2": 0}, [1], [2]),
])
def test_missing_hook_after_patch_is_not_gone(tmp_path, hits, gone, not_measured):
    old = setup_run(tmp_path, 1)
    class Before(Driver):
        def bug_hits(self): return {"1": True, "2": True}
    class After(Driver):
        def bug_hits(self): return hits
    result = R.regress_run(old, Client([answer("GONE")]), "", tmp_path / "new",
                           driver_cls=After, baseline_driver_cls=Before)
    row = result["reports"][0]
    assert row["verdict"] == "still there"
    assert row["hooks_gone"] == gone
    assert row["hooks_not_measured"] == not_measured
    assert row["hook_rule"] == "before_after"
    assert result["counts"] == {"fixed": 0, "still there": 1, "new breakage": 0,
                                "not comparable": 0, "page broken": 0}


def test_build_requires_baseline_before_client_or_driver(tmp_path, monkeypatch):
    from pt import adapter, guard
    from trials import common
    old = setup_run(tmp_path, 0)
    monkeypatch.setattr(adapter, "make", lambda *a, **kw: pytest.fail("no driver"))
    monkeypatch.setattr(common, "load_client", lambda *a: pytest.fail("no client"))
    monkeypatch.setattr(guard, "take_lock", lambda: pytest.fail("no lock"))
    args = cli.parse(["regress", str(old), "--bugs", "", "--build", "patched.html"])
    with pytest.raises(ValueError, match="--baseline-build"):
        R.run_cli(args, tmp_path)
