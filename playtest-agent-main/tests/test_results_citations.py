"""Every RESULTS path has a public or release destination."""
import zipfile
from pathlib import Path

from tools import citation_check as C

ROOT = Path(__file__).resolve().parents[1]


def test_real_results_have_no_missing():
    rows = C.check(ROOT)
    missing = [path for path, status in rows if status == "MISSING"]
    assert not missing, f"{len(missing)} unresolved paths: {missing}"


def test_private_release_tool_is_not_public_or_imported():
    from tools import make_public

    selected = make_public.selected(ROOT, make_public.read_manifest(ROOT / "tools/public_manifest.txt"))
    assert "tools/make_release.py" not in selected
    source = (ROOT / "tools/citation_check.py").read_text(encoding="utf-8")
    assert "tools.make_release" not in source


def fixture(tmp_path, text, proof=""):
    (tmp_path / "docs").mkdir()
    (tmp_path / "tools").mkdir()
    (tmp_path / "docs/RESULTS.md").write_text(text)
    (tmp_path / "tools/public_manifest.txt").write_text("")
    (tmp_path / "tools/proof_logs.txt").write_text(proof)
    (tmp_path / "tools/release_runs.txt").write_text("h12\n")
    return tmp_path


def test_unlisted_and_private(tmp_path):
    root = fixture(tmp_path, "`docs/absent.md`\n`docs/private.md` (kept private)\nhttps://example.org/docs/web.md")
    assert C.check(root, selected=[]) == [("docs/absent.md", "MISSING"), ("docs/private.md", "kept private")]


def test_release_checks_zip_contents(tmp_path):
    root = fixture(tmp_path, "data/proof/present.log and `data/proof/absent.log`", "data/proof/\n")
    assets = tmp_path / "assets"
    assets.mkdir()
    with zipfile.ZipFile(assets / "proof-logs.zip", "w") as z:
        z.writestr("data/proof/present.log", "proof")
    assert C.check(root, selected=[], release=assets) == [
        ("data/proof/present.log", "release"), ("data/proof/absent.log", "MISSING")]


def test_public_folders_patterns_and_run_archives(tmp_path):
    root = fixture(tmp_path, "`bench/` `bench/*.json` `data/runs/h12/result.json` `data/runs/h12/absent.json`")
    assets = tmp_path / "assets"
    assets.mkdir()
    with zipfile.ZipFile(assets / "h12-run.zip", "w") as z:
        z.writestr("h12/result.json", "{}")
    assert C.check(root, selected=["bench/cases.json"], release=assets) == [
        ("bench/", "public"), ("bench/*.json", "public"),
        ("data/runs/h12/result.json", "release"), ("data/runs/h12/absent.json", "MISSING")]
