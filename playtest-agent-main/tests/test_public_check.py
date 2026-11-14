"""The public-clean check. Each rule has a case that must fail and one that must pass. Uses a throwaway git repo."""
import subprocess
from pathlib import Path
from tools import public_check as P


def repo(tmp_path, files, msg="Add things"):
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=tmp_path, check=True)
    subprocess.run(["git", "config", "user.email", "a@b.c"], cwd=tmp_path, check=True)
    subprocess.run(["git", "config", "user.name", "n"], cwd=tmp_path, check=True)
    for name, text in files.items():
        p = tmp_path / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
    subprocess.run(["git", "add", "-A", "-f"], cwd=tmp_path, check=True)
    subprocess.run(["git", "commit", "-q", "-m", msg], cwd=tmp_path, check=True)
    return tmp_path


GOOD = {"LICENSE": "MIT License\n", "README.md": "# Tool\n\nRun one command.\n", ".gitignore": "data/\n", "a.py": "print(1)\n"}


def test_clean_repo_passes(tmp_path):
    assert P.check(repo(tmp_path, GOOD)) == []


def test_missing_license_and_readme(tmp_path):
    r = P.check(repo(tmp_path, {"a.py": "x = 1\n"}))
    assert any("LICENSE" in x for x in r) and any("README" in x for x in r)


def test_secret_strings(tmp_path):
    r = P.check(repo(tmp_path, {**GOOD, "b.py": 'KEY = "' + "sk" + '-abcdefghijklmnopqrstuvwxyz123456"\n'}))
    assert any("secret" in x for x in r)
    r = P.check(repo(tmp_path / "x", {**GOOD, ".env": "A=1\n"})) if (tmp_path / "x").mkdir() is None else []
    assert any(".env" in x for x in r)


def test_session_trailer_in_history(tmp_path):
    r = P.check(repo(tmp_path, GOOD, msg="Add\n\nCla" + "ude-Session: abc"))
    assert any("-Session" in x for x in r)


def test_ai_attribution_words(tmp_path):
    r = P.check(repo(tmp_path, {**GOOD, "docs.md": "Gener" + "ated with an assistant\n"}))
    assert any("attribution" in x for x in r)


def test_dashes_in_public_text(tmp_path):
    r = P.check(repo(tmp_path, {**GOOD, "README.md": "# Tool\n\nIt plays \u2014 and tests.\n"}))
    assert any("dash" in x for x in r)


def test_workflow_files(tmp_path):
    r = P.check(repo(tmp_path, {**GOOD, ".github/workflows/ci.yml": "on: push\n"}))
    assert any("workflow" in x for x in r)


def test_paths_into_other_projects(tmp_path):
    bs = chr(92)
    r = P.check(repo(tmp_path, {**GOOD, "c.py": "P = r'A:" + bs + "Projects" + bs + "other'" + chr(10)}))
    assert any("path" in x for x in r)


def test_tracked_data_folder(tmp_path):
    r = P.check(repo(tmp_path, {**GOOD, "data/x.bin": "1"}))
    assert any("data" in x for x in r)


def test_history_is_checked_not_only_head(tmp_path):
    repo(tmp_path, {**GOOD, "old.md": "notes about zebragame art\n"})
    subprocess.run(["git", "rm", "-q", "old.md"], cwd=tmp_path, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "Remove notes"], cwd=tmp_path, check=True)
    (tmp_path / ".public-check-terms").write_text("zebragame" + chr(10))
    assert P.check(tmp_path) == []                       # HEAD is clean
    r = P.check(tmp_path, history=True)
    assert any("history" in x and "private term" in x for x in r)


def test_history_flags_a_private_config_folder(tmp_path):
    repo(tmp_path, {**GOOD, "games.local/x.json": "{}"})
    subprocess.run(["git", "rm", "-q", "-r", "games.local"], cwd=tmp_path, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "Remove"], cwd=tmp_path, check=True)
    assert any("games.local" in x for x in P.check(tmp_path, history=True))


def test_history_flags_a_secret_in_an_old_commit(tmp_path):
    repo(tmp_path, {**GOOD, "k.py": 'K = "' + "sk" + '-abcdefghijklmnopqrstuvwxyz123456"\n'})
    subprocess.run(["git", "rm", "-q", "k.py"], cwd=tmp_path, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "Remove"], cwd=tmp_path, check=True)
    assert any("history" in x and "secret" in x for x in P.check(tmp_path, history=True))


def test_git_raises_on_command_failure(monkeypatch, tmp_path):
    class Result:
        returncode = 2
        stdout = ""
        stderr = "fatal: bad pattern"
    monkeypatch.setattr(P.subprocess, "run", lambda *a, **kw: Result())
    import pytest
    with pytest.raises(RuntimeError, match=r"git status.*return code 2.*fatal: bad pattern"):
        P.git(tmp_path, "status")


def test_history_secret_scan_does_not_use_git_grep(tmp_path, monkeypatch):
    repo(tmp_path, {**GOOD, "k.py": 'K = "' + "sk" + '-abcdefghijklmnopqrstuvwxyz123456"\n'})
    subprocess.run(["git", "rm", "-q", "k.py"], cwd=tmp_path, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "Remove"], cwd=tmp_path, check=True)
    original = P.git
    def no_grep(r, *args):
        if args and args[0] == "grep":
            raise AssertionError("history scan called git grep")
        return original(r, *args)
    monkeypatch.setattr(P, "git", no_grep)
    assert any("history" in x and "secret" in x for x in P.check(tmp_path, history=True))


def _png(path, text=None):
    import io
    from PIL import Image
    from PIL.PngImagePlugin import PngInfo
    info = PngInfo()
    if text:
        info.add_text("workflow", text)
    buf = io.BytesIO()
    Image.new("RGB", (4, 4)).save(buf, "PNG", pnginfo=info)
    path.write_bytes(buf.getvalue())


def test_png_text_chunks_are_refused(tmp_path):
    r = repo(tmp_path, GOOD)
    _png(tmp_path / "art.png", '{"ckpt": "models/m.safetensors"}')
    _png(tmp_path / "plain.png")
    subprocess.run(["git", "add", "-A"], cwd=r, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "art"], cwd=r, check=True)
    out = P.check(r)
    assert any("art.png" in x and "metadata" in x for x in out)
    assert not any("plain.png" in x for x in out)
