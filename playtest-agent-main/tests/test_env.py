"""Machine specific settings live in a git-ignored local.env, never in code."""
import os
from pt import env as E


def test_local_env_sets_missing_values_only(tmp_path, monkeypatch):
    f = tmp_path / "local.env"
    f.write_text("# comment\nPLAYTEST_LEDGER=/x/ledger.jsonl\nPLAYTEST_KEY_FILE = /k/key.txt\n\nBAD LINE\nHAS_EQ=a=b\n", encoding="utf-8-sig")
    monkeypatch.delenv("PLAYTEST_LEDGER", raising=False)
    monkeypatch.setenv("PLAYTEST_KEY_FILE", "already")
    monkeypatch.delenv("HAS_EQ", raising=False)
    E.load_local_env(f)
    assert os.environ["PLAYTEST_LEDGER"] == "/x/ledger.jsonl"
    assert os.environ["PLAYTEST_KEY_FILE"] == "already"          # a real environment value wins
    assert os.environ["HAS_EQ"] == "a=b"


def test_missing_file_is_fine(tmp_path):
    E.load_local_env(tmp_path / "nope.env")


def test_api_key_from_env_or_file(tmp_path, monkeypatch):
    kf = tmp_path / "k.txt"; kf.write_text("﻿secret-value\nsecond line\n", encoding="utf-8")
    monkeypatch.delenv("MODEL_API_KEY", raising=False)
    monkeypatch.setenv("PLAYTEST_KEY_FILE", str(kf))
    assert E.api_key() == "secret-value"                          # line 1 only, BOM dropped
    monkeypatch.setenv("MODEL_API_KEY", "from-env")
    assert E.api_key() == "from-env"
    monkeypatch.delenv("MODEL_API_KEY")
    monkeypatch.delenv("PLAYTEST_KEY_FILE")
    assert E.api_key() == ""


def test_ledger_default_path_comes_from_env(tmp_path, monkeypatch):
    from metaclient import ledger as L
    monkeypatch.setenv("PLAYTEST_LEDGER", str(tmp_path / "l.jsonl"))
    assert L.default_ledger() == tmp_path / "l.jsonl"
    monkeypatch.delenv("PLAYTEST_LEDGER")
    assert L.default_ledger().name == "ledger.jsonl" and "data" in L.default_ledger().parts
