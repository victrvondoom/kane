import hashlib
import io
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image


class Client:
    def __init__(self, answers, patch=None):
        self.answers = iter(answers)
        self.patch = patch or {"edits": [{"search": "broken", "replace": "repaired"}],
                               "diff": "", "why": "Repair the move"}
        self.prompts = []

    def wonder(self, body, **kwargs):
        from pt.fix import FORMAT, FIX_MAX_OUT
        assert body["text"]["format"] == FORMAT
        assert body["max_output_tokens"] == FIX_MAX_OUT
        assert "fix-any" in kwargs["label"] and kwargs["reserve_usd"] > 0
        self.prompts.append(body["input"][0]["content"][0]["text"])
        return {"output_text": json.dumps(self.patch), "_cost_usd": .02}

    def responses(self, inp, **kwargs):
        assert "fix-any" in kwargs["label"]
        return {"output_text": json.dumps({"verdict": next(self.answers),
                                          "evidence": "The move still fails"}), "_cost_usd": .01}


@pytest.fixture
def case(tmp_path):
    run = tmp_path / "run"
    run.mkdir()
    (run / "result.json").write_text(json.dumps({"kind": "hunt", "game_id": "react-chess",
        "actions_by_step": [[{"type": "click", "x": 1, "y": 2}]],
        "reports": [{"title": "Bad move", "step": 1}]}))
    (run / "confirm.json").write_text(json.dumps([{"title": "Bad move", "step": 1,
        "confirmed": True, "status": "kept", "reproducible": True}]))
    source = tmp_path / "source"
    source.mkdir()
    (source / "move.js").write_text("broken\n")
    (source / "readonly.js").write_text("broken\n")
    config = {"source": str(source), "editable": ["move.js"], "context": [],
              "build": ["fake-build", "{src}", "{out}"],
              "game": {"type": "web", "name": "Chess", "serve": {"dir": "{out}"}},
              "checks": [["fake-check", "{out}"]]}
    path = tmp_path / "fix.json"
    made, commands = [], []
    class Driver:
        def __init__(self, cfg, bugs=""):
            self.cfg, self.closed, self.actions = cfg, False, []
            made.append(self)
        def screenshot(self):
            stream = io.BytesIO()
            image = Image.new("RGB", (8, 8), "black")
            image.putpixel((0, 0), (255, 0, 0))
            image.save(stream, "JPEG")
            return stream.getvalue()
        def state(self): return {"moves": len(self.actions)}
        def execute(self, actions): self.actions.append(actions)
        def health(self): return {"alive": True}
        def close(self): self.closed = True
    def runner(cmd, **kwargs):
        commands.append(cmd)
        if cmd[0] == "fake-build":
            assert Path(cmd[1], "move.js").read_text() == "repaired\n"
            assert Path(cmd[1], "readonly.js").read_text() == "broken\n"
        return SimpleNamespace(returncode=0, stdout="", stderr="")
    def execute(client, tries=2, build_runner=runner, driver_factory=Driver):
        from pt.fix_any import fix_run
        path.write_text(json.dumps(config))
        return fix_run(run, client, report=0, fix_config=path, tries=tries,
                       runner=build_runner, driver_factory=driver_factory)
    return SimpleNamespace(**locals())


def test_retry_judge_failure_reaches_prompt(case):
    client = Client(["YES", "NO"])
    result = case.execute(client)
    assert result["result"] == "fixed"
    assert len(result["attempts"]) == 2
    assert "The move still fails" in client.prompts[1]
    assert result["cost_usd"] == pytest.approx(.06)
    assert all(d.closed and len(d.actions) == 1 for d in case.made)
    assert (case.run / "fix-any-0.diff").read_text().startswith("--- a/move.js")
    assert (case.source / "move.js").read_text() == "broken\n"


def test_all_judges_fail(case):
    assert case.execute(Client(["YES", "YES"]))["result"] == "not fixed"


def test_all_builds_fail(case):
    def fail(cmd, **kwargs):
        return SimpleNamespace(returncode=1, stdout="", stderr="compiler failed")
    client = Client([])
    result = case.execute(client, build_runner=fail)
    assert result["result"] == "build failed"
    assert "compiler failed" in client.prompts[1]
    assert not case.made


def test_edit_outside_allowlist_refused(case):
    patch = {"edits": [{"path": "readonly.js", "search": "broken", "replace": "repaired"}],
             "diff": "", "why": "Change another file"}
    result = case.execute(Client([], patch), tries=1)
    assert result["result"] == "not fixed"
    assert "Patch rejected" in result["attempts"][0]["failure"]
    assert not case.commands


def test_check_failure_prevents_success(case):
    def runner(cmd, **kwargs):
        return SimpleNamespace(returncode=int(cmd[0] == "fake-check"), stdout="", stderr="check failed")
    result = case.execute(Client(["NO"]), tries=1, build_runner=runner)
    assert result["result"] == "not fixed"
    assert result["attempts"][0]["checks"][0]["returncode"] == 1


def test_external_context_never_saved_or_printed(case, capsys):
    marker = "PRIVATE_CONTEXT_MARKER_90210"
    context = case.tmp_path / "private.cs"
    context.write_text(marker, encoding="utf-8")
    case.config["context"] = [str(context)]
    client = Client(["NO"])
    client.patch["why"] = marker
    def runner(cmd, **kwargs):
        return SimpleNamespace(returncode=0, stdout=marker, stderr=marker)
    result = case.execute(client, tries=1, build_runner=runner)
    assert marker in client.prompts[0]
    assert result["context"] == [{"path": str(context), "sha256": hashlib.sha256(marker.encode()).hexdigest()}]
    for path in case.run.rglob("*"):
        if path.is_file():
            assert marker.encode() not in path.read_bytes()
    output = capsys.readouterr()
    assert marker not in output.out + output.err


def test_legacy_fix_still_refuses_other_games(case):
    from pt.fix import _inputs
    goal = case.tmp_path / "goal"
    goal.mkdir()
    (goal / "result.json").write_text("{}")
    with pytest.raises(ValueError, match="^Fix needs a hunt on cave-courier-buggy$"):
        _inputs(case.run, goal, 1)


@pytest.mark.parametrize("answer", ["UNKNOWN", "", "NO", "YES"])
def test_only_explicit_no_passes(case, answer):
    assert (case.execute(Client([answer]), tries=1)["result"] == "fixed") is (answer == "NO")


def test_replay_error_closes_driver(case):
    class Broken(case.Driver):
        def execute(self, actions): raise ValueError("driver failed")
    result = case.execute(Client([]), tries=1, driver_factory=Broken)
    assert result["result"] == "not fixed"
    assert case.made[0].closed


def test_money_stop_is_not_retried(case):
    from metaclient.ledger import CapReached
    class Stopped(Client):
        def wonder(self, *args, **kwargs): raise CapReached("session stop")
    with pytest.raises(CapReached):
        case.execute(Stopped([]))
    assert not case.commands


def test_cli_parser():
    from pt.cli import parse
    args = parse(["fix-any", "run", "--report", "0", "--fix-config", "fix.json"])
    assert args.tries == 3 and args.report == 0


def test_long_judge_reply_is_read_in_full(case):
    class Long(Client):
        def responses(self, *args, **kwargs):
            return {"output_text": json.dumps({"expected_change": "legal move " * 100,
                "verdict": "NO", "evidence": "The piece moves correctly"}), "_cost_usd": .01}
    assert case.execute(Long([]), tries=1)["result"] == "fixed"


def test_private_context_cannot_be_inserted_in_patch(case):
    marker = "PRIVATE_INSERT_MARKER_801"
    path = case.tmp_path / "private.cs"
    path.write_text(marker)
    case.config["context"] = [str(path)]
    client = Client([])
    client.patch["edits"][0]["replace"] = marker
    result = case.execute(client, tries=1)
    assert result["result"] == "not fixed"
    assert not case.commands
    assert marker not in (case.run / "fix-any-0.json").read_text()


def test_short_using_context_line_does_not_block_patch(case):
    (case.source / "move.js").write_text("broken\n")
    context = case.tmp_path / "private.cs"
    context.write_text("using System.Linq;\nclass HiddenThing { }\n")
    case.config["context"] = [str(context)]
    client = Client(["NO"])
    client.patch["edits"][0]["replace"] = "repaired\nusing System.Linq;\n"
    result = case.execute(client, tries=1, build_runner=lambda *a, **kw:
        SimpleNamespace(returncode=0, stdout="", stderr=""))
    assert result["attempts"][0]["build"]["returncode"] == 0


def test_long_context_line_is_still_refused(case):
    (case.source / "move.js").write_text("broken\n")
    private_line = "class HiddenThing { private void SecretMethod() { } }"
    context = case.tmp_path / "private.cs"
    context.write_text(private_line + "\n")
    case.config["context"] = [str(context)]
    client = Client(["NO"])
    client.patch["edits"][0]["replace"] = private_line + "\n"
    result = case.execute(client, tries=1)
    assert result["attempts"][0]["build"] is None
    assert "Patch contains read only context" in result["attempts"][0]["failure"]


@pytest.mark.parametrize("name", ["../outside.js", "readonly.js"])
def test_diff_cannot_change_other_file(case, name):
    patch = {"edits": [], "diff": f"--- a/{name}\n+++ b/{name}\n@@ -1 +1 @@\n-broken\n+repaired\n",
             "why": "Wrong target"}
    assert case.execute(Client([], patch), tries=1)["result"] == "not fixed"
    assert not case.commands


def test_cli_uses_guard_lock_and_shared_client(case, monkeypatch, capsys):
    from pt import cli, fix_any, guard
    from trials import common
    case.path.write_text(json.dumps(case.config))
    locks = []
    monkeypatch.setattr(guard, "problems", lambda: [])
    monkeypatch.setattr(guard, "take_lock", lambda: locks.append("take"))
    monkeypatch.setattr(guard, "release_lock", lambda: locks.append("release"))
    monkeypatch.setattr(common, "load_client", lambda name: Client(["NO"]))
    real = fix_any.fix_run
    monkeypatch.setattr(fix_any, "fix_run", lambda *a, **kw: real(*a, **kw,
        runner=case.runner, driver_factory=case.Driver))
    args = cli.parse(["fix-any", str(case.run), "--report", "0", "--fix-config", str(case.path)])
    assert cli._main(args) == 0
    assert locks == ["take", "release"]
    assert capsys.readouterr().out.strip() == "fixed"


def test_chess_example_is_also_a_valid_game_config():
    from pt.adapter import load_config
    path = Path(__file__).resolve().parents[1] / "games/react-chess.fix.json"
    cfg = load_config(path)
    assert cfg["game"]["serve"]["dir"] == "{out}"
    assert cfg["source"] == "games.cache/react-chess"


def test_csharp_mod_with_multiple_editable_files(case):
    for name in ("Move.cs", "Helper.cs"):
        (case.source / name).write_text("broken\n")
    case.config["editable"] = ["Move.cs", "Helper.cs"]
    case.config["game"] = {"type": "pcgame", "name": "Mod test",
        "exe": "{out}/game.exe", "run_root": "{out}/runs", "side_display": 2}
    def runner(cmd, **kwargs):
        if cmd[0] == "fake-build":
            assert all(Path(cmd[1], name).read_text() == "repaired\n"
                       for name in case.config["editable"])
        return SimpleNamespace(returncode=0, stdout="", stderr="")
    result = case.execute(Client(["NO"]), tries=1, build_runner=runner)
    assert result["result"] == "fixed"
    assert result["cost_usd"] == pytest.approx(.05)
    assert case.made[0].cfg["type"] == "pcgame"
    assert "{out}" not in case.made[0].cfg["exe"]
    diff = (case.run / "fix-any-0.diff").read_text()
    assert "a/Move.cs" in diff and "a/Helper.cs" in diff


def test_context_shared_syntax_does_not_block_csharp_patch(case):
    original = "class Move {\n    // broken\n}\n"
    (case.source / "move.js").write_text(original)
    context = case.tmp_path / "private.cs"
    context.write_text("class PrivateMove {\n    // PRIVATE_GAME_LOGIC_501\n}\n")
    case.config["context"] = [str(context)]
    def runner(cmd, **kwargs):
        return SimpleNamespace(returncode=0, stdout="", stderr="")
    result = case.execute(Client(["NO"]), tries=1, build_runner=runner)
    assert result["result"] == "fixed"
    diff = (case.run / "fix-any-0.diff").read_text()
    assert "[private context]" not in diff
    assert "PRIVATE_GAME_LOGIC_501" not in json.dumps(result)


def test_report_requires_repeatable_or_confirmed(case):
    (case.run / "confirm.json").write_text("[]")
    with pytest.raises(ValueError, match="confirmed|repeatable"):
        case.execute(Client(["NO"]), tries=1)


def test_input_refused_report_cannot_be_fixed(case):
    from pt.fix_any import _inputs
    rows = json.loads((case.run / "confirm.json").read_text())
    rows[0].update({"confirmed": False, "status": "input refused in replay", "reproducible": True})
    (case.run / "confirm.json").write_text(json.dumps(rows))
    case.path.write_text(json.dumps(case.config))
    with pytest.raises(ValueError, match="confirmed|repeatable"):
        _inputs(case.run, case.path, 0, 1)


def test_empty_checks_rejected(case):
    case.config["checks"] = []
    with pytest.raises(ValueError, match="at least one"):
        case.execute(Client(["NO"]), tries=1)


def test_blank_last_replay_frame_cannot_pass(case):
    class Blank(case.Driver):
        def screenshot(self):
            stream = io.BytesIO()
            Image.new("RGB", (8, 8), "black").save(stream, "JPEG")
            return stream.getvalue()
    result = case.execute(Client(["NO"]), tries=1, driver_factory=Blank)
    assert result["result"] == "not fixed"
    assert "the replay did not reach the report" in result["attempts"][0]["failure"]


def test_json_encoded_context_marker_is_redacted(case, capsys):
    marker = 'private "é" marker'
    context = case.tmp_path / "private.txt"
    context.write_text(marker, encoding="utf-8")
    case.config["context"] = [str(context)]
    client = Client(["NO"])
    client.patch["why"] = marker
    def runner(cmd, **kwargs):
        return SimpleNamespace(returncode=1, stdout=json.dumps(marker), stderr="")
    case.execute(client, tries=1, build_runner=runner)
    contents = (case.run / "fix-any-0.json").read_text(encoding="utf-8")
    assert marker not in contents and json.dumps(marker, ensure_ascii=True)[1:-1] not in contents
    output = capsys.readouterr()
    assert marker not in output.out + output.err


def test_bom_and_trimmed_context_lines_redacted(case):
    marker = "PRIVATE_LINE_MARKER_123_WITH_ENOUGH_LENGTH_TO_REMAIN_PRIVATE"
    context = case.tmp_path / "private.txt"
    context.write_text("\ufeff" + marker + "   \n", encoding="utf-8")
    case.config["context"] = [str(context)]
    def runner(cmd, **kwargs):
        return SimpleNamespace(returncode=1, stdout=marker, stderr="")
    case.execute(Client([]), tries=1, build_runner=runner)
    assert marker not in (case.run / "fix-any-0.json").read_text(encoding="utf-8")


def test_timeout_is_failed_and_row_saved(case):
    case.config["build_timeout_s"] = 1
    def runner(cmd, **kwargs):
        raise __import__("subprocess").TimeoutExpired(cmd, kwargs.get("timeout"))
    result = case.execute(Client([]), tries=1, build_runner=runner)
    assert result["result"] == "build failed"
    assert "timed out" in result["attempts"][0]["failure"].lower()
    assert (case.run / "fix-any-0.json").is_file()


def test_judge_exception_cost_comes_from_ledger(case):
    class Ledger:
        amount = 0
        def spent(self): return self.amount
    class Costly(Client):
        ledger = Ledger()
        def responses(self, *args, **kwargs):
            self.ledger.amount += .07
            raise RuntimeError("judge failed")
    result = case.execute(Costly([]), tries=1)
    assert result["attempts"][0]["cost_usd"] == pytest.approx(.07)


def test_replay_settle_wait_is_added_to_copied_last_row(case, monkeypatch):
    from pt import replay
    original = json.loads((case.run / "result.json").read_text())["actions_by_step"]
    calls = []
    real = replay.replay_trace
    def capture(actions, *args, **kwargs):
        calls.append(actions)
        return real(actions, *args, **kwargs)
    monkeypatch.setattr(replay, "replay_trace", capture)
    case.config["replay_settle_ms"] = 1250
    result = case.execute(Client(["NO"]), tries=1)
    expected = [[{"type": "click", "x": 1, "y": 2}, {"type": "wait", "ms": 1250}]]
    assert result["result"] == "fixed"
    assert calls and calls[0] == expected
    assert calls[0] is not original
    assert json.loads((case.run / "result.json").read_text())["actions_by_step"] == original
    assert result["attempts"][0]["replay_settle_ms"] == 1250


def test_replay_settle_absent_passes_saved_actions(case, monkeypatch):
    from pt import fix_any, replay
    original = json.loads((case.run / "result.json").read_text())["actions_by_step"]
    read = fix_any._read
    saved = {}
    def capture_read(path):
        value = read(path)
        if Path(path).name == "result.json":
            saved["actions"] = value["actions_by_step"]
        return value
    monkeypatch.setattr(fix_any, "_read", capture_read)
    calls = []
    real = replay.replay_trace
    def capture(actions, *args, **kwargs):
        calls.append(actions)
        return real(actions, *args, **kwargs)
    monkeypatch.setattr(replay, "replay_trace", capture)
    case.execute(Client(["NO"]), tries=1)
    assert calls and calls[0] is saved["actions"]
    assert calls[0] == original


@pytest.mark.parametrize("value", [True, False, -1, 1.5, "5", None])
def test_bad_replay_settle_stops_before_driver(case, value):
    case.config["replay_settle_ms"] = value
    with pytest.raises(ValueError, match="replay_settle_ms"):
        case.execute(Client(["NO"]), tries=1)
    assert not case.made


@pytest.mark.parametrize("change", [
    {"confirmed": False, "status": "rejected"}, {"status": "not compared"},
    {"reproducible": None}, {"reproducible": False}, {"title": "Other"}, {"step": 0},
])
def test_selected_report_needs_its_own_matching_confirmation(case, change):
    good = {"title": "Bad move", "step": 1, "confirmed": True,
            "status": "confirmed", "reproducible": True}
    (case.run / "confirm.json").write_text(json.dumps([{**good, **change}, good]))
    with pytest.raises(ValueError, match="Report must be confirmed or repeatable before fix-any"):
        case.execute(Client(["NO"]), tries=1)
    assert not case.made and not case.commands


@pytest.mark.parametrize("rows", [[], [{"title": "Other", "step": 1, "confirmed": True}]])
def test_confirmation_row_must_exist_at_selected_index(case, rows):
    (case.run / "confirm.json").write_text(json.dumps(rows))
    with pytest.raises(ValueError, match="Report must be confirmed or repeatable before fix-any"):
        case.execute(Client(["NO"]), tries=1)


@pytest.mark.parametrize("evidence", ["", "   ", "The piece moves correctly after the trigger"])
def test_repair_needs_no_with_nonblank_evidence(case, evidence):
    class Evidence(Client):
        def responses(self, *args, **kwargs):
            return {"output_text": json.dumps({"verdict": "NO", "evidence": evidence}), "_cost_usd": .01}
    result = case.execute(Evidence([]), tries=1)
    assert (result["result"] == "fixed") is bool(evidence.strip())
    if not evidence.strip():
        assert result["attempts"][0]["failure"] == "Bug remains or judge gave no NO verdict: no evidence"
        assert result["attempts"][0]["checks"] == []


def test_missing_trigger_still_fails_repair(case):
    class Missing(Client):
        def responses(self, *args, **kwargs):
            return {"output_text": json.dumps({"verdict": "YES", "evidence": "The trigger never appears"}), "_cost_usd": .01}
    result = case.execute(Missing([]), tries=1)
    assert result["result"] == "not fixed" and not result["attempts"][0]["checks"]
