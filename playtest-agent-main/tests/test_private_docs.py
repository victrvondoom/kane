from pathlib import Path


def test_readme_private_mode():
    text = (Path(__file__).resolve().parents[1] / "README.md").read_text(encoding="utf-8")
    section = text.split("## Private mode\n", 1)[1].split("\n## ", 1)[0]
    assert "--model glimmer-local" in section
    assert "docs/receipts/judge-glimmer.json" in section
    assert "python -m trials.judge_compare" not in section
    assert "llama-server" in section and "8090" in section
    assert "nothing leaves the machine" in section.lower()
