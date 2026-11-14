import io
import json
from html.parser import HTMLParser
from pathlib import Path
import pytest

from PIL import Image

from pt import report as R


def jpg(color=(80, 120, 160)):
    image = Image.new("RGB", (24, 16), color)
    buffer = io.BytesIO()
    image.save(buffer, "JPEG")
    return buffer.getvalue()


def put_json(path, value):
    path.write_text(json.dumps(value), encoding="utf-8")


class PageParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.text = []
        self.tables = []
        self.images = []
        self.tags = []
        self.table = None
        self.row = None
        self.cell = None
        self.skipping = 0
        self.badges = []
        self.current_badge = None

    def handle_starttag(self, tag, attrs):
        self.tags.append(tag)
        attrs = dict(attrs)
        if tag in ("style", "script"):
            self.skipping += 1
        if tag == "table":
            self.table = []
            self.tables.append(self.table)
        elif tag == "tr" and self.table is not None:
            self.row = []
        elif tag in ("th", "td") and self.row is not None:
            self.cell = []
        elif tag == "span" and "badge" in attrs.get("class", "").split():
            self.current_badge = []
        elif tag == "img":
            self.images.append(attrs.get("src", ""))

    def handle_endtag(self, tag):
        if tag in ("style", "script") and self.skipping:
            self.skipping -= 1
        if tag == "span" and self.current_badge is not None:
            self.badges.append("".join(self.current_badge).strip())
            self.current_badge = None
        elif tag in ("th", "td") and self.cell is not None:
            self.row.append("".join(self.cell).strip())
            self.cell = None
        elif tag == "tr" and self.row is not None:
            self.table.append(self.row)
            self.row = None
        elif tag == "table":
            self.table = None

    def handle_data(self, data):
        if self.skipping:
            return
        self.text.append(data)
        if self.current_badge is not None:
            self.current_badge.append(data)
        if self.cell is not None:
            self.cell.append(data)


def hunt_run(tmp_path):
    run_dir = tmp_path / "hunt"
    run_dir.mkdir()
    put_json(
        run_dir / "result.json",
        {
            "game": "Lantern Field",
            "kind": "hunt",
            "stop": "finished",
            "steps": 4,
            "seconds": 12.5,
            "cost_usd": 0.42,
            "won": None,
            "final_state": {"room": "hall"},
            "bugs_on": "",
            "fallbacks": 0,
            "final_text": "The run ended.",
            "reports": [
                {"title": "Door stays open", "expected": "Door shuts", "actual": "Door stayed open", "step": 1},
                {"title": "Key remains", "expected": "Key disappears", "actual": "Key remains", "step": 2},
                {"title": "<script>alert(1)</script>", "expected": "A bell rings", "actual": "No sound", "step": 3},
            ],
            "actions_by_step": [[], [{}], [{}], [{}]],
            "log": [
                {"step": 1, "cost": 0.1, "latency_s": 1.0, "in": "", "calls": [], "text": "Moved to the door"},
                {"step": 2, "cost": 0.1, "latency_s": 3.0, "in": "", "calls": [], "text": "Checked the key"},
                {"step": 3, "cost": 0.22, "latency_s": 2.0, "in": "", "calls": [], "text": "Tried the bell"},
            ],
        },
    )
    put_json(
        run_dir / "confirm.json",
        [
            {"title": "Door stays open", "expected": "Door shuts", "actual": "Door stayed open", "step": 1, "confirmed": True, "reproducible": True, "evidence": "The door stayed open after use.", "judge": "", "cost_usd": 0.1},
            {"title": "Key remains", "expected": "Key disappears", "actual": "Key remains", "step": 2, "confirmed": False, "reproducible": True, "evidence": "The key was not lost.", "judge": "", "cost_usd": 0.1},
            {"title": "Bell is silent", "expected": "A bell rings", "actual": "No sound", "step": 3, "confirmed": False, "reproducible": False, "evidence": "The replay changed.", "judge": "", "cost_usd": 0.22},
        ],
    )
    for name in ("s000.jpg", "s001.jpg", "s003.jpg", "strip_0.jpg"):
        (run_dir / name).write_bytes(jpg())
    return run_dir


def goal_run_without_optional_data(tmp_path):
    run_dir = tmp_path / "goal"
    run_dir.mkdir()
    put_json(
        run_dir / "result.json",
        {
            "kind": "goal",
            "stop": "limit reached",
            "steps": 0,
            "seconds": 0.0,
            "cost_usd": 0.0,
            "won": False,
            "final_text": "No steps taken.",
            "reports": [],
            "actions_by_step": [],
            "log": [],
        },
    )
    (run_dir / "s000.jpg").write_bytes(jpg((140, 100, 60)))
    return run_dir


def parse_page(html):
    parser = PageParser()
    parser.feed(html)
    return parser


def test_hunt_report_has_cards_badges_counts_timeline_and_costs(tmp_path):
    run_dir = hunt_run(tmp_path)

    html = R.build(run_dir)
    page = parse_page(html)
    visible = "".join(page.text)

    assert "Lantern Field" in visible
    assert "hunt" in visible
    assert "Door stays open" in visible
    assert "Key remains" in visible
    assert "<script>alert(1)</script>" in visible
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in html
    assert "<script>alert(1)</script>" not in html
    assert page.badges == ["Confirmed", "Not confirmed", "Not reproducible"]
    assert "Door shuts" in visible
    assert "Door stayed open" in visible
    assert "The door stayed open after use." in visible
    assert "strip_0.jpg" in page.images
    assert "s003.jpg" in page.images
    assert "s002.jpg" not in page.images
    assert "Moved to the door" in visible
    assert "Tried the bell" in visible
    assert "0.42" in visible
    assert "0.105" in visible
    assert "2" in visible

    summary = {row[0]: row[1] for row in page.tables[0] if len(row) >= 2}
    assert summary["Reports filed"] == "3"
    assert summary["Confirmed"] == "1"
    assert summary["Not confirmed"] == "1"
    assert summary["Not reproducible"] == "1"

    assert "—" not in visible
    assert " - " not in visible


def test_goal_without_reports_or_confirm_file_builds_and_writes(tmp_path):
    run_dir = goal_run_without_optional_data(tmp_path)

    html = R.build(run_dir)
    written = R.write(run_dir)
    page = parse_page(html)
    visible = "".join(page.text)

    assert "Game" in visible
    assert "goal" in visible
    assert "Goal not reached" in visible
    assert '<article class="bug-card">' not in html
    assert "s000.jpg" in page.images
    assert isinstance(written, Path)
    assert written == run_dir / "report.html"
    assert written.read_text(encoding="utf-8") == html


def test_card_shows_the_state_change_and_the_page_shows_how_the_run_ended(tmp_path):
    import json as _json
    d = tmp_path / "r"; d.mkdir()
    (d / "result.json").write_text(_json.dumps({"kind": "hunt", "stop": "model", "steps": 3, "seconds": 30.0, "cost_usd": 0.1, "game": "G",
                                                "final_text": "I tried the door and the shop.", "settings": {"effort": "minimal", "state_text": True},
                                                "fallbacks": 1, "reports": [{"title": "T", "expected": "e", "actual": "a", "step": 2}], "log": []}))
    (d / "confirm.json").write_text(_json.dumps([{"title": "T", "confirmed": True, "reproducible": True, "evidence": "coins 3 to 0",
                                                  "state_change": ["coins: 3 -> 0", "boots: False -> False"]}]))
    page = parse_page(R.build(d))
    vis = " ".join(page.text)
    assert "coins: 3 -> 0" in vis
    assert "I tried the door and the shop." in vis
    assert "effort minimal" in vis.lower() or "minimal" in vis
    assert "resent" in vis.lower() or "1 time" in vis.lower()


def test_no_extra_sections_when_the_data_is_missing(tmp_path):
    import json as _json
    d = tmp_path / "r"; d.mkdir()
    (d / "result.json").write_text(_json.dumps({"kind": "goal", "stop": "won", "steps": 1, "seconds": 1.0, "cost_usd": 0.0, "won": True, "log": [], "reports": []}))
    vis = " ".join(parse_page(R.build(d)).text)
    assert "How the run ended" not in vis


def test_card_combines_replays_patch_reads_and_checks_without_paths(tmp_path):
    run = hunt_run(tmp_path)
    confirmations = json.loads((run / "confirm.json").read_text())
    confirmations[0]["comparison"] = {"compared": True, "method": "pictures", "same": True, "difference": 2.5}
    confirmations[1]["comparison"] = {"compared": True, "method": "state", "same": False}
    put_json(run / "confirm.json", confirmations)
    (run / "strip_0_b.jpg").write_bytes(jpg())
    (run / "replay-check").mkdir()
    put_json(run / "replay-check/summary.json", {"reports": [{"index": 0, "tries": [
        {"try": 1, "verdict": "YES"}, {"try": 2, "verdict": "NO"}]}]})
    check = {"stdout": json.dumps({"read": 8, "expected": 8, "path": "C:/private/screen.jpg"}),
             "returncode": 0, "command": ["A:/private/check"], "stderr": "D:/private/error"}
    put_json(run / "fix-any-0.json", {"report_index": 0, "result": "fixed", "context": "E:/private/context",
        "attempts": [{"try": 1, "control": {**check, "returncode": 1}, "replay_check": check,
                      "checks": [check], "judge": {"verdict": "NO", "reason": "The effect now occurs"}}]})
    put_json(run / "replay-reads.json", [{"replay": "patch off", "read": 7, "expected": 8}])
    page = parse_page(R.build(run))
    visible = " ".join(page.text)
    assert "Two replays compared by pictures: same (difference 2.5)" in visible
    assert "Two replays compared by state: different" in visible
    assert "strip_0_b.jpg" in page.images
    for text in ("Patch comparison", "fixed", "Patch off", "Patch on", "Normal check 1", "read 8", "expected 8",
                 "exit code 1", "exit code 0", "NO", "The effect now occurs", "Replay reads", "patch off", "7"):
        assert text in visible
    raw = R.build(run)
    for name in ("replay-check/report-0/try-1/strip.jpg", "replay-check/report-0/try-2/strip.jpg", "fix-any-0.diff"):
        assert name in raw
    assert "private" not in raw


def test_not_compared_badge_summary_and_status(tmp_path):
    run = hunt_run(tmp_path)
    rows = [{"confirmed": False, "reproducible": None, "status": "not compared",
             "comparison": {"compared": False, "method": "none", "same": None}}]
    put_json(run / "confirm.json", rows)
    page = parse_page(R.build(run))
    assert page.badges[0] == "Not compared"
    assert R.confirmation_status(rows[0]) == "not compared"
    summary = {row[0]: row[1] for row in page.tables[0] if len(row) >= 2}
    assert summary["Not compared"] == "1" and summary["Not confirmed"] == "0"
    assert "not-compared" in R.build(run)


def test_input_refused_badge_message_and_optional_summary(tmp_path):
    run = hunt_run(tmp_path)
    row = {"confirmed": False, "reproducible": True, "status": "input refused in replay",
           "refused_inputs": ["<escape>"]}
    put_json(run / "confirm.json", [row])
    page = parse_page(R.build(run))
    assert page.badges[0] == "Input refused"
    assert "Input refused in replay: <escape>. The game never got it, so this report was not judged." in " ".join(page.text)
    assert "input-refused" in R.build(run)
    (tmp_path / "older").mkdir()
    run = goal_run_without_optional_data(tmp_path / "older")
    assert "Input refused" not in R.build(run)


def test_older_picture_check_is_labeled_without_changing_badge(tmp_path):
    run = hunt_run(tmp_path)
    page = parse_page(R.build(run))
    assert "Older check: replays not compared" in " ".join(page.text)
    assert page.badges[0] == "Confirmed"


@pytest.mark.parametrize("public", [False, True])
def test_fix_pairs_by_report_index_and_confirmation_title(tmp_path, public):
    run = hunt_run(tmp_path)
    name = "fix-any-9.public.json" if public else "fix-any-9.json"
    fix = {"report_index": 0, "result": "unique patch result", "attempts": [],
           "confirmation": {"title": "wrong title"}}
    put_json(run / name, fix)
    assert "unique patch result" not in R.build(run)
    fix["confirmation"]["title"] = "Door stays open"
    put_json(run / name, fix)
    assert "unique patch result" in R.build(run)


def test_replay_read_table_preserves_observation_columns_on_first_card(tmp_path):
    run = hunt_run(tmp_path)
    put_json(run / "replay-reads.json", {"rows": [{"condition": "patch on", "health": 42, "strength": 8}]})
    raw = R.build(run)
    cards = raw.split('<article class="bug-card">')[1:]
    assert "Replay reads" in cards[0] and "health" in cards[0] and "42" in cards[0]
    assert all("Replay reads" not in card for card in cards[1:])


def test_patch_public_fallback_and_no_paths_in_allowed_values(tmp_path):
    run = hunt_run(tmp_path)
    fix = {"report_index": 0, "result": "public result", "attempts": [{"try": 1,
        "checks": [{"read": "C:/private/read.png", "expected": "/private/answer.png", "returncode": 0}],
        "judge": {"verdict": "NO", "reason": "Correct effect"}}]}
    put_json(run / "fix-any-0.public.json", fix)
    assert "public result" in R.build(run)
    put_json(run / "fix-any-0.json", {**fix, "result": "full result"})
    raw = R.build(run)
    assert "full result" in raw and "public result" not in raw and "private" not in raw


def test_patch_read_keeps_fraction_observations(tmp_path):
    run = hunt_run(tmp_path)
    put_json(run / "fix-any-0.json", {"report_index": 0, "result": "fixed", "attempts": [
        {"checks": [{"read": "8/10", "expected": "8/10", "returncode": 0}]}]})
    assert "read 8/10" in R.build(run)
