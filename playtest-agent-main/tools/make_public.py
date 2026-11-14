"""Make the public copy: a NEW repo built from an allow list of tracked files, with one fresh commit and none of the private history.
Run: python -m tools.make_public DEST   (manifest: tools/public_manifest.txt). It does not publish anything."""
import fnmatch
import shutil
import subprocess
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pt.python_version import require_supported
require_supported()


def _git(cwd, *a):
    return subprocess.run(["git", *a], cwd=cwd, capture_output=True, text=True, encoding="utf-8", check=True).stdout


def read_manifest(path):
    return [l.strip() for l in Path(path).read_text(encoding="utf-8").splitlines() if l.strip() and not l.startswith("#")]


def selected(src, patterns):
    """The tracked files the allow list lets into the public copy."""
    inc = [p for p in patterns if not p.startswith("!")]
    exc = [p[1:] for p in patterns if p.startswith("!")]
    return [f for f in _git(src, "ls-files").splitlines() if any(fnmatch.fnmatch(f, p) for p in inc) and not any(fnmatch.fnmatch(f, p) for p in exc)]


def export(src, dest, patterns, message="Initial release"):
    src, dest = Path(src), Path(dest)
    if dest.exists() and any(dest.iterdir()):
        raise ValueError(f"{dest} is not empty")
    for f in selected(src, patterns):
        t = dest / f
        t.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src / f, t)
    _git(dest, "init", "-q", "-b", "main")
    _git(dest, "add", "-A")
    _git(dest, "commit", "-q", "-m", message)
    return dest


if __name__ == "__main__":
    here = Path(__file__).resolve().parents[1]
    out = export(here, sys.argv[1], read_manifest(here / "tools" / "public_manifest.txt"))
    print("wrote", out)
