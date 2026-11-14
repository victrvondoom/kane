import json

from tools import check_prompt_clean as checker


def _game(tmp_path, monkeypatch, *, goal="Reach the exit.", controls="Arrow keys move.", brief=None):
    config = {"type": "web", "name": "Test", "url": "https://example.invalid", "goal": goal, "controls": controls}
    if brief is not None:
        brief_path = tmp_path / "brief.txt"
        brief_path.write_text(brief, encoding="utf-8")
        config["brief_file"] = str(brief_path)
    config_path = tmp_path / "game.json"
    config_path.write_text(json.dumps(config), encoding="utf-8")
    monkeypatch.setattr(checker, "config_path", lambda _name: config_path)
    return config_path


def test_clean_prompt_passes(tmp_path, monkeypatch, capsys):
    _game(tmp_path, monkeypatch)
    terms = tmp_path / "terms.txt"
    terms.write_text("Zorblax\n", encoding="utf-8")
    assert checker.main(["--game", "sample", "--terms", str(terms)]) == 0
    assert "1 terms" in capsys.readouterr().out


def test_term_in_brief_fails(tmp_path, monkeypatch, capsys):
    _game(tmp_path, monkeypatch, brief="Secretive madeupterm memo.")
    terms = tmp_path / "terms.txt"
    terms.write_text("madeupterm\n", encoding="utf-8")
    assert checker.main(["--game", "sample", "--terms", str(terms)]) == 1
    assert "brief" in capsys.readouterr().out


def test_term_in_goal_fails(tmp_path, monkeypatch, capsys):
    _game(tmp_path, monkeypatch, goal="Find the Quenlith marker.")
    terms = tmp_path / "terms.txt"
    terms.write_text("Quenlith\n", encoding="utf-8")
    assert checker.main(["--game", "sample", "--terms", str(terms)]) == 1
    assert "goal" in capsys.readouterr().out


def test_case_and_underscore_match(tmp_path, monkeypatch, capsys):
    _game(tmp_path, monkeypatch, goal="Visit Some Name.")
    terms = tmp_path / "terms.txt"
    terms.write_text("SOME_NAME\n", encoding="utf-8")
    assert checker.main(["--game", "sample", "--terms", str(terms)]) == 1
    assert "SOME_NAME" in capsys.readouterr().out


def test_empty_terms_exits_two(tmp_path, monkeypatch, capsys):
    _game(tmp_path, monkeypatch)
    terms = tmp_path / "terms.txt"
    terms.write_text("\n", encoding="utf-8")
    assert checker.main(["--game", "sample", "--terms", str(terms)]) == 2
    assert capsys.readouterr().out


def test_built_text_includes_brief_first_line(tmp_path, monkeypatch):
    _game(tmp_path, monkeypatch, brief="First line from the true brief.\nSecond line.")
    prompt = checker.build_text("sample")
    assert "First line from the true brief." in prompt["controls"]
