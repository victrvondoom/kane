"""Is this repo clean enough to make public? Prints PASS or the problems. It never changes anything and never prints a secret.
Run: python -m tools.public_check [repo folder]"""
import os
import re
import subprocess
import sys
import shlex
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pt.python_version import require_supported
require_supported()


SECRET_RES = [re.compile(r"\bsk-[A-Za-z0-9_\-]{20,}"), re.compile(r"Bearer [A-Za-z0-9_\-\.]{25,}"), re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")]
SECRET_FILES = re.compile(r"(^|/)(\.env(\..*)?|\.dev\.vars|.*\.(pem|p12|p8|keystore|jks))$")
_AI = "".join(["cla", "ude"])
_VENDOR = "".join(["anthr", "opic"])
ATTRIBUTION = re.compile(r"(?i)gener" + "ated with|co-auth" + "ored-by|" + _AI + r"|" + _VENDOR + r"|written by an? (ai|assistant)|as an " + "ai")
BS = chr(92)
OTHER_PATH = re.compile(r"[A-Za-z]:" + re.escape(BS) + "{1,2}(Projects|Users)" + re.escape(BS) + "{1,2}")
TEXT_EXT = {".py", ".md", ".txt", ".json", ".html", ".js", ".css", ".toml", ".yml", ".yaml", ".cfg", ".sh", ".ps1", ".cs", ".csproj"}


def _api_key():
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from pt.env import api_key, load_local_env
    load_local_env()
    return api_key()


def git(repo, *args, input_text=None):
    result = subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True,
                            encoding="utf-8", errors="replace", input=input_text)
    if result.returncode and not (args and args[0] == "grep" and result.returncode == 1):
        detail = result.stderr.splitlines()[0] if result.stderr.splitlines() else "no error detail"
        raise RuntimeError(f"git {shlex.join(args)} failed with return code {result.returncode}: {detail}")
    return result.stdout


def tracked(repo):
    return [f for f in git(repo, "ls-files").splitlines() if f]


def read(repo, f):
    try:
        return (Path(repo) / f).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return ""


PNG_PIXEL = {b"IHDR", b"PLTE", b"tRNS", b"IDAT", b"IEND"}


def png_metadata(path):
    """Chunks a PNG carries besides its pixels (text, EXIF, time...). An image tool can hide its whole job and file paths there."""
    data = Path(path).read_bytes()
    found, i = [], 8
    while i + 8 <= len(data):
        n = int.from_bytes(data[i:i + 4], "big")
        kind = data[i + 4:i + 8]
        if kind not in PNG_PIXEL:
            found.append(kind.decode("latin-1"))
        i += 12 + n
    return found


def check(repo, history=False):
    repo = Path(repo)
    files = tracked(repo)
    out = []
    names = {Path(f).name for f in files}
    if "LICENSE" not in names:
        out.append("no LICENSE file")
    if "README.md" not in names:
        out.append("no README.md")
    if "data/" not in read(repo, ".gitignore"):
        out.append(".gitignore does not ignore data/")
    key = _api_key()
    for f in files:
        if SECRET_FILES.search(f):
            out.append(f"secret file tracked: {f}")
        if f.startswith("data/"):
            out.append(f"data folder tracked: {f}")
        if f.startswith(".github/workflows/"):
            out.append(f"GitHub workflow file: {f}")
        if Path(f).suffix.lower() == ".png" and png_metadata(repo / f):
            out.append(f"PNG metadata in {f}: {', '.join(png_metadata(repo / f))}")
        if Path(f).suffix.lower() not in TEXT_EXT:
            continue
        text = read(repo, f)
        if any(r.search(text) for r in SECRET_RES) or (key and key in text):
            out.append(f"secret string in {f}")
        if ATTRIBUTION.search(text):
            out.append(f"AI or tool attribution words in {f}")
        if OTHER_PATH.search(text):
            out.append(f"path into this machine or another project in {f}")
        if Path(f).suffix.lower() == ".md":
            prose = re.sub(r"```.*?```", "", text, flags=re.S)
            if re.search(r"[\u2014\u2013]|\S - \S", prose):
                out.append(f"dash between words in {f}")
    log = git(repo, "log", "--all", "--format=%B")
    for bad in (_AI.capitalize() + "-Session:", "Co-Auth" + "ored-By", "Gener" + "ated with"):
        if bad.lower() in log.lower():
            out.append(f"{bad} in commit history")
    if history:
        out += history_problems(repo, key)
    return out


def history_terms(repo):
    """Words that must be in no commit: one per line in the git-ignored file .public-check-terms (a private game name and so on)."""
    try:
        lines = Path(os.environ.get("PLAYTEST_TERMS_FILE") or (Path(repo) / ".public-check-terms")).read_text(encoding="utf-8-sig").splitlines()
    except OSError:
        lines = []
    return [(t.strip(), "a private term") for t in lines if t.strip() and not t.startswith("#")]


def history_problems(repo, key=""):
    """Search every commit of every branch, not just the files at HEAD."""
    out = []
    objects = git(repo, "rev-list", "--all", "--objects").splitlines()
    object_ids = list(dict.fromkeys(line.split(" ", 1)[0] for line in objects if line))
    if not object_ids:
        return out
    names = git(repo, "log", "--all", "--name-only", "--format=").lower()
    if "games.local/" in names:
        out.append("history holds files from the private config folder (games.local)")
    result = subprocess.run(["git", "cat-file", "--batch"], cwd=repo,
                            input=("\n".join(object_ids) + "\n").encode("ascii"),
                            capture_output=True)
    if result.returncode:
        detail = result.stderr.decode("utf-8", "replace").splitlines()
        raise RuntimeError(f"git cat-file --batch failed with return code {result.returncode}: {detail[0] if detail else 'no error detail'}")
    data, offset = result.stdout, 0
    texts = []
    while offset < len(data):
        end = data.find(b"\n", offset)
        if end < 0:
            raise RuntimeError("git cat-file --batch returned a malformed header")
        header = data[offset:end].split()
        offset = end + 1
        if len(header) != 3:
            raise RuntimeError("git cat-file --batch returned a malformed object")
        kind, size = header[1], int(header[2])
        blob = data[offset:offset + size]
        offset += size + 1
        if kind == b"blob" and b"\0" not in blob[:8000]:
            texts.append(blob.decode("utf-8", "replace"))
    all_text = "\n".join(texts)
    for term, what in history_terms(repo):
        if term.casefold() in all_text.casefold() or term.casefold() in names:
            out.append(f"history holds {what} ({term})")
    if any(pattern.search(all_text) for pattern in SECRET_RES):
        out.append("history holds a secret string")
    if key and key in all_text:
        out.append("history holds the API key")
    if ATTRIBUTION.search(all_text):
        out.append("history holds assistant or tool attribution words")
    return out


if __name__ == "__main__":
    folder = next((a for a in sys.argv[1:] if not a.startswith("--")), ".")
    pr = check(folder, history="--history" in sys.argv)
    print("PASS" if not pr else f"{len(pr)} problem(s):\n" + "\n".join("  " + x for x in pr))
    sys.exit(0 if not pr else 1)
