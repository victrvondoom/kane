"""The playtest diary: one Spark call turns a run's own logged lines into a first person diary, each line tied to a step."""
import json

from pt import diary


def run_result():
    return {"steps": 3, "kind": "hunt", "game": "Cave Courier",
            "log": [
                {"step": 0, "text": "", "calls": [{"name": "act", "args": {"look": "A cave with a key on the left.", "plan": "Walk left to the key.", "actions": []}}]},
                {"step": 1, "text": "", "thinking": "The key is close.", "calls": [{"name": "act", "args": {"look": "I hold the key now.", "plan": "Go right to the big door.", "actions": []}}]},
                {"step": 2, "text": "The coin counter went up by two.", "calls": [{"name": "report_bug", "args": {"title": "Coin counts double"}}]},
            ],
            "reports": [{"title": "Coin counts double", "expected": "1 coin", "actual": "2 coins", "step": 2}],
            "checklist": [{"text": "Open the door", "done": True, "evidence": "The door slid up.", "step": 1}]}


class FakeClient:
    def __init__(self, text):
        self.text, self.calls = text, []

    def responses(self, inp, model=None, max_output_tokens=0, label="", reserve_usd=0, extra=None):
        self.calls.append({"inp": inp, "label": label, "reserve_usd": reserve_usd})
        return {"output": [{"type": "message", "content": [{"type": "output_text", "text": self.text}]}], "_cost_usd": 0.012}


def answer(lines):
    return json.dumps({"lines": lines})


def test_lines_are_the_runs_own_and_in_step_order():
    lines = diary.run_lines(run_result())
    assert [x["step"] for x in lines] == sorted(x["step"] for x in lines)
    texts = " ".join(x["text"] for x in lines)
    for own in ("A cave with a key on the left.", "Go right to the big door.", "The key is close.", "Coin counts double", "The door slid up."):
        assert own in texts


def test_the_prompt_holds_only_the_runs_lines():
    lines = diary.run_lines(run_result())
    text = diary.prompt(lines)
    for x in lines:
        assert x["text"] in text
    assert text.index("A cave with a key") < text.index("I hold the key now") < text.index("Coin counts double")


def test_a_line_about_a_step_that_does_not_exist_is_rejected():
    lines = diary.run_lines(run_result())
    kept, rejected = diary.check([{"step": 1, "text": "I took the key."}, {"step": 9, "text": "I beat the boss."}], lines)
    assert [x["step"] for x in kept] == [1]
    assert rejected[0]["line"]["step"] == 9 and "step" in rejected[0]["why"]


def test_a_quote_must_be_in_that_steps_own_lines():
    lines = diary.run_lines(run_result())
    kept, rejected = diary.check([{"step": 1, "text": "I saw it.", "quote": "I hold the key now"},
                                  {"step": 1, "text": "I saw it.", "quote": "a dragon"},
                                  {"step": 0, "text": "Wrong step.", "quote": "I hold the key now"}], lines)
    assert len(kept) == 1 and len(rejected) == 2


def test_write_saves_json_and_markdown_with_frame_links(tmp_path):
    (tmp_path / "result.json").write_text(json.dumps(run_result()), encoding="utf-8")
    client = FakeClient(answer([{"step": 0, "text": "I walked to the key."}, {"step": 7, "text": "Made up."}]))
    out = diary.write(tmp_path, client)
    data = json.loads((tmp_path / "diary.json").read_text(encoding="utf-8"))
    assert out == tmp_path / "diary.json"
    assert [x["step"] for x in data["lines"]] == [0] and data["rejected_count"] == 1 and data["cost_usd"] == 0.012
    md = (tmp_path / "diary.md").read_text(encoding="utf-8")
    assert "I walked to the key." in md and "s000.jpg" in md and "Made up." not in md


def test_the_call_is_labelled_with_the_run_name_and_reserves_spend(tmp_path):
    run = tmp_path / "h12"
    run.mkdir()
    (run / "result.json").write_text(json.dumps(run_result()), encoding="utf-8")
    client = FakeClient(answer([]))
    diary.write(run, client)
    assert len(client.calls) == 1
    assert "h12" in client.calls[0]["label"].split(":") and client.calls[0]["reserve_usd"] > 0


def test_an_answer_that_is_not_json_keeps_no_lines(tmp_path):
    (tmp_path / "result.json").write_text(json.dumps(run_result()), encoding="utf-8")
    diary.write(tmp_path, FakeClient("Sorry, here is a diary in prose."))
    data = json.loads((tmp_path / "diary.json").read_text(encoding="utf-8"))
    assert data["lines"] == [] and data["parse_error"]


def test_the_report_page_and_console_show_the_diary(tmp_path):
    from pt import console, report
    (tmp_path / "result.json").write_text(json.dumps(run_result()), encoding="utf-8")
    diary.write(tmp_path, FakeClient(answer([{"step": 1, "text": "I opened the big door."}])))
    assert "I opened the big door." in report.build(tmp_path)
    assert "I opened the big door." in console.build(tmp_path)


def test_cli_diary_writes_the_diary(tmp_path, monkeypatch):
    from pt import cli
    import trials.common
    (tmp_path / "result.json").write_text(json.dumps(run_result()), encoding="utf-8")
    monkeypatch.setattr(trials.common, "load_client", lambda repo: FakeClient(answer([{"step": 0, "text": "I looked around."}])))
    assert cli.main(["diary", str(tmp_path)]) == 0
    assert json.loads((tmp_path / "diary.json").read_text(encoding="utf-8"))["lines"][0]["text"] == "I looked around."
