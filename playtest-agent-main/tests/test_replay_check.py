import io
import json

import pytest
from PIL import Image


class FakeClient:
    def __init__(self, verdicts):
        self.verdicts = iter(verdicts)
        self.calls = []

    def responses(self, inputs, **kwargs):
        self.calls.append((inputs, kwargs))
        return {"output_text": json.dumps({"verdict": next(self.verdicts),
                                           "evidence": "The final frames show the symptom."}),
                "_cost_usd": 0.01}


@pytest.fixture
def case(tmp_path):
    picture = io.BytesIO()
    Image.new("RGB", (16, 16)).save(picture, "JPEG")
    saved = {"game_id": "fake", "bugs_on": "", "actions_by_step": [
        [{"type": "wait", "ms": 1}], [{"type": "wait", "ms": 2}]],
        "reports": [{"title": "Missing effect", "expected": "effect", "actual": "none", "step": 1},
                    {"title": "Second report", "step": 2}]}
    (tmp_path / "result.json").write_text(json.dumps(saved), encoding="utf-8")
    drivers, events = [], []

    class Driver:
        def __init__(self, bugs=""):
            assert all(d.closed for d in drivers)
            self.closed, self.actions = False, []
            self.number = len(drivers) + 1
            drivers.append(self)
            events.append(("open", self.number))

        def screenshot(self):
            return picture.getvalue()

        def state(self):
            return None

        def execute(self, actions):
            self.actions.append(actions)

        def close(self):
            self.closed = True
            events.append(("close", self.number))

    return tmp_path, Driver, drivers, events


@pytest.mark.parametrize("verdicts,result", [(["YES", "YES"], "repeatable"),
                                                (["YES", "NO"], "seen once"),
                                                (["NO", "NO"], "not repeated")])
def test_two_judged_replays(case, verdicts, result):
    from pt.replay_check import check_run
    folder, driver, drivers, events = case
    client = FakeClient(verdicts)
    summary = check_run(folder, client, driver_cls=driver, report=0)
    row = summary["reports"][0]
    assert row["result"] == result
    assert [t["verdict"] for t in row["tries"]] == verdicts
    assert all(t["reason"] for t in row["tries"])
    assert summary["cost_usd"] == pytest.approx(0.02)
    assert all("replay-check" in call[1]["label"] for call in client.calls)
    assert json.loads((folder / "replay-check/summary.json").read_text()) == summary
    for k in (1, 2):
        output = folder / f"replay-check/report-0/try-{k}"
        assert (output / "f00.jpg").is_file()
        assert (output / "strip.jpg").is_file()
        assert json.loads((output / "actions.json").read_text()) == drivers[k - 1].actions
        assert json.loads((output / "verdict.json").read_text())["verdict"] == verdicts[k - 1]


def test_no_state_is_not_proof(case):
    from pt.replay_check import check_run
    folder, driver, _, _ = case
    row = check_run(folder, FakeClient(["NO", "NO"]), driver_cls=driver, report=0)["reports"][0]
    assert row["result"] != "repeatable"


def test_second_replay_error_closes_driver(case):
    from pt.replay_check import check_run
    folder, driver, drivers, _ = case

    class Broken(driver):
        def execute(self, actions):
            if self.number == 2:
                raise RuntimeError("second replay broke")
            super().execute(actions)

    client = FakeClient(["YES"])
    row = check_run(folder, client, driver_cls=Broken, report=0)["reports"][0]
    assert row["result"] == "replay failed"
    assert row["tries"][1]["verdict"] is None
    assert "second replay broke" in row["tries"][1]["error"]
    assert all(d.closed for d in drivers)
    assert len(client.calls) == 1
    assert (folder / "replay-check/report-0/try-2/f00.jpg").is_file()


def test_report_flag_selects_only_one_report(case):
    from pt.cli import parse
    from pt.replay_check import check_run
    folder, driver, drivers, _ = case
    args = parse(["replay-check", str(folder), "--report", "1", "--times", "2"])
    result = check_run(args.folder, FakeClient(["YES", "YES"]), driver_cls=driver,
                       report=args.report, times=args.times)
    assert [r["index"] for r in result["reports"]] == [1]
    assert all(len(d.actions) == 2 for d in drivers)
    assert not (folder / "replay-check/report-0").exists()


def test_new_driver_after_previous_closed(case):
    from pt.replay_check import check_run
    folder, driver, drivers, events = case
    check_run(folder, FakeClient(["YES"] * 4), driver_cls=driver)
    assert len(drivers) == 4
    assert events == [(action, n) for n in range(1, 5) for action in ("open", "close")]


def test_money_stop_before_network(case, monkeypatch):
    from metaclient.client import MetaClient
    from metaclient.ledger import Ledger
    from pt.replay_check import check_run
    folder, driver, drivers, _ = case
    monkeypatch.setenv("PLAYTEST_CAP_USD", "0")

    class Http:
        def send(self, *args, **kwargs):
            pytest.fail("network must never be reached")

    client = MetaClient("fake", Ledger(folder / "ledger.jsonl"), http=Http())
    summary = check_run(folder, client, driver_cls=driver)
    assert "CapReached" in summary["stop"]
    assert summary["reports"][0]["tries"][0]["verdict"] is None
    assert len(drivers) == 1 and drivers[0].closed


def test_failed_call_cost_is_kept(case, monkeypatch):
    from metaclient.client import MetaClient
    from metaclient.ledger import Ledger
    from pt.replay_check import check_run
    folder, driver, _, _ = case
    monkeypatch.setenv("PLAYTEST_CAP_USD", "1")

    class Http:
        def send(self, *args, **kwargs):
            raise RuntimeError("fake transport failed")

    ledger = Ledger(folder / "ledger.jsonl")
    summary = check_run(folder, MetaClient("fake", ledger, http=Http()), driver_cls=driver, report=0)
    assert ledger.spent() == 0.05
    assert summary["cost_usd"] == ledger.spent()
    assert summary["reports"][0]["tries"][0]["cost_usd"] == ledger.spent()


def test_saved_config_is_reused(case, monkeypatch):
    from pt import adapter
    from pt.replay_check import check_run
    folder, driver, _, _ = case
    saved = json.loads((folder / "result.json").read_text())
    config = {"type": "web", "name": "fake", "setup": [{"wait": 1}], "seed_profile": "seed"}
    saved["game_config"] = config
    (folder / "result.json").write_text(json.dumps(saved))
    configs = []

    def fresh(cfg, bugs="", sam_client=None):
        configs.append(json.loads(json.dumps(cfg)))
        cfg["setup"].clear()
        return driver(bugs=bugs)

    monkeypatch.setattr(adapter, "WebAdapter", fresh)
    monkeypatch.setattr(adapter, "load_config", lambda *a: pytest.fail("saved config must win"))
    check_run(folder, FakeClient(["YES", "YES"]), report=0)
    assert configs == [config, config]


@pytest.mark.parametrize("times,report", [(1, None), (0, None), (2, -1), (2, 2)])
def test_invalid_selection_starts_nothing(case, times, report):
    from pt.replay_check import check_run
    folder, driver, drivers, _ = case
    with pytest.raises(ValueError):
        check_run(folder, FakeClient([]), driver_cls=driver, times=times, report=report)
    assert not drivers
    assert not (folder / "replay-check").exists()
