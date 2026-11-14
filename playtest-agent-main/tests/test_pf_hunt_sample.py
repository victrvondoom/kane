"""The Purrfect Fit proof sample is complete, clean, and matches its run form."""
import fnmatch
import json
import re
from pathlib import Path

from tools.make_public import read_manifest


ROOT = Path(__file__).resolve().parents[1]
SAMPLE = ROOT / "samples" / "pf-hunt-1"


def test_every_proof_file_is_there():
    expected = {
        "result.json",
        "confirm.json",
        "dns.log",
        "emulator-net.log",
        "hunt-sheet.jpg",
        "reminders-steps-24-26.jpg",
        "reminders-replay-1.jpg",
        "reminders-replay-2.jpg",
        "toyshop-replay-1.jpg",
        "toyshop-replay-2.jpg",
    }
    assert {p.name for p in SAMPLE.iterdir()} == expected


def test_the_manifest_lets_the_proof_out():
    proof = "samples/pf-hunt-1/reminders-steps-24-26.jpg"
    entries = read_manifest(ROOT / "tools" / "public_manifest.txt")
    assert any(fnmatch.fnmatch(proof, p) for p in entries if not p.startswith("!"))
    assert not any(fnmatch.fnmatch(proof, p[1:]) for p in entries if p.startswith("!"))


def test_the_run_is_what_the_form_says():
    result = json.loads((SAMPLE / "result.json").read_text(encoding="utf-8"))
    assert result["steps"] == 60
    assert [r["step"] for r in result["reports"]] == [26, 48]
    for step, step_actions in enumerate(result["actions_by_step"]):
        for action in step_actions:
            assert action["type"] != "drag"
            assert action["type"] != "swipe" or step in {37, 38, 39, 45, 46, 59}

    confirm = json.loads((SAMPLE / "confirm.json").read_text(encoding="utf-8"))
    assert len(confirm) == 2
    assert all(item["confirmed"] is True for item in confirm)


def test_the_run_had_no_network():
    assert "every name is refused" in (SAMPLE / "dns.log").read_text(encoding="utf-8")
    assert "292 looks, 0 outside connections" in (SAMPLE / "emulator-net.log").read_text(encoding="utf-8")


def test_no_path_from_this_pc():
    pattern = re.compile(r"\b[a-z]:[/\\]|\bUsers[/\\]|local\.env|\.cloud" + "flare|adrian" + "ferguson", re.IGNORECASE)
    for name in ("result.json", "confirm.json", "dns.log", "emulator-net.log"):
        text = (SAMPLE / name).read_text(encoding="utf-8-sig")
        match = pattern.search(text)
        assert match is None, f"{name}: {match.group(0)}"


def test_no_picture_holds_metadata():
    for path in SAMPLE.glob("*.jpg"):
        data = path.read_bytes()
        assert b"Exif" not in data, path.name
        assert b"<?xpacket" not in data, path.name
