"""Check that the paths cited in RESULTS are available to readers."""
import argparse
from collections import Counter
import fnmatch
from pathlib import Path
import re
import zipfile

from tools import make_public

ROOT = Path(__file__).resolve().parents[1]
PATH = re.compile(r"(?<![\w/])(?:docs|bench|tools|games|samples|data|film|pt|trials|mods|metaclient|tests|deploy)/[\w.*?/-]*")


def citations(text):
    for line in text.splitlines():
        line = re.sub(r"https?://[^\s`<>]+", "", line)
        # Repo paths contain no spaces; prose and commands can surround them.
        for match in PATH.finditer(line):
            path = match.group().rstrip(".,")
            yield path, bool(re.match(r"`?\s*\(?kept private\b", line[match.end():]))


def matches(path, files):
    return any(fnmatch.fnmatch(file, path) or file.startswith(path.rstrip("/") + "/") for file in files)


def check(root=ROOT, selected=None, release=None):
    root = Path(root)
    runs_file = root / "tools/release_runs.txt"
    runs = runs_file.read_text(encoding="utf-8").splitlines() if runs_file.is_file() else []
    if selected is None:
        selected = make_public.selected(root, make_public.read_manifest(root / "tools/public_manifest.txt"))
    proof_file = root / "tools/proof_logs.txt"
    proof = make_public.read_manifest(proof_file) if proof_file.exists() else []
    proof.append("data/CLEANED.txt")
    archives = {}
    if release is not None:
        for archive in Path(release).glob("*.zip"):
            with zipfile.ZipFile(archive) as z:
                archives[archive.name] = z.namelist()
    rows = {}
    for path, private in citations((root / "docs/RESULTS.md").read_text(encoding="utf-8")):
        status = "MISSING"
        if matches(path, selected):
            status = "public"
        else:
            in_proof = matches(path, proof) or any(path.startswith(entry.rstrip("/") + "/") for entry in proof)
            run = next((name for name in runs if path.startswith(f"data/runs/{name}/")), None)
            if in_proof and (release is None or matches(path, archives.get("proof-logs.zip", []))):
                status = "release"
            elif run and (release is None or matches(path.removeprefix("data/runs/"), archives.get(f"{run}-run.zip", []))):
                status = "release"
            elif private:
                status = "kept private"
        if path not in rows or status != "MISSING":
            rows[path] = status
    return list(rows.items())


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", type=Path)
    args = parser.parse_args(argv)
    rows = check(release=args.release)
    print("| Path | Status |\n| --- | --- |")
    for path, status in rows:
        print(f"| {path} | {status} |")
    counts = Counter(status for _, status in rows)
    print("\n" + ", ".join(f"{status}: {counts[status]}" for status in ("public", "release", "kept private", "MISSING")))
    return int(bool(counts["MISSING"]))


if __name__ == "__main__":
    raise SystemExit(main())
