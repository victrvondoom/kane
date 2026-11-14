import pytest

from pt import cli, goal_buggy, goal_clean, reduce


def _no_key(monkeypatch):
    from pt import env

    def fail():
        raise RuntimeError("API key required")

    monkeypatch.setattr(env, "require_api_key", fail)
    monkeypatch.setattr(goal_clean, "run_cli", lambda args, root: 0)
    monkeypatch.setattr(goal_buggy, "run_cli", lambda args, root: 0)
    monkeypatch.setattr(reduce, "run_cli", lambda args, root: 0)


def test_goal_clean_does_not_require_key(monkeypatch):
    _no_key(monkeypatch)
    assert cli.main(["goal-clean", "r", "--goal-run", "g", "--name", "n"]) == 0


def test_goal_buggy_does_not_require_key(monkeypatch):
    _no_key(monkeypatch)
    assert cli.main(["goal-buggy", "r", "--goal-run", "g", "--targets", "0=1", "--targets-source", "s", "--name", "n"]) == 0


def test_reduce_without_judge_does_not_require_key(monkeypatch):
    _no_key(monkeypatch)
    assert cli.main(["reduce", "r", "--name", "n"]) == 0


def test_reduce_with_judge_requires_key(monkeypatch):
    _no_key(monkeypatch)
    with pytest.raises(RuntimeError, match="API key required"):
        cli.main(["reduce", "r", "--name", "n", "--judge"])


def test_hunt_requires_key(monkeypatch):
    _no_key(monkeypatch)
    with pytest.raises(RuntimeError, match="API key required"):
        cli.main(["hunt", "x"])


def test_regress_requires_key(monkeypatch):
    _no_key(monkeypatch)
    with pytest.raises(RuntimeError, match="API key required"):
        cli.main(["regress", "r", "--bugs", "1"])
