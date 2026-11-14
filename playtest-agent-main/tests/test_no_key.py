import contextlib
import io

import pytest


PAID_COMMANDS = [
    ["goal", "nk-goal"],
    ["hunt", "nk-hunt"],
    ["resume", "nk-resume", "--note", "continue"],
    ["confirm", "some-run"],
    ["issues", "out", "run-one"],
    ["regress", "some-run", "--bugs", "1"],
    ["fix", "some-run", "--goal-run", "goal"],
    ["fix-verify", "some-run", "--goal-run", "goal", "--report", "1", "--try", "1", "--name", "check"],
    ["diary", "some-run"],
    ["duo", "nk-duo"],
    ["challenge", "some-run", "--name", "nk-challenge"],
    ["hostile-judge", "nk-hostile", "--path-run", "some-run"],
    ["contract-draft", "nk-contract", "--rule", "rule", "--keys-from", "some-run"],
    ["exploit-search", "nk-exploit", "--game", "shop-fixture"],
    ["fix-any", "some-run", "--report", "0", "--fix-config", "fix.json"],
    ["replay-check", "some-run"],
]

PAID_NAMES = {"goal", "hunt", "resume", "confirm", "issues", "regress", "fix", "fix-verify",
              "diary", "duo", "challenge", "hostile-judge",
              "contract-draft", "exploit-search", "fix-any", "replay-check"}
FREE_NAMES = {"verify", "report", "console", "signoff", "contrast", "issues-accept", "issues-split",
              "gate", "deathmap", "guard", "persist", "hostile-score", "contract-approve", "contract-check",
              "exploit-rule", "exploit-approve", "reduce", "goal-clean", "goal-buggy"}


def _subcommand_names(monkeypatch):
    import argparse
    original = argparse.ArgumentParser.add_subparsers
    captured = []

    def capture(self, *args, **kwargs):
        value = original(self, *args, **kwargs)
        captured.append(value)
        return value

    monkeypatch.setattr(argparse.ArgumentParser, "add_subparsers", capture)
    from pt import cli
    cli.parse(["guard"])
    return set(captured[-1]._name_parser_map)


def test_every_subcommand_is_sorted_paid_or_free(monkeypatch):
    names = _subcommand_names(monkeypatch)
    assert names == PAID_NAMES | FREE_NAMES


@pytest.mark.parametrize("args", PAID_COMMANDS)
def test_paid_commands_stop_before_side_effects_without_key(monkeypatch, args):
    import pt.cli as cli
    import pt.env

    monkeypatch.delenv("MODEL_API_KEY", raising=False)
    monkeypatch.delenv("PLAYTEST_KEY_FILE", raising=False)
    monkeypatch.setattr(pt.env, "load_local_env", lambda: None)

    calls = []
    monkeypatch.setattr("requests.request", lambda *a, **k: calls.append("request"))
    monkeypatch.setattr("requests.Session.request", lambda *a, **k: calls.append("session"))
    monkeypatch.setattr("metaclient.client.MetaClient._call", lambda *a, **k: calls.append("meta"))
    monkeypatch.setattr("metaclient.ledger.Ledger.reserve", lambda *a, **k: calls.append("reserve"))
    import playwright.sync_api
    monkeypatch.setattr(playwright.sync_api, "sync_playwright", lambda *a, **k: calls.append("browser"))

    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        with pytest.raises(SystemExit) as stopped:
            cli.main(args)
    assert stopped.value.code == 2
    assert err.getvalue().splitlines() == ["no API key: set MODEL_API_KEY (or PLAYTEST_KEY_FILE). Nothing was spent."]
    assert calls == []


def test_free_paid_shaped_cases_do_not_take_no_key_exit(monkeypatch, tmp_path):
    import pt.cli as cli
    import pt.env
    import pt.issues
    import pt.fix_verify

    monkeypatch.delenv("MODEL_API_KEY", raising=False)
    monkeypatch.delenv("PLAYTEST_KEY_FILE", raising=False)
    monkeypatch.setattr(pt.env, "load_local_env", lambda: None)
    monkeypatch.setattr(pt.issues, "collect", lambda runs: ([], []))
    monkeypatch.setattr(pt.issues, "propose", lambda *a, **k: ([], 0))
    monkeypatch.setattr(pt.issues, "write", lambda *a, **k: "written")
    monkeypatch.setattr(pt.fix_verify, "run_cli", lambda a: 17)
    assert cli.main(["issues", str(tmp_path / "out"), "run-one", "--no-model"]) == 0
    assert cli.main(["fix-verify", "some-run", "--goal-run", "goal", "--report", "1", "--try", "1",
                     "--name", "check", "--dry"]) == 17


def test_local_offline_goal_does_not_take_no_key_exit(monkeypatch):
    import pt.cli as cli
    import pt.env

    monkeypatch.delenv("MODEL_API_KEY", raising=False)
    monkeypatch.delenv("PLAYTEST_KEY_FILE", raising=False)
    monkeypatch.setattr(pt.env, "load_local_env", lambda: None)
    monkeypatch.setattr("pt.guard.problems", lambda *a, **k: ["held"])
    assert cli.main(["goal", "local", "--model", "glimmer-local", "--offline"]) == 1
