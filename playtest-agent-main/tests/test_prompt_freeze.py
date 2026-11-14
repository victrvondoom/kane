"""The agent prompt and every player and judge setting stay frozen from the day the holdout game was written until the holdout
bench run. The game's author (this build session) had seen the prompt, so the prompt must not move toward the game after it.
If a change is truly needed, run the holdout bench first (docs/HANDOFF.md), then write a new freeze."""
import json

from tools import prompt_freeze as F


def test_the_prompt_and_settings_match_the_freeze():
    frozen = json.loads(F.FREEZE.read_text(encoding="utf-8"))["hashes"]
    now = F.snapshot()
    changed = sorted(k for k in frozen if now.get(k) != frozen[k]) + sorted(k for k in now if k not in frozen)
    assert not changed, ("FROZEN until the holdout bench run: " + ", ".join(changed)
                         + ". Run the holdout bench first (docs/HANDOFF.md), then python -m tools.prompt_freeze write.")


def test_the_snapshot_sees_a_changed_prompt(monkeypatch):
    from pt import loop
    before = F.snapshot()
    monkeypatch.setattr(loop, "SYSTEM", loop.SYSTEM + " Look harder.")
    after = F.snapshot()
    assert [k for k in before if before[k] != after[k]] == ["loop.SYSTEM"]


def test_the_snapshot_sees_a_changed_default(monkeypatch):
    from pt import cli
    real = cli.parse
    monkeypatch.setattr(cli, "parse", lambda argv: (lambda a: (setattr(a, "effort", "high"), a)[1])(real(argv)))
    assert F.snapshot()["cli.hunt_defaults"] != json.loads(F.FREEZE.read_text(encoding="utf-8"))["hashes"]["cli.hunt_defaults"]


def test_write_keeps_prior_freezes_in_history(tmp_path, monkeypatch):
    path = tmp_path / "freeze.json"
    path.write_text(json.dumps({"why": "old", "written": "date1", "commit": "abc", "hashes": {"x": "1"}}))
    monkeypatch.setattr(F, "snapshot", lambda: {"x": "2"})
    F.write("reason one", path)
    first = json.loads(path.read_text())
    assert first["hashes"] == {"x": "2"}
    assert first["history"] == [{"why": "old", "written": "date1", "commit": "abc", "hashes": {"x": "1"}, "replaced_because": "reason one"}]
    F.write("reason two", path)
    second = json.loads(path.read_text())
    assert [entry["replaced_because"] for entry in second["history"]] == ["reason one", "reason two"]
    assert [entry["commit"] for entry in second["history"]] == ["abc", first["commit"]]
