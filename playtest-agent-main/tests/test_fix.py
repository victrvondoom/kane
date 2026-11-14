"""Fix lane tests use only fake clients and drivers."""
import difflib
import io
import json
import re
from pathlib import Path

import pytest
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


def test_apply_edits_two_ordered_edits_and_crlf():
    from pt.fix_patch import apply_edits
    assert apply_edits("one\ntwo\n", [
        {"search": "one\r\n", "replace": "three\r\n"},
        {"search": "three\ntwo\n", "replace": "done\n"},
    ]) == "done\n"


@pytest.mark.parametrize("source,edits,error", [
    ("one", [{"search": "two", "replace": "three"}], "Search text not found"),
    ("one one", [{"search": "one", "replace": "two"}], "Search text is not unique"),
    ("one", [], "No edits"),
    ("one", [{"search": "one", "replace": "one"}], "Edit changes nothing"),
    ("one", [{"search": "", "replace": "two"}], "Search text not found"),
])
def test_apply_edits_rejects_invalid_changes(source, edits, error):
    from pt.fix_patch import apply_edits
    with pytest.raises(ValueError, match=error):
        apply_edits(source, edits)


@pytest.mark.parametrize("kind", ["edits", "diff", "neither"])
def test_patch_formats(tmp_path, kind):
    from pt.fix import FORMAT, fix_run
    run, goal, source = setup_run(tmp_path)
    class Proposal(Client):
        def wonder(self, body, **kw):
            self.proposals.append((body, kw))
            proposal = {"why": "Repair the door.", "edits": [], "diff": ""}
            if kind == "edits":
                proposal["edits"] = [{"search": "broken\n", "replace": "fixed\n"}]
                proposal["diff"] = "ignored invalid diff"
            elif kind == "diff":
                proposal["diff"] = patch(SOURCE, SOURCE.replace("broken", "fixed"))
            return {"output_text": json.dumps(proposal), "_cost_usd": .02}
    client = Proposal([], ["GONE"])
    result = fix_run(run, client, goal, source_path=source, max_tries=1,
                     driver_factory=lambda path, bugs="": Driver(path, []))
    row = result["reports"][0]
    if kind == "neither":
        assert row["failure"] == "Patch rejected: no edits and no diff"
        assert not row["applied"] and not client.judges
    else:
        assert row["applied"] and row["proved"]
        assert row["patch_format"] == kind
        saved = json.loads((run / "fixes/0/attempts/1/verdict.json").read_text())
        assert saved["patch_format"] == kind
        assert row["attempts"][0]["patch_format"] == kind
    schema = FORMAT["schema"]
    assert set(schema["required"]) == {"edits", "diff", "why"}
    item = schema["properties"]["edits"]["items"]
    assert item == {"type": "object", "properties": {
        "search": {"type": "string"}, "replace": {"type": "string"}},
        "required": ["search", "replace"], "additionalProperties": False}
    prompt = client.proposals[0][0]["input"][0]["content"][0]["text"]
    assert "copied exactly" in prompt and "whole lines" in prompt


def test_shed_hook_measures_open_door_collision():
    from game.build_buggy import hook_anchors, instrument
    view = (ROOT / "game/index-buggy-view.html").read_text(encoding="utf-8")
    anchor = "    for (const s of S) if (overlap(box, s)) { box.x = st.vx > 0 ? s.x - W : s.x + s.w; }"
    hook = "    for (const s of S) if (s.door === 1 && st.shedOpen && overlap(box, s)) window.__bugHit[1] = true;"
    assert view.splitlines().count(anchor) == 1
    served = instrument(view)
    assert served.splitlines().count(hook) == 1
    assert hook + "\n" + anchor in served
    opened = next(line for line in served.splitlines() if "The shed door opens." in line)
    assert "__bugHit[1] = true" not in opened
    assert 1 in hook_anchors(view)
    door = "    s.push({x: 58, y: 50, w: 6, h: 200, door: 1});"
    assert view.splitlines().count(door) == 1
    fixed = view.replace(door, "    if (!st.shedOpen) s.push({x: 58, y: 50, w: 6, h: 200, door: 1});")
    assert 1 in hook_anchors(fixed)


def test_boots_hook_measures_only_a_purchase_that_leaves_boots_missing():
    from game.build_buggy import instrument
    view = (ROOT / "game/index-buggy-view.html").read_text(encoding="utf-8")
    hook = next(line for line in instrument(view).splitlines() if "__bugHit[3]" in line)
    assert "if (!st.boots)" in hook


def test_floor_hook_tolerates_removed_options_declaration():
    from game.build_buggy import instrument
    view = (ROOT / "game/index-buggy-view.html").read_text(encoding="utf-8")
    view = view.replace(
        "  const OPTIONS = new Set((q.get('b' + 'ugs') || '').split(',').filter(Boolean).map(Number).filter(n => n === 6));\n",
        "",
    )
    assert "const OPTIONS =" not in view
    served = instrument(view)
    hook = next(line for line in served.splitlines() if "__bugHit[6] = true" in line)
    assert "typeof OPTIONS !== 'undefined'" in hook


@pytest.mark.skipif(__import__("os").environ.get("PT_BROWSER_TESTS") != "1", reason="requires explicit browser opt in")
def test_floor_hook_runs_without_options_declaration(tmp_path):
    from game.build_buggy import instrument
    from playwright.sync_api import sync_playwright
    view = (ROOT / "game/index-buggy-view.html").read_text(encoding="utf-8")
    view = view.replace(
        "  const OPTIONS = new Set((q.get('b' + 'ugs') || '').split(',').filter(Boolean).map(Number).filter(n => n === 6));\n",
        "",
    ).replace("    if (OPTIONS.has(6)) s[0] = {x: 0, y: GROUND, w: 80, h: 110};\n", "")
    assert "OPTIONS" not in view
    page_path = tmp_path / "patched.html"
    page_path.write_text(instrument(view), encoding="utf-8", newline="\n")
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        page = browser.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(page_path.as_uri())
        page.wait_for_timeout(30 * 16)
        hits = page.evaluate("window.__bugHit[6]")
        browser.close()
    assert errors == []
    assert hits is False


def test_bake_keeps_clean_source_and_hook_keys(tmp_path):
    from game.build_buggy import bake, build, instrument
    clean = ROOT / "game/index.html"
    before = clean.read_bytes()
    target = tmp_path / "index-buggy.html"
    build(clean, target)
    source = target.read_text(encoding="utf-8")
    assert source == instrument(bake(clean.read_text(encoding="utf-8")))
    assert not re.search(r"BUGS\.has\([1-5]\)", source)
    for n in range(1, 6):
        assert f"{n}: false" in source and f"window.__bugHit[{n}] = true" in source
    assert "OPTIONS.has(6)" in source
    assert ".filter(n => n === 6)" in source
    assert clean.read_bytes() == before
    assert (ROOT / "game/index-buggy.html").read_text(encoding="utf-8") == source
    cfg = json.loads((ROOT / "games/cave-courier-buggy.json").read_text())
    assert cfg["url"] == "game/index-buggy.html"


def patch(old, new, name="index-buggy-view.html"):
    return "".join(difflib.unified_diff(old.splitlines(True), new.splitlines(True),
                                         fromfile="a/" + name, tofile="b/" + name))


@pytest.mark.parametrize("name", ["other.html", "game/index.html", "../index-buggy-view.html", "/index-buggy-view.html", "C:/index-buggy-view.html", "index-buggy.html"])
def test_path_guard(name):
    from pt.fix_patch import apply_diff
    with pytest.raises(ValueError, match="path"):
        apply_diff("old\n", patch("old\n", "new\n", name))


def test_unapplied_and_multiple_file_diff_rejected():
    from pt.fix_patch import apply_diff
    with pytest.raises(ValueError):
        apply_diff("old\n", patch("missing\n", "new\n"))
    diff = patch("old\n", "new\n")
    with pytest.raises(ValueError):
        apply_diff("old\n", diff + diff)
    assert apply_diff("old\n", diff) == "new\n"


SOURCE = """(() => {
  const q = new URLSearchParams(location.search);
    if (Math.abs(st.x - 61) < 24 && !st.shedOpen) { st.shedOpen = true; say('The shed door opens.'); return; }
    for (const s of S) if (overlap(box, s)) { box.x = st.vx > 0 ? s.x - W : s.x + s.w; }
    st.x = box.x + W / 2;
broken
goal ok
})();
"""


class Client:
    def __init__(self, diffs, answers):
        self.diffs, self.answers = iter(diffs), iter(answers)
        self.proposals, self.judges = [], []

    def wonder(self, body, **kw):
        self.proposals.append((body, kw))
        return {"output_text": json.dumps({"edits": [], "diff": next(self.diffs), "why": "Repair the door."}), "_cost_usd": .02}

    def responses(self, inp, **kw):
        self.judges.append(inp)
        return {"output_text": json.dumps({"verdict": next(self.answers), "evidence": "NEW frame: the door is open."}), "_cost_usd": .01}


class Driver:
    def __init__(self, path, made):
        self.source, self.n, self.closed = Path(path).read_text(), 0, False
        made.append(self)

    def execute(self, acts): self.n += 1
    def state(self): return {"x": self.n, "doorOpen": "broken" not in self.source}
    def won(self): return self.n >= 2 and "goal ok" in self.source
    def bug_hits(self):
        return {str(n): (n == 1 and "window.__bugHit[1] = true;" in self.source and "broken" in self.source) for n in range(1, 7)}
    def screenshot(self):
        buf = io.BytesIO()
        Image.new("RGB", (64, 36), "blue").save(buf, "JPEG")
        return buf.getvalue()
    def close(self): self.closed = True


def setup_run(tmp_path):
    run = tmp_path / "run"
    run.mkdir()
    rep = {"title": "Shed stays solid", "expected": "Walk through", "actual": "Blocked", "step": 2,
           "confirmed": True, "status": "confirmed", "evidence": "OLD quote: door blocks the player"}
    (run / "confirm.json").write_text(json.dumps([rep]))
    (run / "result.json").write_text(json.dumps({"kind": "hunt", "game_id": "cave-courier-buggy", "bugs_on": "", "actions_by_step": [[], []]}))
    goal = tmp_path / "goal"
    goal.mkdir()
    (goal / "result.json").write_text(json.dumps({"kind": "goal", "game_id": "cave-courier", "bugs_on": "", "won": True, "actions_by_step": [[], []]}))
    source = tmp_path / "index-buggy-view.html"
    source.write_text(SOURCE)
    return run, goal, source


def execute(tmp_path, diffs, answers, max_tries=1):
    from pt.fix import fix_run
    run, goal, source = setup_run(tmp_path)
    made = []
    client = Client(diffs, answers)
    result = fix_run(run, client, goal, source_path=source, max_tries=max_tries,
                     driver_factory=lambda path, bugs="": Driver(path, made))
    assert source.read_text() == SOURCE
    assert all(d.closed for d in made)
    return run, result, client


def test_incomplete_fix_response_reports_reasoning_tokens_without_parsing(tmp_path):
    from pt.fix import fix_run
    run, goal, source = setup_run(tmp_path)
    class Incomplete(Client):
        def wonder(self, body, **kw):
            return {"status": "incomplete", "output": [], "usage": {
                "output_tokens": 16000, "output_tokens_details": {"reasoning_tokens": 15998}},
                "_cost_usd": .1}
    result = fix_run(run, Incomplete([], []), goal, max_tries=1, source_path=source,
                     driver_factory=lambda path, bugs="": Driver(path, []))
    row = result["reports"][0]
    assert row["failure"] == "Patch rejected: out of output tokens (15998 reasoning)"
    assert row["applied"] is False


def test_fix_proposal_uses_reasoning_room_and_reserve(tmp_path):
    from pt.fix import FIX_EFFORT, FIX_MAX_OUT, fix_run
    run, goal, source = setup_run(tmp_path)
    client = Client([patch(SOURCE, SOURCE.replace("broken", "fixed"))], ["GONE"])
    fix_run(run, client, goal, source_path=source,
            driver_factory=lambda path, bugs="": Driver(path, []))
    body = client.proposals[0][0]
    assert body["max_output_tokens"] == FIX_MAX_OUT == 16000
    assert body["reasoning"] == {"effort": FIX_EFFORT} == {"effort": "low"}


def test_fixed_judgement_with_live_baseline_hook_is_not_proved(tmp_path):
    from pt.fix import fix_run
    run, goal, source = setup_run(tmp_path)
    class LiveHook(Driver):
        def bug_hits(self):
            hits = super().bug_hits()
            if "fixed" in self.source:
                hits["1"] = True
            return hits
    result = fix_run(run, Client([patch(SOURCE, SOURCE.replace("broken", "fixed"))], ["GONE"]),
                     goal, max_tries=1, source_path=source,
                     driver_factory=lambda path, bugs="": LiveHook(path, []))
    assert result["reports"][0]["proved"] is False


@pytest.mark.parametrize("diff", [patch(SOURCE, SOURCE.replace("broken", "fixed"), "game/index.html"), patch("wrong\n", "new\n")])
def test_rejected_diff_never_reaches_patched_driver(tmp_path, diff):
    run, result, client = execute(tmp_path, [diff], [])
    row = result["reports"][0]
    assert not row["applied"] and not row["proved"]
    assert row["tries"] == 1 and row["cost_usd"] == .02
    assert not client.judges
    assert not (run / "fixes/0/index.html").exists()


def test_goal_loss_is_not_proved(tmp_path):
    diff = patch(SOURCE, SOURCE.replace("broken", "fixed").replace("goal ok", "goal broken"))
    run, result, _ = execute(tmp_path, [diff], ["GONE"])
    row = result["reports"][0]
    assert row["bug_gone"] and not row["goal_won"] and not row["proved"]
    assert result["fixed"] == 0
    assert json.loads((run / "fix.json").read_text()) == result
    from pt.report import build
    assert "Rejected" in build(run)


def test_hook_only_removal_is_not_proved(tmp_path):
    from game.build_buggy import instrument
    served = instrument(SOURCE)
    diff = patch(served, served.replace("window.__bugHit[1] = true;", ""))
    _, result, client = execute(tmp_path, [diff], [])
    row = result["reports"][0]
    assert not row["applied"] and not row["proved"]
    assert not client.judges


def test_retry_failure_text_fresh_source_cost_and_limit(tmp_path):
    broken_goal = patch(SOURCE, SOURCE.replace("broken", "fixed").replace("goal ok", "goal lost"))
    valid = patch(SOURCE, SOURCE.replace("broken", "fixed"))
    run, result, client = execute(tmp_path, [broken_goal, valid], ["GONE", "GONE"], max_tries=2)
    row = result["reports"][0]
    assert row["proved"] and row["tries"] == 2 and row["cost_usd"] == pytest.approx(.06)
    assert result["fixed"] == 1 and result["total"] == 1
    prompt = client.proposals[1][0]["input"][0]["content"][0]["text"]
    assert "goal won before and lost after" in prompt
    assert SOURCE in prompt and "OLD quote:" in prompt and "Blocked" in prompt
    assert client.proposals[0][1]["reserve_usd"] > .02
    assert client.proposals[0][0]["text"]["format"]["type"] == "json_schema"
    assert (run / "fixes/0/patch.diff").read_text() == valid
    assert json.loads((run / "fixes/0/verdict.json").read_text()) == row
    assert (run / "fixes/0/attempts/1/patch.diff").read_text() == broken_goal


def test_retry_stops_at_max_tries(tmp_path):
    invalid = patch("absent\n", "new\n")
    _, result, client = execute(tmp_path, [invalid] * 3, [], max_tries=2)
    assert len(client.proposals) == 2 and result["reports"][0]["tries"] == 2
    assert "does not apply" in client.proposals[1][0]["input"][0]["content"][0]["text"]


def test_default_retries_three_times_and_writes_handoff(tmp_path):
    from pt.fix import fix_run
    run, goal, source = setup_run(tmp_path)
    invalid = patch("absent\n", "new\n")
    client = Client([invalid] * 3, [])
    result = fix_run(run, client, goal, source_path=source,
                     driver_factory=lambda path, bugs="": Driver(path, []))
    handoff = json.loads((run / "fixes/0/needs_human.json").read_text())
    assert len(client.proposals) == 3
    assert handoff == {
        "report_index": 0, "title": "Shed stays solid", "tries": 3,
        "failure": result["reports"][0]["failure"],
        "question": "The fix did not pass its checks after 3 tries. Please look at the bug and the attempts.",
    }
    assert result["needs_human"] == [0]
    from pt.report import build
    assert "Needs a person after 3 tries" in build(run)


def test_proved_report_writes_no_handoff(tmp_path):
    from pt.fix import fix_run
    run, goal, source = setup_run(tmp_path)
    result = fix_run(run, Client([patch(SOURCE, SOURCE.replace("broken", "fixed"))], ["GONE"]),
                     goal, source_path=source, driver_factory=lambda path, bugs="": Driver(path, []))
    assert result["reports"][0]["proved"]
    assert not (run / "fixes/0/needs_human.json").exists()
    assert result["needs_human"] == []


def test_report_shows_escaped_diff_and_both_verdicts(tmp_path):
    from pt.report import build
    diff = patch(SOURCE, SOURCE.replace("broken", "fixed <script>"))
    run, _, _ = execute(tmp_path, [diff], ["GONE"])
    page = build(run)
    assert "Fixes" in page and "1 of 1 fixed and proved" in page
    assert "Bug gone" in page and "Goal still won" in page
    assert "fixed &lt;script&gt;" in page and "NEW frame: the door is open." in page


def test_cli_flags_and_regression_build():
    from pt.cli import parse
    args = parse(["fix", "run", "--goal-run", "goal"])
    assert args.max_tries == 3 and args.goal_run == "goal"
    assert parse(["regress", "run", "--bugs", "", "--build", "copy/index.html"]).build == "copy/index.html"


@pytest.mark.parametrize("hits,proved", [(None, False), ({}, False), ({"1": True}, False), ({"1": 0}, False),
                                       ({"1": None}, False)])
def test_missing_or_live_hook_cannot_prove_fix(tmp_path, hits, proved):
    from pt.fix import fix_run
    run, goal, source = setup_run(tmp_path)
    made = []
    class Hooks(Driver):
        def bug_hits(self):
            return super().bug_hits() if "broken" in self.source else hits
    result = fix_run(run, Client([patch(SOURCE, SOURCE.replace("broken", "fixed"))], ["GONE"]),
                     goal, max_tries=1, source_path=source, driver_factory=lambda path, bugs="": Hooks(path, made))
    assert result["reports"][0]["proved"] is proved
    row = result["reports"][0]
    assert row["hooks_gone"] == []
    assert row["hooks_not_measured"] == ([] if hits == {"1": True} else [1])
    if row["hooks_not_measured"]:
        assert "hook 1 not measured after the patch" in row["failure"]


def test_gone_without_new_quote_cannot_prove_fix(tmp_path):
    from pt.fix import fix_run
    run, goal, source = setup_run(tmp_path)
    class NoQuote(Client):
        def responses(self, inp, **kw):
            return {"output_text": '{"verdict":"GONE","evidence":""}', "_cost_usd": .01}
    result = fix_run(run, NoQuote([patch(SOURCE, SOURCE.replace("broken", "fixed"))], []), goal,
                     max_tries=1, source_path=source, driver_factory=lambda path, bugs="": Driver(path, []))
    assert not result["reports"][0]["bug_gone"] and not result["reports"][0]["proved"]


def test_bad_structured_output_is_counted_and_retried(tmp_path):
    from pt.fix import fix_run
    run, goal, source = setup_run(tmp_path)
    class Bad(Client):
        def wonder(self, body, **kw):
            self.proposals.append(body)
            return {"output_text": '[]', "_cost_usd": .02}
    client = Bad([], [])
    result = fix_run(run, client, goal, source_path=source, max_tries=2,
                     driver_factory=lambda path, bugs="": Driver(path, []))
    row = result["reports"][0]
    assert row["tries"] == 2 and row["cost_usd"] == .04 and not row["applied"]
    assert "structured" in client.proposals[1]["input"][0]["content"][0]["text"]


@pytest.mark.parametrize("which,field,value", [
    ("run", "kind", "goal"), ("run", "game_id", "cave-courier"),
    ("goal", "won", False), ("goal", "bugs_on", "1"), ("goal", "game_id", "other"),
])
def test_invalid_inputs_rejected_without_proposal(tmp_path, which, field, value):
    from pt.fix import fix_run
    run, goal, source = setup_run(tmp_path)
    path = (run if which == "run" else goal) / "result.json"
    obj = json.loads(path.read_text())
    obj[field] = value
    path.write_text(json.dumps(obj))
    client = Client([], [])
    with pytest.raises(ValueError):
        fix_run(run, client, goal, source_path=source, driver_factory=lambda *a, **kw: pytest.fail("no driver"))
    assert not client.proposals and not (run / "fixes").exists()


def test_fix_cli_guard_precedes_client_and_driver(tmp_path, monkeypatch):
    from pt import cli, guard
    from trials import common
    monkeypatch.setattr(guard, "problems", lambda: ["held"])
    monkeypatch.setattr(common, "load_client", lambda *a: pytest.fail("no paid client"))
    assert cli.main(["fix", "run", "--goal-run", "goal"]) == 1


def test_copy_driver_uses_only_given_file(tmp_path, monkeypatch):
    from pt import adapter
    from pt.fix_build import copy_driver
    source = tmp_path / "index.html"
    source.write_text("patched")
    seen = []
    monkeypatch.setattr(adapter, "WebAdapter", lambda cfg, **kw: seen.append((cfg, kw)))
    copy_driver(source, bugs="6")
    cfg, kw = seen[0]
    assert cfg["url"] == source.resolve().as_uri() and "serve" not in cfg
    assert cfg["bug_js"] == "window.__bugHit" and kw["bugs"] == "6"


def test_patch_that_cannot_load_is_counted_and_retried(tmp_path):
    from pt.fix import fix_run
    run, goal, source = setup_run(tmp_path)
    invalid = patch(SOURCE, SOURCE.replace("broken", "syntax error"))
    valid = patch(SOURCE, SOURCE.replace("broken", "fixed"))
    class LoadError(Driver):
        def __init__(self, path):
            if "syntax error" in Path(path).read_text():
                raise RuntimeError("patched page did not become ready")
            super().__init__(path, [])
    client = Client([invalid, valid], ["GONE"])
    result = fix_run(run, client, goal, source_path=source,
                     driver_factory=lambda path, bugs="": LoadError(path))
    assert result["fixed"] == 1 and result["reports"][0]["tries"] == 2
    assert result["cost_usd"] == pytest.approx(.05)
    assert "did not become ready" in client.proposals[1][0]["input"][0]["content"][0]["text"]


def test_only_confirmed_reports_and_no_duplicate_attempt_after_success(tmp_path):
    from pt.fix import fix_run
    run, goal, source = setup_run(tmp_path)
    checked = json.loads((run / "confirm.json").read_text())
    (run / "confirm.json").write_text(json.dumps([
        {"confirmed": False}, {"confirmed": True, "status": "rejected"},
        {"confirmed": True, "reproducible": False}, *checked]))
    client = Client([patch(SOURCE, SOURCE.replace("broken", "fixed"))], ["GONE"])
    result = fix_run(run, client, goal, source_path=source,
                     driver_factory=lambda path, bugs="": Driver(path, []))
    assert result["fixed"] == result["total"] == len(client.proposals) == 1
    assert result["reports"][0]["report_index"] == 3
    assert (run / "fixes/3/verdict.json").exists()
    with pytest.raises(FileExistsError):
        fix_run(run, client, goal, source_path=source)


def test_one_hook_can_clear_while_another_remains(tmp_path):
    from pt.fix import fix_run
    run, goal, source = setup_run(tmp_path)
    class Multiple(Driver):
        def bug_hits(self):
            return {**super().bug_hits(), "2": True}
    result = fix_run(run, Client([patch(SOURCE, SOURCE.replace("broken", "fixed"))], ["GONE"]),
                     goal, max_tries=1, source_path=source,
                     driver_factory=lambda path, bugs="": Multiple(path, []))
    row = result["reports"][0]
    assert row["baseline_hooks"] == [1, 2] and row["cleared_hooks"] == [1]
    assert row["proved"]


def test_regression_command_can_use_a_patched_copy(tmp_path, monkeypatch):
    from pt import adapter, cli, guard
    from trials import common
    run, goal, source = setup_run(tmp_path)
    target = tmp_path / "index.html"
    target.write_text(SOURCE.replace("broken", "fixed"))
    from game.build_buggy import instrument
    baseline = tmp_path / "baseline.html"
    baseline.write_text(instrument(SOURCE))
    opened = []
    def open_copy(cfg, bugs=""):
        from urllib.parse import urlsplit
        from urllib.request import url2pathname
        path = Path(url2pathname(urlsplit(cfg["url"]).path))
        opened.append(path)
        return Driver(path, [])
    monkeypatch.setattr(adapter, "WebAdapter", open_copy)
    monkeypatch.setattr(adapter, "make", lambda *a, **kw: pytest.fail("must use copy"))
    monkeypatch.setattr(cli, "ROOT", tmp_path)
    monkeypatch.setattr(common, "load_client", lambda *a: Client([], ["GONE"]))
    monkeypatch.setattr(guard, "problems", lambda: [])
    monkeypatch.setattr(guard, "take_lock", lambda: None)
    monkeypatch.setattr(guard, "release_lock", lambda: None)
    assert cli.main(["regress", str(run), "--bugs", "", "--build", str(target), "--baseline-build", str(baseline),
                     "--goal-run", str(goal), "--name", "copy-proof"]) == 0
    result = json.loads((tmp_path / "data/runs/copy-proof/regress.json").read_text())
    assert result["counts"] == {"fixed": 0, "still there": 0, "new breakage": 0, "not comparable": 1,
                                "page broken": 0}
    row = result["reports"][0]
    assert row["verdict"] == "path changed, not comparable"
    assert row["first_different"] == 0 and row["judge_verdict"] == "fixed"
    assert opened == [baseline, target, baseline, target]
    assert result["baseline_build"] == str(baseline.resolve())
    assert result["build"] == str(target.resolve())


def test_report_keeps_rejected_attempt_diff_and_verdicts(tmp_path):
    from pt.report import build
    first = patch(SOURCE, SOURCE.replace("broken", "fixed").replace("goal ok", "goal lost"))
    final = patch(SOURCE, SOURCE.replace("broken", "fixed"))
    run, _, _ = execute(tmp_path, [first, final], ["GONE", "GONE"], max_tries=2)
    page = build(run)
    assert "Attempt 1" in page and "goal lost" in page
    assert "Goal still won: False" in page and "Goal still won: True" in page


def test_fix_cli_uses_fake_client_and_writes_report(tmp_path, monkeypatch, capsys):
    from pt import cli, fix, guard
    from trials import common
    run, goal, source = setup_run(tmp_path)
    client = Client([patch(SOURCE, SOURCE.replace("broken", "fixed"))], ["GONE"])
    real = fix.fix_run
    monkeypatch.setattr(fix, "fix_run", lambda *a, **kw: real(*a, **kw, source_path=source,
                        driver_factory=lambda path, bugs="": Driver(path, [])))
    monkeypatch.setattr(common, "load_client", lambda *a: client)
    monkeypatch.setattr(guard, "problems", lambda: [])
    locks = []
    monkeypatch.setattr(guard, "take_lock", lambda: locks.append("take"))
    monkeypatch.setattr(guard, "release_lock", lambda: locks.append("release"))
    assert cli.main(["fix", str(run), "--goal-run", str(goal)]) == 0
    assert capsys.readouterr().out.strip() == "1 of 1 fixed and proved"
    assert locks == ["take", "release"] and (run / "report.html").is_file()


LANE_FILES = (
    "game/build_buggy.py", "game/index-buggy.html", "game/index-buggy-view.html",
    "games/cave-courier-buggy.json", "pt/fix.py", "pt/fix_build.py", "pt/fix_patch.py",
    "pt/fix_report.py", "tests/test_fix.py", "tests/test_fix_browser.py",
)


def test_view_has_no_location_tells():
    from game.build_buggy import bake
    view = bake((ROOT / "game/index.html").read_text(encoding="utf-8"))
    for tell in ("bug", "__bugHit", "BUGS.has(", "true &&", "|| true", "if (true)", "!true", "true ?"):
        assert tell.lower() not in view.lower(), tell


def test_instrumented_view_is_the_served_page_byte_for_byte(tmp_path):
    from game.build_buggy import bake, build, instrument
    clean = (ROOT / "game/index.html").read_text(encoding="utf-8")
    view = bake(clean)
    served = instrument(view)
    target = tmp_path / "index-buggy.html"
    build(target=target)
    assert (tmp_path / "index-buggy-view.html").read_bytes() == view.encode("utf-8")
    assert target.read_bytes() == served.encode("utf-8")
    assert (ROOT / "game/index-buggy-view.html").read_bytes() == view.encode("utf-8")
    assert (ROOT / "game/index-buggy.html").read_bytes() == served.encode("utf-8")
    assert set(re.findall(r"window.__bugHit\[(\d)\] = true", served)) == set("123456")
    assert "const PIT_FLOOR = 350;" in served
    assert "if (!true)" not in served and "true &&" not in served
    assert "if (st.y > GROUND)" in served and "if (c.id === 3)" in served
    assert "s.push({x: 300, y: GROUND" not in served
    assert "st.boots = true" not in served
    compact = re.sub(r"\s+", " ", served)
    # These are the five enabled paths in index.html, without their flag gates.
    for fragment in (
        "s.push({x: 58, y: 50, w: 6, h: 200, door: 1});",
        "for (const s of S) if (s.door === 1 && st.shedOpen && overlap(box, s)) window.__bugHit[1] = true;",
        "if (st.x > 300 && st.x < 330 && box.y > GROUND - H) window.__bugHit[2] = true;",
        "st.coins -= 3; if (!st.boots) window.__bugHit[3] = true; say('Thanks! Enjoy the boots!'); return;",
        "if (st.y > GROUND) { window.__bugHit[4] = true; continue; } reset(); continue;",
        "if (c.id === 3) { st.score += 1; window.__bugHit[5] = true; } else st.score += 10;",
    ):
        assert fragment in compact


def test_lane_files_have_no_bom():
    for name in LANE_FILES:
        assert not (ROOT / name).read_bytes().startswith(b"\xef\xbb\xbf"), name


def test_public_manifest_includes_baked_build():
    from tools import make_public
    shipped = set(make_public.selected(ROOT, make_public.read_manifest(ROOT / "tools/public_manifest.txt")))
    assert {"game/build_buggy.py", "game/index-buggy.html", "game/index-buggy-view.html"} <= shipped


def test_generated_pages_keep_lf_on_checkout():
    import subprocess
    paths = ["game/index-buggy.html", "game/index-buggy-view.html"]
    attrs = subprocess.run(["git", "check-attr", "eol", "--", *paths], cwd=ROOT,
                           capture_output=True, text=True, check=True).stdout.splitlines()
    assert attrs == [f"{path}: eol: lf" for path in paths]


def test_fix_prompt_uses_only_view_text(tmp_path, monkeypatch):
    from pt import fix
    run, goal, source = setup_run(tmp_path)
    game = tmp_path / "game"
    game.mkdir()
    (game / "index-buggy-view.html").write_text(SOURCE, encoding="utf-8")
    (game / "index-buggy.html").write_text("SERVED PAGE MUST STAY PRIVATE __bugHit", encoding="utf-8")
    monkeypatch.setattr(fix, "ROOT", tmp_path)
    client = Client([patch(SOURCE, SOURCE.replace("broken", "fixed"))], ["GONE"])
    fix.fix_run(run, client, goal, driver_factory=lambda path, bugs="": Driver(path, []))
    prompt = client.proposals[0][0]["input"][0]["content"][0]["text"]
    assert SOURCE in prompt and "SERVED PAGE MUST STAY PRIVATE" not in prompt
    assert "__bugHit" not in prompt


@pytest.mark.parametrize("answer,goal_ok,quote,proved", [
    ("GONE", True, "NEW frame: the door is open.", True),
    ("STILL THERE", True, "NEW frame: the door blocks the player.", False),
    ("GONE", False, "NEW frame: the door is open.", True),
    ("GONE", True, "", False),
])
def test_changed_anchor_is_unknown_and_needs_judge_and_goal(tmp_path, answer, goal_ok, quote, proved):
    from pt.fix import fix_run
    from game.build_buggy import bake
    run, goal, source = setup_run(tmp_path)
    view = bake((ROOT / "game/index.html").read_text(encoding="utf-8"))
    from game.build_buggy import ANCHORS
    anchor = ANCHORS[1]
    assert anchor in view
    updated = view.replace(anchor, anchor + " // repaired collision")
    source.write_text(view, encoding="utf-8")
    class UnknownDriver(Driver):
        def bug_hits(self):
            return {"1": "// repaired collision" not in self.source}
        def won(self): return goal_ok
    class Answer(Client):
        def responses(self, inp, **kw):
            return {"output_text": json.dumps({"verdict": answer, "evidence": quote}), "_cost_usd": .01}
    result = fix_run(run, Answer([patch(view, updated)], []), goal, source_path=source,
                     max_tries=1, driver_factory=lambda path, bugs="": UnknownDriver(path, []))
    row = result["reports"][0]
    assert row["hook"] == "unknown" and row["unknown_hooks"] == [1]
    assert row["cleared_hooks"] == [] and not row["hooks_clear"]
    assert row["proved"] is proved
    assert json.loads((run / "fixes/0/verdict.json").read_text())["hook"] == "unknown"
    from pt.report import build
    assert "Hook: unknown" in build(run)


@pytest.mark.parametrize("number", range(1, 6))
def test_missing_anchor_never_creates_a_false_hook(number):
    from game.build_buggy import ANCHORS, bake, instrument
    view = bake((ROOT / "game/index.html").read_text(encoding="utf-8"))
    changed = view.replace(ANCHORS[number], ANCHORS[number] + " ")
    served = instrument(changed)
    assert f"{number}: null" in served
    assert f"window.__bugHit[{number}] = true;" not in served
    assert ANCHORS[number] + " \n" in served


def test_unknown_anchor_does_not_excuse_another_live_hook(tmp_path):
    from game.build_buggy import ANCHORS
    from pt.fix import fix_run
    run, goal, source = setup_run(tmp_path)
    updated = SOURCE.replace(ANCHORS[1], ANCHORS[1] + " ")
    class Mixed(Driver):
        def bug_hits(self): return {"1": True, "2": True}
    result = fix_run(run, Client([patch(SOURCE, updated)], ["GONE"]), goal,
                     source_path=source, max_tries=1,
                     driver_factory=lambda path, bugs="": Mixed(path, []))
    row = result["reports"][0]
    assert row["hook"] == "unknown" and row["unknown_hooks"] == [1]
    assert row["goal_won"] and row["bug_gone"] and not row["proved"]


@pytest.mark.parametrize("before,after,answer,proved,failure", [
    ({1, 2}, {2}, "GONE", True, ""),
    ({1, 2}, {1, 2}, "GONE", False, "no hook went away"),
    ({1}, {1, 3}, "GONE", False, "new hook 3 fired"),
    ({1, 2}, {2}, "STILL THERE", False, "report still there"),
], ids=["a", "b", "c", "d"])
def test_hooks_before_after(tmp_path, before, after, answer, proved, failure):
    from pt.fix import fix_run
    run, goal, source = setup_run(tmp_path)
    class Hooks(Driver):
        def bug_hits(self):
            active = before if "broken" in self.source else after
            return {str(n): n in active for n in range(1, 6)}
    result = fix_run(run, Client([patch(SOURCE, SOURCE.replace("broken", "fixed"))], [answer]),
                     goal, max_tries=1, source_path=source,
                     driver_factory=lambda path, bugs="": Hooks(path, []))
    row = result["reports"][0]
    assert row["proved"] is proved
    assert failure in row["failure"]
    assert row["goal_won_before"] is True and row["goal_won"] is True
    assert result["fixed"] == int(proved)


@pytest.mark.parametrize("before,proved", [(False, True), (True, False)])
def test_goal_before_after(tmp_path, before, proved):
    from pt.fix import fix_run
    run, goal, source = setup_run(tmp_path)
    made = []
    class Goal(Driver):
        def __init__(self, path):
            super().__init__(path, made)
            self.path = Path(path)
        def won(self): return before if self.path.name == "baseline.html" else False
    result = fix_run(run, Client([patch(SOURCE, SOURCE.replace("broken", "fixed"))], ["GONE"]),
                     goal, max_tries=1, source_path=source,
                     driver_factory=lambda path, bugs="": Goal(path))
    row = result["reports"][0]
    assert row["proved"] is proved
    assert row["goal_won_before"] is before and row["goal_won"] is False
    assert ("goal won before and lost after" in row["failure"]) is before
    saved = json.loads((run / "fixes/goal-before.json").read_text())
    assert saved["won"] is before and len(saved["states"]) == 3
    assert len([d for d in made if d.path.name == "baseline.html"]) == 2


@pytest.mark.parametrize("anchor_removed,answer,expected", [
    (True, "GONE", True),
    (True, "STILL THERE", False),
    (False, "GONE", False),
], ids=["changed_line_judge_fixed", "changed_line_judge_not_fixed", "intact_anchor"])
def test_line_changed_judge_fixed(tmp_path, anchor_removed, answer, expected):
    from game.build_buggy import ANCHORS
    from pt.fix import fix_run
    run, goal, source = setup_run(tmp_path)
    updated = SOURCE.replace("broken", "fixed")
    if anchor_removed:
        updated = updated.replace(ANCHORS[1], ANCHORS[1] + " ")
    class Unmeasured(Driver):
        def bug_hits(self):
            return {"1": True if "broken" in self.source else None}
    result = fix_run(run, Client([patch(SOURCE, updated)], [answer]), goal,
                     source_path=source, max_tries=1,
                     driver_factory=lambda path, bugs="": Unmeasured(path, []))
    row = result["reports"][0]
    assert row["line_changed_judge_fixed"] is expected
    assert row["proved"] is False
    assert row["hooks_not_measured"] == [1]
    assert row["unknown_hooks"] == ([1] if anchor_removed else [])
    assert "hook 1 not measured after the patch" in row["failure"]
    saved = json.loads((run / "fix.json").read_text())
    assert saved["fixed"] == 0
    assert saved["line_changed_judge_fixed"] == int(expected)
    assert json.loads((run / "fixes/0/verdict.json").read_text())["line_changed_judge_fixed"] is expected
