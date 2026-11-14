"""The public copy is a fresh repo made from an allow list, with one commit and none of the private history."""
import subprocess
from pathlib import Path
import pytest
from tools import make_public as M


@pytest.fixture(autouse=True)
def git_identity(monkeypatch):
    monkeypatch.setenv("GIT_AUTHOR_NAME", "n")
    monkeypatch.setenv("GIT_AUTHOR_EMAIL", "a@b.c")
    monkeypatch.setenv("GIT_COMMITTER_NAME", "n")
    monkeypatch.setenv("GIT_COMMITTER_EMAIL", "a@b.c")


def sh(cwd, *a):
    return subprocess.run(a, cwd=cwd, capture_output=True, text=True, check=True).stdout


def src_repo(tmp_path):
    s = tmp_path / "src"; s.mkdir()
    sh(s, "git", "init", "-q", "-b", "main"); sh(s, "git", "config", "user.email", "a@b.c"); sh(s, "git", "config", "user.name", "n")
    for name in ("README.md", "LICENSE", "pt/a.py", "pt/b.py", "docs/PLAN.md", "docs/results.md", "notes/x.md", "trials/run.sh"):
        p = s / name; p.parent.mkdir(parents=True, exist_ok=True); p.write_text("x")
    sh(s, "git", "add", "-A"); sh(s, "git", "commit", "-q", "-m", "first private commit")
    (s / "pt/c.py").write_text("later")
    sh(s, "git", "add", "-A"); sh(s, "git", "commit", "-q", "-m", "second private commit")
    return s


MANIFEST = ["README.md", "LICENSE", "pt/*.py", "docs/results.md"]


def test_only_listed_files_are_copied(tmp_path):
    s = src_repo(tmp_path)
    d = M.export(s, tmp_path / "pub", MANIFEST)
    got = sorted(str(p.relative_to(d)).replace(chr(92), "/") for p in d.rglob("*") if p.is_file() and ".git" not in p.parts)
    assert got == ["LICENSE", "README.md", "docs/results.md", "pt/a.py", "pt/b.py", "pt/c.py"]


def test_public_repo_has_one_fresh_commit(tmp_path):
    s = src_repo(tmp_path)
    d = M.export(s, tmp_path / "pub", MANIFEST, message="Initial release")
    assert sh(d, "git", "rev-list", "--count", "HEAD").strip() == "1"
    assert "private commit" not in sh(d, "git", "log", "--all", "--format=%B")
    assert sh(d, "git", "log", "-1", "--format=%s").strip() == "Initial release"


def test_untracked_files_are_never_copied(tmp_path):
    s = src_repo(tmp_path)
    (s / "pt" / "secret_local.py").write_text("untracked")
    d = M.export(s, tmp_path / "pub", MANIFEST)
    assert not (d / "pt" / "secret_local.py").exists()


def test_refuses_a_non_empty_destination(tmp_path):
    s = src_repo(tmp_path)
    (tmp_path / "pub").mkdir(); (tmp_path / "pub" / "x").write_text("1")
    try:
        M.export(s, tmp_path / "pub", MANIFEST)
        assert False, "should refuse"
    except ValueError:
        pass


def test_exclusion_patterns_win(tmp_path):
    s = src_repo(tmp_path)
    d = M.export(s, tmp_path / "pub", MANIFEST + ["!pt/b.py"])
    assert not (d / "pt" / "b.py").exists() and (d / "pt" / "a.py").exists()
